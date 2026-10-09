import { describe, expect, it } from "vitest";
import { type FieldEdits, changedFields, editsAfter, latestDecision, mergeEdit } from "../src/library/merge.js";

// The per-field merge of Library edits and its Conflicts (ADR-0020), through
// the pure module's interface: which fields an edit changed, which of them it
// decides, and which values are kept as Conflicts. Tablet and version ids are
// made up.

const UPTOWN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const BELMONT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const LAB = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const VERSION = "3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f";

/** A Bean's content: its notes last set by Uptown at 10:00, decided by PostgreSQL's clock at 10:01. */
const current = { roaster: "Roux", name: "Guji Hambela", country: "Ethiopia", notes: "Peach" };
const edits: FieldEdits = {
  roaster: { at: "2026-10-08T09:00:00.000Z", decidedAt: "2026-10-08T09:00:01.000Z", tabletId: LAB, versionId: VERSION },
  name: { at: "2026-10-08T09:00:00.000Z", decidedAt: "2026-10-08T09:00:01.000Z", tabletId: LAB, versionId: VERSION },
  country: { at: "2026-10-08T09:00:00.000Z", decidedAt: "2026-10-08T09:00:01.000Z", tabletId: LAB, versionId: VERSION },
  notes: { at: "2026-10-08T10:00:00.000Z", decidedAt: "2026-10-08T10:01:00.000Z", tabletId: UPTOWN, versionId: "4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a" },
};

const at = (time: string) => new Date(`2026-10-08T${time}Z`);

describe("changedFields", () => {
  it("is each field that differs between two records, with the newer one's value, a field left out being null", () => {
    expect(changedFields({ notes: "Peach", species: "Arabica", altitude: [1700, 1900] }, { notes: "Jasmine", altitude: [1700, 1900], region: "Guji" })).toEqual({
      notes: "Jasmine",
      species: null,
      region: "Guji",
    });
  });

  it("compares objects whatever their keys' order and arrays by their elements, and a field held as null as one left out", () => {
    expect(changedFields({ metadata: { a: 1, b: 2 }, variety: ["Heirloom"], decafProcess: null }, { metadata: { b: 2, a: 1 }, variety: ["Heirloom"] })).toEqual({});
    expect(changedFields({ variety: ["Caturra", "Castillo"] }, { variety: ["Castillo", "Caturra"] })).toEqual({ variety: ["Castillo", "Caturra"] });
  });
});

describe("mergeEdit", () => {
  it("decides each field an edit changed that its tablet had seen the latest edit of, whatever its time", () => {
    // Belmont was written the Bean after Uptown's notes were decided, then edited them with a clock behind.
    const merged = mergeEdit(current, edits, { values: { notes: "Jasmine" }, at: at("09:30:00.000"), tabletId: BELMONT, seenAt: at("10:01:00.000") });
    expect(merged).toEqual({ applied: { notes: "Jasmine" }, lost: {}, overwritten: [] });
  });

  it("decides a field whose latest edit was its own tablet's, whatever else its record has seen", () => {
    const merged = mergeEdit(current, edits, { values: { notes: "Apricot" }, at: at("09:30:00.000"), tabletId: UPTOWN, seenAt: null });
    expect(merged).toEqual({ applied: { notes: "Apricot" }, lost: {}, overwritten: [] });
  });

  it("merges edits of different fields made without seeing each other, with no Conflict", () => {
    // Belmont, offline since it was written the Bean at 09:00:01, edits its country; Uptown's notes stand.
    const merged = mergeEdit(current, edits, { values: { country: "Kenya" }, at: at("09:45:00.000"), tabletId: BELMONT, seenAt: at("09:00:01.000") });
    expect(merged).toEqual({ applied: { country: "Kenya" }, lost: {}, overwritten: [] });
  });

  it("lets a later edit of a field win over one it had not seen, keeping the value it replaced as a Conflict from where that came", () => {
    const merged = mergeEdit(current, edits, { values: { notes: "Jasmine" }, at: at("10:05:00.000"), tabletId: BELMONT, seenAt: at("09:00:01.000") });
    expect(merged).toEqual({ applied: { notes: "Jasmine" }, lost: {}, overwritten: [{ field: "notes", value: "Peach", versionId: edits.notes!.versionId }] });
  });

  it("keeps an earlier edit of a field that its tablet had not seen the latest edit of as a Conflict, even when it arrives later", () => {
    const merged = mergeEdit(current, edits, { values: { notes: "Jasmine", country: "Kenya" }, at: at("09:55:00.000"), tabletId: BELMONT, seenAt: at("09:00:01.000") });
    expect(merged).toEqual({ applied: { country: "Kenya" }, lost: { notes: "Jasmine" }, overwritten: [] });
  });

  it("keeps no Conflict between two edits that set a field to the same value, and the later one still decides it", () => {
    const later = mergeEdit(current, edits, { values: { notes: "Peach" }, at: at("10:05:00.000"), tabletId: BELMONT, seenAt: null });
    expect(later).toEqual({ applied: { notes: "Peach" }, lost: {}, overwritten: [] });
    const earlier = mergeEdit(current, edits, { values: { notes: "Peach" }, at: at("09:55:00.000"), tabletId: BELMONT, seenAt: null });
    expect(earlier).toEqual({ applied: {}, lost: {}, overwritten: [] });
  });

  it("decides a field nobody has edited yet, and one cleared, as null", () => {
    expect(mergeEdit(current, edits, { values: { region: "Guji", notes: null }, at: at("10:05:00.000"), tabletId: UPTOWN, seenAt: null })).toEqual({
      applied: { region: "Guji", notes: null },
      lost: {},
      overwritten: [],
    });
  });

  it("lets an edit made at the same time as the field's latest win, as the later to arrive", () => {
    const merged = mergeEdit(current, edits, { values: { notes: "Jasmine" }, at: at("10:00:00.000"), tabletId: BELMONT, seenAt: null });
    expect(merged.applied).toEqual({ notes: "Jasmine" });
    expect(merged.overwritten).toHaveLength(1);
  });
});

describe("editsAfter", () => {
  it("makes the fields an edit decided its latest, never timed earlier than the edit before it", () => {
    const decidedAt = at("10:10:00.000");
    const next = editsAfter(edits, { notes: "Jasmine", region: "Guji" }, { at: at("09:30:00.000"), tabletId: BELMONT }, decidedAt, VERSION);
    expect(next.notes).toEqual({ at: "2026-10-08T10:00:00.000Z", decidedAt: "2026-10-08T10:10:00.000Z", tabletId: BELMONT, versionId: VERSION });
    expect(next.region).toEqual({ at: "2026-10-08T09:30:00.000Z", decidedAt: "2026-10-08T10:10:00.000Z", tabletId: BELMONT, versionId: VERSION });
    expect(next.country).toEqual(edits.country);
    // An edit timed between the two, from a tablet that had seen neither, now loses to the one that applied.
    expect(mergeEdit({ ...current, notes: "Jasmine" }, next, { values: { notes: "Apricot" }, at: at("09:45:00.000"), tabletId: LAB, seenAt: null }).lost).toEqual({
      notes: "Apricot",
    });
  });

  it("gives the latest decision of an item's fields, which a record written its content then has seen", () => {
    expect(latestDecision(edits)).toEqual(at("10:01:00.000"));
    expect(latestDecision({})).toBeNull();
  });
});
