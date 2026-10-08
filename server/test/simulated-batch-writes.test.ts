import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's bean batch writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/bean-batch-writes-v0.8.7/): each
// recorded request is sent to a simulated tablet whose Decaid starts with no
// beans or batches, as that one did, and must be answered the same, field for
// field and in the same order, but for the ids Decaid assigns and the times
// it reads from its clock, inside its error messages too. Those are compared
// by which are the same as which.

interface Exchange {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/bean-batch-writes-v0.8.7/bean-batch-writes.json");
const exchanges = JSON.parse(fs.readFileSync(fixture, "utf8")) as Exchange[];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A time as Dart's toIso8601String writes a local one, and as SQLite's errors print it, with its offset after a space. */
const LOCAL_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?(?: [+-]\d\d:\d\d)?(?!\d|Z)/g;
const WHOLE_LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?$/;

/** The UUIDs a value holds anywhere, inside strings too. */
function uuidsIn(value: unknown): string[] {
  return JSON.stringify(value).match(UUID) ?? [];
}

/**
 * Replaces the ids Decaid assigned and the times it wrote with names, given
 * in the order they first appear, wherever they appear, so two answers
 * compare equal when they hold the same ids and times in the same places.
 */
class Names {
  private readonly names = new Map<string, string>();

  constructor(private readonly assigned: ReadonlySet<string>) {}

  of(value: unknown): unknown {
    if (typeof value === "string") {
      return value.replace(UUID, (id) => (this.assigned.has(id) ? this.name(id, "id") : id)).replace(LOCAL_TIME, (time) => this.name(time, "time"));
    }
    if (Array.isArray(value)) return value.map((item) => this.of(item));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.of(item)]));
    return value;
  }

  private name(value: string, kind: string): string {
    if (!this.names.has(value)) this.names.set(value, `<${kind} ${this.names.size + 1}>`);
    return this.names.get(value)!;
  }
}

describe("The simulated tablet's bean batch writes", () => {
  // No settings: the plugin does not connect, and only Decaid's API is used.
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/beans": [], "/bean-batches": [] } });
  afterAll(() => tablet.unload());

  it("answer as Decaid v0.8.7 answered them, field for field, refusals included", async () => {
    /** The ids the requests chose, such as global ids and ids no record has: never Decaid's. */
    const given = new Set(exchanges.flatMap((exchange) => uuidsIn(exchange.request.body ?? null)));
    /** The id the simulated tablet assigned each record the recording created. */
    const idFor = new Map<string, string>();
    const answers: Exchange["response"][] = [];
    for (const { request, response } of exchanges) {
      const route = request.path.replace(UUID, (id) => idFor.get(id) ?? id);
      const answer = await tablet.callApi(request.method, route, request.body);
      answers.push(answer);
      if (answer.status === 201) {
        const id = (answer.body as { id: string }).id;
        expect(id).toMatch(UUID_V4);
        idFor.set((response.body as { id: string }).id, id);
      }
    }

    const assigned = (responses: Exchange["response"][]) => new Set(responses.flatMap((response) => uuidsIn(response.body)).filter((id) => !given.has(id)));
    const recorded = new Names(assigned(exchanges.map((exchange) => exchange.response)));
    const simulated = new Names(assigned(answers));
    // Compared as JSON text, so the fields' order counts too.
    expect(answers.map((answer) => JSON.stringify(simulated.of(answer)))).toEqual(exchanges.map(({ response }) => JSON.stringify(recorded.of(response))));
    // What the tablet holds in the end is what Decaid listed, archived ones included.
    expect(JSON.stringify(simulated.of([tablet.batches(), tablet.beans()]))).toBe(
      JSON.stringify(recorded.of([exchanges.at(-2)!.response.body, exchanges.at(-1)!.response.body])),
    );
    for (const record of [...tablet.batches(), ...tablet.beans()]) {
      expect(record.createdAt).toMatch(WHOLE_LOCAL_TIME);
      expect(record.updatedAt).toMatch(WHOLE_LOCAL_TIME);
    }
  });
});
