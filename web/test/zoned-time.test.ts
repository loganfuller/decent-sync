import { describe, expect, it } from "vitest";
import { fromZonedInput, toZonedInput, zoneOffsetMinutes } from "../src/lib/zoned-time";

// Times read and written in a Location's time zone. The module works them
// out from Intl alone, as a browser may lack Temporal; these tests check it
// against Temporal in the same process, so both read one set of time zone
// data and no clock change is written here as a fixed offset.

describe("toZonedInput", () => {
  it("is the time as the zone's clocks read it, to the minute", () => {
    expect(toZonedInput("2026-01-15T14:30:00.000Z", "America/Chicago")).toBe("2026-01-15T08:30");
    expect(toZonedInput("2026-07-15T14:30:00.000Z", "America/Chicago")).toBe("2026-07-15T09:30");
    expect(toZonedInput("2026-01-15T14:30:59.999Z", "Asia/Kolkata")).toBe("2026-01-15T20:00");
    expect(toZonedInput("2026-01-15T23:45:00.000Z", "Asia/Tokyo")).toBe("2026-01-16T08:45");
    expect(toZonedInput("2026-01-15T14:30:00.000Z", "UTC")).toBe("2026-01-15T14:30");
  });
});

describe("fromZonedInput", () => {
  it("is the time the zone's clocks read as the value, with or without seconds", () => {
    expect(fromZonedInput("2026-01-15T08:30", "America/Chicago")).toBe("2026-01-15T14:30:00.000Z");
    expect(fromZonedInput("2026-07-15T09:30", "America/Chicago")).toBe("2026-07-15T14:30:00.000Z");
    expect(fromZonedInput("2026-01-15T08:30:45", "America/Chicago")).toBe("2026-01-15T14:30:45.000Z");
    expect(fromZonedInput("2026-01-16T08:45", "Asia/Tokyo")).toBe("2026-01-15T23:45:00.000Z");
  });

  it("takes a time the clocks repeat at its first occurrence, and names none for one they skip", () => {
    // Toronto's clocks went back from 02:00 to 01:00 on 1 November 2026, and forward from 02:00 to 03:00 on 8 March.
    expect(fromZonedInput("2026-11-01T01:30", "America/Toronto")).toBe("2026-11-01T05:30:00.000Z");
    expect(fromZonedInput("2026-03-08T02:30", "America/Toronto")).toBeUndefined();
    expect(fromZonedInput("2026-03-08T03:00", "America/Toronto")).toBe("2026-03-08T07:00:00.000Z");
  });

  it("names none for a value that is no date and time, or a date the calendar lacks", () => {
    for (const value of ["", "2026-01-15", "2026-01-15 08:30", "2026-1-15T08:30", "2026-01-15T08:30Z", "2026-02-30T10:00", "2026-13-01T10:00", "2026-01-15T24:30"]) {
      expect(fromZonedInput(value, "America/Chicago"), value).toBeUndefined();
    }
  });
});

describe("zoneOffsetMinutes", () => {
  it("is how far the zone's clocks are ahead of UTC then, in minutes, and a plain 0 for UTC", () => {
    expect(zoneOffsetMinutes("America/Toronto", Date.parse("2026-01-15T12:00:00Z"))).toBe(-300);
    expect(zoneOffsetMinutes("America/Toronto", Date.parse("2026-07-15T12:00:00Z"))).toBe(-240);
    expect(zoneOffsetMinutes("Asia/Kolkata", Date.parse("2026-01-15T12:00:00Z"))).toBe(330);
    expect(Object.is(zoneOffsetMinutes("UTC", Date.parse("2026-01-15T12:00:00Z")), 0)).toBe(true);
  });
});

/** What Temporal makes of a wall-clock time in a zone: its first occurrence, or undefined where the clocks skip it. */
function instantOf(wall: Temporal.PlainDateTime, timeZone: string): string | undefined {
  const zoned = wall.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  return zoned.toPlainDateTime().equals(wall) ? new Date(zoned.epochMilliseconds).toISOString() : undefined;
}

/** Where the module and Temporal disagree about a wall-clock time in a zone, in words; none where they agree. */
function differences(wall: Temporal.PlainDateTime, timeZone: string): string[] {
  const value = wall.toString({ smallestUnit: "minute" });
  const wanted = instantOf(wall, timeZone);
  const found = fromZonedInput(value, timeZone);
  if (found !== wanted) return [`${timeZone} ${value}: ${found}, not ${wanted}`];
  if (wanted !== undefined && toZonedInput(wanted, timeZone) !== value) return [`${timeZone} ${wanted}: read back as ${toZonedInput(wanted, timeZone)}, not ${value}`];
  return [];
}

describe("against Temporal", () => {
  it("agrees on the times around every clock change of 2026, in every time zone the runtime knows", () => {
    // Either side of a change by up to an hour and a half, which covers changes of 30 and 60 minutes, and their edges.
    const minutes = [-90, -61, -60, -59, -31, -30, -29, -1, 0, 1, 29, 30, 31, 59, 60, 61, 90];
    const end = Temporal.Instant.from("2027-01-01T00:00:00Z").epochMilliseconds;
    const differing: string[] = [];
    let changes = 0;
    for (const timeZone of Intl.supportedValuesOf("timeZone")) {
      let from = Temporal.Instant.from("2026-01-01T00:00:00Z").toZonedDateTimeISO(timeZone);
      for (;;) {
        const change = from.getTimeZoneTransition("next");
        if (!change || change.epochMilliseconds >= end) break;
        changes++;
        // The change as the clocks read just before it and from it on.
        const before = change.subtract({ nanoseconds: 1 }).toPlainDateTime().round({ smallestUnit: "minute", roundingMode: "ceil" });
        for (const wall of [before, change.toPlainDateTime()]) {
          for (const offset of minutes) differing.push(...differences(wall.add({ minutes: offset }), timeZone));
        }
        const offset = zoneOffsetMinutes(timeZone, change.epochMilliseconds);
        if (offset !== Math.round(change.offsetNanoseconds / 60e9)) differing.push(`${timeZone} at ${change.toString()}: ${offset} minutes ahead of UTC`);
        from = change;
      }
    }
    // Many zones change their clocks twice a year, so a run that found few changes checked little.
    expect(changes).toBeGreaterThan(100);
    expect(differing).toEqual([]);
  });

  it("agrees through changes of other sizes: a skipped day, half an hour, and a zone's offset moved for good", () => {
    const days: [timeZone: string, day: string][] = [
      // Samoa skipped 30 December 2011, crossing the date line.
      ["Pacific/Apia", "2011-12-30"],
      // Lord Howe Island's clocks change by half an hour.
      ["Australia/Lord_Howe", "2026-04-05"],
      ["Australia/Lord_Howe", "2026-10-04"],
      // Venezuela moved from UTC-4:30 to UTC-4 on 1 May 2016, and North Korea from UTC+8:30 to UTC+9 on 5 May 2018.
      ["America/Caracas", "2016-05-01"],
      ["Asia/Pyongyang", "2018-05-05"],
    ];
    const differing: string[] = [];
    for (const [timeZone, day] of days) {
      const start = Temporal.PlainDateTime.from(`${day}T00:00`).subtract({ days: 1 });
      // Every quarter of an hour from the day before to the day after.
      for (let quarter = 0; quarter < 3 * 24 * 4; quarter++) differing.push(...differences(start.add({ minutes: quarter * 15 }), timeZone));
    }
    expect(differing).toEqual([]);
  });
});
