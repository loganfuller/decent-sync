import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, SYNC_PATH } from "@decent-sync/protocol";
import WebSocket from "ws";
import { assertBuilt } from "./builds.js";
import { rememberSecret, watchLog } from "./secrets.js";

// Seam 1's simulated tablet: runs the built decent-sync.reaplugin/plugin.js
// (`npm run build` first) in a stand-in for Decaid's plugin host, the way
// Decaid v0.8.7 does (decaid:lib/src/plugins/plugin_manager.dart and
// plugin_transport_service.dart):
//
// - The source is pasted into a function body with `host`, `fetch`,
//   `setTimeout` and `clearTimeout` in scope; the global createPlugin(host)
//   must return an object whose id matches the manifest, and onLoad is called
//   synchronously without awaiting it. Then the plugin is sent the current
//   Workflow in a `workflowUpdated` event, as Decaid sends it after every load.
// - `fetch` answers Decaid's local API from fixtures, failing after Decaid's
//   30 s timeout. `GET /shots` pages the Shots served at `/shots/{id}`, and
//   `GET /steams/ids` lists the Steam Records served at `/steams/{id}`. The
//   library's lists leave out archived and hidden records unless asked for
//   them, and send an ETag, answering 304 to it in If-None-Match. A key of
//   plugin storage never written answers `null`. The machine's settings, like
//   its info, fail while no machine is connected.
// - The plugin's local time, as JavaScript reads it, is this process's time
//   zone: set `process.env.TZ` to put the tablet in another one.
// - `host.transport` opens real WebSockets with only a URL and subprotocols
//   (no custom headers), allows 8 live transports per plugin generation
//   (counting opens still in progress, which cannot be cancelled),
//   rejects a send that would take the pending outbound bytes past 1 MiB,
//   closes a transport whose undelivered inbound bytes pass 1 MiB, and
//   delivers events asynchronously and in order, ending with a close event.
//   A send resolves once its frame is queued. Frames are written in order,
//   one at a time, and stay pending until written; `uploadBytesPerSecond`
//   slows the writing, so pending bytes build up as on a slow network, and
//   `stallUpload` stops it at a chosen frame. Closing a transport first
//   waits for its queued frames to be written. `loseNetwork` ends every
//   connection and fails every open until `restoreNetwork`, while Decaid's
//   own API keeps answering.
// - `host.storage` is Decaid's plugin storage, given only to a plugin whose
//   manifest declares `pluginStorage`: it answers a read with a `storageRead`
//   event of `{ key, value }`, `value` null for a key never written, and a
//   write with a `storageWrite` event of the data written, each in a later
//   turn, and never answers a command that fails. Its values belong to a
//   `PluginStorage`, which outlives the load: give the next load of the same
//   tablet the same one. Decaid's store API (`/store/{plugin id}`) reads the
//   same values.
// - Unloading calls onUnload, then cancels the generation's timers and closes
//   its transports, dropping their later events.
// - Timers are the host's, so a test can run them faster with `timeScale` to
//   reach the plugin's timeouts and backoff quickly. The server keeps real
//   time, though. The heartbeat interval in its `welcome` is slowed by the
//   same factor, so a sped-up plugin still heartbeats, and expects the
//   server's answers, at the server's pace. And from the moment a connection
//   starts to open until the server's first answer, the tablet's clock runs
//   at real time: the server's work on an upgrade and a hello takes real time
//   however fast the tablet runs, and a sped-up connect deadline would
//   otherwise give up on a server that is merely busy. A stalled upgrade and
//   a slow one look the same, though, so an upgrade the server never answers
//   then waits out the deadline in real time; `upgradeAtTabletPace` times
//   upgrades at the sped-up pace, for tests of servers that never answer one.
//
// RawConnection is the raw-frame mode, for protocol cases the plugin never
// produces.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reapluginDir = path.join(repoDir, "decent-sync.reaplugin");
const fixturesDir = path.join(repoDir, "server/test/fixtures/decaid");

const API_ORIGIN = "http://localhost:8080";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_LIVE_TRANSPORTS = 8;
const MAX_PENDING_OUTBOUND_BYTES = 1 << 20;
const MAX_QUEUED_INBOUND_BYTES = 1 << 20;

export interface BuiltPlugin {
  id: string;
  version: string;
  onLoad(settings: Record<string, unknown>): unknown;
  onUnload(): unknown;
  onEvent(event: { name: string; payload?: unknown }): unknown;
}

export function readBuiltPlugin(): { source: string; manifest: Record<string, unknown> } {
  assertBuilt("plugin");
  return {
    source: fs.readFileSync(path.join(reapluginDir, "plugin.js"), "utf8"),
    manifest: JSON.parse(fs.readFileSync(path.join(reapluginDir, "manifest.json"), "utf8")),
  };
}

/**
 * Decaid API responses, by path under /api/v1 (such as "/machine/info"):
 * each answered with status 200, or, if it is a `Refusal`, with its status.
 */
export type DecaidApi = Record<string, unknown>;

/** A response Decaid's API refuses with, such as 503 while no scale is connected. */
export class Refusal {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/**
 * The test tablet's DE1Pro on Decaid 0.8.7, with its hardware ids replaced
 * (see the fixtures' README): its library, settings and paired devices
 * included. Its scale is off, so `/scale/info` answers 503, and DYE2 has
 * never written its equipment, which therefore answers `null`.
 */
export function de1ProOnDecaid087(): DecaidApi {
  return {
    "/info": readFixture("info.json"),
    "/machine/info": readFixture("machine-info.json"),
    "/settings": readFixture("settings.json"),
    "/workflow": readFixture("workflow.json"),
    "/machine/state": readFixture("machine-state.json"),
    "/beans": readFixture("beans.json"),
    "/bean-batches": readFixture("bean-batches.json"),
    "/grinders": readFixture("grinders.json"),
    "/profiles": readFixture("profiles.json"),
    "/store/dye2.reaplugin/recipes": readFixture("dye2-recipes.json"),
    "/store/dye2.reaplugin/baskets": readFixture("dye2-baskets.json"),
    "/machine/settings": readFixture("machine-settings.json"),
    "/machine/settings/advanced": readFixture("machine-settings-advanced.json"),
    "/devices": readFixture("devices.json"),
    "/scale/info": new Refusal(503, readFixture("scale-info-no-scale.json")),
    "/sensors": readFixture("sensors.json"),
  };
}

/**
 * Decaid's own simulated devices (simulated-devices-v0.8.7/): a connected
 * scale, which reports no firmware or battery level, two sensors, and a
 * second machine only discovered nearby, with the app settings recorded
 * beside them, which prefer that scale and name that machine's connection
 * id. Merge it into a tablet's API.
 */
export function simulatedDevices(): DecaidApi {
  return {
    "/settings": readFixture("settings.json", "simulated-devices-v0.8.7"),
    "/devices": readFixture("devices.json", "simulated-devices-v0.8.7"),
    "/sensors": readFixture("sensors.json", "simulated-devices-v0.8.7"),
    "/scale/info": readFixture("scale-info.json", "simulated-devices-v0.8.7"),
  };
}

/**
 * Decaid's simulated devices after its machine and scale were disconnected:
 * the inventory lists them disconnected, and `/scale/info` answers 503. The
 * sensors stay connected. Merge it into a tablet's API, and set
 * `machineConnected` false for the machine.
 */
export function simulatedDevicesSwitchedOff(): DecaidApi {
  return {
    ...simulatedDevices(),
    "/devices": readFixture("devices-disconnected.json", "simulated-devices-v0.8.7"),
    "/scale/info": new Refusal(503, readFixture("scale-info-no-scale.json")),
  };
}

/**
 * The library Decaid's simulated devices were recorded with, which has an
 * archived bean, bean batch and grinder and a hidden profile, and their
 * machine's settings and advanced settings. Merge it into a tablet's API.
 */
export function simulatedLibrary(): DecaidApi {
  const simulated = (file: string) => readFixture(file, "simulated-devices-v0.8.7");
  return {
    "/beans": simulated("beans.json"),
    "/bean-batches": simulated("bean-batches.json"),
    "/grinders": simulated("grinders.json"),
    "/profiles": simulated("profiles.json"),
    "/machine/settings": simulated("machine-settings.json"),
    "/machine/settings/advanced": simulated("machine-settings-advanced.json"),
  };
}

/**
 * Derived: the test tablet's profiles, repeated with their ids changed (each
 * repeat's suffixed `-copy-N`) until their JSON is larger than `minBytes`,
 * as a tablet with many profiles would answer.
 */
export function manyProfiles(minBytes = 1.25 * 1024 * 1024): Record<string, unknown>[] {
  const profiles = readFixture<Record<string, unknown>[]>("profiles.json");
  const copies = Math.ceil(minBytes / Buffer.byteLength(JSON.stringify(profiles))) + 1;
  return Array.from({ length: copies }, (_, copy) =>
    profiles.map((profile) => (copy === 0 ? profile : { ...profile, id: `${String(profile.id)}-copy-${copy}` })),
  ).flat();
}

function readFixture<T = Record<string, unknown>>(file: string, folder = "de1pro-v0.8.7"): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, folder, file), "utf8"));
}

/** What /machine/info and the machine's settings answer, with status 500, while no machine is connected. */
function machineNotConnected(): Refusal {
  return new Refusal(500, readFixture("machine-not-connected.json", "simulated-devices-v0.8.7"));
}

/** Routes Decaid answers with ETags (jsonOkConditional in json_response.dart), and the query that includes archived or hidden records. */
const LIBRARY_LISTS: Readonly<Record<string, { include: string; hidden(record: Record<string, unknown>): boolean }>> = {
  "/beans": { include: "includeArchived", hidden: (record) => record.archived === true },
  "/bean-batches": { include: "includeArchived", hidden: (record) => record.archived === true },
  "/grinders": { include: "includeArchived", hidden: (record) => record.archived === true },
  "/profiles": { include: "includeHidden", hidden: (record) => record.visibility !== "visible" },
};

/** The test tablet's Workflow: what `GET /workflow` answers and `workflowUpdated` carries. */
export function workflowFixture(): Record<string, unknown> {
  return readFixture("workflow.json");
}

/**
 * Derived from workflowFixture(): the same Workflow with the named changes
 * to its `context` (dose, yield, bean, grinder and so on), as when a barista
 * dials in. Everything else is as Decaid sent it.
 */
export function derivedWorkflow(context: Record<string, unknown>): Record<string, unknown> {
  const workflow = workflowFixture();
  return { ...workflow, context: { ...(workflow.context as Record<string, unknown>), ...context } };
}

/**
 * Derived from the test tablet's machine state: the same snapshot, as a
 * `stateUpdate` carries it, in another of Decaid's states and substates
 * (MachineState and MachineSubstate in decaid:lib/src/models/device/machine.dart).
 */
export function machineSnapshot(state: string, substate: string): Record<string, unknown> {
  return { ...readFixture("machine-state.json"), state: { state, substate } };
}

/**
 * Derived from de1ProOnDecaid087(): the same responses, with the machine's
 * reported model and serial, the preferred machine's connection id, or
 * Decaid's version (such as 0.8.6+2801, split into its version and build
 * number as Decaid reports them too) changed. Every other field is as Decaid
 * sent it.
 */
export function derivedDe1Pro(changes: { model?: string; serial?: string; connectionId?: string; decaidVersion?: string }): DecaidApi {
  const api = de1ProOnDecaid087();
  const info = api["/info"] as Record<string, unknown>;
  const machineInfo = api["/machine/info"] as Record<string, unknown>;
  const settings = api["/settings"] as Record<string, unknown>;
  const [version, buildNumber] = changes.decaidVersion?.split("+") ?? [];
  return {
    ...api,
    "/info": changes.decaidVersion === undefined ? info : { ...info, version, buildNumber, fullVersion: changes.decaidVersion },
    "/machine/info": {
      ...machineInfo,
      ...(changes.model === undefined ? {} : { model: changes.model }),
      ...(changes.serial === undefined ? {} : { serialNumber: changes.serial }),
    },
    "/settings": { ...settings, ...(changes.connectionId === undefined ? {} : { preferredMachineId: changes.connectionId }) },
  };
}

/** Plugin settings for a machine entry, as someone at the machine enters them. */
export function settingsFor({ token, serverUrl }: { token: string; serverUrl: string }): Record<string, unknown> {
  return { ServerUrl: serverUrl, Token: token };
}

/** A valid `hello` of this protocol version, for raw frames, from a new tablet unless `extra` names its `tabletId`. */
export function helloWith(token: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  rememberSecret(token);
  return {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    token,
    pluginVersion: "0.1.0",
    decaidVersion: "0.8.7+2847",
    tabletId: randomUUID(),
    connectionId: "00:00:5E:00:53:01",
    ...extra,
  };
}

/**
 * Decaid's plugin storage for this plugin (`_handlePluginStorage` in
 * plugin_manager.dart, over its Hive store), which holds the tablet's id. It
 * is part of the tablet's Decaid data, so it lasts across loads of the plugin:
 * give each load of one tablet the same one. `clear()` stands for resetting
 * the tablet's Decaid data, and `save()` and `restore()` for exporting it in
 * a Decaid backup and importing that backup.
 *
 * Decaid's backup (`GET /api/v1/data/export`) holds a plugin's storage only
 * once Decaid's store API has opened it since Decaid started: its
 * KvStoreExportSection lists the stores that API's own Hive service opened,
 * and `host.storage` goes through another. Each load of the plugin stands for
 * Decaid starting. (Seen on Decaid v0.8.7's Linux release on 2026-10-07: a
 * backup left out the plugin's storage until `GET
 * /api/v1/store/decent-sync.reaplugin/tabletId` had been answered.)
 */
export class PluginStorage {
  private values = new Map<string, unknown>();
  private failingReads = 0;
  /** Whether Decaid's store API has opened this storage since Decaid started, which a backup needs. */
  private openedThroughApi = false;

  /** The value at a key, as a read answers it: null if never written. */
  read(key: string): unknown {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  /** Writes a value, as anything else writing to the plugin's storage would. */
  write(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }

  /** Loses every value, as resetting the tablet's Decaid data does. */
  clear(): void {
    this.values.clear();
  }

  /** The values a Decaid backup taken now holds: none until Decaid's store API has opened this storage since Decaid started. */
  save(): ReadonlyMap<string, unknown> {
    return this.openedThroughApi ? structuredClone(this.values) : new Map();
  }

  /** Puts back the values saved, and only those, as importing that backup onto a reset tablet does. */
  restore(saved: ReadonlyMap<string, unknown>): void {
    this.values = structuredClone(new Map(saved));
  }

  /** Leaves the next `count` reads unanswered, as Decaid leaves one whose read from its store fails. */
  failNextReads(count: number): void {
    this.failingReads = count;
  }

  /** Decaid starts, as each load of the plugin stands for: its store API has opened nothing yet. */
  decaidStarted(): void {
    this.openedThroughApi = false;
  }

  /**
   * What Decaid's store API answers for this storage (KvStoreHandler in
   * kv_store_handler.dart): its keys, or a key's value, null if never
   * written. Answering opens the storage there, so backups include it.
   */
  readThroughApi(key: string | undefined): unknown {
    this.openedThroughApi = true;
    return key === undefined ? [...this.values.keys()] : this.read(key);
  }

  /**
   * Carries out a command the plugin sent, as Decaid receives it, by way of
   * JSON. Returns the event that answers it, or null for a command Decaid
   * drops: one it cannot read, a write of null, or a read made to fail.
   */
  carryOut(command: unknown): { name: "storageRead" | "storageWrite"; payload: unknown } | null {
    const { type, key, data } = (JSON.parse(JSON.stringify(command ?? null)) ?? {}) as { type?: unknown; key?: unknown; data?: unknown };
    if (typeof key !== "string") return null;
    if (type === "read") {
      if (this.failingReads > 0) {
        this.failingReads--;
        return null;
      }
      return { name: "storageRead", payload: { key, value: this.read(key) } };
    }
    if (type === "write" && data !== undefined && data !== null) {
      this.write(key, data);
      return { name: "storageWrite", payload: data };
    }
    return null;
  }
}

export interface SimulatedTabletOptions {
  /** Plugin settings as Decaid passes them: only the ones that are set. */
  settings: Record<string, unknown>;
  /**
   * The tablet's plugin storage, kept across loads: pass the one an earlier
   * load used to load the plugin on the same tablet again. Defaults to an
   * empty one, as on a new tablet.
   */
  storage?: PluginStorage;
  /** Decaid's API responses; defaults to de1ProOnDecaid087(). */
  api?: DecaidApi;
  /** Whether a machine is connected to the tablet; while not, /machine/info fails. Defaults to true. */
  machineConnected?: boolean;
  /**
   * Runs the plugin's timers, and the delays below, this many times faster,
   * except while a connection opens and waits for the server's first answer.
   * Defaults to 1.
   */
  timeScale?: number;
  /** How long Decaid's API takes to answer each request; from 30 s on, the request times out. Defaults to 0. */
  apiDelayMs?: number;
  /**
   * How fast the tablet's network takes queued frames, in bytes per second
   * of real time, whatever `timeScale` is. Unlimited by default.
   */
  uploadBytesPerSecond?: number;
  /**
   * Times WebSocket upgrades at the sped-up pace, as the rest of the tablet's
   * clock runs, so an upgrade the server never answers times out quickly. A
   * server slow to answer one then has only the connect deadline divided by
   * `timeScale`, 150 ms at 100x, so only tests of servers that never answer
   * an upgrade use it. By default the clock runs at real time while a
   * connection opens.
   */
  upgradeAtTabletPace?: boolean;
  /**
   * Stalls the network at the first queued frame, parsed, that this matches:
   * that frame and the ones behind it stay pending, unwritten, for as long as
   * it matches. Nothing stalls by default.
   */
  stallUpload?: (frame: unknown) => boolean;
}

type TransportEvent = Record<string, unknown> & { type: string };

interface TransportRecord {
  handle: string;
  socket: WebSocket;
  listener?: (event: TransportEvent) => void;
  inbound: { event: TransportEvent; size: number }[];
  inboundBytes: number;
  /** Frames sent and not yet written, in order, with each one parsed. */
  outbound: { data: string; size: number; message: unknown }[];
  /** Their size, as Decaid counts it against its limit. */
  pendingOutboundBytes: number;
  /** Whether a frame is being written now. */
  writing: boolean;
  /** Closed, by either end or a failure; no further sends. */
  terminal: boolean;
  /** Open, with nothing yet from the server, and not closing; the tablet's clock runs at real time meanwhile. */
  awaitingServer: boolean;
  closing: boolean;
  draining: boolean;
}

interface Timer {
  /** When it fires, on the tablet's clock. */
  due: number;
  callback: () => void;
  timeout?: NodeJS.Timeout;
}

class TransportError extends Error {
  constructor(
    message: string,
    readonly code = "transport_error",
  ) {
    super(message);
  }
}

export class SimulatedTablet {
  readonly logs: string[] = [];
  /** Decaid's storage for the plugin, which outlasts this load. */
  readonly storage: PluginStorage;
  /** The Decaid API routes the plugin requested, in order, such as "/machine/info". */
  readonly requests: string[] = [];
  /** Requests that could change the tablet's data (any method but GET), such as "POST /store/dye2.reaplugin/recipes". */
  readonly writes: string[] = [];
  readonly plugin: BuiltPlugin;
  machineConnected: boolean;
  private api: DecaidApi;
  private readonly apiFailures = new Map<string, number>();
  readonly shotPageRequests: { limit: number; offset: number }[] = [];
  /**
   * Called as each `GET /shots` page is requested, before it is answered:
   * a change to the Shots, through `serve`, shows in that page.
   */
  beforeShotPage?: (request: { limit: number; offset: number }) => void;
  /** Every frame the plugin sent, parsed, in order. */
  readonly sent: unknown[] = [];
  /** Every text frame the server sent the plugin, parsed, in order. */
  readonly received: unknown[] = [];
  /** The most bytes any transport has had pending at once. */
  peakPendingOutboundBytes = 0;
  /** Sends refused for going past the pending outbound limit. */
  refusedSends = 0;
  /** The plugin's id, which names its storage in Decaid's store API. */
  private readonly pluginId: string;
  private readonly timeScale: number;
  private readonly apiDelayMs: number;
  private readonly uploadBytesPerSecond: number | undefined;
  private readonly stallUpload: ((frame: unknown) => boolean) | undefined;
  private readonly upgradeAtTabletPace: boolean;
  /** Opens not yet connected; Decaid counts them against the transport limit, and the clock runs at real time meanwhile. */
  private opening = 0;
  private readonly transports = new Map<string, TransportRecord>();
  /** Transports awaiting the server's first answer. */
  private awaitingServer = 0;
  /** The tablet's clock in ms, as of `clockReadAt` in real time (performance.now()). */
  private clockMs = 0;
  private clockReadAt = performance.now();
  private readonly timers = new Map<number, Timer>();
  private nextTimerId = 0;
  private nextHandle = 0;
  private unloaded = false;
  /** Whether the server cannot be reached: every open fails. */
  private networkLost = false;

  /** Loads the built plugin and calls onLoad, as Decaid does when the plugin is enabled. */
  static load(options: SimulatedTabletOptions): SimulatedTablet {
    return new SimulatedTablet(options);
  }

  private constructor(options: SimulatedTabletOptions) {
    this.api = options.api ?? de1ProOnDecaid087();
    this.machineConnected = options.machineConnected ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.apiDelayMs = options.apiDelayMs ?? 0;
    this.uploadBytesPerSecond = options.uploadBytesPerSecond;
    this.stallUpload = options.stallUpload;
    this.upgradeAtTabletPace = options.upgradeAtTabletPace ?? false;
    this.storage = options.storage ?? new PluginStorage();
    this.storage.decaidStarted();
    rememberSecret(options.settings.Token);
    watchLog("a simulated tablet's log", () => this.logs.join("\n"));
    const { source, manifest } = readBuiltPlugin();
    this.pluginId = String(manifest.id);
    const permissions = manifest.permissions as string[];
    this.plugin = loadPlugin(source, String(manifest.id), {
      host: {
        log: (message: unknown) => this.logs.push(String(message)),
        transport: {
          open: (options: unknown) => this.open(options),
          onEvent: (handle: string, listener: (event: TransportEvent) => void) => this.onEvent(handle, listener),
          send: (handle: string, payload: unknown) => this.send(handle, payload),
          close: (handle: string) => this.close(handle),
        },
        storage: permissions.includes("pluginStorage")
          ? (command: unknown) => this.storageCommand(command)
          : () => {
              throw new Error(`Plugin ${String(manifest.id)} requires manifest permission pluginStorage`);
            },
      },
      fetch: (input: unknown, init?: unknown) => this.fetch(input, init),
      setTimeout: (callback: () => void, delay: number) => this.setTimer(callback, delay),
      clearTimeout: (id: number) => this.clearTimer(id),
    });
    this.plugin.onLoad(options.settings);
    // PluginManager sends the current Workflow once the plugin has loaded.
    if (this.api["/workflow"] !== undefined) this.fire("workflowUpdated", this.api["/workflow"]);
  }

  /** Answers Decaid's API with these responses from now on, as when another machine is connected. */
  serve(api: DecaidApi): void {
    this.api = api;
  }

  /**
   * Connects the machine to the tablet: /machine/info answers from now on,
   * and Decaid starts sending machine state updates, of which this delivers
   * one, with the state /machine/state answers.
   */
  connectMachine(): void {
    this.machineConnected = true;
    this.fire("stateUpdate", this.api["/machine/state"]);
  }

  /**
   * Changes the tablet's Workflow, as a barista or a skin does: /workflow
   * answers with it from now on, and the plugin is sent it in a
   * `workflowUpdated` event.
   */
  setWorkflow(workflow: Record<string, unknown>): void {
    this.api = { ...this.api, "/workflow": workflow };
    this.fire("workflowUpdated", workflow);
  }

  /**
   * The connected machine reports a state, as Decaid does several times a
   * second while one is connected: /machine/state answers with it from now
   * on, and the plugin is sent it in a `stateUpdate` event.
   */
  reportState(state: string, substate: string): void {
    if (!this.machineConnected) throw new Error("Decaid sends machine state updates only while a machine is connected");
    const snapshot = machineSnapshot(state, substate);
    this.api = { ...this.api, "/machine/state": snapshot };
    this.fire("stateUpdate", snapshot);
  }

  /** Fails this many upcoming reads of a local API route, as a transient Decaid failure does. */
  failNextApiReads(path: string, count: number): void { this.apiFailures.set(path, count); }

  /** Delivers a Decaid event to the plugin. */
  fire(name: string, payload?: unknown): void {
    if (!this.unloaded) this.plugin.onEvent({ name, payload });
  }

  /**
   * A command to the plugin's storage: carried out at once, so a write made
   * as the plugin unloads still lands, as Decaid finishes them, and answered
   * in a later turn, while the plugin is still loaded.
   */
  private storageCommand(command: unknown): void {
    const answer = this.storage.carryOut(command);
    if (answer) setImmediate(() => this.fire(answer.name, answer.payload));
  }

  /** Loses the network: every connection ends without a close handshake, as if the Wi-Fi dropped. */
  dropConnections(): void {
    for (const record of this.transports.values()) record.socket.terminate();
  }

  /**
   * Loses the network until `restoreNetwork`: every connection ends as in
   * `dropConnections`, and every connection opened meanwhile fails, as
   * while the Wi-Fi is down or the server cannot be reached. Decaid's own
   * API still answers.
   */
  loseNetwork(): void {
    this.networkLost = true;
    this.dropConnections();
  }

  /** Brings back the network `loseNetwork` lost: connections open again. */
  restoreNetwork(): void {
    this.networkLost = false;
  }

  /** Unloads the plugin, as disabling it, changing its settings or quitting Decaid does. */
  async unload(): Promise<void> {
    if (this.unloaded) return;
    try {
      this.plugin.onUnload();
    } finally {
      this.unloaded = true;
      for (const timer of this.timers.values()) clearTimeout(timer.timeout);
      this.timers.clear();
      const closing = [...this.transports.values()].map((record) => this.closeNative(record));
      await Promise.all(closing);
      this.transports.clear();
    }
  }

  /** Resolves with the first log line, past or future, that matches. */
  async waitForLog(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
    return (await this.waitForLogs(pattern, 1, timeoutMs))[0]!;
  }

  /** Resolves once at least `count` log lines, past or future, match. */
  async waitForLogs(pattern: RegExp, count: number, timeoutMs = 10_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const lines = this.logs.filter((log) => pattern.test(log));
      if (lines.length >= count) return lines;
      if (Date.now() > deadline) {
        throw new Error(`${lines.length} of ${count} logs matched ${pattern} within ${timeoutMs} ms. Logs:\n${this.logs.join("\n")}`);
      }
      await delay(20);
    }
  }

  // Decaid's plugin fetch, limited to its own API.
  private async fetch(input: unknown, init: unknown): Promise<unknown> {
    await new Promise<void>((resolve) => this.setTimer(resolve, Math.min(this.apiDelayMs, FETCH_TIMEOUT_MS)));
    if (this.apiDelayMs >= FETCH_TIMEOUT_MS) throw new Error("Fetch timed out");
    const url = String(input);
    if (!url.startsWith(`${API_ORIGIN}/api/v1/`)) throw new Error(`The simulated tablet has no network for ${url}`);
    const route = url.slice(`${API_ORIGIN}/api/v1`.length).split("?")[0]!;
    this.requests.push(route);
    // Decaid's fetch sends a request's headers, with any case, as given (plugin_manager.dart).
    const { method = "GET", headers = {} } = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    if (method.toUpperCase() !== "GET") {
      this.writes.push(`${method.toUpperCase()} ${route}`);
      throw new Error("The simulated tablet's API is read only");
    }
    const failures = this.apiFailures.get(route) ?? 0;
    if (failures > 0) {
      this.apiFailures.set(route, failures - 1);
      return response(503, JSON.stringify({ error: "Local API temporarily unavailable" }));
    }
    if (["/machine/info", "/machine/settings", "/machine/settings/advanced"].includes(route) && !this.machineConnected) {
      // de1handler.dart answers a DeviceNotConnectedException with a 500.
      const refusal = machineNotConnected();
      return response(refusal.status, JSON.stringify(refusal.body));
    }
    const list = LIBRARY_LISTS[route];
    if (list && Array.isArray(this.api[route])) {
      const all = this.api[route] as Record<string, unknown>[];
      const body = JSON.stringify(new URL(url).searchParams.get(list.include) === "true" ? all : all.filter((record) => !list.hidden(record)));
      // A strong tag derived from the body, as Decaid's is.
      const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
      const ifNoneMatch = Object.entries(headers).find(([name]) => name.toLowerCase() === "if-none-match")?.[1]?.trim();
      return ifNoneMatch === etag || ifNoneMatch === "*" ? response(304, "", { etag }) : response(200, body, { etag });
    }
    if (route === "/shots") {
      const params = new URL(url).searchParams;
      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      this.shotPageRequests.push({ limit, offset });
      this.beforeShotPage?.({ limit, offset });
      const records = Object.entries(this.api).filter(([path]) => path.startsWith("/shots/")).map(([, shot]) => shot as Record<string, unknown>);
      records.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(a.id).localeCompare(String(b.id)));
      const items = records.slice(offset, offset + Math.min(100, Math.max(1, limit))).map(({ measurements, ...summary }) => summary);
      return response(200, JSON.stringify({ items, total: records.length, limit, offset }));
    }
    if (route === "/steams/ids") {
      // Every id at once, unpaginated, in the order of Decaid's primary key index.
      const ids = Object.keys(this.api).filter((path) => path.startsWith("/steams/")).map((path) => decodeURIComponent(path.slice("/steams/".length)));
      return response(200, JSON.stringify(ids.sort()));
    }
    // The plugin's own storage, as Decaid's store API reads it.
    const [, store, namespace, key, ...rest] = route.split("/");
    if (store === "store" && namespace === encodeURIComponent(this.pluginId) && rest.length === 0) {
      return response(200, JSON.stringify(this.storage.readThroughApi(key === undefined ? undefined : decodeURIComponent(key))));
    }
    const answer = this.api[route];
    if (answer instanceof Refusal) return response(answer.status, JSON.stringify(answer.body));
    // A key of plugin storage nothing has written (KvStoreHandler in kv_store_handler.dart).
    if (!(route in this.api) && route.startsWith("/store/") && route.split("/").length === 4) return response(200, "null");
    if (!(route in this.api)) return response(404, "");
    return response(200, JSON.stringify(answer));
  }

  private setTimer(callback: () => void, delayMs: number): number {
    const id = ++this.nextTimerId;
    this.arm(id, { due: this.now() + Math.max(0, Math.trunc(Number(delayMs) || 0)), callback });
    return id;
  }

  private clearTimer(id: number): void {
    clearTimeout(this.timers.get(id)?.timeout);
    this.timers.delete(id);
  }

  /** (Re)schedules a timer for its due time at the clock's current rate; call `now()` first. */
  private arm(id: number, timer: Timer): void {
    clearTimeout(timer.timeout);
    timer.timeout = setTimeout(
      () => {
        this.timers.delete(id);
        if (!this.unloaded) timer.callback();
      },
      Math.max(0, timer.due - this.clockMs) / this.rate(),
    );
    this.timers.set(id, timer);
  }

  /** Reads the tablet's clock. */
  private now(): number {
    const realNow = performance.now();
    this.clockMs += (realNow - this.clockReadAt) * this.rate();
    this.clockReadAt = realNow;
    return this.clockMs;
  }

  /** How many times faster than real time the tablet's clock runs. */
  private rate(): number {
    return this.awaitingServer > 0 || (this.opening > 0 && !this.upgradeAtTabletPace) ? 1 : this.timeScale;
  }

  /** Makes a change that may change the clock's rate, rescheduling every timer if it does. */
  private retimed(change: () => void): void {
    const before = this.rate();
    this.now();
    change();
    if (this.rate() !== before) for (const [id, timer] of this.timers) this.arm(id, timer);
  }

  /** Marks whether a transport awaits the server's first answer. */
  private setAwaitingServer(record: TransportRecord, awaiting: boolean): void {
    if (record.awaitingServer === awaiting) return;
    this.retimed(() => {
      record.awaitingServer = awaiting;
      this.awaitingServer += awaiting ? 1 : -1;
    });
  }

  private async open(options: unknown): Promise<{ handle: string; protocol?: string }> {
    const { kind, url, protocols } = (options ?? {}) as { kind?: unknown; url?: unknown; protocols?: unknown };
    if (kind !== "websocket") throw new TransportError(`The plugin may open only WebSocket transports, not ${String(kind)}`);
    if (typeof url !== "string" || !(url.startsWith("ws://") || url.startsWith("wss://"))) {
      throw new TransportError("WebSocket transport requires a ws:// or wss:// url");
    }
    if (protocols !== undefined && (!Array.isArray(protocols) || protocols.some((p) => typeof p !== "string"))) {
      throw new TransportError("WebSocket protocols must be an array of strings");
    }
    const live = [...this.transports.values()].filter((record) => !record.terminal || record.inbound.length > 0);
    if (live.length + this.opening >= MAX_LIVE_TRANSPORTS) {
      throw new TransportError("Too many open transports for this plugin", "transport_resource_limit");
    }
    if (this.networkLost) throw new TransportError("WebSocket connect failed: Network is unreachable");

    // Only the URL and subprotocols: Decaid cannot send custom headers.
    const socket = new WebSocket(url, protocols as string[] | undefined);
    this.retimed(() => this.opening++);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", (error) => reject(new TransportError(`WebSocket connect failed: ${error.message}`)));
      });
    } finally {
      this.retimed(() => this.opening--);
    }
    socket.removeAllListeners("error");
    if (this.unloaded) {
      socket.terminate();
      throw new TransportError("Plugin unloaded during connect");
    }
    if (this.networkLost) {
      socket.terminate();
      throw new TransportError("WebSocket connect failed: Network is unreachable");
    }

    const record: TransportRecord = {
      handle: `simulated-${++this.nextHandle}`,
      socket,
      inbound: [],
      inboundBytes: 0,
      outbound: [],
      pendingOutboundBytes: 0,
      writing: false,
      terminal: false,
      awaitingServer: false,
      closing: false,
      draining: false,
    };
    this.transports.set(record.handle, record);
    this.setAwaitingServer(record, true);
    let failure: string | undefined;
    socket.on("message", (data, isBinary) => {
      this.setAwaitingServer(record, false);
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!isBinary) this.received.push(parsed(buffer.toString("utf8")));
      const event = isBinary
        ? { type: "data", dataType: "binary", data: buffer.toString("base64") }
        : { type: "data", dataType: "text", data: this.atServerPace(buffer.toString("utf8")) };
      this.enqueue(record, event, buffer.length);
    });
    socket.on("error", (error) => {
      failure = `WebSocket error: ${error.message}`;
    });
    socket.on("close", (code, reason) => this.terminate(record, failure, "transport_error", code, reason.toString()));
    return { handle: record.handle, ...(socket.protocol ? { protocol: socket.protocol } : {}) };
  }

  /** Scales the heartbeat interval in a `welcome` up by `timeScale`, which the plugin's timers then scale back down. */
  private atServerPace(text: string): string {
    if (this.timeScale === 1) return text;
    try {
      const message = JSON.parse(text) as { type?: unknown; heartbeatIntervalMs?: unknown };
      if (message.type !== "welcome" || typeof message.heartbeatIntervalMs !== "number") return text;
      return JSON.stringify({ ...message, heartbeatIntervalMs: Math.round(message.heartbeatIntervalMs * this.timeScale) });
    } catch {
      return text;
    }
  }

  private onEvent(handle: string, listener: (event: TransportEvent) => void): void {
    const record = this.record(handle);
    record.listener = listener;
    this.drain(record);
  }

  private async send(handle: string, payload: unknown): Promise<void> {
    const record = this.record(handle);
    if (record.terminal || record.closing) throw new TransportError("Transport already closed");
    const { type, data } = (payload ?? {}) as { type?: unknown; data?: unknown };
    if (type !== "text" || typeof data !== "string") {
      throw new TransportError('The simulated tablet supports only { type: "text", data: string } sends');
    }
    const size = Buffer.byteLength(data);
    if (size > MAX_PENDING_OUTBOUND_BYTES || record.pendingOutboundBytes + size > MAX_PENDING_OUTBOUND_BYTES) {
      this.refusedSends++;
      throw new TransportError("Outbound data limit exceeded; send rejected", "transport_resource_limit");
    }
    record.pendingOutboundBytes += size;
    this.peakPendingOutboundBytes = Math.max(this.peakPendingOutboundBytes, record.pendingOutboundBytes);
    const message: unknown = JSON.parse(data);
    this.sent.push(message);
    record.outbound.push({ data, size, message });
    void this.write(record);
  }

  /**
   * Writes a transport's queued frames in order, one at a time, at the upload
   * speed, as Decaid's outbound drain does. A frame stays pending until the
   * socket has taken it.
   */
  private async write(record: TransportRecord): Promise<void> {
    if (record.writing) return;
    record.writing = true;
    try {
      while (!record.terminal && record.outbound.length > 0) {
        const frame = record.outbound[0]!;
        // A stalled network takes nothing; the next send tries again.
        if (this.stallUpload?.(frame.message)) return;
        if (this.uploadBytesPerSecond !== undefined) await delay((frame.size / this.uploadBytesPerSecond) * 1000);
        if (record.terminal) return;
        // Settles once the socket has taken the frame, or failed to; a failure ends the transport anyway.
        await new Promise<void>((resolve) => record.socket.send(frame.data, () => resolve())).catch(() => {});
        record.outbound.shift();
        record.pendingOutboundBytes -= frame.size;
      }
    } finally {
      record.writing = false;
    }
  }

  private async close(handle: string): Promise<void> {
    const record = this.record(handle);
    if (record.terminal || record.closing) throw new TransportError("Transport already closed");
    await this.closeNative(record);
    this.transports.delete(handle);
  }

  private async closeNative(record: TransportRecord): Promise<void> {
    record.closing = true;
    this.setAwaitingServer(record, false);
    // Decaid writes what is queued before it closes, for up to 5 s.
    const deadline = Date.now() + 5_000;
    while (record.outbound.length > 0 && !record.terminal && Date.now() < deadline) await delay(10);
    if (record.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => record.socket.once("close", () => resolve()));
    record.socket.close(1000);
    const forced = setTimeout(() => record.socket.terminate(), 5_000);
    return closed.finally(() => clearTimeout(forced));
  }

  private record(handle: string): TransportRecord {
    const record = this.transports.get(handle);
    if (!record) throw new TransportError("Unknown transport handle");
    return record;
  }

  private enqueue(record: TransportRecord, event: TransportEvent, size: number): void {
    if (record.terminal) return;
    if (record.inboundBytes + size > MAX_QUEUED_INBOUND_BYTES) {
      this.terminate(record, "Inbound data limit exceeded; transport closed", "transport_resource_limit");
      record.socket.terminate();
      return;
    }
    record.inbound.push({ event, size });
    record.inboundBytes += size;
    this.drain(record);
  }

  private terminate(record: TransportRecord, error: string | undefined, code: string, closeCode?: number, reason?: string): void {
    if (record.terminal) return;
    record.terminal = true;
    this.setAwaitingServer(record, false);
    if (error !== undefined) record.inbound.push({ event: { type: "error", code, message: error }, size: 0 });
    // Decaid omits the code when the connection ended without a close frame.
    const close: TransportEvent = { type: "close" };
    if (closeCode !== undefined && closeCode !== 1006) close.code = closeCode;
    if (reason) close.reason = reason;
    record.inbound.push({ event: close, size: 0 });
    this.drain(record);
  }

  /** Delivers queued events in order, each in its own turn of the event loop, as Decaid's bridge does. */
  private drain(record: TransportRecord): void {
    if (!record.listener || record.draining) return;
    record.draining = true;
    setImmediate(() => {
      record.draining = false;
      const next = record.inbound.shift();
      // A closed transport stops counting against the limit once its events are delivered.
      if (record.terminal && record.inbound.length === 0) this.transports.delete(record.handle);
      if (!next) return;
      record.inboundBytes -= next.size;
      if (this.unloaded) return;
      try {
        record.listener?.(next.event);
      } catch (error) {
        this.logs.push(`Transport listener error: ${String(error)}`);
      }
      this.drain(record);
    });
  }
}

interface PluginScope {
  host: Record<string, unknown>;
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
}

/** Evaluates plugin.js the way Decaid's plugin manager does. */
export function loadPlugin(source: string, manifestId: string, scope: PluginScope): BuiltPlugin {
  const factory = new Function(
    "host",
    "fetch",
    "setTimeout",
    "clearTimeout",
    `${source}
    if (typeof createPlugin !== "function") {
      throw new Error("Plugin must export a 'createPlugin' function. Got: " + typeof createPlugin);
    }
    return createPlugin(host);`,
  ) as (...args: unknown[]) => BuiltPlugin;
  const plugin = factory(scope.host, scope.fetch, scope.setTimeout, scope.clearTimeout);
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`createPlugin did not return an object, got: ${typeof plugin}`);
  }
  if (plugin.id !== manifestId) {
    throw new Error(`Plugin ID mismatch. Expected: ${manifestId}, Got: ${plugin.id}`);
  }
  return plugin;
}

/**
 * Raw-frame mode: a WebSocket to a server's sync endpoint that sends whatever
 * a test gives it, with no headers, as Decaid would.
 */
export class RawConnection {
  /** Every message received, parsed as JSON where possible. */
  readonly messages: unknown[] = [];
  /** Resolves when the connection ends, with the close code the server sent. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
        this.wake();
      });
    });
    socket.on("message", (data) => {
      this.messages.push(parsed((Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)).toString("utf8")));
      this.wake();
    });
  }

  /** Connects to the sync endpoint of a server's public http(s):// URL. */
  static async open(serverUrl: string): Promise<RawConnection> {
    const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}${SYNC_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new RawConnection(socket);
  }

  /**
   * Connects, sends the `hello` and resolves once the server welcomes it,
   * then keeps the connection alive with heartbeats every `heartbeatMs`.
   */
  static async welcomed(serverUrl: string, hello: Record<string, unknown>, heartbeatMs = 300): Promise<RawConnection> {
    const raw = await RawConnection.open(serverUrl);
    try {
      raw.send(hello);
      const answer = await raw.message(0);
      if ((answer as { type?: unknown }).type !== "welcome") throw new Error(`The server did not welcome the hello: ${JSON.stringify(answer)}`);
    } catch (error) {
      // The caller never gets the connection to close.
      await raw.terminate();
      throw error;
    }
    raw.keepAlive(heartbeatMs);
    return raw;
  }

  /** Sends a heartbeat every `intervalMs` until the connection ends, as the plugin does once welcomed. */
  keepAlive(intervalMs = 300): void {
    const heartbeats = setInterval(() => this.send({ type: "heartbeat" }), intervalMs);
    void this.closed.then(() => clearInterval(heartbeats));
  }

  /** Sends a string as is, or anything else as JSON, in a text frame. */
  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes, { binary: true });
  }

  /** Resolves with the message at `index` once it has arrived. */
  async message(index: number, timeoutMs = 10_000): Promise<unknown> {
    await this.until(() => this.messages.length > index, timeoutMs, `message ${index}`);
    return this.messages[index];
  }

  /** How many times the server has acknowledged the delivery with this id. */
  acks(id: string): number {
    return this.messages.filter((message) => {
      const { type, id: acked } = (message ?? {}) as { type?: unknown; id?: unknown };
      return type === "ack" && acked === id;
    }).length;
  }

  /** Resolves once the server has acknowledged the delivery with this id. */
  async acknowledged(id: string, timeoutMs = 10_000): Promise<void> {
    await this.until(() => this.acks(id) > 0, timeoutMs, `acknowledgment of ${id}`);
  }

  /** Sends a delivery and resolves once the server acknowledges it, again if it had before. */
  async deliver(message: { id: string; [field: string]: unknown }, timeoutMs = 10_000): Promise<void> {
    const before = this.acks(message.id);
    this.send(message);
    await this.until(() => this.acks(message.id) > before, timeoutMs, `acknowledgment of ${message.id}`);
  }

  close(): Promise<{ code: number; reason: string }> {
    this.socket.close(1000);
    return this.closed;
  }

  /** Ends the connection without a close frame, as a lost network does. */
  terminate(): Promise<{ code: number; reason: string }> {
    this.socket.terminate();
    return this.closed;
  }

  /** Resolves once `done` holds, checked as each message arrives; fails if the connection closes first. */
  private async until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`The connection closed after ${this.messages.length} messages, before ${what}`);
      if (Date.now() > deadline) throw new Error(`No ${what} within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    text: async () => body,
    json: async () => JSON.parse(body || "null"),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A frame's text parsed as JSON, or the text itself if it is not JSON. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
