import { Controller, Get, GoneException, HttpCode, Post } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";

/**
 * What a page of the release before Lost Edits (ADR-0033) still asks for
 * until it loads the new build at its next navigation (ADR-0025): that
 * release listed Conflicts, on a page of their own and on each item's, and
 * used or dismissed them. Nothing is listed, used or dismissed here: an edit
 * that loses is in its item's history (`HistoryService`). Each list is
 * empty, so such a page shows none, and a use or dismiss of one it still
 * shows, as a previous-release instance listed it, is refused. To be removed
 * in the release after this one (#642).
 */
@AllowStaff()
@Controller("api")
export class ConflictsController {
  /** No Conflicts: the list that release's page reads, and each item's. */
  @Get([
    "conflicts",
    "beans/:id/conflicts",
    "bean-batches/:id/conflicts",
    "grinders/:id/conflicts",
    "profiles/:id/conflicts",
    "baskets/:id/conflicts",
    "tools/:id/conflicts",
    "recipes/:id/conflicts",
  ])
  list(): { conflicts: [] } {
    return { conflicts: [] };
  }

  /** Refused: nothing is used or dismissed any more. */
  @Post(["conflicts/:id/use", "conflicts/:id/dismiss"])
  @HttpCode(410)
  resolve(): never {
    throw new GoneException("An edit that loses is now kept in its item's history. Reload the page.");
  }
}
