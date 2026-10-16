import type { DecaidAnswer } from "./decaid-beans.js";
import type { SimulatedTablet } from "./simulated-tablet.js";

// Streamline (streamline-js) running as a simulated tablet's skin, as far as
// it touches the shared settings, as on `main` at 07be2b3 (2026-10-14), and
// as far as its DYE strip, Drink tile and wake touch DYE2 and the Workflow,
// as in v0.2.14, which includes it, the first release Decent Sync supports
// (ADR-0017), checked against fixtures/decaid/dye2-v0.1.20/. The plugin is not told of it:
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
// (`updateFlushValue` in src/modules/ui.js). Left out: each profile's saved
// steam time and flow, sent on a switch to it (`applySavedSteamSettings`), its
// Auto steam mode, which writes back the steam settings it found on entering
// it, and its 20 s Workflow poll, which only repaints its tiles (ADR-0021).
//
// Once each Shot is stored, it also clears from the Workflow the batch,
// grinder, barista, drinker, Basket, RPM and note a DYE2 recipe or favourite
// set, so they do not label the next Shot (`clearDyeWorkflowContext` in
// src/modules/dyeStrip.js, called from app.js): `shotStored()`. DYE2 v0.1.20
// writes no `extras.dye` marker, so the clear is never scoped to the fields
// it marked.
//
// With DYE2 v0.1.20, which records into its selected recipe itself
// (`pluginRecordsDialIn` in src/modules/dye-selection.js), its DYE strip
// applies a recipe, then selects it in DYE2 (`applyRecipe` in dyeStrip.js):
// `applyRecipe()`; switched off, it clears DYE2's selection
// (`disableDye2Ui`): `switchDye2Off()`. Its Drink and Dose tiles send the
// dose and yield together, the yield as the active profile's target weight
// too, and save them for that profile (`updateDoseValue` in src/modules/ui.js,
// `saveContextToActiveProfile` in src/modules/profileManager.js):
// `setYield()` and `setDose()`. Its wake sends a profile with its saved
// dose, yield, grind and brew temperature (`loadProfileForWake`,
// decentespresso/streamline-js#153): `wake()`. The active profile is the
// tablet's profile record whose title is the Workflow's profile's
// (`syncActiveProfileFromTitle`), and what the tiles save for it is kept in
// Decaid's store under `streamlineProfileOverrides`, keyed by its id
// (src/modules/profile-overrides.js).

/** Streamline's namespace in Decaid's store. */
export const STREAMLINE_NAMESPACE = "streamline-app";

/** Where Streamline keeps each profile's saved dose, yield, grind and brew temperature, by profile id (profile-overrides.js). */
export const PROFILE_OVERRIDES_NAMESPACE = "streamlineProfileOverrides";

/** The dose Streamline's wake sends for a profile with none saved, where no dose was set since it started (DEFAULT_DOSE_WEIGHT). */
const DEFAULT_DOSE_WEIGHT = 18;

/** What a recipe applied from Streamline's DYE strip sent: its `PUT /workflow`, then, once Decaid took it, its `POST .../selection` to DYE2. */
export interface StreamlineApplied {
  workflow: DecaidAnswer;
  selection?: DecaidAnswer;
}

/** How long Streamline waits before pushing a value it pushed on a shot-settings frame again (app.js). */
const RESYNC_COOLDOWN_MS = 30_000;

/** How long after its own push Streamline ignores a differing value as a stale echo (resync-policy.js). */
const ECHO_WINDOW_MS = 10_000;

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
  /** Whether DYE2 confirmed the strip's last selection (`dye2Armed`). */
  private dye2Armed = false;
  /** The last dose and grind set in Streamline, which its wake falls back on (`rememberTileDefaults`). */
  private lastDose: number | undefined;
  private lastGrind: string | undefined;
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

  /**
   * What Streamline does once a Shot is stored (`clearDyeWorkflowContext`),
   * and as it starts with its DYE2 switch off, or DYE2 not loaded: where the
   * Workflow holds any of them, it clears its batch, coffee, grinder,
   * barista and drinker, and the Basket, RPM, note and `dye` marker in its
   * `extras`, in one `PUT /workflow` of the context alone, leaving its dose,
   * yield, grind setting and profile.
   */
  async shotStored(): Promise<void> {
    const { status, body } = await this.tablet.callApi("GET", "/workflow");
    if (status !== 200) throw new Error(`Decaid refused the Workflow with ${status}`);
    const context = ((body as Record_).context ?? {}) as Record_;
    const extras = (context.extras ?? {}) as Record_;
    const top = ["beanBatchId", "coffeeName", "coffeeRoaster", "grinderId", "grinderModel", "baristaName", "drinkerName"];
    const inExtras = ["basketId", "basketName", "rpm", "note", "dye"];
    if (!top.some((field) => context[field] != null) && !inExtras.some((field) => extras[field] != null)) return;
    await this.change({ context: { ...Object.fromEntries(top.map((field) => [field, null])), extras: Object.fromEntries(inExtras.map((field) => [field, null])) } });
  }

  /**
   * A barista taps the tablet's recipe in that slot on the DYE strip, as
   * the strip read it, or the recipe given (`applyRecipe` in dyeStrip.js):
   * it reads the Workflow, merges into it the recipe's embedded `workflow`,
   * its context over the Workflow's and its Profile whole, from the tablet's
   * profiles, hidden ones included, where it carries no steps, or, for a
   * recipe without one, its `dashboardVariables` as DYE2's dashboard does;
   * keeps the steam, hot water and flush values of the recipe's modes
   * (`persistSharedValue`) and sets them in the Workflow, sends the whole
   * Workflow, and, once Decaid took it, selects the recipe in DYE2, trying
   * once more on a failure but a 404.
   */
  async applyRecipe(recipe: string | Record_): Promise<StreamlineApplied> {
    const item = typeof recipe === "string" ? await this.recipeIn(recipe) : recipe;
    const read = await this.tablet.callApi("GET", "/workflow");
    const live = (read.status === 200 ? read.body : {}) as Record_;
    const dv = (item.dashboardVariables ?? {}) as Record_;
    const stored = item.workflow as Record_ | undefined;
    if (stored) {
      live.context = { ...((live.context ?? {}) as Record_), ...((stored.context ?? {}) as Record_) };
      if (stored.profile) live.profile = (await this.fullProfile(stored.profile)) ?? stored.profile;
    } else {
      const context: Record_ = { ...((live.context ?? {}) as Record_) };
      if (dv.dose != null) context.targetDoseWeight = dv.dose;
      if (dv.drink != null) context.targetYield = dv.drink;
      else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
      if (dv.grind != null) context.grinderSetting = String(dv.grind);
      if (dv.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
      if (dv.grinderId) context.grinderId = dv.grinderId;
      if (item.barista) context.baristaName = item.barista;
      if (item.drinker) context.drinkerName = item.drinker;
      live.context = context;
      if (item.profileId || item.profileTitle) {
        const snapshot = item.profileSnapshot as Record_ | undefined;
        live.profile = snapshot && Array.isArray(snapshot.steps) ? snapshot : ((item.profileId ? await this.fullProfile(item.profileId) : null) ?? { id: item.profileId, title: item.profileTitle });
      }
    }
    await this.mergeRecipeLiveSettings(live, dv);
    const workflow = await this.tablet.callApi("PUT", "/workflow", live);
    if (workflow.status !== 200) return { workflow };
    const selection = await this.postSelection({ kind: "recipe", id: String(item.id) });
    this.dye2Armed = selection.status === 200;
    return { workflow, selection };
  }

  /**
   * Its DYE2 switch turned off (`disableDye2Ui`): where DYE2 confirmed the
   * strip's last selection, or `GET /plugins` lists it loaded with its
   * `selection` endpoint, it clears DYE2's selection with `{}`, and changes
   * nothing in the Workflow. Resolves with DYE2's answer, or undefined if it
   * posted nothing.
   */
  async switchDye2Off(): Promise<DecaidAnswer | undefined> {
    const { body } = await this.tablet.callApi("GET", "/plugins");
    const dye2 = (Array.isArray(body) ? (body as Record_[]) : []).find((plugin) => plugin.id === "dye2.reaplugin");
    const records = !!dye2?.loaded && Array.isArray(dye2.api) && (dye2.api as Record_[]).some((endpoint) => endpoint.type === "http" && endpoint.id === "selection");
    if (!this.dye2Armed && !records) return undefined;
    this.dye2Armed = false;
    return this.postSelection({});
  }

  /** A barista sets the yield on the Drink tile (`updateDoseValue('out')`); see `setDose`. */
  async setYield(grams: number): Promise<DecaidAnswer> {
    return this.doseAndYield("out", grams);
  }

  /**
   * A barista sets the dose on the Dose tile (`updateDoseValue('in')`): it
   * sends the dose and yield shown together, `{ context: { targetDoseWeight,
   * targetYield } }`, with the active profile's library record, its
   * `target_weight` at the yield, where there is one and the yield is above
   * 0, then saves the value set for that profile. The profile sent is the
   * record's, at its own step temperatures, not the Workflow's.
   */
  async setDose(grams: number): Promise<DecaidAnswer> {
    return this.doseAndYield("in", grams);
  }

  /**
   * Streamline's wake onto the profile with that id (`loadProfileForWake`):
   * it sends the profile with its saved yield as `target_weight` and its
   * saved brew temperature (`withSavedBrewTemp`), and in the context its
   * saved dose, else the last dose set, else 18 g, its saved yield, else its
   * target weight, and its saved grind setting, else the last one set, else
   * null, which clears the Workflow's. Resolves with Decaid's answer.
   */
  async wake(profileId: string): Promise<DecaidAnswer> {
    const record = (await this.availableProfiles()).find((candidate) => candidate.id === profileId);
    if (!record) throw new Error(`Streamline has no profile ${profileId}`);
    const profile = record.profile as Record_;
    const meta = await this.savedFor(profileId, record);
    const targetDoseWeight = meta.targetDoseWeight ?? this.lastDose ?? DEFAULT_DOSE_WEIGHT;
    const grinderSetting = meta.grinderSetting ?? this.lastGrind ?? null;
    const parsedYield = parseFloat(String(meta.targetYield ?? profile.target_weight));
    const targetYield = Number.isNaN(parsedYield) ? 0 : parsedYield;
    const sent = withSavedBrewTemp(targetYield > 0 ? { ...profile, target_weight: targetYield } : profile, meta);
    const answer = await this.tablet.callApi("PUT", "/workflow", { profile: sent, context: { targetDoseWeight, targetYield, grinderSetting } });
    if (answer.status === 200) {
      if (typeof meta.targetSteamDuration === "number") await this.push("last-steam-duration", meta.targetSteamDuration);
      if (typeof meta.targetSteamFlow === "number") await this.push("last-steam-flow", meta.targetSteamFlow);
    }
    return answer;
  }

  /** Saves values for the profile with that id, as Streamline's tiles do for the active profile (`saveProfileOverride`), merged into what it kept. */
  async saveForProfile(profileId: string, fields: { targetDoseWeight?: number; targetYield?: number; grinderSetting?: string; brewTemperature?: number }): Promise<void> {
    const { body } = await this.tablet.callApi("GET", `/store/${PROFILE_OVERRIDES_NAMESPACE}/${encodeURIComponent(profileId)}`);
    const merged = { ...((body ?? {}) as Record_), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)) };
    const { status } = await this.tablet.callApi("POST", `/store/${PROFILE_OVERRIDES_NAMESPACE}/${encodeURIComponent(profileId)}`, merged);
    if (status !== 200) throw new Error(`Decaid refused Streamline's saved values with ${status}`);
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

  /** `updateDoseValue`: the dose and yield sent together, the yield as the active profile's target weight too, then saved for that profile. */
  private async doseAndYield(tile: "in" | "out", grams: number): Promise<DecaidAnswer> {
    const read = await this.tablet.callApi("GET", "/workflow");
    const workflow = (read.body ?? {}) as Record_;
    const context = (workflow.context ?? {}) as Record_;
    const targetDose = tile === "in" ? grams : Number(context.targetDoseWeight ?? 0);
    const targetYield = tile === "out" ? grams : Number(context.targetYield ?? 0);
    const active = await this.activeProfile(workflow);
    const payload: Record_ = { context: { targetDoseWeight: targetDose, targetYield } };
    if (active && Number.isFinite(targetYield) && targetYield > 0) payload.profile = { ...(active.profile as Record_), target_weight: targetYield };
    const answer = await this.tablet.callApi("PUT", "/workflow", payload);
    if (answer.status === 200) {
      if (tile === "in") this.lastDose = grams;
      if (active) await this.saveForProfile(String(active.id), tile === "in" ? { targetDoseWeight: grams } : { targetYield: grams });
    }
    return answer;
  }

  /** The profile records Streamline keeps (`loadAvailableProfiles`): the tablet's, hidden ones included, but not deleted ones. */
  private async availableProfiles(): Promise<Record_[]> {
    const { body } = await this.tablet.callApi("GET", "/profiles?includeHidden=true");
    return (Array.isArray(body) ? (body as Record_[]) : []).filter((record) => record.visibility !== "deleted");
  }

  /** The active profile's record: the one whose title is the Workflow's profile's (`syncActiveProfileFromTitle`), a visible one first. */
  private async activeProfile(workflow: Record_): Promise<Record_ | undefined> {
    const title = (workflow.profile as Record_ | undefined)?.title;
    const titled = (await this.availableProfiles()).filter((record) => (record.profile as Record_ | undefined)?.title === title);
    return titled.find((record) => record.visibility !== "hidden") ?? titled[0];
  }

  /** What Streamline saved for a profile, over what its record's metadata holds (`applyOverridesToRecords`). */
  private async savedFor(profileId: string, record: Record_): Promise<Record_> {
    const { body } = await this.tablet.callApi("GET", `/store/${PROFILE_OVERRIDES_NAMESPACE}/${encodeURIComponent(profileId)}`);
    return { ...((record.metadata ?? {}) as Record_), ...((body ?? {}) as Record_) };
  }

  /** `resolveFullProfile`: a profile with steps as given, else the tablet's record of its id, hidden ones included; null if none. */
  private async fullProfile(stub: unknown): Promise<Record_ | null> {
    const id = typeof stub === "string" ? stub : (stub as Record_ | null)?.id;
    if (typeof stub === "object" && stub !== null && Array.isArray((stub as Record_).steps)) return stub as Record_;
    if (!id) return null;
    const { body } = await this.tablet.callApi("GET", "/profiles?includeHidden=true");
    const record = (Array.isArray(body) ? (body as Record_[]) : []).find((candidate) => candidate.id === id);
    return record?.profile ? (record.profile as Record_) : null;
  }

  /** `mergeRecipeLiveSettings`: the steam, hot water and flush values of the recipe's modes, each kept (`persistSharedValue`) and set in the Workflow sent. */
  private async mergeRecipeLiveSettings(live: Record_, dv: Record_): Promise<void> {
    if (live.steamSettings && (dv.steamTimeS != null || dv.steamFlowMls != null)) {
      const steam = { ...(live.steamSettings as Record_) };
      if (dv.steamMode === "time" && dv.steamTimeS != null) {
        steam.duration = dv.steamTimeS;
        await this.keep("last-steam-duration", dv.steamTimeS);
      }
      if (dv.steamMode === "flow" && dv.steamFlowMls != null) {
        steam.flow = dv.steamFlowMls;
        await this.keep("last-steam-flow", dv.steamFlowMls);
      }
      live.steamSettings = steam;
    }
    if (live.hotWaterData && (dv.hotWaterMl != null || dv.hotWaterTempC != null)) {
      const hotWater = { ...(live.hotWaterData as Record_) };
      if (dv.hotWaterMode === "vol" && dv.hotWaterMl != null) {
        hotWater.volume = dv.hotWaterMl;
        await this.keep("last-hot-water-volume", dv.hotWaterMl);
      }
      if (dv.hotWaterMode === "temp" && dv.hotWaterTempC != null) {
        hotWater.targetTemperature = dv.hotWaterTempC;
        await this.keep("last-hot-water-temp", dv.hotWaterTempC);
      }
      live.hotWaterData = hotWater;
    }
    if (live.rinseData && dv.flushS != null) {
      live.rinseData = { ...(live.rinseData as Record_), duration: dv.flushS };
      await this.keep("last-flush-duration", dv.flushS);
    }
  }

  /** `postSelection` in dyeStrip.js: posted to DYE2's `selection`, once more on a failure but a 404. */
  private async postSelection(body: Record_): Promise<DecaidAnswer> {
    let answer = await this.tablet.callApi("POST", "/plugins/dye2.reaplugin/selection", body);
    if (answer.status !== 200 && answer.status !== 404) answer = await this.tablet.callApi("POST", "/plugins/dye2.reaplugin/selection", body);
    return answer;
  }

  /** The tablet's recipe in that slot, as the strip read it. */
  private async recipeIn(slot: string): Promise<Record_> {
    const { body } = await this.tablet.callApi("GET", "/store/dye2.reaplugin/recipes");
    const recipe = (Array.isArray(body) ? (body as Record_[]) : []).find((candidate) => candidate.id === slot);
    if (!recipe) throw new Error(`The tablet holds no recipe in slot ${slot}`);
    return recipe;
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

/**
 * A copy of the profile at the brew temperature saved for it, its first
 * step at it and the others moved by as much (`withSavedBrewTemp` in
 * profileManager.js, `profileAtBrewTemp` and `shiftedTemperatures` in
 * src/modules/brew-temp.js); the profile itself where none is saved or it
 * has no steps.
 */
function withSavedBrewTemp(profile: Record_, saved: Record_): Record_ {
  const target = saved.brewTemperature;
  if (typeof target !== "number" || !Number.isFinite(target) || !Array.isArray(profile.steps)) return profile;
  const steps = profile.steps as Record_[];
  const round = (value: number) => Math.round(value * 100) / 100;
  const origin = steps[0]?.temperature;
  const temperatures =
    typeof origin === "number" && Number.isFinite(origin)
      ? steps.map(({ temperature }) => (typeof temperature === "number" && Number.isFinite(temperature) ? round(temperature + target - origin) : round(target)))
      : steps.map(() => target);
  return { ...profile, steps: steps.map((step, index) => ({ ...step, temperature: temperatures[index] })) };
}
