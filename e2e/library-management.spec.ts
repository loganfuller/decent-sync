import { expect, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// Creating and editing the Library's Beans and Bean Batches in the
// management interface (ticket #87), a batch created at one Location, and
// moved to another, with its weight, or finished where it is, on its page
// (ticket #704, ADR-0037). What each Location's tablets are written of them
// is server/test/library-management.test.ts's and library-moves.test.ts's.
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
  // It is created at one Location, chosen from a list of them: no Location is ticked beside another.
  await expect(newBatch).toContainText("A batch is at one Location at a time");
  await expect(newBatch.getByLabel("Uptown", { exact: true })).toHaveCount(0);
  // Left empty, the remaining weight is the roasted weight entered.
  await expect(newBatch.getByLabel("Remaining weight (g)")).toHaveValue("1000");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(newBatch.getByRole("alert")).toHaveText("Choose the Location it is at");
  await newBatch.getByLabel("At", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Downtown" })).toBeVisible();
  await page.getByRole("option", { name: "Uptown" }).click();
  await newBatch.getByLabel("Remaining weight (g)").fill("850");
  await newBatch.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Uptown Gesha, roasted 2026-10-03", level: 1 })).toBeVisible();
  await expect(field(page.getByLabel("Roast", { exact: true }), "Weight")).toHaveText("1000 g");
  const where = page.getByRole("group", { name: "At Uptown" });
  await expect(where.getByRole("link", { name: "Uptown" })).toBeVisible();
  await expect(where).toContainText("850 g");
  await expect(where.getByLabel("Remaining weight at Uptown (g)")).toHaveValue("850");
  await expect(page.getByRole("group", { name: "At Downtown" })).toHaveCount(0);

  // Its Bean, edited here.
  await page.getByRole("link", { name: "Uptown Gesha" }).click();
  await page.getByRole("button", { name: "Edit the coffee" }).click();
  const coffee = page.getByRole("form", { name: "Edit the coffee" });
  await coffee.getByLabel("Notes", { exact: true }).fill("Jasmine, bergamot");
  await coffee.getByRole("button", { name: "Save" }).click();
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Jasmine, bergamot");
});

test("a lab batch is moved to a cafe with its weight, as one entry of its history, given a weight there, finished there, and moved again from nowhere", async ({ page }) => {
  const lab = await createLocation(page, "Roastery lab");
  await createLocation(page, "Belmont");
  const createdBean = await page.request.post("/api/beans", { data: { content: { roaster: "Roux Bakehouse", name: "Lab Sidra" } } });
  expect(createdBean.status()).toBe(201);
  const { bean } = (await createdBean.json()) as { bean: { id: string } };
  const createdBatch = await page.request.post("/api/bean-batches", {
    data: { beanId: bean.id, content: { roastDate: "2026-10-04", weight: 250, batchCode: "LS-0104" }, locations: [{ locationId: lab.id, remainingWeight: 250 }] },
  });
  expect(createdBatch.status()).toBe(201);

  await page.goto("/library/bean-batches");
  await page.getByRole("link", { name: "Lab Sidra, roasted 2026-10-04" }).click();
  await expectTip(page.getByRole("main"), "Where it is", /^A batch is at one Location at a time, from when it is added there until it is finished there or moved to another\./);
  const atLab = page.getByRole("group", { name: "At Roastery lab" });
  await expect(atLab).toContainText("250 g");
  await expect(atLab).not.toContainText("Moved from");

  // Moved to the cafe: the dialog says what moving does, and offers the Locations it is not at.
  await atLab.getByRole("button", { name: "Move to…" }).click();
  const moving = page.getByRole("dialog", { name: "Move this batch" });
  await expect(moving).toContainText("Lab Sidra, roasted 2026-10-04 (LS-0104) is at Roastery lab. A batch is at one Location at a time, so moving it takes it away from Roastery lab.");
  await expect(moving.getByRole("listitem")).toHaveText([
    "Its remaining weight, 250 g, goes with it unless you enter another.",
    "Recipes at Roastery lab that name it go on naming it.",
    "Roastery lab's tablets stop offering it.",
  ]);
  await expect(moving.getByLabel("Weight on arrival, in grams")).toHaveAttribute("placeholder", "250");
  await expect(moving.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
  await moving.getByLabel("Move to", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Roastery lab" })).toHaveCount(0);
  await page.getByRole("option", { name: "Belmont" }).click();
  await moving.getByRole("button", { name: "Move to Belmont" }).click();
  await expect(moving).toHaveCount(0);

  // It is at the cafe alone, with the weight entered at the lab, and its history keeps the move as one entry.
  const atCafe = page.getByRole("group", { name: "At Belmont" });
  await expect(atCafe).toContainText("Moved from Roastery lab.");
  await expect(atCafe).toContainText("250 g");
  await expect(atLab).toHaveCount(0);
  await expect(field(page.getByLabel("Finished", { exact: true }), "Roastery lab")).toContainText("with 250 g");
  const history = page.getByRole("table", { name: "History" });
  await expect(history.getByRole("row").filter({ hasText: "Moved from Roastery lab to Belmont" })).toHaveCount(1);
  await expect(history.getByRole("row").filter({ hasText: "Moved from Roastery lab to Belmont" })).toContainText("You, here");
  // No entry of its own says it was finished at the lab: the move's does.
  await expect(history.getByRole("row").filter({ hasText: /At Roastery lab\s*No/ })).toHaveCount(0);

  await atCafe.getByLabel("Remaining weight at Belmont (g)").fill("200");
  await atCafe.getByRole("button", { name: "Set the remaining weight at Belmont" }).click();
  await expect(atCafe).toContainText("200 g");

  await atCafe.getByRole("button", { name: "Finish it at Belmont" }).click();
  await expect(field(page.getByLabel("Finished", { exact: true }), "Belmont")).toContainText("with 200 g");
  await expect(atCafe).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText("It is at no Location.");

  // At no Location, it is moved to one, with a weight entered on arrival.
  await page.getByRole("button", { name: "Move to…" }).click();
  await expect(moving).toContainText("is at no Location.");
  await moving.getByLabel("Move to", { exact: true }).click();
  await page.getByRole("option", { name: "Roastery lab" }).click();
  await moving.getByLabel("Weight on arrival, in grams").fill("180");
  await moving.getByRole("button", { name: "Move to Roastery lab" }).click();
  await expect(atLab).toContainText("180 g");
  await expect(atLab).not.toContainText("Moved from");
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
