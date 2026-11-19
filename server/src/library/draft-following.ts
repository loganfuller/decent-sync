import { DRAFT_KIND, FOLLOWED_DRAFTS_WIRE_REVISION, MAX_PROFILE_STEPS, followedDraftTitle, peerHasWireRevision, readProfile } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import { stepsKeySql } from "../shots/links.js";
import type { PlannedWrite } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type PlannedTablet, lockHeldMachine } from "./intake.js";

// A Machine following a Draft (ADR-0032, ticket #581): the server's record
// that the Machine should hold the Draft's steps (`draft_followings`). While
// it does, the Machine's tablet is due the Draft's profile, set whole as its
// Workflow's profile, whenever the profile it was last written differs from
// the Draft's (`followedDraftDue`), so each save reaches it through its
// writer as a Library write does, held while a Shot runs. The Draft keeps
// each profile a following Machine was written (`draft_trials`), so a Shot
// pulled on that Machine with its steps from then on, until following on it
// ends, is a Trial Shot, tied to the steps it ran (`trialShotsSql`).
// Following ends when the Machine's Workflow comes to hold another profile
// than the Draft's, whatever changed it (`followedWorkflowReported`), when a
// person stops it, when its Location stops trying Drafts or the Machine
// leaves it (`endStrandedFollowings`),
// and, the row gone with the Draft, when the Draft is published or
// discarded. The server writes the Draft to it again only once a person
// follows again. Everything is in PostgreSQL, so every instance reads the
// same. The REST API's side is draft-following.service.ts.

/** Why a following ended (`draft_followings.ended_why`). */
export type FollowingEnded = "workflow" | "stopped" | "location";

/** What Decaid hashes for a Profile's id but its steps and target weight, as the Library compares a Shot's profile with a Profile's (shots/links.ts). */
const HASHED = ["version", "beverage_type", "tank_temperature", "target_volume", "target_volume_count_start"] as const;

/**
 * Whether two profiles, as JSONB, are the same steps as the Library compares
 * a Shot's with a Profile's (`shotPulledWithSql`): without each step's
 * temperature and without the target weight, which a tablet may change, and
 * whatever their titles. False where either is no profile.
 */
export function sameStepsSql(a: Prisma.Sql, b: Prisma.Sql): Prisma.Sql {
  const same = HASHED.map((field) => Prisma.sql`${a} -> ${field} IS NOT DISTINCT FROM ${b} -> ${field}`);
  return Prisma.sql`coalesce(${stepsKeySql(Prisma.sql`${a} -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${b} -> 'steps'`)} AND ${Prisma.join(same, " AND ")}, false)`;
}

/** A Draft's profile as a following Machine is written it: under the title a tablet shows it by (`followedDraftTitle`). */
export function followedProfile(profile: unknown): Record<string, unknown> | null {
  const read = readProfile(profile).profile;
  return read ? { ...read, title: followedDraftTitle(read.title) } : null;
}

/** Whether a plugin at the wire revision can follow a Draft; one whose revision is not known can't yet. */
export function canFollow(wireRevision: number | null): boolean {
  return wireRevision !== null && peerHasWireRevision(wireRevision, FOLLOWED_DRAFTS_WIRE_REVISION);
}

/** Whether the Machine follows a Draft now, and whether it was written the Draft since following began (`written`), which ended its Loaded Recipe; null for none. */
export async function draftFollowed(tx: Prisma.TransactionClient, machineId: string): Promise<{ written: boolean } | null> {
  const [row] = await tx.$queryRaw<{ written: boolean }[]>`SELECT trial_id IS NOT NULL AS written FROM draft_followings WHERE machine_id = ${machineId}::uuid AND ended_at IS NULL`;
  return row ?? null;
}

/**
 * Ends followings: `ended` is an UPDATE of `draft_followings` that ends some
 * and returns their `draft_id`s. Each profile those Drafts were written with
 * is no longer followed from now (`draft_trials.followed_until`), so a Shot
 * pulled afterwards is none of their Trial Shots: a Draft has one following,
 * so every profile of its still followed is that following's. One statement,
 * after the common table expressions in `before`, each followed by a comma.
 */
export function endFollowingsSql(ended: Prisma.Sql, before: Prisma.Sql = Prisma.empty): Prisma.Sql {
  return Prisma.sql`
    WITH ${before} ended AS (${ended})
    UPDATE draft_trials SET followed_until = statement_timestamp()
    WHERE draft_id IN (SELECT draft_id FROM ended) AND followed_until IS NULL`;
}

/**
 * The write of the Draft the Machine follows that its tablet is due at the
 * Location, or null: the Draft's profile, under the title a tablet shows it
 * by, while the Location tries Drafts and the profile the Machine was last
 * written since following began is another, or none. Nothing is due to a
 * plugin from before FOLLOWED_DRAFTS_WIRE_REVISION, nor for a Draft of no
 * steps or of more than a machine takes, which waits until it is saved with
 * some. The connection's wire revision where it is at hand, as its writer's
 * is, else the one its Machine's latest hello gave. Read in the caller's
 * snapshot.
 */
export async function followedDraftDue(tx: Prisma.TransactionClient, tablet: PlannedTablet, locationId: string): Promise<PlannedWrite | null> {
  const [row] = await tx.$queryRaw<{ draftId: string; profile: unknown; written: unknown; wireRevision: number | null }[]>`
    SELECT f.draft_id::text AS "draftId", d.profile, t.profile AS written, m.wire_revision AS "wireRevision"
    FROM draft_followings f
    JOIN drafts d ON d.id = f.draft_id
    JOIN machines m ON m.id = f.machine_id
    JOIN locations l ON l.id = ${locationId}::uuid AND l.tries_drafts
    LEFT JOIN draft_trials t ON t.id = f.trial_id
    WHERE f.machine_id = ${tablet.machineId}::uuid AND f.ended_at IS NULL`;
  if (!row || !canFollow(tablet.wireRevision ?? row.wireRevision)) return null;
  const profile = followedProfile(row.profile);
  if (profile === null || !sendable(profile)) return null;
  if (row.written !== null && sameJson(row.written, profile)) return null;
  return { kind: DRAFT_KIND, globalId: row.draftId, localId: null, fields: { profile }, decidedAt: null, contentDecidedAt: null };
}

/** Whether a profile has steps, and no more than a machine takes, so it can be a Workflow's. */
export function sendable(profile: { steps?: unknown }): boolean {
  return Array.isArray(profile.steps) && profile.steps.length > 0 && profile.steps.length <= MAX_PROFILE_STEPS;
}

/** Whether two JSON values are the same, whatever the order of their keys, as PostgreSQL's JSONB compares them. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => sameJson(left[key], right[key]));
}

/**
 * Records the plugin's answer to a write of the Draft its Machine follows:
 * the profile the write carried (`record.draft`) is what the Machine has
 * now, kept as a profile the Draft was tried with, timed by the tablet's
 * clock as the plugin had Decaid's answer (`tabletWrittenAt`, else now), one
 * equal to the latest kept for the Machine while it is still followed kept
 * once. Nothing is recorded
 * once the Machine no longer follows the Draft, as when it was stopped or
 * published meanwhile, though the Workflow holds the profile all the same.
 * The Draft's row is held for key share first, then the Machine's lock, then
 * the following's, the order publishing and following take them in.
 */
export async function recordFollowedDraftWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  draftId: string,
  record: Record<string, unknown>,
  tabletWrittenAt: string | null,
): Promise<AnswerRecorded> {
  const written = record.draft;
  if (typeof written !== "object" || written === null || Array.isArray(written)) return "notTheItem";
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    const drafts = await tx.$queryRaw<unknown[]>`SELECT 1 FROM drafts WHERE id = ${draftId}::uuid FOR KEY SHARE`;
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    if (drafts.length === 0) return "recorded";
    const following = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM draft_followings WHERE draft_id = ${draftId}::uuid AND machine_id = ${tablet.machineId}::uuid AND ended_at IS NULL FOR UPDATE`;
    if (following.length === 0) return "recorded";
    const profile = JSON.stringify(written);
    const [latest] = await tx.$queryRaw<{ id: string; same: boolean }[]>`
      SELECT id::text AS id, profile = ${profile}::jsonb AND followed_until IS NULL AS same FROM draft_trials
      WHERE draft_id = ${draftId}::uuid AND machine_id = ${tablet.machineId}::uuid ORDER BY written_at DESC, id DESC LIMIT 1`;
    let trialId = latest?.same ? latest.id : null;
    if (trialId === null) {
      const [made] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO draft_trials (id, draft_id, machine_id, profile, tablet_written_at)
        VALUES (gen_random_uuid(), ${draftId}::uuid, ${tablet.machineId}::uuid, ${profile}::jsonb, COALESCE(${tabletWrittenAt}::timestamptz, statement_timestamp()))
        RETURNING id::text AS id`;
      trialId = made!.id;
    }
    await tx.$executeRaw`UPDATE draft_followings SET trial_id = ${trialId}::uuid WHERE draft_id = ${draftId}::uuid`;
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * A Workflow its Machine's tablet reported, as it is stored: a following of
 * the Machine's ends where the Workflow's profile is no longer the Draft's
 * steps (`sameStepsSql`), whatever changed it, a barista, a Recipe or
 * Streamline's wake profile: neither the Draft's as saved now nor the one
 * the Machine was last written, as a report made before a save's write
 * landed still holds the steps written before it. An earlier profile of the
 * Draft's loaded again, as a Profile it started from, ends it too. Until the
 * Machine was written the Draft since following began, its Workflow holds
 * whatever it held, and nothing ends. The plugin sends its reports in the
 * order it made them, a write's answer ahead of the change it caused, so
 * one from before the write is taken in before the write is recorded.
 */
export async function followedWorkflowReported(tx: Prisma.TransactionClient, machineId: string, workflow: Record<string, unknown>): Promise<void> {
  // The reported profile bound once, as the comparisons name it many times.
  const reported = Prisma.sql`(SELECT profile FROM reported)`;
  await tx.$executeRaw(
    endFollowingsSql(
      Prisma.sql`
        UPDATE draft_followings f SET ended_at = statement_timestamp(), ended_why = 'workflow'
        FROM drafts d, draft_trials t
        WHERE f.machine_id = ${machineId}::uuid AND f.ended_at IS NULL AND d.id = f.draft_id AND t.id = f.trial_id
          AND NOT ${sameStepsSql(reported, Prisma.sql`d.profile`)}
          AND NOT ${sameStepsSql(reported, Prisma.sql`t.profile`)}
        RETURNING f.draft_id`,
      Prisma.sql`reported AS (SELECT ${JSON.stringify(workflow)}::jsonb -> 'profile' AS profile),`,
    ),
  );
}

/**
 * Ends each following whose Machine no longer takes part at a Location that
 * tries Drafts, as its Location's setting was turned off, or the Machine
 * left, or became capture-only, and each whose Machine moved since it began,
 * to whichever Location: all of them, or the Machine's.
 */
export async function endStrandedFollowings(db: Prisma.TransactionClient, machineId?: string): Promise<void> {
  await db.$executeRaw(
    endFollowingsSql(Prisma.sql`
      UPDATE draft_followings f SET ended_at = statement_timestamp(), ended_why = 'location'
      WHERE f.ended_at IS NULL AND (${machineId ?? null}::uuid IS NULL OR f.machine_id = ${machineId ?? null}::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM machines m
          JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS latest ON true
          JOIN LATERAL (
            SELECT location_id FROM location_assignments WHERE machine_id = m.id AND effective_from <= f.started_at ORDER BY effective_from DESC LIMIT 1
          ) AS began ON began.location_id = latest.location_id
          JOIN locations l ON l.id = latest.location_id AND l.tries_drafts
          WHERE m.id = f.machine_id AND m.sharing
        )
      RETURNING f.draft_id`),
  );
}

/** Tells every instance's writers that the Draft changed, where a Machine follows it, so its tablet is written it again. In the save's transaction. */
export async function followedDraftSaved(tx: Prisma.TransactionClient, draftId: string): Promise<void> {
  const [following] = await tx.$queryRaw<{ machineId: string }[]>`SELECT machine_id::text AS "machineId" FROM draft_followings WHERE draft_id = ${draftId}::uuid AND ended_at IS NULL`;
  // The payload is a Location's id for the Library's changes; every writer looks whichever it names, so the Draft's is given.
  if (following) await notify(tx, "library_changes", draftId);
}

/**
 * The Trial Shots of a Draft (ADR-0032), the latest first, at most `limit`:
 * each listed Shot credited to a Machine the Draft was written to, pulled,
 * by the tablet's clock, from when it was written a profile whose steps the
 * Shot's Workflow's profile holds (`sameStepsSql`), so it still matches
 * after the brew temperature or the yield was changed on the tablet, until
 * following on that Machine ended (by PostgreSQL's clock); tied to the
 * latest such profile written before it was pulled. Read through the
 * Shots' index on their Machine and time, from the first profile the
 * Machine was written, or the one on their steps.
 */
export function trialShotsSql(draftId: string, limit: number): Prisma.Sql {
  const shot = Prisma.sql`(s.record -> 'workflow' -> 'profile')`;
  return Prisma.sql`
    SELECT s.id, tied.id::text AS "trialId"
    FROM (
      SELECT machine_id, min(tablet_written_at) AS since,
        CASE WHEN bool_and(followed_until IS NOT NULL) THEN max(followed_until) END AS until
      FROM draft_trials WHERE draft_id = ${draftId}::uuid GROUP BY machine_id
    ) AS tried
    JOIN shots s ON s.machine_id = tried.machine_id AND s.pulled_at >= tried.since AND (tried.until IS NULL OR s.pulled_at <= tried.until)
      AND s.has_full_record
      AND ${stepsKeySql(Prisma.sql`s.record -> 'workflow' -> 'profile' -> 'steps'`)} IN (
        SELECT ${stepsKeySql(Prisma.sql`profile -> 'steps'`)} FROM draft_trials WHERE draft_id = ${draftId}::uuid
      )
    JOIN LATERAL (
      SELECT t.id FROM draft_trials t
      WHERE t.draft_id = ${draftId}::uuid AND t.machine_id = s.machine_id AND t.tablet_written_at <= s.pulled_at
        AND (t.followed_until IS NULL OR s.pulled_at <= t.followed_until) AND ${sameStepsSql(shot, Prisma.sql`t.profile`)}
      ORDER BY t.tablet_written_at DESC, t.id DESC LIMIT 1
    ) AS tied ON true
    ORDER BY s.pulled_at DESC, s.id LIMIT ${limit}`;
}
