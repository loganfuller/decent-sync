import { ForbiddenException, Injectable } from "@nestjs/common";
import { type ShotEdit, isRecordId } from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { shotListedSql } from "./links.js";
import { announceReferenceShots } from "./reference-announcements.js";
import type { ShotEditFields } from "./shot-edits.js";
import { lockShot, shotNotFound } from "./shots.service.js";

/**
 * Who makes an edit of a Shot: an account, as its Scope stands, in the
 * management interface or through a Connected App acting as it (ADR-0026).
 */
export interface ShotEditor {
  accountId: string;
  scope: Scope;
  /** The Connected App it is made through; null for the management interface. */
  connectedAppId: string | null;
}

/** A connection whose tablet is written the edits of the Shots it holds: its session, which must still hold its Machine, the Machine and its tablet. */
export interface EditedTablet {
  sessionId: string;
  machineId: string;
  tabletId: string;
}

/**
 * The edits of a Shot's rating and note made through the server (ADR-0031,
 * ticket #512), the first changes to a Shot that do not come from the
 * tablet holding it.
 *
 * An edit is applied to the Shot the server holds as it is made (`make`),
 * so every read of the Shot, list and Shot Summary shows it at once, and
 * kept as a row of `shot_edits` with who made it. It is then a write the
 * tablet that holds the Shot is due: the tablet that last reported the
 * Shot (`shots.tablet_id`). What a tablet is due is read from the database
 * each time (`due`), so it reflects edits made through any instance, and
 * the instance holding that tablet's connection is told of each
 * (`shot_edits`), so an edit goes out at once while the tablet is
 * connected, and otherwise once it next connects. An edit stays due until
 * the plugin answers that it wrote it (`written`).
 *
 * An Admin edits any Shot the Shots list lists. Staff edit those at a
 * Location they work at, so a Shot at no Location is an Admin's alone. A
 * Viewer changes nothing, which the session guard sees to.
 */
@Injectable()
export class ShotEditsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Makes an edit: sets the Shot's rating, note or both, keeps the edit and
   * tells the instance holding the Shot's tablet. 404 for a Shot the Shots
   * list doesn't list, and 403 for one the editor's Scope doesn't include.
   *
   * The Shot's record is changed as Decaid's own Shot update changes it
   * (`_updateShot` in decaid:lib/src/services/webserver/shots_handler.dart),
   * so the tablet's report of the write, once made, changes nothing the
   * edit hadn't already: the rating and note in its annotations, and
   * `shotNotes`, Decaid's older name for the note, which it keeps equal to
   * it. Nothing else of the record is touched, its edit time included,
   * which stays the tablet's, so that report is taken as the newer.
   *
   * It holds the Shot's lock, as storing a delivery of the Shot does, so
   * the two are decided one at a time, and edits of one Shot are numbered
   * in the order they were applied. The tablet to tell is read from the
   * row as it is changed: a tablet's index claiming a Shot that had none
   * (`claimListed`) takes that row too, so it either came first, and is
   * told, or waits for the edit, and finds it as its connection looks
   * once the index is answered.
   */
  async make(shotId: string, fields: ShotEditFields, editor: ShotEditor): Promise<void> {
    if (!isRecordId(shotId)) throw shotNotFound();
    const annotations = { ...(fields.rating !== undefined && { enjoyment: fields.rating }), ...(fields.note !== undefined && { espressoNotes: fields.note }) };
    const aliases = fields.note === undefined ? {} : { shotNotes: fields.note };
    const rating = fields.rating === undefined ? Prisma.empty : Prisma.sql`, enjoyment = ${fields.rating}::double precision`;
    await this.prisma.$transaction(async (tx) => {
      await lockShot(tx, shotId);
      const [shot] = await tx.$queryRaw<{ locationId: string | null }[]>`
        SELECT s.location_id::text AS "locationId" FROM shots AS s WHERE s.id = ${shotId} AND ${shotListedSql("s")}`;
      if (!shot) throw shotNotFound();
      if (!includesLocation(editor.scope, shot.locationId)) throw new ForbiddenException("You can edit only the Shots at a Location you work at");
      // Set in place, so the rest of the record stays as Decaid sent it.
      const [{ tabletId }] = await tx.$queryRaw<[{ tabletId: string | null }]>`
        UPDATE shots SET
          record = jsonb_set(
            record, '{annotations}',
            (CASE WHEN jsonb_typeof(record -> 'annotations') = 'object' THEN record -> 'annotations' ELSE '{}'::jsonb END) || ${JSON.stringify(annotations)}::jsonb
          ) || ${JSON.stringify(aliases)}::jsonb
          ${rating}
        WHERE id = ${shotId}
        RETURNING tablet_id::text AS "tabletId"`;
      await tx.shotEdit.create({
        data: { shotId, rating: fields.rating ?? null, note: fields.note ?? null, accountId: editor.accountId, connectedAppId: editor.connectedAppId },
      });
      // Each tablet keeping a copy of it as a Recipe's Reference Shot is sent it as it is now.
      await announceReferenceShots(tx, Prisma.sql`s.id = ${shotId}`);
      // A Shot no tablet is known to hold, as one stored before Shots kept their tablet, waits for a tablet's index to list it.
      if (tabletId !== null) await notify(tx, "shot_edits", tabletId);
    });
  }

  /**
   * The edit the connection's tablet is due next: the first made that is
   * not yet written, of a Shot it holds, leaving out the Shots in
   * `skipped`, as a `shotEdit` to send it; null where none is due, or the
   * connection no longer holds its Machine.
   */
  async due(tablet: EditedTablet, skipped: readonly string[]): Promise<ShotEdit | null> {
    const [edit] = await this.prisma.$queryRaw<{ id: string; shotId: string; rating: number | null; note: string | null }[]>`
      SELECT e.id::text AS id, e.shot_id AS "shotId", e.rating, e.note
      FROM shot_edits AS e JOIN shots AS s ON s.id = e.shot_id
      WHERE e.written_at IS NULL AND s.tablet_id = ${tablet.tabletId}::uuid AND NOT (e.shot_id = ANY(${[...skipped]}::text[]))
        AND EXISTS (SELECT 1 FROM machines AS m WHERE m.id = ${tablet.machineId}::uuid AND m.connected_session_id = ${tablet.sessionId}::uuid)
      ORDER BY e.number LIMIT 1`;
    if (!edit) return null;
    return { type: "shotEdit", id: edit.id, shotId: edit.shotId, ...(edit.rating !== null && { rating: edit.rating }), ...(edit.note !== null && { note: edit.note }) };
  }

  /**
   * Marks an edit written, as its tablet's plugin answered, and says
   * whether it did: only an edit not yet written, of a Shot that tablet
   * holds, so an answer repeated, or from a tablet that no longer holds
   * the Shot, changes nothing.
   */
  async written(tabletId: string, editId: string): Promise<boolean> {
    const marked = await this.prisma.$executeRaw`
      UPDATE shot_edits AS e SET written_at = now() FROM shots AS s
      WHERE e.id = ${editId}::uuid AND e.written_at IS NULL AND s.id = e.shot_id AND s.tablet_id = ${tabletId}::uuid`;
    return marked > 0;
  }
}
