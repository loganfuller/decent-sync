import { GLOBAL_ID_KEY, equipmentMatchKey } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type MappedEquipment,
  type ReportedEquipment,
  editedContent,
  equipmentContent,
  beforeWriteAfter,
  heldBefore,
  planEquipmentIntake,
  readReportedEquipment,
} from "../src/library/equipment-intake.js";
import { dye2Keys } from "./support/simulated-dye2.js";

// How a tablet's report of DYE2's baskets or tools is taken into the Library
// (ADR-0005, ADR-0006, ADR-0018, ADR-0019), through the pure module's
// interface. Records are DYE2 v0.1.19's, as it saved them
// (fixtures/decaid/dye2-v0.1.19/keys.json), with made-up global ids.

const [basket18, basket20] = dye2Keys().baskets as [Record<string, unknown>, Record<string, unknown>];
const [wdt, puckScreen] = dye2Keys().equipment as [Record<string, unknown>, Record<string, unknown>];
const ITEMS = ["2f9c1e4a-6b3d-4c8e-9a1f-5d7b3c9e1a2f", "8e1a3c5b-7d9f-4b2e-8c4a-6f1d3b5e7a9c", "4c6e8a1b-3d5f-4a7c-9e2b-1f3d5a7c9e1b"] as const;
const READ = "2026-10-12T20:30:00.000Z";

const carrying = (record: Record<string, unknown>, id: string) => ({ ...record, [GLOBAL_ID_KEY]: id });
const reported = (record: Record<string, unknown>): ReportedEquipment => readReportedEquipment([record], [READ])[0]!;
const mapped = (itemId: string, record: Record<string, unknown>, state: Partial<MappedEquipment> = {}): MappedEquipment => ({
  itemId,
  localId: record.id as string,
  updatedAt: new Date(READ),
  record: carrying(record, itemId),
  beforeWrite: null,
  listed: true,
  ...state,
});

describe("DYE2's baskets and tools as Library items", () => {
  it("keeps every field of a record but its id, its creation time and its global id as the item's content", () => {
    expect(equipmentContent(carrying(basket18, ITEMS[0]))).toEqual({ name: "Fixture 18g Precision", size: "double", notes: "Fixture notes, edited", diameterMm: 58.4 });
    expect(equipmentContent(wdt)).toEqual({ name: "Fixture WDT Tool", custom: wdt.custom });
    // Fields DYE2 may add later are kept.
    expect(equipmentContent({ ...puckScreen, colour: "black" })).toMatchObject({ colour: "black" });
  });

  it("reads each record with its id and name, the global id its own field carries, and when the plugin first read it", () => {
    const records = readReportedEquipment([carrying(basket18, ITEMS[0].toUpperCase()), basket20], [READ, null]);
    // A record without a time is left out; one carrying a global id has it in lower case.
    expect(records).toEqual([
      { localId: basket18.id, globalId: ITEMS[0], matchKey: equipmentMatchKey("Fixture 18g Precision"), updatedAt: new Date(READ), record: carrying(basket18, ITEMS[0].toUpperCase()) },
    ]);
    // A record without a name, which DYE2 always saves, is left out.
    expect(readReportedEquipment([{ id: "x" }], [READ])).toEqual([]);
    // A list in a shape that is not recognised gives none.
    expect(readReportedEquipment({ baskets: [basket18] }, undefined)).toEqual([]);
    expect(readReportedEquipment([basket18, { ...basket20, id: basket18.id }], [READ, READ])).toEqual([]);
  });

  it("takes a field set back to what the tablet held just before the server's write to it as unchanged", () => {
    const written = { ...wdt, custom: [{ key: "Needles", value: "12" }], name: "Fixture WDT" };
    const before = heldBefore(wdt, ["custom", "name"]);
    expect(before).toEqual({ custom: wdt.custom, name: wdt.name });
    // A save from a page opened before the write, or a write lost to the list rewritten at once, sets both back: no edit.
    expect(editedContent(written, wdt, before)).toEqual({});
    // A field the write did not set, changed there, is an edit; so is one set to another value.
    expect(editedContent(written, { ...wdt, notes: "new" }, before)).toEqual({ notes: "new" });
    expect(editedContent(written, { ...written, name: "WDT" }, before)).toEqual({ name: "WDT" });
    // A field the write set that the tablet held no value for, left out again, is unchanged too.
    expect(editedContent({ ...basket20, notes: "written" }, basket20, heldBefore(basket20, ["notes"]))).toEqual({});
    // With no write known, every change is an edit.
    expect(editedContent(written, wdt, null)).toEqual({ custom: wdt.custom, name: wdt.name });
  });

  it("forgets a field's value before the server's write once the tablet sets it to a value of its own, so setting it back is an edit", () => {
    const written = { ...wdt, notes: "B" };
    const before = heldBefore({ ...wdt, notes: "A" }, ["notes"]);
    // Reported as written, or set back by a stale save, it still stands.
    expect(beforeWriteAfter(before, written, written)).toEqual({ notes: "A" });
    expect(beforeWriteAfter(before, written, { ...wdt, notes: "A" })).toEqual({ notes: "A" });
    // Set to C on the tablet, it is gone: setting A after that is the barista's edit.
    expect(beforeWriteAfter(before, written, { ...wdt, notes: "C" })).toBeNull();
    expect(editedContent({ ...wdt, notes: "C" }, { ...wdt, notes: "A" }, null)).toEqual({ notes: "A" });
    // Only the field set otherwise is forgotten.
    expect(beforeWriteAfter({ notes: "A", name: "Old" }, written, { ...written, notes: "C" })).toEqual({ name: "Old" });
    expect(beforeWriteAfter(null, written, written)).toBeNull();
  });
});

describe("planEquipmentIntake", () => {
  const library = [
    { id: ITEMS[0], matchKey: equipmentMatchKey("Fixture 18g Precision"), archived: false },
    { id: ITEMS[1], matchKey: equipmentMatchKey("Fixture 20g High-flow"), archived: true },
  ];

  it("links a record new to the Library to an item of the same name, ignoring case and spaces at either end, not Archived", () => {
    const shouted = reported({ ...basket18, name: "  FIXTURE 18G PRECISION " });
    expect(planEquipmentIntake([shouted, reported(basket20)], [], library)).toEqual([
      { kind: "link", itemId: ITEMS[0], reported: shouted },
      // The only one of its name is Archived, so it joins the Library.
      { kind: "add", reported: reported(basket20) },
    ]);
    // Two records of one name: the item is the first's only.
    const again = reported({ ...basket18, id: "c0ffee00-0000-4000-8000-000000000000" });
    expect(planEquipmentIntake([reported(basket18), again], [], library).map((step) => step.kind)).toEqual(["link", "add"]);
  });

  it("knows a record the map holds by its id, and one carrying an item's global id that it does not", () => {
    const lost = reported(basket18);
    // Its global id lost, it is the item still, and replaces the record known.
    expect(planEquipmentIntake([lost], [mapped(ITEMS[0], basket18)], library)).toEqual([{ kind: "update", itemId: ITEMS[0], reported: lost, content: {} }]);
    // Unchanged, it changes nothing.
    expect(planEquipmentIntake([reported(carrying(basket18, ITEMS[0]))], [mapped(ITEMS[0], basket18)], library)).toEqual([]);
    const restored = reported(carrying(basket18, ITEMS[0]));
    expect(planEquipmentIntake([restored], [], library)).toEqual([{ kind: "map", itemId: ITEMS[0], reported: restored }]);
    // An edit is the fields it changed.
    const edited = reported(carrying({ ...basket18, notes: "Re-measured" }, ITEMS[0]));
    expect(planEquipmentIntake([edited], [mapped(ITEMS[0], basket18)], library)).toEqual([{ kind: "update", itemId: ITEMS[0], reported: edited, content: { notes: "Re-measured" } }]);
  });

  it("reads a record gone from the list as deleted there once a report listed it, and as a write lost otherwise", () => {
    const listed = mapped(ITEMS[2], wdt);
    const written = mapped(ITEMS[1], puckScreen, { listed: false });
    expect(planEquipmentIntake([], [listed, written], [])).toEqual([
      { kind: "delete", itemId: ITEMS[2], localId: wdt.id, updatedAt: new Date(READ) },
      { kind: "forget", itemId: ITEMS[1], localId: puckScreen.id },
    ]);
    // A record still in the list, though it cannot be read, is not gone.
    expect(planEquipmentIntake([], [listed], [], new Set([wdt.id as string]))).toEqual([]);
    // Nor is an item another record the tablet reports is now.
    const again = reported(carrying({ ...wdt, id: "c0ffee00-0000-4000-8000-000000000001" }, ITEMS[2]));
    expect(planEquipmentIntake([again], [listed], [{ id: ITEMS[2], matchKey: equipmentMatchKey("Fixture WDT Tool"), archived: false }])).toEqual([
      { kind: "map", itemId: ITEMS[2], reported: again },
    ]);
  });
});
