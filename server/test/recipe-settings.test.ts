import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import {
  DYE2_NAMESPACE,
  applyInDye2,
  applyInStreamline,
  autoSaveInStreamline,
  dye2Keys,
  dye2Library,
  dye2List,
  dye2Recording,
  saveInDye2,
} from "./support/simulated-dye2.js";
import { type DecaidApi, SimulatedTablet, derivedDe1Pro, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #141: the steam and flush values inside DYE2's recipes
// mirror the steam and rinse settings (ADR-0014, ADR-0005). Every recipe
// written to a tablet carries its Location's steam and flush values, of its
// own steam mode, or its Machine's own while its sharing of them is off, so
// applying one, the DYE2 way or the Streamline way, changes neither the
// Location's settings nor another Machine's Workflow, and one saved blank
// sets no 0. A change of them inside a recipe is an edit of the Location's
// settings, which reaches every Machine and recipe there, but a recipe
// applied from a copy read before the server's latest write of it is no
// edit, and neither is a steam value DYE2's editor carries over as it
// switches a recipe's steam mode. Through the built
// plugin in simulated tablets, acting as DYE2 v0.1.19 and Streamline v0.2.13
// do with the steps recorded from them (fixtures/decaid/dye2-v0.1.19/), on
// two server instances sharing one database, with assertions through the
// REST API and what each simulated tablet holds. Serials are made up, from
// 44001.

type Record_ = Record<string, unknown>;

interface SettingsView {
  id: string | null;
  values: Record<string, number | null>;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The Location's steam and rinse settings each test sets first, apart from every tablet's own. */
const LOCATION = { "steamSettings.duration": 33, "steamSettings.flow": 1.7, "rinseData.duration": 6 };

describe("Steam and flush inside recipes mirror the shared settings", { timeout: 90_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /** A DE1Pro's Decaid with an empty library, and DYE2's keys never written. */
  function emptyDecaid(serial: string): DecaidApi {
    const decaidApi: DecaidApi = { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };
    for (const key of ["recipes", "baskets", "equipment"] as const) delete decaidApi[`/store/${DYE2_NAMESPACE}/${key}`];
    return decaidApi;
  }

  /** The recording's tablet, its Workflow included, with DYE2's baskets and tools but no recipes; its beans named as the test's own. */
  function recordedDecaid(serial: string, scenario: string): DecaidApi {
    const library = dye2Library();
    const keys = dye2Keys();
    return {
      ...emptyDecaid(serial),
      ...library,
      "/beans": (library["/beans"] as Record_[]).map((bean) => ({ ...bean, name: `${scenario} ${String(bean.name)}` })),
      [`/store/${DYE2_NAMESPACE}/baskets`]: keys.baskets,
      [`/store/${DYE2_NAMESPACE}/equipment`]: keys.equipment,
    };
  }

  function load(machine: CreatedMachine, decaidApi: DecaidApi, instance: TestServer = server): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: 5 },
      api: decaidApi,
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  const settingsAt = async (location: LocationView) => (await api.get<{ settings: SettingsView }>(`/locations/${location.id}/settings`)).settings;
  const versions = async (settings: SettingsView) =>
    (await api.get<{ versions: { fields: Record_; source: { machine: { name: string } | null } }[] }>(`/location-settings/${settings.id}/history`))
      .versions;
  const conflicts = async (settings: SettingsView) =>
    (await api.get<{ conflicts: { item: { id: string } }[] }>("/conflicts")).conflicts.filter((conflict) => conflict.item.id === settings.id);
  /** The tablet's Workflow's settings, by their names, such as `steamSettings.flow`. */
  const held = (tablet: SimulatedTablet, fields: readonly string[] = Object.keys(LOCATION)) =>
    Object.fromEntries(
      fields.map((field) => {
        const [part, name] = field.split(".") as [string, string];
        return [field, (tablet.workflow()[part] as Record_)[name]];
      }),
    );
  /** Resolves once the tablet's Workflow holds those settings. */
  const holds = (tablet: SimulatedTablet, values: Record<string, number>) => expect.poll(() => held(tablet, Object.keys(values)), { timeout: 15_000 }).toEqual(values);
  const inSlot = (tablet: SimulatedTablet, slot: string) => (Array.isArray(dye2List(tablet, "recipes")) ? (dye2List(tablet, "recipes") as Record_[]) : []).find((record) => record.id === slot);
  /** The `dashboardVariables` of the tablet's recipe in that slot. */
  const variables = (tablet: SimulatedTablet, slot: string) => (inSlot(tablet, slot)?.dashboardVariables ?? {}) as Record_;
  /** The steam mode and the steam and flush values of the tablet's recipe in that slot; a value it holds none of is undefined. */
  const mirrored = (tablet: SimulatedTablet, slot: string) => {
    const { steamMode, steamTimeS, steamFlowMls, flushS } = variables(tablet, slot);
    return { steamMode, steamTimeS, steamFlowMls, flushS };
  };
  /** Resolves once the latest Workflow of the Machine's the server stored has that dose. */
  const dosed = ({ machine }: CreatedMachine, dose: number) =>
    expect
      .poll(
        async () => {
          const { events } = (await (await api.call("GET", `/machines/${machine.id}/workflow-events?limit=1`)).json()) as { events: { workflow: { context?: Record_ } }[] };
          return events[0]?.workflow.context?.targetDoseWeight;
        },
        { timeout: 15_000 },
      )
      .toBe(dose);

  /** Saves the tablet's recipe in that slot as DYE2's editor saves one opened on it: every field as it holds it, with `changes` made by their paths. */
  const editInDye2 = async (tablet: SimulatedTablet, slot: string, changes: Record_) => {
    const list = (await tablet.callApi("GET", `/store/${DYE2_NAMESPACE}/recipes`)).body as Record_[];
    const edited = list.map((record) => {
      if (record.id !== slot) return record;
      const next: Record_ = { ...record, dashboardVariables: { ...(record.dashboardVariables as Record_) }, capturedAt: new Date().toISOString() };
      for (const [path, value] of Object.entries(changes)) {
        if (path.startsWith("dashboardVariables.")) (next.dashboardVariables as Record_)[path.slice("dashboardVariables.".length)] = value;
        else next[path] = value;
      }
      return next;
    });
    expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/recipes`, edited)).status).toBe(200);
  };

  /**
   * A Location with two Machines, the first's tablet the recording's, on one
   * instance, the second's empty, on the other, each with steam and rinse
   * settings of its own. Resolves once both hold the Location's (`LOCATION`),
   * set in the management interface.
   */
  async function lab(scenario: string, serials: number) {
    const here = await api.createLocation(`${scenario} lab`, "America/Chicago");
    const machines = [await api.createMachine(`${scenario} lab 1`, here.id), await api.createMachine(`${scenario} lab 2`, here.id)] as const;
    const one = load(machines[0], recordedDecaid(String(serials), scenario));
    const two = load(machines[1], emptyDecaid(String(serials + 1)), other);
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
    await expect.poll(async () => (await settingsAt(here)).id, { timeout: 15_000 }).not.toBeNull();
    const settings = await settingsAt(here);
    expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: LOCATION })).status).toBe(200);
    for (const tablet of [one, two]) await holds(tablet, LOCATION);
    return { here, machines, one, two, settings };
  }

  const recipes = dye2Recording("recipes");
  const streamline = dye2Recording("streamline");

  it("leaves the Location's settings and the other Machine's Workflow as they are when a recipe is applied the DYE2 way and the Streamline way, and steam that is off stays off", async () => {
    const { here, machines, one, two, settings } = await lab("Applied", 44001);
    // Saved with steam by time, 30 s, and a 5 s flush, then with steam by flow, 1.3 ml/s, and a 4 s flush.
    await saveInDye2(one, recipes.saveSlot1);
    await saveInDye2(one, recipes.saveSlot2);
    // Every tablet holds them with the Location's values, of each recipe's steam mode, the saving tablet's own written over.
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "1"), { timeout: 15_000 }).toEqual({ steamMode: "time", steamTimeS: 33, steamFlowMls: undefined, flushS: 6 });
      await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 1.7, flushS: 6 });
    }
    const history = await versions(settings);
    const elsewhere = two.workflow();

    // Applied on the tablet that saved them, Streamline's way, then DYE2's: each dose differs from the Workflow's before.
    expect((await applyInStreamline(one, "2")).status).toBe(200);
    await dosed(machines[0], 19);
    expect((await applyInDye2(one, "1")).status).toBe(200);
    await dosed(machines[0], 18);
    expect(held(one)).toEqual(LOCATION);
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect(await versions(settings)).toHaveLength(history.length);
    expect(two.workflow()).toEqual(elsewhere);

    // With its steam off, applying a recipe sets its steam flow, never its steam temperature: it stays off.
    await one.changeSettings({ steamSettings: { targetTemperature: 0 } });
    expect((await applyInDye2(one, "2")).status).toBe(200);
    await dosed(machines[0], 19);
    expect(held(one, ["steamSettings.targetTemperature", ...Object.keys(LOCATION)])).toEqual({ "steamSettings.targetTemperature": 0, ...LOCATION });
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect((await settingsAt(here)).values["steamSettings.targetTemperature"]).toBeGreaterThanOrEqual(135);
    expect(await versions(settings)).toHaveLength(history.length);
    expect(two.workflow()).toEqual(elsewhere);
  });

  it("writes a recipe saved with blank steam and flush fields back with the Location's values, so applying it sets no 0", async () => {
    const { here, machines, one, two, settings } = await lab("Blank", 44011);
    // DYE2's editor saves the blank fields as 0: a steam flow and a flush of 0.
    await saveInDye2(one, recipes.saveBlankSlot3);
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "3"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 1.7, flushS: 6 });
    }
    // Another recipe, its steam and flush blanked in the editor after the Location's were written into it, is no edit either.
    await saveInDye2(one, recipes.saveSlot1);
    await expect.poll(() => mirrored(one, "1"), { timeout: 15_000 }).toEqual({ steamMode: "time", steamTimeS: 33, steamFlowMls: undefined, flushS: 6 });
    const history = await versions(settings);
    await editInDye2(one, "1", { "dashboardVariables.steamTimeS": 0, "dashboardVariables.flushS": 0 });
    await expect.poll(() => mirrored(one, "1"), { timeout: 15_000 }).toEqual({ steamMode: "time", steamTimeS: 33, steamFlowMls: undefined, flushS: 6 });

    expect((await applyInDye2(one, "3")).status).toBe(200);
    await dosed(machines[0], 0);
    expect(held(one)).toEqual(LOCATION);
    // Applied from the copy DYE2's dashboard read as the editor saved it, before the server wrote the Location's values into
    // it, it sets 0, which is no edit: the Location's are written back.
    expect((await applyInDye2(one, "3", { ...inSlot(one, "3")!, dashboardVariables: { ...variables(one, "3"), steamFlowMls: 0, flushS: 0 } })).status).toBe(200);
    expect(held(one, ["steamSettings.flow", "rinseData.duration"])).toEqual({ "steamSettings.flow": 0, "rinseData.duration": 0 });
    await holds(one, { "steamSettings.flow": 1.7, "rinseData.duration": 6 });
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect(await versions(settings)).toHaveLength(history.length);
    expect(held(two)).toEqual(LOCATION);
  });

  it("rewrites every recipe at the Location when its steam settings change", async () => {
    const { settings, one, two } = await lab("Rewritten", 44021);
    await saveInDye2(one, recipes.saveSlot1);
    await saveInDye2(one, recipes.saveSlot2);
    await expect.poll(() => mirrored(two, "2").steamFlowMls, { timeout: 15_000 }).toBe(1.7);

    expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: { "steamSettings.flow": 2.1, "steamSettings.duration": 40 } })).status).toBe(200);
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 2.1, flushS: 6 });
      await expect.poll(() => mirrored(tablet, "1"), { timeout: 15_000 }).toEqual({ steamMode: "time", steamTimeS: 40, steamFlowMls: undefined, flushS: 6 });
      await holds(tablet, { "steamSettings.flow": 2.1, "steamSettings.duration": 40 });
    }
    // Writing them made no version of the settings but the account's change.
    expect((await versions(settings)).filter((version) => version.source.machine !== null).map((version) => version.fields)).not.toContainEqual(
      expect.objectContaining({ "steamSettings.flow": 2.1 }),
    );
  });

  it("takes a flush time changed inside a recipe on one tablet to the Location's rinse settings, every Machine there and every recipe", async () => {
    const { here, one, two, settings } = await lab("Flushed", 44031);
    await saveInDye2(one, recipes.saveSlot1);
    await saveInDye2(one, recipes.saveSlot2);
    for (const tablet of [one, two]) {
      for (const slot of ["1", "2"]) await expect.poll(() => mirrored(tablet, slot).flushS, { timeout: 15_000 }).toBe(6);
    }

    // Changed in DYE2's editor on the second tablet, on the other instance.
    await editInDye2(two, "1", { "dashboardVariables.flushS": 9 });
    await expect.poll(async () => (await settingsAt(here)).values["rinseData.duration"], { timeout: 15_000 }).toBe(9);
    for (const tablet of [one, two]) {
      await holds(tablet, { "rinseData.duration": 9 });
      for (const slot of ["1", "2"]) await expect.poll(() => mirrored(tablet, slot).flushS, { timeout: 15_000 }).toBe(9);
    }
    expect((await versions(settings))[0]).toMatchObject({ fields: { "rinseData.duration": 9 }, source: { machine: { name: "Flushed lab 2" } } });
    expect(await conflicts(settings)).toEqual([]);

    // Streamline's auto-save of a steam flow change, into the Workflow and the recipe it applied, reaches the Location and
    // every recipe there.
    expect((await applyInStreamline(one, "2")).status).toBe(200);
    expect(await autoSaveInStreamline(one, streamline.autoSaveSteam)).toBeDefined();
    await expect.poll(async () => (await settingsAt(here)).values["steamSettings.flow"], { timeout: 15_000 }).toBe(1.3);
    await holds(two, { "steamSettings.flow": 1.3 });
    await expect.poll(() => mirrored(two, "2").steamFlowMls, { timeout: 15_000 }).toBe(1.3);
  });

  it("writes a Machine's own values into its recipes while its sharing of the settings is off, keeps them as a recipe is applied, and puts back a change made inside one", async () => {
    const { here, machines, one, two, settings } = await lab("Own", 44041);
    await saveInDye2(one, recipes.saveSlot2);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toMatchObject({ steamFlowMls: 1.7, flushS: 6 });
    const switchTwo = (sharesSettings: boolean) => api.call("PUT", `/machines/${machines[1].machine.id}/settings-sharing`, { sharesSettings });

    expect((await switchTwo(false)).status).toBe(200);
    await two.changeSettings({ steamSettings: { flow: 0.9 }, rinseData: { duration: 3 } });
    // Its recipes mirror its own; the other tablet's keep the Location's.
    await expect.poll(() => mirrored(two, "2"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 0.9, flushS: 3 });
    expect(mirrored(one, "2")).toMatchObject({ steamFlowMls: 1.7, flushS: 6 });
    const history = await versions(settings);

    // Applying one keeps its own, and changes nothing at the Location.
    expect((await applyInDye2(two, "2")).status).toBe(200);
    await dosed(machines[1], 19);
    expect(held(two, ["steamSettings.flow", "rinseData.duration"])).toEqual({ "steamSettings.flow": 0.9, "rinseData.duration": 3 });
    // A change inside one is put back to its own, and is no edit of the Location's.
    await editInDye2(two, "2", { "dashboardVariables.flushS": 11 });
    await expect.poll(() => mirrored(two, "2").flushS, { timeout: 15_000 }).toBe(3);
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect(await versions(settings)).toHaveLength(history.length);
    expect(held(one)).toEqual(LOCATION);

    // Its sharing turned back on, its Workflow and recipes take the Location's again.
    expect((await switchTwo(true)).status).toBe(200);
    await holds(two, LOCATION);
    await expect.poll(() => mirrored(two, "2"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 1.7, flushS: 6 });
  });

  it("takes no edit from a recipe applied from a copy read before the Location's settings changed, and writes the Location's back", async () => {
    const { here, one, two, settings } = await lab("Stale", 44051);
    await saveInDye2(one, recipes.saveSlot2);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toMatchObject({ steamFlowMls: 1.7, flushS: 6 });
    // Streamline's strip on the second tablet reads its recipes, and keeps them.
    const copy = structuredClone(inSlot(two, "2")!);

    expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: { "steamSettings.flow": 2.1, "rinseData.duration": 8 } })).status).toBe(200);
    for (const tablet of [one, two]) {
      await holds(tablet, { "steamSettings.flow": 2.1, "rinseData.duration": 8 });
      await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toMatchObject({ steamFlowMls: 2.1, flushS: 8 });
    }
    const history = await versions(settings);

    // Applied from the copy it kept, the recipe sets the old values, which are no edit: the Location's are written back. So
    // does applying it again, as the strip keeps the copy.
    for (let tap = 0; tap < 2; tap++) {
      expect((await applyInStreamline(two, "2", copy)).status).toBe(200);
      expect(held(two, ["steamSettings.flow", "rinseData.duration"])).toEqual({ "steamSettings.flow": 1.7, "rinseData.duration": 6 });
      await holds(two, { "steamSettings.flow": 2.1, "rinseData.duration": 8 });
    }
    expect((await settingsAt(here)).values).toMatchObject({ "steamSettings.flow": 2.1, "rinseData.duration": 8 });
    expect(await versions(settings)).toHaveLength(history.length);
    expect(held(one, ["steamSettings.flow", "rinseData.duration"])).toEqual({ "steamSettings.flow": 2.1, "rinseData.duration": 8 });
  });

  it("writes the Location's back over a setting set on the machine to its value before the recipes were rewritten, until the Location's changes again", async () => {
    const { here, one, two, settings } = await lab("Undone", 44071);
    await saveInDye2(one, recipes.saveSlot1);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "1").flushS, { timeout: 15_000 }).toBe(6);
    // A flush of 9 tried on the first machine reaches the Location and every recipe there.
    await one.changeSettings({ rinseData: { duration: 9 } });
    await expect.poll(async () => (await settingsAt(here)).values["rinseData.duration"], { timeout: 15_000 }).toBe(9);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "1").flushS, { timeout: 15_000 }).toBe(9);

    // Set back to 6, the value its recipe held before, it is taken for a recipe applied from a stale copy each time, and 9
    // is written back.
    for (let attempt = 0; attempt < 2; attempt++) {
      await one.changeSettings({ rinseData: { duration: 6 } });
      await holds(one, { "rinseData.duration": 9 });
      expect((await settingsAt(here)).values["rinseData.duration"]).toBe(9);
    }
    // Once the Location's has changed again, to 7 in the management interface, its recipes held 9 before the latest write,
    // not 6: 6 set on the machine is an edit.
    expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: { "rinseData.duration": 7 } })).status).toBe(200);
    for (const tablet of [one, two]) {
      await holds(tablet, { "rinseData.duration": 7 });
      await expect.poll(() => mirrored(tablet, "1").flushS, { timeout: 15_000 }).toBe(7);
    }
    await one.changeSettings({ rinseData: { duration: 6 } });
    await expect.poll(async () => (await settingsAt(here)).values["rinseData.duration"], { timeout: 15_000 }).toBe(6);
    await holds(two, { "rinseData.duration": 6 });
  });

  it("takes a steam flow a recipe held before its steam mode was switched as an edit once the Location's has changed since", async () => {
    const { here, one, two, settings } = await lab("Switched", 44081);
    await saveInDye2(one, recipes.saveSlot2);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toMatchObject({ steamMode: "flow", steamFlowMls: 1.7 });
    // Switched to steaming by time on the second tablet: every record of it loses its flow of 1.7.
    await editInDye2(two, "2", { "dashboardVariables.steamMode": "time", "dashboardVariables.steamFlowMls": undefined, "dashboardVariables.steamTimeS": 1.7 });
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "2"), { timeout: 15_000 }).toEqual({ steamMode: "time", steamTimeS: 33, steamFlowMls: undefined, flushS: 6 });
    }
    // The Location's flow changes twice, so 1.7 is no longer the value before its current one.
    for (const flow of [2.1, 2.5]) {
      expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: { "steamSettings.flow": flow } })).status).toBe(200);
      for (const tablet of [one, two]) await holds(tablet, { "steamSettings.flow": flow });
    }
    await one.changeSettings({ steamSettings: { flow: 1.7 } });
    await expect.poll(async () => (await settingsAt(here)).values["steamSettings.flow"], { timeout: 15_000 }).toBe(1.7);
    await holds(two, { "steamSettings.flow": 1.7 });
  });

  it("takes no edit from a steam value DYE2's editor carries over as a recipe's steam mode is switched", async () => {
    const { here, one, two, settings } = await lab("Toggled", 44061);
    await saveInDye2(one, recipes.saveSlot1);
    for (const tablet of [one, two]) await expect.poll(() => mirrored(tablet, "1"), { timeout: 15_000 }).toMatchObject({ steamMode: "time", steamTimeS: 33 });
    const history = await versions(settings);

    // The editor shows 33 s; switched to steaming by flow, it keeps 33, now as ml/s, and saves it as the flow.
    await editInDye2(two, "1", { "dashboardVariables.steamMode": "flow", "dashboardVariables.steamTimeS": undefined, "dashboardVariables.steamFlowMls": 33 });
    // The Recipe steams by flow now, at the Location's flow, on every tablet.
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "1"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 1.7, flushS: 6 });
    }
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect(await versions(settings)).toHaveLength(history.length);

    // Switched back to steaming by time on the first tablet, which held it by time before the server's write, the switch is
    // a stale save, and the 1.7 it carries over is still no steam time.
    await editInDye2(one, "1", { "dashboardVariables.steamMode": "time", "dashboardVariables.steamFlowMls": undefined, "dashboardVariables.steamTimeS": 1.7 });
    for (const tablet of [one, two]) {
      await expect.poll(() => mirrored(tablet, "1"), { timeout: 15_000 }).toEqual({ steamMode: "flow", steamTimeS: undefined, steamFlowMls: 1.7, flushS: 6 });
    }
    expect((await settingsAt(here)).values).toMatchObject(LOCATION);
    expect(await versions(settings)).toHaveLength(history.length);
    expect(held(two)).toEqual(LOCATION);
  });
});
