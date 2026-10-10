import { Prisma } from "../generated/prisma/client.js";

// Shots linked to the Library (ticket #92). A Shot names its Bean Batch and
// Grinder by their ids on the tablet that reported it, which resolve to the
// Library's items through that tablet's map (ADR-0006); a Shot stored before
// Shots kept their tablet resolves through the first tablet seen on its
// Machine. Each link is stored on the Shot once its tablet's map holds the
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
// whole double Decaid writes as `92.0` equals 92 (`shotProfileSql`). The
// profile id a skin records in the Workflow is not used: it names the
// Profile the skin last selected, which need not be the one the Shot was
// pulled with.
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
export interface ShotLinks {
  beanBatchId: string | null;
  grinderId: string | null;
  libraryBatchId: string | null;
  libraryGrinderId: string | null;
}

/**
 * The tablet whose map resolves the ids of `shots` aliased `alias`: the one
 * that reported its metadata, or, for a Shot stored before Shots kept it,
 * the first tablet seen on its Machine.
 */
export function resolvingTabletSql(alias: string): Prisma.Sql {
  const shot = (column: string) => Prisma.raw(`${alias}.${column}`);
  return Prisma.sql`coalesce(${shot("tablet_id")}, (
    SELECT first.tablet_id FROM machine_tablets AS first WHERE first.machine_id = ${shot("machine_id")}
    ORDER BY first.first_seen_at, first.id LIMIT 1
  ))`;
}

/**
 * The links of a Shot whose metadata the tablet reported, naming the ids
 * given, through the tablet's map, holding its row for share until the
 * transaction ends. An id the map does not hold keeps the link it had when
 * the Shot named the same id before, as its record may have left the map
 * since; otherwise it is unlinked, until the map gains it (`linkShots`).
 */
export async function resolveLinks(
  tx: Prisma.TransactionClient,
  tabletId: string,
  ids: { beanBatchId: string | null; grinderId: string | null },
  stored: ShotLinks | undefined,
): Promise<{ libraryBatchId: string | null; libraryGrinderId: string | null }> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR SHARE`;
  const [resolved] = await tx.$queryRaw<{ batch: string | null; grinder: string | null }[]>`
    SELECT
      (SELECT batch_id::text FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.beanBatchId}) AS batch,
      (SELECT grinder_id::text FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.grinderId}) AS grinder`;
  const kept = (id: string | null, before: string | null | undefined, link: string | null | undefined) =>
    id !== null && id === before ? (link ?? null) : null;
  return {
    libraryBatchId: resolved?.batch ?? kept(ids.beanBatchId, stored?.beanBatchId, stored?.libraryBatchId),
    libraryGrinderId: resolved?.grinder ?? kept(ids.grinderId, stored?.grinderId, stored?.libraryGrinderId),
  };
}

/**
 * Links each Shot not linked yet that names the tablet's record by its id
 * there, and resolves its ids through that tablet, to the item: called as the
 * tablet's map comes to hold the record under that id, with the tablet's row
 * lock held, which storing a Shot's metadata waits for.
 */
export async function linkShots(tx: Prisma.TransactionClient, kind: LinkedKind, tabletId: string, itemId: string, localId: string): Promise<void> {
  const { local, link } = KINDS[kind];
  await tx.$executeRaw`
    UPDATE shots AS s SET ${Prisma.raw(link)} = ${itemId}::uuid
    WHERE s.${Prisma.raw(local)} = ${localId} AND s.${Prisma.raw(link)} IS NULL AND ${resolvingTabletSql("s")} = ${tabletId}::uuid`;
}

/** Whether a Shot is linked to any of the items, under the locks of the tablets whose maps hold them. */
export function shotLinkedSql(kind: LinkedKind, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE ${Prisma.raw(KINDS[kind].link)} = ANY(${ids}::uuid[]))`;
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
 * for that. The steps are compared first, through the index on the Shot's.
 */
export function shotProfileSql(alias: string): Prisma.Sql {
  const shot = workflowProfileSql(alias);
  const same = HASHED.map((field) => Prisma.sql`p.content -> 'profile' -> ${field} IS NOT DISTINCT FROM ${shot} -> ${field}`);
  return Prisma.sql`(
    SELECT candidate.id FROM (
      SELECT p.id, coalesce(p.content -> 'profile' -> 'target_weight' = ${shot} -> 'target_weight', false) AS exact, count(*) OVER () AS candidates
      FROM profiles AS p
      WHERE p.content -> 'profile' -> 'steps' = ${shot} -> 'steps' AND ${Prisma.join(same, " AND ")}
    ) AS candidate
    WHERE candidate.exact OR candidate.candidates = 1
    ORDER BY candidate.exact DESC, candidate.id LIMIT 1
  )`;
}

/** Whether the Shot of `shots` aliased `alias` was pulled with the Library Profile (`shotProfileSql`), narrowed first by the index on its steps. */
export function shotPulledWithSql(alias: string, profileId: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}.record -> 'workflow' -> 'profile' -> 'steps' = (SELECT content -> 'profile' -> 'steps' FROM profiles WHERE id = ${profileId})
    AND ${shotProfileSql(alias)} = ${profileId}`;
}
