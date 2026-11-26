import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { shotFixture } from "../server/test/support/shot-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// A Bean Batch's Remaining Weight in the management interface (ticket #706,
// ADR-0037): a batch's page shows its weight at each Location, worked out
// from the Shots pulled there since the weight was entered, with one line
// saying so, and its total; Enter weight corrects it, finishes the batch
// there with zero, saying so first, and clears it left empty; and the list
// of batches shows each Location's weight and the total. The rules
// themselves are server/test/library-remaining-weight.test.ts's.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What the Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a batch's page shows its weight at each Location less the Shots pulled there, and Enter weight corrects it, clears it left empty and finishes the batch there with zero", async ({ page }) => {
  const downtown = await createLocation(page, "Downtown");
  const riverside = await createLocation(page, "Riverside");
  const tablet = await tabletAt(page, server, "Bar Left", downtown, "70651", tabletApi);
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name: "House Espresso" } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-11-20", weight: 6000, batchCode: "PR-0470" },
    locations: [{ locationId: downtown.id, remainingWeight: 4180 }],
  });
  expect((await page.request.put(`/api/bean-batches/${batch.id}/locations/${riverside.id}`, { data: { atLocation: true } })).status()).toBe(200);

  // Two Shots at Downtown, pulled after its weight was entered: 18.5 g weighed, and 20 g by the Workflow alone.
  const local = () => tablet.batches().find((record) => globalIdOf(record) === batch.id)?.id;
  await expect.poll(local).toBeTruthy();
  tablet.pullShot(shotWith("weighed-1", "70651", local(), { actual: 18.5 }));
  tablet.pullShot(shotWith("weighed-2", "70651", local(), { target: 20 }));
  await expect.poll(async () => ((await (await page.request.get(`/api/shots?beanBatchId=${batch.id}`)).json()) as { total: number }).total).toBe(2);

  await page.goto(`/library/bean-batches/${batch.id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  const where = whereItIs.getByRole("table", { name: "Locations" });
  await expect(field(whereItIs, "Total remaining")).toHaveText("4141.5 g");
  await expect(rows(where).locator("td:nth-child(-n+2)")).toHaveText([
    "Downtown",
    /^4141\.5 g4180 g entered .+ by you\. Since: 2 Shots used 38\.5 g\.$/,
    "Riverside",
    "Not tracked",
  ]);
  // Each Location has Move to… (#704), Enter weight and Finish here, and nothing that only clears a weight.
  await expect(where.getByRole("button")).toHaveText(["Move to…", "Enter weight", "Finish here", "Move to…", "Enter weight", "Finish here"]);
  await expect(whereItIs.getByRole("spinbutton")).toHaveCount(0);

  // A weight entered at Riverside is its own, and the total is the sum.
  await where.getByRole("button", { name: "Enter its weight at Riverside" }).click();
  const atRiverside = page.getByRole("dialog", { name: "Enter weight at Riverside" });
  // Opened on no weight, which would leave it as it is: not tracked.
  await expect(atRiverside.getByRole("status")).toHaveText("Left empty, the batch is not tracked at Riverside.");
  await atRiverside.getByLabel("Remaining weight (g)", { exact: true }).fill("500");
  await expect(atRiverside.getByRole("status")).toHaveText("");
  await atRiverside.getByRole("button", { name: "Save" }).click();
  await expect(where.getByRole("row", { name: /^Riverside 500 g/ })).toContainText(/500 g entered .+ by you\. No Shots since\./);
  await expect(field(whereItIs, "Total remaining")).toHaveText("4641.5 g");

  // The list names each Location with its weight there, and the total.
  await page.goto("/library/bean-batches");
  await expect(rows(page.getByRole("table", { name: "Bean Batches" }))).toHaveText([
    ["House Espresso, roasted 2026-11-20", "PR-0470", "Lantern Coffee Roasters", "Downtown (4141.5 g), Riverside (500 g)", "4641.5 g", "-", ""].join(""),
  ]);
  await page.getByRole("link", { name: "House Espresso, roasted 2026-11-20" }).click();

  // Left empty, Enter weight clears it: the batch reads "Not tracked" there, and is still there.
  await where.getByRole("button", { name: "Enter its weight at Riverside" }).click();
  await expect(atRiverside.getByLabel("Remaining weight (g)", { exact: true })).toHaveValue("500");
  await atRiverside.getByLabel("Remaining weight (g)", { exact: true }).fill("");
  await expect(atRiverside.getByRole("status")).toHaveText("Left empty, the batch is not tracked at Riverside.");
  await atRiverside.getByRole("button", { name: "Save" }).click();
  await expect(where.getByRole("row", { name: /^Riverside Not tracked/ })).toBeVisible();
  await expect(field(whereItIs, "Total remaining")).toHaveText("4141.5 g");

  // Zero finishes the batch there, which the dialog says before it is saved.
  await where.getByRole("button", { name: "Enter its weight at Downtown" }).click();
  const atDowntown = page.getByRole("dialog", { name: "Enter weight at Downtown" });
  await expect(atDowntown.getByLabel("Remaining weight (g)", { exact: true })).toHaveValue("4141.5");
  await atDowntown.getByLabel("Remaining weight (g)", { exact: true }).fill("0");
  await expect(atDowntown.getByRole("status")).toHaveText("A weight of 0 finishes the batch at Downtown.");
  // Nothing is finished until it is saved: the row is still there behind the dialog.
  await expect(page.locator('table[aria-label="Locations"] tbody tr').filter({ hasText: "Downtown" })).toHaveCount(1);
  await atDowntown.getByRole("button", { name: "Finish here" }).click();
  await expect(where.getByRole("row", { name: /^Downtown/ })).toHaveCount(0);
  await expect(field(page.getByLabel("Finished", { exact: true }), "Downtown")).toContainText("Finished");
  // Its history keeps it as a finish made by a weight of zero, in one entry.
  const history = page.getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText("At DowntownFinished, by a weight of 0 g");
  await expect(history.getByText("Remaining weight at Downtown")).toHaveCount(1);
});

test("a new batch is created at one Location and starts at its roasted weight there, or untracked with none", async ({ page }) => {
  // With the first test's two, four Locations to choose among.
  await createLocation(page, "Uptown");
  await createLocation(page, "Harbor");
  await post(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name: "Kenya Nyeri AA" } });

  await page.goto("/library/bean-batches");
  await page.getByRole("button", { name: "New Batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New Batch" });
  await newBatch.getByLabel("Bean", { exact: true }).click();
  await page.getByRole("option", { name: /Kenya Nyeri AA/ }).click();
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-11-22");
  await newBatch.getByLabel("Weight (g)", { exact: true }).fill("6000");
  // With no Location chosen, it is not created.
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(newBatch.getByRole("alert")).toHaveText("Choose the Location it is at");
  await newBatch.getByLabel("Location", { exact: true }).click();
  await page.getByRole("option", { name: "Harbor" }).click();
  // A remaining weight of zero is refused, as it would finish the batch there.
  await newBatch.getByLabel("Remaining weight (g)", { exact: true }).fill("0");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(newBatch.getByRole("alert")).toContainText("A batch is not added with a remaining weight of 0");
  await newBatch.getByLabel("Remaining weight (g)", { exact: true }).fill("");
  await newBatch.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: "Kenya Nyeri AA, roasted 2026-11-22", level: 1 })).toBeVisible();
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  await expect(rows(whereItIs.getByRole("table", { name: "Locations" })).locator("td:nth-child(-n+2)")).toHaveText(["Harbor", /^6000 g6000 g entered .+ by you\. No Shots since\.$/]);
});

/** A Shot pulled a minute from now on the Machine of that serial, its Workflow naming the batch by the tablet's id for it, with the measured or Workflow dose given alone. */
function shotWith(id: string, serial: string, beanBatchId: unknown, dose: { actual?: number; target?: number }): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  const { targetDoseWeight: _target, ...context } = workflow.context as Record_;
  const { actualDoseWeight: _actual, ...annotations } = fixture.annotations as Record_;
  return {
    ...fixture,
    id,
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    annotations: { ...annotations, ...(dose.actual === undefined ? {} : { actualDoseWeight: dose.actual }) },
    workflow: {
      ...workflow,
      machine: { ...(workflow.machine as Record_), serialNumber: serial },
      context: { ...context, grinderId: null, beanBatchId, ...(dose.target === undefined ? {} : { targetDoseWeight: dose.target }) },
    },
  };
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}
