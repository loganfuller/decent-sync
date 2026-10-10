import { Prisma } from "../generated/prisma/client.js";

// Shots linked to the Library (ticket #92). A Shot names its Bean Batch and
// Grinder by their ids on the tablet that reported it, which resolve to the
// Library's items through that tablet's map (ADR-0006). A Shot stored before
// Shots kept their tablet is not linked: data stored before v1 need not
// carry over. Each link is stored on the Shot once its tablet's map holds the
// id, as the Shot is stored or as the map gains the id later, so a Shot
// reported before its batch joined the Library is linked once it does. A
// link stays when the tablet's record leaves its map, as when a barista
// deletes it there: the Shot still used that batch.
//
// A Profile's id is Decaid's, the same on every tablet: a hash of what the
// machine executes (`ProfileHash.calculateProfileHash` in
// decaid:lib/src/models/data/profile_hash.dart), which a Shot's Workflow
// records as its profile, but not the id itself. So a Shot's Profile is read,
// with nothing stored, as the Library Profile whose id that profile hashes
// to: the one holding the same of what Decaid hashes, compared as JSON so a
// whole double Decaid writes as `92.0` equals 92, and a step's limiter of
// value 0 as none, as a skin may send it (`shotProfileSql`, `stepsKeySql`).
// A skin's other changes to the profile it loads, such as streamline-js's
// saved brew temperature written into every step, make a profile of their
// own, which the Library may lack. The
// profile id a skin records in the Workflow is not used: the WorkFlow skin
// (Sabotage1/WorkFlow-Skin) records the Profile picked in it, which stays as
// it was when another skin loads another profile, as Decaid merges a
// Workflow's changes into it.
//
// Every change to a tablet's map holds the tablet's row lock, and links the
// Shots it can then (`linkShots`); storing a Shot's metadata holds that row
// for share as it resolves its ids (`resolveLinks`). So either the map's
// change commits first, and the Shot's resolution finds it, or the Shot is
// stored first, and the map's change links it.

/** The kinds a Shot names by their ids on its tablet. */
export type LinkedKind = "beanBatch" | "grinder";

/** Each kind's columns on a Shot: its id on the tablet, and its link. */
const KINDS: Readonly<Record<LinkedKind, { local: string; link: string }>> = {
  beanBatch: { local: "bean_batch_id", link: "library_batch_id" },
  grinder: { local: "grinder_id", link: "library_grinder_id" },
};

/** A Shot's ids on its tablet, as its metadata names them, and its links. */
interface ShotLinks {
  beanBatchId: string | null;
  grinderId: string | null;
  libraryBatchId: string | null;
  libraryGrinderId: string | null;
}

/**
 * The links of the Shot whose metadata the tablet reported, naming the ids
 * given, through the tablet's map, holding its row for share until the
 * transaction ends. An id the map does not hold keeps the link the Shot has
 * while it names the same id, as its record may have left the map since;
 * otherwise it is unlinked, until the map gains it (`linkShots`). The Shot's
 * links are read under the tablet's row, as a map change may have linked it
 * while this waited for that or for its credit's locks.
 */
export async function resolveLinks(
  tx: Prisma.TransactionClient,
  tabletId: string,
  shotId: string,
  ids: { beanBatchId: string | null; grinderId: string | null },
): Promise<{ libraryBatchId: string | null; libraryGrinderId: string | null }> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR SHARE`;
  const [resolved] = await tx.$queryRaw<{ batch: string | null; grinder: string | null }[]>`
    SELECT
      (SELECT batch_id::text FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.beanBatchId}) AS batch,
      (SELECT grinder_id::text FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.grinderId}) AS grinder`;
  const [stored] = await tx.$queryRaw<ShotLinks[]>`
    SELECT bean_batch_id AS "beanBatchId", grinder_id AS "grinderId",
      library_batch_id::text AS "libraryBatchId", library_grinder_id::text AS "libraryGrinderId"
    FROM shots WHERE id = ${shotId}`;
  const kept = (id: string | null, before: string | null | undefined, link: string | null | undefined) =>
    id !== null && id === before ? (link ?? null) : null;
  return {
    libraryBatchId: resolved?.batch ?? kept(ids.beanBatchId, stored?.beanBatchId, stored?.libraryBatchId),
    libraryGrinderId: resolved?.grinder ?? kept(ids.grinderId, stored?.grinderId, stored?.libraryGrinderId),
  };
}

/**
 * Links each Shot not linked yet that the tablet reported naming its record
 * by its id there to the item: called as the tablet's map comes to hold the
 * record under that id, with the tablet's row lock held, which storing a
 * Shot's metadata waits for.
 */
export async function linkShots(tx: Prisma.TransactionClient, kind: LinkedKind, tabletId: string, itemId: string, localId: string): Promise<void> {
  const { local, link } = KINDS[kind];
  await tx.$executeRaw`
    UPDATE shots AS s SET ${Prisma.raw(link)} = ${itemId}::uuid
    WHERE s.${Prisma.raw(local)} = ${localId} AND s.${Prisma.raw(link)} IS NULL AND s.tablet_id = ${tabletId}::uuid`;
}

/** Whether a Shot is linked to any of the items, under the locks of the tablets whose maps hold them. */
export function shotLinkedSql(kind: LinkedKind, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE ${Prisma.raw(KINDS[kind].link)} = ANY(${ids}::uuid[]))`;
}

/**
 * A profile's steps as they are compared, through the indexes on them: a
 * step's limiter of value 0, which is no limiter, as null
 * (`profile_steps_key`, in the migration). streamline-js sends every profile
 * it loads into the Workflow so, while the profile's record keeps the limiter.
 */
export function stepsKeySql(steps: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`profile_steps_key(${steps})`;
}

/** What Decaid hashes for a Profile's id, but its target weight and steps, which `shotProfileSql` compares on their own. */
const HASHED = ["version", "beverage_type", "tank_temperature", "target_volume", "target_volume_count_start"] as const;

/** A Shot's Workflow's profile, of `shots` aliased `alias`. */
function workflowProfileSql(alias: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}.record -> 'workflow' -> 'profile')`;
}

/**
 * The id of the Library Profile the Shot of `shots` aliased `alias` was
 * pulled with, or null: the one whose id its Workflow's profile hashes to,
 * holding the same steps and the rest of what Decaid hashes. A skin sets the
 * Workflow's profile's target weight to the Shot's yield, so a Profile with
 * another target weight is the Shot's when no other Profile matches it but
 * for that. The Profiles' steps are found through their index.
 */
export function shotProfileSql(alias: string): Prisma.Sql {
  const shot = workflowProfileSql(alias);
  const same = HASHED.map((field) => Prisma.sql`p.content -> 'profile' -> ${field} IS NOT DISTINCT FROM ${shot} -> ${field}`);
  return Prisma.sql`(
    SELECT candidate.id FROM (
      SELECT p.id, coalesce(p.content -> 'profile' -> 'target_weight' = ${shot} -> 'target_weight', false) AS exact, count(*) OVER () AS candidates
      FROM profiles AS p
      WHERE ${stepsKeySql(Prisma.sql`p.content -> 'profile' -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${shot} -> 'steps'`)} AND ${Prisma.join(same, " AND ")}
    ) AS candidate
    WHERE candidate.exact OR candidate.candidates = 1
    ORDER BY candidate.exact DESC, candidate.id LIMIT 1
  )`;
}

/**
 * Whether the Shot of `shots` aliased `alias` was pulled with the Library
 * Profile, as `shotProfileSql` decides, without deciding it for each Shot:
 * the Shot holds the Profile's steps, found through the index on the
 * Shot's, and the rest of what Decaid hashes, and either its target weight,
 * unless a Profile listed before matches it as closely, or the Profile is the
 * only one matching it but for that. Which Profiles match it so is the same
 * for every such Shot, so it is counted once.
 */
export function shotPulledWithSql(alias: string, profileId: string): Prisma.Sql {
  const shot = workflowProfileSql(alias);
  const target = Prisma.sql`(SELECT content -> 'profile' FROM profiles WHERE id = ${profileId})`;
  const shotSame = HASHED.map((field) => Prisma.sql`${shot} -> ${field} IS NOT DISTINCT FROM ${target} -> ${field}`);
  const rival = (p: string) => Prisma.join(
    [Prisma.sql`${stepsKeySql(Prisma.sql`${Prisma.raw(p)}.content -> 'profile' -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${target} -> 'steps'`)}`,
      ...HASHED.map((field) => Prisma.sql`${Prisma.raw(p)}.content -> 'profile' -> ${field} IS NOT DISTINCT FROM ${target} -> ${field}`)],
    " AND ",
  );
  return Prisma.sql`${stepsKeySql(Prisma.sql`${Prisma.raw(alias)}.record -> 'workflow' -> 'profile' -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${target} -> 'steps'`)}
    AND ${Prisma.join(shotSame, " AND ")}
    AND (
      (SELECT count(*) FROM profiles AS p WHERE ${rival("p")}) = 1
      OR (${shot} -> 'target_weight' = ${target} -> 'target_weight'
        AND NOT EXISTS (SELECT 1 FROM profiles AS p WHERE ${rival("p")} AND p.id < ${profileId} AND p.content -> 'profile' -> 'target_weight' = ${shot} -> 'target_weight'))
    )`;
}
