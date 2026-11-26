import type { HeldValue, MachineModel, Profile as ProfileDefinition, ProfileChecks, ProfileText, ProfileTextField, SourceSeen } from "@decent-sync/protocol";
import { noteServerBuild } from "@/lib/build";
import type { LibraryKind } from "@/lib/library-kinds";

// The management interface uses only the server's REST API, the same one any
// other client uses. The session cookie travels with every same-origin request.

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
    /** The refusal's body as the server sent it, such as the existing Bean a new one duplicates. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const refusalListeners = new Set<() => Promise<void>>();

/**
 * Calls `listener` whenever the server refuses a request with 401 or 403,
 * since the session may have ended or its account's role or Locations
 * changed. The request's caller sees the refusal only once the promise it
 * returns settles. Returns a function that removes it.
 */
export function onRefusal(listener: () => Promise<void>): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

/**
 * Sends a request to the REST API. Its refusals with 401 or 403 go to the
 * `onRefusal` listeners first, unless `reportRefusal` is false for a request
 * whose refusal answers it alone, such as signing in with a wrong password.
 * `keepalive` lets the request outlive the page, as a save sent as it closes.
 */
export async function api<T>(method: string, path: string, body?: unknown, { reportRefusal = true, keepalive = false } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    keepalive,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  noteServerBuild(response);
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    if (reportRefusal && (response.status === 401 || response.status === 403)) {
      await Promise.allSettled([...refusalListeners].map((listener) => listener()));
    }
    throw new ApiError(response.status, errorMessage(data) ?? response.statusText, data);
  }
  return data as T;
}

// Nest reports problems as { message: string | string[] }.
function errorMessage(data: unknown): string | undefined {
  const message = (data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message)) return message.join(". ");
  return typeof message === "string" ? message : undefined;
}

/**
 * An Admin changes everything, Staff the Library's shared content anywhere and more at their Locations, and a Viewer
 * sees what Staff see and changes nothing.
 */
export type Role = "admin" | "staff" | "viewer";

export interface Account {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * The Locations a Staff member works at, where they may move Machines; none for an Admin, who may change anything
   * anywhere, or a Viewer, who changes nothing.
   */
  locations: Location[];
}

/** An account as an Admin managing accounts sees it. */
export interface ManagedAccount extends Account {
  /** When an Admin deactivated it; null while it is active. */
  deactivatedAt: string | null;
}

/** A newly issued password reset link, which the server returns only once. */
export interface IssuedPasswordReset {
  account: ManagedAccount;
  link: string;
  expiresAt: string;
}

/** A password reset link, as whoever opens it sees it: whose password it sets, and until when. */
export interface PasswordReset {
  name: string;
  email: string;
  expiresAt: string;
}

/** An invite: a one-time link that creates an account, as an Admin, as Staff at chosen Locations, or as a Viewer. */
export interface Invite {
  id: string;
  /** The email its account will sign in with. */
  email: string;
  role: Role;
  /** The Locations a Staff member will work at; none for an Admin, who sees every Location, or a Viewer. */
  locations: Location[];
  createdAt: string;
  expiresAt: string;
}

/** A newly created invite and its link, which the server returns only once. */
export interface CreatedInvite {
  invite: Invite;
  link: string;
}

/** An assistant app, such as Claude, that a person allowed to read, or to read and change, as them (ADR-0027). */
export interface ConnectedApp {
  id: string;
  /** The name the app gave itself as it was approved. */
  name: string;
  /** The host its client id is published at, which, unlike the name, no other app can give. */
  host: string;
  /** What it may do now: `read`, and `change` if it was allowed to and its account is not a Viewer. */
  scopes: string[];
  approvedAt: string;
  /** Recorded at most once an hour. */
  lastUsedAt: string;
}

/** A Connected App as an Admin sees every account's: also whose it is. */
export interface AccountConnectedApp extends ConnectedApp {
  account: { id: string; name: string; email: string };
}

export interface Location {
  id: string;
  name: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
  /**
   * Whether Drafts may be tried here (#581), as the Locations list gives it: only its Machines can follow a Draft.
   * Absent where a Location is named beside something else, and from the previous release's answer during a deploy (ADR-0025).
   */
  triesDrafts?: boolean;
}

/** How a Machine's identity stands: decided at each connection, or by an Admin entering its hardware. */
export type Identification = "identified" | "hardwareNotReported" | "unidentified" | "mismatch";

export interface Machine {
  id: string;
  name: string;
  /** The hardware its token is bound to, or null until a connection reports it or an Admin enters it. */
  model: string | null;
  serial: string | null;
  identification: Identification;
  /**
   * The hardware the latest connection that reported any did: the Machine's
   * own, the other hardware of a mismatch, or an Unidentified Machine's "0".
   */
  reported: { model: string; serial: string; firmware: string | null } | null;
  /** The connection id and versions of the latest accepted connection. */
  connectionId: string | null;
  pluginVersion: string | null;
  decaidVersion: string | null;
  /** Connection ids known to be this Machine's, oldest first. */
  aliases: string[];
  /** While a mismatch: the hardware reported, and the Pending Machine or Machine that has it. */
  mismatch: {
    model: string;
    serial: string;
    pendingMachineId: string | null;
    machine: { id: string; name: string } | null;
  } | null;
  /** Why a connection with its token was last refused, until one is accepted. */
  lastRefusal: { reason: string; at: string } | null;
  /**
   * The latest time a connection with its token took it over from a live
   * connection from another tablet, or null if none ever has.
   */
  takeover: Takeover | null;
  online: boolean;
  lastSeenAt: string | null;
  /**
   * The Shot it pulled last, with the Recipe it was pulled with, its duration in seconds and how it stands against the
   * margins (#543); those three are absent from the previous release's answer during a deploy (ADR-0025).
   */
  lastShot: { id: string; pulledAt: string | null; recipe?: NamedLink | null; duration?: number | null; spec?: ShotSpec } | null;
  /** What it is doing: the latest machine state its tablet reported, or null before any. */
  machineState: MachineState | null;
  /** The Recipe its Workflow has loaded, since when, or null for none. */
  loadedRecipe: LoadedRecipe | null;
  /** Where it is now: the Location of its Location History's latest entry, or null if it has none. */
  location: Location | null;
  /** Where it has been, oldest first. Each entry lasts until the next one's time. */
  locationHistory: LocationHistoryEntry[];
  /** Whether it shares the Library at its Location: on unless an Admin turned it off, making it a Capture-only Machine. */
  sharing: boolean;
  /** Why it is a Capture-only Machine, taking no part in the Library; empty while it takes part. */
  captureOnly: CaptureOnlyReason[];
  /** The tablet its latest connection came from, or null before any. A reset or replaced tablet is a new one. */
  tablet: Tablet | null;
  /** The tablets its connections came from before, the one whose connection was accepted most recently first. */
  earlierTablets: Tablet[];
}

/** Why a Machine is a Capture-only Machine: it has no Location, or an Admin turned its sharing off. */
export type CaptureOnlyReason = "noLocation" | "sharingOff";

/** A change the server makes to a tablet: a write of an item or the Workflow, a delete, a removal from one of DYE2's lists, or setting aside a record. */
export interface TabletChange {
  change: "write" | "delete" | "remove" | "leaveOut";
  /**
   * A Library kind, `workflow` (its Workflow's grinder and batch) or
   * `loadedRecipe` (its Workflow's Loaded Recipe, named by the Recipe).
   */
  kind: ItemKind | "workflow" | "loadedRecipe" | "draft";
  /** The item, named as its page names it, a Loaded Recipe as its Recipe; null for a record set aside, which is none of the Library's, or an item deleted since. */
  item: { kind: ItemKind | "workflow" | "loadedRecipe" | "draft"; id: string; name: string | null } | null;
  /** Decaid's id for the tablet's record; null for a create, a Workflow or a Loaded Recipe. */
  localId: string | null;
}

/** How a Machine's sharing is going, for the tablet of the connection holding it, or else of its latest connection. */
export interface SharingStatus {
  /** That tablet, or null if none has connected. */
  tabletId: string | null;
  /** The changes waiting for it, offline or not, but those it refused; null while it is written nothing, as it is capture-only. */
  waiting: number | null;
  /** The last change it applied, and when; null if none. */
  lastApplied: (TabletChange & { appliedAt: string }) | null;
  /** The changes it refused that are still due, the latest refused first, each with Decaid's HTTP status, null if it gave none (it did not answer, the plugin did not ask it, or the server could not take in its answer), and its answer or why. */
  refused: (TabletChange & { status: number | null; error: string; refusedAt: string })[];
  /** DYE2's lists the tablet holds in a shape that is not recognised, which nothing is written to, each by its collection's name, and since when. */
  unrecognisedLists: { list: string; since: string }[];
}

/** One tablet taking a Machine over from another, both connected with its token. */
export interface Takeover {
  /** When the connection that took over was accepted. */
  at: string;
  /** The connection replaced, which was still connected. */
  replaced: TakeoverConnection;
  /** The connection that took over. */
  replacement: TakeoverConnection;
}

/** A connection in a takeover: its tablet, the address it came from, and what its plugin reported. */
export interface TakeoverConnection {
  tabletId: string;
  remoteAddress: string;
  connectionId: string | null;
  pluginVersion: string;
  decaidVersion: string;
}

/** A tablet a Machine's connections came from: a device running Decaid, with its Decaid data. */
export interface Tablet {
  /** The id its plugin made on its first run. */
  id: string;
  /** When a connection from it to this Machine was first accepted. */
  firstSeenAt: string;
  /** When one was last accepted, or last sent a heartbeat. */
  lastSeenAt: string;
}

/** A machine state as Decaid names it, such as espresso and preinfusion, and when the plugin observed it. */
export interface MachineState {
  state: string;
  substate: string;
  observedAt: string;
}

/** A Workflow a Machine's tablet reported: what it is set up to do next. */
export interface WorkflowEvent {
  id: string;
  /** When the plugin observed it, by the tablet's clock. */
  observedAt: string;
  receivedAt: string;
  /** Decaid's Workflow, as sent; any part may be missing. */
  workflow: Record<string, unknown>;
}

/** One entry of a Machine's Location History. */
export interface LocationHistoryEntry {
  id: string;
  location: Location;
  /** When the Machine arrived there. */
  effectiveFrom: string;
}

/** Hardware the server has seen that no Machine has, for an Admin to adopt or dismiss. */
export interface PendingMachine {
  id: string;
  model: string;
  serial: string;
  firstSeenAt: string;
  lastSeenAt: string | null;
  dismissed: boolean;
  /** Machines whose token's connection reports this hardware as a mismatch. */
  mismatchedMachines: { id: string; name: string }[];
}

/** A newly issued Machine token, returned only once, with the server URL to enter beside it. */
export interface IssuedToken {
  machine: Machine;
  token: string;
  serverUrl: string;
}

/**
 * A delivery from a Machine's tablet that the server could not store, and
 * would fail to store the same way if it was sent again, so it was set aside
 * as sent. It is never listed with what it carried.
 */
export interface SetAsideDelivery {
  id: string;
  /** When it was set aside. */
  receivedAt: string;
  /** The message's type, such as shot or collection. */
  type: string;
  deliveryId: string;
  /** The Decaid id of a Shot's or Steam Record's; null for other deliveries. */
  recordId: string | null;
  /** PostgreSQL's error code, such as 22P05, and its message. */
  sqlState: string;
  error: string;
}

/** One page of a Machine's deliveries set aside, latest first, and how many there are. */
export interface SetAsideDeliveryPage {
  deliveries: SetAsideDelivery[];
  total: number;
  limit: number;
  offset: number;
}

/** A collection a Machine's tablet reports (its library, settings or paired devices), as last reported, without its value. */
export interface CollectionSummary {
  name: string;
  /** Whether the latest report had a value: false while, say, no scale is connected. */
  available: boolean;
  /** When the latest report, available or not, arrived. */
  reportedAt: string;
  /** When the value arrived; null if no report has had one. */
  receivedAt: string | null;
  /** How many entries the value lists, if it is a list. */
  items: number | null;
}

/** A collection with the latest value reported, as Decaid sent it, which later unavailable reports keep. */
export interface Collection extends CollectionSummary {
  value: unknown;
  /** For `appSettings` and `presenceSettings`, the Tablet's UTC offset as the value was read, in minutes east of UTC, which its times are in; otherwise null. */
  utcOffsetMinutes: number | null;
}

/** Why a Settings Edit was refused, and what the Tablet said of it. */
export type SettingsEditRefusal =
  | { reason: "machineBusy"; state: string | null }
  /** The edit's fields as the Tablet held them, changed since the report it was made over. */
  | { reason: "changedSince"; current: Record<string, unknown> | null }
  | { reason: "expired" }
  /** Decaid's status, null where it did not answer or was not asked, its message, and the fields it changed before refusing. */
  | { reason: "decaid"; status: number | null; message: string | null; changed: string[] };

/** A Settings Edit (ADR-0023): a change of a Machine's settings made here, sent to its Tablet at once, and what came of it. */
export interface SettingsEdit {
  id: string;
  machineId: string;
  collection: string;
  /** For the presence settings, the wake schedule it adds, changes or deletes, if it does: for an add, the new schedule's id once its answer gave it. */
  schedule: { action: "add" | "change" | "delete"; id: string | null } | null;
  /**
   * Each field it sets with its new value, and each field's value in the
   * report it was made over; for a wake schedule's change or delete, the
   * whole schedule as reported.
   */
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
  /** Who made it: named to Admins, and to Staff by its id only. */
  account: { id: string; name: string | null } | null;
  /**
   * The Connected App, such as an assistant, it was made through; null for
   * one made here. Absent from the previous release's answer during a deploy
   * (ADR-0025).
   */
  connectedApp?: { id: string; name: string; host: string } | null;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  /**
   * Null while it awaits the Machine's answer; `notConfirmed` once the
   * Machine has not answered within a minute, or its connection closed
   * first, until an answer arriving later replaces it.
   */
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  /** Whether its outcome came from an answer that arrived after it was marked not confirmed. */
  late: boolean;
  /** For `adjusted`: each field the Machine stored otherwise, with what it holds, if it was read back. */
  adjusted: { field: string; holds?: unknown }[];
  refusal: SettingsEditRefusal | null;
  /** The edit's fields as read back after its write, or as the Tablet held them when it was refused as changed since. */
  readBack: Record<string, unknown> | null;
}

/** One field's change in a Machine's Settings History, as compared: a wake schedule's fields, a sensor calibration's measured value, a paired device without how it is connected. */
export interface SettingsHistoryField {
  /** A field's name, as Decaid names it; `schedules/<id>` for a wake schedule; a target of the sensor calibration; a plugin's, paired device's or sensor's id. */
  field: string;
  change: "added" | "changed" | "removed";
  /** Null where absent. */
  before: unknown;
  after: unknown;
  /** For a brief change, made outside Decent Sync and changed back within about 2 minutes, when it changed back; null for any other. */
  backAt: string | null;
}

/**
 * An entry of a Machine's Settings History with its Settings Edits (#545): a
 * change, with the Settings Edit that made it, if one did, or a Settings
 * Edit that changed nothing.
 */
export interface SettingsHistoryEntry {
  /** When the server received the change, or when a Settings Edit that changed nothing was made. */
  at: string;
  collection: string;
  /** The change, by its value's id; null for a Settings Edit that changed nothing. */
  change: { id: string; fields: SettingsHistoryField[] } | null;
  /** The Settings Edit that made the change, or that changed nothing, with what came of it; null for a change made outside Decent Sync. */
  settingsEdit: SettingsEdit | null;
  /**
   * The Software Action whose read-back made the change (ADR-0034); null for
   * any other change. Absent from the previous release's answer during a
   * deploy (ADR-0025).
   */
  softwareAction?: SoftwareAction | null;
}

export interface SettingsHistoryEntryPage {
  entries: SettingsHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * How a plugin or Skin updates, shown and never switched: from a GitHub
 * repository's latest release, a branch's head, a commit or a URL naming a
 * commit's archive or one release's download, with its `tag` (Pinned), any
 * other URL, as one that comes with Decaid, or not at all.
 */
export type SoftwareUpdates =
  | { how: "followsReleases"; repo: string | null }
  | { how: "followsBranch"; repo: string | null; branch: string }
  | { how: "pinned"; repo: string | null; commit: string | null; tag?: string; url: string | null }
  | { how: "followsUrl"; url: string }
  | { how: "comesWithDecaid"; repo: string | null }
  | { how: "notUpdated" };

/** A setting a plugin declares, with what the Tablet holds for it. */
export interface PluginSetting {
  name: string;
  kind: "text" | "number" | "switch" | "choice";
  label: string;
  description: string | null;
  /** Its value is never reported, only whether one is set. */
  secret: boolean;
  choices: string[];
  default: unknown;
  /** To Admins only: a value, null for one not set, or `{ isSet }` for a secret; absent to anyone else, and until reported. */
  value?: unknown;
  /** Whether a Software Action may change it: of Decent Sync's own plugin, only its poll interval. */
  changeable: boolean;
}

export interface TabletPlugin {
  id: string;
  name: string | null;
  version: string | null;
  /** `notLoaded`: to load as Decaid starts, but not loaded now. */
  state: "enabled" | "disabled" | "notLoaded";
  updates: SoftwareUpdates;
  /** Where Decaid says it came from and the build it is at: what a change of how it updates is made over. */
  build: SourceSeen;
  /** What the latest update check said went wrong, in Decaid's words. */
  lastError: string | null;
  /** An update that waits for someone to approve the permissions it adds. */
  pendingUpdate: { version: string | null; addedPermissions: string[] } | null;
  permissions: string[];
  /** Decent Sync's own plugin, which is never disabled or removed from here. */
  own: boolean;
  settings: PluginSetting[];
}

export interface TabletSkin {
  id: string;
  name: string | null;
  version: string | null;
  default: boolean;
  /** Whether Decaid's Skin server is serving it now. */
  served: boolean;
  updates: SoftwareUpdates;
  /** Where Decaid says it came from and the build it is at: what a change of how it updates is made over. */
  build: SourceSeen;
  /** Whether it may be removed: it is neither the default, nor the one served, nor one that comes with Decaid. */
  removable: boolean;
  /** Whether it is served now and has reported the page it shows, so that it can be asked to reload. */
  pageReported: boolean;
}

/**
 * What the Tablet shows (#661): the Skin served now, the page it reported
 * showing where it reports one, and the default Skin where a restart of the
 * Skin view would show another.
 */
export interface TabletShowing {
  /** The Skin Decaid's Skin server serves now, with the version installed; null while it serves none. */
  skin: { id: string; name: string | null; version: string | null } | null;
  /** The page that Skin last reported, by the Tablet's clock; null where it reported none. */
  page: { version: string | null; loadedAt: string; reportedAt: string } | null;
  /** Whether the version installed is another than the one its page reported, so that a reload is due. */
  newerInstalled: boolean;
  /** The default Skin where it is not the one served: it shows once the Skin view restarts. */
  nextDefault: { id: string; name: string | null } | null;
}

/** A Machine's Tablet Software: Decaid, its plugins and its Skins, as its Tablet last reported them. */
export interface TabletSoftware {
  decaid: {
    version: string | null;
    build: string | null;
    /** Decaid's own update state: `phase` as Decaid names it, such as idle, checking, available or error. */
    update: { phase: string | null; latestVersion: string | null; installable: boolean; error: string | null; reportedAt: string } | null;
    /** Null until reported. */
    automaticUpdateCheck: boolean | null;
  };
  /** Null until the Tablet reports them. */
  plugins: TabletPlugin[] | null;
  skins: TabletSkin[] | null;
  /** Null until the Tablet reports its Skins; absent from the previous release's answer during a deploy (ADR-0025). */
  showing?: TabletShowing | null;
  /** Always false from this release's server; true from the previous release's for a plugin from before Software Actions. */
  pluginMustUpdate: boolean;
  /**
   * Whether the Tablet's plugin carries out a change of how a plugin or Skin
   * updates: false for one of the previous release, which must update first.
   * Absent from the previous release's answer during a deploy (ADR-0025).
   */
  takesSourceChanges?: boolean;
}

/**
 * Where a plugin or Skin can be pinned to hold it at the build installed
 * now, found through GitHub: what an install names for it, null where
 * nothing matches, with the release tag or commit it would be held at, and
 * why GitHub could not be asked where it could not.
 */
export interface PinnedSource {
  source: { repo: string; branch: string } | { url: string } | null;
  tag: string | null;
  commit: string | null;
  unavailable: string | null;
  /** The item's source and build this was worked out from, as its row's `build`. */
  build: SourceSeen;
}

/** A source the account's other Machines' plugins were installed from, for the install form. */
export interface PluginSource {
  pluginId: string;
  name: string | null;
  version: string | null;
  repo: string;
  /** The branch or commit an install names; null for the latest release. */
  branch: string | null;
  updates: SoftwareUpdates;
  machines: number;
}

/**
 * A source the account's other Machines' Skins were installed from, for the
 * Skin install form: a repository, with its branch for one that follows one,
 * or a URL.
 */
export interface SkinSource {
  skinId: string;
  name: string | null;
  version: string | null;
  /** The repository an install names, null for one from a URL. */
  repo: string | null;
  /** The branch it follows; null for the latest release or a URL. */
  branch: string | null;
  url: string | null;
  updates: SoftwareUpdates;
  machines: number;
}

/** Why a Software Action was refused. */
export type SoftwareActionRefusal =
  | { reason: "machineBusy"; state: string | null }
  | { reason: "changedSince"; message: string | null }
  | { reason: "expired" }
  | { reason: "notAllowed"; message: string | null }
  /** The source a change of how an item updates named held another plugin or Skin, in the plugin's words. */
  | { reason: "differentItem"; message: string | null }
  /** Android's permission for Decaid to install apps is not granted at the Tablet, with Decaid's words. */
  | { reason: "installNotPermitted"; message: string | null }
  /** The Skin view was stopped and did not start again, so the Tablet shows no Skin, with why. */
  | { reason: "noSkinServed"; message: string | null }
  /** Decaid's status, null where it did not answer or was not asked, and its words. */
  | { reason: "decaid"; status: number | null; message: string | null };

/** Something done to a Tablet's software through the server (ADR-0034), kept with who asked and what came of it. */
export interface SoftwareAction {
  id: string;
  machineId: string;
  /**
   * installPlugin, enablePlugin, disablePlugin, changePluginSettings,
   * checkPluginUpdates, approvePluginUpdate, removePlugin,
   * changePluginSource, installSkin, chooseDefaultSkin, checkSkinUpdates,
   * removeSkin, changeSkinSource, reloadSkin, restartSkinView,
   * checkDecaidUpdate or startDecaidUpdate; another for a later release's.
   */
  kind: string;
  /** What it names: never a setting's value. */
  params: {
    plugin?: { id: string; name: string | null };
    /** The Skin it acts on, with its name as the Tablet reported it then. */
    skin?: { id: string; name: string | null };
    repo?: string;
    branch?: string | null;
    /** The URL a Skin is installed from. */
    url?: string;
    /** For a change of how an item updates: its version and source as its Tablet reported them when it was made. */
    expected?: Record<string, string | null>;
    version?: string;
    addedPermissions?: string[];
    settings?: string[];
  };
  /** Named to Admins, and to anyone else by its id only. */
  account: { id: string; name: string | null } | null;
  connectedApp: { id: string; name: string; host: string } | null;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  /** Null while it awaits its answer; `notConfirmed` once no longer awaited, until a late answer replaces it. */
  outcome: "done" | "refused" | "notConfirmed" | null;
  /** For one the plugin answered as not confirmed: what did not show, in its words. Absent from the previous release's answer during a deploy. */
  note?: string | null;
  late: boolean;
  refusal: SoftwareActionRefusal | null;
  /** What came of it, once done. */
  result: {
    pluginId?: string;
    /** The Skin installed, made the default or removed, or the one served once the Skin view restarted. */
    skinId?: string;
    /** The plugin's or Skin's name, as its Tablet listed it. */
    name?: string;
    version?: string;
    /** For a change of how an item updates: its version before. */
    previousVersion?: string;
    /** For a change of how a plugin updates: the permissions its new build adds, held with no approval asked. */
    addedPermissions?: string[];
    loaded?: boolean;
    /**
     * An update check's result for each plugin or Skin: updated,
     * alreadyCurrent, pendingApproval or failed. A Skin that comes with
     * Decaid is named by its repository (owner/name), any other by its id.
     */
    results?: { item: string; status: string; error?: string; version?: string }[];
    /** The fresh page a Skin reported once asked to reload. */
    page?: { skinId: string; version?: string; loadedAt: string };
    /** Decaid's update state after a check for its own update, or once its update started. */
    decaid?: Record<string, unknown>;
  } | null;
}

export interface SoftwareActionPage {
  softwareActions: SoftwareAction[];
  total: number;
  limit: number;
  offset: number;
}

/** A device paired with a Machine's tablet. */
export interface PairedDevice {
  /** Decaid's id for it, such as a Bluetooth address. */
  id: string;
  /** Decaid's kind of device: machine, scale or sensor. */
  type: string | null;
  /** As Decaid names it, which names its model. */
  model: string | null;
  vendor: string | null;
  /** Decaid's connection state when last reported, such as connected. */
  state: string | null;
  firmware: string | null;
  /** A percentage. */
  batteryLevel: number | null;
}

/** A Machine's paired devices, as its tablet last reported them. */
export interface PairedDevices {
  /** When its tablet last reported them, whether or not it could read them then; null until it reports them. */
  reportedAt: string | null;
  /** Whether it could read them then; if not, those shown are from `receivedAt`. */
  available: boolean | null;
  receivedAt: string | null;
  scale: PairedDevice | null;
  auxiliaryScale: PairedDevice | null;
  sensors: PairedDevice[];
  others: PairedDevice[];
}

/** DYE2 on a Machine's tablet, from Decaid's plugin list as last reported. */
export type TabletDye2 =
  | { status: "notReported" }
  | { status: "notInstalled" }
  /** Loaded, or installed but disabled or failed to load; `branch` names the branch of a branch install. */
  | { status: "installed"; version: string | null; loaded: boolean; branch: string | null };

/** Streamline, or Streamline Cafe built on it, on a Machine's tablet, if it is the Skin Decaid serves, from its Skins as last reported. */
export type TabletStreamline =
  | { status: "notReported" }
  | { status: "notInstalled" }
  /** Installed, but another Skin is the one served, or none is. */
  | { status: "notActive"; activeSkin: { name: string | null; version: string | null } | null }
  /**
   * A release (`streamline.js`, `streamline-cafe.js`) or a build of `main` (`streamline.js-dist`,
   * `streamline-cafe.js-dist`), with the Streamline version it is or contains. `skin` and `streamlineVersion` are
   * absent from the previous release's answer during a deploy (ADR-0025), which knows only Streamline.
   */
  | { status: "active"; skin?: "streamline" | "streamlineCafe"; version: string | null; build: "release" | "main"; streamlineVersion?: string | null };

export interface TabletVersions {
  dye2: TabletDye2;
  streamline: TabletStreamline;
}

/** A Shot as the Shots list shows it: what it recorded and how it was credited, without its record or curves. */
export interface ListedShot {
  id: string;
  /** When it was pulled; null when its record does not say. */
  pulledAt: string | null;
  /** The Machine it is credited to, or else the Pending Machine holding it. */
  machine: { id: string; name: string } | null;
  pendingMachine: { id: string; model: string; serial: string } | null;
  /** Credited to the Machine whose tablet reported it, since it recorded no hardware. */
  machineInferred: boolean;
  /** Where its Machine was when it was pulled; null when unknown, and its times are then in UTC. */
  location: Location | null;
  /** Its Location came through an inferred Machine. */
  locationInferred: boolean;
  profileTitle: string | null;
  /** The Bean as the Shot recorded it. */
  coffeeRoaster: string | null;
  coffeeName: string | null;
  targetDose: number | null;
  actualDose: number | null;
  targetYield: number | null;
  actualYield: number | null;
  /** In seconds. */
  duration: number | null;
  enjoyment: number | null;
  barista: string | null;
  peakPressure: number | null;
  peakFlow: number | null;
  /**
   * In seconds, from the start of its profile to when its coffee first reached the cup, as its scale shows it; null where
   * its scale never read 1 g, as without a scale, and until the server has worked it out. Absent from the previous release's answer during a deploy
   * (ADR-0025).
   */
  timeToFirstDrip?: number | null;
  /**
   * The step of its Profile it ended in; null when it stopped in its Preheat or its samples name no step. A list gives it
   * as stored, so null too until the server has worked it out, and absent from the previous release's rows during a
   * deploy (ADR-0025); a Shot read on its own gives it from its samples.
   */
  lastStep?: { frame: number; name: string } | null;
  /** The Library's Bean Batch it used, through its tablet's ids; null until its tablet's batch is in the Library. */
  beanBatch: BatchLink | null;
  /** The Library's Grinder it used, the same way. */
  grinder: GrinderLink | null;
  /** The Library's Profile it was pulled with: the one its Workflow's profile hashes to, as Decaid's ids do. */
  profile: ProfileLink | null;
  /** The Library's Recipe it was pulled with: the one its Workflow named as loaded, where its Machine had it loaded then. */
  recipe: NamedLink | null;
  /** The Library's Basket DYE2 recorded for it, through its tablet's ids, as the Bean Batch is. */
  basket: NamedLink | null;
  /** The Grinder's model and the Basket's name as it recorded them, linked to the Library or not. */
  grinderModel: string | null;
  basketName: string | null;
  grinderSetting: string | null;
  /** What stopped it, as Decaid recorded it. */
  stopReason: string | null;
  /** How it stands against the margins (#543). Absent from the previous release's answer during a deploy (ADR-0025). */
  spec?: ShotSpec;
  /** As typed on the tablet. */
  notes: string | null;
  /** Total dissolved solids, in %. */
  tds: number | null;
  /** In %. */
  extractionYield: number | null;
  /**
   * The Recipes it is the Reference Shot of (ADR-0029), Archived or not, by name; given only where there are any, and
   * never by the previous release during a deploy (ADR-0025).
   */
  referenceOf?: (NamedLink & { location: Location | null })[];
}

/**
 * How a Shot stopped, of the stop reason Decaid recorded: at its target weight or volume, which are stopped at target
 * (GLOSSARY.md), by hand, by the Machine itself, by an error, or `other`, any other reason, which `stopReason` gives.
 */
export type StopKind = "targetWeight" | "targetVolume" | "byHand" | "machineEnded" | "error" | "other";

/**
 * One Shot against the margins (#543; GLOSSARY.md, Out of spec), as the server judges it. An Unfinished Shot and a
 * cleaning or calibration Shot are not judged: their `duration` and `yield` are null.
 */
export interface ShotSpec {
  unfinished: boolean;
  cleaningOrCalibration: boolean;
  /** Its duration less its Recipe's Reference Shot's, in seconds, and whether that is out of spec; null with no such Shot to compare. */
  duration: { difference: number; outOfSpec: boolean } | null;
  /** Its yield weighed less its own target, in grams, and whether that is out of spec; null with no target, or no yield. */
  yield: { againstTarget: number; outOfSpec: boolean } | null;
  /** How it stopped; null where it recorded no stop reason. */
  stopped: StopKind | null;
}

/** A Library Bean Batch a Shot is linked to: its Bean and roast date, as the Bean Batches list names them. */
export interface BatchLink {
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  roastDate: string | null;
}

/** A Library Grinder a Shot is linked to. */
export interface GrinderLink {
  id: string;
  model: string | null;
}

/** A Library Profile a Shot was pulled with. */
export interface ProfileLink {
  id: string;
  title: string | null;
}

/** A Library Recipe a Shot was pulled with, or a Basket it used, by its name. */
export interface NamedLink {
  id: string;
  name: string | null;
}

/** One page of a Shots list, and how many Shots the whole list has. */
export interface ShotPage {
  shots: ListedShot[];
  total: number;
  limit: number;
  offset: number;
}

/** An edit of a Shot's rating or note made through the server (ADR-0031): in the management interface, through a Connected App, or on a tablet that doesn't hold the Shot. */
export interface ShotEdit {
  id: string;
  /** The fields it set, with the values it set them to: a rating, 0 for unrated, a note, empty for none, or both. */
  fields: { rating?: number; note?: string };
  /** The account that made it: named to Admins, and to Staff and Viewers by its id only; null for one made on a Machine's tablet, and once the account is gone. */
  account: { id: string; name: string | null } | null;
  /** The Machine whose tablet it was made on, and that tablet's id; each null for an account's, and once the Machine or tablet is gone. */
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  /** The Connected App, such as an assistant, the account made it through; null for the management interface. */
  connectedApp: { id: string; name: string; host: string } | null;
  madeAt: string;
  /**
   * Where it stands with the tablet that holds the Shot: awaiting it;
   * written to it; dropped, never written, as the tablet changed every field
   * it set later; or with no tablet to reach, as that tablet no longer holds
   * the Shot.
   */
  state: "awaitingTablet" | "written" | "dropped" | "noTablet";
  /** The fields it set that were not written, as the tablet changed them later than it was made. */
  dropped: ("rating" | "note")[];
  writtenAt: string | null;
}

/** A Shot with its Decaid record, without measurements, as stored. */
export interface Shot extends ListedShot {
  record: Record<string, unknown>;
  /**
   * The edits of its rating and note made through the server, newest first, and where they stand with the tablet that
   * holds it: an edit awaits that tablet, the latest found it no longer holding the Shot, or neither. Both absent from
   * the previous release's answer during a deploy (ADR-0025).
   */
  edits?: ShotEdit[];
  editStanding?: "awaitingTablet" | "noTablet" | null;
  /**
   * The scale's weight flow at its last weight sample, in g/s; null without one, and until the server has worked it out.
   * Absent from the previous release's answer during a deploy (ADR-0025).
   */
  flowAtStop?: number | null;
  /** The Shot pulled just before it on the same Machine, or held by the same Pending Machine. */
  previousShot: { id: string; pulledAt: string } | null;
}

/** A number of a Shot Summary: its median with the 25th and 75th percentiles, and how many Shots had a value; each null where none had. */
export interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

/** A rating of a Shot Summary: the median of the ratings given, and the part of the group's Shots rated, from 0 to 1. */
export interface RatingNumber extends SummaryNumber {
  rated: number | null;
}

/** A number of a Shot Summary with the lowest and highest of its Shots' values. */
export interface RangedNumber extends SummaryNumber {
  lowest: number | null;
  highest: number | null;
}

/** The steps of their Profiles a summary's Shots ended in: how many ended in one, and the steps most of them did, each with how many. */
export interface LastSteps {
  shots: number;
  mostCommon: { frame: number; name: string | null; shots: number }[];
}

/** Each number a Shot Summary can give: a group gives those asked for. */
export interface SummaryNumbers {
  /** Yield weighed less target yield, in grams. */
  yieldAgainstTarget: SummaryNumber;
  /** In seconds, without the Preheat, as the list shows it. */
  duration: SummaryNumber;
  /**
   * Stopped at target (GLOSSARY.md): of the Shots that recorded a stop reason, how many there are, how many Decaid
   * stopped at their target weight or volume, that part of them, from 0 to 1, and how many of the rest stopped each
   * other way.
   */
  stoppedAtTarget: { shots: number; share: number | null; atTarget: number; byHand: number; machineEnded: number; error: number; other: number };
  /** Yield weighed over dose weighed. */
  ratio: SummaryNumber;
  /** In bar and ml/s, without the Preheat. */
  peakPressure: SummaryNumber;
  peakFlow: SummaryNumber;
  /** Enjoyment as rated on the tablet, 0 to 10, where above 0. */
  rating: RatingNumber;
  /** Where the setting recorded is a decimal number. */
  grindSetting: RangedNumber;
  /** In %. */
  tds: SummaryNumber;
  extractionYield: SummaryNumber;
  /** Seconds from the start of the profile to when its coffee first reached the cup. */
  timeToFirstDrip: SummaryNumber;
  lastStep: LastSteps;
}

/**
 * What a Shot Summary's group is grouped by: an entry for each grouping asked for, of which the management interface
 * asks for a Recipe and a Machine, and none without one. A Recipe's is null for the group of Shots pulled with none.
 */
export interface GroupedBy {
  /** The Machine the Shots are credited to; null where a Pending Machine holds them, which is at no Location. */
  machine?: { id: string; name: string } | null;
  /** The Recipe the Shots were pulled with, and the Location it belongs to. */
  recipe?: { id: string; name: string | null; location: { id: string; name: string } | null } | null;
}

/**
 * The server's judgement of a group's Shots against a margin (GLOSSARY.md, Out of spec): within spec, out of spec, or
 * not judged, for want of Shots with a value. `beyondMargin` says whether what they have is beyond the margin, judged
 * or not; null with nothing to measure.
 */
export interface Judgement {
  judgement: "withinSpec" | "outOfSpec" | "notJudged";
  beyondMargin: boolean | null;
}

/** A group's Shots against the margins: each of what the server judges of it. */
export interface GroupSpec {
  /** Grouped by Recipe, where the Recipe has a Reference Shot with a duration: the median duration's difference from it, in seconds. */
  duration?: Judgement & { difference: number | null };
  /** The median of each Shot's yield against its own target, as a share of it. */
  yield: Judgement;
  /** The share of the Shots that recorded what stopped them that stopped at their target. */
  stoppedAtTarget: Judgement;
  /** Grouped by Recipe and Machine, for a group with a Recipe: how far apart its Machines' median durations are, in seconds, the same on each of its groups. */
  betweenMachines?: Judgement & { apart: number | null };
}

/** What a set of Shots have in common: a Shot Summary's group. */
export interface SummaryGroup {
  by: GroupedBy;
  counts: {
    /** The Shots its numbers cover. */
    shots: number;
    /** The Unfinished Shots left out of them, in which nothing poured. */
    unfinished: number;
    /** The cleaning and calibration Shots left out of them. With `shots` and `unfinished`, the list's total for the same filters. */
    cleaningAndCalibration: number;
    /** Of `shots`, those whose first drip and last step the server is still working out. */
    awaitingValues: number;
  };
  /** The numbers asked for. */
  numbers: Partial<SummaryNumbers>;
  /**
   * How its Shots stand against the margins (#543), of a summary with no bucket. Absent from the previous release's
   * answer during a deploy (ADR-0025).
   */
  spec?: GroupSpec;
  /**
   * Grouped by Recipe, its Recipe's Reference Shot, where it has one the Shots list lists: the same for each group of
   * the Recipe. Absent from the previous release's answer during a deploy (ADR-0025).
   */
  reference?: SummaryReference;
}

/**
 * A group's Shots of one day or week, of a Shot Summary asked for by `bucket`: `start`, the day, or the Monday its week
 * starts on, as a date, such as `2026-03-02`, in each Shot's own Location's time zone, or UTC for a Shot with none; null
 * for the Shots whose time is unknown.
 */
export interface SummaryBucket extends Pick<SummaryGroup, "counts" | "numbers"> {
  start: string | null;
}

/**
 * A group of a Shot Summary asked for by `bucket`: in place of its counts and numbers, its buckets, one for each day or
 * week it has Shots of, oldest first, then that of the Shots whose time is unknown. The previous release's answer during
 * a deploy has none (ADR-0025): it knows no `bucket`, and gives the group's counts and numbers.
 */
export interface BucketedGroup extends Pick<SummaryGroup, "by" | "reference"> {
  buckets?: SummaryBucket[];
}

/** A Recipe's Reference Shot beside a group of the Recipe's Shots: its id, and its own value of each number asked for. */
export interface SummaryReference {
  id: string;
  numbers: Partial<ShotNumbers>;
}

/**
 * One Shot's own value of each number of a Shot Summary, null where it has none: whether it stopped at target is true
 * or false, and its last step the step of its Profile it ended in.
 */
export type ShotNumbers = {
  [Name in keyof SummaryNumbers]: (Name extends "stoppedAtTarget" ? boolean : Name extends "lastStep" ? { frame: number; name: string | null } : number) | null;
};

/**
 * The Shot Summary of the Shots a list's filters find: one group, or, grouped, a page of its groups in their order,
 * with how many groups there are.
 */
export interface ShotSummary<Group = SummaryGroup> {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
}

/** How long a Machine spent in one of Decaid's states, whatever its substates. */
export interface StateTime {
  /** Decaid's name for the state, such as `espresso` or `sleeping`. */
  state: string;
  /** The Machine State as the management interface names it, such as Pulling a shot or Asleep. */
  name: string;
  seconds: number;
}

/** A Machine's use in one day, or one hour of a day, at the Location it was at then. */
export interface UseBucket {
  /** The day, as a date on that Location's wall clock. */
  date: string;
  /** By hour, the hour of that day, 0 to 23. */
  hour?: number;
  /** The Shots pulled in it, cleaning and calibration Shots included. */
  shots: number;
  steamRecords: number;
  /** The flushes and hot water pours that began in it. */
  flushes: number;
  hotWaterPours: number;
  /** The time spent in each of Decaid's states in it, the longest first. */
  states: StateTime[];
}

/** A Machine's use over a range, by day or by hour (`GET /api/machines/:id/use`). */
export interface MachineUse {
  by: "day" | "hour";
  from: string;
  /** The range's end, or now if that is sooner. */
  to: string;
  /** Each day or hour of the range, oldest first. */
  buckets: UseBucket[];
}

/**
 * A Workflow summarised, as a dial-in trail gives the one in effect as its
 * range began: the parts the Workflow card shows, and its Basket and Recipe,
 * with the Library's ids of what it names, each null for none.
 */
export interface WorkflowSummary {
  profile: string | null;
  profileId: string | null;
  brewTemperature: number | null;
  dose: number | null;
  yield: number | null;
  bean: string | null;
  roaster: string | null;
  beanBatchId: string | null;
  grinder: string | null;
  burrs: string | null;
  grindSetting: string | null;
  grinderId: string | null;
  basket: string | null;
  basketId: string | null;
  recipe: string | null;
  recipeId: string | null;
  barista: string | null;
  steam: { temperature: number | null; duration: number | null; flow: number | null } | null;
  hotWater: { temperature: number | null; volume: number | null } | null;
  flush: { temperature: number | null; duration: number | null } | null;
}

/** A Recipe as a dial-in trail names it. */
export interface TrailRecipe {
  id: string;
  name: string | null;
}

/** A field of a Workflow's summary that changed, by its name there, a part's as `steam.duration`. */
export interface TrailFieldChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/**
 * An entry of a Machine's dial-in trail: the Workflow in effect as its range
 * began (`inEffect`), a Recipe loaded or unloaded, Decent Sync's write of an
 * edit of the Loaded Recipe made elsewhere (`recipeUpdated`), or any other
 * change, changes close together merged into one.
 */
export interface TrailEntry {
  kind: "inEffect" | "loaded" | "unloaded" | "recipeUpdated" | "changed";
  /** When it began, by the tablet's clock. */
  observedAt: string;
  /** When it took its last change after it began; otherwise null. */
  lastObservedAt: string | null;
  /** Who made its first change: Decent Sync (`plugin`), anyone else (`other`), or `unknown`. */
  cause: "plugin" | "other" | "unknown";
  /** For a `plugin` change, which of Decent Sync's writes it was; otherwise null. */
  pluginWrite: string | null;
  /** The Recipe loaded, unloaded or updated; for any other entry, the one loaded then, or null. */
  loadedRecipe: TrailRecipe | null;
  /** For a load, the Recipe unloaded as it loaded; otherwise null. */
  replaced: TrailRecipe | null;
  /** For `inEffect`, the Workflow summarised whole; otherwise null. */
  workflow: WorkflowSummary | null;
  /** For any other, each field that changed, before and after. */
  changes: TrailFieldChange[];
}

/** A Machine State change as stored: the state it went into, when its tablet observed it and when the server received it. */
export interface MachineStateEvent extends MachineState {
  id: string;
  receivedAt: string;
}

/** A page of one kind of a Machine's activity, latest first, and how many there are in all. */
export interface ActivityPage<T> {
  entries: T[];
  total: number;
}

/**
 * What a Machine was doing over a time range (`GET /api/machines/:id/activity`):
 * a page of each kind asked for, of what was in effect at any time in the
 * range, so each list's oldest entry may date from before it.
 */
export interface MachineActivity {
  workflowChanges?: ActivityPage<TrailEntry>;
  loadedRecipes?: ActivityPage<LoadedRecipe>;
  machineStates?: ActivityPage<MachineStateEvent>;
  limit: number;
  offset: number;
}

/** What the listed Shots recorded, for choosing filters. Null stands for Shots that recorded none. */
export interface ShotFilterOptions {
  beans: { coffeeRoaster: string | null; coffeeName: string | null }[];
  /** Each Barista once, whatever the name's case and the blanks around it, by its most recent spelling. */
  baristas: (string | null)[];
  profiles: (string | null)[];
  /** The Library's Bean Batches listed Shots are linked to; null stands for Shots linked to none. */
  beanBatches: (BatchLink | null)[];
  /** The Library's Grinders listed Shots are linked to, each with its Location; null stands for Shots linked to none. */
  grinders: ((GrinderLink & { location: Location | null }) | null)[];
  /** The Library's Recipes listed Shots are linked to, each with its Location; null stands for Shots linked to none. */
  recipes: ((NamedLink & { location: Location | null }) | null)[];
  /** The Library's Baskets listed Shots are linked to; null stands for Shots linked to none. */
  baskets: (NamedLink | null)[];
}

/** A Steam Record as the Steam Records list shows it: what it measured and how it was credited, without its record or curves. */
export interface SteamRecordSummary {
  id: string;
  /** When it was recorded: its tablet's local time, which the plugin placed in UTC. */
  steamedAt: string;
  /** The Machine whose tablet reported it, or else the Pending Machine holding it. Steam Records record no hardware. */
  machine: { id: string; name: string } | null;
  pendingMachine: { id: string; model: string; serial: string } | null;
  /** Where its Machine was when it was recorded; null when unknown, and its times are then in UTC. */
  location: Location | null;
  /**
   * How long it steamed, in seconds, leaving out its lead-in, pauses, puffs and purge; the whole recording for one
   * the server has yet to compute again.
   */
  duration: number | null;
  /** In °C, from the milk probe, leaving out a reading carried over from the Steam Record before; null without a probe. */
  peakMilkTemperature: number | null;
  /** The probe's last reading, in °C. */
  finalMilkTemperature: number | null;
  barista: string | null;
}

/** One page of a Steam Records list, and how many Steam Records the whole list has. */
export interface SteamRecordPage {
  steamRecords: SteamRecordSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** A Steam Record with its Decaid record, without measurements, as stored. */
export interface SteamRecord extends SteamRecordSummary {
  record: Record<string, unknown>;
}

/** A Bean in the Library, as the Beans list shows it. */
export interface BeanSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  roaster: string | null;
  name: string | null;
  archived: boolean;
  /**
   * The Locations offering it: each where one of its batches is, and each where it has no batch yet but a tablet
   * created it, linked a bean of its own to it or un-archived it. None while it is Archived.
   */
  offeredAt: Location[];
  /** When it joined the Library. */
  createdAt: string;
  /** The Location of the tablet that created it. */
  createdLocation: Location | null;
  /** Other Beans with the same roaster and name, ignoring case and spaces at either end. */
  likelyDuplicates: { id: string; roaster: string | null; name: string | null }[];
}

/** A Bean with its content: Decaid's record fields, as the tablet that created it sent them. */
export interface Bean extends BeanSummary {
  content: Record<string, unknown>;
  /** Its batches, the latest roasted first. */
  batches: BeanBatchSummary[];
}

/** A Bean Batch at a Location. */
export interface BatchAtLocation {
  location: Location;
  /**
   * Its Remaining Weight there, in grams, worked out by the server: the
   * weight last entered there less the dose of each Shot linked to the batch
   * that was pulled there since, never below zero. Null where it is
   * untracked: none was entered, or it was cleared.
   */
  remainingWeight: number | null;
  /**
   * The weight last entered there, when, and who entered it, where known;
   * null where it is untracked. The release before answers without it, as it
   * may during a deploy (ADR-0025).
   */
  entered?: { weight: number; at: string; by: EditSource | null } | null;
  /** The Shots pulled there since that weight was entered, and the coffee they used, in grams; null where it is untracked. Absent as `entered` is. */
  used?: { shots: number; weight: number } | null;
  /** When it was added there. */
  since: string;
}

/** A Bean Batch in the Library, as the Bean Batches list shows it. */
export interface BeanBatchSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  bean: { id: string; roaster: string | null; name: string | null };
  /** Its roast date as Decaid recorded it, such as 2026-10-01T00:00:00.000. */
  roastDate: string | null;
  /** Its Batch Code, the roaster's own identifier for it; null where it has none. */
  batchCode: string | null;
  archived: boolean;
  /** The Locations it is at, by name, with its remaining weight at each. */
  locations: BatchAtLocation[];
  /** The sum of its remaining weights over the Locations that track it, in grams; null where none does. Absent from the release before (ADR-0025). */
  totalRemainingWeight?: number | null;
  /** When it joined the Library. */
  createdAt: string;
  /** The Location of the tablet that created it. */
  createdLocation: Location | null;
}

/** A Bean Batch with its content: Decaid's record fields, as the tablet that created it sent them. */
export interface BeanBatch extends BeanBatchSummary {
  content: Record<string, unknown>;
  /** The Locations it was at and has been finished at since, with when and the weight last entered there. */
  finished: { location: Location; remainingWeight: number | null; finishedAt: string }[];
}

/** A Location showing a Profile. */
export interface ProfileAtLocation {
  location: Location;
  /** Since when it is shown there, by the server's clock. */
  since: string;
}

/** A Grinder in the Library, as the Grinders list shows it. */
export interface GrinderSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  model: string | null;
  burrs: string | null;
  burrType: string | null;
  archived: boolean;
  /** The Location it belongs to, the one where it was created and the only one offering it; null if that Location no longer exists. */
  location: Location | null;
  /** When it joined the Library. */
  createdAt: string;
}

/**
 * A Grinder with its content: Decaid's record fields, as the tablet that
 * created it sent them, and what DYE2 keeps in the record's `extras`:
 * `feedRate`, its feed rate note, and the range and default of its setting
 * and of its RPM (`settingMin`, `settingMax`, `settingDefault`, `rpmMin`,
 * `rpmMax`, `rpmDefault`), each a number, where 0 is a value.
 */
export interface Grinder extends GrinderSummary {
  content: Record<string, unknown>;
}

/** A Profile in the Library, as the Profiles list shows it. */
export interface ProfileSummary {
  /** Decaid's id, such as profile:bf1ca48b9c7389c7d146: a hash of what the machine executes, the same on every tablet. */
  id: string;
  title: string | null;
  author: string | null;
  beverageType: string | null;
  /** One of Decaid's bundled Profiles, which every tablet has already. */
  bundled: boolean;
  archived: boolean;
  /** The Locations showing it, by name. None while it is Archived. */
  shownAt: ProfileAtLocation[];
  /** When it joined the Library. */
  createdAt: string;
  /** The Location of the tablet that created it. */
  createdLocation: Location | null;
}

/** A Profile with its content: Decaid's record fields, as the tablet that created it sent them. */
export interface Profile extends ProfileSummary {
  content: Record<string, unknown>;
  /** Its profile, as Decaid reads it: what the machine executes, and its title, author and notes; null where Decaid would not read it, and absent from a server of the release before. */
  profile?: ProfileDefinition | null;
  /** The Profile it was saved from, if the Library has it. */
  parent: { id: string; title: string | null } | null;
  /**
   * Each Location that has decided whether it shows it, by name, kept while
   * it is Archived: whether it is shown there, and since when that was
   * decided. A Location not listed does not show it.
   */
  locations: { location: Location; shown: boolean; since: string }[];
  /**
   * The Machine model it is simulated as unless another is chosen: a Bengle where every Machine at the Locations showing
   * it is one, otherwise a DE1. Absent from a server of the release before (ADR-0025).
   */
  machineModel?: MachineModel;
  /**
   * The Machines whose tablets refused its write, the latest first, with why: among them Decaid answering under another
   * id, as a Decaid that computes its id otherwise than Decent Sync. Absent from a server of the release before.
   */
  refusedOn?: { machine: { id: string; name: string }; error: string; refusedAt: string }[];
}

/** A Draft as the Library lists it (#579): a profile being written or changed here, on no tablet until it is published. */
export interface DraftSummary {
  id: string;
  /** Its profile's title, empty for none yet. */
  title: string;
  /** The Library Profile it was started from, by Edit or Duplicate; its title and bundled null where the Library no longer has it. */
  startedFrom: { id: string; title: string | null; bundled: boolean | null } | null;
  /** The starting shape it was started from. */
  shape: { key: string; title: string } | null;
  /** A new version of the Profile it was started from, or a separate Profile. */
  publishesAs: "version" | "separate";
  /** Who saved it last. */
  savedBy: EditSource;
  savedAt: string;
  /** How many times it has been saved: a save names the count it started from. */
  saves: number;
  createdAt: string;
}

/** A Draft with its profile and checks. */
export interface Draft extends DraftSummary {
  profile: ProfileDefinition;
  /** The id Decaid would give its profile. */
  profileId: string;
  /** The models the account has Machines of: its values are held to the widest of their ranges. */
  models: MachineModel[];
  /** The model it is simulated as unless another is chosen. */
  machineModel: MachineModel;
  /** Its checks but those of a simulated run, which the page makes itself. */
  checks: ProfileChecks;
  /**
   * For a new version with the steps of the Profile it started from: which of that Profile's title, author and
   * notes it changes, which publishing it edits there, making no Profile (#667). Null otherwise; absent from a
   * server of the release before.
   */
  editsText?: ProfileTextField[] | null;
  /**
   * For a new version, while the Library has the Profile it started from: that Profile, with its title, author and
   * notes as they were when the Draft began, which the page checks it against. Null otherwise; absent from a server
   * of the release before, whose page checks it as a new version.
   */
  versionOf?: { id: string; text: ProfileText } | null;
  /** For a new version, the versions of the Profile it started from the Library gained since it began, the latest first: publishing it forks the chain beside them. */
  newer: { id: string; title: string | null; savedAt: string }[];
}

/** A Machine a Draft can be followed on (#581): one taking part at a Location that tries Drafts. */
export interface FollowableMachine {
  id: string;
  name: string;
  location: { id: string; name: string };
  /** Its plugin is from before a Machine could follow a Draft. */
  needsPluginUpdate: boolean;
  /** Whether it can be followed on now: false too for one whose tablet has not connected since the server could ask it. */
  canFollow: boolean;
  /** Another Draft it follows now. */
  follows: { id: string; title: string } | null;
}

/** Whether, and how, a Draft is followed on a Machine (#581). */
export interface DraftFollowing {
  machine: { id: string; name: string; location: { id: string; name: string } | null };
  startedAt: string;
  /** current: the Machine has the Draft's steps as saved, since `since`; waiting: it is still to be written them; ended: following ended. */
  state: "current" | "waiting" | "ended";
  since: string | null;
  /** Why it is still to be written, where the server knows. */
  waitingFor: string | null;
  /** workflow: the Machine's Workflow came to hold another profile; stopped: someone turned it off; location: its Location stopped trying Drafts, or it left. */
  ended: { at: string; why: "workflow" | "stopped" | "location" } | null;
  /** The title of the profile the Machine's Workflow holds now. */
  has: string | null;
  titleOnTablet: string;
}

/** A Trial Shot of a Draft (#581): a Shot pulled with its steps on a Machine following it, and the steps it ran. */
export interface TrialShot {
  shot: ListedShot;
  /** The profile the Draft was written to the Machine with that the Shot ran (`DraftTrial`). */
  trialId: string;
  /** Whether those are the Draft's steps as saved now, or earlier ones. */
  steps: "current" | "earlier";
}

/** How a Draft is tried (#581). */
export interface DraftTrying {
  following: DraftFollowing | null;
  machines: FollowableMachine[];
  /** The latest first. */
  trialShots: TrialShot[];
}

/** A profile a Draft was written to a following Machine with, which a Trial Shot ran. */
export interface DraftTrial {
  id: string;
  machine: { id: string; name: string };
  writtenAt: string;
  profile: ProfileDefinition;
}

/** What publishing a Draft, or returning to an earlier version, did (#580). */
export interface Published {
  /** The Profile now shown at the Locations chosen. */
  profile: { id: string; title: string | null };
  /** The Profile it took the place of; null for a separate Profile. */
  replaced: { id: string; title: string | null } | null;
  shownAt: { id: string; name: string }[];
  /** Where the Profile it replaced was hidden. */
  hiddenAt: { id: string; name: string }[];
  /** Locations chosen that still show the Profile it replaced, as Recipes there not moved name it. */
  keptAt: { location: { id: string; name: string }; recipes: { id: string; name: string | null }[] }[];
  moved: { id: string; name: string | null; location: { id: string; name: string } }[];
  /** Newer versions of the Profile the Draft started from, beside which it now forks the chain. */
  forked: { id: string; title: string | null; savedAt: string }[];
  /**
   * For a Draft with the steps of the Profile it started from, which publishing made an edit of that Profile (#667):
   * which of its title, author and notes changed, the Profile being the one edited and nothing shown, hidden or
   * moved. Null where a Profile was published; absent from a server of the release before.
   */
  edited?: ProfileTextField[] | null;
}

/** A Draft started, with what of a file was held to the ranges. */
export interface StartedDraft {
  draft: Draft;
  held: HeldValue[];
}

/** A Draft saved, and the saves made between the count it started from and this one, if any. */
export interface SavedDraft {
  draft: Draft;
  between: { saves: number; savedBy: EditSource; savedAt: string } | null;
}

/** One of a Profile's Profile Versions: a Profile in the chain of Decaid's `parentId` links through it. */
export interface ProfileVersion {
  id: string;
  title: string | null;
  bundled: boolean;
  archived: boolean;
  /** The Profile it was saved from, where that is in the chain; null for the first. */
  parentId: string | null;
  /** When it was saved: by the record its first tablet sent, else when it joined the Library. */
  savedAt: string;
  /** Who saved it: the Machine whose tablet saved it, or the account that published it; null where unknown. */
  savedBy: EditSource | null;
  shownAt: ProfileAtLocation[];
  /** How many Shots are on it. */
  shots: number;
}

/** A Recipe naming a Profile, with the Machines that have it loaded now. */
export interface RecipeOnProfile {
  recipe: Recipe;
  loadedOn: { id: string; name: string }[];
}

/** A Basket or Tool in the Library, as the Baskets and Tools lists show it: DYE2's baskets and its equipment. */
export interface EquipmentSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  name: string | null;
  archived: boolean;
  /** The Locations showing it, by name. None while it is Archived. */
  shownAt: ProfileAtLocation[];
  /** When it joined the Library. */
  createdAt: string;
  /** The Location it was created at, by a tablet there or here. */
  createdLocation: Location | null;
  /** DYE2's record fields, such as a Basket's `size` or a Tool's attributes as `custom`. */
  content: Record<string, unknown>;
}

/** A Basket or Tool with where it is shown. */
export interface Equipment extends EquipmentSummary {
  /**
   * Each Location that has decided whether it shows it, by name, kept while
   * it is Archived: whether it is shown there, and since when that was
   * decided. A Location not listed does not show it.
   */
  locations: { location: Location; shown: boolean; since: string }[];
}

/** A Recipe a Machine has loaded, or had loaded: since when, and until when, null while it still has it. */
export interface LoadedRecipe {
  id: string;
  recipe: { id: string; name: string | null; slot: number | null; locationId: string | null; archived: boolean };
  /** When its tablet observed the Workflow naming it, by the tablet's clock. */
  loadedAt: string;
  unloadedAt: string | null;
}

/**
 * A Recipe: DYE2's recipe, belonging to one Location, in one of its Recipe
 * Slots or none.
 */
export interface Recipe {
  id: string;
  name: string | null;
  /** The Location it belongs to. */
  location: Location | null;
  /** Its Recipe Slot there, 1 to 9, or null for none. */
  slot: number | null;
  archived: boolean;
  createdAt: string;
  /**
   * Its content in the Library's terms: `name`, `beverage`, `beanId`,
   * `beanBatchId`, `profileId`, `grinderId`, `basketId`, `toolIds`,
   * `toolAttributes` (each Tool's attributes for it, by the Tool's id),
   * `dose`, `yield`, `ratio`, `grindSetting` (a number, or text as typed),
   * `rpm`, `feedRate` (text as typed), `brewTemperature`, the steam, hot
   * water and flush settings it holds (`steamTemperature`,
   * `steamDuration`, `steamFlow`, `steamStopTemperature`,
   * `hotWaterTemperature`, `hotWaterDuration`, `hotWaterVolume`,
   * `hotWaterFlow`, `flushTemperature`, `flushDuration` and `flushFlow`), and
   * DYE2's display modes `steamMode` and `hotWaterMode`, each left out where
   * it holds none.
   */
  content: Record<string, unknown>;
  /** The items its content names, with what names each; an item the Library no longer has is named by its id alone. */
  uses: {
    bean: { id: string; roaster: string | null; name: string | null } | null;
    /** Its batch, and whether it is at the Recipe's Location now. */
    beanBatch: { id: string; roastDate: string | null; atLocation: boolean } | null;
    profile: { id: string; title: string | null } | null;
    grinder: { id: string; model: string | null } | null;
    basket: { id: string; name: string | null } | null;
    tools: { id: string; name: string | null }[];
  };
  /** Not Archived, and naming a Bean Batch that is no longer at its Location: its dial needs the next roast. */
  batchFinished: boolean;
  /**
   * Its Reference Shot (ADR-0029): null for none, as for one whose Pending Machine was dismissed, until that hardware
   * is adopted. Absent from a Location's list as the previous release answers it during a deploy (ADR-0025), which
   * gives it only by a Recipe's own read, `GET /api/recipes/:id`.
   */
  referenceShot?: ReferenceShot | null;
}

/** A Recipe's Reference Shot: what its page shows of it. */
export interface ReferenceShot {
  id: string;
  pulledAt: string | null;
  /** The Machine it is credited to; null while a Pending Machine holds it. */
  machine: { id: string; name: string } | null;
  /** Where its Machine was then; null when unknown, and its time is then in UTC. */
  location: Location | null;
  /** Its profile's title, as the Shot recorded it. */
  profileTitle: string | null;
  /** The Library's Profile it was pulled with. */
  profile: ProfileLink | null;
  targetDose: number | null;
  actualDose: number | null;
  targetYield: number | null;
  actualYield: number | null;
  /** In seconds, without its Preheat, as the Shots list shows it. */
  duration: number | null;
  /** Its rating, 0 to 10, where 0 is unrated, and its Grinder's setting as recorded. Each absent from the previous release's answer during a deploy (ADR-0025). */
  enjoyment?: number | null;
  grinderSetting?: string | null;
  /** The Recipe names a Profile, and this Shot's is another, or none in the Library. */
  profileDiffers: boolean;
}

/** The kinds of Library item (`LIBRARY_KINDS`). */
export type { LibraryKind };

/** What has a history: Library items. */
export type ItemKind = LibraryKind;

/** Where a version or a Lost Edit came from: a Machine's tablet, or an account in the management interface. */
export interface EditSource {
  /** The Machine whose tablet made it, if one did and it still exists. */
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  /** The account that made it here, named only to Admins: other accounts' names are personal information Staff do not see. */
  account: { id: string; name: string | null } | null;
  /** The Connected App, such as an assistant, the account made it through: its name and its client id's host. Null for the management interface. */
  connectedApp: { id: string; name: string; host: string } | null;
}

/** One accepted edit of a Library item. */
export interface ItemVersion {
  id: string;
  /** The fields it set, with their values: of the item's content, or of its state at `location` (`atLocation`, `remainingWeight` or `shown`). */
  fields: Record<string, unknown>;
  /** The Location whose state of the item it changed; null for its content. */
  location: Location | null;
  source: EditSource;
  /** When it was made: a tablet's by its record's time, a management-interface edit by the server's clock. */
  editedAt: string;
  /** When the server took it in. */
  receivedAt: string;
  /**
   * A copy's first version names the item it was copied from, as a Recipe
   * copied to a Location does: its name now, null where it has none or is
   * gone, and its Location then, if it still exists. Null otherwise.
   */
  copiedFrom: { id: string; name: string | null; location: Location | null } | null;
}

/**
 * A Lost Edit: an edit to a field of a Library item that did not apply, because it lost to another edit of the same
 * field made without seeing it, or because a record entered on a tablet, of an item the Library already had, held another value. Kept in the
 * item's history, to be read. A tablet joining a Location keeps none.
 */
export interface LostEdit {
  id: string;
  field: string;
  /** The losing value; null where the edit cleared the field. */
  value: unknown;
  /** The Location whose state of the item the field is; null for the item's content. */
  location: Location | null;
  source: EditSource;
  /** When the losing edit was made. */
  editedAt: string;
  /** When it lost. */
  lostAt: string;
  /** The edit it lost to, one of the item's versions, with the value it set the field to; null where that is not known. */
  lostTo: { versionId: string; value: unknown; source: EditSource; editedAt: string } | null;
}

/** An item's history. The previous release answers without `lostEdits`, as it may during a deploy (ADR-0025). */
export interface ItemHistory {
  versions: ItemVersion[];
  lostEdits?: LostEdit[];
}
