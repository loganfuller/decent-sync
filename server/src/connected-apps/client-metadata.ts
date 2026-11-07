import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";
import { isLoopbackAddress, isPublicAddress } from "./public-addresses.js";

/** The most a Client ID Metadata Document may hold. Apps' documents are a few hundred bytes. */
const MAX_DOCUMENT_BYTES = 16 * 1024;
/** How long fetching one may take, connecting included. */
const FETCH_TIMEOUT_MS = 5_000;
/** The longest name kept and shown for an app. */
const MAX_NAME_LENGTH = 100;

/** An app as its Client ID Metadata Document describes it. */
export interface ClientMetadata {
  /** The document's URL, which is the app's client id. */
  clientId: string;
  /** The client id's host, shown above the name the app gives itself, which any page could make "Claude". */
  host: string;
  name: string;
  logoUri: string | null;
  redirectUris: string[];
}

/** Why an app's client id can't be used; the authorization endpoint answers it with 400, not to the app's redirect. */
export class ClientRefused extends Error {
  override name = "ClientRefused";
}

/**
 * Fetches and checks an app's Client ID Metadata Document, its client id
 * being the document's URL (ADR-0027): over HTTPS only, from a host whose
 * every address is public, connecting to an address it checked, following no
 * redirect, within MAX_DOCUMENT_BYTES and FETCH_TIMEOUT_MS. The document's
 * `client_id` must be its URL. With TEST_LOOPBACK_CLIENT_METADATA, a test
 * app may serve it over plain HTTP from a loopback address instead.
 */
@Injectable()
export class ClientMetadataDocuments {
  private readonly loopback: boolean;

  constructor(@Inject(CONFIG) config: Config) {
    this.loopback = config.loopbackClientMetadata;
  }

  async fetch(clientId: string): Promise<ClientMetadata> {
    const url = this.clientIdUrl(clientId);
    const body = await this.download(url);
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      throw new ClientRefused("The app's Client ID Metadata Document is not JSON");
    }
    return this.read(clientId, url, document);
  }

  /** Whether a redirect URI the app sent is one its document lists: the same, or for a loopback one, the same but for its port (RFC 8252). */
  static redirectListed(redirectUri: string, listed: readonly string[]): boolean {
    if (listed.includes(redirectUri)) return true;
    if (!URL.canParse(redirectUri)) return false;
    const requested = new URL(redirectUri);
    if (!isLoopbackRedirect(requested)) return false;
    return listed.some((entry) => {
      if (!URL.canParse(entry)) return false;
      const allowed = new URL(entry);
      return (
        isLoopbackRedirect(allowed) &&
        allowed.hostname === requested.hostname &&
        allowed.pathname === requested.pathname &&
        allowed.search === requested.search
      );
    });
  }

  private clientIdUrl(clientId: string): URL {
    if (!URL.canParse(clientId)) throw new ClientRefused("The app's client_id is not a URL");
    const url = new URL(clientId);
    if (url.href !== clientId) throw new ClientRefused("The app's client_id is not a URL in its usual form");
    const plainLoopback = this.loopback && url.protocol === "http:" && isLoopbackAddress(url.hostname);
    if (url.protocol !== "https:" && !plainLoopback) throw new ClientRefused("The app's client_id must be an https:// URL");
    if (url.username || url.password || url.hash) throw new ClientRefused("The app's client_id must have no credentials or fragment");
    if (url.pathname === "/") throw new ClientRefused("The app's client_id must have a path");
    return url;
  }

  private allowedAddress(address: string): boolean {
    return isPublicAddress(address) || (this.loopback && isLoopbackAddress(address));
  }

  /** The document's text, fetched from an address checked as it was connected to. */
  private download(url: URL): Promise<string> {
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    // Node connects to an address literal without a lookup.
    if (isIP(hostname) !== 0 && !this.allowedAddress(hostname)) {
      return Promise.reject(new ClientRefused("The app's Client ID Metadata Document is not on a public address"));
    }
    const lookup: LookupFunction = (name, options, callback) => {
      dns.lookup(name, { all: true, family: options.family }, (error, addresses) => {
        if (error) return callback(error, "", 0);
        if (addresses.length === 0 || !addresses.every((each) => this.allowedAddress(each.address))) {
          return callback(new ClientRefused("The app's Client ID Metadata Document is not on a public address"), "", 0);
        }
        if (options.all) return (callback as unknown as (error: null, addresses: dns.LookupAddress[]) => void)(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      });
    };
    return new Promise<string>((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.get(url, { lookup, headers: { Accept: "application/json" }, agent: false }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          const redirect = response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400;
          return fail(new ClientRefused(redirect ? "The app's Client ID Metadata Document redirects, which is not followed" : `Fetching the app's Client ID Metadata Document answered ${response.statusCode}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) return fail(new ClientRefused("The app's Client ID Metadata Document is too large"));
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        response.on("error", fail);
      });
      const timer = setTimeout(() => fail(new ClientRefused("Fetching the app's Client ID Metadata Document took too long")), FETCH_TIMEOUT_MS);
      request.on("error", (error) => fail(error instanceof ClientRefused ? error : new ClientRefused(`The app's Client ID Metadata Document could not be fetched: ${error.message}`)));
      function fail(error: Error) {
        clearTimeout(timer);
        request.destroy();
        reject(error);
      }
    });
  }

  private read(clientId: string, url: URL, document: unknown): ClientMetadata {
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new ClientRefused("The app's Client ID Metadata Document is not a JSON object");
    }
    const fields = document as Record<string, unknown>;
    if (fields.client_id !== clientId) throw new ClientRefused("The app's Client ID Metadata Document names another client_id than its URL");
    const redirectUris = fields.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((uri) => typeof uri === "string" && URL.canParse(uri))) {
      throw new ClientRefused("The app's Client ID Metadata Document lists no redirect_uris");
    }
    const method = fields.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      throw new ClientRefused(`The app authenticates with ${String(method)}, which this server doesn't support`);
    }
    const name = typeof fields.client_name === "string" ? fields.client_name.trim().slice(0, MAX_NAME_LENGTH) : "";
    return {
      clientId,
      host: url.host,
      name: name || url.host,
      logoUri: this.logoUri(fields.logo_uri),
      redirectUris: redirectUris as string[],
    };
  }

  /** The app's logo, shown on the consent page, only from an https:// URL (or a test's loopback one). */
  private logoUri(value: unknown): string | null {
    if (typeof value !== "string" || !URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.protocol === "https:" || (this.loopback && url.protocol === "http:" && isLoopbackAddress(url.hostname))) return url.href;
    return null;
  }
}

/** A loopback redirect of a native app, whose port the app chooses as it starts (RFC 8252, section 7.3). */
function isLoopbackRedirect(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || isLoopbackAddress(url.hostname));
}
