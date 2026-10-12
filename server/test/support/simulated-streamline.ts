import type { SimulatedTablet } from "./simulated-tablet.js";

// Streamline (streamline-js) running as a simulated tablet's skin, as far as
// it touches the shared settings, as at v0.2.12 (bf72a0c). The plugin is not
// told of it: it calls Decaid's API as anything else on the tablet does
// (`SimulatedTablet.callApi`).
//
// Streamline remembers what the barista last set for some settings in
// Decaid's store, under `streamline-app` (the `*_LAST_VALUE_KEY` constants in
// streamline-js:src/modules/api.js), and pushes a remembered value back
// through `PUT /workflow` whenever the Workflow holds another, whoever
// changed it (`resyncIfDrifted`). It checks:
//
// - On every shot-settings frame from the machine, for steam duration and
//   hot water volume and temperature (`resyncDriftedShotSettings` and
//   `SHOT_SETTINGS_KV_FIELDS` in src/modules/app.js). Decaid sends the
//   machine new shot settings when the Workflow changes, and the machine
//   echoes them back, so here every change of the Workflow, while a machine
//   is connected, is followed by such a frame, in a later turn. A field
//   whose value repeats the last frame's is not checked, and one pushed is
//   not checked again for `RESYNC_COOLDOWN_MS` of real time.
// - On every load (`loadInitialData`), for every key it keeps, its milk
//   stop only while the Workflow's is on (`resyncMilkStopIfDrifted`):
//   `reload()`.
//
// Each push, and a barista's change made in Streamline (`set()`), goes
// through Streamline's setter for the value, which keeps the value in the
// store before it changes the Workflow (`setTargetHotWaterVolume` and the
// others), but for the flush duration, kept after (`updateFlushValue` in
// src/modules/ui.js). Its Auto steam mode, which pushes nothing, is left out.

/** Streamline's namespace in Decaid's store. */
export const STREAMLINE_NAMESPACE = "streamline-app";

/** How long Streamline waits before pushing a value it pushed on a shot-settings frame again (app.js). */
export const RESYNC_COOLDOWN_MS = 30_000;

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

export class SimulatedStreamline {
  /** Each value Streamline pushed back over the Workflow, in order. */
  readonly pushes: { key: StreamlineKey; value: number }[] = [];
  /** The value of each field the last shot-settings frame carried. */
  private readonly lastSeen = new Map<string, number>();
  /** When each field was last pushed, by Date.now(), as `lastResyncAt` keeps it. */
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

  /** Keeps the value in Decaid's store, as `persistSharedValue` does. */
  async keep(key: StreamlineKey, value: number): Promise<void> {
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
    const now = Date.now();
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

  /** `resyncIfDrifted`: pushes the value kept at the key if there is one and the Workflow holds another. */
  private async resyncIfDrifted(key: StreamlineKey, value: unknown): Promise<number | null> {
    const { body: remembered } = await this.tablet.callApi("GET", `/store/${STREAMLINE_NAMESPACE}/${key}`);
    if (remembered === null || remembered === undefined || remembered === value) return null;
    this.pushes.push({ key, value: remembered as number });
    await this.push(key, remembered as number);
    return remembered as number;
  }

  /** Streamline's setter for the value. */
  private async push(key: StreamlineKey, value: number): Promise<void> {
    switch (key) {
      case "last-hot-water-volume":
        await this.keep(key, value);
        return this.change({ hotWaterData: { volume: value } });
      case "last-hot-water-temp":
        await this.keep(key, value);
        return this.change({ hotWaterData: { targetTemperature: value } });
      case "last-steam-duration":
        await this.keep(key, value);
        return this.change({ steamSettings: { duration: value, ...(await this.steamHeaterFor(value)) } });
      case "last-steam-flow":
        await this.keep(key, value);
        return this.change({ steamSettings: { flow: value } });
      case "last-steam-temp": {
        const temperature = Math.round(value);
        if (temperature > 0) await this.keep(key, temperature);
        return this.change({ steamSettings: { targetTemperature: temperature } });
      }
      case "last-milk-stop": {
        const stop = Math.min(80, Math.max(0, value));
        if (stop > 0) await this.keep(key, stop);
        return this.change({ steamSettings: { stopAtTemperature: stop } });
      }
      case "last-flush-duration":
        await this.change({ rinseData: { duration: value } });
        return this.keep(key, value);
    }
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

/** A setting of a Workflow by its name, such as `steamSettings.flow`. */
function settingOf(workflow: Record_, field: string): unknown {
  const [part, name] = field.split(".") as [string, string];
  const values = workflow[part];
  return typeof values === "object" && values !== null ? (values as Record_)[name] : undefined;
}
