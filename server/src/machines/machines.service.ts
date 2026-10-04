import { ConflictException, Injectable } from "@nestjs/common";
import type { Hello } from "@decent-sync/protocol";
import { type Machine, MachineIdentification, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type Hardware, type Identity, type TokenMachine, realHardware, sameHardware } from "../sync/identity.js";
import { type NewMachine, machineNotFound } from "./input.js";
import { Presence } from "./presence.js";

/** How a Machine's identity stands, as the REST API names it. */
export type IdentificationView = "identified" | "hardwareNotReported" | "unidentified" | "mismatch";

/** A Machine as the REST API returns it. */
export interface MachineView {
  id: string;
  name: string;
  /** The hardware the Machine's token is bound to, or null until a connection reports it or an Admin enters it. */
  model: string | null;
  serial: string | null;
  identification: IdentificationView;
  /**
   * The hardware the latest connection that reported any did, as reported:
   * the Machine's own, the other hardware of a mismatch, or the "0" serial
   * of an Unidentified Machine.
   */
  reported: { model: string; serial: string; firmware: string | null } | null;
  /** The connection id and versions of the latest accepted connection. */
  connectionId: string | null;
  pluginVersion: string | null;
  decaidVersion: string | null;
  /** Connection ids known to be this Machine's, oldest first. */
  aliases: string[];
  /** While identification is mismatch: the hardware reported, and whose it is. */
  mismatch: {
    model: string;
    serial: string;
    /** The Pending Machine holding what the connection sends, while no Machine has the hardware. */
    pendingMachineId: string | null;
    /** The Machine that has the hardware, if one does. */
    machine: { id: string; name: string } | null;
  } | null;
  /** Why a connection with its token was last refused, until one is accepted. */
  lastRefusal: { reason: string; at: string } | null;
  /** Whether a plugin is connected with the Machine's token right now. */
  online: boolean;
  /** When a plugin connected with its token was last heard from, or null if never. */
  lastSeenAt: string | null;
}

/** The token's Machine, with what identity resolution needs. */
export type MachineForHello = Machine & { tokenMachine: TokenMachine };

type MachineWithAliases = Machine & { aliases: { connectionId: string }[] };

const IDENTIFICATION: Record<MachineIdentification, IdentificationView> = {
  HARDWARE_NOT_REPORTED: "hardwareNotReported",
  IDENTIFIED: "identified",
  UNIDENTIFIED: "unidentified",
  MISMATCH: "mismatch",
};

const withAliases = { aliases: { orderBy: { createdAt: "asc" }, select: { connectionId: true } } } as const;

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: Presence,
  ) {}

  /** Every Machine, by name. */
  async list(): Promise<MachineView[]> {
    return this.views(await this.prisma.machine.findMany({ orderBy: { name: "asc" }, include: withAliases }));
  }

  async get(id: string): Promise<MachineView> {
    const machine = await this.prisma.machine.findUnique({ where: { id }, include: withAliases });
    if (!machine) throw machineNotFound();
    return (await this.views([machine]))[0]!;
  }

  /** Creates a machine entry and its first token. The token is returned only here. */
  async create(fields: NewMachine): Promise<{ machine: MachineView; token: string }> {
    const token = newSecret();
    const machine = await this.prisma.machine
      .create({ data: { name: fields.name, tokens: { create: { tokenHash: hashSecret(token) } } } })
      .catch(refuseDuplicateName(fields.name));
    return { machine: await this.get(machine.id), token };
  }

  /** Issues the Machine a new token and revokes the old one, closing any connection that uses it. */
  async reissueToken(id: string): Promise<{ machine: MachineView; token: string }> {
    const token = newSecret();
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.machine.findUnique({ where: { id }, select: { id: true } }))) throw machineNotFound();
      await tx.machineToken.updateMany({ where: { machineId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.machineToken.create({ data: { machineId: id, tokenHash: hashSecret(token) } });
    });
    this.presence.end(id, "bad_token", "This Machine's token was replaced by a newer one; enter the new token in the plugin's settings");
    return { machine: await this.get(id), token };
  }

  /**
   * An Admin enters an Unidentified Machine's model and serial, which makes it
   * identified. The connection id it last connected from is remembered as its
   * alias, so its tablet is recognised again although its machine reports no
   * real serial.
   */
  async identify(id: string, hardware: Hardware): Promise<MachineView> {
    await this.prisma.$transaction(async (tx) => {
      const machine = await tx.machine.findUnique({ where: { id } });
      if (!machine) throw machineNotFound();
      if (machine.identification !== MachineIdentification.UNIDENTIFIED) {
        throw new ConflictException(`Only an Unidentified Machine's model and serial can be entered; ${machine.name} is not one`);
      }
      const binding = bindingOf(machine);
      if (binding && !sameHardware(binding, hardware)) {
        throw new ConflictException(
          `${machine.name} is bound to ${describeHardware(binding)}. Create a machine entry for other hardware instead`,
        );
      }
      const owner = await tx.machine.findFirst({ where: { ...hardware, NOT: { id } }, select: { name: true } });
      if (owner) throw new ConflictException(`Machine ${owner.name} already has ${describeHardware(hardware)}`);

      await tx.machine.update({ where: { id }, data: { ...hardware, identification: MachineIdentification.IDENTIFIED } });
      if (machine.connectionId) {
        await tx.machineAlias.createMany({ data: [{ machineId: id, connectionId: machine.connectionId }], skipDuplicates: true });
      }
      // The Machine takes over whatever was held for its hardware.
      await tx.pendingMachine.deleteMany({ where: hardware });
    });
    return this.get(id);
  }

  /** The Machine a token belongs to, unless the token is unknown or revoked. */
  async findByToken(token: string): Promise<MachineForHello | null> {
    const found = await this.prisma.machineToken.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { machine: { include: { ...withAliases, dismissedHardware: { select: { model: true, serial: true } } } } },
    });
    if (!found || found.revokedAt !== null) return null;
    const { aliases, dismissedHardware, ...machine } = found.machine;
    return {
      ...machine,
      tokenMachine: {
        binding: bindingOf(machine),
        aliases: aliases.map((alias) => alias.connectionId),
        dismissed: dismissedHardware,
      },
    };
  }

  /** Whether a Machine other than this one is bound to the hardware. */
  async anotherMachineHas(machineId: string, hardware: Hardware): Promise<boolean> {
    return (await this.prisma.machine.count({ where: { ...hardware, NOT: { id: machineId } } })) > 0;
  }

  /**
   * Records an accepted `hello` and what identity resolution decided: binds
   * the hardware, remembers the connection id, and holds a mismatch's
   * hardware as a Pending Machine when no Machine has it. Returns that
   * Pending Machine's id.
   */
  async recordHello(machineId: string, hello: Hello, identity: Identity, at: Date): Promise<{ pendingMachineId: string | null }> {
    if (identity.kind === "rejected") throw new Error("A rejected hello is recorded as a refusal");
    const reported = hello.machine;
    const hardware = realHardware(reported);
    const connectionId = hello.connectionId?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      await tx.machine.update({
        where: { id: machineId },
        data: {
          identification: identificationOf(identity),
          ...(reported
            ? { reportedModel: reported.model.trim(), reportedSerial: reported.serial.trim(), firmware: reported.firmware ?? null }
            : {}),
          ...(identity.kind === "identified" && identity.bind ? hardware! : {}),
          connectionId,
          pluginVersion: hello.pluginVersion,
          decaidVersion: hello.decaidVersion ?? null,
          refusalReason: null,
          refusedAt: null,
          lastSeenAt: at,
        },
      });
      if ("rememberAlias" in identity && identity.rememberAlias && connectionId) {
        await tx.machineAlias.createMany({ data: [{ machineId, connectionId }], skipDuplicates: true });
      }
      if (identity.kind === "identified" && identity.bind) {
        await tx.pendingMachine.deleteMany({ where: hardware! });
      }
      if (identity.kind === "mismatch" && !identity.anotherMachineHasIt) {
        const pending = await tx.pendingMachine.upsert({
          where: { model_serial: identity.hardware },
          create: { ...identity.hardware, lastSeenAt: at },
          update: { lastSeenAt: at },
        });
        return { pendingMachineId: pending.id };
      }
      return { pendingMachineId: null };
    });
  }

  /** Records why a connection with the Machine's token was refused, for its page. */
  async recordRefusal(machineId: string, reason: string, at = new Date()): Promise<void> {
    await this.prisma.machine.updateMany({ where: { id: machineId }, data: { refusalReason: reason, refusedAt: at } });
  }

  async markSeen(machineId: string, at: Date): Promise<void> {
    await this.prisma.machine.updateMany({ where: { id: machineId }, data: { lastSeenAt: at } });
  }

  private async views(machines: MachineWithAliases[]): Promise<MachineView[]> {
    // A mismatch's hardware belongs to a Machine, or else to a Pending Machine.
    const mismatched = machines.flatMap((machine) => {
      const hardware = machine.identification === MachineIdentification.MISMATCH ? reportedHardware(machine) : null;
      return hardware ? [hardware] : [];
    });
    const [owners, pending] =
      mismatched.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.machine.findMany({ where: { OR: mismatched }, select: { id: true, name: true, model: true, serial: true } }),
            this.prisma.pendingMachine.findMany({ where: { OR: mismatched }, select: { id: true, model: true, serial: true } }),
          ]);

    return machines.map((machine) => {
      const hardware = machine.identification === MachineIdentification.MISMATCH ? reportedHardware(machine) : null;
      const owner = hardware && owners.find((candidate) => sameHardware(bindingOf(candidate)!, hardware));
      return {
        id: machine.id,
        name: machine.name,
        model: machine.model,
        serial: machine.serial,
        identification: IDENTIFICATION[machine.identification],
        reported:
          machine.reportedModel !== null && machine.reportedSerial !== null
            ? { model: machine.reportedModel, serial: machine.reportedSerial, firmware: machine.firmware }
            : null,
        connectionId: machine.connectionId,
        pluginVersion: machine.pluginVersion,
        decaidVersion: machine.decaidVersion,
        aliases: machine.aliases.map((alias) => alias.connectionId),
        mismatch: hardware
          ? {
              ...hardware,
              pendingMachineId: pending.find((candidate) => sameHardware(candidate, hardware))?.id ?? null,
              machine: owner ? { id: owner.id, name: owner.name } : null,
            }
          : null,
        lastRefusal:
          machine.refusalReason !== null && machine.refusedAt !== null
            ? { reason: machine.refusalReason, at: machine.refusedAt.toISOString() }
            : null,
        online: this.presence.isOnline(machine.id),
        lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
      };
    });
  }
}

export function describeHardware(hardware: Hardware): string {
  return `${hardware.model} serial ${hardware.serial}`;
}

/** Turns a unique-name violation into a message naming the clash. */
export function refuseDuplicateName(name: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ConflictException(`A Machine named ${name} already exists`);
    }
    throw error;
  };
}

function bindingOf(machine: { model: string | null; serial: string | null }): Hardware | null {
  return machine.model !== null && machine.serial !== null ? { model: machine.model, serial: machine.serial } : null;
}

function reportedHardware(machine: Machine): Hardware | null {
  if (machine.reportedModel === null || machine.reportedSerial === null) return null;
  return realHardware({ model: machine.reportedModel, serial: machine.reportedSerial });
}

function identificationOf(identity: Exclude<Identity, { kind: "rejected" }>): MachineIdentification {
  switch (identity.kind) {
    case "identified":
      return MachineIdentification.IDENTIFIED;
    case "hardwareNotReported":
      return MachineIdentification.HARDWARE_NOT_REPORTED;
    case "unidentified":
      return MachineIdentification.UNIDENTIFIED;
    case "mismatch":
      return MachineIdentification.MISMATCH;
  }
}
