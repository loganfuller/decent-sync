import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// How Decaid v0.9.3 manages its Skins, for the simulated tablet: its Skin
// list, default, install, update check and remove routes, and its Skin
// server's status, stop and start (`WebUIHandler` in
// decaid:lib/src/services/webserver/webui_handler.dart). Every answer and
// entry here is one Decaid's Linux release answered, recorded in
// fixtures/decaid/tablet-software-v0.9.3/skin-management.json (its README):
// a Skin's entry is taken whole from the step that installed it, and only
// ids, ports and times are put in the places the recording holds them. Two
// answers are derived from the handler's source, as no recording holds
// them, and say so where they are made: a start that fails, and an update
// check that installs a newer build.

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/decaid/tablet-software-v0.9.3");

type Json = Record<string, unknown>;
interface Step {
  exchanges?: { request: { method: string; path: string; body?: unknown }; response: { status: number; body: unknown } }[];
  reads: Record<string, { status: number; body?: unknown; unchanged?: true }>;
}

const SKINS = JSON.parse(fs.readFileSync(path.join(fixturesDir, "skin-management.json"), "utf8")) as Record<string, Step>;

/** Decaid's answer to the nth request of a recorded step. */
function recorded(step: string, index = 0): { status: number; body: unknown } {
  const exchange = SKINS[step]?.exchanges?.[index];
  if (!exchange) throw new Error(`The recording holds no exchange ${index} of ${step}`);
  return structuredClone(exchange.response);
}

/** A recorded read of a route as it stood after a step: the last one at or before it that was not kept as unchanged. */
function readAt(step: string, route: string): unknown {
  let body: unknown;
  for (const [name, { reads }] of Object.entries(SKINS)) {
    const read = reads?.[route];
    if (read && !read.unchanged) body = read.body;
    if (name === step) return structuredClone(body);
  }
  throw new Error(`No step ${step} was recorded`);
}

/** A Skin's entry in Decaid's list as recorded after a step: `streamline-cafe.js` once installed from its release (`releaseInstalled`), `streamline.js-dist` from a branch (`branchInstalled`), `streamline-cafe.js-dist` from a commit's archive (`urlInstalled`), or one Decaid comes with. */
export function recordedSkin(id: string, step = "urlInstalled"): Json {
  const skin = (readAt(step, "/webui/skins") as Json[]).find((entry) => entry.id === id);
  if (!skin) throw new Error(`No Skin ${id} was recorded at ${step}`);
  return skin;
}

/** Where an install takes a Skin from: a repository's release or branch, or a URL. */
export type SkinSource = { repo: string; branch?: string } | { url: string };

function keyOf(source: SkinSource): string {
  return "url" in source ? `url ${source.url}` : `${source.repo.toLowerCase()} ${source.branch ?? ""}`;
}

/**
 * The Skins on a simulated tablet's Decaid, its default and what its Skin
 * server serves, and what manages them. Starts as a new v0.9.3 does once it
 * has installed the Skins it comes with: Streamline the default and served.
 */
export class SimulatedSkins {
  private skins: Json[] = readAt("started", "/webui/skins") as Json[];
  private defaultId: string | null = String((readAt("started", "/webui/skins/default") as Json).id);
  /** What the Skin server serves: a Skin's path and its port, or null while stopped. */
  private serving: { path: string; port: number } | null = { path: String((readAt("started", "/webui/server/status") as Json).path), port: Number((readAt("started", "/webui/server/status") as Json).port) };
  /** The port each Skin is served on, by its path, as Decaid keeps one a folder (`webUISkinPorts`). */
  private readonly ports = new Map<string, number>([[String((readAt("started", "/webui/server/status") as Json).path), Number((readAt("started", "/webui/server/status") as Json).port)]]);
  private readonly offers = new Map<string, Json>();
  /** Newer builds an update check installs, by the id of the Skin they replace. */
  private readonly newer = new Map<string, Json>();
  /** How many starts of the Skin server fail from now on. */
  failStarts = 0;
  /** Every managing request taken, as `METHOD route`. */
  readonly managed: string[] = [];
  /** Called each time the Skin server starts serving a Skin, as the Skin view then loads it: with that Skin's entry. */
  onServed?: (skin: Json) => void;

  /** The Skins as Decaid lists them now. */
  listed(): Json[] {
    return structuredClone(this.skins);
  }

  /** The id of the Skin served now, or null while none is. */
  servedId(): string | null {
    const served = this.serving;
    return served === null ? null : (this.skins.find((skin) => skin.path === served.path)?.id as string | undefined) ?? null;
  }

  /** The default Skin's id. */
  defaultSkinId(): string | null {
    return this.defaultId;
  }

  /** Has an install from a source give this Skin's entry, as recorded (`recordedSkin`). */
  offer(source: SkinSource, skin: Json): void {
    this.offers.set(keyOf(source), structuredClone(skin));
  }

  /** Has the next update check install a newer build of an installed Skin: its entry with this version. Derived: the recording's check found every Skin current. */
  offerNewer(id: string, version: string): void {
    const skin = this.skins.find((entry) => entry.id === id);
    if (!skin) throw new Error(`No Skin ${id} is installed`);
    this.newer.set(id, { ...structuredClone(skin), version });
  }

  /** Installs a Skin as an earlier install would have, before the test begins. */
  install(skin: Json): void {
    this.skins = [...this.skins.filter((entry) => entry.id !== skin.id), structuredClone(skin)];
  }

  /** Has the default Skin be this one, as if chosen before the test, and serves it where `serve`. */
  makeDefault(id: string, serve = false): void {
    const skin = this.skins.find((entry) => entry.id === id);
    if (!skin) throw new Error(`No Skin ${id} is installed`);
    this.defaultId = id;
    if (serve) this.serve(skin);
  }

  /** Decaid's answer to a request to its Skin routes, or undefined for any other route. */
  answer(method: string, route: string, body: unknown): { status: number; body: unknown } | undefined {
    if (!route.startsWith("/webui/")) return undefined;
    if (method === "GET") return this.read(route);
    this.managed.push(`${method} ${route}`);
    const given = parsedBody(body);
    switch (route) {
      case "/webui/skins/default":
        if (method !== "PUT") break;
        return this.chooseDefault(isObject(given) ? given.skinId : undefined);
      case "/webui/skins/install/github-release":
      case "/webui/skins/install/github-branch":
      case "/webui/skins/install/url":
        return this.installFrom(route, given);
      case "/webui/skins/update":
        return this.checkUpdates();
      case "/webui/server/stop":
        if (this.serving === null) return recorded("stoppedAgain");
        this.serving = null;
        return recorded("serverStopped");
      case "/webui/server/start":
        return this.start();
      default:
        if (method === "DELETE" && /^\/webui\/skins\/[^/]+$/.test(route)) return this.remove(decodeURIComponent(route.slice("/webui/skins/".length)));
    }
    throw new Error(`The simulated tablet's API carries out no ${method} ${route}`);
  }

  private read(route: string): { status: number; body: unknown } | undefined {
    if (route === "/webui/skins") return { status: 200, body: this.listed() };
    if (route === "/webui/server/status") {
      const status = structuredClone(this.serving === null ? (readAt("serverStopped", "/webui/server/status") as Json) : (readAt("started", "/webui/server/status") as Json));
      return { status: 200, body: this.serving === null ? status : { ...status, path: this.serving.path, port: this.serving.port } };
    }
    if (route === "/webui/skins/default") {
      // Decaid falls back to Streamline, then to a Skin it comes with, where the default chosen is gone (`WebUIStorage.defaultSkin`).
      const skin = this.defaultSkin();
      return skin ? { status: 200, body: structuredClone(skin) } : undefined;
    }
    const id = /^\/webui\/skins\/([^/]+)$/.exec(route)?.[1];
    const skin = id === undefined ? undefined : this.skins.find((entry) => entry.id === decodeURIComponent(id));
    return skin ? { status: 200, body: structuredClone(skin) } : undefined;
  }

  private defaultSkin(): Json | undefined {
    return this.skins.find((skin) => skin.id === this.defaultId) ?? this.skins.find((skin) => skin.id === "streamline.js") ?? this.skins.find((skin) => skin.isBundled === true) ?? this.skins[0];
  }

  private chooseDefault(skinId: unknown): { status: number; body: unknown } {
    const id = typeof skinId === "string" ? skinId : "";
    if (!this.skins.some((skin) => skin.id === id)) return named(recorded("unknownDefault"), "no-such-skin", id);
    this.defaultId = id;
    return named(recorded("defaultSwitched"), "streamline-cafe.js", id);
  }

  private installFrom(route: string, given: unknown): { status: number; body: unknown } {
    const fields = isObject(given) ? given : {};
    const branch = route.endsWith("github-branch") ? (typeof fields.branch === "string" ? fields.branch : "main") : undefined;
    const source: SkinSource = route.endsWith("/url") ? { url: String(fields.url ?? "") } : { repo: String(fields.repo ?? ""), ...(branch === undefined ? {} : { branch }) };
    const skin = this.offers.get(keyOf(source));
    // No such repository, branch or download, as a commit given as a branch fails, recorded.
    if (!skin) return recorded("commitAsBranch");
    const now = new Date().toISOString().replace("Z", "");
    const entry = { ...structuredClone(skin), reaMetadata: { ...(isObject(skin.reaMetadata) ? skin.reaMetadata : {}), installedAt: now, lastChecked: now } };
    this.install(entry);
    if ("url" in source) return named(recorded("urlInstalled"), "https://github.com/loganfuller/streamline-cafe-js/archive/d7729dc9532ae31d606447ee0648e20284268b2c.zip", source.url);
    const answer = recorded(branch === undefined ? "releaseInstalled" : "branchInstalled");
    return { status: answer.status, body: { ...(answer.body as Json), repo: source.repo, ...(branch === undefined ? {} : { branch }) } };
  }

  /** A result for each Skin Decaid updates, as recorded: by its repository for one it comes with, by its id for one installed; `updated` for one with a newer build offered. */
  private checkUpdates(): { status: number; body: unknown } {
    const answer = recorded("checked");
    const now = new Date().toISOString().replace("Z", "");
    const results = this.skins.flatMap((skin): Json[] => {
      const metadata = isObject(skin.reaMetadata) ? skin.reaMetadata : null;
      if (metadata === null) return [];
      metadata.lastChecked = now;
      const repo = /^github_release:([^@]+)@/.exec(String(metadata.sourceUrl))?.[1];
      const item = skin.isBundled === true && repo !== undefined ? repo : String(skin.id);
      const newer = this.newer.get(String(skin.id));
      if (!newer) return [{ item, status: "alreadyCurrent" }];
      this.newer.delete(String(skin.id));
      Object.assign(skin, newer, { reaMetadata: { ...(isObject(newer.reaMetadata) ? newer.reaMetadata : {}), installedAt: now, lastChecked: now } });
      return [{ item, status: "updated" }];
    });
    return { status: answer.status, body: { ...(answer.body as Json), results } };
  }

  private remove(id: string): { status: number; body: unknown } {
    const skin = this.skins.find((entry) => entry.id === id);
    if (!skin) return named(recorded("unknownRemoved"), "no-such-skin", id);
    if (skin.isBundled === true) return named(recorded("bundledRemoveRefused"), "insight", id);
    // Decaid removes the default Skin too, and serves its folder on until the server stops (`defaultRemoved`).
    this.skins = this.skins.filter((entry) => entry !== skin);
    return named(recorded("removed"), "streamline.js-dist", id);
  }

  private start(): { status: number; body: unknown } {
    if (this.serving !== null) return recorded("startedAgain");
    const skin = this.defaultSkin();
    if (!skin) throw new Error("The simulated tablet has no Skin to serve, which no recording answers");
    if (this.failStarts > 0) {
      this.failStarts--;
      // Derived from `_handleServerStart`: its catch answers 500 with the error; no recording holds one.
      return { status: 500, body: { error: "Failed to start: SocketException: Failed to create server socket" } };
    }
    this.serve(skin);
    return { status: 200, body: { ...(recorded("serverStarted").body as Json), path: skin.path } };
  }

  private serve(skin: Json): void {
    const skinPath = String(skin.path);
    const port = this.ports.get(skinPath) ?? 25000 + this.ports.size * 311;
    this.ports.set(skinPath, port);
    this.serving = { path: skinPath, port };
    this.onServed?.(structuredClone(skin));
  }
}

/** A recorded answer with the id, or URL, it was recorded for replaced by the one asked for. */
function named(answer: { status: number; body: unknown }, was: string, now: string): { status: number; body: unknown } {
  return { status: answer.status, body: JSON.parse(JSON.stringify(answer.body).replaceAll(JSON.stringify(was).slice(1, -1), JSON.stringify(now).slice(1, -1))) };
}

function parsedBody(body: unknown): unknown {
  if (typeof body !== "string") return body ?? null;
  try {
    return body === "" ? null : JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
