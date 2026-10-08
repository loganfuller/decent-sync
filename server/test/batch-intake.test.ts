import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { type MappedBatch, type ReportedBatch, batchContent, editsInAnswer, planBatchIntake, readReportedBatches } from "../src/library/batch-intake.js";

// Taking a tablet's report of its bean batches into the Library, through the
// pure module's interface: which records are new, mapped by the global id
// they carry, or kept by the tablet's map (ADR-0006, ADR-0018), and the
// mapping from what changed in them to the tablet's Location's state
// (ADR-0008, ADR-0019): whether the batch is there and its remaining weight
// there. Records are shaped as Decaid v0.8.7 serves batches
// (fixtures/decaid/bean-batch-writes-v0.8.7/), with made-up ids.

const LOCAL = ["eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca", "f01cd028-ab46-466f-9e8e-6f80e3d0e9d9", "54579ba5-a309-4a69-81e2-1610fd95d4ff"] as const;
const BEAN = "1ebec875-1533-46d3-bc5f-9de5c85d9c2b";
const GLOBAL = ["3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c", "5a7c9e1b-2d3f-4a5b-8c6d-9e0f1a2b3c4d"] as const;
const LIBRARY_BEAN = "6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d";
/** The tablet's map of its beans: its bean's record is the Library Bean. */
const beans = new Map([[BEAN, LIBRARY_BEAN]]);

/** A batch record as Decaid serves one, with the fields given. */
function record(localId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: localId,
    beanId: BEAN,
    roastDate: "2026-10-01T00:00:00.000",
    roastLevel: "medium",
    weight: 250,
    weightRemaining: 250,
    frozen: false,
    archived: false,
    createdAt: "2026-10-07T22:11:19.437952",
    updatedAt: "2026-10-07T22:11:19.437952",
    ...fields,
  };
}

function reported(localId: string, fields: Record<string, unknown> = {}, updatedAt = "2026-10-08T03:11:19.437Z"): ReportedBatch {
  return readReportedBatches([record(localId, fields)], [updatedAt])[0]!;
}

/** A record the tablet's map holds, as it was known: at the Location with 250 g left, unless given otherwise. */
const mapped = (batchId: string, localId: string, known: Partial<MappedBatch> = {}): MappedBatch => ({
  batchId,
  localId,
  updatedAt: new Date("2026-10-08T03:11:19.437Z"),
  globalId: batchId,
  archived: false,
  weightRemaining: 250,
  ...known,
});
const withId = (id: string) => ({ extras: { [GLOBAL_ID_KEY]: id } });
const LATER = "2026-10-08T04:00:00.000Z";

describe("readReportedBatches", () => {
  it("reads each batch with its bean's id on the tablet, global id, archived flag, remaining weight and UTC time", () => {
    const batches = readReportedBatches(
      [record(LOCAL[0], { archived: true, weightRemaining: 180.5, extras: { bcUuid: "x", [GLOBAL_ID_KEY]: GLOBAL[0].toUpperCase() } }), record(LOCAL[1], { weightRemaining: undefined })],
      ["2026-10-08T03:11:19.437Z", LATER],
    );
    expect(batches.map(({ record, ...read }) => read)).toEqual([
      { localId: LOCAL[0], beanLocalId: BEAN, globalId: GLOBAL[0], archived: true, weightRemaining: 180.5, updatedAt: new Date("2026-10-08T03:11:19.437Z") },
      { localId: LOCAL[1], beanLocalId: BEAN, globalId: null, archived: false, weightRemaining: null, updatedAt: new Date(LATER) },
    ]);
  });

  it("leaves out records without what every supported Decaid sends, or whose time could not be placed", () => {
    const { beanId, ...noBean } = record(LOCAL[1]);
    expect(
      readReportedBatches([record(LOCAL[0]), noBean, record(""), "not a batch", record(LOCAL[2])], [LATER, LATER, LATER, LATER, null]).map((batch) => batch.localId),
    ).toEqual([LOCAL[0]]);
    expect(readReportedBatches([record(LOCAL[0])], undefined)).toEqual([]);
  });
});

describe("batchContent", () => {
  it("keeps Decaid's fields, unknown ones included, but the record's own and each Location's", () => {
    expect(batchContent(record(LOCAL[0], { notes: "Bright", tastingWheel: ["jasmine"], ...withId(GLOBAL[0]) }))).toEqual({
      roastDate: "2026-10-01T00:00:00.000",
      roastLevel: "medium",
      weight: 250,
      frozen: false,
      notes: "Bright",
      tastingWheel: ["jasmine"],
    });
  });
});

describe("planBatchIntake", () => {
  it("adds a new batch of a bean the tablet's map holds at the tablet's Location, with the remaining weight its record has", () => {
    const batch = reported(LOCAL[0]);
    expect(planBatchIntake([batch], [], beans, [])).toEqual([
      { kind: "add", beanId: LIBRARY_BEAN, batch, edits: [{ field: "at", value: true }, { field: "remainingWeight", value: 250, had: null }] },
    ]);
    // Without a weight, Decaid records no remaining weight, and none is entered.
    const unweighed = reported(LOCAL[1], { weight: undefined, weightRemaining: undefined });
    expect(planBatchIntake([unweighed], [], beans, [])).toEqual([{ kind: "add", beanId: LIBRARY_BEAN, batch: unweighed, edits: [{ field: "at", value: true }] }]);
  });

  it("adds a new batch archived on the tablet to the Library at no Location", () => {
    const batch = reported(LOCAL[0], { archived: true, weightRemaining: 0 });
    expect(planBatchIntake([batch], [], beans, [])).toEqual([{ kind: "add", beanId: LIBRARY_BEAN, batch, edits: [{ field: "remainingWeight", value: 0, had: null }] }]);
  });

  it("leaves a new batch whose bean the tablet's map does not hold for a report taken in once it does", () => {
    expect(planBatchIntake([reported(LOCAL[0], { beanId: "79699013-0984-4a1a-842a-5b84f36e612d" })], [], beans, [])).toEqual([]);
  });

  it("never matches one batch to another: two of a bean with the same fields are two batches", () => {
    const [first, second] = [reported(LOCAL[0]), reported(LOCAL[1])];
    expect(planBatchIntake([first, second], [], beans, []).map((step) => step.kind)).toEqual(["add", "add"]);
  });

  it("finishes a known batch archived on the tablet since at its Location, and adds one un-archived there", () => {
    const archived = reported(LOCAL[0], { archived: true }, LATER);
    expect(planBatchIntake([archived], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([
      { kind: "update", batchId: GLOBAL[0], batch: archived, edits: [{ field: "at", value: false }] },
    ]);
    const restored = reported(LOCAL[0], {}, LATER);
    expect(planBatchIntake([restored], [mapped(GLOBAL[0], LOCAL[0], { archived: true })], beans, [])).toEqual([
      { kind: "update", batchId: GLOBAL[0], batch: restored, edits: [{ field: "at", value: true }] },
    ]);
  });

  it("makes a weightRemaining changed on the tablet its Location's remaining weight, with the value the tablet had", () => {
    const counted = reported(LOCAL[0], { weightRemaining: 180.5 }, LATER);
    expect(planBatchIntake([counted], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([
      { kind: "update", batchId: GLOBAL[0], batch: counted, edits: [{ field: "remainingWeight", value: 180.5, had: 250 }] },
    ]);
    // Cleared, and archived in the same edit.
    const cleared = reported(LOCAL[0], { weightRemaining: undefined, archived: true }, LATER);
    expect(planBatchIntake([cleared], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([
      { kind: "update", batchId: GLOBAL[0], batch: cleared, edits: [{ field: "at", value: false }, { field: "remainingWeight", value: null, had: 250 }] },
    ]);
  });

  it("changes nothing at the Location for a known record changed otherwise, or older than the one known", () => {
    const edited = reported(LOCAL[0], { notes: "Edited", ...withId(GLOBAL[0]) }, LATER);
    expect(planBatchIntake([edited], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([{ kind: "update", batchId: GLOBAL[0], batch: edited, edits: [] }]);
    expect(planBatchIntake([reported(LOCAL[0], { archived: true, ...withId(GLOBAL[0]) }, "2026-10-08T03:00:00.000Z")], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([]);
    // As old, and the same at the Location: nothing changed.
    expect(planBatchIntake([reported(LOCAL[0], { notes: "Edited", ...withId(GLOBAL[0]) })], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([]);
  });

  it("takes a record as old as the one known that differs at the Location as changed within the millisecond times are read to", () => {
    const counted = reported(LOCAL[0], { weightRemaining: 200, ...withId(GLOBAL[0]) });
    expect(planBatchIntake([counted], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([
      { kind: "update", batchId: GLOBAL[0], batch: counted, edits: [{ field: "remainingWeight", value: 200, had: 250 }] },
    ]);
  });

  it("replaces a known record carrying the batch's global id with one that no longer does, whatever its time, so the id is written back", () => {
    const wiped = reported(LOCAL[0], { extras: { otherPlugin: true } }, "2026-10-07T00:00:00.000Z");
    expect(planBatchIntake([wiped], [mapped(GLOBAL[0], LOCAL[0])], beans, [])).toEqual([{ kind: "update", batchId: GLOBAL[0], batch: wiped, edits: [] }]);
  });

  it("maps a record carrying a Library batch's global id to that batch, changing nothing at the Location, as after a lost answer or a restored backup", () => {
    const batch = reported(LOCAL[0], { archived: true, ...withId(GLOBAL[1]) });
    expect(planBatchIntake([batch], [], beans, [{ id: GLOBAL[1] }])).toEqual([{ kind: "map", batchId: GLOBAL[1], batch }]);
    // A global id the Library does not know is new.
    expect(planBatchIntake([batch], [], beans, []).map((step) => step.kind)).toEqual(["add"]);
  });

  it("finishes a batch deleted on the tablet at its Location, but not one it held archived, which was not there", () => {
    const known = mapped(GLOBAL[0], LOCAL[0]);
    expect(planBatchIntake([], [known], beans, [], new Set())).toEqual([
      { kind: "delete", batchId: GLOBAL[0], localId: LOCAL[0], updatedAt: known.updatedAt, edits: [{ field: "at", value: false }] },
    ]);
    expect(planBatchIntake([], [mapped(GLOBAL[0], LOCAL[0], { archived: true })], beans, [], new Set())).toEqual([
      { kind: "delete", batchId: GLOBAL[0], localId: LOCAL[0], updatedAt: known.updatedAt, edits: [] },
    ]);
  });

  it("deletes nothing still listed, though unreadable, or that another record the tablet reports now is, and nothing for an empty map", () => {
    expect(planBatchIntake([], [mapped(GLOBAL[0], LOCAL[0])], beans, [], new Set([LOCAL[0]]))).toEqual([]);
    const again = reported(LOCAL[1], withId(GLOBAL[0]));
    expect(planBatchIntake([again], [mapped(GLOBAL[0], LOCAL[0])], beans, [{ id: GLOBAL[0] }], new Set([LOCAL[1]]))).toEqual([
      { kind: "map", batchId: GLOBAL[0], batch: again },
    ]);
    // A new or reset tablet's map holds nothing: an empty report deletes nothing.
    expect(planBatchIntake([], [], beans, [], new Set())).toEqual([]);
  });
});

describe("editsInAnswer", () => {
  const known = { archived: false, weightRemaining: 250 };

  it("finds what the tablet changed at its Location since its last report in the record Decaid returned for a write", () => {
    // Archived on the tablet just before the server wrote its global id, which kept it archived.
    expect(editsInAnswer(known, record(LOCAL[0], { archived: true, ...withId(GLOBAL[0]) }), new Set())).toEqual([{ field: "at", value: false }]);
    expect(editsInAnswer(known, record(LOCAL[0], { weightRemaining: 180.5 }), new Set())).toEqual([{ field: "remainingWeight", value: 180.5, had: 250 }]);
  });

  it("takes no field the write set for the tablet's change, and finds none in a record the write created", () => {
    expect(editsInAnswer(known, record(LOCAL[0], { archived: true, weightRemaining: 120 }), new Set(["archived", "weightRemaining"]))).toEqual([]);
    expect(editsInAnswer(known, record(LOCAL[0]), new Set())).toEqual([]);
    expect(editsInAnswer(null, record(LOCAL[0], { archived: true }), new Set(["roastDate"]))).toEqual([]);
  });
});
