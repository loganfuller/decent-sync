import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  type HeldRecord,
  type LocationBatch,
  type LocationOffer,
  type ShownProfile,
  type TabletHoldings,
  batchesAwaitingBeans,
  plannedWrites,
  writeKey,
} from "../src/library/holdings.js";

// What a tablet should hold for its Location (ADR-0008), through the pure
// module's interface: the writes, in order, that bring a tablet's Beans,
// Bean Batches, Grinders and Profiles to what the Location offers. Records
// are shaped as Decaid v0.8.7 serves them (fixtures/decaid/
// bean-batch-writes-v0.8.7/, grinder-writes-v0.8.7/ and
// profile-writes-v0.8.7/), with made-up ids.

const BEANS = ["6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", "7b2d4e3f-5c6a-4b8f-8d9e-1f2a3b4c5d6e"] as const;
const BATCHES = ["3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c", "5a7c9e1b-2d3f-4a5b-8c6d-9e0f1a2b3c4d"] as const;
const LOCAL_BEAN = "1ebec875-1533-46d3-bc5f-9de5c85d9c2b";
const LOCAL_BATCH = "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca";
const GRINDERS = ["7b2d4e6f-8a1c-4d3e-9f5a-6b7c8d9e0f1a", "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"] as const;
const LOCAL_GRINDER = "4d09e759-76b3-4e91-a095-cb9887e8f9db";

const PROFILES = ["profile:bf1ca48b9c7389c7d146", "profile:e8ec02bda185095cd94f"] as const;
const BUNDLED = "profile:ca3086783cd9569e128c";

const beanContent = { roaster: "Fixture Roaster", name: "Batch Fixture Bean", decaf: false };
/** A Profile's content, as profile-writes-v0.8.7 recorded it, trimmed to one step, with a parent and metadata. */
const profileContent = {
  profile: {
    version: "2",
    title: "Fixture Lab Bloom",
    notes: "Made up for the recording",
    author: "Decent Sync fixtures",
    beverage_type: "espresso",
    steps: [{ name: "Bloom", pump: "flow", transition: "fast", exit: null, volume: 100, seconds: 10, weight: 0, temperature: 92, sensor: "coffee", flow: 4, limiter: null }],
    target_volume: null,
    target_weight: 36,
    target_volume_count_start: 2,
    tank_temperature: 0,
  },
  metadataHash: "3042422d1b16c9885b8a7def9b2771dcb6a140b13db16655dab3f3ae5d09d79f",
  compoundHash: "ae0a37cea35c8fc60d3ce2daafd2f63f3bc4cf4005c2b1892e99a665af287f5f",
  parentId: PROFILES[1],
  isDefault: false,
  metadata: { fixture: "lab" },
};
const grinderContent = { model: "Fixture Grinder", burrs: "Fixture 63mm", notes: "Lab", settingType: "numeric" };
const batchContent = { roastDate: "2026-10-01T00:00:00.000", roastLevel: "medium", weight: 250, frozen: false };

/** When the Location last decided each batch's presence, any of a Bean's batches' and each Profile's showing, by PostgreSQL's clock: what a write's record then holds. */
const DECIDED = new Date("2026-10-08T12:00:00.000Z");
/** When the latest edit of each item's content was decided, by PostgreSQL's clock: what a write's record then holds of it. */
const EDITED = new Date("2026-10-08T11:00:00.000Z");

/** A batch as the Location has it: offered there with 180.5 g left, unless given otherwise. */
const batch = (id: string, state: Partial<LocationBatch> = {}): LocationBatch => ({
  id,
  beanId: BEANS[0],
  content: batchContent,
  contentDecidedAt: EDITED,
  offered: true,
  remainingWeight: 180.5,
  decidedAt: DECIDED,
  ...state,
});
const offer = (beans: string[], batches: LocationBatch[] = [], profiles: ShownProfile[] = [], grinders: string[] = []): LocationOffer => ({
  beans: beans.map((id) => ({ id, content: beanContent, decidedAt: DECIDED, contentDecidedAt: EDITED })),
  batches,
  grinders: grinders.map((id) => ({ id, content: grinderContent, contentDecidedAt: EDITED })),
  profiles,
});
/** What the tablet holds: no Profiles or Grinders unless given. */
const holding = (beans: HeldRecord[], batches: HeldRecord[], profiles: HeldRecord[] = [], grinders: HeldRecord[] = []): TabletHoldings => ({
  beans,
  batches,
  grinders,
  profiles,
});

/** A Profile the Location shows, with its content, as one the tablet lacks has it, unless given otherwise. */
const shown = (id: string, fields: Partial<ShownProfile> = {}): ShownProfile => ({
  id,
  bundled: false,
  content: profileContent,
  decidedAt: DECIDED,
  contentDecidedAt: EDITED,
  ...fields,
});
/** A Profile's title, author and notes, as the Library has them. */
const profileText = { title: profileContent.profile.title, author: profileContent.profile.author, notes: profileContent.profile.notes };
/** The tablet's record of a Profile, as the map holds it for planning: its visibility and its title, author and notes, the Library's unless given. */
const heldProfile = (id: string, visibility: string, text: Record<string, unknown> = profileText): HeldRecord => ({
  itemId: id,
  localId: id,
  record: { visibility, profile: text },
  content: profileText,
  contentDecidedAt: EDITED,
});

/** The tablet's record of a Bean, carrying its global id, not archived, unless given otherwise. */
function heldBean(beanId: string, fields: Record<string, unknown> = {}): HeldRecord {
  return {
    itemId: beanId,
    localId: LOCAL_BEAN,
    record: { id: LOCAL_BEAN, ...beanContent, archived: false, extras: { [GLOBAL_ID_KEY]: beanId }, ...fields },
    content: beanContent,
    contentDecidedAt: EDITED,
  };
}
/** The tablet's record of a Grinder, carrying its global id, not archived, unless given otherwise. */
function heldGrinder(grinderId: string, fields: Record<string, unknown> = {}): HeldRecord {
  return {
    itemId: grinderId,
    localId: LOCAL_GRINDER,
    record: { id: LOCAL_GRINDER, ...grinderContent, archived: false, extras: { [GLOBAL_ID_KEY]: grinderId }, ...fields },
    content: grinderContent,
    contentDecidedAt: EDITED,
  };
}
/** The tablet's record of a batch, carrying its global id, at the Location with 180.5 g left, unless given otherwise. */
function heldBatch(batchId: string, fields: Record<string, unknown> = {}): HeldRecord {
  return {
    itemId: batchId,
    localId: LOCAL_BATCH,
    record: { id: LOCAL_BATCH, beanId: LOCAL_BEAN, ...batchContent, weightRemaining: 180.5, archived: false, extras: { [GLOBAL_ID_KEY]: batchId }, ...fields },
    content: batchContent,
    contentDecidedAt: EDITED,
  };
}

describe("plannedWrites", () => {
  it("writes nothing to a tablet that holds what its Location offers, as its Location has it", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), holding([heldBean(BEANS[0])], [heldBatch(BATCHES[0])]))).toEqual([]);
  });

  it("writes a Bean the tablet lacks before its batch, which waits for the tablet's record of it", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), holding([], []))).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: null, fields: beanContent, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
  });

  it("creates a batch under the tablet's record of its Bean, with the Location's remaining weight, or none if none was entered there", () => {
    const held = holding([heldBean(BEANS[0])], []);
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: null, fields: { ...batchContent, beanId: LOCAL_BEAN, weightRemaining: 180.5 }, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: undefined })]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: null, fields: { ...batchContent, beanId: LOCAL_BEAN }, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
  });

  it("un-archives a Bean and a batch the Location offers that the tablet holds archived, and writes the Location's remaining weight", () => {
    const held = holding([heldBean(BEANS[0], { archived: true })], [heldBatch(BATCHES[0], { archived: true, weightRemaining: 250 })]);
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), held)).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: { archived: false }, expected: { archived: true }, decidedAt: DECIDED, contentDecidedAt: EDITED },
      {
        kind: "beanBatch",
        globalId: BATCHES[0],
        localId: LOCAL_BATCH,
        fields: { archived: false, weightRemaining: 180.5 },
        expected: { archived: true, weightRemaining: 250 },
        decidedAt: DECIDED,
        contentDecidedAt: EDITED,
      },
    ]);
  });

  it("clears a remaining weight cleared at the Location, and keeps the tablet's own where none was ever entered there", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: null })]), holding([heldBean(BEANS[0])], [heldBatch(BATCHES[0])]))).toEqual([
      {
        kind: "beanBatch",
        globalId: BATCHES[0],
        localId: LOCAL_BATCH,
        fields: { weightRemaining: null },
        expected: { weightRemaining: 180.5 },
        decidedAt: DECIDED,
        contentDecidedAt: EDITED,
      },
    ]);
    expect(
      plannedWrites(offer([BEANS[0]], [batch(BATCHES[0], { remainingWeight: undefined })]), holding([heldBean(BEANS[0])], [heldBatch(BATCHES[0])])),
    ).toEqual([]);
  });

  it("archives, never deletes, what the tablet holds that its Location no longer offers: batches before their Beans", () => {
    const held = holding([{ ...heldBean(BEANS[0]), decidedAt: DECIDED }], [heldBatch(BATCHES[0])]);
    expect(plannedWrites(offer([], [batch(BATCHES[0], { offered: false })]), held)).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: { archived: true }, expected: { archived: false }, decidedAt: DECIDED, contentDecidedAt: EDITED },
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: { archived: true }, expected: { archived: false }, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
    // Already archived, they are left as they are.
    expect(
      plannedWrites(offer([], [batch(BATCHES[0], { offered: false })]), holding([heldBean(BEANS[0], { archived: true })], [heldBatch(BATCHES[0], { archived: true })])),
    ).toEqual([]);
  });

  it("writes nothing for a batch the Location does not offer and the tablet does not hold", () => {
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[1], { offered: false })]), holding([heldBean(BEANS[0])], []))).toEqual([]);
  });

  it("writes the global id back to a record that lost it, beside any other field due, keeping it offered or not", () => {
    const wiped = { extras: { otherPlugin: true } };
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])]), holding([heldBean(BEANS[0], wiped)], [heldBatch(BATCHES[0], wiped)]))).toEqual([
      { kind: "bean", globalId: BEANS[0], localId: LOCAL_BEAN, fields: {}, expected: {}, decidedAt: DECIDED, contentDecidedAt: EDITED },
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: {}, expected: {}, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
    expect(plannedWrites(offer([]), holding([heldBean(BEANS[1], { ...wiped, archived: true })], []))).toEqual([
      { kind: "bean", globalId: BEANS[1], localId: LOCAL_BEAN, fields: {}, expected: {}, decidedAt: null, contentDecidedAt: EDITED },
    ]);
  });

  it("writes Beans the Location offers first, then batches, then archives the Beans it does not, each in the order given", () => {
    const other = "72a68d6e-7986-43c7-9134-a9a78b6803ed";
    const held = holding([heldBean(BEANS[0], { archived: true }), { ...heldBean(BEANS[1]), localId: other }], []);
    const writes = plannedWrites(offer([BEANS[0]], [batch(BATCHES[0]), batch(BATCHES[1])]), held);
    expect(writes.map((write) => [write.kind, write.globalId, write.localId ?? "create"])).toEqual([
      ["bean", BEANS[0], LOCAL_BEAN],
      ["beanBatch", BATCHES[0], "create"],
      ["beanBatch", BATCHES[1], "create"],
      ["bean", BEANS[1], other],
    ]);
  });

  it("creates a Profile the Location shows that the tablet lacks, visible, with its parent and metadata, and never one of Decaid's bundled Profiles", () => {
    expect(plannedWrites(offer([], [], [shown(PROFILES[0]), shown(BUNDLED, { bundled: true, content: null })]), holding([], []))).toEqual([
      { kind: "profile", globalId: PROFILES[0], localId: null, fields: { profile: profileContent.profile, parentId: PROFILES[1], metadata: { fixture: "lab" }, visibility: "visible" }, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
    // Without a parent or metadata, Decaid is sent none.
    const plain = { profile: profileContent.profile, isDefault: false };
    expect(plannedWrites(offer([], [], [shown(PROFILES[0], { content: plain })]), holding([], []))).toEqual([
      { kind: "profile", globalId: PROFILES[0], localId: null, fields: { profile: plain.profile, parentId: null, metadata: null, visibility: "visible" }, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
  });

  it("shows a Profile the Location shows that the tablet holds hidden or deleted, bundled ones included, and hides, never deletes, one it holds visible that the Location does not show", () => {
    const held = holding([], [], [heldProfile(PROFILES[0], "hidden"), heldProfile(BUNDLED, "deleted"), heldProfile(PROFILES[1], "visible")]);
    const shows = (id: string, visibility: string, was: string, decidedAt: Date | null) => ({
      kind: "profile",
      globalId: id,
      localId: id,
      fields: { visibility },
      expected: { visibility: was },
      decidedAt,
      contentDecidedAt: EDITED,
    });
    expect(plannedWrites(offer([], [], [shown(PROFILES[0], { content: null }), shown(BUNDLED, { bundled: true, content: null })]), held)).toEqual([
      shows(PROFILES[0], "visible", "hidden", DECIDED),
      shows(BUNDLED, "visible", "deleted", DECIDED),
      shows(PROFILES[1], "hidden", "visible", null),
    ]);
    // One the Location does not show, hidden or deleted on the tablet, is left as it is.
    expect(plannedWrites(offer([]), holding([], [], [heldProfile(PROFILES[0], "hidden"), heldProfile(PROFILES[1], "deleted")]))).toEqual([]);
    expect(plannedWrites(offer([], [], [shown(PROFILES[0], { content: null })]), holding([], [], [heldProfile(PROFILES[0], "visible")]))).toEqual([]);
  });

  it("creates a Profile after the one it was saved from where both are to be created, so the tablet keeps its parent", () => {
    const child = { ...profileContent, parentId: PROFILES[1] };
    const parent = { ...profileContent, parentId: null };
    const writes = plannedWrites(offer([], [], [shown(PROFILES[0], { content: child }), shown(BUNDLED, { bundled: true, content: null }), shown(PROFILES[1], { content: parent })]), holding([], []));
    expect(writes.map((write) => [write.globalId, write.fields.parentId])).toEqual([
      [PROFILES[1], null],
      [PROFILES[0], PROFILES[1]],
    ]);
    // A parent the tablet holds already, or that is not to be created, changes nothing.
    expect(plannedWrites(offer([], [], [shown(PROFILES[0], { content: child }), shown(PROFILES[1], { content: null })]), holding([], [], [heldProfile(PROFILES[1], "visible")])).map((write) => write.globalId)).toEqual([
      PROFILES[0],
    ]);
  });

  it("writes Profiles after Beans and Bean Batches, those the Location shows first", () => {
    const held = holding([heldBean(BEANS[0])], [], [heldProfile(PROFILES[1], "visible")]);
    const writes = plannedWrites(offer([], [], [shown(PROFILES[0])]), held);
    expect(writes.map((write) => [write.kind, write.globalId, write.localId ?? "create"])).toEqual([
      ["bean", BEANS[0], LOCAL_BEAN],
      ["profile", PROFILES[0], "create"],
      ["profile", PROFILES[1], PROFILES[1]],
    ]);
  });

  it("creates a Grinder its Location offers that the tablet lacks, un-archives one it holds archived, and archives, never deletes, one it does not offer", () => {
    expect(plannedWrites(offer([], [], [], [GRINDERS[0]]), holding([], []))).toEqual([
      { kind: "grinder", globalId: GRINDERS[0], localId: null, fields: grinderContent, decidedAt: null, contentDecidedAt: EDITED },
    ]);
    expect(plannedWrites(offer([], [], [], [GRINDERS[0]]), holding([], [], [], [heldGrinder(GRINDERS[0], { archived: true })]))).toEqual([
      { kind: "grinder", globalId: GRINDERS[0], localId: LOCAL_GRINDER, fields: { archived: false }, expected: { archived: true }, decidedAt: null, contentDecidedAt: EDITED },
    ]);
    expect(plannedWrites(offer([]), holding([], [], [], [heldGrinder(GRINDERS[1])]))).toEqual([
      { kind: "grinder", globalId: GRINDERS[1], localId: LOCAL_GRINDER, fields: { archived: true }, expected: { archived: false }, decidedAt: null, contentDecidedAt: EDITED },
    ]);
    // Held as the Location has it, archived or not, nothing is written; a lost global id is written back.
    expect(plannedWrites(offer([], [], [], [GRINDERS[0]]), holding([], [], [], [heldGrinder(GRINDERS[0])]))).toEqual([]);
    expect(plannedWrites(offer([]), holding([], [], [], [heldGrinder(GRINDERS[1], { archived: true })]))).toEqual([]);
    expect(plannedWrites(offer([], [], [], [GRINDERS[0]]), holding([], [], [], [heldGrinder(GRINDERS[0], { extras: { otherPlugin: true } })]))).toEqual([
      { kind: "grinder", globalId: GRINDERS[0], localId: LOCAL_GRINDER, fields: {}, expected: {}, decidedAt: null, contentDecidedAt: EDITED },
    ]);
  });

  it("writes Grinders after Beans and Bean Batches and before Profiles, those the Location offers first", () => {
    const other = "6c9d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
    const held = holding([heldBean(BEANS[0], { archived: true })], [], [heldProfile(PROFILES[1], "visible")], [{ ...heldGrinder(GRINDERS[1]), localId: other }]);
    const writes = plannedWrites(offer([BEANS[0]], [], [shown(PROFILES[0])], [GRINDERS[0]]), held);
    expect(writes.map((write) => [write.kind, write.globalId, write.localId ?? "create"])).toEqual([
      ["bean", BEANS[0], LOCAL_BEAN],
      ["grinder", GRINDERS[0], "create"],
      ["grinder", GRINDERS[1], other],
      ["profile", PROFILES[0], "create"],
      ["profile", PROFILES[1], PROFILES[1]],
    ]);
  });

  it("writes an item's content where a record the tablet holds differs, offered there or not, with the value the record holds for each field", () => {
    const edited = { ...beanContent, notes: "Bright", country: "Ethiopia" };
    const held = holding([{ ...heldBean(BEANS[0], { notes: "Dull", species: "Arabica" }), content: edited }], []);
    const update = {
      kind: "bean",
      globalId: BEANS[0],
      localId: LOCAL_BEAN,
      fields: { notes: "Bright", country: "Ethiopia", species: null },
      expected: { notes: "Dull", country: null, species: "Arabica" },
      decidedAt: DECIDED,
      contentDecidedAt: EDITED,
    };
    expect(plannedWrites(offer([BEANS[0]]), held)).toEqual([update]);
    // Archived where the Location does not offer it, it is written the content with its archiving.
    expect(plannedWrites(offer([]), { ...held, beans: [{ ...held.beans[0]!, decidedAt: DECIDED }] })).toEqual([
      { ...update, fields: { ...update.fields, archived: true }, expected: { ...update.expected, archived: false } },
    ]);
    // A batch's and a Grinder's content the same way, never their Location's state as content.
    const batchHeld = { ...heldBatch(BATCHES[0], { notes: "Old" }), content: { ...batchContent, notes: "New" } };
    const grinderHeld = { ...heldGrinder(GRINDERS[0], { burrs: "Fixture 64mm" }), content: grinderContent };
    expect(plannedWrites(offer([BEANS[0]], [batch(BATCHES[0])], [], [GRINDERS[0]]), holding([heldBean(BEANS[0])], [batchHeld], [], [grinderHeld]))).toEqual([
      { kind: "beanBatch", globalId: BATCHES[0], localId: LOCAL_BATCH, fields: { notes: "New" }, expected: { notes: "Old" }, decidedAt: DECIDED, contentDecidedAt: EDITED },
      { kind: "grinder", globalId: GRINDERS[0], localId: LOCAL_GRINDER, fields: { burrs: "Fixture 63mm" }, expected: { burrs: "Fixture 64mm" }, decidedAt: null, contentDecidedAt: EDITED },
    ]);
  });

  it("writes a user's Profile's title, author and notes to every record the tablet holds of it, beside its visibility, and none to a bundled one", () => {
    const renamed = { ...profileText, title: "Lab Bloom", notes: null };
    const held = holding([], [], [
      { ...heldProfile(PROFILES[0], "hidden"), content: renamed },
      { ...heldProfile(PROFILES[1], "hidden"), content: renamed },
      { ...heldProfile(BUNDLED, "visible", { title: "Bundled" }), content: null },
    ]);
    expect(plannedWrites(offer([], [], [shown(PROFILES[0], { content: null }), shown(BUNDLED, { bundled: true, content: null })]), held)).toEqual([
      {
        kind: "profile",
        globalId: PROFILES[0],
        localId: PROFILES[0],
        fields: { title: "Lab Bloom", notes: null, visibility: "visible" },
        expected: { title: profileText.title, notes: profileText.notes, visibility: "hidden" },
        decidedAt: DECIDED,
        contentDecidedAt: EDITED,
      },
      {
        kind: "profile",
        globalId: PROFILES[1],
        localId: PROFILES[1],
        fields: { title: "Lab Bloom", notes: null },
        expected: { title: profileText.title, notes: profileText.notes },
        decidedAt: null,
        contentDecidedAt: EDITED,
      },
    ]);
  });

  it("leaves out the items skipped for the connection", () => {
    const skipped = new Set([writeKey("bean", BEANS[0])]);
    expect(plannedWrites(offer([BEANS[0], BEANS[1]]), holding([], []), skipped)).toEqual([
      { kind: "bean", globalId: BEANS[1], localId: null, fields: beanContent, decidedAt: DECIDED, contentDecidedAt: EDITED },
    ]);
  });
});

describe("batchesAwaitingBeans", () => {
  it("names the Bean of each batch the Location offers that waits for the tablet's record of its Bean, and none it holds or does not offer", () => {
    const offered = offer([BEANS[0], BEANS[1]], [batch(BATCHES[0]), batch(BATCHES[1], { beanId: BEANS[1] }), batch("9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f", { offered: false })]);
    expect(batchesAwaitingBeans(offered, holding([], []))).toEqual([BEANS[0], BEANS[1]]);
    // A batch whose Bean the tablet holds is planned itself, and one it holds is written as any record.
    expect(batchesAwaitingBeans(offered, holding([heldBean(BEANS[0])], []))).toEqual([BEANS[1]]);
    expect(batchesAwaitingBeans(offered, holding([], [heldBatch(BATCHES[0])]))).toEqual([BEANS[1]]);
  });
});
