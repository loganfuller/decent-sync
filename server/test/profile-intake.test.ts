import { describe, expect, it } from "vitest";
import { type MappedProfile, type ReportedProfile, planProfileIntake, profileContent, readReportedProfiles } from "../src/library/profile-intake.js";

// Taking a tablet's report of its profiles into the Library, through the pure
// module's interface: which records are new to the Library, which are a
// Library Profile the tablet's map did not hold, and the mapping from what
// changed in the records it held to whether the Profile is shown at the
// tablet's Location (ADR-0008, ADR-0019). A Profile keeps Decaid's id, so a
// record's id is its Profile's (ADR-0006). Records are shaped as Decaid
// v0.8.7 serves profiles (fixtures/decaid/profile-writes-v0.8.7/).

const IDS = ["profile:bf1ca48b9c7389c7d146", "profile:e8ec02bda185095cd94f", "profile:b314408be6113ebbcb25"] as const;
const BUNDLED = "profile:ca3086783cd9569e128c";
const KNOWN_AT = "2026-10-08T12:38:17.051Z";
const LATER = "2026-10-08T12:40:00.000Z";

/** A profile record as Decaid serves one, visible, with the fields given. */
function record(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    profile: { version: "2", title: "Fixture Lab Bloom", notes: "", author: "", beverage_type: "espresso", steps: [], target_volume: null, target_weight: 36, target_volume_count_start: 2, tank_temperature: 0 },
    metadataHash: "3042422d1b16c9885b8a7def9b2771dcb6a140b13db16655dab3f3ae5d09d79f",
    compoundHash: "ae0a37cea35c8fc60d3ce2daafd2f63f3bc4cf4005c2b1892e99a665af287f5f",
    parentId: null,
    visibility: "visible",
    isDefault: false,
    createdAt: "2026-10-08T07:38:17.051786",
    updatedAt: "2026-10-08T07:38:17.051786",
    metadata: null,
    ...fields,
  };
}

function reported(id: string, fields: Record<string, unknown> = {}, updatedAt = KNOWN_AT): ReportedProfile {
  return readReportedProfiles([record(id, fields)], [updatedAt])[0]!;
}

/** A record the tablet's map holds, as it was known: visible, unless given otherwise. */
const mapped = (profileId: string, known: Partial<MappedProfile> = {}): MappedProfile => ({ profileId, updatedAt: new Date(KNOWN_AT), visible: true, ...known });

/** The steps a report makes, by what each changes at the Location. */
const plan = (...args: Parameters<typeof planProfileIntake>) =>
  planProfileIntake(...args).map((step) => [step.kind, step.kind === "add" ? step.profile.id : step.profileId, step.shown ?? "unchanged"]);

describe("readReportedProfiles", () => {
  it("reads each profile with whether it is visible, whether it is bundled and its UTC time", () => {
    const profiles = readReportedProfiles(
      [record(IDS[0]), record(IDS[1], { visibility: "hidden" }), record(IDS[2], { visibility: "deleted" }), record(BUNDLED, { isDefault: true })],
      [KNOWN_AT, KNOWN_AT, KNOWN_AT, LATER],
    );
    expect(profiles.map(({ record, ...read }) => read)).toEqual([
      { id: IDS[0], visible: true, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: IDS[1], visible: false, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: IDS[2], visible: false, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: BUNDLED, visible: true, bundled: true, updatedAt: new Date(LATER) },
    ]);
  });

  it("leaves out a record without what every supported Decaid sends: its id, profile, visibility and a time the plugin could place", () => {
    const { profile, visibility, ...bare } = record(IDS[1]);
    const profiles = readReportedProfiles(
      [record(IDS[0]), record(""), { ...bare, profile }, { ...bare, visibility }, record(IDS[2]), record(BUNDLED), "profile"],
      [KNOWN_AT, KNOWN_AT, KNOWN_AT, KNOWN_AT, null, KNOWN_AT, KNOWN_AT],
    );
    expect(profiles.map((profile) => profile.id)).toEqual([IDS[0], BUNDLED]);
    expect(readReportedProfiles({ not: "a list" }, [])).toEqual([]);
  });

  it("keeps Decaid's fields as a Profile's content, those unknown included, but its id, times and visibility", () => {
    const content = profileContent(record(IDS[0], { parentId: IDS[1], metadata: { fixture: "lab" }, futureField: 1 }));
    expect(Object.keys(content)).toEqual(["profile", "metadataHash", "compoundHash", "parentId", "isDefault", "metadata", "futureField"]);
    expect(content).toMatchObject({ parentId: IDS[1], metadata: { fixture: "lab" }, futureField: 1 });
  });
});

describe("planProfileIntake", () => {
  it("adds a Profile new to the Library, shown at the tablet's Location if visible there, and hidden there if not", () => {
    expect(plan([reported(IDS[0]), reported(IDS[1], { visibility: "hidden" })], [], new Set(), new Map())).toEqual([
      ["add", IDS[0], true],
      ["add", IDS[1], false],
    ]);
  });

  it("takes a Library Profile the map did not hold as that Profile: its visibility decides it where the Location has decided nothing, as for an identical Profile created at two Locations", () => {
    const library = new Set([IDS[0], BUNDLED]);
    expect(plan([reported(IDS[0]), reported(BUNDLED, { isDefault: true, visibility: "hidden" })], [], library, new Map())).toEqual([
      ["map", IDS[0], true],
      ["map", BUNDLED, false],
    ]);
  });

  it("keeps the Location's state of a Library Profile the map did not hold, so a new tablet's bundled Profiles do not show those its Location hid", () => {
    const library = new Set([IDS[0], BUNDLED]);
    const located = new Map([
      [BUNDLED, false],
      [IDS[0], true],
    ]);
    expect(plan([reported(BUNDLED, { isDefault: true }), reported(IDS[0], { visibility: "hidden" })], [], library, located)).toEqual([
      ["map", BUNDLED, "unchanged"],
      ["map", IDS[0], "unchanged"],
    ]);
  });

  it("hides at the tablet's Location a Profile it held visible that it hid or deleted since, and shows one it made visible", () => {
    const known = [mapped(IDS[0]), mapped(IDS[1]), mapped(BUNDLED, { visible: false })];
    const report = [reported(IDS[0], { visibility: "hidden" }, LATER), reported(IDS[1], { visibility: "deleted" }, LATER), reported(BUNDLED, { isDefault: true }, LATER)];
    expect(plan(report, known, new Set(), new Map())).toEqual([
      ["update", IDS[0], false],
      ["update", IDS[1], false],
      ["update", BUNDLED, true],
    ]);
  });

  it("changes nothing at the Location for a record that only changed otherwise, or went from hidden to deleted", () => {
    const known = [mapped(IDS[0]), mapped(IDS[1], { visible: false })];
    const report = [reported(IDS[0], { profile: { title: "Renamed" } }, LATER), reported(IDS[1], { visibility: "deleted" }, LATER)];
    expect(plan(report, known, new Set(), new Map())).toEqual([
      ["update", IDS[0], "unchanged"],
      ["update", IDS[1], "unchanged"],
    ]);
  });

  it("takes a record as old as the one known only if it was shown or hidden since, within the millisecond the plugin reads times to, and an older one not at all", () => {
    expect(plan([reported(IDS[0], { visibility: "hidden" })], [mapped(IDS[0])], new Set(), new Map())).toEqual([["update", IDS[0], false]]);
    expect(plan([reported(IDS[0])], [mapped(IDS[0])], new Set(), new Map())).toEqual([]);
    expect(plan([reported(IDS[0], { visibility: "hidden" }, "2026-10-08T12:00:00.000Z")], [mapped(IDS[0])], new Set(), new Map())).toEqual([]);
    // One known without a time is replaced by any.
    expect(plan([reported(IDS[0], { visibility: "hidden" }, "2026-10-08T12:00:00.000Z")], [mapped(IDS[0], { updatedAt: null })], new Set(), new Map())).toEqual([
      ["update", IDS[0], false],
    ]);
  });

  it("hides at the Location a Profile gone from the tablet that it held visible, as when its steps changed and Decaid replaced it under a new id, which is a new Profile shown there", () => {
    // Decaid's PUT with new steps: the old id is gone, and the new one is new to the Library.
    expect(plan([reported(IDS[2], {}, LATER)], [mapped(IDS[0])], new Set(), new Map())).toEqual([
      ["add", IDS[2], true],
      ["delete", IDS[0], false],
    ]);
    // Purged while hidden there, it was not shown there already.
    expect(plan([], [mapped(IDS[1], { visible: false })], new Set(), new Map())).toEqual([["delete", IDS[1], "unchanged"]]);
  });

  it("deletes only what the tablet's map held, and nothing whose id the list still holds, readable or not", () => {
    // A new or reset tablet lacking the Location's Profiles hides none of them (ADR-0019).
    expect(plan([], [], new Set([IDS[0]]), new Map([[IDS[0], true]]))).toEqual([]);
    expect(plan([], [mapped(IDS[0])], new Set(), new Map(), new Set([IDS[0]]))).toEqual([]);
  });

  it("reads a record listed twice once", () => {
    expect(plan([reported(IDS[0]), reported(IDS[0], { visibility: "hidden" })], [], new Set(), new Map())).toEqual([["add", IDS[0], true]]);
  });
});
