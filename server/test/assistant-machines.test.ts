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
    for (const name of ["list_machines", "get_machine", "get_machine_activity", "list_settings_edits"]) {
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
    expect(unseen(machines)).toEqual(unseen(rest.map(listed)));
    const byName = (name: string) => machines.find((machine) => machine.name === name);
    seenBetween(before.find((machine) => machine.id === bar.machine.id)!, byName("Lab bar")!, rest.find((machine) => machine.id === bar.machine.id)!);
    expect(byName("Lab bar")).toMatchObject({
      location: { id: lab.id, name: "Lab", timeZone: "America/Chicago" },
      online: true,
      machineState: { state: "idle", substate: "idle" },
      loadedRecipe: { recipe: { id: ethiopia, archived: false }, unloadedAt: null },
      captureOnly: [],
    });
    expect(byName("In the van")).toMatchObject({ id: van.machine.id, location: null, online: false, lastSeenAt: null, machineState: null, loadedRecipe: null, captureOnly: ["noLocation"] });
    expect(byName("Lab spare")).toMatchObject({ captureOnly: ["sharingOff"] });
  });

  it("gives one Machine as the REST API does: its Workflow, Machine Settings, Tablet Settings, Location History, sharing status and tablet versions", async () => {
    const before = await restMachine(bar);
    const result = await assistant.call<Record_ & { machine: Record_ }>("get_machine", { machineId: bar.machine.id });
    const path = `/machines/${bar.machine.id}`;
    const rest = await restMachine(bar);
    seenBetween(before, result.machine, rest);
    const collection = async (name: string) => {
      const { collection } = await api.get<{ collection: Record_ | null }>(`${path}/collections/${name}`);
      return collection && { available: collection.available, reportedAt: collection.reportedAt, receivedAt: collection.receivedAt, value: collection.value, utcOffsetMinutes: collection.utcOffsetMinutes };
    };
    const { workflow } = await api.get<{ workflow: Record_ }>(`${path}/workflow`);
    const { status } = await api.get<{ status: Record_ & { refused: Record_[] } }>(`${path}/sharing-status`);
    expect(unseen(result)).toEqual({
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
    });
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
    const moved = await assistant.call<{ machine: { location: LocationView; locationHistory: { location: LocationView }[] }; workflow: unknown }>("get_machine", { machineId: van.machine.id });
    expect(moved.machine.location).toEqual(uptown);
    expect(moved.machine.locationHistory.map((entry) => entry.location.name)).toEqual(["Lab", "Uptown"]);
    expect(moved.workflow).toBeNull();
  });

  it("refuses a Machine that doesn't exist, as the REST API does", async () => {
    for (const machineId of [randomUUID(), "not an id"]) {
      for (const [name, args] of [
        ["get_machine", { machineId }],
        ["get_machine_activity", { machineId }],
        ["list_settings_edits", { machineId }],
      ] as const) {
        const result = await assistant.client.callTool({ name, arguments: args });
        expect(result, name).toMatchObject({ isError: true, content: [{ type: "text", text: "No such Machine" }] });
      }
    }
  });

  describe("a Machine's activity over a time range", () => {
    // Monday 2 November 2026 in Chicago (UTC-6): asleep at 6, a Workflow at 6:30, awake at 7, another Workflow at 8, a
    // Shot at 9, a third Workflow at 10, idle again at 11.
    const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 2, hour + 6, minute)).toISOString();
    const chicago = (hour: number, minute = 0) => `2026-11-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-06:00`;
    const STATES = [
      ["sleeping", "noState", at(6)],
      ["idle", "idle", at(7)],
      ["espresso", "pouring", at(9)],
      ["idle", "idle", at(11)],
    ] as const;
    const DOSES = [
      [18, at(6, 30)],
      [18.5, at(8)],
      [19, at(10)],
    ] as const;

    beforeAll(async () => {
      // Its records sent as raw frames at those times, from a tablet at no Location, which takes no part in the Library.
      roaster = await api.createMachine("Roastery");
      const raw = await RawConnection.welcomed(server.url, helloWith(roaster.token));
      try {
        const deliveries = [
          ...STATES.map(([state, substate, observedAt]) => ({ type: "machineState", id: randomUUID(), observedAt, state, substate })),
          ...DOSES.map(([dose, observedAt]) => ({ type: "workflow", id: randomUUID(), observedAt, workflow: derivedWorkflow({ targetDoseWeight: dose }) })),
        ].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        for (const delivery of deliveries) await raw.deliver(delivery);
      } finally {
        await raw.close();
      }
    });

    const activity = (args: Record_) => assistant.call<Activity>("get_machine_activity", { machineId: roaster.machine.id, ...args });
    const doses = (result: Activity) => result.workflowChanges!.entries.map((entry) => entry.workflow.dose);
    const states = (result: Activity) => result.machineStates!.entries.map((entry) => entry.state);

    it("gives every Workflow change and Machine State, latest first, as the REST API lists them, each Workflow as the management interface shows it", async () => {
      const all = await activity({});
      const path = `/machines/${roaster.machine.id}`;
      const workflows = (await api.get<{ events: { observedAt: string; receivedAt: string; workflow: Record_ }[] }>(`${path}/workflow-events`)).events;
      const transitions = (await api.get<{ events: { state: string; substate: string; observedAt: string; receivedAt: string }[] }>(`${path}/machine-state-events`)).events;
      expect(all.machineStates).toEqual({ entries: transitions.map(({ state, substate, observedAt, receivedAt }) => ({ state, substate, observedAt, receivedAt })), more: false });
      expect(all.workflowChanges!.entries.map(({ observedAt, receivedAt }) => ({ observedAt, receivedAt }))).toEqual(workflows.map(({ observedAt, receivedAt }) => ({ observedAt, receivedAt })));
      expect(all.workflowChanges!.more).toBe(false);
      expect(all.loadedRecipes).toEqual({ entries: [], more: false });
      expect(states(all)).toEqual(["idle", "espresso", "idle", "sleeping"]);
      expect(doses(all)).toEqual([19, 18.5, 18]);

      // As sent, Decaid's numbers and names; as summarized, those the Workflow card shows, to two decimal places.
      const sent = workflows[0]!.workflow as { profile: Record_ & { steps: Record_[] }; context: Record_; steamSettings: Record_; hotWaterData: Record_; rinseData: Record_ };
      expect(all.workflowChanges!.entries[0]!.workflow).toEqual({
        profile: sent.profile.title,
        brewTemperature: sent.profile.steps[0]!.temperature,
        dose: 19,
        yield: sent.context.targetYield,
        bean: sent.context.coffeeName,
        roaster: sent.context.coffeeRoaster,
        grinder: sent.context.grinderModel,
        burrs: null,
        grindSetting: sent.context.grinderSetting,
        basket: (sent.context.extras as Record_).basketName,
        barista: sent.context.baristaName,
        steam: { temperature: sent.steamSettings.targetTemperature, duration: sent.steamSettings.duration, flow: 2.5 },
        hotWater: { temperature: sent.hotWaterData.targetTemperature, volume: sent.hotWaterData.volume },
        flush: { temperature: sent.rinseData.targetTemperature, duration: sent.rinseData.duration },
      });
      expect(sent.steamSettings.flow).not.toBe(2.5);
    });

    it("gives what was in effect at any time in a range given with offsets: what was observed in it, and what was in effect as it began", async () => {
      // 7:30 to 9:30: awake since 7 and a Shot at 9; the 6:30 Workflow until 8, then the 8 o'clock one.
      const morning = await activity({ from: chicago(7, 30), to: chicago(9, 30) });
      expect(states(morning)).toEqual(["espresso", "idle"]);
      expect(doses(morning)).toEqual([18.5, 18]);
      expect(morning.machineStates!.entries.map((entry) => entry.observedAt)).toEqual([at(9), at(7)]);
      // The same range in UTC.
      expect(await activity({ from: at(7, 30), to: at(9, 30) })).toEqual(morning);
      // From exactly 8: the Workflow observed then is the one in effect, and the range's end is not in it.
      expect(doses(await activity({ from: chicago(8), to: chicago(10) }))).toEqual([18.5]);
      // Before the first, nothing; after the last, only what was in effect.
      expect(await activity({ to: chicago(6) })).toMatchObject({ workflowChanges: { entries: [] }, machineStates: { entries: [] } });
      const evening = await activity({ from: chicago(18) });
      expect([states(evening), doses(evening)]).toEqual([["idle"], [19]]);
      // A start not before its end is refused.
      for (const range of [{ from: chicago(9), to: chicago(9) }, { from: chicago(10), to: chicago(9) }]) {
        const result = await assistant.client.callTool({ name: "get_machine_activity", arguments: { machineId: roaster.machine.id, ...range } });
        expect(result).toMatchObject({ isError: true, content: [{ text: "The range's start must be before its end" }] });
      }
      // A time without an offset is not taken.
      const local = await assistant.client.callTool({ name: "get_machine_activity", arguments: { machineId: roaster.machine.id, from: "2026-11-02T07:30:00" } });
      expect(local.isError).toBe(true);
    });

    it("pages each list by limit and offset, at most 50, saying whether more follow, and gives only the lists asked for", async () => {
      const first = await activity({ limit: 2 });
      expect([states(first), first.machineStates!.more, doses(first), first.workflowChanges!.more]).toEqual([["idle", "espresso"], true, [19, 18.5], true]);
      const second = await activity({ limit: 2, offset: 2 });
      expect([states(second), second.machineStates!.more, doses(second), second.workflowChanges!.more]).toEqual([["idle", "sleeping"], false, [18], false]);
      const only = await activity({ kinds: ["machineStates"], limit: 1, offset: 3 });
      expect(only).toEqual({ machineStates: { entries: [expect.objectContaining({ state: "sleeping" })], more: false } });
      for (const page of [{ limit: 51 }, { limit: 0 }, { offset: -1 }]) {
        expect((await assistant.client.callTool({ name: "get_machine_activity", arguments: { machineId: roaster.machine.id, ...page } })).isError, JSON.stringify(page)).toBe(true);
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

      expect(await recipes({})).toEqual({ entries: entries.map(withoutId), more: false });
      // From the switch, only the Brazil's; up to it, only the Ethiopia's; across it, both.
      expect(ids(await recipes({ from: iso(switchedAt) }))).toEqual([brazil!.recipe.id]);
      expect(ids(await recipes({ to: iso(switchedAt) }))).toEqual([ethiopia]);
      expect(ids(await recipes({ from: iso(switchedAt - 1), to: iso(switchedAt + 1) }))).toEqual([brazil!.recipe.id, ethiopia]);
      // A page at a time, latest loaded first.
      expect(await recipes({ limit: 1 })).toEqual({ entries: [withoutId(brazil!)], more: true });
      expect(await recipes({ limit: 1, offset: 1 })).toEqual({ entries: [withoutId(earlier!)], more: false });
      expect(await recipes({ limit: 1, offset: 2 })).toEqual({ entries: [], more: false });
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
      expect(unseen(machines), who).toEqual(unseen((await as.api.get<{ machines: RestMachine[] }>("/machines")).machines.map(listed)));
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
      const rest = await as.get<{ settingsEdits: Record_[] }>(path);
      const listedEdits = await through.call<{ settingsEdits: Record_[]; more: boolean }>("list_settings_edits", { machineId: bar.machine.id });
      expect(listedEdits, who).toEqual({ settingsEdits: asListed(rest.settingsEdits), more: false });
    }
    const { settingsEdits } = await assistant.call<{ settingsEdits: Record_[] }>("list_settings_edits", { machineId: bar.machine.id });
    expect(settingsEdits).toMatchObject([
      { fields: { fan: 45 }, outcome: "refused", refusal: { reason: "changedSince", current: { fan: 40 } }, account: { name: "sam@example.com" } },
      { fields: { fan: 40 }, outcome: "applied", account: { name: "Ada Admin" } },
    ]);
    expect((await sam.assistant.call<{ settingsEdits: { account: { name: string | null } }[] }>("list_settings_edits", { machineId: bar.machine.id })).settingsEdits.map((edit) => edit.account.name)).toEqual([null, null]);

    const page = await assistant.call<{ settingsEdits: { id: string }[]; more: boolean }>("list_settings_edits", { machineId: bar.machine.id, limit: 1 });
    expect([page.settingsEdits.map((edit) => edit.id), page.more]).toEqual([[settingsEdits[0]!.id], true]);
    const last = await assistant.call<{ settingsEdits: { id: string }[]; more: boolean }>("list_settings_edits", { machineId: bar.machine.id, limit: 1, offset: 1 });
    expect([last.settingsEdits.map((edit) => edit.id), last.more]).toEqual([[settingsEdits[1]!.id], false]);
  });
});
