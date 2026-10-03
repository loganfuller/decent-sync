import { expect, test } from "@playwright/test";

test("the server serves the management interface, which reaches the server's API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Decent Sync" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Server connected");
});
