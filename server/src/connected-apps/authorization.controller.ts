import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  type OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { Request } from "express";
import { AllowStaff, AllowViewer, CurrentSession, Public } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { type AuthorizationRequestView, AuthorizationServer, type TokenResponse } from "./authorization-server.js";
import { AUTHORIZATION_PATH, CHANGE, READ, TOKEN_PATH, issuerOf, tokenError } from "./oauth.js";

/**
 * The authorization server's endpoints (ADR-0027). The authorization
 * endpoint and the token endpoint are public: an app's browser reaches the
 * first before anyone signs in, and the app itself the second. The consent
 * page's routes are any signed-in account's, a Viewer's included, as each
 * approves apps that act as itself.
 */
@Controller("api/oauth")
export class AuthorizationController {
  constructor(private readonly server: AuthorizationServer) {}

  /** Sends the browser to the consent page, or back to the app with an error. */
  @Public()
  @Get("authorize")
  @Redirect()
  async authorize(@Query() query: Record<string, unknown>): Promise<{ url: string; statusCode: number }> {
    const outcome = await this.server.authorize(query);
    return { url: "consent" in outcome ? outcome.consent : outcome.redirect, statusCode: 302 };
  }

  /** Exchanges a code or a refresh token for tokens. Form-encoded, as OAuth's token requests are. */
  @Public()
  @Post("token")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  async token(@Req() request: Request, @Body() body: unknown): Promise<TokenResponse> {
    if (!request.is("application/x-www-form-urlencoded") || typeof body !== "object" || body === null) {
      throw tokenError("invalid_request", "Send the token request form-encoded");
    }
    return this.server.token(body as Record<string, unknown>);
  }

  /** An app's request to connect, as the consent page shows it to the signed-in account. */
  @AllowStaff()
  @Get("requests/:id")
  async request(@Param("id") id: string, @CurrentSession() { account }: SignedIn): Promise<{ request: AuthorizationRequestView }> {
    return { request: await this.server.request(id, account.role) };
  }

  /** Approves it, with `{ scopes: ["read"] }` or `{ scopes: ["read", "change"] }`, and answers where the browser goes next. */
  @AllowStaff()
  @AllowViewer()
  @Post("requests/:id/approve")
  @HttpCode(200)
  approve(@Param("id") id: string, @Body() body: unknown, @CurrentSession() { account }: SignedIn): Promise<{ redirect: string }> {
    return this.server.approve(id, account.id, body);
  }

  /** Denies it, and answers where the browser goes next. */
  @AllowStaff()
  @AllowViewer()
  @Post("requests/:id/deny")
  @HttpCode(200)
  deny(@Param("id") id: string): Promise<{ redirect: string }> {
    return this.server.deny(id);
  }
}

/**
 * Serves the authorization server's metadata (RFC 8414) at the public URL's
 * origin, as the MCP module serves the endpoint's protected resource
 * metadata: on the HTTP platform, outside the REST API and its guards.
 */
@Injectable()
export class AuthorizationServerMetadata implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    const issuer = issuerOf(this.config);
    const metadata = {
      issuer,
      authorization_endpoint: `${issuer}${AUTHORIZATION_PATH}`,
      token_endpoint: `${issuer}${TOKEN_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [READ, CHANGE, "offline_access"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
    adapter.get("/.well-known/oauth-authorization-server", (_request: unknown, response: unknown) => {
      adapter.setHeader(response, "Access-Control-Allow-Origin", "*");
      adapter.setHeader(response, "Cache-Control", "public, max-age=3600");
      adapter.reply(response, metadata, 200);
    });
  }
}
