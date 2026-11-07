import { Injectable } from "@nestjs/common";
import type { McpContext, McpTokenVerifier } from "@nestjs/mcp";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { type ConnectedAppAccess, ConnectedAppTokens } from "../connected-apps/access.js";

/** What a verified MCP request's `authInfo.extra` holds: who it acts as. */
export interface McpCaller {
  access: ConnectedAppAccess;
}

/**
 * The MCP endpoint's token verifier, which the MCP module calls on every
 * request, `tools/list` included: the access token of a Connected App that
 * still stands, with its scopes, expiry, resource, and the Connected App and
 * account it acts for (`ConnectedAppTokens`). Anything else is refused with
 * 401 and a challenge naming the protected resource metadata.
 */
@Injectable()
export class AccessTokenVerifier implements McpTokenVerifier {
  constructor(private readonly tokens: ConnectedAppTokens) {}

  async verifyAccessToken(token: string): Promise<AuthInfo | null> {
    const access = await this.tokens.verify(token);
    if (!access) return null;
    return {
      token,
      clientId: access.clientId,
      scopes: access.scopes,
      // The module compares it with this instance's clock: the time the token has left by PostgreSQL's, from now by this one.
      expiresAt: Math.floor(Date.now() / 1000 + access.secondsLeft),
      resource: new URL(access.resource),
      extra: { access } satisfies McpCaller,
    };
  }
}

/** Who a tool call acts as, as its access token was verified for this request. */
export function callerOf(context: McpContext): ConnectedAppAccess {
  const caller = context.authInfo?.extra as McpCaller | undefined;
  // The module verifies every request's token before any tool is called.
  if (!caller) throw new Error("A tool was called without a verified access token");
  return caller.access;
}
