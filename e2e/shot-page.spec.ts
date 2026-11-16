import { type Browser, type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { preheatShotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet, settingsFor } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { type Fields, type JudgedShots, LEFT, ZONE_NAME, at, emptyLibrary, seedJudgedShots, shotOf } from "./support/judged-shots.js";
import { field, openCard, rows } from "./support/locators.js";
import { signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// A Shot's page (#546), as an Admin, at a desktop's width and at a phone's:
// its title, naming its Recipe and Machine; How it went, with its duration
// against its Recipe's Reference Shot's and its yield against its target,
// marked where out of spec, how it stopped in words, and its rating and
// note, edited there; its curves, drawn over the Reference Shot's when the
// page opens, with the two Shots side by side under them; and everything
// else once each, in cards closed until opened.
//
// The Locations, Machines, Recipes and Shots are those of
// support/judged-shots.ts, which describes them: the House's Reference Shot
// is left-house-1, of 23.549 s, the Decaf has none, and some Shots were
// pulled with no Recipe. One more is pulled here, on the Lab's Left, of the
// House: FAST, the Shot Decaid recorded with a long Preheat, cut off 20.03 s
// into its profile, weighing 35.9 g, so 3.5 s under the reference, which is
// out of spec, and 0.1 g under its target, which is within. And the Guest is
// given a long name.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const FAST = "left-house-fast";
/** What the Guest is renamed to here: a name with nowhere to break, wider than a phone. */
const LONG_NAME = "Guest".padEnd(64, "o");

let machines: JudgedShots["machines"];
let recipes: JudgedShots["recipes"];

/** A phone as wide as the ticket's: 390 px. */
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** The widths the page is read at. */
const WIDTHS = [
  ["at a desktop's width", undefined],
  ["on a phone", PHONE],
] as const;

const CHARTS = ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"];

test.beforeEach(({ page }) => signInAsAdmin(page));

for (const [width, phone] of WIDTHS) {
  test(`${width}, the title names the Shot's Recipe and Machine, each linked, over when it was pulled and its Location, a Shot pulled with no Recipe says so, and its cards come in the order a reader asks`, async ({
    page,
    browser,
  }) => {
    // The first of the file's tests seeds what the rest read.
    if (!phone) await seed(page);
    await view(page, browser, phone, async (shown) => {
      await shown.goto(`/shots/${FAST}`);
      const title = shown.getByRole("heading", { level: 1 });
      await expect(title).toHaveText("House on Lab Left");
      await expect(title.getByRole("link", { name: "House" })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
      await expect(title.getByRole("link", { name: "Lab Left" })).toHaveAttribute("href", `/machines/${machines.left.id}`);
      await expect(shown.getByText(new RegExp(`^\\w{3} \\d+, \\d{4}, 1:11 AM ${ZONE_NAME.replace("+", "\\+")} · Lab$`))).toBeVisible();
      await expect(shown.getByRole("button", { name: "Make it a Reference Shot" })).toBeVisible();
      // How it went, then its curves, then everything else, closed.
      await expect
        .poll(() => shown.getByRole("main").getByRole("region").evaluateAll((regions) => regions.map((region) => region.getAttribute("aria-label"))))
        .toEqual(["How it went", "Curves", "Details", "Measurements", "Rating and note edits", "Record as sent"]);
      for (const closed of ["Details", "Measurements", "Rating and note edits", "Record as sent"]) {
        await expect(shown.getByRole("region", { name: closed, exact: true }).getByRole("button", { name: `Show ${closed}`, exact: true })).toBeVisible();
      }
      await expectFits(shown, phone);

      await shown.goto("/shots/left-none");
      await expect(title).toHaveText("No Recipe loaded on Lab Left");
      await expect(title.getByRole("link")).toHaveText(["Lab Left"]);
      await expectFits(shown, phone);

      // A long name with nowhere to break wraps within the page.
      await shown.goto("/shots/right-guest");
      await expect(title).toHaveText(`${LONG_NAME} on Lab Right`);
      await expectFits(shown, phone);
    });
  });

  test(`${width}, How it went marks a duration out of spec against the Reference Shot's, gives a yield within spec against its target muted, and says how the Shot stopped in words`, async ({
    page,
    browser,
  }) => {
    await view(page, browser, phone, async (shown) => {
      // 20.03 s against the reference's 23.549 s: more than 10% under. 35.9 g of its 36 g: within 5%.
      await shown.goto(`/shots/${FAST}`);
      const went = shown.getByRole("region", { name: "How it went" });
      await expect(field(went, "Duration")).toHaveText("20.0 s");
      await expect(mark(went)).toHaveText(["Out of spec: −3.5 s vs reference"]);
      await expect(field(went, "Yield")).toHaveText("35.9 g");
      await expect(went.getByText("−0.1 g vs its 36 g target", { exact: true })).toHaveClass(/text-muted-foreground/);
      await expect(field(went, "Dose")).toHaveText("16 g");
      await expect(went.getByText("target 16 g", { exact: true })).toBeVisible();
      await expect(field(went, "Stopped")).toHaveText("At its target weight");

      // The Decaf has no Reference Shot, which its duration says, leading to its rated Shots; it weighed 2.5 g over its
      // 36 g, which is marked; and its Machine ended it.
      await shown.goto("/shots/left-decaf");
      await expect(field(went, "Duration")).toHaveText("23.5 s");
      await expect(went.getByRole("link", { name: "No reference" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}&rating=rated`);
      await expect(mark(went)).toHaveText(["Out of spec: +2.5 g vs its 36 g target"]);
      await expect(field(went, "Stopped")).toHaveText("Ended by the Machine");

      // The House's Reference Shot says it is that, and one pulled with no Recipe says nothing of a reference.
      await shown.goto("/shots/left-house-1");
      await expect(went.getByText("Its Recipe's Reference Shot", { exact: true })).toBeVisible();
      await expect(mark(went)).toHaveCount(0);
      await shown.goto("/shots/left-none");
      await expect(field(went, "Duration")).toHaveText("23.5 s");
      await expect(went.getByText(/reference/i)).toHaveCount(0);

      // An Unfinished Shot and a cleaning Shot say what they are, and carry no mark.
      await shown.goto("/shots/left-house-unfinished");
      await expect(went.getByText("Unfinished Shot", { exact: true })).toBeVisible();
      await expectTip(went, "Unfinished Shot", /^Nothing poured: its Machine never reached pouring and its scale never read a gram\./);
      await expect(field(went, "Duration")).toHaveText(/^\d+\.\d s$/);
      await expect(mark(went)).toHaveCount(0);
      await expect(went.getByText(/reference/i)).toHaveCount(0);
      await shown.goto("/shots/left-cleaning");
      await expect(went.getByText("Cleaning or calibration Shot", { exact: true })).toBeVisible();
      await expect(mark(went)).toHaveCount(0);

      if (!phone) return;
      // On a phone the figures are two to a row, and its rating and note a row of their own under them.
      await shown.goto(`/shots/${FAST}`);
      const [duration, yielded, dose, stopped, rating] = await Promise.all(
        ["Duration", "Yield", "Dose", "Stopped", "Rating"].map(async (term) => (await went.locator("dt", { hasText: new RegExp(`^${term}$`) }).boundingBox())!),
      );
      expect(yielded!.y).toBe(duration!.y);
      expect(yielded!.x).toBeGreaterThan(duration!.x);
      expect(dose!.y).toBeGreaterThan(duration!.y);
      expect([dose!.x, stopped!.y]).toEqual([duration!.x, dose!.y]);
      expect(rating!.y).toBeGreaterThan(dose!.y);
      await expectFits(shown, phone);
    });
  });

  test(`${width}, the curves open drawn over the Recipe's Reference Shot's, with the two Shots side by side under them, and over nothing for a Shot whose Recipe has none and for the Reference Shot itself`, async ({
    page,
    browser,
  }) => {
    await view(page, browser, phone, async (shown) => {
      await shown.goto(`/shots/${FAST}`);
      const curves = shown.getByRole("region", { name: "Curves" });
      // One control, offering what the Shot has: its Recipe's Reference Shot, chosen as the page opens, the Shot
      // before it on its Machine, and nothing.
      const choice = curves.getByRole("radiogroup", { name: "Compare with" });
      await expect(choice.getByRole("radio")).toHaveText(["Reference Shot", "Previous Shot on this Machine", "Nothing"]);
      await expect(choice.getByRole("radio", { name: "Reference Shot" })).toBeChecked();
      for (const name of CHARTS) await expect(curves.getByRole("figure", { name, exact: true })).toContainText("Reference Shot");
      // Under them, the two side by side, the Reference Shot linked.
      expect(await compared(curves, "Comparison with the Reference Shot", phone)).toEqual([
        ["This Shot", "20.0 s", "35.9 g", "7.9 s", "8.01 bar", "6.50"],
        ["Reference Shot", "23.5 s", "35.9 g", "21.4 s", "9 bar", "8"],
      ]);
      await expect(comparison(curves, "Comparison with the Reference Shot", phone).getByRole("link", { name: "Reference Shot" })).toHaveAttribute("href", "/shots/left-house-1");
      await expectFits(shown, phone);

      // The Shot before it on its Machine instead, one at a time, and then nothing.
      await choice.getByRole("radio", { name: "Previous Shot on this Machine" }).click();
      for (const name of CHARTS) await expect(curves.getByRole("figure", { name, exact: true })).toContainText("Previous Shot");
      await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Reference Shot");
      expect(await compared(curves, "Comparison with the previous Shot", phone)).toEqual([
        ["This Shot", "20.0 s", "35.9 g", "7.9 s", "8.01 bar", "6.50"],
        ["Previous Shot", "25.8 s", "34.7 g", "7.9 s", "8.01 bar", "6.50"],
      ]);
      await expect(comparison(curves, "Comparison with the previous Shot", phone).getByRole("link", { name: "Previous Shot" })).toHaveAttribute("href", "/shots/left-house-2");
      await expect(comparison(curves, "Comparison with the Reference Shot", phone)).toHaveCount(0);
      // Pressing the one chosen leaves it chosen.
      await choice.getByRole("radio", { name: "Previous Shot on this Machine" }).click();
      await expect(choice.getByRole("radio", { name: "Previous Shot on this Machine" })).toBeChecked();
      await choice.getByRole("radio", { name: "Nothing" }).click();
      await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Previous Shot");
      await expect(comparison(curves, "Comparison with the previous Shot", phone)).toHaveCount(0);

      // The Decaf has no Reference Shot: its Shot opens compared with nothing, and is offered the Shot before it.
      await shown.goto("/shots/left-decaf");
      await expect(choice.getByRole("radio")).toHaveText(["Previous Shot on this Machine", "Nothing"]);
      await expect(choice.getByRole("radio", { name: "Nothing" })).toBeChecked();
      await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).toContainText("This Shot");
      await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Previous Shot");
      await expect(curves.getByRole("table")).toHaveCount(0);

      // The House's Reference Shot itself, the first Shot on its Machine, has nothing to be compared with.
      await shown.goto("/shots/left-house-1");
      await expect(curves.getByText("There is no earlier Shot on Lab Left to compare it with.")).toBeVisible();
      await expect(choice).toHaveCount(0);
      await expect(curves.getByRole("figure", { name: "Pressure", exact: true })).not.toContainText("Reference Shot");

      if (!phone) return;
      // On a phone the control scrolls within its own row, under the card's title, and the charts are one to a row.
      await shown.goto(`/shots/${FAST}`);
      await expect(choice.getByRole("radio", { name: "Reference Shot" })).toBeChecked();
      const row = choice.locator("xpath=..");
      expect(await row.evaluate((scrolled) => scrolled.scrollWidth > scrolled.clientWidth)).toBe(true);
      expect((await row.boundingBox())!.y).toBeGreaterThan((await curves.getByRole("heading", { name: "Curves" }).boundingBox())!.y + 10);
      // Its last choice is past the row's end until the row is scrolled to it.
      await expect(choice.getByRole("radio", { name: "Nothing" })).not.toBeInViewport({ ratio: 0.95 });
      await choice.getByRole("radio", { name: "Nothing" }).scrollIntoViewIfNeeded();
      await expect(choice.getByRole("radio", { name: "Nothing" })).toBeInViewport({ ratio: 0.95 });
      const lefts = await curves.getByRole("figure").evaluateAll((figures) => figures.map((figure) => figure.getBoundingClientRect().left));
      expect(lefts).toHaveLength(5);
      expect(new Set(lefts).size).toBe(1);
      await expectFits(shown, phone);
    });
  });

  test(`${width}, a rating and note are edited from How it went, which says where the edit stands with the Shot's tablet`, async ({ page, browser }) => {
    // Rated at a desktop's width, and its note written on a phone. Its tablet is off.
    const [before, stars, note] = phone ? (["4 stars", "4 stars", "Fast, and thin."] as const) : (["Unrated", "4 stars", "No note"] as const);
    await view(page, browser, phone, async (shown) => {
      await shown.goto(`/shots/${FAST}`);
      const went = shown.getByRole("region", { name: "How it went" });
      await expect(field(went, "Rating")).toHaveText(before);
      await expect(field(went, "Note")).toHaveText("No note");
      await expectTip(went, "Rating and note", /^How the Shot was judged\. The rating is up to 5 stars/);
      await went.getByRole("button", { name: "Edit its rating and note" }).click();
      const form = went.getByRole("form", { name: "Edit its rating and note" });
      if (phone) await form.getByLabel("Note").fill("Fast, and thin.");
      else await form.getByRole("radio", { name: "4 stars" }).click();
      await expectFits(shown, phone);
      await form.getByRole("button", { name: "Save" }).click();
      await expect(form).toHaveCount(0);
      await expect(field(went, "Rating")).toHaveText(stars);
      await expect(field(went, "Note")).toHaveText(note);
      await expect(went.getByRole("status", { name: "Edits and the tablet" })).toHaveText("Awaiting its tablet");
      // The figures beside them are as they were.
      await expect(field(went, "Duration")).toHaveText("20.0 s");
      await expectFits(shown, phone);
    });
  });

  test(`${width}, Details is closed until opened, and then gives every other fact once, as its other cards are, with no raw id`, async ({ page, browser }) => {
    await view(page, browser, phone, async (shown) => {
      await shown.goto(`/shots/${FAST}`);
      const details = shown.getByRole("region", { name: "Details", exact: true });
      await expect(details.getByRole("term")).toHaveCount(0);
      await expectTip(details, "Details", /^What it was pulled with and what its Machine and scale measured, as recorded on its tablet\. A Recipe Slot is the one its Recipe is in now\. Times on this page are in Lab's time zone, /);
      await openCard(shown, "Details");
      // What it was pulled with, each once, a dash for the Barista it recorded none of; then what was measured and set.
      await expect(details.getByRole("term")).toHaveText([
        "Recipe",
        "Profile",
        "Bean",
        "Bean Batch",
        "Grinder",
        "Basket",
        "Barista",
        "Burrs",
        "Brew temperature",
        "Peak pressure",
        "Peak flow",
        "Time to first drip",
        "Last weight recorded",
        "Flow at the stop",
        "Steam",
        "Hot water",
        "Flush",
        "Machine, as recorded",
      ]);
      // Its Recipe, linked, with the Recipe Slot it is in.
      await expect(field(details, "Recipe")).toHaveText("House (slot 2)");
      await expect(field(details, "Recipe").getByRole("link", { name: "House" })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
      await expect(field(details, "Bean")).toHaveText("Roux Bakehouse · Ethiopia Generic 100g Sample");
      // Its tablet named its Bean Batch by an id the Library has none for: not linked, and no id shown.
      await expect(field(details, "Bean Batch")).toHaveText("Not linked");
      await expect(field(details, "Grinder")).toHaveText("DF64 v2 at 6.50");
      await expect(field(details, "Burrs")).toHaveText("SSP MP");
      await expect(field(details, "Basket")).toHaveText("Decent 18g Ridgeless");
      await expect(field(details, "Barista")).toHaveText("-");
      await expect(field(details, "Time to first drip")).toHaveText("7.9 s");
      await expect(field(details, "Flush")).toHaveText(/^\d+ °C, \d+ s$/);
      await expect(field(details, "Machine, as recorded")).toHaveText(`DE1Pro, serial ${LEFT}, firmware 1358, flow calibration 1.2`);
      // No tablet's id for an item, and none of Decaid's own names for what the interface names.
      await expect(details).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-|bskt-|Rinse|captured/);
      // Each fact is on the page once: no term of How it went or Details comes twice.
      const terms = [...(await shown.getByRole("region", { name: "How it went" }).getByRole("term").allTextContents()), ...(await details.getByRole("term").allTextContents())];
      expect(terms).toHaveLength(24);
      expect(new Set(terms).size).toBe(terms.length);
      await expectFits(shown, phone);

      // Its measurements and its record as sent, each in a card of its own, closed until opened.
      const measurements = await openCard(shown, "Measurements");
      await expect(rows(measurements.getByRole("table", { name: "Measurements" }))).toHaveCount(140);
      await measurements.getByRole("button", { name: "Hide Measurements" }).click();
      const sent = await openCard(shown, "Record as sent");
      await expect(sent.locator("pre")).toContainText('"stopReason": "targetWeight"');
      await expectFits(shown, phone);
    });
  });
}

/**
 * Seeds the judged Shots, then has the Lab's Left's tablet backfill FAST, pulled with the House a minute after
 * left-house-2, and leaves that tablet off, so an edit made here awaits it.
 */
async function seed(page: Page) {
  ({ machines, recipes } = await seedJudgedShots(page, server));
  const fixture = preheatShotFixture();
  const fast: Fields = shotOf(FAST, at(0, 1, 11), LEFT, { actualYield: 35.9 }, { ...fixture, measurements: (fixture.measurements as Fields[]).slice(0, 140) });
  const tablet = SimulatedTablet.load({ settings: settingsFor({ serverUrl: server.url(), token: machines.left.token }), api: withShots(emptyLibrary(LEFT), [fast]), timeScale: 50 });
  await expect.poll(async () => (await page.request.get(`/api/shots/${FAST}`)).status(), { timeout: 30_000 }).toBe(200);
  // Its Recipe is set once its tablet is unloaded, as the seed sets the others', so nothing the tablet sends later undoes it.
  await tablet.unload();
  expect((await page.request.patch(`/api/recipes/${recipes.guest}`, { data: { content: { name: LONG_NAME } } })).status()).toBe(200);
  const database = await server.connectDatabase();
  try {
    await database.query("UPDATE shots SET recipe_id = $2 WHERE id = $1", [FAST, recipes.house]);
  } finally {
    await database.end();
  }
}

/** Runs `work` on the test's own page, or, for a phone, on a page of a phone's width signed in as the Admin. */
async function view(page: Page, browser: Browser, phone: BrowserContextOptions | undefined, work: (shown: Page) => Promise<void>) {
  if (!phone) return work(page);
  const context = await browser.newContext({ baseURL: server.url(), ...phone });
  try {
    const shown = await context.newPage();
    await signInAsAdmin(shown);
    await work(shown);
  } finally {
    await context.close();
  }
}

/** The comparison under the curves: a table on a wide screen, and a list of the two Shots on a phone. */
function comparison(curves: Locator, name: string, phone: BrowserContextOptions | undefined): Locator {
  return curves.getByRole(phone ? "list" : "table", { name });
}

/** Each compared Shot's name and numbers, in the comparison's order: its duration, yield, time to first drip, peak pressure and grind setting. */
async function compared(curves: Locator, name: string, phone: BrowserContextOptions | undefined): Promise<string[][]> {
  const shown = comparison(curves, name, phone);
  await expect(shown).toBeVisible();
  if (!phone) {
    await expect(shown.getByRole("columnheader")).toHaveText(["", "Duration", "Yield", "Time to first drip", "Peak pressure", "Grind setting"]);
    return Promise.all((await rows(shown).all()).map(async (row) => [await row.getByRole("rowheader").innerText(), ...(await row.getByRole("cell").allInnerTexts())]));
  }
  await expect(shown.getByRole("listitem").first().getByRole("term")).toHaveText(["Duration", "Yield", "First drip", "Peak pressure", "Grind"]);
  return Promise.all((await shown.getByRole("listitem").all()).map(async (item) => [await item.locator("> span").innerText(), ...(await item.getByRole("definition").allInnerTexts())]));
}

/** What is marked within `scope`: each out-of-spec mark (web/src/components/spec-mark.tsx). */
function mark(scope: Locator): Locator {
  return scope.locator('[data-slot="spec-mark"]');
}

/** On a phone, the page is no wider than its screen. */
async function expectFits(page: Page, phone: BrowserContextOptions | undefined) {
  if (!phone) return;
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: 390, clientWidth: 390 });
}
