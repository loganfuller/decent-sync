import { Injectable } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

/**
 * The MCP endpoint's `subscriptions/listen` streams on this instance, which
 * stay open until the client closes them. A stopping instance ends them at
 * once, as it does the Live View's streams (`stopOnSignals` in `drain.ts`),
 * since a response still open would hold up its drain: the client listens
 * again, on another instance. The MCP module answers each request on its
 * own (ADR-0026), so nothing else is lost.
 */
@Injectable()
export class McpListenStreams {
  private readonly open = new Set<Response>();
  private ending = false;

  /** Middleware on the endpoint's route, after the body is parsed: remembers the response of each `subscriptions/listen` request. */
  readonly track = (request: Request, response: Response, next: NextFunction): void => {
    if ((request.body as { method?: unknown } | undefined)?.method === "subscriptions/listen") {
      if (this.ending) {
        response.destroy();
        return;
      }
      this.open.add(response);
      response.once("close", () => this.open.delete(response));
    }
    next();
  };

  /** Ends every stream at once, and any that opens later. Its client sees the connection close, as if the instance had gone. */
  end(): void {
    this.ending = true;
    for (const response of this.open) response.destroy();
    this.open.clear();
  }
}
