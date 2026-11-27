// How the management interface names a Bean Batch (#732): by its Bean and
// its Batch Code, with its roast date wherever there is a second line or a
// sentence, and in place of the code on a batch that has none. Every page
// names a batch through here and through the components that draw these
// forms (components/batch-name.tsx), so none builds a name of its own:
//
// - in a line, "House Espresso" with its code, or "House Espresso, roasted
//   10 Nov" (`batchLine`);
// - in a table's cell, the same first line without the date, over "Roasted
//   17 Nov" (`batchLine` with `roastedLine`);
// - where the Bean is already said, its code with "roasted 17 Nov", or
//   "Roasted 10 Nov" (`batchOfBean`);
// - in words, "House Espresso LR-0411, roasted 17 Nov" (`batchWords`).

/** What names a batch, wherever a response gives one. */
export interface NamedBatch {
  bean: { name: string | null };
  /** Its roast date as Decaid recorded it, such as 2026-11-17T00:00:00.000. */
  roastDate: string | null;
  /** Its Batch Code; null for none, and absent from the previous release's answers during a deploy (ADR-0025), which read as a batch with none. */
  batchCode?: string | null;
}

// Written at UTC, where `recordedDay` puts the day, so no time zone moves it.
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_AND_YEAR = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The day a date Decaid recorded names, as that day's midnight in UTC: the
 * date a barista picked, read from its text, whatever time zone it was
 * written in or is read in. Undefined for none, or for text that names no
 * day.
 */
function recordedDay(date: string | null | undefined): Date | undefined {
  const match = /^(\d{4})-(\d\d)-(\d\d)/.exec(date ?? "");
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const read = new Date(Date.UTC(year, month - 1, day));
  return read.getUTCFullYear() === year && read.getUTCMonth() === month - 1 && read.getUTCDate() === day ? read : undefined;
}

/**
 * A date Decaid recorded, such as a roast date, as its day, as a batch's
 * weight lines write days (`dayText`): "17 Nov" as the browser's locale
 * writes one, with its year when that is not this year.
 */
export function recordedDayText(date: string | null | undefined, now: Date = new Date()): string | undefined {
  const day = recordedDay(date);
  return day && (day.getUTCFullYear() === now.getFullYear() ? DAY : DAY_AND_YEAR).format(day);
}

/** A date Decaid recorded where it is itself the value shown, as in a batch's Roast card: its day with its year, such as "17 Nov 2026". */
export function recordedDayWithYear(date: string | null | undefined): string | undefined {
  const day = recordedDay(date);
  return day && DAY_AND_YEAR.format(day);
}

/** A batch's Bean, by name. */
export function batchBean(batch: Pick<NamedBatch, "bean">): string {
  return batch.bean.name ?? "Unnamed Bean";
}

/** A batch's Batch Code, or undefined for none. */
export function batchCodeOf(batch: Pick<NamedBatch, "batchCode">): string | undefined {
  return batch.batchCode == null || batch.batchCode === "" ? undefined : batch.batchCode;
}

/** A batch's roast date within a sentence: "roasted 17 Nov", or "no roast date". */
export function roastedText(batch: Pick<NamedBatch, "roastDate">, now: Date = new Date()): string {
  const day = recordedDayText(batch.roastDate, now);
  return day === undefined ? "no roast date" : `roasted ${day}`;
}

/** A batch's roast date as a line of its own: "Roasted 17 Nov", or "No roast date". */
export function roastedLine(batch: Pick<NamedBatch, "roastDate">, now: Date = new Date()): string {
  const text = roastedText(batch, now);
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * A batch in a line: its Bean, and its Batch Code, which the page sets
 * apart; or, for a batch with none, its roast date in the code's place, as
 * `after`, such as ", roasted 10 Nov".
 */
export function batchLine(batch: NamedBatch, now: Date = new Date()): { bean: string; code?: string; after?: string } {
  const code = batchCodeOf(batch);
  return code === undefined ? { bean: batchBean(batch), after: `, ${roastedText(batch, now)}` } : { bean: batchBean(batch), code };
}

/** A batch in a line, as text alone, such as "House Espresso LR-0411" or "House Espresso, roasted 10 Nov". */
export function batchLineText(batch: NamedBatch, now: Date = new Date()): string {
  const { bean, code, after } = batchLine(batch, now);
  return code === undefined ? `${bean}${after}` : `${bean} ${code}`;
}

/** A batch as its own page titles it, beside the chip of its Batch Code: its Bean and roast date, such as "House Espresso, roasted 17 Nov". */
export function batchTitle(batch: NamedBatch, now: Date = new Date()): string {
  return `${batchBean(batch)}, ${roastedText(batch, now)}`;
}

/**
 * A batch where its Bean is already said: its Batch Code, set apart, with
 * "roasted 17 Nov" after it, or, for a batch with none, "Roasted 10 Nov"
 * alone.
 */
export function batchOfBean(batch: Pick<NamedBatch, "roastDate" | "batchCode">, now: Date = new Date()): { code?: string; roasted: string } {
  const code = batchCodeOf(batch);
  return code === undefined ? { roasted: roastedLine(batch, now) } : { code, roasted: roastedText(batch, now) };
}

/** That, as text alone, such as "LR-0411 roasted 17 Nov" or "Roasted 10 Nov". */
export function batchOfBeanText(batch: Pick<NamedBatch, "roastDate" | "batchCode">, now: Date = new Date()): string {
  const { code, roasted } = batchOfBean(batch, now);
  return code === undefined ? roasted : `${code} ${roasted}`;
}

/**
 * A batch in words, for a dialog's title and text, an option of a select
 * and a control's accessible name: "House Espresso LR-0411, roasted 17 Nov",
 * or "House Espresso, roasted 10 Nov" for a batch with no Batch Code.
 */
export function batchWords(batch: NamedBatch, now: Date = new Date()): string {
  const code = batchCodeOf(batch);
  return `${batchBean(batch)}${code === undefined ? "" : ` ${code}`}, ${roastedText(batch, now)}`;
}

/**
 * How long after its roast a Shot was pulled, for the line under its batch:
 * the days from the batch's roast date to the Shot's day at its Location
 * (`shotDay`, as 2026-11-27), such as "10 days before this Shot", or "the
 * day of this Shot" for none. Undefined for a batch with no roast date, a
 * Shot whose day isn't known, or one pulled before the roast date.
 */
export function roastedBeforeShot(roastDate: string | null, shotDay: string | undefined): string | undefined {
  const roasted = recordedDay(roastDate);
  const pulled = recordedDay(shotDay);
  if (!roasted || !pulled) return undefined;
  const days = Math.round((pulled.getTime() - roasted.getTime()) / 86_400_000);
  if (days < 0) return undefined;
  return days === 0 ? "the day of this Shot" : `${days} ${days === 1 ? "day" : "days"} before this Shot`;
}
