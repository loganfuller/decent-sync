import { expect, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";

// Creating and editing the Library's Beans and Bean Batches in the
// management interface, and adding and finishing batches at Locations
// there (ticket #87). What each Location's tablets are written of them is
// server/test/library-management.test.ts's.
useFreshServer();

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

  await page.getByRole("button", { name: "New Batch" }).click();
  const newBatch = page.getByRole("dialog", { name: "New Batch of Uptown Gesha" });
  await newBatch.getByLabel("Roast date", { exact: true }).fill("2026-10-03");
  await newBatch.getByLabel("Weight (g)", { exact: true }).fill("1000");
  // It is created at one Location, chosen from a list: nothing ticks several.
  await expect(newBatch.getByRole("checkbox", { name: /Uptown|Downtown/ })).toHaveCount(0);
  await newBatch.getByLabel("Location", { exact: true }).click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await newBatch.getByLabel("Remaining weight (g)", { exact: true }).fill("850");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha, roasted 2026-10-03", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("Roast", { exact: true }), "Weight")).toHaveText("1000 g");
  const where = page.getByRole("table", { name: "Locations" });
  await expect(where.getByRole("row", { name: /^Uptown 850 g/ })).toBeVisible();
  await expect(where.getByRole("row", { name: /^Uptown/ })).toContainText(/850 g entered .+ by you\. No Shots since\./);
  await expect(where.getByRole("row", { name: /^Downtown/ })).toHaveCount(0);

  // Its Bean, edited here.
  await page.getByRole("link", { name: "Uptown Gesha" }).click();
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Jasmine, bergamot");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Jasmine, bergamot");
});

test("part of a lab batch is moved to a cafe, weighed there and finished there, staying at the lab", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  await createLocation(page, "Belmont");
  const createdBean = await page.request.post("/api/beans", { data: { content: { roaster: "Roux Bakehouse", name: "Lab Sidra" } } });
  expect(createdBean.status()).toBe(201);
  const { bean } = (await createdBean.json()) as { bean: { id: string } };
  const createdBatch = await page.request.post("/api/bean-batches", {
    data: { beanId: bean.id, content: { roastDate: "2026-10-04", weight: 250 }, locations: [{ locationId: lab.id }] },
  });
  expect(createdBatch.status()).toBe(201);

  await page.goto("/library/bean-batches");
  await page.getByRole("link", { name: "Lab Sidra, roasted 2026-10-04" }).click();
  const where = page.getByRole("table", { name: "Locations" });
  // Created with a roasted weight and no remaining weight, it starts at that weight at the lab.
  await expect(where.getByRole("row", { name: /^Roastery lab 250 g/ })).toBeVisible();
  // It reaches the cafe by a move (#704): the page has no control that only adds it there.
  await expect(page.getByRole("form", { name: "Add it at a Location" })).toHaveCount(0);
  await where.getByRole("button", { name: "Move it from Roastery lab" }).click();
  const moving = page.getByRole("dialog", { name: "Move this batch" });
  await moving.getByLabel("Move from Roastery lab to").click();
  await page.getByRole("option", { name: "Belmont, which has none" }).click();
  await moving.getByLabel("Weight to move, in grams").fill("180");
  await moving.getByRole("button", { name: "Move 180 g to Belmont" }).click();
  await expect(where.getByRole("row", { name: /^Belmont 180 g/ })).toBeVisible();
  await expect(where.getByRole("row", { name: /^Roastery lab 70 g/ })).toBeVisible();

  await where.getByRole("button", { name: "Enter its weight at Belmont" }).click();
  const entering = page.getByRole("dialog", { name: "Enter weight at Belmont" });
  await entering.getByLabel("Remaining weight (g)", { exact: true }).fill("200");
  await entering.getByRole("button", { name: "Save" }).click();
  await expect(where.getByRole("row", { name: /^Belmont 200 g/ })).toBeVisible();
  await expect(field(page.getByRole("region", { name: "Where it is" }), "Total remaining")).toHaveText("270 g");

  await where.getByRole("button", { name: "Finish it at Belmont" }).click();
  await expect(field(page.getByLabel("Finished", { exact: true }), "Belmont")).toContainText("Finished");
  await expect(where.getByRole("row", { name: /^Belmont/ })).toHaveCount(0);
  // The lab still has it.
  await expect(where.getByRole("row", { name: /^Roastery lab/ })).toBeVisible();
});

test("creating a Bean whose roaster and name the Library has is refused, with a link to that Bean", async ({ page }) => {
  const created = await page.request.post("/api/beans", { data: { content: { roaster: "Sandbox Coffee Roasters", name: "Washed Heirloom" } } });
  expect(created.status()).toBe(201);

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
  expect(created.status()).toBe(201);
  const { id } = ((await created.json()) as { bean: { id: string } }).bean;

  await page.goto(`/library/beans/${id}`);
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Salted caramel");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Salted caramel");
  const { bean } = (await (await page.request.get(`/api/beans/${id}`)).json()) as { bean: { content: Record<string, unknown> } };
  expect(bean.content).toMatchObject({ notes: "Salted caramel", altitude: [-5] });
});
