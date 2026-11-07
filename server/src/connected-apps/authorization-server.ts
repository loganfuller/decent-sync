import { createHash } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { AccountRole, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import { ClientMetadataDocuments, ClientRefused } from "./client-metadata.js";
import {
  ACCESS_TOKEN_SECONDS,
  CHANGE,
  CODE_SECONDS,
  LAPSE_DAYS,
  READ,
  REQUEST_SECONDS,
  USE_RECORDED_SECONDS,
  effectiveScopes,
  issuerOf,
  resourceOf,
  sameResource,
  tokenError,
} from "./oauth.js";

/** The authorization endpoint's query, as the app sent it. */
export type AuthorizationQuery = Record<string, unknown>;

/** Where the authorization endpoint sends the browser. */
export type AuthorizationOutcome =
  /** To the consent page, which signs the person in first if need be. */
  | { consent: string }
  /** Back to the app, with an error (RFC 6749, section 4.1.2.1). */
  | { redirect: string };

/** An app's request to connect, as the consent page shows it to the signed-in account. */
export interface AuthorizationRequestView {
  client: { id: string; host: string; name: string; logoUri: string | null };
  /** What the account may allow it: `read`, and `change` if the app asked for it and the account is not a Viewer. */
  scopes: string[];
}

/** The token endpoint's answer (RFC 6749, section 5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * That a Connected App `c` and its account `a` still stand: it is not
 * disconnected or lapsed, and its account is not deactivated.
 */
export const STANDING = Prisma.raw(
  `c.disconnected_at IS NULL AND a.deactivated_at IS NULL AND c.last_used_at > now() - make_interval(days => ${LAPSE_DAYS})`,
);

/**
 * The server as its own OAuth 2.1 authorization server for Connected Apps
 * (ADR-0027): apps identified by their Client ID Metadata Document, PKCE
 * with S256 only, codes and tokens that are random secrets stored as hashes,
 * every time judged by PostgreSQL's clock, and everything kept in
 * PostgreSQL, so any instance continues what another began (ADR-0016).
 *
 * The authorization endpoint checks the app's request and keeps it; the
 * consent page reads it, and the person approves it, which makes a Connected
 * App and a single-use code, or denies it. The token endpoint exchanges the
 * code, with its PKCE verifier and `resource`, for an access token, which
 * lasts an hour, and a refresh token, which is replaced each time it is used.
 */
@Injectable()
export class AuthorizationServer {
  private readonly issuer: string;
  private readonly resource: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: ClientMetadataDocuments,
    @Inject(CONFIG) config: Config,
  ) {
    this.issuer = issuerOf(config);
    this.resource = resourceOf(config);
  }

  /**
   * Checks an app's request at the authorization endpoint and keeps it for
   * the consent page. A client id or redirect that can't be used is refused
   * with 400, as the app can't be trusted with the browser; anything else
   * wrong goes back to the app's redirect as an error.
   */
  async authorize(query: AuthorizationQuery): Promise<AuthorizationOutcome> {
    const clientId = single(query, "client_id");
    const redirectUri = single(query, "redirect_uri");
    if (!clientId) throw new BadRequestException("The app sent no client_id");
    if (!redirectUri) throw new BadRequestException("The app sent no redirect_uri");
    let client;
    try {
      client = await this.documents.fetch(clientId);
    } catch (error) {
      if (error instanceof ClientRefused) throw new BadRequestException(error.message);
      throw error;
    }
    if (!ClientMetadataDocuments.redirectListed(redirectUri, client.redirectUris)) {
      throw new BadRequestException("The app's redirect_uri is not one its Client ID Metadata Document lists");
    }

    const state = single(query, "state");
    const refuse = (error: string, description: string): AuthorizationOutcome => ({
      redirect: this.redirectTo(redirectUri, { error, error_description: description, state }),
    });
    if (single(query, "response_type") !== "code") return refuse("unsupported_response_type", "Only the authorization code flow is supported");
    const challenge = single(query, "code_challenge");
    if (single(query, "code_challenge_method") !== "S256" || !challenge) return refuse("invalid_request", "PKCE with S256 is required");
    if (!PKCE_CHALLENGE.test(challenge)) return refuse("invalid_request", "The code_challenge is not an S256 challenge");
    const resource = single(query, "resource");
    if (!resource) return refuse("invalid_target", `Name this server's MCP endpoint, ${this.resource}, as the resource`);
    if (!sameResource(resource, this.resource)) return refuse("invalid_target", `This server's MCP endpoint is ${this.resource}`);

    const [{ id }] = await this.prisma.$queryRaw<[{ id: string }]>`
      INSERT INTO authorization_requests
        (id, client_id, client_host, client_name, logo_uri, redirect_uri, code_challenge, resource, scopes, state, expires_at)
      VALUES (gen_random_uuid(), ${client.clientId}, ${client.host}, ${client.name}, ${client.logoUri}, ${redirectUri}, ${challenge},
        ${this.resource}, ${requestedScopes(single(query, "scope"))}::text[], ${state ?? null}, now() + make_interval(secs => ${REQUEST_SECONDS}))
      RETURNING id::text`;
    return { consent: `/connect/${id}` };
  }

  /** An app's request to connect, as the consent page shows it to the account, until it expires or is answered. */
  async request(id: string, role: AccountRole): Promise<AuthorizationRequestView> {
    if (!UUID.test(id)) throw requestNotFound();
    const [request] = await this.prisma.$queryRaw<{ clientId: string; clientHost: string; clientName: string; logoUri: string | null; scopes: string[] }[]>`
      SELECT client_id AS "clientId", client_host AS "clientHost", client_name AS "clientName", logo_uri AS "logoUri", scopes
      FROM authorization_requests WHERE id = ${id}::uuid AND expires_at > now()`;
    if (!request) throw requestNotFound();
    return {
      client: { id: request.clientId, host: request.clientHost, name: request.clientName, logoUri: request.logoUri },
      scopes: effectiveScopes(request.scopes, role),
    };
  }

  /**
   * Approves an app's request with the scopes the person chose, making a
   * Connected App for the account and a single-use code for it, and returns
   * where the browser goes next: the app's redirect, with the code, `state`
   * and `iss`. The request is answered once, whichever instance answers it.
   */
  async approve(id: string, accountId: string, chosen: unknown): Promise<{ redirect: string }> {
    const scopes = readChosenScopes(chosen);
    if (!UUID.test(id)) throw requestNotFound();
    const code = newSecret();
    const redirect = await this.prisma.$transaction(async (tx) => {
      // Under the account's row lock, as a session starts: a deactivation either comes first, and this is refused, or
      // after, and finds the Connected App.
      const [account] = await tx.$queryRaw<{ role: AccountRole; deactivated: boolean }[]>`
        SELECT role, deactivated_at IS NOT NULL AS deactivated FROM accounts WHERE id = ${accountId}::uuid FOR SHARE`;
      if (!account || account.deactivated) throw new NotFoundException("Your account can no longer approve apps");
      const request = await claimRequest(tx, id);
      const offered = effectiveScopes(request.scopes, account.role);
      if (!scopes.every((scope) => offered.includes(scope))) {
        throw new BadRequestException(account.role === AccountRole.VIEWER ? "A Viewer can allow an app only to read" : "The app didn't ask to change anything");
      }
      const [app] = await tx.$queryRaw<[{ id: string }]>`
        INSERT INTO connected_apps (id, account_id, client_id, client_host, name, logo_uri, scopes)
        VALUES (gen_random_uuid(), ${accountId}::uuid, ${request.clientId}, ${request.clientHost}, ${request.clientName}, ${request.logoUri}, ${scopes}::text[])
        RETURNING id::text`;
      await tx.$executeRaw`
        INSERT INTO authorization_codes (code_hash, connected_app_id, redirect_uri, code_challenge, resource, expires_at)
        VALUES (${hashSecret(code)}, ${app.id}::uuid, ${request.redirectUri}, ${request.codeChallenge}, ${request.resource},
          now() + make_interval(secs => ${CODE_SECONDS}))`;
      return this.redirectTo(request.redirectUri, { code, state: request.state });
    });
    return { redirect };
  }

  /** Denies an app's request, and returns where the browser goes next: the app's redirect, with `access_denied`. */
  async deny(id: string): Promise<{ redirect: string }> {
    if (!UUID.test(id)) throw requestNotFound();
    const request = await claimRequest(this.prisma, id);
    return { redirect: this.redirectTo(request.redirectUri, { error: "access_denied", error_description: "The person denied the app", state: request.state }) };
  }

  /** The token endpoint: a code, with its PKCE verifier and `resource`, or a refresh token, for an access token and a new refresh token. */
  async token(form: Record<string, unknown>): Promise<TokenResponse> {
    switch (single(form, "grant_type")) {
      case "authorization_code":
        return this.exchangeCode(form);
      case "refresh_token":
        return this.refresh(form);
      case undefined:
        throw tokenError("invalid_request", "Name the grant_type");
      default:
        throw tokenError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
    }
  }

  private async exchangeCode(form: Record<string, unknown>): Promise<TokenResponse> {
    const code = single(form, "code");
    const verifier = single(form, "code_verifier");
    const redirectUri = single(form, "redirect_uri");
    const clientId = single(form, "client_id");
    const resource = single(form, "resource");
    if (!code || !verifier || !redirectUri || !clientId) throw tokenError("invalid_request", "Send the code, code_verifier, redirect_uri and client_id");
    if (!resource) throw tokenError("invalid_request", `Name this server's MCP endpoint, ${this.resource}, as the resource`);
    // In a statement of its own, which commits whatever follows: a code is tried once, rightly or not.
    const [used] = await this.prisma.$queryRaw<{ connectedAppId: string; redirectUri: string; codeChallenge: string; resource: string; live: boolean }[]>`
      DELETE FROM authorization_codes WHERE code_hash = ${hashSecret(code)}
      RETURNING connected_app_id::text AS "connectedAppId", redirect_uri AS "redirectUri", code_challenge AS "codeChallenge", resource,
        expires_at > now() AS live`;
    if (!used) throw tokenError("invalid_grant", "The code is not one this server issued, or it was used already");
    if (!used.live) throw tokenError("invalid_grant", "The code has expired; connect again");
    if (!PKCE_VERIFIER.test(verifier) || pkceChallenge(verifier) !== used.codeChallenge) throw tokenError("invalid_grant", "The code_verifier does not match the code's challenge");
    if (used.redirectUri !== redirectUri) throw tokenError("invalid_grant", "The redirect_uri is not the one the code was issued to");
    if (!sameResource(resource, used.resource)) throw tokenError("invalid_target", `The code was issued for ${used.resource}`);
    return this.prisma.$transaction(async (tx) => {
      const app = await standingApp(tx, used.connectedAppId);
      if (!app || app.clientId !== clientId) throw tokenError("invalid_grant", "The code was not issued to this app, or its Connected App can no longer be used");
      return this.issue(tx, used.connectedAppId, used.resource, effectiveScopes(app.scopes, app.role));
    });
  }

  private async refresh(form: Record<string, unknown>): Promise<TokenResponse> {
    const refreshToken = single(form, "refresh_token");
    const clientId = single(form, "client_id");
    const resource = single(form, "resource");
    if (!refreshToken || !clientId) throw tokenError("invalid_request", "Send the refresh_token and client_id");
    if (resource && !sameResource(resource, this.resource)) throw tokenError("invalid_target", `This server's MCP endpoint is ${this.resource}`);
    return this.prisma.$transaction(async (tx) => {
      // Replaced as it is used: of two uses at once, only the first gets new tokens.
      const [replaced] = await tx.$queryRaw<{ connectedAppId: string }[]>`
        DELETE FROM refresh_tokens r USING connected_apps c
        WHERE r.token_hash = ${hashSecret(refreshToken)} AND c.id = r.connected_app_id AND c.client_id = ${clientId}
        RETURNING r.connected_app_id::text AS "connectedAppId"`;
      if (!replaced) throw tokenError("invalid_grant", "The refresh token is not one this server issued to this app, or it was replaced already");
      const app = await standingApp(tx, replaced.connectedAppId);
      if (!app) throw tokenError("invalid_grant", "The Connected App can no longer be used; connect again");
      await recordUse(tx, replaced.connectedAppId);
      return this.issue(tx, replaced.connectedAppId, this.resource, effectiveScopes(app.scopes, app.role));
    });
  }

  private async issue(tx: Prisma.TransactionClient, connectedAppId: string, resource: string, scopes: string[]): Promise<TokenResponse> {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    await tx.$executeRaw`
      INSERT INTO access_tokens (token_hash, connected_app_id, resource, expires_at)
      VALUES (${hashSecret(accessToken)}, ${connectedAppId}::uuid, ${resource}, now() + make_interval(secs => ${ACCESS_TOKEN_SECONDS}))`;
    await tx.$executeRaw`INSERT INTO refresh_tokens (token_hash, connected_app_id) VALUES (${hashSecret(refreshToken)}, ${connectedAppId}::uuid)`;
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: scopes.join(" ") };
  }

  /** The app's redirect with these parameters added, and `iss` (RFC 9207). */
  private redirectTo(redirectUri: string, parameters: Record<string, string | null | undefined>): string {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(parameters)) if (value !== null && value !== undefined) url.searchParams.set(name, value);
    url.searchParams.set("iss", this.issuer);
    return url.href;
  }
}

interface ClaimedRequest {
  clientId: string;
  clientHost: string;
  clientName: string;
  logoUri: string | null;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  state: string | null;
}

/** Deletes an app's request as it is answered, so it is answered once, or refuses one that has expired or was answered. */
async function claimRequest(db: Prisma.TransactionClient, id: string): Promise<ClaimedRequest> {
  const [request] = await db.$queryRaw<(ClaimedRequest & { live: boolean })[]>`
    DELETE FROM authorization_requests WHERE id = ${id}::uuid
    RETURNING client_id AS "clientId", client_host AS "clientHost", client_name AS "clientName", logo_uri AS "logoUri",
      redirect_uri AS "redirectUri", code_challenge AS "codeChallenge", resource, scopes, state, expires_at > now() AS live`;
  if (!request?.live) throw requestNotFound();
  return request;
}

/** The Connected App, if it and its account still stand. */
async function standingApp(db: Prisma.TransactionClient, id: string): Promise<{ clientId: string; scopes: string[]; role: AccountRole } | undefined> {
  const [app] = await db.$queryRaw<{ clientId: string; scopes: string[]; role: AccountRole }[]>`
    SELECT c.client_id AS "clientId", c.scopes, a.role FROM connected_apps c JOIN accounts a ON a.id = c.account_id
    WHERE c.id = ${id}::uuid AND ${STANDING}`;
  return app;
}

/** Records the Connected App's use, at most once every USE_RECORDED_SECONDS. */
export async function recordUse(db: Prisma.TransactionClient, connectedAppId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE connected_apps SET last_used_at = now()
    WHERE id = ${connectedAppId}::uuid AND last_used_at < now() - make_interval(secs => ${USE_RECORDED_SECONDS})`;
}

function requestNotFound(): NotFoundException {
  return new NotFoundException("This request to connect an app has expired or was answered already. Connect again from the app.");
}

/** A parameter sent once, as a string; undefined when absent or empty. */
function single(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * What an app may be allowed, from the scopes it asked for: `change` too if
 * it asked for it, or named neither `read` nor `change`, leaving the choice
 * to the person. Others, such as `offline_access`, are ignored: every
 * approval issues a refresh token.
 */
function requestedScopes(scope: string | undefined): string[] {
  const asked = new Set(scope?.split(" ") ?? []);
  return asked.has(CHANGE) || !asked.has(READ) ? [READ, CHANGE] : [READ];
}

/** The consent page's choice: `read`, or `read` and `change`. */
function readChosenScopes(body: unknown): string[] {
  const scopes = typeof body === "object" && body !== null ? (body as { scopes?: unknown }).scopes : undefined;
  if (Array.isArray(scopes) && scopes.length === 1 && scopes[0] === READ) return [READ];
  if (Array.isArray(scopes) && scopes.length === 2 && scopes.includes(READ) && scopes.includes(CHANGE)) return [READ, CHANGE];
  throw new BadRequestException('Choose ["read"] or ["read", "change"]');
}

/** PKCE's S256 challenge of a verifier (RFC 7636). */
function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
