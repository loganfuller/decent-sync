import type { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";

// Takeovers (ticket #62): an accepted `hello` replaces the connection holding
// its Machine. When that connection was live, heard from within
// MISSED_HEARTBEATS heartbeat intervals, and came from another tablet, two
// tablets were using one token at once, and the one replaced may be the one
// on the machine, so the latest such takeover is recorded on the Machine for
// its page. Replacing a dead connection, or one from the same tablet, as when
// a tablet reconnects while the server still holds its old connection, is
// routine and records nothing.

/** A connection holding a Machine, or taking it over, as a takeover records it. */
export interface TakeoverConnectionView {
  /** The tablet it came from. */
  tabletId: string;
  /** The address it came from, as the server saw it: behind a proxy, the proxy's. */
  remoteAddress: string;
  /** The connection id, plugin and Decaid versions its `hello` reported. */
  connectionId: string | null;
  pluginVersion: string;
  decaidVersion: string;
}

/** A Machine's latest takeover, as its view shows it. */
export interface TakeoverView {
  /** When the `hello` that took over was accepted, by PostgreSQL's clock. */
  at: string;
  /** The live connection, from another tablet, that it replaced. */
  replaced: TakeoverConnectionView;
  /** The connection that took over. */
  replacement: TakeoverConnectionView;
}

/**
 * Records that `replacement` took the Machine over from `replaced` at `at`,
 * in place of any earlier takeover. Called by the transaction accepting the
 * replacement's `hello`, which holds the Machine's row lock.
 */
export async function recordTakeover(
  tx: Prisma.TransactionClient,
  machineId: string,
  at: Date,
  replaced: TakeoverConnectionView,
  replacement: TakeoverConnectionView,
): Promise<void> {
  const data = {
    at,
    replacedTabletId: replaced.tabletId,
    replacedRemoteAddress: replaced.remoteAddress,
    replacedConnectionId: replaced.connectionId,
    replacedPluginVersion: replaced.pluginVersion,
    replacedDecaidVersion: replaced.decaidVersion,
    ...replacement,
  };
  await tx.takeover.upsert({ where: { machineId }, create: { machineId, ...data }, update: data });
}

/** Each Machine's latest takeover, for those that have one. */
export async function takeoversOf(prisma: PrismaService, machineIds: string[]): Promise<Map<string, TakeoverView>> {
  const takeovers = machineIds.length === 0 ? [] : await prisma.takeover.findMany({ where: { machineId: { in: machineIds } } });
  return new Map(
    takeovers.map((takeover) => [
      takeover.machineId,
      {
        at: takeover.at.toISOString(),
        replaced: {
          tabletId: takeover.replacedTabletId,
          remoteAddress: takeover.replacedRemoteAddress,
          connectionId: takeover.replacedConnectionId,
          pluginVersion: takeover.replacedPluginVersion,
          decaidVersion: takeover.replacedDecaidVersion,
        },
        replacement: {
          tabletId: takeover.tabletId,
          remoteAddress: takeover.remoteAddress,
          connectionId: takeover.connectionId,
          pluginVersion: takeover.pluginVersion,
          decaidVersion: takeover.decaidVersion,
        },
      },
    ]),
  );
}
