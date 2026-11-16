import { expect, type Page } from "@playwright/test";
import type pg from "pg";
import { preheatShotFixture, shotFixture, withShots } from "../../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, SimulatedTablet, derivedDe1Pro, settingsFor } from "../../server/test/support/simulated-tablet.js";
import { farFromMidnight } from "./calendar.js";
import { createLocation } from "./seed.js";

// Shots for the server to judge against the margins (#543; GLOSSARY.md, Out
// of spec), which the Overview's spec and the Shots list's read: on two
// Machines at the Lab and one at the Harbor, of Recipes with and without a
// Reference Shot, some out of spec, an Unfinished Shot and a cleaning Shot
// among them.
//
// Simulated tablets running the built plugin backfill twelve Shots on two
// Machines at the Lab and one at the Harbor, each derived from one of two
// Shots Decaid recorded, changing only its id, time, recorded hardware and
// what the table names. The Recipes are made through the REST API once the
// tablets are unloaded, so none is written to one, and each Shot's Recipe
// is then set in PostgreSQL, with each Machine's Loaded Recipes: how a
// tablet's map and its Workflow make them is shot-recipe-links.spec.ts's to
// cover. The real Shots weighed 0.1 g and 1.3 g under their targets of 36 g,
// ran 23.549 s and 25.833 s after their Preheat, and stopped on weight.
// Hardware ids are made up.
//
// | Shot | Machine | Pulled, on its Location's wall clock | Recipe | What it is |
// |---|---|---|---|---|
// | left-house-1 | Lab Left | today 01:00 | House, slot 2 | −0.1 g, 23.549 s: the House's Reference Shot |
// | left-house-2 | Lab Left | today 01:10 | House | −1.3 g, 25.833 s |
// | left-house-unfinished | Lab Left | today 01:20 | House | stopped at once: an Unfinished Shot |
// | left-decaf | Lab Left | today 01:40 | Decaf, slot 1 | +2.5 g, ended by the Machine |
// | left-none | Lab Left | today 02:00 | none | −0.1 g, 23.549 s |
// | left-cleaning | Lab Left | today 02:10 | none | a cleaning Shot |
// | right-house | Lab Right | today 01:05 | House | −0.1 g, 23.549 s |
// | right-decaf | Lab Right | yesterday 08:00 | Decaf | −1.3 g, 25.833 s |
// | right-guest | Lab Right | 3 days ago 08:00 | Guest, no slot | −0.1 g, 23.549 s |
// | right-old | Lab Right | 8 days ago 08:00 | House | before every period |
// | harbor-house | Harbor 1 | today 00:30 | Harbor House, slot 1 | −0.1 g, 23.549 s |
// | depot-none | Depot 1 | today 00:45, stored by a later test | none | −0.1 g, 23.549 s |
//
// A judgement needs three Shots, and a margin a duration no fixture ran, so
// eleven more are copies of those rows made in PostgreSQL, as
// server/test/shot-spec.test.ts makes its own, each changing only its id,
// time, Recipe and what the table names, a duration as the Shot's own with
// a Preheat of 0:
//
// | Copies | Of | Pulled today | Recipe | What each is |
// |---|---|---|---|---|
// | left-house-slow-1, -2 | left-house-1 | 01:12, 01:14 | House | 27 s |
// | left-house-last | left-house-1 | 02:25 | House | 27 s: the Left's last Shot |
// | right-house-2, -3 | right-house | 01:07, 01:09 | House | 24.5 s |
// | left-decaf-2, -3 | left-decaf | 01:42, 01:44 | Decaf | +2.5 g, ended by the Machine |
// | right-decaf-slow-1, -2, -3 | right-house | 00:05, 00:10, 00:15 | Decaf | 30 s |
// | right-none-last | right-house | 02:30 | none | 25 s, 6 g under, ended by the Machine: the Right's last Shot |
//
// So today, at the Lab, against the margins (10% of a Reference Shot's
// duration, 5% of a yield's target, 90% stopped at target, and 10% of the
// slower Machine's duration between Machines):
//
// | Recipe | Lab Left | Lab Right | Between Machines |
// |---|---|---|---|
// | Decaf, no Reference Shot | 3 Shots, 23.5 s; +2.5 g of 36, and 0 of 3 stopped at target: both out of spec | 3 Shots, 30 s | 6.5 s apart, of 30: out of spec |
// | House, reference 23.549 s | 5 Shots and 1 unfinished, median 27 s: +3.5 s, out of spec | 3 Shots, median 24.5 s: +1.0 s, within spec | 2.5 s apart, of 27: within spec |
// | no Recipe | 1 Shot and 1 cleaning | 1 Shot, 6 g under and ended by the Machine: too few to judge | |
//
// The days are counted back from today, so the Locations are where no day
// begins while this runs (`farFromMidnight`): the Harbor an hour or two ahead
// of the Lab, so its Shot, half an hour into its day, was pulled on the
// Lab's yesterday.

export const HOUR = 3_600_000;

/** The Lab's and the Depot's time zone, how many hours it is ahead of UTC, and how a time there names it. */
export const { zone: ZONE, ahead: AHEAD, zoneName: ZONE_NAME } = farFromMidnight();
/** The Harbor's: Regina, 6 hours behind UTC all year, beside Phoenix, or Tokyo, 9 ahead, beside Bangkok, each as far from its midnight. */
export const HARBOR = ZONE === "America/Phoenix" ? { zone: "America/Regina", ahead: -6 } : { zone: "Asia/Tokyo", ahead: 9 };

export const LEFT = "10071";
export const RIGHT = "10072";
export const HARBOR_1 = "10073";
export const DEPOT_1 = "10074";

export type Fields = Record<string, unknown>;

/** A day where the clocks are `ahead` of UTC, `days` from today there, as a UTC date at its midnight on the wall clock. */
export function day(days: number, ahead = AHEAD): Date {
  const today = new Date(Date.now() + ahead * HOUR);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
}

/** The moment the wall clock there read a time on a day `days` from today. */
export function at(days: number, hours: number, minutes = 0, ahead = AHEAD): string {
  return new Date(day(days, ahead).getTime() + (hours - ahead) * HOUR + minutes * 60_000).toISOString();
}

/** A day at the Lab as an address names it, such as 2026-11-11. */
export const date = (days: number) => day(days).toISOString().slice(0, 10);

/** A day at the Lab as the Shots list's date fields show it, such as "Nov 11, 2026". */
export const dateText = (days: number) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(day(days));

/** What a test changes of a fixture's record. */
export interface Changes {
  actualYield?: number;
  stopReason?: string;
  /** Its profile's type. */
  type?: string;
  /** Stopped at once, in its preinfusion, before anything poured: its first two samples alone. */
  unfinished?: boolean;
}

/** A Shot pulled at a UTC time on the hardware given, derived from `fixture` with the changes given. */
export function shotOf(id: string, pulledAt: string, serial: string, changes: Changes = {}, fixture = shotFixture()): Fields {
  const workflow = fixture.workflow as Record<string, Fields>;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    ...(changes.stopReason !== undefined && { stopReason: changes.stopReason }),
    ...(changes.unfinished && { measurements: (fixture.measurements as Fields[]).slice(0, 2) }),
    workflow: {
      ...workflow,
      profile: { ...workflow.profile, ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** What `seedJudgedShots` made, for a spec to read. */
export interface JudgedShots {
  lab: { id: string };
  harbor: { id: string };
  machines: Record<"left" | "right" | "harbor1" | "depot1", { id: string; token: string }>;
  recipes: Record<"house" | "decaf" | "guest" | "harborHouse", string>;
}

/** The tablet with this serial, its Decaid holding no Library of its own, so the Library is only what the spec makes. */
export function emptyLibrary(serial: string) {
  return { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };
}

/**
 * Copies a Shot's row in PostgreSQL under another id, with the columns
 * given, and its record's stop reason where one is given.
 */
export async function copyShot(database: pg.Client, from: string, id: string, columns: Fields, stopReason?: string) {
  const record = stopReason === undefined ? {} : { record: { ...(await database.query<{ record: Fields }>("SELECT record FROM shots WHERE id = $1", [from])).rows[0]!.record, stopReason } };
  await database.query("INSERT INTO shots SELECT (jsonb_populate_record(NULL::shots, to_jsonb(s) || $2::jsonb)).* FROM shots AS s WHERE s.id = $1", [from, JSON.stringify({ id, ...columns, ...record })]);
}

/**
 * Three Locations and five Machines: two at the Lab and one at the Harbor,
 * each there since long before its Shots, which its tablet backfills; one
 * at the Depot whose tablet never connected; and one at no Location. Then,
 * the tablets unloaded, the Recipes, each Shot's Recipe, the copies that
 * make groups large enough to judge, the Recipes each Machine had loaded,
 * and the House's Reference Shot.
 */
export async function seedJudgedShots(page: Page, server: { url(): string; connectDatabase(): Promise<pg.Client> }): Promise<JudgedShots> {
  const post = async <T>(path: string, data: Fields): Promise<T> => {
    const response = await page.request.post(`/api${path}`, { data });
    expect(response.status(), `${path}: ${await response.text()}`).toBe(201);
    return (await response.json()) as T;
  };
  const machine = async (name: string, locationId?: string) => {
    const created = await post<{ machine: { id: string }; token: string }>("/machines", { name });
    if (locationId) await post(`/machines/${created.machine.id}/location-history`, { locationId, effectiveFrom: "2025-01-01T00:00:00Z" });
    return { id: created.machine.id, token: created.token };
  };
  const lab = await createLocation(page, "Lab", ZONE);
  const harbor = await createLocation(page, "Harbor", HARBOR.zone);
  const depot = await createLocation(page, "Depot", ZONE);
  const machines = { left: await machine("Lab Left", lab.id), right: await machine("Lab Right", lab.id), harbor1: await machine("Harbor 1", harbor.id), depot1: await machine("Depot 1", depot.id) };
  await machine("Spare");

  const shots: [{ token: string }, string, Fields[]][] = [
    [
      machines.left,
      LEFT,
      [
        shotOf("left-house-1", at(0, 1), LEFT),
        shotOf("left-house-2", at(0, 1, 10), LEFT, {}, preheatShotFixture()),
        shotOf("left-house-unfinished", at(0, 1, 20), LEFT, { unfinished: true }),
        shotOf("left-decaf", at(0, 1, 40), LEFT, { actualYield: 38.5, stopReason: "machineEnded" }),
        shotOf("left-none", at(0, 2), LEFT),
        shotOf("left-cleaning", at(0, 2, 10), LEFT, { type: "cleaning" }),
      ],
    ],
    [
      machines.right,
      RIGHT,
      [
        shotOf("right-house", at(0, 1, 5), RIGHT),
        shotOf("right-decaf", at(-1, 8), RIGHT, {}, preheatShotFixture()),
        shotOf("right-guest", at(-3, 8), RIGHT),
        shotOf("right-old", at(-8, 8), RIGHT),
      ],
    ],
    [machines.harbor1, HARBOR_1, [shotOf("harbor-house", at(0, 0, 30, HARBOR.ahead), HARBOR_1)]],
  ];
  const tablets = shots.map(([{ token }, serial, pulled]) => SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token }), api: withShots(emptyLibrary(serial), pulled), timeScale: 50 }));
  const stored = shots.reduce((count, [, , pulled]) => count + pulled.length, 0);
  await expect.poll(async () => ((await (await page.request.get("/api/shots?limit=1")).json()) as { total: number }).total, { timeout: 30_000 }).toBe(stored);
  // The Left's tablet reports its Machine idle and the Harbor's asleep, as one left for the night, the Right's nothing.
  tablets[0]!.reportState("idle", "idle");
  tablets[2]!.reportState("sleeping", "idle");
  const stateOf = async (machine: { id: string }) =>
    ((await (await page.request.get(`/api/machines/${machine.id}`)).json()) as { machine: { machineState: { state: string } | null } }).machine.machineState?.state;
  await expect.poll(() => stateOf(machines.left)).toBe("idle");
  await expect.poll(() => stateOf(machines.harbor1)).toBe("sleeping");
  await Promise.all(tablets.map((tablet) => tablet.unload()));

  // The House's Bean Batch was roasted 12 days ago, by the Lab's days.
  const made = async (path: string, data: Fields) => Object.values(await post<Record<string, { id: string }>>(path, data))[0]!.id;
  const beanId = await made("/beans", { content: { roaster: "Roux", name: "Guji" } });
  const beanBatchId = await made("/bean-batches", { beanId, content: { roastDate: date(-12) }, locations: [{ locationId: lab.id }] });
  const recipe = (locationId: string, name: string, slot: number | null, content: Fields = {}) => made("/recipes", { locationId, slot, content: { name, ...content } });
  const recipes = {
    house: await recipe(lab.id, "House", 2, { beanBatchId }),
    decaf: await recipe(lab.id, "Decaf", 1),
    guest: await recipe(lab.id, "Guest", null),
    harborHouse: await recipe(harbor.id, "Harbor House", 1),
  };

  // Each Shot's Recipe, as its tablet's map would resolve the one its Workflow names, and the Recipes each Machine had
  // loaded: the Left the House again since 02:15, after its Decaf and a while with none, and the Right the House
  // again since half an hour into today.
  const pulledWith: Record<string, string> = {
    "left-house-1": recipes.house,
    "left-house-2": recipes.house,
    "left-house-unfinished": recipes.house,
    "left-decaf": recipes.decaf,
    "right-house": recipes.house,
    "right-decaf": recipes.decaf,
    "right-guest": recipes.guest,
    "right-old": recipes.house,
    "harbor-house": recipes.harborHouse,
  };
  const loaded: [{ id: string }, string, string, string | null][] = [
    [machines.left, recipes.house, at(-9, 0), at(0, 1, 30)],
    [machines.left, recipes.decaf, at(0, 1, 30), at(0, 1, 50)],
    [machines.left, recipes.house, at(0, 2, 15), null],
    [machines.right, recipes.house, at(-9, 0), at(-4, 0)],
    [machines.right, recipes.guest, at(-4, 0), at(-2, 0)],
    [machines.right, recipes.decaf, at(-2, 0), at(0, 0, 30)],
    [machines.right, recipes.house, at(0, 0, 30), null],
    [machines.harbor1, recipes.harborHouse, at(-9, 0, 0, HARBOR.ahead), null],
  ];
  const database = await server.connectDatabase();
  try {
    for (const [id, recipeId] of Object.entries(pulledWith)) await database.query("UPDATE shots SET recipe_id = $2 WHERE id = $1", [id, recipeId]);
    // The copies, each of a Shot on its own Machine: its time today, its Recipe, and a duration of its own with no Preheat.
    const timed = (hours: number, minutes: number, recipeId: string | null, duration?: number) => ({ pulled_at: at(0, hours, minutes), recipe_id: recipeId, ...(duration !== undefined && { duration, preheat: 0 }) });
    await copyShot(database, "left-house-1", "left-house-slow-1", timed(1, 12, recipes.house, 27));
    await copyShot(database, "left-house-1", "left-house-slow-2", timed(1, 14, recipes.house, 27));
    await copyShot(database, "left-house-1", "left-house-last", timed(2, 25, recipes.house, 27));
    await copyShot(database, "right-house", "right-house-2", timed(1, 7, recipes.house, 24.5));
    await copyShot(database, "right-house", "right-house-3", timed(1, 9, recipes.house, 24.5));
    await copyShot(database, "left-decaf", "left-decaf-2", timed(1, 42, recipes.decaf));
    await copyShot(database, "left-decaf", "left-decaf-3", timed(1, 44, recipes.decaf));
    for (const [n, minutes] of [5, 10, 15].entries()) await copyShot(database, "right-house", `right-decaf-slow-${n + 1}`, timed(0, minutes, recipes.decaf, 30));
    // 6 g under its target of 36, and ended by its Machine.
    await copyShot(database, "right-house", "right-none-last", { ...timed(2, 30, null, 25), actual_yield: 30 }, "machineEnded");
    for (const [{ id }, recipeId, loadedAt, unloadedAt] of loaded) {
      await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, $3, $4)", [id, recipeId, loadedAt, unloadedAt]);
    }
  } finally {
    await database.end();
  }
  // The House is read against its own first Shot on the Left, of 23.549 s.
  expect((await page.request.put(`/api/recipes/${recipes.house}/reference-shot`, { data: { shotId: "left-house-1" } })).status()).toBe(200);
  return { lab, harbor, machines, recipes };
}
