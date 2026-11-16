import { describe, expect, it } from "vitest";
import { relativeTime } from "../src/lib/relative-time";
import { stopWords, stoppedText } from "../src/lib/stops";

// The shared parts of #543 that are pure: a time as it reads now, and the
// words for how a Shot stopped.

/** Sunday 15 November 2026, 1:40 PM in Toronto, 5 hours behind UTC. */
const NOW = Date.parse("2026-11-15T18:40:00Z");
const TORONTO = "America/Toronto";
const ago = (ms: number, timeZone = TORONTO) => relativeTime(NOW - ms, NOW, timeZone);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("a relative time", () => {
  it("counts minutes within the hour, and never seconds", () => {
    expect(ago(0)).toBe("Just now");
    expect(ago(59_999)).toBe("Just now");
    expect(ago(MINUTE)).toBe("1 min ago");
    expect(ago(14 * MINUTE + 59_000)).toBe("14 min ago");
    expect(ago(59 * MINUTE)).toBe("59 min ago");
  });

  it("counts hours earlier the same day, and gives yesterday's with its time of day", () => {
    expect(ago(HOUR)).toBe("1 h ago");
    // 12:10 AM that day.
    expect(ago(13 * HOUR + 30 * MINUTE)).toBe("13 h ago");
    // 11:50 PM the day before, less than a day ago.
    expect(ago(13 * HOUR + 50 * MINUTE)).toBe("Yesterday, 11:50 PM");
    expect(ago(21 * HOUR + 28 * MINUTE)).toBe("Yesterday, 4:12 PM");
    // 12:05 AM yesterday, more than a day ago.
    expect(ago(37 * HOUR + 35 * MINUTE)).toBe("Yesterday, 12:05 AM");
  });

  it("goes by the days of the time zone given, not UTC's or the browser's", () => {
    // 3:40 AM on the 16th in Tokyo: 7 hours ago was 8:40 PM on the 15th there, and 11:40 AM the same day in Toronto.
    expect(ago(7 * HOUR, "Asia/Tokyo")).toBe("Yesterday, 8:40 PM");
    expect(ago(7 * HOUR)).toBe("7 h ago");
  });

  it("counts days for the rest of a week, then gives the date, with the year for another year's", () => {
    expect(ago(2 * 24 * HOUR)).toBe("2 days ago");
    expect(ago(6 * 24 * HOUR)).toBe("6 days ago");
    expect(ago(7 * 24 * HOUR)).toBe("Nov 8");
    expect(relativeTime(Date.parse("2026-01-02T17:00:00Z"), NOW, TORONTO)).toBe("Jan 2");
    expect(relativeTime(Date.parse("2025-12-31T17:00:00Z"), NOW, TORONTO)).toBe("Dec 31, 2025");
  });

  it("reads a moment just ahead of now as now, as a tablet's clock a little fast gives one, and one further ahead as its date", () => {
    expect(ago(-30 * MINUTE)).toBe("Just now");
    expect(ago(-2 * HOUR)).toBe("Nov 15");
    expect(ago(-3 * 24 * HOUR)).toBe("Nov 18");
  });
});

describe("the words for how a Shot stopped", () => {
  it("names each kind, and gives any other reason as recorded", () => {
    expect(stopWords("targetWeight", "targetWeight")).toBe("at its target weight");
    expect(stopWords("targetVolume", "targetVolume")).toBe("at its target volume");
    expect(stopWords("byHand", "apiStop")).toBe("by hand");
    expect(stopWords("machineEnded", "machineEnded")).toBe("ended by the Machine");
    expect(stopWords("error", "disconnected")).toBe("by an error");
    expect(stopWords("other", "noScale")).toBe("noScale");
    expect(stopWords(null, null)).toBeUndefined();
  });

  it("gives the reason as recorded where the server gave no kind, as the previous release", () => {
    expect(stopWords(undefined, "targetWeight")).toBe("targetWeight");
    expect(stoppedText(undefined, "targetWeight")).toBe("targetWeight");
  });

  it("starts a field's value with a capital, leaving a recorded reason as it is", () => {
    expect(stoppedText("targetWeight", "targetWeight")).toBe("At its target weight");
    expect(stoppedText("machineEnded", "machineEnded")).toBe("Ended by the Machine");
    expect(stoppedText("other", "profileSkip")).toBe("profileSkip");
    expect(stoppedText(null, null)).toBeUndefined();
  });
});
