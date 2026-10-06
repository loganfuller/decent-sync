import { randomUUID } from "node:crypto";
import { CLOSE_CODES, type Chunk, MAX_FRAME_BYTES, MAX_ID_LENGTH, frames } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { derivedShot, longShot, shotFixture, withShots } from "./support/shot-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: messages too large for one frame, sent by the built plugin on a
// simulated tablet and as raw frames, to a real server and PostgreSQL, with
// assertions through the REST API. The large Shots are derived from the
// scrubbed real record by repeating its measurement samples (longShot()).

/** Decaid's limit on a transport's pending outbound bytes. */
const DECAID_PENDING_LIMIT = 1 << 20;

interface Received {
  type: string;
  id?: string;
  index?: number;
  code?: string;
  message?: string;
}

describe("Chunked messages", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const timers: NodeJS.Timeout[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    timers.splice(0).forEach(clearInterval);
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** A derived long Shot that names no hardware, so it is credited to the Machine whose tablet sends it. */
  function long(id: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
    const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    const record = longShot(id, { workflow, ...changes });
    expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(DECAID_PENDING_LIMIT);
    return record;
  }
  function tabletApi(machine: CreatedMachine) {
    return derivedDe1Pro({ serial: machine.machine.id.replaceAll("-", "") });
  }
  function load(machine: CreatedMachine, shots: Record<string, unknown>[], options = {}) {
    const tablet = SimulatedTablet.load({ settings: settingsFor(machine), api: withShots(tabletApi(machine), shots), timeScale: 50, ...options });
    tablets.push(tablet);
    return tablet;
  }
  async function connect(machine: CreatedMachine, url = server.url) {
    const raw = await RawConnection.open(url);
    raws.push(raw);
    raw.send(helloWith(machine.token));
    expect(await raw.message(0)).toMatchObject({ type: "welcome" });
    timers.push(setInterval(() => raw.send({ type: "heartbeat" }), 300));
    return raw;
  }
  async function stored(id: string) {
    await expect.poll(async () => (await api.call("GET", `/shots/${encodeURIComponent(id)}`)).status, { timeout: 20_000 }).toBe(200);
    const response = await api.call("GET", `/shots/${encodeURIComponent(id)}`);
    return ((await response.json()) as { shot: { record: Record<string, unknown> } }).shot;
  }
  async function measurements(id: string) {
    return ((await (await api.call("GET", `/shots/${encodeURIComponent(id)}/measurements`)).json()) as { measurements: unknown }).measurements;
  }
  async function absent(id: string) {
    expect((await api.call("GET", `/shots/${encodeURIComponent(id)}`)).status).toBe(404);
  }

  /** The chunks a message travels in, parsed. */
  function chunked(message: Record<string, unknown>, id: string, maxFrameBytes?: number): Chunk[] {
    return frames(JSON.stringify(message), id, maxFrameBytes).map((frame) => JSON.parse(frame.text) as Chunk);
  }
  function chunksSent(tablet: SimulatedTablet): Chunk[] {
    return tablet.sent.filter((message): message is Chunk => (message as Received).type === "chunk");
  }
  function acks(messages: unknown[], id: string): number {
    return (messages as Received[]).filter((message) => message.type === "ack" && message.id === id).length;
  }
  function receipts(messages: unknown[], id?: string): number[] {
    return (messages as Received[]).flatMap((message) =>
      message.type === "chunkReceived" && (id === undefined || message.id === id) ? [message.index!] : [],
    );
  }

  it("delivers a Shot larger than 1 MiB intact, in chunks, and acknowledges it once", async () => {
    const machine = await api.createMachine("Long Shot");
    const record = long("long-shot");
    const tablet = load(machine, [record]);
    expect((await stored("long-shot")).record).toEqual({ ...record, measurements: undefined });
    expect(await measurements("long-shot")).toEqual(record.measurements);

    // One delivery, in order, in frames no larger than the protocol allows.
    const chunks = chunksSent(tablet);
    const id = chunks[0]!.id;
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.map(({ id, index, count }) => ({ id, index, count }))).toEqual(chunks.map((_, index) => ({ id, index, count: chunks.length })));
    for (const chunk of chunks) expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    await expect.poll(() => acks(tablet.received, id)).toBe(1);
    expect(receipts(tablet.received, id)).toEqual(chunks.map((chunk) => chunk.index));
    // Nothing more arrives for it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(acks(tablet.received, id)).toBe(1);
    expect(chunksSent(tablet)).toHaveLength(chunks.length);
  });

  it("sends a chunked Shot again from its first chunk after a reconnect, and stores it once", async () => {
    const machine = await api.createMachine("Interrupted long Shot");
    const record = long("interrupted-long-shot");
    // The network stalls once two chunks are through, so the connection drops partway through.
    let stalled = true;
    const stallUpload = (frame: unknown) => stalled && (frame as Received).type === "chunk" && (frame as Received).index === 2;
    const tablet = load(machine, [record], { stallUpload });
    await expect.poll(() => receipts(tablet.received).length, { timeout: 10_000 }).toBe(2);
    await absent("interrupted-long-shot");
    stalled = false;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    expect((await stored("interrupted-long-shot")).record).toEqual({ ...record, measurements: undefined });
    expect(await measurements("interrupted-long-shot")).toEqual(record.measurements);

    // The delivery was cut off, then sent whole on the new connection, from its first chunk.
    const chunks = chunksSent(tablet);
    const { id, count } = chunks[0]!;
    expect(chunks.every((chunk) => chunk.id === id)).toBe(true);
    expect(chunks.length).toBeGreaterThan(count);
    expect(chunks.slice(-count).map((chunk) => chunk.index)).toEqual(chunks.slice(-count).map((_, index) => index));
    await expect.poll(() => acks(tablet.received, id)).toBe(1);
    const listed = (await (await api.call("GET", `/shots?machineId=${machine.machine.id}`)).json()) as { shots: { id: string }[] };
    expect(listed.shots.map((shot) => shot.id)).toEqual(["interrupted-long-shot"]);
  });

  it("keeps Decaid's pending outbound bytes within its limit while sending a large Shot, and still delivers later messages", async () => {
    const machine = await api.createMachine("Slow upload");
    // Mostly text of three and four bytes a character, so counting characters instead of bytes would overfill Decaid's queue.
    const notes = "抽出はゆっくり、甘い余韻。\u{2615}\u{1f600}".repeat(25_000);
    const record = long("slow-upload-shot", { annotations: { ...(shotFixture().annotations as object), espressoNotes: notes } });
    const tablet = load(machine, [record], { uploadBytesPerSecond: 512 * 1024 });
    await expect.poll(() => receipts(tablet.received).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const heartbeatsBefore = tablet.sent.filter((message) => (message as Received).type === "heartbeat").length;

    // A Shot pulled while the long one is still on its way.
    const { machine: hardware, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    const later = derivedShot("after-slow-upload", { workflow, timestamp: "2026-11-01T12:00:00" });
    tablet.serve(withShots(tabletApi(machine), [record, later]));
    tablet.fire("shotStored", { id: later.id });

    const slow = await stored("slow-upload-shot");
    expect((slow.record.annotations as { espressoNotes: string }).espressoNotes).toBe(notes);
    expect(await measurements("slow-upload-shot")).toEqual(record.measurements);
    await stored("after-slow-upload");
    expect(await measurements("after-slow-upload")).toEqual(later.measurements);

    // Frames queued up behind the slow network, but never past Decaid's limit.
    expect(tablet.refusedSends).toBe(0);
    expect(tablet.peakPendingOutboundBytes).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(tablet.peakPendingOutboundBytes).toBeLessThanOrEqual(DECAID_PENDING_LIMIT);
    // Heartbeats kept going alongside, and the connection never dropped.
    expect(tablet.sent.filter((message) => (message as Received).type === "heartbeat").length).toBeGreaterThan(heartbeatsBefore);
    expect(tablet.logs.filter((line) => line.startsWith("Disconnected"))).toEqual([]);
  }, 30_000);

  it("puts duplicate and out-of-order chunks back together without corrupting the stored Shot", async () => {
    const machine = await api.createMachine("Raw chunks");
    const raw = await connect(machine);
    const record = long("raw-chunked-shot");
    const id = randomUUID();
    const chunks = chunked({ type: "shot", id, shotId: record.id, shot: record }, id);
    // Last chunk first, and every other chunk twice.
    const order = [...chunks].reverse().flatMap((chunk, n) => (n % 2 === 0 ? [chunk, chunk] : [chunk]));
    for (const chunk of order) raw.send(chunk);
    await expect.poll(() => acks(raw.messages, id), { timeout: 10_000 }).toBe(1);
    // A stray copy after the Shot is complete starts nothing that could complete again.
    raw.send(chunks[1]);
    await expect.poll(() => receipts(raw.messages, id).length).toBe(order.length + 1);
    expect(acks(raw.messages, id)).toBe(1);
    expect((await stored("raw-chunked-shot")).record).toEqual({ ...record, measurements: undefined });
    expect(await measurements("raw-chunked-shot")).toEqual(record.measurements);
  });

  it("refuses chunks that contradict each other, storing and acknowledging nothing", async () => {
    const machine = await api.createMachine("Contradicting chunks");
    const raw = await connect(machine);
    const record = long("contradicted-shot");
    const id = randomUUID();
    const [first, ...rest] = chunked({ type: "shot", id, shotId: record.id, shot: record }, id);
    const altered = { ...first!, data: first!.data.replace("measurements", "measurementz") };
    expect(altered.data).not.toBe(first!.data);
    raw.send(first);
    raw.send(altered);
    for (const chunk of rest) raw.send(chunk);
    expect((await raw.closed).code).toBe(CLOSE_CODES.protocol_error);
    expect(raw.messages).toContainEqual({ type: "error", code: "protocol_error", message: "chunk.data differs from an earlier copy of the same chunk" });
    expect(acks(raw.messages, id)).toBe(0);
    await absent("contradicted-shot");
  });

  it("never stores or acknowledges a message its chunks do not make whole", async () => {
    const machine = await api.createMachine("Invalid chunked messages");
    const record = long("invalid-chunked-shot");
    const cases = [
      // Cut short: not JSON once put back together.
      { id: randomUUID(), text: (id: string) => JSON.stringify({ type: "shot", id, shotId: record.id, shot: record }).slice(0, -2) },
      // JSON, but a Shot delivery without its Shot id.
      { id: randomUUID(), text: (id: string) => JSON.stringify({ type: "shot", id, shot: record }) },
    ];
    for (const { id, text } of cases) {
      const raw = await connect(machine);
      for (const frame of frames(text(id), id)) raw.send(frame.text);
      expect((await raw.closed).code).toBe(CLOSE_CODES.protocol_error);
      expect(acks(raw.messages, id)).toBe(0);
    }
    await absent("invalid-chunked-shot");
  });

  it("discards a dropped connection's partial chunks, on any instance, and stores the Shot once it is sent whole", async () => {
    const machine = await api.createMachine("Partial chunks");
    const record = long("partial-chunked-shot");
    const id = randomUUID();
    const chunks = chunked({ type: "shot", id, shotId: record.id, shot: record }, id);
    const half = Math.ceil(chunks.length / 2);
    for (const url of [server.url, other.url]) {
      const first = await connect(machine, url);
      for (const chunk of chunks.slice(0, half)) first.send(chunk);
      await expect.poll(() => receipts(first.messages, id).length).toBe(half);
      await first.terminate();

      // The rest alone does not complete it: the first half went with the dropped connection.
      const second = await connect(machine, url === server.url ? other.url : server.url);
      for (const chunk of chunks.slice(half)) second.send(chunk);
      await expect.poll(() => receipts(second.messages, id).length).toBe(chunks.length - half);
      expect(acks(second.messages, id)).toBe(0);
      await absent("partial-chunked-shot");
      await second.terminate();
    }

    // Sent whole, from its first chunk, it is stored once.
    const whole = await connect(machine);
    for (const chunk of chunks) whole.send(chunk);
    await expect.poll(() => acks(whole.messages, id), { timeout: 10_000 }).toBe(1);
    expect(await measurements("partial-chunked-shot")).toEqual(record.measurements);
  });

  it("accepts a hello in chunks, but holds no more before a hello than one frame could carry, ids included", async () => {
    const machine = await api.createMachine("Chunked hello");
    const raw = await RawConnection.open(server.url);
    raws.push(raw);
    const chunks = chunked(helloWith(machine.token), "hello", 128);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) raw.send(chunk);
    // Each chunk's receipt, then the welcome.
    expect(await raw.message(chunks.length)).toMatchObject({ type: "welcome" });
    expect(raw.messages.slice(0, chunks.length)).toEqual(chunks.map(({ index }) => ({ type: "chunkReceived", id: "hello", index })));
    timers.push(setInterval(() => raw.send({ type: "heartbeat" }), 300));
    await api.waitForMachine("Chunked hello", (view) => view.online);

    const flood = await RawConnection.open(server.url);
    raws.push(flood);
    const padded = { ...helloWith(machine.token), padding: "x".repeat(DECAID_PENDING_LIMIT) };
    for (const chunk of chunked(padded, "padded")) flood.send(chunk);
    expect((await flood.closed).code).toBe(CLOSE_CODES.protocol_error);
    expect((flood.messages as Received[]).some((message) => message.type === "welcome")).toBe(false);
    const overLimit = expect.objectContaining({ type: "error", code: "protocol_error", message: expect.stringContaining("ids included") });
    expect(flood.messages).toContainEqual(overLimit);

    // Messages' ids count too: these two chunks' data fits, but not with their ids.
    const ids = await RawConnection.open(server.url);
    raws.push(ids);
    const data = "x".repeat(DECAID_PENDING_LIMIT / 2 - MAX_ID_LENGTH / 2);
    for (const id of ["a", "b"]) ids.send({ type: "chunk", id: id.repeat(MAX_ID_LENGTH), index: 0, count: 2, data });
    expect((await ids.closed).code).toBe(CLOSE_CODES.protocol_error);
    expect(receipts(ids.messages)).toEqual([0]);
    expect(ids.messages).toContainEqual(overLimit);
  });
});
