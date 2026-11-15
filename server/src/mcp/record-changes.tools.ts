import { MAX_SHOT_RATING } from "@decent-sync/protocol";
import { Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { ShotEditsService } from "../shots/shot-edits.service.js";
import { readShotEdit } from "../shots/shot-edits.js";
import { BudgetedTool } from "./budget.js";
import { MAX_LISTED_EDITS } from "../shots/shot-edits.js";
import { RecordsTools, shotDetails } from "./records.tools.js";
import { callerOf } from "./token-verifier.js";

// A Shot's rating and note edited through an assistant (#514, ADR-0031,
// ADR-0026), by the service its REST route calls (`ShotEditsService`), so
// the edit is applied at once, kept as the account's, through its Connected
// App, written to the tablet that holds the Shot, and refused, with the
// same message, wherever the REST API would refuse it. It needs `change`
// besides `read`, so a Connected App granted only `read`, or a Viewer's, is
// refused with 403 `insufficient_scope`. Nothing else of a Shot is edited:
// the rest comes only from the tablet that holds it.

/** What get_shot lists of a Shot's edits, which its own description leaves to this tool's, for its length. */
const SHOT_EDITS = `get_shot lists these edits with edits true, newest first, the newest ${MAX_LISTED_EDITS} at most, or fewer to fit, with total, how many there are, and more, whether older ones are left out, which no offset reaches: each with madeAt, its account, named to Admins only, and connectedApp, the app it was made through, null for the management interface, or its machine, for one made on another Machine's tablet at the Shot's Location, which names no account, the rating or note it set, and its state: awaitingTablet; written; dropped, never written, as the tablet changed every field it set later than the edit, so the tablet's stand; or noTablet. dropped names the fields so lost, which may be one of two. A change made on the tablet that holds the Shot is no edit, and is not listed.`;

const editShotInput = z.strictObject({
  id: z.string().describe("The Shot's id, as find_shots gives it."),
  rating: z.number().min(0).max(MAX_SHOT_RATING).optional().describe(`Its rating, from 0 to ${MAX_SHOT_RATING}, two points a star of five, where 0 is unrated; left out to leave it as it is.`),
  note: z.string().optional().describe("Its note, whole, where empty is none; left out to leave it as it is."),
});

/** A Shot's rating and note edited through an assistant, as the account and through its Connected App; the Shot is then read back as get_shot reads it. */
@Injectable()
export class RecordChangesTools {
  constructor(
    private readonly edits: ShotEditsService,
    private readonly records: RecordsTools,
  ) {}

  @BudgetedTool({
    name: "edit_shot",
    title: "Edit a Shot's rating and note",
    description: `Edits a Shot's rating, its note or both, leaving alone whichever is not given, and returns the Shot as get_shot reads it, without curves. rating is from 0 to ${MAX_SHOT_RATING}, where 0 is unrated: DYE2 on a tablet, and the management interface for a Shot, show it as five stars, two points a star, so give 8 for four stars, and an even number unless asked for half a star. note replaces the whole note, so to add to one, read it with get_shot first and send it whole with the addition; an empty one clears it. Nothing else of a Shot can be edited: its measurements, dose and yield stay as its tablet recorded them. The edit shows at once in every read, find_shots and summarise_shots, and is kept with who made it: this account, through this Connected App. It is then written into the Shot on the tablet that holds it, now if that tablet is connected and otherwise when it next connects, so its Skin and DYE2 show the same; until then they show the Shot as it was. Where the rating or the note was changed on that tablet later than the edit, without seeing it, the tablet's stands and the edit of that field is dropped: the later change wins, and nothing is kept of the other. The Shot's editStanding says so: awaitingTablet while an edit isn't yet written to that tablet, as while it is off; noTablet where that tablet answered that it no longer holds the Shot, as one deleted there, so the latest edit stays in Decent Sync alone; otherwise null. An edit whose tablet never connects again, as one replaced, awaits it for good. ${SHOT_EDITS} Any Shot find_shots finds may be edited by an Admin; Staff edit only the Shots at the Locations they work at, so a Shot at no Location is an Admin's alone.`,
    inputSchema: editShotInput,
    outputSchema: shotDetails,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    scopes: [READ, CHANGE],
  })
  async editShot({ id, ...fields }: z.infer<typeof editShotInput>, context: McpContext): Promise<z.infer<typeof shotDetails>> {
    const { accountId, connectedAppId, scope } = callerOf(context);
    // As the REST route reads its body: a field left out is one it doesn't carry.
    const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    await this.edits.make(id, readShotEdit(given), { accountId, scope, connectedAppId });
    return this.records.readShot({ id }, scope);
  }
}
