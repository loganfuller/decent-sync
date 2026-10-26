import { Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { CONFIG } from "./config.module.js";

/** `/api` and every path under it, matched without regard to case as Express matches routes. */
const API_PATH = /^\/api(?:\/|$)/i;

/**
 * Serves the management interface's build, a single-page app: its files as
 * they are, and its `index.html` for any other path outside the API, a missing
 * hashed asset included, so a page reloads on a chunk it can no longer find.
 *
 * It replaces `@nestjs/serve-static`, whose fallback sends `index.html` by its
 * absolute path, which `send` refuses with 404 when a segment of that path
 * starts with a dot, as under `~/.t3/` or a hidden directory. Sending it
 * relative to the build's root checks only the path below it.
 *
 * It registers on Express in `onModuleInit`, after Nest's routes and before its
 * not-found handler, so API routes come first and an unknown one keeps Nest's
 * 404. It is not a controller, so the global guards do not apply to it.
 */
@Injectable()
export class ManagementInterface implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onModuleInit(): void {
    const app = this.adapterHost.httpAdapter.getInstance<Express>();
    const root = this.config.webDistDir;
    app.use(express.static(root));
    app.get("{*any}", (req: Request, res: Response, next: NextFunction) => {
      if (API_PATH.test(req.path)) {
        next();
        return;
      }
      res.sendFile("index.html", { root }, (error?: Error) => {
        if (!error) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        // With no build, or no index.html in it, a page answers as an unknown route does.
        const notFound = new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
        res.status(notFound.getStatus()).send(notFound.getResponse());
      });
    });
    // A file that goes between express.static finding it and reading it, as in a rebuild, answers as an
    // unknown route does, rather than with an error naming its path on the server.
    app.use((error: NodeJS.ErrnoException, req: Request, _res: Response, next: NextFunction) => {
      const missing = error?.code === "ENOENT" || error?.message?.includes("ENOENT");
      next(missing ? new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`) : error);
    });
  }
}
