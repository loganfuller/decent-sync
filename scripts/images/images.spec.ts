// The README's and the documentation site's images, captured raw into SCREENSHOT_DIR: run it through
// `npm run readme-images` or `npm run site-images`, which also encode them (README.md beside this file). It is not one
// of the e2e specs: on a pull request that changes the management interface, CI captures the page stills raw and
// checks what the Live View GIF and the phone need without recording them (`LIVE_CHECK=1 node scripts/images/run.mjs
// --raw`), and the site's deploy runs `npm run site-images`. stills.ts names every image; each is captured here.
// Seeds a fresh test server with made-up Locations, Machines, Library and Shots through simulated tablets running the
// built plugin. Each Shot's curves are a real recording, anonymized: Shots from real Machines reduced to their physics
// (sample-shots.json, written by sample.mjs) and the repo's de1pro-v0.9.0/shot-preheat fixture. Names, serials, times
// and the rest are made up.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";
import { liveFixture, openingFrames } from "../../server/test/support/live-fixtures.js";
import { syncingTablet } from "../../server/test/support/loaded-tablets.js";
import { preheatShotFixture } from "../../server/test/support/shot-fixtures.js";
import { type DecaidApi, NO_DYE2_LISTS, type SimulatedTablet, derivedDe1Pro } from "../../server/test/support/simulated-tablet.js";
import { SimulatedDye2, openDye2Dashboard } from "../../server/test/support/simulated-dye2.js";
import { useFreshServer } from "../../e2e/support/fresh-server.js";
import { createLocation, signInAsAdmin } from "../../e2e/support/seed.js";
import { GIF_HEIGHT, GIF_WIDTH, type StillName, THEMES } from "./stills.js";
import { afternoonZone, offsetHours } from "./zone.js";

if (!process.env.SCREENSHOT_DIR) throw new Error("Set SCREENSHOT_DIR, or run this through `npm run readme-images`");
const OUT = process.env.SCREENSHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });
const server = useFreshServer();
test.setTimeout(900_000);

/** The latest Shot's time: a quarter of an hour before the run, so today's Shots are the Overview's. */
const ANCHOR = Math.floor((Date.now() - 15 * 60_000) / 60_000) * 60_000;
/**
 * The Locations' and the browser's time zone, and its hours ahead of UTC. The Overview and the Recipe page show each
 * Location's own today, so it is a zone where the latest Shot falls in the afternoon (zone.ts), unless
 * SCREENSHOT_ZONE names one.
 */
const ZONE = process.env.SCREENSHOT_ZONE ?? afternoonZone(ANCHOR);
const ZONE_HOURS = offsetHours(ZONE, ANCHOR);
test.use({ timezoneId: ZONE, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const ROASTER = "Lantern Coffee Roasters";
/** A date as the zone has it, some days before the latest Shot: roast dates keep their distance from it. */
const daysBefore = (d: number) => new Date(ANCHOR + ZONE_HOURS * 3_600_000 - d * 86_400_000).toISOString().slice(0, 10);
const hoursBefore = (h: number) => new Date(ANCHOR - h * 3_600_000);
/** A time as the tablet's local time without an offset, as Decaid writes it. */
const local = (ms: number) => new Date(ms + ZONE_HOURS * 3_600_000).toISOString().slice(0, -1);

interface Source {
  profile: Record<string, any>;
  steamSettings?: unknown;
  hotWaterData?: unknown;
  rinseData?: unknown;
  stopReason: string | null;
  actualDoseWeight: number;
  actualYield: number;
  targetDoseWeight: number;
  targetYield: number;
  measurements: any[];
}

const fixture = preheatShotFixture() as Record<string, any>;
const preheat: Source = {
  profile: fixture.workflow.profile,
  steamSettings: fixture.workflow.steamSettings,
  hotWaterData: fixture.workflow.hotWaterData,
  rinseData: fixture.workflow.rinseData,
  stopReason: fixture.stopReason,
  actualDoseWeight: 16,
  actualYield: 34.7,
  targetDoseWeight: 16,
  targetYield: 36,
  measurements: fixture.measurements,
};
/** The anonymized Shots, the committed sample unless SAMPLE_SHOTS names a fresh one. */
const sample: Source[] = JSON.parse(fs.readFileSync(process.env.SAMPLE_SHOTS ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "sample-shots.json"), "utf8"));

// Every tablet's profiles: Decaid's bundled Adaptive v3, Londonium and TurboBloom, and the sampled Shots' profiles.
const bundled = derivedDe1Pro({})["/profiles"] as Record<string, any>[];
const template = bundled.find((p) => p.profile.title === "Best practice (light roast)")!;
const sampleProfiles = [...new Map(sample.map((s) => [s.profile.title as string, s.profile])).values()];
const PROFILES: Record<string, any>[] = [
  ...bundled.filter((p) => ["Adaptive v3", "Londonium", "TurboBloom"].includes(p.profile.title)),
  ...sampleProfiles.map((profile, i) => ({ ...template, id: `profile:5e0c1a77e1d5a0b0c0d${i}`, isDefault: false, metadata: { source: "user" }, profile })),
];
const profileIdOnTablet = (title: string) => PROFILES.find((p) => p.profile.title === title)!.id as string;

interface Placed {
  id: string;
  at: Date;
  source: Source;
  k?: number;
  /** The duration, in seconds, to stretch the recording to, as the server counts it (after the Preheat): instead of `k`. */
  seconds?: number;
  bean: string;
  roastDate: string;
  barista: string;
  grinder: string;
  setting: string;
  basket: string;
  recipe?: string;
  /** Decaid's rating, 0 to 10: two points a star. */
  rating?: number;
}

/** A recording's duration as the server counts it: from its first sample after the Preheat (`preparingForShot`) to its last. */
function durationOf(source: Source): number {
  const samples = source.measurements;
  const t = (sample: any) => Date.parse(sample.machine.timestamp + "Z");
  const first = samples.findIndex((sample) => sample.machine.state?.substate !== "preparingForShot");
  return (t(samples.at(-1)) - t(samples[first])) / 1000;
}

/** The Shot as the tablet records it, naming the tablet's own records of what it used. `updatedAt` must be UTC with a Z, or the server ignores it. */
function shotOn(tablet: SimulatedTablet, serial: string, model: string, spec: Placed): Record<string, unknown> {
  const { source } = spec;
  const k = spec.seconds !== undefined ? spec.seconds / durationOf(source) : (spec.k ?? 1);
  const samples = structuredClone(source.measurements);
  const t = (iso: string) => Date.parse(iso + "Z");
  const t0 = t(samples[0].machine.timestamp);
  const start = spec.at.getTime();
  const shift = (iso: string) => local(start + (t(iso) - t0) * k);
  for (const sample of samples) {
    sample.machine.timestamp = shift(sample.machine.timestamp);
    sample.machine.flow = sample.machine.flow / k;
    if (sample.scale) {
      sample.scale.timestamp = shift(sample.scale.timestamp);
      sample.scale.weightFlow = sample.scale.weightFlow / k;
    }
  }
  const beanId = tablet.beans().find((b) => b.name === spec.bean)?.id;
  const batchId = tablet.batches().find((b) => b.beanId === beanId && String(b.roastDate).startsWith(spec.roastDate))?.id;
  const grinderId = tablet.grinders().find((g) => g.model === spec.grinder)?.id;
  const basketId = ((tablet.storeValue("dye2.reaplugin", "baskets") as any[]) ?? []).find((b) => b.name === spec.basket)?.id;
  const recipeId = spec.recipe ? ((tablet.storeValue("dye2.reaplugin", "recipes") as any[]) ?? []).find((r) => r.name === spec.recipe)?.id : undefined;
  if (!batchId || !grinderId || !basketId || (spec.recipe && !recipeId)) throw new Error(`${spec.id}: not on the tablet yet`);
  const done = new Date(start + 40_000).toISOString();
  return {
    id: spec.id,
    timestamp: spec.at.toISOString(),
    createdAt: done,
    updatedAt: done,
    measurements: samples,
    workflow: {
      id: `workflow-${spec.id}`,
      name: "Workflow",
      description: "",
      profile: source.profile,
      steamSettings: source.steamSettings ?? fixture.workflow.steamSettings,
      hotWaterData: source.hotWaterData ?? fixture.workflow.hotWaterData,
      rinseData: source.rinseData ?? fixture.workflow.rinseData,
      machine: { provenanceStatus: "captured", flowCalibration: 1.2, serialNumber: serial, model, firmwareVersion: "1358" },
      context: {
        targetDoseWeight: source.targetDoseWeight,
        targetYield: source.targetYield,
        grinderId,
        grinderModel: spec.grinder,
        grinderSetting: spec.setting,
        beanBatchId: batchId,
        coffeeName: spec.bean,
        coffeeRoaster: ROASTER,
        baristaName: spec.barista,
        drinkerName: "",
        finalBeverageType: "espresso",
        extras: {
          basketId,
          basketName: spec.basket,
          workflowSkin: { selectedProfileId: profileIdOnTablet(source.profile.title) },
          ...(recipeId ? { dye: { recipeId } } : {}),
        },
      },
    },
    annotations: { actualDoseWeight: source.actualDoseWeight, actualYield: source.actualYield, ...(spec.rating ? { enjoyment: spec.rating } : {}), extras: {} },
    stopReason: source.stopReason,
  };
}

/** A tablet's Decaid with no library of its own but these profiles, set up to pull the given coffee next. */
function tabletApi(serial: string, model: string, next: { bean: string; barista: string; grinder: string; setting: string; dose: number }): DecaidApi {
  const api = derivedDe1Pro({ serial, model }) as Record<string, any>;
  const workflow = structuredClone(api["/workflow"]);
  const context = { ...workflow.context };
  delete context.grinderId;
  delete context.beanBatchId;
  workflow.context = {
    ...context,
    targetDoseWeight: next.dose,
    targetYield: Math.round(next.dose * 2.2),
    coffeeRoaster: ROASTER,
    coffeeName: next.bean,
    baristaName: next.barista,
    drinkerName: "",
    grinderModel: next.grinder,
    grinderSetting: next.setting,
    extras: { ...context.extras, basketId: undefined, basketName: undefined },
  };
  return { ...api, ...NO_DYE2_LISTS, "/workflow": workflow, "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": PROFILES };
}

async function post<T>(page: Page, url: string, data: unknown): Promise<T> {
  const response = await page.request.post(url, { data });
  expect(response.status(), `${url}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

interface Machine {
  id: string;
  serial: string;
  model: string;
  tablet: SimulatedTablet;
}

/** A Machine at the Location since long before its Shots, and its tablet connected, running DYE2. */
async function adopt(page: Page, name: string, locationId: string, serial: string, model: string, next: Parameters<typeof tabletApi>[2]): Promise<Machine> {
  const { machine, token } = await post<{ machine: { id: string }; token: string }>(page, "/api/machines", { name });
  await post(page, `/api/machines/${machine.id}/location-history`, { locationId, effectiveFrom: "2025-06-01T00:00:00Z" });
  const tablet = syncingTablet({ token }, { url: server.url() }, { api: tabletApi(serial, model, next), sockets: { ...openingFrames(), scale: "connected" }, dye2: new SimulatedDye2() });
  await tablet.waitForLog(/^Connected to /);
  return { id: machine.id, serial, model, tablet };
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("decent-sync-theme", value), theme);
}

/** The Machine's page, once its Live View stream is answered. */
async function openLive(page: Page, machineId: string) {
  const opened = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/machines/${machineId}/live`);
  await page.goto(`/machines/${machineId}`);
  await opened;
  await page.waitForTimeout(1500);
}

test("README and site images", async ({ page }) => {
  console.log(`Capturing in ${ZONE}, UTC${ZONE_HOURS < 0 ? "" : "+"}${ZONE_HOURS}`);
  await signInAsAdmin(page);
  const lab = await createLocation(page, "Roastery Lab", ZONE);
  const downtown = await createLocation(page, "Downtown", ZONE);
  const riverside = await createLocation(page, "Riverside", ZONE);

  const E65 = "Mahlkönig E65S";
  const DF = "DF64 v2";
  const ATOM = "Eureka Atom 75";
  const BASKET = "Decent 18g Ridgeless";

  const barLeft = await adopt(page, "Bar Left", downtown.id, "41001", "DE1Pro", { bean: "House Espresso", barista: "Maya", grinder: E65, setting: "2.4", dose: 20 });
  const barRight = await adopt(page, "Bar Right", downtown.id, "41002", "DE1Pro", { bean: "Ethiopia Guji Natural", barista: "Priya", grinder: E65, setting: "2.1", dose: 20 });
  const river = await adopt(page, "Riverside", riverside.id, "41003", "DE1XL", { bean: "Kenya Nyeri AA", barista: "Sam", grinder: ATOM, setting: "3.0", dose: 20 });
  const labMachine = await adopt(page, "Lab", lab.id, "41004", "DE1Pro", { bean: "Colombia Huila", barista: "Jonah", grinder: DF, setting: "11.0", dose: 18 });

  // The Library, as an Admin enters it.
  const bean = async (name: string, extra: Record<string, unknown> = {}) =>
    (await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: ROASTER, name, ...extra } })).bean.id;
  // Created at its first Location, as a batch is at one, and added at each other with its weight there. Each has its Batch Code, as on
  // its label, which every page names it by (#732).
  const batch = async (beanId: string, batchCode: string, roastDate: string, weight: number, [[locationId, remainingWeight], ...added]: [[string, number], ...[string, number][]]) => {
    const { id } = (await post<{ batch: { id: string } }>(page, "/api/bean-batches", { beanId, content: { roastDate, batchCode, weight, roastLevel: "Medium" }, locations: [{ locationId, remainingWeight }] })).batch;
    for (const [addedAt, weightThere] of added) {
      expect((await page.request.put(`/api/bean-batches/${id}/locations/${addedAt}`, { data: { atLocation: true, remainingWeight: weightThere } })).status()).toBe(200);
    }
    return id;
  };
  const house = await bean("House Espresso", { notes: "Chocolate, hazelnut, ripe plum" });
  const guji = await bean("Ethiopia Guji Natural", { country: "Ethiopia", region: "Guji", processing: "Natural", altitude: [2100] });
  const kenya = await bean("Kenya Nyeri AA", { country: "Kenya", region: "Nyeri", processing: "Washed" });
  const huila = await bean("Colombia Huila", { country: "Colombia", region: "Huila", processing: "Washed" });
  const cerrado = await bean("Brazil Cerrado", { country: "Brazil", region: "Cerrado", processing: "Natural" });
  const decaf = await bean("Decaf Colombia", { country: "Colombia", decaf: true, decafProcess: "Sugarcane" });
  const houseNow = await batch(house, "LR-0411", daysBefore(5), 5000, [[downtown.id, 3240], [riverside.id, 1850]]);
  await batch(house, "LR-0405", daysBefore(12), 5000, [[downtown.id, 410]]);
  const gujiNow = await batch(guji, "LR-0412", daysBefore(4), 2000, [[lab.id, 1460], [downtown.id, 920]]);
  await batch(kenya, "LR-0408", daysBefore(8), 2000, [[riverside.id, 1120], [lab.id, 650]]);
  await batch(huila, "LR-0413", daysBefore(3), 2500, [[lab.id, 2380]]);
  await batch(cerrado, "LR-0406", daysBefore(10), 2000, [[riverside.id, 720]]);
  const decafNow = await batch(decaf, "LR-0407", daysBefore(9), 2000, [[downtown.id, 600], [riverside.id, 450]]);

  const grinder = async (locationId: string, model: string) => (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId, content: { model } })).grinder.id;
  const e65 = await grinder(downtown.id, E65);
  await grinder(lab.id, DF);
  await grinder(riverside.id, ATOM);
  // A Basket's name is unique in the Library: one, shown at each Location.
  const downtownBasket = (await post<{ basket: { id: string } }>(page, "/api/baskets", { locationId: downtown.id, content: { name: BASKET } })).basket.id;
  for (const elsewhere of [lab.id, riverside.id]) {
    const shown = await page.request.put(`/api/baskets/${downtownBasket}/locations/${elsewhere}`, { data: { shown: true } });
    expect(shown.status(), await shown.text()).toBe(200);
  }

  // The Profiles the tablets brought, once they are in the Library.
  let profiles: { id: string; title: string }[] = [];
  await expect
    .poll(async () => {
      const listed = (await (await page.request.get("/api/profiles")).json()) as { profiles: { id: string; title?: string; content?: { title?: string } }[] };
      profiles = listed.profiles.map((p) => ({ id: p.id, title: p.title ?? p.content?.title ?? "" }));
      return profiles.length;
    }, { timeout: 60_000 })
    .toBeGreaterThanOrEqual(PROFILES.length);
  const profile = (title: string) => profiles.find((p) => p.title === title)?.id ?? null;
  const recipe = (slot: number, content: Record<string, unknown>) => post(page, "/api/recipes", { locationId: downtown.id, slot, content });
  await recipe(1, { name: "House Espresso", beanBatchId: houseNow, profileId: profile("Gentle and sweet"), dose: 20, yield: 44, grinderId: e65, grindSetting: "2.4", basketId: downtownBasket });
  await recipe(2, { name: "Guji Espresso", beanBatchId: gujiNow, profileId: profile("Best practice (light roast)"), dose: 20, yield: 46, grinderId: e65, grindSetting: "2.1", basketId: downtownBasket });
  await recipe(3, { name: "House Ristretto", beanBatchId: houseNow, profileId: profile("Londonium"), dose: 20, yield: 30, grinderId: e65, grindSetting: "2.2", basketId: downtownBasket });
  await recipe(4, { name: "Decaf", beanBatchId: decafNow, profileId: profile("Adaptive v3"), dose: 18, yield: 38, grinderId: e65, grindSetting: "2.8", basketId: downtownBasket });

  // Each bar has a Recipe loaded, applied in DYE2's dashboard.
  for (const [machine, name] of [[barLeft, "House Espresso"], [barRight, "Guji Espresso"]] as const) {
    let id: string | undefined;
    await expect
      .poll(() => (id = ((machine.tablet.storeValue("dye2.reaplugin", "recipes") as any[]) ?? []).find((r) => r.name === name)?.id), { timeout: 60_000 })
      .toBeTruthy();
    const applied = await (await openDye2Dashboard(machine.tablet)).applyRecipe(id!);
    expect(applied.workflow?.status).toBe(200);
  }

  // Shots, once each tablet holds what they name. The committed sample: 0-3 Best practice (light roast), 4 and 6-8
  // Gentle and sweet, 5 Baseline 6 bar (each Decaid's bundled profile). A new sample needs these indexes rechecked.
  const HOUSE = { bean: "House Espresso", roastDate: daysBefore(5) };
  const GUJI = { bean: "Ethiopia Guji Natural", roastDate: daysBefore(4) };
  const KENYA = { bean: "Kenya Nyeri AA", roastDate: daysBefore(8) };
  const HUILA = { bean: "Colombia Huila", roastDate: daysBefore(3) };
  const CERRADO = { bean: "Brazil Cerrado", roastDate: daysBefore(10) };
  const DECAF = { bean: "Decaf Colombia", roastDate: daysBefore(9) };
  const at = (machine: Machine, grinderModel: string) => ({ machine, grinder: grinderModel, basket: BASKET });
  const placed: (Placed & { machine: Machine })[] = [
    { ...at(barLeft, E65), id: "bl-1", at: hoursBefore(0), source: sample[4]!, ...HOUSE, barista: "Maya", setting: "2.4", recipe: "House Espresso", rating: 8 },
    { ...at(barLeft, E65), id: "bl-2", at: hoursBefore(0.3), source: sample[6]!, ...HOUSE, barista: "Maya", setting: "2.5", recipe: "House Espresso" },
    { ...at(barLeft, E65), id: "bl-3", at: hoursBefore(1.8), source: sample[0]!, seconds: 24.9, ...GUJI, barista: "Theo", setting: "2.1", recipe: "Guji Espresso" },
    { ...at(barLeft, E65), id: "bl-4", at: hoursBefore(24.6), source: sample[6]!, k: 0.98, ...HOUSE, barista: "Theo", setting: "2.4", recipe: "House Espresso", rating: 10 },
    { ...at(barLeft, E65), id: "bl-5", at: hoursBefore(26.1), source: preheat, ...DECAF, barista: "Maya", setting: "2.8", recipe: "Decaf" },
    // Bar Right's last Shot is of the Guji it has loaded.
    { ...at(barRight, E65), id: "br-1", at: hoursBefore(0.15), source: sample[2]!, seconds: 28.2, ...GUJI, barista: "Priya", setting: "2.1", recipe: "Guji Espresso" },
    { ...at(barRight, E65), id: "br-2", at: hoursBefore(1.0), source: sample[6]!, seconds: 28.6, ...HOUSE, barista: "Priya", setting: "2.3", recipe: "House Espresso" },
    { ...at(barRight, E65), id: "br-3", at: hoursBefore(2.6), source: sample[4]!, seconds: 29.4, ...HOUSE, barista: "Theo", setting: "2.4", recipe: "House Espresso" },
    { ...at(barRight, E65), id: "br-4", at: hoursBefore(25.3), source: preheat, k: 0.95, ...DECAF, barista: "Priya", setting: "2.8", recipe: "Decaf" },
    { ...at(river, ATOM), id: "rv-1", at: hoursBefore(0.6), source: sample[2]!, ...KENYA, barista: "Sam", setting: "3.0" },
    { ...at(river, ATOM), id: "rv-2", at: hoursBefore(2.3), source: sample[6]!, k: 0.97, ...HOUSE, barista: "Sam", setting: "2.9" },
    { ...at(river, ATOM), id: "rv-3", at: hoursBefore(27.0), source: preheat, k: 1.05, ...CERRADO, barista: "Jonah", setting: "3.3" },
    { ...at(labMachine, DF), id: "lb-1", at: hoursBefore(3.5), source: sample[5]!, ...HUILA, barista: "Jonah", setting: "11.0" },
    { ...at(labMachine, DF), id: "lb-2", at: hoursBefore(3.8), source: sample[5]!, k: 0.92, ...HUILA, barista: "Jonah", setting: "11.5" },
    { ...at(labMachine, DF), id: "lb-3", at: hoursBefore(4.1), source: sample[3]!, ...GUJI, barista: "Jonah", setting: "8.2" },
    { ...at(labMachine, DF), id: "lb-4", at: hoursBefore(28.0), source: preheat, k: 1.1, ...KENYA, barista: "Jonah", setting: "8.0" },
  ];
  // More of today at Downtown, so the Overview's cells and the Recipe page's numbers rest on several Shots each: the
  // same recordings, each stretched to a duration of its own, all before the latest on each bar. The durations make
  // the Overview's marks (v1.11.0, #543), against House Espresso's Reference Shot, bl-4 at 26.1 s, and its margin of
  // 2.6 s: House on Bar Left, 8 Shots, median 27.7 s, +1.6 s, within spec; House on Bar Right, 7 Shots, median 29.1 s,
  // +3.0 s, out of spec, yet 1.4 s from Bar Left, within spec between Machines; Guji, no Reference Shot, 25.1 s on
  // Bar Left and 28.4 s on Bar Right, 3.3 s apart, out of spec between Machines; Decaf too few Shots to judge. The
  // yields are the recordings' own: sample[1]'s +13% and nothing else beyond 5%, so every cell's median is within spec,
  // and every Shot stopped on weight. sample[7], 39 s and +22%, is left out of Downtown's today.
  const more = (machine: Machine, prefix: string, recipe: string, coffee: typeof HOUSE, sources: Source[], setting: string, baristas: string[], hours: number[], seconds: number[]) =>
    hours.forEach((h, i) =>
      placed.push({ ...at(machine, E65), id: `${prefix}-${i + 1}`, at: hoursBefore(h), source: sources[i % sources.length]!, seconds: seconds[i]!, ...coffee, barista: baristas[i % baristas.length]!, setting, recipe }),
    );
  const houseSources = [sample[4]!, sample[6]!, sample[8]!];
  const gujiSources = [sample[0]!, sample[1]!, sample[2]!, sample[3]!];
  more(barLeft, "blh", "House Espresso", HOUSE, houseSources, "2.4", ["Maya", "Theo"], [0.7, 1.2, 1.5, 2.2, 2.9, 3.4], [27.4, 28.1, 26.6, 28.4, 28.0, 29.0]);
  more(barRight, "brh", "House Espresso", HOUSE, houseSources, "2.3", ["Priya", "Theo"], [0.5, 1.4, 2.0, 3.1, 3.6], [29.8, 27.2, 30.2, 29.1, 28.8]);
  more(barLeft, "blg", "Guji Espresso", GUJI, gujiSources, "2.1", ["Theo", "Maya"], [0.9, 2.5, 3.2], [24.6, 25.3, 25.8]);
  more(barRight, "brg", "Guji Espresso", GUJI, gujiSources, "2.1", ["Priya"], [0.8, 1.7, 2.8, 3.3], [28.4, 27.9, 29.0, 28.6]);
  more(barLeft, "bld", "Decaf", DECAF, [preheat], "2.8", ["Maya"], [1.9], [26.1]);
  more(barRight, "brd", "Decaf", DECAF, [preheat], "2.8", ["Priya"], [2.3, 3.8], [25.6, 26.4]);

  // Pulled oldest first, each once its tablet holds what it names.
  for (const spec of [...placed].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    let shot: Record<string, unknown> | undefined;
    await expect
      .poll(() => {
        try {
          shot = shotOn(spec.machine.tablet, spec.machine.serial, spec.machine.model, spec);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 60_000, message: `${spec.id}'s Library on its tablet` })
      .toBe(true);
    spec.machine.tablet.pullShot(shot!);
  }
  await expect
    .poll(async () => ((await (await page.request.get("/api/shots?limit=100")).json()) as { shots: unknown[] }).shots.length, { timeout: 120_000 })
    .toBe(placed.length);
  // A Shot's Recipe is the one it names where its Machine had it loaded as it was pulled. The bars loaded theirs just
  // now, after these Shots' times, so their Loaded Recipes are set in PostgreSQL: each Downtown Recipe on each bar since
  // before its oldest Shot, the loaded one still loaded. Ids below the real entries' keep those the latest.
  const { recipes: downtownRecipes } = (await (await page.request.get(`/api/locations/${downtown.id}/recipes`)).json()) as { recipes: { id: string }[] };
  const database = await server.connectDatabase();
  try {
    const since = hoursBefore(48).toISOString();
    await database.query("UPDATE loaded_recipes SET loaded_at = $1", [since]);
    let id = -1;
    for (const machine of [barLeft, barRight])
      for (const { id: recipeId } of downtownRecipes) {
        const { rowCount } = await database.query("SELECT 1 FROM loaded_recipes WHERE machine_id = $1 AND recipe_id = $2", [machine.id, recipeId]);
        if (!rowCount) await database.query("INSERT INTO loaded_recipes (id, machine_id, recipe_id, loaded_at, unloaded_at) VALUES ($1, $2, $3, $4, now())", [id--, machine.id, recipeId, since]);
      }
  } finally {
    await database.end();
  }
  for (const machine of [barLeft, barRight, river, labMachine]) machine.tablet.reportState("idle", "idle");

  // House Espresso's Reference Shot: yesterday's on Bar Left.
  const { recipes: listed } = (await (await page.request.get(`/api/locations/${downtown.id}/recipes`)).json()) as { recipes: { id: string; name?: string; content?: { name?: string } }[] };
  const houseRecipe = listed.find((r) => (r.name ?? r.content?.name) === "House Espresso")!;
  const chosen = await page.request.put(`/api/recipes/${houseRecipe.id}/reference-shot`, { data: { shotId: "bl-4" } });
  expect(chosen.status(), await chosen.text()).toBe(200);
  await page.waitForTimeout(3000);

  // Stills, each in both themes, cropped to what they show. Each is loaded once, then for each theme reloaded, its
  // content asserted by `ready` and captured: a still whose page no longer shows what it should fails the run.
  type Clip = { x: number; y: number; width: number; height: number };
  interface Capture {
    /** The viewport's height, where the clip runs below 800 px: a clip outside the viewport is cut at its edge. */
    height?: number;
    /** The page's address. */
    url: () => string | Promise<string>;
    /** Waits for the page's content and asserts it, after every reload. */
    ready: () => Promise<void>;
    /** What to capture, once ready. */
    clip: () => Promise<Clip>;
    /** How long to let the page settle after `ready`, in ms. */
    settle?: number;
  }
  const box = async (locator: ReturnType<Page["locator"]>) => (await locator.boundingBox())!;
  /** From the top of the page to just below the locator, the page's whole width. */
  const toBottomOf = (locator: ReturnType<Page["locator"]>) => async (): Promise<Clip> => {
    const { y, height } = await box(locator);
    return { x: 0, y: 0, width: 1280, height: Math.ceil(y + height) + 32 };
  };
  /** From the top of one locator to the bottom of another, the first's width. */
  const spanning = (top: ReturnType<Page["locator"]>, end: ReturnType<Page["locator"]>) => async (): Promise<Clip> => {
    const [from, to] = [await box(top), await box(end)];
    return { x: from.x, y: from.y, width: from.width, height: to.y + to.height - from.y };
  };
  const region = (name: string) => page.getByRole("region", { name, exact: true });
  // The Overview's blocks, read again every 30 s: each block's table and status cards, and no "Loading" left.
  const settled = async (block: ReturnType<Page["locator"]>) => {
    await expect(block.getByRole("rowheader").first()).toBeVisible();
    await expect(block.getByRole("list", { name: /^Machines at / }).getByRole("listitem")).toHaveCount(2);
    await expect(block.getByText("Loading", { exact: true })).toHaveCount(0);
  };
  const shotRows = page.getByRole("table", { name: "Shots" }).getByRole("row").filter({ has: page.getByRole("cell") });

  /**
   * A Draft of Gentle and sweet as a new version, its pour held a bar lower, followed on the Lab's Machine once the
   * Lab is marked for trying Drafts, with one Trial Shot pulled on its steps: its id.
   */
  const triedDraft = async (): Promise<string> => {
    const from = profile("Gentle and sweet")!;
    type Draft = { id: string; title: string; saves: number; profile: { steps: { pump?: string; pressure?: number }[] } };
    const { draft } = await post<{ draft: Draft }>(page, "/api/drafts", { profileId: from, as: "version" });
    const steps = structuredClone(draft.profile.steps);
    const pour = [...steps].reverse().find((step) => step.pump === "pressure" && typeof step.pressure === "number")!;
    pour.pressure = pour.pressure! - 1;
    const saved = await page.request.put(`/api/drafts/${draft.id}`, { data: { profile: { ...draft.profile, steps }, saves: draft.saves } });
    expect(saved.status(), await saved.text()).toBe(200);
    const marked = await page.request.patch(`/api/locations/${lab.id}`, { data: { triesDrafts: true } });
    expect(marked.status(), await marked.text()).toBe(200);
    const followed = await page.request.put(`/api/drafts/${draft.id}/following`, { data: { machineId: labMachine.id } });
    expect(followed.status(), await followed.text()).toBe(200);
    const held = () => labMachine.tablet.workflow().profile as { title?: string } | undefined;
    await expect.poll(() => held()?.title, { timeout: 60_000 }).toBe(`${draft.title} (Draft)`);
    // Pulled now, by the tablet's clock after it was written the Draft, with the Workflow's profile and no recipe.
    const trial = shotOn(labMachine.tablet, labMachine.serial, labMachine.model, { ...at(labMachine, DF), id: "lb-trial", at: new Date(), source: sample[6]!, ...HUILA, barista: "Jonah", setting: "10.5" });
    (trial.workflow as { profile: unknown }).profile = held();
    labMachine.tablet.pullShot(trial);
    return draft.id;
  };
  const machineRows = page.getByRole("table", { name: "Machines" }).getByRole("row").filter({ has: page.getByRole("cell") });

  // The page stills, by their names in stills.ts. A still for a Guide page is one more entry here.
  const captures: Record<Exclude<StillName, "live-view" | "phone">, Capture> = {
    overview: {
      url: () => "/",
      ready: () => settled(region("Downtown")),
      clip: toBottomOf(region("Downtown")),
    },
    // From v1.11.0 the page is its Overview block and its Recipes card: no Machines card.
    location: {
      height: 1600,
      url: () => `/locations/${downtown.id}`,
      ready: async () => {
        await settled(region("Overview"));
        await expect(region("Recipes").getByText("Guji Espresso").first()).toBeVisible();
      },
      clip: toBottomOf(region("Recipes")),
    },
    "bean-batches": {
      url: () => "/library/bean-batches",
      ready: async () => {
        await expect(page.getByRole("table").first().getByText("Colombia Huila").first()).toBeVisible();
        await expect(page.getByText("Loading", { exact: true })).toHaveCount(0);
      },
      clip: toBottomOf(page.getByRole("table").first()),
    },
    shots: {
      url: () => "/shots",
      ready: () => expect(shotRows).toHaveCount(Math.min(25, placed.length)),
      clip: toBottomOf(shotRows.nth(7)),
    },
    // From v1.11.0 the page opens with how the Shot went, over its curves: the still is both cards. It compares bl-1
    // with its Recipe's Reference Shot, whose radio is chosen already.
    shot: {
      height: 2600,
      url: () => "/shots/bl-1",
      ready: async () => {
        await expect(region("Curves").locator(".recharts-line").first()).toBeVisible();
        await expect(page.getByRole("radio", { name: "Reference Shot", exact: true })).toBeChecked();
      },
      clip: spanning(region("How it went"), region("Curves")),
      settle: 2000,
    },
    // The Profile page (#578): House Espresso's Profile, its graph and its steps.
    profile: {
      height: 2000,
      url: async () => {
        const listed = (await (await page.request.get("/api/profiles")).json()) as { profiles: { id: string; title: string | null }[] };
        return `/library/profiles/${encodeURIComponent(listed.profiles.find((each) => each.title === "Gentle and sweet")!.id)}`;
      },
      ready: async () => {
        await expect(region("How it runs").getByRole("figure", { name: /^Simulated run of / })).toBeVisible();
        await expect(page.getByRole("region", { name: "Recipes on this version" }).getByRole("listitem").first()).toBeVisible();
      },
      clip: spanning(region("How it runs"), region("Steps")),
      settle: 1500,
    },
    // The Guide's stills (#685). House Espresso's page: its Reference Shot beside its numbers by Machine.
    recipe: {
      height: 1400,
      url: () => `/library/recipes/${houseRecipe.id}`,
      ready: async () => {
        await expect(region("By Machine").getByRole("row").filter({ hasText: "Bar Right" })).toBeVisible();
        await expect(region("Reference Shot").getByRole("link", { name: "Open its Reference Shot" })).toBeVisible();
      },
      clip: toBottomOf(region("By Machine")),
    },
    machines: {
      url: () => "/machines",
      ready: async () => {
        await expect(machineRows).toHaveCount(4);
        await expect(machineRows.filter({ hasText: "Bar Left" }).getByRole("link", { name: "House Espresso", exact: true })).toBeVisible();
      },
      clip: toBottomOf(page.getByRole("table", { name: "Machines" })),
    },
    // Bar Left's tabs, each as a link to it opens it.
    "machine-activity": {
      height: 1800,
      url: () => `/machines/${barLeft.id}?tab=activity`,
      ready: async () => {
        await expect(region("Use").getByRole("figure").first()).toBeVisible();
        await expect(page.getByRole("table", { name: "Dial-in trail" }).getByRole("row").nth(1)).toBeVisible();
      },
      // Down to the trail's fourth entry: the one under it lists the whole Workflow in effect as the day began.
      clip: async () => {
        const { y, height } = await box(page.getByRole("table", { name: "Dial-in trail" }).getByRole("row").nth(4));
        return { x: 0, y: 0, width: 1280, height: Math.floor(y + height) };
      },
    },
    "machine-settings": {
      height: 1400,
      url: () => `/machines/${barLeft.id}?tab=settings`,
      ready: async () => {
        await expect(region("Settings").getByRole("heading", { name: "Machine Settings" })).toBeVisible();
        await expect(region("Settings").getByText("Fan threshold")).toBeVisible();
        await expect(region("Settings").getByRole("heading", { name: "Tablet Settings" })).toBeVisible();
      },
      // The Machine Settings, down to where the Tablet Settings start.
      clip: async () => ({ x: 0, y: 0, width: 1280, height: Math.floor((await box(region("Settings").getByRole("heading", { name: "Tablet Settings" }))).y) - 16 }),
    },
    "machine-software": {
      height: 3000,
      url: () => `/machines/${barLeft.id}?tab=software`,
      ready: async () => {
        await expect(page.getByRole("table", { name: "Plugins" }).getByRole("row").nth(1)).toBeVisible();
        await expect(page.getByRole("table", { name: "Skins" }).getByRole("row").nth(1)).toBeVisible();
      },
      clip: toBottomOf(region("Skins")),
    },
    // House Espresso's Recipe card (#684): what the Recipe holds.
    "recipe-details": {
      height: 3000,
      url: () => `/library/recipes/${houseRecipe.id}`,
      ready: async () => {
        await expect(region("Recipe").getByText("Gentle and sweet")).toBeVisible();
        await expect(region("Recipe").getByText("Bean Batch", { exact: true })).toBeVisible();
      },
      clip: spanning(region("Recipe"), region("Recipe")),
      settle: 1000,
    },
    "new-profile": {
      height: 1400,
      url: () => "/library/profiles/new",
      ready: async () => {
        await expect(page.getByRole("button", { name: /^Start from / })).toHaveCount(6);
        await expect(page.getByRole("button", { name: "Duplicate", exact: true })).toBeVisible();
      },
      clip: toBottomOf(page.getByRole("button", { name: "Choose a file" })),
      settle: 1500,
    },
    // A Draft of Gentle and sweet, tried at the Lab (#684). It is the last still: the Draft, the Lab's following and
    // its Trial Shot are made here, as its address is asked for, so no other still shows them.
    draft: {
      height: 2600,
      url: async () => `/library/drafts/${await triedDraft()}`,
      ready: async () => {
        await expect(region("On a Machine")).toContainText("The Machine has these steps, since");
        await expect(region("Trial Shots").getByRole("listitem")).toHaveCount(1);
        await expect(region("How it runs")).toContainText("The Trial Shot, as it ran");
        await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
      },
      clip: toBottomOf(region("How it runs")),
      settle: 2000,
    },
  };

  // `STILLS=overview,location` captures only the page stills it names; unset, every one.
  const named = process.env.STILLS?.split(",").map((name) => name.trim());
  for (const name of named ?? []) if (!(name in captures)) throw new Error(`STILLS: ${name} is not one of ${Object.keys(captures).join(", ")}`);
  if (!process.env.SKIP_STILLS) {
    for (const [name, capture] of Object.entries(captures) as [keyof typeof captures, Capture][]) {
      if (named && !named.includes(name)) continue;
      await page.setViewportSize({ width: 1280, height: capture.height ?? 800 });
      await page.goto(await capture.url());
      for (const theme of THEMES) {
        await setTheme(page, theme);
        await page.reload();
        await capture.ready();
        await page.waitForTimeout(capture.settle ?? 2500);
        await page.mouse.move(0, 0);
        await page.screenshot({ path: path.join(OUT, `${name}-${theme}.png`), clip: await capture.clip() });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  // LIVE_CHECK=1 checks what the Live View GIF and the phone need, in place of capturing them: in the light theme only,
  // the shot replayed fast, the same assertions and the GIF's clip measured, then one screenshot of each. No frames
  // are recorded in real time, so nothing is left for ffmpeg. CI's stills job runs it; SKIP_LIVE skips this part.
  const LIVE_CHECK = Boolean(process.env.LIVE_CHECK);
  if (process.env.SKIP_LIVE && !LIVE_CHECK) return;
  const liveThemes = LIVE_CHECK ? (["light"] as const) : THEMES;
  /** How fast to replay the shot where it is not being recorded. */
  const fast = LIVE_CHECK ? 20 : 4;
  // The Live View: a real recorded shot replayed on Bar Left's tablet, its card captured from the Preheat on. A clip
  // outside the viewport is cut at its edge, so the viewport is taller here.
  const frames = liveFixture("shot.json");
  const stateOf = (frame: Record<string, unknown>) => frame.state as { state?: string } | undefined;
  const espresso = frames.findIndex(({ source, frame }) => source === "machine" && stateOf(frame)?.state === "espresso");
  // The recording turns Idle with the cup lifted, the scale far below zero, and the card "Waiting for its Shot",
  // which reads as a bug: the GIF ends on the last frame captured before that (encode.mjs).
  const idle = frames.findIndex(({ source, frame }, i) => i > espresso && source === "machine" && stateOf(frame)?.state === "idle");
  const pouring = frames.findIndex(({ source, frame }) => source === "machine" && (frame.state as { substate?: string } | undefined)?.substate === "pouring");
  const midPour = pouring + Math.round((frames.length - pouring) * 0.45);
  const live = page.getByRole("region", { name: "Live View" });
  await page.goto("/shots");
  await page.setViewportSize({ width: 1280, height: 1400 });
  for (const theme of liveThemes) {
    await setTheme(page, theme);
    await openLive(page, barLeft.id);
    await expect.poll(() => barLeft.tablet.delivered).toContainEqual({ type: "liveStart" });
    // A warm-up shot, so every chart is drawn, to measure the clip: the tiles and the Pressure and Flow charts.
    await barLeft.tablet.replayLive(frames, { speed: fast }).to();
    await expect(live.getByRole("figure", { name: "Weight", exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    const box = (await live.boundingBox())!;
    const weight = (await live.getByRole("figure", { name: "Weight", exact: true }).boundingBox())!;
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.round(weight.y - box.y - 36) };
    // encode.mjs crops the GIF to GIF_HEIGHT once scaled to GIF_WIDTH: a shorter clip would fail it.
    expect(Math.floor((clip.height * GIF_WIDTH) / clip.width), "the Live View clip's height at the GIF's width").toBeGreaterThanOrEqual(GIF_HEIGHT);
    if (LIVE_CHECK) {
      const check = barLeft.tablet.replayLive(frames, { speed: fast });
      await check.to(midPour);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `live-view-check-${theme}.png`), clip });
      // Finished, as the recorded shot is, so the phone starts from the same state as at the deploy.
      await check.to();
      continue;
    }
    const replay = barLeft.tablet.replayLive(frames, { speed: 1 });
    await replay.to(espresso + 2);
    await page.waitForTimeout(300);
    const dir = path.join(OUT, `live-frames-${theme}`);
    fs.mkdirSync(dir, { recursive: true });
    const times: number[] = [];
    let done = false;
    const playing = replay.to().then(() => (done = true));
    const started = Date.now();
    let n = 0;
    while (!done) {
      await page.screenshot({ path: path.join(dir, `${String(n).padStart(4, "0")}.png`), clip });
      times.push(Date.now() - started);
      n++;
    }
    await playing;
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(dir, `${String(n).padStart(4, "0")}.png`), clip });
    times.push(Date.now() - started);
    // Each frame's time, and the recording's turn to Idle, in ms from when the capture started with frame espresso + 2.
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ frameTimesMs: times, idleAtMs: frames[idle]!.ms - frames[espresso + 2]!.ms }));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of liveThemes) {
    await setTheme(page, theme);
    await openLive(page, barLeft.id);
    const replay = barLeft.tablet.replayLive(frames, { speed: LIVE_CHECK ? fast : 1 });
    await replay.to(midPour);
    await expect(live.getByRole("figure", { name: "Weight", exact: true })).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `phone-${theme}.png`) });
    await replay.to();
  }
});
