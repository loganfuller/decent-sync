// A day as the management interface writes one a batch holds, such as its
// roast date (#732, `recordedDayText` in web/src/lib/batch-name.ts): the day
// its text names, as the browser's locale writes it, which is "Nov 17" in
// the en-US these specs' browser runs in, with its year when that is not
// this year.

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "numeric", month: "short" });
const DAY_AND_YEAR = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** The date a text such as 2026-11-17 names, at midnight UTC. */
function dateOf(date: string): Date {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`);
}

/** A date, such as 2026-11-17, as a list or a sentence writes it: "Nov 17", with its year when that is not this year. */
export function roastDay(date: string): string {
  const day = dateOf(date);
  return (day.getUTCFullYear() === new Date().getFullYear() ? DAY : DAY_AND_YEAR).format(day);
}

/** A date where it is itself the value shown, as on a batch's Roast card: its day with its year, such as "Nov 17, 2026". */
export function roastDayWithYear(date: string): string {
  return DAY_AND_YEAR.format(dateOf(date));
}
