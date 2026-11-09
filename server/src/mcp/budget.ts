import { BadRequestException, Logger } from "@nestjs/common";
import { Tool, type ToolOptions } from "@nestjs/mcp";
import * as z from "zod";

// Every MCP tool's response kept within a size budget that Claude and
// ChatGPT take inline (ADR-0028), by one guard every tool's response passes
// through: `BudgetedTool`, which every tool is declared with in place of
// `@Tool`, rounds its numbers to hundredths (`rounded`), measures it as the
// MCP module serializes it, and, over the cap, cuts its free text, longest
// first, then ends each of its pages sooner, but never cuts its structured
// data.

/** The most characters of one compact JSON copy of a response, as `@nestjs/mcp` serializes it (`JSON.stringify`). */
export const MAX_RESPONSE_CHARS = 45_000;

/** What every tool declares in `tools/list`, so Claude Code keeps a slight overrun inline rather than saving it to a file. */
export const RESULT_SIZE_META = { "anthropic/maxResultSizeChars": 100_000 } as const;

/** No free text is cut shorter than this many characters: shorter text, such as ids, times and names, is left whole. */
export const MIN_CUT = 200;

/** What ends text cut to fit. */
export const CUT_MARK = "…[cut]";

/** A tool's own guide to its response's budget. */
export interface Budget {
  /**
   * Parts of its response that are structured data, given as they are: never
   * cut, nor their numbers rounded, as a Machine's settings, which
   * edit_machine_settings' expected must give exactly. Each is a path from
   * the response's root, such as `/machineSettings`, in which `*` stands for
   * any key or index. Beside these, ids (`id`, and keys ending in `Id` or
   * `Ids`) and a Profile's `steps` are never cut, wherever they are. Every
   * other string is free text.
   */
  whole?: readonly string[];
  /** How to have more of what was cut, ending the response's `cut` note. */
  rest?: string;
}

/** A tool's options, as `@Tool` takes them, with its response's budget. */
export interface BudgetedToolOptions extends ToolOptions {
  name: string;
  outputSchema: z.ZodObject;
  budget?: Budget;
}

const cutNote = z
  .string()
  .optional()
  .describe(`Only when text was cut to fit: which, each ending in ${CUT_MARK}, and how to have more of it.`);

/**
 * A tool, as `@Tool` declares one, whose response the shared guard rounds
 * (`rounded`) and keeps within the budget (`withinBudget`), declaring
 * `RESULT_SIZE_META` and the response's `cut` note in its output schema. A
 * tool that changes something refuses text a response cut
 * (`refuseCutText`). It wraps the method, so any other method decorator,
 * such as `@UseGuards`, goes above it, to apply to the method it leaves.
 */
export function BudgetedTool({ budget = {}, ...options }: BudgetedToolOptions): MethodDecorator {
  const changes = options.annotations?.readOnlyHint !== true;
  return (target, key, descriptor) => {
    const method = descriptor.value as (...args: unknown[]) => unknown;
    const guarded = async function (this: unknown, ...args: unknown[]) {
      if (changes) refuseCutText(args[0]);
      return withinBudget(rounded(await method.apply(this, args), budget), budget, options.name);
    };
    (descriptor as PropertyDescriptor).value = guarded;
    return Tool({
      ...options,
      outputSchema: options.outputSchema.extend({ cut: cutNote }),
      _meta: { ...RESULT_SIZE_META, ...options._meta },
    })(target, key, descriptor);
  };
}

const logger = new Logger("McpBudget");

/**
 * A tool's response within `MAX_RESPONSE_CHARS` as serialized, if it can be:
 * as it is if it fits; otherwise with its free text cut, the longest first,
 * to no shorter than `MIN_CUT`, each cut string ending in `CUT_MARK`, and a
 * `cut` note first saying so; then, if it still doesn't fit, with each of its
 * pages (`pageOf`) ended sooner, at the same number of entries and at least
 * one, each marked as having more after it. Its structured data
 * (`Budget.whole`) is never cut. A response that can't fit even so is
 * returned as it is then, and logged.
 */
export function withinBudget<T>(response: T, budget: Budget, tool: string): T {
  if (typeof response !== "object" || response === null || Array.isArray(response) || size(response) <= MAX_RESPONSE_CHARS) return response;
  // As the client receives it: a Date as its text, and what is undefined left out. A cut note the tool gave for text it
  // cut itself is given again only if what is kept still holds cut text, as the entries holding it may not be kept.
  const { cut: _, ...sent } = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  const whole = (budget.whole ?? []).map((path) => path.split("/").slice(1));
  const note = cutNoteOf(budget);
  const fitted = (at: number, entries: number) => {
    const shape = new Shape(whole, at, entries);
    const value = shape.of(sent, []) as Record<string, unknown>;
    return { value: shape.cut ? { cut: note, ...value } : value, shape };
  };
  const fits = (at: number, entries: number) => size(fitted(at, entries).value) <= MAX_RESPONSE_CHARS;
  const { longest, most } = fitted(Infinity, Infinity).shape;
  const textUpTo = Math.min(longest, MAX_RESPONSE_CHARS);

  let [at, entries] = [Infinity, Infinity];
  // The text first, cut no shorter than it must be, if cutting it is enough; then fewer entries a page, with it cut as
  // short as it may be, and then cut no shorter than it must be for those.
  if (longest > MIN_CUT && fits(MIN_CUT, entries)) at = largest(MIN_CUT, textUpTo, (n) => fits(n, entries));
  else {
    if (most > 1) entries = largest(1, most, (n) => fits(MIN_CUT, n));
    at = longest > MIN_CUT && fits(MIN_CUT, entries) ? largest(MIN_CUT, textUpTo, (n) => fits(n, entries)) : MIN_CUT;
  }
  const { value } = fitted(at, entries);
  const length = size(value);
  if (length > MAX_RESPONSE_CHARS) logger.warn(`${tool}'s response is ${length} characters, over ${MAX_RESPONSE_CHARS} even with its free text cut and its pages at one entry each`);
  return value as T;
}

/**
 * The `cut` note a response holding cut text gives first, saying so and how
 * to have more of it: the guard's, and a tool's that cuts text of its own to
 * keep each entry of a list small, as find_shots does.
 */
export function cutNoteOf(budget: Budget): string {
  return `Text ending in ${CUT_MARK} was cut to keep this response small; never send it back in a change, which is refused. ${budget.rest ?? "The management interface shows it whole."}`;
}

/**
 * Refuses an input holding text a response cut, `CUT_MARK` in it anywhere,
 * saying how to have the whole of it: a change's, as an assistant that edits
 * a field it read cut, such as a Bean's notes read with its history, would
 * otherwise save the cut text over the whole, and a filter's, such as
 * find_shots's, as no Shot recorded a cut name.
 */
export function refuseCutText(input: unknown, whole = "read it whole first, such as without history or curves, and send the whole of it"): void {
  const holds = (value: unknown): boolean =>
    typeof value === "string" ? value.includes(CUT_MARK) : typeof value === "object" && value !== null && Object.values(value).some(holds);
  if (holds(input)) throw new BadRequestException(`A value holds ${CUT_MARK}, so it is text a response cut short: ${whole}`);
}

/**
 * The largest whole number from `low` to `high` at which the response a tool
 * makes with it (`respond`) is within `MAX_RESPONSE_CHARS`, as the guard
 * measures it, or `low` if none is, searched by halving, as a response nearly
 * always grows with the number. Where it doesn't, as when thinning curves to
 * more points picks shorter readings, the number found may be a little under
 * the largest, but a response is never over the cap at it unless at `low`.
 * For structured data the guard never shortens, which a tool gives as much of
 * as fits, as get_shot's curves within a window.
 */
export function mostWithinBudget(low: number, high: number, respond: (n: number) => unknown): number {
  return largest(low, high, (n) => size(respond(n)) <= MAX_RESPONSE_CHARS);
}

/**
 * A response with each number that isn't whole rounded to hundredths, as the
 * management interface shows a record's and a Workflow's, so float noise,
 * such as a steam flow of 2.5000000000000004, or a pressure of 3.533203125,
 * reads as 2.5 and 3.53; but those in its whole parts (`Budget.whole`), as it
 * gives them.
 */
export function rounded<T>(response: T, budget: Budget): T {
  const whole = (budget.whole ?? []).map((path) => path.split("/").slice(1));
  const round = (value: unknown, path: readonly string[]): unknown => {
    if (typeof value === "number") return Number.isFinite(value) && !Number.isInteger(value) ? hundredths(value) : value;
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map((entry, n) => entryOf(String(n), entry, path));
    // A Date, or another class's instance, as the MCP module serializes it.
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entryOf(key, entry, path)]));
  };
  const entryOf = (key: string, value: unknown, path: readonly string[]) => {
    const at = [...path, key];
    return whole.some((part) => onPath(part, at)) ? value : round(value, at);
  };
  return round(response, []) as T;
}

/** A number to hundredths, as `rounded` gives each, and as the curves round their readings and seconds before a window compares them. */
export function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Whether `at` is the part a path names, `*` in it standing for any key or index. */
function onPath(part: readonly string[], at: readonly string[]): boolean {
  return part.length === at.length && part.every((segment, n) => segment === "*" || segment === at[n]);
}

function size(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * A response shaped to a budget: its free text cut to `at` characters, and
 * its pages ended at `entries`, noting whether any text it holds is cut, by
 * it or already by the tool, and
 * its longest free text and its longest page.
 */
class Shape {
  cut = false;
  longest = 0;
  most = 0;

  constructor(
    private readonly whole: readonly string[][],
    private readonly at: number,
    private readonly entries: number,
  ) {}

  /** The value at `path`, shaped: a string as free text, and each of an object's or list's entries but those whole. */
  of(value: unknown, path: readonly string[]): unknown {
    if (typeof value === "string") {
      this.longest = Math.max(this.longest, value.length);
      const kept = cut(value, this.at);
      // Cut here, or already, by the tool.
      if (kept.endsWith(CUT_MARK)) this.cut = true;
      return kept;
    }
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map((entry, n) => this.entry(String(n), entry, path));
    const object = value as Record<string, unknown>;
    const list = pageList(object);
    const shaped: Record<string, unknown> = {};
    let ended = false;
    for (const [key, entry] of Object.entries(object)) {
      if (key === list) {
        const all = entry as unknown[];
        this.most = Math.max(this.most, all.length);
        ended = all.length > this.entries;
        shaped[key] = all.slice(0, this.entries).map((kept, n) => this.entry(String(n), kept, [...path, key]));
      } else shaped[key] = this.entry(key, entry, path);
    }
    if (ended) shaped.more = true;
    return shaped;
  }

  /** An object's or list's entry under `key`, shaped unless it is whole: an id, a Profile's steps, or a part the tool names. */
  private entry(key: string, value: unknown, path: readonly string[]): unknown {
    const at = [...path, key];
    if (key === "id" || /Ids?$/.test(key) || key === "steps") return value;
    if (this.whole.some((part) => onPath(part, at))) return value;
    return this.of(value, at);
  }
}

/** The key of a page's list, if an object is a page, as `pageOf` makes one: `total`, `offset` and `more` beside one list. */
function pageList(object: Record<string, unknown>): string | undefined {
  if (typeof object.total !== "number" || typeof object.offset !== "number" || typeof object.more !== "boolean") return undefined;
  const lists = Object.keys(object).filter((key) => Array.isArray(object[key]));
  return lists.length === 1 ? lists[0] : undefined;
}

/** Text cut to at most `at` characters, not splitting a character, ending in `CUT_MARK`; as it is if no longer than that would make it. */
export function cut(text: string, at: number): string {
  if (text.length <= at + CUT_MARK.length) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(at - 1)) ? at - 1 : at;
  return text.slice(0, end) + CUT_MARK;
}

/** The largest whole number from `low` to `high` for which `holds`, given that it holds for every number below one it holds for; `low` if none. */
function largest(low: number, high: number, holds: (n: number) => boolean): number {
  let [found, above] = [low, high + 1];
  while (above - found > 1) {
    const middle = Math.floor((found + above) / 2);
    if (holds(middle)) found = middle;
    else above = middle;
  }
  return found;
}
