// Relative, as the module tests import it without the web build's alias.
import { timeOfDayMinutes } from "./tablet-time";

// On a Bengle, Decaid writes the presence settings into the Machine's
// firmware too (`PresenceController` in
// decaid:lib/src/controllers/presence_controller.dart), its enabled wake
// schedules as wake windows (`translateWakeSchedules` in
// decaid:lib/src/models/firmware_wake_window.dart), of which the firmware
// takes at most 32: Decaid drops the rest.

/** The most wake windows a Bengle's firmware takes (`kFirmwareMaxWakeWindows`). */
export const FIRMWARE_MAX_WAKE_WINDOWS = 32;

/** How long a schedule with no keep-awake time keeps a Bengle awake, in minutes (`kFirmwareMaxSleepTimeoutMinutes`). */
const DEFAULT_KEEP_AWAKE_MINUTES = 240;

const MINUTES_PER_DAY = 24 * 60;

/**
 * How many wake windows Decaid makes of wake schedules as reported
 * (`WakeSchedule.toJson`), counted as `translateWakeSchedules` makes them,
 * before it drops those past FIRMWARE_MAX_WAKE_WINDOWS: for each enabled
 * schedule, one per day it runs, every day where it names none, and another
 * the next day where its keep-awake time, 240 min where it has none, runs
 * past midnight. A schedule Decaid could not read, such as one without a
 * time, makes none.
 */
export function firmwareWakeWindows(schedules: unknown): number {
  if (!Array.isArray(schedules)) return 0;
  let windows = 0;
  for (const schedule of schedules) {
    if (!isObject(schedule) || schedule.enabled !== true) continue;
    const start = timeOfDayMinutes(schedule.time);
    if (start === undefined) continue;
    const keepAwake = schedule.keepAwakeFor;
    const duration = typeof keepAwake === "number" && Number.isInteger(keepAwake) && keepAwake > 0 ? keepAwake : DEFAULT_KEEP_AWAKE_MINUTES;
    const named = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
    const days = named.length === 0 ? 7 : new Set(named.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)).size;
    windows += days * windowsPerDay(start, duration);
  }
  return windows;
}

/** The windows one day of a schedule makes: one up to midnight at most, then one a day for what is left. */
function windowsPerDay(start: number, duration: number): number {
  let count = 0;
  let dayStart = start;
  for (let remaining = duration; remaining > 0; dayStart = 0) {
    const end = Math.min(dayStart + remaining, MINUTES_PER_DAY);
    remaining -= end - dayStart;
    count += 1;
  }
  return count;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
