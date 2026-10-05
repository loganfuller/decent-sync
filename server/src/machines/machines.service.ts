import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { type ErrorCode, type Hello, MISSED_HEARTBEATS } from "@decent-sync/protocol";
import { EVERYTHING, type Scope, seesLocation } from "../accounts/scope.js";
import { transferPendingCollections } from "../collections/transfer.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { type Machine, MachineIdentification, Prisma } from "../generated/prisma/client.js";
import type { LocationView } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { type Hardware, type Identity, isRealSerial, realHardware, resolveIdentity, sameHardware } from "../sync/identity.js";
import { notifyAccessChanged } from "./access-changes.js";
import type { LiveConnection } from "./connections.js";
import { type NewMachine, machineNotFound } from "./input.js";
import { type LocationHistoryEntryView, creditLocations, startLocationHistory, viewLocationHistory, withLocationHistory } from "./location-history.js";
import { machinesInScope, requireMachineInScope } from "./scope.js";

/** How a Machine's identity stands, as the REST API names it. */
export type IdentificationView = "identified" | "hardwareNotReported" | "unidentified" | "mismatch";

/**
 * A Machine as the REST API returns it. Staff see it only while it is at one
 * of their Locations, and nothing of it from elsewhere: its Last Shot and
 * Location History are only those at their Locations, and a mismatch names
 * no Pending Machine and only a Machine they see.
 */
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
  lastShot: { id: string; pulledAt: string | null } | null;
  /** What it is doing: the latest machine state stored for it, or null before any. */
  machineState: MachineStateView | null;
  /** Where it is now: the Location of its Location History's latest entry, or null if it has none. */
  location: LocationView | null;
  /** Where it has been, oldest first. Each entry lasts until the next one's time. */
  locationHistory: LocationHistoryEntryView[];
}

/** A machine state as Decaid names it, and when the plugin observed it, by the tablet's clock. */
export interface MachineStateView {
  state: string;
  substate: string;
  observedAt: string;
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
    };

/** Why a welcomed connection may no longer stay. */
export interface Refusal {
  code: Extract<ErrorCode, "bad_token" | "hardware_dismissed" | "replaced">;
  reason: string;
}

const BAD_TOKEN = "No Machine on this server has this token; it may have been replaced by a newer one";
const REPLACED_TOKEN = "This Machine's token was replaced by a newer one; enter the new token in the plugin's settings";
const REPLACED_CONNECTION = "A newer connection with this Machine's token took over";
const REVOKED_TOKEN = "A tablet connected with a token that was replaced by a newer one; enter the new token in its plugin's settings";

const withAliases = { aliases: { orderBy: { createdAt: "asc" }, select: { connectionId: true } } } as const;
const listed = { ...withAliases, ...withLocationHistory } as const satisfies Prisma.MachineInclude;
type ListedMachine = Prisma.MachineGetPayload<{ include: typeof listed }>;

const IDENTIFICATION: Record<MachineIdentification, IdentificationView> = {
  HARDWARE_NOT_REPORTED: "hardwareNotReported",
  IDENTIFIED: "identified",
  UNIDENTIFIED: "unidentified",
  MISMATCH: "mismatch",
};

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** The Machines the scope includes, by name. */
  async list(scope: Scope): Promise<MachineView[]> {
    const where = await machinesInScope(this.prisma, scope);
    return this.views(await this.prisma.machine.findMany({ where, orderBy: { name: "asc" }, include: listed }), scope);
  }

  async get(id: string, scope: Scope): Promise<MachineView> {
    await requireMachineInScope(this.prisma, id, scope);
    const machine = await this.prisma.machine.findUnique({ where: { id }, include: listed });
    if (!machine) throw machineNotFound();
    return (await this.views([machine], scope))[0]!;
  }

  /**
   * Creates a machine entry and its first token, at its Location from now if
   * it is given one. The token is returned only here.
   */
  async create(fields: NewMachine): Promise<{ machine: MachineView; token: string }> {
    const token = newSecret();
    const machine = await this.prisma
      .$transaction(async (tx) => {
        const machine = await tx.machine.create({ data: { name: fields.name, tokens: { create: { tokenHash: hashSecret(token) } } } });
        await startLocationHistory(tx, machine.id, fields.locationId);
        return machine;
      })
      .catch(refuseDuplicateName(fields.name));
    return { machine: await this.get(machine.id, EVERYTHING), token };
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
    return { machine: await this.get(id, EVERYTHING), token };
  }

  /**
   * An Admin enters an Unidentified Machine's model and serial, which makes it
   * identified. The connection id its machine reported no real serial from is
   * remembered as its alias, so its tablet is recognised again.
   */
  async identify(id: string, hardware: Hardware): Promise<MachineView> {
    await this.prisma
      .$transaction(async (tx) => {
        // Locked, so a hello binding other hardware, or reporting this hardware, cannot interleave.
        await lockHardware(tx, hardware);
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
        if (owner) throw hardwareTaken(owner.name, hardware);

        await tx.machine.update({ where: { id }, data: { ...hardware, identification: MachineIdentification.IDENTIFIED } });
        // Only an unidentified hello was the one reporting no serial. Hardware not reported since
        // means a later hello's connection id, maybe another tablet's; the one that reported "0"
        // was remembered then, as an unbound Machine's always is.
        if (machine.identification === MachineIdentification.UNIDENTIFIED && machine.connectionId) {
          await tx.machineAlias.createMany({ data: [{ machineId: id, connectionId: machine.connectionId }], skipDuplicates: true });
        }
        // The Machine takes over whatever was held for its hardware.
        await transferPendingRecords(tx, hardware, id);
        await tx.pendingMachine.deleteMany({ where: hardware });
      })
      .catch(async (error: unknown) => {
        // A hello bound the hardware to another Machine meanwhile.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          const owner = await this.prisma.machine.findFirst({ where: hardware, select: { name: true } });
          throw hardwareTaken(owner ? owner.name : null, hardware);
        }
        throw error;
      });
    return this.get(id, EVERYTHING);
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
   * Whether each welcomed connection may stay (`refusalOf`), in the order
   * given. Read from the database, so it reflects changes made on any
   * instance, in the same three queries however many connections there are.
   */
  async standings(connections: readonly LiveConnection[]): Promise<(Refusal | null)[]> {
    if (connections.length === 0) return [];
    const mismatched = connections.flatMap((connection) =>
      connection.mismatch ? [{ machineId: connection.machineId, ...connection.mismatch }] : [],
    );
    const [tokens, machines, dismissed] = await Promise.all([
      this.prisma.machineToken.findMany({
        where: { tokenHash: { in: connections.map((connection) => connection.tokenHash) }, revokedAt: null },
        select: { tokenHash: true },
      }),
      this.prisma.machine.findMany({
        where: { id: { in: [...new Set(connections.map((connection) => connection.machineId))] } },
        select: { id: true, connectedSessionId: true },
      }),
      mismatched.length === 0
        ? []
        : this.prisma.dismissedHardware.findMany({ where: { OR: mismatched }, select: { machineId: true, model: true, serial: true } }),
    ]);
    const currentTokens = new Set(tokens.map((token) => hex(token.tokenHash)));
    const holders = new Map(machines.map((machine) => [machine.id, machine.connectedSessionId]));
    return connections.map((connection) =>
      refusalOf(connection, {
        tokenCurrent: currentTokens.has(hex(connection.tokenHash)),
        dismissed: dismissed.some((hardware) => hardware.machineId === connection.machineId && sameHardware(hardware, connection.mismatch)),
        holds: holders.get(connection.machineId) === connection.sessionId,
      }),
    );
  }

  /**
   * A heartbeat: the connection's Machine was seen, if the connection still
   * holds it, and whether the connection may stay, in one query.
   */
  async heard(connection: LiveConnection): Promise<Refusal | null> {
    const [standing] = await this.prisma.$queryRaw<[Standing]>`
      WITH seen AS (
        UPDATE machines SET last_seen_at = now()
        WHERE id = ${connection.machineId}::uuid AND connected_session_id = ${connection.sessionId}::uuid
        RETURNING id
      )
      SELECT
        EXISTS (SELECT 1 FROM machine_tokens WHERE token_hash = ${connection.tokenHash} AND revoked_at IS NULL) AS "tokenCurrent",
        EXISTS (
          SELECT 1 FROM dismissed_hardware
          WHERE machine_id = ${connection.machineId}::uuid
            AND model = ${connection.mismatch?.model ?? null}::text AND serial = ${connection.mismatch?.serial ?? null}::text
        ) AS dismissed,
        EXISTS (SELECT 1 FROM seen) AS holds`;
    return refusalOf(connection, standing);
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
    const hardware = realHardware(hello.machine);
    // The hardware before the Machine, the order everything taking both takes them in.
    if (hardware) await lockHardware(tx, hardware);
    await lockMachine(tx, token.machineId);
    // Read again under the lock: a reissue may have revoked it since.
    const current = await tx.machineToken.findUnique({ where: { tokenHash: hashSecret(hello.token) }, select: { revokedAt: true } });
    if (!current || current.revokedAt !== null) {
      // A tablet still using the Machine's old token: its page shows why it cannot connect.
      await tx.machine.update({ where: { id: token.machineId }, data: { refusalReason: REVOKED_TOKEN, refusedAt: at } });
      return { accepted: false, code: "bad_token", reason: REPLACED_TOKEN };
    }

    const machine = (await tx.machine.findUnique({
      where: { id: token.machineId },
      include: { ...withAliases, dismissedHardware: { select: { model: true, serial: true } } },
    }))!;
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
        decaidVersion: hello.decaidVersion,
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
      await transferPendingRecords(tx, hardware!, machine.id);
      await tx.pendingMachine.deleteMany({ where: hardware! });
    }
    if (identity.kind === "mismatch" && !identity.anotherMachineHasIt) {
      // No Machine can be given the hardware meanwhile: that takes the hardware's lock, held here.
      // Seen by the database's clock, as Machines are, whatever the instances' clocks say.
      const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
      await tx.pendingMachine.upsert({
        where: { model_serial: identity.hardware },
        create: { ...identity.hardware, lastSeenAt: now },
        update: { lastSeenAt: now },
      });
    }
    return { accepted: true, machine: { id: machine.id, name: machine.name }, identity, hardware };
  }

  /** Records why a connection with the Machine's token was refused, for its page. */
  async recordRefusal(machineId: string, reason: string, at = new Date()): Promise<void> {
    await this.prisma.machine.updateMany({ where: { id: machineId }, data: { refusalReason: reason, refusedAt: at } });
  }

  private async views(machines: ListedMachine[], scope: Scope): Promise<MachineView[]> {
    // Last-seen times are written by the database's clock, so they are judged by it too, whatever the instances' clocks say.
    const [{ now }] = await this.prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
    // A connection unheard for MISSED_HEARTBEATS intervals no longer keeps its Machine online, as when the instance holding it crashed.
    const heardSince = now.getTime() - this.config.heartbeatIntervalMs * MISSED_HEARTBEATS;
    // A mismatch's hardware belongs to a Machine, or else to a Pending Machine.
    const mismatched = machines.flatMap((machine) => {
      const hardware = machine.identification === MachineIdentification.MISMATCH ? reportedHardware(machine) : null;
      return hardware ? [hardware] : [];
    });
    // Each Machine's last Shot and latest machine state are one index probe each, however long its history.
    // Staff see only the Shots at their Locations.
    const shotsInScope = scope.kind === "everything" ? Prisma.empty : Prisma.sql`AND location_id = ANY(${scope.locationIds}::uuid[])`;
    const [owners, pending, lastShots, states] = await Promise.all([
      mismatched.length === 0
        ? []
        : this.prisma.machine.findMany({
            where: { AND: [{ OR: mismatched }, await machinesInScope(this.prisma, scope)] },
            select: { id: true, name: true, model: true, serial: true },
          }),
      mismatched.length === 0 || scope.kind !== "everything"
        ? []
        : this.prisma.pendingMachine.findMany({ where: { OR: mismatched }, select: { id: true, model: true, serial: true } }),
      machines.length === 0 ? [] : this.prisma.$queryRaw<{ id: string; machineId: string; pulledAt: Date | null }[]>(Prisma.sql`
        SELECT last.id, listed.id AS "machineId", last.pulled_at AS "pulledAt"
        FROM unnest(${machines.map((machine) => machine.id)}::uuid[]) AS listed(id)
        CROSS JOIN LATERAL (
          -- Only full records are credited, so this needs no has_full_record check.
          SELECT id, pulled_at FROM shots WHERE machine_id = listed.id ${shotsInScope}
          ORDER BY pulled_at DESC NULLS LAST, id ASC LIMIT 1
        ) AS last`),
      machines.length === 0 ? [] : this.prisma.$queryRaw<{ machineId: string; state: string; substate: string; observedAt: Date }[]>(Prisma.sql`
        SELECT listed.id AS "machineId", latest.state, latest.substate, latest.observed_at AS "observedAt"
        FROM unnest(${machines.map((machine) => machine.id)}::uuid[]) AS listed(id)
        CROSS JOIN LATERAL (
          SELECT state, substate, observed_at FROM machine_state_events WHERE machine_id = listed.id
          ORDER BY id DESC LIMIT 1
        ) AS latest`),
    ]);
    const lastByMachine = new Map(lastShots.map((shot) => [shot.machineId, { id: shot.id, pulledAt: shot.pulledAt?.toISOString() ?? null }]));
    const stateByMachine = new Map(
      states.map(({ machineId, state, substate, observedAt }) => [machineId, { state, substate, observedAt: observedAt.toISOString() }]),
    );
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
        lastShot: lastByMachine.get(machine.id) ?? null,
        machineState: stateByMachine.get(machine.id) ?? null,
        ...viewLocationHistory(historyInScope(machine.locationHistory, scope)),
      };
    });
  }
}

/**
 * For Staff, a Machine's Location History since it last arrived at one of
 * their Locations, where it is now: nothing of its time elsewhere.
 */
function historyInScope<Entry extends { locationId: string }>(history: Entry[], scope: Scope): Entry[] {
  let start = history.length;
  while (start > 0 && seesLocation(scope, history[start - 1]!.locationId)) start--;
  return history.slice(start);
}

/** What decides whether a welcomed connection may stay. */
interface Standing {
  /** Its token is not revoked. */
  tokenCurrent: boolean;
  /** Its mismatched hardware was dismissed for its token's Machine. */
  dismissed: boolean;
  /** It is still the connection holding its Machine. */
  holds: boolean;
}

/**
 * Why a welcomed connection may no longer stay, if it may not: its token was
 * replaced, its mismatched hardware dismissed, or a newer connection holds
 * its Machine.
 */
function refusalOf(connection: LiveConnection, standing: Standing): Refusal | null {
  if (!standing.tokenCurrent) return { code: "bad_token", reason: REPLACED_TOKEN };
  if (connection.mismatch && standing.dismissed) return { code: "hardware_dismissed", reason: dismissedReason(connection.mismatch) };
  if (!standing.holds) return { code: "replaced", reason: REPLACED_CONNECTION };
  return null;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function describeHardware(hardware: Hardware): string {
  return `${hardware.model} serial ${hardware.serial}`;
}

/** Refuses giving hardware to a Machine when another Machine, named if known, has it. */
export function hardwareTaken(owner: string | null, hardware: Hardware): ConflictException {
  return new ConflictException(`${owner === null ? "Another Machine" : `Machine ${owner}`} already has ${describeHardware(hardware)}`);
}

export function dismissedReason(hardware: Hardware): string {
  return `An Admin dismissed ${describeHardware(hardware)}, which a tablet reported with this Machine's token`;
}

/** Records that the Machine was seen now, by the database's clock, which every instance shares. */
async function touch(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`UPDATE machines SET last_seen_at = now() WHERE id = ${id}::uuid`;
}

// Advisory locks on hardware use this as their first key, and a hash of the
// model and serial as their second. Any constant works; two-key locks never
// clash with the single-key ones this server takes.
const HARDWARE_LOCK = 4_000_002;

/**
 * Locks the hardware until the transaction ends, so whatever gives it to a
 * Machine, holds it as a Pending Machine, or dismisses it runs one at a time,
 * including a hello whose Machine's row does not yet show the hardware. Taken
 * before any Machine's row, an order that cannot deadlock. Hardware whose
 * hashes collide only waits for each other.
 */
export async function lockHardware(tx: Prisma.TransactionClient, hardware: Hardware): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HARDWARE_LOCK}::int, hashtext(${hardware.model}::text || '/' || ${hardware.serial}::text))`;
}

/**
 * Locks the Machine's row until the transaction ends, so whatever decides
 * its identity or tokens, changes its Location History, or credits a record
 * to it by that history, runs one at a time. Returns false if there is none.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: it excludes the others just the same,
 * but lets foreign-key checks on rows referencing the Machine through. A
 * Shot edit that writes its row twice checks that key again, and with FOR
 * UPDATE it would wait for a Location History change that is itself waiting
 * for the Shot's row.
 */
export async function lockMachine(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM machines WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
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

/**
 * Gives the Machine whatever is held for its hardware, even by a dismissed
 * Pending Machine: its Shots and Steam Records, credited by its Location
 * History, its Workflow and machine state events, and its collections. The
 * Machine's row lock must be held, or the Machine created in this transaction.
 */
export async function transferPendingRecords(tx: Prisma.TransactionClient, hardware: Hardware, machineId: string): Promise<void> {
  const handover = { machineId, pendingMachineId: null };
  await tx.shot.updateMany({ where: { pendingMachine: hardware }, data: handover });
  await tx.steamRecord.updateMany({ where: { pendingMachine: hardware }, data: handover });
  await tx.workflowEvent.updateMany({ where: { pendingMachine: hardware }, data: handover });
  await tx.machineStateEvent.updateMany({ where: { pendingMachine: hardware }, data: handover });
  await transferPendingCollections(tx, hardware, machineId);
  await creditLocations(tx, machineId);
}
