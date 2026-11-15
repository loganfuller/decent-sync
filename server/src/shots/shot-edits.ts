import { BadRequestException } from "@nestjs/common";
import { MAX_SHOT_RATING, isShotNote, isShotRating } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { object } from "./extraction.js";
import { announceReferenceShots } from "./reference-announcements.js";

// The edits of a Shot's rating and note made through the server (ADR-0031,
// ticket #512), as a request gives one and as a Shot's read lists them.
// ShotEditsService (shot-edits.service.ts) makes them and has them written
// to the tablet that holds the Shot.

/** The fields an edit sets, with their values: a rating, 0 for unrated, a note, empty for none, or both. */
export interface ShotEditFields {
  rating?: number;
  note?: string;
}

/** An edit of a Shot as its REST read lists it. */
export interface ShotEditView {
  id: string;
  /** The fields it set, with the values it set them to. A field it left alone is absent. */
  fields: ShotEditFields;
  /** Who made it: named to Admins, and to Staff and Viewers by its id only, as other accounts' names are personal information they do not see. */
  account: { id: string; name: string | null } | null;
  /**
   * The Connected App the account made it through, by the name its app gave
   * and the host of its client id as it was approved; null for the
   * management interface.
   */
  connectedApp: { id: string; name: string; host: string } | null;
  /** When it was made, by PostgreSQL's clock. */
  madeAt: string;
  /**
   * Where it stands with the tablet that holds the Shot:
   * - `awaitingTablet` until that tablet's plugin answers, as while the
   *   tablet is off;
   * - `written` once the plugin answered that it wrote it into the Shot
   *   there. One a later edit of the same field overtook before either was
   *   written is `written` with that one, as the Shot there holds what came
   *   of both;
   * - `dropped` where it was never written, as the tablet changed every
   *   field it set later than it was made, so the tablet's values stand;
   * - `noTablet` where the tablet answered that it no longer holds the
   *   Shot, as one the Shot was deleted on: the edit stays on the server,
   *   and is sent no more. An edit whose tablet never connects again, as
   *   one replaced, has no such answer, and awaits it for good.
   *
   * An edit of both fields of which the tablet changed one later is where
   * the other stands, with the one in `dropped`.
   */
  state: ShotEditState;
  /** The fields it set that were not written, as the tablet changed them later than it was made; empty for most. */
  dropped: ShotEditField[];
  /** When the plugin's answer that it wrote it was recorded, by PostgreSQL's clock; null unless it is `written`. */
  writtenAt: string | null;
}

export type ShotEditField = "rating" | "note";
export type ShotEditState = "awaitingTablet" | "written" | "dropped" | "noTablet";

/**
 * Where a Shot's edits stand with the tablet that holds it, as its page
 * and get_shot say it (ticket #514): `awaitingTablet` while any of them
 * awaits that tablet, so the Shot there doesn't show it yet; `noTablet`
 * where the latest of them found that tablet no longer holding the Shot,
 * and the Shot still reads as it set it, on the server alone; null
 * otherwise, as for a Shot never edited through the server.
 */
export type ShotEditStanding = "awaitingTablet" | "noTablet" | null;

/**
 * Where a Shot's edits stand with its tablet (`ShotEditStanding`), from
 * them as its read lists them, newest first, and the Shot's record. An
 * edit with no tablet to reach stays so marked for good, but its Shot may
 * come back to a tablet, as one restored from a backup, and be changed
 * there: the version that tablet then reports is stored whole, over the
 * edit. So the Shot has no tablet to reach only while it still reads as
 * its latest edit set it, which needs no clock to tell: but for a field of
 * it the tablet had changed later, before it lost the Shot, which reads
 * as the tablet's.
 */
export function editStanding(edits: readonly Pick<ShotEditView, "state" | "fields" | "dropped">[], record: unknown): ShotEditStanding {
  if (edits.some((edit) => edit.state === "awaitingTablet")) return "awaitingTablet";
  const [latest] = edits;
  if (latest?.state !== "noTablet") return null;
  const now = ratingAndNote(record);
  const stands = (["rating", "note"] as const).every((field) => latest.fields[field] === undefined || latest.dropped.includes(field) || latest.fields[field] === now[field]);
  return stands ? "noTablet" : null;
}

/**
 * In SQL, whether an edit, a row of `shot_edits` under that alias, still
 * awaits its tablet: not written, not found to have no tablet to reach, and
 * setting a field its tablet has not changed later.
 */
export function awaitingSql(alias: string): Prisma.Sql {
  const e = Prisma.raw(alias);
  return Prisma.sql`(${e}.written_at IS NULL AND ${e}.unreachable_at IS NULL
    AND ((${e}.rating IS NOT NULL AND ${e}.rating_dropped_at IS NULL) OR (${e}.note IS NOT NULL AND ${e}.note_dropped_at IS NULL)))`;
}

/** In SQL, the value an edit under that alias set for a field, null where it left the field alone or the tablet changed it later. */
export function standingSql(alias: string, field: ShotEditField): Prisma.Sql {
  return Prisma.raw(`CASE WHEN ${alias}.${field}_dropped_at IS NULL THEN ${alias}.${field} END`);
}

/**
 * In SQL, whether the version stored of a Shot, a row of `shots` under that
 * alias, is one the previous release stored (ADR-0025), still to be
 * decided (`settleStoredVersion`): the Shot has held values, set at
 * another version than its own.
 */
export function undecidedSql(alias: string): Prisma.Sql {
  const s = Prisma.raw(alias);
  return Prisma.sql`(${s}.held_rating IS NOT NULL AND ${s}.held_note IS NOT NULL AND ${s}.held_version_at IS DISTINCT FROM ${s}.version_at)`;
}

/** What a Shot's record holds of its rating and note, as an edit says them: 0 where it has no rating, and empty where it has no note. */
export function ratingAndNote(record: unknown): Required<ShotEditFields> {
  const annotations = object(object(record).annotations);
  return { rating: typeof annotations.enjoyment === "number" ? annotations.enjoyment : 0, note: typeof annotations.espressoNotes === "string" ? annotations.espressoNotes : "" };
}

/**
 * A Shot's record with an edit's fields set in it, as Decaid's own Shot
 * update leaves them, and as `ShotEditsService.make` sets them in the
 * stored record: the rating and note in its annotations, and `shotNotes`,
 * Decaid's older name for the note.
 */
function withShotEdit(record: Prisma.JsonObject, fields: ShotEditFields): Prisma.JsonObject {
  if (fields.rating === undefined && fields.note === undefined) return record;
  const annotations = { ...object(record.annotations), ...(fields.rating !== undefined && { enjoyment: fields.rating }), ...(fields.note !== undefined && { espressoNotes: fields.note }) };
  return { ...record, annotations: annotations as Prisma.JsonObject, ...(fields.note !== undefined && { shotNotes: fields.note }) };
}

/**
 * Decides a Shot's edits still awaiting their tablet against a later
 * version of the Shot that a tablet reports (ticket #513, ADR-0031), under
 * the Shot's lock, as that version is stored. The later edit of a field
 * wins, and nothing is kept of the other:
 *
 * - **A field the tablet changed** reads otherwise than the tablet held it
 *   (`held`). Where the version is later than the latest edit of that
 *   field, by the tablet's update time against the edit's `made_at`, the
 *   tablet's value stands and every awaiting edit of the field is dropped.
 *   Where the edit is the later, it stands, and is still written.
 * - **A field the tablet didn't change** keeps the server's edit, which is
 *   still written: the report repeats what the tablet held before it.
 * - **A field that reads as the server wrote it** is no change of the
 *   tablet's: as the latest edit set it, or as a write this connection sent
 *   and has had no answer to carried it (`sent`), since Decaid reports the
 *   Shot as the plugin writes it, which may reach the server before the
 *   plugin's answer does.
 *
 * Returns the record to store, the reported one with the edits that stand
 * set in it, so the Shot goes on reading as edited until its tablet is
 * written, with the fields so set (`stands`), and what the tablet holds
 * from now on.
 */
export async function settleShotEdits(
  tx: Prisma.TransactionClient,
  shotId: string,
  reported: Prisma.JsonObject,
  version: string,
  held: Required<ShotEditFields>,
  sent: readonly ShotEditFields[],
): Promise<{ record: Prisma.JsonObject; stands: ShotEditFields; held: Required<ShotEditFields> }> {
  const awaiting = await tx.$queryRaw<{ id: string; rating: number | null; note: string | null; earlier: boolean }[]>`
    SELECT e.id::text AS id, ${standingSql("e", "rating")} AS rating, ${standingSql("e", "note")} AS note, e.made_at < ${version}::timestamptz AS earlier
    FROM shot_edits AS e WHERE e.shot_id = ${shotId} AND ${awaitingSql("e")} ORDER BY e.number`;
  const now = ratingAndNote(reported);
  /** The value of the field that stands, or undefined where no edit of it awaits or the tablet's later change stands. */
  async function decide<Field extends ShotEditField>(field: Field): Promise<Required<ShotEditFields>[Field] | undefined> {
    const edits = awaiting.filter((edit) => edit[field] !== null);
    const latest = edits.at(-1);
    if (!latest) return undefined;
    const value = latest[field] as Required<ShotEditFields>[Field];
    const changed = now[field] !== held[field] && now[field] !== value && !sent.some((write) => write[field] === now[field]);
    if (!changed || !latest.earlier) return value;
    await tx.$executeRaw`UPDATE shot_edits SET ${Prisma.raw(`${field}_dropped_at`)} = now() WHERE id = ANY(${edits.map((edit) => edit.id)}::uuid[])`;
    return undefined;
  }
  const [rating, note] = [await decide("rating"), await decide("note")];
  const stands = { ...(rating !== undefined && { rating }), ...(note !== undefined && { note }) };
  return { record: withShotEdit(reported, stands), stands, held: now };
}

/**
 * Decides a Shot's awaiting edits against the version of it stored, where
 * an instance of the previous release stored that version (ADR-0025),
 * under the Shot's lock. That release stores what a tablet reports whole:
 * it neither decides the edits nor keeps what the tablet holds, so the
 * version the held values were set at is no longer the Shot's
 * (`held_version_at`). The stored record is then the tablet's report as it
 * came, and is decided as this release would have decided it on storing it
 * (`settleShotEdits`): the edits the tablet's change overtook are dropped,
 * the rest set in the record again, and what the tablet holds is what it
 * reported. Changes nothing for a Shot this release stored last, or one
 * never edited through the server.
 *
 * It runs before anything reads the record as decided: as an edit is made,
 * as a newer version is stored, and as a write to the tablet is looked for.
 */
export async function settleStoredVersion(tx: Prisma.TransactionClient, shotId: string): Promise<void> {
  const [shot] = await tx.$queryRaw<{ record: Prisma.JsonObject; heldRating: number; heldNote: string }[]>`
    SELECT record, held_rating AS "heldRating", held_note AS "heldNote" FROM shots WHERE id = ${shotId} AND ${undecidedSql("shots")}`;
  if (!shot) return;
  const { record, stands, held } = await settleShotEdits(tx, shotId, shot.record, String(shot.record.updatedAt), { rating: shot.heldRating, note: shot.heldNote }, []);
  await tx.$executeRaw`
    UPDATE shots SET record = ${JSON.stringify(record)}::jsonb, enjoyment = COALESCE(${stands.rating ?? null}::double precision, enjoyment),
      held_rating = ${held.rating}::double precision, held_note = ${held.note}, held_version_at = version_at
    WHERE id = ${shotId}`;
  // Each tablet keeping a copy of it as a Recipe's Reference Shot is sent it as it is now.
  await announceReferenceShots(tx, Prisma.sql`s.id = ${shotId}`);
}

/**
 * The fields an edit sets, from a request's body: `rating`, `note` or both,
 * valued as Decaid's own Shot update takes them (`isShotRating`,
 * `isShotNote`). 400 for any other field, as only a Shot's rating and note
 * are edited through the server, for a value Decaid would refuse or
 * PostgreSQL could not store, and for a body setting neither.
 */
export function readShotEdit(body: unknown): ShotEditFields {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestException(NOTHING_TO_SET);
  const { rating, note, ...others } = body as Record<string, unknown>;
  const problems = Object.keys(others).map((field) => `${field} is not a field this can set`);
  const fields: ShotEditFields = {};
  if (isShotRating(rating)) fields.rating = rating;
  else if (rating !== undefined) problems.push(`rating must be a number from 0 to ${MAX_SHOT_RATING}, where 0 is unrated`);
  if (isShotNote(note)) fields.note = note;
  else if (note !== undefined) problems.push("note must be text, where empty is none, without a NUL or an unpaired surrogate");
  if (problems.length > 0) throw new BadRequestException(problems);
  if (rating === undefined && note === undefined) throw new BadRequestException(NOTHING_TO_SET);
  return fields;
}

const NOTHING_TO_SET = "Send the Shot's rating, its note or both";

/** The most of a Shot's edits its read lists: the newest. A Shot has a handful, and each may hold a note as long as a request. */
export const MAX_LISTED_EDITS = 100;

/**
 * The edits of a Shot's rating and note made through the server, newest
 * first, the newest MAX_LISTED_EDITS of them, with who made each, as
 * `scope` sees them, and where each stands with the Shot's tablet; and how
 * many there are in all.
 */
export async function listShotEdits(db: Prisma.TransactionClient, shotId: string, scope: Scope): Promise<{ edits: ShotEditView[]; total: number }> {
  const [edits, total] = await Promise.all([
    db.shotEdit.findMany({
      where: { shotId },
      include: { account: { select: { name: true } }, connectedApp: { select: { id: true, name: true, clientHost: true } } },
      orderBy: { number: "desc" },
      take: MAX_LISTED_EDITS,
    }),
    db.shotEdit.count({ where: { shotId } }),
  ]);
  return { edits: edits.map(viewShotEdit(scope)), total };
}

/** An edit as a Shot's read lists it, as `scope` sees who made it. */
function viewShotEdit(scope: Scope) {
  return (edit: Prisma.ShotEditGetPayload<{ include: { account: { select: { name: true } }; connectedApp: { select: { id: true; name: true; clientHost: true } } } }>): ShotEditView => {
    const dropped: ShotEditField[] = [];
    if (edit.rating !== null && edit.ratingDroppedAt !== null) dropped.push("rating");
    if (edit.note !== null && edit.noteDroppedAt !== null) dropped.push("note");
    const set = Number(edit.rating !== null) + Number(edit.note !== null);
    const state: ShotEditState = dropped.length === set ? "dropped" : edit.writtenAt !== null ? "written" : edit.unreachableAt !== null ? "noTablet" : "awaitingTablet";
    return {
      id: edit.id,
      fields: { ...(edit.rating !== null && { rating: edit.rating }), ...(edit.note !== null && { note: edit.note }) },
      // Other accounts' names are personal information that only an Admin sees.
      account: edit.accountId === null ? null : { id: edit.accountId, name: scope.kind === "everything" ? (edit.account?.name ?? null) : null },
      connectedApp: edit.connectedApp && { id: edit.connectedApp.id, name: edit.connectedApp.name, host: edit.connectedApp.clientHost },
      madeAt: edit.madeAt.toISOString(),
      state,
      dropped,
      writtenAt: state === "written" ? edit.writtenAt!.toISOString() : null,
    };
  };
}
