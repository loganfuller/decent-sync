import { isIP } from "node:net";
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccountRole } from "../generated/prisma/client.js";
import type { Scope } from "./scope.js";
import { type SignedIn, SessionsService } from "./sessions.service.js";

const PUBLIC = Symbol("public");
const STAFF = Symbol("staff");

/**
 * Lets a route answer without a signed-in account. Every other route requires
 * one. Public routes are few: health, first-run setup, sign-in and invite links.
 */
export const Public = () => SetMetadata(PUBLIC, true);

/**
 * Lets Staff use a route, which must then show and change only what their
 * Scope includes. Every other route that requires a signed-in account
 * requires an Admin, so a new route stays Admin-only until it is scoped.
 */
export const AllowStaff = () => SetMetadata(STAFF, true);

type SignedInRequest = Request & { signedIn?: SignedIn };

/** The signed-in account and session of a route that requires one. */
export const CurrentSession = createParamDecorator((_: unknown, context: ExecutionContext): SignedIn => signedInOf(context));

/** What the signed-in account of a route that requires one sees. */
export const CurrentScope = createParamDecorator((_: unknown, context: ExecutionContext): Scope => signedInOf(context).scope);

function signedInOf(context: ExecutionContext): SignedIn {
  const { signedIn } = context.switchToHttp().getRequest<SignedInRequest>();
  if (!signedIn) throw new Error("CurrentSession or CurrentScope used on a public route");
  return signedIn;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses cross-site state-changing requests (cross-site request forgery).
 * Browsers send `Origin` with every such request; it must be the server's
 * public URL, or the host the request was sent to when that host is an IP
 * address or localhost. That covers reaching a LAN server by its address and
 * the web dev server's proxy, but not another domain name: a page using DNS
 * rebinding reaches the server under its own domain, and could otherwise
 * complete first-run setup on a LAN server not yet set up. Without `Origin`,
 * `Sec-Fetch-Site` must not name another site. A request with neither comes
 * from outside a browser, where forgery does not apply.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  private readonly publicOrigin: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.publicOrigin = config.publicUrl.origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (origin === this.publicOrigin || isSameAddressedHost(origin, request.headers.host)) return true;
      throw new ForbiddenException("Cross-site request refused");
    }
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      throw new ForbiddenException("Cross-site request refused");
    }
    return true;
  }
}

/**
 * Requires a signed-in account on every route not marked `@Public()`, and an
 * Admin on every one not marked `@AllowStaff()` either.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<SignedInRequest>();
    const signedIn = await this.sessions.resume(request, http.getResponse<Response>());
    if (!signedIn) throw new UnauthorizedException("Sign in to continue");
    if (signedIn.account.role !== AccountRole.ADMIN && !this.reflector.getAllAndOverride<boolean>(STAFF, targets)) {
      throw new ForbiddenException("Only an Admin can do this");
    }
    request.signedIn = signedIn;
    return true;
  }
}

/** Whether the origin is the requested host, and that host is an IP address or localhost. */
function isSameAddressedHost(origin: string, host: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host !== host) return false;
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return hostname === "localhost" || isIP(hostname) !== 0;
}
