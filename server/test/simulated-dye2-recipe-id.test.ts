import { dye2Fingerprint } from "@decent-sync/protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { DecaidAnswer } from "./support/decaid-beans.js";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  type Dye2Step,
  SimulatedDye2,
  dye2Generated,
  dye2List,
  dye2Migrated,
  dye2ProfileFingerprint,
  dye2NeverUsed,
  dye2RecipeIdOf,
  dye2Recording,
  dye2V032Recording,
  dye2V033Recording,
  openDye2Dashboard,
  openDye2RecipeEditor,
  pickBasketInDye2,
  recordedDye2MainTablet,
  selectRecipeInDye2,
} from "./support/simulated-dye2.js";
import { type SimulatedStreamline, recipeStripCells, startStreamline } from "./support/simulated-streamline.js";
import { type DecaidApi, SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated DYE2 v0.1.33 and Streamline v0.2.21 against what they were
// recorded doing on Decaid v0.9.0's Linux release, at DYE2 v0.1.26 and
// Streamline `main` at cec5664 (fixtures/decaid/dye2-v0.1.26/, whose README
// says what each step was and what it shows): the recording's steps are made
// again on one simulated tablet, in the recording's order, from the state
// its pages' steps left (library.json, its recipes as recorded), the pages'
// actions through the simulators and the script's requests as recorded.
// Each step's writes, and what Decaid and DYE2 answered them, its reads once
// DYE2 had followed, whether DYE2 pushed, and the context of each Workflow
// change must be what was recorded, but where DYE2 v0.1.32 does otherwise,
// as fixtures/decaid/dye2-v0.1.32/ records it: a recipe applied again on its
// own profile keeps its id (`KEPT_SINCE_V0132`), and `save-recipe` names a
// recipe otherwise (`unnamed`); and where Streamline v0.2.21 makes no such
// request, as fixtures/decaid/dye2-v0.1.33/ records it: its "Replace <name>"
// no longer saves a recipe into a filled button, so DYE2's save-recipe is
// sent as recorded. Then what v0.1.32 was recorded doing otherwise is made
// again (fixtures/decaid/dye2-v0.1.32/), but where v0.1.33 keeps a recipe
// whose record holds its profile in another key order (`KEPT_SINCE_V0133`),
// and last what v0.1.33 and v0.2.21 were recorded doing otherwise
// (fixtures/decaid/dye2-v0.1.33/). No settings are given, so the plugin does
// not connect.

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

const library = dye2Recording<{ recipes: Record_[]; beans: Record_[]; beanBatches: Record_[]; grinders: Record_[]; baskets: Record_[] }>("library");
const recipeNamed = (name: string) => String(library.recipes.find((recipe) => recipe.name === name)!.id);
const LIBRARY_RECIPE = recipeNamed("Fixture Library Recipe");

/**
 * The steps of the v0.1.26 recording in which DYE2 cleared the Workflow's
 * `recipeId` as a recipe was applied again on its own profile, which v0.1.32
 * keeps (decentespresso/dye2#38, `e5e1120`; dye2-v0.1.32/applies.json,
 * `ownProfileSameId`), the record holding that profile in Decaid's key
 * order: each is made again, its recipe checked still named, then the id
 * cleared as v0.1.26 cleared it, so the steps after start where recorded.
 */
const KEPT_SINCE_V0132 = new Set(["profileChangeAfterTwoPuts", "reapplyAfterLiveChange"]);

/**
 * The steps of the v0.1.32 recording in which DYE2 cleared the Workflow's
 * `recipeId` as a recipe was applied again on its own profile, its record
 * holding that profile in `jsonb`'s key order, as Decent Sync's server writes
 * one, which v0.1.33 keeps, as its fingerprint ignores key order
 * (decentespresso/dye2#43, `026054e`; dye2-v0.1.33/applies.json,
 * `reapplyEdited`): each is made again as `KEPT_SINCE_V0132`'s are.
 */
const KEPT_SINCE_V0133 = new Set(["reapplyEdited", "ownProfileJsonbOrderSameId"]);

/**
 * A recorded value without what DYE2 v0.1.32 makes otherwise of a recipe
 * `save-recipe` made (an id `recipe-…`): the name it proposes, from the
 * profile's first word, the bean and the day, rather than the drink, and the
 * beverage it keeps, "" for none (dye2-v0.1.32/save-recipe.json); its
 * `name`, `title` and `beverage` are left out, and its answer's `name`.
 */
function unnamed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unnamed);
  if (!value || typeof value !== "object") return value;
  const record = value as Record_;
  const made = typeof record.id === "string" && record.id.startsWith("recipe-");
  return Object.fromEntries(Object.entries(record).flatMap(([key, field]) => (made && ["name", "title", "beverage"].includes(key) ? [] : [[key, unnamed(field)]])));
}

/**
 * Makes a step DYE2 now does otherwise (`KEPT_SINCE_V0132`,
 * `KEPT_SINCE_V0133`) again on that tablet: the recipe it applies still
 * named, nothing cleared; then its id cleared, as the recording's DYE2
 * cleared it, so the steps after start where recorded.
 */
function keptThenCleared(dye2: SimulatedDye2, tablet: SimulatedTablet, settled: () => Promise<void>) {
  return async (act: () => Promise<unknown>, name: string): Promise<void> => {
    const named = dye2RecipeIdOf(tablet.workflow());
    const cleared = dye2.cleared.length;
    await act();
    await settled();
    expect(dye2RecipeIdOf(tablet.workflow()), `${name}: kept`).toBe(named);
    expect(dye2.cleared.length, `${name}: cleared`).toBe(cleared);
    await tablet.callApi("PUT", "/workflow", { context: { extras: { dye: { recipeId: null } } } });
    await settled();
  };
}

/** The writes of a step, and the reads DYE2 answers but `selection` (which pages make on timers): those compared with the recording. */
const compared = ({ request }: Dye2Exchange) =>
  (request.method !== "GET" && !/^\/store\/(streamline-app|streamlineProfileOverrides)\//.test(request.path) && !/\/plugins\/dye2\.reaplugin\/(disable|enable)$/.test(request.path)) || request.path === "/plugins/dye2.reaplugin/record";

/** Makes DYE2's clock and new ids those of the recipe the step saved or changed. */
function asSaved(step: Dye2Step, id?: string): void {
  const write = step.exchanges.find(({ request }) => request.method === "POST" && request.path === `/store/${DYE2_NAMESPACE}/recipes`);
  const answer = step.exchanges.find(({ request }) => request.path.endsWith("/save-recipe"))?.response.body as { id: string } | undefined;
  const target = id ?? answer?.id;
  const recipes = (write?.request.body ?? step.after.find(({ request }) => request.path.endsWith("/recipes"))!.response.body) as Record_[];
  const saved = recipes.find((recipe) => recipe.id === target)!;
  dye2Generated.now = () => new Date(String(saved.capturedAt));
  dye2Generated.uuid = () => String(saved.id);
  dye2Generated.saveRecipeId = () => String(saved.id);
}

/**
 * A simulated tablet with this API and DYE2 loaded, whose steps a recording's
 * are made again on: the requests made through `proxy`, as the pages and the
 * script made them, with Decaid's answers (`made`), and the context of each
 * Workflow change (`events`).
 */
function replaying(api: DecaidApi, compare: (value: unknown) => unknown = unnamed) {
  const dye2 = new SimulatedDye2();
  const tablet = SimulatedTablet.load({ settings: {}, api, dye2, keepsFlushSettings: false });
  tablets.push(tablet);
  const events: unknown[] = [];
  tablet.onWorkflowChange((workflow) => events.push(structuredClone(workflow.context ?? null)));
  const made: Dye2Exchange[] = [];
  const proxy = new Proxy(tablet, {
    get(target, property) {
      if (property === "callApi") {
        return async (method: Dye2Exchange["request"]["method"], route: string, body?: unknown) => {
          const response = await target.callApi(method, route, body);
          made.push({ request: { method, path: route, ...(body === undefined ? {} : { body: structuredClone(body) }) }, response });
          return response;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SimulatedTablet;
  const pages: { streamline?: SimulatedStreamline } = {};

  /** Sends the step's requests as recorded, through the proxy. */
  async function script(step: Pick<Dye2Step, "exchanges">, filter: (exchange: Dye2Exchange) => boolean = () => true): Promise<void> {
    for (const exchange of step.exchanges.filter(filter)) {
      const { request } = exchange;
      if (request.path === "/plugins/dye2.reaplugin/disable") dye2.disable();
      else if (request.path === "/plugins/dye2.reaplugin/enable") await dye2.enable();
      else if (request.method === "GET" && request.path.endsWith("/selection")) await proxy.callApi("GET", request.path);
      else await proxy.callApi(request.method, request.path, request.body);
    }
  }

  /** Waits for DYE2 and Streamline to follow, as the recording waited 2.5 s. */
  async function settled(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      await dye2.settled();
      await pages.streamline?.settled();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Makes a step again with `act`, then checks it: its writes, and what
   * Decaid and DYE2 answered them, as recorded; once DYE2 has followed, its
   * reads after, whether DYE2 pushed, and the context of each Workflow change,
   * but for a step that restarts Decaid, whose sockets heard nothing while
   * closed (`restarts`).
   */
  async function again(step: Dye2Step, act: () => Promise<unknown>, name: string, restarts = false): Promise<void> {
    const from = { made: made.length, pushes: dye2.pushes.length, events: events.length };
    await act();
    await settled();
    expect(compare(made.slice(from.made).filter(compared)), `${name}: writes`).toEqual(compare(step.exchanges.filter(compared)));
    const after: DecaidAnswer[] = [];
    for (const { request } of step.after) after.push(await tablet.callApi(request.method, request.path));
    expect(compare(after), `${name}: after`).toEqual(compare(step.after.map(({ response }) => response)));
    if (restarts) return;
    expect(events.slice(from.events), `${name}: events`).toEqual(step.events);
    expect(dye2.pushes.length > from.pushes, `${name}: pushed`).toBe(step.pushes.length > 0);
  }

  return { dye2, tablet, proxy, events, made, pages, script, settled, again };
}

describe("The simulated DYE2 v0.1.33 and Streamline v0.2.21, made again as v0.1.26 was recorded", () => {
  runAsSteps();
  const { dye2, tablet, proxy, pages, script, settled, again } = replaying(recordedDye2MainTablet("10001", undefined, { asRecorded: true }));
  const generated = { ...dye2Generated };
  afterEach(() => Object.assign(dye2Generated, generated));

  const keptSinceV0132 = keptThenCleared(dye2, tablet, settled);

  /** The recipe with that record id tapped on DYE2's dashboard opened afresh. */
  const pill = (id = LIBRARY_RECIPE) => async () => (await openDye2Dashboard(proxy)).applyRecipe(id);

  it("applies the library recipe on DYE2's dashboard, sets a batch, and pushes once a Shot is stored after a restart (shot.json)", async () => {
    await settled();
    const shot = dye2Recording<{ dashboard: Record<string, Dye2Step> & { shot: Dye2Exchange; favourites: Dye2Exchange } }>("shot").dashboard;
    await again(shot.applied!, pill(), "applied");
    await again(shot.batchSet!, () => script(shot.batchSet!), "batchSet");
    // Decaid restarted, its sockets closed meanwhile.
    await dye2.reload();
    await dye2.settled();
    await again(
      shot.pulled!,
      async () => {
        tablet.pullShot(shot.shot.response.body as Record_);
      },
      "pulled",
    );
    // Recent favourites are not simulated: the one the Shot made, as DYE2 wrote it.
    await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/autoFavourites`, shot.favourites.response.body);
  });

  it("applies a recipe in a slot and one in none, a recent favourite and the selected recipe edited, as recorded (dye2-applies.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("dye2-applies");
    await again(steps.applyInSlot!, pill(), "applyInSlot");
    await again(steps.applyFromSelectRecipe!, () => selectRecipeInDye2(proxy, "1"), "applyFromSelectRecipe");
    await again(
      steps.applyFavourite!,
      async () => {
        const page = await openDye2Dashboard(proxy);
        const recent = page.favourites.filter((favourite) => favourite.auto).sort((a, b) => Number(a.recentRank) - Number(b.recentRank))[0]!;
        return page.applyFavourite(recent);
      },
      "applyFavourite",
    );
    await again(steps.applyBeforeEdit!, pill(), "applyBeforeEdit");
    asSaved(steps.editSelected!, LIBRARY_RECIPE);
    await again(steps.editSelected!, async () => (await openDye2RecipeEditor(proxy, { id: LIBRARY_RECIPE })).set({ grind: 3.3 }).save(), "editSelected");
  });

  it("sends only its own edits over a change made elsewhere, and nothing on Done (dashboard.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("dashboard");
    await again(steps.applyInSlot!, pill(), "applyInSlot");
    const page = await openDye2Dashboard(proxy);
    await again(steps.writtenElsewhere!, () => script(steps.writtenElsewhere!), "writtenElsewhere");
    await again(steps.dialTap!, () => page.tap("grind", Number((((steps.dialTap!.exchanges[0]!.request.body as Record_).context as Record_).grinderSetting))), "dialTap");
    await again(steps.done!, () => page.done(), "done");
  });

  it("records into the recipe what the Workflow holds otherwise, as recorded (recording.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("recording");
    for (const [name, step] of Object.entries(steps)) await again(step, name === "select" ? pill() : () => script(step, ({ request }) => request.method !== "GET"), name);
  });

  it("clears recipeId on a profile change and keeps it otherwise, as recorded (unloads.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("unloads");
    for (const [name, step] of Object.entries(steps)) {
      const act = name.startsWith("select") ? (name === "selectAdaptive" ? () => selectRecipeInDye2(proxy, "1") : pill()) : () => script(step, ({ request }) => request.method !== "GET");
      if (KEPT_SINCE_V0132.has(name)) await keptSinceV0132(act, name);
      else await again(step, act, name);
    }
  });

  it("keeps recipeId across every restart, its baseline the Workflow as DYE2 found it, as recorded (restart.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("restart");
    for (const [name, step] of Object.entries(steps)) {
      if (!step.after) {
        await script(step);
        continue;
      }
      const act =
        name.startsWith("select") || name === "reapplyAfterLiveChange"
          ? pill()
          : name === "decaidRestart"
            ? () => dye2.reload()
            : name === "decaidRestartRecordChanged"
              ? async () => {
                  await script(step);
                  await dye2.reload();
                }
              : () => script(step);
      if (KEPT_SINCE_V0132.has(name)) await keptSinceV0132(act, name);
      else await again(step, act, name, name.startsWith("decaidRestart"));
    }
  });

  it("saves the Workflow as a recipe into an empty slot, a held one and none, as recorded (save-recipe.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step>>("save-recipe");
    for (const [name, step] of Object.entries(steps)) {
      asSaved(step);
      await again(step, () => script(step), name);
      Object.assign(dye2Generated, generated);
    }
  });

  it("applies, saves into and replaces recipes from Streamline's strip, frees a cell, clears the note after a Shot, and sets its steam, as recorded (streamline.json)", async () => {
    const steps = dye2Recording<Record<string, Dye2Step> & { freeSlot5: Dye2Exchange[] }>("streamline");
    // DYE2's editor freeing slot 5.
    const freeing = steps.freeSlot5.find(({ request }) => request.method === "POST" && request.path.endsWith("/recipes"))!.request.body as Record_[];
    const inFive = (dye2List(tablet, "recipes") as Record_[]).find((recipe) => recipe.stripSlot === 5)!;
    dye2Generated.now = () => new Date(String(freeing.find((recipe) => recipe.id === inFive.id)!.capturedAt));
    await (await openDye2RecipeEditor(proxy, { id: String(inFive.id) })).tapSlot(5).save();
    expect(unnamed(dye2List(tablet, "recipes"))).toEqual(unnamed(freeing));
    const cell = (name: string) => pages.streamline!.cells().find(({ recipe }) => recipe?.name === name)!.slot as 1 | 2 | 3 | 4 | 5;
    await again(steps.started!, async () => (pages.streamline = await startStreamline(proxy)), "started");
    await again(steps.applyFromStrip!, () => pages.streamline!.applyRecipe("2"), "applyFromStrip");
    await again(steps.doseTile!, () => pages.streamline!.setDose(Number((((steps.doseTile!.exchanges[0]!.request.body as Record_).context as Record_).targetDoseWeight))), "doseTile");
    await again(steps.saveChanges!, () => pages.streamline!.saveChanges("2"), "saveChanges");
    asSaved(steps.saveToEmptyCell!);
    await again(steps.saveToEmptyCell!, () => pages.streamline!.saveToRecipe(5), "saveToEmptyCell");
    Object.assign(dye2Generated, generated);
    // Streamline at cec5664's "Replace <name>" saved into the filled button; v0.2.21's opens DYE2's Select Recipe to
    // assign one instead (dye2-v0.1.33/streamline.json), so DYE2's save-recipe is sent as recorded.
    asSaved(steps.replaceFilledCell!);
    await again(
      steps.replaceFilledCell!,
      async () => {
        await script(steps.replaceFilledCell!, ({ request }) => request.method !== "GET");
        await pages.streamline!.repoll();
      },
      "replaceFilledCell",
    );
    Object.assign(dye2Generated, generated);
    await again(steps.applyBeforeClear!, () => pages.streamline!.applyRecipe("2"), "applyBeforeClear");
    await again(steps.clearButton!, () => pages.streamline!.clearButton(cell("Fixture Brazil Espresso")), "clearButton");
    // Decaid restarted, its sockets closed meanwhile.
    await dye2.reload();
    await dye2.settled();
    await again(steps.restarted!, async () => (pages.streamline = await startStreamline(proxy)), "restarted");
    await again(steps.applyBeforeShot!, () => pages.streamline!.applyRecipe(LIBRARY_RECIPE), "applyBeforeShot");
    await again(steps.writtenBeforeShot!, () => script(steps.writtenBeforeShot!), "writtenBeforeShot");
    await again(
      steps.shotPulled!,
      async () => {
        tablet.pullShot(dye2Recording<{ streamline: { pulled: Dye2Exchange } }>("shot").streamline.pulled.response.body as Record_);
        await pages.streamline!.shotStored();
      },
      "shotPulled",
    );
    await again(steps.steamTimeZero!, () => pages.streamline!.set("last-steam-duration", 0), "steamTimeZero");
    await again(steps.heaterOff!, () => pages.streamline!.setSteamHeater(false), "heaterOff");
    await again(steps.heaterOn!, () => pages.streamline!.setSteamHeater(true), "heaterOn");
  });
});

describe("The simulated DYE2 v0.1.33 and Streamline v0.2.21, made again as v0.1.32 was recorded doing otherwise", () => {
  runAsSteps();
  // From the state DYE2 v0.1.32's install left (dye2-v0.1.32/loading.json), the steps of each file in the recording's order.
  const library = dye2V032Recording<Record_>("library");
  const final = dye2V032Recording<{ install: { reads: { values: Record<string, unknown>; workflow: Record_ }[] } }>("loading").install.reads.at(-1)!;
  const api: DecaidApi = {
    ...dye2NeverUsed("10004"),
    "/beans": library.beans,
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/machine/settings": library.machineSettings,
    "/workflow": final.workflow,
  };
  for (const [key, value] of Object.entries(final.values)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
  const { dye2, tablet, proxy, pages, script, settled, again } = replaying(api, (value) => value);
  const generated = { ...dye2Generated };
  afterEach(() => Object.assign(dye2Generated, generated));
  const pill = (id: string) => async () => (await openDye2Dashboard(proxy)).applyRecipe(id);
  const named = (recipes: (Record_ | null)[]) => recipes.map((recipe) => (recipe?.name as string | undefined) ?? "");
  const pills = async () => named((await openDye2Dashboard(proxy)).recipePills());
  const keptSinceV0133 = keptThenCleared(dye2, tablet, settled);

  it("applies a recipe naming no Bean, clearing the batch, and keeps one applied again on its own profile, in Decaid's key order and, since v0.1.33, in jsonb's (applies.json)", async () => {
    await settled();
    const steps = dye2V032Recording<Record<string, Dye2Step> & { pillsShown: string[] }>("applies");
    expect(await pills()).toEqual(steps.pillsShown);
    for (const [name, step] of Object.entries(steps)) {
      if (Array.isArray(step)) continue;
      const act = name === "selectNoBean" ? () => selectRecipeInDye2(proxy, "3") : name.startsWith("apply") || name === "reapplyEdited" ? pill(name === "applyNoBean" ? "2" : "1") : () => script(step, ({ request }) => request.method !== "GET");
      if (KEPT_SINCE_V0133.has(name)) await keptSinceV0133(act, name);
      else await again(step, act, name);
    }
  });

  it("applies a recipe naming no Bean from Streamline's strip, clearing the batch, and clears a button, which DYE2's dashboard then leaves out (streamline.json)", async () => {
    const steps = dye2V032Recording<Record<string, Dye2Step> & { cells: string[]; cellsAfterClear: string[]; dashboardPillsAfterClear: string[] }>("streamline");
    await again(steps.started!, async () => (pages.streamline = await startStreamline(proxy)), "started");
    expect(named(pages.streamline!.cells().map(({ recipe }) => recipe))).toEqual(steps.cells);
    await again(steps.batchSet!, () => script(steps.batchSet!), "batchSet");
    await again(steps.applyNoBeanFromStrip!, () => pages.streamline!.applyRecipe("2"), "applyNoBeanFromStrip");
    await again(steps.applyWithBeanFromStrip!, () => pages.streamline!.applyRecipe("1"), "applyWithBeanFromStrip");
    await again(steps.clearButton!, () => pages.streamline!.clearButton(1), "clearButton");
    expect(named(pages.streamline!.cells().map(({ recipe }) => recipe))).toEqual(steps.cellsAfterClear);
    expect(await pills()).toEqual(steps.dashboardPillsAfterClear);
  });

  it("records a grind setting as typed, a number where it reads as one, and no batch (recording.json)", async () => {
    const steps = dye2V032Recording<Record<string, Dye2Step>>("recording");
    for (const [name, step] of Object.entries(steps)) await again(step, name === "select" ? pill("2") : () => script(step, ({ request }) => request.method !== "GET"), name);
  });

  it("names a recipe it saves from a Workflow naming no Bean by its profile and the day, with a beverage given (save-recipe.json)", async () => {
    const steps = dye2V032Recording<Record<string, Dye2Step>>("save-recipe");
    for (const [name, step] of Object.entries(steps)) {
      if (name !== "beanCleared") asSaved(step);
      await again(step, () => script(step), name);
      Object.assign(dye2Generated, generated);
    }
  });
});

describe("The simulated DYE2 v0.1.33 and Streamline v0.2.21, made again as they were recorded doing otherwise", () => {
  runAsSteps();
  // From the state DYE2 v0.1.33's install left (dye2-v0.1.33/loading.json), the steps of each file in the recording's order.
  const library = dye2V033Recording<Record_>("library");
  const final = dye2V033Recording<{ install: { reads: { values: Record<string, unknown>; workflow: Record_ }[] } }>("loading").install.reads.at(-1)!;
  const api: DecaidApi = {
    ...dye2NeverUsed("10005"),
    "/beans": library.beans,
    "/bean-batches": library.beanBatches,
    "/grinders": library.grinders,
    "/profiles": library.profiles,
    "/machine/settings": library.machineSettings,
    "/workflow": final.workflow,
  };
  for (const [key, value] of Object.entries(final.values)) api[`/store/${DYE2_NAMESPACE}/${key}`] = value;
  const { proxy, pages, script, settled, again } = replaying(api, (value) => value);
  const generated = { ...dye2Generated };
  afterEach(() => Object.assign(dye2Generated, generated));
  const pill = (id: string) => async () => (await openDye2Dashboard(proxy)).applyRecipe(id);
  const sent = (step: Dye2Step) => () => script(step, ({ request }) => request.method !== "GET");
  const basketNamed = (name: string) => String((final.values.baskets as Record_[]).find((basket) => basket.name === name)!.id);

  it("keeps a recipe applied again after its record's profile changed in jsonb's key order, and one whose own profile is written into the Workflow under its id, but not another profile (applies.json)", async () => {
    await settled();
    const steps = dye2V033Recording<Record<string, Dye2Step>>("applies");
    for (const [name, step] of Object.entries(steps)) await again(step, name.includes("pply") ? pill("1") : sent(step), name);
  });

  it("saves a Basket picked since the apply into a recipe holding none, but not the one it was applied over, and removes none (baskets.json)", async () => {
    const steps = dye2V033Recording<Record<string, Dye2Step>>("baskets");
    const acts: Record<string, () => Promise<unknown>> = {
      applyNoBasket: pill("2"),
      basketPicked: () => pickBasketInDye2(proxy, basketNamed("Fixture 18g Precision")),
      applyOverBasket: pill("1"),
      basketPickedAgain: () => pickBasketInDye2(proxy, basketNamed("Fixture 20g High-flow")),
      applyHolding: pill("4"),
      basketPickedOnHolding: () => pickBasketInDye2(proxy, basketNamed("Fixture 20g High-flow")),
    };
    for (const [name, step] of Object.entries(steps)) await again(step, acts[name] ?? sent(step), name);
  });

  it("applies a recipe from Streamline's strip, does nothing on a tap of its highlighted cell, and assigns a library recipe to a filled button through DYE2's Select Recipe (streamline.json)", async () => {
    const steps = dye2V033Recording<Record<string, Dye2Step> & { cells: string[]; filledMenu: string[]; emptyMenu: string[]; cellsAfterReplace: string[] }>("streamline");
    const named = () => pages.streamline!.cells().map(({ recipe }) => (recipe?.name as string | undefined) ?? "");
    await again(steps.started!, async () => (pages.streamline = await startStreamline(proxy)), "started");
    expect(named()).toEqual(steps.cells);
    await again(steps.applyFromStrip!, () => pages.streamline!.applyRecipe("2"), "applyFromStrip");
    let tapped: unknown;
    await again(steps.tapHighlighted!, async () => (tapped = await pages.streamline!.applyRecipe("2")), "tapHighlighted");
    expect(tapped).toEqual({ inert: true });
    asSaved(steps.replace!, "3");
    await again(steps.replace!, () => pages.streamline!.assignToCell(4, "3"), "replace");
    expect(named()).toEqual(steps.cellsAfterReplace);
  });
});

describe("The simulated DYE2's fingerprint", () => {
  it("is the one the recording computed with every object's keys sorted, as v0.1.33's is, protocol's dye2Fingerprint the one recorded, for each profile a load left, and the record's matched the Workflow's", () => {
    type Entry = { name: string; fingerprints: Record<string, string | null>; recordMatchesWorkflow: boolean; recordMatchesWorkflowUpdated: boolean; [profile: string]: unknown };
    const sorted = (_key: string, value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record_)[key]])) : value);
    for (const entry of dye2Recording<Entry[]>("fingerprints")) {
      for (const [key, fingerprint] of Object.entries(entry.fingerprints)) {
        // decentespresso/dye2#43 (`026054e`): the same fingerprint, its keys sorted at every level.
        expect(dye2ProfileFingerprint(entry[key]), `${entry.name} ${key}`).toBe(fingerprint === null ? null : JSON.stringify(JSON.parse(fingerprint), sorted));
        expect(dye2Fingerprint(entry[key]), `${entry.name} ${key}`).toBe(fingerprint);
      }
      expect([entry.recordMatchesWorkflow, entry.recordMatchesWorkflowUpdated]).toEqual([true, true]);
    }
  });

  it("is the same for a profile in Decaid's key order and in jsonb's, as the record and the Workflow v0.1.33 was recorded keeping held it", () => {
    const steps = dye2V033Recording<Record<string, Dye2Step>>("applies");
    const record = ((steps.recordProfileEdited!.exchanges[0]!.request.body as Record_[]).find((recipe) => recipe.id === "1")!.workflow as Record_).profile as Record_;
    const workflow = steps.reapplyEdited!.after.find(({ request }) => request.path === "/workflow")!.response.body as Record_;
    expect(Object.keys((record.steps as Record_[])[0]!)).not.toEqual(Object.keys(((workflow.profile as Record_).steps as Record_[])[0]!));
    expect(dye2ProfileFingerprint(record)).toBe(dye2ProfileFingerprint(workflow.profile));
    expect(dye2Fingerprint(record)).not.toBe(dye2Fingerprint(workflow.profile));
  });
});

describe("The simulated Streamline's strip and wake, against its source", () => {
  it("places recipes by stripSlot once any row has the key, else by ids 1 to 5", () => {
    expect(recipeStripCells([{ id: "a", stripSlot: 2 }, { id: "b", stripSlot: null }, { id: "1" }]).map((cell) => cell.recipe?.id ?? null)).toEqual([null, "a", null, null, null]);
    expect(recipeStripCells([{ id: "2" }, { id: "x" }]).map((cell) => cell.recipe?.id ?? null)).toEqual(["x", "2", null, null, null]);
    expect(recipeStripCells([{ id: "a", stripSlot: 1, showOnStreamlineDashboard: false }]).map((cell) => cell.recipe?.id ?? null)).toEqual([null, null, null, null, null]);
    // By ids, a cell whose recipe is hidden stays empty, not filled from the blanks (71ea5cb).
    expect(recipeStripCells([{ id: "1", showOnStreamlineDashboard: false }, { id: "x" }]).map((cell) => cell.recipe?.id ?? null)).toEqual([null, "x", null, null, null]);
  });

  it("sends no profile for a recipe whose profile resolves to none with steps, leaving the Workflow's (16903cc)", async () => {
    const dye2 = new SimulatedDye2();
    const tablet = SimulatedTablet.load({ settings: {}, api: { ...recordedDye2MainTablet("10003"), ...dye2Migrated() }, dye2, keepsFlushSettings: false });
    tablets.push(tablet);
    await dye2.settled();
    const title = (tablet.workflow().profile as Record_).title;
    // In slots 4 and 5, out of whatever held them: a stored Workflow naming a profile the tablet has no record of, and a
    // legacy recipe holding a snapshot without steps and such an id.
    const recipes = (dye2List(tablet, "recipes") as Record_[]).map((recipe) => ([4, 5].includes(Number(recipe.stripSlot)) ? { ...recipe, stripSlot: null } : recipe));
    const stub = { id: "stub-stored", name: "Stub stored", stripSlot: 4, workflow: { context: { targetDoseWeight: 18.4 }, profile: { id: "profile:00000000000000000000", title: "Purged" } } };
    const legacy = { id: "stub-legacy", name: "Stub legacy", stripSlot: 5, profileId: "profile:00000000000000000000", profileTitle: "Purged", profileSnapshot: { title: "Purged", steps: [] }, dashboardVariables: { dose: 18.6 } };
    await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, [...recipes, stub, legacy]);
    const streamline = await startStreamline(tablet);
    for (const [cell, dose] of [
      [4, 18.4],
      [5, 18.6],
    ] as const) {
      expect((await streamline.applyRecipe(cell)).workflow?.status).toBe(200);
      expect(streamline.sent.at(-1)).not.toHaveProperty("profile");
      expect([(tablet.workflow().profile as Record_).title, (tablet.workflow().context as Record_).targetDoseWeight]).toEqual([title, dose]);
    }
  });

  it("does nothing on a tap of the highlighted cell, refuses a strip apply of a recipe holding a field its writer does not own before the PUT, and sends its wake with the profile", async () => {
    const dye2 = new SimulatedDye2();
    const tablet = SimulatedTablet.load({ settings: {}, api: { ...recordedDye2MainTablet("10002"), ...dye2Migrated() }, dye2, keepsFlushSettings: false });
    tablets.push(tablet);
    await dye2.settled();
    const streamline = await startStreamline(tablet);
    await tablet.callApi("PUT", "/workflow", { context: { extras: { note: "Fixture note" } } });
    const { id } = (await streamline.saveToRecipe(5)).body as { id: string };
    expect(streamline.cells()[4]!.recipe?.id).toBe(id);
    // The Workflow names it, so its cell is the highlighted one.
    expect(await streamline.applyRecipe(5)).toEqual({ inert: true });
    await tablet.callApi("PUT", "/workflow", { context: { extras: { dye: { recipeId: null } } } });
    await dye2.settled();
    await streamline.repoll();
    const applied = await streamline.applyRecipe(5);
    expect(applied.refused).toContain("context.extras.note");
    expect(applied.workflow).toBeUndefined();
    // From v0.2.19 (1324df8), its wake's writer owns the profile it sends.
    expect((await streamline.wake("profile:39e939592679fb194706"))?.status).toBe(200);
    expect((streamline.sent.at(-1)!.profile as Record_).title).toBe("Classic Italian espresso");
    expect(((streamline.sent.at(-1)!.context as Record_).extras as Record_).dye).toEqual({ v: 1, recipeId: null });
    expect((await streamline.tapProfile("profile:39e939592679fb194706"))?.status).toBe(200);
    expect(((streamline.sent.at(-1)!.context as Record_).extras as Record_).dye).toEqual({ v: 1, recipeId: null });
  });
});
