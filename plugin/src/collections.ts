import { type CollectionDelivery, type CollectionName, isLibraryList } from "@decent-sync/protocol";
import { type Fingerprint, type Reading, decide, ifNoneMatch, pairedDevices } from "./change-detection.js";
import { readCollection } from "./decaid.js";
import type { LibraryAccess } from "./library-writes.js";
import { utcTime } from "./local-time.js";
import type { Outbox } from "./outbox.js";

interface Source {
  name: CollectionName;
  /** The route under Decaid's API, with its query. */
  path: string;
  /** Turns Decaid's response into the collection, or null if it has nothing to report. */
  select?: (value: unknown) => unknown;
}

/**
 * Where each collection is read, in Decaid v0.8.7's API (rest_v1.yml). The
 * library's lists send ETags; the rest are compared by content. DYE2's keys
 * are only ever read: DYE2 is their only writer until Location sharing
 * (ADR-0005).
 */
const SOURCES: readonly Source[] = [
  { name: "beans", path: "/beans?includeArchived=true" },
  { name: "beanBatches", path: "/bean-batches?includeArchived=true" },
  { name: "grinders", path: "/grinders?includeArchived=true" },
  { name: "profiles", path: "/profiles?includeHidden=true" },
  { name: "dye2Recipes", path: "/store/dye2.reaplugin/recipes" },
  { name: "dye2Equipment", path: "/store/dye2.reaplugin/equipment" },
  { name: "dye2Baskets", path: "/store/dye2.reaplugin/baskets" },
  { name: "appSettings", path: "/settings" },
  { name: "machineSettings", path: "/machine/settings" },
  { name: "advancedSettings", path: "/machine/settings/advanced" },
  { name: "pairedDevices", path: "/devices", select: pairedDevices },
  { name: "scaleInfo", path: "/scale/info" },
  { name: "sensors", path: "/sensors" },
];

/**
 * The tablet's library, settings and paired devices, through the outbox.
 * Decaid has no event for them, so while connected the plugin reads each one
 * every poll interval and sends it, whole, when it changed
 * (change-detection.ts). On every welcome it reads every one again and
 * sends it whatever it is, which also covers whatever changed while the
 * plugin was disconnected. Reads run one at a time, one collection after
 * another, and a read asked for while one runs waits for it.
 *
 * A Library list is read, and its report queued, between the server's
 * writes to the tablet (`LibraryAccess`), so a report holds each write that
 * began before it. And whenever the beans were sent, the bean batches are
 * sent in full after them, changed or not: the server takes in a batch only
 * once it knows its bean, which may have been added since the batches were
 * last sent.
 */
export class CollectionCapture {
  /** What was last queued for each collection. */
  private readonly last = new Map<CollectionName, Fingerprint>();
  /** For each collection, the latest delivery queued, and the latest queued with a value. */
  private readonly queued = new Map<CollectionName, { latest: string; value: string | undefined }>();
  private wanted: "changes" | "full" | undefined;
  private reading = false;
  private stopped = false;
  private pollTimer?: number;

  constructor(
    private readonly outbox: Outbox,
    private readonly library: LibraryAccess,
    private readonly pollMs: number,
  ) {}

  start(): void {
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
  }

  /** Every collection, read again and sent in full, as on every welcome and whenever the server asks. */
  sendAll(): void {
    this.read("full");
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      // While disconnected, changes wait for the next welcome, which sends everything.
      if (this.outbox.connected) this.read("changes");
      if (!this.stopped) this.schedulePoll();
    }, this.pollMs);
  }

  private read(kind: "changes" | "full"): void {
    if (this.stopped) return;
    if (kind === "full" || this.wanted === undefined) this.wanted = kind;
    void this.run();
  }

  private async run(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      while (this.wanted !== undefined && !this.stopped) {
        const full = this.wanted === "full";
        this.wanted = undefined;
        let beansSent = false;
        for (const source of SOURCES) {
          if (this.stopped) return;
          const sent = await (isLibraryList(source.name)
            ? this.library.run(() => this.capture(source, full || (source.name === "beanBatches" && beansSent)))
            : this.capture(source, full));
          if (source.name === "beans") beansSent = sent;
        }
      }
    } finally {
      this.reading = false;
    }
  }

  /** Reads a collection, and queues it if it is to be sent. Says whether a value was queued. */
  private async capture(source: Source, full: boolean): Promise<boolean> {
    const last = this.last.get(source.name);
    const reading = selected(source, await readCollection(source.path, full ? null : ifNoneMatch(last)));
    if (this.stopped) return false;
    const decision = decide(last, reading, full);
    if (decision.next) this.last.set(source.name, decision.next);
    if (!decision.send || reading.kind === "notModified") return false;

    const id = this.outbox.nextId();
    const delivery: CollectionDelivery =
      reading.kind === "value"
        ? { type: "collection", id, name: source.name, available: true, value: reading.value, ...placedInTime(source.name, reading.value) }
        : { type: "collection", id, name: source.name, available: false };
    // The newer delivery makes older ones still queued unnecessary, unless they were sent before a
    // reconnect, except that a value stays ahead of a report that the collection became unavailable:
    // the server keeps the value it gets, and otherwise would never get this one.
    const earlier = this.queued.get(source.name);
    if (earlier) {
      if (delivery.available || earlier.latest !== earlier.value) this.outbox.supersede(earlier.latest);
      if (delivery.available && earlier.value !== undefined && earlier.value !== earlier.latest) this.outbox.supersede(earlier.value);
    }
    this.queued.set(source.name, { latest: id, value: delivery.available ? id : earlier?.value });
    this.outbox.enqueue(delivery);
    return delivery.available;
  }
}

/**
 * For a Library list, each record's `updatedAt` placed in UTC, beside the
 * list: Decaid writes it in the tablet's local time without an offset, which
 * only the plugin, running in the tablet's time zone, can place.
 */
function placedInTime(name: CollectionName, value: unknown): Pick<CollectionDelivery, "updatedAt"> {
  if (!isLibraryList(name) || !Array.isArray(value)) return {};
  return { updatedAt: value.map((record: unknown) => utcTime((record as { updatedAt?: unknown } | null)?.updatedAt)) };
}

function selected(source: Source, reading: Reading): Reading {
  if (reading.kind !== "value" || !source.select) return reading;
  const value = source.select(reading.value);
  return value === null ? { kind: "unavailable" } : { ...reading, value };
}
