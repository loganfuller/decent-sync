import { Injectable } from "@nestjs/common";
import { MachineIdentification, type PendingMachine, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import type { Hardware } from "../sync/identity.js";
import { type NewMachine, pendingMachineNotFound } from "./input.js";
import { type MachineView, MachinesService, dismissedReason, hardwareTaken, lockHardware, refuseDuplicateName } from "./machines.service.js";
import { notifyAccessChanged } from "./access-changes.js";

/** A Pending Machine as the REST API returns it. */
export interface PendingMachineView {
  id: string;
  model: string;
  serial: string;
  /** When the server first saw the hardware. */
  firstSeenAt: string;
  /** When a connection last reported it, or null if none has. */
  lastSeenAt: string | null;
  /** Dismissed Pending Machines are kept: creating a machine entry for them later restores what they hold. */
  dismissed: boolean;
  /** Machines whose token's connection reports this hardware as a mismatch. */
  mismatchedMachines: { id: string; name: string }[];
}

/**
 * Hardware the server has seen but no Machine has (ADR-0015). An Admin
 * either creates a machine entry for it or dismisses it.
 */
@Injectable()
export class PendingMachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly machines: MachinesService,
  ) {}

  /** Every Pending Machine, dismissed or not, newest first. */
  async list(): Promise<PendingMachineView[]> {
    const pending = await this.prisma.pendingMachine.findMany({ orderBy: { createdAt: "desc" } });
    if (pending.length === 0) return [];
    const mismatched = await this.prisma.machine.findMany({
      where: {
        identification: MachineIdentification.MISMATCH,
        OR: pending.map(({ model, serial }) => ({ reportedModel: model, reportedSerial: serial })),
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, reportedModel: true, reportedSerial: true },
    });
    return pending.map((machine) => view(machine, mismatched));
  }

  /**
   * Creates a machine entry bound to the Pending Machine's hardware, which
   * takes over what was held for it. Its token is returned only here.
   */
  async createMachine(id: string, fields: NewMachine): Promise<{ machine: MachineView; token: string }> {
    const token = newSecret();
    let hardware: Hardware | undefined;
    const machineId = await this.prisma
      .$transaction(async (tx) => {
        const pending = await lockedPendingMachine(tx, id);
        hardware = { model: pending.model, serial: pending.serial };
        const owner = await tx.machine.findFirst({ where: hardware, select: { name: true } });
        if (owner) throw hardwareTaken(owner.name, hardware);

        const machine = await tx.machine.create({
          data: {
            name: fields.name,
            ...hardware,
            identification: MachineIdentification.IDENTIFIED,
            tokens: { create: { tokenHash: hashSecret(token) } },
          },
        });
        await tx.pendingMachine.delete({ where: { id } });
        return machine.id;
      })
      .catch(async (error: unknown) => {
        // The name, or the hardware, which a hello may have bound to another Machine meanwhile.
        if (hardware && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const owner = await this.prisma.machine.findFirst({ where: hardware, select: { name: true } });
          if (owner) throw hardwareTaken(owner.name, hardware);
        }
        return refuseDuplicateName(fields.name)(error);
      });
    return { machine: await this.machines.get(machineId), token };
  }

  /**
   * Dismisses the Pending Machine. Every Machine whose token's connection
   * reports it as a mismatch has that hardware refused from now on, with the
   * reason shown on it, and its connection is closed by whichever instance
   * holds it.
   */
  async dismiss(id: string): Promise<PendingMachineView> {
    const at = new Date();
    const { pending, refused } = await this.prisma.$transaction(async (tx) => {
      // A hello reporting the hardware, which may make its Machine a mismatch of it, waits for the
      // dismissal or is waited for, so every Machine that is one when this commits is found here.
      const found = await lockedPendingMachine(tx, id);
      // Machines first, then the Pending Machine: the order a hello takes them in, so neither waits on the other in a cycle.
      const refused = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM machines
        WHERE identification = 'MISMATCH' AND reported_model = ${found.model} AND reported_serial = ${found.serial}
        ORDER BY id
        FOR UPDATE`;
      const pending = found.dismissedAt ? found : await tx.pendingMachine.update({ where: { id }, data: { dismissedAt: at } });
      await tx.dismissedHardware.createMany({
        data: refused.map((machine) => ({ machineId: machine.id, model: pending.model, serial: pending.serial })),
        skipDuplicates: true,
      });
      await tx.machine.updateMany({
        where: { id: { in: refused.map((machine) => machine.id) } },
        data: { refusalReason: dismissedReason(pending), refusedAt: at },
      });
      // Delivered on commit: each instance closes its connections reporting this hardware with those tokens.
      for (const machine of refused) await notifyAccessChanged(tx, machine.id);
      return { pending, refused };
    });

    return view(
      pending,
      refused.map((machine) => ({ ...machine, reportedModel: pending.model, reportedSerial: pending.serial })),
    );
  }
}

/**
 * The Pending Machine, with its hardware locked: it is read again under the
 * lock, as a hello or an Admin may have given the hardware to a Machine,
 * which removes it, while the lock was awaited.
 */
async function lockedPendingMachine(tx: Prisma.TransactionClient, id: string): Promise<PendingMachine> {
  const found = await tx.pendingMachine.findUnique({ where: { id } });
  if (!found) throw pendingMachineNotFound();
  await lockHardware(tx, found);
  const pending = await tx.pendingMachine.findUnique({ where: { id } });
  if (!pending) throw pendingMachineNotFound();
  return pending;
}

function view(
  pending: PendingMachine,
  mismatched: { id: string; name: string; reportedModel: string | null; reportedSerial: string | null }[],
): PendingMachineView {
  return {
    id: pending.id,
    model: pending.model,
    serial: pending.serial,
    firstSeenAt: pending.createdAt.toISOString(),
    lastSeenAt: pending.lastSeenAt?.toISOString() ?? null,
    dismissed: pending.dismissedAt !== null,
    mismatchedMachines: mismatched
      .filter((machine) => machine.reportedModel === pending.model && machine.reportedSerial === pending.serial)
      .map(({ id, name }) => ({ id, name })),
  };
}
