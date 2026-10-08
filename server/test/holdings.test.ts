import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { type HeldRecord, type LocationBatch, type LocationOffer, plannedWrites, writeKey } from "../src/library/holdings.js";

// What a tablet should hold for its Location (ADR-0008), through the pure
// module's interface: the writes, in order, that bring a tablet's Beans and
// Bean Batches to what the Location offers. Records are shaped as Decaid
// v0.8.7 serves them (fixtures/decaid/bean-batch-writes-v0.8.7/), with
// made-up ids.

const BEANS = ["6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", "7b2d4e3f-5c6a-4b8f-8d9e-1f2a3b4c5d6e"] as const;
const BATCHES = ["3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c", "5a7c9e1b-2d3f-4a5b-8c6d-9e0f1a2b3c4d"] as const;
const LOCAL_BEAN = "1ebec875-1533-46d3-bc5f-9de5c85d9c2b";
const LOCAL_BATCH = "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca";

const beanContent = { roaster: "Fixture Roaster", name: "Batch Fixture Bean", decaf: false };
const batchContent = { roastDate: "2026-10-01T00:00:00.000", roastLevel: "medium", weight: 250, frozen: false };

/** A batch as the Location has it: offered there with 180.5 g left, unless given otherwise. */
const batch = (id: string, state: Partial<LocationBatch> = {}): LocationBatch => ({
  id,
  beanId: BEANS[0],
  content: batchContent,
  offered: true,
  remainingWeight: 180.5,
  ...state,
});
const offer = (beans: string[], batches: LocationBatch[] = []): LocationOffer => ({ beans: beans.map((id) => ({ id, content: beanContent })), batches });

/** The tablet's record of a Bean, carrying its global id, not archived, unless given otherwise. */
function heldBean(beanId: string, fields: Record<string, unknown> = {}): HeldRecord {
  return {
    itemId: beanId,
    localId: LOCAL_BEAN,
    record: { id: LOCAL_BEAN, ...beanContent, archived: false, extras: { [GLOBAL_ID_KEY]: beanId }, ...fields },
  };
}
/** The tablet's record of a batch, carrying its global id, at the Location with 180.5 g left, unless given otherwise. */
function heldBatch(batchId: string, fields: Record<string, unknown> = {}): HeldRecord {
  return {
    itemId: batchId,
    localId: LOCAL_BATCH,
    record: { id: LOCAL_BATCH, beanId: LOCAL_BEAN, ...batchContent, weightRemaining: 180.5, archived: false, extras: { [GLOBAL_ID_KEY]: batchId }, ...fields },
  };
}

describe("plannedWrites", () => {
  it("writes nothing to a tablet that holds what its Location offers, as its Location has it", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), { beans: [heldBean(BEANS[0])], batches: [heldBatch(BATCHES[0])] })).toEqual([]);
  });

  it("writes a Bean the tablet lacks before its batch, which waits for the tablet's record of it", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), { beans: [], batches: [] })).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: null, fields: beanContent },
    ]);
  });

  it("creates a batch under the tablet's record of its Bean, with the Location's remaining weight, or none if none was entered there", () => {
    const held = { beans: [heldBean(BEANS[0])], batches: [] };
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: null, fields: { ...batchContent, beanId: LOCAL_BEAN, weightRemaining: 180.5 } },
    ]);
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: undefined })]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: null, fields: { ...batchContent, beanId: LOCAL_BEAN } },
    ]);
  });

  it("un-archives a Bean and a batch the Location offers that the tablet holds archived, and writes the Location's remaining weight", () => {
    const held = { beans: [heldBean(BEANS[0], { archived: true })], batches: [heldBatch(BATCHES[0], { archived: true, weightRemaining: 250 })] };
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), held)).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: { archived: false } },
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: { archived: false, weightRemaining: 180.5 } },
    ]);
  });

  it("clears a remaining weight cleared at the Location, and keeps the tablet's own where none was ever entered there", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: null })]), { beans: [heldBean(BEANS[0])], batches: [heldBatch(BATCHES[0])] })).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: { weightRemaining: null } },
    ]);
    expect(
      plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: undefined })]), { beans: [heldBean(BEANS[0])], batches: [heldBatch(BATCHES[0])] }),
    ).toEqual([]);
  });

  it("archives, never deletes, what the tablet holds that its Location no longer offers: batches before their Beans", () => {
    const held = { beans: [heldBean(BEANS[0])], batches: [heldBatch(BATCHES[0])] };
    expect(plannedWrites(offer([], [batch(BATCHES[0], { offered: false })]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: { archived: true } },
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: { archived: true } },
    ]);
    // Already archived, they are left as they are.
    expect(
      plannedWrites(offer([], [batch(BATCHES[0], { offered: false })]), { beans: [heldBean(BEANS[0], { archived: true })], batches: [heldBatch(BATCHES[0], { archived: true })] }),
    ).toEqual([]);
  });

  it("writes nothing for a batch the Location does not offer and the tablet does not hold", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[1], { offered: false })]), { beans: [heldBean(BEANS[0])], batches: [] })).toEqual([]);
  });

  it("writes the global id back to a record that lost it, beside any other field due, keeping it offered or not", () => {
    const wiped = { extras: { otherPlugin: true } };
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), { beans: [heldBean(BEANS[0], wiped)], batches: [heldBatch(BATCHES[0], wiped)] })).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: {} },
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: {} },
    ]);
    expect(plannedWrites(offer([]), { beans: [heldBean(BEANS[1], { ...wiped, archived: true })], batches: [] })).toEqual([
      { kind: "bean", globalId: BEANS[1], localId: LOCAL_BEAN, fields: {} },
    ]);
  });

  it("writes Beans the Location offers first, then batches, then archives the Beans it does not, each in the order given", () => {
    const other = "72a68d6e-7986-43c7-9134-a9a78b6803ed";
    const held = { beans: [heldBean(BEANS[0], { archived: true }), { ...heldBean(BEANS[1]), localId: other }], batches: [] };
    const writes = plannedWrites(offer([BEANS[0]], [batch(BATCHES[0]), batch(BATCHES[1])]), held);
    expect(writes.map((write) => [write.kind, write.globalId, write.localId ?? "create"])).toEqual([
      ["bean", BEANS[0], LOCAL_BEAN],
      ["beanBatch", BATCHES[0], "create"],
      ["beanBatch", BATCHES[1], "create"],
      ["bean", BEANS[1], other],
    ]);
  });

  it("leaves out the items skipped for the connection", () => {
    const skipped = new Set([writeKey("bean", BEANS[0])]);
    expect(plannedWrites(offer([BEANS[0], BEANS[1]]), { beans: [], batches: [] }, skipped)).toEqual([
      { kind: "bean", globalId: BEANS[1], localId: null, fields: beanContent },
    ]);
  });
});
