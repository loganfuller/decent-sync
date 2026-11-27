import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type NamedBatch,
  batchLine,
  batchLineText,
  batchOfBean,
  batchOfBeanText,
  batchTitle,
  batchWords,
  recordedDayText,
  recordedDayWithYear,
  roastedBeforeShot,
  roastedLine,
  roastedText,
} from "../src/lib/batch-name";

// How the management interface names a Bean Batch (#732): by its Bean and its Batch Code, with its roast date, a day, wherever
// there is a second line or a sentence, and in the code's place on a batch that has none.

/** Late November 2026, as each test's now. */
const now = new Date(2026, 10, 27, 12);

/** A day as the browser's locale writes one, such as "17 Nov", and with its year, such as "17 Nov 2026". */
const day = (year: number, month: number, date: number) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.UTC(year, month - 1, date));
const dayWithYear = (year: number, month: number, date: number) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, date));

const batch = (held: { name?: string | null; roastDate?: string | null; batchCode?: string | null } = {}): NamedBatch => ({
  bean: { name: held.name === undefined ? "House Espresso" : held.name },
  roastDate: held.roastDate === undefined ? "2026-11-17T00:00:00.000" : held.roastDate,
  ...("batchCode" in held && { batchCode: held.batchCode }),
});

const coded = batch({ batchCode: "LR-0411" });
const plain = batch({ roastDate: "2026-11-10T00:00:00.000", batchCode: null });
const undated = batch({ roastDate: null, batchCode: "LR-0398" });

describe("a roast date as a day", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads as its day, with its year when that is not this year, and with it always where the date is itself the value shown", () => {
    expect(recordedDayText("2026-11-17T00:00:00.000", now)).toBe(day(2026, 11, 17));
    expect(recordedDayText("2026-11-17T00:00:00.000", now)).toMatch(/17/);
    expect(recordedDayText("2026-11-17T00:00:00.000", now)).not.toMatch(/2026/);
    // Last year's, and one read once the year has turned.
    expect(recordedDayText("2025-12-30T00:00:00.000", now)).toBe(dayWithYear(2025, 12, 30));
    expect(recordedDayText("2026-11-17T00:00:00.000", new Date(2027, 0, 5))).toMatch(/2026/);
    expect(recordedDayWithYear("2026-11-17T00:00:00.000")).toBe(dayWithYear(2026, 11, 17));
    expect(recordedDayWithYear("2026-11-17T00:00:00.000")).toMatch(/2026/);
    // A day alone, as an edit made here keeps one, reads the same.
    expect(recordedDayText("2026-11-17", now)).toBe(day(2026, 11, 17));
  });

  it("is the day Decaid recorded, whatever time zone the page is read in or the date was written with", () => {
    for (const zone of ["Pacific/Kiritimati", "America/Los_Angeles", "Pacific/Pago_Pago", "UTC"]) {
      vi.stubEnv("TZ", zone);
      expect(recordedDayText("2026-11-17T00:00:00.000", now), zone).toBe(day(2026, 11, 17));
      // The first and last day of a month, which a shift of a few hours would move across it.
      expect(recordedDayText("2026-11-01T00:00:00.000", now), zone).toBe(day(2026, 11, 1));
      expect(recordedDayText("2026-11-30T23:59:59.999", now), zone).toBe(day(2026, 11, 30));
      // Written with an offset, it is still the day its text names.
      expect(recordedDayText("2026-11-17T00:00:00.000+13:00", now), zone).toBe(day(2026, 11, 17));
      expect(recordedDayWithYear("2026-01-01T00:00:00.000Z"), zone).toBe(dayWithYear(2026, 1, 1));
    }
  });

  it("is nothing for no date, or for text that names no day", () => {
    for (const none of [null, undefined, "", "last week", "2026-13-01", "2026-02-30T00:00:00.000"]) {
      expect(recordedDayText(none, now), String(none)).toBeUndefined();
      expect(recordedDayWithYear(none), String(none)).toBeUndefined();
    }
  });
});

describe("a Bean Batch's name", () => {
  it("writes a roast date in a sentence and as a line of its own, and says where a batch has none", () => {
    expect(roastedText(coded, now)).toBe(`roasted ${day(2026, 11, 17)}`);
    expect(roastedLine(coded, now)).toBe(`Roasted ${day(2026, 11, 17)}`);
    expect(roastedText(undated, now)).toBe("no roast date");
    expect(roastedLine(undated, now)).toBe("No roast date");
  });

  it("is in a line its Bean and its Batch Code, or, with no code, its roast date in the code's place", () => {
    expect(batchLine(coded, now)).toEqual({ bean: "House Espresso", code: "LR-0411" });
    expect(batchLineText(coded, now)).toBe("House Espresso LR-0411");
    expect(batchLine(plain, now)).toEqual({ bean: "House Espresso", after: `, roasted ${day(2026, 11, 10)}` });
    expect(batchLineText(plain, now)).toBe(`House Espresso, roasted ${day(2026, 11, 10)}`);
    // A code stands without a roast date; neither reads "no roast date" in the code's place.
    expect(batchLineText(undated, now)).toBe("House Espresso LR-0398");
    expect(batchLineText(batch({ roastDate: null }), now)).toBe("House Espresso, no roast date");
  });

  it("is where its Bean is already said its Batch Code with its roast date, or its roast date alone", () => {
    expect(batchOfBean(coded, now)).toEqual({ code: "LR-0411", roasted: `roasted ${day(2026, 11, 17)}` });
    expect(batchOfBeanText(coded, now)).toBe(`LR-0411 roasted ${day(2026, 11, 17)}`);
    expect(batchOfBean(plain, now)).toEqual({ roasted: `Roasted ${day(2026, 11, 10)}` });
    expect(batchOfBeanText(plain, now)).toBe(`Roasted ${day(2026, 11, 10)}`);
    expect(batchOfBeanText(undated, now)).toBe("LR-0398 no roast date");
    expect(batchOfBeanText(batch({ roastDate: null }), now)).toBe("No roast date");
  });

  it("is in words its Bean, its Batch Code and its roast date", () => {
    expect(batchWords(coded, now)).toBe(`House Espresso LR-0411, roasted ${day(2026, 11, 17)}`);
    expect(batchWords(plain, now)).toBe(`House Espresso, roasted ${day(2026, 11, 10)}`);
    expect(batchWords(undated, now)).toBe("House Espresso LR-0398, no roast date");
    expect(batchWords(batch({ roastDate: "2025-11-17T00:00:00.000", batchCode: "LR-0001" }), now)).toBe(`House Espresso LR-0001, roasted ${dayWithYear(2025, 11, 17)}`);
  });

  it("titles its own page by its Bean and roast date, whatever its code, which the page draws beside it", () => {
    expect(batchTitle(coded, now)).toBe(`House Espresso, roasted ${day(2026, 11, 17)}`);
    expect(batchTitle(undated, now)).toBe("House Espresso, no roast date");
  });

  it("names a Bean with no name as an unnamed one", () => {
    const unnamed = batch({ name: null, batchCode: "LR-0411" });
    expect(batchLineText(unnamed, now)).toBe("Unnamed Bean LR-0411");
    expect(batchWords(unnamed, now)).toBe(`Unnamed Bean LR-0411, roasted ${day(2026, 11, 17)}`);
    expect(batchTitle(unnamed, now)).toBe(`Unnamed Bean, roasted ${day(2026, 11, 17)}`);
  });

  it("reads the previous release's answer, which gives no Batch Code, as a batch with none, by its Bean and roast date (ADR-0025)", () => {
    const before = batch();
    expect("batchCode" in before).toBe(false);
    expect(batchLine(before, now)).toEqual({ bean: "House Espresso", after: `, roasted ${day(2026, 11, 17)}` });
    expect(batchWords(before, now)).toBe(`House Espresso, roasted ${day(2026, 11, 17)}`);
    expect(batchOfBeanText(before, now)).toBe(`Roasted ${day(2026, 11, 17)}`);
    // An empty code is none too.
    expect(batchLineText(batch({ batchCode: "" }), now)).toBe(`House Espresso, roasted ${day(2026, 11, 17)}`);
  });
});

describe("how long after its roast a Shot was pulled", () => {
  it("counts the days from the roast date to the Shot's day at its Location", () => {
    expect(roastedBeforeShot("2026-11-17T00:00:00.000", "2026-11-27")).toBe("10 days before this Shot");
    expect(roastedBeforeShot("2026-11-17T00:00:00.000", "2026-11-18")).toBe("1 day before this Shot");
    expect(roastedBeforeShot("2026-11-17T00:00:00.000", "2026-11-17")).toBe("the day of this Shot");
    // Across a month's end and a year's, and a change of clocks, which is no day more or less.
    expect(roastedBeforeShot("2026-10-20T00:00:00.000", "2026-11-03")).toBe("14 days before this Shot");
    expect(roastedBeforeShot("2025-12-30T00:00:00.000", "2026-01-02")).toBe("3 days before this Shot");
  });

  it("says nothing for a batch with no roast date, a Shot pulled before it, or one whose day isn't known", () => {
    expect(roastedBeforeShot(null, "2026-11-27")).toBeUndefined();
    expect(roastedBeforeShot("2026-11-17T00:00:00.000", "2026-11-16")).toBeUndefined();
    expect(roastedBeforeShot("2026-11-17T00:00:00.000", undefined)).toBeUndefined();
  });
});
