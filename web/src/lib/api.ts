// The management interface uses only the server's REST API, the same one any
// other client uses. The session cookie travels with every same-origin request.

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    message: string,
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
 */
export async function api<T>(method: string, path: string, body?: unknown, { reportRefusal = true } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    if (reportRefusal && (response.status === 401 || response.status === 403)) {
      await Promise.allSettled([...refusalListeners].map((listener) => listener()));
    }
    throw new ApiError(response.status, errorMessage(data) ?? response.statusText);
  }
  return data as T;
}

// Nest reports problems as { message: string | string[] }.
function errorMessage(data: unknown): string | undefined {
  const message = (data as { message?: unknown } | undefined)?.message;
  if (Array.isArray(message)) return message.join(". ");
  return typeof message === "string" ? message : undefined;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  role: "admin" | "staff";
  /** The Locations a Staff member works at, where they may move Machines; none for an Admin, who may change anything anywhere. */
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

/** An invite: a one-time link that creates an account, as an Admin or as Staff at chosen Locations. */
export interface Invite {
  id: string;
  /** The email its account will sign in with. */
  email: string;
  role: "admin" | "staff";
  /** The Locations a Staff member will work at; none for an Admin, who sees every Location. */
  locations: Location[];
  createdAt: string;
  expiresAt: string;
}

/** A newly created invite and its link, which the server returns only once. */
export interface CreatedInvite {
  invite: Invite;
  link: string;
}

export interface Location {
  id: string;
  name: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
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
  lastShot: { id: string; pulledAt: string | null } | null;
  /** What it is doing: the latest machine state its tablet reported, or null before any. */
  machineState: MachineState | null;
  /** Where it is now: the Location of its Location History's latest entry, or null if it has none. */
  location: Location | null;
  /** Where it has been, oldest first. Each entry lasts until the next one's time. */
  locationHistory: LocationHistoryEntry[];
  /** The tablet its latest connection came from, or null before any. A reset or replaced tablet is a new one. */
  tablet: Tablet | null;
  /** The tablets its connections came from before, the one whose connection was accepted most recently first. */
  earlierTablets: Tablet[];
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

/** A connection in a takeover: its tablet, the address the server saw it come from, and what its plugin reported. */
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

/** A Shot as the Shots list shows it: what it recorded and how it was credited, without its record or curves. */
export interface ShotSummary {
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
}

/** One page of a Shots list, and how many Shots the whole list has. */
export interface ShotPage {
  shots: ShotSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** A Shot with its Decaid record, without measurements, as stored. */
export interface Shot extends ShotSummary {
  record: Record<string, unknown>;
  /** The Shot pulled just before it on the same Machine, or held by the same Pending Machine. */
  previousShot: { id: string; pulledAt: string } | null;
}

/** What the listed Shots recorded, for choosing filters. Null stands for Shots that recorded none. */
export interface ShotFilterOptions {
  beans: { coffeeRoaster: string | null; coffeeName: string | null }[];
  baristas: (string | null)[];
  profiles: (string | null)[];
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
  /** In seconds. */
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
  /** The remaining weight entered there last, in grams: null if none was, or it was cleared. */
  remainingWeight: number | null;
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
  archived: boolean;
  /** The Locations it is at, by name, with its remaining weight at each. */
  locations: BatchAtLocation[];
  /** When it joined the Library. */
  createdAt: string;
  /** The Location of the tablet that created it. */
  createdLocation: Location | null;
}

/** A Bean Batch with its content: Decaid's record fields, as the tablet that created it sent them. */
export interface BeanBatch extends BeanBatchSummary {
  content: Record<string, unknown>;
  /** The Locations it was at and has been finished at since, with when and the remaining weight last entered there. */
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

/** A Grinder with its content: Decaid's record fields, as the tablet that created it sent them. */
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
  /** The Profile it was saved from, if the Library has it. */
  parent: { id: string; title: string | null } | null;
}

/** The kinds of Library item. */
export type LibraryKind = "bean" | "beanBatch" | "grinder" | "profile";

/** What has versions and Conflicts: Library items, and each Location's settings for one model (`settings`). */
export type ItemKind = LibraryKind | "settings";

/** A Location's steam, hot water and rinse settings, shared by its Machines whatever their model. */
export interface LocationSettings {
  /** Null while no Machine there has reported its Workflow, so none are set. */
  id: string | null;
  /** Each setting, by its part and name, such as `steamSettings.flow`; null while unset. */
  values: Record<string, number | null>;
  /** The Location's Machines now, each with its model, if known, and whether it shares them. */
  machines: { id: string; name: string; model: string | null; sharesSettings: boolean }[];
  /** Whether the signed-in account may change them, and switch its Machines' sharing. */
  editable: boolean;
}

/** Where a version or a Conflict came from: a Machine's tablet, or an account in the management interface. */
export interface EditSource {
  /** The Machine whose tablet made it, if one did and it still exists. */
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  /** The account that made it here, named only to Admins: other accounts' names are personal information Staff do not see. */
  account: { id: string; name: string | null } | null;
}

/** One accepted edit of a Library item. */
export interface ItemVersion {
  id: string;
  /** The fields it set, with their values: of the item's content, or of its state at `location` (`atLocation`, `remainingWeight`, `shown`, or a setting). */
  fields: Record<string, unknown>;
  /** The Location whose state of the item it changed; null for its content. */
  location: Location | null;
  source: EditSource;
  /** When it was made: a tablet's by its record's time, a management-interface edit by the server's clock. */
  editedAt: string;
  /** When the server took it in. */
  receivedAt: string;
}

/** An edit of a field of a Library item that lost to another made without seeing it. */
export interface Conflict {
  id: string;
  /** The item, or the settings, whose Location is `location`; named by their model. */
  item: { kind: ItemKind; id: string; name: string | null };
  field: string;
  /** The losing value; null where the edit cleared the field. */
  value: unknown;
  /** The Location whose state of the item the field is; null for the item's content. */
  location: Location | null;
  source: EditSource;
  /** When the losing edit was made. */
  editedAt: string;
  /** When it became a Conflict. */
  createdAt: string;
  state: "open" | "used" | "dismissed";
  /** The field's value now, and where and when that came from and its version, where known. Using the value names that version. */
  current: { value: unknown; source: EditSource | null; editedAt: string | null; versionId: string | null };
  /** Whether the signed-in account may use its value or dismiss it. */
  resolvable: boolean;
}
