import { date, elapsedSeconds, number, object, string } from "../shots/extraction.js";

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
  const times: number[] = [];
  const readings: number[] = [];
  for (const sample of samples) {
    const at = date(object(object(sample).machine).timestamp)?.getTime();
    if (at !== undefined) times.push(at);
    const milk = number(object(sample).milkTemperature);
    if (milk !== null) readings.push(milk);
  }
  const next = readings.findIndex((reading) => reading !== readings[0]);
  const current = next > 0 && readings[next]! < readings[0]! ? readings.slice(next) : readings;
  return {
    duration: elapsedSeconds(times),
    peakMilkTemperature: current.reduce<number | null>((peak, reading) => (peak === null ? reading : Math.max(peak, reading)), null),
    finalMilkTemperature: readings.at(-1) ?? null,
    barista: string(object(object(steam.workflow).context).baristaName),
  };
}
