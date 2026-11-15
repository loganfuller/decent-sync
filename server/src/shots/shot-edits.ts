import { BadRequestException } from "@nestjs/common";
import { MAX_SHOT_RATING, isShotNote, isShotRating } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";

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
   * Where it stands with the tablet that holds the Shot: `awaitingTablet`
   * until that tablet's plugin answers that it wrote it into the Shot
   * there, as while the tablet is off, and `written` from then on. One a
   * later edit of the same field overtook before either was written is
   * `written` with that one, as the Shot there holds what came of both.
   */
  state: "awaitingTablet" | "written";
  /** When the plugin's answer that it wrote it was recorded, by PostgreSQL's clock; null while it awaits its tablet. */
  writtenAt: string | null;
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
 * `scope` sees them, and where each stands with the Shot's tablet.
 */
export async function listShotEdits(db: Prisma.TransactionClient, shotId: string, scope: Scope): Promise<ShotEditView[]> {
  const edits = await db.shotEdit.findMany({
    where: { shotId },
    include: { account: { select: { name: true } }, connectedApp: { select: { id: true, name: true, clientHost: true } } },
    orderBy: { number: "desc" },
    take: MAX_LISTED_EDITS,
  });
  return edits.map((edit) => ({
    id: edit.id,
    fields: { ...(edit.rating !== null && { rating: edit.rating }), ...(edit.note !== null && { note: edit.note }) },
    // Other accounts' names are personal information that only an Admin sees.
    account: edit.accountId === null ? null : { id: edit.accountId, name: scope.kind === "everything" ? (edit.account?.name ?? null) : null },
    connectedApp: edit.connectedApp && { id: edit.connectedApp.id, name: edit.connectedApp.name, host: edit.connectedApp.clientHost },
    madeAt: edit.madeAt.toISOString(),
    state: edit.writtenAt === null ? "awaitingTablet" : "written",
    writtenAt: edit.writtenAt?.toISOString() ?? null,
  }));
}
