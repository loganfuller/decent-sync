import { describe, expect, it } from "vitest";
import type { ShotSpec } from "../src/lib/api";
import { RATINGS, UNTIMED, dayGroups, dayHeading, durationDifference, ratedShotsPath, ratingChoiceText, stopNote, timeOfDay, yieldDifference } from "../src/lib/shot-list";
import { otherStopsText } from "../src/lib/shot-summary";

// The Shots list's rows (#544): a page of Shots under a heading for each
// day, each Shot's own Location's, and what a row says of a Shot's time,
// differences and stop; with what the rating filter's choices are called.

const LAB = { id: "lab", name: "Lab", timeZone: "America/Denver" };
const HARBOR = { id: "harbor", name: "Harbor", timeZone: "Asia/Tokyo" };

const shot = (id: string, pulledAt: string | null, location: typeof LAB | null) => ({ id, pulledAt, location });

const spec = (changes: Partial<ShotSpec> = {}): ShotSpec => ({ unfinished: false, cleaningOrCalibration: false, duration: null, yield: null, stopped: "targetWeight", ...changes });

describe("a day's heading", () => {
  it("names today and yesterday, and gives any other day alone, with its year where that isn't this one", () => {
    expect(dayHeading("2026-11-15", "2026-11-15")).toBe("Today, Sun Nov 15");
    expect(dayHeading("2026-11-14", "2026-11-15")).toBe("Yesterday, Sat Nov 14");
    expect(dayHeading("2026-11-13", "2026-11-15")).toBe("Fri Nov 13");
    expect(dayHeading("2025-12-31", "2026-01-01")).toBe("Yesterday, Wed Dec 31, 2025");
    expect(dayHeading("2025-11-15", "2026-11-15")).toBe("Sat Nov 15, 2025");
    // A Shot timed after today, as by a tablet whose clock runs ahead, is neither.
    expect(dayHeading("2026-11-16", "2026-11-15")).toBe("Mon Nov 16");
  });
});

describe("a page of Shots under its days", () => {
  // 13:40 on November 15 in Denver, and 05:40 on the 16th in Tokyo.
  const now = Date.parse("2026-11-15T20:40:00Z");

  it("heads each run of Shots with their day at their own Location, today and yesterday by that Location's own today", () => {
    const groups = dayGroups(
      [
        shot("lab-afternoon", "2026-11-15T20:21:00Z", LAB),
        shot("lab-morning", "2026-11-15T15:00:00Z", LAB),
        // 23:30 on the 14th in Denver, though the 15th in UTC.
        shot("lab-last-night", "2026-11-15T06:30:00Z", LAB),
        shot("lab-friday", "2026-11-13T20:00:00Z", LAB),
      ],
      now,
    );
    expect(groups.map((group) => [group.heading, group.shots.map((each) => each.id)])).toEqual([
      ["Today, Sun Nov 15", ["lab-afternoon", "lab-morning"]],
      ["Yesterday, Sat Nov 14", ["lab-last-night"]],
      ["Fri Nov 13", ["lab-friday"]],
    ]);
  });

  it("reads a Shot with no Location in UTC, and heads the Shots whose time is unknown apart", () => {
    const groups = dayGroups([shot("roaming", "2026-11-15T06:30:00Z", null), shot("untimed", null, LAB), shot("untimed-roaming", null, null)], now);
    expect(groups.map((group) => [group.heading, group.shots.map((each) => each.id)])).toEqual([
      ["Today, Sun Nov 15", ["roaming"]],
      [UNTIMED, ["untimed", "untimed-roaming"]],
    ]);
  });

  it("keeps the page's order where Locations on different dates pulled Shots in turn, heading each run", () => {
    const groups = dayGroups(
      [
        // 05:30 on the 16th in Tokyo, then 13:20 on the 15th in Denver, then 05:10 in Tokyo: each is today there.
        shot("harbor-dawn", "2026-11-15T20:30:00Z", HARBOR),
        shot("lab-afternoon", "2026-11-15T20:20:00Z", LAB),
        shot("harbor-earlier", "2026-11-15T20:10:00Z", HARBOR),
      ],
      now,
    );
    expect(groups.map((group) => [group.heading, group.shots.map((each) => each.id)])).toEqual([
      ["Today, Mon Nov 16", ["harbor-dawn"]],
      ["Today, Sun Nov 15", ["lab-afternoon"]],
      ["Today, Mon Nov 16", ["harbor-earlier"]],
    ]);
  });
});

describe("what a row says of a Shot", () => {
  it("gives its time of day on its Location's wall clock, or UTC's", () => {
    expect(timeOfDay(shot("lab", "2026-11-15T20:21:00Z", LAB))).toBe("1:21 PM");
    expect(timeOfDay(shot("harbor", "2026-11-15T20:21:00Z", HARBOR))).toBe("5:21 AM");
    expect(timeOfDay(shot("roaming", "2026-11-15T20:21:00Z", null))).toBe("8:21 PM");
    expect(timeOfDay(shot("untimed", null, LAB))).toBe(UNTIMED);
  });

  it("gives its yield's and its duration's difference, marked when out of spec, and none where the server judged none", () => {
    expect(yieldDifference(spec({ yield: { againstTarget: 0.2, outOfSpec: false } }))).toEqual({ text: "+0.2 g", marked: false });
    expect(yieldDifference(spec({ yield: { againstTarget: 4.6, outOfSpec: true } }))).toEqual({ text: "+4.6 g", marked: true });
    expect(yieldDifference(spec({ yield: { againstTarget: -0.04, outOfSpec: false } }))).toEqual({ text: "0.0 g", marked: false });
    expect(durationDifference(spec({ duration: { difference: -6.4, outOfSpec: true } }))).toEqual({ text: "−6.4 s", marked: true });
    expect(durationDifference(spec({ duration: { difference: 2.3, outOfSpec: false } }))).toEqual({ text: "+2.3 s", marked: false });
    // An Unfinished Shot, a Shot whose Recipe has no Reference Shot, and the previous release's row during a deploy.
    for (const none of [spec({ unfinished: true }), spec(), undefined]) {
      expect(yieldDifference(none)).toBeUndefined();
      expect(durationDifference(none)).toBeUndefined();
    }
  });

  it("says how it stopped only where that was not at its target", () => {
    expect(stopNote(spec({ stopped: "targetWeight" }), "targetWeight")).toBeUndefined();
    expect(stopNote(spec({ stopped: "targetVolume" }), "targetVolume")).toBeUndefined();
    expect(stopNote(spec({ stopped: "byHand" }), "apiStop")).toBe("stopped by hand");
    expect(stopNote(spec({ stopped: "machineEnded" }), "machineEnded")).toBe("ended by the Machine");
    expect(stopNote(spec({ stopped: "error" }), "disconnected")).toBe("stopped by an error");
    expect(stopNote(spec({ stopped: "other" }), "scaleLost")).toBe("stopped: scaleLost");
    // One that recorded no reason, and the previous release's row, which gives no kind.
    expect(stopNote(spec({ stopped: null }), null)).toBeUndefined();
    expect(stopNote(undefined, "apiStop")).toBeUndefined();
  });
});

describe("a summary's Shots that didn't stop at their target", () => {
  it("are said by how they stopped, each kind where there are any", () => {
    const stops = { shots: 10, share: 0.6, atTarget: 6, byHand: 2, machineEnded: 1, error: 0, other: 1 };
    expect(otherStopsText(stops)).toBe("2 by hand · 1 ended by the Machine · 1 another way");
    expect(otherStopsText({ ...stops, byHand: 0, machineEnded: 0, other: 0, error: 4 })).toBe("4 by an error");
    expect(otherStopsText({ shots: 6, share: 1, atTarget: 6, byHand: 0, machineEnded: 0, error: 0, other: 0 })).toBeUndefined();
  });
});

describe("the rating filter", () => {
  it("names each of its choices, and reads one it doesn't know as it is", () => {
    expect(RATINGS.map(ratingChoiceText)).toEqual(["Rated", "Not rated", "5 stars", "4 stars or more", "3 stars or more", "2 stars or more"]);
    expect(ratingChoiceText("7")).toBe("7");
  });

  it("opens a Recipe's rated Shots, which No reference leads to", () => {
    expect(ratedShotsPath("recipe-1")).toBe("/shots?recipeId=recipe-1&rating=rated");
  });
});
