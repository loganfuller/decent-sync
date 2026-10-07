import { randomUUID } from "node:crypto";
import { CLOSE_CODES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import {
  RawConnection,
  SimulatedTablet,
  type SimulatedTabletOptions,
  derivedDe1Pro,
  derivedWorkflow,
  helloWith,
  settingsFor,
  workflowFixture,
} from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #13: the built plugin in a simulated tablet, or raw
// frames, against real servers sharing one PostgreSQL database, with every
// assertion made through the REST API. Workflows and machine states are
// derived from the test tablet's (see the fixtures' README); serials are
// made up.

interface WorkflowEvent { id: string; observedAt: string; receivedAt: string; workflow: Record<string, unknown> }
interface StateEvent { id: string; state: string; substate: string; observedAt: string; receivedAt: string }
interface EventPage<T> { events: T[]; total: number; limit: number; offset: number }
interface Frame { type: string; id?: string }

const frameType = (frame: unknown) => (frame as Frame).type;
const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("Workflow changes and machine state transitions", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** A simulated tablet with the Machine's token, its machine reporting hardware of its own unless given an API. */
  function load(machine: CreatedMachine, options: Omit<SimulatedTabletOptions, "settings"> = {}) {
    const tablet = SimulatedTablet.load({
      settings: settingsFor(machine),
      api: derivedDe1Pro({ serial: machine.machine.id.replaceAll("-", "") }),
      timeScale: 50,
      ...options,
    });
    tablets.push(tablet);
    return tablet;
  }
  async function get<T>(path: string, at = api): Promise<T> {
    const response = await at.call("GET", path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  const workflowEvents = (machine: CreatedMachine, at = api) =>
    get<EventPage<WorkflowEvent>>(`/machines/${machine.machine.id}/workflow-events?limit=100`, at);
  const stateEvents = (machine: CreatedMachine, at = api) =>
    get<EventPage<StateEvent>>(`/machines/${machine.machine.id}/machine-state-events?limit=100`, at);
  const currentWorkflow = async (machine: CreatedMachine) =>
    (await get<{ workflow: WorkflowEvent | null }>(`/machines/${machine.machine.id}/workflow`)).workflow;
  const transitions = async (machine: CreatedMachine) =>
    (await stateEvents(machine)).events.map((event) => [event.state, event.substate]).reverse();

  /** Resolves once the server has acknowledged every delivery of this type the plugin sent. */
  async function acknowledged(tablet: SimulatedTablet, type: string) {
    await expect
      .poll(() =>
        tablet.sent
          .filter((frame) => frameType(frame) === type)
          .every((frame) => tablet.received.some((reply) => frameType(reply) === "ack" && (reply as Frame).id === (frame as Frame).id)),
      )
      .toBe(true);
  }

  /** Welcomed, sending heartbeats every `heartbeatMs`: SILENT for none while the test holds its Machine's row. */
  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }, heartbeatMs?: number) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}), heartbeatMs);
    raws.push(raw);
    return raw;
  }
  // Longer than any test. A heartbeat records its Machine as seen, so while the test holds that Machine's row it
  // would wait there, ahead of the deliveries sent after it.
  const SILENT = 60_000;
  const stateDelivery = (state: string, substate: string, observedAt: string) =>
    ({ type: "machineState", id: randomUUID(), observedAt, state, substate });
  const workflowDelivery = (workflow: Record<string, unknown>, observedAt: string) =>
    ({ type: "workflow", id: randomUUID(), observedAt, workflow });

  it("requires a Machine and valid pagination for the history reads", async () => {
    const machine = await api.createMachine("History reads");
    const paths = ["/workflow", "/workflow-events", "/machine-state-events"];
    for (const path of paths) {
      for (const id of [randomUUID(), "not-a-machine"]) expect((await api.call("GET", `/machines/${id}${path}`)).status).toBe(404);
    }
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=1.5"]) {
      expect((await api.call("GET", `/machines/${machine.machine.id}/workflow-events?${query}`)).status).toBe(400);
      expect((await api.call("GET", `/machines/${machine.machine.id}/machine-state-events?${query}`)).status).toBe(400);
    }
    expect(await currentWorkflow(machine)).toBeNull();
    expect(await workflowEvents(machine)).toEqual({ events: [], total: 0, limit: 100, offset: 0 });
    expect(await stateEvents(machine)).toEqual({ events: [], total: 0, limit: 100, offset: 0 });
    expect((await api.machineNamed("History reads"))!.machineState).toBeNull();
  });

  it("records the Workflow Decaid sends on load and on each change, the latest as the Machine's current Workflow, and only sends it again on reconnect", async () => {
    const machine = await api.createMachine("Workflow changes");
    const loaded = Date.now();
    const tablet = load(machine);
    // Decaid sends the plugin the current Workflow as soon as it has loaded.
    await expect.poll(async () => (await currentWorkflow(machine))?.workflow).toEqual(workflowFixture());
    const first = (await currentWorkflow(machine))!;
    expect(Date.parse(first.observedAt)).toBeGreaterThanOrEqual(loaded);
    expect(Date.parse(first.observedAt)).toBeLessThanOrEqual(Date.now());

    const dialledIn = derivedWorkflow({ targetYield: 40, grinderSetting: "7.5" });
    tablet.setWorkflow(dialledIn);
    await expect.poll(async () => (await currentWorkflow(machine))?.workflow).toEqual(dialledIn);
    expect((await workflowEvents(machine)).events.map((event) => event.workflow)).toEqual([dialledIn, workflowFixture()]);

    // On reconnect, the plugin sends the latest Workflow again, which is unchanged.
    const sentBefore = tablet.sent.length;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(() => tablet.sent.slice(sentBefore).filter((frame) => frameType(frame) === "workflow").length).toBe(1);
    await acknowledged(tablet, "workflow");
    const history = await workflowEvents(machine);
    expect(history.total).toBe(2);
    expect(history.events[0]).toMatchObject({ id: expect.any(String), workflow: dialledIn });
    expect((await currentWorkflow(machine))!.workflow).toEqual(dialledIn);
  });

  it("records only the transitions in a series of state updates, a change of substate alone included", async () => {
    const machine = await api.createMachine("State transitions");
    const tablet = load(machine);
    await tablet.waitForLog(/^Connected to /);
    const shot: [string, string][] = [
      ["idle", "idle"],
      ["idle", "idle"],
      ["espresso", "preparingForShot"],
      ["espresso", "preparingForShot"],
      ["espresso", "preinfusion"],
      ["espresso", "pouring"],
      ["espresso", "pouring"],
      ["espresso", "pouring"],
      ["espresso", "pouringDone"],
      ["idle", "idle"],
      ["idle", "idle"],
    ];
    for (const [state, substate] of shot) tablet.reportState(state, substate);
    const expected = [
      ["idle", "idle"],
      ["espresso", "preparingForShot"],
      ["espresso", "preinfusion"],
      ["espresso", "pouring"],
      ["espresso", "pouringDone"],
      ["idle", "idle"],
    ];
    await expect.poll(() => transitions(machine)).toEqual(expected);
    // The plugin sends a change of state or substate, not every update.
    expect(tablet.sent.filter((frame) => frameType(frame) === "machineState")).toHaveLength(expected.length);
    const latest = (await stateEvents(machine)).events[0]!;
    expect((await api.machineNamed("State transitions"))!.machineState).toEqual({ state: "idle", substate: "idle", observedAt: latest.observedAt });
    const times = (await stateEvents(machine)).events.map((event) => Date.parse(event.observedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("keeps the time the plugin observed an event it delivered late, after a reconnect", async () => {
    const machine = await api.createMachine("Late delivery");
    let stalled = false;
    const tablet = load(machine, { stallUpload: (frame) => stalled && frameType(frame) === "machineState" });
    await tablet.waitForLog(/^Connected to /);
    tablet.reportState("idle", "idle");
    await expect.poll(async () => (await stateEvents(machine)).total).toBe(1);

    stalled = true;
    const observed = Date.now();
    tablet.reportState("espresso", "preinfusion");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await stateEvents(machine)).total).toBe(1);
    tablet.dropConnections();
    stalled = false;
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(async () => (await stateEvents(machine)).total).toBe(2);
    const late = (await stateEvents(machine)).events[0]!;
    expect(late).toMatchObject({ state: "espresso", substate: "preinfusion" });
    expect(Date.parse(late.observedAt)).toBeGreaterThanOrEqual(observed);
    expect(Date.parse(late.observedAt)).toBeLessThan(observed + 500);
    expect(Date.parse(late.receivedAt) - Date.parse(late.observedAt)).toBeGreaterThan(1_000);
  });

  it("keeps Workflow changes made while disconnected, with their times, and records nothing for the Workflow sent on reconnect", async () => {
    const machine = await api.createMachine("Offline changes");
    let stalled = false;
    const tablet = load(machine, { stallUpload: (frame) => stalled && frameType(frame) === "workflow" });
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(1);

    stalled = true;
    const changes = [derivedWorkflow({ targetYield: 38 }), derivedWorkflow({ targetYield: 42 })];
    for (const change of changes) {
      tablet.setWorkflow(change);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    tablet.dropConnections();
    stalled = false;
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(3);
    await acknowledged(tablet, "workflow");
    const [second, first] = (await workflowEvents(machine)).events;
    expect([first!.workflow, second!.workflow]).toEqual(changes);
    expect(Date.parse(second!.observedAt) - Date.parse(first!.observedAt)).toBeGreaterThanOrEqual(15);

    // The next reconnect sends the latest Workflow again; it is unchanged.
    const sentBefore = tablet.sent.length;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 3);
    await expect.poll(() => tablet.sent.slice(sentBefore).filter((frame) => frameType(frame) === "workflow").length).toBe(1);
    await acknowledged(tablet, "workflow");
    expect((await workflowEvents(machine)).total).toBe(3);
  });

  it("gives a mismatched connection's events to the Machine that has its hardware, judging changes against that Machine's, and leaves the token's Machine its own", async () => {
    const owner = await api.createMachine("Owner of 20001");
    const ownerRaw = await connect(owner, server.url, { model: "DE1Pro", serial: "20001" });
    await ownerRaw.deliver(stateDelivery("idle", "idle", new Date().toISOString()));
    await ownerRaw.close();

    const traveller = await api.createMachine("Traveller");
    const home = load(traveller, { api: derivedDe1Pro({ serial: "20002" }) });
    home.reportState("sleeping", "idle");
    await expect.poll(() => transitions(traveller)).toEqual([["sleeping", "idle"]]);
    await home.unload();

    // The tablet moves onto Owner's machine, still with Traveller's token.
    const moved = load(traveller, { api: derivedDe1Pro({ serial: "20001" }) });
    await api.waitForMachine("Traveller", (machine) => machine.online && machine.identification === "mismatch");
    moved.reportState("idle", "idle");
    moved.reportState("espresso", "preinfusion");
    const dialledIn = derivedWorkflow({ targetYield: 44 });
    moved.setWorkflow(dialledIn);
    await expect.poll(async () => (await currentWorkflow(owner))?.workflow).toEqual(dialledIn);
    await acknowledged(moved, "machineState");
    // Owner was already idle, so only the change to espresso is new for it.
    expect(await transitions(owner)).toEqual([["idle", "idle"], ["espresso", "preinfusion"]]);
    expect((await workflowEvents(owner)).events.map((event) => event.workflow)).toEqual([dialledIn, workflowFixture()]);
    expect((await api.machineNamed("Owner of 20001"))!.machineState).toMatchObject({ state: "espresso", substate: "preinfusion" });

    expect(await transitions(traveller)).toEqual([["sleeping", "idle"]]);
    expect((await workflowEvents(traveller)).events.map((event) => event.workflow)).toEqual([workflowFixture()]);
    expect((await api.machineNamed("Traveller"))!.machineState).toMatchObject({ state: "sleeping", substate: "idle" });
  });

  it("holds a mismatched connection's events for hardware without a Machine, and hands them to the machine entry created for it", async () => {
    const machine = await api.createMachine("Before the move");
    const home = load(machine, { api: derivedDe1Pro({ serial: "20101" }) });
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(1);
    await home.unload();

    const moved = load(machine, { api: derivedDe1Pro({ serial: "20102" }) });
    await api.waitForMachine("Before the move", (candidate) => candidate.online && candidate.identification === "mismatch");
    moved.reportState("espresso", "pouring");
    const dialledIn = derivedWorkflow({ targetYield: 45 });
    moved.setWorkflow(dialledIn);
    // Acknowledged in order, so once the dialled-in Workflow is, the state is too.
    await expect.poll(() => moved.sent.some((frame) => frameType(frame) === "workflow" && isEqual((frame as { workflow: unknown }).workflow, dialledIn))).toBe(true);
    await acknowledged(moved, "workflow");
    expect(await stateEvents(machine)).toMatchObject({ total: 0 });
    expect((await workflowEvents(machine)).total).toBe(1);

    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "20102")!;
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "After the move" }));
    expect(await transitions(adopted)).toEqual([["espresso", "pouring"]]);
    expect((await workflowEvents(adopted)).events.map((event) => event.workflow)).toEqual([dialledIn, workflowFixture()]);
    expect((await currentWorkflow(adopted))!.workflow).toEqual(dialledIn);
    expect((await api.machineNamed("After the move"))!.machineState).toMatchObject({ state: "espresso", substate: "pouring" });
    expect((await workflowEvents(machine)).total).toBe(1);
  });

  it("stores each change once, whether its delivery is repeated, resent through another instance, overtaken by its resend, or arrives after a restart", async () => {
    const machine = await api.createMachine("Raw events");
    const first = await connect(machine);
    const idle = stateDelivery("idle", "idle", "2026-10-05T12:00:00.000Z");
    const workflow = { ...workflowFixture(), unfamiliar: { kept: [1, null, "as sent"] } };
    const loaded = workflowDelivery(workflow, "2026-10-05T12:00:00.000Z");
    await first.deliver(idle);
    await first.deliver(loaded);
    // Repeated on the same connection, a delivery is acknowledged again but not stored again.
    await first.deliver(idle);
    await first.deliver(loaded);

    // Resent through another instance, as the outbox resends what was not acknowledged.
    const second = await connect(machine, other.url);
    await second.deliver(idle);
    await second.deliver(loaded);
    // Observed again, unchanged, in a new delivery, as on every welcome.
    await second.deliver(workflowDelivery(workflow, "2026-10-05T12:00:30.000Z"));
    await second.deliver(stateDelivery("espresso", "pouring", "2026-10-05T12:01:00.000Z"));
    const dialledIn = derivedWorkflow({ targetYield: 39 });
    await second.deliver(workflowDelivery(dialledIn, "2026-10-05T12:01:00.000Z"));
    await second.close();
    // Resends that arrive after the changes that followed them, on a connection that has not seen them.
    const third = await connect(machine);
    await third.deliver(idle);
    await third.deliver(loaded);
    expect(await transitions(machine)).toEqual([["idle", "idle"], ["espresso", "pouring"]]);
    expect((await workflowEvents(machine)).events.map((event) => event.workflow)).toEqual([dialledIn, workflow]);
    await third.close();

    // A restarted instance judges changes by what is stored.
    await other.stop();
    other = await startTestServer({ env, sharing: server });
    const restarted = await connect(machine, other.url);
    await restarted.deliver(stateDelivery("espresso", "pouring", "2026-10-05T12:02:00.000Z"));
    await restarted.deliver(workflowDelivery(dialledIn, "2026-10-05T12:02:00.000Z"));
    // Back to a state it was in before is a change.
    await restarted.deliver(stateDelivery("idle", "idle", "2026-10-05T12:03:00.000Z"));
    const states = await stateEvents(machine, api.at(other.url));
    expect(states.events.map((event) => [event.state, event.substate, event.observedAt]).reverse()).toEqual([
      ["idle", "idle", "2026-10-05T12:00:00.000Z"],
      ["espresso", "pouring", "2026-10-05T12:01:00.000Z"],
      ["idle", "idle", "2026-10-05T12:03:00.000Z"],
    ]);
    const workflows = await workflowEvents(machine);
    expect(workflows.events.map((event) => [event.workflow, event.observedAt])).toEqual([
      [dialledIn, "2026-10-05T12:01:00.000Z"],
      [workflow, "2026-10-05T12:00:00.000Z"],
    ]);

    // Pages, latest first.
    const page = await get<EventPage<StateEvent>>(`/machines/${machine.machine.id}/machine-state-events?limit=2&offset=1`);
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.events.map((event) => event.observedAt)).toEqual(["2026-10-05T12:01:00.000Z", "2026-10-05T12:00:00.000Z"]);
  }, 30_000);

  it("records nothing for a delivery that changed nothing when it first arrived, when it arrives again after a change", async () => {
    const machine = await api.createMachine("Unchanged replays");
    const first = await connect(machine);
    await first.deliver(stateDelivery("idle", "idle", "2026-10-05T14:00:00.000Z"));
    await first.deliver(workflowDelivery(workflowFixture(), "2026-10-05T14:00:00.000Z"));
    // The same values again, in new deliveries, change nothing.
    const unchangedState = stateDelivery("idle", "idle", "2026-10-05T14:00:10.000Z");
    const unchangedWorkflow = workflowDelivery(workflowFixture(), "2026-10-05T14:00:10.000Z");
    await first.deliver(unchangedState);
    await first.deliver(unchangedWorkflow);
    // Then the Machine changes, through another instance.
    const second = await connect(machine, other.url);
    await second.deliver(stateDelivery("espresso", "pouring", "2026-10-05T14:01:00.000Z"));
    const dialledIn = derivedWorkflow({ targetYield: 41 });
    await second.deliver(workflowDelivery(dialledIn, "2026-10-05T14:01:00.000Z"));
    await second.close();
    // The unchanged deliveries arrive again, as after a lost acknowledgment or from a slow instance.
    const third = await connect(machine);
    await third.deliver(unchangedState);
    await third.deliver(unchangedWorkflow);
    expect(await transitions(machine)).toEqual([["idle", "idle"], ["espresso", "pouring"]]);
    expect((await workflowEvents(machine)).events.map((event) => event.workflow)).toEqual([dialledIn, workflowFixture()]);
    expect((await api.machineNamed("Unchanged replays"))!.machineState).toMatchObject({ state: "espresso", substate: "pouring" });
  });

  it("gives a tablet moved onto other hardware its Workflow on reconnect, though its last Workflow delivery was stored and never acknowledged", async () => {
    const machine = await api.createMachine("Moved mid-delivery");
    const destination = await api.createMachine("Destination");
    await (await connect(destination, server.url, { model: "DE1Pro", serial: "20302" })).close();
    const tablet = load(machine, { api: derivedDe1Pro({ serial: "20301" }) });
    await expect.poll(async () => (await workflowEvents(machine)).total).toBe(1);
    // The Workflow Decaid sends on load and the one the first welcome sends again, both acknowledged,
    // so the next Workflow is the only one in flight.
    await expect.poll(() => tablet.sent.filter((frame) => frameType(frame) === "workflow").length).toBe(2);
    await acknowledged(tablet, "workflow");
    const dialledIn = derivedWorkflow({ targetYield: 43 });
    const database = await server.connectDatabase();
    try {
      // Holds the Workflow's storage once it has begun, until its connection is gone.
      await database.query("BEGIN");
      await database.query("LOCK TABLE workflow_events IN ACCESS EXCLUSIVE MODE");
      tablet.setWorkflow(dialledIn);
      await waitForLockWaits(server, { relation: "workflow_events" });
      // The tablet moves onto the destination's machine, losing its connection, and with it the acknowledgment.
      tablet.serve(derivedDe1Pro({ serial: "20302" }));
      tablet.dropConnections();
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
    await api.waitForMachine("Moved mid-delivery", (candidate) => candidate.online && candidate.identification === "mismatch");
    await expect.poll(async () => (await currentWorkflow(destination))?.workflow, { timeout: 10_000 }).toEqual(dialledIn);
    expect((await workflowEvents(machine)).events.map((event) => event.workflow)).toEqual([dialledIn, workflowFixture()]);
  }, 20_000);

  it("decides deliveries for one Machine that arrive at once one at a time, on any instance", async () => {
    // The owner's connection is silent while the test holds its Machine's row, for longer than this file's instances
    // allow, as waiting for a lock may take up to 4 s; it goes through an instance that allows a minute.
    const patient = await startTestServer({ env: { ...env, SYNC_HEARTBEAT_SECONDS: "20" }, sharing: server });
    try {
      const owner = await api.createMachine("Busy owner");
      const visitor = await api.createMachine("Visitor");
      await (await connect(visitor, other.url, { model: "DE1Pro", serial: "20202" })).close();
      const own = await connect(owner, patient.url, { model: "DE1Pro", serial: "20201" }, SILENT);
      await own.deliver(stateDelivery("idle", "idle", "2026-10-05T13:00:00.000Z"));
      // The visitor's tablet, moved onto the owner's machine: its events are the owner's.
      const moved = await connect(visitor, other.url, { model: "DE1Pro", serial: "20201" });
      const fromOwner = stateDelivery("espresso", "pouring", "2026-10-05T13:01:00.000Z");
      const fromVisitor = stateDelivery("espresso", "pouring", "2026-10-05T13:01:00.500Z");
      const acked = (raw: RawConnection, id: string) => raw.messages.some((reply) => frameType(reply) === "ack" && (reply as Frame).id === id);
      const database = await server.connectDatabase();
      try {
        // Both are held as they start to be handled, at the owner's row, which each locks before it writes anything,
        // so they arrive at once; let go, the owner's Machine decides them one at a time, each against what the other
        // stored.
        await database.query("BEGIN");
        await database.query("SELECT 1 FROM machines WHERE id = $1 FOR NO KEY UPDATE", [owner.machine.id]);
        own.send(fromOwner);
        moved.send(fromVisitor);
        await waitForLockWaits(server, { count: 2 });
        expect(acked(own, fromOwner.id) || acked(moved, fromVisitor.id)).toBe(false);
        await database.query("COMMIT");
      } finally {
        await database.end();
      }
      await expect.poll(() => acked(own, fromOwner.id) && acked(moved, fromVisitor.id)).toBe(true);
      expect(await transitions(owner)).toEqual([["idle", "idle"], ["espresso", "pouring"]]);
      expect((await stateEvents(visitor)).total).toBe(0);
    } finally {
      await patient.stop();
    }
  }, 30_000);

  it("credits a mismatched connection's delivery once, to the Machine that has its hardware or its Pending Machine, however often it arrives", async () => {
    const owner = await api.createMachine("Owner of 20601");
    await (await connect(owner, server.url, { model: "DE1Pro", serial: "20601" })).close();
    const visitor = await api.createMachine("Visitor of 20601");
    await (await connect(visitor, server.url, { model: "DE1Pro", serial: "20602" })).close();
    const dialledIn = derivedWorkflow({ targetYield: 46 });
    // The visitor's tablet moves onto the owner's machine, then onto one no Machine has.
    for (const serial of ["20601", "20603"]) {
      const hardware = { model: "DE1Pro", serial };
      const pouring = stateDelivery("espresso", "pouring", "2026-10-05T16:00:00.000Z");
      const loaded = workflowDelivery(dialledIn, "2026-10-05T16:00:00.000Z");
      const first = await connect(visitor, server.url, hardware);
      await first.deliver(pouring);
      await first.deliver(loaded);
      await first.close();
      // After later changes, the first deliveries again, through another instance, as after lost acknowledgments.
      const second = await connect(visitor, other.url, hardware);
      await second.deliver(stateDelivery("idle", "idle", "2026-10-05T16:01:00.000Z"));
      await second.deliver(workflowDelivery(workflowFixture(), "2026-10-05T16:01:00.000Z"));
      await second.deliver(pouring);
      await second.deliver(loaded);
      await second.close();
    }
    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "20603")!;
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Adopted 20603" }));
    for (const credited of [owner, adopted]) {
      expect(await transitions(credited)).toEqual([["espresso", "pouring"], ["idle", "idle"]]);
      expect((await workflowEvents(credited)).events.map((event) => event.workflow)).toEqual([workflowFixture(), dialledIn]);
    }
    expect((await stateEvents(visitor)).total).toBe(0);
    expect((await workflowEvents(visitor)).total).toBe(0);
  });

  it("refuses a state change timed by the tablet's local clock rather than in UTC, storing nothing", async () => {
    const machine = await api.createMachine("Local times");
    const raw = await connect(machine);
    // A stateUpdate's own timestamp, which has no offset.
    raw.send(stateDelivery("espresso", "pouring", "2026-10-05T10:05:43.648490"));
    expect(await raw.closed).toMatchObject({ code: CLOSE_CODES.protocol_error });
    expect((await stateEvents(machine)).total).toBe(0);
  });
});
