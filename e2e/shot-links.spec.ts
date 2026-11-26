import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { tabletAt } from "./support/tablets.js";
import { signInAsAdmin } from "./support/seed.js";
import { chooseFilter, field, filterChip, openCard, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

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

test("a batch's page counts its Shots from both Locations it has been at and opens them in the Shots list, as its Bean's does, and the Shots list filters by Bean Batch and by Grinder", async ({ page }) => {
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
  const labGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: lab.location.id, content: { model: "Lab EK43" } })).grinder;
  const cafeGrinder = (await post<{ grinder: { id: string } }>(page, "/api/grinders", { locationId: cafe.location.id, content: { model: "Belmont Mythos" } })).grinder;
  const local = (tablet: SimulatedTablet, grinderId: string) => ({
    beanBatchId: tablet.batches().find((record) => globalIdOf(record) === batch.id)?.id,
    grinderId: tablet.grinders().find((record) => globalIdOf(record) === grinderId)?.id,
  });
  await expect.poll(() => Object.values(local(labTablet, labGrinder.id)).every(Boolean)).toBe(true);
  // The bucket goes on to the cafe: the lab's tablet keeps its record of the batch, archived, and the cafe's holds one too.
  expect((await page.request.put(`/api/bean-batches/${batch.id}/locations/${cafe.location.id}`, { data: { atLocation: true } })).status()).toBe(200);
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
  await expect(filterChip(page, "Bean Batch")).toHaveText("Bean Batch:Linked Sidra, roasted 2026-10-04");

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
  await details.getByRole("link", { name: "Linked Sidra, roasted 2026-10-04" }).click();
  await expect(page.getByRole("heading", { name: "Linked Sidra, roasted 2026-10-04", level: 1 })).toBeVisible();
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
