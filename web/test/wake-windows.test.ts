import { describe, expect, it } from "vitest";
import { FIRMWARE_MAX_WAKE_WINDOWS, firmwareWakeWindows } from "../src/lib/wake-windows";

// Each expectation is what decaid:lib/src/models/firmware_wake_window.dart's
// `translateWakeSchedules` makes of the same schedules at v0.9.0.

const schedule = (time: string, daysOfWeek: number[], keepAwakeFor?: number, enabled = true) => ({
  id: `${time}-${daysOfWeek.join("")}`,
  time,
  daysOfWeek,
  enabled,
  ...(keepAwakeFor === undefined ? {} : { keepAwakeFor }),
});

describe("firmwareWakeWindows", () => {
  it("counts one window per day a schedule runs, every day where it names none", () => {
    expect(firmwareWakeWindows([schedule("06:30", [1, 3, 5], 120)])).toBe(3);
    expect(firmwareWakeWindows([schedule("06:30", [], 120)])).toBe(7);
    expect(firmwareWakeWindows([schedule("06:30", [1, 2, 3, 4, 5], 120), schedule("08:00", [6, 7], 60)])).toBe(7);
  });

  it("counts another window the next day where a schedule runs past midnight", () => {
    expect(firmwareWakeWindows([schedule("23:00", [1], 120)])).toBe(2);
    // Up to midnight exactly stays one window.
    expect(firmwareWakeWindows([schedule("22:00", [1], 120)])).toBe(1);
    expect(firmwareWakeWindows([schedule("12:01", [], 720)])).toBe(14);
  });

  it("gives a schedule with no keep-awake time 240 min, so one starting after 20:00 takes two windows a day", () => {
    expect(firmwareWakeWindows([schedule("20:00", [])])).toBe(7);
    expect(firmwareWakeWindows([schedule("20:01", [])])).toBe(14);
    expect(firmwareWakeWindows([schedule("21:30", [2, 4])])).toBe(4);
  });

  it("leaves out a schedule that is off, and one Decaid could not read", () => {
    expect(firmwareWakeWindows([schedule("06:30", [], 60, false), { id: "x", daysOfWeek: [], enabled: true }, "06:30", null])).toBe(0);
    expect(firmwareWakeWindows(undefined)).toBe(0);
  });

  it("comes to more than the firmware takes with three every-day schedules after 20:00 and no keep-awake time", () => {
    const schedules = [schedule("20:30", []), schedule("21:00", []), schedule("22:00", [], 60)];
    expect(firmwareWakeWindows(schedules)).toBe(35);
    expect(firmwareWakeWindows(schedules)).toBeGreaterThan(FIRMWARE_MAX_WAKE_WINDOWS);
  });
});
