import { describe, expect, it } from "vitest";
import { type PlacingProfile, type PlacingRow, linkedRows, needsPlacing, planPlacement } from "../src/library/profile-placement.js";

// The rules that place Profile Versions in Profiles (ADR-0038, #735), as a
// module: the conversion of what an upgrade finds, a row the previous release
// adds, and what publishing and a tablet's report make. Shapes are built
// here, never copied from a cafe: a chain replaced everywhere, a version
// published at some Locations, a fork, a Duplicate, a chain shown nowhere,
// and one of Decaid's bundled Profiles.

/** A row that joined at minute `at`, saved from `parentId`, in use or not. */
function row(id: string, at: number, parentId: string | null, inUse: boolean, more: Partial<PlacingRow> = {}): PlacingRow {
  return { id, parentId, bundled: false, inUse, joinedAt: new Date(Date.UTC(2026, 10, 1, 0, at)), profileId: null, versionNumber: null, ...more };
}

/** Plans with Profile ids P1, P2 and so on, in the order they are made. */
function plan(rows: PlacingRow[], profiles: PlacingProfile[] = [], separate: string[] = []) {
  let made = 0;
  return planPlacement(rows, profiles, () => `P${++made}`, new Set(separate));
}

/** Each row's Profile and number after the plan, as "P1#2". */
function placedAs(rows: PlacingRow[], planned: ReturnType<typeof plan>): Record<string, string> {
  const placed = new Map(planned.placed.map((each) => [each.id, `${each.profileId}#${each.versionNumber}`]));
  return Object.fromEntries(rows.map((each) => [each.id, placed.get(each.id) ?? `${each.profileId}#${each.versionNumber}`]));
}

describe("Placing Profile Versions in Profiles", () => {
  it("makes a chain replaced everywhere one Profile, numbered as its versions joined, the one in use current", () => {
    const rows = [row("c", 3, "b", true), row("a", 1, null, false), row("b", 2, "a", false)];
    const planned = plan(rows);
    expect(placedAs(rows, planned)).toEqual({ a: "P1#1", b: "P1#2", c: "P1#3" });
    expect(planned.created).toEqual([{ id: "P1", currentVersionId: "c", startedFromId: null, createdAt: rows[1]!.joinedAt }]);
  });

  it("starts a separate Profile for one saved from a row still in use, as a Duplicate or a version published at some Locations", () => {
    const rows = [row("a", 1, null, true), row("b", 2, "a", true), row("c", 3, "b", false)];
    const planned = plan(rows);
    // c was saved from b, which is in use, so it too is apart, and shown nowhere.
    expect(placedAs(rows, planned)).toEqual({ a: "P1#1", b: "P2#1", c: "P3#1" });
    expect(planned.created.map((made) => [made.id, made.currentVersionId, made.startedFromId])).toEqual([
      ["P1", "a", null],
      ["P2", "b", "P1"],
      ["P3", "c", "P2"],
    ]);
  });

  it("keeps the later of a fork's two versions in use, and starts a separate Profile for the other", () => {
    const rows = [row("a", 1, null, false), row("left", 2, "a", true), row("right", 3, "a", true)];
    const planned = plan(rows);
    expect(placedAs(rows, planned)).toEqual({ a: "P1#1", right: "P1#2", left: "P2#1" });
    expect(planned.created.map((made) => [made.id, made.currentVersionId, made.startedFromId])).toEqual([
      ["P1", "right", null],
      ["P2", "left", "P1"],
    ]);
  });

  it("makes the latest to join current where none is in use", () => {
    const rows = [row("a", 1, null, false), row("b", 2, "a", false), row("c", 3, "a", false)];
    const planned = plan(rows);
    expect(placedAs(rows, planned)).toEqual({ a: "P1#1", b: "P1#2", c: "P1#3" });
    expect(planned.created[0]).toMatchObject({ currentVersionId: "c" });
  });

  it("gives each of Decaid's bundled Profiles one version, and one saved from it a Profile started from it", () => {
    const rows = [row("bundled", 1, null, false, { bundled: true }), row("mine", 2, "bundled", true), row("next", 3, "mine", true)];
    // mine is in use, so next is apart from it too; hide mine and next is its version.
    expect(placedAs(rows, plan(rows))).toEqual({ bundled: "P1#1", mine: "P2#1", next: "P3#1" });
    const replaced = [rows[0]!, { ...rows[1]!, inUse: false }, rows[2]!];
    const planned = plan(replaced);
    expect(placedAs(replaced, planned)).toEqual({ bundled: "P1#1", mine: "P2#1", next: "P2#2" });
    expect(planned.created.map((made) => [made.id, made.currentVersionId, made.startedFromId])).toEqual([
      ["P1", "bundled", null],
      ["P2", "next", "P1"],
    ]);
  });

  it("starts a Profile of its own for a row whose parent the Library lacks, or that names itself, or in a loop", () => {
    const rows = [row("orphan", 1, "gone", true), row("self", 2, "self", true), row("x", 3, "y", false), row("y", 4, "x", false)];
    const planned = plan(rows);
    expect(new Set(Object.values(placedAs(rows, planned)).map((placed) => placed.split("#")[0])).size).toBe(3);
    expect(placedAs(rows, planned)).toMatchObject({ orphan: "P1#1", self: "P2#1" });
  });

  it("places a row the previous release added beside a Profile already made, as the next version, current where it is in use", () => {
    const profiles = [{ id: "G", currentVersionId: "b" }];
    const rows = [
      row("a", 1, null, false, { profileId: "G", versionNumber: 1 }),
      row("b", 2, "a", false, { profileId: "G", versionNumber: 2 }),
      row("c", 3, "b", true),
    ];
    const planned = plan(rows, profiles);
    expect(planned).toMatchObject({ created: [], placed: [{ id: "c", profileId: "G", versionNumber: 3 }], current: [{ profileId: "G", versionId: "c" }], removed: [] });
    // Saved from a version still in use, it is a Profile of its own, and G is as it was.
    const published = plan([rows[0]!, { ...rows[1]!, inUse: true }, rows[2]!], profiles);
    expect(published).toMatchObject({ created: [{ id: "P1", currentVersionId: "c", startedFromId: "G" }], placed: [{ id: "c", profileId: "P1", versionNumber: 1 }], current: [] });
  });

  it("never gives again a number a version that has left the Profile, or been deleted, had", () => {
    // G gave Version 2 to a row that has since left it or been deleted; the next to join takes 3.
    const rows = [row("a", 1, null, false, { profileId: "G", versionNumber: 1 }), row("c", 3, "a", true)];
    expect(plan(rows, [{ id: "G", currentVersionId: "a", lastVersionNumber: 2 }])).toMatchObject({ placed: [{ id: "c", profileId: "G", versionNumber: 3 }] });
  });

  it("keeps a made Profile's current version where a fork joins it in use beside it", () => {
    const profiles = [{ id: "G", currentVersionId: "b" }];
    const rows = [row("a", 1, null, false, { profileId: "G", versionNumber: 1 }), row("b", 2, "a", true, { profileId: "G", versionNumber: 2 }), row("fork", 3, "a", true)];
    expect(plan(rows, profiles)).toMatchObject({ created: [{ id: "P1", currentVersionId: "fork", startedFromId: "G" }], placed: [{ id: "fork", profileId: "P1", versionNumber: 1 }], current: [] });
  });

  it("starts a separate Profile for a row known to be one, whatever it was saved from", () => {
    const rows = [row("a", 1, null, false, { profileId: "G", versionNumber: 1 }), row("copy", 2, "a", true)];
    expect(plan(rows, [{ id: "G", currentVersionId: "a" }], ["copy"])).toMatchObject({ created: [{ id: "P1", currentVersionId: "copy", startedFromId: "G" }], current: [] });
  });

  it("makes an earlier version current where it alone is in use, as after a return everywhere, and gives no number", () => {
    const profiles = [{ id: "G", currentVersionId: "b" }];
    const rows = [row("a", 1, null, true, { profileId: "G", versionNumber: 1 }), row("b", 2, "a", false, { profileId: "G", versionNumber: 2 })];
    expect(needsPlacing(rows, profiles)).toBe(true);
    expect(plan(rows, profiles)).toEqual({ created: [], placed: [], current: [{ profileId: "G", versionId: "a" }], removed: [] });
    // Hidden everywhere again, it stays current: the latest to join does not take its place.
    const hidden = [{ ...rows[0]!, inUse: false }, rows[1]!];
    expect(needsPlacing(hidden, [{ id: "G", currentVersionId: "a" }])).toBe(false);
    expect(plan(hidden, [{ id: "G", currentVersionId: "a" }])).toMatchObject({ placed: [], current: [] });
  });

  it("starts a separate Profile for an earlier version in use beside the current one, as after a return at some Locations", () => {
    const profiles = [{ id: "G", currentVersionId: "b" }];
    const rows = [row("a", 1, null, true, { profileId: "G", versionNumber: 1 }), row("b", 2, "a", true, { profileId: "G", versionNumber: 2 })];
    const planned = plan(rows, profiles);
    expect(planned).toMatchObject({ created: [{ id: "P1", currentVersionId: "a", startedFromId: "G" }], placed: [{ id: "a", profileId: "P1", versionNumber: 1 }], current: [] });
    // The Profile's next version takes the number after its highest, never the one that left.
    const next = plan([{ ...rows[0]!, profileId: "P1" }, { ...rows[1]!, inUse: false }, row("c", 3, "b", true)], [...profiles, { id: "P1", currentVersionId: "a" }]);
    expect(next.placed).toEqual([{ id: "c", profileId: "G", versionNumber: 3 }]);
  });

  it("gives a Profile whose current version is gone the latest of the rest, and removes one left with none", () => {
    const profiles = [
      { id: "G", currentVersionId: "deleted" },
      { id: "empty", currentVersionId: "also deleted" },
    ];
    const rows = [row("a", 1, null, false, { profileId: "G", versionNumber: 1 }), row("b", 2, "a", false, { profileId: "G", versionNumber: 2 })];
    expect(needsPlacing(rows, profiles)).toBe(true);
    expect(plan(rows, profiles)).toMatchObject({ created: [], placed: [], current: [{ profileId: "G", versionId: "b" }], removed: ["empty"] });
  });

  it("plans nothing for rows placed as the rules have them", () => {
    const profiles = [{ id: "G", currentVersionId: "b" }];
    const rows = [row("a", 1, null, false, { profileId: "G", versionNumber: 1 }), row("b", 2, "a", true, { profileId: "G", versionNumber: 2 })];
    expect(needsPlacing(rows, profiles)).toBe(false);
    expect(plan(rows, profiles)).toEqual({ created: [], placed: [], current: [], removed: [] });
  });

  it("gathers rows linked by what they were saved from or the Profile they share, each set planned alone", () => {
    const rows = [row("a", 1, null, false), row("b", 2, "a", true), row("other", 3, null, true), row("p", 4, null, true, { profileId: "G", versionNumber: 1 }), row("q", 5, null, false, { profileId: "G", versionNumber: 2 })];
    expect(linkedRows(rows).map((set) => set.map((each) => each.id).sort())).toEqual([["a", "b"], ["other"], ["p", "q"]]);
  });
});
