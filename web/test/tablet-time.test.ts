import { describe, expect, it } from "vitest";
import { differingZoneOffset, inTabletTime, localTimeText, timeOfDayMinutes, timeOfDayText, utcOffsetText } from "../src/lib/tablet-time";

describe("timeOfDayText", () => {
  it("writes minutes after midnight as hours and minutes", () => {
    expect(timeOfDayText(0)).toBe("00:00");
    expect(timeOfDayText(390)).toBe("06:30");
    expect(timeOfDayText(1320)).toBe("22:00");
    expect(timeOfDayText(1439)).toBe("23:59");
  });

  it("writes nothing for a value that is no time of day", () => {
    for (const minutes of [-1, 1440, 600.5, Number.NaN, "600", null]) expect(timeOfDayText(minutes)).toBeUndefined();
  });
});

describe("timeOfDayMinutes", () => {
  it("reads a time of day back as minutes after midnight", () => {
    expect(timeOfDayMinutes("00:00")).toBe(0);
    expect(timeOfDayMinutes("06:30")).toBe(390);
    expect(timeOfDayMinutes("23:59")).toBe(1439);
    for (let minutes = 0; minutes < 1440; minutes += 7) expect(timeOfDayMinutes(timeOfDayText(minutes))).toBe(minutes);
  });

  it("reads nothing from text that is not HH:MM within a day", () => {
    for (const text of ["24:00", "06:60", "6:30", "06:30:00", " 06:30", "", "noon", 390, null]) expect(timeOfDayMinutes(text)).toBeUndefined();
  });
});

describe("utcOffsetText", () => {
  it("writes whole hours alone, and minutes where there are any", () => {
    expect(utcOffsetText(-240)).toBe("UTC−4");
    expect(utcOffsetText(60)).toBe("UTC+1");
    expect(utcOffsetText(330)).toBe("UTC+5:30");
    expect(utcOffsetText(-570)).toBe("UTC−9:30");
    expect(utcOffsetText(345)).toBe("UTC+5:45");
    expect(utcOffsetText(840)).toBe("UTC+14");
    expect(utcOffsetText(0)).toBe("UTC");
  });
});

describe("localTimeText", () => {
  it("writes a local time Decaid wrote as its date and time of day, as they read on the Tablet", () => {
    // The date as this runtime's locale writes it, for no time zone.
    const date = (year: number, month: number, day: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(Date.UTC(year, month - 1, day));
    // Late in the evening, the next day in UTC and in time zones east of the Tablet.
    expect(localTimeText("2026-10-25T23:30:00.000")).toBe(`${date(2026, 10, 25)}, 23:30`);
    // A time the clocks skip in some time zones, Decaid's microseconds and seconds left out.
    expect(localTimeText("2026-03-08T02:30:00.000123")).toBe(`${date(2026, 3, 8)}, 02:30`);
    expect(localTimeText("2026-03-08T02:30")).toBe(`${date(2026, 3, 8)}, 02:30`);
  });

  it("writes nothing for text that is not a local time", () => {
    for (const text of ["2026-02-30T08:00:00.000", "2026-10-25T24:00:00.000", "2026-10-25T08:30:99.000", "2026-10-25T08:30:60", "2026-10-25T08:30:00.000Z", "2026-10-25", "", null]) {
      expect(localTimeText(text)).toBeUndefined();
    }
  });
});

describe("inTabletTime", () => {
  it("labels a time with the Tablet's offset, where it is known", () => {
    expect(inTabletTime("06:30", -240)).toBe("06:30 (UTC−4)");
    expect(inTabletTime("06:30", null)).toBe("06:30");
  });
});

describe("differingZoneOffset", () => {
  // Toronto's clocks go back from UTC−4 to UTC−5 at 06:00 UTC on 2026-11-01, 02:00 there.
  const beforeChange = Date.parse("2026-11-01T05:59:00Z");
  const afterChange = Date.parse("2026-11-01T06:00:00Z");

  it("finds nothing where the Tablet's offset is the time zone's at the moment, on either side of a daylight saving change", () => {
    expect(differingZoneOffset(-240, "America/Toronto", beforeChange)).toBeUndefined();
    expect(differingZoneOffset(-300, "America/Toronto", afterChange)).toBeUndefined();
  });

  it("gives the time zone's offset where the Tablet has not followed the change, or has moved before it", () => {
    expect(differingZoneOffset(-240, "America/Toronto", afterChange)).toBe(-300);
    expect(differingZoneOffset(-300, "America/Toronto", beforeChange)).toBe(-240);
  });

  it("compares offsets of part of an hour, and a zone at UTC itself", () => {
    expect(differingZoneOffset(330, "Asia/Kolkata", afterChange)).toBeUndefined();
    expect(differingZoneOffset(300, "Asia/Kolkata", afterChange)).toBe(330);
    expect(differingZoneOffset(0, "UTC", afterChange)).toBeUndefined();
    expect(differingZoneOffset(60, "Europe/London", Date.parse("2026-12-01T12:00:00Z"))).toBe(0);
    expect(differingZoneOffset(60, "Europe/London", Date.parse("2026-07-01T12:00:00Z"))).toBeUndefined();
  });
});
