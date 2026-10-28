import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { type MappedGrinder, type ReportedGrinder, grinderContent, planGrinderIntake, readReportedGrinders } from "../src/library/grinder-intake.js";

// Taking a tablet's report of its grinders into the Library, through the
// pure module's interface: which records are new, mapped by the global id
// they carry, or kept by the tablet's map (ADR-0006, ADR-0018), and the
// mapping from what changed in them to the Library's state of each Grinder
// (ADR-0019): archived or deleted on the tablet, it is Archived, and
// un-archived, restored. Records are shaped as Decaid v0.8.7 serves grinders
// (fixtures/decaid/grinder-writes-v0.8.7/), with made-up ids.

const LOCAL = ["4d09e759-76b3-4e91-a095-cb9887e8f9db", "a8a1d229-ed41-45aa-8e1b-515dc3275758", "cdfe7f8d-ba7e-4c0e-993f-ef3c17b46b7a"] as const;
const GLOBAL = ["7b2d4e6f-8a1c-4d3e-9f5a-6b7c8d9e0f1a", "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"] as const;
const TIME = "2026-10-08T18:34:34.492Z";
const LATER = "2026-10-08T19:00:00.000Z";

/** A grinder record as Decaid serves one, with the fields given. */
function record(localId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: localId,
    model: "Fixture Grinder",
    burrs: "Fixture 63mm",
    notes: "Lab",
    archived: false,
    settingType: "numeric",
    createdAt: "2026-10-08T13:34:34.492968",
    updatedAt: "2026-10-08T13:34:34.492968",
    ...fields,
  };
}

function reported(localId: string, fields: Record<string, unknown> = {}, updatedAt = TIME): ReportedGrinder {
  return readReportedGrinders([record(localId, fields)], [updatedAt])[0]!;
}

/** A record the tablet's map holds, as it was known: carrying its global id, not archived, unless given otherwise. */
const mapped = (grinderId: string, localId: string, known: Partial<MappedGrinder> = {}): MappedGrinder => ({
  grinderId,
  localId,
  updatedAt: new Date(TIME),
  globalId: grinderId,
  archived: false,
  record: record(localId),
  ...known,
});
const withId = (id: string) => ({ extras: { [GLOBAL_ID_KEY]: id } });

describe("readReportedGrinders", () => {
  it("reads each grinder with its global id, archived flag and UTC time", () => {
    const grinders = readReportedGrinders(
      [record(LOCAL[0], { archived: true, extras: { otherPluginId: "x", [GLOBAL_ID_KEY]: GLOBAL[0].toUpperCase() } }), record(LOCAL[1])],
      [TIME, LATER],
    );
    expect(grinders.map(({ record, ...read }) => read)).toEqual([
      { localId: LOCAL[0], globalId: GLOBAL[0], archived: true, updatedAt: new Date(TIME) },
      { localId: LOCAL[1], globalId: null, archived: false, updatedAt: new Date(LATER) },
    ]);
  });

  it("leaves out records without what every supported Decaid sends, or whose time could not be placed", () => {
    const { model, ...noModel } = record(LOCAL[1]);
    expect(readReportedGrinders([record(LOCAL[0]), noModel, record(""), "not a grinder", record(LOCAL[2])], [LATER, LATER, LATER, LATER, null]).map((grinder) => grinder.localId)).toEqual([
      LOCAL[0],
    ]);
  });

  it("keeps as content every field but the record's id, times, archived flag and extras", () => {
    expect(grinderContent(record(LOCAL[0], { burrSize: 63, fixtureUnknown: "kept", ...withId(GLOBAL[0]) }))).toEqual({
      model: "Fixture Grinder",
      burrs: "Fixture 63mm",
      notes: "Lab",
      settingType: "numeric",
      burrSize: 63,
      fixtureUnknown: "kept",
    });
  });
});

describe("planGrinderIntake", () => {
  it("adds each grinder new to the Library, two of one model included, archived on the tablet or not: Grinders are never matched", () => {
    const steps = planGrinderIntake([reported(LOCAL[0]), reported(LOCAL[1]), reported(LOCAL[2], { archived: true })], [], new Set());
    expect(steps.map((step) => [step.kind, step.kind === "add" ? step.grinder.localId : "", step.kind === "add" && step.grinder.archived])).toEqual([
      ["add", LOCAL[0], false],
      ["add", LOCAL[1], false],
      ["add", LOCAL[2], true],
    ]);
  });

  it("maps a record carrying a Library Grinder's global id, but not twice, and adds one carrying a global id the Library lacks", () => {
    const steps = planGrinderIntake(
      [reported(LOCAL[0], withId(GLOBAL[0])), reported(LOCAL[1], withId(GLOBAL[0])), reported(LOCAL[2], withId(GLOBAL[1]))],
      [],
      new Set([GLOBAL[0]]),
    );
    expect(steps.map((step) => [step.kind, "grinder" in step ? step.grinder.localId : ""])).toEqual([
      ["map", LOCAL[0]],
      ["add", LOCAL[1]],
      ["add", LOCAL[2]],
    ]);
  });

  it("Archives a Grinder archived on the tablet since, and restores one un-archived since, within the millisecond too", () => {
    expect(planGrinderIntake([reported(LOCAL[0], { archived: true, ...withId(GLOBAL[0]) }, LATER)], [mapped(GLOBAL[0], LOCAL[0])], new Set())).toMatchObject([
      { kind: "update", grinderId: GLOBAL[0], archived: true },
    ]);
    expect(planGrinderIntake([reported(LOCAL[0], withId(GLOBAL[0]))], [mapped(GLOBAL[0], LOCAL[0], { archived: true })], new Set())).toMatchObject([
      { kind: "update", grinderId: GLOBAL[0], archived: false },
    ]);
  });

  it("replaces the record known when newer without Archiving anything, and changes nothing for one as old or older", () => {
    const [step] = planGrinderIntake([reported(LOCAL[0], { notes: "Retuned", ...withId(GLOBAL[0]) }, LATER)], [mapped(GLOBAL[0], LOCAL[0])], new Set());
    expect(step).toMatchObject({ kind: "update", grinderId: GLOBAL[0] });
    expect(step).not.toHaveProperty("archived");
    expect(planGrinderIntake([reported(LOCAL[0], withId(GLOBAL[0]))], [mapped(GLOBAL[0], LOCAL[0])], new Set())).toEqual([]);
    expect(planGrinderIntake([reported(LOCAL[0], { archived: true, ...withId(GLOBAL[0]) }, "2026-10-08T18:00:00.000Z")], [mapped(GLOBAL[0], LOCAL[0])], new Set())).toEqual([]);
  });

  it("keeps a record whose global id another plugin wiped as its Grinder, whatever its time, so the id is written back", () => {
    expect(planGrinderIntake([reported(LOCAL[0], { extras: { otherPluginId: "x" } }, "2026-10-08T18:00:00.000Z")], [mapped(GLOBAL[0], LOCAL[0])], new Set())).toMatchObject([
      { kind: "update", grinderId: GLOBAL[0] },
    ]);
  });

  it("Archives a Grinder the tablet deleted, only if it held it unarchived, and deletes nothing for a record still listed but unreadable", () => {
    expect(planGrinderIntake([], [mapped(GLOBAL[0], LOCAL[0]), mapped(GLOBAL[1], LOCAL[1], { archived: true })], new Set())).toEqual([
      { kind: "delete", grinderId: GLOBAL[0], localId: LOCAL[0], updatedAt: new Date(TIME), archived: true },
      { kind: "delete", grinderId: GLOBAL[1], localId: LOCAL[1], updatedAt: new Date(TIME) },
    ]);
    expect(planGrinderIntake([], [mapped(GLOBAL[0], LOCAL[0])], new Set(), new Set([LOCAL[0]]))).toEqual([]);
  });

  it("deletes nothing for a Grinder another of the tablet's records is now", () => {
    expect(planGrinderIntake([reported(LOCAL[1], withId(GLOBAL[0]))], [mapped(GLOBAL[0], LOCAL[0])], new Set([GLOBAL[0]]))).toEqual([
      { kind: "map", grinderId: GLOBAL[0], grinder: reported(LOCAL[1], withId(GLOBAL[0])) },
    ]);
  });

  it("deletes nothing on a new or reset tablet, whose map holds nothing", () => {
    expect(planGrinderIntake([], [], new Set([GLOBAL[0]]))).toEqual([]);
  });
});
