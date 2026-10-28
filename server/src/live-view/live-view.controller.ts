import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readMachineId } from "../machines/input.js";
import { LiveViews } from "./live-views.js";

/**
 * A Machine's Live View (ADR-0024), read as the browser's `EventSource`
 * reads it. It exposes no personal information, so Staff read it, as they
 * read the rest of a Machine's page.
 */
@Controller("api/machines")
export class LiveViewController {
  constructor(private readonly liveViews: LiveViews) {}

  /**
   * A `text/event-stream` of the Machine's live frames, each one event whose
   * data is the frame as relayed (`RelayedLiveFrame`), with a comment after
   * `LIVE_VIEW_KEEP_ALIVE_SECONDS` (15 by default) with nothing to send,
   * answered once its lease is held, or at once as it ends without one,
   * such as while the instance stops. It ends within 10 s of the viewer's
   * session ending, by signing out or the account's deactivation, and the
   * browser's reconnect is refused. It opens for an offline Machine too,
   * whose frames start once it connects; the page learns whether it is
   * online from the Machine's own route.
   */
  @AllowStaff()
  @Get(":id/live")
  async live(@Param("id") id: string, @CurrentSession() signedIn: SignedIn, @Res() response: Response): Promise<void> {
    await this.liveViews.open(readMachineId(id), signedIn.sessionId, response);
  }
}
