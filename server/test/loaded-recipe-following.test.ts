import { GLOBAL_ID_KEY, LOADED_RECIPE_KEY, RECIPE_FIELD, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import {
  applyInDye2,
  applyInStreamline,
  autoSaveInStreamline,
  dye2Library,
  dye2List,
  dye2NeverUsed,
  dye2Recording,
  dye2Selection,
  recordedDye2Tablet,
  saveInDye2,
  withDye2Selection,
} from "./support/simulated-dye2.js";
import { type DecaidApi, Refusal, type SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #146: a Machine follows its Loaded Recipe both ways
// (ADR-0022). A change on one Machine to a part of its Workflow the Recipe
// sets (its dose, yield, grind setting, RPM, Basket and hot water, and
// another batch of its Bean) is an edit of the Recipe from that Machine's
// tablet, once, whichever app made it; and an edit of the Recipe from
// anywhere is written into the Workflow of every Machine that has it
// loaded, and no other's. Taking the Recipe out of its slot, Archiving it,
// or making the Machine capture-only has the plugin clear it from the
// Workflow; moving it to another slot keeps it loaded. Through the built
// plugin in simulated tablets, acting as DYE2 v0.1.19 and Streamline do with
// the steps recorded from them (fixtures/decaid/dye2-v0.1.19/), Machines A
// and C on two server instances sharing one database, with assertions
// through the REST API and what each simulated tablet holds. Serials are
// made up, from 48001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  slot: number | null;
  archived: boolean;
  content: Record_;
}

interface VersionView {
  fields: Record_;
  source: { machine: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Machine follows its Loaded Recipe both ways", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  const recipes = dye2Recording("recipes");
  const strip = dye2Recording("streamline");

  const records = (tablet: SimulatedTablet) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []);
  const inSlot = (tablet: SimulatedTablet, slot: string) => records(tablet).find((record) => record.id === slot);
  const variables = (record: Record_ | undefined) => (record?.dashboardVariables ?? {}) as Record_;
  const context = (tablet: SimulatedTablet) => (tablet.workflow().context ?? {}) as Record_;
  const extras = (tablet: SimulatedTablet) => (context(tablet).extras ?? {}) as Record_;
  const hotWater = (tablet: SimulatedTablet) => (tablet.workflow().hotWaterData ?? {}) as Record_;
  /** The Recipe id the tablet's Workflow names as loaded, or null. */
  const named = (tablet: SimulatedTablet) => extras(tablet)[LOADED_RECIPE_KEY] ?? null;
  const recipe = async (id: string) => (await api.get<{ recipe: RecipeView }>(`/recipes/${id}`)).recipe;
  const versions = async (id: string) => (await api.get<{ versions: VersionView[] }>(`/recipes/${id}/history`)).versions;
  /** How many of the Recipe's versions set the field. */
  const editsOf = async (id: string, field: string) => (await versions(id)).filter((version) => field in version.fields).length;
  const loadedRecipe = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** Resolves once the server holds that Recipe as the Machine's Loaded Recipe, or none. */
  const loads = (machine: CreatedMachine, recipeId: string | null) => expect.poll(() => loadedRecipe(machine)).toBe(recipeId);
  /** The Workflow the server holds as the Machine's latest. */
  const storedWorkflow = async ({ machine }: CreatedMachine) =>
    ((await (await api.call("GET", `/machines/${machine.id}/workflow`)).json()) as { workflow: { workflow: Record_ } | null }).workflow?.workflow ?? {};
  /** The tablet's id for its record of a Library item, by the global id the record carries in its `extras`. */
  const localId = async (tablet: SimulatedTablet, route: string, globalId: string) => {
    const listed = (await tablet.callApi("GET", `${route}?includeArchived=true`)).body as Record_[];
    return listed.find((record) => (record.extras as Record_ | undefined)?.[GLOBAL_ID_KEY] === globalId)?.id;
  };
  /** Waits a while for what should not happen, as a write to a Workflow that does not follow the Recipe. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  /**
   * A Location with Machines A, whose tablet is the recording's, on one
   * instance, C on the other, and D on the first, both tablets where DYE2
   * was never used. A's DYE2 editor saves slots 1 and 2, which every tablet
   * there is written, and slot 1 is applied the DYE2 way on A and C, and
   * slot 2 on D, which each loads.
   */
  async function lab(scenario: string, serial: number, options: { dye2Selection?: boolean } = {}) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = {
      a: await api.createMachine(`${scenario} lab A`, here.id),
      c: await api.createMachine(`${scenario} lab C`, here.id),
      d: await api.createMachine(`${scenario} lab D`, here.id),
    };
    // DYE2 v0.1.20's selection endpoint, where asked for.
    const dye2 = (decaidApi: DecaidApi) => (options.dye2Selection ? withDye2Selection(decaidApi) : decaidApi);
    const a = syncingTablet(machines.a, server, { api: dye2(recordedDye2Tablet(String(serial), scenario)) });
    const c = syncingTablet(machines.c, other, { api: dye2(dye2NeverUsed(String(serial + 1))) });
    const d = syncingTablet(machines.d, server, { api: dye2(dye2NeverUsed(String(serial + 2))) });
    await api.waitForOnline(machines.a, machines.c, machines.d);
    await saveInDye2(a, recipes.saveSlot1);
    await saveInDye2(a, recipes.saveSlot2);
    await saveInDye2(a, recipes.editSlot1);
    const listed = async () => (await api.get<{ recipes: RecipeView[] }>(`/locations/${here.id}/recipes`)).recipes;
    await expect.poll(async () => (await listed()).map((listedRecipe) => listedRecipe.slot).sort()).toEqual([1, 2]);
    const [one, two] = [1, 2].map(async (slot) => (await listed()).find((listedRecipe) => listedRecipe.slot === slot)!.id);
    const ids = { one: await one!, two: await two! };
    // Each tablet holds both, naming the batch and Basket each uses by its own ids, and A's carry their global ids.
    for (const tablet of [a, c, d]) {
      await expect
        .poll(() => ["1", "2"].map((slot) => [dye2GlobalIdOf(inSlot(tablet, slot)), (inSlot(tablet, slot)?.[RECIPE_FIELD] as Record_ | undefined)?.beanBatchId ?? null]).flat())
        .not.toContain(null);
      await expect.poll(() => ["1", "2"].map((slot) => variables(inSlot(tablet, slot)).basketId ?? null)).not.toContain(null);
    }
    const load = async (tablet: SimulatedTablet, machine: CreatedMachine, slot: string, recipeId: string) => {
      expect((await applyInDye2(tablet, slot)).status).toBe(200);
      await expect.poll(() => named(tablet)).toBe(recipeId);
      await loads(machine, recipeId);
    };
    await load(a, machines.a, "1", ids.one);
    await load(c, machines.c, "1", ids.one);
    await load(d, machines.d, "2", ids.two);
    return { here, machines, a, c, d, ...ids, load };
  }

  it("takes a grind, RPM and hot water change on A into the Recipe, once, and writes it into C's Workflow on the other instance, and no other's", async () => {
    const { machines, a, c, d, one } = await lab("Grind", 48001);
    const before = { grind: await editsOf(one, "grindSetting"), rpm: await editsOf(one, "rpm"), volume: await editsOf(one, "hotWaterVolume") };
    const untouched = { grind: context(d).grinderSetting, rpm: extras(d).rpm, volume: hotWater(d).volume };

    await a.changeSettings({ context: { grinderSetting: "2.8", extras: { rpm: 950 } }, hotWaterData: { volume: 140 } });
    await expect.poll(async () => (await recipe(one)).content).toMatchObject({ grindSetting: 2.8, rpm: 950, hotWaterVolume: 140 });
    // C's Workflow takes it, the Recipe still loaded there, as does its record on every tablet.
    await expect.poll(() => [context(c).grinderSetting, extras(c).rpm, hotWater(c).volume]).toEqual(["2.8", 950, 140]);
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
    for (const tablet of [a, c, d]) await expect.poll(() => [variables(inSlot(tablet, "1")).grind, variables(inSlot(tablet, "1")).rpm]).toEqual([2.8, 950]);
    // The server reads C's Workflow as its own write, not C's edit, and A's as A's edit.
    await expect.poll(async () => ((await storedWorkflow(machines.c)).context as Record_ | undefined)?.grinderSetting).toBe("2.8");
    await settle();
    expect({ grind: await editsOf(one, "grindSetting"), rpm: await editsOf(one, "rpm"), volume: await editsOf(one, "hotWaterVolume") }).toEqual({
      grind: before.grind + 1,
      rpm: before.rpm + 1,
      volume: before.volume + 1,
    });
    const [latest] = (await versions(one)).filter((version) => "grindSetting" in version.fields);
    expect(latest!.source.machine?.id).toBe(machines.a.machine.id);
    // D has slot 2 loaded: its Workflow is written nothing.
    expect({ grind: context(d).grinderSetting, rpm: extras(d).rpm, volume: hotWater(d).volume }).toEqual(untouched);
    expect(named(a)).toBe(one);
  });

  it("edits the Recipe once for a dose changed in the Workflow alone, and once for one also saved into the recipe, as Streamline's auto-save does, and DYE2 from v0.1.20", async () => {
    const { machines, a, c, d, one, two, load } = await lab("Dose", 48011);
    // The Workflow alone changes, as on DYE2's dashboard before v0.1.20.
    const dashboard = await editsOf(one, "dose");
    await a.changeSettings({ context: { targetDoseWeight: 18.7 } });
    await expect.poll(async () => (await recipe(one)).content.dose).toBe(18.7);
    await expect.poll(() => context(c).targetDoseWeight).toBe(18.7);
    await settle();
    expect(await editsOf(one, "dose")).toBe(dashboard + 1);

    // The Streamline way: its strip applies slot 2 on A, then saves the barista's dose change into it, 19 g to 20 g.
    expect((await applyInStreamline(a, "2")).status).toBe(200);
    await expect.poll(() => named(a)).toBe(two);
    await loads(machines.a, two);
    await load(c, machines.c, "2", two);
    const streamline = await editsOf(two, "dose");
    expect(await autoSaveInStreamline(a, strip.autoSaveDose)).toBeDefined();
    expect(variables(inSlot(a, "2")).dose).toBe(20);
    await expect.poll(async () => (await recipe(two)).content.dose).toBe(20);
    // Both the Workflow and the recipe saved into are taken in, as the same edit.
    await expect
      .poll(async () => (((await api.get<{ collection: { value: Record_[] } | null }>(`/machines/${machines.a.machine.id}/collections/dye2Recipes`)).collection?.value ?? []).find((record) => record.id === "2")?.dashboardVariables as Record_ | undefined)?.dose)
      .toBe(20);
    await expect.poll(async () => ((await storedWorkflow(machines.a)).context as Record_ | undefined)?.targetDoseWeight).toBe(20);
    await expect.poll(() => [context(c).targetDoseWeight, context(d).targetDoseWeight]).toEqual([20, 20]);
    await settle();
    expect(await editsOf(two, "dose")).toBe(streamline + 1);
    expect(named(c)).toBe(two);
  });

  it("writes an edit in the management interface into the Workflow of every Machine with the Recipe loaded, and of no other", async () => {
    const { machines, a, c, d, one } = await lab("Managed", 48021);
    const untouched = { dose: context(d).targetDoseWeight, temperature: hotWater(d).targetTemperature };
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { dose: 17.5, grindSetting: 2.5, hotWaterTemperature: 90 } })).status).toBe(200);
    for (const tablet of [a, c]) {
      await expect.poll(() => [context(tablet).targetDoseWeight, context(tablet).grinderSetting, hotWater(tablet).targetTemperature]).toEqual([17.5, "2.5", 90]);
      expect(named(tablet)).toBe(one);
    }
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
    await settle();
    expect({ dose: context(d).targetDoseWeight, temperature: hotWater(d).targetTemperature }).toEqual(untouched);
    // Written by the server, which the tablets' Workflows do not edit back.
    expect((await recipe(one)).content).toMatchObject({ dose: 17.5, grindSetting: 2.5, hotWaterTemperature: 90 });
    expect((await versions(one)).filter((version) => "dose" in version.fields)[0]!.source.machine).toBeNull();
  });

  it("writes the Recipe's Grinder and Profile, changed in the management interface, into the Workflow of each Machine with it loaded, which keeps it loaded", async () => {
    const { here, machines, a, c, one, two } = await lab("Regrind", 48081);
    const created = await api.call("POST", "/grinders", { locationId: here.id, content: { model: "Regrind EK43" } });
    expect(created.status).toBe(201);
    const grinder = ((await created.json()) as { grinder: { id: string } }).grinder.id;
    const profileId = (await recipe(two)).content.profileId as string;
    expect(profileId).not.toBe((await recipe(one)).content.profileId);
    const title = ((await api.get<{ profile: { content: { profile: { title: string } } } }>(`/profiles/${encodeURIComponent(profileId)}`)).profile.content.profile).title;

    expect((await api.call("PATCH", `/recipes/${one}`, { content: { grinderId: grinder, profileId, grindSetting: 4.3 } })).status).toBe(200);
    for (const tablet of [a, c]) {
      await expect.poll(() => localId(tablet, "/grinders", grinder)).toEqual(expect.any(String));
      const onTablet = await localId(tablet, "/grinders", grinder);
      await expect.poll(() => [context(tablet).grinderId, context(tablet).grinderModel, context(tablet).grinderSetting]).toEqual([onTablet, "Regrind EK43", "4.3"]);
      await expect.poll(() => (tablet.workflow().profile as Record_ | undefined)?.title).toBe(title);
    }
    // Still the Recipe the plugin and the server have loaded on both.
    await settle();
    expect([named(a), named(c)]).toEqual([one, one]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

  it("writes the Recipe's Grinder and grind into a Workflow only once its tablet holds the Recipe's record, so a refused write of the record leaves it loaded", async () => {
    const { here, machines, c, one } = await lab("Refused record", 48101);
    const created = await api.call("POST", "/grinders", { locationId: here.id, content: { model: "Refused EK43" } });
    const grinder = ((await created.json()) as { grinder: { id: string } }).grinder.id;
    const before = context(c).grinderId;
    c.refuseWrites = ({ route }) => (route === "/store/dye2.reaplugin/recipes" ? { status: 500, body: { error: "Recipe write failed" } } : undefined);
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { grinderId: grinder, grindSetting: 4.1, hotWaterTemperature: 92 } })).status).toBe(200);
    // The hot water is written; the Grinder and grind wait for the record, and the Recipe stays loaded.
    await expect.poll(() => (c.workflow().hotWaterData as Record_).targetTemperature).toBe(92);
    await settle();
    expect([context(c).grinderId, context(c).grinderSetting]).toEqual([before, "2.7"]);
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
    // Its record written once it reconnects, the Grinder follows, still loaded.
    c.refuseWrites = undefined;
    c.dropConnections();
    await expect.poll(() => localId(c, "/grinders", grinder)).toEqual(expect.any(String));
    const onC = await localId(c, "/grinders", grinder);
    await expect.poll(() => [context(c).grinderId, context(c).grinderSetting]).toEqual([onC, "4.1"]);
    await settle();
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
  });

  it("writes the Recipe's grind into a Workflow only once its tablet holds the Recipe's record, so another Recipe it would match is not loaded", async () => {
    const { machines, c, d, one, two } = await lab("Twin", 48111);
    // Slot 2 made slot 1's twin, but for its grind setting.
    const { profileId, grinderId, dose, yield: drink } = (await recipe(one)).content;
    expect((await api.call("PATCH", `/recipes/${two}`, { content: { profileId, grinderId, dose, yield: drink, grindSetting: 4.1 } })).status).toBe(200);
    await expect.poll(() => [variables(inSlot(c, "2")).dose, variables(inSlot(c, "2")).grind, inSlot(c, "2")?.profileId]).toEqual([dose, 4.1, profileId]);
    // D, with slot 2 loaded, takes its new dial and keeps it loaded.
    await expect.poll(() => context(d).grinderSetting).toBe("4.1");
    expect(named(d)).toBe(two);

    c.refuseWrites = ({ route }) => (route === "/store/dye2.reaplugin/recipes" ? { status: 500, body: { error: "Recipe write failed" } } : undefined);
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { grindSetting: 4.1, hotWaterTemperature: 91 } })).status).toBe(200);
    // The hot water is written; the grind waits for slot 1's record, which would otherwise leave the Workflow matching slot 2.
    await expect.poll(() => (c.workflow().hotWaterData as Record_).targetTemperature).toBe(91);
    await settle();
    expect(context(c).grinderSetting).toBe("2.7");
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
  });

  it("keeps no Conflict for a tweak of a value its Workflow was written, though the Recipe names a Basket its tablets no longer hold", async () => {
    const { a, c, one } = await lab("Archived basket", 48121);
    const basket = (await recipe(one)).content.basketId as string;
    expect((await api.call("PUT", `/baskets/${basket}/archived`, { archived: true })).status).toBe(200);
    // DYE2 cannot hide a Basket: it leaves every tablet's list, and no write of the Recipe can carry it.
    for (const tablet of [a, c]) await expect.poll(() => (dye2List(tablet, "baskets") as Record_[]).some((record) => record[GLOBAL_ID_KEY] === basket)).toBe(false);

    await a.changeSettings({ context: { grinderSetting: "2.8" } });
    await expect.poll(() => context(c).grinderSetting).toBe("2.8");
    // C, written A's tweak, tweaks it again.
    await c.changeSettings({ context: { grinderSetting: "2.9" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting).toBe(2.9);
    await expect.poll(() => context(a).grinderSetting).toBe("2.9");
    await settle();
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${one}/conflicts`)).conflicts).toEqual([]);
  });

  it("keeps a Conflict for a Basket edit a Workflow never held, as its tablet refused the Basket's write, that a change on its Machine replaces", async () => {
    const { here, machines, c, one, two } = await lab("Refused basket", 48141);
    c.refuseWrites = ({ route }) => (route === "/store/dye2.reaplugin/baskets" ? { status: 500, body: { error: "Basket write failed" } } : undefined);
    const created = await api.call("POST", "/baskets", { locationId: here.id, content: { name: "Refused 21g" } });
    expect(created.status).toBe(201);
    const basket = ((await created.json()) as { basket: { id: string } }).basket.id;
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { basketId: basket, grindSetting: 3.1 } })).status).toBe(200);
    // C takes the grind, but not the Basket it holds no record of.
    await expect.poll(() => context(c).grinderSetting).toBe("3.1");
    await settle();

    // C's barista picks slot 2's Basket, never having seen the one the Admin set.
    const other = variables(inSlot(c, "2")).basketId as string;
    await c.changeSettings({ context: { extras: { basketId: other } } });
    await expect.poll(async () => (await recipe(one)).content.basketId).toBe((await recipe(two)).content.basketId);
    await expect.poll(async () => (await api.get<{ conflicts: { field: string; value: unknown }[] }>(`/recipes/${one}/conflicts`)).conflicts).toEqual([
      expect.objectContaining({ field: "basketId", value: basket }),
    ]);
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
  });

  it("keeps DYE2's selected recipe in step with the Loaded Recipe, clearing only a selection of the recipe unloaded", async () => {
    const { machines, a, c, d, one, two, load } = await lab("Selected", 48151, { dye2Selection: true });
    // Each Machine's DYE2 has its Loaded Recipe's slot selected, so it records a barista's changes into that recipe.
    expect([dye2Selection(a), dye2Selection(c), dye2Selection(d)]).toEqual([
      { kind: "recipe", id: "1" },
      { kind: "recipe", id: "1" },
      { kind: "recipe", id: "2" },
    ]);
    // Moved to slot 5, it is selected there.
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: 5 })).status).toBe(200);
    await expect.poll(() => [dye2Selection(a), dye2Selection(c)]).toEqual([{ kind: "recipe", id: "5" }, { kind: "recipe", id: "5" }]);

    // Another grinder unloads it on A, and clears it from DYE2's selection, which DYE2 itself keeps on a grinder change.
    await a.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await expect.poll(() => named(a)).toBeNull();
    await expect.poll(() => dye2Selection(a)).toBeNull();

    // A favourite the barista selected since in DYE2 stays as C unloads the Recipe.
    expect((await c.callApi("POST", "/plugins/dye2.reaplugin/selection", { kind: "favourite", id: "fav-1" })).status).toBe(200);
    await c.changeSettings({ context: { grinderId: "a-grinder-the-recipe-does-not-name", grinderModel: "Another grinder" } });
    await expect.poll(() => named(c)).toBeNull();
    await loads(machines.c, null);
    await settle();
    expect(dye2Selection(c)).toEqual({ kind: "favourite", id: "fav-1" });

    // An unload the server decides clears it too, though D's list loses the Recipe first, as its clear is refused once
    // and written only once D reconnects.
    let refused = false;
    d.refuseWrites = ({ route, body }) => {
      const extras = ((body as Record_ | null)?.context as Record_ | undefined)?.extras as Record_ | undefined;
      if (refused || route !== "/workflow" || !extras || !(LOADED_RECIPE_KEY in extras)) return undefined;
      refused = true;
      return { status: 500, body: { error: "Workflow write failed" } };
    };
    expect((await api.call("PUT", `/recipes/${two}/archived`, { archived: true })).status).toBe(200);
    await expect.poll(() => refused).toBe(true);
    await expect.poll(() => inSlot(d, "2")).toBeUndefined();
    await settle();
    expect(named(d)).toBe(two);
    d.dropConnections();
    await expect.poll(() => named(d)).toBeNull();
    await expect.poll(() => dye2Selection(d)).toBeNull();
  });

  it("moves the Recipe to the next batch of its Bean picked on A, written into C's Workflow, and unloads it on a batch of another Bean, leaving the Recipe as it was", async () => {
    const { machines, a, c, one } = await lab("Rebagged", 48031);
    const library = dye2Library();
    const beanOf = (name: string) => (library["/beans"] as Record_[]).find((bean) => String(bean.name).endsWith(name))!.id;
    const brazilBatch = (library["/bean-batches"] as Record_[]).find((batch) => batch.beanId === beanOf("Brazil"))!.id;

    // The next bag of the Recipe's Bean, picked at once, before the tablet's report of its batches can name it.
    const nextBag = await a.addBatch(beanOf("Ethiopia"), { roastDate: "2026-10-10", weight: 250 });
    await a.changeSettings({ context: { beanBatchId: nextBag.id } });
    const global = async () => ((await a.callApi("GET", `/bean-batches/${String(nextBag.id)}`)).body as { extras?: Record_ }).extras?.[GLOBAL_ID_KEY];
    await expect.poll(global).toEqual(expect.any(String));
    const bag = (await global()) as string;
    await expect.poll(async () => (await recipe(one)).content.beanBatchId).toBe(bag);
    // C is written the batch first, then its Workflow takes it, the Recipe still loaded there.
    await expect.poll(() => localId(c, "/bean-batches", bag)).toEqual(expect.any(String));
    const onC = await localId(c, "/bean-batches", bag);
    await expect.poll(() => context(c).beanBatchId).toBe(onC);
    expect(named(c)).toBe(one);
    expect(named(a)).toBe(one);

    // A batch of another Bean unloads it on A, keeping the batch picked, and changes nothing of the Recipe or of C.
    await a.changeSettings({ context: { beanBatchId: brazilBatch } });
    await expect.poll(() => named(a)).toBeNull();
    await loads(machines.a, null);
    expect(context(a).beanBatchId).toBe(brazilBatch);
    await settle();
    expect((await recipe(one)).content.beanBatchId).toBe(bag);
    expect(context(c).beanBatchId).toBe(onC);
    expect(named(c)).toBe(one);
  });

  it("unloads the Recipe on every Machine as it is taken out of its slot, or Archived, and keeps it loaded as it moves to another slot", async () => {
    const { machines, a, c, d, one, two, load } = await lab("Unslotted", 48041);
    // Moved to slot 5: still loaded, its record in slot 5 on every tablet.
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: 5 })).status).toBe(200);
    for (const tablet of [a, c]) await expect.poll(() => dye2GlobalIdOf(inSlot(tablet, "5"))).toBe(one);
    await settle();
    expect([named(a), named(c)]).toEqual([one, one]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);

    // Taken out of its slot: cleared from the Workflow of each Machine with it loaded.
    expect((await api.call("PUT", `/recipes/${one}/slot`, { slot: null })).status).toBe(200);
    for (const tablet of [a, c]) await expect.poll(() => named(tablet)).toBeNull();
    for (const machine of [machines.a, machines.c]) await loads(machine, null);
    expect(named(d)).toBe(two);
    await loads(machines.d, two);

    // Archived: the same, on every Machine with it loaded.
    await load(a, machines.a, "2", two);
    expect((await api.call("PUT", `/recipes/${two}/archived`, { archived: true })).status).toBe(200);
    for (const tablet of [a, d]) await expect.poll(() => named(tablet)).toBeNull();
    for (const machine of [machines.a, machines.d]) await loads(machine, null);
    expect((await recipe(two)).content.dose).toBe(19);
  });

  it("writes the rest of an edit into a Workflow whose machine is away, and its hot water once the machine is back, as Decaid refuses that meanwhile", async () => {
    const { machines, a, c, one } = await lab("Away", 48071);
    const volume = hotWater(c).volume;
    c.machineConnected = false;
    expect((await api.call("PATCH", `/recipes/${one}`, { content: { dose: 18.2, hotWaterVolume: 130 } })).status).toBe(200);
    await expect.poll(() => context(c).targetDoseWeight).toBe(18.2);
    await expect.poll(() => c.sent.some((frame) => (frame as Record_).type === "writeRefused")).toBe(true);
    expect(hotWater(c).volume).toBe(volume);
    expect(hotWater(a).volume).toBe(130);
    // The machine back, the plugin reconnects, and the Workflow is written the Recipe's hot water.
    c.connectMachine();
    await expect.poll(() => hotWater(c).volume).toBe(130);
    expect(named(c)).toBe(one);
    await settle();
    expect((await recipe(one)).content).toMatchObject({ dose: 18.2, hotWaterVolume: 130 });
    await loads(machines.c, one);
  });

  it("unloads the Recipe of a Machine made capture-only, and of no other", async () => {
    const { machines, a, c, one } = await lab("Capture-only", 48051);
    expect((await api.call("PUT", `/machines/${machines.a.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    await expect.poll(() => named(a)).toBeNull();
    await loads(machines.a, null);
    await settle();
    expect(named(c)).toBe(one);
    await loads(machines.c, one);
  });

  it("clears the Recipe of a Machine made capture-only while offline, though a report of its Library lists is unavailable as it reconnects", async () => {
    const { machines, a, c, one } = await lab("Offline capture-only", 48091);
    c.loseNetwork();
    await api.waitForMachine(machines.c.machine.name, (viewed) => !viewed.online, 15_000);
    c.refuseFor("/beans", new Refusal(500, { error: "Read failed" }));
    expect((await api.call("PUT", `/machines/${machines.c.machine.id}/sharing`, { sharing: false })).status).toBe(200);
    const sent = c.sent.length;
    c.restoreNetwork();
    await expect.poll(() => c.sent.slice(sent).some((frame) => (frame as Record_).type === "collection" && (frame as Record_).name === "beans" && (frame as Record_).available === false)).toBe(true);
    await expect.poll(() => named(c)).toBeNull();
    await loads(machines.c, null);
    expect(named(a)).toBe(one);
  });

  it("writes the Recipe's dial back over a stale recipe pill, or a stale DYE2 dashboard's Done, on another Machine, which edits nothing", async () => {
    const { machines, a, c, one } = await lab("Stale", 48131);
    // C's DYE2 dashboard reads its recipes and the Workflow once, as it opens.
    const copy = structuredClone(inSlot(c, "1")!);
    const opened = structuredClone(c.workflow());
    await a.changeSettings({ context: { grinderSetting: "2.9" } });
    await expect.poll(() => context(c).grinderSetting).toBe("2.9");
    await expect.poll(() => variables(inSlot(c, "1")).grind).toBe(2.9);
    const grinds = await editsOf(one, "grindSetting");
    // The Workflows the server stored for C with the old grind: one as it loaded the Recipe so far.
    const old = async () =>
      (
        (await (await api.call("GET", `/machines/${machines.c.machine.id}/workflow-events?limit=100`)).json()) as { events: { workflow: { context?: Record_ } }[] }
      ).events.filter((event) => event.workflow.context?.grinderSetting === "2.7").length;

    for (const [stale, apply] of [
      ["pill", () => applyInDye2(c, "1", copy)],
      ["Done", () => c.callApi("PUT", "/workflow", opened)],
    ] as const) {
      const before = await old();
      expect((await apply()).status, stale).toBe(200);
      await expect.poll(old).toBe(before + 1);
      await expect.poll(() => context(c).grinderSetting).toBe("2.9");
      await expect.poll(async () => ((await storedWorkflow(machines.c)).context as Record_ | undefined)?.grinderSetting).toBe("2.9");
    }
    await settle();
    expect(named(c)).toBe(one);
    expect((await recipe(one)).content.grindSetting).toBe(2.9);
    expect(await editsOf(one, "grindSetting")).toBe(grinds);
    expect(context(a).grinderSetting).toBe("2.9");
  });

  it("takes a tweak set back on A as A's edit, which every Machine with the Recipe loaded follows", async () => {
    const { machines, a, c, one } = await lab("Set back", 48061);
    await a.changeSettings({ context: { grinderSetting: "2.8" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting).toBe(2.8);
    // Every tablet, A's included, is written the Recipe's record with the tweak.
    for (const tablet of [a, c]) await expect.poll(() => variables(inSlot(tablet, "1")).grind).toBe(2.8);
    await expect.poll(() => context(c).grinderSetting).toBe("2.8");
    const grinds = await editsOf(one, "grindSetting");

    // Set back as the barista tastes it.
    await a.changeSettings({ context: { grinderSetting: "2.7" } });
    await expect.poll(async () => (await recipe(one)).content.grindSetting).toBe(2.7);
    await expect.poll(() => context(c).grinderSetting).toBe("2.7");
    await settle();
    expect(context(a).grinderSetting).toBe("2.7");
    expect(await editsOf(one, "grindSetting")).toBe(grinds + 1);
    expect([named(a), named(c)]).toEqual([one, one]);
    for (const machine of [machines.a, machines.c]) await loads(machine, one);
  });

});
