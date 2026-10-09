import { describe, expect, it } from "vitest";
import {
  type LocationProfile,
  type MappedProfile,
  type ReportedProfile,
  planProfileIntake,
  profileContent,
  readReportedProfiles,
  visibilityInAnswer,
} from "../src/library/profile-intake.js";

// Taking a tablet's report of its profiles into the Library, through the pure
// module's interface: which records are new to the Library, which are a
// Library Profile the tablet's map did not hold, and the mapping from what
// changed in the records it held to whether the Profile is shown at the
// tablet's Location (ADR-0008, ADR-0019, ADR-0020). A Profile keeps Decaid's
// id, so a record's id is its Profile's (ADR-0006). Records are shaped as
// Decaid v0.8.7 serves profiles (fixtures/decaid/profile-writes-v0.8.7/).

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
const mapped = (profileId: string, known: Partial<MappedProfile> = {}): MappedProfile => ({
  profileId,
  updatedAt: new Date(KNOWN_AT),
  visible: true,
  deleted: false,
  record: record(profileId),
  ...known,
});

/** When the tablet joined its Location, before the records reported: what it holds, it brought. */
const JOINED = new Date("2026-10-08T12:00:00.000Z");
/** The Location's state of a Profile, decided by an edit at that time, another tablet's unless given otherwise. */
const at = (shown: boolean, changedAt = "2026-10-08T12:30:00.000Z", byTablet = false): LocationProfile => ({ shown, changedAt: new Date(changedAt), byTablet });

/**
 * The steps a report makes, each with what it does at the Location: an edit
 * showing or hiding the Profile, deciding it where the Location had not, or
 * nothing.
 */
function plan(
  reported: readonly ReportedProfile[],
  mapped: readonly MappedProfile[],
  library: ReadonlySet<string> = new Set(),
  located: ReadonlyMap<string, LocationProfile> = new Map(),
  listed?: ReadonlySet<string>,
) {
  return planProfileIntake(reported, mapped, library, located, JOINED, listed).map((step) => {
    const id = step.kind === "add" ? step.profile.id : step.profileId;
    if (step.kind === "decide") return [step.kind, id, `decides ${step.shown ? "shown" : "hidden"}`];
    if ((step.kind === "add" || step.kind === "map") && step.decide !== undefined) return [step.kind, id, `decides ${step.decide ? "shown" : "hidden"}`];
    return [step.kind, id, step.shown === undefined ? "unchanged" : step.shown ? "shows" : "hides"];
  });
}

describe("readReportedProfiles", () => {
  it("reads each profile with whether it is visible, deleted or bundled and its UTC time", () => {
    const profiles = readReportedProfiles(
      [record(IDS[0]), record(IDS[1], { visibility: "hidden" }), record(IDS[2], { visibility: "deleted" }), record(BUNDLED, { isDefault: true })],
      [KNOWN_AT, KNOWN_AT, KNOWN_AT, LATER],
    );
    expect(profiles.map(({ record, ...read }) => read)).toEqual([
      { id: IDS[0], visible: true, deleted: false, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: IDS[1], visible: false, deleted: false, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: IDS[2], visible: false, deleted: true, bundled: false, updatedAt: new Date(KNOWN_AT) },
      { id: BUNDLED, visible: true, deleted: false, bundled: true, updatedAt: new Date(LATER) },
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
    expect(plan([reported(IDS[0]), reported(IDS[1], { visibility: "hidden" })], [])).toEqual([
      ["add", IDS[0], "decides shown"],
      ["add", IDS[1], "decides hidden"],
    ]);
  });

  it("takes a Library Profile the map did not hold as that Profile: its visibility decides it where the Location has decided nothing, as for an identical Profile created at two Locations", () => {
    const library = new Set([IDS[0], BUNDLED]);
    expect(plan([reported(IDS[0]), reported(BUNDLED, { isDefault: true, visibility: "hidden" })], [], library)).toEqual([
      ["map", IDS[0], "decides shown"],
      ["map", BUNDLED, "decides hidden"],
    ]);
  });

  it("keeps the Location's state of a Library Profile the map did not hold and the tablet brought, so a new tablet's Profiles do not show those its Location hid", () => {
    const library = new Set([IDS[0], IDS[1], BUNDLED]);
    const located = new Map([
      [BUNDLED, at(false)],
      [IDS[0], at(true)],
      [IDS[1], at(false)],
    ]);
    // A bundled one, whenever its record changed, and a user's from before the tablet joined.
    const report = [reported(BUNDLED, { isDefault: true }, LATER), reported(IDS[0], { visibility: "hidden" }, LATER), reported(IDS[1], {}, "2026-10-08T11:00:00.000Z")];
    expect(plan(report, [], library, located)).toEqual([
      ["map", BUNDLED, "unchanged"],
      ["map", IDS[0], "unchanged"],
      ["map", IDS[1], "unchanged"],
    ]);
  });

  it("shows a user's Profile the Location hid that the tablet made visible after it joined and after the Location hid it, as when a barista re-creates it", () => {
    const library = new Set([IDS[0]]);
    expect(plan([reported(IDS[0], {}, LATER)], [], library, new Map([[IDS[0], at(false)]]))).toEqual([["map", IDS[0], "shows"]]);
    // Shown there already, it is the latest edit still, so an earlier hide arriving later cannot undo it.
    expect(plan([reported(IDS[0], {}, LATER)], [], library, new Map([[IDS[0], at(true)]]))).toEqual([["map", IDS[0], "shows"]]);
    // Made visible before the Location hid it, the tablet had not seen that.
    expect(plan([reported(IDS[0], {}, "2026-10-08T12:20:00.000Z")], [], library, new Map([[IDS[0], at(false)]]))).toEqual([["map", IDS[0], "unchanged"]]);
    // Where the tablet's own edit hid it last, as when it deleted or replaced it there, what it reports now it made after that, whatever its clock.
    expect(plan([reported(IDS[0], {}, "2026-10-08T11:00:00.000Z")], [], library, new Map([[IDS[0], at(false, LATER, true)]]))).toEqual([["map", IDS[0], "shows"]]);
    // Without a known joining time, nothing is taken as made there.
    expect(planProfileIntake([reported(IDS[0], {}, LATER)], [], library, new Map([[IDS[0], at(false)]]), null).map((step) => step.kind === "map" && step.shown === true)).toEqual([false]);
  });

  it("hides at the tablet's Location a Profile it held visible that it hid or deleted since, and shows one it made visible", () => {
    const known = [mapped(IDS[0]), mapped(IDS[1]), mapped(BUNDLED, { visible: false })];
    const report = [reported(IDS[0], { visibility: "hidden" }, LATER), reported(IDS[1], { visibility: "deleted" }, LATER), reported(BUNDLED, { isDefault: true }, LATER)];
    const located = new Map([
      [IDS[0], at(true)],
      [IDS[1], at(true)],
      [BUNDLED, at(false)],
    ]);
    expect(plan(report, known, new Set(), located)).toEqual([
      ["update", IDS[0], "hides"],
      ["update", IDS[1], "hides"],
      ["update", BUNDLED, "shows"],
    ]);
  });

  it("changes nothing at the Location for a record that only changed otherwise", () => {
    const known = [mapped(IDS[0]), mapped(IDS[1], { visible: false, deleted: true })];
    const report = [reported(IDS[0], { profile: { title: "Renamed" } }, LATER), reported(IDS[1], { visibility: "deleted", profile: { title: "Renamed" } }, LATER)];
    const located = new Map([
      [IDS[0], at(true)],
      [IDS[1], at(false)],
    ]);
    expect(plan(report, known, new Set(), located)).toEqual([
      ["update", IDS[0], "unchanged"],
      ["update", IDS[1], "unchanged"],
    ]);
  });

  it("hides at the Location a Profile the tablet had hidden that it deleted since, as another tablet may have shown it there meanwhile", () => {
    const located = new Map([[IDS[1], at(true)]]);
    expect(plan([reported(IDS[1], { visibility: "deleted" }, LATER)], [mapped(IDS[1], { visible: false })], new Set(), located)).toEqual([["update", IDS[1], "hides"]]);
    // Within the millisecond the plugin reads times to, too.
    expect(plan([reported(IDS[1], { visibility: "deleted" })], [mapped(IDS[1], { visible: false })], new Set(), located)).toEqual([["update", IDS[1], "hides"]]);
    // So is one it had deleted that it hid again.
    expect(plan([reported(IDS[1], { visibility: "hidden" }, LATER)], [mapped(IDS[1], { visible: false, deleted: true })], new Set(), located)).toEqual([
      ["update", IDS[1], "hides"],
    ]);
  });

  it("takes a record as old as the one known only if it was shown or hidden since, within the millisecond the plugin reads times to, and an older one not at all", () => {
    const located = new Map([[IDS[0], at(true)]]);
    expect(plan([reported(IDS[0], { visibility: "hidden" })], [mapped(IDS[0])], new Set(), located)).toEqual([["update", IDS[0], "hides"]]);
    expect(plan([reported(IDS[0])], [mapped(IDS[0])], new Set(), located)).toEqual([]);
    expect(plan([reported(IDS[0], { visibility: "hidden" }, "2026-10-08T12:00:00.000Z")], [mapped(IDS[0])], new Set(), located)).toEqual([]);
    // One known without a time is replaced by any.
    expect(plan([reported(IDS[0], { visibility: "hidden" }, "2026-10-08T12:00:00.000Z")], [mapped(IDS[0], { updatedAt: null })], new Set(), located)).toEqual([
      ["update", IDS[0], "hides"],
    ]);
  });

  it("lets a bundled Profile the tablet held decide where its Location has decided nothing, as after its Machine moved there, but not a user's, which belonged to its old Location", () => {
    const known = [mapped(BUNDLED, { visible: false }), mapped(IDS[0])];
    expect(plan([reported(BUNDLED, { isDefault: true, visibility: "hidden" }), reported(IDS[0])], known)).toEqual([["decide", BUNDLED, "decides hidden"]]);
    // Changed since, it is updated, and decides too, with its edit.
    expect(plan([reported(BUNDLED, { isDefault: true }, LATER)], [mapped(BUNDLED, { visible: false })])).toEqual([
      ["update", BUNDLED, "shows"],
      ["decide", BUNDLED, "decides shown"],
    ]);
    // A Location that has decided it keeps its state.
    expect(plan([reported(BUNDLED, { isDefault: true })], [mapped(BUNDLED)], new Set(), new Map([[BUNDLED, at(false)]]))).toEqual([]);
  });

  it("hides at the Location a Profile gone from the tablet, as when its steps changed and Decaid replaced it under a new id, which is a new Profile shown there", () => {
    // Decaid's PUT with new steps: the old id is gone, and the new one is new to the Library.
    expect(plan([reported(IDS[2], {}, LATER)], [mapped(IDS[0])])).toEqual([
      ["add", IDS[2], "decides shown"],
      ["delete", IDS[0], "hides"],
    ]);
    // Purged while the tablet had it hidden, it is hidden there still, as an edit: another tablet may have shown it there meanwhile.
    expect(plan([], [mapped(IDS[1], { visible: false })])).toEqual([["delete", IDS[1], "hides"]]);
  });

  it("deletes only what the tablet's map held, and nothing whose id the list still holds, readable or not", () => {
    // A new or reset tablet lacking the Location's Profiles hides none of them (ADR-0019).
    expect(plan([], [], new Set([IDS[0]]), new Map([[IDS[0], at(true)]]))).toEqual([]);
    expect(plan([], [mapped(IDS[0])], new Set(), new Map(), new Set([IDS[0]]))).toEqual([]);
  });

  it("reads a record listed twice once", () => {
    expect(plan([reported(IDS[0]), reported(IDS[0], { visibility: "hidden" })], [])).toEqual([["add", IDS[0], "decides shown"]]);
  });
});

describe("visibilityInAnswer", () => {
  const visible = { visible: true, deleted: false };
  const hidden = { visible: false, deleted: false };
  const none = new Set<string>();
  it("reads a visibility the tablet changed since its last report, which the write did not set, as a report would", () => {
    expect(visibilityInAnswer(visible, { visibility: "hidden" }, new Set(["title"]))).toBe(false);
    expect(visibilityInAnswer(visible, { visibility: "deleted" }, none)).toBe(false);
    expect(visibilityInAnswer(hidden, { visibility: "visible" }, none)).toBe(true);
    // Deleted since it was hidden is hidden again, as another tablet may have shown it meanwhile.
    expect(visibilityInAnswer(hidden, { visibility: "deleted" }, none)).toBe(false);
  });

  it("reads nothing where the write set the visibility, the record known agrees, or none is known", () => {
    expect(visibilityInAnswer(visible, { visibility: "hidden" }, new Set(["visibility"]))).toBeUndefined();
    expect(visibilityInAnswer(visible, { visibility: "visible" }, none)).toBeUndefined();
    expect(visibilityInAnswer(null, { visibility: "hidden" }, none)).toBeUndefined();
  });
});
