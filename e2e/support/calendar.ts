import { expect, type Locator, type Page } from "@playwright/test";

// The calendar a card's date field opens (the Machine page's Use and Activity cards).

/**
 * Picks a day in the calendar the card's field of that name opens, going to
 * its month and year first. The day is a UTC date holding its parts as the
 * wall clock reads them.
 */
export async function chooseDate(page: Page, card: Locator, name: string, chosen: Date) {
  await card.getByRole("button", { name, exact: true }).click();
  const calendar = page.getByRole("dialog");
  await calendar.getByRole("combobox", { name: "Choose the Year" }).selectOption(String(chosen.getUTCFullYear()));
  await calendar.getByRole("combobox", { name: "Choose the Month" }).selectOption({ label: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(chosen) });
  await calendar.getByRole("button", { name: new RegExp(`, \\w+ ${chosen.getUTCDate()}(st|nd|rd|th), ${chosen.getUTCFullYear()}`) }).click();
  await expect(calendar).toHaveCount(0);
}
