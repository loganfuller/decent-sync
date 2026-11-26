import { type Page, expect, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";

// A Bean Batch's Batch Code in the management interface (ticket #703): given
// as a batch is created, shown beside the batch's title, in its Roast card
// and in the list of batches, which finds a batch by it, changed where the
// roast date is edited, and refused, with a link to the batch that holds
// it, where another batch that is not Archived does. The rules themselves,
// and what tablets are written, are server/test/library-batch-codes.test.ts's.
useFreshServer();

test.beforeEach(({ page }) => signInAsAdmin(page));

async function createBean(page: Page, name: string): Promise<string> {
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Lantern Coffee Roasters", name } } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { bean: { id: string } }).bean.id;
}

async function createBatch(page: Page, beanId: string, content: Record<string, unknown>): Promise<string> {
  const created = await page.request.post("/api/bean-batches", { data: { beanId, content, locations: [] } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { batch: { id: string } }).batch.id;
}

test("a batch is given a Batch Code as it is created, shown on its page and in the list, found by it, and changed where its roast date is", async ({ page }) => {
  await createLocation(page, "Downtown");
  const guji = await createBean(page, "Ethiopia Guji Natural");
  await createBatch(page, await createBean(page, "Brazil Cerrado"), { batchCode: "LR-0409", roastDate: "2026-11-12" });
  await createBatch(page, guji, { roastDate: "2026-11-01" });

  await page.goto(`/library/beans/${guji}`);
  await page.getByRole("button", { name: "New Batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New Batch of Ethiopia Guji Natural" });
  await newBatch.getByLabel("Batch Code", { exact: true }).fill(" LR-0412 ");
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-11-18");
  await newBatch.getByLabel("Downtown", { exact: true }).check();
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Ethiopia Guji Natural, roasted 2026-11-18", level: 1 })).toBeVisible();
  // Beside the title, and first in the Roast card.
  await expect(page.getByRole("heading", { level: 1 }).getByLabel("Batch Code LR-0412")).toHaveText("LR-0412");
  const roast = page.getByLabel("Roast", { exact: true });
  await expect(field(roast, "Batch Code")).toHaveText("LR-0412");

  // Changed where the roast date is edited, and in the batch's history.
  await page.getByRole("button", { name: "Edit the roast" }).click();
  const form = page.getByRole("form", { name: "Edit the roast" });
  await expect(form.getByLabel("Batch Code", { exact: true })).toHaveValue("LR-0412");
  await form.getByLabel("Batch Code", { exact: true }).fill("LR-0413");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(roast, "Batch Code")).toHaveText("LR-0413");
  await expect(page.getByRole("heading", { level: 1 }).getByLabel("Batch Code LR-0413")).toBeVisible();
  await expect(page.getByRole("table", { name: "History" })).toContainText("Batch Code");

  // The list has a column of them, and its search finds a batch by its code, its Bean or its roaster.
  await page.getByRole("link", { name: "← Bean Batches" }).click();
  const list = page.getByRole("table", { name: "Bean Batches" });
  await expect(list.getByRole("columnheader")).toHaveText(["Batch", "Batch Code", "Roaster", "At", "Created at", "Attention"]);
  await expect(rows(list)).toHaveText([
    ["Brazil Cerrado, roasted 2026-11-12", "LR-0409", "Lantern Coffee Roasters", "Nowhere", "-", ""].join(""),
    ["Ethiopia Guji Natural, roasted 2026-11-18", "LR-0413", "Lantern Coffee Roasters", "Downtown (no weight entered)", "-", ""].join(""),
    ["Ethiopia Guji Natural, roasted 2026-11-01", "-", "Lantern Coffee Roasters", "Nowhere", "-", ""].join(""),
  ]);
  const search = page.getByRole("search", { name: "Find a batch" });
  await search.getByLabel("Find a batch").fill("lr-041");
  await expect(rows(list)).toHaveText([/^Ethiopia Guji Natural, roasted 2026-11-18LR-0413/]);
  await expect(search.getByRole("status")).toHaveText("1 of 3 batches");
  // Kept in the address, so the list found is a link.
  await expect(page).toHaveURL(/[?&]q=lr-041$/);
  await search.getByLabel("Find a batch").fill("guji lantern");
  await expect(rows(list)).toHaveCount(2);
  await search.getByLabel("Find a batch").fill("LR-9999");
  await expect(page.getByText("No batch matches.")).toBeVisible();

  // Cleared, the batch has none.
  await search.getByLabel("Find a batch").fill("LR-0413");
  await list.getByRole("link", { name: "Ethiopia Guji Natural, roasted 2026-11-18" }).click();
  await page.getByRole("button", { name: "Edit the roast" }).click();
  await form.getByLabel("Batch Code", { exact: true }).fill("");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(roast, "Batch Code")).toHaveText("-");
  await expect(page.getByRole("heading", { level: 1 }).getByLabel(/^Batch Code/)).toHaveCount(0);
});

test("a Batch Code another batch holds is refused with a link to that batch, creating one, editing one and restoring one", async ({ page }) => {
  const bean = await createBean(page, "Colombia Huila");
  await createBatch(page, bean, { batchCode: "LR-0412", roastDate: "2026-11-18" });
  const other = await createBatch(page, bean, { batchCode: "LR-0500", roastDate: "2026-11-19" });

  // In the new batch dialog, whatever its case.
  await page.goto(`/library/beans/${bean}`);
  await page.getByRole("button", { name: "New Batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New Batch of Colombia Huila" });
  await newBatch.getByLabel("Batch Code", { exact: true }).fill("lr-0412");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(newBatch.getByRole("alert")).toHaveText("Another batch holds the Batch Code LR-0412: Colombia Huila, roasted 2026-11-18. A code is one batch's until that batch is Archived.");
  // Another code is taken, and the dialog's refusal goes.
  await newBatch.getByLabel("Batch Code", { exact: true }).fill("LR-0501");
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-11-20");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Colombia Huila, roasted 2026-11-20", level: 1 })).toBeVisible();

  // Where the roast is edited.
  await page.goto(`/library/bean-batches/${other}`);
  await page.getByRole("button", { name: "Edit the roast" }).click();
  const form = page.getByRole("form", { name: "Edit the roast" });
  await form.getByLabel("Batch Code", { exact: true }).fill("LR-0412");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toContainText("Another batch holds the Batch Code LR-0412");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(field(page.getByLabel("Roast", { exact: true }), "Batch Code")).toHaveText("LR-0500");

  // Archived, its code is free: another batch takes it, and it is not restored while that batch holds it.
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  const taker = await createBatch(page, bean, { batchCode: "lr-0500", roastDate: "2026-11-21" });
  await page.getByRole("button", { name: "Restore" }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "Another batch holds the Batch Code lr-0500" });
  await expect(refusal).toBeVisible();
  await refusal.getByRole("link", { name: "Colombia Huila, roasted 2026-11-21" }).click();
  await expect(page).toHaveURL(new RegExp(`/library/bean-batches/${taker}$`));
  await expect(page.getByRole("heading", { level: 1 }).getByLabel("Batch Code lr-0500")).toBeVisible();
});
