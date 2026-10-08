import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's bean writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/bean-writes-v0.8.7/): each recorded
// request is sent to a simulated tablet whose Decaid starts with no beans, as
// that one did, and must be answered the same, field for field and in the same
// order, but for the ids Decaid assigns and the times it reads from its clock.
// Those are compared by which are the same as which, and by their shape.

interface Exchange {
  request: { method: "GET" | "POST" | "PUT"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/bean-writes-v0.8.7/bean-writes.json");
const exchanges = JSON.parse(fs.readFileSync(fixture, "utf8")) as Exchange[];

/** A time as Dart's toIso8601String writes a local one: milliseconds, then microseconds unless they are 0. */
const LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Replaces the ids Decaid assigned and the times it wrote with names, given
 * in the order they first appear, so two answers compare equal when they
 * hold the same ids and times in the same places.
 */
class Names {
  private readonly ids = new Map<string, string>();
  private readonly times = new Map<string, string>();

  constructor(private readonly assigned: ReadonlySet<string>) {}

  of(value: unknown): unknown {
    if (typeof value === "string") {
      if (this.assigned.has(value)) return this.name(this.ids, value, "bean");
      if (LOCAL_TIME.test(value)) return this.name(this.times, value, "time");
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => this.of(item));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.of(item)]));
    return value;
  }

  private name(names: Map<string, string>, value: string, kind: string): string {
    if (!names.has(value)) names.set(value, `<${kind} ${names.size + 1}>`);
    return names.get(value)!;
  }
}

describe("The simulated tablet's bean writes", () => {
  // No settings: the plugin does not connect, and only Decaid's API is used.
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/beans": [] } });
  afterAll(() => tablet.unload());

  it("answer as Decaid v0.8.7 answered them, field for field", async () => {
    const recordedIds = new Set(exchanges.flatMap((exchange) => (exchange.response.status === 201 ? [(exchange.response.body as { id: string }).id] : [])));
    const simulatedIds = new Set<string>();
    /** The id the simulated tablet assigned each bean the recording created. */
    const idFor = new Map<string, string>();
    const answers: Exchange["response"][] = [];
    for (const { request, response } of exchanges) {
      const route = request.path.replace(/[0-9a-f-]{36}/, (id) => idFor.get(id) ?? id);
      const answer = await tablet.callApi(request.method, route, request.body);
      answers.push(answer);
      if (answer.status === 201) {
        const id = (answer.body as { id: string }).id;
        expect(id).toMatch(UUID_V4);
        simulatedIds.add(id);
        idFor.set((response.body as { id: string }).id, id);
      }
    }

    const recorded = new Names(recordedIds);
    const simulated = new Names(simulatedIds);
    // Compared as JSON text, so the fields' order counts too.
    expect(answers.map((answer) => JSON.stringify(simulated.of(answer)))).toEqual(
      exchanges.map(({ response }) => JSON.stringify(recorded.of(response))),
    );
    // What the tablet holds in the end is what Decaid listed, archived beans included.
    expect(JSON.stringify(simulated.of(tablet.beans()))).toBe(JSON.stringify(recorded.of(exchanges.at(-2)!.response.body)));
    for (const bean of [...tablet.beans(), ...(exchanges.at(-2)!.response.body as Record<string, unknown>[])]) {
      expect(bean.createdAt).toMatch(LOCAL_TIME);
      expect(bean.updatedAt).toMatch(LOCAL_TIME);
    }
  });
});
