import fs from "node:fs";
import path from "node:path";
import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Config } from "./config.js";
import { CONFIG } from "./config.module.js";

/** `/api` and every path under it, matched without regard to case as Express matches routes. */
const API_PATH = /^\/api(?:\/|$)/i;

/** The header naming the build of the management interface the server serves, which its pages read (`web/src/lib/build.ts`). */
const BUILD_HEADER = "Decent-Sync-Build";

/** The build's name in its index.html, as `nameBuild` in `web/vite.config.ts` writes it: hex, so fit for a header. */
const BUILD_NAME = /<meta name="decent-sync-build" content="([0-9a-f]+)">/;

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
 *
 * Every response names the build, as its index.html names it when the server
 * starts, so a page loads the new one at its next navigation after a deploy
 * (ADR-0025): `nameBuild`, which `AppModule` applies to every route. A server
 * without a build, or with one that names none, names none.
 */
@Injectable()
export class ManagementInterface implements OnModuleInit {
  private readonly logger = new Logger("ManagementInterface");
  /** The build this server serves, or undefined if it serves none with a name. */
  readonly build: string | undefined;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    this.build = this.readBuild();
  }

  /** Middleware naming the build in each response's `Decent-Sync-Build` header. */
  readonly nameBuild = (_req: Request, res: Response, next: NextFunction): void => {
    if (this.build) res.setHeader(BUILD_HEADER, this.build);
    next();
  };

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
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNABORTED") this.logger.error(`Failed to send index.html after the response had started: ${error.message}`);
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

  private readBuild(): string | undefined {
    let index: string;
    try {
      index = fs.readFileSync(path.join(this.config.webDistDir, "index.html"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") this.logger.warn(`Could not read the management interface's index.html, so no build is named: ${(error as Error).message}`);
      return undefined;
    }
    return BUILD_NAME.exec(index)?.[1];
  }
}
