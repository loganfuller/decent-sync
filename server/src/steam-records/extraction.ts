import { date, number, object, string } from "../shots/extraction.js";

/**
 * A Steam Record's analytics, a projection of optional fields from the whole
 * record as Decaid serves it, measurements included: missing or unfamiliar
 * fields never invalidate a record. Its time is not among them. Decaid writes
 * only the tablet's local time, so the plugin sends the record's UTC time
 * beside it.
 *
 * Each sample holds the machine's snapshot and the latest milk temperature a
 * probe reported (`SteamSnapshot` in Decaid), null before any reading or with
 * no probe. The final temperature is the last reading. Decaid starts a Steam
 * Record with the probe's latest reading, which until the probe reports
 * again is the last one of the session before it: `SteamSequencer`
 * subscribes to the probe afresh for each record, and `BengleMilkProbe`
 * replays its latest reading to a new subscriber. Milk only warms as it is
 * steamed, so the peak leaves out the reading a record starts with once a
 * different one follows: it was carried over, or it was the coldest.
 */
export function extractSteamRecord(record: unknown) {
  const steam = object(record);
  const samples = Array.isArray(steam.measurements) ? steam.measurements : [];
  let first: number | null = null;
  let last: number | null = null;
  const readings: number[] = [];
  for (const sample of samples) {
    // Local times without an offset, which keep their differences when read as UTC.
    const at = date(object(object(sample).machine).timestamp)?.getTime();
    if (at !== undefined) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
    const milk = number(object(sample).milkTemperature);
    if (milk !== null) readings.push(milk);
  }
  const changed = readings.findIndex((reading) => reading !== readings[0]);
  const current = changed > 0 ? readings.slice(changed) : readings;
  return {
    duration: first !== null && last !== null ? (last - first) / 1000 : null,
    peakMilkTemperature: current.reduce<number | null>((peak, reading) => (peak === null ? reading : Math.max(peak, reading)), null),
    finalMilkTemperature: readings.at(-1) ?? null,
    barista: string(object(object(steam.workflow).context).baristaName),
  };
}
