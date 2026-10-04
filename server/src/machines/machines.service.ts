import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { ErrorCode, Hello } from "@decent-sync/protocol";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { type Machine, MachineIdentification, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type Hardware, type Identity, isRealSerial, realHardware, resolveIdentity, sameHardware } from "../sync/identity.js";
import { notifyAccessChanged } from "./access-changes.js";
import type { LiveConnection } from "./connections.js";
import { type NewMachine, machineNotFound } from "./input.js";

/**
 * A connection not heard from for this many heartbeat intervals no longer
 * keeps its Machine online, as when the instance holding it crashed. The
 * instance closes a connection that silent itself.
 */
export const MISSED_HEARTBEATS = 3;

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
  /** Whether a plugin is connected with the Machine's token right now, to any server instance. */
  online: boolean;
  /** When a plugin connected with its token was last heard from, or null if never. */
  lastSeenAt: string | null;
}

/** What became of a `hello`, decided and recorded while its Machine was locked. */
export type HelloOutcome =
  | { accepted: false; code: Extract<ErrorCode, "bad_token" | "hardware_dismissed">; reason: string }
  | {
      accepted: true;
      machine: { id: string; name: string };
      identity: Exclude<Identity, { kind: "rejected" }>;
      /** The real hardware the `hello` reported, if any. */
      hardware: Hardware | null;
      /** For a mismatch no Machine has the hardware of: the Pending Machine holding what the session sends. */
      pendingMachineId: string | null;
    };

/** Why a welcomed connection may no longer stay. */
export interface Refusal {
  code: Extract<ErrorCode, "bad_token" | "hardware_dismissed" | "replaced">;
  reason: string;
}

const BAD_TOKEN = "No Machine on this server has this token; it may have been replaced by a newer one";
const REPLACED_TOKEN = "This Machine's token was replaced by a newer one; enter the new token in the plugin's settings";
const REPLACED_CONNECTION = "A newer connection with this Machine's token took over";

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
    @Inject(CONFIG) private readonly config: Config,
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
    // Locked, so a concurrent reissue revokes this one's token rather than missing it.
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, id))) throw machineNotFound();
      await tx.machineToken.updateMany({ where: { machineId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.machineToken.create({ data: { machineId: id, tokenHash: hashSecret(token) } });
      // Delivered on commit: every instance closes the connections using the old token.
      await notifyAccessChanged(tx, id);
    });
    return { machine: await this.get(id), token };
  }

  /**
   * An Admin enters an Unidentified Machine's model and serial, which makes it
   * identified. The connection id it last connected from is remembered as its
   * alias, so its tablet is recognised again although its machine reports no
   * real serial.
   */
  async identify(id: string, hardware: Hardware): Promise<MachineView> {
    await this.prisma
      .$transaction(async (tx) => {
        // Locked, so a hello binding other hardware cannot interleave.
        if (!(await lockMachine(tx, id))) throw machineNotFound();
        const machine = (await tx.machine.findUnique({ where: { id } }))!;
        const binding = bindingOf(machine);
        // Unbound, it is still the Unidentified Machine it was while its tablet starts before its machine.
        const reportedNoSerial = machine.reportedSerial !== null && !isRealSerial(machine.reportedSerial);
        if (machine.identification !== MachineIdentification.UNIDENTIFIED && !(binding === null && reportedNoSerial)) {
          throw new ConflictException(`Only an Unidentified Machine's model and serial can be entered; ${machine.name} is not one`);
        }
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
      })
      .catch(async (error: unknown) => {
        // A hello bound the hardware to another Machine meanwhile.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const owner = await this.prisma.machine.findFirst({ where: hardware, select: { name: true } });
          throw new ConflictException(`${owner ? `Machine ${owner.name}` : "Another Machine"} already has ${describeHardware(hardware)}`);
        }
        throw error;
      });
    return this.get(id);
  }

  /** The Machine a token belongs to, unless the token is unknown or revoked. */
  async findByToken(token: string): Promise<Machine | null> {
    const found = await this.prisma.machineToken.findUnique({ where: { tokenHash: hashSecret(token) }, include: { machine: true } });
    return found && found.revokedAt === null ? found.machine : null;
  }

  /**
   * Decides who a tablet is and records it, with its Machine locked: binding
   * the hardware, remembering the connection id, holding a mismatch's
   * hardware as a Pending Machine, or recording why it was refused. Two
   * hellos with the same token, a token reissue and an Admin entering the
   * hardware are therefore decided one at a time, each seeing what the one
   * before it committed, on whichever instance they run.
   *
   * An accepted hello makes `sessionId` the connection holding the Machine
   * and notifies every instance, which closes the one it replaces. A refused
   * hello changes neither, so it never replaces a connection.
   */
  async acceptHello(hello: Hello, sessionId: string, at: Date): Promise<HelloOutcome> {
    try {
      return await this.prisma.$transaction((tx) => this.decideHello(tx, hello, sessionId, at));
    } catch (error) {
      // Another Machine bound the same hardware meanwhile; decided again, this is a mismatch.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return this.prisma.$transaction((tx) => this.decideHello(tx, hello, sessionId, at));
      }
      throw error;
    }
  }

  /**
   * Whether a welcomed connection may stay: its token still current, its
   * mismatched hardware not dismissed for that token, and still the
   * connection holding its Machine. Read from the database, so it reflects
   * changes made on any instance.
   */
  async standing(connection: LiveConnection): Promise<Refusal | null> {
    const [token, machine, dismissed] = await Promise.all([
      this.prisma.machineToken.findUnique({ where: { tokenHash: connection.tokenHash }, select: { revokedAt: true } }),
      this.prisma.machine.findUnique({ where: { id: connection.machineId }, select: { connectedSessionId: true } }),
      connection.mismatch
        ? this.prisma.dismissedHardware.count({ where: { machineId: connection.machineId, ...connection.mismatch } })
        : 0,
    ]);
    if (!token || token.revokedAt !== null) return { code: "bad_token", reason: REPLACED_TOKEN };
    if (connection.mismatch && dismissed > 0) return { code: "hardware_dismissed", reason: dismissedReason(connection.mismatch) };
    if (machine?.connectedSessionId !== connection.sessionId) return { code: "replaced", reason: REPLACED_CONNECTION };
    return null;
  }

  /** A heartbeat: the connection's Machine was seen, if the connection still holds it. */
  async heard(connection: LiveConnection): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE machines SET last_seen_at = now()
      WHERE id = ${connection.machineId}::uuid AND connected_session_id = ${connection.sessionId}::uuid`;
  }

  /**
   * Releases the Machine a closed connection held, if it still held it, and
   * says whether it did: a replaced connection's close leaves its Machine
   * to the connection that replaced it. A close frame was heard from the
   * plugin, so it is the last time it was seen; a dropped connection was last
   * seen at its last heartbeat.
   */
  async released(sessionId: string, closeFrameHeard: boolean): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE machines
      SET connected_session_id = NULL, last_seen_at = CASE WHEN ${closeFrameHeard} THEN now() ELSE last_seen_at END
      WHERE connected_session_id = ${sessionId}::uuid`;
    return count > 0;
  }

  /** Releases every Machine these connections hold, as when their instance shuts down. */
  async releaseAll(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    await this.prisma.machine.updateMany({ where: { connectedSessionId: { in: sessionIds } }, data: { connectedSessionId: null } });
  }

  private async decideHello(tx: Prisma.TransactionClient, hello: Hello, sessionId: string, at: Date): Promise<HelloOutcome> {
    const token = await tx.machineToken.findUnique({ where: { tokenHash: hashSecret(hello.token) }, select: { machineId: true } });
    if (!token) return { accepted: false, code: "bad_token", reason: BAD_TOKEN };
    await lockMachine(tx, token.machineId);
    // Read again under the lock: a reissue may have revoked it since.
    const current = await tx.machineToken.findUnique({ where: { tokenHash: hashSecret(hello.token) }, select: { revokedAt: true } });
    if (!current || current.revokedAt !== null) return { accepted: false, code: "bad_token", reason: BAD_TOKEN };

    const machine = (await tx.machine.findUnique({
      where: { id: token.machineId },
      include: { ...withAliases, dismissedHardware: { select: { model: true, serial: true } } },
    }))!;
    const hardware = realHardware(hello.machine);
    const anotherMachineHasIt =
      hardware !== null && (await tx.machine.count({ where: { ...hardware, NOT: { id: machine.id } } })) > 0;
    const identity = resolveIdentity(
      hello,
      {
        binding: bindingOf(machine),
        aliases: machine.aliases.map((alias) => alias.connectionId),
        dismissed: machine.dismissedHardware,
      },
      anotherMachineHasIt,
    );

    if (identity.kind === "rejected") {
      const reason = dismissedReason(identity.hardware);
      await tx.machine.update({ where: { id: machine.id }, data: { refusalReason: reason, refusedAt: at } });
      return { accepted: false, code: "hardware_dismissed", reason };
    }

    const reported = hello.machine;
    const connectionId = hello.connectionId?.trim() || null;
    await tx.machine.update({
      where: { id: machine.id },
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
        connectedSessionId: sessionId,
      },
    });
    await touch(tx, machine.id);
    // Delivered on commit: the instance holding the connection this replaces closes it.
    await notifyAccessChanged(tx, machine.id);
    if ("rememberAlias" in identity && identity.rememberAlias && connectionId) {
      await tx.machineAlias.createMany({ data: [{ machineId: machine.id, connectionId }], skipDuplicates: true });
    }
    if (identity.kind === "identified" && identity.bind) {
      // The Machine takes over whatever was held for its hardware.
      await tx.pendingMachine.deleteMany({ where: hardware! });
    }
    let pendingMachineId: string | null = null;
    let decided: typeof identity = identity;
    if (identity.kind === "mismatch" && !identity.anotherMachineHasIt) {
      const pending = await tx.pendingMachine.upsert({
        where: { model_serial: identity.hardware },
        create: { ...identity.hardware, lastSeenAt: at },
        update: { lastSeenAt: at },
      });
      // The upsert may have waited for an Admin creating a machine entry for this hardware;
      // then that Machine has it, and the Pending Machine just written is not needed.
      if ((await tx.machine.count({ where: identity.hardware })) > 0) {
        await tx.pendingMachine.delete({ where: { id: pending.id } });
        decided = { ...identity, anotherMachineHasIt: true };
      } else {
        pendingMachineId = pending.id;
      }
    }
    return { accepted: true, machine: { id: machine.id, name: machine.name }, identity: decided, hardware, pendingMachineId };
  }

  /** Records why a connection with the Machine's token was refused, for its page. */
  async recordRefusal(machineId: string, reason: string, at = new Date()): Promise<void> {
    await this.prisma.machine.updateMany({ where: { id: machineId }, data: { refusalReason: reason, refusedAt: at } });
  }

  private async views(machines: MachineWithAliases[]): Promise<MachineView[]> {
    // Last-seen times are written by the database's clock, so they are judged by it too, whatever the instances' clocks say.
    const [{ now }] = await this.prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
    const heardSince = now.getTime() - this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
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
        online: machine.connectedSessionId !== null && machine.lastSeenAt !== null && machine.lastSeenAt.getTime() >= heardSince,
        lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
      };
    });
  }
}

export function describeHardware(hardware: Hardware): string {
  return `${hardware.model} serial ${hardware.serial}`;
}

export function dismissedReason(hardware: Hardware): string {
  return `An Admin dismissed ${describeHardware(hardware)}, which a tablet reported with this Machine's token`;
}

/** Records that the Machine was seen now, by the database's clock, which every instance shares. */
async function touch(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`UPDATE machines SET last_seen_at = now() WHERE id = ${id}::uuid`;
}

/**
 * Locks the Machine's row until the transaction ends, so whatever decides
 * its identity or tokens runs one at a time. Returns false if there is none.
 */
async function lockMachine(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM machines WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length > 0;
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
