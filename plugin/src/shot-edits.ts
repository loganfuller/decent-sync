import { MAX_REFUSAL_LENGTH, type ShotEdit, type ShotEdited } from "@decent-sync/protocol";
import { request } from "./decaid.js";

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

/** Sets the fields the edit carries in the tablet's Shot, and says whether Decaid took the update. */
async function writeShotEdit(edit: ShotEdit): Promise<ShotEdited> {
  const annotations = { ...(edit.rating !== undefined && { enjoyment: edit.rating }), ...(edit.note !== undefined && { espressoNotes: edit.note }) };
  try {
    const answer = await request("PUT", `/shots/${encodeURIComponent(edit.shotId)}`, { annotations });
    if (answer.ok) return { type: "shotEdited", id: edit.id, outcome: "written" };
    return { type: "shotEdited", id: edit.id, outcome: "refused", status: answer.status, error: answer.text.slice(0, MAX_REFUSAL_LENGTH) };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { type: "shotEdited", id: edit.id, outcome: "refused", status: null, error: why.slice(0, MAX_REFUSAL_LENGTH) };
  }
}
