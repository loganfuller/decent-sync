import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { burrsShotFixture, preheatShotFixture, shotFixture, withShots } from "./support/shot-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: a Shot Summary grouped by Location, Machine, Recipe, Bean, Bean
// Batch, Profile, Grinder, Basket or Barista, two at once (#468), through
// the REST API, with a Barista's spellings folded in the grouping, the
// Barista filter and the filter's choices.
//
// Eleven Shots are stored through simulated tablets running the built
// plugin, each derived from one of three Shots Decaid recorded
// (shot-summary.test.ts works out what each shows), changing only its id,
// time, recorded hardware and what the table below names. The Library's
// items are made through the REST API once the tablets are unloaded, so
// none is written to one, and each Shot's links to them are then set in
// PostgreSQL, with each Machine's Loaded Recipes: how a tablet's map and
// its Workflow make them is shot-links.test.ts's and
// shot-recipe-links.test.ts's to cover, with tablets acting as DYE2 does.
// Hardware ids are made up, from 47801.
//
// | Shot | Machine | Yield − target | Duration | Stopped by | Barista | Bean | Profile | Recipe | Bean Batch | Grinder | Basket |
// |---|---|---|---|---|---|---|---|---|---|---|---|
// | left-house-1 | bar Left | −0.1 g | 23.549 s | targetWeight | `Jules` | Roux Bakehouse · Guji | Londonium | House, Lab | Guji, 20 Feb | EK43 | 18 g |
// | left-house-2 | bar Left | −1.3 g | 25.833 s | targetWeight | `jules ` | Roux Bakehouse · Guji | Adaptive v3 | House, Lab | Guji, 20 Feb | EK43 | 18 g |
// | left-decaf | bar Left | +2.4 g | 23.549 s | machineEnded | `Ann` | roux bakehouse · Guji | Londonium | decaf | Brazil | EK43 | 20 g |
// | left-none | bar Left | −6 g | 4.095 s | targetWeight | none | none | Default | none: it names House, which was not loaded then | none | none | none |
// | left-cleaning | bar Left | a cleaning Shot | | | three spaces | Roux Bakehouse · Guji | Clean | none | none | none | none |
// | right-house-1 | Bar Right | −0.1 g | 23.549 s | targetWeight | a tab, then `JULES` | Roux Bakehouse · Guji | Londonium | House, Lab | Guji, 10 Feb | EK43 | 18 g |
// | right-house-2 | Bar Right | +0.5 g | 23.549 s | targetWeight | `Ann` | Roux Bakehouse · Guji | Londonium | House, Lab | Guji, 10 Feb | EK43 | 18 g |
// | right-decaf | Bar Right | −1.3 g | 25.833 s | none recorded | `ann` | Roux Bakehouse, no name | Adaptive v3 | decaf | Brazil | none | 20 g |
// | harbor-house-1 | Harbor 1 | −0.1 g | 23.549 s | targetWeight | `Jules` | Roux Bakehouse · Guji | Londonium | House, Harbor | Guji, 20 Feb | ek43 | 18 g |
// | harbor-house-2 | Harbor 1 | −1.3 g | 25.833 s | targetWeight | `Kai` | Monogram · Guji | none | House, Harbor | none | ek43 | none |
// | pending | a Pending Machine | −0.1 g | 23.549 s | targetWeight | `JULES` | Roux Bakehouse · Guji | Londonium | none: it names House, and no Machine has it | none | none | none |
//
// The pending Shot is the latest, then right-decaf, so the Baristas are
// JULES and ann by their most recent spellings. A percentile is interpolated
// between the two Shots nearest it: of n values in order, counted from 0,
// the one at p × (n − 1).

interface SummaryNumber {
  shots: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

interface Named {
  id: string;
  name: string | null;
}

/** What a group is grouped by. */
interface By {
  location?: Named | null;
  machine?: Named | null;
  pendingMachine?: { id: string; model: string; serial: string } | null;
  recipe?: (Named & { location: Named | null }) | null;
  bean?: { roaster: string | null; name: string | null } | null;
  beanBatch?: { id: string; bean: { id: string; roaster: string | null; name: string | null }; roastDate: string | null } | null;
  profile?: string | null;
  grinder?: { id: string; model: string | null; location: Named | null } | null;
  basket?: Named | null;
  barista?: string | null;
}

interface Numbers {
  yieldAgainstTarget: SummaryNumber;
  duration: SummaryNumber;
  stoppedOnWeight: { shots: number; share: number | null };
}

interface Group {
  by: By;
  counts: { shots: number; cleaningAndCalibration: number };
  numbers: Numbers;
}

interface Summary {
  groups: Group[];
  total: number;
  limit: number;
  offset: number;
}

type Fields = Record<string, unknown>;

/** What a test changes of a fixture's record; null takes what it recorded away. */
interface Changes {
  actualYield?: number;
  stopReason?: string | null;
  type?: string;
  barista?: string | null;
  roaster?: string | null;
  bean?: string | null;
  title?: string;
}

const LEFT_SERIAL = "47801";
const RIGHT_SERIAL = "47802";
const HARBOR_SERIAL = "47803";
const UNKNOWN_SERIAL = "47809";

const GROUPINGS = ["location", "machine", "recipe", "bean", "beanBatch", "profile", "grinder", "basket", "barista"] as const;

/** A number of `shots` Shots. */
const number = (shots: number, median: number, p25 = median, p75 = median): SummaryNumber => ({ shots, median, p25, p75 });

/** The numbers of one Shot of shot-espresso.json: 0.1 g under its target, 23.549 s, stopped on weight. */
const ONE_ESPRESSO: Numbers = { yieldAgainstTarget: number(1, -0.1), duration: number(1, 23.549), stoppedOnWeight: { shots: 1, share: 1 } };
/** The numbers of one of shot-espresso.json and one of shot-preheat.json: −1.3 and −0.1, and 23.549 s and 25.833 s. */
const ESPRESSO_AND_PREHEAT: Numbers = { yieldAgainstTarget: number(2, -0.7, -1, -0.4), duration: number(2, 24.691, 24.12, 25.262), stoppedOnWeight: { shots: 2, share: 1 } };

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A Shot pulled at a UTC time on the hardware given, derived from `fixture` with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, changes: Changes = {}, fixture = shotFixture()): Fields {
  const { stopReason: recordedStop, ...record } = fixture;
  const workflow = fixture.workflow as Record<string, Fields>;
  const { baristaName, coffeeRoaster, coffeeName, ...context } = workflow.context!;
  const kept = (changed: string | null | undefined, recorded: unknown) => (changed === undefined ? recorded : (changed ?? undefined));
  const stopReason = kept(changes.stopReason, recordedStop);
  return {
    ...record,
    id,
    timestamp: pulledAt,
    ...(stopReason !== undefined && { stopReason }),
    workflow: {
      ...workflow,
      // JSON leaves out what is undefined, as a Shot that recorded none.
      context: { ...context, baristaName: kept(changes.barista, baristaName), coffeeRoaster: kept(changes.roaster, coffeeRoaster), coffeeName: kept(changes.bean, coffeeName) },
      profile: { ...workflow.profile, ...(changes.title !== undefined && { title: changes.title }), ...(changes.type !== undefined && { beverage_type: changes.type }) },
      machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
    },
    annotations: { ...(fixture.annotations as Fields), ...(changes.actualYield !== undefined && { actualYield: changes.actualYield }) },
  };
}

/** The filters of the Shots list a group opens as: each grouping's own, by what the group is grouped by, `none` or empty for its group of Shots with none. */
function filtersOf(by: By): Record<string, string> {
  const filters: Record<string, string> = {};
  if (by.location !== undefined) filters.locationId = by.location?.id ?? "none";
  if (by.machine) filters.machineId = by.machine.id;
  if (by.pendingMachine) filters.pendingMachineId = by.pendingMachine.id;
  if (by.recipe !== undefined) filters.recipeId = by.recipe?.id ?? "none";
  if (by.bean !== undefined) Object.assign(filters, { coffeeRoaster: by.bean?.roaster ?? "", coffeeName: by.bean?.name ?? "" });
  if (by.beanBatch !== undefined) filters.beanBatchId = by.beanBatch?.id ?? "none";
  if (by.profile !== undefined) filters.profileTitle = by.profile ?? "";
  if (by.grinder !== undefined) filters.grinderId = by.grinder?.id ?? "none";
  if (by.basket !== undefined) filters.basketId = by.basket?.id ?? "none";
  if (by.barista !== undefined) filters.barista = by.barista ?? "";
  return filters;
}

describe("Shot Summaries by group", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let harbor: LocationView;
  let left: CreatedMachine;
  let right: CreatedMachine;
  let harbor1: CreatedMachine;
  let pending: { id: string; model: string; serial: string };
  const tablets = new LoadedTablets();
  const raws: RawConnection[] = [];
  /** The Library's items, as a group names each. */
  let recipes: Record<"labHouse" | "decaf" | "harborHouse", NonNullable<By["recipe"]>>;
  let batches: Record<"gujiLater" | "gujiEarlier" | "brazil", NonNullable<By["beanBatch"]>>;
  let grinders: Record<"lab" | "harbor", NonNullable<By["grinder"]>>;
  let baskets: Record<"g18" | "g20", Named>;

  const ALL = [
    "left-house-1",
    "left-house-2",
    "left-decaf",
    "left-none",
    "left-cleaning",
    "right-house-1",
    "right-house-2",
    "right-decaf",
    "harbor-house-1",
    "harbor-house-2",
    "pending",
  ];

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
    // Named in two cases. The database's collation (en_US.utf8) orders these ignoring case without lower() too: the
    // Grinders' EK43 and ek43, two of one model ordered by id, are what show the order ignoring case.
    left = await api.createMachine("bar Left");
    right = await api.createMachine("Bar Right");
    harbor1 = await api.createMachine("Harbor 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[left, lab], [right, lab], [harbor1, harbor]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    const stored = (machine: CreatedMachine, serial: string, shots: Fields[]) => tablets.syncing(machine, server, { api: withShots(emptyLibrary(serial), shots) });
    stored(left, LEFT_SERIAL, [
      shotOf("left-house-1", "2026-03-02T15:00:00Z", LEFT_SERIAL, { barista: "Jules", bean: "Guji" }),
      shotOf("left-house-2", "2026-03-02T16:00:00Z", LEFT_SERIAL, { barista: "jules ", bean: "Guji" }, preheatShotFixture()),
      // 2.4 g over its target, and ended by the Machine; its Bean's roaster in another case is another Bean.
      shotOf("left-decaf", "2026-03-02T17:00:00Z", LEFT_SERIAL, { barista: "Ann", roaster: "roux bakehouse", bean: "Guji", actualYield: 38.4, stopReason: "machineEnded" }),
      // It recorded no Barista and no Bean.
      shotOf("left-none", "2026-03-02T18:00:00Z", LEFT_SERIAL, {}, burrsShotFixture()),
      shotOf("left-cleaning", "2026-03-02T19:00:00Z", LEFT_SERIAL, { barista: "   ", bean: "Guji", title: "Clean", type: "cleaning" }),
      // Recorded on hardware no Machine has, which a Pending Machine holds, at no Location: the latest of them all.
      shotOf("pending", "2026-03-04T12:00:00Z", UNKNOWN_SERIAL, { barista: "JULES", bean: "Guji" }),
    ]);
    stored(right, RIGHT_SERIAL, [
      shotOf("right-house-1", "2026-03-02T15:30:00Z", RIGHT_SERIAL, { barista: "\tJULES", bean: "Guji" }),
      shotOf("right-house-2", "2026-03-02T16:30:00Z", RIGHT_SERIAL, { barista: "Ann", bean: "Guji", actualYield: 36.5 }),
      // Its Bean has a roaster and no name, and it recorded no stop reason.
      shotOf("right-decaf", "2026-03-03T15:00:00Z", RIGHT_SERIAL, { barista: "ann", bean: null, stopReason: null }, preheatShotFixture()),
    ]);
    stored(harbor1, HARBOR_SERIAL, [
      shotOf("harbor-house-1", "2026-03-02T01:00:00Z", HARBOR_SERIAL, { barista: "Jules", bean: "Guji" }),
      // Its profile has no title.
      shotOf("harbor-house-2", "2026-03-02T02:00:00Z", HARBOR_SERIAL, { barista: "Kai", roaster: "Monogram", bean: "Guji", title: "" }, preheatShotFixture()),
    ]);
    // Each tablet's plugin indexes its Shots and sends those the server asks for, one at a time.
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === ALL.length);
    await tablets.unloadAll();
    const held = (await api.pendingMachines()).find((waiting) => waiting.serial === UNKNOWN_SERIAL)!;
    pending = { id: held.id, model: held.model, serial: held.serial };

    // The Library, made with no tablet online to write it to. A Recipe and a Grinder belong to a Location, and two of
    // each share a name, but for its case.
    const made = async (path: string, body: Fields) => Object.values(await api.send<Record<string, { id: string }>>("POST", path, body, 201))[0]!.id;
    const guji = await made("/beans", { content: { roaster: "Roux", name: "Guji" } });
    const brazil = await made("/beans", { content: { roaster: "Roux", name: "Brazil" } });
    const batch = async (beanId: string, bean: string, roastDate: string) => ({
      id: await made("/bean-batches", { beanId, content: { roastDate }, locations: [{ locationId: lab.id }, { locationId: harbor.id }] }),
      bean: { id: beanId, roaster: "Roux", name: bean },
      roastDate: expect.stringMatching(new RegExp(`^${roastDate}`)) as unknown as string,
    });
    batches = { gujiEarlier: await batch(guji, "Guji", "2026-02-10"), gujiLater: await batch(guji, "Guji", "2026-02-20"), brazil: await batch(brazil, "Brazil", "2026-02-01") };
    const at = (location: LocationView) => ({ id: location.id, name: location.name });
    const grinder = async (location: LocationView, model: string) => ({ id: await made("/grinders", { locationId: location.id, content: { model } }), model, location: at(location) });
    grinders = { lab: await grinder(lab, "EK43"), harbor: await grinder(harbor, "ek43") };
    const basket = async (name: string) => ({ id: await made("/baskets", { locationId: lab.id, content: { name } }), name });
    baskets = { g18: await basket("18 g"), g20: await basket("20 g") };
    const recipe = async (location: LocationView, name: string) => ({ id: await made("/recipes", { locationId: location.id, content: { name } }), name, location: at(location) });
    recipes = { labHouse: await recipe(lab, "House"), decaf: await recipe(lab, "decaf"), harborHouse: await recipe(harbor, "House") };

    // Each Shot's links, as its tablet's map would resolve the ids it names, and the Recipes each Machine had loaded.
    const links: Record<string, { recipe?: Named; batch?: { id: string }; grinder?: { id: string }; basket?: Named }> = {
      "left-house-1": { recipe: recipes.labHouse, batch: batches.gujiLater, grinder: grinders.lab, basket: baskets.g18 },
      "left-house-2": { recipe: recipes.labHouse, batch: batches.gujiLater, grinder: grinders.lab, basket: baskets.g18 },
      "left-decaf": { recipe: recipes.decaf, batch: batches.brazil, grinder: grinders.lab, basket: baskets.g20 },
      // Its Workflow still named House, an hour after its Machine unloaded it.
      "left-none": { recipe: recipes.labHouse },
      "right-house-1": { recipe: recipes.labHouse, batch: batches.gujiEarlier, grinder: grinders.lab, basket: baskets.g18 },
      "right-house-2": { recipe: recipes.labHouse, batch: batches.gujiEarlier, grinder: grinders.lab, basket: baskets.g18 },
      "right-decaf": { recipe: recipes.decaf, batch: batches.brazil, basket: baskets.g20 },
      "harbor-house-1": { recipe: recipes.harborHouse, batch: batches.gujiLater, grinder: grinders.harbor, basket: baskets.g18 },
      "harbor-house-2": { recipe: recipes.harborHouse, grinder: grinders.harbor },
      // It names a Recipe too, and no Machine has it.
      pending: { recipe: recipes.labHouse },
    };
    const loaded: [CreatedMachine, Named, string, string | null][] = [
      [left, recipes.labHouse, "2026-03-02T14:00:00Z", "2026-03-02T16:45:00Z"],
      [left, recipes.decaf, "2026-03-02T16:45:00Z", "2026-03-02T17:30:00Z"],
      [right, recipes.labHouse, "2026-03-02T15:00:00Z", "2026-03-03T14:00:00Z"],
      [right, recipes.decaf, "2026-03-03T14:00:00Z", null],
      [harbor1, recipes.harborHouse, "2026-03-01T00:00:00Z", null],
    ];
    const database = await server.connectDatabase();
    try {
      for (const [id, link] of Object.entries(links)) {
        await database.query("UPDATE shots SET recipe_id = $2, library_batch_id = $3, library_grinder_id = $4, library_basket_id = $5 WHERE id = $1", [
          id,
          link.recipe?.id ?? null,
          link.batch?.id ?? null,
          link.grinder?.id ?? null,
          link.basket?.id ?? null,
        ]);
      }
      for (const [machine, recipe, loadedAt, unloadedAt] of loaded) {
        await database.query("INSERT INTO loaded_recipes (machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, $3, $4)", [machine.machine.id, recipe.id, loadedAt, unloadedAt]);
      }
    } finally {
      await database.end();
    }
  });
  afterAll(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await tablets.unloadAll();
    await server?.stop();
  });

  /** The ids of the Shots the list lists for the filters, in id order. */
  async function listed(query: Record<string, string> = {}, at = api): Promise<string[]> {
    const { shots, total } = await at.get<{ shots: { id: string }[]; total: number }>(`/shots?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(shots).toHaveLength(total);
    return shots.map((shot) => shot.id).sort();
  }

  /** The summary the REST API gives for the query, each number to the microgram or microsecond, clear of the last bit of its arithmetic. */
  async function summary(query: Record<string, string> = {}, at = api): Promise<Summary> {
    const read = await at.get<Summary>(`/shots/summary?${new URLSearchParams(query)}`);
    const exact = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);
    const exactNumber = ({ shots, median, p25, p75 }: SummaryNumber) => ({ shots, median: exact(median), p25: exact(p25), p75: exact(p75) });
    return {
      ...read,
      groups: read.groups.map(({ numbers, ...group }) => ({
        ...group,
        numbers: {
          yieldAgainstTarget: exactNumber(numbers.yieldAgainstTarget),
          duration: exactNumber(numbers.duration),
          stoppedOnWeight: { shots: numbers.stoppedOnWeight.shots, share: exact(numbers.stoppedOnWeight.share) },
        },
      })),
    };
  }

  /** What each group of a grouping is grouped by, with the Shots the filters it opens as find, in the groups' order; every group, 100 a page. */
  async function groupsOf(groupBy: string, query: Record<string, string> = {}): Promise<{ by: By; shots: string[] }[]> {
    const { groups, total } = await summary({ ...query, groupBy, limit: "100" });
    expect(groups).toHaveLength(total);
    return Promise.all(groups.map(async ({ by }) => ({ by, shots: await listed({ ...query, ...filtersOf(by) }) })));
  }

  it("groups by Machine, a Pending Machine's Shots a group too, with each group's counts and numbers", async () => {
    const machine = (created: CreatedMachine) => ({ machine: { id: created.machine.id, name: created.machine.name }, pendingMachine: null });
    expect(await summary({ groupBy: "machine" })).toEqual({
      // By name, ignoring case, and then the Pending Machine, which has none.
      groups: [
        {
          by: machine(left),
          // All but its cleaning Shot.
          counts: { shots: 4, cleaningAndCalibration: 1 },
          numbers: {
            // −6, −1.3, −0.1 and 2.4: the median halfway from −1.3 to −0.1, the 25th percentile three quarters of the way from −6
            // to −1.3, and the 75th a quarter of the way from −0.1 to 2.4.
            yieldAgainstTarget: number(4, -0.7, -2.475, 0.525),
            // 4.095, two of 23.549 and 25.833.
            duration: number(4, 23.549, 18.6855, 24.12),
            // All but the one its Machine ended.
            stoppedOnWeight: { shots: 4, share: 0.75 },
          },
        },
        {
          by: machine(right),
          counts: { shots: 3, cleaningAndCalibration: 0 },
          numbers: {
            // −1.3, −0.1 and 0.5, and two of 23.549 and 25.833; one recorded no stop reason.
            yieldAgainstTarget: number(3, -0.1, -0.7, 0.2),
            duration: number(3, 23.549, 23.549, 24.691),
            stoppedOnWeight: { shots: 2, share: 1 },
          },
        },
        { by: machine(harbor1), counts: { shots: 2, cleaningAndCalibration: 0 }, numbers: ESPRESSO_AND_PREHEAT },
        { by: { machine: null, pendingMachine: pending }, counts: { shots: 1, cleaningAndCalibration: 0 }, numbers: ONE_ESPRESSO },
      ],
      total: 4,
      limit: 20,
      offset: 0,
    });
  });

  it("groups by two at once, ordered by the first and then the second, and pages by group", async () => {
    const by = (recipe: By["recipe"], created: CreatedMachine | null) => ({
      recipe,
      ...(created ? { machine: { id: created.machine.id, name: created.machine.name }, pendingMachine: null } : { machine: null, pendingMachine: pending }),
    });
    // Recipes by name, ignoring case: decaf, then the two named House, by their ids, and last the Shots pulled with
    // none; within each, its Machines.
    const labHouse: Group[] = [
      { by: by(recipes.labHouse, left), counts: { shots: 2, cleaningAndCalibration: 0 }, numbers: ESPRESSO_AND_PREHEAT },
      // −0.1 and 0.5, and 23.549 s twice.
      {
        by: by(recipes.labHouse, right),
        counts: { shots: 2, cleaningAndCalibration: 0 },
        numbers: { yieldAgainstTarget: number(2, 0.2, 0.05, 0.35), duration: number(2, 23.549), stoppedOnWeight: { shots: 2, share: 1 } },
      },
    ];
    const harborHouse: Group[] = [{ by: by(recipes.harborHouse, harbor1), counts: { shots: 2, cleaningAndCalibration: 0 }, numbers: ESPRESSO_AND_PREHEAT }];
    const groups: Group[] = [
      // 2.4 g over, ended by its Machine.
      { by: by(recipes.decaf, left), counts: { shots: 1, cleaningAndCalibration: 0 }, numbers: { yieldAgainstTarget: number(1, 2.4), duration: number(1, 23.549), stoppedOnWeight: { shots: 1, share: 0 } } },
      // It recorded no stop reason.
      { by: by(recipes.decaf, right), counts: { shots: 1, cleaningAndCalibration: 0 }, numbers: { yieldAgainstTarget: number(1, -1.3), duration: number(1, 25.833), stoppedOnWeight: { shots: 0, share: null } } },
      ...(recipes.labHouse.id < recipes.harborHouse.id ? [...labHouse, ...harborHouse] : [...harborHouse, ...labHouse]),
      // The Shot pulled an hour after its Machine unloaded the Recipe it names, 6 g under, and the cleaning Shot.
      { by: by(null, left), counts: { shots: 1, cleaningAndCalibration: 1 }, numbers: { yieldAgainstTarget: number(1, -6), duration: number(1, 4.095), stoppedOnWeight: { shots: 1, share: 1 } } },
      { by: by(null, null), counts: { shots: 1, cleaningAndCalibration: 0 }, numbers: ONE_ESPRESSO },
    ];
    expect(await summary({ groupBy: "recipe,machine" })).toEqual({ groups, total: 7, limit: 20, offset: 0 });
    // The other way round, each Machine's Recipes: the same groups, in the Machines' order.
    const [decafLeft, decafRight, , , , noneLeft, nonePending] = groups;
    const byMachine = [decafLeft!, labHouse[0]!, noneLeft!, decafRight!, labHouse[1]!, harborHouse[0]!, nonePending!];
    expect((await summary({ groupBy: "machine,recipe" })).groups).toEqual(byMachine.map(({ by: { recipe, ...credit }, ...group }) => ({ by: { ...credit, recipe }, ...group })));
    // What a group is grouped by reads in the groupings' order.
    expect(Object.keys((await summary({ groupBy: "machine,recipe" })).groups[0]!.by)).toEqual(["machine", "pendingMachine", "recipe"]);

    // A page is a number of groups, with how many there are, as a list's.
    expect(await summary({ groupBy: "recipe,machine", limit: "3" })).toEqual({ groups: groups.slice(0, 3), total: 7, limit: 3, offset: 0 });
    expect(await summary({ groupBy: "recipe,machine", limit: "3", offset: "3" })).toEqual({ groups: groups.slice(3, 6), total: 7, limit: 3, offset: 3 });
    expect(await summary({ groupBy: "recipe,machine", limit: "3", offset: "6" })).toEqual({ groups: groups.slice(6), total: 7, limit: 3, offset: 6 });
    expect(await summary({ groupBy: "recipe,machine", limit: "3", offset: "7" })).toEqual({ groups: [], total: 7, limit: 3, offset: 7 });

    // Filters narrow the Shots grouped: the Lab's, on 2 March there, are neither the Harbor's nor right-decaf.
    const narrowed = await summary({ groupBy: "recipe,machine", locationId: lab.id, from: "2026-03-02", to: "2026-03-02" });
    expect(narrowed).toEqual({ groups: [decafLeft, ...labHouse, noneLeft], total: 4, limit: 20, offset: 0 });
    // And a group there is only for Shots found.
    expect(await summary({ groupBy: "recipe,machine", barista: "Nobody" })).toEqual({ groups: [], total: 0, limit: 20, offset: 0 });
  });

  it("gives one group without a grouping, there even where the filters find no Shot", async () => {
    const all = await summary();
    expect(all).toMatchObject({ groups: [{ by: {}, counts: { shots: 10, cleaningAndCalibration: 1 } }], total: 1, limit: 20, offset: 0 });
    expect(await summary({ offset: "1" })).toEqual({ groups: [], total: 1, limit: 20, offset: 1 });
    expect(await summary({ barista: "Nobody" })).toMatchObject({ groups: [{ by: {}, counts: { shots: 0, cleaningAndCalibration: 0 } }], total: 1 });
  });

  it("groups by each grouping, in its order, its group of Shots with none last, every group opening as the list's filter that finds its Shots", async () => {
    const machine = (created: CreatedMachine) => ({ machine: { id: created.machine.id, name: created.machine.name }, pendingMachine: null });
    const expected: Record<(typeof GROUPINGS)[number], { by: By; shots: string[] }[]> = {
      location: [
        { by: { location: { id: harbor.id, name: "Harbor" } }, shots: ["harbor-house-1", "harbor-house-2"] },
        { by: { location: { id: lab.id, name: "Lab" } }, shots: ["left-cleaning", "left-decaf", "left-house-1", "left-house-2", "left-none", "right-decaf", "right-house-1", "right-house-2"] },
        // The Pending Machine's, at no Location.
        { by: { location: null }, shots: ["pending"] },
      ],
      // No Shot is without one: a Pending Machine's are its group, after the Machines.
      machine: [
        { by: machine(left), shots: ["left-cleaning", "left-decaf", "left-house-1", "left-house-2", "left-none"] },
        { by: machine(right), shots: ["right-decaf", "right-house-1", "right-house-2"] },
        { by: machine(harbor1), shots: ["harbor-house-1", "harbor-house-2"] },
        { by: { machine: null, pendingMachine: pending }, shots: ["pending"] },
      ],
      recipe: [
        { by: { recipe: recipes.decaf }, shots: ["left-decaf", "right-decaf"] },
        // Two of one name: by their ids.
        ...[
          { by: { recipe: recipes.labHouse }, shots: ["left-house-1", "left-house-2", "right-house-1", "right-house-2"] },
          { by: { recipe: recipes.harborHouse }, shots: ["harbor-house-1", "harbor-house-2"] },
        ].sort((a, b) => a.by.recipe.id.localeCompare(b.by.recipe.id)),
        { by: { recipe: null }, shots: ["left-cleaning", "left-none", "pending"] },
      ],
      // By roaster, then name, each ignoring case, a Bean with no name after its roaster's others: only what the Shots
      // recorded, so a roaster in another case is another Bean, the database's collation putting the lower case first.
      bean: [
        { by: { bean: { roaster: "Monogram", name: "Guji" } }, shots: ["harbor-house-2"] },
        { by: { bean: { roaster: "roux bakehouse", name: "Guji" } }, shots: ["left-decaf"] },
        { by: { bean: { roaster: "Roux Bakehouse", name: "Guji" } }, shots: ["harbor-house-1", "left-cleaning", "left-house-1", "left-house-2", "pending", "right-house-1", "right-house-2"] },
        { by: { bean: { roaster: "Roux Bakehouse", name: null } }, shots: ["right-decaf"] },
        { by: { bean: null }, shots: ["left-none"] },
      ],
      // As the Bean Batches list orders them: by Bean, then the latest roast first.
      beanBatch: [
        { by: { beanBatch: batches.brazil }, shots: ["left-decaf", "right-decaf"] },
        { by: { beanBatch: batches.gujiLater }, shots: ["harbor-house-1", "left-house-1", "left-house-2"] },
        { by: { beanBatch: batches.gujiEarlier }, shots: ["right-house-1", "right-house-2"] },
        { by: { beanBatch: null }, shots: ["harbor-house-2", "left-cleaning", "left-none", "pending"] },
      ],
      profile: [
        { by: { profile: "Adaptive v3" }, shots: ["left-house-2", "right-decaf"] },
        { by: { profile: "Clean" }, shots: ["left-cleaning"] },
        { by: { profile: "Default" }, shots: ["left-none"] },
        { by: { profile: "Londonium" }, shots: ["harbor-house-1", "left-decaf", "left-house-1", "pending", "right-house-1", "right-house-2"] },
        { by: { profile: null }, shots: ["harbor-house-2"] },
      ],
      // Two of one model, ignoring case: by their ids.
      grinder: [
        ...[
          { by: { grinder: grinders.lab }, shots: ["left-decaf", "left-house-1", "left-house-2", "right-house-1", "right-house-2"] },
          { by: { grinder: grinders.harbor }, shots: ["harbor-house-1", "harbor-house-2"] },
        ].sort((a, b) => a.by.grinder.id.localeCompare(b.by.grinder.id)),
        { by: { grinder: null }, shots: ["left-cleaning", "left-none", "pending", "right-decaf"] },
      ],
      basket: [
        { by: { basket: baskets.g18 }, shots: ["harbor-house-1", "left-house-1", "left-house-2", "right-house-1", "right-house-2"] },
        { by: { basket: baskets.g20 }, shots: ["left-decaf", "right-decaf"] },
        { by: { basket: null }, shots: ["harbor-house-2", "left-cleaning", "left-none", "pending"] },
      ],
      // Each Barista once, whatever the case of the name and the blanks around it, by its most recent spelling: the
      // pending Shot's, and right-decaf's. A blank name is none.
      barista: [
        { by: { barista: "ann" }, shots: ["left-decaf", "right-decaf", "right-house-2"] },
        { by: { barista: "JULES" }, shots: ["harbor-house-1", "left-house-1", "left-house-2", "pending", "right-house-1"] },
        { by: { barista: "Kai" }, shots: ["harbor-house-2"] },
        { by: { barista: null }, shots: ["left-cleaning", "left-none"] },
      ],
    };
    for (const grouping of GROUPINGS) {
      expect(await groupsOf(grouping), grouping).toEqual(expected[grouping]);
      // Every Shot is in one group.
      expect(expected[grouping].flatMap((group) => group.shots).sort(), grouping).toEqual([...ALL].sort());
      // A group's counts and numbers are the summary's of the Shots its filters find.
      for (const group of (await summary({ groupBy: grouping })).groups) {
        const [alone] = (await summary(filtersOf(group.by))).groups;
        expect({ counts: group.counts, numbers: group.numbers }, JSON.stringify(group.by)).toEqual({ counts: alone!.counts, numbers: alone!.numbers });
      }
    }
  });

  it("opens every group of two groupings as both their filters, within the list's own filters", async () => {
    // Every pair of groupings, each first once, over the Lab's Shots.
    const atLab = { locationId: lab.id };
    const labShots = await listed(atLab);
    expect(labShots).toHaveLength(8);
    for (const [n, first] of GROUPINGS.entries()) {
      const second = GROUPINGS[(n + 4) % GROUPINGS.length]!;
      const groups = await groupsOf(`${first},${second}`, atLab);
      expect(groups.flatMap((group) => group.shots).sort(), `${first},${second}`).toEqual(labShots);
      for (const group of groups) expect(group.shots.length, `${first},${second}: ${JSON.stringify(group.by)}`).toBeGreaterThan(0);
      // Ordered by the first grouping, as that grouping alone orders its groups.
      const firsts = (await groupsOf(first, atLab)).map((group) => JSON.stringify(group.by));
      const ofFirst = (by: By) => JSON.stringify(Object.fromEntries(Object.entries(by).filter(([name]) => name === first || (first === "machine" && name === "pendingMachine"))));
      const order = groups.map((group) => firsts.indexOf(ofFirst(group.by)));
      expect(order.every((at) => at >= 0), `${first},${second}`).toBe(true);
      expect(order, `${first},${second}`).toEqual([...order].sort((a, b) => a - b));
    }
  });

  it("finds every spelling of a Barista by any of them, and gives each Barista once in the filter's choices, a blank name as none", async () => {
    const jules = ["harbor-house-1", "left-house-1", "left-house-2", "pending", "right-house-1"];
    // Whatever the case and the blanks around it.
    for (const barista of ["Jules", "jules", "JULES", "  jUlEs\t"]) expect(await listed({ barista }), JSON.stringify(barista)).toEqual(jules);
    // The whole name, as before: not a part of it.
    expect(await listed({ barista: "Jul" })).toEqual([]);
    expect(await listed({ barista: "ANN" })).toEqual(["left-decaf", "right-decaf", "right-house-2"]);
    // An empty or a blank one finds the Shots that recorded none, or a blank one.
    for (const barista of ["", "   ", " \t"]) expect(await listed({ barista }), JSON.stringify(barista)).toEqual(["left-cleaning", "left-none"]);
    // By words, as before, each anywhere: and one of no words finds those that recorded a blank name too.
    expect(await listed({ barista: "jul", match: "words" })).toEqual(jules);
    expect(await listed({ barista: " ", match: "words" })).toEqual(["left-cleaning", "left-none"]);
    // The other text filters are as they were: case and all.
    expect(await listed({ coffeeRoaster: "roux bakehouse", coffeeName: "Guji" })).toEqual(["left-decaf"]);
    expect(await listed({ profileTitle: "londonium" })).toEqual([]);

    // Each Barista once, by its most recent spelling, in the names' order, ignoring case; then none.
    const options = await api.get<{ baristas: (string | null)[]; profiles: (string | null)[] }>("/shots/filters");
    expect(options.baristas).toEqual(["ann", "JULES", "Kai", null]);
    expect(options.profiles).toEqual(["Adaptive v3", "Clean", "Default", "Londonium", null]);
    // And each choice finds the Barista's Shots, as its group's does.
    expect(await listed({ barista: "ann" })).toEqual(["left-decaf", "right-decaf", "right-house-2"]);

    // A later Shot names Kai another way, with blanks around it: the Barista is named as it spells it, without them.
    const raw = await RawConnection.welcomed(server.url, helloWith(harbor1.token, { machine: { model: "DE1Pro", serial: HARBOR_SERIAL } }));
    raws.push(raw);
    const later = shotOf("harbor-later", "2026-03-05T01:00:00Z", HARBOR_SERIAL, { barista: " KAI ", bean: "Guji" });
    await raw.deliver({ type: "shot", id: randomUUID(), shotId: later.id, shot: later });
    expect((await api.get<{ baristas: (string | null)[] }>("/shots/filters")).baristas).toEqual(["ann", "JULES", "KAI", null]);
    expect((await groupsOf("barista")).find((group) => group.by.barista === "KAI")).toEqual({ by: { barista: "KAI" }, shots: ["harbor-house-2", "harbor-later"] });
    // By one name wherever it is given: in a summary of Shots that hold only its earlier spelling too.
    expect((await groupsOf("barista", { to: "2026-03-03" })).map((group) => group.by.barista)).toEqual(["ann", "JULES", "KAI", null]);
  });

  it("refuses a grouping it doesn't have, more than two, one twice and a page it doesn't take, and is read by Staff and Viewers", async () => {
    const refusal = async (query: string) => {
      const response = await api.call("GET", `/shots/summary?${query}`);
      return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
    };
    const groupings = "Enter groupBy as one or two of location, machine, recipe, bean, beanBatch, profile, grinder, basket and barista, separated by a comma";
    for (const query of ["groupBy=roaster", "groupBy=", "groupBy=recipe,", "groupBy=Recipe", "groupBy=recipe,machine,barista", "groupBy=recipe%20machine"]) {
      expect(await refusal(query), query).toEqual({ status: 400, message: groupings });
    }
    expect(await refusal("groupBy=recipe,recipe")).toEqual({ status: 400, message: "Give each grouping once" });
    expect(await refusal("groupBy=recipe&groupBy=machine")).toEqual({ status: 400, message: ["Give groupBy once"] });
    expect(await refusal("groupBy=recipe&limit=0")).toMatchObject({ status: 400 });
    expect(await refusal("groupBy=recipe&limit=101")).toMatchObject({ status: 400 });
    // The filters' problems, as the list gives them.
    expect(await refusal("groupBy=recipe&from=2026-02-30")).toMatchObject({ status: 400, message: [expect.stringContaining("Enter from as a date")] });

    const staff = await api.staffAt("sam-468@example.com", harbor);
    const { link } = await api.invite("val-468@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Val Viewer", password: "val's password" }));
    // Staff read every Location's groups, as they read every Shot.
    for (const reader of [staff, viewer]) {
      expect(await summary({ groupBy: "location,barista" }, reader)).toEqual(await summary({ groupBy: "location,barista" }));
    }
    expect((await api.call("GET", "/shots/summary?groupBy=machine", undefined, {})).status).toBe(401);
  });

  it("leaves out a dismissed Pending Machine's group, and names a Barista by the listed Shots alone", async () => {
    await api.send("POST", `/pending-machines/${pending.id}/dismiss`);
    const groups = await groupsOf("machine");
    expect(groups.map((group) => group.by.machine?.name ?? null)).toEqual(["bar Left", "Bar Right", "Harbor 1"]);
    expect((await summary({ groupBy: "location" })).groups.map((group) => group.by.location?.name ?? null)).toEqual(["Harbor", "Lab"]);
    // The most recent spelling among the Shots still listed is left-house-2's, without the blank after it.
    expect((await groupsOf("barista")).map((group) => group.by.barista)).toEqual(["ann", "jules", "KAI", null]);
    expect((await api.get<{ baristas: (string | null)[] }>("/shots/filters")).baristas).toEqual(["ann", "jules", "KAI", null]);
  });
});
