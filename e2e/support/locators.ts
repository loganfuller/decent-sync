import type { Locator, Page } from "@playwright/test";

// Locators for parts the management interface's pages share.

/** The value a description list in `scope` gives for `term`: the `dd` after the `dt` reading exactly that. */
export function field(scope: Page | Locator, term: string): Locator {
  return scope.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
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
