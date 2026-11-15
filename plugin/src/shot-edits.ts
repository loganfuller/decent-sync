import { MAX_REFUSAL_LENGTH, type ShotEdit, type ShotEdited, isLaterRecordTime } from "@decent-sync/protocol";
import { readShot, request } from "./decaid.js";

/**
 * Writes the edits of Shots made through the server (ADR-0031, ticket #512)
 * into the Shots this tablet holds, one at a time, in the order the server
 * sends them, through Decaid's own Shot update, and gives each one's answer
 * to the connection that asked.
 *
 * Decaid merges an update into the Shot it holds
 * (`_updateShot` in decaid:lib/src/services/webserver/shots_handler.dart, at
 * v0.9.1 and v0.9.2), so only the fields an edit carries are sent, in the
 * Shot's annotations: a rating without a note leaves the note alone, and
 * the reverse. Decaid moves the Shot's update time only where its content
 * changed, and reports the Shot as updated (`shotUpdated`) either way,
 * which the plugin sends the server as any edit made on the tablet
 * (shots.ts). So an edit written twice, as when its answer was lost with
 * its connection and the server sent it again, changes nothing the second
 * time.
 *
 * An edit is never written over a change made on the tablet that the server
 * has yet to take in (ticket #513). Each is sent for the version of the Shot
 * the server holds, and the Shot is read first: where the tablet's is later,
 * nothing is written and the answer is `changed`. The tablet's report of
 * that version is on its way, from the outbox or, after a reload, by the
 * index, and the server decides the edit against it, field by field, then
 * sends what still stands for the version it then holds. Decaid's update
 * takes no condition, so a change made on the tablet between that read and
 * the write is not seen. A Shot the tablet no longer holds, as one reset or
 * replaced, is answered `notHeld`, and the server sends its edits no more.
 *
 * A Shot's edit changes neither the Workflow nor a recipe, so it does not
 * wait for a Shot being pulled to end, as the Library's writes do
 * (ADR-0022), and it waits behind none of them.
 */
export class ShotEdits {
  private queue: Promise<void> = Promise.resolve();

  /** Writes an edit once those before it are written, and gives its answer to `answer`. It never rejects. */
  apply(edit: ShotEdit, answer: (answer: ShotEdited) => void): Promise<void> {
    this.queue = this.queue.then(async () => answer(await writeShotEdit(edit))).catch(() => {});
    return this.queue;
  }
}

/**
 * Sets the fields the edit carries in the tablet's Shot, unless the tablet
 * no longer holds it or holds a later version than the edit was sent for,
 * and says what became of it.
 */
async function writeShotEdit(edit: ShotEdit): Promise<ShotEdited> {
  const annotations = { ...(edit.rating !== undefined && { enjoyment: edit.rating }), ...(edit.note !== undefined && { espressoNotes: edit.note }) };
  try {
    const held = await readShot(edit.shotId);
    if (held === null) return { type: "shotEdited", id: edit.id, outcome: "notHeld" };
    if (isLaterRecordTime(held.updatedAt, edit.version)) return { type: "shotEdited", id: edit.id, outcome: "changed" };
    const answer = await request("PUT", `/shots/${encodeURIComponent(edit.shotId)}`, { annotations });
    if (answer.ok) return { type: "shotEdited", id: edit.id, outcome: "written" };
    // Deleted since it was read.
    if (answer.status === 404) return { type: "shotEdited", id: edit.id, outcome: "notHeld" };
    return { type: "shotEdited", id: edit.id, outcome: "refused", status: answer.status, error: answer.text.slice(0, MAX_REFUSAL_LENGTH) };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { type: "shotEdited", id: edit.id, outcome: "refused", status: null, error: why.slice(0, MAX_REFUSAL_LENGTH) };
  }
}
