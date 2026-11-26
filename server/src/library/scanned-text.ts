import { isShotNote } from "@decent-sync/protocol";
import { MAX_BATCH_CODE_LENGTH } from "./item-input.js";

// Reading the text of a scanned QR code (ticket #708), which a Skin read and
// its plugin sent as it was: what in it may be a Batch Code, whether it
// names a Bean, and the dates in it. Nothing here decodes a code, or reads
// the Library: `BatchScansService` matches what these give against it.

/**
 * What in the text may be a Batch Code, where the text is a URL or JSON
 * (step 2 of matching): a URL's last path segment, each of its query values
 * and its fragment, or each string value of JSON, at any depth. Each is
 * trimmed, and one empty, longer than a Batch Code, or that PostgreSQL would
 * not store (a NUL or an unpaired surrogate a percent- or JSON escape gave)
 * is left out. None for text that is neither. Every value is read, so a code
 * listed after others is never missed and two codes in one text both match:
 * the text's own length (MAX_SCANNED_TEXT_LENGTH) bounds how many there are.
 *
 * A URL is text with a scheme and `//`, as `https://roaster.example/b/PR-0470`:
 * `Roaster: PR-0470` also parses as a URL, of the scheme `roaster`, and is
 * not read as one. JSON is whatever `JSON.parse` reads as an object, a list
 * or a string; a number alone is not a string value.
 */
export function codeCandidates(text: string): string[] {
  const found = urlValues(text) ?? jsonStrings(text) ?? [];
  const candidates = new Set<string>();
  for (const value of found) {
    const trimmed = value.trim();
    if (trimmed !== "" && trimmed.length <= MAX_BATCH_CODE_LENGTH && isShotNote(trimmed)) candidates.add(trimmed);
  }
  return [...candidates];
}

/** A URL's last path segment, query values and fragment, each decoded; null for text that is no URL. */
function urlValues(text: string): string[] | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || !URL.canParse(text)) return null;
  const url = new URL(text);
  const lastSegment = url.pathname.split("/").filter((segment) => segment !== "").at(-1);
  return [...(lastSegment === undefined ? [] : [decoded(lastSegment)]), ...url.searchParams.values(), ...(url.hash.length > 1 ? [decoded(url.hash.slice(1))] : [])];
}

/** A part of a URL with its percent-escapes read, or as it is where they can't be. */
function decoded(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The string values of JSON, at any depth, keys left out; null for text that is not JSON. */
function jsonStrings(text: string): string[] | null {
  if (!/^[[{"]/.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const strings: string[] = [];
  const read = (each: unknown): void => {
    if (typeof each === "string") strings.push(each);
    else if (typeof each === "object" && each !== null) for (const inner of Object.values(each)) read(inner);
  };
  read(value);
  return strings;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

/** The forms a date is read in, each with how its match gives the year, month and day. */
const DATE_FORMS: readonly { pattern: RegExp; read: (match: RegExpExecArray) => [year: string, month: number, day: string] }[] = [
  // 2026-11-20, 2026/11/20, 2026.11.20: the year first, so the month and day are not guessed.
  { pattern: /(?<!\d)(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/g, read: (match) => [match[1]!, Number(match[3]), match[4]!] },
  // 20 Nov 2026, 20 November 2026.
  { pattern: new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+${MONTH}[\\s,-]+(\\d{4})(?!\\d)`, "gi"), read: (match) => [match[3]!, monthOf(match[2]!), match[1]!] },
  // Nov 20, 2026.
  { pattern: new RegExp(`(?<![a-z])${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?[\\s,]+(\\d{4})(?!\\d)`, "gi"), read: (match) => [match[3]!, monthOf(match[1]!), match[2]!] },
];

function monthOf(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/**
 * The dates in the text that are read without guessing, each as
 * `YYYY-MM-DD`, with the text left once they are taken out of it: one
 * written year first (2026-11-20, 2026/11/20, 2026.11.20), or with its
 * month by name (20 Nov 2026, November 20, 2026). A date of numbers with
 * the year last is not read, as 03/04/2026 is March or April by who wrote
 * it, nor one of eight digits run together, which may be any number. A day
 * the calendar doesn't have is no date.
 */
export function datesIn(text: string): { dates: string[]; rest: string } {
  const dates = new Set<string>();
  let rest = text;
  for (const { pattern, read } of DATE_FORMS) {
    rest = rest.replace(pattern, (...args) => {
      const [year, month, day] = read(args.slice(0, -2) as unknown as RegExpExecArray);
      const date = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return args[0] as string;
      dates.add(date);
      return " ";
    });
  }
  return { dates: [...dates], rest };
}

/** The words of some text: its runs of letters and digits, in lower case. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether the text names a Bean (step 3 of matching): every word of the
 * text, its dates taken out (`rest`), is a word of the Bean's roaster and
 * name, as a label reading "Roux Guji" names Roux's Guji Natural; or every
 * word of the Bean's name is a word of the text, as a label holding the name
 * among much else does. A text of no words but a date names none, nor does
 * it a Bean with no name.
 */
export function namesBean(scanned: { words: ReadonlySet<string>; restWords: readonly string[] }, bean: { roaster: string | null; name: string | null }): boolean {
  const nameWords = wordsOf(bean.name ?? "");
  if (nameWords.length > 0 && nameWords.every((word) => scanned.words.has(word))) return true;
  if (scanned.restWords.length === 0) return false;
  const beanWords = new Set([...wordsOf(bean.roaster ?? ""), ...nameWords]);
  return scanned.restWords.every((word) => beanWords.has(word));
}

/** The text as `namesBean` reads it, with the dates in it (`datesIn`). */
export function scannedWords(text: string): { words: ReadonlySet<string>; restWords: string[]; dates: string[] } {
  const { dates, rest } = datesIn(text);
  return { words: new Set(wordsOf(text)), restWords: wordsOf(rest), dates };
}
