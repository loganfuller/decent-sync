import type { DecaidAnswer } from "./decaid-beans.js";
import { assignRecipeInDye2 } from "./simulated-dye2.js";
import type { SimulatedTablet } from "./simulated-tablet.js";

// Streamline (streamline-js) running as a simulated tablet's skin, as at
// v0.2.21, the release Decent Sync supports (ADR-0017), as far as it touches
// DYE2, the Workflow and the settings it remembers. The plugin is not
// told of it: it calls Decaid's API as anything else on the tablet does
// (`SimulatedTablet.callApi`).
//
// Every write of the Workflow goes through `updateWorkflow` in
// src/modules/api.js, named for its writer, and throws before the PUT where
// the body holds a field that writer does not own (`assertDeclaredFields`
// and `WORKFLOW_WRITERS` in src/modules/workflow-fields.js); its profile goes
// as `putWorkflow` cleans it up, a step limiter of 0 as null among the rest.
//
// Streamline remembers what the barista last set for some settings in
// Decaid's store, under `streamline-app` (the `*_LAST_VALUE_KEY` constants in
// api.js), and compares the Workflow with it (`resyncIfDrifted`, which
// `decideResync` in src/modules/resync-policy.js decides for). A value the
// Workflow holds that differs from the one remembered is adopted: kept in the
// store, nothing pushed (ADR-0021). It pushes only its own push that has not
// reached the Workflow (`pending`), and the value remembered for a setting
// the Workflow lacks, and it ignores a differing value seen within
// `ECHO_WINDOW_MS` of its own push. It checks:
//
// - On every shot-settings frame from the machine, for steam duration and
//   hot water volume and temperature (`resyncDriftedShotSettings` and
//   `SHOT_SETTINGS_KV_FIELDS` in src/modules/app.js). Decaid sends the
//   machine new shot settings when the Workflow changes, and the machine
//   echoes them back, so here every change of the Workflow, while a machine
//   is connected, is followed by such a frame, in a later turn. A field
//   whose value repeats the last frame's is not checked, and one pushed is
//   not checked again for `RESYNC_COOLDOWN_MS` of real time.
// - On every load (`loadInitialData`), for every key it keeps but the steam
//   temperature, and its milk stop only while the Workflow's is on
//   (`resyncMilkStopIfDrifted`): `reload()`. It loads again after each apply
//   of a DYE2 item (`refreshAfterApply`).
//
// Each push, and a barista's change made in Streamline (`set()`), goes
// through Streamline's setter for the value, which keeps the value in the
// store and marks it pending before it changes the Workflow, and clears the
// mark once the Workflow took it (`pushRemembered`). The steam temperature is
// kept without a mark, and the flush duration only after the Workflow took it
// (`updateFlushValue` in src/modules/ui.js). A steam time of 0 is no timer
// and leaves the heater alone (bc487aa); the heater has a switch of its own,
// which turns it off at a target of 0, keeping the temperature it was at, and
// back on at the selected DYE2 recipe's steam temperature while its DYE2
// switch is on, else the one kept, only from off (`setSteamHeaterEnabled` and
// `steamHeaterFor`, streamline-js #143 and #156): `setSteamHeater()`. Two
// more ways turn steam on, the same at v0.2.21 as at cec5664. Its
// settings page (src/settings/settings.js) reads the Workflow as it opens,
// stages each steam change made on it, and writes them on Save, keeping the
// steam time, flow, temperature and milk stop in the store
// (`flushPendingChanges`); its Settings › Calibration › Steam heater switch
// turns steam back on at the temperature that page last switched off, else
// 150 °C, never at the one kept (`setSteamHeaterOn`): `openSettings()`.
// Auto Steam, choosing a pitcher, writes the steam time and flow the Auto
// Steam Calculator plugin works out, at the Workflow's steam temperature as
// it was entered, or with the heater off then at the one kept
// (`createAutoSteamSession` in src/modules/auto-steam-session.js):
// `autoSteam()`, the calculator's answer given. Left out: the rest of Auto
// Steam, and its 20 s Workflow poll, which only repaints its tiles
// (ADR-0021).
//
// Its DYE strip (src/modules/dyeStrip.js, src/modules/dye-selection.js)
// reads DYE2's recipes and favourites and whether DYE2 records dial-in
// itself, listed loaded with an HTTP `selection` endpoint
// (`loadDyeStripData`, `pluginRecordsDialIn`), and places a recipe in the
// cell of its `stripSlot`, or by its id `1` to `5` where no row has the key
// (`recipeStripCells`). A tap on a cell not highlighted applies the
// recipe (`applyRecipe()`), and on the highlighted one does nothing: its
// embedded `workflow`, its context and its Profile whole (`applyStoredWorkflow`),
// or, without one, its `dashboardVariables` (`applyRecipeLegacy`), the steam,
// hot water and flush values of its modes, each kept (`mergeRecipeLiveSettings`),
// and its id as `recipeId` (`recipeIdPatch`), as one partial `PUT
// /workflow`, then `POST .../selection` to DYE2, retried in the background
// where it fails and DYE2 records itself, DYE2's selection cleared where it
// never lands (`armSelection`, streamline-js#148). A favourite applied
// (`applyFavourite()`) writes `recipeId` null. Its long-press menu saves the
// dial-in into the selected recipe (`saveChanges()`: `POST .../record`),
// saves the Workflow as a recipe in an empty cell's slot (`saveToRecipe()`:
// "Save to recipe N", `POST .../save-recipe`), puts a recipe from DYE2's
// library in a cell's slot (`assignToCell()`: "Replace <name>" on a filled
// cell, "Select recipe" on an empty one, which open DYE2's Select Recipe to
// assign one, streamline-js 35c5917 and 0af3b9d), and frees a cell
// (`clearButton()`: the recipe's
// `showOnStreamlineDashboard` set false, and DYE2's selection cleared where
// the cell was selected). Switched off, it clears DYE2's selection
// (`disableDye2Ui`): `switchDye2Off()`. Once each Shot's record is stored it
// clears only the note (`noteClearContext` in src/modules/workflow-note.js,
// streamline-js#164): `shotStored()`.
//
// Its Drink and Dose tiles send the dose and yield together, with only the
// yield as the profile's `target_weight` (`updateDoseValue` and
// `targetWeightProfilePatch` in src/modules/brew-temp.js), and save the value
// set for the active profile: `setYield()` and `setDose()`. Its wake, and a
// tap of a profile's button, send the profile with its saved dose, yield,
// grind and brew temperature, `recipeId` null, then its saved steam time and
// flow, but send nothing where DYE2's mirrored selection names a recipe and
// the Workflow's profile is that profile (`recipeHoldsDial` in
// src/modules/profileManager.js): `wake()` and `tapProfile()`. The active
// profile is the tablet's profile record whose title is the Workflow's
// profile's (`syncActiveProfileFromTitle`), and what the tiles save for it is
// kept in Decaid's store under `streamlineProfileOverrides`, keyed by its id
// (src/modules/profile-overrides.js).

/** Streamline's namespace in Decaid's store. */
export const STREAMLINE_NAMESPACE = "streamline-app";

/** Where Streamline keeps each profile's saved dose, yield, grind and brew temperature, by profile id (profile-overrides.js). */
export const PROFILE_OVERRIDES_NAMESPACE = "streamlineProfileOverrides";

/** DYE2's namespace in Decaid's store, and the base of its endpoints. */
const DYE2 = "dye2.reaplugin";

/** The dose Streamline's wake sends for a profile with none saved, where no dose was set since it started (DEFAULT_DOSE_WEIGHT). */
const DEFAULT_DOSE_WEIGHT = 18;

/** What an item applied from Streamline's DYE strip sent: Decaid's answer to its `PUT /workflow`, then to its first `POST .../selection` to DYE2; `refused`, the error where `assertDeclaredFields` threw before the PUT. */
export interface StreamlineApplied {
  workflow?: DecaidAnswer;
  selection?: DecaidAnswer;
  refused?: string;
  /** The cell tapped was the highlighted one, so nothing was sent (#159 acceptance 1, 0af3b9d). */
  inert?: true;
}

/** How long Streamline waits before pushing a value it pushed on a shot-settings frame again (app.js). */
const RESYNC_COOLDOWN_MS = 30_000;

/** How long after its own push Streamline ignores a differing value as a stale echo (resync-policy.js). */
const ECHO_WINDOW_MS = 10_000;

/** The keys Streamline keeps the steam, hot water and rinse settings it remembers under (api.js). */
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

/** The writers of the Workflow simulated here, and the fields each owns (`WORKFLOW_WRITERS` in workflow-fields.js). */
const WORKFLOW_WRITERS: Readonly<Record<string, readonly string[]>> = {
  "tiles.doseYield": ["context.targetDoseWeight", "context.targetYield", "profile.target_weight"],
  "tiles.flush": ["rinseData.duration"],
  "api.steamTemp": ["steamSettings.targetTemperature"],
  "api.steamDuration": ["steamSettings.duration"],
  "api.steamFlow": ["steamSettings.flow"],
  "api.steamStopAt": ["steamSettings.stopAtTemperature"],
  "api.hotWater": ["hotWaterData.targetTemperature", "hotWaterData.volume", "hotWaterData.duration", "hotWaterData.flow"],
  "api.steamHeater": ["steamSettings"],
  "api.autoSteam": ["steamSettings.duration", "steamSettings.flow", "steamSettings.targetTemperature", "steamSettings.stopAtTemperature"],
  "settings.steam": ["steamSettings.targetTemperature", "steamSettings.duration", "steamSettings.flow", "steamSettings.stopAtTemperature"],
  "profile.send": ["profile", "context.targetDoseWeight", "context.targetYield", "context.grinderSetting", "context.extras.dye"],
  "profile.wake": ["profile", "context.targetDoseWeight", "context.targetYield", "context.grinderSetting", "context.extras.dye"],
  "shot.clearNote": ["context.extras.note"],
  "dye.applyFavourite": [
    "profile",
    "context.targetDoseWeight",
    "context.targetYield",
    "context.grinderSetting",
    "context.extras.rpm",
    "context.extras.dye",
    "context.coffeeName",
    "context.coffeeRoaster",
    "context.beanBatchId",
    "context.baristaName",
    "context.drinkerName",
    "context.basket",
    "context.grinderId",
    "context.grinderModel",
    "context.extras.basketId",
    "context.extras.basketName",
    "context.roastDate",
    "context.extras.note",
  ],
  "dye.applyRecipe": [
    "profile",
    "context.targetDoseWeight",
    "context.targetYield",
    "context.grinderSetting",
    "context.extras.rpm",
    "context.extras.dye",
    "context.coffeeName",
    "context.coffeeRoaster",
    "context.beanBatchId",
    "context.baristaName",
    "context.drinkerName",
    "context.basket",
    "context.grinderId",
    "context.grinderModel",
    "context.extras.basketId",
    "context.extras.basketName",
    "steamSettings.targetTemperature",
    "steamSettings.duration",
    "steamSettings.flow",
    "hotWaterData.targetTemperature",
    "hotWaterData.volume",
    "hotWaterData.duration",
    "hotWaterData.flow",
    "rinseData",
  ],
};

/** The field paths a Workflow body writes, `profile` walked into like the rest, arrays as leaves (`workflowPatchKeys`). */
function workflowPatchKeys(patch: unknown, prefix = ""): string[] {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return prefix ? [prefix] : [];
  const entries = Object.entries(patch as Record_);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value === null || typeof value !== "object" || Array.isArray(value) ? [path] : workflowPatchKeys(value, path);
  });
}

/** `assertDeclaredFields`: throws where the body writes a field its writer does not own. */
function assertDeclaredFields(writer: string, patch: Record_): void {
  const declared = WORKFLOW_WRITERS[writer];
  if (!declared) throw new Error(`updateWorkflow: unknown writer '${writer}' -- add it to WORKFLOW_WRITERS`);
  const undeclared = workflowPatchKeys(patch).filter((path) => !declared.some((owned) => path === owned || path.startsWith(`${owned}.`)));
  if (undeclared.length > 0) throw new Error(`updateWorkflow: writer '${writer}' sent undeclared field(s) ${undeclared.join(", ")}`);
}

/**
 * Streamline's settings page as `openSettings()` opened it, as far as its
 * steam settings go (src/settings/settings.js). Each change made on it is
 * staged, field by field, over the Workflow it read as it opened
 * (`updateSteamSetting`, `stageWorkflowField`), until Save.
 */
export interface StreamlineSettings {
  /**
   * The heater switch on Settings › Calibration › Steam (`setSteamHeaterOn`):
   * off stages a target of 0, keeping in memory the temperature it was at,
   * where above 0 (`lastEnabledSteamCalibTemp`); on stages that temperature,
   * else the page's where above 0, else 150 °C. It never reads the one
   * Streamline keeps in the store.
   */
  steamHeater(on: boolean): void;
  /** A steam temperature set on that page, in °C (`steamCalibTempInput`). */
  steamTemperature(celsius: number): void;
  /**
   * Save (`flushPendingChanges`): the staged steam fields written into the
   * Workflow as one partial `PUT /workflow` (`settings.steam`), then each
   * kept in Decaid's store, the steam time and flow, a temperature above 0
   * and a milk stop above 0 (`persistSharedValue`); nothing where none is
   * staged.
   */
  save(): Promise<void>;
}

/** How Streamline runs: its DYE2 switch, on unless given, and the waits before each retry of a selection that failed (`armSelection`). */
export interface StreamlineOptions {
  dye2Enabled?: boolean;
  selectionRetriesMs?: readonly number[];
}

/** The waits `armSelection` in dyeStrip.js retries a failed selection after, before it gives up and clears DYE2's selection. */
const SELECTION_RETRIES_MS = [2000, 5000, 10000, 20000, 30000];

/**
 * Runs Streamline on the tablet, keeping these values in Decaid's store
 * first, as it had kept them when the barista last set them, and, with its
 * DYE2 switch on, reading the strip's data and DYE2's selection as it starts
 * (`enableDye2Ui`, then `restoreParkedSelection`).
 */
export async function startStreamline(tablet: SimulatedTablet, remembered: Partial<Record<StreamlineKey, number>> = {}, options: StreamlineOptions = {}): Promise<SimulatedStreamline> {
  const streamline = new SimulatedStreamline(tablet, options);
  for (const [key, value] of Object.entries(remembered)) await streamline.keep(key as StreamlineKey, value);
  await streamline.repoll();
  return streamline;
}

/** What Streamline does with a value the Workflow holds (`decideResync`). */
type Decision = { action: "none" } | { action: "push"; value: number } | { action: "adopt"; value: unknown };

export class SimulatedStreamline {
  /** Each value Streamline pushed back over the Workflow, in order. */
  readonly pushes: { key: StreamlineKey; value: number }[] = [];
  /** Streamline's clock, Date.now() unless a test holds it still, as to stay inside `ECHO_WINDOW_MS`. */
  clock: () => number = () => Date.now();
  /** The body of each `PUT /workflow` Streamline sent, in order. */
  readonly sent: Record_[] = [];
  /** Each value Streamline adopted from the Workflow, in order. */
  readonly adopted: { key: StreamlineKey; value: unknown }[] = [];
  /** Each write `assertDeclaredFields` refused before its PUT, in order: the error. */
  readonly refused: string[] = [];
  /** Its own pushes not yet taken by the Workflow, kept per device (`readPendingPush`). */
  private readonly pendingPushes = new Map<StreamlineKey, number>();
  /** Its latest push of each key, and when, by `clock` (`lastOwnPush`). */
  private readonly lastOwnPush = new Map<StreamlineKey, { value: number; at: number }>();
  /** The value of each field the last shot-settings frame carried. */
  private readonly lastSeen = new Map<string, number>();
  /** When each field was last pushed, by `clock`, as `lastResyncAt` keeps it. */
  private readonly lastResyncAt = new Map<string, number>();
  /** The strip's recipes and favourites as it last read them (`recipeCache`, `favCache`). */
  private recipeCache: Record_[] = [];
  private favCache: Record_[] = [];
  /** Whether DYE2 records dial-in itself, as the strip last read it (`dye2RecordsDialIn`). */
  private dye2RecordsDialIn = false;
  /** Whether DYE2 confirmed the strip's last selection (`dye2Armed`). */
  private dye2Armed = false;
  /** The cell the strip highlights (`activeItemId`), and whether DYE2 says it drifted (`activeModified`). */
  private activeItemId: unknown = null;
  private activeModified = false;
  /** Its DYE2 switch (`streamline.dye2Enabled`). */
  private dye2Enabled: boolean;
  /** Each apply's number: only the newest arms, or retries (`applySeq`). */
  private applySeq = 0;
  private readonly selectionRetriesMs: readonly number[];
  /** The last dose and grind set in Streamline, which its wake falls back on (`rememberTileDefaults`). */
  private lastDose: number | undefined;
  private lastGrind: string | undefined;
  /** What Streamline is still doing in reply to a frame or a load. */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stopListening: () => void;

  constructor(
    private readonly tablet: SimulatedTablet,
    { dye2Enabled = true, selectionRetriesMs = SELECTION_RETRIES_MS }: StreamlineOptions = {},
  ) {
    this.dye2Enabled = dye2Enabled;
    this.selectionRetriesMs = selectionRetriesMs;
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

  /**
   * The steam heater switched on or off (`setSteamHeaterEnabled`): off sends
   * a target of 0, keeping the temperature it was at; on, only from off, the
   * temperature of the recipe DYE2's mirrored selection names, where its DYE2
   * switch is on and that recipe holds one of 135 or more
   * (`selectedRecipeSteamTemp`), else the one kept, else nothing; the steam
   * time is left alone.
   */
  async setSteamHeater(enabled: boolean): Promise<void> {
    await this.change({ steamSettings: await this.steamHeaterFor(enabled ? 1 : 0) }, "api.steamHeater");
  }

  /**
   * Its settings page opened (`loadSettings` in src/settings/settings.js),
   * as far as its steam settings go: it reads the Workflow as it opens
   * (`settingsCache.workflow`), and holds what it keeps in memory until it
   * is left, as a page of its own (`loadPage('src/settings/settings.html')`).
   * See `StreamlineSettings`.
   */
  async openSettings(): Promise<StreamlineSettings> {
    const { status, body } = await this.tablet.callApi("GET", "/workflow");
    if (status !== 200) throw new Error(`Decaid refused the Workflow with ${status}`);
    const cached = { ...(((body as Record_).steamSettings ?? {}) as Record_) };
    let staged: Record_ = {};
    let lastEnabledSteamCalibTemp: number | null = null;
    const stage = (key: string, value: number) => {
      cached[key] = value;
      staged = { ...staged, [key]: value };
    };
    return {
      steamHeater: (on) => {
        const current = typeof cached.targetTemperature === "number" ? cached.targetTemperature : 0;
        let value = 0;
        if (on) value = lastEnabledSteamCalibTemp ?? (current > 0 ? current : 150);
        else if (current > 0) lastEnabledSteamCalibTemp = current;
        stage("targetTemperature", value);
      },
      steamTemperature: (celsius) => stage("targetTemperature", Math.round(celsius)),
      save: async () => {
        const steam = staged;
        staged = {};
        if (Object.keys(steam).length === 0) return;
        await this.change({ steamSettings: steam }, "settings.steam");
        const kept = (key: StreamlineKey, value: unknown, above?: number) =>
          typeof value === "number" && Number.isFinite(value) && (above === undefined || value > above) ? this.keep(key, value) : undefined;
        await kept("last-steam-duration", steam.duration);
        await kept("last-steam-flow", steam.flow);
        await kept("last-steam-temp", steam.targetTemperature, 0);
        await kept("last-milk-stop", steam.stopAtTemperature, 0);
      },
    };
  }

  /**
   * A barista turns Auto Steam on and chooses a pitcher, with the machine
   * idle (`enter`, then `select`, of `createAutoSteamSession` in
   * src/modules/auto-steam-session.js). As it is entered it keeps the
   * Workflow's steam settings as the manual ones, and turns the steam timer
   * and milk stop off at the pitcher's flow, where the Workflow holds
   * otherwise (`off`). The pitcher chosen writes the steam time and flow the
   * Auto Steam Calculator plugin worked out for it, given here (its
   * `workflowPatch`), as the calculator is not simulated, with the manual
   * steam temperature, or, where the heater was off as Auto Steam was
   * entered, the one kept (`getHeaterTemperature`, `last-steam-temp`, in
   * src/modules/calibrated-steam-ui.js), and the milk stop off, its time
   * rounded (`writeAutoSteamSettings` and `clampAutoSteamSettings`). It
   * refuses a steam temperature that is not a whole number from 135 to
   * 165 °C, as Streamline does.
   */
  async autoSteam(calculated: { duration: number; flow: number }): Promise<void> {
    const { status, body } = await this.tablet.callApi("GET", "/workflow");
    if (status !== 200) throw new Error(`Decaid refused the Workflow with ${status}`);
    const steam = ((body as Record_).steamSettings ?? {}) as Record_;
    const manual = steam.targetTemperature;
    if (![steam.duration, steam.flow, manual].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("Steam settings are unavailable.");
    const off: Record_ = { duration: 0, stopAtTemperature: 0, flow: calculated.flow };
    if (!Object.entries(off).every(([key, value]) => (steam[key] ?? (key === "stopAtTemperature" ? 0 : undefined)) === value)) {
      await this.change({ steamSettings: off }, "api.autoSteam");
    }
    const targetTemperature = (manual as number) > 0 ? manual : (await this.tablet.callApi("GET", `/store/${STREAMLINE_NAMESPACE}/last-steam-temp`)).body;
    if (typeof targetTemperature !== "number" || !Number.isInteger(targetTemperature) || targetTemperature < 135 || targetTemperature > 165) {
      throw new Error("Set the heater temperature in normal Steam settings, then calculate again.");
    }
    const duration = Math.max(0, Math.min(255, Math.round(calculated.duration)));
    const flow = Math.max(0, Math.min(2.5, calculated.flow));
    await this.change({ steamSettings: { duration, flow, targetTemperature, stopAtTemperature: 0 } }, "api.autoSteam");
  }

  /** Streamline loads its data again, as when it starts, the machine connects again, or an apply of a DYE2 item ends, and resolves once it has pushed what it does. */
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

  /** Resolves once Streamline has done what it does in reply to every frame, load and selection retry so far. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * What Streamline does once a Shot's record is stored (the `finalize`
   * frame, `noteClearContext`): `PUT /workflow` of `{ context: { extras: {
   * note: null } } }` where the Workflow holds a note, nothing otherwise.
   * Resolves with the context sent, or undefined if it sent nothing.
   */
  async shotStored(): Promise<Record_ | undefined> {
    const { status, body } = await this.tablet.callApi("GET", "/workflow");
    if (status !== 200) throw new Error(`Decaid refused the Workflow with ${status}`);
    const context = ((body as Record_).context ?? {}) as Record_;
    if ((context.extras as Record_ | undefined)?.note == null) return undefined;
    const clear = { extras: { note: null } };
    await this.change({ context: clear }, "shot.clearNote");
    return clear;
  }

  /**
   * The strip's data read again, and DYE2's selection, as a focus, a plugin's
   * push or a return from DYE2 does (`repoll`): DYE2's recipes and
   * favourites, kept as they were where a read fails, whether it records
   * dial-in itself, and, where it does, the cell to highlight from its
   * derived selection (`syncSelection`).
   */
  async repoll(): Promise<void> {
    if (!this.dye2Enabled) return;
    await this.loadDyeStripData();
    await this.syncSelection();
  }

  /**
   * The strip's cells, as it last read DYE2's recipes (`recipeStripCells`):
   * each slot 1 to 5 with the recipe placed there, by `stripSlot`, or by id
   * where no row has a `stripSlot` key, a recipe hidden from the strip
   * leaving its cell blank.
   */
  cells(): { slot: number; recipe: Record_ | null }[] {
    return recipeStripCells(this.recipeCache).map(({ slot, recipe }) => ({ slot: Number(slot), recipe }));
  }

  /**
   * A barista taps a recipe's cell on the DYE strip, read afresh (`renderStrip`,
   * then `applyRecipe` in dyeStrip.js): the cell of that slot, or the cell
   * holding the recipe with that record id. A tap on the highlighted cell, its
   * recipe the one DYE2's selection names, does nothing, so it never sets the
   * Machine back to the recipe's stored values (`inert`). Otherwise it
   * highlights the cell, then sends as one partial `PUT /workflow` the
   * recipe's embedded `workflow` (its context and its Profile whole, from the
   * tablet's profiles where it carries no steps, and none where neither has
   * steps, 16903cc), or without one its
   * `dashboardVariables`, the steam,
   * hot water and flush values of its modes, each kept (`persistSharedValue`),
   * and its id as `recipeId`; then, once Decaid took it, selects it in DYE2,
   * trying once more on a failure but a 404 (`postSelection`). Where that
   * fails and DYE2 records itself, it tries again after each of
   * `selectionRetriesMs`, until one lands, a newer apply or its switch turned
   * off stops it, or the last fails, when it clears DYE2's selection
   * (`armSelection`): `settled()` waits for that too. Last it loads its data
   * again (`refreshAfterApply`). A body holding a field `dye.applyRecipe`
   * does not own is refused before the PUT (`assertDeclaredFields`).
   */
  async applyRecipe(cell: number | string): Promise<StreamlineApplied> {
    await this.loadDyeStripData();
    const recipe = this.cells().find(({ slot, recipe }) => (typeof cell === "number" ? slot === cell : recipe?.id === cell))?.recipe;
    if (!recipe) throw new Error(`The DYE strip shows no recipe in ${typeof cell === "number" ? `cell ${cell}` : `a cell as ${cell}`}`);
    if (recipe.id != null && recipe.id === this.activeItemId) return { inert: true };
    this.activeItemId = recipe.id;
    this.activeModified = false;
    const dv = (recipe.dashboardVariables ?? {}) as Record_;
    const patch = recipe.workflow ? await this.applyStoredWorkflow(recipe.workflow as Record_) : await this.applyRecipeLegacy(recipe);
    Object.assign(patch, await this.mergeRecipeLiveSettings(dv));
    mergeContext(patch, recipeIdPatch(recipe.id));
    return this.applyItem("recipe", recipe.id, patch, "dye.applyRecipe");
  }

  /**
   * A barista taps a favourite's cell on the DYE strip (`applyFavourite` in
   * dyeStrip.js): its embedded `workflow`, or without one its `snapshot` as
   * its `copyMask` allows, and `recipeId` null, sent, then the favourite
   * selected in DYE2, as `applyRecipe` does.
   */
  async applyFavourite(favourite: Record_): Promise<StreamlineApplied> {
    this.activeItemId = favourite.id;
    this.activeModified = false;
    const patch = favourite.workflow ? await this.applyStoredWorkflow(favourite.workflow as Record_) : await this.applyFavLegacy(favourite);
    mergeContext(patch, recipeIdPatch(null));
    return this.applyItem("favourite", favourite.id, patch, "dye.applyFavourite");
  }

  /**
   * "Save changes" on the long-press menu of the selected recipe's cell
   * (`saveChanges`), offered only where the strip, read again as DYE2's push
   * makes it (`repoll`), highlights that recipe and DYE2 records dial-in:
   * `POST .../record`; then, where DYE2 saved, the strip's data read again.
   * Resolves with DYE2's answer.
   */
  async saveChanges(recordId: string): Promise<DecaidAnswer> {
    await this.repoll();
    if (this.activeItemId == null || this.activeItemId !== recordId || !this.dye2RecordsDialIn) throw new Error(`Streamline offers no Save changes on recipe ${recordId}: its cell is not the one selected`);
    const answer = await this.tablet.callApi("POST", `/plugins/${DYE2}/record`);
    if (answer.status === 200) {
      if ((answer.body as Record_ | null)?.saved) {
        this.activeModified = false;
        await this.loadDyeStripData();
      }
      await this.syncSelection(false);
    }
    return answer;
  }

  /**
   * "Save to recipe N" on an empty cell's long-press menu (`saveToRecipes`):
   * `POST .../save-recipe` `{"slot":N}`, then the strip's data read again,
   * and the cell of the recipe the Workflow then names highlighted. A filled
   * cell offers no such item: its "Replace <name>" is `assignToCell`.
   * Resolves with DYE2's answer.
   */
  async saveToRecipe(slot: 1 | 2 | 3 | 4 | 5): Promise<DecaidAnswer> {
    await this.loadDyeStripData();
    if (this.cells().find((cell) => cell.slot === slot)?.recipe) throw new Error(`The DYE strip's cell ${slot} holds a recipe: it offers "Replace", not "Save to recipe ${slot}"`);
    const answer = await this.tablet.callApi("POST", `/plugins/${DYE2}/save-recipe`, { slot: Number(slot) });
    if (answer.status === 200) {
      await this.loadDyeStripData();
      await this.syncSelection(false);
    }
    return answer;
  }

  /**
   * "Replace <name>" on a filled cell's long-press menu, or "Select recipe"
   * on an empty one's (`openPluginOverlay('select-recipe', { slot })`): DYE2's
   * Select Recipe page opened in assign mode for that cell's slot, where the
   * recipe with that record id is picked and assigned to it
   * (`assignRecipeInDye2`), then, back on the strip, its data read again and
   * its Workflow-derived highlight (`closePluginOverlay(true)`, or the page
   * loading again where DYE2 is on another origin). Applies nothing. Resolves
   * with the recipe DYE2 saved.
   */
  async assignToCell(slot: 1 | 2 | 3 | 4 | 5, recordId: string): Promise<Record_> {
    const saved = await assignRecipeInDye2(this.tablet, recordId, slot);
    await this.repoll();
    return saved;
  }

  /**
   * "Clear button" on a recipe's cell (`clearCell`): DYE2's recipes read, the
   * recipe's `showOnStreamlineDashboard` set false and the list posted
   * (`saveItemTopLevel`); where the cell was the one selected, the
   * highlight dropped and DYE2's selection cleared with `{}` where DYE2
   * confirmed the strip's last selection or records itself (`clearSelection`).
   * Resolves with whether DYE2 still held the recipe.
   */
  async clearButton(slot: 1 | 2 | 3 | 4 | 5): Promise<boolean> {
    const recipe = this.cells().find((cell) => cell.slot === slot)?.recipe;
    if (!recipe) throw new Error(`The DYE strip shows no recipe in cell ${slot}`);
    const { status, body } = await this.tablet.callApi("GET", `/store/${DYE2}/recipes`);
    if (status !== 200) throw new Error("DYE2 read failed");
    const list = Array.isArray(body) ? (body as Record_[]) : [];
    const index = list.findIndex((row) => row && String(row.id) === String(recipe.id));
    if (index === -1) return false;
    const next = list.map((row, at) => (at === index ? { ...row, showOnStreamlineDashboard: false } : row));
    const written = await this.tablet.callApi("POST", `/store/${DYE2}/recipes`, next);
    if (written.status !== 200) throw new Error(`Decaid refused DYE2's recipes with ${written.status}`);
    this.recipeCache = next;
    if (recipe.id != null && recipe.id === this.activeItemId) {
      this.applySeq++;
      this.activeItemId = null;
      this.activeModified = false;
      if (this.dye2Armed || this.dye2RecordsDialIn) await this.postSelection("", null);
      this.dye2Armed = false;
    }
    return true;
  }

  /**
   * Its DYE2 switch turned off (`disableDye2Ui`): any selection still being
   * retried is dropped, and where DYE2 confirmed the strip's last selection,
   * or records itself as the strip last read it, it clears DYE2's selection
   * with `{}`, and changes nothing in the Workflow itself. Resolves with
   * DYE2's answer, or undefined if it posted nothing.
   */
  async switchDye2Off(): Promise<DecaidAnswer | undefined> {
    this.applySeq++;
    this.dye2Enabled = false;
    if (!this.dye2Armed && !this.dye2RecordsDialIn) return undefined;
    this.dye2Armed = false;
    return (await this.postSelection("", null)).answer;
  }

  /** A barista sets the yield on the Drink tile (`updateDoseValue('out')`); see `setDose`. */
  async setYield(grams: number): Promise<DecaidAnswer> {
    return this.doseAndYield("out", grams);
  }

  /**
   * A barista sets the dose on the Dose tile (`updateDoseValue('in')`): it
   * sends the dose and yield together, the other read from the Workflow now
   * (Streamline takes it from the tile, which repaints only on its own
   * writes, its 20 s poll, focus or a plugin's push, so a tap there soon
   * after another app changed it sends the old value back: not simulated),
   * `{ context: { targetDoseWeight, targetYield } }`, with `profile: {
   * target_weight }` the yield where it is above 0
   * (`targetWeightProfilePatch`), then saves the value set for the active
   * profile.
   */
  async setDose(grams: number): Promise<DecaidAnswer> {
    return this.doseAndYield("in", grams);
  }

  /**
   * Streamline's wake onto the profile with that id (`loadProfileForWake`):
   * where it leaves the dial alone (`recipeHoldsDial`: its DYE2 switch on,
   * DYE2's mirrored selection naming a recipe, and the Workflow's profile
   * that profile by its fingerprint), it sends nothing. Otherwise it would
   * send the profile with its saved yield as `target_weight` and its saved
   * brew temperature (`withSavedBrewTemp`), and in the context its saved
   * dose, else the last dose set, else 18 g, its saved yield, else its target
   * weight, its saved grind setting, else the last one set, and `recipeId`
   * null, then its saved steam time and flow, so a wake onto a profile other
   * than the Loaded Recipe's unloads it (its writer, `profile.wake`, owns
   * `profile` from v0.2.19, 1324df8). Resolves with Decaid's answer, or
   * undefined where nothing was sent.
   */
  async wake(profileId: string): Promise<DecaidAnswer | undefined> {
    return this.sendProfile(profileId, "profile.wake");
  }

  /**
   * A barista taps the button of the profile with that id
   * (`handleProfileClick`): as `wake` describes, sent by `profile.send`,
   * which owns it, a grind setting neither saved nor set sent as null, the
   * steam time and flow only where the dial was not left alone.
   */
  tapProfile(profileId: string): Promise<DecaidAnswer | undefined> {
    return this.sendProfile(profileId, "profile.send");
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

  /** `loadDyeStripData`: DYE2's favourites and recipes, each kept as it was where its read fails, and whether DYE2 records dial-in, kept where `GET /plugins` fails. */
  private async loadDyeStripData(): Promise<void> {
    const list = async (key: string) => {
      const { status, body } = await this.tablet.callApi("GET", `/store/${DYE2}/${key}`);
      return status === 200 ? (Array.isArray(body) ? (body as Record_[]) : []) : null;
    };
    const [favourites, recipes, plugins] = await Promise.all([list("autoFavourites"), list("recipes"), this.tablet.callApi("GET", "/plugins")]);
    if (favourites) this.favCache = favourites;
    if (recipes) this.recipeCache = recipes;
    if (plugins.status === 200 && Array.isArray(plugins.body)) {
      const dye2 = (plugins.body as Record_[]).find((plugin) => plugin.id === DYE2);
      this.dye2RecordsDialIn = !!dye2?.loaded && Array.isArray(dye2.api) && (dye2.api as Record_[]).some((endpoint) => endpoint?.type === "http" && endpoint?.id === "selection");
    }
  }

  /** `syncSelection`: where DYE2 records itself, the highlight and its `*` from DYE2's derived selection, else, with `mirror`, its store key `selection`; left as they are where neither answers. */
  private async syncSelection(mirror = true): Promise<void> {
    if (!this.dye2RecordsDialIn) return;
    const before = this.activeItemId;
    const seq = this.applySeq;
    let selection: unknown;
    const route = await this.tablet.callApi("GET", `/plugins/${DYE2}/selection`);
    if (route.status === 200) selection = route.body;
    else if (mirror) {
      const stored = await this.tablet.callApi("GET", `/store/${DYE2}/selection`);
      selection = stored.status === 200 ? stored.body : undefined;
    } else return;
    if (selection === undefined || this.activeItemId !== before || this.applySeq !== seq) return;
    const derived = (selection ?? null) as Record_ | null;
    const list = derived?.kind === "recipe" ? this.recipeCache : derived?.kind === "favourite" ? this.favCache : null;
    const found = derived && derived.id != null && list ? list.find((item) => item && String(item.id) === String(derived.id)) : undefined;
    this.activeItemId = found ? found.id : null;
    this.activeModified = !!found && derived!.kind === "recipe" && derived!.modified === true;
  }

  /** An item's patch sent, then the item selected in DYE2 (`armSelection`), then Streamline's data loaded again (`refreshAfterApply`). */
  private async applyItem(kind: "recipe" | "favourite", id: unknown, patch: Record_, writer: string): Promise<StreamlineApplied> {
    const seq = ++this.applySeq;
    let workflow: DecaidAnswer;
    try {
      workflow = await this.send(patch, writer);
    } catch (error) {
      const refused = error instanceof Error ? error.message : String(error);
      this.refused.push(refused);
      return { refused };
    }
    if (workflow.status !== 200 || seq !== this.applySeq) return { workflow };
    const { landed, answer: selection } = await this.postSelection(kind, id);
    if (seq !== this.applySeq) return { workflow, selection };
    if (landed) this.dye2Armed = true;
    else if (this.dye2RecordsDialIn) {
      this.dye2Armed = true;
      this.track(this.retrySelection(kind, id, seq));
    } else this.dye2Armed = false;
    await this.reload();
    return { workflow, selection };
  }

  /** `armSelection`'s retries in the background, then DYE2's selection cleared if none landed. */
  private async retrySelection(kind: string, id: unknown, seq: number): Promise<void> {
    const current = () => seq === this.applySeq && this.dye2Enabled;
    for (const wait of this.selectionRetriesMs) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (!current()) return;
      if ((await this.postSelection(kind, id)).landed) return;
    }
    if (current()) await this.postSelection("", null);
  }

  /** `postSelection` in dyeStrip.js: `{kind, id}` posted to DYE2's `selection`, `{}` for no id or a recent one's, once more on a failure but a 404. */
  private async postSelection(kind: string, id: unknown): Promise<{ landed: boolean; answer: DecaidAnswer }> {
    const body = id != null && !String(id).startsWith("recent:") ? { kind, id: String(id) } : {};
    let answer = await this.tablet.callApi("POST", `/plugins/${DYE2}/selection`, body);
    if (answer.status !== 200 && answer.status !== 404) answer = await this.tablet.callApi("POST", `/plugins/${DYE2}/selection`, body);
    return { landed: answer.status === 200, answer };
  }

  /** `applyStoredWorkflow`: an item's stored `workflow`, its context copied and its Profile resolved whole (`resolveFullProfile`), none where no profile with steps resolves (`profileWithSteps`). */
  private async applyStoredWorkflow(workflow: Record_): Promise<Record_> {
    const patch: Record_ = {};
    if (workflow.context) patch.context = { ...(workflow.context as Record_) };
    if (workflow.profile) {
      const full = profileWithSteps(await this.resolveFullProfile(workflow.profile));
      if (full) patch.profile = full;
    }
    return patch;
  }

  /** `applyRecipeLegacy`: a recipe without a stored `workflow`, its `dashboardVariables` as a context of only what it holds, and its Profile, its snapshot or its id's, where either has steps. */
  private async applyRecipeLegacy(recipe: Record_): Promise<Record_> {
    const dv = (recipe.dashboardVariables ?? {}) as Record_;
    const context: Record_ = {};
    if (dv.dose != null) context.targetDoseWeight = dv.dose;
    if (dv.drink != null) context.targetYield = dv.drink;
    else if (dv.ratio != null && dv.dose != null) context.targetYield = Math.round((dv.dose as number) * (dv.ratio as number) * 10) / 10;
    if (dv.grind != null) context.grinderSetting = String(dv.grind);
    if (dv.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: dv.rpm };
    if (dv.grinderId) context.grinderId = dv.grinderId;
    if (recipe.barista) context.baristaName = recipe.barista;
    if (recipe.drinker) context.drinkerName = recipe.drinker;
    const patch: Record_ = Object.keys(context).length > 0 ? { context } : {};
    if (recipe.profileId || recipe.profileTitle) {
      const full = profileWithSteps(recipe.profileSnapshot) ?? profileWithSteps(recipe.profileId ? await this.resolveFullProfile(recipe.profileId) : null);
      if (full) patch.profile = full;
    }
    return patch;
  }

  /** `applyFavLegacy`: a favourite without a stored `workflow`, its `snapshot` as its `copyMask` allows, and its Profile, its snapshot or its id's, where either has steps. */
  private async applyFavLegacy(favourite: Record_): Promise<Record_> {
    const snapshot = (favourite.snapshot ?? {}) as Record_;
    const mask = (favourite.copyMask ?? {}) as Record_;
    const on = (key: string) => mask[key] !== false;
    const context: Record_ = {};
    if (on("dose") && snapshot.dose != null) context.targetDoseWeight = snapshot.dose;
    if (on("drink") && snapshot.drink != null) context.targetYield = snapshot.drink;
    if (on("grindSetting")) {
      if (snapshot.grindSetting != null) context.grinderSetting = String(snapshot.grindSetting);
      if (snapshot.rpm != null) context.extras = { ...((context.extras ?? {}) as Record_), rpm: snapshot.rpm };
    }
    if (on("grinder")) {
      if (snapshot.grinderId) context.grinderId = snapshot.grinderId;
      if (snapshot.grinderModel) context.grinderModel = snapshot.grinderModel;
    }
    if (on("beans")) {
      if (snapshot.beanBatchId) context.beanBatchId = snapshot.beanBatchId;
      if (snapshot.coffeeName) context.coffeeName = snapshot.coffeeName;
      if (snapshot.coffeeRoaster) context.coffeeRoaster = snapshot.coffeeRoaster;
    }
    if (on("roastDate") && snapshot.roastDate) context.roastDate = snapshot.roastDate;
    if (on("barista") && snapshot.barista) context.baristaName = snapshot.barista;
    if (on("drinker") && snapshot.drinker) context.drinkerName = snapshot.drinker;
    if (on("note") && snapshot.note) context.extras = { ...((context.extras ?? {}) as Record_), note: snapshot.note };
    const patch: Record_ = Object.keys(context).length > 0 ? { context } : {};
    if (on("profile") && (snapshot.profileId || snapshot.profileTitle)) {
      const full = profileWithSteps(snapshot.profileSnapshot) ?? profileWithSteps(snapshot.profileId ? await this.resolveFullProfile(snapshot.profileId) : null);
      if (full) patch.profile = full;
    }
    return patch;
  }

  /** `mergeRecipeLiveSettings`: the steam, hot water and flush values of the recipe's modes, each kept (`persistSharedValue`), as the patch's parts. */
  private async mergeRecipeLiveSettings(dv: Record_): Promise<Record_> {
    const patch: Record_ = {};
    const steam: Record_ = {};
    if (dv.steamMode === "time" && dv.steamTimeS != null) {
      steam.duration = dv.steamTimeS;
      await this.keep("last-steam-duration", dv.steamTimeS);
    }
    if (dv.steamMode === "flow" && dv.steamFlowMls != null) {
      steam.flow = dv.steamFlowMls;
      await this.keep("last-steam-flow", dv.steamFlowMls);
    }
    if (Object.keys(steam).length > 0) patch.steamSettings = steam;
    const water: Record_ = {};
    if (dv.hotWaterMode === "vol" && dv.hotWaterMl != null) {
      water.volume = dv.hotWaterMl;
      await this.keep("last-hot-water-volume", dv.hotWaterMl);
    }
    if (dv.hotWaterMode === "temp" && dv.hotWaterTempC != null) {
      water.targetTemperature = dv.hotWaterTempC;
      await this.keep("last-hot-water-temp", dv.hotWaterTempC);
    }
    if (Object.keys(water).length > 0) patch.hotWaterData = water;
    if (dv.flushS != null) {
      patch.rinseData = { duration: dv.flushS };
      await this.keep("last-flush-duration", dv.flushS);
    }
    return patch;
  }

  /** `resolveFullProfile` in dyeStrip.js: a profile with steps as given, else the tablet's record of its id, hidden ones included; null if none. */
  private async resolveFullProfile(stub: unknown): Promise<Record_ | null> {
    if (!stub) return null;
    // A whole profile first: one a record captured from the Workflow carries no id (0c9652b).
    if (typeof stub === "object" && profileWithSteps(stub)) return stub as Record_;
    const id = typeof stub === "string" ? stub : (stub as Record_).id;
    if (!id) return null;
    const record = (await this.availableProfiles(true)).find((candidate) => candidate.id === id);
    return record?.profile ? (record.profile as Record_) : null;
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
        return this.pushRemembered(key, value, () => this.change({ hotWaterData: { volume: value } }, "api.hotWater"));
      case "last-hot-water-temp":
        return this.pushRemembered(key, value, () => this.change({ hotWaterData: { targetTemperature: value } }, "api.hotWater"));
      case "last-steam-duration":
        return this.pushRemembered(key, value, () => this.change({ steamSettings: { duration: value } }, "api.steamDuration"));
      case "last-steam-flow":
        return this.pushRemembered(key, value, () => this.change({ steamSettings: { flow: value } }, "api.steamFlow"));
      case "last-steam-temp": {
        const temperature = Math.round(value);
        if (temperature > 0) await this.keep(key, temperature);
        return this.change({ steamSettings: { targetTemperature: temperature } }, "api.steamTemp");
      }
      case "last-milk-stop": {
        const stop = Math.min(80, Math.max(0, value));
        const send = () => this.change({ steamSettings: { stopAtTemperature: stop } }, "api.steamStopAt");
        return stop > 0 ? this.pushRemembered(key, stop, send) : send();
      }
      case "last-flush-duration":
        await this.change({ rinseData: { duration: value } }, "tiles.flush");
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

  /** `steamHeaterFor`: off at a target of 0, keeping the temperature it was at; on only from off, at the selected recipe's steam temperature while its DYE2 switch is on, else the one kept, else none. */
  private async steamHeaterFor(on: number): Promise<Record_> {
    const { body: live } = await this.tablet.callApi("GET", "/workflow");
    const current = settingOf((live ?? {}) as Record_, "steamSettings.targetTemperature");
    if (on === 0) {
      if (typeof current === "number" && current > 0) await this.keep("last-steam-temp", current);
      return { targetTemperature: 0 };
    }
    // Back on only from off: a temperature set since is not Streamline's to put back (streamline-js#143).
    if (typeof current === "number" && current > 0) return {};
    if (this.dye2Enabled) {
      const [selection, recipes] = await Promise.all([this.tablet.callApi("GET", `/store/${DYE2}/selection`), this.tablet.callApi("GET", `/store/${DYE2}/recipes`)]);
      const temperature = selectedRecipeSteamTemp(selection.body, recipes.body);
      if (temperature != null) return { targetTemperature: temperature };
    }
    const { body: kept } = await this.tablet.callApi("GET", `/store/${STREAMLINE_NAMESPACE}/last-steam-temp`);
    return typeof kept === "number" && kept > 0 ? { targetTemperature: Math.round(kept) } : {};
  }

  /** `updateDoseValue`: the dose and yield sent together, the yield as the profile's target weight alone, then saved for the active profile. */
  private async doseAndYield(tile: "in" | "out", grams: number): Promise<DecaidAnswer> {
    const read = await this.tablet.callApi("GET", "/workflow");
    const workflow = (read.body ?? {}) as Record_;
    const context = (workflow.context ?? {}) as Record_;
    const targetDose = tile === "in" ? grams : Number(context.targetDoseWeight ?? 0);
    const targetYield = tile === "out" ? grams : Number(context.targetYield ?? 0);
    const payload: Record_ = { context: { targetDoseWeight: targetDose, targetYield } };
    if (Number.isFinite(targetYield) && targetYield > 0) payload.profile = { target_weight: targetYield };
    const answer = await this.send(payload, "tiles.doseYield");
    if (answer.status === 200) {
      if (tile === "in") this.lastDose = grams;
      const active = await this.activeProfile(workflow);
      if (active) await this.saveForProfile(String(active.id), tile === "in" ? { targetDoseWeight: grams } : { targetYield: grams });
    }
    return answer;
  }

  /** `loadProfileForWake` and `handleProfileClick`: the profile sent with what is saved for it and `recipeId` null, then its saved steam time and flow, unless `recipeHoldsDial`. */
  private async sendProfile(profileId: string, writer: "profile.wake" | "profile.send"): Promise<DecaidAnswer | undefined> {
    const record = (await this.availableProfiles(true)).find((candidate) => candidate.id === profileId);
    if (!record) throw new Error(`Streamline has no profile ${profileId}`);
    const profile = record.profile as Record_;
    if (await this.recipeHoldsDial(profile)) return undefined;
    const meta = await this.savedFor(profileId, record);
    const targetDoseWeight = meta.targetDoseWeight ?? this.lastDose ?? DEFAULT_DOSE_WEIGHT;
    const grinderSetting = meta.grinderSetting ?? this.lastGrind ?? (writer === "profile.send" ? null : undefined);
    const parsedYield = parseFloat(String(meta.targetYield ?? profile.target_weight));
    const targetYield = Number.isNaN(parsedYield) ? 0 : parsedYield;
    const sent = withSavedBrewTemp(targetYield > 0 ? { ...profile, target_weight: targetYield } : profile, meta);
    const context: Record_ = { targetDoseWeight, targetYield, ...(grinderSetting === undefined ? {} : { grinderSetting }), ...recipeIdPatch(null) };
    let answer: DecaidAnswer;
    try {
      answer = await this.send({ profile: sent, context }, writer);
    } catch (error) {
      // `loadProfileForWake` catches it and answers false.
      this.refused.push(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    if (answer.status === 200) {
      if (typeof meta.targetSteamDuration === "number") await this.push("last-steam-duration", meta.targetSteamDuration);
      if (typeof meta.targetSteamFlow === "number") await this.push("last-steam-flow", meta.targetSteamFlow);
    }
    return answer;
  }

  /** `recipeHoldsDial`: its DYE2 switch on, DYE2's mirrored selection naming a recipe, and the Workflow's profile this one by its fingerprint. */
  private async recipeHoldsDial(profile: Record_): Promise<boolean> {
    if (!this.dye2Enabled) return false;
    const { body: stored } = await this.tablet.callApi("GET", `/store/${DYE2}/selection`);
    const selection = (stored ?? null) as Record_ | null;
    if (selection?.kind !== "recipe" || selection.id == null) return false;
    const live = ((await this.tablet.callApi("GET", "/workflow")).body as Record_ | null)?.profile;
    return !!live && streamlineFingerprint(live) === streamlineFingerprint(profile);
  }

  /** The profile records Streamline keeps (`loadAvailableProfiles`, `getProfiles`): the tablet's, hidden ones included, but not deleted ones where `live`. */
  private async availableProfiles(live: boolean): Promise<Record_[]> {
    const { body } = await this.tablet.callApi("GET", "/profiles?includeHidden=true");
    const records = Array.isArray(body) ? (body as Record_[]) : [];
    return live ? records.filter((record) => record.visibility !== "deleted") : records;
  }

  /** The active profile's record: the one whose title is the Workflow's profile's (`syncActiveProfileFromTitle`), a visible one first. */
  private async activeProfile(workflow: Record_): Promise<Record_ | undefined> {
    const title = (workflow.profile as Record_ | undefined)?.title;
    const titled = (await this.availableProfiles(true)).filter((record) => (record.profile as Record_ | undefined)?.title === title);
    return titled.find((record) => record.visibility !== "hidden") ?? titled[0];
  }

  /** What Streamline saved for a profile, over what its record's metadata holds (`applyOverridesToRecords`). */
  private async savedFor(profileId: string, record: Record_): Promise<Record_> {
    const { body } = await this.tablet.callApi("GET", `/store/${PROFILE_OVERRIDES_NAMESPACE}/${encodeURIComponent(profileId)}`);
    return { ...((record.metadata ?? {}) as Record_), ...((body ?? {}) as Record_) };
  }

  /** `updateWorkflow` in api.js: the body checked against its writer's fields, then sent, its profile as `putWorkflow` cleans it up. */
  private send(body: Record_, writer: string): Promise<DecaidAnswer> {
    assertDeclaredFields(writer, body);
    const sent = withSentProfile(body);
    this.sent.push(sent);
    return this.tablet.callApi("PUT", "/workflow", sent);
  }

  private async change(parts: Record_, writer: string): Promise<void> {
    const { status, body } = await this.send(parts, writer);
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

/** `recipeIdPatch` in dye-selection.js: the context fragment that writes the recipe being dialled in, null for none. */
export function recipeIdPatch(id: unknown): { extras: { dye: { v: 1; recipeId: string | null } } } {
  return { extras: { dye: { v: 1, recipeId: id == null ? null : String(id) } } };
}

/** `mergeContext` in dyeStrip.js: a context fragment folded into the patch, `extras` merged one level, so the fragment's `extras.dye` replaces the patch's. Changes the patch. */
function mergeContext(patch: Record_, fragment: Record_): Record_ {
  const context = (patch.context ?? {}) as Record_;
  patch.context = {
    ...context,
    ...fragment,
    ...(context.extras || fragment.extras ? { extras: { ...((context.extras ?? {}) as Record_), ...((fragment.extras ?? {}) as Record_) } } : {}),
  };
  return patch;
}

/**
 * The strip's cells (`recipeStripCells` in dye-selection.js): slots 1 to 5,
 * each holding the first recipe shown on the strip whose `stripSlot` is that
 * number; where no row has a `stripSlot` key, a recipe with id `1` to `5` in
 * that cell, and the others in the blanks left.
 */
export function recipeStripCells(recipes: unknown, count = 5): { slot: string; recipe: Record_ | null }[] {
  const cells: { slot: string; recipe: Record_ | null }[] = Array.from({ length: count }, (_, index) => ({ slot: String(index + 1), recipe: null }));
  const rows = (Array.isArray(recipes) ? recipes : []).filter((row): row is Record_ => !!row && typeof row === "object");
  const visible = rows.filter((row) => row.showOnStreamlineDashboard !== false);
  const legacy = !rows.some((row) => row.stripSlot !== undefined);
  const strays: Record_[] = [];
  for (const recipe of visible) {
    let cell: { slot: string; recipe: Record_ | null } | undefined;
    if (legacy) {
      const slot = parseInt(String(recipe.id), 10);
      cell = String(recipe.id) === String(slot) ? cells[slot - 1] : undefined;
      if (!cell) {
        strays.push(recipe);
        continue;
      }
    } else {
      const slot = typeof recipe.stripSlot === "number" ? recipe.stripSlot : NaN;
      cell = Number.isInteger(slot) ? cells[slot - 1] : undefined;
    }
    if (cell && !cell.recipe) cell.recipe = recipe;
  }
  for (const recipe of strays) {
    const blank = cells.find((cell) => !cell.recipe);
    if (!blank) break;
    blank.recipe = recipe;
  }
  return cells;
}

/** `selectedRecipeSteamTemp` in dye-selection.js: the steam temperature, 135 or more, rounded, of the recipe DYE2's selection names; null otherwise. */
function selectedRecipeSteamTemp(selection: unknown, recipes: unknown): number | null {
  const selected = (selection ?? null) as Record_ | null;
  if (!selected || selected.kind !== "recipe" || selected.id == null || !Array.isArray(recipes)) return null;
  const recipe = (recipes as Record_[]).find((row) => row && String(row.id) === String(selected.id));
  const temperature = Number((recipe?.dashboardVariables as Record_ | undefined)?.steamTempC);
  return Number.isFinite(temperature) && temperature >= 135 ? Math.round(temperature) : null;
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

/**
 * The body as `putWorkflow` in api.js sends it: its profile without the
 * fields Decaid refuses (`type`, `legacy_profile_type`, `lang`, `hidden`,
 * `reference_file`, `changes_since_last_espresso`), each step with only its
 * pump's own setpoint, a limiter of 0 as null and an exit of another type
 * than pressure or flow as null.
 */
function withSentProfile(body: Record_): Record_ {
  if (!body.profile || typeof body.profile !== "object") return body;
  const profile = structuredClone(body.profile) as Record_;
  for (const key of ["type", "legacy_profile_type", "lang", "hidden", "reference_file", "changes_since_last_espresso"]) delete profile[key];
  if (Array.isArray(profile.steps)) {
    for (const step of profile.steps as Record_[]) {
      if (step.pump === "flow") delete step.pressure;
      else if (step.pump === "pressure") delete step.flow;
      if (step.limiter && (step.limiter as Record_).value === 0) step.limiter = null;
      const exit = step.exit as Record_ | null | undefined;
      if (exit && exit.type !== "pressure" && exit.type !== "flow") step.exit = null;
    }
  }
  return { ...body, profile };
}

/**
 * `profilePatchWithSteps` in src/modules/dye-selection.js (16903cc): the profile where it has steps, else null, as
 * `PUT /workflow` merges a profile without them into the loaded one, renaming it rather than replacing it.
 */
function profileWithSteps(profile: unknown): Record_ | null {
  const steps = (profile as Record_ | null | undefined)?.steps;
  return Array.isArray(steps) && steps.length > 0 ? (profile as Record_) : null;
}

/**
 * A profile as Streamline fingerprints it (`profileFingerprint` in src/modules/dye-selection.js): as DYE2 does, its
 * title, tank temperature and steps but their temperatures, a limiter of 0 as none, every object's keys sorted
 * (`sortKeysReplacer`, 915c6d1).
 */
function streamlineFingerprint(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record_;
  const steps = Array.isArray(record.steps)
    ? (record.steps as Record_[]).map(({ temperature: _, limiter, ...rest }) => ({ ...rest, limiter: limiter && Number((limiter as Record_).value) !== 0 ? limiter : null }))
    : record.steps;
  const sorted = (_key: string, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value as Record_).sort().map((key) => [key, (value as Record_)[key]])) : value;
  return JSON.stringify({ title: record.title, tank_temperature: record.tank_temperature, steps }, sorted);
}
