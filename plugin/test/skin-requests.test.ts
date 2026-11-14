import { afterEach, describe, expect, it, vi } from "vitest";
import { type PluginMessage, type SkinAnswer, WIRE_REVISION } from "@decent-sync/protocol";
import type { PluginHost, StorageCommand } from "../src/host.js";
import { KeptDeliveries } from "../src/kept-deliveries.js";
import { type Delivery, Outbox } from "../src/outbox.js";
import { type Asked, SKIN_REQUEST_MS, SkinRequests } from "../src/skin-requests.js";
import { PluginStorage } from "../src/storage.js";

// When a request for a Skin goes out (ADR-0030, ticket #507): at once, as
// `status` does, or, for an ask whose answer depends on what the tablet
// reports, once the server has acknowledged what the outbox held as the Skin
// asked. No ask follows the tablet's reports yet: the Location's Shots are
// the first (#509). So the wait is tested here, on the plugin's own outbox
// with a Decaid that holds nothing, with `status` told to follow them; Seam
// 1 covers `status` as it is asked (server/test/skin-status.test.ts).

const SERVED: SkinAnswer["result"] = { served: true, machine: { id: "machine", name: "Machine" }, location: { id: "location", name: "Location" } };

/** A Shot's read under way, which the test ends as Decaid would: with the Shot, with none, or failing. */
interface Read {
  found(): void;
  gone(): void;
  fail(): void;
}

/**
 * The plugin's outbox and its requests for a Skin, on a welcomed connection
 * that records what is sent on it and acknowledges nothing by itself.
 * `follows` has `status` follow the tablet's reports, as no ask yet does.
 */
async function connected(options: { follows: boolean; restored?: boolean }) {
  const logs: string[] = [];
  const log = (message: string) => void logs.push(message);
  // Decaid's plugin storage, never written: each read answers null, in a later turn, as Decaid's events come.
  const host = {
    log,
    storage: (command: StorageCommand) =>
      queueMicrotask(() => (command.type === "read" ? storage.answered("storageRead", { key: command.key, value: null }) : storage.answered("storageWrite", command.data))),
  } as PluginHost;
  const storage = new PluginStorage(host);
  const reads = new Map<string, Read>();
  const outbox = new Outbox(
    log,
    {
      shot: (id, deliveryId) =>
        new Promise((resolve, reject) => {
          reads.set(id, {
            found: () => resolve({ type: "shot", id: deliveryId, shotId: id, shot: { id } }),
            gone: () => resolve(null),
            fail: () => reject(new Error("Record unavailable")),
          });
        }),
      steam: () => Promise.resolve(null),
    },
    new KeptDeliveries(storage, log, "a token"),
  );
  const requests = new SkinRequests(outbox, { status: options.follows });
  const sent: PluginMessage[] = [];
  const welcome = () => {
    outbox.welcome(async (message) => void sent.push(message));
    requests.welcomed(async (request) => void sent.push(request), WIRE_REVISION);
  };
  welcome();
  if (options.restored !== false) await outbox.restore();
  opened.push(outbox);

  /** What was sent, by type, with a Shot's id. */
  const sentAs = () => sent.map((message) => (message.type === "shot" ? `shot ${message.shotId}` : message.type));
  /** A delivery that is not kept in Decaid's plugin storage, queued as a Shot's edit is. */
  const queue = (shotId: string): Delivery => {
    const delivery: Delivery = { type: "shotUpdated", id: outbox.nextId(), shotId, shot: {} };
    outbox.enqueue(delivery);
    return delivery;
  };
  /** The server's acknowledgment of the delivery sent last. */
  const acknowledge = () => {
    const delivery = sent.filter((message) => message.type !== "request").at(-1) as Delivery;
    outbox.acknowledge(delivery.id);
  };
  /** Asks for the status, and gives what became of it once it is settled. */
  const ask = () => {
    const asked: { settled?: Asked } = {};
    void requests.ask("status").then((settled) => (asked.settled = settled));
    return asked;
  };
  /** The server's answer to the request sent last. */
  const answer = () => {
    const request = sent.filter((message) => message.type === "request").at(-1) as { id: string };
    requests.answered({ type: "answer", id: request.id, ask: "status", result: SERVED });
  };
  /** The read of that Shot, once the outbox has begun it. */
  const read = async (id: string) => {
    await vi.waitFor(() => expect(reads.has(id)).toBe(true));
    return reads.get(id)!;
  };
  const disconnect = () => {
    outbox.disconnected();
    requests.disconnected();
  };
  return { outbox, requests, sent, sentAs, queue, acknowledge, ask, answer, read, welcome, disconnect, logs };
}

const opened: Outbox[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const outbox of opened.splice(0)) outbox.stop();
});

/** Lets the outbox do what it has been given: its sends and reads take turns of their own. */
const turns = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("A request that follows the tablet's reports", () => {
  it("goes out once the server has acknowledged the deliveries queued as the Skin asked, and waits for none queued after", async () => {
    const { queue, ask, acknowledge, answer, sentAs } = await connected({ follows: true });
    queue("before");
    await turns();
    const asked = ask();
    queue("after");
    await turns();
    expect(sentAs()).toEqual(["shotUpdated"]);

    acknowledge();
    await turns();
    // Behind the delivery that waited, and ahead of the one queued since, which the server has yet to acknowledge.
    expect(sentAs()).toEqual(["shotUpdated", "request", "shotUpdated"]);
    expect(asked.settled).toBeUndefined();
    answer();
    await turns();
    expect(asked.settled).toEqual({ answer: expect.objectContaining({ type: "answer", result: SERVED }) });
  });

  it("follows a record new on the tablet, read only as it is sent, but not the records the server asked for", async () => {
    const { outbox, ask, acknowledge, read, sentAs } = await connected({ follows: true });
    // A backfill's Shots, the first of them being read, and a Shot Decaid just stored, which goes ahead of the rest.
    outbox.request("shot", ["old-1", "old-2"]);
    outbox.request("shot", ["new"], { first: true });
    const asked = ask();
    (await read("old-1")).found();
    await turns();
    acknowledge();
    (await read("new")).found();
    await turns();
    expect(sentAs()).toEqual(["shot old-1", "shot new"]);

    // Once the new Shot is acknowledged, with the backfill's second Shot still to be read.
    acknowledge();
    await turns();
    expect(sentAs()).toEqual(["shot old-1", "shot new", "request"]);
    expect(asked.settled).toBeUndefined();
    (await read("old-2")).found();
    await turns();
    expect(sentAs()).toEqual(["shot old-1", "shot new", "request", "shot old-2"]);
  });

  it("is not held back by a new record the tablet no longer holds, nor by one Decaid fails to read, then or afterwards", async () => {
    const { outbox, ask, read, sentAs, logs } = await connected({ follows: true });
    outbox.request("shot", ["gone"], { first: true });
    ask();
    (await read("gone")).gone();
    await turns();
    expect(sentAs()).toEqual(["request"]);

    outbox.request("shot", ["unreadable"], { first: true });
    ask();
    (await read("unreadable")).fail();
    await turns();
    expect(sentAs()).toEqual(["request", "request"]);
    expect(logs).toContainEqual(expect.stringContaining("Could not read Shot unreadable"));
    // It is tried again after the other records, and holds back nothing meanwhile.
    ask();
    await turns();
    expect(sentAs()).toEqual(["request", "request", "request"]);
  });

  it("is answered as unreachable, and never sent, when its time runs out or its connection closes while it waits", async () => {
    const { queue, ask, acknowledge, disconnect, welcome, sentAs } = await connected({ follows: true });
    queue("unacknowledged");
    await turns();
    vi.useFakeTimers();
    const late = ask();
    await vi.advanceTimersByTimeAsync(SKIN_REQUEST_MS - 1);
    expect(late.settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(late.settled).toEqual({ unanswered: "unreachable" });
    vi.useRealTimers();

    const cut = ask();
    disconnect();
    await turns();
    expect(cut.settled).toEqual({ unanswered: "unreachable" });

    // The delivery goes again on the next connection, and is acknowledged at last: neither request follows it.
    welcome();
    await turns();
    acknowledge();
    await turns();
    expect(sentAs()).toEqual(["shotUpdated", "shotUpdated"]);
  });

  it("is answered as unreachable at once while the outbox is still reading back what earlier loads kept", async () => {
    const { outbox, ask, sentAs } = await connected({ follows: true, restored: false });
    const early = ask();
    await turns();
    expect(early.settled).toEqual({ unanswered: "unreachable" });

    await outbox.restore();
    ask();
    await turns();
    expect(sentAs()).toEqual(["request"]);
  });
});

describe("A request that follows nothing, as the status", () => {
  it("goes out at once, whatever the outbox still holds", async () => {
    const { outbox, queue, ask, answer, sentAs } = await connected({ follows: false });
    queue("unacknowledged");
    outbox.request("shot", ["new"], { first: true });
    await turns();
    const asked = ask();
    await turns();
    expect(sentAs()).toEqual(["shotUpdated", "request"]);
    answer();
    await turns();
    expect(asked.settled).toEqual({ answer: expect.objectContaining({ result: SERVED }) });
  });

  it("goes out at once while the outbox is still reading back what earlier loads kept", async () => {
    const { ask, sentAs } = await connected({ follows: false, restored: false });
    ask();
    await turns();
    expect(sentAs()).toEqual(["request"]);
  });
});
