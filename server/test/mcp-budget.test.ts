import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { CUT_MARK, MAX_RESPONSE_CHARS, MIN_CUT, withinBudget } from "../src/mcp/budget.js";

// The shared guard that keeps an MCP tool's response within its budget
// (ADR-0028), through the pure function every tool's response passes: what
// it cuts, in what order, and what it leaves whole. The Seam 1 budget tests
// (assistant-budget.test.ts) run it through every read tool.

type Fields = Record<string, unknown>;

const size = (value: unknown) => JSON.stringify(value).length;
const page = <T>(key: string, entries: T[], offset = 0, total = offset + entries.length) => ({ total, offset, more: offset + entries.length < total, [key]: entries });
const cutText = (value: unknown) => typeof value === "string" && value.endsWith(CUT_MARK);

describe("withinBudget", () => {
  it("returns a response that fits as it is", () => {
    const response = { shots: [{ id: "a", notes: "x".repeat(40_000) }] };
    expect(withinBudget(response, {}, "test")).toBe(response);
  });

  it("cuts free text no shorter than it must be, the longest first, marking each cut and noting it first", () => {
    const response = { id: "shot", barista: "Ann", notes: "n".repeat(60_000), stopReason: "targetWeight", curves: { pressure: { unit: "bar", values: [[0, 9]] } } };
    const fitted = withinBudget(response, { rest: "Ask without curves." }, "get_shot") as Fields;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(size(fitted)).toBeGreaterThan(MAX_RESPONSE_CHARS - 10);
    expect(Object.keys(fitted)[0]).toBe("cut");
    expect(fitted.cut).toBe(`Text ending in ${CUT_MARK} was cut to keep this response small. Ask without curves.`);
    expect(fitted.notes).toMatch(/^n+…\[cut\]$/);
    expect({ ...fitted, cut: undefined, notes: undefined }).toEqual({ ...response, cut: undefined, notes: undefined });
  });

  it("cuts several texts to the same length, leaving shorter ones whole", () => {
    const response = { a: "a".repeat(30_000), b: "b".repeat(30_000), c: "c".repeat(5_000) };
    const fitted = withinBudget(response, {}, "test") as Fields;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect((fitted.a as string).length).toBe((fitted.b as string).length);
    expect(fitted.c).toBe(response.c);
  });

  it("measures text as serialized, escapes included, and never splits a character", () => {
    const escaped = '"\\\n'.repeat(10_000);
    const emoji = "\u{1F600}".repeat(20_000);
    const fitted = withinBudget({ quoted: escaped, emoji }, {}, "test") as Fields;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect([fitted.quoted, fitted.emoji].every(cutText)).toBe(true);
    const kept = (fitted.emoji as string).slice(0, -CUT_MARK.length);
    expect(kept).toBe("\u{1F600}".repeat(kept.length / 2));
  });

  it("never cuts ids, a Profile's steps, or a part the tool names whole", () => {
    const [long, longer] = ["s".repeat(7_000), "t".repeat(30_000)];
    const response = {
      id: long,
      beanId: long,
      toolIds: [long],
      profile: { steps: [{ name: long }], notes: longer },
      machineSettings: { value: { label: long } },
      workflow: { name: longer },
    };
    const fitted = withinBudget(response, { whole: ["/machineSettings"] }, "test") as typeof response;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect([fitted.id, fitted.beanId, fitted.toolIds[0], fitted.profile.steps[0]!.name, fitted.machineSettings.value.label]).toEqual([long, long, long, long, long]);
    expect([fitted.profile.notes, fitted.workflow.name].every(cutText)).toBe(true);
  });

  it("names a part whole by a path whose * stands for any key or index", () => {
    const long = "v".repeat(10_000);
    const response = page("settingsEdits", [
      { fields: { webUiPath: long }, readBack: { webUiPath: long }, decaidMessage: long },
      { fields: { webUiPath: long }, readBack: null, decaidMessage: long },
    ]);
    const fitted = withinBudget(response, { whole: ["/settingsEdits/*/fields", "/settingsEdits/*/readBack"] }, "test") as typeof response;
    const [first, second] = fitted.settingsEdits as unknown as { fields: unknown; readBack: unknown; decaidMessage: unknown }[];
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect([first!.fields, first!.readBack, second!.fields]).toEqual([{ webUiPath: long }, { webUiPath: long }, { webUiPath: long }]);
    expect([first!.decaidMessage, second!.decaidMessage].every(cutText)).toBe(true);
  });

  it("ends a page sooner when cutting its text isn't enough, keeping its paging fields first and marking more after it", () => {
    // Each about 1,100 characters, as a Shot's summary is, in text too short to cut.
    const shots = Array.from({ length: 50 }, (_, n) => ({ id: `shot-${n}`, barista: "Ann", parts: Array.from({ length: 10 }, () => "s".repeat(105)) }));
    const response = page("shots", shots, 100, 400);
    const fitted = withinBudget(response, {}, "find_shots") as typeof response;
    const kept = fitted.shots as typeof shots;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(kept.length).toBeGreaterThan(30);
    expect(kept.length).toBeLessThan(50);
    expect(Object.keys(fitted)).toEqual(["total", "offset", "more", "shots"]);
    expect(fitted).toMatchObject({ total: 400, offset: 100, more: true });
    expect(kept).toEqual(shots.slice(0, kept.length));
  });

  it("ends a page whose list comes before its paging fields as having more", () => {
    const entries = Array.from({ length: 50 }, (_, n) => ({ id: `e-${n}`, parts: Array.from({ length: 10 }, () => "t".repeat(150)) }));
    const fitted = withinBudget({ entries, total: 50, offset: 0, more: false }, {}, "test") as Fields;
    expect((fitted.entries as unknown[]).length).toBeLessThan(50);
    expect(fitted.more).toBe(true);
  });

  it("cuts text as short as it may be before ending pages, then no shorter than it must be for those left", () => {
    // Hostile names: ten of 5,000 characters each a Shot, which even at the shortest cut don't fit 50 to a page.
    const shots = Array.from({ length: 50 }, (_, n) => ({ id: `shot-${n}`, names: Array.from({ length: 10 }, () => "h".repeat(5_000)) }));
    const fitted = withinBudget(page("shots", shots), {}, "test") as Fields;
    const kept = fitted.shots as { names: string[] }[];
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(kept.length).toBeLessThan(50);
    expect(kept.length).toBeGreaterThan(10);
    const names = kept.flatMap((shot) => shot.names);
    expect(names.every((name) => cutText(name) && name.length >= MIN_CUT + CUT_MARK.length)).toBe(true);
    // Those left are cut longer than the shortest cut.
    expect(names[0]!.length).toBeGreaterThan(MIN_CUT + CUT_MARK.length);
    expect(Object.keys(fitted)[0]).toBe("cut");
  });

  it("ends every page at the same number of entries, and notes no cut for text only in entries left out", () => {
    const entries = (key: string) => Array.from({ length: 40 }, (_, n) => ({ id: `${key}-${n}`, parts: Array.from({ length: 5 }, () => "x".repeat(150)), note: n === 39 ? "n".repeat(1_000) : null }));
    const response = { workflowChanges: page("entries", entries("w")), machineStates: page("entries", entries("m")), loadedRecipes: page("entries", entries("l").slice(0, 3)) };
    const fitted = withinBudget(response, {}, "get_machine_activity") as unknown as Record<string, { entries: unknown[]; more: boolean }>;
    expect(size(fitted)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(fitted.workflowChanges!.entries.length).toBe(fitted.machineStates!.entries.length);
    expect(fitted.workflowChanges!.more).toBe(true);
    expect(fitted.loadedRecipes).toEqual(response.loadedRecipes);
    expect(fitted).not.toHaveProperty("cut");
  });

  it("keeps one entry a page, returns what can't fit as it is then, and logs it", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const huge = { id: "profile", steps: Array.from({ length: 2_000 }, (_, n) => ({ name: `step ${n}`, pressure: 9 })) };
      const fitted = withinBudget(page("entries", [huge, huge]), {}, "get_library_item") as Fields;
      expect(fitted.entries).toEqual([huge]);
      expect(fitted.more).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("get_library_item's response is"));
    } finally {
      warn.mockRestore();
    }
  });
});
