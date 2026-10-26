import { expect, type Page, test } from "@playwright/test";
import { GLOBAL_ID_KEY } from "@decent-sync/protocol";
import { type Dye2Key, DYE2_NAMESPACE, dye2List } from "../server/test/support/simulated-dye2.js";
import { NO_DYE2_LISTS, SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { tabletAt } from "./support/tablets.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// Baskets and Tools in the management interface (ticket #139): created at a
// Location, shown at others, edited, Archived and restored there, which
// reaches the DYE2 lists of the simulated tablets running the built plugin at
// each Location showing them; their history and Conflicts; and what Staff may
// change. Serials are made up, from 43101.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What each Machine's tablet holds over derivedDe1Pro()'s: no library, and DYE2's lists empty. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };

const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };

type Record_ = Record<string, unknown>;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("an Admin creates a Basket at the lab, shows it at a cafe, edits it, Archives it and restores it", async ({ page }) => {
  // What reaches the tablets at each step is library-equipment-management.test.ts's.
  await createLocation(page, "Roastery lab");
  const cafe = await createLocation(page, "Uptown");

  await page.goto("/library");
  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name: "Baskets" }).click();
  await expectTip(page.getByRole("main"), "Baskets", /^DYE2's baskets, one item for each model of basket at every Location/);
  await page.getByRole("button", { name: "New Basket" }).click();
  const dialog = page.getByRole("dialog", { name: "New Basket" });
  await dialog.getByLabel("Shown at").click();
  await page.getByRole("option", { name: "Roastery lab" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Lab 20g High-flow");
  await dialog.getByLabel("Size").click();
  await page.getByRole("option", { name: "Double" }).click();
  await dialog.getByLabel("Diameter (mm)").fill("58");
  await dialog.getByLabel("Notes").fill("Even extraction");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Lab 20g High-flow", level: 1 })).toBeVisible();
  const basket = page.getByLabel("Basket", { exact: true });
  await expect(field(basket, "Size")).toHaveText("Double");
  await expect(field(basket, "Diameter")).toHaveText("58 mm");
  await expectTip(page.getByRole("main"), "Basket", "As it was created, with the edits made since, on tablets or here, which reach every tablet that holds it.");
  await expectTip(page.getByRole("main"), "Locations", /^Where it is shown\. Showing it at a Location writes it to the DYE2 list of each tablet there/);

  // Shown at the lab only.
  const shownAt = (name: string) => page.getByRole("switch", { name: `Shown at ${name}` });
  await expect(shownAt("Roastery lab")).toBeChecked();
  await expect(shownAt("Uptown")).not.toBeChecked();

  await shownAt("Uptown").click();
  await expect(shownAt("Uptown")).toBeChecked();

  await page.getByRole("button", { name: "Edit the Basket" }).click();
  const form = page.getByRole("form", { name: "Edit the Basket" });
  await form.getByLabel("Notes").fill("Even extraction at 20 g");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(field(basket, "Notes")).toHaveText("Even extraction at 20 g");

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: "Lab 20g High-flow", level: 1 })).toContainText("Archived");
  // Each Location's choice is kept.
  await expect(shownAt("Uptown")).toBeChecked();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

  // The list filters by the Locations showing it, by status and by name, keeping the filters in the address.
  await page.getByRole("link", { name: "← Baskets" }).click();
  const list = page.getByRole("table", { name: "Baskets" });
  await expect(rows(list).filter({ hasText: "Lab 20g High-flow" }).getByRole("cell").nth(3)).toHaveText("Roastery lab, Uptown");
  const filters = page.getByRole("search", { name: "Filter Baskets" });
  await filters.getByLabel("Shown at").click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await expect(page).toHaveURL(new RegExp(`shownAt=${cafe.id}`));
  await expect(rows(list).filter({ hasText: "Lab 20g High-flow" })).toHaveCount(1);
  await filters.getByLabel("Status").click();
  await page.getByRole("option", { name: "Archived", exact: true }).click();
  await expect(page.getByText("No Baskets match these filters.")).toBeVisible();
  await filters.getByRole("button", { name: "Clear filters" }).click();
  await expect(filters.getByLabel("Status")).toHaveText("Any");
  await filters.getByLabel("Search").fill("high-FLOW");
  await expect(rows(list)).toHaveCount(1);
  await filters.getByLabel("Search").fill("precision");
  await expect(page.getByText("No Baskets match these filters.")).toBeVisible();
});

test("a Tool's attributes are edited, and its history lists the edit", async ({ page }) => {
  // What reaches the tablets is library-equipment-management.test.ts's.
  const lab = await createLocation(page, "Tool lab");
  const created = await page.request.post("/api/tools", {
    data: { locationId: lab.id, content: { name: "Lab WDT Tool", custom: [{ key: "Needles", value: "8" }] } },
  });
  expect(created.status()).toBe(201);

  await page.goto("/library/tools");
  await expectTip(page.getByRole("main"), "Tools", /^Gear such as WDT tools and puck screens, which DYE2 calls equipment/);
  await page.getByRole("link", { name: "Lab WDT Tool" }).click();
  await expect(page.getByRole("heading", { name: "Lab WDT Tool", level: 1 })).toBeVisible();
  const attributes = page.getByRole("table", { name: "Attributes" });
  await expect(rows(attributes)).toHaveText(["Needles8"]);

  await page.getByRole("button", { name: "Edit the Tool" }).click();
  const form = page.getByRole("form", { name: "Edit the Tool" });
  await form.getByLabel("Attribute 1 value").fill("10");
  await form.getByRole("button", { name: "Add an attribute" }).click();
  await form.getByLabel("Attribute 2 name").fill("Needle size");
  await form.getByLabel("Attribute 2 value").fill("0.3 mm");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(rows(attributes)).toHaveText(["Needles10", "Needle size0.3 mm"]);

  // Its history lists the edit, made here, above the Tool joining the Library.
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(3);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("AttributesNeedles: 10, Needle size: 0.3 mm");
  await expect(history.nth(2)).toContainText("NameLab WDT Tool");

  // Saving values that read as they were, a space after the name and an attribute row without a name, is no edit.
  await page.getByRole("button", { name: "Edit the Tool" }).click();
  await form.getByLabel("Name", { exact: true }).fill("Lab WDT Tool ");
  await form.getByRole("button", { name: "Add an attribute" }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Edit the Tool" })).toBeVisible();
  await expect(history).toHaveCount(3);

  // Removing an attribute is an edit.
  await page.getByRole("button", { name: "Edit the Tool" }).click();
  await form.getByRole("button", { name: "Remove attribute 2" }).click();
  await form.getByRole("button", { name: "Save" }).click();
  await expect(rows(attributes)).toHaveText(["Needles10"]);
  await expect(history).toHaveCount(4);
});

test("a Conflict over a Basket's notes, made on two tablets offline, is shown on its page, and using its value makes it current on every tablet", async ({ page }) => {
  const lab = await createLocation(page, "Conflict lab");
  const one = await tabletAt(page, server, "Conflict lab 1", lab, "43121", tabletApi);
  const two = await tabletAt(page, server, "Conflict lab 2", lab, "43122", tabletApi);
  const created = await page.request.post("/api/baskets", { data: { locationId: lab.id, content: { name: "Conflict 18g Precision", notes: "New" } } });
  expect(created.status()).toBe(201);
  const { id } = ((await created.json()) as { basket: { id: string } }).basket;
  for (const tablet of [one, two]) await expect.poll(() => recordOf(tablet, "baskets", id)?.notes).toBe("New");

  // Both offline, each tablet's DYE2 page saves notes of its own: the later wins on reconnecting, the earlier is kept as a Conflict.
  one.loseNetwork();
  two.loseNetwork();
  await saveNotes(one, id, "Tight puck");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await saveNotes(two, id, "Fast flow");
  one.restoreNetwork();
  await expect.poll(async () => (await view(page, id)).content.notes).toBe("Tight puck");
  two.restoreNetwork();
  for (const tablet of [one, two]) await expect.poll(() => recordOf(tablet, "baskets", id)?.notes).toBe("Fast flow");
  await expect.poll(async () => ((await (await page.request.get(`/api/baskets/${id}/conflicts`)).json()) as { conflicts: unknown[] }).conflicts.length).toBe(1);

  await page.goto("/library/conflicts");
  await rows(page.getByRole("table", { name: "Conflicts" })).filter({ hasText: "Conflict 18g Precision" }).getByRole("link", { name: "Conflict 18g Precision" }).click();
  await expect(page.getByRole("heading", { name: "Conflict 18g Precision", level: 1 })).toBeVisible();
  const open = page.getByRole("region", { name: "Open Conflicts" });
  const conflict = rows(open.getByRole("table", { name: "Conflicts" }));
  await expect(conflict).toHaveCount(1);
  await expect(conflict.getByRole("cell").nth(0)).toHaveText("Notes");
  await expect(conflict.getByRole("cell").nth(1)).toContainText("Tight puck");
  await expect(conflict.getByRole("cell").nth(1)).toContainText("Conflict lab 1");
  await expect(conflict.getByRole("cell").nth(2)).toContainText("Fast flow");

  await open.getByRole("button", { name: "Use the losing value of Notes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Use this value" }).click();
  await expect(open).toBeHidden();
  await expect(field(page.getByLabel("Basket", { exact: true }), "Notes")).toHaveText("Tight puck");
  for (const tablet of [one, two]) await expect.poll(() => recordOf(tablet, "baskets", id)?.notes).toBe("Tight puck");
});

test("Staff edit a Basket's content, but cannot show or hide it at a Location they do not work at", async ({ page, browser }) => {
  const home = await createLocation(page, "Belmont");
  const elsewhere = await createLocation(page, "Staff lab");
  const created = await page.request.post("/api/baskets", { data: { locationId: elsewhere.id, content: { name: "Staff lab basket", size: "single" } } });
  expect(created.status()).toBe(201);
  const { id } = ((await created.json()) as { basket: { id: string } }).basket;

  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [home.id] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    expect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/library/baskets/${id}`);
    await expect(samsPage.getByRole("heading", { name: "Staff lab basket", level: 1 })).toBeVisible();

    // The switch at the Location Sam does not work at is disabled; the one at Sam's own is not.
    await expect(samsPage.getByRole("switch", { name: "Shown at Staff lab" })).toBeDisabled();
    await expect(samsPage.getByRole("switch", { name: "Shown at Belmont" })).toBeEnabled();

    await samsPage.getByRole("button", { name: "Edit the Basket" }).click();
    const form = samsPage.getByRole("form", { name: "Edit the Basket" });
    await form.getByLabel("Size").click();
    await samsPage.getByRole("option", { name: "Not set" }).click();
    await form.getByLabel("Notes").fill("Checked by Staff");
    await form.getByRole("button", { name: "Save" }).click();
    const basket = samsPage.getByLabel("Basket", { exact: true });
    await expect(field(basket, "Notes")).toHaveText("Checked by Staff");
    await expect(field(basket, "Size")).toHaveText("-");

    // Still shown where it was, and not at Sam's own Location.
    await expect(samsPage.getByRole("switch", { name: "Shown at Staff lab" })).toBeChecked();
    await expect(samsPage.getByRole("switch", { name: "Shown at Belmont" })).not.toBeChecked();
  } finally {
    await samsBrowser.close();
  }
});

test("creating a Tool whose name the Library has is refused, with a link to that Tool, which is to be restored if Archived", async ({ page }) => {
  const lab = await createLocation(page, "Duplicate lab");
  const created = await page.request.post("/api/tools", { data: { locationId: lab.id, content: { name: "Duplicate Puck Screen" } } });
  expect(created.status()).toBe(201);
  const { id } = ((await created.json()) as { tool: { id: string } }).tool;
  expect((await page.request.put(`/api/tools/${id}/archived`, { data: { archived: true } })).status()).toBe(200);

  await page.goto("/library/tools");
  await page.getByRole("button", { name: "New Tool" }).click();
  const dialog = page.getByRole("dialog", { name: "New Tool" });
  await dialog.getByLabel("Shown at").click();
  await page.getByRole("option", { name: "Duplicate lab" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(" duplicate PUCK screen ");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The Library has this Tool already, Archived");
  await expect(dialog.getByRole("alert")).toContainText("Restore it on its page instead.");
  await dialog.getByRole("link", { name: "Duplicate Puck Screen" }).click();
  await expect(page.getByRole("heading", { name: "Duplicate Puck Screen", level: 1 })).toContainText("Archived");
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  const { tools } = (await (await page.request.get("/api/tools")).json()) as { tools: { name: string }[] };
  expect(tools.filter((tool) => tool.name.toLowerCase().includes("puck screen"))).toHaveLength(1);
});


/** The tablet's record of the item in DYE2's list, by the global id it carries, if it holds one. */
function recordOf(tablet: SimulatedTablet, key: Dye2Key, id: string): Record_ | undefined {
  const list = dye2List(tablet, key);
  return Array.isArray(list) ? (list as Record_[]).find((record) => record[GLOBAL_ID_KEY] === id) : undefined;
}

/** Saves the Basket's notes on the tablet as DYE2's baskets page does: reads the list, changes the record, posts the list back. */
async function saveNotes(tablet: SimulatedTablet, id: string, notes: string): Promise<void> {
  const list = (dye2List(tablet, "baskets") as Record_[]).map((record) => (record[GLOBAL_ID_KEY] === id ? { ...record, notes } : record));
  expect((await tablet.callApi("POST", `/store/${DYE2_NAMESPACE}/baskets`, list)).status).toBe(200);
}

async function view(page: Page, id: string): Promise<{ content: Record_ }> {
  return ((await (await page.request.get(`/api/baskets/${id}`)).json()) as { basket: { content: Record_ } }).basket;
}
