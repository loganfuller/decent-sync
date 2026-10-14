import type { SimulatedTablet } from "./simulated-tablet.js";

// Streamline (streamline-js) running as a simulated tablet's skin, as far as
// it touches the shared settings, as on `main` at 07be2b3 (2026-10-14), the
// first builds Decent Sync supports (ADR-0017). The plugin is not told of it:
// it calls Decaid's API as anything else on the tablet does
// (`SimulatedTablet.callApi`).
//
// Streamline remembers what the barista last set for some settings in
// Decaid's store, under `streamline-app` (the `*_LAST_VALUE_KEY` constants in
// streamline-js:src/modules/api.js), and compares the Workflow with it
// (`resyncIfDrifted`, which `decideResync` in src/modules/resync-policy.js
// decides for). A value the Workflow holds that differs from the one
// remembered is adopted: kept in the store, nothing pushed (ADR-0021). It
// pushes only its own push that has not reached the Workflow (`pending`), and
// the value remembered for a setting the Workflow lacks, and it ignores a
// differing value seen within `ECHO_WINDOW_MS` of its own push. It checks:
//
// - On every shot-settings frame from the machine, for steam duration and
//   hot water volume and temperature (`resyncDriftedShotSettings` and
//   `SHOT_SETTINGS_KV_FIELDS` in src/modules/app.js). Decaid sends the
//   machine new shot settings when the Workflow changes, and the machine
//   echoes them back, so here every change of the Workflow, while a machine
//   is connected, is followed by such a frame, in a later turn. A field
//   whose value repeats the last frame's is not checked, and one pushed is
//   not checked again for `RESYNC_COOLDOWN_MS` of real time.
// - On every load (`loadInitialData`), for every key it keeps but the
//   steam temperature, which it sends only along with a steam time it
//   pushes (`steamHeaterFor`), and its milk stop only while the Workflow's
//   is on (`resyncMilkStopIfDrifted`): `reload()`.
//
// Each push, and a barista's change made in Streamline (`set()`), goes
// through Streamline's setter for the value, which keeps the value in the
// store and marks it pending before it changes the Workflow, and clears the
// mark once the Workflow took it (`pushRemembered`, used by
// `setTargetHotWaterVolume` and the others). The steam temperature is kept
// without a mark, and the flush duration only after the Workflow took it
// (`updateFlushValue` in src/modules/ui.js). Its Auto steam mode, which
// pushes nothing, and its 20 s Workflow poll, which only repaints its tiles,
// are left out.

/** Streamline's namespace in Decaid's store. */
export const STREAMLINE_NAMESPACE = "streamline-app";

/** How long Streamline waits before pushing a value it pushed on a shot-settings frame again (app.js). */
export const RESYNC_COOLDOWN_MS = 30_000;

/** How long after its own push Streamline ignores a differing value as a stale echo (resync-policy.js). */
export const ECHO_WINDOW_MS = 10_000;

/** The keys Streamline keeps the shared settings under (api.js). */
export type StreamlineKey =
  | "last-steam-duration"
  | "last-steam-flow"
  | "last-steam-temp"
  | "last-milk-stop"
  | "last-flush-duration"
  | "last-hot-water-volume"
  | "last-hot-water-temp";

type Record_ = Record<string, unknown>;

/** The fields of a shot-settings frame Streamline checks, with the key and Workflow setting each is checked against. */
const SHOT_SETTINGS_FIELDS: readonly { field: string; key: StreamlineKey }[] = [
  { field: "steamSettings.duration", key: "last-steam-duration" },
  { field: "hotWaterData.volume", key: "last-hot-water-volume" },
  { field: "hotWaterData.targetTemperature", key: "last-hot-water-temp" },
];

/** What `loadInitialData` checks, in its order, each key against its Workflow setting. */
const LOADED: readonly { field: string; key: StreamlineKey }[] = [
  { field: "rinseData.duration", key: "last-flush-duration" },
  { field: "hotWaterData.volume", key: "last-hot-water-volume" },
  { field: "hotWaterData.targetTemperature", key: "last-hot-water-temp" },
  { field: "steamSettings.duration", key: "last-steam-duration" },
  { field: "steamSettings.flow", key: "last-steam-flow" },
  { field: "steamSettings.stopAtTemperature", key: "last-milk-stop" },
];

/** Runs Streamline on the tablet, keeping these values in Decaid's store first, as it had kept them when the barista last set them. */
export async function startStreamline(tablet: SimulatedTablet, remembered: Partial<Record<StreamlineKey, number>> = {}): Promise<SimulatedStreamline> {
  const streamline = new SimulatedStreamline(tablet);
  for (const [key, value] of Object.entries(remembered)) await streamline.keep(key as StreamlineKey, value);
  return streamline;
}

/** What Streamline does with a value the Workflow holds (`decideResync`). */
type Decision = { action: "none" } | { action: "push"; value: number } | { action: "adopt"; value: unknown };

export class SimulatedStreamline {
  /** Each value Streamline pushed back over the Workflow, in order. */
  readonly pushes: { key: StreamlineKey; value: number }[] = [];
  /** Streamline's clock, Date.now() unless a test holds it still, as to stay inside `ECHO_WINDOW_MS`. */
  clock: () => number = () => Date.now();
  /** Each value Streamline adopted from the Workflow, in order. */
  readonly adopted: { key: StreamlineKey; value: unknown }[] = [];
  /** Its own pushes not yet taken by the Workflow, kept per device (`readPendingPush`). */
  private readonly pendingPushes = new Map<StreamlineKey, number>();
  /** Its latest push of each key, and when, by `clock` (`lastOwnPush`). */
  private readonly lastOwnPush = new Map<StreamlineKey, { value: number; at: number }>();
  /** The value of each field the last shot-settings frame carried. */
  private readonly lastSeen = new Map<string, number>();
  /** When each field was last pushed, by `clock`, as `lastResyncAt` keeps it. */
  private readonly lastResyncAt = new Map<string, number>();
  /** What Streamline is still doing in reply to a frame or a load. */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stopListening: () => void;

  constructor(private readonly tablet: SimulatedTablet) {
    this.stopListening = tablet.onWorkflowChange((workflow) => {
      if (!tablet.machineConnected) return;
      this.track(new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.shotSettings(workflow)));
    });
  }

  /** What Streamline keeps at the key in Decaid's store: null if nothing. */
  remembered(key: StreamlineKey): unknown {
    return this.tablet.storeValue(STREAMLINE_NAMESPACE, key);
  }

  /** A barista changes the value in Streamline, through its setter for it. */
  async set(key: StreamlineKey, value: number): Promise<void> {
    await this.push(key, value);
  }

  /** Streamline loads its data again, as when it starts or the machine connects again, and resolves once it has pushed what it does. */
  async reload(): Promise<void> {
    await this.track(
      (async () => {
        const { status, body } = await this.tablet.callApi("GET", "/workflow");
        if (status !== 200) throw new Error(`Decaid refused the Workflow with ${status}`);
        for (const { field, key } of LOADED) {
          const value = settingOf(body as Record_, field);
          if (key === "last-milk-stop" && !(typeof value === "number" && value > 0)) continue;
          await this.resyncIfDrifted(key, value);
        }
      })(),
    );
  }

  /** Resolves once Streamline has done what it does in reply to every frame and load so far. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Stops hearing of the Workflow's changes, as when another skin is chosen. */
  stop(): void {
    this.stopListening();
  }

  /** Keeps the value in Decaid's store, as `persistSharedValue` does: one adopted from the Workflow whatever it is. */
  async keep(key: StreamlineKey, value: unknown): Promise<void> {
    const { status, body } = await this.tablet.callApi("POST", `/store/${STREAMLINE_NAMESPACE}/${key}`, value);
    if (status !== 200) throw new Error(`Decaid refused to keep ${key} with ${status}: ${JSON.stringify(body)}`);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.catch(() => {}).finally(() => this.pending.delete(work));
    return work;
  }

  /** `resyncDriftedShotSettings`, for the frame the machine echoes after the Workflow changed. */
  private async shotSettings(workflow: Record_): Promise<void> {
    const now = this.clock();
    const checks: Promise<unknown>[] = [];
    for (const { field, key } of SHOT_SETTINGS_FIELDS) {
      const value = settingOf(workflow, field);
      if (typeof value !== "number" || value === this.lastSeen.get(field)) continue;
      this.lastSeen.set(field, value);
      if (now - (this.lastResyncAt.get(field) ?? 0) < RESYNC_COOLDOWN_MS) continue;
      this.lastResyncAt.set(field, now);
      // A failed push keeps the cooldown; Streamline logs it.
      checks.push(this.resyncIfDrifted(key, value).then((pushed) => pushed === null && this.lastResyncAt.delete(field)));
    }
    await Promise.allSettled(checks);
  }

  /** `resyncIfDrifted`: adopts a value the Workflow holds that differs from the one kept, or pushes as `decide` says. Resolves with the value pushed, else null. */
  private async resyncIfDrifted(key: StreamlineKey, value: unknown): Promise<number | null> {
    const { body: remembered } = await this.tablet.callApi("GET", `/store/${STREAMLINE_NAMESPACE}/${key}`);
    const decision = decide({ remembered, observed: value, pending: this.pendingPushes.get(key) ?? null, lastPush: this.lastOwnPush.get(key) ?? null, now: this.clock() });
    if (decision.action === "adopt") {
      this.adopted.push({ key, value: decision.value });
      await this.keep(key, decision.value);
      return null;
    }
    if (decision.action !== "push") return null;
    this.pushes.push({ key, value: decision.value });
    await this.push(key, decision.value);
    return decision.value;
  }

  /** Streamline's setter for the value. */
  private async push(key: StreamlineKey, value: number): Promise<void> {
    switch (key) {
      case "last-hot-water-volume":
        return this.pushRemembered(key, value, () => this.change({ hotWaterData: { volume: value } }));
      case "last-hot-water-temp":
        return this.pushRemembered(key, value, () => this.change({ hotWaterData: { targetTemperature: value } }));
      case "last-steam-duration":
        return this.pushRemembered(key, value, async () => this.change({ steamSettings: { duration: value, ...(await this.steamHeaterFor(value)) } }));
      case "last-steam-flow":
        return this.pushRemembered(key, value, () => this.change({ steamSettings: { flow: value } }));
      case "last-steam-temp": {
        const temperature = Math.round(value);
        if (temperature > 0) await this.keep(key, temperature);
        return this.change({ steamSettings: { targetTemperature: temperature } });
      }
      case "last-milk-stop": {
        const stop = Math.min(80, Math.max(0, value));
        const send = () => this.change({ steamSettings: { stopAtTemperature: stop } });
        return stop > 0 ? this.pushRemembered(key, stop, send) : send();
      }
      case "last-flush-duration":
        await this.change({ rinseData: { duration: value } });
        return this.keep(key, value);
    }
  }

  /** `pushRemembered`: keeps the value and marks it pending, then sends it, clearing the mark once the Workflow took it. */
  private async pushRemembered(key: StreamlineKey, value: number, send: () => Promise<void>): Promise<void> {
    await this.keep(key, value);
    this.lastOwnPush.set(key, { value, at: this.clock() });
    this.pendingPushes.set(key, value);
    await send();
    this.lastOwnPush.set(key, { value, at: this.clock() });
    this.pendingPushes.delete(key);
  }

  /** `steamHeaterFor`: steam off with a duration of 0, keeping the temperature it was at, and otherwise back at the one kept. */
  private async steamHeaterFor(duration: number): Promise<Record_> {
    if (duration === 0) {
      const { body } = await this.tablet.callApi("GET", "/workflow");
      const current = settingOf(body as Record_, "steamSettings.targetTemperature");
      if (typeof current === "number" && current > 0) await this.keep("last-steam-temp", current);
      return { targetTemperature: 0 };
    }
    const { body: kept } = await this.tablet.callApi("GET", `/store/${STREAMLINE_NAMESPACE}/last-steam-temp`);
    return typeof kept === "number" && kept > 0 ? { targetTemperature: Math.round(kept) } : {};
  }

  private async change(parts: Record<string, Record_>): Promise<void> {
    const { status, body } = await this.tablet.callApi("PUT", "/workflow", parts);
    if (status !== 200) throw new Error(`Decaid refused Streamline's change with ${status}: ${JSON.stringify(body)}`);
  }
}

/** `decideResync`: what Streamline does with the value the Workflow holds, given the one it keeps. */
function decide({ remembered, observed, pending, lastPush, now }: { remembered: unknown; observed: unknown; pending: number | null; lastPush: { value: number; at: number } | null; now: number }): Decision {
  // Its own push the Workflow has not taken is tried again.
  if (pending !== null && pending !== observed) return { action: "push", value: pending };
  if (remembered === null || remembered === undefined) return { action: "none" };
  // A setting the Workflow lacks is filled from the value kept.
  if (observed === null || observed === undefined) return { action: "push", value: remembered as number };
  if (remembered === observed) return { action: "none" };
  if (lastPush && now - lastPush.at < ECHO_WINDOW_MS && observed !== lastPush.value) return { action: "none" };
  return { action: "adopt", value: observed };
}

/** A setting of a Workflow by its name, such as `steamSettings.flow`. */
function settingOf(workflow: Record_, field: string): unknown {
  const [part, name] = field.split(".") as [string, string];
  const values = workflow[part];
  return typeof values === "object" && values !== null ? (values as Record_)[name] : undefined;
}
