import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { signInAsAdmin } from "./support/seed.js";

// The theme: Light, Dark or System, chosen from the header's Theme button and
// kept in the browser. System, the default, follows the device's appearance
// setting, which Playwright emulates (`page.emulateMedia`). Each test opens a
// context of its own, so it starts with nothing chosen.
const server = useFreshServer();

let context: BrowserContext;

test.beforeEach(async ({ browser }) => {
  context = await browser.newContext({ baseURL: server.url(), viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  await signInAsAdmin(await context.newPage());
});

test.afterEach(() => context.close());

test("with nothing chosen, the page follows the device, and flips when it does, without a reload", async () => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/machines");
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  await expectTheme(page, "dark");
  await expectChoice(page, "System");

  await markPage(page);
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
  await expectNotReloaded(page);
});

test("Light or Dark overrides the device, through a reload and a sign-out, and the sign-in page keeps it", async () => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/machines");
  await choose(page, "Dark");
  await expectTheme(page, "dark");
  await expectChoice(page, "Dark");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  await expectTheme(page, "dark");
  await expectChoice(page, "Dark");

  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Decent Sync" })).toBeVisible();
  await expectTheme(page, "dark");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Decent Sync" })).toBeVisible();
  await expectTheme(page, "dark");

  // Light, under a dark device.
  await signInAsAdmin(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/machines");
  await choose(page, "Light");
  await expectTheme(page, "light");
  await expectChoice(page, "Light");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  await expectTheme(page, "light");

  // Back to System, which follows the device again.
  await choose(page, "System");
  await expectTheme(page, "dark");
  await expectChoice(page, "System");
});

test("a choice made in one tab applies to the browser's other open tabs, without a reload", async () => {
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/machines");
    await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
    await markPage(page);
  }

  await choose(first, "Dark");
  await expectTheme(second, "dark");
  await expectChoice(second, "Dark");
  await choose(first, "System");
  await expectTheme(second, "light");
  await expectChoice(second, "System");
  await expectNotReloaded(second);
});

test("<html> has the theme's class and color-scheme before the app's JavaScript runs", async () => {
  const page = await context.newPage();
  // The app's JavaScript is held back, so what is set comes from index.html's own script.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/assets/*.js", async (route) => {
    await released;
    // A navigation since may have ended the request.
    await route.continue().catch(() => {});
  });
  const root = page.locator("#root");

  async function expectBeforeTheApp(path: string, theme: "light" | "dark") {
    await page.goto(path, { waitUntil: "commit" });
    await expectTheme(page, theme);
    await expect(root).toBeEmpty();
  }

  // Nothing chosen: the device's.
  await page.emulateMedia({ colorScheme: "dark" });
  await expectBeforeTheApp("/sign-in", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expectBeforeTheApp("/machines", "light");

  // A choice the app kept, which overrides the device.
  await page.evaluate(() => localStorage.setItem("decent-sync-theme", "dark"));
  await expectBeforeTheApp("/machines", "dark");
  await page.evaluate(() => localStorage.setItem("decent-sync-theme", "light"));
  await page.emulateMedia({ colorScheme: "dark" });
  await expectBeforeTheApp("/", "light");

  // Once the app runs, it reads the same choice.
  release();
  await expect(page.getByRole("heading", { name: "Welcome, Ada Admin" })).toBeVisible();
  await expectTheme(page, "light");
  await expectChoice(page, "Light");
});

/** The theme in effect: `.dark` on `<html>` or not, and the `color-scheme` native controls follow. */
async function expectTheme(page: Page, theme: "light" | "dark") {
  const html = page.locator("html");
  if (theme === "dark") await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).toHaveCSS("color-scheme", theme);
}

const ICONS = { Light: "lucide-sun", Dark: "lucide-moon", System: "lucide-monitor" } as const;

/** The header's Theme button shows the choice, not the theme in effect, and its menu has it checked. */
async function expectChoice(page: Page, choice: keyof typeof ICONS) {
  const button = page.getByRole("banner").getByRole("button", { name: "Theme" });
  await expect(button.locator("svg")).toHaveClass(new RegExp(`(^|\\s)${ICONS[choice]}(\\s|$)`));
  await button.click();
  const menu = page.getByRole("menu", { name: "Theme" });
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Light", "Dark", "System"]);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(choice);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

async function choose(page: Page, choice: keyof typeof ICONS) {
  await page.getByRole("banner").getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menu", { name: "Theme" }).getByRole("menuitemradio", { name: choice }).click();
  await expect(page.getByRole("menu", { name: "Theme" })).toBeHidden();
}

/** Marks the loaded page, which a reload would forget. */
async function markPage(page: Page) {
  await page.evaluate(() => Object.assign(window, { themeSpecMark: true }));
}

async function expectNotReloaded(page: Page) {
  expect(await page.evaluate(() => "themeSpecMark" in window)).toBe(true);
}
