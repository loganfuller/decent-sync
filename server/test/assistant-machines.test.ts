import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets } from "./support/loaded-tablets.js";
import { SimulatedDye2, recordedDye2MainTablet, selectRecipeInDye2 } from "./support/simulated-dye2.js";
import { quiesced } from "./support/quiet.js";
import { runAsSteps } from "./support/steps.js";
import { RawConnection, type SimulatedTablet, derivedWorkflow, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #407 (#405, ADR-0026): Machines read through an assistant, a
// test app on the MCP SDK's client connected as a Connected App, against the
// built server, each tool's result matching what the REST API gives the same
// account for the same Machine. Data comes from simulated tablets: the built
// plugin on a tablet with DYE2 as recorded in fixtures/decaid/dye2-v0.1.26/,
// which loads a Recipe and carries out Settings Edits, and raw frames for
// Workflows and Machine States at chosen times. Serials are made up, from 40701.

type Record_ = Record<string, unknown>;

interface RestMachine {
  id: string;
  name: string;
  model: string | null;
  serial: string | null;
  reported: { firmware: string | null } | null;
  pluginVersion: string | null;
  decaidVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  lastShot: { id: string; pulledAt: string | null } | null;
  machineState: { state: string; substate: string; observedAt: string } | null;
  loadedRecipe: { id: string; recipe: Record_; loadedAt: string; unloadedAt: string | null } | null;
  location: LocationView | null;
  locationHistory: { id: string; location: LocationView; effectiveFrom: string }[];
  sharing: boolean;
  captureOnly: string[];
}

interface Page<T> {
  entries: T[];
  total: number;
  offset: number;
  more: boolean;
}

interface Activity {
  workflowChanges?: Page<{ observedAt: string; receivedAt: string; workflow: Record_ }>;
  loadedRecipes?: Page<{ recipe: Record_; loadedAt: string; unloadedAt: string | null }>;
  machineStates?: Page<{ state: string; substate: string; observedAt: string; receivedAt: string }>;
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The recording's tablet's record ids: the Ethiopia's recipe, in no Recipe Slot, and the Brazil's, in slot 2. */
const ETHIOPIA = "1";
const BRAZIL = "2";

/** A Staff member or Viewer with an assistant connected as them, and their REST API. */
interface Person {
  assistant: Assistant;
  api: AdminApi;
}

/** What list_machines gives of a Machine the REST API returns. */
function listed(machine: RestMachine): Record_ {
  const { id, name, model, location, online, lastSeenAt, machineState, loadedRecipe, captureOnly } = machine;
  return { id, name, model, location, online, lastSeenAt, machineState, loadedRecipe: loadedRecipe && withoutId(loadedRecipe), captureOnly };
}

function withoutId<T extends { id: string }>({ id: _, ...rest }: T): Omit<T, "id"> {
  return rest;
}

/** The value with every lastSeenAt taken out: each heartbeat of an online Machine's plugin moves it, between any two reads. */
function unseen<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, field: unknown) => (key === "lastSeenAt" ? undefined : field)) as T;
}

/** An ISO 8601 time with its offset. */
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

/** The value with each ISO 8601 time as its instant: the REST API gives times in UTC, the tools with the offset of the Location the Machine was at then. */
function instants(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_, field: unknown) => (typeof field === "string" && ISO_TIME.test(field) ? Date.parse(field) : field));
}

/** The offset a time zone had at a moment, as ISO 8601 writes it, such as -06:00, or -05:00 in the summer, in Chicago. */
function offsetIn(timeZone: string, at: string): string {
  const named = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(Date.parse(at)).find((part) => part.type === "timeZoneName")!.value;
  return named.replace(/^GMT/, "") || "+00:00";
}

/** That each time, stamped as the test runs, carries the offset the time zone had then. */
function expectZoned(timeZone: string, ...times: unknown[]): void {
  for (const at of times) {
    expect(typeof at, String(at)).toBe("string");
    expect((at as string).slice(-6), at as string).toBe(offsetIn(timeZone, at as string));
  }
}

const CHICAGO = "America/Chicago";

/** That a tool read an online Machine's lastSeenAt between the REST API's reads of it before and after the call. */
function seenBetween(before: RestMachine, seen: Record_, after: RestMachine): void {
  expect(Date.parse(seen.lastSeenAt as string), seen.name as string).toBeGreaterThanOrEqual(Date.parse(before.lastSeenAt!));
  expect(Date.parse(seen.lastSeenAt as string), seen.name as string).toBeLessThanOrEqual(Date.parse(after.lastSeenAt!));
}

describe("Machines through an assistant", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let bar: CreatedMachine;
  let tablet: SimulatedTablet;
  let ethiopia: string;
  let roaster: CreatedMachine;
  /** A Staff member at the Lab and a Viewer, each with an assistant connected as them. */
  let sam: Person;
  let vic: Person;
  const tablets = new LoadedTablets();

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    lab = await api.createLocation("Lab", "America/Chicago");
  });
  afterAll(async () => {
    await assistant?.close();
    await sam?.assistant.close();
    await vic?.assistant.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  const restMachine = async ({ machine }: CreatedMachine, as = api) => (await as.get<{ machine: RestMachine }>(`/machines/${machine.id}`)).machine;

  /** A Staff member or Viewer with an assistant connected as them, and their REST API. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[] = []): Promise<Person> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    return { assistant: await Assistant.connect(server.url, app, cookie, { allowed: ["read"] }), api: AdminApi.signedInAs(server.url, cookie) };
  }

  it("has the Lab's bar online, idle, its tablet's DYE2 having brought its recipes, and the Ethiopia's applied from DYE2's Select Recipe page, so loaded", async () => {
    bar = await api.createMachine("Lab bar", lab.id);
    tablet = tablets.syncing(bar, server, { api: recordedDye2MainTablet("40701", "assistant"), dye2: new SimulatedDye2() });
    await api.waitForOnline(bar);
    tablet.reportState("idle", "idle");
    await expect.poll(async () => (await restMachine(bar)).machineState, { timeout: 15_000 }).toMatchObject({ state: "idle", substate: "idle" });
    await selectRecipeInDye2(tablet, ETHIOPIA);
    await expect.poll(async () => (await restMachine(bar)).loadedRecipe, { timeout: 15_000 }).not.toBeNull();
    ethiopia = (await restMachine(bar)).loadedRecipe!.recipe.id as string;
    for (const name of ["machineSettings", "presenceSettings", "plugins"]) {
      await expect.poll(() => api.get<{ collection: unknown }>(`/machines/${bar.machine.id}/collections/${name}`), { timeout: 15_000 }).not.toEqual({ collection: null });
    }
    // Nothing left under way, so what the REST API and the assistant read next stays as it is.
    await quiesced(api, { tablets: { tablet }, machines: { machine: bar } });
  });

  it("lists the Machine tools, each only reading", async () => {
    const { tools } = await assistant.client.listTools();
    for (const name of ["list_machines", "get_machine", "get_machine_activity", "list_settings_edits", "list_settings_history"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({ readOnlyHint: true });
    }
  });

  it("lists every Machine as the REST API does: where it is, whether online, its last Machine State, its Loaded Recipe and whether capture-only", async () => {
    const van = await api.createMachine("In the van");
    const unshared = await api.createMachine("Lab spare", lab.id);
    await api.send("PUT", `/machines/${unshared.machine.id}/sharing`, { sharing: false });

    const before = (await api.get<{ machines: RestMachine[] }>("/machines")).machines;
    const { machines } = await assistant.call<{ machines: Record_[] }>("list_machines");
    const rest = (await api.get<{ machines: RestMachine[] }>("/machines")).machines;
    expect(instants(unseen(machines))).toEqual(instants(unseen(rest.map(listed))));
    const byName = (name: string) => machines.find((machine) => machine.name === name);
    seenBetween(before.find((machine) => machine.id === bar.machine.id)!, byName("Lab bar")!, rest.find((machine) => machine.id === bar.machine.id)!);
    const labBar = byName("Lab bar") as Record_ & { machineState: { observedAt: string }; loadedRecipe: { loadedAt: string } };
    expect(labBar).toMatchObject({
      location: { id: lab.id, name: "Lab", timeZone: CHICAGO },
      online: true,
      machineState: { state: "idle", substate: "idle" },
      loadedRecipe: { recipe: { id: ethiopia, archived: false }, unloadedAt: null },
      captureOnly: [],
    });
    // Its times with the Lab's offset then.
    expectZoned(CHICAGO, labBar.lastSeenAt, labBar.machineState.observedAt, labBar.loadedRecipe.loadedAt);
    expect(byName("In the van")).toMatchObject({ id: van.machine.id, location: null, online: false, lastSeenAt: null, machineState: null, loadedRecipe: null, captureOnly: ["noLocation"] });
    expect(byName("Lab spare")).toMatchObject({ captureOnly: ["sharingOff"] });
  });

  it("gives one Machine as the REST API does: its Workflow summarised, Machine Settings, Tablet Settings, Location History, sharing status and tablet versions", async () => {
    const before = await restMachine(bar);
    const result = await assistant.call<Record_ & { machine: Record_ }>("get_machine", { machineId: bar.machine.id });
    const path = `/machines/${bar.machine.id}`;
    const rest = await restMachine(bar);
    seenBetween(before, result.machine, rest);
    const collection = async (name: string) => {
      const { collection } = await api.get<{ collection: Record_ | null }>(`${path}/collections/${name}`);
      return collection && { available: collection.available, reportedAt: collection.reportedAt, receivedAt: collection.receivedAt, value: collection.value, utcOffsetMinutes: collection.utcOffsetMinutes };
    };
    const { workflow } = await api.get<{ workflow: Record_ }>(`${path}/workflow-summary`);
    const { status } = await api.get<{ status: Record_ & { refused: Record_[] } }>(`${path}/sharing-status`);
    expect(instants(unseen(result))).toEqual(instants({
      machine: {
        ...unseen(listed(rest)),
        serial: rest.serial,
        firmware: rest.reported?.firmware ?? null,
        pluginVersion: rest.pluginVersion,
        decaidVersion: rest.decaidVersion,
        locationHistory: rest.locationHistory.map(({ location, effectiveFrom }) => ({ location, effectiveFrom })),
        sharing: rest.sharing,
        lastShot: rest.lastShot,
      },
      workflow: withoutId(workflow as Record_ & { id: string }),
      machineSettings: {
        machineSettings: await collection("machineSettings"),
        advancedSettings: await collection("advancedSettings"),
        machineCalibration: await collection("machineCalibration"),
        sensorCalibration: await collection("sensorCalibration"),
      },
      tabletSettings: { appSettings: await collection("appSettings"), presenceSettings: await collection("presenceSettings") },
      sharingStatus: { waiting: status.waiting, lastApplied: status.lastApplied, refused: status.refused, unrecognisedLists: status.unrecognisedLists },
      tabletVersions: (await api.get<{ tabletVersions: unknown }>(`${path}/tablet-versions`)).tabletVersions,
    }));
    const shown = result as Record_ & { machine: { locationHistory: { effectiveFrom: string }[] }; workflow: { observedAt: string; receivedAt: string } };
    expectZoned(CHICAGO, shown.machine.locationHistory[0]!.effectiveFrom, shown.workflow.observedAt, shown.workflow.receivedAt);
    expect(result).toMatchObject({
      machine: { locationHistory: [{ location: { name: "Lab" } }], sharing: true },
      machineSettings: { machineSettings: { available: true, value: { fan: 55 } } },
      tabletSettings: { presenceSettings: { available: true } },
      tabletVersions: { dye2: { status: "installed" } },
    });

    // A Machine moved since: each place it has been, oldest first.
    const van = await api.createMachine("Moved van", lab.id);
    const uptown = await api.createLocation("Uptown", "America/New_York");
    await api.send("POST", `/machines/${van.machine.id}/location-history`, { locationId: uptown.id }, 201);
    const moved = await assistant.call<{ machine: { location: LocationView; locationHistory: { location: LocationView; effectiveFrom: string }[] }; workflow: unknown }>("get_machine", {
      machineId: van.machine.id,
    });
    expect(moved.machine.location).toEqual(uptown);
    // Each arrival with the offset of where it arrived: Chicago's, then New York's.
    expect(moved.machine.locationHistory.map((entry) => entry.location.name)).toEqual(["Lab", "Uptown"]);
    expectZoned(CHICAGO, moved.machine.locationHistory[0]!.effectiveFrom);
    expectZoned("America/New_York", moved.machine.locationHistory[1]!.effectiveFrom);
    expect(moved.workflow).toBeNull();
    expect(await api.get(`/machines/${van.machine.id}/workflow-summary`)).toEqual({ workflow: null });
  });

  it("gives its Workflow summarised with the Library's ids of the Profile, Bean Batch, Grinder, Basket and Recipe it names, which get_library_item finds, and whole only with raw", async () => {
    const path = `/machines/${bar.machine.id}`;
    const current = (await assistant.call<{ workflow: { workflow: Record_ } }>("get_machine", { machineId: bar.machine.id })).workflow;
    expect(current).not.toHaveProperty("raw");
    const summary = current.workflow;
    expect(summary.recipeId).toBe(ethiopia);
    const ids = { profile: summary.profileId, beanBatch: summary.beanBatchId, grinder: summary.grinderId, basket: summary.basketId, recipe: summary.recipeId };
    for (const [kind, id] of Object.entries(ids)) {
      expect(id, kind).toEqual(expect.any(String));
      expect((await assistant.call<Record<string, { id: string }>>("get_library_item", { kind, id }))[kind]!.id, kind).toBe(id);
    }
    // The Recipe by the Library's name, which the Workflow doesn't record; the rest by the names the Workflow recorded.
    expect(summary.recipe).toBe((await assistant.call<{ recipe: { name: string } }>("get_library_item", { kind: "recipe", id: ethiopia })).recipe.name);
    const sent = (await api.get<{ workflow: { workflow: Record_ & { context: Record_ & { extras: Record_ }; profile: Record_ } } }>(`${path}/workflow`)).workflow.workflow;
    expect(summary).toMatchObject({ profile: sent.profile.title, bean: sent.context.coffeeName, grinder: sent.context.grinderModel, basket: sent.context.extras.basketName });

    // With raw, Decaid's Workflow too, as sent, as the REST API's route for it gives it, whose shape is as it was.
    const whole = (await assistant.call<{ workflow: { workflow: Record_; raw: Record_ } }>("get_machine", { machineId: bar.machine.id, raw: true })).workflow;
    expect(whole.workflow).toEqual(summary);
    expect(whole.raw).toEqual(sent);
    expect(Object.keys((await api.get<{ workflow: Record_ }>(`${path}/workflow`)).workflow).sort()).toEqual(["id", "observedAt", "receivedAt", "workflow"]);

    // Its activity gives the same summary of it, but finds only its Profile, as which tablet reported a change isn't recorded.
    const changes = (await assistant.call<Activity>("get_machine_activity", { machineId: bar.machine.id, kinds: ["workflowChanges"], limit: 1 })).workflowChanges!;
    expect(changes.entries[0]!.workflow).toEqual({ ...summary, beanBatchId: null, grinderId: null, basketId: null, recipe: null, recipeId: null });
  });

  it("refuses a Machine that doesn't exist, as the REST API does", async () => {
    for (const machineId of [randomUUID(), "not an id"]) {
      for (const [name, args] of [
        ["get_machine", { machineId }],
        ["get_machine_activity", { machineId }],
        ["list_settings_edits", { machineId }],
        ["list_settings_history", { machineId }],
      ] as const) {
        const result = await assistant.client.callTool({ name, arguments: args });
        expect(result, name).toMatchObject({ isError: true, content: [{ type: "text", text: "No such Machine" }] });
      }
    }
  });

  describe("a Machine's activity over a time range", () => {
    // Monday 2 November 2026 in Chicago (UTC-6): asleep at 6, a Workflow at 6:30, awake at 7, another Workflow at 8, a
    // Shot at 9, a third Workflow at 10, idle again at 11 and asleep at 11 at night, which is 3 November in UTC. Its
    // Workflow before, on 30 October, was from before it was at the Lab, which it was from 1 November.
    const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 2, hour + 6, minute)).toISOString();
    const chicago = (hour: number, minute = 0) => `2026-11-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-06:00`;
    /** As the tool gives a time on 2 November: with the Lab's offset, to the millisecond. */
    const local = (hour: number, minute = 0) => `2026-11-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000-06:00`;
    const BEFORE_THE_LAB = "2026-10-30T12:00:00.000Z";
    const STATES = [
      ["sleeping", "noState", at(6)],
      ["idle", "idle", at(7)],
      ["espresso", "pouring", at(9)],
      ["idle", "idle", at(11)],
      ["sleeping", "noState", at(23)],
    ] as const;
    const DOSES = [
      [17, BEFORE_THE_LAB],
      [18, at(6, 30)],
      [18.5, at(8)],
      [19, at(10)],
    ] as const;
    /** The fixture's Workflow with the changes given to its context, naming recipe 7 as DYE2 named one saved before v0.1.25: by a number. */
    const namingRecipe7 = (context: Record_): Record_ => {
      const workflow = derivedWorkflow(context) as Record_ & { context: Record_ & { extras: Record_ } };
      return { ...workflow, context: { ...workflow.context, extras: { ...workflow.context.extras, dye: { recipeId: 7 } } } };
    };

    beforeAll(async () => {
      // Its records sent as raw frames at those times, from a tablet at no Location then, which took no part in the
      // Library; then an Admin records that it has been at the Lab since 1 November.
      roaster = await api.createMachine("Roastery");
      const raw = await RawConnection.welcomed(server.url, helloWith(roaster.token));
      try {
        const deliveries = [
          ...STATES.map(([state, substate, observedAt]) => ({ type: "machineState", id: randomUUID(), observedAt, state, substate })),
          ...DOSES.map(([dose, observedAt]) => ({ type: "workflow", id: randomUUID(), observedAt, workflow: namingRecipe7({ targetDoseWeight: dose }) })),
        ].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        for (const delivery of deliveries) await raw.deliver(delivery);
      } finally {
        await raw.close();
      }
      await api.send("POST", `/machines/${roaster.machine.id}/location-history`, { locationId: lab.id, effectiveFrom: "2026-11-01T00:00:00.000Z" }, 201);
    });

    const activity = (args: Record_) => assistant.call<Activity>("get_machine_activity", { machineId: roaster.machine.id, ...args });
    const refusal = async (args: Record_) => assistant.client.callTool({ name: "get_machine_activity", arguments: { machineId: roaster.machine.id, ...args } });
    const doses = (result: Activity) => result.workflowChanges!.entries.map((entry) => entry.workflow.dose);
    const states = (result: Activity) => result.machineStates!.entries.map((entry) => entry.state);

    it("gives every Workflow change and Machine State, latest first, as the REST API lists them, with the offset of where it was then, each Workflow as the management interface shows it", async () => {
      const all = await activity({});
      const path = `/machines/${roaster.machine.id}`;
      const workflows = (await api.get<{ events: { observedAt: string; receivedAt: string; workflow: Record_ }[] }>(`${path}/workflow-events`)).events;
      const transitions = (await api.get<{ events: { state: string; substate: string; observedAt: string; receivedAt: string }[] }>(`${path}/machine-state-events`)).events;
      expect(instants(all.machineStates)).toEqual(
        instants({ entries: transitions.map(({ state, substate, observedAt, receivedAt }) => ({ state, substate, observedAt, receivedAt })), total: 5, offset: 0, more: false }),
      );
      expect(instants(all.workflowChanges!.entries.map(({ observedAt, receivedAt }) => ({ observedAt, receivedAt })))).toEqual(
        instants(workflows.map(({ observedAt, receivedAt }) => ({ observedAt, receivedAt }))),
      );
      expect(all.workflowChanges).toMatchObject({ total: 4, offset: 0, more: false });
      expect(all.loadedRecipes).toEqual({ entries: [], total: 0, offset: 0, more: false });
      expect(states(all)).toEqual(["sleeping", "idle", "espresso", "idle", "sleeping"]);
      expect(doses(all)).toEqual([19, 18.5, 18, 17]);
      // With the Lab's offset while it was there, received today too, and UTC's before it was anywhere.
      expect(all.machineStates!.entries.map((entry) => entry.observedAt)).toEqual([local(23), local(11), local(9), local(7), local(6)]);
      expect(all.workflowChanges!.entries.map((entry) => entry.observedAt)).toEqual([local(10), local(8), local(6, 30), BEFORE_THE_LAB]);
      expectZoned(CHICAGO, ...all.machineStates!.entries.map((entry) => entry.receivedAt));

      // As sent, Decaid's numbers and names; as summarized, those the Workflow card shows, to two decimal places, with
      // none of the Library's ids: it has no such Profile, and the records its tablet named never joined it.
      const sent = workflows[0]!.workflow as { profile: Record_ & { steps: Record_[] }; context: Record_; steamSettings: Record_; hotWaterData: Record_; rinseData: Record_ };
      expect(all.workflowChanges!.entries[0]!.workflow).toEqual({
        profile: sent.profile.title,
        profileId: null,
        brewTemperature: sent.profile.steps[0]!.temperature,
        dose: 19,
        yield: sent.context.targetYield,
        bean: sent.context.coffeeName,
        roaster: sent.context.coffeeRoaster,
        beanBatchId: null,
        grinder: sent.context.grinderModel,
        burrs: null,
        grindSetting: sent.context.grinderSetting,
        grinderId: null,
        basket: (sent.context.extras as Record_).basketName,
        basketId: null,
        recipe: null,
        recipeId: null,
        barista: sent.context.baristaName,
        steam: { temperature: sent.steamSettings.targetTemperature, duration: sent.steamSettings.duration, flow: 2.5 },
        hotWater: { temperature: sent.hotWaterData.targetTemperature, volume: sent.hotWaterData.volume },
        flush: { temperature: sent.rinseData.targetTemperature, duration: sent.rinseData.duration },
      });
      expect(sent.steamSettings.flow).not.toBe(2.5);
    });

    it("gives a current Workflow naming records its tablet's map doesn't hold with null ids and the names it recorded, as the REST API does", async () => {
      // Its tablet was at no Location as it reported them, so none joined the Library, the recipe it names by a number,
      // as DYE2 named one saved before v0.1.25, included.
      const { workflow } = await assistant.call<{ workflow: { observedAt: string; receivedAt: string; workflow: Record_ } }>("get_machine", { machineId: roaster.machine.id });
      const sent = namingRecipe7({}) as { context: Record_ & { extras: Record_ & { dye: Record_ } } };
      expect(sent.context.extras.dye.recipeId).toBe(7);
      expect(workflow.workflow).toMatchObject({
        dose: 19,
        bean: sent.context.coffeeName,
        beanBatchId: null,
        grinder: sent.context.grinderModel,
        grinderId: null,
        basket: sent.context.extras.basketName,
        basketId: null,
        recipe: null,
        recipeId: null,
      });
      const rest = await api.get<{ workflow: Record_ & { id: string } }>(`/machines/${roaster.machine.id}/workflow-summary`);
      expect(instants(workflow)).toEqual(instants(withoutId(rest.workflow)));
    });

    it("gives what was in effect at any time in a range given with offsets: what was observed in it, and what was in effect as it began", async () => {
      // 7:30 to 9:30: awake since 7 and a Shot at 9; the 6:30 Workflow until 8, then the 8 o'clock one.
      const morning = await activity({ from: chicago(7, 30), to: chicago(9, 30) });
      expect(states(morning)).toEqual(["espresso", "idle"]);
      expect(doses(morning)).toEqual([18.5, 18]);
      expect(morning.machineStates!.entries.map((entry) => entry.observedAt)).toEqual([local(9), local(7)]);
      expect([morning.machineStates!.total, morning.workflowChanges!.total]).toEqual([2, 2]);
      // The same range in UTC.
      expect(await activity({ from: at(7, 30), to: at(9, 30) })).toEqual(morning);
      // From exactly 8: the Workflow observed then is the one in effect, and the range's end is not in it.
      expect(doses(await activity({ from: chicago(8), to: chicago(10) }))).toEqual([18.5]);
      // Before the first state, none, and only the Workflow from before the Lab; after the last, only what was in effect.
      const early = await activity({ to: chicago(6) });
      expect([states(early), doses(early)]).toEqual([[], [17]]);
      const evening = await activity({ from: chicago(18) });
      expect([states(evening), doses(evening)]).toEqual([["sleeping", "idle"], [19]]);
      // A start not before its end is refused.
      for (const range of [{ from: chicago(9), to: chicago(9) }, { from: chicago(10), to: chicago(9) }, { from: "2026-11-03", to: "2026-11-02" }]) {
        expect(await refusal(range), JSON.stringify(range)).toMatchObject({ isError: true, content: [{ text: "Choose an end after the start" }] });
      }
      // A time in the year 0, or past 9999, in UTC, which PostgreSQL takes neither of, is refused.
      for (const range of [{ from: "0000-06-01T00:00:00Z" }, { to: "9999-12-31T23:30:00-01:00" }]) {
        expect(await refusal(range), JSON.stringify(range)).toMatchObject({ isError: true, content: [{ text: "Times must be in the years 1 to 9999, in UTC" }] });
      }
      // A time without an offset is not taken.
      expect((await refusal({ from: "2026-11-02T07:30:00" })).isError).toBe(true);
    });

    it("takes a date as that day at the Location the Machine was at, in its time zone, through its end for the range's end", async () => {
      // All of 2 November in Chicago, to 6 in the morning of 3 November in UTC: the night's sleep at 11 included.
      const monday = await activity({ from: "2026-11-02", to: "2026-11-02" });
      expect(states(monday)).toEqual(["sleeping", "idle", "espresso", "idle", "sleeping"]);
      expect(doses(monday)).toEqual([19, 18.5, 18, 17]);
      expect(await activity({ to: "2026-11-02" })).toEqual(monday);
      // 3 November in Chicago starts after the night's sleep began, which is in effect then.
      const tuesday = await activity({ from: "2026-11-03" });
      expect([states(tuesday), doses(tuesday)]).toEqual([["sleeping"], [19]]);
      expect(tuesday.machineStates!.entries[0]!.observedAt).toBe(local(23));
      // A date and a time mix.
      expect(states(await activity({ from: "2026-11-02", to: chicago(7) }))).toEqual(["sleeping"]);
    });

    it("pages each list by limit and offset, at most 50, saying how many match and whether more follow, and gives only the lists asked for", async () => {
      const first = await activity({ limit: 2 });
      expect([first.machineStates, first.workflowChanges]).toMatchObject([
        { total: 5, offset: 0 },
        { total: 4, offset: 0 },
      ]);
      expect([states(first), first.machineStates!.more, doses(first), first.workflowChanges!.more]).toEqual([["sleeping", "idle"], true, [19, 18.5], true]);
      const second = await activity({ limit: 2, offset: 2 });
      expect([states(second), second.machineStates!.more, doses(second), second.workflowChanges!.more]).toEqual([["espresso", "idle"], true, [18, 17], false]);
      const only = await activity({ kinds: ["machineStates"], limit: 1, offset: 4 });
      expect(only).toEqual({ machineStates: { entries: [expect.objectContaining({ state: "sleeping", observedAt: local(6) })], total: 5, offset: 4, more: false } });
      for (const page of [{ limit: 51 }, { limit: 0 }, { offset: -1 }]) {
        expect((await refusal(page)).isError, JSON.stringify(page)).toBe(true);
      }
    });

    it("gives each Loaded Recipe loaded at any time in a range, as the REST API lists them, a Recipe unloaded as another loads in neither range that meets at that moment", async () => {
      type Entry = Record_ & { id: string; recipe: { id: string }; loadedAt: string; unloadedAt: string | null };
      const history = async () => (await api.get<{ entries: Entry[] }>(`/machines/${bar.machine.id}/loaded-recipes`)).entries;
      const recipes = async (args: Record_) =>
        (await assistant.call<Activity>("get_machine_activity", { machineId: bar.machine.id, kinds: ["loadedRecipes"], ...args })).loadedRecipes!;
      const ids = (page: Page<{ recipe: Record_ }>) => page.entries.map((entry) => entry.recipe.id);
      expect((await history()).map((entry) => entry.recipe.id)).toEqual([ethiopia]);
      const loadedAt = Date.parse((await history())[0]!.loadedAt);
      // Still loaded, so in a range long after its load, but not in one ending as it was loaded.
      expect(ids(await recipes({ from: new Date(loadedAt + 60_000).toISOString() }))).toEqual([ethiopia]);
      expect(ids(await recipes({ to: new Date(loadedAt).toISOString() }))).toEqual([]);

      // The Brazil's applied from DYE2's Select Recipe page, which unloads the Ethiopia's as it loads.
      await selectRecipeInDye2(tablet, BRAZIL);
      await expect.poll(async () => (await history()).length, { timeout: 15_000 }).toBe(2);
      await quiesced(api, { tablets: { tablet }, machines: { machine: bar } });
      const entries = await history();
      const [brazil, earlier] = entries;
      expect(earlier!.recipe.id).toBe(ethiopia);
      expect(earlier!.unloadedAt).toBe(brazil!.loadedAt);
      const switchedAt = Date.parse(brazil!.loadedAt);
      const iso = (ms: number) => new Date(ms).toISOString();

      expect(instants(await recipes({}))).toEqual(instants({ entries: entries.map(withoutId), total: 2, offset: 0, more: false }));
      // From the switch, only the Brazil's; up to it, only the Ethiopia's; across it, both.
      expect(ids(await recipes({ from: iso(switchedAt) }))).toEqual([brazil!.recipe.id]);
      expect(ids(await recipes({ to: iso(switchedAt) }))).toEqual([ethiopia]);
      expect(ids(await recipes({ from: iso(switchedAt - 1), to: iso(switchedAt + 1) }))).toEqual([brazil!.recipe.id, ethiopia]);
      // A page at a time, latest loaded first.
      expect(instants(await recipes({ limit: 1 }))).toEqual(instants({ entries: [withoutId(brazil!)], total: 2, offset: 0, more: true }));
      expect(instants(await recipes({ limit: 1, offset: 1 }))).toEqual(instants({ entries: [withoutId(earlier!)], total: 2, offset: 1, more: false }));
      expect(await recipes({ limit: 1, offset: 2 })).toEqual({ entries: [], total: 2, offset: 2, more: false });
    });
  });

  it("reads every Machine through a Staff member's or a Viewer's assistant as through their REST API, which is as an Admin reads it, a Machine outside Staff's Locations included", async () => {
    sam = await person("sam@example.com", "staff", [lab]);
    vic = await person("vic@example.com", "viewer");
    const van = (await api.get<{ machines: RestMachine[] }>("/machines")).machines.find((machine) => machine.name === "In the van")!;
    for (const [who, as] of [
      ["Staff", sam],
      ["a Viewer", vic],
    ] as const) {
      const { machines } = await as.assistant.call<{ machines: Record_[] }>("list_machines");
      expect(instants(unseen(machines)), who).toEqual(instants(unseen((await as.api.get<{ machines: RestMachine[] }>("/machines")).machines.map(listed))));
      expect(unseen(machines), who).toEqual(unseen((await assistant.call<{ machines: Record_[] }>("list_machines")).machines));
      for (const machineId of [bar.machine.id, van.id]) {
        const read = (through: Assistant) => through.call<Record_>("get_machine", { machineId });
        expect(unseen(await read(as.assistant)), who).toEqual(unseen(await read(assistant)));
      }
      const activity = (through: Assistant) => through.call<Activity>("get_machine_activity", { machineId: roaster.machine.id });
      expect(await activity(as.assistant), who).toEqual(await activity(assistant));
    }
  });

  it("lists a Machine's Settings Edits as the REST API does, newest first, naming who made each only to Admins", async () => {
    const path = `/machines/${bar.machine.id}/settings-edits`;
    const make = async (body: unknown, as: AdminApi) => (await as.send<{ settingsEdit: { id: string } }>("POST", path, body, 201)).settingsEdit.id;
    const answered = (id: string) => expect.poll(async () => (await api.get<{ settingsEdit: { answeredAt: string | null } }>(`${path}/${id}`)).settingsEdit.answeredAt, { timeout: 15_000 }).not.toBeNull();
    // Applied, by an Admin; refused as changed since, by Sam, who expected a fan threshold the Machine no longer holds.
    await answered(await make({ collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 55 } }, api));
    await answered(await make({ collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 55 } }, sam.api));

    const asListed = (edits: Record_[]) => edits.map(({ machineId: _, ...edit }) => edit);
    for (const [who, as, through] of [
      ["an Admin", api, assistant],
      ["Staff", sam.api, sam.assistant],
      ["a Viewer", vic.api, vic.assistant],
    ] as const) {
      const rest = await as.get<{ settingsEdits: Record_[]; total: number }>(path);
      const listedEdits = await through.call<Record_>("list_settings_edits", { machineId: bar.machine.id });
      expect(instants(listedEdits), who).toEqual(instants({ settingsEdits: asListed(rest.settingsEdits), total: rest.total, offset: 0, more: false }));
    }
    const { settingsEdits } = await assistant.call<{ settingsEdits: Record_[] }>("list_settings_edits", { machineId: bar.machine.id });
    expect(settingsEdits).toMatchObject([
      { fields: { fan: 45 }, outcome: "refused", refusal: { reason: "changedSince", current: { fan: 40 } }, account: { name: "sam@example.com" } },
      { fields: { fan: 40 }, outcome: "applied", account: { name: "Ada Admin" } },
    ]);
    expectZoned(CHICAGO, ...settingsEdits.flatMap((edit) => [edit.madeAt, edit.sentAt, edit.answeredAt]));
    expect((await sam.assistant.call<{ settingsEdits: { account: { name: string | null } }[] }>("list_settings_edits", { machineId: bar.machine.id })).settingsEdits.map((edit) => edit.account.name)).toEqual([null, null]);

    type EditsPage = { settingsEdits: { id: string }[]; total: number; offset: number; more: boolean };
    const page = await assistant.call<EditsPage>("list_settings_edits", { machineId: bar.machine.id, limit: 1 });
    expect([page.settingsEdits.map((edit) => edit.id), page.total, page.offset, page.more]).toEqual([[settingsEdits[0]!.id], 2, 0, true]);
    const last = await assistant.call<EditsPage>("list_settings_edits", { machineId: bar.machine.id, limit: 1, offset: 1 });
    expect([last.settingsEdits.map((edit) => edit.id), last.total, last.offset, last.more]).toEqual([[settingsEdits[1]!.id], 2, 1, false]);
  });

  it("lists a Machine's Settings History as the REST API does, newest first, naming who made an edit's change only to Admins, and gives its settings as last received by a time", async () => {
    const path = `/machines/${bar.machine.id}`;
    type Change = Record_ & { receivedAt: string; settingsEdit: { id: string; account: { name: string | null } } | null; fields: Record_[] };
    type HistoryPage = { changes: Change[]; total: number; offset: number; more: boolean };
    const rest = async (as: AdminApi, query = "") => {
      const { changes, total, offset } = await as.get<{ changes: Change[]; total: number; offset: number }>(`${path}/settings-history${query}`);
      return { total, offset, more: offset + changes.length < total, changes };
    };
    for (const [who, as, through] of [
      ["an Admin", api, assistant],
      ["Staff", sam.api, sam.assistant],
      ["a Viewer", vic.api, vic.assistant],
    ] as const) {
      const listed = await through.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id });
      expect(instants(listed), who).toEqual(instants(await rest(as)));
      const briefToo = await through.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings", "appSettings"], includeBrief: true, limit: 1 });
      expect(instants(briefToo), who).toEqual(instants(await rest(as, "?collection=machineSettings&collection=appSettings&includeBrief=true&limit=1")));
    }
    // A collection named twice is listed once.
    const twice = await assistant.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings", "machineSettings"] });
    expect(twice).toEqual(await assistant.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings"] }));
    expect(twice.total).toBe(1);
    // The fan threshold the Admin's edit applied, and no change for Sam's, which was refused.
    const { changes } = await assistant.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings"] });
    const { settingsEdits } = await api.get<{ settingsEdits: { id: string; fields: Record_ }[] }>(`${path}/settings-edits`);
    const applied = settingsEdits.find((edit) => edit.fields.fan === 40)!;
    expect(changes).toEqual([
      {
        id: expect.any(String),
        receivedAt: expect.any(String),
        collection: "machineSettings",
        settingsEdit: { id: applied.id, account: { id: expect.any(String), name: "Ada Admin" }, connectedApp: null },
        fields: [{ field: "fan", change: "changed", before: 55, after: 40, backAt: null }],
      },
    ]);
    expectZoned(CHICAGO, changes[0]!.receivedAt);
    const seenBySam = await sam.assistant.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings"] });
    expect(seenBySam.changes[0]!.settingsEdit!.account.name).toBeNull();
    // A range of when they were received, each bound a moment with its offset.
    const at = changes[0]!.receivedAt;
    const ranged = (from: string, to: string) => assistant.call<HistoryPage>("list_settings_history", { machineId: bar.machine.id, collections: ["machineSettings"], from, to });
    expect((await ranged(at, new Date(Date.parse(at) + 1).toISOString())).total).toBe(1);
    expect((await ranged(new Date(Date.parse(at) - 60_000).toISOString(), at)).total).toBe(0);

    // Its settings as last received just before the edit's change, as the REST API gives them then, and none before its first report.
    const before = new Date(Date.parse(at) - 1).toISOString();
    const asOf = await assistant.call<Record_ & { machineSettings: Record_; tabletSettings: Record_ }>("get_machine", { machineId: bar.machine.id, at: before });
    const collection = async (name: string, when: string) => {
      const { collection } = await api.get<{ collection: Record_ | null }>(`${path}/collections/${name}?${new URLSearchParams({ at: when })}`);
      return collection && { available: collection.available, reportedAt: collection.reportedAt, receivedAt: collection.receivedAt, value: collection.value, utcOffsetMinutes: collection.utcOffsetMinutes };
    };
    expect(instants({ machineSettings: asOf.machineSettings, tabletSettings: asOf.tabletSettings })).toEqual(
      instants({
        machineSettings: {
          machineSettings: await collection("machineSettings", before),
          advancedSettings: await collection("advancedSettings", before),
          machineCalibration: await collection("machineCalibration", before),
          sensorCalibration: await collection("sensorCalibration", before),
        },
        tabletSettings: { appSettings: await collection("appSettings", before), presenceSettings: await collection("presenceSettings", before) },
      }),
    );
    expect(asOf.machineSettings).toMatchObject({ machineSettings: { available: true, value: { fan: 55 } } });
    expect(await assistant.call<Record_>("get_machine", { machineId: bar.machine.id, at })).toMatchObject({ machineSettings: { machineSettings: { receivedAt: at, value: { fan: 40 } } } });
    const long = await assistant.call<{ machineSettings: Record_; tabletSettings: Record_; machine: Record_ }>("get_machine", { machineId: bar.machine.id, at: "2020-01-01T00:00:00-06:00" });
    expect([long.machineSettings, long.tabletSettings]).toEqual([
      { machineSettings: null, advancedSettings: null, machineCalibration: null, sensorCalibration: null },
      { appSettings: null, presenceSettings: null },
    ]);
    // The rest is as now.
    expect(unseen(long.machine)).toEqual(unseen((await assistant.call<{ machine: Record_ }>("get_machine", { machineId: bar.machine.id })).machine));
    const refused = await assistant.client.callTool({ name: "get_machine", arguments: { machineId: bar.machine.id, at: "2026-11-08T09:00:00" } });
    expect(refused).toMatchObject({ isError: true });
  });
});
