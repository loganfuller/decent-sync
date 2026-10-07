import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { RawConnection, derivedWorkflow, helloWith, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, type TestServerOptions, startTestServer } from "./support/test-server.js";

// Seam 1 for #67: recorded delivery ids are deleted once recorded more than
// 90 days ago, by PostgreSQL's clock, on every server instance as it starts
// and hourly. Deliveries are raw frames against real servers sharing one
// PostgreSQL database, with events read through the REST API. Ids are aged
// through the database directly, as waiting 90 days would not fit in a test,
// and each cleanup run is the one an instance makes as it starts.
// delivery-id-cleanup.test.ts covers the hourly timer and shutdown;
// machine-events.test.ts and collections.test.ts cover resends of ids still
// recorded.

const DAY_MS = 24 * 60 * 60_000;
/** What an instance logs once its cleanup has deleted something. */
const DELETED = /Deleted (\d+) delivery ids recorded more than 90 days ago/;

interface Delivery { id: string; [field: string]: unknown }

describe("delivery id retention", { timeout: 30_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let database: pg.Client;
  const instances: TestServer[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    database = await server.connectDatabase();
  }, 60_000);
  afterEach(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await Promise.all(instances.splice(0).map((instance) => instance.stop()));
  });
  afterAll(async () => {
    await database?.end();
    await server?.stop();
  });

  /** Starts another instance on the database; its cleanup runs as it starts. */
  async function startInstance(options: TestServerOptions = {}) {
    const instance = await startTestServer({ env, sharing: server, ...options });
    instances.push(instance);
    return instance;
  }
  /** How many delivery ids the instance's cleanup deleted, once it logs that it deleted some. */
  async function deletedBy(instance: TestServer): Promise<number> {
    await expect.poll(() => DELETED.test(instance.output()), { timeout: 10_000 }).toBe(true);
    expect(instance.output()).not.toContain("Could not delete delivery ids");
    return Number(DELETED.exec(instance.output())![1]);
  }
  async function connect(machine: CreatedMachine, serial: string) {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial } }));
    raws.push(raw);
    return raw;
  }
  async function get<T>(path: string): Promise<T> {
    const response = await api.call("GET", path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  const transitions = async (machine: CreatedMachine) =>
    (await get<{ events: { state: string; substate: string }[] }>(`/machines/${machine.machine.id}/machine-state-events?limit=100`)).events
      .map((event) => [event.state, event.substate])
      .reverse();
  const workflows = async (machine: CreatedMachine) =>
    (await get<{ events: { workflow: unknown }[] }>(`/machines/${machine.machine.id}/workflow-events?limit=100`)).events
      .map((event) => event.workflow)
      .reverse();
  const grinders = async (machine: CreatedMachine) =>
    (await get<{ collection: { value: unknown } | null }>(`/machines/${machine.machine.id}/collections/grinders`)).collection?.value;
  /** The delivery ids recorded for the Machine's token. */
  const recorded = async (machine: CreatedMachine) =>
    (await database.query<{ id: string }>("SELECT delivery_id AS id FROM machine_event_deliveries WHERE machine_id = $1", [machine.machine.id])).rows
      .map((row) => row.id)
      .sort();
  /** Sets when the deliveries were recorded to this long ago, by the database's clock. */
  const recordedAgo = (deliveries: Delivery[], interval: string) =>
    database.query("UPDATE machine_event_deliveries SET received_at = now() - $2::interval WHERE delivery_id = ANY($1)", [
      deliveries.map((delivery) => delivery.id),
      interval,
    ]);
  const ids = (deliveries: Delivery[]) => deliveries.map((delivery) => delivery.id).sort();

  const state = (state: string, substate: string): Delivery =>
    ({ type: "machineState", id: randomUUID(), observedAt: new Date().toISOString(), state, substate });
  const workflow = (workflow: Record<string, unknown>): Delivery =>
    ({ type: "workflow", id: randomUUID(), observedAt: new Date().toISOString(), workflow });
  const grindersCollection = (names: string[]): Delivery =>
    ({ type: "collection", id: randomUUID(), name: "grinders", available: true, value: names.map((name) => ({ id: name, name })) });

  it("deletes the delivery ids recorded more than 90 days ago by the database's clock, keeping younger ones, whose resends still change nothing", async () => {
    const machine = await api.createMachine("Ageing deliveries");
    const raw = await connect(machine, "30101");
    const pulled = workflowFixture();
    const dialledIn = derivedWorkflow({ targetYield: 38 });
    const old = [state("idle", "idle"), workflow(pulled), grindersCollection(["Lab grinder"])];
    const kept = [state("espresso", "pouring"), workflow(dialledIn), grindersCollection(["Lab grinder", "Backup grinder"])];
    // Back to the old values, so a kept delivery stored again would be a change.
    const recent = [state("idle", "idle"), workflow(pulled), grindersCollection(["Lab grinder"])];
    for (const delivery of [...old, ...kept, ...recent]) await raw.deliver(delivery);
    await recordedAgo(old, "90 days 1 minute");
    await recordedAgo(kept, "89 days 23 hours");

    // Its clock runs two days ahead: by that clock, the kept ids would be more than 90 days old.
    const instance = await startInstance({ clockOffsetMs: 2 * DAY_MS });
    expect(await deletedBy(instance)).toBe(old.length);
    expect(await recorded(machine)).toEqual(ids([...kept, ...recent]));

    for (const delivery of kept) await raw.deliver(delivery);
    expect(await transitions(machine)).toEqual([["idle", "idle"], ["espresso", "pouring"], ["idle", "idle"]]);
    expect(await workflows(machine)).toEqual([pulled, dialledIn, pulled]);
    expect(await grinders(machine)).toEqual([{ id: "Lab grinder", name: "Lab grinder" }]);
  });

  it("deletes on two instances at once, each skipping what the other is deleting, leaving exactly the ids recorded within 90 days", async () => {
    const machine = await api.createMachine("Long history");
    // Ten batches of ids past 90 days, and some within it, written straight to the database.
    const insert = (prefix: string, count: number, age: string) =>
      database.query(
        `INSERT INTO machine_event_deliveries (machine_id, delivery_id, received_at)
         SELECT $1, $2 || n, now() - $3::interval - n * interval '1 second' FROM generate_series(1, $4::integer) AS n`,
        [machine.machine.id, prefix, age, count],
      );
    await insert("old-", 10_000, "90 days");
    await insert("kept-", 500, "89 days");

    const lock = await server.connectDatabase();
    let ahead: TestServer;
    let behind: TestServer;
    try {
      // Holds both instances' first statements until both have started, so they delete at once.
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE machine_event_deliveries IN SHARE MODE");
      // By their own clocks, the one ahead would delete ids within 90 days, and the one behind none at all.
      [ahead, behind] = await Promise.all([
        startInstance({ clockOffsetMs: 2 * DAY_MS }),
        startInstance({ clockOffsetMs: -2 * DAY_MS }),
      ]);
      await waitForLockWaits(server, { relation: "machine_event_deliveries", count: 2 });
      await lock.query("COMMIT");
    } finally {
      await lock.end();
    }

    // Each deleted some, together all, without failing.
    const [byAhead, byBehind] = await Promise.all([deletedBy(ahead), deletedBy(behind)]);
    expect(byAhead + byBehind).toBe(10_000);
    expect(await recorded(machine)).toEqual(Array.from({ length: 500 }, (_, n) => `kept-${n + 1}`).sort());
  });

  it("deletes while a delivery is being stored and another transaction holds an old id, waiting for neither, and deletes that id once let go", async () => {
    const machine = await api.createMachine("Storing while deleting");
    const raw = await connect(machine, "30301");
    const held = state("idle", "idle");
    const unheld = state("espresso", "pouring");
    await raw.deliver(held);
    await raw.deliver(unheld);
    await recordedAgo([held, unheld], "91 days");

    const storing = state("idle", "idle");
    const holder = await server.connectDatabase();
    try {
      await holder.query("BEGIN");
      // Another transaction holds an old id's row, as deleting its Machine would.
      await holder.query("SELECT 1 FROM machine_event_deliveries WHERE delivery_id = $1 FOR UPDATE", [held.id]);
      // And the Machine's row, so a delivery waits there having recorded its id, its row locked until it commits.
      await holder.query("SELECT 1 FROM machines WHERE id = $1 FOR NO KEY UPDATE", [machine.machine.id]);
      raw.send(storing);
      await waitForLockWaits(server);

      const instance = await startInstance();
      expect(await deletedBy(instance)).toBe(1);
      expect(raw.acks(storing.id)).toBe(0);
      await holder.query("COMMIT");
    } finally {
      await holder.end();
    }
    await raw.acknowledged(storing.id);
    expect(await transitions(machine)).toEqual([["idle", "idle"], ["espresso", "pouring"], ["idle", "idle"]]);
    expect(await recorded(machine)).toEqual(ids([held, storing]));

    // The next run deletes the id it skipped.
    const next = await startInstance();
    expect(await deletedBy(next)).toBe(1);
    expect(await recorded(machine)).toEqual([storing.id]);
  });
});
