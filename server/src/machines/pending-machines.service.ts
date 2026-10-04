import { ConflictException, Injectable } from "@nestjs/common";
import { MachineIdentification, type PendingMachine } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { sameHardware } from "../sync/identity.js";
import { type NewMachine, pendingMachineNotFound } from "./input.js";
import { type MachineView, MachinesService, describeHardware, refuseDuplicateName } from "./machines.service.js";
import { Presence } from "./presence.js";

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
    private readonly presence: Presence,
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
    const machineId = await this.prisma.$transaction(async (tx) => {
      const pending = await tx.pendingMachine.findUnique({ where: { id } });
      if (!pending) throw pendingMachineNotFound();
      const hardware = { model: pending.model, serial: pending.serial };
      const owner = await tx.machine.findFirst({ where: hardware, select: { name: true } });
      if (owner) throw new ConflictException(`Machine ${owner.name} already has ${describeHardware(hardware)}`);

      const machine = await tx.machine
        .create({
          data: {
            name: fields.name,
            ...hardware,
            identification: MachineIdentification.IDENTIFIED,
            tokens: { create: { tokenHash: hashSecret(token) } },
          },
        })
        .catch(refuseDuplicateName(fields.name));
      await tx.pendingMachine.delete({ where: { id } });
      return machine.id;
    });
    return { machine: await this.machines.get(machineId), token };
  }

  /**
   * Dismisses the Pending Machine. Every Machine whose token's connection
   * reports it as a mismatch has that hardware refused from now on, and its
   * connection is closed.
   */
  async dismiss(id: string): Promise<PendingMachineView> {
    const at = new Date();
    const { pending, refused } = await this.prisma.$transaction(async (tx) => {
      const found = await tx.pendingMachine.findUnique({ where: { id } });
      if (!found) throw pendingMachineNotFound();
      const pending = found.dismissedAt ? found : await tx.pendingMachine.update({ where: { id }, data: { dismissedAt: at } });
      const refused = await tx.machine.findMany({
        where: { identification: MachineIdentification.MISMATCH, reportedModel: pending.model, reportedSerial: pending.serial },
        select: { id: true, name: true },
      });
      await tx.dismissedHardware.createMany({
        data: refused.map((machine) => ({ machineId: machine.id, model: pending.model, serial: pending.serial })),
        skipDuplicates: true,
      });
      return { pending, refused };
    });

    const hardware = { model: pending.model, serial: pending.serial };
    const reason = `An Admin dismissed ${describeHardware(hardware)}, which a tablet reported with this Machine's token`;
    for (const machine of refused) {
      await this.machines.recordRefusal(machine.id, reason, at);
      this.presence.end(machine.id, "hardware_dismissed", reason, (connection) =>
        connection.hardware !== null && sameHardware(connection.hardware, hardware),
      );
    }
    return view(
      pending,
      refused.map((machine) => ({ ...machine, reportedModel: pending.model, reportedSerial: pending.serial })),
    );
  }
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
