import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import { type HeldRecord, type LocationBatch, type OfferedBean, type OfferedGrinder, type PlannedWrite, type ShownProfile, plannedWrites } from "./holdings.js";

// What a connection's tablet is due: the next write that brings it to what
// its Machine's Location offers (holdings.ts), read from the database each
// time, so it reflects changes made through any instance.

/** A connection whose tablet is written to: its session, which must still hold its Machine, the Machine and its tablet. */
export interface WrittenTablet {
  sessionId: string;
  machineId: string;
  tabletId: string;
}

/** What a connection's tablet is due: where its Machine is now, and the writes due there. */
export interface TabletDue {
  /** The Location its Machine is at now, or null if none. */
  locationId: string | null;
  /** The writes due, in the order they are made; null while none is planned, as the Machine is not where they were reported. */
  writes: PlannedWrite[] | null;
}

/**
 * Where the connection's Machine is now, and the writes its tablet is due,
 * leaving out the items in `skipped` (`writeKey`). No write is due while
 * the Machine is not at the Location its tablet's latest reports of its
 * beans, bean batches, grinders and profiles were all taken in at (`reportedAt`), so a
 * tablet is written only what the Library knows it lacks once what it holds
 * is taken in there, and a bean it holds already is linked rather than
 * written again. Read in one snapshot. Null while the connection no longer
 * holds its Machine.
 */
export async function tabletDue(
  prisma: PrismaService,
  tablet: WrittenTablet,
  reportedAt: string | null,
  skipped: ReadonlySet<string>,
): Promise<TabletDue | null> {
  return prisma.$transaction(
    async (tx) => {
      const [holder] = await tx.$queryRaw<{ locationId: string | null }[]>`
        SELECT (
          SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
        ) AS "locationId"
        FROM machines WHERE id = ${tablet.machineId}::uuid AND connected_session_id = ${tablet.sessionId}::uuid`;
      if (!holder) return null;
      const { locationId } = holder;
      if (locationId === null || locationId !== reportedAt) return { locationId, writes: null };
      // Each with the latest decision of whether any of its batches is there: a write to the Bean carries it.
      const beans = await tx.$queryRaw<OfferedBean[]>`
        SELECT beans.id, beans.content, ${presenceDecidedSql(Prisma.raw("beans.id"), locationId)} AS "decidedAt" FROM beans
        WHERE NOT beans.archived AND (
          EXISTS (SELECT 1 FROM bean_origins AS origin WHERE origin.bean_id = beans.id AND origin.location_id = ${locationId}::uuid)
          OR EXISTS (
            SELECT 1 FROM bean_batches AS batch
            JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
            WHERE batch.bean_id = beans.id AND NOT batch.archived AND here.added_at IS NOT NULL AND here.finished_at IS NULL
          )
        )
        ORDER BY beans.created_at, beans.id`;
      // The batches the Location offers, then the others the tablet holds, each with its state there.
      const batches = await tx.$queryRaw<(Omit<LocationBatch, "remainingWeight"> & { remainingWeight: number | null; entered: boolean })[]>`
        SELECT batch.id, batch.bean_id AS "beanId", batch.content,
          (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived) AS offered,
          here.remaining_weight AS "remainingWeight", here.remaining_weight_at IS NOT NULL AS entered, here.presence_decided_at AS "decidedAt"
        FROM bean_batches AS batch
        JOIN beans AS bean ON bean.id = batch.bean_id
        LEFT JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
        WHERE (here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived)
          OR EXISTS (SELECT 1 FROM tablet_bean_batches AS held WHERE held.batch_id = batch.id AND held.tablet_id = ${tablet.tabletId}::uuid)
        ORDER BY 4 DESC, batch.created_at, batch.id`;
      const heldBeans = await tx.$queryRaw<HeldRecord[]>`
        SELECT bean_id AS "itemId", local_id AS "localId", record, ${presenceDecidedSql(Prisma.raw("tablet_beans.bean_id"), locationId)} AS "decidedAt"
        FROM tablet_beans WHERE tablet_id = ${tablet.tabletId}::uuid ORDER BY bean_id`;
      const heldBatches = await tx.$queryRaw<HeldRecord[]>`
        SELECT batch_id AS "itemId", local_id AS "localId", record FROM tablet_bean_batches WHERE tablet_id = ${tablet.tabletId}::uuid ORDER BY batch_id`;
      const grinders = await tx.$queryRaw<OfferedGrinder[]>`
        SELECT id, content FROM grinders WHERE location_id = ${locationId}::uuid AND NOT archived ORDER BY created_at, id`;
      const heldGrinders = await tx.$queryRaw<HeldRecord[]>`
        SELECT grinder_id AS "itemId", local_id AS "localId", record FROM tablet_grinders WHERE tablet_id = ${tablet.tabletId}::uuid ORDER BY grinder_id`;
      // Each Profile's content only where the tablet lacks it, to create its record with: what a Location shows is many and large.
      const profiles = await tx.$queryRaw<ShownProfile[]>`
        SELECT profiles.id, profiles.bundled, here.decided_at AS "decidedAt",
          CASE WHEN held.profile_id IS NULL AND NOT profiles.bundled THEN profiles.content END AS content
        FROM profiles
        JOIN profile_locations AS here ON here.profile_id = profiles.id AND here.location_id = ${locationId}::uuid AND here.shown
        LEFT JOIN tablet_profiles AS held ON held.profile_id = profiles.id AND held.tablet_id = ${tablet.tabletId}::uuid
        WHERE NOT profiles.archived
        ORDER BY profiles.created_at, profiles.id`;
      // Each with when the Location last decided whether it shows it: a write hiding it carries that decision.
      const heldProfiles = await tx.$queryRaw<HeldRecord[]>`
        SELECT held.profile_id AS "itemId", held.profile_id AS "localId", jsonb_build_object('visibility', held.record -> 'visibility') AS record,
          here.decided_at AS "decidedAt"
        FROM tablet_profiles AS held
        LEFT JOIN profile_locations AS here ON here.profile_id = held.profile_id AND here.location_id = ${locationId}::uuid
        WHERE held.tablet_id = ${tablet.tabletId}::uuid ORDER BY held.profile_id`;
      const offer = {
        beans,
        batches: batches.map(({ entered, remainingWeight, ...batch }) => ({ ...batch, remainingWeight: entered ? remainingWeight : undefined })),
        grinders,
        profiles,
      };
      return { locationId, writes: plannedWrites(offer, { beans: heldBeans, batches: heldBatches, grinders: heldGrinders, profiles: heldProfiles }, skipped) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** The latest decision of whether any of a Bean's batches is at the Location, by PostgreSQL's clock; null if none was ever decided. */
function presenceDecidedSql(beanId: Prisma.Sql, locationId: string): Prisma.Sql {
  return Prisma.sql`(
    SELECT max(here.presence_decided_at) FROM batch_locations AS here JOIN bean_batches AS batch ON batch.id = here.batch_id
    WHERE batch.bean_id = ${beanId} AND here.location_id = ${locationId}::uuid
  )`;
}
