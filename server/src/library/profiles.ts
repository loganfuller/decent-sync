import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import {
  type AnswerRecorded,
  type AnsweringTablet,
  INTAKE_TRANSACTION,
  type ReportingTablet,
  type SeenDecision,
  currentLocation,
  keepSeenSql,
  lockHeldMachine,
  lockTablet,
  seenAtSql,
} from "./intake.js";
import { listedIds } from "./listed.js";
import { decideProfileAt, deletedAt, lockLocation, showProfileAt, transactionTime } from "./location-state.js";
import { planProfileIntake, profileContent, readReportedProfiles } from "./profile-intake.js";

// The Library's Profiles and the tablets that hold them (ADR-0003, ADR-0006,
// ADR-0008, ADR-0018, ADR-0019). A Profile keeps Decaid's id, a hash of what
// the machine executes, which is the same on every tablet: an identical
// Profile created on two tablets is one Profile, and one whose steps change
// is a new Profile under a new id. A tablet at a Location reports its
// profiles, hidden and deleted ones included, as a collection; new ones join
// the Library, shown at that Location only. Hiding, deleting or replacing
// one on the tablet hides it at that Location, and making it visible shows it
// there (location-state.ts). Decaid's bundled Profiles join the Library as
// any other, so whether each is shown is per Location too, but are never
// written to a tablet, which has them already. The server keeps, per tablet,
// the record as the tablet last had it, under the locks beans.ts takes.

// Every report with profiles new to the tablet's map takes this advisory lock before it reads the Library's.
const PROFILE_JOINING_LOCK = 4_000_008;

/**
 * Takes a tablet's report of its profiles into the Library, as `takeInBeans`
 * takes its beans, in the transaction storing the report. A report with
 * profiles new to the tablet's map holds one advisory lock while it reads and
 * adds to the Library's, so two tablets reporting the same new Profile at
 * once make one, at whichever Location first. Returns the Location the report
 * was taken in at, or null if none.
 */
export async function takeInProfiles(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  value: unknown,
  updatedAt: readonly (string | null)[] | undefined,
): Promise<string | null> {
  const locationId = await currentLocation(tx, tablet.machineId);
  if (locationId === null) return null;
  const reported = readReportedProfiles(value, updatedAt);
  await lockTablet(tx, tablet.tabletId);
  const mapped = await tx.$queryRaw<{ profileId: string; updatedAt: Date | null; visible: boolean; seenAt: Date | null }[]>`
    SELECT profile_id AS "profileId", record_updated_at AS "updatedAt", (record ->> 'visibility') = 'visible' AS visible, ${seenAtSql(locationId)} AS "seenAt"
    FROM tablet_profiles WHERE tablet_id = ${tablet.tabletId}::uuid`;
  /** The Location's latest decision of each Profile that the tablet's record the map holds has seen there: one decided by then, the tablet had seen. */
  const seenAt = new Map(mapped.map((profile) => [profile.profileId, profile.seenAt]));
  const mappedIds = new Set(mapped.map((profile) => profile.profileId));
  const unmapped = reported.flatMap((profile) => (mappedIds.has(profile.id) ? [] : [profile.id]));
  if (unmapped.length > 0) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROFILE_JOINING_LOCK}::bigint)`;
  // The Library Profiles the new records are.
  const library = unmapped.length === 0 ? [] : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM profiles WHERE id = ANY(${unmapped}::text[])`;
  if (reported.length === 0 && mapped.length === 0) return locationId;
  // Whether the Location shows each Profile reported that it has decided, and when that was decided, read under its lock.
  await lockLocation(tx, locationId);
  const located = await tx.$queryRaw<{ profileId: string; shown: boolean; changedAt: Date }[]>`
    SELECT profile_id AS "profileId", shown, changed_at AS "changedAt" FROM profile_locations
    WHERE location_id = ${locationId}::uuid AND profile_id = ANY(${reported.map((profile) => profile.id)}::text[])`;
  const steps = planProfileIntake(
    reported,
    mapped,
    new Set(library.map((profile) => profile.id)),
    new Map(located.map(({ profileId, ...state }) => [profileId, state])),
    unmapped.length === 0 ? null : await joinedAt(tx, tablet),
    listedIds(value),
  );
  if (steps.length === 0) return locationId;

  /** Whether the Location's tablets, this one included, may have something to be written. */
  let writesDue = false;
  for (const step of steps) {
    if (step.kind === "delete") {
      await tx.$executeRaw`DELETE FROM tablet_profiles WHERE tablet_id = ${tablet.tabletId}::uuid AND profile_id = ${step.profileId}`;
      if (step.shown === false) {
        await showProfileAt(tx, step.profileId, locationId, false, deletedAt(await transactionTime(tx), step.updatedAt), seenAt.get(step.profileId) ?? null);
      }
      writesDue = true;
      continue;
    }
    if (step.kind === "decide") {
      const decided = await decideProfileAt(tx, step.profileId, locationId, step.shown, step.at);
      if (decided !== null) {
        writesDue = true;
        // The tablet's record decided it, so it has seen that.
        await tx.$executeRaw`
          UPDATE tablet_profiles SET
            seen_at = CASE WHEN seen_location_id = ${locationId}::uuid THEN GREATEST(seen_at, ${decided}::timestamptz) ELSE ${decided}::timestamptz END,
            seen_location_id = ${locationId}::uuid
          WHERE tablet_id = ${tablet.tabletId}::uuid AND profile_id = ${step.profileId}`;
      }
      continue;
    }
    const { profile } = step;
    if (step.kind === "add") {
      await tx.$executeRaw`
        INSERT INTO profiles (id, content, bundled, created_location_id)
        VALUES (${profile.id}, ${JSON.stringify(profileContent(profile.record))}::jsonb, ${profile.bundled}, ${locationId}::uuid)
        ON CONFLICT (id) DO NOTHING`;
    }
    /** When the record's own edit decided the Profile's state at the Location, which it has seen then; null if it did not. */
    let decided: Date | null = null;
    if (step.kind === "update") {
      if (step.shown !== undefined) decided = await showProfileAt(tx, profile.id, locationId, step.shown, profile.updatedAt, seenAt.get(profile.id) ?? null);
      writesDue = decided !== null || writesDue;
    } else {
      // The tablet holds it as the Location has it, or is written so; the Location's other tablets may lack it.
      if (step.decide !== undefined) decided = await decideProfileAt(tx, profile.id, locationId, step.decide, profile.updatedAt);
      // The map did not hold it, so only its time tells whether the tablet saw the Location's state.
      if (step.kind === "map" && step.shown) decided = (await showProfileAt(tx, profile.id, locationId, true, profile.updatedAt, null)) ?? decided;
      writesDue = true;
    }
    // A report shows nothing of what the tablet saw of others' decisions, only of the one its own edit made.
    await saveRecord(tx, tablet.tabletId, profile.id, profile.record, profile.updatedAt, decided === null ? null : { at: decided, locationId });
  }
  if (writesDue) await notify(tx, "library_changes", locationId);
  return locationId;
}

/**
 * Records a Profile's record as Decaid returned the plugin's write of it, as
 * `recordBeanWritten` does a Bean's: the tablet's record of that Profile from
 * now on, whatever the time of the record known. Every write of a Profile
 * sets its visibility, so its answer shows no change the tablet made at its
 * Location. Recorded only while the answering connection holds its Machine,
 * under the Machine's and the tablet's locks, in the order a report takes
 * them. The record has seen the Location's decision of the Profile that the
 * write carried (`seen`), if its Machine is still at that Location; null
 * says nothing new, as for an answer to a write no longer awaited. Nothing
 * is recorded
 * when the record is another Profile's, as one a Decaid hashing profiles
 * otherwise would make, or when the Library no longer has the Profile.
 */
export async function recordProfileWritten(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  profileId: string,
  record: Record<string, unknown>,
  updatedAt: string | null,
  seen: SeenDecision | null,
): Promise<AnswerRecorded> {
  if (record.id !== profileId) return "notTheItem";
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    if ((await tx.profile.count({ where: { id: profileId } })) === 0) return "notTheItem";
    const here = seen === null ? null : await currentLocation(tx, tablet.machineId);
    await saveRecord(tx, tablet.tabletId, profileId, record, updatedAt === null ? null : new Date(updatedAt), seen?.locationId === here ? seen : null);
    return "recorded";
  }, INTAKE_TRANSACTION);
}

/**
 * When the tablet joined its Machine's Location: the later of when the
 * Machine arrived there, by its Location History, and when the tablet first
 * connected as that Machine. What the tablet changed after that it changed
 * there; what it holds from before, it brought.
 */
async function joinedAt(tx: Prisma.TransactionClient, tablet: ReportingTablet): Promise<Date | null> {
  const [row] = await tx.$queryRaw<{ joinedAt: Date | null }[]>`
    SELECT GREATEST(
      (SELECT first_seen_at FROM machine_tablets WHERE tablet_id = ${tablet.tabletId}::uuid AND machine_id = ${tablet.machineId}::uuid),
      (SELECT effective_from FROM location_assignments WHERE machine_id = ${tablet.machineId}::uuid ORDER BY effective_from DESC LIMIT 1)
    ) AS "joinedAt"`;
  return row?.joinedAt ?? null;
}

/**
 * Saves the tablet's record of a Profile as the one it holds, as `saveRecord`
 * in beans.ts does a Bean's, with a decision of the Profile at its Location
 * it has now seen (`seen`): one the server's write carried, or one its own
 * edit made. It keeps the latest it has seen at one Location (`keepSeenSql`);
 * null keeps the one known.
 */
async function saveRecord(
  tx: Prisma.TransactionClient,
  tabletId: string,
  profileId: string,
  record: Record<string, unknown>,
  updatedAt: Date | null,
  seen: SeenDecision | null,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO tablet_profiles (tablet_id, profile_id, record, record_updated_at, seen_at, seen_location_id)
    VALUES (${tabletId}::uuid, ${profileId}, ${JSON.stringify(record)}::jsonb, ${updatedAt}::timestamptz, ${seen?.at ?? null}::timestamptz, ${seen?.locationId ?? null}::uuid)
    ON CONFLICT (tablet_id, profile_id) DO UPDATE SET
      record = EXCLUDED.record, record_updated_at = EXCLUDED.record_updated_at, ${keepSeenSql("tablet_profiles")}`;
}
