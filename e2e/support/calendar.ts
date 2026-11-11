import { expect, type Locator, type Page } from "@playwright/test";

// Days on the Machine page's Use and Activity cards: a Location whose day
// doesn't turn while a spec runs, and the calendar a card's date field opens.

/**
 * A time zone for a spec's Location in which no day begins while the spec
 * runs, for specs that count days back from today or read today's on a
 * page: Phoenix, 7 hours behind UTC all year, or, within three hours of
 * midnight there, Bangkok, 7 hours ahead all year. So every day there is 24
 * hours. With how many hours it is ahead of UTC, and how a time there names
 * its zone in en-US. Midnight in Phoenix is 07:00 UTC, and in Bangkok 17:00.
 */
export function farFromMidnight(): { zone: string; ahead: number; zoneName: string } {
  const hour = new Date().getUTCHours();
  return hour >= 4 && hour < 10 ? { zone: "Asia/Bangkok", ahead: 7, zoneName: "GMT+7" } : { zone: "America/Phoenix", ahead: -7, zoneName: "MST" };
}

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
