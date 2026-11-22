import { describe, expect, it } from "vitest";
import { type FieldEdits, changedFields, editsAfter, holdsContentAsDecided, latestDecision, mergeEdit } from "../src/library/merge.js";

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

  it("decides fields that name one choice together as one where the edit holds them all: losing either, it loses both (#570)", () => {
    // A Recipe's Bean last set at 09:00, and its batch, of that Bean, picked on Uptown at 10:00. Belmont picked another
    // Bean's batch at 09:30, with its Bean, without having seen either.
    const recipe = { beanId: "ethiopia", beanBatchId: "ethiopia-2" };
    const recipeEdits: FieldEdits = { beanId: edits.roaster!, beanBatchId: edits.notes! };
    const pick = { values: { beanId: "brazil", beanBatchId: "brazil-1" }, at: at("09:30:00.000"), tabletId: BELMONT, seenAt: null };
    const together = [["beanId", "beanBatchId"]];
    expect(mergeEdit(recipe, recipeEdits, pick)).toEqual({ applied: { beanId: "brazil" }, lost: { beanBatchId: "brazil-1" }, overwritten: [expect.objectContaining({ field: "beanId" })] });
    expect(mergeEdit(recipe, recipeEdits, pick, together)).toEqual({ applied: {}, lost: { beanId: "brazil", beanBatchId: "brazil-1" }, overwritten: [] });
    // One made after both wins both; one holding only the batch is decided as any field.
    expect(mergeEdit(recipe, recipeEdits, { ...pick, at: at("10:05:00.000") }, together).applied).toEqual({ beanId: "brazil", beanBatchId: "brazil-1" });
    expect(mergeEdit(recipe, recipeEdits, { ...pick, values: { beanBatchId: "ethiopia-3" } }, together)).toEqual({ applied: {}, lost: { beanBatchId: "ethiopia-3" }, overwritten: [] });
    // A field of the choice that the edit leaves as it is loses with it and is kept as no Conflict.
    expect(mergeEdit(recipe, recipeEdits, { ...pick, values: { beanId: "ethiopia", beanBatchId: "ethiopia-3" } }, together)).toEqual({ applied: {}, lost: { beanBatchId: "ethiopia-3" }, overwritten: [] });
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

// A tablet's record as Decaid returned it for a write whose answer the
// server took in with no earlier record of the tablet's to judge it by, as
// one that reached it only after a reconnect: judged against the item as it
// stood when the write's content was decided (ticket #629).

describe("holdsContentAsDecided", () => {
  // The write carried the content as decided at 10:01, the notes' latest edit.
  const written = at("10:01:00.000");

  it("holds the content written though a field was edited after the write's content was decided, and has then seen the edits decided by then", () => {
    const retitled: FieldEdits = { ...edits, name: { at: "2026-10-08T10:05:00.000Z", decidedAt: "2026-10-08T10:05:00.500Z", tabletId: null, versionId: VERSION } };
    expect(holdsContentAsDecided({ ...current, name: "Guji Hambela Natural" }, retitled, current, written)).toBe(true);
    // Its next edit of the notes, timed before Uptown's, which it had seen, applies.
    expect(mergeEdit(current, retitled, { values: { notes: "Jasmine" }, at: at("09:59:00.000"), tabletId: BELMONT, seenAt: written })).toEqual({
      applied: { notes: "Jasmine" },
      lost: {},
      overwritten: [],
    });
  });

  it("does not hold it when the record differs in a field not edited since, whatever else was", () => {
    const retitled: FieldEdits = { ...edits, name: { at: "2026-10-08T10:05:00.000Z", decidedAt: "2026-10-08T10:05:00.500Z", tabletId: null, versionId: VERSION } };
    expect(holdsContentAsDecided({ ...current, name: "Guji Hambela Natural" }, retitled, { ...current, country: "Kenya" }, written)).toBe(false);
    // A field nobody has edited is held as the item holds it.
    expect(holdsContentAsDecided({ ...current, process: "Washed" }, edits, current, written)).toBe(false);
    // Nor when the field was last decided exactly then, as the write carried that edit.
    expect(holdsContentAsDecided(current, edits, { ...current, notes: "Apricot" }, written)).toBe(false);
  });

  it("does not hold it when the answer repeats no time its content was decided", () => {
    expect(holdsContentAsDecided(current, edits, current, null)).toBe(false);
  });
});

// Edits of one field that tablets made out of each other's sight, as while
// offline, merged in the order they reach the server, as content-edits.ts
// carries each out.

const ANNEX = "5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b";

interface Arrival {
  tabletId: string;
  notes: string;
  at: Date;
}

/** The notes once the edits have arrived in this order, and every value kept as a Conflict on the way, sorted. */
function arrive(order: Arrival[]): { notes: unknown; conflicts: unknown[] } {
  let content: Record<string, unknown> = {};
  let fieldEdits: FieldEdits = {};
  const conflicts: unknown[] = [];
  order.forEach((edit, n) => {
    // No tablet's record had seen what the server wrote of another's edit.
    const merged = mergeEdit(content, fieldEdits, { values: { notes: edit.notes }, at: edit.at, tabletId: edit.tabletId, seenAt: null });
    conflicts.push(...Object.values(merged.lost), ...merged.overwritten.map(({ value }) => value));
    content = { ...content, ...merged.applied };
    // Decided a minute apart by PostgreSQL's clock, in the order they arrived.
    fieldEdits = editsAfter(fieldEdits, merged.applied, edit, new Date(Date.UTC(2026, 9, 9, 12, n)), VERSION);
  });
  return { notes: content.notes, conflicts: conflicts.sort() };
}

/** Every order of the items. */
function orders<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, n) => orders([...items.slice(0, n), ...items.slice(n + 1)]).map((rest) => [item, ...rest]));
}

const named = (order: Arrival[]) => order.map((edit) => edit.notes).join(", ");

describe("edits of one field made out of each other's sight", () => {
  it("keep the latest, and every other as a Conflict, whatever order they arrive in, where each is another tablet's", () => {
    const tablets = [UPTOWN, BELMONT, LAB, ANNEX];
    const notes = ["Peach", "Jasmine", "Apricot", "Bergamot"];
    for (let count = 2; count <= tablets.length; count++) {
      const made = tablets.slice(0, count).map((tabletId, n) => ({ tabletId, notes: notes[n]!, at: at(`10:${n}0:00.000`) }));
      const kept = { notes: made.at(-1)!.notes, conflicts: made.slice(0, -1).map((edit) => edit.notes).sort() };
      for (const order of orders(made)) expect(arrive(order), named(order)).toEqual(kept);
    }
  });

  it("keep a tablet's own earlier value as a Conflict only where another tablet's edit arrived between its two", () => {
    const peach = { tabletId: UPTOWN, notes: "Peach", at: at("10:00:00.000") };
    const jasmine = { tabletId: BELMONT, notes: "Jasmine", at: at("10:10:00.000") };
    const apricot = { tabletId: UPTOWN, notes: "Apricot", at: at("10:20:00.000") };
    // Belmont's edit overwrote Peach before Uptown's next arrived, so Peach is kept, and then Belmont's own.
    expect(arrive([peach, jasmine, apricot])).toEqual({ notes: "Apricot", conflicts: ["Jasmine", "Peach"] });
    // Uptown had replaced Peach itself by the time Belmont's edit arrived, so only Belmont's is kept.
    expect(arrive([peach, apricot, jasmine])).toEqual({ notes: "Apricot", conflicts: ["Jasmine"] });
  });

  it("keep the latest, and every other tablet's last value as a Conflict, whatever order they arrive in, each tablet's own in the order it made them", () => {
    // Two tablets, then three, taking turns for up to five edits.
    for (const tablets of [
      [UPTOWN, BELMONT],
      [UPTOWN, BELMONT, LAB],
    ]) {
      for (let count = 2; count <= 5; count++) {
        const made = Array.from({ length: count }, (_, n) => ({ tabletId: tablets[n % tablets.length]!, notes: `Notes ${n + 1}`, at: at(`10:0${n}:00.000`) }));
        const latest = made.at(-1)!;
        const lastOf = (tabletId: string) => [...made].reverse().find((edit) => edit.tabletId === tabletId);
        const inOwnOrder = (order: Arrival[]) =>
          tablets.every((tabletId) => {
            const own = order.filter((edit) => edit.tabletId === tabletId);
            return own.every((edit, n) => n === 0 || edit.at.getTime() > own[n - 1]!.at.getTime());
          });
        for (const order of orders(made).filter(inOwnOrder)) {
          const { notes, conflicts } = arrive(order);
          expect(notes, named(order)).toBe(latest.notes);
          for (const tabletId of tablets) {
            const last = lastOf(tabletId);
            if (last && tabletId !== latest.tabletId) expect(conflicts, named(order)).toContain(last.notes);
          }
          // Nothing is kept but a value that lost.
          expect(made.slice(0, -1).map((edit) => edit.notes), named(order)).toEqual(expect.arrayContaining(conflicts));
        }
      }
    }
  });
});
