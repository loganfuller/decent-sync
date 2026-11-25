import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { SimulatedPlugins, bundledPlugins, recordedPlugin } from "../server/test/support/decaid-plugins.js";
import { SimulatedSkins, recordedSkin } from "../server/test/support/decaid-skins.js";
import { derivedShot, shotFixture, withShots } from "../server/test/support/shot-fixtures.js";
import { NO_DYE2_LISTS, type SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { derivedSteam, withSteams } from "../server/test/support/steam-fixtures.js";
import { farFromMidnight } from "./support/calendar.js";
import { useFreshServer } from "./support/fresh-server.js";
import { openAccountMenu, openCard, openMachineTab } from "./support/locators.js";
import { admin, createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// The management interface on a phone as wide as an iPhone 15, as an Admin
// and as Staff: no page is wider than the screen, the navigation, the
// account's name, Connected Apps and Sign out are in a menu, and the Theme
// button stays in the top bar beside it. On a wider screen the top bar is the
// one row it was, with Connected Apps and Sign out in the account menu. A
// simulated tablet running the built plugin backfills a Shot and a Steam
// Record, so each list has a table to fit; its serial is made up. Its
// Location's today, which the Machine page's On one day card lists, doesn't
// turn while this runs (`farFromMidnight`, #587). The Software tab is
// lists on a phone, held either way, each row keeping the buttons it has on
// a wide screen with the rest of its actions in its menu (#674, #678), and
// its tables from md, fitting either way with the most it shows:
// its log open, a plugin update waiting for approval and a Skin that reports
// its page; its repositories and commits are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
const PHONE: BrowserContextOptions = { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true };
test.use(PHONE);

const TIME_TO_READY_COMMIT = "451e2bb172243153c87122d86666000d55bb162c";
const TIME_TO_READY_NEXT = "a74df584b7c1e5187a028ef2daae5ee9c59aa9f0";

const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
const MAIN_LINKS = ["Overview", "Shots", "Steam Records", "Library", "Machines", "Locations"];

/** Each page the main navigation leads to, and what shows once its content has loaded. */
const PAGES: { link: string; heading: string; loaded: (page: Page) => Locator }[] = [
  // On a phone its Shots are two-line rows, not a table (#544).
  { link: "Shots", heading: "Shots", loaded: (page) => page.getByRole("group", { name: "Shots" }) },
  { link: "Steam Records", heading: "Steam Records", loaded: (page) => page.getByRole("table", { name: "Steam Records" }) },
  // The Library opens on its Recipes (#547): a table for each Location, or that it has none.
  { link: "Library", heading: "Recipes", loaded: (page) => page.getByRole("region", { name: /^Recipes at / }).first() },
  { link: "Machines", heading: "Machines", loaded: (page) => page.getByRole("table", { name: "Machines" }) },
  { link: "Locations", heading: "Locations", loaded: (page) => page.getByRole("list", { name: "Locations" }) },
  { link: "Accounts", heading: "Accounts", loaded: (page) => page.getByRole("table", { name: "Accounts" }) },
];

/** Each tab of a Machine's page (#545), and what shows once its content has loaded. */
const MACHINE_TABS: ["Now" | "Activity" | "Settings" | "Software" | "Setup", (page: Page) => Locator][] = [
  // Shown once its tablet's Workflow has been read.
  ["Now", (page) => page.getByRole("region", { name: "Workflow" })],
  ["Activity", (page) => page.getByRole("region", { name: "On one day" }).getByRole("table")],
  ["Settings", (page) => page.getByRole("table", { name: "Paired devices" })],
  // Shown once its Tablet Software has been read: its plugins' list, which is a table on a wider screen.
  ["Software", (page) => page.getByRole("list", { name: "Plugins" })],
  // Shown once the library its tablet reported has been read.
  ["Setup", (page) => page.getByRole("region", { name: "Library" })],
];

let uptownId: string;

test.beforeEach(({ page }) => signInAsAdmin(page));

test("on a phone, every page fits the screen for an Admin, who reaches the navigation and Sign out in a menu", async ({ page }) => {
  const uptown = await createLocation(page, "Uptown", farFromMidnight().zone);
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

test("on a phone, the Software tab's plugins, Skins and Software Actions are lists, each row with its buttons and its menu as on a wide screen, and nothing on it is wider than the screen", async ({ page, browser }) => {
  const corner = await createLocation(page, "Corner");
  // Time To Ready follows a branch, whose next commit adds a permission, so its update waits for approval.
  const plugins = new SimulatedPlugins({
    plugins: bundledPlugins().map((plugin) =>
      plugin.id === "time-to-ready.reaplugin" ? { ...plugin, source: { ...recordedPlugin("dye2.reaplugin", "branchInstalled").source, repo: "example/time-to-ready", branch: "main", commit: TIME_TO_READY_COMMIT } } : plugin,
    ),
  });
  const skins = new SimulatedSkins();
  // One Skin Decaid does not come with, Pinned at one release's download, so its row has every action a Skin's can.
  const cafe = recordedSkin("streamline-cafe.js-dist");
  skins.install({ ...cafe, reaMetadata: { ...(cafe.reaMetadata as Record<string, unknown>), sourceUrl: "https://github.com/example/corner-cafe/releases/download/v1.4.0/corner-cafe.js-v1.4.0.zip" } });
  const tablet = await tabletAt(page, server, "Corner 1", corner, "17002", {}, { plugins, skins });
  const machineId = await machineIdOf(page, "Corner 1");
  await expect.poll(async () => (await tabletSoftware(page, machineId)).skins?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  await reportPage(tablet, skins.servedId()!);
  await expect.poll(async () => (await tabletSoftware(page, machineId)).showing?.page ?? null).not.toBeNull();
  const timeToReady = recordedPlugin("time-to-ready.reaplugin");
  plugins.offer("example/time-to-ready", { manifest: { ...timeToReady, version: "1.0.6", permissions: [...timeToReady.permissions, "notifications"] }, branch: "main", commit: TIME_TO_READY_NEXT });

  await page.goto(`/machines/${machineId}?tab=software`);
  const pluginsCard = page.getByRole("region", { name: "Plugins", exact: true });
  const pluginList = page.getByRole("list", { name: "Plugins" });
  await expect(pluginList).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText("This table scrolls sideways.")).toHaveCount(0);
  const pluginRow = (name: string) => pluginList.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });

  // The card's own actions are under its title, and its update check finds Time To Ready's update.
  await pluginsCard.getByRole("button", { name: "Check for updates" }).click();
  await expect(pluginsCard.getByRole("status")).toContainText("Time To Ready waits for approval.");
  await expect(pluginRow("Time To Ready")).toContainText("1.0.5 · EnabledFollows a branch · example/time-to-ready, main1.0.6 waits for approval · adds: notifications");
  // Approving it stays a button of its own, under what waits, outside the menu, as a plugin's settings do.
  await expect(pluginRow("Time To Ready").getByRole("button", { name: "Approve Time To Ready's update" })).toBeVisible();
  await expect(pluginRow("Time To Ready").getByRole("button", { name: "Actions for Time To Ready" })).toBeVisible();
  const visualizerSettings = pluginRow("Visualizer upload").getByRole("button", { name: "Visualizer upload settings" });
  await expect(visualizerSettings).toBeVisible();

  // Decent Sync's own plugin's menu only changes how it updates; another's also enables or disables it, and removes it.
  const menu = page.getByRole("menu");
  await pluginRow("Decent Sync").getByRole("button", { name: "Actions for Decent Sync" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…"]);
  await page.keyboard.press("Escape");
  const visualizer = pluginRow("Visualizer upload").getByRole("button", { name: "Actions for Visualizer upload" });
  await visualizer.click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Disable", "Remove"]);
  // Remove is set apart, and asks first.
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await menu.getByRole("menuitem", { name: "Remove Visualizer upload" }).click();
  const remove = page.getByRole("alertdialog", { name: "Remove Visualizer upload?" });
  await expect(remove).toBeVisible();
  await remove.getByRole("button", { name: "Cancel" }).click();
  await expect(remove).toBeHidden();
  await expect(visualizer).toBeFocused();
  // Changing how it updates opens in the dialog it opens in on a wide screen, and the focus goes back to the menu's button.
  await visualizer.click();
  await menu.getByRole("menuitem", { name: "Change how Visualizer upload updates" }).click();
  const source = page.getByRole("dialog", { name: "Change how Visualizer upload updates" });
  await expect(source).toBeVisible();
  // It fits the phone's screen, with nothing in it reaching past it.
  expect(await source.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  await source.getByRole("button", { name: "Cancel" }).click();
  await expect(source).toBeHidden();
  await expect(visualizer).toBeFocused();
  // Its settings open in the dialog they open in on a wide screen.
  await visualizerSettings.click();
  const settings = page.getByRole("dialog", { name: "Visualizer upload settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Cancel" }).click();
  await expect(settings).toBeHidden();
  // What is typed in a dialog stays as the phone turns past md: in a plugin's settings, whose list holds until they close, and in installing one.
  // Each is checked once the rest of the tab has turned (found by CSS, as the modal hides it from roles): a dialog the layout's change closed is there until it renders.
  const smallButtons = page.locator("main button[data-size=sm]");
  const listedPlugins = page.locator('ul[aria-label="Plugins"]');
  await visualizerSettings.click();
  await settings.getByLabel("Visualizer username", { exact: true }).fill("front-bar");
  await page.setViewportSize({ width: 852, height: 393 });
  await expect(smallButtons.first()).toBeAttached();
  await expect(listedPlugins).toBeAttached();
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Visualizer username", { exact: true })).toHaveValue("front-bar");
  await settings.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("table", { name: "Plugins" })).toBeVisible();
  await pluginsCard.getByRole("button", { name: "Install plugin" }).click();
  const install = page.getByRole("dialog", { name: "Install plugin" });
  await install.getByLabel("GitHub repository").fill("example/uploader");
  await page.setViewportSize(PHONE.viewport!);
  await expect(listedPlugins).toBeAttached();
  await expect(smallButtons).toHaveCount(0);
  await expect(install).toBeVisible();
  await expect(install.getByLabel("GitHub repository")).toHaveValue("example/uploader");
  await install.getByRole("button", { name: "Cancel" }).click();
  await expect(install).toBeHidden();
  await expect(pluginList).toBeVisible();
  // An action made from the menu.
  await visualizer.click();
  await menu.getByRole("menuitem", { name: "Disable Visualizer upload" }).click();
  await expect(pluginsCard.getByRole("status")).toHaveText("DoneDisabled Visualizer upload. Done.");
  await expect(pluginRow("Visualizer upload")).toContainText(" · Disabled");

  // The Skins: the default, which nothing is offered for, has neither a button nor a menu; another that comes with Decaid has only
  // the button making it the default; and one that doesn't has that button and, in its menu, the rest.
  const skinList = page.getByRole("list", { name: "Skins" });
  const defaultSkin = skinList.getByRole("listitem").filter({ has: page.getByText("Default", { exact: true }) });
  await expect(defaultSkin).toHaveCount(1);
  await expect(defaultSkin).toContainText(/^Streamline\.js\s*Default\s*Showing now/);
  await expect(defaultSkin.getByRole("button", { name: /^(?!About )/ })).toHaveCount(0);
  const passione = skinList.getByRole("listitem").filter({ has: page.getByText("Passione", { exact: true }) });
  await expect(passione.getByRole("button", { name: "Make Passione the default" })).toBeVisible();
  await expect(passione.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
  const cafeDev = skinList.getByRole("listitem").filter({ has: page.getByText("Streamline Cafe Dev", { exact: true }) });
  await expect(cafeDev).toContainText("Pinned · example/corner-cafe at v1.4.0");
  await expect(cafeDev.getByRole("button", { name: "Make Streamline Cafe Dev the default" })).toBeVisible();
  await cafeDev.getByRole("button", { name: "Actions for Streamline Cafe Dev" }).click();
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Follow releases instead", "Remove"]);
  await page.keyboard.press("Escape");
  // The strip's actions, under what it says.
  const strip = page.getByRole("group", { name: "What the Tablet shows" });
  await expect(strip.getByRole("button", { name: /^(?!About )/ })).toHaveText(["Reload", "Restart the Skin view"]);

  // The log, open, as a list of what each did, what came of it, then when and who.
  const log = await openCard(page, "Software Actions");
  const entries = log.getByRole("list", { name: "Software Actions" }).getByRole("listitem");
  await expect(entries.first()).toContainText(/^Disabled Visualizer upload\.?Done.*· You$/);
  // Every button on the tab is the default size, not the small one.
  await expect(page.locator("main button[data-size=sm]")).toHaveCount(0);
  await expectFits(page);
  await expectTabFits(page);

  // Below md, as on a phone held sideways, still its lists; from md, as wide as a tablet held upright, its tables. Each fits.
  for (const [width, layout] of [
    [640, "list"],
    [768, "table"],
  ] as const) {
    const context = await browser.newContext({ baseURL: server.url(), viewport: { width, height: 1024 } });
    try {
      const wider = await context.newPage();
      await signInAsAdmin(wider);
      await wider.goto(`/machines/${machineId}?tab=software`);
      for (const name of ["Plugins", "Skins"]) await expect(wider.getByRole(layout, { name })).toBeVisible();
      await expect(wider.getByRole("button", { name: "Approve Time To Ready's update" })).toBeVisible();
      await openCard(wider, "Software Actions");
      await expect(wider.getByRole(layout, { name: "Software Actions" })).toBeVisible();
      await expectFits(wider, width);
      await expectTabFits(wider);
    } finally {
      await context.close();
    }
  }
});

test("on a small phone held sideways, the menu scrolls to Sign out", async ({ browser }) => {
  // A Galaxy S5's, below lg, too short for the Admin's menu, which ends at about 414 px.
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
  // lg, where the row starts, and a desktop's.
  for (const width of [1024, 1280]) {
    const context = await browser.newContext({ baseURL: server.url(), viewport: { width, height: 800 } });
    try {
      const page = await context.newPage();
      await signInAsAdmin(page);
      await page.goto("/machines");
      await expect(page.getByRole("table", { name: "Machines" })).toBeVisible();
      const bar = page.getByRole("banner");
      await expect(bar.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText([...MAIN_LINKS, "Accounts"]);
      await expect(bar.getByRole("button", { name: "Theme" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Menu" })).toBeHidden();
      await expectFits(page, width);
      const accountMenu = await openAccountMenu(page, admin.name);
      await expect(accountMenu.getByRole("menuitem")).toHaveText(["Connected Apps", "Sign out"]);
    } finally {
      await context.close();
    }
  }
});

/**
 * Goes from page to page through the menu, checking each fits the phone's
 * width once loaded, and each tab of the Machine's page from the Machines
 * list, then signs out from the menu.
 */
async function visitEachPage(page: Page, account: { name: string; links: string[] }) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  // With Uptown's block, its Machine's status card, once its numbers have arrived: e2e/overview.spec.ts covers a block
  // with a table on a phone.
  await expect(page.getByRole("list", { name: "Machines at Uptown" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByText("No Shots were pulled here today.")).toBeVisible();
  await expect(page.getByRole("banner").getByRole("navigation", { name: "Main" })).toBeHidden();
  await expectFits(page);
  await expectThemeInReach(page);

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
      for (const [tab, loaded] of MACHINE_TABS) {
        await openMachineTab(page, tab);
        await expect(loaded(page)).toBeVisible();
        await expectFits(page);
      }
    }
    if (link === "Locations") {
      // The Location's page, whose Overview block has its choice of period beside its title.
      await page.getByRole("list", { name: "Locations" }).getByRole("link", { name: "Uptown" }).click();
      await expect(page.getByRole("heading", { name: "Uptown", level: 1 })).toBeVisible();
      await expect(page.getByRole("list", { name: "Machines at Uptown" }).getByRole("listitem")).toHaveCount(1);
      await expect(page.getByText("No Shots were pulled here today.")).toBeVisible();
      await expectFits(page);
    }
  }

  const menu = await openMenu(page, account);
  await menu.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in to Decent Sync" })).toBeVisible();
}

/** Opens the menu, which holds the main navigation, the account's name, Connected Apps and Sign out. */
async function openMenu(page: Page, account: { name: string; links: string[] }) {
  await page.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = page.getByRole("dialog", { name: "Decent Sync" });
  await expect(menu.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(account.links);
  // Focus starts at the first link, not Sign out, which Enter would press.
  await expect(menu.getByRole("link", { name: "Overview" })).toBeFocused();
  await expect(menu.getByText(`Signed in as ${account.name}`)).toBeVisible();
  await expect(menu.getByRole("navigation", { name: "Account" }).getByRole("link")).toHaveText(["Connected Apps"]);
  await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();
  return menu;
}

/** The Theme button is in the top bar, on the screen, not in the menu, and opens its choices. */
async function expectThemeInReach(page: Page) {
  const theme = page.getByRole("banner").getByRole("button", { name: "Theme" });
  await expect(theme).toBeInViewport({ ratio: 1 });
  await theme.click();
  const choices = page.getByRole("menu", { name: "Theme" });
  await expect(choices).toBeInViewport({ ratio: 1 });
  await expect(choices.getByRole("menuitemradio")).toHaveText(["Light", "Dark", "System"]);
  await page.keyboard.press("Escape");
  await expect(choices).toBeHidden();
}

/** A Machine's id, by its name. */
async function machineIdOf(page: Page, name: string): Promise<string> {
  const { machines } = (await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] };
  return machines.find((machine) => machine.name === name)!.id;
}

interface Reported {
  skins: unknown[] | null;
  showing: { page: unknown } | null;
}
async function tabletSoftware(page: Page, machineId: string): Promise<Reported> {
  return ((await (await page.request.get(`/api/machines/${machineId}/tablet-software`)).json()) as { tabletSoftware: Reported }).tabletSoftware;
}

/** Reports a page to the plugin as a Skin that supports Reload does as it loads: its id, a version and when it loaded, now, as the plugin's clock reads it. */
async function reportPage(tablet: SimulatedTablet, skinId: string): Promise<void> {
  const answer = await tablet.callEndpoint("page", { method: "PUT", body: { skinId, version: "0.2.31", loadedAt: new Date().toISOString() } });
  expect(answer.status).toBe(204);
}

/**
 * Nothing on the Software tab is wider than what holds it: each of its
 * cards lies within the page's main column, each thing in a card within the
 * card, which would clip it, and nothing scrolls sideways within them.
 */
async function expectTabFits(page: Page) {
  const overflowing = await page.evaluate(() => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const found: string[] = [];
    const describe = (element: Element) => `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}"`;
    for (const name of ["Decaid", "Plugins", "Skins", "Software Actions"]) {
      const card = document.querySelector(`[role=region][aria-label="${name}"]`);
      if (!card) {
        found.push(`no ${name} card`);
        continue;
      }
      const box = card.getBoundingClientRect();
      if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push(`the ${name} card is wider than the page's column`);
      for (const element of [card, ...card.querySelectorAll("*")]) {
        if (element.getClientRects().length === 0 || element.closest(".sr-only")) continue;
        const own = element.getBoundingClientRect();
        if (own.left < box.left - 0.5 || own.right > box.right + 0.5) found.push(`${describe(element)} in ${name} reaches past the card`);
        if (element.scrollWidth > element.clientWidth + 0.5 && ["auto", "scroll"].includes(getComputedStyle(element).overflowX)) found.push(`${describe(element)} in ${name} scrolls sideways`);
      }
    }
    return found;
  });
  expect(overflowing, `${new URL(page.url()).pathname}'s Software tab fits`).toEqual([]);
}

/** The page is no wider than the screen: what is wider, such as a table, scrolls within it. */
async function expectFits(page: Page, width = 393) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect({ scrollWidth, clientWidth }, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: width, clientWidth: width });
}
