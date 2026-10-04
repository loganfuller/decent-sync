import { expect, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";

// Creating and editing Locations, as an Admin whose browser is in Chicago
// while the server runs in UTC.
useFreshServer();
test.use({ timezoneId: "America/Chicago" });

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

test.beforeEach(async ({ page }) => {
  // The first test sets the server up; later ones sign in. Both sign the page's context in.
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else expect(setup.status()).toBe(201);
});

test("creating a Location defaults its time zone to the browser's", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Locations" }).click();

  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  await expect(page.getByText("No Locations yet.")).toBeVisible();
  const form = page.getByRole("form", { name: "New Location" });
  await expect(form.getByLabel("Time zone")).toHaveValue("America/Chicago");
  await form.getByLabel("Name").fill("Uptown");
  await form.getByRole("button", { name: "Create Location" }).click();

  await expect(location(page, "Uptown")).toContainText("America/Chicago");
  // The form is ready for the next one.
  await expect(form.getByLabel("Name")).toHaveValue("");
});

test("a Location can be given any IANA time zone, and an invalid one is refused", async ({ page }) => {
  await page.goto("/locations");
  const form = page.getByRole("form", { name: "New Location" });

  await form.getByLabel("Name").fill("Belmont");
  await form.getByLabel("Time zone").fill("Chicago time");
  await form.getByRole("button", { name: "Create Location" }).click();
  await expect(form.getByRole("alert")).toHaveText("Choose a time zone from the list, such as Europe/London");
  await expect(location(page, "Belmont")).toHaveCount(0);

  await form.getByLabel("Time zone").fill("Europe/London");
  await form.getByRole("button", { name: "Create Location" }).click();
  await expect(location(page, "Belmont")).toContainText("Europe/London");
});

test("a Location can be renamed and have its time zone changed", async ({ page }) => {
  await page.goto("/locations");

  await page.getByRole("button", { name: "Edit Belmont" }).click();
  const form = page.getByRole("form", { name: "Edit Belmont" });
  await expect(form.getByLabel("Name")).toHaveValue("Belmont");
  await form.getByLabel("Name").fill("Uptown");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.getByRole("alert")).toHaveText("A Location named Uptown already exists");

  await form.getByLabel("Name").fill("Roastery lab");
  await form.getByLabel("Time zone").fill("America/Denver");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).toHaveCount(0);
  await expect(location(page, "Roastery lab")).toContainText("America/Denver");
  await expect(location(page, "Belmont")).toHaveCount(0);

  // The change was saved, not just shown.
  await page.reload();
  await expect(location(page, "Roastery lab")).toContainText("America/Denver");
});

function location(page: Page, name: string) {
  return page.getByRole("list", { name: "Locations" }).getByRole("listitem").filter({ hasText: name });
}
