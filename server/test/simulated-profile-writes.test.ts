import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's profile writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/profile-writes-v0.8.7/): each
// recorded request is sent to a simulated tablet whose Decaid holds the two
// bundled profiles the recording reads first, and must be answered the same,
// field for field and in the same order, ids included, since Decaid derives
// a profile's id from its content. Only the times Decaid reads from its clock
// (`createdAt` and `updatedAt`) are compared by which are the same as which.

interface Exchange {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/profile-writes-v0.8.7/profile-writes.json");
const exchanges = JSON.parse(fs.readFileSync(fixture, "utf8")) as Exchange[];

/** A time as Dart's toIso8601String writes a local one. */
const LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?$/;
const CLOCK_FIELDS = new Set(["createdAt", "updatedAt"]);

/** Replaces the times Decaid wrote with names, given in the order they first appear, so two answers compare equal when they hold the same times in the same places. */
class Times {
  private readonly names = new Map<string, string>();

  of(value: unknown, key?: string): unknown {
    if (typeof value === "string" && key !== undefined && CLOCK_FIELDS.has(key) && LOCAL_TIME.test(value)) {
      if (!this.names.has(value)) this.names.set(value, `<time ${this.names.size + 1}>`);
      return this.names.get(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.of(item));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, this.of(item, field)]));
    return value;
  }
}

describe("The simulated tablet's profile writes", () => {
  // The bundled profiles the recording reads, as Decaid held them; no settings, so the plugin does not connect.
  const bundled = exchanges.slice(0, 2).map((exchange) => exchange.response.body as Record<string, unknown>);
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/profiles": bundled } });
  afterAll(() => tablet.unload());

  it("answer as Decaid v0.8.7 answered them, field for field, ids derived from content and refusals included", async () => {
    const answers: Exchange["response"][] = [];
    for (const { request } of exchanges) answers.push(await tablet.callApi(request.method, request.path, request.body));

    // Compared as JSON text, so the fields' order counts too.
    const recorded = new Times();
    const simulated = new Times();
    expect(answers.map((answer) => JSON.stringify(simulated.of(answer)))).toEqual(exchanges.map(({ response }) => JSON.stringify(recorded.of(response))));
    // The records it made carry Decaid's own times.
    for (const record of tablet.profiles()) {
      expect(record.createdAt).toMatch(LOCAL_TIME);
      expect(record.updatedAt).toMatch(LOCAL_TIME);
    }
  });

  it("lists every profile with includeHidden, hidden and deleted ones too, the most recently updated first", async () => {
    const all = (await tablet.callApi("GET", "/profiles?includeHidden=true")).body as Record<string, unknown>[];
    expect(all.map((record) => record.visibility).sort()).toEqual(["deleted", "hidden", "hidden", "visible"]);
    const times = all.map((record) => String(record.updatedAt));
    expect(times).toEqual([...times].sort().reverse());
    expect(((await tablet.callApi("GET", "/profiles")).body as Record<string, unknown>[]).map((record) => record.visibility)).toEqual(["visible"]);
  });
});
