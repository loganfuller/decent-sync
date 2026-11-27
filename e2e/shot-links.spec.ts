import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { tabletAt } from "./support/tablets.js";
import { signInAsAdmin } from "./support/seed.js";
import { chooseFilter, field, filterChip, openCard, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";
import { roastDay } from "./support/days.js";

// Shots linked to the Library (ticket #92): each Library item's page lists
// the Shots that used it, and the Shots list filters by Bean Batch and by
// Grinder. Simulated tablets running the built plugin, at a lab and a cafe
// sharing a batch, each with a Grinder of its own, pull Shots naming them
// by their own ids.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What each Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

/** The batch the first test's Shots are linked to, for the test of how it is named. */
let linked: { batchId: string } | undefined;

test("a batch's page counts its Shots from both Locations and opens them in the Shots list, as its Bean's does, and the Shots list filters by Bean Batch and by Grinder", async ({ page }) => {
  const lab = await post<{ location: { id: string } }>(page, "/api/locations", { name: "Roastery lab", timeZone: "America/Chicago" });
  const cafe = await post<{ location: { id: string } }>(page, "/api/locations", { name: "Belmont", timeZone: "America/Chicago" });
  const labTablet = await tabletAt(page, server, "Lab group", lab.location.id, "27001", tabletApi);
  const cafeTablet = await tabletAt(page, server, "Belmont 1", cafe.location.id, "27002", tabletApi);
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Roux Bakehouse", name: "Linked Sidra" } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-10-04" },
    locations: [{ locationId: lab.location.id }],
  });
  linked = { batchId: batch.id };
  // Created at the lab, as a batch is at one Location, and added at the cafe.
  expect((await page.request.put(`/api/bean-batches/${batch.id}/locations/${cafe.location.id}`, { data: { atLocation: true } })).status()).toBe(200);
  const labGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: lab.location.id, content: { model: "Lab EK43" } })).grinder;
  const cafeGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: cafe.location.id, content: { model: "Belmont Mythos" } })).grinder;
  const local = (tablet: SimulatedTablet, grinderId: string) => ({
    beanBatchId: tablet.batches().find((record) => globalIdOf(record) === batch.id)?.id,
    grinderId: tablet.grinders().find((record) => globalIdOf(record) === grinderId)?.id,
  });
  await expect.poll(() => Object.values(local(labTablet, labGrinder.id)).every(Boolean)).toBe(true);
  await expect.poll(() => Object.values(local(cafeTablet, cafeGrinder.id)).every(Boolean)).toBe(true);

  labTablet.pullShot(shotWith("lab-linked", "27001", local(labTablet, labGrinder.id), 8));
  cafeTablet.pullShot(shotWith("cafe-linked", "27002", local(cafeTablet, cafeGrinder.id), 7));
  // A Shot naming a batch the Library lacks stays unlinked, and listed.
  labTablet.pullShot(shotWith("lab-unlinked", "27001", { beanBatchId: "a-batch-the-library-lacks" }, 6));
  await expect.poll(async () => ((await (await page.request.get("/api/shots")).json()) as { total: number }).total).toBe(3);

  await page.goto(`/library/bean-batches/${batch.id}`);
  // One line (#547): how many Shots it has, and a link that opens them in the Shots list. The table of them is gone.
  const shots = page.getByRole("region", { name: "Shots" });
  await expect(shots).toHaveText("Shots2 ShotsOpen in the Shots list");
  await expect(shots.getByRole("table")).toHaveCount(0);
  await expectTip(shots, "Shots", "The Shots pulled with this Bean Batch on any Machine. The Shots list lists them, newest first, with their summary and trend.");

  // Its Bean's page counts the same Shots, those of any of its batches, and opens the list by the Bean: a filter the
  // address alone sets, shown as a chip that removes it.
  await page.goto(`/library/beans/${bean.id}`);
  await expect(shots).toHaveText("Shots2 ShotsOpen in the Shots list");
  await shots.getByRole("link", { name: "Open in the Shots list" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?beanId=${bean.id}$`));
  const list = page.getByRole("table", { name: "Shots" });
  await expect(rows(list)).toHaveCount(2);
  await expect(filterChip(page, "Library Bean")).toHaveText("Library Bean:Linked Sidra");
  await page.getByRole("button", { name: "Remove the Library Bean filter" }).click();
  await expect(page).toHaveURL(/\/shots$/);
  await expect(rows(list)).toHaveCount(3);

  // The batch's Shots in the Shots list, filtered by it.
  await page.goto(`/library/bean-batches/${batch.id}`);
  await shots.getByRole("link", { name: "Open in the Shots list" }).click();
  await expect(page).toHaveURL(new RegExp(`/shots\\?beanBatchId=${batch.id}$`));
  await expect(rows(list)).toHaveCount(2);
  await expect(filterChip(page, "Bean Batch")).toHaveText(`Bean Batch:Linked Sidra, roasted ${roastDay("2026-10-04")}`);

  // By Grinder, each Location's own.
  await chooseFilter(page, "Bean Batch", "Any Bean Batch");
  await expect(rows(list)).toHaveCount(3);
  await chooseFilter(page, "Grinder", "Belmont Mythos, Belmont");
  await expect(page).toHaveURL(new RegExp(`grinderId=${cafeGrinder.id}`));
  await expect(rows(list)).toHaveCount(1);
  await expect(list.getByRole("row", { name: /Belmont 1/ })).toBeVisible();

  // Shots linked to no batch.
  await chooseFilter(page, "Grinder", "Any Grinder");
  await chooseFilter(page, "Bean Batch", "Not linked to a Bean Batch");
  await expect(filterChip(page, "Bean Batch")).toHaveText("Bean Batch:Not linked");
  // The list filtered by Grinder also had one Shot, so wait for this one's row before counting.
  const unlinked = list.getByRole("row", { name: /Lab group .* 3 stars Fixture Barista$/ });
  await expect(unlinked).toBeVisible();
  await expect(rows(list)).toHaveCount(1);
  await unlinked.getByRole("link").first().click();
  // Its tablet named a batch by an id the Library has none for: its page says it is not linked, and shows no id.
  const unlinkedDetails = await openCard(page, "Details");
  await expect(field(unlinkedDetails, "Bean Batch")).toHaveText("Not linked");
  await expect(unlinkedDetails).not.toContainText("a-batch-the-library-lacks");

  // A linked Shot's page links to what it used.
  await page.goto("/shots/lab-linked");
  const details = await openCard(page, "Details");
  await expect(field(details, "Grinder").getByRole("link", { name: "Lab EK43" })).toHaveAttribute("href", `/library/grinders/${labGrinder.id}`);
  // The Library's Grinder by its name now, with the model the Shot recorded, which is another, and its grind setting.
  await expect(field(details, "Grinder")).toHaveText("Lab EK43 (recorded as DF64 v2) at 8");
  // Its Bean Batch, which has no Batch Code: its Bean, linked, over its roast day and how long after it the Shot was pulled (#732).
  await expect(field(details, "Bean Batch")).toHaveText(new RegExp(String.raw`^Linked SidraRoasted ${roastDay("2026-10-04")}(, (\d+ days? before this Shot|the day of this Shot))?$`));
  await details.getByRole("link", { name: "Linked Sidra", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Linked Sidra, roasted ${roastDay("2026-10-04")}`, level: 1 })).toBeVisible();
});

test("the Shots list, its Bean Batch filter and a Shot's page name a Shot's batch by its Batch Code, or by its roast date where it has none, and a Shot linked to none reads as before", async ({ page }) => {
  const { batchId } = linked!;
  const list = page.getByRole("table", { name: "Shots" });
  /** A Shot's row, by the Shot its time opens, and what it says under its Recipe. */
  const shotRow = (id: string) => rows(list).filter({ has: page.locator(`a[href="/shots/${id}"]`) });
  const under = (id: string) => shotRow(id).getByRole("cell").nth(2);

  // With no Batch Code: the batch's Bean, linked to the batch, and its roast date, between its profile and its Location, which these Shots,
  // pulled before their Machines came to one, have none of.
  await page.goto("/shots");
  await expect(under("lab-linked")).toHaveText(new RegExp(String.raw` · Linked Sidra, roasted ${roastDay("2026-10-04")} · No Location, times in UTC$`));
  await expect(under("lab-linked").getByRole("link", { name: "Linked Sidra", exact: true })).toHaveAttribute("href", `/library/bean-batches/${batchId}`);
  // A Shot linked to no batch gives its Bean as it recorded it, with no link and no roast date.
  const recorded = String(((shotFixture().workflow as Record_).context as Record_).coffeeName);
  await expect(under("lab-unlinked")).toHaveText(new RegExp(String.raw` · ${recorded} · No Location, times in UTC$`));
  await expect(under("lab-unlinked").getByRole("link")).toHaveCount(0);

  // Given its Batch Code, the row names the batch by it, in plain monospace text, not a chip.
  expect((await page.request.patch(`/api/bean-batches/${batchId}`, { data: { content: { batchCode: "LS-1004" } } })).status()).toBe(200);
  await page.reload();
  await expect(under("lab-linked")).toHaveText(/ · Linked Sidra LS-1004 · No Location, times in UTC$/);
  await expect(under("cafe-linked")).toHaveText(/ · Linked Sidra LS-1004 · No Location, times in UTC$/);
  const code = under("lab-linked").getByLabel("Batch Code LS-1004", { exact: true });
  await expect(code).toHaveCSS("font-family", /mono/i);
  await expect(code).toHaveCSS("border-top-width", "0px");
  await expect(under("lab-unlinked")).toHaveText(new RegExp(String.raw` · ${recorded} · No Location, times in UTC$`));

  // The filter offers the batch in words, and its chip names it in a line, its code in a chip.
  await chooseFilter(page, "Bean Batch", `Linked Sidra LS-1004, roasted ${roastDay("2026-10-04")}`);
  await expect(page).toHaveURL(new RegExp(`beanBatchId=${batchId}`));
  await expect(rows(list)).toHaveCount(2);
  await expect(filterChip(page, "Bean Batch")).toHaveText("Bean Batch:Linked Sidra LS-1004");
  await expect(filterChip(page, "Bean Batch").getByLabel("Batch Code LS-1004", { exact: true })).toHaveCSS("border-top-width", "1px");

  // At a phone's width a Shot's two lines name no Bean, as before, and nothing is wider than the screen.
  await page.setViewportSize({ width: 393, height: 852 });
  const narrow = page.getByRole("group", { name: "Shots" });
  await expect(narrow.getByRole("listitem")).toHaveCount(2);
  await expect(narrow).not.toContainText("Linked Sidra");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393);
  await page.setViewportSize({ width: 1280, height: 720 });

  // A Shot's page: its batch, linked, with its code in a chip, over its roast day and the days from it to the Shot's day.
  await page.goto("/shots/lab-linked");
  const details = await openCard(page, "Details");
  const batch = field(details, "Bean Batch");
  await expect(batch).toHaveText(new RegExp(String.raw`^Linked SidraLS-1004Roasted ${roastDay("2026-10-04")}(, (\d+ days? before this Shot|the day of this Shot))?$`));
  await expect(batch.getByRole("link", { name: "Linked Sidra", exact: true })).toHaveAttribute("href", `/library/bean-batches/${batchId}`);
  await expect(batch.getByLabel("Batch Code LS-1004", { exact: true })).toHaveCSS("border-top-width", "1px");
  // The days are from the roast date to the Shot's day, at its Location, or in UTC for one with none: a batch roasted ten days before it
  // says so, and one roasted after it says nothing.
  const pulled = ((await (await page.request.get("/api/shots/lab-linked")).json()) as { shot: { pulledAt: string } }).shot.pulledAt;
  const dayAtTheLab = (days: number) => new Date(Date.parse(pulled) + days * 86_400_000).toISOString().slice(0, 10);
  for (const [days, says] of [
    [-10, ", 10 days before this Shot"],
    [0, ", the day of this Shot"],
    [2, ""],
  ] as const) {
    expect((await page.request.patch(`/api/bean-batches/${batchId}`, { data: { content: { roastDate: dayAtTheLab(days) } } })).status()).toBe(200);
    await page.reload();
    await expect(field(await openCard(page, "Details"), "Bean Batch")).toHaveText(`Linked SidraLS-1004Roasted ${roastDay(dayAtTheLab(days))}${says}`);
  }
  expect((await page.request.patch(`/api/bean-batches/${batchId}`, { data: { content: { roastDate: "2026-10-04" } } })).status()).toBe(200);

  // In the dark theme the batch's code still reads on its chip.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect(field(details, "Bean Batch").getByLabel("Batch Code LS-1004", { exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });

  // The previous release's server sends no Batch Code (ADR-0025): the list, the filter and the Shot's page name the batch by its Bean and roast date.
  const older = (shot: Record_) => {
    const { batchCode: _code, ...beanBatch } = (shot.beanBatch ?? {}) as Record_;
    return { ...shot, beanBatch: shot.beanBatch === null ? null : beanBatch };
  };
  await page.route(/\/api\/shots(\?|$)/, async (route) => {
    const answer = await route.fetch();
    const read = (await answer.json()) as Record_ & { shots: Record_[] };
    await route.fulfill({ response: answer, json: { ...read, shots: read.shots.map(older) } });
  });
  await page.route("**/api/shots/filters", async (route) => {
    const answer = await route.fetch();
    const read = (await answer.json()) as Record_ & { beanBatches: (Record_ | null)[] };
    await route.fulfill({ response: answer, json: { ...read, beanBatches: read.beanBatches.map((offered) => offered && (({ batchCode: _code, ...rest }) => rest)(offered)) } });
  });
  await page.route("**/api/shots/lab-linked", async (route) => {
    const answer = await route.fetch();
    const read = (await answer.json()) as { shot: Record_ };
    await route.fulfill({ response: answer, json: { ...read, shot: older(read.shot) } });
  });
  await page.goto(`/shots?beanBatchId=${batchId}`);
  await expect(under("lab-linked")).toHaveText(new RegExp(String.raw` · Linked Sidra, roasted ${roastDay("2026-10-04")} · No Location, times in UTC$`));
  await expect(filterChip(page, "Bean Batch")).toHaveText(`Bean Batch:Linked Sidra, roasted ${roastDay("2026-10-04")}`);
  await page.goto("/shots/lab-linked");
  await expect(field(await openCard(page, "Details"), "Bean Batch")).toHaveText(new RegExp(String.raw`^Linked SidraRoasted ${roastDay("2026-10-04")}`));
});

/** The test tablet's Shot pulled on the Machine of that serial, naming the batch and Grinder by the ids given, rated as given. */
function shotWith(id: string, serial: string, context: Record_, enjoyment: number): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return {
    ...fixture,
    id,
    annotations: { ...(fixture.annotations as Record_), enjoyment },
    workflow: {
      ...workflow,
      machine: { ...(workflow.machine as Record_), serialNumber: serial },
      context: { ...(workflow.context as Record_), grinderId: null, ...context },
    },
  };
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}
