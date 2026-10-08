import { GLOBAL_ID_KEY, beanMatchKey } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type LibraryBean,
  type MappedBean,
  type ReportedBean,
  archivingInAnswer,
  beanContent,
  planIntake,
  readReportedBeans,
} from "../src/library/bean-intake.js";

// Taking a tablet's report of its beans into the Library, through the pure
// module's interface: Bean matching (ADR-0018), which records are new,
// linked, mapped by the global id they carry, or kept by the tablet's map
// (ADR-0006), and what archiving, un-archiving and deleting one on the
// tablet means at its Location (ADR-0008, ADR-0019). Records are shaped as
// Decaid v0.8.7 serves beans
// (fixtures/decaid/simulated-devices-v0.8.7/beans.json), with made-up ids.

const LOCAL = ["79699013-0984-4a1a-842a-5b84f36e612d", "877a2e9d-8016-43f0-9c43-c0f8866c0a6d", "8ac511b9-81a6-4066-9a5e-5b67da092efc"] as const;
const GLOBAL = ["6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", "7b2d4e3f-5c6a-4b8f-8d9e-1f2a3b4c5d6e", "0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81"] as const;

/** A bean record as Decaid serves one, with the fields given. */
function record(localId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: localId,
    roaster: "Fixture Roaster",
    name: "Fixture Bean",
    decaf: false,
    archived: false,
    createdAt: "2026-10-05T14:03:13.044376",
    updatedAt: "2026-10-05T14:03:13.044376",
    ...fields,
  };
}

function reported(localId: string, fields: Record<string, unknown> = {}, updatedAt = "2026-10-05T19:03:13.044Z"): ReportedBean {
  return readReportedBeans([record(localId, fields)], [updatedAt])[0]!;
}

const library = (id: string, roaster: string, name: string, archived = false): LibraryBean => ({ id, matchKey: beanMatchKey(roaster, name), archived });
/** A record the tablet's map holds, known at a time and, as when its global id was written, carrying one. */
const mapped = (
  beanId: string,
  localId: string,
  updatedAt: string | null = "2026-10-05T19:03:13.044Z",
  globalId: string | null = null,
  archived = false,
): MappedBean => ({
  beanId,
  localId,
  updatedAt: updatedAt === null ? null : new Date(updatedAt),
  globalId,
  archived,
});
const withId = (id: string) => ({ extras: { [GLOBAL_ID_KEY]: id } });

describe("beanMatchKey", () => {
  it("is the same for a roaster and name that differ only in case and white space at either end", () => {
    expect(beanMatchKey("  Roux Bakehouse ", "LAUNCH day blend\t")).toBe(beanMatchKey("roux bakehouse", "Launch Day Blend"));
  });

  it("tells apart names that differ within, and keeps roaster and name apart", () => {
    expect(beanMatchKey("Roux", "Launch  Day")).not.toBe(beanMatchKey("Roux", "Launch Day"));
    expect(beanMatchKey("Roux", "Bakehouse Blend")).not.toBe(beanMatchKey("Roux Bakehouse", "Blend"));
    expect(beanMatchKey("Sandbox", "Washed Heirloom")).not.toBe(beanMatchKey("Roux", "Washed Heirloom"));
  });
});

describe("readReportedBeans", () => {
  it("reads each bean with its global id, archived flag, match key and UTC time", () => {
    const beans = readReportedBeans(
      [record(LOCAL[0], { archived: true, extras: { bcUuid: "x", [GLOBAL_ID_KEY]: GLOBAL[0].toUpperCase() } }), record(LOCAL[1])],
      ["2026-10-05T19:03:13.044Z", "2026-10-05T19:04:00.000Z"],
    );
    expect(beans.map(({ record, ...read }) => read)).toEqual([
      { localId: LOCAL[0], globalId: GLOBAL[0], archived: true, matchKey: beanMatchKey("Fixture Roaster", "Fixture Bean"), updatedAt: new Date("2026-10-05T19:03:13.044Z") },
      { localId: LOCAL[1], globalId: null, archived: false, matchKey: beanMatchKey("Fixture Roaster", "Fixture Bean"), updatedAt: new Date("2026-10-05T19:04:00.000Z") },
    ]);
  });

  it("leaves out records without what every supported Decaid sends, or whose time could not be placed", () => {
    const { roaster, ...noRoaster } = record(LOCAL[1]);
    expect(
      readReportedBeans(
        [record(LOCAL[0]), noRoaster, record(""), record(LOCAL[2], { name: 7 }), "not a bean", record(LOCAL[2])],
        ["2026-10-05T19:03:13.044Z", "2026-10-05T19:03:13.044Z", "2026-10-05T19:03:13.044Z", "2026-10-05T19:03:13.044Z", null, null],
      ).map((bean) => bean.localId),
    ).toEqual([LOCAL[0]]);
    expect(readReportedBeans([record(LOCAL[0])], undefined)).toEqual([]);
    expect(readReportedBeans({ not: "a list" }, [])).toEqual([]);
  });
});

describe("beanContent", () => {
  it("keeps Decaid's fields, unknown ones included, but the record's id, times, archived flag and extras", () => {
    expect(beanContent(record(LOCAL[0], { country: "Ethiopia", tastingWheel: ["jasmine"], ...withId(GLOBAL[0]) }))).toEqual({
      roaster: "Fixture Roaster",
      name: "Fixture Bean",
      decaf: false,
      country: "Ethiopia",
      tastingWheel: ["jasmine"],
    });
  });
});

describe("planIntake", () => {
  it("adds a bean the Library has no match for", () => {
    const bean = reported(LOCAL[0]);
    expect(planIntake([bean], [], [library(GLOBAL[0], "Another Roaster", "Fixture Bean")])).toEqual([{ kind: "add", bean }]);
  });

  it("links a new bean to the oldest Library Bean with its roaster and name, ignoring case and spaces at either end", () => {
    const bean = reported(LOCAL[0], { roaster: " fixture roaster", name: "FIXTURE BEAN " });
    const older = library(GLOBAL[0], "Fixture Roaster", "Fixture Bean");
    const newer = library(GLOBAL[1], "Fixture Roaster", "Fixture Bean");
    expect(planIntake([bean], [], [older, newer])).toEqual([{ kind: "link", beanId: GLOBAL[0], bean }]);
  });

  it("matches no Archived Bean, which is offered nowhere", () => {
    const bean = reported(LOCAL[0]);
    expect(planIntake([bean], [], [library(GLOBAL[0], "Fixture Roaster", "Fixture Bean", true)])).toEqual([{ kind: "add", bean }]);
  });

  it("never links two of a tablet's records to one Bean: a second with the same roaster and name joins the Library", () => {
    const first = reported(LOCAL[0]);
    const second = reported(LOCAL[1]);
    const existing = library(GLOBAL[0], "Fixture Roaster", "Fixture Bean");
    expect(planIntake([first, second], [], [existing])).toEqual([
      { kind: "link", beanId: GLOBAL[0], bean: first },
      { kind: "add", bean: second },
    ]);
    // Nor one the tablet's map holds by another record still reported.
    expect(planIntake([first, second], [mapped(GLOBAL[0], LOCAL[0], "2026-10-06T00:00:00.000Z")], [existing])).toEqual([{ kind: "add", bean: second }]);
  });

  it("maps a record carrying a Library Bean's global id to that Bean, as after a lost answer or a restored backup", () => {
    const bean = reported(LOCAL[0], { name: "Renamed meanwhile", ...withId(GLOBAL[1]) });
    expect(planIntake([bean], [], [library(GLOBAL[1], "Fixture Roaster", "Fixture Bean")])).toEqual([{ kind: "map", beanId: GLOBAL[1], bean }]);
    // Moved from a record the tablet no longer reports.
    expect(planIntake([bean], [mapped(GLOBAL[1], LOCAL[2])], [library(GLOBAL[1], "Fixture Roaster", "Fixture Bean")])).toEqual([
      { kind: "map", beanId: GLOBAL[1], bean },
    ]);
  });

  it("resolves records whose Bean is known before matching others by name, so a duplicate listed first cannot take their Bean", () => {
    // A newer duplicate, entered without a global id, is listed before the record that carries the Bean's id, as
    // after the answer to the write that gave it the id was lost.
    const duplicate = reported(LOCAL[0], {}, "2026-10-07T00:00:00.000Z");
    const tagged = reported(LOCAL[1], withId(GLOBAL[0]));
    const existing = library(GLOBAL[0], "Fixture Roaster", "Fixture Bean");
    expect(planIntake([duplicate, tagged], [], [existing])).toEqual([
      { kind: "map", beanId: GLOBAL[0], bean: tagged },
      { kind: "add", bean: duplicate },
    ]);
    // So too after a record the map holds by its local id.
    expect(planIntake([duplicate, tagged], [mapped(GLOBAL[0], LOCAL[1])], [existing])).toEqual([{ kind: "add", bean: duplicate }]);
  });

  it("takes a record carrying a global id the Library does not know for a new one", () => {
    const bean = reported(LOCAL[0], withId(GLOBAL[2]));
    expect(planIntake([bean], [], [])).toEqual([{ kind: "add", bean }]);
  });

  it("keeps a record the map holds as that Bean, whatever global id it carries, replacing the known record only with a newer one", () => {
    const wiped = reported(LOCAL[0], { extras: { otherPlugin: true } }, "2026-10-06T00:00:00.000Z");
    const other = reported(LOCAL[0], withId(GLOBAL[1]), "2026-10-06T00:00:00.000Z");
    const library_ = [library(GLOBAL[1], "Fixture Roaster", "Fixture Bean")];
    expect(planIntake([wiped], [mapped(GLOBAL[0], LOCAL[0])], library_)).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: wiped }]);
    expect(planIntake([other], [mapped(GLOBAL[0], LOCAL[0])], library_)).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: other }]);
    // As old as the record known, or older, as a report read before the plugin's own write: nothing changes.
    expect(planIntake([wiped], [mapped(GLOBAL[0], LOCAL[0], "2026-10-06T00:00:00.000Z")], library_)).toEqual([]);
    expect(planIntake([wiped], [mapped(GLOBAL[0], LOCAL[0], "2026-10-07T00:00:00.000Z")], library_)).toEqual([]);
    // A known record whose time could not be read is replaced.
    expect(planIntake([wiped], [mapped(GLOBAL[0], LOCAL[0], null)], library_)).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: wiped }]);
  });

  it("replaces a known record carrying the Bean's global id with one that no longer does, whatever its time, so the id is written back", () => {
    // Reported with an older time than the record known, as after the tablet's clock went back or a backup was restored.
    const wiped = reported(LOCAL[0], { extras: { otherPlugin: true } }, "2026-10-06T00:00:00.000Z");
    const intact = reported(LOCAL[0], withId(GLOBAL[0]), "2026-10-06T00:00:00.000Z");
    const known = mapped(GLOBAL[0], LOCAL[0], "2026-10-07T00:00:00.000Z", GLOBAL[0]);
    expect(planIntake([wiped], [known], [])).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: wiped }]);
    // An older record still carrying the id changes nothing.
    expect(planIntake([intact], [known], [])).toEqual([]);
  });

  it("takes a new bean archived on the tablet in, linking it as any other, and reads a record repeated in one report once", () => {
    const archived = reported(LOCAL[0], { archived: true });
    const bean = reported(LOCAL[1], { name: "Another Bean" });
    expect(planIntake([archived, bean, bean], [], [])).toEqual([
      { kind: "add", bean: archived },
      { kind: "add", bean },
    ]);
    expect(planIntake([archived], [], [library(GLOBAL[0], "Fixture Roaster", "Fixture Bean")])).toEqual([{ kind: "link", beanId: GLOBAL[0], bean: archived }]);
  });

  it("says a known record archived on the tablet since takes its Bean away from the Location, and one un-archived offers it there again", () => {
    const archived = reported(LOCAL[0], { archived: true }, "2026-10-06T00:00:00.000Z");
    const restored = reported(LOCAL[0], {}, "2026-10-06T00:00:00.000Z");
    expect(planIntake([archived], [mapped(GLOBAL[0], LOCAL[0])], [])).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: archived, archived: true }]);
    expect(planIntake([restored], [mapped(GLOBAL[0], LOCAL[0], undefined, null, true)], [])).toEqual([
      { kind: "update", beanId: GLOBAL[0], bean: restored, archived: false },
    ]);
    // A record changed otherwise changes nothing at the Location.
    const edited = reported(LOCAL[0], { notes: "Edited" }, "2026-10-06T00:00:00.000Z");
    expect(planIntake([edited], [mapped(GLOBAL[0], LOCAL[0])], [])).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: edited }]);
    // Archived within the millisecond times are read to, as old as the record known.
    const quick = reported(LOCAL[0], { archived: true }, "2026-10-05T19:03:13.044Z");
    expect(planIntake([quick], [mapped(GLOBAL[0], LOCAL[0])], [])).toEqual([{ kind: "update", beanId: GLOBAL[0], bean: quick, archived: true }]);
  });

  it("reads a record the map holds that the list no longer holds as deleted on the tablet", () => {
    const kept = reported(LOCAL[1]);
    const known = mapped(GLOBAL[0], LOCAL[0], "2026-10-05T19:03:13.044Z");
    expect(planIntake([kept], [known, mapped(GLOBAL[1], LOCAL[1])], [], new Set([LOCAL[1]]))).toEqual([
      { kind: "delete", beanId: GLOBAL[0], localId: LOCAL[0], updatedAt: new Date("2026-10-05T19:03:13.044Z") },
    ]);
    // Still listed, though no longer a record Decent Sync can read, it was not deleted.
    expect(planIntake([kept], [known, mapped(GLOBAL[1], LOCAL[1])], [], new Set([LOCAL[0], LOCAL[1]]))).toEqual([]);
  });

  it("deletes no Bean another record the tablet reports now is, as one made again under another id", () => {
    const again = reported(LOCAL[1], withId(GLOBAL[0]));
    expect(planIntake([again], [mapped(GLOBAL[0], LOCAL[0])], [library(GLOBAL[0], "Fixture Roaster", "Fixture Bean")], new Set([LOCAL[1]]))).toEqual([
      { kind: "map", beanId: GLOBAL[0], bean: again },
    ]);
  });

  it("deletes nothing for a tablet whose map holds nothing, as a new or reset tablet's, whatever it reports", () => {
    expect(planIntake([], [], [], new Set())).toEqual([]);
    const bean = reported(LOCAL[0]);
    expect(planIntake([bean], [], [library(GLOBAL[0], "Fixture Roaster", "Fixture Bean")], new Set([LOCAL[0]]))).toEqual([
      { kind: "link", beanId: GLOBAL[0], bean },
    ]);
  });
});

describe("archivingInAnswer", () => {
  it("says the record Decaid returned for a write shows the tablet archived or un-archived the Bean since its last report", () => {
    expect(archivingInAnswer(false, record(LOCAL[0], { archived: true }), new Set())).toBe(true);
    expect(archivingInAnswer(true, record(LOCAL[0]), new Set())).toBe(false);
  });

  it("says nothing when the write set archived itself, the record known agrees, or none is known", () => {
    expect(archivingInAnswer(false, record(LOCAL[0], { archived: true }), new Set(["archived"]))).toBeUndefined();
    expect(archivingInAnswer(false, record(LOCAL[0]), new Set())).toBeUndefined();
    expect(archivingInAnswer(null, record(LOCAL[0], { archived: true }), new Set())).toBeUndefined();
  });
});
