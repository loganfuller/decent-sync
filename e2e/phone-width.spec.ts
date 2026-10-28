import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { derivedShot, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS } from "../server/test/support/simulated-tablet.js";
import { derivedSteam, withSteams } from "../server/test/support/steam-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { admin, createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// The management interface on a phone as wide as an iPhone 15, as an Admin
// and as Staff: no page is wider than the screen, and the navigation, the
// account's name and Sign out are in a menu. On a wider screen the top bar is
// the one row it was. A simulated tablet running the built plugin backfills a
// Shot and a Steam Record, so each list has a table to fit; its serial is
// made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true };
test.use(PHONE);

const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const MAIN_LINKS = ["Shots", "Steam Records", "Library", "Machines", "Locations"];

/** Each page the main navigation leads to, and what shows once its content has loaded. */
const PAGES: { link: string; heading: string; loaded: (page: Page) => Locator }[] = [
  { link: "Shots", heading: "Shots", loaded: (page) => page.getByRole("table", { name: "Shots" }) },
  { link: "Steam Records", heading: "Steam Records", loaded: (page) => page.getByRole("table", { name: "Steam Records" }) },
  { link: "Library", heading: "Beans", loaded: (page) => page.getByRole("table", { name: "Beans" }) },
  { link: "Machines", heading: "Machines", loaded: (page) => page.getByRole("table", { name: "Machines" }) },
  { link: "Locations", heading: "Locations", loaded: (page) => page.getByRole("list", { name: "Locations" }) },
  { link: "Accounts", heading: "Accounts", loaded: (page) => page.getByRole("table", { name: "Accounts" }) },
];

let uptownId: string;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("on a phone, every page fits the screen for an Admin, who reaches the navigation and Sign out in a menu", async ({ page }) => {
  const uptown = await createLocation(page, "Uptown");
  uptownId = uptown.id;
  const { machine, ...workflow } = shotFixture().workflow as Record<string, Record<string, unknown>>;
  const shot = derivedShot("phone-shot", { workflow: { ...workflow, machine: { ...machine, model: "DE1Pro", serialNumber: "17001" } } });
  await tabletAt(page, server, "Uptown 1", uptown, "17001", {
    ...withSteams(withShots({}, [shot]), [derivedSteam("phone-steam")]),
    "/beans": [],
    "/bean-batches": [],
    ...NO_DYE2_LISTS,
  });
  expect((await page.request.post("/api/beans", { data: { content: { roaster: "Roux Bakehouse", name: "House Blend" } } })).status()).toBe(201);
  for (const list of ["shots", "steam-records"]) {
    await expect.poll(async () => ((await (await page.request.get(`/api/${list}`)).json()) as { total: number }).total).toBe(1);
  }

  await visitEachPage(page, { name: admin.name, links: [...MAIN_LINKS, "Accounts"] });
});

test("on a phone, every page fits the screen for Staff too", async ({ page, browser }) => {
  const response = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [uptownId] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url(), ...PHONE });
  try {
    expect((await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam })).status()).toBe(201);
    await visitEachPage(await samsBrowser.newPage(), { name: sam.name, links: MAIN_LINKS });
  } finally {
    await samsBrowser.close();
  }
});

test("on a small phone held sideways, the menu scrolls to Sign out", async ({ browser }) => {
  // A Galaxy S5's, below md, too short for the Admin's menu, which ends at about 414 px.
  const context = await browser.newContext({ baseURL: server.url(), ...PHONE, viewport: { width: 640, height: 360 } });
  try {
    const page = await context.newPage();
    await signInAsAdmin(page);
    await page.goto("/");
    const menu = await openMenu(page, { name: admin.name, links: [...MAIN_LINKS, "Accounts"] });
    await menu.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  } finally {
    await context.close();
  }
});

test("on a wider screen, the top bar is one row with no menu", async ({ browser }) => {
  // md, where the row starts, and a desktop's.
  for (const width of [768, 1280]) {
    const context = await browser.newContext({ baseURL: server.url(), viewport: { width, height: 800 } });
    try {
      const page = await context.newPage();
      await signInAsAdmin(page);
      await page.goto("/machines");
      await expect(page.getByRole("table", { name: "Machines" })).toBeVisible();
      const bar = page.getByRole("banner");
      await expect(bar.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText([...MAIN_LINKS, "Accounts"]);
      await expect(bar.getByText(admin.name)).toBeVisible();
      await expect(bar.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Menu" })).toBeHidden();
      await expectFits(page, width);
    } finally {
      await context.close();
    }
  }
});

/**
 * Goes from page to page through the menu, checking each fits the phone's
 * width once loaded, and the Machine's page from the Machines list, then signs
 * out from the menu.
 */
async function visitEachPage(page: Page, account: { name: string; links: string[] }) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: `Welcome, ${account.name}`, level: 1 })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Main" })).toBeHidden();
  await expectFits(page);

  for (const { link, heading, loaded } of PAGES.filter(({ link }) => account.links.includes(link))) {
    const menu = await openMenu(page, account);
    await menu.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(loaded(page)).toBeVisible();
    await expectFits(page);

    if (link === "Machines") {
      await page.getByRole("link", { name: "Uptown 1" }).click();
      await expect(page.getByRole("heading", { name: "Uptown 1", level: 1 })).toBeVisible();
      await expect(page.getByRole("table", { name: "Paired devices" })).toBeVisible();
      await expectFits(page);
    }
  }

  const menu = await openMenu(page, account);
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in to Decent Sync" })).toBeVisible();
}

/** Opens the menu, which holds the account's links, its name and Sign out. */
async function openMenu(page: Page, account: { name: string; links: string[] }) {
  await page.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = page.getByRole("dialog", { name: "Decent Sync" });
  await expect(menu.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(account.links);
  // Focus starts at the first link, not Sign out, which Enter would press.
  await expect(menu.getByRole("link", { name: "Shots" })).toBeFocused();
  await expect(menu.getByText(`Signed in as ${account.name}`)).toBeVisible();
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  return menu;
}

/** The page is no wider than the screen: what is wider, such as a table, scrolls within it. */
async function expectFits(page: Page, width = 393) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: width, clientWidth: width });
}
