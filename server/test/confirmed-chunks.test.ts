import { randomUUID } from "node:crypto";
import { CLOSE_CODES, CONFIRMED_CHUNKS_WIRE_REVISION, type Chunk, MAX_FRAME_BYTES, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_UNCONFIRMED_BYTES, MAX_UNCONFIRMED_WHOLE_BYTES, MAX_WHOLE_BYTES } from "../src/sync/sender.js";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Ticket #508 (milestone 8): the plugin confirms each chunk the server sends
// it, and the server holds back what it sends a connection so that what is
// unconfirmed stays under Decaid's limit on the frames it holds for a
// plugin. Protocol cases with hand-made frames, a tablet that confirms when
// the test says, against a real server, and Seam 1 with the built plugin in
// simulated tablets. The large write is a Bean whose tasting notes are far
// longer than a barista writes, derived, which another tablet at the
// Location brings to the Library. The server's sender alone, with two large
// messages in flight, is tested in sender.test.ts: no answer the server
// gives yet is large. Serials are made up, from 50801.

/** Decaid's limit on the frames it holds for a plugin (`maxQueuedInboundBytes`). */
const DECAID_INBOUND_LIMIT = 1 << 20;

type Frame = { type?: string; id?: string; index?: number; code?: string };

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The chunks the server has sent the connection, in the order they arrived. */
const chunksOn = (raw: RawConnection) => (raw.messages as Frame[]).filter((frame): frame is Chunk => frame.type === "chunk");
/** The chunks' size as Decaid counts their frames: the server writes a chunk as its JSON. */
const bytesOf = (chunks: Chunk[]) => chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)), 0);
const confirm = (raw: RawConnection, { id, index }: Chunk) => raw.send({ type: "chunkReceived", id, index });
/** The message the chunks carry, put back together. */
const whole = (chunks: Chunk[]) => JSON.parse(chunks.map((chunk) => chunk.data).join("")) as Record<string, unknown>;

/**
 * Resolves once everything the server had to send by now has arrived: it
 * answers a request in its turn among the connection's frames, after taking
 * every confirmation sent before it, so the answer follows whatever those
 * let go.
 */
async function settled(raw: RawConnection): Promise<Frame> {
  const id = randomUUID();
  raw.send({ type: "request", id, ask: "status" });
  const answer = () => (raw.messages as Frame[]).find((frame) => frame.type === "answer" && frame.id === id);
  await expect.poll(answer).toBeDefined();
  return answer()!;
}

/** Reports that the tablet holds nothing of the Library, which is taken in before anything is written to it. */
async function reportEmptyLibrary(raw: RawConnection): Promise<void> {
  for (const name of ["beans", "beanBatches", "profiles", "dye2Baskets", "dye2Equipment", "dye2Recipes", "grinders"]) {
    await raw.deliver({ type: "collection", id: randomUUID(), name, available: true, value: [], updatedAt: [] });
  }
}

describe("The server's chunks to the plugin", () => {
  let server: TestServer;
  let api: AdminApi;
  let serial = 50_801;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /**
   * A Location whose Library holds a Bean with tasting notes of `bytes`
   * bytes, brought by the tablet of one of its Machines, and a second
   * Machine there, whose tablet is to be written it.
   */
  async function largeBean(name: string, bytes = 1.25 * DECAID_INBOUND_LIMIT): Promise<{ second: CreatedMachine; beanId: string; notes: string }> {
    const lab = await api.createLocation(`${name} lab`, "UTC");
    const first = await api.createMachine(`${name} 1`, lab.id);
    const second = await api.createMachine(`${name} 2`, lab.id);
    const one = syncingTablet(first, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(first);
    const line = "Stone fruit, jasmine and black tea. ";
    const notes = line.repeat(Math.ceil(bytes / line.length));
    await one.addBean({ roaster: "Roux", name, notes });
    const named = async () => (await api.get<{ beans: { id: string; name: string | null }[] }>("/beans")).beans.filter((bean) => bean.name === name);
    await expect.poll(async () => (await named()).length, { timeout: 20_000 }).toBe(1);
    return { second, beanId: (await named())[0]!.id, notes };
  }

  /** A tablet of hand-made frames, welcomed for the Machine and holding nothing of the Library, which the server then writes to. */
  async function rawTablet(machine: CreatedMachine, hello: Record<string, unknown> = {}): Promise<RawConnection> {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial: String(serial++) }, ...hello }));
    await reportEmptyLibrary(raw);
    return raw;
  }

  /**
   * Confirms each chunk from `from` on as it arrives, as the plugin does,
   * until the message is whole, checking that what is unconfirmed never
   * passes the limit: the message, put back together.
   */
  async function confirmEach(raw: RawConnection, from = 0): Promise<Record<string, unknown>> {
    await expect.poll(() => chunksOn(raw).length).toBeGreaterThan(from);
    const { id, count } = chunksOn(raw)[from]!;
    const ofMessage = () => chunksOn(raw).filter((chunk) => chunk.id === id);
    for (let index = 0; index < count; index++) {
      await expect.poll(() => ofMessage().length).toBeGreaterThan(index);
      const chunks = ofMessage();
      expect(chunks[index]).toMatchObject({ index, count });
      expect(bytesOf(chunks.slice(index))).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
      confirm(raw, chunks[index]!);
    }
    return whole(ofMessage());
  }

  it("writes an item larger than 1 MiB whole, in order, as each chunk is confirmed", async () => {
    const { second, beanId, notes } = await largeBean("Confirmed");
    const raw = await rawTablet(second);
    const write = await confirmEach(raw);
    expect(write).toMatchObject({ type: "write", kind: "bean", globalId: beanId, localId: null, fields: { name: "Confirmed", notes } });
    // More than Decaid holds for a plugin went through, never more than half of it at once.
    expect(bytesOf(chunksOn(raw))).toBeGreaterThan(DECAID_INBOUND_LIMIT);
    expect(chunksOn(raw).every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) <= MAX_FRAME_BYTES)).toBe(true);
  });

  it("holds back while chunks are unconfirmed, sends small frames meanwhile, and carries on once they are confirmed", async () => {
    const { second, beanId, notes } = await largeBean("Held back");
    const raw = await rawTablet(second);
    await expect.poll(() => chunksOn(raw).length).toBeGreaterThan(0);
    await settled(raw);
    const held = chunksOn(raw);
    // As many as the limit holds, and no more, though the message has more.
    expect(held.length).toBeLessThan(held[0]!.count);
    expect(bytesOf(held)).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
    expect(bytesOf(held) + MAX_FRAME_BYTES).toBeGreaterThan(MAX_UNCONFIRMED_BYTES);

    // Heartbeats are answered and a delivery acknowledged meanwhile, and nothing more of the write comes.
    const beats = () => (raw.messages as Frame[]).filter((frame) => frame.type === "heartbeat").length;
    const before = beats();
    await expect.poll(beats).toBeGreaterThan(before + 1);
    await raw.deliver({ type: "collection", id: randomUUID(), name: "scale", available: false });
    // A confirmation naming no chunk in flight lets nothing go: one of a message never sent, and one of a chunk not sent yet.
    raw.send({ type: "chunkReceived", id: "message-99", index: 0 });
    raw.send({ type: "chunkReceived", id: held[0]!.id, index: held[0]!.count - 1 });
    await settled(raw);
    expect(chunksOn(raw)).toHaveLength(held.length);

    // Confirming the first lets one more go, and no more.
    confirm(raw, held[0]!);
    await expect.poll(() => chunksOn(raw).length).toBe(held.length + 1);
    await settled(raw);
    expect(chunksOn(raw)).toHaveLength(held.length + 1);
    expect(bytesOf(chunksOn(raw).slice(1))).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);

    // A confirmation covers the chunks sent before it: the latest one's lets go as much as all of them took.
    const latest = chunksOn(raw).at(-1)!;
    confirm(raw, latest);
    await settled(raw);
    const sent = chunksOn(raw);
    expect(sent.length).toBeGreaterThan(latest.index + 2);
    expect(bytesOf(sent.slice(latest.index + 1))).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);

    // The rest follows, in order, and the write is whole.
    for (let index = latest.index + 1; index < latest.count; index++) {
      await expect.poll(() => chunksOn(raw).length).toBeGreaterThan(index);
      confirm(raw, chunksOn(raw)[index]!);
    }
    expect(chunksOn(raw).map((chunk) => chunk.index)).toEqual(Array.from({ length: latest.count }, (_, index) => index));
    expect(whole(chunksOn(raw))).toMatchObject({ type: "write", kind: "bean", globalId: beanId, fields: { notes } });
  });

  it("answers a request while a write is in flight, the two together staying under Decaid's limit", async () => {
    const { second } = await largeBean("With an answer");
    const raw = await rawTablet(second);
    await expect.poll(() => chunksOn(raw).length).toBeGreaterThan(0);
    // The answer comes at once, whole, though the write's chunks wait to be confirmed.
    const answer = await settled(raw);
    expect(answer).toMatchObject({ type: "answer", ask: "status", result: { served: true } });
    const unconfirmed = chunksOn(raw);
    expect(unconfirmed.length).toBeLessThan(unconfirmed[0]!.count);
    // An answer sent whole is small, and counted apart: with the chunks unconfirmed, it leaves Decaid's limit far off.
    const answerBytes = Buffer.byteLength(JSON.stringify(answer));
    expect(answerBytes).toBeLessThanOrEqual(MAX_WHOLE_BYTES);
    expect(bytesOf(unconfirmed)).toBeLessThanOrEqual(MAX_UNCONFIRMED_BYTES);
    expect(bytesOf(unconfirmed) + answerBytes).toBeLessThan(DECAID_INBOUND_LIMIT);
    // Its arrival confirms nothing: the write goes on only as its own chunks are confirmed.
    expect(await confirmEach(raw)).toMatchObject({ type: "write", kind: "bean" });
  });

  it("sends answers whole until those unconfirmed would pass their limit, then as chunks, and whole again once a chunk is confirmed", async () => {
    const machine = await api.createMachine("Many answers");
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
    const answers = () => (raw.messages as Frame[]).filter((frame) => frame.type === "answer");
    const request = () => raw.send({ type: "request", id: randomUUID(), ask: "status" });
    // As many as fit the limit on what is sent whole, by the first one's size, and then some: nothing confirms them.
    request();
    await expect.poll(() => answers().length).toBe(1);
    const answerBytes = Buffer.byteLength(JSON.stringify(answers()[0]));
    const fit = Math.floor(MAX_UNCONFIRMED_WHOLE_BYTES / answerBytes);
    for (let sent = 1; sent < fit + 3; sent++) request();
    await expect.poll(() => chunksOn(raw).length, { timeout: 30_000 }).toBe(3);
    // Each id is as long as the first, so every answer is its size: exactly those that fit came whole.
    expect(answers()).toHaveLength(fit);
    expect(chunksOn(raw).map((chunk) => whole([chunk]))).toMatchObject([{ type: "answer" }, { type: "answer" }, { type: "answer" }]);
    expect(answers().length * answerBytes + bytesOf(chunksOn(raw))).toBeLessThan(DECAID_INBOUND_LIMIT);

    // Confirming a chunk confirms every frame before it, so the next answer comes whole again.
    confirm(raw, chunksOn(raw)[0]!);
    request();
    await expect.poll(() => answers().length).toBe(fit + 1);
    expect(chunksOn(raw)).toHaveLength(3);
  });

  it("sends a write again whole on the next connection after one dropped with chunks in flight, and no answer again", async () => {
    const { second, beanId, notes } = await largeBean("Dropped");
    const tabletId = randomUUID();
    const hardware = { model: "DE1Pro", serial: String(serial++) };
    const first = await rawTablet(second, { tabletId, machine: hardware });
    await expect.poll(() => chunksOn(first).length).toBeGreaterThan(0);
    await settled(first);
    const inFlight = chunksOn(first);
    expect(inFlight.length).toBeLessThan(inFlight[0]!.count);
    await first.terminate();

    const back = await rawTablet(second, { tabletId, machine: hardware });
    // From its first chunk, nothing of the dropped connection's counted against it.
    const write = await confirmEach(back);
    expect(write).toMatchObject({ type: "write", kind: "bean", globalId: beanId, localId: null, fields: { notes } });
    expect(chunksOn(back)[0]).toMatchObject({ index: 0, count: inFlight[0]!.count });
    // The dropped connection's request was answered there or not at all.
    expect((back.messages as Frame[]).filter((frame) => frame.type === "answer")).toEqual([]);
  });

  it("sends a plugin behind the confirmations' wire revision a large write in chunks all at once, as before", async () => {
    // Too large for one frame, and more than the server would send unconfirmed to a plugin that confirms.
    const { second, beanId, notes } = await largeBean("Unconfirmed", MAX_UNCONFIRMED_BYTES + MAX_FRAME_BYTES);
    const raw = await rawTablet(second, { wireRevision: CONFIRMED_CHUNKS_WIRE_REVISION - 1 });
    await expect.poll(() => chunksOn(raw).length).toBeGreaterThan(0);
    const { count } = chunksOn(raw)[0]!;
    expect(count).toBeGreaterThan(2);
    // Every chunk arrives though none is confirmed.
    await expect.poll(() => chunksOn(raw).length).toBe(count);
    expect(bytesOf(chunksOn(raw))).toBeGreaterThan(MAX_UNCONFIRMED_BYTES);
    const write = whole(chunksOn(raw));
    expect(write).toMatchObject({ type: "write", kind: "bean", globalId: beanId, fields: { notes } });
    // Named by the write's id, as the previous release named them.
    expect(new Set(chunksOn(raw).map((chunk) => chunk.id))).toEqual(new Set([write.id]));
  });

  it("refuses a confirmation it can't read, and one sent before a hello", async () => {
    const machine = await api.createMachine("Unreadable confirmations");
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
    raw.send({ type: "chunkReceived", id: "message-1" });
    expect((await raw.closed).code).toBe(CLOSE_CODES.protocol_error);
    expect(raw.messages).toContainEqual(expect.objectContaining({ type: "error", code: "protocol_error", message: "chunkReceived.index must be a whole number" }));

    const early = await RawConnection.open(server.url);
    early.send({ type: "chunkReceived", id: "message-1", index: 0 });
    expect((await early.closed).code).toBe(CLOSE_CODES.protocol_error);
    expect(early.messages).toContainEqual(expect.objectContaining({ type: "error", message: "The first message must be hello" }));
  });

  describe("with the built plugin in simulated tablets", () => {
    const received = (tablet: SimulatedTablet) => (tablet.received as Frame[]).filter((frame): frame is Chunk => frame.type === "chunk");
    const confirmations = (tablet: SimulatedTablet) => (tablet.sent as Frame[]).filter((frame) => frame.type === "chunkReceived");

    it("writes an item larger than 1 MiB to the tablet, the plugin confirming every chunk", async () => {
      const { second, beanId, notes } = await largeBean("Simulated");
      const two = syncingTablet(second, server, { api: emptyLibrary(serial++) });
      const held = () => two.beans().filter((bean) => globalIdOf(bean) === beanId);
      await expect.poll(() => held().length, { timeout: 20_000 }).toBe(1);
      expect(held()[0]).toMatchObject({ roaster: "Roux", name: "Simulated", notes });

      const chunks = received(two);
      expect(chunks.length).toBe(chunks[0]!.count);
      expect(bytesOf(chunks)).toBeGreaterThan(DECAID_INBOUND_LIMIT);
      await expect.poll(() => confirmations(two).length).toBe(chunks.length);
      expect(confirmations(two)).toEqual(chunks.map(({ id, index }) => ({ type: "chunkReceived", id, index })));
      // The transport never passed Decaid's limit on what it holds for the plugin, which closes it.
      expect(two.logs.filter((line) => line.includes("transport_resource_limit"))).toEqual([]);
    });
  });
});
