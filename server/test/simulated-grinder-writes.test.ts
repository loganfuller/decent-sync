import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Dye2GrinderField, Dye2FormRefused, dye2V035Recording, editGrinderInDye2 } from "./support/simulated-dye2.js";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's grinder writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/grinder-writes-v0.8.7/): each
// recorded request is sent to a simulated tablet whose Decaid starts with no
// grinders, as that one did, and must be answered the same, field for field
// and in the same order, but for the ids Decaid assigns and the times it
// reads from its clock, which are compared by which are the same as which.

interface Exchange {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/grinder-writes-v0.8.7/grinder-writes.json");
const exchanges = JSON.parse(fs.readFileSync(fixture, "utf8")) as Exchange[];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A time as Dart's toIso8601String writes a local one. */
const WHOLE_LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(\d{3})?$/;
/** The fields a record holds Decaid's clock in. */
const CLOCK_FIELDS = new Set(["createdAt", "updatedAt"]);

/** A grinder's range and defaults, as DYE2 names them in its `extras`. */
const RANGED = ["settingMin", "settingMax", "settingDefault", "rpmMin", "rpmMax", "rpmDefault"];

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

  of(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      if (key !== undefined && CLOCK_FIELDS.has(key) && WHOLE_LOCAL_TIME.test(value)) return this.name(value, "time");
      return value.replace(UUID, (id) => (this.assigned.has(id) ? this.name(id, "id") : id));
    }
    if (Array.isArray(value)) return value.map((item) => this.of(item));
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, this.of(item, field)]));
    return value;
  }

  private name(value: string, kind: string): string {
    if (!this.names.has(value)) this.names.set(value, `<${kind} ${this.names.size + 1}>`);
    return this.names.get(value)!;
  }
}

describe("The simulated tablet's grinder writes", () => {
  // No settings: the plugin does not connect, and only Decaid's API is used.
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/grinders": [] } });
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
    expect(JSON.stringify(simulated.of(tablet.grinders()))).toBe(JSON.stringify(recorded.of(exchanges.at(-2)!.response.body)));
    for (const record of tablet.grinders()) {
      expect(record.createdAt).toMatch(WHOLE_LOCAL_TIME);
      expect(record.updatedAt).toMatch(WHOLE_LOCAL_TIME);
    }
  });
});

describe("DYE2 v0.1.35's grinders page on the simulated tablet, as recorded on Decaid v0.9.1 (fixtures/decaid/dye2-v0.1.35/grinders.json)", () => {
  type Step = { exchanges: Exchange[] };
  const steps = dye2V035Recording<Record<string, Step>>("grinders");
  const written = (step: Step) => step.exchanges.find(({ request }) => request.method === "PUT" || request.method === "POST")!;
  /** A record without the times Decaid reads from its clock. */
  const timeless = (value: unknown) => {
    const { createdAt: _, updatedAt: __, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  const before = written(steps.globalIdWritten!).response.body as Record<string, unknown>;
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/grinders": [before] } });
  afterAll(() => tablet.unload());
  const sent: Exchange["request"][] = [];
  const page = new Proxy(tablet, {
    get(target, property) {
      if (property === "callApi") {
        return async (method: Exchange["request"]["method"], route: string, body?: unknown) => {
          if (method !== "GET") sent.push({ method, path: route, ...(body === undefined ? {} : { body }) });
          return target.callApi(method, route, body);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SimulatedTablet;

  /**
   * A request or record without what DYE2 sends since: from v0.1.37 an edit
   * sends a null in `extras` for each of the grinder's range and defaults
   * left blank, which Decaid keeps, where v0.1.35 sent none
   * (fixtures/decaid/dye2-v0.1.40/grinder-form.json).
   */
  const asV035 = (value: unknown) => {
    const { extras, ...rest } = value as Record<string, unknown>;
    if (typeof extras !== "object" || extras === null) return value;
    const kept = Object.entries(extras).filter(([key, held]) => !(RANGED.includes(key) && held === null));
    return { ...rest, extras: Object.fromEntries(kept) };
  };

  it("sends a feed rate note typed, kept, and cleared in the grinder's extras over its other keys, its global id among them, and a new grinder's in extras alone", async () => {
    const id = String(before.id);
    const changes: Record<string, Partial<Record<Dye2GrinderField, string>>> = {
      noteSet: { feedRate: "manual FF/MF/SF" },
      otherEdited: { notes: "Fixture notes" },
      noteCleared: { feedRate: "" },
    };
    for (const [name, change] of Object.entries(changes)) {
      sent.length = 0;
      const answer = await editGrinderInDye2(page, id, change);
      const recorded = written(steps[name]!);
      expect(sent.map((request) => ({ ...request, body: asV035(request.body) })), name).toEqual([recorded.request]);
      expect({ ...answer, body: asV035(timeless(answer.body)) }, name).toEqual({ ...recorded.response, body: timeless(recorded.response.body) });
    }
    sent.length = 0;
    const created = await editGrinderInDye2(page, null, { model: "Fixture Feeder Grinder", feedRate: "feeder RPM 200-1200" });
    const recorded = written(steps.created!);
    expect(sent).toEqual([recorded.request]);
    const { id: _, ...made } = timeless(created.body);
    const { id: __, ...madeThen } = timeless(recorded.response.body);
    expect({ status: created.status, body: made }).toEqual({ status: recorded.response.status, body: madeThen });
  });

  it("drops a top-level feedRate, as the previous release's plugin writes a Grinder's note, and keeps one in extras, as this release's writes it", async () => {
    for (const name of ["topLevel", "inExtras"]) {
      const { request, response } = written(steps[name]!);
      const answer = await tablet.callApi(request.method, request.path.replace(/[0-9a-f-]{36}/, String(before.id)), request.body);
      expect({ ...answer, body: timeless(answer.body) }, name).toEqual({ ...response, body: timeless(response.body) });
    }
  });
});

describe("DYE2 v0.1.40's grinders page on the simulated tablet, as recorded on Decaid v0.9.2 (fixtures/decaid/dye2-v0.1.40/grinder-form.json)", () => {
  type Shown = { error?: string | null; typed?: Partial<Record<Dye2GrinderField, string>> };
  type Step = { exchanges: (Exchange | Shown)[]; after: Exchange[] };
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/dye2-v0.1.40/grinder-form.json");
  const steps = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Step>;
  const exchangesOf = (step: Step) => step.exchanges.filter((entry): entry is Exchange => "request" in entry);
  const typedIn = (step: Step) => step.exchanges.find((entry): entry is Shown => "typed" in entry)!.typed!;
  const errorOf = (step: Step) => step.exchanges.find((entry): entry is Shown => "error" in entry)!.error;
  /** A record without its id and the times Decaid reads from its clock. */
  const timeless = (value: unknown) => {
    const { id: _, createdAt: __, updatedAt: ___, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/grinders": [] } });
  afterAll(() => tablet.unload());
  const sent: Exchange["request"][] = [];
  const page = new Proxy(tablet, {
    get(target, property) {
      if (property === "callApi") {
        return async (method: Exchange["request"]["method"], route: string, body?: unknown) => {
          if (method !== "GET") sent.push({ method, path: route, ...(body === undefined ? {} : { body }) });
          return target.callApi(method, route, body);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as SimulatedTablet;
  /** The recording's grinder ids as the simulated tablet's. */
  const idFor = new Map<string, string>();
  const routed = (request: Exchange["request"]) => ({ ...request, path: request.path.replace(UUID, (id) => idFor.get(id) ?? id) });
  /** The simulated tablet's record of the grinder the step read after it, as the recording holds it. */
  const held = (step: Step) => {
    const recorded = step.after[0]!.response.body as { id: string };
    return { now: timeless(tablet.grinders().find((grinder) => grinder.id === idFor.get(recorded.id))), then: timeless(recorded) };
  };
  /** Saves the form as the step typed it, and compares what it sent and what the tablet then holds with the recording. */
  async function replay(name: string, id: string | null): Promise<void> {
    const step = steps[name]!;
    sent.length = 0;
    const answer = await editGrinderInDye2(page, id, typedIn(step));
    const [recorded] = exchangesOf(step);
    expect(errorOf(step), name).toBeNull();
    if (id === null) idFor.set((recorded!.response.body as { id: string }).id, (answer.body as { id: string }).id);
    expect(sent, name).toEqual([routed(recorded!.request)]);
    expect({ status: answer.status, body: timeless(answer.body) }, name).toEqual({ status: recorded!.response.status, body: timeless(recorded!.response.body) });
    const { now, then } = held(step);
    expect(now, name).toEqual(then);
  }
  let id: string;

  it("saves a range and defaults into the grinder's extras over its other keys, its global id and its feed rate note among them, a lowest setting of 0 as 0, and keeps them through an edit of another field", async () => {
    const [made] = exchangesOf(steps.made!);
    const answer = await tablet.callApi(made!.request.method, made!.request.path, made!.request.body);
    id = (answer.body as { id: string }).id;
    idFor.set((made!.response.body as { id: string }).id, id);
    expect(timeless(answer.body)).toEqual(timeless(made!.response.body));

    await replay("rangeSaved", id);
    expect(tablet.grinders()[0]!.extras).toEqual({
      bcUuid: "fixture-bc-uuid",
      decentSyncId: "5c0f3d52-7a1e-4c55-9d0e-2f6a41b7c551",
      feedRate: "manual FF/MF/SF",
      settingMin: 0,
      settingMax: 10,
      settingDefault: 4,
      rpmMin: 400,
      rpmMax: 1200,
      rpmDefault: 900,
    });
    await replay("otherEdited", id);
  });

  it("refuses a lowest above a highest, for the setting and for the RPM, sending nothing, in an edit and in a new grinder", async () => {
    for (const name of ["settingReversed", "rpmReversed", "createdReversed"]) {
      const step = steps[name]!;
      expect(exchangesOf(step), name).toEqual([]);
      sent.length = 0;
      const refused = await editGrinderInDye2(page, name === "createdReversed" ? null : id, typedIn(step)).catch((error: unknown) => error);
      expect(refused, name).toBeInstanceOf(Dye2FormRefused);
      expect((refused as Error).message, name).toBe(errorOf(step));
      expect(sent, name).toEqual([]);
    }
    const { now, then } = held(steps.rpmReversed!);
    expect(now).toEqual(then);
  });

  it("saves a lowest equal to a highest, a default outside the range as typed, a default cleared as null, and numbers below 0", async () => {
    for (const name of ["defaultOutside", "defaultCleared", "belowZero"]) await replay(name, id);
  });

  it("drops a range sent at the record's top, as the previous release's plugin writes one, and keeps one in extras, as this release's writes it", async () => {
    for (const name of ["topLevel", "inExtras"]) {
      const step = steps[name]!;
      const [{ request, response }] = exchangesOf(step) as [Exchange];
      const answer = await tablet.callApi(request.method, routed(request).path, request.body);
      expect({ status: answer.status, body: timeless(answer.body) }, name).toEqual({ status: response.status, body: timeless(response.body) });
      const { now, then } = held(step);
      expect(now, name).toEqual(then);
    }
  });

  it("clears the setting's range and default as the grinder is edited to named positions, its RPM's kept, and leaves them cleared as it is edited back", async () => {
    await replay("namedPositions", id);
    expect(tablet.grinders()[0]!.extras).toMatchObject({ settingMin: null, settingMax: null, settingDefault: null, rpmMin: 400, rpmMax: 1200, rpmDefault: 700 });
    await replay("numericAgain", id);
  });

  it("saves a new grinder's range and defaults in extras alone, only those typed, and none of the setting's for one with named positions", async () => {
    await replay("created", null);
    await replay("createdNamed", null);
  });
});
