import { randomUUID } from "node:crypto";
import { CLOSE_CODES, type Chunk, MAX_ID_LENGTH, frames } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HANDLED_DELIVERY_LIMITS } from "../src/sync/handled-deliveries.js";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { derivedSteam } from "./support/steam-fixtures.js";
import { RawConnection, de1ProOnDecaid087, derivedWorkflow, helloWith, workflowFixture } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #42: deliveries sent again on the connection that first
// sent them, and ids longer than the protocol allows, as raw frames to real
// servers sharing PostgreSQL, with assertions through the REST API. Records
// are derived from the real ones in the fixtures.

interface Received {
  type: string;
  id?: string;
  code?: string;
  message?: string;
  shotIds?: string[];
}

describe("Deliveries sent again on one connection", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  async function connect(machine: CreatedMachine, url = server.url) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token));
    raws.push(raw);
    return raw;
  }
  const received = (raw: RawConnection, type: string) => (raw.messages as Received[]).filter((message) => message.type === type);
  /** Sends an index and resolves with the request it was answered with, once it is acknowledged. */
  async function requestFor(raw: RawConnection, index: { id: string }, type = "requestShots") {
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

  /** A real Shot naming no hardware, so it is credited to the Machine whose tablet sends it. */
  function shot(id: string, changes: Record<string, unknown> = {}) {
    const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    return derivedShot(id, { workflow, ...changes });
  }
  /** An edit of a Shot, as Decaid's event gives it: its metadata, without measurements. */
  function edit(record: Record<string, unknown>, updatedAt: string, enjoyment: number) {
    const { measurements, ...metadata } = record;
    return { type: "shotUpdated", id: randomUUID(), shotId: record.id, shot: { ...metadata, updatedAt, annotations: { enjoyment } } };
  }
  const shotDelivery = (record: Record<string, unknown>) => ({ type: "shot", id: randomUUID(), shotId: record.id, shot: record });
  const shotIndex = (...ids: string[]) => ({ type: "shotIndex", id: randomUUID(), shots: ids.map((id) => ({ id })) });
  const state = (state: string, substate: string, observedAt: string) => ({ type: "machineState", id: randomUUID(), observedAt, state, substate });
  const workflow = (value: Record<string, unknown>, observedAt: string) => ({ type: "workflow", id: randomUUID(), observedAt, workflow: value });
  const report = (name: string, value: unknown) => ({ type: "collection", id: randomUUID(), name, available: true, value });

  it("changes nothing, and is acknowledged, after more deliveries than the connection remembers, whatever was delivered", async () => {
    const machine = await api.createMachine("Long connection");
    const raw = await connect(machine);
    const replayedShot = shot("replayed-shot");
    const steam = derivedSteam("replayed-steam");
    const settings = de1ProOnDecaid087()["/machine/settings"] as Record<string, unknown>;

    // One of each delivery, each later followed by a newer one where there can be one.
    const earliest = {
      index: shotIndex("replayed-shot", "indexed-shot"),
      shot: shotDelivery(replayedShot),
      edit: edit(replayedShot, "2026-10-05T09:00:00Z", 1),
      steam: { type: "steam", id: randomUUID(), steamId: steam.id, steamedAt: "2026-10-05T14:07:03.341Z", steam },
      steamIndex: { type: "steamIndex", id: randomUUID(), steams: [{ id: "replayed-steam" }, { id: "indexed-steam" }] },
      workflow: workflow(workflowFixture(), "2026-10-05T12:00:00.000Z"),
      state: state("idle", "idle", "2026-10-05T12:00:00.000Z"),
      collection: report("machineSettings", { ...settings, fan: 40 }),
    };
    expect(await requestFor(raw, earliest.index)).toEqual({ type: "requestShots", shotIds: ["replayed-shot", "indexed-shot"] });
    for (const delivery of Object.values(earliest).slice(1)) await raw.deliver(delivery);
    await raw.deliver(edit(replayedShot, "2026-10-05T10:00:00Z", 2));
    await raw.deliver(shotDelivery(shot("indexed-shot")));
    const dialledIn = derivedWorkflow({ targetYield: 40 });
    await raw.deliver(workflow(dialledIn, "2026-10-05T12:01:00.000Z"));
    await raw.deliver(report("machineSettings", { ...settings, fan: 45 }));
    // More state transitions than the connection remembers deliveries, from idle to espresso and back, ending in espresso.
    const transitions = HANDLED_DELIVERY_LIMITS.maxDeliveries + 1;
    for (let n = 0; n < transitions; n++) {
      const observedAt = new Date(Date.parse("2026-10-05T12:02:00.000Z") + n * 1000).toISOString();
      await raw.deliver(n % 2 === 0 ? state("espresso", "pouring", observedAt) : state("idle", "idle", observedAt));
    }

    const visible = async () => ({
      shots: await get(`/shots?limit=100&machineId=${machine.machine.id}`),
      shot: await get("/shots/replayed-shot"),
      measurements: await get("/shots/replayed-shot/measurements"),
      steamRecords: await get(`/steam-records?limit=100&machineId=${machine.machine.id}`),
      steam: await get("/steam-records/replayed-steam"),
      workflowEvents: await get(`/machines/${machine.machine.id}/workflow-events?limit=100`),
      stateEvents: await get(`/machines/${machine.machine.id}/machine-state-events?limit=100`),
      collection: await get(`/machines/${machine.machine.id}/collections/machineSettings`),
    });
    const before = await visible();
    expect(before.shot).toMatchObject({ shot: { enjoyment: 2 } });
    expect(await get(`/machines/${machine.machine.id}/workflow-events?limit=1`)).toMatchObject({ total: 2, events: [{ workflow: dialledIn }] });
    expect(await get(`/machines/${machine.machine.id}/machine-state-events?limit=1`)).toMatchObject({
      total: transitions + 1,
      events: [{ state: "espresso", substate: "pouring" }],
    });
    expect(before.collection).toMatchObject({ collection: { value: { fan: 45 } } });

    // Each earliest delivery again: a stale edit, Workflow, state and value among them.
    for (const delivery of Object.values(earliest)) await raw.deliver(delivery);
    expect(await visible()).toEqual(before);
    // The earliest index was forgotten, so it is answered from what is stored now.
    expect(received(raw, "requestShots").at(-1)).toEqual({ type: "requestShots", shotIds: [] });
    expect(received(raw, "requestSteams").at(-1)).toEqual({ type: "requestSteams", steamIds: ["indexed-steam"] });

    // So does a connection to another instance, which never handled them.
    const elsewhere = await connect(machine, other.url);
    for (const delivery of Object.values(earliest)) await elsewhere.deliver(delivery);
    expect(await visible()).toEqual(before);
  }, 30_000);

  it("answers a recent index sent again with the request it was answered with", async () => {
    const machine = await api.createMachine("Recent index");
    const raw = await connect(machine);
    const index = shotIndex("recently-requested", "still-missing");
    const request = { type: "requestShots", shotIds: ["recently-requested", "still-missing"] };
    expect(await requestFor(raw, index)).toEqual(request);
    const steamIndex = { type: "steamIndex", id: randomUUID(), steams: [{ id: "recent-steam" }] };
    expect(await requestFor(raw, steamIndex, "requestSteams")).toEqual({ type: "requestSteams", steamIds: ["recent-steam"] });
    await raw.deliver(shotDelivery(shot("recently-requested")));

    // Its request is sent again, ahead of its acknowledgment, as first answered.
    expect(await requestFor(raw, index)).toEqual(request);
    const ack = (raw.messages as Received[]).map((message) => message.type === "ack" && message.id === index.id).lastIndexOf(true);
    expect(raw.messages[ack - 1]).toEqual(request);
    expect(await requestFor(raw, steamIndex, "requestSteams")).toEqual({ type: "requestSteams", steamIds: ["recent-steam"] });
    expect(await get(`/shots?limit=100&machineId=${machine.machine.id}`)).toMatchObject({ total: 1 });
  });

  it("forgets earlier deliveries sooner while indexes were answered with many long ids", async () => {
    const machine = await api.createMachine("Long requests");
    const raw = await connect(machine);
    // Decaid's ids are UUIDs. Ids this long fill what the connection may hold in a few requests.
    const longIds = (page: string) => Array.from({ length: 99 }, (_, n) => `${page}-${n}-`.padEnd(1_000, "x"));
    const pages = Math.ceil(HANDLED_DELIVERY_LIMITS.maxLength / 100_000);
    // Too few deliveries for their number alone to make the connection forget any.
    expect(2 + pages).toBeLessThanOrEqual(HANDLED_DELIVERY_LIMITS.maxDeliveries);
    // Answered in no particular order.
    const requested = async (index: { id: string }) => [...(await requestFor(raw, index))!.shotIds!].sort();
    const first = shotIndex("stored-later", ...longIds("first"));
    expect(await requested(first)).toEqual(["stored-later", ...longIds("first")].sort());
    await raw.deliver(shotDelivery(shot("stored-later")));
    for (let page = 0; page < pages; page++) await requested(shotIndex(`page-${page}`, ...longIds(`page-${page}`)));

    // Forgotten, the first index is answered from what is stored now.
    expect(await requested(first)).toEqual(longIds("first").sort());
  });

  describe("an id longer than the protocol allows", () => {
    const longId = "x".repeat(MAX_ID_LENGTH + 1);
    const refusal = (field: string) => ({ type: "error", code: "protocol_error", message: `${field} must be at most ${MAX_ID_LENGTH} characters` });

    async function refused(raw: RawConnection, field: string) {
      expect(await raw.closed).toEqual({ code: CLOSE_CODES.protocol_error, reason: "protocol_error" });
      expect(received(raw, "error")).toEqual([refusal(field)]);
      expect(received(raw, "ack")).toEqual([]);
    }
    const chunks = (message: Record<string, unknown>, id: string) =>
      frames(JSON.stringify(message), id, 1024).map((frame) => JSON.parse(frame.text) as Chunk);

    it("is refused on a delivery, which is neither stored nor acknowledged, whether sent whole or in chunks", async () => {
      const machine = await api.createMachine("Long ids");
      const record = shot("long-id-shot");
      const delivery = { ...shotDelivery(record), id: longId };

      const whole = await connect(machine);
      whole.send(delivery);
      await refused(whole, "shot.id");

      const inChunks = await connect(machine);
      const pieces = chunks(delivery, "short-chunk-id");
      expect(pieces.length).toBeGreaterThan(1);
      for (const piece of pieces) inChunks.send(piece);
      await refused(inChunks, "shot.id");
      expect(received(inChunks, "chunkReceived")).toHaveLength(pieces.length);

      const states = await connect(machine);
      states.send({ ...state("idle", "idle", "2026-10-05T12:00:00.000Z"), id: longId });
      await refused(states, "machineState.id");

      expect((await api.call("GET", "/shots/long-id-shot")).status).toBe(404);
      expect(await get(`/machines/${machine.machine.id}/machine-state-events`)).toMatchObject({ total: 0 });
    });

    it("is refused on a chunk, before anything of its message is held", async () => {
      const machine = await api.createMachine("Long chunk ids");
      const raw = await connect(machine);
      const pieces = chunks(shotDelivery(shot("long-chunk-id-shot")), longId);
      expect(pieces.length).toBeGreaterThan(1);
      raw.send(pieces[0]);
      await refused(raw, "chunk.id");
      expect(received(raw, "chunkReceived")).toEqual([]);
      expect((await api.call("GET", "/shots/long-chunk-id-shot")).status).toBe(404);
    });
  });
});
