import { type SteamPhase, steamPhases, steamingSeconds } from "@decent-sync/protocol";
import { date, elapsedMilliseconds, number, object, string } from "../shots/extraction.js";

/**
 * The revision of the values `extractSteamRecord` stores, raised whenever it
 * changes them, so that the Steam Records stored with an earlier revision's
 * are computed again (`CurvesRefresh`). Revision 1 adds the steaming time.
 */
export const STEAM_CURVES_REVISION = 1;

/**
 * A Steam Record's analytics, a projection of optional fields from the whole
 * record as Decaid serves it, measurements included: missing or unfamiliar
 * fields never invalidate a record. Its time is not among them. Decaid writes
 * only the tablet's local time, so the plugin sends the record's UTC time
 * beside it.
 *
 * The duration is the whole recording, as the release before stores it, and
 * the steaming time the part of it in Steaming, leaving out the lead-in, the
 * pauses, the puffs and the purge (`steamPhases`), from the sample times
 * counted as the duration's are.
 *
 * Each sample holds the machine's snapshot and the latest milk temperature a
 * probe reported (`SteamSnapshot` in Decaid), null before any reading or with
 * no probe. The final temperature is the last reading. Decaid starts a Steam
 * Record with the probe's latest reading, which until the probe reports
 * again is the last one of the record before: `SteamSequencer` subscribes to
 * the probe afresh for each record, and `BengleMilkProbe` replays its latest
 * reading to a new subscriber. Steamed milk warms, so when the probe's next
 * reading is lower, the reading the record starts with is taken to be carried
 * over and left out of the peak. Even if it was not, leaving it out changes
 * the peak only if no later reading is as high.
 */
export function extractSteamRecord(record: unknown) {
  const steam = object(record);
  const samples = Array.isArray(steam.measurements) ? steam.measurements : [];
  const phases = steamPhases(samples);
  const times: number[] = [];
  const timedPhases: SteamPhase[] = [];
  const readings: number[] = [];
  samples.forEach((sample, n) => {
    const at = date(object(object(sample).machine).timestamp)?.getTime();
    if (at !== undefined) {
      times.push(at);
      timedPhases.push(phases[n]!);
    }
    const milk = number(object(sample).milkTemperature);
    if (milk !== null) readings.push(milk);
  });
  const elapsed = elapsedMilliseconds(times);
  const next = readings.findIndex((reading) => reading !== readings[0]);
  const current = next > 0 && readings[next]! < readings[0]! ? readings.slice(next) : readings;
  return {
    duration: times.length === 0 ? null : elapsed.at(-1)! / 1000,
    steaming: times.length === 0 ? null : steamingSeconds(elapsed.map((ms, n) => ({ phase: timedPhases[n]!, seconds: ms / 1000 }))),
    peakMilkTemperature: current.reduce<number | null>((peak, reading) => (peak === null ? reading : Math.max(peak, reading)), null),
    finalMilkTemperature: readings.at(-1) ?? null,
    barista: string(object(object(steam.workflow).context).baristaName),
  };
}
