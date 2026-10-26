import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_ID_KEY, RECIPE_SLOT_FIELD, globalIdOf } from "@decent-sync/protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, recipeIdInWorkflow, syncingTablet } from "./support/loaded-tablets.js";
import { SimulatedDye2, dye2List, dye2Migrated, openDye2RecipeEditor, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { Refusal, type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, adminDatabaseUrl, startTestServer, testDatabaseName } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #143: Recipes created, edited, moved
// between Recipe Slots, taken out of them, Archived and restored in the
// management interface reach the DYE2 recipes of the tablets at their
// Location, through the built plugin in simulated tablets, on two server
// instances sharing PostgreSQL. And for ticket #216: a Recipe created there
// has a new opaque record id, the same on every tablet; every Recipe at the
// Location that is not Archived is on each of its tablets, its Recipe Slot
// its record's `stripSlot`, one of five, so a move changes only that, the
// slot's previous holder's cleared, and keeps it loaded; an Archived Recipe
// leaves the tablets and the Workflows that name it; and the migration keeps
// each Recipe's slot number as its record id, taking those above 5 out of
// their slots. What a Recipe uses is offered at its Location as it is set.
// Serials are made up, from 45001.

type Record_ = Record<string, unknown>;

interface RecipeView {
  id: string;
  name: string | null;
  location: LocationView | null;
  slot: number | null;
  archived: boolean;
  content: Record_;
  uses: {
    bean: { id: string; name: string | null } | null;
    beanBatch: { id: string; atLocation: boolean } | null;
    profile: { id: string; title: string | null } | null;
    grinder: { id: string; model: string | null } | null;
    basket: { id: string; name: string | null } | null;
    tools: { id: string; name: string | null }[];
  };
  batchFinished: boolean;
}

interface VersionView {
  fields: Record_;
  location: LocationView | null;
  source: { machine: unknown; account: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("Recipes in the management interface", { timeout: 90_000 }, () => {
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

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Library and DYE2's lists empty, DYE2 running where given. */
  function load(machine: CreatedMachine, serial: number, instance: TestServer, stallUpload?: (frame: unknown) => boolean, pollSeconds = 5, dye2?: SimulatedDye2): SimulatedTablet {
    return syncingTablet(machine, instance, { api: { ...emptyLibrary(serial), ...(dye2 ? dye2Migrated() : {}) }, stallUpload, pollSeconds, dye2 });
  }

  /** A Location with a Machine whose tablet is online through each instance given, each running DYE2 with `dye2`. */
  async function locationWith(
    name: string,
    serial: number,
    instances: TestServer[],
    { dye2 = false }: { dye2?: boolean } = {},
  ): Promise<{ location: LocationView; tablets: SimulatedTablet[]; machines: CreatedMachine[]; dye2s: SimulatedDye2[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    const machines: CreatedMachine[] = [];
    const dye2s: SimulatedDye2[] = [];
    for (const [index, instance] of instances.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      const running = dye2 ? new SimulatedDye2() : undefined;
      if (running) dye2s.push(running);
      machines.push(machine);
      loaded.push(load(machine, serial + index, instance, undefined, 5, running));
      await api.waitForOnline(machine);
    }
    return { location, tablets: loaded, machines, dye2s };
  }

  const create = (location: LocationView, slot: number | "next" | null, content: Record_, as: AdminApi = api) =>
    as.send<{ recipe: RecipeView }>("POST", "/recipes", { locationId: location.id, slot, content }, 201).then((created) => created.recipe);
  const edit = (id: string, content: Record_, as: AdminApi = api) => as.send<{ recipe: RecipeView }>("PATCH", `/recipes/${id}`, { content }).then((edited) => edited.recipe);
  const move = (id: string, slot: number | "next" | null, as: AdminApi = api) => as.send<{ recipe: RecipeView }>("PUT", `/recipes/${id}/slot`, { slot }).then((moved) => moved.recipe);
  const recipe = (id: string) => api.get<{ recipe: RecipeView }>(`/recipes/${id}`).then((read) => read.recipe);
  const recipesAt = (location: LocationView) => api.get<{ recipes: RecipeView[] }>(`/locations/${location.id}/recipes`).then((read) => read.recipes);
  const versions = async (id: string) => (await api.get<{ versions: VersionView[] }>(`/recipes/${id}/history`)).versions;

  /** A Bean with a batch at each Location given, and a Grinder of the first. */
  async function library(scenario: string, grinderAt: LocationView, batchAt: LocationView[]) {
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: `${scenario} Guji` } }, 201)).bean;
    const batch = (
      await api.send<{ batch: { id: string } }>(
        "POST",
        "/bean-batches",
        { beanId: bean.id, content: { roastDate: "2026-10-01" }, locations: batchAt.map((location) => ({ locationId: location.id })) },
        201,
      )
    ).batch;
    const grinder = (await api.send<{ grinder: { id: string } }>("POST", "/grinders", { locationId: grinderAt.id, content: { model: `${scenario} EK43` } }, 201)).grinder;
    return { bean, batch, grinder };
  }

  /** The tablet's recipe records, in its list's order. */
  const recordsOn = (tablet: SimulatedTablet): Record_[] => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]) : [];
  };
  /** The tablet's recipe in a slot, by its `stripSlot`, if it holds one there. */
  const slotOn = (tablet: SimulatedTablet, slot: number): Record_ | undefined => recordsOn(tablet).find((record) => record[RECIPE_SLOT_FIELD] === slot);
  /** The tablet's record of a Recipe, by the global id it carries. */
  const recordOf = (tablet: SimulatedTablet, recipeId: string): Record_ | undefined => recordsOn(tablet).find((record) => record[GLOBAL_ID_KEY] === recipeId);
  /** The slot each of the tablet's recipes is in, `-` for none, and its name, in its list's order. */
  const slotsOn = (tablet: SimulatedTablet) => recordsOn(tablet).map((record) => `${String(record[RECIPE_SLOT_FIELD] ?? "-")}:${String(record.name)}`);
  /** Whether the Machine has that Recipe loaded, by its id, or none. */
  const loadedOn = async ({ machine }: CreatedMachine) =>
    (await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.id}`)).machine.loadedRecipe?.recipe.id ?? null;
  /** A record of the tablet's without its `stripSlot`, to compare what else a write changed. */
  const withoutSlot = (record: Record_ | undefined) => {
    const { [RECIPE_SLOT_FIELD]: _, ...rest } = record ?? {};
    return rest;
  };
  /** The tablet's own id for its record of a Library item, by the global id the record carries. */
  const localId = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id || record[GLOBAL_ID_KEY] === id)?.id;
  /** Whether the server has acknowledged the tablet's answer to a write of the item, so the writer awaits it no more. */
  const answered = (tablet: SimulatedTablet, id: string) =>
    tablet.acknowledgedSome((frame: { type?: unknown; globalId?: unknown }) => frame.type === "written" && frame.globalId === id);


  it("creates a Recipe in slot 3 using items not offered at its Location, offers them there, and writes it to that Location's tablets only, under one new record id", async () => {
    const lab = await locationWith("Created recipe lab", 45001, [server, other]);
    const cafe = await locationWith("Created recipe cafe", 45003, [server]);
    // A batch at the cafe only, a Profile saved on the cafe's tablet, shown there only, and a Basket and Tool shown at the cafe only.
    const { bean, batch, grinder } = await library("Created", lab.location, [cafe.location]);
    const profile = await cafe.tablets[0]!.addProfile(derivedProfile("Created Bloom", 7.25));
    const profileId = String(profile.id);
    await expect.poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profileId)}`)).status).toBe(200);
    const basket = (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: cafe.location.id, content: { name: "Created 20g" } }, 201)).basket;
    const tool = (await api.send<{ tool: { id: string } }>("POST", "/tools", { locationId: cafe.location.id, content: { name: "Created WDT", custom: [{ key: "Needles", value: "8" }] } }, 201)).tool;

    const created = await create(lab.location, 3, {
      name: "Created Espresso",
      beverage: "Espresso",
      beanBatchId: batch.id,
      profileId,
      dose: 18,
      yield: 40,
      grinderId: grinder.id,
      grindSetting: 2.5,
      rpm: 1000,
      brewTemperature: 92,
      basketId: basket.id,
      toolIds: [tool.id],
      toolAttributes: { [tool.id]: [{ key: "Needles", value: "10" }] },
      hotWaterVolume: 120,
      hotWaterTemperature: 85,
      hotWaterDuration: 30,
      hotWaterFlow: 6,
      showOnDashboard: false,
    });
    expect(created).toMatchObject({
      name: "Created Espresso",
      slot: 3,
      archived: false,
      batchFinished: false,
      content: { beanId: bean.id, beanBatchId: batch.id, steamMode: "flow", hotWaterMode: "vol", showOnDashboard: false },
      uses: {
        bean: { id: bean.id, name: "Created Guji" },
        beanBatch: { id: batch.id, atLocation: true },
        profile: { id: profileId, title: "Created Bloom" },
        grinder: { id: grinder.id, model: "Created EK43" },
        basket: { id: basket.id, name: "Created 20g" },
        tools: [{ id: tool.id, name: "Created WDT" }],
      },
    });

    // The batch was added at the lab, and the Profile, Basket and Tool shown there, by the account.
    const atLab = (here: { location: { id: string } }) => here.location.id === lab.location.id;
    expect((await api.get<{ batch: { locations: { location: { id: string } }[] } }>(`/bean-batches/${batch.id}`)).batch.locations.some(atLab)).toBe(true);
    for (const path of [`/profiles/${encodeURIComponent(profileId)}`, `/baskets/${basket.id}`, `/tools/${tool.id}`]) {
      const read = Object.values(await api.get<Record<string, { shownAt: { location: { id: string } }[] }>>(path))[0]!;
      expect(read.shownAt.some(atLab), path).toBe(true);
    }

    // Each lab tablet holds it in slot 3, naming what it uses by its own ids; the cafe's holds nothing of it.
    for (const tablet of lab.tablets) {
      await expect.poll(() => slotOn(tablet, 3)?.[GLOBAL_ID_KEY]).toBe(created.id);
      const record = slotOn(tablet, 3)!;
      const baskets = dye2List(tablet, "baskets") as Record_[];
      const tools = dye2List(tablet, "equipment") as Record_[];
      const toolId = String(localId(tools, tool.id));
      expect(record).toMatchObject({
        name: "Created Espresso",
        beverage: "Espresso",
        beanId: localId(tablet.beans(), bean.id),
        beanBatchId: localId(tablet.batches(), batch.id),
        profileId,
        showOnStreamlineDashboard: false,
        barista: "",
        drinker: "",
        dashboardVariables: {
          dose: 18,
          drink: 40,
          grind: 2.5,
          rpm: 1000,
          brewC: 92,
          hotWaterMode: "vol",
          hotWaterTempC: 85,
          hotWaterTimeS: 30,
          hotWaterMl: 120,
          hotWaterFlowMls: 6,
          grinderId: localId(tablet.grinders(), grinder.id),
          basketId: localId(baskets, basket.id),
          equipmentIds: [toolId],
          equipmentCustom: { [toolId]: [{ key: "Needles", value: "10" }] },
        },
      });
      expect(slotOn(tablet, 3)).not.toHaveProperty("decentSyncRecipe");
    }
    // Its record id is a new opaque one, not its slot's number, the same on both lab tablets.
    const recordIds = lab.tablets.map((tablet) => slotOn(tablet, 3)!.id);
    expect(recordIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(recordIds[1]).toBe(recordIds[0]);
    expect(slotsOn(cafe.tablets[0]!)).toEqual([]);

    const history = await versions(created.id);
    expect(history.map((version) => version.fields)).toEqual([{ slot: 3 }, expect.objectContaining({ name: "Created Espresso", dose: 18 })]);
    expect(history[0]).toMatchObject({ location: { id: lab.location.id }, source: { machine: null, account: { id: expect.any(String) } } });
  });

  it("edits a Recipe, keeping DYE2's ratio only while the yield is the dose times it, and each Tool's attributes only while it names the Tool", async () => {
    const lab = await locationWith("Edited recipe lab", 45011, [server, other]);
    const tool = (await api.send<{ tool: { id: string } }>("POST", "/tools", { locationId: lab.location.id, content: { name: "Edited Puck Screen" } }, 201)).tool;
    const created = await create(lab.location, "next", { name: "Edited Espresso", dose: 18, yield: 36, toolIds: [tool.id], toolAttributes: { [tool.id]: [{ key: "Mesh", value: "150" }] } });
    expect(created.slot).toBe(1);
    // A ratio a tablet saved, kept while the yield is the dose times it.
    await expect.poll(() => slotOn(lab.tablets[0]!, 1)?.name).toBe("Edited Espresso");
    expect((await edit(created.id, { name: "Edited Espresso 2" })).content).toMatchObject({ dose: 18, yield: 36 });

    const edited = await edit(created.id, { dose: 20, yield: null, toolIds: [] });
    expect(edited.content).not.toHaveProperty("yield");
    expect(edited.content).toMatchObject({ dose: 20, toolIds: [], toolAttributes: {} });
    for (const tablet of lab.tablets) {
      await expect.poll(() => (slotOn(tablet, 1)?.dashboardVariables as Record_ | undefined)?.dose).toBe(20);
      expect(slotOn(tablet, 1)).toMatchObject({ name: "Edited Espresso 2", dashboardVariables: { equipmentIds: [], equipmentCustom: {} } });
    }
    expect((await versions(created.id))[0]!.fields).toEqual({ dose: 20, yield: null, toolIds: [], toolAttributes: {} });

    // Attributes of a Tool the Recipe does not name are refused.
    const refused = await api.call("PATCH", `/recipes/${created.id}`, { content: { toolAttributes: { [tool.id]: [{ key: "Mesh", value: "200" }] } } });
    expect(refused.status).toBe(400);
  });

  it("keeps a Tool Archived since beside a new one, and drops every Tool's attributes when the Tools are cleared with null", async () => {
    const lab = await api.createLocation("Kept tool lab", "America/Chicago");
    const newTool = (body: string) => api.send<{ tool: { id: string } }>("POST", "/tools", { locationId: lab.id, content: { name: body } }, 201).then((created) => created.tool);
    const old = await newTool("Kept Old WDT");
    const created = await create(lab, 1, { name: "Kept Espresso", toolIds: [old.id], toolAttributes: { [old.id]: [{ key: "Needles", value: "8" }] } });
    expect((await api.call("PUT", `/tools/${old.id}/archived`, { archived: true })).status).toBe(200);

    // The Archived Tool, which the Recipe uses already, is not refused as a new Tool joins it; it cannot be picked anew.
    const replacement = await newTool("Kept New WDT");
    expect((await edit(created.id, { toolIds: [old.id, replacement.id] })).content.toolIds).toEqual([old.id, replacement.id]);
    const other = await create(lab, 2, { name: "Other Espresso" });
    expect((await api.call("PATCH", `/recipes/${other.id}`, { content: { toolIds: [old.id] } })).status).toBe(409);

    const cleared = await edit(created.id, { toolIds: null });
    expect(cleared.content).not.toHaveProperty("toolIds");
    expect(cleared.content.toolAttributes).toEqual({});
  });

  it("keeps a Recipe's Bean its batch's when a Conflict's batch of another Bean is used", async () => {
    const lab = await locationWith("Conflicted batch lab", 45061, [server, other]);
    const start = await library("Conflicted Start", lab.location, [lab.location]);
    const brazil = await library("Conflicted Brazil", lab.location, [lab.location]);
    const kenya = await library("Conflicted Kenya", lab.location, [lab.location]);
    const created = await create(lab.location, 1, { name: "Conflicted Espresso", beanBatchId: start.batch.id });
    const [one, two] = lab.tablets as [SimulatedTablet, SimulatedTablet];
    for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(created.id);
    await expect.poll(() => localId(one.beans(), brazil.bean.id)).toBeDefined();
    await expect.poll(() => localId(two.beans(), kenya.bean.id)).toBeDefined();

    // Offline, one tablet's DYE2 editor picks the Brazil and the other, later, the Kenya: the Kenya and its batch win, and
    // the Brazil and its batch, replaced without being seen, are kept as Conflicts.
    const pick = async (tablet: SimulatedTablet, beanId: unknown) => {
      const list = recordsOn(tablet).map((record) => (record[GLOBAL_ID_KEY] === created.id ? { ...record, beanId } : record));
      expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);
    };
    one.loseNetwork();
    two.loseNetwork();
    await pick(one, localId(one.beans(), brazil.bean.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pick(two, localId(two.beans(), kenya.bean.id));
    one.restoreNetwork();
    await expect.poll(async () => (await recipe(created.id)).content.beanBatchId).toBe(brazil.batch.id);
    two.restoreNetwork();
    await expect.poll(async () => (await recipe(created.id)).content.beanBatchId).toBe(kenya.batch.id);
    type Open = { id: string; field: string; value: unknown; current: { versionId: string | null } };
    const conflicts = async () => (await api.get<{ conflicts: Open[] }>(`/recipes/${created.id}/conflicts`)).conflicts;
    await expect.poll(async () => (await conflicts()).map((conflict) => conflict.field).sort()).toEqual(["beanBatchId", "beanId"]);

    // Using the Brazil's batch makes the Brazil the Recipe's Bean too, rather than leaving the Kenya beside it.
    const batchConflict = (await conflicts()).find((conflict) => conflict.field === "beanBatchId")!;
    expect(batchConflict.value).toBe(brazil.batch.id);
    await api.send("POST", `/conflicts/${batchConflict.id}/use`, { seen: batchConflict.current.versionId });
    expect((await recipe(created.id)).content).toMatchObject({ beanId: brazil.bean.id, beanBatchId: brazil.batch.id });
    for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.beanId).toBe(localId(tablet.beans(), brazil.bean.id));
  });

  it("keeps a Bean used from a Conflict though it has no batch at the Location, and sets the yield from a ratio used", async () => {
    const lab = await locationWith("Conflicted bean lab", 45071, [server, other]);
    const start = await library("Bean-only Start", lab.location, [lab.location]);
    const brazil = await library("Bean-only Brazil", lab.location, [lab.location]);
    const kenya = await library("Bean-only Kenya", lab.location, [lab.location]);
    const created = await create(lab.location, 1, { name: "Bean-only Espresso", beanBatchId: start.batch.id, dose: 18, yield: 36 });
    const [one, two] = lab.tablets as [SimulatedTablet, SimulatedTablet];
    for (const tablet of [one, two]) await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(created.id);
    await expect.poll(() => localId(one.beans(), brazil.bean.id)).toBeDefined();
    await expect.poll(() => localId(two.beans(), kenya.bean.id)).toBeDefined();

    // Offline, one tablet's DYE2 editor picks the Brazil and a 1:3 ratio, the other, later, the Kenya and 1:2.5.
    const save = async (tablet: SimulatedTablet, beanId: unknown, ratio: number) => {
      const list = recordsOn(tablet).map((record) =>
        record[GLOBAL_ID_KEY] === created.id ? { ...record, beanId, dashboardVariables: { ...(record.dashboardVariables as Record_), ratio } } : record,
      );
      expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);
    };
    one.loseNetwork();
    two.loseNetwork();
    await save(one, localId(one.beans(), brazil.bean.id), 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await save(two, localId(two.beans(), kenya.bean.id), 2.5);
    one.restoreNetwork();
    await expect.poll(async () => (await recipe(created.id)).content.beanBatchId).toBe(brazil.batch.id);
    two.restoreNetwork();
    await expect.poll(async () => (await recipe(created.id)).content.beanBatchId).toBe(kenya.batch.id);
    type Open = { id: string; field: string; value: unknown; current: { versionId: string | null } };
    const conflicts = async () => (await api.get<{ conflicts: Open[] }>(`/recipes/${created.id}/conflicts`)).conflicts;
    await expect.poll(async () => (await conflicts()).map((conflict) => conflict.field).sort()).toEqual(["beanBatchId", "beanId", "ratio"]);
    const use = async (field: string) => {
      const conflict = (await conflicts()).find((open) => open.field === field)!;
      await api.send("POST", `/conflicts/${conflict.id}/use`, { seen: conflict.current.versionId });
    };

    // With the Brazil's batch finished here, using the Brazil alone keeps it, with no batch, rather than clearing it.
    expect((await api.call("PUT", `/bean-batches/${brazil.batch.id}/locations/${lab.location.id}`, { atLocation: false })).status).toBe(200);
    await use("beanId");
    const kept = (await recipe(created.id)).content;
    expect(kept.beanId).toBe(brazil.bean.id);
    expect(kept).not.toHaveProperty("beanBatchId");
    // The Brazil is offered at the lab again, with no batch there, so its tablets name it.
    expect((await api.get<{ bean: { offeredAt: { id: string }[] } }>(`/beans/${brazil.bean.id}`)).bean.offeredAt.map((at) => at.id)).toContain(lab.location.id);
    for (const tablet of [one, two]) {
      await expect.poll(() => slotOn(tablet, 1)?.beanId ?? null).toBe(localId(tablet.beans(), brazil.bean.id) ?? "none");
    }

    // A ratio cannot be used on a Recipe with no dose: the Conflict stays open until one is set.
    await edit(created.id, { dose: null });
    const ratioConflict = (await conflicts()).find((open) => open.field === "ratio")!;
    const refused = await api.call("POST", `/conflicts/${ratioConflict.id}/use`, { seen: ratioConflict.current.versionId });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain("no dose");
    expect((await conflicts()).map((open) => open.field)).toContain("ratio");
    await edit(created.id, { dose: 18 });

    // Using the 1:3 ratio sets the yield to the dose times it, as picking it in DYE2's editor does.
    await use("ratio");
    expect((await recipe(created.id)).content).toMatchObject({ dose: 18, yield: 54, ratio: 3 });
    for (const tablet of [one, two]) await expect.poll(() => (slotOn(tablet, 1)?.dashboardVariables as Record_ | undefined)?.drink).toBe(54);
  });

  it("clears DYE2's ratio when an edit leaves the yield other than the dose times it", async () => {
    const lab = await locationWith("Ratio lab", 45021, [server]);
    const created = await create(lab.location, 1, { name: "Ratio Espresso", dose: 18, yield: 36 });
    await expect.poll(() => slotOn(lab.tablets[0]!, 1)?.name).toBe("Ratio Espresso");
    // As DYE2's editor saves a ratio of 1:2 with its yield.
    const list = recordsOn(lab.tablets[0]!).map((record) =>
      record[GLOBAL_ID_KEY] === created.id ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), ratio: 2 } } : record,
    );
    expect((await lab.tablets[0]!.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);
    await expect.poll(async () => (await recipe(created.id)).content.ratio).toBe(2);

    expect((await edit(created.id, { dose: 20, yield: 40 })).content).toMatchObject({ dose: 20, yield: 40, ratio: 2 });
    const broken = await edit(created.id, { yield: 45 });
    expect(broken.content).toMatchObject({ dose: 20, yield: 45 });
    expect(broken.content).not.toHaveProperty("ratio");
    await expect.poll(() => (slotOn(lab.tablets[0]!, 1)?.dashboardVariables as Record_ | undefined)?.drink).toBe(45);
    expect(slotOn(lab.tablets[0]!, 1)!.dashboardVariables).not.toHaveProperty("ratio");
  });

  it("moves a Recipe from slot 2 to slot 4, swapping it with the one there, to the next free slot, and out of its slot, changing only stripSlot on every tablet and keeping it loaded", async () => {
    const lab = await locationWith("Moved recipe lab", 45031, [server, other], { dye2: true });
    const two = await create(lab.location, 2, { name: "Moved Two", dose: 18, yield: 36, grindSetting: 2.5 });
    const four = await create(lab.location, 4, { name: "Moved Four", dose: 19, yield: 40, grindSetting: 3 });
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["2:Moved Two", "4:Moved Four"]);
    // Each Recipe's record has one id on both tablets.
    expect(recordsOn(lab.tablets[1]!).map((record) => record.id)).toEqual(recordsOn(lab.tablets[0]!).map((record) => record.id));

    // The first Machine loads Moved Two from DYE2's Select Recipe page, its load write landing.
    const [first] = lab.tablets as [SimulatedTablet, SimulatedTablet];
    const twoRecord = String(recordOf(first, two.id)!.id);
    first.connectMachine();
    await selectRecipeInDye2(first, twoRecord);
    await expect.poll(() => loadedOn(lab.machines[0]!)).toBe(two.id);
    await expect.poll(() => (first.workflow().context as Record_ | undefined)?.grinderSetting).toBe("2.5");
    await lab.dye2s[0]!.settled();
    const before = lab.tablets.map((tablet) => structuredClone(recordsOn(tablet)));
    /** Whether each tablet's records changed nothing but their stripSlot, and Moved Two is still loaded on the first Machine, its Workflow naming it. */
    const onlySlotsMoved = async () => {
      for (const [index, tablet] of lab.tablets.entries()) expect(recordsOn(tablet).map(withoutSlot)).toEqual(before[index]!.map(withoutSlot));
      expect(recipeIdInWorkflow(first)).toBe(twoRecord);
      expect(await loadedOn(lab.machines[0]!)).toBe(two.id);
    };

    expect(await move(two.id, 4)).toMatchObject({ id: two.id, slot: 4 });
    expect((await recipe(four.id)).slot).toBe(2);
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["4:Moved Two", "2:Moved Four"]);
    await onlySlotsMoved();
    // Each keeps its id and its history, the move a version of its own.
    for (const tablet of lab.tablets) expect(slotOn(tablet, 4)![GLOBAL_ID_KEY]).toBe(two.id);
    expect((await versions(two.id)).map((version) => version.fields)).toEqual([{ slot: 4 }, { slot: 2 }, expect.objectContaining({ name: "Moved Two" })]);
    expect((await versions(four.id)).map((version) => version.fields)).toEqual([{ slot: 2 }, { slot: 4 }, expect.objectContaining({ name: "Moved Four" })]);

    // The next free slot is the lowest the Location leaves empty, which is never a Recipe's own.
    expect((await move(two.id, "next")).slot).toBe(1);
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["1:Moved Two", "2:Moved Four"]);
    expect((await move(two.id, "next")).slot).toBe(3);
    expect((await move(two.id, 1)).slot).toBe(1);
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["1:Moved Two", "2:Moved Four"]);

    // Taken out of its slot, it is kept at the Location, unslotted, and on every tablet in no slot.
    expect((await move(four.id, null)).slot).toBeNull();
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["1:Moved Two", "-:Moved Four"]);
    expect((await recipesAt(lab.location)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["Moved Two", 1],
      ["Moved Four", null],
    ]);
    // An unslotted Recipe moved into an occupied slot leaves the one there unslotted, the loaded one too, which stays loaded.
    expect((await move(four.id, 1)).slot).toBe(1);
    expect((await recipe(two.id)).slot).toBeNull();
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["-:Moved Two", "1:Moved Four"]);
    await onlySlotsMoved();
  });

  it("offers no next free slot where all five hold a Recipe: a new Recipe goes in none, and a move there is refused", async () => {
    const lab = await api.createLocation("Full slots lab", "America/Chicago");
    const slotted = [];
    for (const slot of [1, 2, 3, 4, 5]) slotted.push(await create(lab, slot, { name: `Full ${slot}` }));
    const kept = await create(lab, "next", { name: "Full kept" });
    expect(kept.slot).toBeNull();
    expect((await versions(kept.id)).map((version) => version.fields)).toEqual([expect.objectContaining({ name: "Full kept" })]);
    const refused = await api.call("PUT", `/recipes/${kept.id}/slot`, { slot: "next" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { message: string }).message).toContain("All 5 Recipe Slots here hold a Recipe");
    // A slot chosen still swaps, and a Recipe in a slot moved to the next free one stays where it is.
    expect((await move(kept.id, 3)).slot).toBe(3);
    expect((await recipe(slotted[2]!.id)).slot).toBeNull();
    expect((await api.call("PUT", `/recipes/${slotted[0]!.id}/slot`, { slot: "next" })).status).toBe(409);
    expect((await recipe(slotted[0]!.id)).slot).toBe(1);
  });

  it("writes a Recipe moved to another slot and back again, however its answers lag", async () => {
    const lab = await api.createLocation("Moved back lab", "America/Chicago");
    const machine = await api.createMachine("Moved back lab 1", lab.id);
    // The tablet's answers of each kind wait while held, as on a slow network, until let through.
    const held = new Set<string>();
    const tablet = load(machine, 45081, server, (frame) => held.has(String((frame as { type?: unknown }).type)));
    await api.waitForOnline(machine);
    const four = await create(lab, 2, { name: "Back Four" });
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Back Four"]);
    // Its answer through, so the writer awaits none: one held from here would hold every write after it.
    await expect.poll(() => answered(tablet, four.id)).toBe(true);

    // Written in slot 1, its answer held, then moved to slot 3, back to 1 and to 3 again before the writer looks again.
    held.add("written");
    const two = await create(lab, 1, { name: "Back Two" });
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Back Four", "1:Back Two"]);
    const recordId = recordOf(tablet, two.id)!.id;
    expect((await move(two.id, "next")).slot).toBe(3);
    expect((await move(two.id, 1)).slot).toBe(1);
    expect((await move(two.id, "next")).slot).toBe(3);
    held.clear();
    tablet.resumeUpload();
    // Its record is written its last slot, under the same id.
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Back Four", "3:Back Two"]);
    expect(recordOf(tablet, two.id)!.id).toBe(recordId);

    // The same with the answers to its moves held: moved back to slot 1, and the other Recipe out of its slot.
    held.add("written");
    expect((await move(two.id, 1)).slot).toBe(1);
    expect(await move(four.id, null)).toMatchObject({ slot: null });
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Back Four", "1:Back Two"]);
    held.clear();
    tablet.resumeUpload();
    await expect.poll(() => slotsOn(tablet)).toEqual(["-:Back Four", "1:Back Two"]);
    expect(recordsOn(tablet).map((record) => record.id)).toContain(recordId);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("writes a Recipe over its record that came to carry another item's id as it was moved away and back", async () => {
    const lab = await api.createLocation("Foreign slot lab", "America/Chicago");
    const machine = await api.createMachine("Foreign slot lab 1", lab.id);
    const held = new Set<string>();
    const tablet = load(machine, 45091, server, (frame) => held.has(String((frame as { type?: unknown }).type)));
    await api.waitForOnline(machine);

    // Written in slot 1, its answer held; meanwhile its record comes to carry another item's id, as a restored backup's might.
    held.add("written");
    const two = await create(lab, 1, { name: "Foreign Two" });
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    const recordId = slotOn(tablet, 1)!.id;
    const foreign = "00000000-0000-4000-8000-000000000143";
    const list = recordsOn(tablet).map((record) => (record.id === recordId ? { ...record, [GLOBAL_ID_KEY]: foreign } : record));
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);

    // Moved to the next free slot, and back before the writer looks again: its record is written in slot 1 again, carrying
    // its own id.
    expect((await move(two.id, "next")).slot).toBe(2);
    held.delete("written");
    tablet.resumeUpload();
    expect((await move(two.id, 1)).slot).toBe(1);
    held.clear();
    tablet.resumeUpload();
    await expect.poll(() => recordsOn(tablet).map((record) => [record.id, record[RECIPE_SLOT_FIELD], record[GLOBAL_ID_KEY]])).toEqual([[recordId, 1, two.id]]);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("writes a Recipe moved away and back again whose record another app lost meanwhile", async () => {
    const lab = await api.createLocation("Lost slot lab", "America/Chicago");
    const machine = await api.createMachine("Lost slot lab 1", lab.id);
    const held = new Set<string>();
    const tablet = load(machine, 45101, server, (frame) => held.has(String((frame as { type?: unknown }).type)));
    await api.waitForOnline(machine);

    // Written in slot 1, its answer held, and moved to the next free slot before the writer looks again.
    held.add("written");
    const two = await create(lab, 1, { name: "Lost Two" });
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    const recordId = slotOn(tablet, 1)!.id;
    expect((await move(two.id, "next")).slot).toBe(2);

    // Another app rewrites the list without it, which the plugin reads at its next poll (every 0.1 s here) and reports
    // once the held answer is through, as its outbox sends one delivery at a time.
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", [])).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    // Decaid's store fails for a moment, so its write in slot 2 is refused; the report forgets its record.
    const restore = tablet.refuseFor("/store/dye2.reaplugin/recipes", new Refusal(500, { error: "Store unavailable" }));
    held.clear();
    tablet.resumeUpload();
    const refusedWrites = async () =>
      (await api.get<{ status: { refused: { change: string }[] } }>(`/machines/${machine.machine.id}/sharing-status`)).status.refused.filter((refused) => refused.change === "write").length;
    await expect.poll(refusedWrites).toBeGreaterThan(0);
    restore();

    // Moved back to slot 1: it is written again, under its record id, the map showing the tablet lacks it.
    expect((await move(two.id, 1)).slot).toBe(1);
    await expect.poll(() => recordsOn(tablet).map((record) => [record.id, record[RECIPE_SLOT_FIELD], record[GLOBAL_ID_KEY]])).toEqual([[recordId, 1, two.id]]);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("keeps an edit saved on a tablet offline of a Recipe a swap moved meanwhile, writing it its new slot, and writes back a move made there over the swap", async () => {
    const lab = await locationWith("Swapped offline lab", 45111, [server, other]);
    const [offline, online] = lab.tablets as [SimulatedTablet, SimulatedTablet];
    const two = await create(lab.location, 2, { name: "Offline Two", dose: 18 });
    const four = await create(lab.location, 4, { name: "Offline Four", dose: 19 });
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["2:Offline Two", "4:Offline Four"]);
    const [twoRecord, fourRecord] = [String(recordOf(offline, two.id)!.id), String(recordOf(offline, four.id)!.id)];

    // Swapped while one tablet is offline, whose DYE2 editor then saves a new dose for the recipe it still holds in slot 2,
    // and gives the one it holds in slot 4 tab 5.
    offline.loseNetwork();
    expect((await move(two.id, 4)).slot).toBe(4);
    await expect.poll(() => slotsOn(online)).toEqual(["4:Offline Two", "2:Offline Four"]);
    await (await openDye2RecipeEditor(offline, { id: twoRecord })).set({ dose: 21 }).save();
    await (await openDye2RecipeEditor(offline, { id: fourRecord })).tapSlot(5).save();
    expect(slotsOn(offline)).toEqual(["2:Offline Two", "5:Offline Four"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    offline.restoreNetwork();

    // The dose is the moved Recipe's, written to it in its new slot on every tablet. The other Recipe had left slot 4 before
    // the tablet moved it from there, so it stays in slot 2, written back there.
    await expect.poll(async () => (await recipe(two.id)).content.dose).toBe(21);
    expect((await recipe(four.id)).content.dose).toBe(19);
    for (const tablet of lab.tablets) {
      await expect.poll(() => slotsOn(tablet)).toEqual(["4:Offline Two", "2:Offline Four"]);
      await expect.poll(() => (slotOn(tablet, 4)?.dashboardVariables as Record_ | undefined)?.dose).toBe(21);
      expect((slotOn(tablet, 2)?.dashboardVariables as Record_ | undefined)?.dose).toBe(19);
    }
    expect((await recipesAt(lab.location)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["Offline Four", 2],
      ["Offline Two", 4],
    ]);
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${two.id}/conflicts`)).conflicts).toEqual([]);
  });

  it("keeps an edit a tablet has not reported yet when its Recipe is moved, or its Basket hidden, before the plugin reads its lists again", async () => {
    const lab = await api.createLocation("Unreported lab", "America/Chicago");
    const machine = await api.createMachine("Unreported lab 1", lab.id);
    // Reads its lists every 10 minutes (12 s here), so a change made on it waits to be reported.
    const tablet = load(machine, 45121, server, undefined, 600);
    await api.waitForOnline(machine);
    const two = await create(lab, 2, { name: "Unreported Two", dose: 18 });
    const basket = (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: lab.id, content: { name: "Unreported 20g", notes: "v1" } }, 201)).basket;
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Unreported Two"]);
    await expect.poll(() => (dye2List(tablet, "baskets") as Record_[]).find((record) => record[GLOBAL_ID_KEY] === basket.id)?.notes).toBe("v1");

    // A barista saves a new dose, then Staff move the Recipe before the plugin has read it: its record is written its new
    // slot alone, and the dose it holds taken in.
    const recipes = recordsOn(tablet).map((record) =>
      record[GLOBAL_ID_KEY] === two.id ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 21 } } : record,
    );
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", recipes)).status).toBe(200);
    expect((await move(two.id, 4)).slot).toBe(4);
    await expect.poll(async () => (await recipe(two.id)).content.dose).toBe(21);
    await expect.poll(() => slotsOn(tablet)).toEqual(["4:Unreported Two"]);
    expect((slotOn(tablet, 4)!.dashboardVariables as Record_).dose).toBe(21);

    // The same for a Basket's notes changed just before it is hidden at the Location.
    const baskets = (dye2List(tablet, "baskets") as Record_[]).map((record) => (record[GLOBAL_ID_KEY] === basket.id ? { ...record, notes: "v2 on the tablet" } : record));
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/baskets", baskets)).status).toBe(200);
    expect((await api.call("PUT", `/baskets/${basket.id}/locations/${lab.id}`, { shown: false })).status).toBe(200);
    await expect.poll(async () => (await api.get<{ basket: { content: Record_ } }>(`/baskets/${basket.id}`)).basket.content.notes).toBe("v2 on the tablet");
    await expect.poll(() => (dye2List(tablet, "baskets") as Record_[]).some((record) => record[GLOBAL_ID_KEY] === basket.id)).toBe(false);
  });

  it("keeps an edit a tablet has not reported yet on its Recipe, not on another Recipe Staff put in its slot since", async () => {
    const lab = await api.createLocation("Replaced slot lab", "America/Chicago");
    const machine = await api.createMachine("Replaced slot lab 1", lab.id);
    // Reads its lists every 10 minutes (12 s here), so a change made on it waits to be reported.
    const tablet = load(machine, 45131, server, undefined, 600);
    await api.waitForOnline(machine);
    const old = await create(lab, 2, { name: "Old Espresso", dose: 18 });
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Old Espresso"]);

    // A barista saves a new dose for the recipe in slot 2, then Staff create another Recipe there, which leaves it unslotted.
    const recipes = recordsOn(tablet).map((record) =>
      record[RECIPE_SLOT_FIELD] === 2 ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 21 } } : record,
    );
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", recipes)).status).toBe(200);
    const fresh = await create(lab, 2, { name: "New Filter", dose: 15 });
    expect((await recipe(old.id)).slot).toBeNull();

    // The dose is the edited Recipe's, kept in no slot; the new one keeps what Staff entered, with no Conflict, and holds slot
    // 2 on the tablet under a record of its own.
    await expect.poll(async () => (await recipe(old.id)).content.dose).toBe(21);
    await expect.poll(() => slotsOn(tablet)).toEqual(["-:Old Espresso", "2:New Filter"]);
    expect(await recipe(fresh.id)).toMatchObject({ name: "New Filter", slot: 2, content: { dose: 15 } });
    expect((slotOn(tablet, 2)!.dashboardVariables as Record_).dose).toBe(15);
    expect((recordOf(tablet, old.id)!.dashboardVariables as Record_).dose).toBe(21);
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${fresh.id}/conflicts`)).conflicts).toEqual([]);
    expect((await recipesAt(lab)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["New Filter", 2],
      ["Old Espresso", null],
    ]);
  });

  it("Archives a Recipe, which leaves its slot, the tablets and every Workflow naming it, restores it unslotted under its record id, and refuses to slot it while Archived", async () => {
    const lab = await locationWith("Archived recipe lab", 45041, [server, other], { dye2: true });
    const created = await create(lab.location, 3, { name: "Archived Espresso", dose: 18, yield: 36 });
    const kept = await create(lab.location, 1, { name: "Archived Neighbour", dose: 19, yield: 40 });
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet).sort()).toEqual(["1:Archived Neighbour", "3:Archived Espresso"]);
    const recordId = String(recordOf(lab.tablets[0]!, created.id)!.id);
    // Both Machines load it from DYE2's Select Recipe page.
    for (const [index, tablet] of lab.tablets.entries()) {
      tablet.connectMachine();
      await selectRecipeInDye2(tablet, recordId);
      await expect.poll(() => loadedOn(lab.machines[index]!)).toBe(created.id);
    }

    const archived = await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${created.id}/archived`, { archived: true });
    expect(archived.recipe).toMatchObject({ archived: true, slot: null });
    // Its record leaves every tablet, and each Workflow naming it names none, so neither Machine has it loaded.
    for (const [index, tablet] of lab.tablets.entries()) {
      await expect.poll(() => slotsOn(tablet)).toEqual(["1:Archived Neighbour"]);
      await expect.poll(() => recipeIdInWorkflow(tablet)).toBeNull();
      await expect.poll(() => loadedOn(lab.machines[index]!)).toBeNull();
    }
    expect((await api.call("PUT", `/recipes/${created.id}/slot`, { slot: 3 })).status).toBe(409);

    const restored = await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${created.id}/archived`, { archived: false });
    expect(restored.recipe).toMatchObject({ archived: false, slot: null });
    expect((await versions(created.id)).slice(0, 3).map((version) => version.fields)).toEqual([{ archived: false }, { archived: true }, { slot: null }]);
    // It is written back to every tablet, in no slot, under the record id it had, and loaded nowhere until applied again.
    for (const tablet of lab.tablets) {
      await expect.poll(() => recordOf(tablet, created.id)).toMatchObject({ id: recordId, [RECIPE_SLOT_FIELD]: null, name: "Archived Espresso" });
    }
    for (const machine of lab.machines) expect(await loadedOn(machine)).toBeNull();
    expect((await move(created.id, 3)).slot).toBe(3);
    for (const tablet of lab.tablets) await expect.poll(() => slotOn(tablet, 3)?.[GLOBAL_ID_KEY]).toBe(created.id);
    expect((await recipe(kept.id)).slot).toBe(1);
  });

  it("flags a Recipe not Archived, in a slot or not, whose Bean Batch is finished at its Location", async () => {
    const lab = await api.createLocation("Finished batch lab", "America/Chicago");
    const { batch } = await library("Finished", lab, [lab]);
    const created = await create(lab, 1, { name: "Finished Espresso", beanBatchId: batch.id });
    expect(created.batchFinished).toBe(false);
    expect((await api.call("PUT", `/bean-batches/${batch.id}/locations/${lab.id}`, { atLocation: false })).status).toBe(200);
    expect(await recipe(created.id)).toMatchObject({ batchFinished: true, uses: { beanBatch: { id: batch.id, atLocation: false } } });
    // An unslotted Recipe is on every tablet at its Location all the same, so flagged; an Archived one is not.
    expect((await move(created.id, null)).batchFinished).toBe(true);
    expect((await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${created.id}/archived`, { archived: true })).recipe.batchFinished).toBe(false);
  });

  it("refuses items a Recipe cannot use at its Location", async () => {
    const lab = await api.createLocation("Refused recipe lab", "America/Chicago");
    const cafe = await api.createLocation("Refused recipe cafe", "America/Chicago");
    const { batch, grinder } = await library("Refused", cafe, [cafe]);
    const refusal = async (content: Record_) => (await api.call("POST", "/recipes", { locationId: lab.id, slot: 1, content })).status;
    // Another Location's Grinder.
    expect(await refusal({ grinderId: grinder.id })).toBe(409);
    // An Archived batch, Basket or Tool.
    expect((await api.call("PUT", `/bean-batches/${batch.id}/archived`, { archived: true })).status).toBe(200);
    expect(await refusal({ beanBatchId: batch.id })).toBe(409);
    // Items the Library does not have, and values DYE2 would not take.
    expect(await refusal({ basketId: "00000000-0000-4000-8000-000000000000" })).toBe(400);
    expect(await refusal({ profileId: "profile:none" })).toBe(400);
    expect(await refusal({ hotWaterMode: "temp" })).toBe(400);
    expect(await refusal({ steamMode: "time" })).toBe(400);
    expect(await refusal({ dose: -1 })).toBe(400);
    // A slot that is none of the five buttons of Streamline's DYE strip.
    for (const slot of [0, 6, 2.5]) expect((await api.call("POST", "/recipes", { locationId: lab.id, slot, content: {} })).status, String(slot)).toBe(400);
    expect(await recipesAt(lab)).toEqual([]);
    const created = await create(lab, 5, { name: "Refused slot" });
    expect((await api.call("PUT", `/recipes/${created.id}/slot`, { slot: 6 })).status).toBe(400);
    expect((await recipe(created.id)).slot).toBe(5);
  });

  /** The steam, hot water and flush settings a Recipe may hold, each with a value in its range. */
  const SETTINGS: Record_ = {
    steamTemperature: 150,
    steamDuration: 40,
    steamFlow: 1.5,
    steamStopTemperature: 65,
    hotWaterTemperature: 80,
    hotWaterDuration: 30,
    hotWaterVolume: 200,
    hotWaterFlow: 6,
    flushTemperature: 90,
    flushDuration: 10,
    flushFlow: 4.5,
  };

  it("holds each steam, hot water and flush setting or none, set and cleared through REST, a new Recipe none", async () => {
    const lab = await api.createLocation("Settings recipe lab", "America/Chicago");
    const created = await create(lab, 1, { name: "Settings Espresso" });
    // DYE2's display modes are kept, but a new Recipe holds none of the settings: each Machine keeps its own.
    expect(created.content).toMatchObject({ steamMode: "flow", hotWaterMode: "vol", showOnDashboard: true });
    for (const field of Object.keys(SETTINGS)) expect(created.content, field).not.toHaveProperty(field);

    expect((await edit(created.id, SETTINGS)).content).toMatchObject(SETTINGS);
    expect((await recipe(created.id)).content).toMatchObject(SETTINGS);
    expect((await versions(created.id))[0]!.fields).toEqual(SETTINGS);

    // 0 is a value: a steam time of 0, and a milk stop of 0, which is off.
    expect((await edit(created.id, { steamDuration: 0, steamStopTemperature: 0, flushDuration: 0 })).content).toMatchObject({
      steamDuration: 0,
      steamStopTemperature: 0,
      flushDuration: 0,
    });

    // Null or empty text clears each, leaving the Machine's own.
    const fields = Object.keys(SETTINGS);
    const cleared = await edit(created.id, Object.fromEntries(fields.map((field, index) => [field, index % 2 === 0 ? null : ""])));
    for (const field of fields) expect(cleared.content, field).not.toHaveProperty(field);
    expect(cleared.content).toMatchObject({ name: "Settings Espresso", steamMode: "flow", hotWaterMode: "vol" });

    // A new Recipe takes the settings it is given.
    expect((await create(lab, 2, { name: "Settings Lungo", ...SETTINGS })).content).toMatchObject(SETTINGS);
  });

  it("refuses a steam, hot water or flush setting outside the range DYE2's editor offers, naming the field and the range", async () => {
    const lab = await api.createLocation("Ranged recipe lab", "America/Chicago");
    const created = await create(lab, 1, { name: "Ranged Espresso", ...SETTINGS });
    const refusal = async (content: Record_) => {
      const response = await api.call("PATCH", `/recipes/${created.id}`, { content });
      return { status: response.status, message: ((await response.json()) as { message?: unknown }).message };
    };
    const refused = (field: string, range: string) => ({ status: 400, message: [`${field} must be ${range}`] });
    // A range with no "Off", and a whole number where Decaid's field is an int.
    expect(await refusal({ steamTemperature: 0 })).toEqual(refused("steamTemperature", "a whole number from 135 to 170"));
    expect(await refusal({ steamTemperature: 171 })).toEqual(refused("steamTemperature", "a whole number from 135 to 170"));
    expect(await refusal({ steamTemperature: 150.5 })).toEqual(refused("steamTemperature", "a whole number from 135 to 170"));
    // 0 or more, whole or not.
    expect(await refusal({ steamDuration: -1 })).toEqual(refused("steamDuration", "a whole number of 0 or more"));
    expect(await refusal({ hotWaterVolume: 200.5 })).toEqual(refused("hotWaterVolume", "a whole number of 0 or more"));
    expect(await refusal({ steamFlow: -0.1 })).toEqual(refused("steamFlow", "a number of 0 or more"));
    // 0 for off, or within the range.
    expect(await refusal({ steamStopTemperature: 20 })).toEqual(refused("steamStopTemperature", "0 (off) or a number from 30 to 80"));
    expect(await refusal({ steamStopTemperature: 81 })).toEqual(refused("steamStopTemperature", "0 (off) or a number from 30 to 80"));
    // A range, whole or not.
    expect(await refusal({ hotWaterDuration: 4 })).toEqual(refused("hotWaterDuration", "a whole number from 5 to 120"));
    expect(await refusal({ hotWaterFlow: 0.4 })).toEqual(refused("hotWaterFlow", "a number from 0.5 to 8"));
    expect(await refusal({ flushTemperature: 96 })).toEqual(refused("flushTemperature", "a whole number from 5 to 95"));
    expect(await refusal({ flushFlow: 8.5 })).toEqual(refused("flushFlow", "a number from 1 to 8"));
    // Not a number at all.
    expect(await refusal({ flushDuration: "10" })).toEqual(refused("flushDuration", "a whole number of 0 or more"));
    // DYE2's display modes are not set here.
    expect(await refusal({ hotWaterMode: "temp", steamMode: "time" })).toEqual({
      status: 400,
      message: ["hotWaterMode is not a field this can set", "steamMode is not a field this can set"],
    });
    expect((await api.call("POST", "/recipes", { locationId: lab.id, slot: 2, content: { flushFlow: 0 } })).status).toBe(400);
    // The edges of each range are taken; nothing refused was kept.
    const edges = { steamTemperature: 135, steamStopTemperature: 80, hotWaterDuration: 120, hotWaterFlow: 0.5, flushTemperature: 5, flushFlow: 8 };
    expect((await edit(created.id, edges)).content).toMatchObject({ ...SETTINGS, ...edges });
    expect(await recipesAt(lab)).toHaveLength(1);
  });

  it("puts one Recipe in a slot when two are created in it at once through two instances, and two created in the next free slot in two", async () => {
    const lab = await api.createLocation("Raced recipe lab", "America/Chicago");
    const viaOther = api.at(other.url);
    const [first, second] = await Promise.all([create(lab, 5, { name: "Raced A" }), create(lab, 5, { name: "Raced B" }, viaOther)]);
    const slots = (await recipesAt(lab)).map((listed) => listed.slot);
    expect(slots).toEqual([5, null]);
    expect([first.id, second.id]).toContain((await recipesAt(lab))[0]!.id);

    await Promise.all([create(lab, "next", { name: "Raced C" }), create(lab, "next", { name: "Raced D" }, viaOther)]);
    expect((await recipesAt(lab)).map((listed) => listed.slot)).toEqual([1, 2, 5, null]);
  });

  it("lets Staff change Recipes only at the Locations they work at", async () => {
    const home = await api.createLocation("Staff recipe home", "America/Chicago");
    const elsewhere = await api.createLocation("Staff recipe elsewhere", "America/Chicago");
    const sam = await api.staffAt("sam.recipes@example.com", home);
    const theirs = await create(home, 1, { name: "Staff Espresso" }, sam);
    expect((await edit(theirs.id, { dose: 18 }, sam)).content.dose).toBe(18);
    expect((await move(theirs.id, 2, sam)).slot).toBe(2);
    expect((await sam.call("PUT", `/recipes/${theirs.id}/archived`, { archived: true })).status).toBe(200);

    const others = await create(elsewhere, 1, { name: "Elsewhere Espresso" });
    expect((await sam.call("POST", "/recipes", { locationId: elsewhere.id, slot: 2, content: { name: "Refused" } })).status).toBe(403);
    expect((await sam.call("PATCH", `/recipes/${others.id}`, { content: { dose: 20 } })).status).toBe(403);
    expect((await sam.call("PUT", `/recipes/${others.id}/slot`, { slot: 3 })).status).toBe(403);
    expect((await sam.call("PUT", `/recipes/${others.id}/archived`, { archived: true })).status).toBe(403);
    expect(await recipe(others.id)).toMatchObject({ slot: 1, archived: false, content: { name: "Elsewhere Espresso" } });
    // Staff still read it.
    expect((await sam.call("GET", `/recipes/${others.id}`)).status).toBe(200);
  });
});

describe("The migration giving Recipes record ids", () => {
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");
  const migration = (name: string) => fs.readFileSync(path.join(migrations, name, "migration.sql"), "utf8");

  it("keeps each Recipe's slot number as its record id, gives one in no slot a new one, and takes those above slot 5 out of their slots", async () => {
    // A scratch database migrated to the init migration, holding Recipes as they were, then the migration applied.
    const admin = new pg.Client({ connectionString: adminDatabaseUrl() });
    const database = testDatabaseName();
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(adminDatabaseUrl());
    url.pathname = `/${database}`;
    const client = new pg.Client({ connectionString: url.toString() });
    try {
      await client.connect();
      await client.query(migration("20261016000000_init"));
      const location = "00000000-0000-4000-8000-000000045201";
      await client.query(`INSERT INTO locations (id, name, time_zone, updated_at) VALUES ($1, 'Migrated lab', 'America/Chicago', now())`, [location]);
      const recipes: [string, number | null, boolean][] = [
        ["00000000-0000-4000-8000-000000045211", 1, false],
        ["00000000-0000-4000-8000-000000045213", 5, false],
        ["00000000-0000-4000-8000-000000045217", 7, false],
        ["00000000-0000-4000-8000-000000045219", null, false],
        ["00000000-0000-4000-8000-000000045220", null, true],
      ];
      for (const [id, slot, archived] of recipes) {
        await client.query(`INSERT INTO recipes (id, location_id, slot, content, archived) VALUES ($1, $2, $3, '{}', $4)`, [id, location, slot, archived]);
      }
      await client.query(migration("20261024000000_recipe_record_ids"));

      const rows = (await client.query<{ id: string; slot: number | null; recordId: string }>(`SELECT id::text, slot, record_id AS "recordId" FROM recipes ORDER BY id`)).rows;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(rows.map((row) => [row.id.slice(-2), row.slot, uuid.test(row.recordId) ? "uuid" : row.recordId])).toEqual([
        ["11", 1, "1"],
        ["13", 5, "5"],
        // Out of slot 7, kept at the Location under the id its records have on the tablets.
        ["17", null, "7"],
        ["19", null, "uuid"],
        ["20", null, "uuid"],
      ]);
      expect(new Set(rows.map((row) => row.recordId)).size).toBe(rows.length);
      // No Recipe can be put in a slot above 5 from now on.
      await expect(client.query(`UPDATE recipes SET slot = 6 WHERE id = $1`, [recipes[3]![0]])).rejects.toThrow(/recipes_slot_check/);
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  });
});
