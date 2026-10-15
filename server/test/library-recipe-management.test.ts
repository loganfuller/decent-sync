import { GLOBAL_ID_KEY, RECIPE_FIELD, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { dye2List } from "./support/simulated-dye2.js";
import { Refusal, type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #143: Recipes created, edited, moved
// between Recipe Slots, taken out of them, Archived and restored in the
// management interface reach the DYE2 recipes of the tablets at their
// Location, through the built plugin in simulated tablets, on two server
// instances sharing PostgreSQL. What a Recipe uses is offered at its
// Location as it is set. Serials are made up, from 45001.

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

  /** The built plugin on a tablet of the Machine, polling every 5 s (0.1 s here), its Library and DYE2's lists empty. */
  function load(machine: CreatedMachine, serial: number, instance: TestServer, stallUpload?: (frame: unknown) => boolean, pollSeconds = 5): SimulatedTablet {
    return syncingTablet(machine, instance, { api: emptyLibrary(serial), stallUpload, pollSeconds });
  }

  /** A Location with a Machine whose tablet is online through each instance given. */
  async function locationWith(name: string, serial: number, instances: TestServer[]): Promise<{ location: LocationView; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    for (const [index, instance] of instances.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      loaded.push(load(machine, serial + index, instance));
      await api.waitForOnline(machine);
    }
    return { location, tablets: loaded };
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

  /** The tablet's recipe in a slot, if it holds one there. */
  const slotOn = (tablet: SimulatedTablet, slot: number): Record_ | undefined => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]).find((record) => record.id === String(slot)) : undefined;
  };
  /** The slots the tablet's recipes are in, in its list's order. */
  const slotsOn = (tablet: SimulatedTablet) => {
    const list = dye2List(tablet, "recipes");
    return Array.isArray(list) ? (list as Record_[]).map((record) => `${String(record.id)}:${String(record.name)}`) : [];
  };
  /** The tablet's own id for its record of a Library item, by the global id the record carries. */
  const localId = (records: Record_[], id: string) => records.find((record) => globalIdOf(record) === id || record[GLOBAL_ID_KEY] === id)?.id;
  /** Whether the server has acknowledged the tablet's answer to a write of the item, so the writer awaits it no more. */
  const answered = (tablet: SimulatedTablet, id: string) =>
    tablet.acknowledgedSome((frame: { type?: unknown; globalId?: unknown }) => frame.type === "written" && frame.globalId === id);


  it("creates a Recipe in slot 6 using items not offered at its Location, offers them there, and writes it to that Location's tablets only", async () => {
    const lab = await locationWith("Created recipe lab", 45001, [server, other]);
    const cafe = await locationWith("Created recipe cafe", 45003, [server]);
    // A batch at the cafe only, a Profile saved on the cafe's tablet, shown there only, and a Basket and Tool shown at the cafe only.
    const { bean, batch, grinder } = await library("Created", lab.location, [cafe.location]);
    const profile = await cafe.tablets[0]!.addProfile(derivedProfile("Created Bloom", 7.25));
    const profileId = String(profile.id);
    await expect.poll(async () => (await api.call("GET", `/profiles/${encodeURIComponent(profileId)}`)).status).toBe(200);
    const basket = (await api.send<{ basket: { id: string } }>("POST", "/baskets", { locationId: cafe.location.id, content: { name: "Created 20g" } }, 201)).basket;
    const tool = (await api.send<{ tool: { id: string } }>("POST", "/tools", { locationId: cafe.location.id, content: { name: "Created WDT", custom: [{ key: "Needles", value: "8" }] } }, 201)).tool;

    const created = await create(lab.location, 6, {
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
      hotWaterMode: "temp",
      hotWaterVolume: 120,
      hotWaterTemperature: 85,
      hotWaterDuration: 30,
      hotWaterFlow: 6,
      showOnDashboard: false,
    });
    expect(created).toMatchObject({
      name: "Created Espresso",
      slot: 6,
      archived: false,
      batchFinished: false,
      content: { beanId: bean.id, beanBatchId: batch.id, steamMode: "flow", hotWaterMode: "temp", showOnDashboard: false },
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

    // Each lab tablet holds it in slot 6, naming what it uses by its own ids; the cafe's holds nothing of it.
    for (const tablet of lab.tablets) {
      await expect.poll(() => slotOn(tablet, 6)?.[GLOBAL_ID_KEY]).toBe(created.id);
      const record = slotOn(tablet, 6)!;
      const baskets = dye2List(tablet, "baskets") as Record_[];
      const tools = dye2List(tablet, "equipment") as Record_[];
      const toolId = String(localId(tools, tool.id));
      expect(record).toMatchObject({
        name: "Created Espresso",
        beverage: "Espresso",
        beanId: localId(tablet.beans(), bean.id),
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
          hotWaterMode: "temp",
          hotWaterTempC: 85,
          grinderId: localId(tablet.grinders(), grinder.id),
          basketId: localId(baskets, basket.id),
          equipmentIds: [toolId],
          equipmentCustom: { [toolId]: [{ key: "Needles", value: "10" }] },
        },
        [RECIPE_FIELD]: {
          beanBatchId: localId(tablet.batches(), batch.id),
          hotWaterData: { targetTemperature: 85, duration: 30, volume: 120, flow: 6 },
        },
      });
    }
    expect(slotsOn(cafe.tablets[0]!)).toEqual([]);

    const history = await versions(created.id);
    expect(history.map((version) => version.fields)).toEqual([{ slot: 6 }, expect.objectContaining({ name: "Created Espresso", dose: 18 })]);
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
      const list = (dye2List(tablet, "recipes") as Record_[]).map((record) => (record.id === "1" ? { ...record, beanId } : record));
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
      const list = (dye2List(tablet, "recipes") as Record_[]).map((record) =>
        record.id === "1" ? { ...record, beanId, dashboardVariables: { ...(record.dashboardVariables as Record_), ratio } } : record,
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
    const list = (dye2List(lab.tablets[0]!, "recipes") as Record_[]).map((record) =>
      record.id === "1" ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), ratio: 2 } } : record,
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

  it("moves a Recipe from slot 2 to slot 4, swapping it with the one there, to the next free slot, and out of its slot, on every tablet", async () => {
    const lab = await locationWith("Moved recipe lab", 45031, [server, other]);
    const two = await create(lab.location, 2, { name: "Moved Two", dose: 18 });
    const four = await create(lab.location, 4, { name: "Moved Four", dose: 19 });
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["2:Moved Two", "4:Moved Four"]);

    expect(await move(two.id, 4)).toMatchObject({ id: two.id, slot: 4 });
    expect((await recipe(four.id)).slot).toBe(2);
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["2:Moved Four", "4:Moved Two"]);
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

    // Taken out of its slot, it is kept at the Location, unslotted, and its slot is emptied on the tablets.
    expect((await move(four.id, null)).slot).toBeNull();
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["1:Moved Two"]);
    expect((await recipesAt(lab.location)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["Moved Two", 1],
      ["Moved Four", null],
    ]);
    // An unslotted Recipe moved into an occupied slot leaves the one there unslotted.
    expect((await move(four.id, 1)).slot).toBe(1);
    expect((await recipe(two.id)).slot).toBeNull();
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["1:Moved Four"]);
  });

  it("writes a Recipe moved to another slot and back again in the slot its record was removed from, however its answers lag", async () => {
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

    // Written in slot 1, its answer held; moved to slot 3, so its record in slot 1 is removed, that answer held in turn.
    held.add("written");
    const two = await create(lab, 1, { name: "Back Two" });
    await expect.poll(() => slotsOn(tablet)).toEqual(["1:Back Two", "2:Back Four"]);
    expect((await move(two.id, "next")).slot).toBe(3);
    held.add("removed");
    held.delete("written");
    tablet.resumeUpload();
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:Back Four"]);

    // Moved back to slot 1 before the writer looks again: it is written there again, with the same fields as before.
    expect((await move(two.id, 1)).slot).toBe(1);
    held.clear();
    tablet.resumeUpload();
    await expect.poll(() => slotsOn(tablet)).toEqual(["1:Back Two", "2:Back Four"]);
    expect(await move(four.id, null)).toMatchObject({ slot: null });
    await expect.poll(() => slotsOn(tablet)).toEqual(["1:Back Two"]);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("writes a Recipe back in a slot whose record turned out to be another item's as it was moved away and back", async () => {
    const lab = await api.createLocation("Foreign slot lab", "America/Chicago");
    const machine = await api.createMachine("Foreign slot lab 1", lab.id);
    const held = new Set<string>();
    const tablet = load(machine, 45091, server, (frame) => held.has(String((frame as { type?: unknown }).type)));
    await api.waitForOnline(machine);

    // Written in slot 1, its answer held; meanwhile the record there comes to carry another item's id, as a restored
    // backup's might.
    held.add("written");
    const two = await create(lab, 1, { name: "Foreign Two" });
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    const foreign = "00000000-0000-4000-8000-000000000143";
    const list = (dye2List(tablet, "recipes") as Record_[]).map((record) => (record.id === "1" ? { ...record, [GLOBAL_ID_KEY]: foreign } : record));
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);

    // Moved to the next free slot: removing its record from slot 1 finds another item's there, an answer held in turn.
    expect((await move(two.id, "next")).slot).toBe(2);
    const refusals = () => tablet.sent.filter((frame) => (frame as { type?: unknown }).type === "writeRefused").length;
    const before = refusals();
    held.add("writeRefused");
    held.delete("written");
    tablet.resumeUpload();
    await expect.poll(refusals).toBeGreaterThan(before);

    // Moved back before the writer looks again: it is written in slot 1 again, over the other item's record.
    expect((await move(two.id, 1)).slot).toBe(1);
    held.clear();
    tablet.resumeUpload();
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("writes a Recipe moved away and back again in a slot whose record another app lost meanwhile", async () => {
    const lab = await api.createLocation("Lost slot lab", "America/Chicago");
    const machine = await api.createMachine("Lost slot lab 1", lab.id);
    const held = new Set<string>();
    const tablet = load(machine, 45101, server, (frame) => held.has(String((frame as { type?: unknown }).type)));
    await api.waitForOnline(machine);

    // Written in slot 1, its answer held, and moved to the next free slot before the writer looks again.
    held.add("written");
    const two = await create(lab, 1, { name: "Lost Two" });
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    expect((await move(two.id, "next")).slot).toBe(2);

    // Another app rewrites the list without it, which the plugin reads at its next poll (every 0.1 s here) and reports
    // once the held answer is through, as its outbox sends one delivery at a time.
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", [])).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    // Decaid's store fails for a moment, so its removal from slot 1 and its write in slot 2 are refused; the report
    // forgets its record in slot 1.
    const restore = tablet.refuseFor("/store/dye2.reaplugin/recipes", new Refusal(500, { error: "Store unavailable" }));
    const refusals = () => tablet.sent.filter((frame) => (frame as { type?: unknown }).type === "writeRefused").length;
    held.clear();
    tablet.resumeUpload();
    await expect.poll(refusals).toBeGreaterThanOrEqual(1);
    // Its write in slot 2 refused too, once the report forgot its record in slot 1.
    const refusedWrites = async () =>
      (await api.get<{ status: { refused: { change: string }[] } }>(`/machines/${machine.machine.id}/sharing-status`)).status.refused.filter((refused) => refused.change === "write").length;
    await expect.poll(refusedWrites).toBeGreaterThan(0);
    restore();

    // Moved back to slot 1: it is written there again, the map showing the tablet lacks it.
    expect((await move(two.id, 1)).slot).toBe(1);
    await expect.poll(() => slotOn(tablet, 1)?.[GLOBAL_ID_KEY]).toBe(two.id);
    expect(server.output()).not.toMatch(/is still due Recipe .* once written/);
  });

  it("keeps an edit saved on a tablet offline in the slot a swap took its Recipe from, and moves the record", async () => {
    const lab = await locationWith("Swapped offline lab", 45111, [server, other]);
    const [offline, online] = lab.tablets as [SimulatedTablet, SimulatedTablet];
    const two = await create(lab.location, 2, { name: "Offline Two", dose: 18 });
    const four = await create(lab.location, 4, { name: "Offline Four", dose: 19 });
    for (const tablet of lab.tablets) await expect.poll(() => slotsOn(tablet)).toEqual(["2:Offline Two", "4:Offline Four"]);

    // Swapped while one tablet is offline, whose barista then saves a new dose for the recipe it still holds in slot 2.
    offline.loseNetwork();
    expect((await move(two.id, 4)).slot).toBe(4);
    await expect.poll(() => slotsOn(online)).toEqual(["2:Offline Four", "4:Offline Two"]);
    const list = (dye2List(offline, "recipes") as Record_[]).map((record) =>
      record.id === "2" ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 21 } } : record,
    );
    expect((await offline.callApi("POST", "/store/dye2.reaplugin/recipes", list)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    offline.restoreNetwork();

    // The dose is the moved Recipe's, written to it in its new slot on every tablet; the other Recipe is untouched.
    await expect.poll(async () => (await recipe(two.id)).content.dose).toBe(21);
    expect((await recipe(four.id)).content.dose).toBe(19);
    for (const tablet of lab.tablets) {
      await expect.poll(() => slotsOn(tablet)).toEqual(["2:Offline Four", "4:Offline Two"]);
      await expect.poll(() => (slotOn(tablet, 4)?.dashboardVariables as Record_ | undefined)?.dose).toBe(21);
      expect((slotOn(tablet, 2)?.dashboardVariables as Record_ | undefined)?.dose).toBe(19);
    }
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

    // A barista saves a new dose, then Staff move the Recipe before the plugin has read it: the removal from slot 2 is
    // refused as the record changed, its list read again, and the dose taken in before it is moved.
    const recipes = (dye2List(tablet, "recipes") as Record_[]).map((record) =>
      record.id === "2" ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 21 } } : record,
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
    const recipes = (dye2List(tablet, "recipes") as Record_[]).map((record) =>
      record.id === "2" ? { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_), dose: 21 } } : record,
    );
    expect((await tablet.callApi("POST", "/store/dye2.reaplugin/recipes", recipes)).status).toBe(200);
    const fresh = await create(lab, 2, { name: "New Filter", dose: 15 });
    expect((await recipe(old.id)).slot).toBeNull();

    // The dose is the edited Recipe's; the new one keeps what Staff entered, with no Conflict, and holds slot 2 on the tablet.
    await expect.poll(async () => (await recipe(old.id)).content.dose).toBe(21);
    await expect.poll(() => slotsOn(tablet)).toEqual(["2:New Filter"]);
    expect(await recipe(fresh.id)).toMatchObject({ name: "New Filter", slot: 2, content: { dose: 15 } });
    expect((slotOn(tablet, 2)!.dashboardVariables as Record_).dose).toBe(15);
    expect((await api.get<{ conflicts: unknown[] }>(`/recipes/${fresh.id}/conflicts`)).conflicts).toEqual([]);
    expect((await recipesAt(lab)).map((listed) => [listed.name, listed.slot])).toEqual([
      ["New Filter", 2],
      ["Old Espresso", null],
    ]);
  });

  it("Archives a Recipe, which leaves its slot, restores it unslotted, and refuses to slot it while Archived", async () => {
    const lab = await locationWith("Archived recipe lab", 45041, [server]);
    const created = await create(lab.location, 3, { name: "Archived Espresso" });
    await expect.poll(() => slotsOn(lab.tablets[0]!)).toEqual(["3:Archived Espresso"]);

    const archived = await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${created.id}/archived`, { archived: true });
    expect(archived.recipe).toMatchObject({ archived: true, slot: null });
    await expect.poll(() => slotsOn(lab.tablets[0]!)).toEqual([]);
    expect((await api.call("PUT", `/recipes/${created.id}/slot`, { slot: 3 })).status).toBe(409);

    const restored = await api.send<{ recipe: RecipeView }>("PUT", `/recipes/${created.id}/archived`, { archived: false });
    expect(restored.recipe).toMatchObject({ archived: false, slot: null });
    expect((await versions(created.id)).slice(0, 3).map((version) => version.fields)).toEqual([{ archived: false }, { archived: true }, { slot: null }]);
    expect((await move(created.id, 3)).slot).toBe(3);
    await expect.poll(() => slotsOn(lab.tablets[0]!)).toEqual(["3:Archived Espresso"]);
  });

  it("flags a slotted Recipe whose Bean Batch is finished at its Location", async () => {
    const lab = await locationWith("Finished batch lab", 45051, [server]);
    const { batch } = await library("Finished", lab.location, [lab.location]);
    const created = await create(lab.location, 1, { name: "Finished Espresso", beanBatchId: batch.id });
    expect(created.batchFinished).toBe(false);
    expect((await api.call("PUT", `/bean-batches/${batch.id}/locations/${lab.location.id}`, { atLocation: false })).status).toBe(200);
    expect(await recipe(created.id)).toMatchObject({ batchFinished: true, uses: { beanBatch: { id: batch.id, atLocation: false } } });
    // An unslotted Recipe is not flagged.
    expect((await move(created.id, null)).batchFinished).toBe(false);
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
    expect(await refusal({ hotWaterMode: "steam" })).toBe(400);
    expect(await refusal({ steamMode: "time" })).toBe(400);
    expect(await refusal({ dose: -1 })).toBe(400);
    expect((await api.call("POST", "/recipes", { locationId: lab.id, slot: 0, content: {} })).status).toBe(400);
    // A slot beyond what PostgreSQL's integer holds.
    expect((await api.call("POST", "/recipes", { locationId: lab.id, slot: 2_147_483_648, content: {} })).status).toBe(400);
    expect(await recipesAt(lab)).toEqual([]);
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
