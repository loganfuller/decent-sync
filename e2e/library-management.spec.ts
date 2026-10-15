import { expect as baseExpect, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";

// Creating and editing the Library's Beans and Bean Batches in the
// management interface, and adding and finishing batches at Locations
// there (ticket #87). What each Location's tablets are written of them is
// server/test/library-management.test.ts's.
useFreshServer();
const expect = baseExpect.configure({ timeout: 15_000 });

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a Bean and a batch of it at a Location are created here, and the Bean edited", async ({ page }) => {
  await createLocation(page, "Uptown");
  await createLocation(page, "Downtown");

  await page.goto("/library/beans");
  await page.getByRole("button", { name: "New Bean" }).click();
  const newBean = page.getByRole("dialog", { name: "New Bean" });
  await newBean.getByLabel("Roaster", { exact: true }).fill("Roux Bakehouse");
  await newBean.getByLabel("Name", { exact: true }).fill("Uptown Gesha");
  await newBean.getByLabel("Country", { exact: true }).fill("Panama");
  await newBean.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Roaster")).toHaveText("Roux Bakehouse");
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Country")).toHaveText("Panama");
  await expect(field(page.getByLabel("In the Library", { exact: true }), "Offered at")).toHaveText("Nowhere");

  await page.getByRole("button", { name: "New batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New batch of Uptown Gesha" });
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-10-03");
  await newBatch.getByLabel("Weight (g)", { exact: true }).fill("1000");
  await newBatch.getByLabel("Uptown", { exact: true }).check();
  await newBatch.getByLabel("Remaining weight at Uptown (g)").fill("850");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha, roasted 2026-10-03", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("Roast", { exact: true }), "Weight")).toHaveText("1000 g");
  const where = page.getByRole("table", { name: "Locations" });
  await expect(where.getByRole("row", { name: /^Uptown 850 g/ })).toBeVisible();
  await expect(where.getByLabel("Remaining weight at Uptown (g)")).toHaveValue("850");
  await expect(where.getByRole("row", { name: /^Downtown/ })).toHaveCount(0);

  // Its Bean, edited here.
  await page.getByRole("link", { name: "Uptown Gesha" }).click();
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Jasmine, bergamot");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Jasmine, bergamot");
});

test("a lab batch is added at a cafe, given a remaining weight there and finished there, staying at the lab", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  await createLocation(page, "Belmont");
  const createdBean = await page.request.post("/api/beans", { data: { content: { roaster: "Roux Bakehouse", name: "Lab Sidra" } } });
  baseExpect(createdBean.status()).toBe(201);
  const { bean } = (await createdBean.json()) as { bean: { id: string } };
  const createdBatch = await page.request.post("/api/bean-batches", {
    data: { beanId: bean.id, content: { roastDate: "2026-10-04", weight: 250 }, locations: [{ locationId: lab.id }] },
  });
  baseExpect(createdBatch.status()).toBe(201);

  await page.goto("/library/bean-batches");
  await page.getByRole("link", { name: "Lab Sidra, roasted 2026-10-04" }).click();
  const adding = page.getByRole("form", { name: "Add it at a Location" });
  await adding.getByLabel("Add it at").click();
  await page.getByRole("option", { name: "Belmont" }).click();
  await adding.getByRole("button", { name: "Add" }).click();
  const where = page.getByRole("table", { name: "Locations" });
  await expect(where.getByRole("row", { name: /^Belmont no weight entered/ })).toBeVisible();

  await where.getByLabel("Remaining weight at Belmont (g)").fill("200");
  await where.getByRole("button", { name: "Set the remaining weight at Belmont" }).click();
  await expect(where.getByRole("row", { name: /^Belmont 200 g/ })).toBeVisible();

  await where.getByRole("button", { name: "Finish it at Belmont" }).click();
  await expect(field(page.getByLabel("Finished", { exact: true }), "Belmont")).toContainText("with 200 g");
  await expect(where.getByRole("row", { name: /^Belmont/ })).toHaveCount(0);
  // The lab still has it.
  await expect(where.getByRole("row", { name: /^Roastery lab/ })).toBeVisible();
});

test("creating a Bean whose roaster and name the Library has is refused, with a link to that Bean", async ({ page }) => {
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Sandbox Coffee Roasters", name: "Washed Heirloom" } } });
  baseExpect(created.status()).toBe(201);

  await page.goto("/library/beans");
  await page.getByRole("button", { name: "New Bean" }).click();
  const newBean = page.getByRole("dialog", { name: "New Bean" });
  await newBean.getByLabel("Roaster", { exact: true }).fill("sandbox coffee roasters");
  await newBean.getByLabel("Name", { exact: true }).fill(" WASHED HEIRLOOM ");
  await newBean.getByRole("button", { name: "Create" }).click();
  await expect(newBean.getByRole("alert")).toContainText("The Library has this Bean already");
  await newBean.getByRole("link", { name: "Washed Heirloom" }).click();
  await expect(page.getByRole("heading", { name: "Washed Heirloom", level: 1 })).toBeVisible();
});

test("a Bean's form saves an edit of one field while another holds a value the form cannot read", async ({ page }) => {
  // Decaid takes any whole number as an altitude, which the form reads as whole numbers of 0 or more.
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Sandbox Coffee Roasters", name: "Below Sea Level", altitude: [-5] } } });
  baseExpect(created.status()).toBe(201);
  const { id } = ((await created.json()) as { bean: { id: string } }).bean;

  await page.goto(`/library/beans/${id}`);
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Salted caramel");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Salted caramel");
  const { bean } = (await (await page.request.get(`/api/beans/${id}`)).json()) as { bean: { content: Record<string, unknown> } };
  baseExpect(bean.content).toMatchObject({ notes: "Salted caramel", altitude: [-5] });
});
