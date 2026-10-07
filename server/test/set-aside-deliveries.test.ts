import { randomUUID } from "node:crypto";
import { type Chunk, MAX_RECORD_ID_LENGTH, frames } from "@decent-sync/protocol";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { type PoolerProxy, startPoolerProxy } from "./support/pooler-proxy.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { derivedSteam } from "./support/steam-fixtures.js";
import { RawConnection, de1ProOnDecaid087, helloWith, workflowFixture } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #60: deliveries whose storage fails the same way every
// time they arrive are set aside and acknowledged, so the deliveries after
// them still flow. Raw frames go to real servers sharing PostgreSQL, the
// second through a stand-in pooler whose connections the test can reset;
// assertions are made through the REST API, and through the database for the
// messages kept, which the API never lists. Records are derived from the real
// ones in the fixtures. Failures a retry may not meet are simulated by a
// trigger, a lock and a reset the test controls.

interface Received {
  type: string;
  id?: string;
  shotIds?: string[];
  steamIds?: string[];
}

interface SetAsideView {
  id: string;
  receivedAt: string;
  type: string;
  deliveryId: string;
  recordId: string | null;
  sqlState: string;
  error: string;
}

/** The advisory lock class `ShotsService` takes for one Shot id. */
const SHOT_LOCK = 4_000_003;
/** Received when the server closes a connection after failing to handle a message. */
const INTERNAL_ERROR = 1011;

describe("Deliveries that cannot be stored", () => {
  let server: TestServer;
  let other: TestServer;
  let pooler: PoolerProxy;
  let api: AdminApi;
  let database: pg.Client;
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
    pooler = await startPoolerProxy();
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server, databaseHost: pooler.host });
    api = await AdminApi.setUp(server.url);
    database = await server.connectDatabase();
  }, 60_000);
  afterEach(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await database?.end();
    await other?.stop();
    await server?.stop();
    await pooler?.close();
  });

  async function connect(machine: CreatedMachine, url = server.url) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token));
    raws.push(raw);
    return raw;
  }
  const received = (raw: RawConnection, type: string) => (raw.messages as Received[]).filter((message) => message.type === type);
  /** Sends an index and resolves with the request it was answered with, once it is acknowledged. */
  async function requestFor(raw: RawConnection, index: { id: string }, type: string) {
    const before = received(raw, type).length;
    await raw.deliver(index);
    const requests = received(raw, type);
    expect(requests).toHaveLength(before + 1);
    return requests.at(-1);
  }
  async function get(path: string): Promise<unknown> {
    const response = await api.call("GET", path);
    expect(response.status).toBe(200);
    return response.json();
  }
  async function setAside(machine: CreatedMachine): Promise<{ deliveries: SetAsideView[]; total: number }> {
    return (await get(`/machines/${machine.machine.id}/set-aside-deliveries?limit=100`)) as { deliveries: SetAsideView[]; total: number };
  }
  /** The messages kept for a Machine's deliveries set aside, by delivery id. */
  async function keptMessages(machine: CreatedMachine): Promise<Record<string, string>> {
    const { rows } = await database.query<{ delivery_id: string; message: string }>(
      "SELECT delivery_id, message FROM set_aside_deliveries WHERE machine_id = $1",
      [machine.machine.id],
    );
    return Object.fromEntries(rows.map((row) => [row.delivery_id, row.message]));
  }
  async function status(path: string): Promise<number> {
    return (await api.call("GET", path)).status;
  }

  /** A real Shot naming no hardware, so it is credited to the Machine whose tablet sends it. */
  function shot(id: string, changes: Record<string, unknown> = {}) {
    const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    return derivedShot(id, { workflow, ...changes });
  }
  /** A Shot whose notes hold a NUL, which neither jsonb nor text can hold. */
  const nulShot = (id: string) => shot(id, { annotations: { espressoNotes: "Bright\u0000, sweet" } });
  const shotDelivery = (record: Record<string, unknown>) => ({ type: "shot", id: randomUUID(), shotId: String(record.id), shot: record });
  const steamDelivery = (record: Record<string, unknown>) =>
    ({ type: "steam", id: randomUUID(), steamId: String(record.id), steamedAt: "2026-10-05T14:07:03.341Z", steam: record });
  const shotIndex = (...ids: string[]) => ({ type: "shotIndex", id: randomUUID(), shots: ids.map((id) => ({ id })) });
  const steamIndex = (...ids: string[]) => ({ type: "steamIndex", id: randomUUID(), steams: ids.map((id) => ({ id })) });
  const report = (name: string, value: unknown) => ({ type: "collection", id: randomUUID(), name, available: true, value });

  describe("whose storage fails the same way every time", () => {
    runAsSteps();
    let machine: CreatedMachine;
    let nul: ReturnType<typeof shotDelivery>;
    let steam: ReturnType<typeof steamDelivery>;

    it("are set aside and acknowledged, without closing the connection, and the deliveries after them are stored", async () => {
      machine = await api.createMachine("Bar 1");
      const raw = await connect(machine);
      nul = shotDelivery(nulShot("nul-shot"));
      await raw.deliver(nul);
      await raw.deliver(shotDelivery(shot("after-nul-shot")));

      expect(await status("/shots/after-nul-shot")).toBe(200);
      expect(await status("/shots/nul-shot")).toBe(404);
      const listed = await setAside(machine);
      expect(listed).toEqual({
        total: 1,
        limit: 100,
        offset: 0,
        deliveries: [
          {
            id: expect.any(String),
            receivedAt: expect.any(String),
            type: "shot",
            deliveryId: nul.id,
            recordId: "nul-shot",
            sqlState: expect.stringMatching(/^(?:22P05|22021)$/),
            error: expect.stringMatching(/\S/),
          },
        ],
      });
      // As received: the message's JSON text, its escaped NUL intact.
      expect(await keptMessages(machine)).toEqual({ [nul.id]: JSON.stringify(nul) });
      expect(JSON.stringify(nul)).toContain("\\u0000");
      expect(received(raw, "error")).toEqual([]);
    });

    it("are set aside whatever was captured: a Steam Record, an edit, a Workflow, a machine state and a collection", async () => {
      const raw = await connect(machine);
      steam = steamDelivery(derivedSteam("nul-steam", { workflow: { ...workflowFixture(), name: "Steam\u0000" } }));
      const settings = de1ProOnDecaid087()["/machine/settings"] as Record<string, unknown>;
      const { measurements, ...metadata } = shot("after-nul-shot");
      const failing = {
        steam,
        edit: { type: "shotUpdated", id: randomUUID(), shotId: "after-nul-shot", shot: { ...metadata, updatedAt: "2026-10-06T09:00:00Z", annotations: { espressoNotes: "\u0000" } } },
        workflow: { type: "workflow", id: randomUUID(), observedAt: "2026-10-05T12:00:00.000Z", workflow: { ...workflowFixture(), name: "\u0000" } },
        state: { type: "machineState", id: randomUUID(), observedAt: "2026-10-05T12:00:00.000Z", state: "idle", substate: "\u0000" },
        // A lone surrogate, which JSON can escape but jsonb refuses.
        collection: report("machineSettings", { ...settings, note: "\ud800" }),
      };
      for (const delivery of Object.values(failing)) await raw.deliver(delivery);
      await raw.deliver(steamDelivery(derivedSteam("after-nul-steam")));
      await raw.deliver(report("machineSettings", settings));

      expect(await status("/steam-records/after-nul-steam")).toBe(200);
      expect(await status("/steam-records/nul-steam")).toBe(404);
      expect(await get(`/machines/${machine.machine.id}/collections/machineSettings`)).toMatchObject({ collection: { value: settings } });
      expect(await get(`/machines/${machine.machine.id}/workflow-events`)).toMatchObject({ total: 0 });
      expect(await get(`/machines/${machine.machine.id}/machine-state-events`)).toMatchObject({ total: 0 });
      expect(await get("/shots/after-nul-shot")).toMatchObject({ shot: { record: { annotations: shot("after-nul-shot").annotations } } });

      const listed = await setAside(machine);
      expect(listed.total).toBe(6);
      // Latest first.
      expect(listed.deliveries.map(({ type, deliveryId, recordId }) => ({ type, deliveryId, recordId }))).toEqual([
        { type: "collection", deliveryId: failing.collection.id, recordId: null },
        { type: "machineState", deliveryId: failing.state.id, recordId: null },
        { type: "workflow", deliveryId: failing.workflow.id, recordId: null },
        { type: "shotUpdated", deliveryId: failing.edit.id, recordId: "after-nul-shot" },
        { type: "steam", deliveryId: steam.id, recordId: "nul-steam" },
        { type: "shot", deliveryId: nul.id, recordId: "nul-shot" },
      ]);
      const sqlStates = Object.fromEntries(listed.deliveries.map((delivery) => [delivery.type, delivery.sqlState]));
      expect(sqlStates).toEqual({
        collection: "22P02",
        machineState: "22021",
        workflow: "22P05",
        shotUpdated: expect.stringMatching(/^(?:22P05|22021)$/),
        steam: expect.stringMatching(/^(?:22P05|22021)$/),
        shot: expect.stringMatching(/^(?:22P05|22021)$/),
      });
      const kept = await keptMessages(machine);
      for (const delivery of Object.values(failing)) expect(kept[delivery.id]).toBe(JSON.stringify(delivery));
    });

    it("are set aside as received when sent in chunks", async () => {
      const raw = await connect(machine);
      const delivery = shotDelivery(nulShot("chunked-nul-shot"));
      const pieces = frames(JSON.stringify(delivery), delivery.id, 4096).map((frame) => JSON.parse(frame.text) as Chunk);
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) raw.send(piece);
      await raw.acknowledged(delivery.id);
      expect((await keptMessages(machine))[delivery.id]).toBe(JSON.stringify(delivery));
    });

    it("count as known to that Machine's indexes, so they are not requested again", async () => {
      const raw = await connect(machine);
      expect(await requestFor(raw, shotIndex("nul-shot", "chunked-nul-shot", "missing-shot"), "requestShots")).toEqual({
        type: "requestShots",
        shotIds: ["missing-shot"],
      });
      expect(await requestFor(raw, steamIndex("nul-steam", "missing-steam"), "requestSteams")).toEqual({
        type: "requestSteams",
        steamIds: ["missing-steam"],
      });
      // An edit set aside counts the Shot as known too, even at a newer version.
      const newer = { type: "shotIndex", id: randomUUID(), shots: [{ id: "after-nul-shot", updatedAt: "2026-10-07T09:00:00Z" }] };
      expect(await requestFor(raw, newer, "requestShots")).toEqual({ type: "requestShots", shotIds: [] });

      // Another Machine's tablet has not had them set aside.
      const elsewhere = await connect(await api.createMachine("Bar 2"));
      expect(await requestFor(elsewhere, shotIndex("nul-shot"), "requestShots")).toEqual({ type: "requestShots", shotIds: ["nul-shot"] });
      expect(await requestFor(elsewhere, steamIndex("nul-steam"), "requestSteams")).toEqual({ type: "requestSteams", steamIds: ["nul-steam"] });
    });

    it("are acknowledged when sent again, on another connection or instance, and recorded once", async () => {
      const before = await setAside(machine);
      for (const url of [server.url, other.url]) {
        const raw = await connect(machine, url);
        await raw.deliver(nul);
        await raw.deliver(steam);
      }
      expect(await setAside(machine)).toEqual(before);
    });
  });

  it("acknowledges a Shot or Steam Record whose id the server cannot store without storing it, and never requests one", async () => {
    const machine = await api.createMachine("Bar 3");
    const raw = await connect(machine);
    const longId = "x".repeat(MAX_RECORD_ID_LENGTH + 1);
    const nulId = "nul\u0000id";
    for (const id of [longId, nulId]) {
      await raw.deliver(shotDelivery(shot(id)));
      await raw.deliver(steamDelivery(derivedSteam(id)));
    }
    await raw.deliver(shotDelivery(shot("y".repeat(MAX_RECORD_ID_LENGTH))));

    expect(await get(`/shots?machineId=${machine.machine.id}`)).toMatchObject({ total: 1, shots: [{ id: "y".repeat(MAX_RECORD_ID_LENGTH) }] });
    expect(await get(`/steam-records?machineId=${machine.machine.id}`)).toMatchObject({ total: 0 });
    expect(await setAside(machine)).toMatchObject({ total: 0 });
    expect(await requestFor(raw, shotIndex(longId, nulId, "missing-shot"), "requestShots")).toEqual({ type: "requestShots", shotIds: ["missing-shot"] });
    expect(await requestFor(raw, steamIndex(longId, nulId), "requestSteams")).toEqual({ type: "requestSteams", steamIds: [] });
    expect(received(raw, "error")).toEqual([]);
  });

  describe("whose storage fails in a way storing again may not", () => {
    beforeAll(async () => {
      // Inserting a Shot listed here fails with its SQLSTATE, until the test removes it.
      await database.query(`
        CREATE TABLE failing_shots (id text PRIMARY KEY, sql_state text NOT NULL);
        CREATE FUNCTION fail_storing_shot() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE code text;
        BEGIN
          SELECT sql_state INTO code FROM failing_shots WHERE id = NEW.id;
          IF code IS NOT NULL THEN RAISE EXCEPTION 'Simulated failure' USING ERRCODE = code; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fail_storing_shot BEFORE INSERT ON shots FOR EACH ROW EXECUTE FUNCTION fail_storing_shot();
      `);
    });

    /** Expects the delivery's connection closed with 1011, the delivery neither acknowledged, stored nor set aside, then stored once sent again. */
    async function closedThenStored(machine: CreatedMachine, raw: RawConnection, delivery: ReturnType<typeof shotDelivery>, fix: () => Promise<void>) {
      expect(await raw.closed).toEqual({ code: INTERNAL_ERROR, reason: "Server error" });
      expect(raw.acks(delivery.id)).toBe(0);
      expect(await status(`/shots/${delivery.shotId}`)).toBe(404);
      expect(await setAside(machine)).toMatchObject({ total: 0 });

      await fix();
      const again = await connect(machine);
      await again.deliver(delivery);
      expect(await status(`/shots/${delivery.shotId}`)).toBe(200);
      expect(await setAside(machine)).toMatchObject({ total: 0 });
    }

    for (const [failure, sqlState] of [["a deadlock", "40P01"], ["a lock timeout", "55P03"], ["a serialization failure", "40001"]] as const) {
      it(`closes the connection with 1011 after ${failure}, leaving the delivery to be sent again`, async () => {
        const machine = await api.createMachine(`Failing with ${sqlState}`);
        const delivery = shotDelivery(shot(`failing-${sqlState}`));
        await database.query("INSERT INTO failing_shots (id, sql_state) VALUES ($1, $2)", [delivery.shotId, sqlState]);
        const raw = await connect(machine);
        raw.send(delivery);
        await closedThenStored(machine, raw, delivery, async () => {
          await database.query("DELETE FROM failing_shots WHERE id = $1", [delivery.shotId]);
        });
      });
    }

    it("closes the connection with 1011 after losing the database connection, an error with no SQLSTATE", async () => {
      const machine = await api.createMachine("Lost database");
      const delivery = shotDelivery(shot("lost-connection-shot"));
      // Holds the Shot's lock, so the delivery is being stored when the connection goes.
      await database.query("SELECT pg_advisory_lock($1::int, hashtext($2::text))", [SHOT_LOCK, delivery.shotId]);
      try {
        const raw = await connect(machine, other.url);
        raw.send(delivery);
        await waitForLockWaits(server, { advisory: true });
        pooler.resetConnections();
        expect(await raw.closed).toEqual({ code: INTERNAL_ERROR, reason: "Server error" });
        expect(raw.acks(delivery.id)).toBe(0);
      } finally {
        await database.query("SELECT pg_advisory_unlock($1::int, hashtext($2::text))", [SHOT_LOCK, delivery.shotId]);
      }
      expect(await status(`/shots/${delivery.shotId}`)).toBe(404);
      expect(await setAside(machine)).toMatchObject({ total: 0 });

      const again = await connect(machine, other.url);
      await again.deliver(delivery);
      expect(await status(`/shots/${delivery.shotId}`)).toBe(200);
    });
  });
});
