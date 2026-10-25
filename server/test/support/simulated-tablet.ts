import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, SETTINGS_EDIT_WRITE_MARGIN_MS, SYNC_PATH } from "@decent-sync/protocol";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { assertBuilt } from "./builds.js";
import { batchesOf, createBatch, deleteBatch, deleteBean, listedBatches, updateBatch } from "./decaid-batches.js";
import { type DecaidAnswer, createBean, listedBeans, updateBean, withDecaidClock } from "./decaid-beans.js";
import { createGrinder, deleteGrinder, listedGrinders, updateGrinder } from "./decaid-grinders.js";
import { createProfile, deleteProfile, getProfile, listProfiles, purgeProfile, setProfileVisibility, updateProfile } from "./decaid-profiles.js";
import { type FieldWriteFailure, type SettingsAnswer, type Written, machineSettingsHeld, presenceSettings, reconnected, writeAdvancedSettings, writeAppSettings, writeCalibration, writeMachineSettings, writePresence, writeSensorCalibration } from "./decaid-settings.js";
import { machineSettingsWritten, updateWorkflow } from "./decaid-workflow.js";
import type { SimulatedDye2 } from "./simulated-dye2.js";
import { rememberSecret, watchLog } from "./secrets.js";
import { opened } from "./test-scope.js";

// Seam 1's simulated tablet: runs the built decent-sync.reaplugin/plugin.js
// (`npm run build` first) in a stand-in for Decaid's plugin host, the way
// Decaid v0.9.0 does (decaid:lib/src/plugins/plugin_manager.dart and
// plugin_transport_service.dart):
//
// - The source is pasted into a function body with `host`, `fetch`,
//   `setTimeout` and `clearTimeout` in scope; the global createPlugin(host)
//   must return an object whose id matches the manifest, and onLoad is called
//   synchronously without awaiting it. Then the plugin is sent the current
//   Workflow in a `workflowUpdated` event, as Decaid sends it after every load.
// - `fetch` answers Decaid's local API from fixtures, failing after Decaid's
//   30 s timeout. `GET /shots` pages the Shots served at `/shots/{id}`,
//   `GET /steams/ids` lists the Steam Records served at `/steams/{id}`,
//   failing as Decaid's 10 MiB response limit fails it once the list passes
//   `steamIdsLimitBytes`, and `GET /steams/latest` answers the newest of them
//   without measurements, or `null`; `holdSteamReads` holds either,
//   `holdWorkflowReads` reads of the Workflow, `holdShotReads` reads
//   of each Shot, and `holdRequests` any request to a route. The
//   library's lists leave out archived and hidden records unless asked for
//   them, the bean batches leaving out those of archived beans too, and send
//   an ETag, answering 304 to it in If-None-Match. A key of
//   plugin storage never written answers `null`. The machine's settings, like
//   its info and state, fail while no machine is connected.
// - Decaid's store API (KvStoreHandler in kv_store_handler.dart) keeps the
//   values other plugins and skins keep there, such as DYE2's recipes,
//   baskets and tools under `dye2.reaplugin` and Streamline's under
//   `streamline-app`: `POST /store/{namespace}/{key}` replaces the key's
//   value with the JSON body, `DELETE` removes it, and `GET` answers it, or
//   `null` for a key never set or deleted. A value starts as `api` serves it,
//   and `storeWrites` records the plugin's writes. `startStreamline`
//   (simulated-streamline.ts) runs Streamline as the tablet's skin, which
//   keeps values there and adopts a Workflow change made elsewhere, as
//   streamline-js does, and simulated-dye2.ts replays what DYE2 and
//   Streamline were recorded writing there and to the Workflow.
// - Of Decaid's writes, it carries out only those to beans (`POST /beans`,
//   `PUT /beans/{id}` and `DELETE /beans/{id}`), their batches (`POST
//   /beans/{beanId}/batches`, `PUT` and `DELETE /bean-batches/{id}`),
//   grinders (`POST /grinders`, `PUT` and `DELETE /grinders/{id}`),
//   profiles (`POST /profiles`, `PUT` and `DELETE /profiles/{id}`, `PUT
//   /profiles/{id}/visibility` and `DELETE /profiles/{id}/purge`), the
//   Workflow (`PUT /workflow`), the store (above), and the settings: the
//   machine's (`POST /machine/settings`, `/machine/settings/advanced` and
//   `/machine/calibration`, and `PUT /machine/calibration/{target}`),
//   Decaid's own (`POST /settings`) and its presence settings and wake
//   schedules (`POST /presence/settings` and `/presence/schedules`, `PUT`
//   and `DELETE /presence/schedules/{id}`), as Decaid does
//   (decaid-beans.ts, decaid-batches.ts, decaid-grinders.ts,
//   decaid-profiles.ts, decaid-workflow.ts, decaid-settings.ts), and serves each bean at
//   `/beans/{id}`, its batches at `/beans/{id}/batches`, each batch at
//   `/bean-batches/{id}`, each grinder at `/grinders/{id}`, and each
//   profile at `/profiles/{id}`, whose id it derives from the profile's
//   content as Decaid does; it refuses every other request but a `GET`.
// - The plugin's local time, as JavaScript reads it, is this process's time
//   zone: set `process.env.TZ` to put the tablet in another one. Its clock is
//   the test's, unless `setPluginClockOffset` corrects it.
// - `host.transport` opens real WebSockets with only a URL and subprotocols
//   (no custom headers), allows 8 live transports per plugin generation
//   (counting opens still in progress, which cannot be cancelled),
//   rejects a send that would take the pending outbound bytes past 1 MiB,
//   closes a transport whose undelivered inbound bytes pass 1 MiB, and
//   delivers events asynchronously and in order, ending with a close event.
//   `dropConnectionsUnnoticed` ends them for the plugin while leaving them
//   open, and silent, for the server, and `cutConnectionAfter` ends one right
//   after a frame the server sent.
//   A send resolves once its frame is queued. Frames are written in order,
//   one at a time, and stay pending until written; `uploadBytesPerSecond`
//   slows the writing, so pending bytes build up as on a slow network, and
//   `stallUpload` stops it at a chosen frame, until the next send, or
//   `resumeUpload` once it lets the frame pass. Closing a transport first
//   waits for its queued frames to be written. `loseNetwork` ends every
//   connection and fails every open until `restoreNetwork`, while Decaid's
//   own API keeps answering. An open to Decaid's own origin
//   (`ws://localhost:8080/ws/v1/plugins/{id}/{endpoint}`) is not on the
//   network, and counts against the 8 all the same: it is refused with 404,
//   as `_handlePluginSocketEndpoint` in plugins_handler.dart refuses it,
//   while that plugin is not loaded or declares no such endpoint, and once
//   open hears each push of that plugin on that endpoint, as `data` events,
//   whichever load of it makes it, until the tablet unloads. Only DYE2's are
//   simulated.
// - `dye2` runs DYE2 v0.1.26 beside the plugin (`SimulatedDye2` in
//   simulated-dye2.ts), as Decaid runs another plugin: `GET /plugins` lists
//   the plugin and DYE2, `/plugins/dye2.reaplugin/{endpoint}` is DYE2's
//   (404 while it is not loaded), and DYE2 loads as the tablet starts, is
//   told of each change of the Workflow and each Shot stored, and keeps its
//   storage, its mirrored selection and migration flags among it, under its
//   keys in Decaid's store. Without it `GET /plugins` lists the plugin
//   alone, and DYE2's endpoints answer 404, as Decaid's do for a plugin not
//   loaded.
// - `host.storage` is Decaid's plugin storage, given only to a plugin whose
//   manifest declares `pluginStorage`: it answers a read with a `storageRead`
//   event of `{ key, value }`, `value` null for a key never written, and a
//   write with a `storageWrite` event of the data written, each in a later
//   turn, and never answers a command that fails; `holdStorageAnswers` holds
//   the answers. Its values belong to a `PluginStorage`, which outlives the
//   load: give the next load of the same tablet the same one. Decaid's store API (`/store/{plugin id}`) reads the
//   same values.
// - `host.emit`, given only to a plugin whose manifest declares `emit`,
//   sends its payload, through JSON, to the sockets open on the plugin's
//   WebSocket endpoint of that name, keeping nothing for one opened later:
//   `emits` lists what it sent, `onEmit` is called with each as it is sent,
//   and `pushes` lists what a skin listening on an endpoint the manifest
//   declares heard (`_handlePluginSocketEndpoint` in plugins_handler.dart);
//   `failEmits` makes it throw. `callEndpoint` calls one of the plugin's
//   HTTP endpoints as a skin does through
//   `/api/v1/plugins/{id}/{endpoint}`, answered only for an `http` endpoint
//   the manifest declares, with `api` (`_handlePluginApiEndpoint`). The
//   manifest's `api` entries must each be shaped as Decaid's
//   `ApiEndpoint.fromJson` reads them, or the plugin does not load.
// - Unloading calls onUnload, then cancels the generation's timers and closes
//   its transports, dropping their later events.
// - Timers are the host's, so a test can run them faster with `timeScale` to
//   reach the plugin's timeouts and backoff quickly. The server keeps real
//   time, though. The heartbeat interval in its `welcome`, and the time a
//   `settingsEdit` has left, are slowed by the same factor, so a sped-up
//   plugin still heartbeats, expects the server's answers and counts down an
//   edit's time at the server's pace. And from the moment a connection
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
/** The largest response Decaid's plugin fetch answers (maxFetchResponseBytes in plugin_manager.dart). */
const MAX_FETCH_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_LIVE_TRANSPORTS = 8;
const MAX_PENDING_OUTBOUND_BYTES = 1 << 20;
const MAX_QUEUED_INBOUND_BYTES = 1 << 20;

export interface BuiltPlugin {
  id: string;
  version: string;
  onLoad(settings: Record<string, unknown>): unknown;
  onUnload(): unknown;
  onEvent(event: { name: string; payload?: unknown }): unknown;
  /** Answers the requests to the plugin's HTTP endpoints; Decaid's loader sets it from `handleHttpRequest` too. */
  __httpRequestHandler?(request: Record<string, unknown>): unknown;
  handleHttpRequest?(request: Record<string, unknown>): unknown;
}

/** An endpoint the plugin's manifest declares, as Decaid's `ApiEndpoint.fromJson` reads it (plugin_manifest.dart). */
interface DeclaredEndpoint {
  id: string;
  type: "http" | "websocket";
}

/** The endpoints a manifest declares; throws for an entry Decaid v0.9.0 could not read, so would not load the plugin with. */
export function declaredEndpoints(manifest: Record<string, unknown>): DeclaredEndpoint[] {
  const api = manifest.api ?? [];
  if (!Array.isArray(api)) throw new Error("The manifest's api must be a list");
  return api.map((entry: unknown) => {
    const { id, type, data } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "string") throw new Error(`An api entry's id must be a string: ${JSON.stringify(entry)}`);
    if (type !== "http" && type !== "websocket") throw new Error(`An api entry's type must be http or websocket: ${JSON.stringify(entry)}`);
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`An api entry's data must be an object: ${JSON.stringify(entry)}`);
    return { id, type };
  });
}

/** What Decaid answers a request to one of the plugin's HTTP endpoints with: its body as sent, a string. */
export interface EndpointAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
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
 * The test tablet's DE1Pro, with its hardware ids replaced (see the
 * fixtures' READMEs): its library, settings and paired devices included, as
 * Decaid 0.8.7 answered them (de1pro-v0.8.7/), and unchanged in 0.9.0, but
 * its version and app settings as Decaid 0.9.0 answers them
 * (de1pro-v0.9.0/). Its scale is off, so `/scale/info` answers 503, and DYE2 has
 * never written its equipment, which therefore answers `null`. Its DYE2
 * recipes and baskets are in an older DYE2's shape than simulated-dye2.ts
 * replays. Its flow calibration is derived, not recorded: Decaid's answer to
 * `GET /machine/calibration` (de1handler.dart) holding the value its Shot
 * recorded (`workflow.machine.flowCalibration` in shot-espresso.json). So is
 * its sensor calibration (`sensorCalibration`). Its Skins are those Decaid's
 * Linux release answered with Streamline's build of `main` the default and
 * its release served, as the test tablet's app settings name them
 * (`defaultSkinId` and `webUiPath`; `skinsAt("defaultSwitched")`). Its
 * presence settings are a new install's (`newPresenceSettings`).
 */
export function de1ProOnDecaid090(): DecaidApi {
  return {
    "/info": readFixture("info.json", "de1pro-v0.9.0"),
    "/machine/info": readFixture("machine-info.json"),
    "/settings": readFixture("settings.json", "de1pro-v0.9.0"),
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
    "/machine/calibration": { flowMultiplier: 1.1 },
    ...sensorCalibration(),
    "/presence/settings": newPresenceSettings(),
    ...skinsAt("defaultSwitched"),
    "/devices": readFixture("devices.json"),
    "/scale/info": new Refusal(503, readFixture("scale-info-no-scale.json")),
    "/sensors": readFixture("sensors.json"),
  };
}

/**
 * Derived, not recorded: Decaid's answers to `GET
 * /machine/calibration/{target}` (de1handler.dart), the current calibration,
 * for a machine whose pressure sensor was recalibrated, by the values given.
 * The flow and pressure calibrations are ratiometric, so Decaid reports them
 * with a `de1ReportedValue` of 1; the temperature calibration, an offset,
 * with 0 (`MockDe1.readCalibration`). Each value is one the machine can
 * hold, in signed Q16.16.
 */
export function sensorCalibration(current: { flow?: number; pressure?: number; temperature?: number } = {}): DecaidApi {
  const now = { flow: 1, pressure: 1.0234375, temperature: 0, ...current };
  return Object.fromEntries(
    (["flow", "pressure", "temperature"] as const).map((target) => [
      `/machine/calibration/${target}`,
      { target, source: "current", de1ReportedValue: target === "temperature" ? 0 : 1, measuredValue: now[target] },
    ]),
  );
}

/**
 * Decaid v0.9.0's presence settings as a new install holds them, what its
 * Linux release answered `GET /presence/settings` with as it started
 * (settings-writes-v0.9.0/, `started`): presence on, a 30 minute sleep
 * timeout and no wake schedules. The test tablet's own were not recorded.
 */
export function newPresenceSettings(): Record<string, unknown> {
  const recorded = readFixture<{ started: { reads: Record<string, { body: Record<string, unknown> }> } }>("settings-writes.json", "settings-writes-v0.9.0");
  return recorded.started.reads["/presence/settings"]!.body;
}

/** A step of plugins-and-skins-v0.9.0/plugins-and-skins.json, in the order it was recorded (its README). */
export type PluginsAndSkinsStep =
  | "started"
  | "dye2Release"
  | "dye2Disabled"
  | "dye2Enabled"
  | "dye2Branch"
  | "streamlineRelease"
  | "streamlineMain"
  | "defaultSwitched"
  | "servedMain"
  | "servedOther"
  | "serverStopped";

/**
 * What Decaid v0.9.0's Linux release answered `GET /plugins`, `/webui/skins`,
 * `/webui/skins/default` and `/webui/server/status` with after that step
 * (plugins-and-skins-v0.9.0/), by route, each read kept as `"unchanged"`
 * there being the last one before it.
 */
export function pluginsAndSkinsAt(step: PluginsAndSkinsStep): Record<string, { status: number; body: unknown }> {
  const recorded = readFixture<Record<string, { reads: Record<string, { status: number; body?: unknown; unchanged?: true }> }>>(
    "plugins-and-skins.json",
    "plugins-and-skins-v0.9.0",
  );
  const answers: Record<string, { status: number; body: unknown }> = {};
  for (const [name, { reads }] of Object.entries(recorded)) {
    for (const [route, read] of Object.entries(reads)) if (!read.unchanged) answers[route] = { status: read.status, body: read.body };
    if (name === step) return answers;
  }
  throw new Error(`No step ${step} was recorded`);
}

/** Decaid's Skins routes as its Linux release answered them after that step (`pluginsAndSkinsAt`). Merge it into a tablet's API. */
export function skinsAt(step: PluginsAndSkinsStep): DecaidApi {
  const answers = pluginsAndSkinsAt(step);
  return Object.fromEntries(
    ["/webui/skins", "/webui/skins/default", "/webui/server/status"].map((route) => {
      const { status, body } = answers[route]!;
      return [route, status === 200 ? body : new Refusal(status, body)];
    }),
  );
}

/**
 * Decaid's own simulated devices (simulated-devices-v0.8.7/, unchanged in
 * v0.9.0): a connected scale, which reports no firmware or battery level,
 * two sensors, and a second machine only discovered nearby, with the app
 * settings Decaid v0.9.0 answered beside them (simulated-devices-v0.9.0/),
 * which prefer that scale and name that machine's connection id. Merge it
 * into a tablet's API.
 */
export function simulatedDevices(): DecaidApi {
  return {
    "/settings": readFixture("settings.json", "simulated-devices-v0.9.0"),
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

/**
 * Derived from the first profile posted in profile-writes-v0.8.7: the same
 * profile, to post as a barista saves one, under another title and with its
 * pouring step's pressure changed. Decaid derives a profile's id from its
 * steps, not its title, so each pressure is a Profile of its own.
 */
export function derivedProfile(title: string, pressure: number): Record<string, unknown> {
  const [, , created] = readFixture<{ request: { body: { profile: Record<string, unknown> } } }[]>("profile-writes.json", "profile-writes-v0.8.7");
  const profile = created!.request.body.profile;
  const steps = profile.steps as Record<string, unknown>[];
  return { ...profile, title, steps: steps.map((step, index) => (index === 1 ? { ...step, pressure } : step)) };
}

function readFixture<T = Record<string, unknown>>(file: string, folder = "de1pro-v0.8.7"): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, folder, file), "utf8"));
}

/** What /machine/info and the machine's settings answer, with status 500, while no machine is connected. */
function machineNotConnected(): Refusal {
  return new Refusal(500, readFixture("machine-not-connected.json", "simulated-devices-v0.8.7"));
}

/** Routes Decaid answers with ETags (jsonOkConditional in json_response.dart), and the query that includes archived records, but for the profiles (decaid-profiles.ts). */
const LIBRARY_LISTS: Readonly<Record<string, { include: string; hidden(record: Record<string, unknown>): boolean }>> = {
  "/beans": { include: "includeArchived", hidden: (record) => record.archived === true },
  "/bean-batches": { include: "includeArchived", hidden: (record) => record.archived === true },
  "/grinders": { include: "includeArchived", hidden: (record) => record.archived === true },
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
function machineSnapshot(state: string, substate: string): Record<string, unknown> {
  return { ...readFixture("machine-state.json"), state: { state, substate } };
}

/**
 * DYE2's recipes, baskets and tools, empty, for a test tablet whose Library
 * is otherwise the test's own: the test tablet's recipe and basket, which
 * every derived tablet holds, are shared through the Library like any other
 * (ADR-0005), and would be written to the Location's other tablets.
 */
export const NO_DYE2_LISTS: DecaidApi = { "/store/dye2.reaplugin/recipes": [], "/store/dye2.reaplugin/baskets": [], "/store/dye2.reaplugin/equipment": [] };

/**
 * Derived from de1ProOnDecaid090(): the same responses, with the machine's
 * reported model and serial, the preferred machine's connection id, or
 * Decaid's version (such as 0.8.8+2900, split into its version and build
 * number as Decaid reports them too) changed. Every other field is as Decaid
 * sent it.
 */
export function derivedDe1Pro(changes: { model?: string; serial?: string; connectionId?: string; decaidVersion?: string }): DecaidApi {
  const api = de1ProOnDecaid090();
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
    decaidVersion: "0.9.0+2977",
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
  /** The key whose reads fail, or undefined for any key's. */
  private failingKey: string | undefined;
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

  /**
   * Leaves the next `count` reads unanswered, or of `key` only, as Decaid
   * leaves one whose read from its store fails.
   */
  failNextReads(count: number, key?: string): void {
    this.failingReads = count;
    this.failingKey = key;
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
      if (this.failingReads > 0 && (this.failingKey === undefined || this.failingKey === key)) {
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
  /** Decaid's API responses; defaults to de1ProOnDecaid090(). */
  api?: DecaidApi;
  /** Whether a machine is connected to the tablet; while not, /machine/info, /machine/state and the machine's settings fail. Defaults to true. */
  machineConnected?: boolean;
  /**
   * Runs the plugin's timers, and the delays below, this many times faster,
   * except while a connection opens and waits for the server's first answer.
   * Defaults to 1.
   */
  timeScale?: number;
  /**
   * How long Decaid's API takes to answer each request, or a request with
   * that method and path (its route and query); from 30 s on, the request
   * times out. Defaults to 0.
   */
  apiDelayMs?: number | ((method: string, path: string) => number);
  /**
   * Answers each of the plugin's requests from what Decaid holds when the
   * request arrives, its answer then taking `apiDelayMs` to reach the plugin,
   * as when Decaid read its database at once but its answer was slow. A
   * write is carried out on arrival too, even if the plugin's fetch then
   * times out. By default a request is answered once its delay is over.
   */
  answerOnArrival?: boolean;
  /**
   * How far ahead of the test's clock the tablet's Decaid reads its own, in
   * milliseconds, or behind it if negative: the times it writes into the
   * records it creates and changes, as on a tablet whose clock is wrong. The
   * plugin's own clock is the test's.
   */
  decaidClockOffsetMs?: number;
  /**
   * The largest `GET /steams/ids` response the plugin's fetch answers: a
   * longer list fails the fetch, as Decaid's 10 MiB limit, the default, fails
   * it on a tablet holding about 268,900 Steam Records.
   */
  steamIdsLimitBytes?: number;
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
   * Whether the machine keeps the flush settings Decaid writes to it from a
   * Workflow change, as a DE1 does (`UnifiedDe1.setFlushTemperature` writes
   * its MMR, which `GET /machine/settings` reads back), so DYE2 reads them
   * there. True by default; Decaid's simulated machine, which the recordings
   * of fixtures/decaid/dye2-v0.1.26/ were made on, keeps none
   * (`MockDe1.setFlushTemperature` does nothing), so replays of them set it
   * false.
   */
  keepsFlushSettings?: boolean;
  /**
   * Stalls the network at the first queued frame, parsed, that this matches:
   * that frame and the ones behind it stay pending, unwritten, for as long as
   * it matches. Nothing stalls by default.
   */
  stallUpload?: (frame: unknown) => boolean;
  /**
   * DYE2 v0.1.26 running on the tablet beside the plugin, as Decaid runs
   * another plugin (simulated-dye2.ts): its HTTP endpoints, its socket and
   * its entry in `GET /plugins`. Pass the same one to a later load of the
   * same tablet, as DYE2 outlives the plugin's reloads. Without it Decaid
   * lists no DYE2.
   */
  dye2?: SimulatedDye2;
}

type TransportEvent = Record<string, unknown> & { type: string };
/** The reads of Steam Records a test can hold: of every id, and of the newest. */
export type HeldSteamRead = "/steams/ids" | "/steams/latest";

/** Requests to one route held by `holdRequests`: how many have arrived so far, and their release. */
export interface HeldRequests {
  readonly arrived: number;
  release(): void;
}

interface TransportRecord {
  handle: string;
  socket: WebSocket | LocalSocket;
  /** A socket on one of Decaid's own plugin endpoints, which the tablet's network does not carry. */
  local: boolean;
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
  /** What the plugin emitted while loaded, in order: the endpoint it named, and the payload read back from the JSON Decaid sends. */
  readonly emits: { event: string; payload: unknown }[] = [];
  /** Makes `host.emit` throw this, as when Decaid refuses it, until cleared. */
  failEmits?: Error;
  /** Called with each push as the plugin emits it, before `host.emit` returns, as a skin hearing it at once would: a test reads what the tablet holds then. */
  onEmit?: (event: string, payload: unknown) => void;
  /** Decaid's storage for the plugin, which outlasts this load. */
  readonly storage: PluginStorage;
  /** The Decaid API routes the plugin requested, in order, such as "/machine/info". */
  readonly requests: string[] = [];
  /** When the plugin made each of `requests`, by the tablet's clock (`readClock`). */
  readonly requestedAt: number[] = [];
  /** The plugin's requests that could change the tablet's data (any method but GET), such as "POST /beans". */
  readonly writes: string[] = [];
  /** The plugin's writes to Decaid's store API that Decaid carried out, in order, each with the value written. */
  readonly storeWrites: { namespace: string; key: string; value: unknown }[] = [];
  /** Told of every change of the Workflow, after the plugin is. */
  private readonly workflowListeners = new Set<(workflow: Record<string, unknown>) => void>();
  readonly plugin: BuiltPlugin;
  /** DYE2 running beside the plugin, if the tablet has it. */
  readonly dye2: SimulatedDye2 | undefined;
  /** The sockets open on Decaid's plugin WebSocket endpoints, by the plugin id and endpoint each was opened on. */
  private readonly localSockets = new Map<LocalSocket, { pluginId: string; endpoint: string }>();
  /** The plugin's manifest, as `GET /plugins` lists it. */
  private readonly manifest: Record<string, unknown>;
  machineConnected: boolean;
  private api: DecaidApi;
  private readonly apiFailures = new Map<string, number>();
  readonly shotPageRequests: { limit: number; offset: number }[] = [];
  /**
   * Called as each `GET /shots` page is requested, before it is answered:
   * a change to the Shots, through `serve`, shows in that page.
   */
  beforeShotPage?: (request: { limit: number; offset: number }) => void;
  /** Each read of Steam Records held, as it is requested, until its promise settles: true if it is to time out. */
  private readonly steamReadsHeld = new Map<HeldSteamRead, Promise<boolean>>();
  /** The reads of the Workflow held, as they are requested, until the promise settles. */
  private workflowReadsHeld: Promise<void> | undefined;
  /** The reads of each Shot held, as they are requested, until the promise settles. */
  private shotReadsHeld: Promise<void> | undefined;
  /** Requests held by `holdRequests`, by their method and route, until released. */
  private readonly requestsHeld = new Map<string, { held: Promise<void>; arrived: number }>();
  /** Every frame the plugin sent, parsed, in order. */
  readonly sent: unknown[] = [];
  /** Every text frame the server sent the plugin, parsed, in order. */
  readonly received: unknown[] = [];
  /** The most bytes any transport has had pending at once. */
  peakPendingOutboundBytes = 0;
  /** Sends refused for going past the pending outbound limit. */
  refusedSends = 0;
  /**
   * Picks the plugin's writes (any request but a `GET`) Decaid refuses,
   * changing nothing, as a Decaid that cannot take a record does: answered
   * with the status and body returned, or carried out as Decaid does where
   * it returns undefined. Undefined carries out every write.
   */
  refuseWrites?: (request: { method: string; route: string; body: unknown }) => DecaidAnswer | undefined;
  /**
   * Fails Decaid's write of one field of a settings write part-way, as when
   * the machine does not take a register's write in time: called with the
   * route and each field's name, as the request gives it, as Decaid is about
   * to write it (or, for `PUT /machine/calibration/{target}`, the target),
   * whoever sent the request. An answer stops the write there, the fields
   * before it written, and answers the request with it, such as Decaid's
   * `{"error": ...}` 504 for a write that timed out (`_mapDe1WriteErrors`
   * in decaid:lib/src/services/webserver/de1handler.dart). Undefined writes
   * every field.
   */
  failSettingWrites?: (write: { route: string; field: string }) => DecaidAnswer | undefined;
  /** The plugin's id, which names its storage in Decaid's store API. */
  private readonly pluginId: string;
  /** The endpoints the plugin's manifest declares. */
  private readonly endpoints: DeclaredEndpoint[];
  private readonly permissions: readonly string[];
  private readonly timeScale: number;
  private readonly apiDelayMs: (method: string, path: string) => number;
  private readonly answerOnArrival: boolean;
  private readonly decaidClockOffsetMs: number;
  /** How far the plugin's own clock, as its `Date` reads it, is from the test's (`setPluginClockOffset`). */
  private pluginClockOffsetMs = 0;
  private readonly keepsFlushSettings: boolean;
  private readonly steamIdsLimitBytes: number;
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
  /** Answers to storage commands held by `holdStorageAnswers`, until released. */
  private heldStorageAnswers: { name: string; payload: unknown }[] | undefined;
  /** Connections the plugin was told ended that the server still holds open, until it closes them or the plugin unloads. */
  private readonly unnoticed = new Set<WebSocket>();
  /** Matches the frame after which the next connection to receive one ends, until one does. */
  private cutAfter: ((frame: unknown) => boolean) | undefined;

  /** Loads the built plugin and calls onLoad, as Decaid does when the plugin is enabled. */
  static load(options: SimulatedTabletOptions): SimulatedTablet {
    const tablet = new SimulatedTablet(options);
    opened({ end: () => tablet.unload() });
    return tablet;
  }

  private constructor(private readonly options: SimulatedTabletOptions) {
    this.api = options.api ?? de1ProOnDecaid090();
    this.machineConnected = options.machineConnected ?? true;
    this.keepsFlushSettings = options.keepsFlushSettings ?? true;
    this.timeScale = options.timeScale ?? 1;
    const apiDelayMs = options.apiDelayMs ?? 0;
    this.apiDelayMs = typeof apiDelayMs === "number" ? () => apiDelayMs : apiDelayMs;
    this.answerOnArrival = options.answerOnArrival ?? false;
    this.decaidClockOffsetMs = options.decaidClockOffsetMs ?? 0;
    this.steamIdsLimitBytes = options.steamIdsLimitBytes ?? MAX_FETCH_RESPONSE_BYTES;
    this.uploadBytesPerSecond = options.uploadBytesPerSecond;
    this.stallUpload = options.stallUpload;
    this.upgradeAtTabletPace = options.upgradeAtTabletPace ?? false;
    this.storage = options.storage ?? new PluginStorage();
    this.storage.decaidStarted();
    rememberSecret(options.settings.Token);
    watchLog("a simulated tablet's log", () => this.logs.join("\n"));
    const { source, manifest } = readBuiltPlugin();
    this.manifest = manifest;
    this.dye2 = options.dye2;
    this.dye2?.attach(this);
    this.pluginId = String(manifest.id);
    this.endpoints = declaredEndpoints(manifest);
    const permissions = manifest.permissions as string[];
    this.permissions = permissions;
    this.plugin = loadPlugin(source, String(manifest.id), {
      host: {
        log: (message: unknown) => this.logs.push(String(message)),
        emit: permissions.includes("emit")
          ? (event: unknown, payload: unknown) => this.emit(event, payload)
          : () => {
              throw new Error(`Plugin ${String(manifest.id)} requires manifest permission emit`);
            },
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
      Date: pluginDate(() => this.pluginClockOffsetMs),
    });
    this.plugin.onLoad(options.settings);
    // PluginManager sends the current Workflow once the plugin has loaded.
    if (this.api["/workflow"] !== undefined) this.fire("workflowUpdated", this.api["/workflow"]);
  }

  /** Answers Decaid's API with these responses from now on, as when another machine is connected, the values in Decaid's store included. */
  serve(api: DecaidApi): void {
    this.api = api;
  }

  /**
   * Answers a route of Decaid's API with the refusal until the function
   * returned is called, which serves what it held again, as Decaid failing
   * for a moment does. Nothing is written to it meanwhile: a write reads it
   * first.
   */
  refuseFor(route: string, refusal: Refusal): () => void {
    const held = this.api[route];
    this.api[route] = refusal;
    return () => {
      this.api[route] = held;
    };
  }

  /**
   * Connects the machine to the tablet, as when it reconnects: /machine/info
   * answers from now on, the fan threshold is 50 and the refill kit set to
   * auto, as Decaid sets them on every connect, and Decaid starts sending
   * machine state updates, of which this delivers one, with the state
   * /machine/state answers.
   */
  connectMachine(): void {
    this.machineConnected = true;
    // A machine connecting to Decaid has its fan threshold and refill kit set to Decaid's defaults (decaid-settings.ts).
    const { settings, advanced } = reconnected(this.api["/machine/settings"], this.api["/machine/settings/advanced"]);
    if ("/machine/settings" in this.api) this.api = { ...this.api, "/machine/settings": settings };
    if ("/machine/settings/advanced" in this.api) this.api = { ...this.api, "/machine/settings/advanced": advanced };
    this.fire("stateUpdate", this.api["/machine/state"]);
  }

  /**
   * Saves a Shot in the tablet's Decaid, as one pulled there does when it
   * ends: /shots/{id} answers with it from now on, and the plugin is sent
   * it in a `shotStored` event.
   */
  pullShot(shot: Record<string, unknown>): void {
    this.api = { ...this.api, [`/shots/${encodeURIComponent(String(shot.id))}`]: shot };
    this.fire("shotStored", { id: shot.id });
    if (!this.unloaded) this.dye2?.shotStored();
  }

  /**
   * Changes the tablet's Workflow, as a barista or a skin does: /workflow
   * answers with it from now on, and the plugin is sent it in a
   * `workflowUpdated` event.
   */
  setWorkflow(workflow: Record<string, unknown>): void {
    this.api = { ...this.api, "/workflow": workflow };
    this.fire("workflowUpdated", workflow);
    if (!this.unloaded) this.dye2?.workflowUpdated(workflow);
    for (const listener of this.workflowListeners) listener(workflow);
  }

  /**
   * Tells `listener` of every change of the Workflow from now on, as a skin
   * hears of one, until the function returned is called.
   */
  onWorkflowChange(listener: (workflow: Record<string, unknown>) => void): () => void {
    this.workflowListeners.add(listener);
    return () => this.workflowListeners.delete(listener);
  }

  /** What Decaid's store holds at that key of that namespace, as `GET /store/{namespace}/{key}` answers it: null if never set. */
  storeValue(namespace: string, key: string): unknown {
    const value = this.api[storeRoute(namespace, key)];
    if (value instanceof Refusal) throw new Error(`Decaid's store is served as refusing ${namespace}/${key}, with ${value.status}`);
    return value === undefined ? null : structuredClone(value);
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

  /**
   * Holds every answer to `GET /steams/ids` or `GET /steams/latest` until the
   * function returned is called, as Decaid is slow to answer a long list.
   * Each request is still made, and listed in `requests`, at once, and
   * answered, when released, from what the tablet serves then. Released with
   * `"timedOut"`, the held requests fail as Decaid's fetch fails one after
   * 30 s. Holding a route again holds the requests made after, while those
   * held before wait for their own release.
   */
  holdSteamReads(route: HeldSteamRead): (outcome?: "timedOut") => void {
    let release!: (timedOut: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    this.steamReadsHeld.set(route, held);
    return (outcome) => {
      if (this.steamReadsHeld.get(route) === held) this.steamReadsHeld.delete(route);
      release(outcome === "timedOut");
    };
  }

  /**
   * Holds the plugin's reads of the Workflow (`GET /workflow`) until the
   * function returned is called, as Decaid is slow to answer: each is
   * answered, when released, from the Workflow the tablet holds then, so a
   * barista's change made meanwhile is in it.
   */
  holdWorkflowReads(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workflowReadsHeld = held;
    return () => {
      if (this.workflowReadsHeld === held) this.workflowReadsHeld = undefined;
      release();
    };
  }

  /**
   * Holds the plugin's reads of each Shot (`GET /shots/{id}`) until the
   * function returned is called, as Decaid is slow to read one: each is
   * answered, when released, from the Shots the tablet holds then.
   */
  holdShotReads(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.shotReadsHeld = held;
    return () => {
      if (this.shotReadsHeld === held) this.shotReadsHeld = undefined;
      release();
    };
  }

  /**
   * Holds the plugin's requests with this method to this route (without its
   * query) until released, as a slow Decaid does, such as one writing a
   * machine's settings one register at a time: each is taken, a write
   * carried out, and answered from what Decaid holds then, only once
   * released. A request still held when Decaid's fetch times out, 30 s from
   * when it was made by the tablet's clock, fails as that fetch does.
   * Holding a route again holds the requests made after, while those held
   * before wait for their own release.
   */
  holdRequests(method: string, route: string): HeldRequests {
    let release!: () => void;
    const hold = { held: new Promise<void>((resolve) => (release = resolve)), arrived: 0 };
    const key = `${method} ${route}`;
    this.requestsHeld.set(key, hold);
    return {
      get arrived() {
        return hold.arrived;
      },
      release: () => {
        if (this.requestsHeld.get(key) === hold) this.requestsHeld.delete(key);
        release();
      },
    };
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
    if (!answer) return;
    if (this.heldStorageAnswers) this.heldStorageAnswers.push(answer);
    else setImmediate(() => this.fire(answer.name, answer.payload));
  }

  /**
   * Holds Decaid's answers to the plugin's storage commands until the
   * function returned is called, as a slow Decaid does: each command is
   * still carried out as it arrives, so a write lands, but the plugin hears
   * of it only once released, and not at all once unloaded.
   */
  holdStorageAnswers(): () => void {
    const held: { name: string; payload: unknown }[] = [];
    this.heldStorageAnswers = held;
    return () => {
      if (this.heldStorageAnswers === held) this.heldStorageAnswers = undefined;
      for (const answer of held.splice(0)) setImmediate(() => this.fire(answer.name, answer.payload));
    };
  }

  /** Loses the network: every connection ends without a close handshake, as if the Wi-Fi dropped. */
  dropConnections(): void {
    for (const record of this.transports.values()) if (!record.local) record.socket.terminate();
  }

  /**
   * Loses the network so that only the tablet notices, as when Android
   * reports its Wi-Fi dropped while the server's end hears nothing: each
   * connection ends for the plugin with an error, but stays open for the
   * server, which is sent nothing more on it and whose frames no longer reach
   * the tablet, until the server closes it.
   */
  dropConnectionsUnnoticed(): void {
    for (const record of this.transports.values()) {
      if (record.terminal || record.local) continue;
      record.socket.removeAllListeners("message");
      const socket = record.socket as WebSocket;
      this.unnoticed.add(socket);
      socket.once("close", () => this.unnoticed.delete(socket));
      this.terminate(record, "WebSocket error: Software caused connection abort", "transport_error");
    }
  }

  /**
   * Ends the next connection to receive a text frame that matches right after
   * it, as a network failing then does: the plugin is given that frame, then
   * a transport error, and nothing the server sent after it.
   */
  cutConnectionAfter(matches: (frame: unknown) => boolean): void {
    this.cutAfter = matches;
  }

  /**
   * Writes the frames `stallUpload` held on each connection, once it lets
   * them pass, without waiting for the plugin's next send, as a network
   * that recovers before it drops does.
   */
  resumeUpload(): void {
    for (const record of this.transports.values()) void this.write(record);
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
      for (const socket of this.unnoticed) socket.terminate();
    }
  }

  /**
   * Unloads the plugin and loads it again, as changing its settings or an
   * update of it does: with the same options, on what this tablet's Decaid
   * holds now, its plugin storage, its DYE2 and whether its machine is
   * connected, but for the `options` given. Resolves with the new load's
   * tablet.
   */
  async reload(options: Partial<SimulatedTabletOptions> = {}): Promise<SimulatedTablet> {
    await this.unload();
    return SimulatedTablet.load({ ...this.options, api: this.api, storage: this.storage, machineConnected: this.machineConnected, ...options });
  }

  /** Sends an emitted payload as Decaid does: through JSON, to the sockets open on the endpoint, none once unloaded. */
  private emit(event: unknown, payload: unknown): void {
    if (this.failEmits) throw this.failEmits;
    if (this.unloaded) return;
    const sent = { event: String(event), payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload)) };
    this.emits.push(sent);
    this.onEmit?.(sent.event, sent.payload);
  }

  /**
   * What a skin listening on the plugin's WebSocket endpoint since the load
   * heard: each payload emitted there. Throws for an endpoint the manifest
   * does not declare as a WebSocket, which Decaid opens no socket on.
   */
  pushes(endpoint: string): unknown[] {
    const declared = this.endpoints.find((candidate) => candidate.id === endpoint);
    if (declared?.type !== "websocket") throw new Error(`Decaid opens no socket on ${endpoint}: the manifest does not declare it as a websocket endpoint`);
    return this.emits.filter((emitted) => emitted.event === endpoint).map((emitted) => emitted.payload);
  }

  /**
   * The socket a WebSocket open to Decaid's own origin is, on a plugin's
   * WebSocket endpoint (`/ws/v1/plugins/{id}/{endpoint}`), as
   * `_handlePluginSocketEndpoint` in plugins_handler.dart opens one: refused
   * with 404 while that plugin is not loaded or declares no such endpoint,
   * and with 400 for an HTTP one; once open, it hears every push of that
   * plugin on that endpoint, whichever load of it makes it, until the tablet
   * unloads. Undefined for any other URL. Only DYE2's endpoints are
   * simulated.
   */
  private localSocket(url: string): LocalSocket | undefined {
    const origin = API_ORIGIN.replace(/^http/, "ws");
    if (!url.startsWith(`${origin}/`)) return undefined;
    const [, ws, v1, plugins, pluginId, endpoint, ...rest] = new URL(url).pathname.split("/");
    const refused = (status: number) => new TransportError(`WebSocket connect failed: Connection to '${url.replace(/^ws/, "http")}#' was not upgraded to websocket, HTTP status code: ${status}`);
    if (ws !== "ws" || v1 !== "v1" || plugins !== "plugins" || pluginId === undefined || endpoint === undefined || rest.length > 0) throw refused(404);
    const id = decodeURIComponent(pluginId);
    const name = decodeURIComponent(endpoint);
    if (id !== this.dye2?.id) throw new Error(`The simulated tablet opens no socket on ${id}'s endpoints`);
    const type = this.dye2.socketEndpoint(name);
    if (type !== "websocket") throw refused(type === "http" ? 400 : 404);
    const socket = new LocalSocket();
    this.localSockets.set(socket, { pluginId: id, endpoint: name });
    return socket;
  }

  /** Sends a plugin's push, through JSON, to each socket open on its endpoint, as Decaid's `host.emit` does; nothing is kept for a socket opened later. */
  pushOnSocket(pluginId: string, endpoint: string, payload: unknown): void {
    const text = JSON.stringify(payload ?? null);
    for (const [socket, opened] of this.localSockets) if (opened.pluginId === pluginId && opened.endpoint === endpoint) socket.receive(text);
  }

  /** The plugins Decaid lists at `GET /plugins` (`PluginsHandler.addRoutes`): this one, loaded, and DYE2 where the tablet has it installed. */
  private listedPlugins(): Record<string, unknown>[] {
    const own = { ...this.manifest, loaded: !this.unloaded, autoLoad: true, source: null, pendingUpdate: null };
    const dye2 = this.dye2?.listing();
    return dye2 ? [dye2, own] : [own];
  }

  /**
   * Moves the plugin's own clock, as its `Date` reads it, this far from the
   * test's from now on, as when the tablet corrects its clock: back where
   * negative. Its timers keep their pace, as Decaid's are Dart's, on a
   * monotonic clock.
   */
  setPluginClockOffset(offsetMs: number): void {
    this.pluginClockOffsetMs = offsetMs;
  }

  /** The tablet's clock, which `timeScale` speeds, in milliseconds. */
  readClock(): number {
    return this.now();
  }

  /**
   * Calls one of the plugin's HTTP endpoints as a skin does, through
   * `/api/v1/plugins/{id}/{endpoint}`: 404 for an endpoint the manifest does
   * not declare, 403 without `api`, 400 for a WebSocket endpoint, and 500 if
   * the plugin's handler throws or rejects; otherwise its answer, status 200
   * if it gives none.
   */
  async callEndpoint(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<EndpointAnswer> {
    const json = (status: number, body: unknown): EndpointAnswer => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const declared = this.endpoints.find((candidate) => candidate.id === endpoint);
    if (this.unloaded) return json(404, { error: `plugin with ${this.pluginId} not loaded` });
    if (!this.permissions.includes("api")) return json(403, { error: `PluginPermissionError: Plugin ${this.pluginId} requires manifest permission api` });
    if (!declared) return json(404, { error: `endpoint ${endpoint} not available` });
    if (declared.type !== "http") return json(400, { error: `endpoint ${endpoint} is not a http type` });
    const handler = this.plugin.__httpRequestHandler;
    if (typeof handler !== "function") throw new Error("The plugin has no __httpRequestHandler, so Decaid never answers the request");
    const request = {
      requestId: `${this.pluginId}_${endpoint}_${Date.now()}`,
      endpoint,
      method: options.method ?? "GET",
      headers: {},
      body: options.body === undefined ? null : JSON.parse(JSON.stringify(options.body)),
      query: {},
    };
    let answer: Record<string, unknown>;
    try {
      answer = (await handler.call(this.plugin, request)) as Record<string, unknown>;
    } catch (error) {
      return json(500, { error: String(error) });
    }
    const headers = Object.fromEntries(Object.entries((answer.headers ?? {}) as Record<string, unknown>).map(([name, value]) => [name, String(value)]));
    return { status: typeof answer.status === "number" ? answer.status : 200, headers, body: String(answer.body ?? "") };
  }

  /**
   * How many times the server has acknowledged the frame with this id, as
   * RawConnection's `acks` counts: none for a frame with no id, rather than
   * every acknowledgment.
   */
  acks(id: unknown): number {
    return typeof id === "string" ? this.received.filter((reply) => isAckOf(reply, id)).length : 0;
  }

  /**
   * Whether the server has acknowledged every frame the plugin sent that
   * matches, as it has when none does. `matches` reads each frame `sent`
   * holds, typed as the caller reads it. A message sent in chunks is in
   * `sent` only as its chunks, each carrying the message's id, which the
   * server acknowledges once the whole message is in: a match on the
   * message's type finds none of them, so match such a message by its id.
   */
  acknowledgedEvery<Frame>(matches: (frame: Frame) => boolean): boolean {
    const acknowledged = this.acknowledgedIds();
    return (this.sent as Frame[]).filter(matches).every((frame) => acknowledged.has((frame as { id?: unknown }).id));
  }

  /** Whether the server has acknowledged some frame the plugin sent that matches, as `acknowledgedEvery` reads them. */
  acknowledgedSome<Frame>(matches: (frame: Frame) => boolean): boolean {
    const acknowledged = this.acknowledgedIds();
    return (this.sent as Frame[]).some((frame) => matches(frame) && acknowledged.has((frame as { id?: unknown }).id));
  }

  /** The ids of the frames the server has acknowledged so far. */
  private acknowledgedIds(): Set<unknown> {
    return new Set(this.received.flatMap((reply) => (isAckOf(reply) ? [(reply as { id?: unknown }).id] : [])));
  }

  /** Resolves with the first log line, past or future, that matches. */
  async waitForLog(pattern: RegExp, timeoutMs = 15_000): Promise<string> {
    return (await this.waitForLogs(pattern, 1, timeoutMs))[0]!;
  }

  /** Resolves once at least `count` log lines, past or future, match. */
  async waitForLogs(pattern: RegExp, count: number, timeoutMs = 15_000): Promise<string[]> {
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

  /** The tablet's beans, archived ones included, as `GET /beans?includeArchived=true` lists them. */
  beans(): Record<string, unknown>[] {
    return structuredClone((this.api["/beans"] as Record<string, unknown>[] | undefined) ?? []);
  }

  /** The tablet's bean batches, archived ones included, as `GET /bean-batches?includeArchived=true` lists them. */
  batches(): Record<string, unknown>[] {
    return structuredClone((this.api["/bean-batches"] as Record<string, unknown>[] | undefined) ?? []);
  }

  /** The tablet's grinders, archived ones included, as `GET /grinders?includeArchived=true` lists them. */
  grinders(): Record<string, unknown>[] {
    return structuredClone((this.api["/grinders"] as Record<string, unknown>[] | undefined) ?? []);
  }

  /** The tablet's profiles, hidden and deleted ones included, as `GET /profiles?includeHidden=true` lists them: the most recently updated first. */
  profiles(): Record<string, unknown>[] {
    const profiles = this.api["/profiles"];
    return Array.isArray(profiles) ? (listProfiles(structuredClone(profiles as Record<string, unknown>[]), new URLSearchParams("includeHidden=true")).body as Record<string, unknown>[]) : [];
  }

  /**
   * Calls Decaid's API as something else on the tablet does, such as a
   * barista adding a bean in Decaid or another plugin: the plugin is not
   * told, and it is not listed in `requests` or `writes`. Resolves with what
   * Decaid answers, its body read as JSON.
   */
  async callApi(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<DecaidAnswer> {
    return this.callApiWithText(method, path, body === undefined ? undefined : JSON.stringify(body));
  }

  /**
   * Calls Decaid's API as `callApi` does, with the body as this text, sent as
   * it is, for one that is not JSON. Resolves with what Decaid answers, its
   * body read as JSON, or as text where it is not.
   */
  async callApiWithText(method: "GET" | "POST" | "PUT" | "DELETE", path: string, text: string | undefined): Promise<DecaidAnswer> {
    const answered = (await this.answer(`${API_ORIGIN}/api/v1${path}`, method, {}, text)) as { status: number; text(): Promise<string> };
    const body = await answered.text();
    if (body === "") return { status: answered.status, body: null };
    try {
      return { status: answered.status, body: JSON.parse(body) };
    } catch {
      return { status: answered.status, body };
    }
  }

  /** The tablet's Workflow, as `GET /workflow` answers it. */
  workflow(): Record<string, unknown> {
    return this.api["/workflow"] as Record<string, unknown>;
  }

  /**
   * Changes the Workflow's steam, hot water or rinse settings in Decaid, as a
   * barista or a skin does, with `PUT /workflow`, and resolves with the
   * Workflow Decaid returned.
   */
  async changeSettings(parts: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", "/workflow", parts);
    if (status !== 200) throw new Error(`Decaid refused the change with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Adds a bean in Decaid, as a barista does, and resolves with the record Decaid made. */
  async addBean(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("POST", "/beans", fields);
    if (status !== 201) throw new Error(`Decaid refused the bean with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Changes the tablet's bean with that id in Decaid, as a barista does, and resolves with the record Decaid returned. */
  async editBean(id: unknown, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", `/beans/${encodeURIComponent(String(id))}`, fields);
    if (status !== 200) throw new Error(`Decaid refused the change with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Adds a batch of the tablet's bean with that id in Decaid, as a barista does, and resolves with the record Decaid made. */
  async addBatch(beanId: unknown, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("POST", `/beans/${encodeURIComponent(String(beanId))}/batches`, fields);
    if (status !== 201) throw new Error(`Decaid refused the batch with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Changes the tablet's batch with that id in Decaid, as a barista does, and resolves with the record Decaid returned. */
  async editBatch(id: unknown, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", `/bean-batches/${encodeURIComponent(String(id))}`, fields);
    if (status !== 200) throw new Error(`Decaid refused the change with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Adds a grinder in Decaid, as a barista does, and resolves with the record Decaid made. */
  async addGrinder(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("POST", "/grinders", fields);
    if (status !== 201) throw new Error(`Decaid refused the grinder with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Changes the tablet's grinder with that id in Decaid, as a barista does, archiving it included, and resolves with the record Decaid returned. */
  async editGrinder(id: unknown, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", `/grinders/${encodeURIComponent(String(id))}`, fields);
    if (status !== 200) throw new Error(`Decaid refused the change with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Deletes the tablet's grinder with that id in Decaid, as a barista does. */
  async deleteGrinder(id: unknown): Promise<void> {
    const { status, body } = await this.callApi("DELETE", `/grinders/${encodeURIComponent(String(id))}`);
    if (status !== 200) throw new Error(`Decaid refused to delete the grinder with ${status}: ${JSON.stringify(body)}`);
  }

  /**
   * Saves a profile in Decaid, as a barista does in Streamline: with the
   * Profile it was made from as its parent, if given, which is then hidden,
   * as Streamline hides the Profile it saved a new one from. Resolves with the
   * record Decaid made, or held already.
   */
  async addProfile(profile: Record<string, unknown>, options: { parentId?: unknown } = {}): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("POST", "/profiles", { profile, ...(options.parentId === undefined ? {} : { parentId: options.parentId }) });
    if (status !== 201) throw new Error(`Decaid refused the profile with ${status}: ${JSON.stringify(body)}`);
    if (options.parentId !== undefined) await this.setProfileVisibility(options.parentId, "hidden");
    return body as Record<string, unknown>;
  }

  /** Shows, hides or deletes the tablet's profile with that id in Decaid, as a barista does, and resolves with the record Decaid returned. */
  async setProfileVisibility(id: unknown, visibility: "visible" | "hidden" | "deleted"): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", `/profiles/${encodeURIComponent(String(id))}/visibility`, { visibility });
    if (status !== 200) throw new Error(`Decaid refused the visibility with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /** Changes the tablet's profile with that id in Decaid, as `PUT /profiles/{id}` does, and resolves with the record Decaid returned, under a new id if its steps changed. */
  async editProfile(id: unknown, profile: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { status, body } = await this.callApi("PUT", `/profiles/${encodeURIComponent(String(id))}`, { profile });
    if (status !== 200) throw new Error(`Decaid refused the change with ${status}: ${JSON.stringify(body)}`);
    return body as Record<string, unknown>;
  }

  /**
   * Deletes the tablet's bean with that id as DYE2 does
   * (`deleteBeanWithBatches` in dye2:dye2-plugin/src/utils/bean-delete.ts):
   * its batches first, archived ones included, since Decaid refuses to
   * delete a bean that has any, then the bean.
   */
  async deleteBean(id: unknown): Promise<void> {
    const bean = encodeURIComponent(String(id));
    const { body: batches } = await this.callApi("GET", `/beans/${bean}/batches?includeArchived=true`);
    for (const batch of batches as Record<string, unknown>[]) await this.callApi("DELETE", `/bean-batches/${encodeURIComponent(String(batch.id))}`);
    const { status, body } = await this.callApi("DELETE", `/beans/${bean}`);
    if (status !== 200) throw new Error(`Decaid refused to delete the bean with ${status}: ${JSON.stringify(body)}`);
  }

  // Decaid's plugin fetch, limited to its own API.
  private async fetch(input: unknown, init: unknown): Promise<unknown> {
    const arrived = this.answerOnArrival ? this.request(input, init) : undefined;
    // Answered or not, a request failing is not seen before its delay is over.
    arrived?.catch(() => {});
    const { method = "GET" } = (init ?? {}) as { method?: string };
    const path = String(input).slice(`${API_ORIGIN}/api/v1`.length);
    const delayMs = this.apiDelayMs(method.toUpperCase(), path);
    const hold = this.requestsHeld.get(`${method.toUpperCase()} ${path.split("?")[0]}`);
    if (hold) hold.arrived++;
    await new Promise<void>((resolve) => this.setTimer(resolve, Math.min(delayMs, FETCH_TIMEOUT_MS)));
    if (delayMs >= FETCH_TIMEOUT_MS) throw new Error("Fetch timed out");
    if (hold) {
      let timer = 0;
      const timedOut = await Promise.race([
        hold.held.then(() => false),
        new Promise<boolean>((resolve) => (timer = this.setTimer(() => resolve(true), FETCH_TIMEOUT_MS - delayMs))),
      ]);
      this.clearTimer(timer);
      if (timedOut) throw new Error("Fetch timed out");
    }
    return arrived ?? this.request(input, init);
  }

  /** Takes one of the plugin's requests, and starts answering it from what Decaid holds now. */
  private request(input: unknown, init: unknown): Promise<unknown> {
    const url = String(input);
    if (!url.startsWith(`${API_ORIGIN}/api/v1/`)) return Promise.reject(new Error(`The simulated tablet has no network for ${url}`));
    const route = url.slice(`${API_ORIGIN}/api/v1`.length).split("?")[0]!;
    this.requests.push(route);
    this.requestedAt.push(this.now());
    // Decaid's fetch sends a request's method, headers and body as given (plugin_manager.dart).
    const { method = "GET", headers = {}, body } = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: unknown };
    if (method.toUpperCase() !== "GET") {
      this.writes.push(`${method.toUpperCase()} ${route}`);
      const refusal = this.refuseWrites?.({ method: method.toUpperCase(), route, body: typeof body === "string" ? JSON.parse(body) : body });
      if (refusal) return Promise.resolve(response(refusal.status, JSON.stringify(refusal.body)));
      const stored = this.keptInStore(route);
      if (method.toUpperCase() === "POST" && stored) this.storeWrites.push({ ...stored, value: storedValue(body) });
    }
    return this.answer(url, method.toUpperCase(), headers, body);
  }

  /** What Decaid's API answers a request, as its plugin fetch gives it. */
  private async answer(url: string, method: string, headers: Record<string, string>, requestBody: unknown): Promise<unknown> {
    const route = url.slice(`${API_ORIGIN}/api/v1`.length).split("?")[0]!;
    const failures = method === "GET" ? (this.apiFailures.get(route) ?? 0) : 0;
    if (failures > 0) {
      this.apiFailures.set(route, failures - 1);
      return response(503, JSON.stringify({ error: "Local API temporarily unavailable" }));
    }
    const kept = this.answerStore(method, route, requestBody);
    if (kept) return response(kept.status, JSON.stringify(kept.body));
    if (method === "GET" && route === "/plugins") return response(200, JSON.stringify(this.listedPlugins()));
    if (this.dye2?.answers(route)) {
      const body = typeof requestBody === "string" ? (requestBody === "" ? null : JSON.parse(requestBody)) : (requestBody ?? null);
      const answered = await this.dye2.answer(method, route, body);
      return response(answered.status, JSON.stringify(answered.body));
    }
    // Decaid refuses a plugin's endpoints while no such plugin is loaded (`_handlePluginApiEndpoint` in plugins_handler.dart).
    if (route.startsWith("/plugins/dye2.reaplugin/")) return response(404, JSON.stringify({ error: "plugin with dye2.reaplugin not loaded" }));
    const settings = this.answerSettings(method, route, requestBody);
    if (settings) return response(settings.status, settings.text ?? JSON.stringify(settings.body));
    const written = withDecaidClock(this.decaidClockOffsetMs, () => this.writeLibrary(method, route, new URL(url).searchParams, requestBody));
    if (written) {
      return written.etag && written.status === 200 ? conditional(JSON.stringify(written.body), headers) : response(written.status, JSON.stringify(written.body));
    }
    if (method !== "GET") throw new Error(`The simulated tablet's API carries out no ${method} ${route}`);
    if ((["/machine/info", "/machine/state", "/machine/settings", "/machine/settings/advanced"].includes(route) || route.startsWith("/machine/calibration")) && !this.machineConnected) {
      // de1handler.dart answers a DeviceNotConnectedException with a 500.
      const refusal = machineNotConnected();
      return response(refusal.status, JSON.stringify(refusal.body));
    }
    const list = LIBRARY_LISTS[route];
    if (list && Array.isArray(this.api[route])) {
      const all = this.api[route] as Record<string, unknown>[];
      const include = new URL(url).searchParams.get(list.include) === "true";
      if (route === "/bean-batches") return conditional(JSON.stringify(listedBatches(this.beans(), all, include)), headers);
      return conditional(JSON.stringify(include ? all : all.filter((record) => !list.hidden(record))), headers);
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
    if ((route === "/steams/ids" || route === "/steams/latest") && (await this.steamReadsHeld.get(route))) throw new Error("Fetch timed out");
    if (method === "GET" && route === "/workflow") await this.workflowReadsHeld;
    if (method === "GET" && route.startsWith("/shots/")) await this.shotReadsHeld;
    if (route === "/steams/ids") {
      // Every id at once, unpaginated, in the order of Decaid's primary key index.
      const ids = Object.keys(this.api).filter((path) => path.startsWith("/steams/")).map((path) => decodeURIComponent(path.slice("/steams/".length)));
      const body = JSON.stringify(ids.sort());
      // Decaid's fetch reads a response only up to its limit, then fails it with this error.
      if (Buffer.byteLength(body) > this.steamIdsLimitBytes) throw new Error(`Bad state: response exceeds maxFetchResponseBytes (${this.steamIdsLimitBytes})`);
      return response(200, body);
    }
    if (route === "/steams/latest") {
      // The newest by its time, without measurements (getLatestSteamMeta in steam_dao.dart), compared as
      // written, which orders Decaid's local times; `null` while there are none.
      const steams = Object.entries(this.api).filter(([path]) => path.startsWith("/steams/")).map(([, steam]) => steam as Record<string, unknown>);
      steams.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(a.id).localeCompare(String(b.id)));
      const { measurements, ...latest } = steams[0] ?? {};
      return response(200, JSON.stringify(steams.length === 0 ? null : latest));
    }
    // The plugin's own storage, as Decaid's store API reads it.
    const [, store, namespace, key, ...rest] = route.split("/");
    if (store === "store" && namespace === encodeURIComponent(this.pluginId) && rest.length === 0) {
      return response(200, JSON.stringify(this.storage.readThroughApi(key === undefined ? undefined : decodeURIComponent(key))));
    }
    // A key of Decaid's store is read under the route its writes keep it at.
    const stored = this.keptInStore(route);
    const served = stored ? storeRoute(stored.namespace, stored.key) : route;
    const answer = this.api[served];
    if (answer instanceof Refusal) return response(answer.status, JSON.stringify(answer.body));
    // A key of plugin storage nothing has written (KvStoreHandler in kv_store_handler.dart).
    if (!(served in this.api) && stored) return response(200, "null");
    if (!(served in this.api)) return response(404, "");
    return response(200, JSON.stringify(answer));
  }

  /**
   * Carries out a settings write as Decaid v0.9.0 does (decaid-settings.ts),
   * to the machine's settings, Decaid's own or its presence settings and wake
   * schedules, keeping what it changed where `api` serves the matching `GET`,
   * or reads the presence settings, without `keepAwakeUntil` while no
   * machine is connected, or the wake schedules; undefined for any other
   * request, the machine's settings' reads included.
   */
  private answerSettings(method: string, route: string, body: unknown): SettingsAnswer | undefined {
    const presence = this.api["/presence/settings"];
    if (method === "GET" && route === "/presence/settings" && !(presence instanceof Refusal) && presence !== undefined) {
      return { status: 200, body: presenceSettings(presence, this.machineConnected) };
    }
    if (method === "GET" && route === "/presence/schedules" && !(presence instanceof Refusal) && presence !== undefined) {
      return { status: 200, body: (presence as { schedules: unknown }).schedules };
    }
    if (method === "GET") return undefined;
    const text = typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
    const failWrite: FieldWriteFailure = (field) => this.failSettingWrites?.({ route, field });
    const machine = { body: text, machineConnected: this.machineConnected, failWrite };
    // What a route holds to write to: none while it is served as a refusal, which a write then throws for.
    const held = (served: string) => (this.api[served] instanceof Refusal ? undefined : this.api[served]);
    const keep = (served: string, { answer, value }: Written) => {
      if (value) this.api = { ...this.api, [served]: value };
      return answer;
    };
    if (method === "POST" && route === "/machine/settings") return keep(route, writeMachineSettings({ ...machine, current: held(route) }));
    if (method === "POST" && route === "/machine/settings/advanced") return keep(route, writeAdvancedSettings({ ...machine, current: held(route) }));
    if (method === "POST" && route === "/machine/calibration") return keep(route, writeCalibration({ ...machine, current: held(route) }));
    const target = /^\/machine\/calibration\/([^/]+)$/.exec(route)?.[1];
    if (method === "PUT" && target !== undefined) {
      const served = `/machine/calibration/${decodeURIComponent(target)}`;
      return keep(served, writeSensorCalibration({ ...machine, target: decodeURIComponent(target), current: held(served) }));
    }
    if (method === "POST" && route === "/settings") return keep(route, writeAppSettings({ current: held(route), body: text, failWrite }));
    const presenceWrite = writePresence(method, route, text, held("/presence/settings"));
    return presenceWrite && keep("/presence/settings", presenceWrite);
  }

  /**
   * Carries out a write to the tablet's beans or bean batches as Decaid does,
   * or reads one bean, one bean's batches or one batch, and gives Decaid's
   * answer, with `etag` for a list Decaid answers with one; undefined for any
   * other request.
   */
  private writeLibrary(method: string, route: string, query: URLSearchParams, body: unknown): (DecaidAnswer & { etag?: true }) | undefined {
    if (method === "PUT" && route === "/workflow") return this.writeWorkflow(body);
    const profiles = this.writeProfiles(method, route, query, body);
    if (profiles) return profiles;
    const grinders = this.writeGrinders(method, route, body);
    if (grinders) return grinders;
    const bean = /^\/beans\/([^/]+)$/.exec(route)?.[1];
    const ofBean = /^\/beans\/([^/]+)\/batches$/.exec(route)?.[1];
    const batch = /^\/bean-batches\/([^/]+)$/.exec(route)?.[1];
    const id = decodeURIComponent(bean ?? ofBean ?? batch ?? "");
    const beans = this.beans();
    const batches = this.batches();
    const json = () => {
      if (typeof body !== "string") throw new Error("The plugin sent a write without a JSON body");
      return JSON.parse(body) as unknown;
    };
    const keep = (result: { answer: DecaidAnswer; beans?: Record<string, unknown>[]; batches?: Record<string, unknown>[] }) => {
      this.api = {
        ...this.api,
        ...(result.beans ? { "/beans": listedBeans(result.beans) } : {}),
        ...(result.batches ? { "/bean-batches": listedBatches(beans, result.batches, true) } : {}),
      };
      return result.answer;
    };
    if (method === "POST" && route === "/beans") return keep(createBean(beans, json()));
    if (bean !== undefined) {
      if (method === "GET") {
        const found = beans.find((candidate) => candidate.id === id);
        return found ? { status: 200, body: found } : { status: 404, body: { error: "Bean not found" } };
      }
      if (method === "PUT") return keep(updateBean(beans, id, json()));
      if (method === "DELETE") return keep(deleteBean(beans, batches, id));
    }
    if (ofBean !== undefined) {
      if (method === "GET") return { status: 200, body: batchesOf(batches, id, query.get("includeArchived") === "true"), etag: true };
      if (method === "POST") return keep(createBatch(beans, batches, id, json()));
    }
    if (batch !== undefined) {
      if (method === "GET") {
        const found = batches.find((candidate) => candidate.id === id);
        return found ? { status: 200, body: found } : { status: 404, body: { error: "Batch not found" } };
      }
      if (method === "PUT") return keep(updateBatch(batches, id, json()));
      if (method === "DELETE") return keep(deleteBatch(batches, id));
    }
    return undefined;
  }

  /**
   * Carries out a write to Decaid's store as KvStoreHandler does: `POST
   * /store/{namespace}/{key}` replaces the key's value with the body read as
   * JSON, and `DELETE` removes it, so that `GET` answers `null`; undefined
   * for any other request, the plugin's own storage included. The value is
   * kept where `api` serves it.
   */
  private answerStore(method: string, route: string, body: unknown): DecaidAnswer | undefined {
    const stored = this.keptInStore(route);
    if (!stored) return undefined;
    const kept = storeRoute(stored.namespace, stored.key);
    if (method === "POST") {
      this.api = { ...this.api, [kept]: storedValue(body) };
      return { status: 200, body: {} };
    }
    if (method === "DELETE") {
      const { [kept]: _deleted, ...rest } = this.api;
      this.api = rest;
      return { status: 200, body: {} };
    }
    return undefined;
  }

  /** The namespace and key of Decaid's store a route names, but for the plugin's own storage; otherwise undefined. */
  private keptInStore(route: string): { namespace: string; key: string } | undefined {
    const stored = storeKey(route);
    return stored && stored.namespace !== this.pluginId ? stored : undefined;
  }

  /**
   * Carries out `PUT /workflow` as Decaid does (decaid-workflow.ts). One that
   * takes is sent to the plugin in a `workflowUpdated` event before Decaid
   * answers, as its PluginManager broadcasts the change as the Workflow is
   * set, so the plugin hears of its own write while it awaits the answer.
   * The steam, hot water and flush settings it writes to the machine are the
   * machine's settings from then on, as `GET /machine/settings` answers them
   * (`machineSettingsWritten`), as the machine's registers hold them
   * (`machineSettingsHeld`), the flush time and temperature only on a
   * machine that keeps them (`keepsFlushSettings`).
   */
  private writeWorkflow(body: unknown): DecaidAnswer {
    const current = this.api["/workflow"];
    if (typeof current !== "object" || current === null || Array.isArray(current)) throw new Error("The simulated tablet has no Workflow to write to");
    const { answer, workflow } = updateWorkflow(current as Record<string, unknown>, typeof body === "string" ? JSON.parse(body) : body, this.machineConnected);
    if (workflow) {
      const settings = this.api["/machine/settings"];
      const written = machineSettingsWritten(current as Record<string, unknown>, workflow, this.keepsFlushSettings);
      // While the machine's settings are served as a refusal, only their read fails: the Workflow write still lands, and the refusal stays.
      if (typeof settings === "object" && settings !== null && !Array.isArray(settings) && !(settings instanceof Refusal) && Object.keys(written).length > 0) {
        this.api = { ...this.api, "/machine/settings": { ...settings, ...machineSettingsHeld(written) } };
      }
      this.setWorkflow(workflow);
    }
    return answer;
  }

  /**
   * Carries out a write to the tablet's grinders as Decaid does, or reads one
   * of them, and gives Decaid's answer; undefined for any other request,
   * the list of them included, which is served as the other lists are.
   */
  private writeGrinders(method: string, route: string, body: unknown): DecaidAnswer | undefined {
    const encoded = /^\/grinders(?:\/([^/]+))?$/.exec(route);
    if (!encoded) return undefined;
    const id = encoded[1] === undefined ? undefined : decodeURIComponent(encoded[1]);
    const grinders = this.grinders();
    const json = () => {
      if (typeof body !== "string") throw new Error("The plugin sent a write without a JSON body");
      return JSON.parse(body) as unknown;
    };
    const keep = (result: { answer: DecaidAnswer; grinders: Record<string, unknown>[] }) => {
      this.api = { ...this.api, "/grinders": listedGrinders(result.grinders) };
      return result.answer;
    };
    if (id === undefined) return method === "POST" ? keep(createGrinder(grinders, json())) : undefined;
    if (method === "GET") {
      const found = grinders.find((candidate) => candidate.id === id);
      return found ? { status: 200, body: found } : { status: 404, body: { error: "Grinder not found" } };
    }
    if (method === "PUT") return keep(updateGrinder(grinders, id, json()));
    if (method === "DELETE") return keep(deleteGrinder(grinders, id));
    return undefined;
  }

  /**
   * Carries out a write to the tablet's profiles as Decaid does, or reads
   * them or one of them, and gives Decaid's answer, with `etag` for the list;
   * undefined for any other request, and for a read of the list while the
   * tablet serves no list of them, as when a test has it fail.
   */
  private writeProfiles(method: string, route: string, query: URLSearchParams, body: unknown): (DecaidAnswer & { etag?: true }) | undefined {
    const [, , encoded, action, ...rest] = route.split("/");
    if (!route.startsWith("/profiles") || rest.length > 0 || (action !== undefined && action !== "visibility" && action !== "purge")) return undefined;
    const id = encoded === undefined ? undefined : decodeURIComponent(encoded);
    const profiles = this.profiles();
    const json = () => {
      if (typeof body !== "string") throw new Error("The plugin sent a write without a JSON body");
      return JSON.parse(body) as unknown;
    };
    const keep = (result: { answer: DecaidAnswer; profiles: Record<string, unknown>[] }) => {
      this.api = { ...this.api, "/profiles": result.profiles };
      return result.answer;
    };
    if (id === undefined) {
      if (method === "GET") return Array.isArray(this.api["/profiles"]) ? { ...listProfiles(profiles, query), etag: true } : undefined;
      return method === "POST" ? keep(createProfile(profiles, json())) : undefined;
    }
    if (action === "visibility") return method === "PUT" ? keep(setProfileVisibility(profiles, id, json())) : undefined;
    if (action === "purge") return method === "DELETE" ? keep(purgeProfile(profiles, id)) : undefined;
    if (method === "GET") return getProfile(profiles, id);
    if (method === "PUT") return keep(updateProfile(profiles, id, json()));
    if (method === "DELETE") return keep(deleteProfile(profiles, id));
    return undefined;
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
    // A socket on one of Decaid's own plugin endpoints, which the tablet's network does not carry.
    const local = this.localSocket(url);
    if (this.networkLost && !local) throw new TransportError("WebSocket connect failed: Network is unreachable");

    // Only the URL and subprotocols: Decaid cannot send custom headers.
    const socket = local ?? new WebSocket(url, protocols as string[] | undefined);
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
    if (this.networkLost && !local) {
      socket.terminate();
      throw new TransportError("WebSocket connect failed: Network is unreachable");
    }

    const record: TransportRecord = {
      handle: `simulated-${++this.nextHandle}`,
      socket,
      local: local !== undefined,
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
    let failure: string | undefined;
    if (local) {
      // Decaid's own endpoint: pushes come as text, and nothing waits on a server.
      local.on("message", (text: string) => this.enqueue(record, { type: "data", dataType: "text", data: text }, Buffer.byteLength(text)));
      local.on("close", (code: number) => {
        this.localSockets.delete(local);
        this.terminate(record, undefined, "transport_error", code);
      });
      return { handle: record.handle };
    }
    const remote = socket as WebSocket;
    this.setAwaitingServer(record, true);
    remote.on("message", (data, isBinary) => {
      this.setAwaitingServer(record, false);
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      const frame = isBinary ? undefined : parsed(buffer.toString("utf8"));
      if (!isBinary) this.received.push(frame);
      const event = isBinary
        ? { type: "data", dataType: "binary", data: buffer.toString("base64") }
        : { type: "data", dataType: "text", data: this.atServerPace(buffer.toString("utf8")) };
      this.enqueue(record, event, buffer.length);
      if (!isBinary && this.cutAfter?.(frame)) {
        this.cutAfter = undefined;
        this.terminate(record, "WebSocket error: Connection reset by peer", "transport_error");
        remote.removeAllListeners("message");
        remote.terminate();
      }
    });
    remote.on("error", (error) => {
      failure = `WebSocket error: ${error.message}`;
    });
    remote.on("close", (code, reason) => this.terminate(record, failure, "transport_error", code, reason.toString()));
    return { handle: record.handle, ...(remote.protocol ? { protocol: remote.protocol } : {}) };
  }

  /**
   * Scales the heartbeat interval in a `welcome`, and the time a
   * `settingsEdit` has left to start its write, before the plugin's 15 s
   * margin, up by `timeScale`, which the plugin's timers then scale back
   * down, so it counts both at the server's pace.
   */
  private atServerPace(text: string): string {
    if (this.timeScale === 1) return text;
    try {
      const message = JSON.parse(text) as { type?: unknown; heartbeatIntervalMs?: unknown; timeLeftMs?: unknown };
      if (message.type === "settingsEdit" && typeof message.timeLeftMs === "number") {
        // The plugin takes its 15 s margin off what it is told, so the margin is left as it is: the edit's time to start
        // its write is what is scaled.
        const toStart = (message.timeLeftMs - SETTINGS_EDIT_WRITE_MARGIN_MS) * this.timeScale;
        return JSON.stringify({ ...message, timeLeftMs: Math.max(0, Math.round(toStart + SETTINGS_EDIT_WRITE_MARGIN_MS)) });
      }
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

/**
 * A socket on one of Decaid's own plugin endpoints, in the process: it opens
 * in a later turn, hears each push as a `message` of its text, ignores what
 * is sent on it, as Decaid does, and closes in a later turn.
 */
class LocalSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly protocol = "";

  constructor() {
    super();
    setImmediate(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.emit("open");
    });
  }

  /** A push from the plugin. */
  receive(text: string): void {
    if (this.readyState === WebSocket.OPEN) this.emit("message", text);
  }

  send(_data: string, written: () => void): void {
    setImmediate(written);
  }

  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    setImmediate(() => this.emit("close", code, Buffer.from("")));
  }

  terminate(): void {
    this.close(1006);
  }
}

interface PluginScope {
  host: Record<string, unknown>;
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
  /** The plugin's `Date`, the global one by default. */
  Date?: DateConstructor;
}

/** The route of Decaid's store API for that key of that namespace, as `api` serves it. */
function storeRoute(namespace: string, key: string): string {
  return `/store/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
}

/**
 * The value a `POST` to Decaid's store keeps: its body read as JSON, as
 * KvStoreHandler reads it.
 */
function storedValue(body: unknown): unknown {
  if (typeof body !== "string") throw new Error("A write to Decaid's store came without a JSON body");
  return JSON.parse(body);
}

/** The namespace and key a route of Decaid's store API names (`/store/{namespace}/{key}`), or undefined for any other route. */
function storeKey(route: string): { namespace: string; key: string } | undefined {
  const [, store, namespace, key, ...rest] = route.split("/");
  if (store !== "store" || namespace === undefined || key === undefined || rest.length > 0) return undefined;
  return { namespace: decodeURIComponent(namespace), key: decodeURIComponent(key) };
}

/** A `Date` reading the test's clock moved by `offsetMs()`, as read when it is asked for the time. */
function pluginDate(offsetMs: () => number): DateConstructor {
  const now = () => Date.now() + offsetMs();
  return new Proxy(Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length > 0 ? args : [now()], newTarget),
    apply: () => new Date(now()).toString(),
    get: (target, property, receiver) => (property === "now" ? now : Reflect.get(target, property, receiver)),
  });
}

/** Evaluates plugin.js the way Decaid's plugin manager does. */
export function loadPlugin(source: string, manifestId: string, scope: PluginScope): BuiltPlugin {
  const factory = new Function(
    "host",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "Date",
    `${source}
    if (typeof createPlugin !== "function") {
      throw new Error("Plugin must export a 'createPlugin' function. Got: " + typeof createPlugin);
    }
    return createPlugin(host);`,
  ) as (...args: unknown[]) => BuiltPlugin;
  const plugin = factory(scope.host, scope.fetch, scope.setTimeout, scope.clearTimeout, scope.Date ?? Date);
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`createPlugin did not return an object, got: ${typeof plugin}`);
  }
  if (plugin.id !== manifestId) {
    throw new Error(`Plugin ID mismatch. Expected: ${manifestId}, Got: ${plugin.id}`);
  }
  if (typeof plugin.handleHttpRequest === "function") plugin.__httpRequestHandler = plugin.handleHttpRequest;
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

  /**
   * Connects to the sync endpoint of a server's public http(s):// URL. The
   * plugin cannot send `headers` on the upgrade request, but a reverse proxy
   * in front of the server can add them.
   */
  static async open(serverUrl: string, headers?: Record<string, string>): Promise<RawConnection> {
    const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}${SYNC_PATH}`, { headers });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const raw = new RawConnection(socket);
    opened({ end: () => raw.terminate() });
    return raw;
  }

  /**
   * Connects, sends the `hello` and resolves once the server welcomes it,
   * then keeps the connection alive with heartbeats every `heartbeatMs`.
   */
  static async welcomed(
    serverUrl: string,
    hello: Record<string, unknown>,
    heartbeatMs = 300,
    headers?: Record<string, string>,
  ): Promise<RawConnection> {
    const raw = await RawConnection.open(serverUrl, headers);
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
  async message(index: number, timeoutMs = 15_000): Promise<unknown> {
    await this.until(() => this.messages.length > index, timeoutMs, `message ${index}`);
    return this.messages[index];
  }

  /** How many times the server has acknowledged the delivery with this id. */
  acks(id: string): number {
    return this.messages.filter((message) => isAckOf(message, id)).length;
  }

  /** Resolves once the server has acknowledged the delivery with this id. */
  async acknowledged(id: string): Promise<void> {
    await this.until(() => this.acks(id) > 0, 15_000, `acknowledgment of ${id}`);
  }

  /** Sends a delivery and resolves once the server acknowledges it, again if it had before. */
  async deliver(message: { id: string; [field: string]: unknown }): Promise<void> {
    const before = this.acks(message.id);
    this.send(message);
    await this.until(() => this.acks(message.id) > before, 15_000, `acknowledgment of ${message.id}`);
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

/**
 * A list as Decaid answers it (jsonOkConditional in json_response.dart): with
 * a strong tag derived from its body, or 304 to that tag in If-None-Match.
 */
function conditional(body: string, headers: Record<string, string>) {
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
  const ifNoneMatch = Object.entries(headers).find(([name]) => name.toLowerCase() === "if-none-match")?.[1]?.trim();
  return ifNoneMatch === etag || ifNoneMatch === "*" ? response(304, "", { etag }) : response(200, body, { etag });
}

/** Whether a message the server sent is an acknowledgment: of the delivery with this id, if one is given. */
function isAckOf(message: unknown, id?: string): boolean {
  const { type, id: acked } = (message ?? {}) as { type?: unknown; id?: unknown };
  return type === "ack" && (id === undefined || acked === id);
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
