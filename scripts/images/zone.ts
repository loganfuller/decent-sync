// The time zone the image capture runs in. The Overview and the Recipe page show each Location's own today, and
// today's Shots reach back about 4 hours before the latest, so the capture runs in a zone where it is the afternoon:
// one of these, a zone for each whole hour from UTC-10 to UTC+13, none with daylight saving. Whatever the hour it runs
// at, one of them is between 14:00 and 15:00, so every run gives the same pages, but for their dates and times and the
// zone's name.

/** A zone for each offset from UTC-10 to UTC+13, in hours ahead of UTC, each with no daylight saving. */
export const AFTERNOON_ZONES: Readonly<Record<number, string>> = {
  [-10]: "Pacific/Honolulu",
  [-9]: "Pacific/Gambier",
  [-8]: "Pacific/Pitcairn",
  [-7]: "America/Phoenix",
  [-6]: "America/Regina",
  [-5]: "America/Bogota",
  [-4]: "America/La_Paz",
  [-3]: "America/Sao_Paulo",
  [-2]: "America/Noronha",
  [-1]: "Atlantic/Cape_Verde",
  0: "Africa/Abidjan",
  1: "Africa/Lagos",
  2: "Africa/Johannesburg",
  3: "Africa/Nairobi",
  4: "Asia/Dubai",
  5: "Asia/Karachi",
  6: "Asia/Dhaka",
  7: "Asia/Bangkok",
  8: "Asia/Singapore",
  9: "Asia/Tokyo",
  10: "Australia/Brisbane",
  11: "Pacific/Guadalcanal",
  12: "Pacific/Tarawa",
  13: "Pacific/Tongatapu",
};

/** The local hour the latest Shot falls in. */
export const AFTERNOON_HOUR = 14;

/** A zone's hours ahead of UTC at a moment, from the runtime's own time zone data. */
export function offsetHours(zone: string, ms: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(ms).find((part) => part.type === "timeZoneName")!.value;
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!match) throw new Error(`${zone}: unexpected offset ${name}`);
  if (!match[1]) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) + Number(match[3]) / 60);
}

/** The zone of AFTERNOON_ZONES where the moment falls in the hour from AFTERNOON_HOUR. */
export function afternoonZone(ms: number): string {
  const utcHour = new Date(ms).getUTCHours();
  // The offset in -10 to +13 that takes this UTC hour to AFTERNOON_HOUR.
  const offset = ((((AFTERNOON_HOUR - utcHour) % 24) + 24 + 10) % 24) - 10;
  return AFTERNOON_ZONES[offset]!;
}
