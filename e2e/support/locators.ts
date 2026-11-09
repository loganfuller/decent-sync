import { expect, type Locator, type Page } from "@playwright/test";

// Locators for parts the management interface's pages share, and the
// account menu's sign-out.

/** The value a description list in `scope` gives for `term`: the `dd` after the `dt` reading exactly that. */
export function field(scope: Page | Locator, term: string): Locator {
  return scope.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
}

/** Opens the account menu in the top bar, on a screen wide enough for it to show the account's name, and returns it. */
export async function openAccountMenu(page: Page, accountName: string): Promise<Locator> {
  await page.getByRole("banner").getByRole("button", { name: accountName, exact: true }).click();
  return page.getByRole("menu");
}

/** Signs out through the account menu in the top bar. */
export async function signOut(page: Page, accountName: string): Promise<void> {
  await (await openAccountMenu(page, accountName)).getByRole("menuitem", { name: "Sign out" }).click();
}

/**
 * Opens a card the page shows closed until asked, such as a Machine's
 * Settings Edits, and returns it once what it holds has loaded.
 */
export async function openCard(page: Page, name: string): Promise<Locator> {
  const card = page.getByRole("region", { name, exact: true });
  await card.getByRole("button", { name: `Show ${name}`, exact: true }).click();
  await expect(card.getByText("Loading", { exact: true })).toHaveCount(0);
  return card;
}

/** The table's rows, leaving out its header row. */
export function rows(table: Locator): Locator {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") });
}

/** The Machine's row in the Machines list. */
export function machineRow(page: Page, name: string): Locator {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}
