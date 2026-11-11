import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseBucket } from "../src/lib/api";
import { bucketLabel, bucketTitle, countTotals, durationText, stateTimes } from "../src/lib/machine-use";

// How a Machine's use reads on its page (#475).

const bucket = (date: string, counted: Partial<UseBucket> = {}): UseBucket => ({ date, shots: 0, steamRecords: 0, flushes: 0, hotWaterPours: 0, states: [], ...counted });

describe("a Machine's use as its page shows it", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("adds up each count over the days or hours", () => {
    expect(countTotals([])).toEqual({ shots: 0, steamRecords: 0, flushes: 0, hotWaterPours: 0 });
    expect(
      countTotals([bucket("2026-11-04", { shots: 41, steamRecords: 30, flushes: 12 }), bucket("2026-11-05", { shots: 9, flushes: 3, hotWaterPours: 2 })]),
    ).toEqual({ shots: 50, steamRecords: 30, flushes: 15, hotWaterPours: 2 });
  });

  it("adds up the time in each Machine State by its name, the longest first, Decaid's states of one name together", () => {
    const days = [
      bucket("2026-11-04", {
        states: [
          { state: "sleeping", name: "Asleep", seconds: 50_000 },
          { state: "idle", name: "Idle", seconds: 30_000 },
          { state: "espresso", name: "Pulling a shot", seconds: 1_200.5 },
        ],
      }),
      bucket("2026-11-05", {
        states: [
          { state: "idle", name: "Idle", seconds: 40_000 },
          // Idle since a wake schedule woke it.
          { state: "schedIdle", name: "Idle", seconds: 20_000 },
          { state: "espresso", name: "Pulling a shot", seconds: 800 },
          { state: "skipStep", name: "Pulling a shot", seconds: 4 },
        ],
      }),
    ];
    expect(stateTimes(days)).toEqual([
      { name: "Idle", seconds: 90_000 },
      { name: "Asleep", seconds: 50_000 },
      { name: "Pulling a shot", seconds: 2_004.5 },
    ]);
    expect(stateTimes([bucket("2026-11-06")])).toEqual([]);
  });

  it("reads a length of time in its largest unit and the next, dropping what is left over", () => {
    expect(durationText(0)).toBe("0 s");
    expect(durationText(0.4)).toBe("0 s");
    expect(durationText(44.6)).toBe("45 s");
    expect(durationText(60)).toBe("1 min");
    expect(durationText(750)).toBe("12 min 30 s");
    expect(durationText(3_600)).toBe("1 h");
    expect(durationText(18_725)).toBe("5 h 12 min");
    // 59 s short of 2 hours.
    expect(durationText(7_141)).toBe("1 h 59 min");
    expect(durationText(86_400)).toBe("1 d");
    expect(durationText(183_600)).toBe("2 d 3 h");
    expect(durationText(90_000 * 31)).toBe("32 d 7 h");
  });

  it("names a day or an hour as given, whatever the time zone it is read in", () => {
    // 14 hours ahead of UTC, then 11 behind it: the day and the hour stay as the server gave them.
    for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      vi.stubEnv("TZ", timeZone);
      expect(new Date(Date.UTC(2026, 10, 5, 12)).getDate()).toBe(timeZone === "Pacific/Kiritimati" ? 6 : 5);
      expect(new Date(Date.UTC(2026, 10, 5, 6)).getDate()).toBe(timeZone === "Pacific/Kiritimati" ? 5 : 4);
      expect(bucketLabel({ date: "2026-11-05" })).toMatch(/^\D*5\D*$/);
      expect(bucketTitle({ date: "2026-11-05" })).toMatch(/\b5\b.*2026/);
      expect(bucketTitle({ date: "2026-11-05" })).toMatch(/Thu/);
      // 6 in the morning, and 11 at night, on a 12-hour or a 24-hour clock.
      expect(bucketLabel({ date: "2026-11-05", hour: 6 })).toMatch(/^0?6\b/);
      expect(bucketLabel({ date: "2026-11-05", hour: 23 })).toMatch(/^(11|23)\b/);
      expect(bucketTitle({ date: "2026-11-05", hour: 23 })).toMatch(/\b5\b.*2026.*\b(11|23)\b/);
    }
  });
});
