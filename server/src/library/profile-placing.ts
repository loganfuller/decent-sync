import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { Notifications } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type PlacementPlan, type PlacingProfile, type PlacingRow, isEmptyPlan, linkedRows, needsPlacing, planPlacement } from "./profile-placement.js";
import { PROFILE_JOINING_LOCK } from "./profiles.js";

// Carries out the placing of Profile Versions in Profiles (ADR-0038, #735),
// by the rules of profile-placement.ts: as publishing or a tablet's report
// adds a `profiles` row, in that transaction, and in the background for the
// rows an upgrade finds, a row the previous release inserts beside this one
// (ADR-0025), and a change of where a version is shown or which Recipe names
// it that leaves a Profile's current version another than the one in use.
// The migration adds the schema only; this changes the stored rows, which
// the owner approved, by those rules, on 2026-11-27.
//
// Always under PROFILE_JOINING_LOCK, which a tablet's report of new profiles
// and publishing a Draft take before they add a row, so a Profile is never
// planned from rows another transaction is adding to. It is the first lock
// those take after a tablet's or a Draft's own, so a caller holds it before
// any Location's lock or item's row.

/** How often each server instance looks for rows to place, whatever it was told. */
export const PROFILE_PLACING_INTERVAL_MS = 60_000;
/** How long after the Library is said to have changed an instance looks, so a burst of changes is looked at once. */
export const PROFILE_PLACING_SETTLE_MS = 250;
/** The most rows one background transaction places, but for the rest of the linked rows of the last. */
export const PROFILE_PLACING_BATCH = 200;

/** Long enough for a batch on a slow database; waiting for a connection is limited as for any other transaction. */
const PLACING_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/** Whether any row has no Profile, any version in use is not its Profile's current one, or any Profile's current version is not its own. */
async function anythingToPlace(tx: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ due: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM profiles WHERE library_profile_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM profiles p JOIN library_profiles l ON l.id = p.library_profile_id
        WHERE l.current_version_id <> p.id AND ${inUseSql()})
      OR EXISTS (
        SELECT 1 FROM library_profiles l
        WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = l.current_version_id AND p.library_profile_id = l.id)) AS due`;
  return row?.due ?? false;
}

/** Whether the row of `profiles` aliased `p` is in use (profile-placement.ts): shown at a Location while not Archived, or named by a Recipe that is not Archived. */
function inUseSql(): Prisma.Sql {
  return Prisma.sql`((NOT p.archived AND EXISTS (SELECT 1 FROM profile_locations here WHERE here.profile_id = p.id AND here.shown))
    OR EXISTS (SELECT 1 FROM recipes r WHERE r.content ->> 'profileId' = p.id AND NOT r.archived))`;
}

/**
 * Places every row that has no Profile yet, and puts right each Profile
 * whose current version is not the one in use, in the caller's transaction,
 * which must hold PROFILE_JOINING_LOCK. `separate` names rows that start a
 * Profile of their own whatever they were saved from. With `limit`, stops
 * once that many rows are placed, at the end of the linked rows it is in;
 * `more` then says whether any are left. Returns how many rows were given a
 * Profile.
 */
export async function placeProfiles(
  tx: Prisma.TransactionClient,
  options: { separate?: readonly string[]; limit?: number } = {},
): Promise<{ placed: number; more: boolean }> {
  if (!(await anythingToPlace(tx))) return { placed: 0, more: false };
  const [rows, profiles] = await Promise.all([
    tx.$queryRaw<PlacingRow[]>`
      SELECT p.id, p.content ->> 'parentId' AS "parentId", p.bundled, ${inUseSql()} AS "inUse", p.created_at AS "joinedAt",
        p.library_profile_id::text AS "profileId", p.version_number AS "versionNumber"
      FROM profiles p`,
    tx.$queryRaw<PlacingProfile[]>`SELECT id::text AS id, current_version_id AS "currentVersionId", last_version_number AS "lastVersionNumber" FROM library_profiles`,
  ]);
  const separate = new Set(options.separate ?? []);
  const profilesOf = new Map<string, PlacingProfile>(profiles.map((profile) => [profile.id, profile]));
  let placed = 0;
  let more = false;
  // Profiles no row belongs to are in no set of linked rows.
  const held = new Set(rows.flatMap((row) => (row.profileId === null ? [] : [row.profileId])));
  const empty = profiles.filter((profile) => !held.has(profile.id)).map((profile) => profile.id);
  if (empty.length > 0) await tx.$executeRaw`DELETE FROM library_profiles WHERE id = ANY(${empty}::uuid[])`;
  for (const linked of linkedRows(rows)) {
    const theirs = [...new Set(linked.flatMap((row) => (row.profileId === null ? [] : [row.profileId])))].flatMap((id) => profilesOf.get(id) ?? []);
    if (!needsPlacing(linked, theirs)) continue;
    if (options.limit !== undefined && placed >= options.limit) {
      more = true;
      break;
    }
    const plan = planPlacement(linked, theirs, randomUUID, separate);
    if (isEmptyPlan(plan)) continue;
    await carryOut(tx, plan);
    placed += plan.placed.length;
  }
  return { placed, more };
}

/** Writes a plan: the Recipes that follow, the Profiles it makes, each row's Profile and number, and the current versions it changes. */
async function carryOut(tx: Prisma.TransactionClient, plan: PlacementPlan): Promise<void> {
  // An Archived Recipe naming an earlier version follows to the current one, with no entry in its history (ADR-0038): no
  // Recipe that is not Archived names one, as a version one names is in use, so is current or a Profile of its own.
  // Recipes' rows before the `profiles` rows, the order a Recipe's edit takes them, which locks its row and then the
  // Profile it names FOR SHARE: the other way round, an edit of one of these Recipes deadlocks with placing.
  for (const profile of plan.touched) {
    const earlier = profile.versionIds.filter((id) => id !== profile.currentVersionId);
    if (earlier.length === 0) continue;
    await tx.$executeRaw`
      UPDATE recipes SET content = jsonb_set(content, '{profileId}', to_jsonb(${profile.currentVersionId}::text))
      WHERE content ->> 'profileId' = ANY(${earlier}::text[]) AND archived`;
  }
  // A Profile started from another made here references it, so those started from none first, then the rest without it, set after.
  for (const made of plan.created) {
    await tx.$executeRaw`
      INSERT INTO library_profiles (id, current_version_id, created_at) VALUES (${made.id}::uuid, ${made.currentVersionId}, ${made.createdAt})`;
  }
  for (const made of plan.created) {
    if (made.startedFromId !== null) await tx.$executeRaw`UPDATE library_profiles SET started_from_id = ${made.startedFromId}::uuid WHERE id = ${made.id}::uuid`;
  }
  // A row that leaves a Profile for its own takes number 1 there, which no other row of that Profile has.
  for (const row of plan.placed) {
    await tx.$executeRaw`UPDATE profiles SET library_profile_id = ${row.profileId}::uuid, version_number = ${row.versionNumber} WHERE id = ${row.id}`;
  }
  // The highest number each Profile has given, which it keeps when that version leaves it or is deleted.
  const numbered = [...new Set(plan.placed.map((row) => row.profileId))];
  if (numbered.length > 0) {
    await tx.$executeRaw`
      UPDATE library_profiles l SET last_version_number = GREATEST(l.last_version_number, given.number)
      FROM (SELECT library_profile_id, max(version_number) AS number FROM profiles WHERE library_profile_id = ANY(${numbered}::uuid[]) GROUP BY library_profile_id) given
      WHERE l.id = given.library_profile_id`;
  }
  for (const change of plan.current) {
    await tx.$executeRaw`UPDATE library_profiles SET current_version_id = ${change.versionId} WHERE id = ${change.profileId}::uuid`;
  }
  if (plan.removed.length > 0) await tx.$executeRaw`DELETE FROM library_profiles WHERE id = ANY(${plan.removed}::uuid[])`;
}

/**
 * Places the `profiles` rows that have no Profile, and puts right the
 * Profiles whose current version is not the one in use (`placeProfiles`), as
 * the server starts, then whenever any instance says the Library changed
 * (`library_changes`) and every minute besides, on every instance, in the
 * background, in batches, as `SettingsHistoryBaselines` takes baselines. The
 * first run converts the rows an upgrade finds; the later ones take what the
 * previous release adds or changes while it still serves beside this one
 * (ADR-0025), which says so on the same channel, and what this release
 * changes outside a transaction that places for itself, as a tablet's
 * report that shows an earlier version again. A look that finds nothing is
 * one query, under no lock. Each batch holds PROFILE_JOINING_LOCK, so two
 * instances never place the same row. A run that fails is logged, and the
 * next tries again.
 */
@Injectable()
export class ProfilePlacing implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ProfilePlacing");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    notifications: Notifications,
  ) {
    // Told of a change, or that some may have been missed, it looks soon, once for a burst of them.
    notifications.subscribe("library_changes", () => {
      if (this.started && !this.stopped) this.schedule(PROFILE_PLACING_SETTLE_MS);
    });
  }

  private started = false;

  onApplicationBootstrap(): void {
    this.started = true;
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish its batch. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Looks in `delayMs`, or sooner if a look is due sooner; one in progress looks again once it ends. */
  private schedule(delayMs: number): void {
    const at = Date.now() + delayMs;
    if (this.running) {
      this.again = Math.min(this.again ?? Infinity, delayMs);
      return;
    }
    if (this.timer !== undefined && this.dueAt <= at) return;
    clearTimeout(this.timer);
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.run()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.error(`Could not place the Library's Profile Versions in Profiles; trying again in a minute: ${String(error)}`))
        .finally(() => {
          this.running = undefined;
          const again = this.again;
          this.again = undefined;
          if (!this.stopped) this.schedule(again ?? PROFILE_PLACING_INTERVAL_MS);
        });
    }, delayMs);
  }

  /** When the timer set is due, and how soon to look again after the run in progress, if told of a change during it. */
  private dueAt = 0;
  private again: number | undefined;

  /** Places everything there is to place now, in batches; how many rows were given a Profile. Also called where a change outside a placing transaction may have left something to place, as a hard delete does. */
  async run(): Promise<number> {
    let placed = 0;
    while (!this.stopped) {
      if (!(await anythingToPlace(this.prisma))) break;
      const batch = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROFILE_JOINING_LOCK}::bigint)`;
        return placeProfiles(tx, { limit: PROFILE_PLACING_BATCH });
      }, PLACING_TRANSACTION);
      placed += batch.placed;
      if (!batch.more) break;
    }
    if (placed > 0) this.logger.log(`Placed ${placed} Profile ${placed === 1 ? "Version" : "Versions"} in ${placed === 1 ? "its Profile" : "their Profiles"}`);
    return placed;
  }
}
