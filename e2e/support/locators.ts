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
  // Open first, as what it holds shows with its Hide button, so it is not read as loaded before it shows.
  await expect(card.getByRole("button", { name: `Hide ${name}`, exact: true })).toBeVisible();
  await expect(card.getByText("Loading", { exact: true })).toHaveCount(0);
  return card;
}

/**
 * Opens one of a Machine's page's tabs (#545), Now, Activity, Settings,
 * Software or Setup, by its link, and waits until it is the one open. A card is on one
 * tab only, and is mounted only while its tab is open.
 */
export async function openMachineTab(page: Page, name: "Now" | "Activity" | "Settings" | "Software" | "Setup"): Promise<void> {
  const tab = page.getByRole("navigation", { name: "Machine" }).getByRole("link", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page");
}

/** That a Recipe's page says it is in this Recipe Slot at this Location: the badge beside its name, and the line under it. */
export async function expectSlot(page: Page, slot: number, location: string): Promise<void> {
  await expect(page.getByRole("main").getByRole("img", { name: `Slot ${slot}`, exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText(`at ${location}`, { exact: true })).toBeVisible();
}

/**
 * Chooses one of a Recipe's actions from the More menu beside its name on
 * its page (#547), where all but Edit are, and, on a wide screen, moving it
 * to a slot.
 */
export async function recipeAction(page: Page, name: string): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

/** The actions a Recipe's More menu offers the account, read with the menu open and closed again after. */
export async function recipeActions(page: Page): Promise<string[]> {
  await page.getByRole("main").getByRole("button", { name: "More", exact: true }).click();
  // Read once the menu is open: a read of its items doesn't wait for them.
  await expect(page.getByRole("menu")).toBeVisible();
  const items = await page.getByRole("menuitem").filter({ visible: true }).allTextContents();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  return items;
}

/** The table's rows, leaving out its header row and any row that only heads a group of rows, as a day's heading in the Shots list. */
export function rows(table: Locator): Locator {
  return table.getByRole("row").filter({ hasNot: table.page().getByRole("columnheader") }).filter({ has: table.page().getByRole("cell") });
}

/** The Machine's row in the Machines list. */
export function machineRow(page: Page, name: string): Locator {
  return page
    .getByRole("table", { name: "Machines" })
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name, exact: true }) });
}

/**
 * Opens a record list's filters, from its Filters button, unless they are
 * open, and returns them: a popover on a wide screen and a sheet on a
 * narrow one, a dialog named Filters either way.
 */
export async function openFilters(page: Page): Promise<Locator> {
  const filters = page.getByRole("dialog", { name: "Filters" });
  if (!(await filters.isVisible())) await page.getByRole("region", { name: "Filters" }).getByRole("button", { name: /^Filters/ }).click();
  await expect(filters).toBeVisible();
  return filters;
}

/** Closes a record list's filters, if they are open. */
export async function closeFilters(page: Page): Promise<void> {
  const filters = page.getByRole("dialog", { name: "Filters" });
  if (await filters.isVisible()) await page.keyboard.press("Escape");
  await expect(filters).toHaveCount(0);
}

/** Sets one of a record list's filters to the option of that name, opening the filters first and closing them after. */
export async function chooseFilter(page: Page, filter: string, option: string): Promise<void> {
  const filters = await openFilters(page);
  await filters.getByRole("combobox", { name: filter, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await closeFilters(page);
}

/** The chip above a record list of a filter that is set, which names it and what it is set to. */
export function filterChip(page: Page, filter: string): Locator {
  return page
    .getByRole("list", { name: "Filters set" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: `Remove the ${filter} filter`, exact: true }) });
}

/** One of a record list's date presets: Today, Yesterday, 7 days, 30 days or Custom. */
export function datesPreset(page: Page, name: string): Locator {
  return page.getByRole("radiogroup", { name: "Dates" }).getByRole("radio", { name, exact: true });
}
