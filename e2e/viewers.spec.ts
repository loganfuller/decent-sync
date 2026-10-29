import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { machineRow, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";
import { expectTip } from "./support/tooltips.js";

// A Viewer in the management interface (ticket #376): an Admin invites one
// from the Accounts page, whose invite and access dialogs offer Viewer with no
// Locations to choose; the invite page says what a Viewer is; the header and
// the menu say "Viewer", with what that means in a tooltip; and the pages a
// Viewer opens show every state with no control that changes anything, where
// Staff see theirs. A simulated tablet running the built plugin brings its
// Library and settings; its serial is made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const val = { name: "Val Viewer", email: "val@example.com", password: "viewer password 1" };
const VIEWER_TIP = "You can see everything Staff see, and change nothing. An Admin can change your role.";

test.beforeEach(({ page }) => signInAsAdmin(page));

test("an Admin invites a Viewer, choosing no Locations, who is told what a Viewer is and is listed as one", async ({ page, browser }) => {
  await createLocation(page, "Uptown");
  await page.goto("/accounts");
  await expectTip(page.getByRole("main"), "Invite someone", /Viewers can see everything Staff see, and change nothing\.$/);
  const form = page.getByRole("form", { name: "Invite someone" });
  await form.getByLabel("Email").fill(val.email);
  await expect(form.getByRole("checkbox", { name: "Uptown" })).toBeVisible();
  await form.getByRole("combobox", { name: "Role" }).click();
  await expect(page.getByRole("option")).toHaveText(["Staff", "Admin", "Viewer"]);
  await page.getByRole("option", { name: "Viewer" }).click();
  // Like an Admin, a Viewer works at no particular Location.
  await expect(form.getByText("Locations they work at")).toHaveCount(0);
  await form.getByRole("button", { name: "Create invite" }).click();

  const notice = page.getByRole("region", { name: `Invite for ${val.email}` });
  await expect(notice).toContainText("signed in as a Viewer.");
  const link = await notice.getByRole("textbox", { name: "Invite link" }).inputValue();
  await expect(rows(page.getByRole("table", { name: "Invites" })).first().getByRole("cell").nth(1)).toHaveText("Viewer");

  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const valsPage = await context.newPage();
    await valsPage.goto(link);
    await expect(valsPage.getByText("You are invited as a Viewer, who can see everything Staff see but change nothing.")).toBeVisible();
    await valsPage.getByLabel("Name").fill(val.name);
    await valsPage.getByLabel("Password").fill(val.password);
    await valsPage.getByRole("button", { name: "Create account" }).click();
    await expect(valsPage.getByRole("heading", { name: `Welcome, ${val.name}` })).toBeVisible();
    const banner = valsPage.getByRole("banner");
    await expect(banner.getByText("Viewer", { exact: true })).toBeVisible();
    await expectTip(banner, "Viewers", VIEWER_TIP);
    await expect(banner.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Shots", "Steam Records", "Library", "Machines", "Locations"]);
  } finally {
    await context.close();
  }

  await page.reload();
  const row = rows(page.getByRole("table", { name: "Accounts" })).filter({ hasText: val.email });
  await expect(row.getByRole("cell").nth(2)).toHaveText("Viewer");
  await row.getByRole("button", { name: `Edit ${val.name}'s role` }).click();
  const dialog = page.getByRole("dialog", { name: `Role of ${val.name}` });
  await expect(dialog.getByRole("combobox", { name: "Role" })).toHaveText("Viewer");
  await expect(dialog.getByText("Locations they work at")).toHaveCount(0);
  // Made Staff, they choose Locations again.
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Staff" }).click();
  await expect(dialog.getByRole("checkbox", { name: "Uptown" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a Viewer's pages show what Staff's show, and no control that changes anything", async ({ page, browser }) => {
  const uptown = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string; name: string }[] };
  const location = uptown.locations.find(({ name }) => name === "Uptown")!;
  await tabletAt(page, server, "Uptown 1", location, "37621");
  const tool = (await (await page.request.post("/api/tools", { data: { locationId: location.id, content: { name: "Viewers' WDT" } } })).json()) as { tool: { id: string } };
  const recipe = (await (await page.request.post("/api/recipes", { data: { locationId: location.id, slot: 1, content: { name: "Viewers' Espresso" } } })).json()) as {
    recipe: { id: string };
  };
  const ids = await libraryIds(page);
  const machineId = ((await (await page.request.get("/api/machines")).json()) as { machines: { id: string }[] }).machines[0]!.id;

  /**
   * Each page, with what shows only once every part of it holding a control
   * has loaded, so a read of the page as it shows misses none (#382); a
   * control Staff working at Uptown have there, from the part that loads
   * last, which the Staff half, reading as `loaded` shows, misses if `loaded`
   * comes too early; and its filters. The Locations table of a Profile, Basket
   * or Tool shows before its rows, which wait for the list of Locations.
   */
  const PAGES: { path: string; loaded: (page: Page) => Locator; staffHave?: string; filters?: RegExp[] }[] = [
    { path: "/machines", loaded: (page) => machineRow(page, "Uptown 1") },
    { path: `/machines/${machineId}`, loaded: (page) => page.getByRole("region", { name: "General", exact: true }).getByRole("term").first(), staffHave: "button Edit General" },
    { path: "/library/beans", loaded: (page) => rows(page.getByRole("table", { name: "Beans" })).first(), staffHave: "button New Bean" },
    { path: `/library/beans/${ids.bean}`, loaded: (page) => page.getByRole("table", { name: "Batches" }), staffHave: "button Edit the coffee" },
    { path: "/library/bean-batches", loaded: (page) => rows(page.getByRole("table", { name: "Bean Batches" })).first(), staffHave: "button New batch" },
    { path: `/library/bean-batches/${ids.batch}`, loaded: uptownRow, staffHave: "button Finish it at Uptown" },
    { path: "/library/grinders", loaded: (page) => rows(page.getByRole("table", { name: "Grinders" })).first(), staffHave: "button New Grinder" },
    { path: `/library/grinders/${ids.grinder}`, loaded: (page) => page.getByRole("heading", { name: "History" }), staffHave: "button Edit the Grinder" },
    { path: "/library/profiles", loaded: (page) => rows(page.getByRole("table", { name: "Profiles" })).first() },
    { path: `/library/profiles/${encodeURIComponent(ids.profile)}`, loaded: uptownRow, staffHave: "switch Shown at Uptown" },
    { path: "/library/baskets", loaded: (page) => rows(page.getByRole("table", { name: "Baskets" })).first(), staffHave: "button New Basket", filters: EQUIPMENT_FILTERS },
    { path: `/library/baskets/${ids.basket}`, loaded: uptownRow, staffHave: "switch Shown at Uptown" },
    { path: `/library/tools/${tool.tool.id}`, loaded: uptownRow, staffHave: "switch Shown at Uptown" },
    { path: "/library/tools", loaded: (page) => rows(page.getByRole("table", { name: "Tools" })).first(), staffHave: "button New Tool", filters: EQUIPMENT_FILTERS },
    { path: "/locations", loaded: (page) => page.getByRole("list", { name: "Locations" }) },
    { path: `/locations/${location.id}`, loaded: (page) => page.getByRole("table", { name: "Recipe Slots" }), staffHave: "button New Recipe" },
    { path: `/library/recipes/${recipe.recipe.id}`, loaded: (page) => page.getByRole("heading", { name: "History" }), staffHave: "button Edit the Recipe" },
  ];

  await asNew(page, browser, "staff", location.id, async (samsPage) => {
    for (const { path, loaded, staffHave, filters } of PAGES.filter(({ staffHave }) => staffHave)) {
      await samsPage.goto(path);
      await expect(loaded(samsPage)).toBeVisible();
      expect(await changingControls(samsPage, filters), path).toContain(staffHave);
    }
  });
  await asNew(page, browser, "viewer", undefined, async (valsPage) => {
    for (const { path, loaded, filters } of PAGES) {
      await valsPage.goto(path);
      await expect(loaded(valsPage)).toBeVisible();
      expect(await changingControls(valsPage, filters), path).toEqual([]);
    }

    // States a control otherwise shows stay in view: where a Profile, Basket or Tool is shown, and a batch's remaining weight.
    for (const path of [`/library/profiles/${encodeURIComponent(ids.profile)}`, `/library/tools/${tool.tool.id}`]) {
      await valsPage.goto(path);
      await expect(rows(valsPage.getByRole("table", { name: "Locations" })).getByRole("cell")).toHaveText(["Uptown", "Yes", /./]);
    }
    // The Machine's Location, its Settings and its Live View.
    await valsPage.goto(`/machines/${machineId}`);
    await expect(valsPage.getByRole("region", { name: "Location" }).getByRole("definition").first()).toHaveText("Uptown");
    await expect(valsPage.getByRole("region", { name: "Live View" })).toBeVisible();
    await expect(valsPage.getByRole("region", { name: "General", exact: true }).getByRole("term").first()).toBeVisible();

    // The menu says so too, on a narrow screen.
    await valsPage.setViewportSize({ width: 393, height: 852 });
    await valsPage.getByRole("banner").getByRole("button", { name: "Menu" }).click();
    const menu = valsPage.getByRole("dialog", { name: "Decent Sync" });
    await expect(menu.getByText(`Signed in as ${val.name}`)).toBeVisible();
    await expect(menu.getByText("Viewer", { exact: true })).toBeVisible();
    await expectTip(menu, "Viewers", VIEWER_TIP);
  });
});

test("a page open as Staff made a Viewer meanwhile shows a Viewer's once the server refuses a change, closing the form open on it", async ({ page, browser }) => {
  const { locations } = (await (await page.request.get("/api/locations")).json()) as { locations: { id: string }[] };
  const { bean } = await libraryIds(page);
  await asNew(page, browser, "staff", locations[0]!.id, async (samsPage) => {
    await samsPage.goto(`/library/beans/${bean}`);
    const { account } = (await (await samsPage.request.get("/api/session")).json()) as { account: { id: string } };
    await samsPage.getByRole("button", { name: "Edit the coffee" }).click();
    const form = samsPage.getByRole("form", { name: "Edit the coffee" });
    await form.getByLabel("Notes").fill("Changed role notes");

    expect((await page.request.put(`/api/accounts/${account.id}/access`, { data: { role: "viewer" } })).status()).toBe(200);
    await form.getByRole("button", { name: "Save" }).click();
    await expect(samsPage.getByRole("banner").getByText("Viewer", { exact: true })).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(samsPage.getByLabel("Coffee", { exact: true })).toBeVisible();
    expect(await changingControls(samsPage)).toEqual([]);
  });
});

/** The ids of a Bean, a batch, a Grinder, a Profile and a Basket the tablet brought into the Library, once it has. */
async function libraryIds(page: Page): Promise<Record<"bean" | "batch" | "grinder" | "profile" | "basket", string>> {
  const first = async (path: string, key: string) => {
    let id: string | undefined;
    await expect
      .poll(async () => {
        id = ((await (await page.request.get(`/api/${path}`)).json()) as Record<string, { id: string }[]>)[key]?.[0]?.id;
        return id;
      })
      .toBeDefined();
    return id!;
  };
  return {
    bean: await first("beans", "beans"),
    batch: await first("bean-batches", "batches"),
    grinder: await first("grinders", "grinders"),
    profile: await first("profiles", "profiles"),
    basket: await first("baskets", "baskets"),
  };
}

/**
 * The controls in the page's main part, each as its role and name, but those
 * that only show more of what it reads: the info icons' tooltips, and the
 * page's `filters`.
 */
async function changingControls(page: Page, filters: RegExp[] = []): Promise<string[]> {
  const snapshot = await page.getByRole("main").ariaSnapshot();
  const controls = [...snapshot.matchAll(/^\s*- (button|switch|checkbox|textbox|searchbox|spinbutton|combobox|radio|slider)(?: "((?:[^"\\]|\\.)*)")?/gm)];
  return controls
    .map(([, role, name]) => `${role} ${name ?? ""}`.trim())
    .filter((control) => !/^button About /.test(control) && !filters.some((filter) => filter.test(control)));
}

/** Uptown's row in the page's Locations table, holding the controls Staff working there have, or, for a Viewer, the states they set. */
function uptownRow(page: Page): Locator {
  return rows(page.getByRole("table", { name: "Locations" })).filter({ hasText: "Uptown" });
}

/** The filters of the Baskets' and Tools' lists. */
const EQUIPMENT_FILTERS = [/^searchbox Search$/, /^combobox (Shown at|Status)$/];

/** Runs `work` with a page signed in as a new account: Staff working at the Location, or a Viewer. */
async function asNew(page: Page, browser: Browser, role: "staff" | "viewer", locationId: string | undefined, work: (page: Page) => Promise<void>) {
  const email = `${role}-${Date.now()}@example.com`;
  const response = await page.request.post("/api/invites", { data: { email, role, locationIds: locationId ? [locationId] : [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: role === "staff" ? "Sam Staff" : val.name, password: "account password 1" },
    });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
