import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { useFreshServer } from "./support/fresh-server.js";
import { type JudgedShots, dateText, emptyLibrary, seedJudgedShots } from "./support/judged-shots.js";
import { boxes } from "./support/layout.js";
import { datesPreset, field, filterChip, machineRow, openCard, openMachineTab, rows } from "./support/locators.js";
import { CHECK_MS, afterDetailsPolls } from "./support/polling.js";
import { signInAsAdmin } from "./support/seed.js";

// A Machine's page in four tabs, and the Machines list that leads with the
// Machines (#545), as an Admin, at a desktop's width and at a phone's: what
// stays above the tabs, each tab opened by its link and by its address, what
// each loads only while it is open, the Workflow card naming the Loaded
// Recipe, the Shots card with what the server judged out of spec, a day
// chosen from Use, Setup's cards, and New Machine opened from its button.
// The merged Settings History is e2e/settings-history.spec.ts's and
// e2e/settings-edits.spec.ts's to cover, with a tablet that takes edits.
//
// The Locations, Machines, Recipes and Shots are those of
// support/judged-shots.ts, which describes them, with one Machine more at
// the Lab, the Bench, whose tablet stays connected. Its serial is made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

let lab: JudgedShots["lab"];
let machines: JudgedShots["machines"];
let recipes: JudgedShots["recipes"];
/** The Bench's id, and the Spare's, the Machine at no Location, which no tablet ever connected for. */
let benchId: string;
let spareId: string;

/** A phone as wide as the ticket's: 390 px. */
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** How a time reads beside what happened then: how long ago, yesterday's with its time of day, or a date. */
const RELATIVE = String.raw`(?:Just now|\d+ min ago|\d+ h ago|Yesterday, \d+:\d\d [AP]M|\d days ago|\w{3} \d+)`;
/** A regular expression of what an element reads as, each `<when>` in it a relative time, each `<range>` a middle half's range, and each space any blanks, as a line's end. */
const reads = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+").replaceAll("<when>", RELATIVE).replaceAll("<range>", String.raw`\d+\.\d–\d+\.\d`)}$`);

const tabs = (page: Page) => page.getByRole("navigation", { name: "Machine" }).getByRole("link");
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const status = (page: Page) => page.getByRole("group", { name: "Status", exact: true });
/** The names of the cards the page shows, in their order. */
const cardNames = (page: Page) => page.getByRole("main").getByRole("region").evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label")));

test.beforeEach(({ page }) => signInAsAdmin(page));

test("the Machines list leads with the Machines: each one's Location, status, Machine State, last Shot with what of it is out of spec, and Loaded Recipe with its Recipe Slot", async ({ page }) => {
  ({ lab, machines, recipes } = await seedJudgedShots(page, server));
  // The Bench, whose tablet stays connected for the tests after this one.
  const created = await page.request.post("/api/machines", { data: { name: "Lab Bench", locationId: lab.id } });
  expect(created.status(), await created.text()).toBe(201);
  const { machine: made, token } = (await created.json()) as { machine: { id: string }; token: string };
  benchId = made.id;
  const bench = server.keep(() => syncingTablet({ token }, { url: server.url() }, { api: emptyLibrary("10075") }));
  await bench.waitForLog(/^Connected to /);
  bench.reportState("idle", "idle");
  const listed = ((await (await page.request.get("/api/machines")).json()) as { machines: { id: string; name: string }[] }).machines;
  spareId = listed.find((machine) => machine.name === "Spare")!.id;

  await page.goto("/machines");
  const table = page.getByRole("table", { name: "Machines" });
  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Location", "Status", "Machine State", "Last Shot", "Loaded Recipe", "Attention"]);
  // The Machines come first: nothing stands between the page's title and them, and New Machine is a button beside the title.
  await expect(page.getByRole("form", { name: "New Machine" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Machine", exact: true })).toBeVisible();

  // The Left's tablet went while it was awake, which is marked, as the Overview marks it; its last Shot ran long against the House's Reference Shot.
  const left = machineRow(page, "Lab Left");
  await expect(left.getByRole("cell")).toHaveText(
    [reads("Lab Left"), reads("Lab"), reads("Offline Last seen <when>"), reads("Idle when last seen"), reads("<when> House · 27.0 s Out of spec: +3.5 s vs reference"), reads("2 House"), reads("")],
    { useInnerText: true },
  );
  await expect(left.getByRole("link", { name: "Lab", exact: true })).toHaveAttribute("href", `/locations/${lab.id}`);
  await expect(left.getByRole("link", { name: "House · 27.0 s" })).toHaveAttribute("href", "/shots/left-house-last");
  await expect(left.locator("[data-slot=spec-mark]")).toHaveText(["Offline", "Out of spec: +3.5 s vs reference"]);
  await expect(left.getByLabel("Slot 2", { exact: true })).toBeVisible();
  await expect(left.getByRole("link", { name: "House", exact: true })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
  // The Right's last Shot was pulled with no Recipe and weighed under its target.
  await expect(machineRow(page, "Lab Right").getByRole("cell").nth(4)).toHaveText(reads("<when> No Recipe · 25.0 s Out of spec: −6.0 g vs target"), { useInnerText: true });
  // One left asleep for the night reads muted, and one no tablet ever connected for has nothing to report.
  const harbor = machineRow(page, "Harbor 1");
  await expect(harbor.getByRole("cell").nth(2)).toHaveText(reads("Offline, asleep Last seen <when>"), { useInnerText: true });
  await expect(harbor.getByRole("cell").nth(3)).toHaveText("Asleep when last seen");
  await expect(harbor.locator("[data-slot=spec-mark]")).toHaveCount(0);
  await expect(machineRow(page, "Depot 1").getByRole("cell")).toHaveText(["Depot 1", "Depot", reads("Offline Never connected"), "Not reported", "No Shots yet", "None", "Hardware not reported"], { useInnerText: true });
  await expect(machineRow(page, "Spare").getByRole("cell")).toHaveText(["Spare", "No Location", reads("Offline Never connected"), "Not reported", "No Shots yet", "None", "Hardware not reported"], { useInnerText: true });
  // And one whose tablet is connected.
  const benchRow = machineRow(page, "Lab Bench");
  await expect(benchRow.getByRole("cell").nth(2)).toHaveText("Online");
  await expect(benchRow.getByRole("cell").nth(3)).toHaveText("Idle");
});

test("New Machine is a button that opens its form, and the Machine made joins the list", async ({ page }) => {
  await page.goto("/machines");
  await page.getByRole("button", { name: "New Machine", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Machine" });
  await expect(dialog.getByText("Its hardware is recorded from the first connection with its token.", { exact: false })).toBeVisible();
  // Cancel closes it with nothing made.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Machines" }).getByRole("row")).toHaveCount(7);

  await page.getByRole("button", { name: "New Machine", exact: true }).click();
  const form = dialog.getByRole("form", { name: "New Machine" });
  await form.getByLabel("Name").fill("Lab Extra");
  await form.getByRole("button", { name: "Create Machine" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(region(page, "Token for Lab Extra")).toBeVisible();
  await expect(machineRow(page, "Lab Extra").getByRole("cell").nth(1)).toHaveText("No Location");
});

test("above a Machine's tabs are its name and status, what it was doing, its last Shot with its mark, its Location and links to its Shots and Steam Records", async ({ page }) => {
  await page.goto("/machines");
  await machineRow(page, "Lab Left").getByRole("link", { name: "Lab Left" }).click();
  await expect(page.getByRole("heading", { name: "Lab Left", level: 1 })).toBeVisible();
  const main = page.getByRole("main");
  await expect(status(page)).toHaveText(reads("Last seen <when>, Idle then · Last Shot <when> House · 27.0 s Out of spec: +3.5 s vs reference · Lab"), { useInnerText: true });
  await expect(main.locator("[data-slot=spec-mark]").first()).toHaveText("Offline");
  await expect(status(page).getByRole("link", { name: "House · 27.0 s" })).toHaveAttribute("href", "/shots/left-house-last");
  await expect(status(page).getByRole("link", { name: "Lab", exact: true })).toHaveAttribute("href", `/locations/${lab.id}`);
  await expect(main.getByRole("link", { name: "Shots", exact: true })).toHaveAttribute("href", `/shots?machineId=${machines.left.id}`);
  await expect(main.getByRole("link", { name: "Steam Records", exact: true })).toHaveAttribute("href", `/steam-records?machineId=${machines.left.id}`);
  // The Status card is gone: the line above carries it.
  await expect(region(page, "Status")).toHaveCount(0);

  // One that is online says what it is doing, and one that never connected that it never did.
  await page.goto(`/machines/${benchId}`);
  await expect(page.getByRole("heading", { name: "Lab Bench", level: 1 })).toBeVisible();
  await expect(status(page)).toHaveText(reads("Idle · No Shots yet · Lab"), { useInnerText: true });
  await expect(main.getByText("Online", { exact: true })).toBeVisible();
  await page.goto(`/machines/${spareId}`);
  await expect(status(page)).toHaveText(reads("Never connected · No Shots yet · No Location"), { useInnerText: true });
});

test("its four tabs open by their links and by their address, Now where the address names none, and each shows only its own cards", async ({ page }) => {
  await page.goto(`/machines/${machines.left.id}`);
  await expect(tabs(page)).toHaveText(["Now", "Activity", "Settings", "Setup"]);
  const current = page.getByRole("navigation", { name: "Machine" }).locator("[aria-current=page]");
  await expect(current).toHaveText("Now");
  await expect.poll(() => cardNames(page)).toEqual(["Live View", "Workflow", "Shots"]);

  await openMachineTab(page, "Activity");
  await expect(page).toHaveURL(`/machines/${machines.left.id}?tab=activity`);
  await expect(region(page, "Use")).toBeVisible();
  // No longer behind a card that opens.
  await expect(region(page, "On one day").getByRole("tab")).toHaveText(["Dial-in trail", "Loaded Recipes", "Machine States"]);
  await expect(page.getByRole("button", { name: /^Show (Activity|On one day)$/ })).toHaveCount(0);
  await expect(region(page, "Live View")).toHaveCount(0);

  await openMachineTab(page, "Settings");
  await expect(page).toHaveURL(`/machines/${machines.left.id}?tab=settings`);
  await expect(region(page, "Paired devices")).toBeVisible();
  // One Settings History, where there were two logs.
  await expect(region(page, "Settings History")).toBeVisible();
  await expect(region(page, "Settings Edits")).toHaveCount(0);
  await expect(region(page, "Use")).toHaveCount(0);

  await openMachineTab(page, "Setup");
  await expect(page).toHaveURL(`/machines/${machines.left.id}?tab=setup`);
  await expect(region(page, "Hardware and software")).toBeVisible();
  await expect(region(page, "Settings")).toHaveCount(0);

  await openMachineTab(page, "Now");
  await expect(page).toHaveURL(`/machines/${machines.left.id}`);
  await expect(region(page, "Live View")).toBeVisible();

  // By its address, each opens on its tab, and the browser's Back goes to the one before.
  for (const [tab, name, card] of [
    ["activity", "Activity", "Use"],
    ["settings", "Settings", "Paired devices"],
    ["setup", "Setup", "Hardware and software"],
  ] as const) {
    await page.goto(`/machines/${machines.left.id}?tab=${tab}`);
    await expect(current).toHaveText(name);
    await expect(region(page, card)).toBeVisible();
    await expect(region(page, "Live View")).toHaveCount(0);
  }
  await openMachineTab(page, "Settings");
  await page.goBack();
  await expect(current).toHaveText("Setup");
  // A tab the page doesn't have is Now.
  await page.goto(`/machines/${machines.left.id}?tab=nothing`);
  await expect(current).toHaveText("Now");
  await expect(region(page, "Live View")).toBeVisible();
});

test("a tab reads what it shows only while it is open: the Live View streams on Now alone", async ({ page }) => {
  // What the page asks of the Machine, beside the Machine itself, which it reads on every tab.
  const asked: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith(`/api/machines/${benchId}/`)) asked.push(pathname.slice(`/api/machines/${benchId}/`.length));
  });
  const streamed = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/machines/${benchId}/live`);
  await page.goto(`/machines/${benchId}`);
  await streamed;
  await expect(region(page, "Workflow")).toBeVisible();
  // Now reads the Workflow and its Live View, and nothing of the other tabs.
  expect(new Set(asked)).toEqual(new Set(["live", "workflow"]));

  // Setup reads what its cards show, and no stream is opened while it is the one open.
  asked.length = 0;
  await openMachineTab(page, "Setup");
  await expect(region(page, "Library").getByRole("table")).toBeVisible();
  await expect(region(page, "Deliveries set aside")).toBeVisible();
  expect(new Set(asked)).toEqual(new Set(["tablet-versions", "collections", "sharing-status", "set-aside-deliveries"]));

  asked.length = 0;
  await openMachineTab(page, "Activity");
  await expect(region(page, "Use").getByRole("figure", { name: "Use by day" })).toBeVisible();
  await expect(region(page, "On one day").getByText("Loading")).toHaveCount(0);
  expect(new Set(asked)).toEqual(new Set(["use", "activity"]));

  // Back on Now, the stream is opened again.
  const again = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/machines/${benchId}/live`);
  await openMachineTab(page, "Now");
  await again;
});

test("what needs attention stays above the tabs, whichever is open: a new token", async ({ page }) => {
  await page.goto(`/machines/${spareId}?tab=setup`);
  await region(page, "Token").getByRole("button", { name: "Issue new token" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Issue new token" }).click();
  const notice = region(page, "Token for Spare");
  await expect(notice).toBeVisible();
  for (const tab of ["Now", "Activity", "Settings", "Setup"] as const) {
    await openMachineTab(page, tab);
    await expect(notice).toBeVisible();
    // Above the tabs, the two measured in one layout, as the page may reflow between two measurements (#635).
    const [noticeBox, tabsBox] = await boxes(notice, page.getByRole("navigation", { name: "Machine" }));
    expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(tabsBox!.y);
  }
});

test("a tab opened while scrolled down to the tabs keeps the page's scroll position while it loads, and gives the space it held back as the page is scrolled up (#641)", async ({ page }) => {
  // The Spare's tabs, which no tablet ever reported for, are shorter than its Setup, more so while they load.
  const reads = (url: URL) => url.pathname.startsWith(`/api/machines/${spareId}/`);
  const scrolled = () => page.evaluate(() => ({ y: window.scrollY, bottom: window.scrollY + window.innerHeight }));
  /** How tall the page's own content is, and the page with what is held for it. */
  const heights = () => page.evaluate(() => ({ content: document.body.offsetHeight, page: document.documentElement.scrollHeight }));
  const twoFrames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** The scroll position noted at each animation frame, from just before the tab's link was clicked. */
  const frames = () => page.evaluate(() => (window as unknown as { scrollFrames: number[] }).scrollFrames);
  for (const tab of ["Now", "Activity", "Settings"] as const) {
    await page.goto(`/machines/${spareId}?tab=setup`);
    await expect(region(page, "Token")).toBeVisible();
    await expect(page.getByRole("main").getByText("Loading", { exact: true })).toHaveCount(0);
    // Scrolled down until the tabs are at the window's top, where a reader can still click them.
    const top = await page.getByRole("navigation", { name: "Machine" }).evaluate((nav) => {
      window.scrollTo(0, Math.round(nav.getBoundingClientRect().top + window.scrollY - 16));
      return window.scrollY;
    });
    expect(top, "scrolled down Setup").toBeGreaterThan(0);

    // The tab's reads held back, so it stays as it is while loading. Each frame's scroll position is noted from before
    // the click, which goes to the link where it is, rather than scrolling it into view first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(reads, async (route) => {
      await held;
      await route.continue();
    });
    await page.evaluate(() => {
      const frames: number[] = [];
      Object.assign(window, { scrollFrames: frames });
      const note = () => {
        frames.push(window.scrollY);
        requestAnimationFrame(note);
      };
      note();
    });
    await openMachineTab(page, tab);
    // Two frames on. The tab's own content is short of the window's bottom, so only what is held kept the page there.
    await twoFrames();
    expect(new Set(await frames()), `${tab}: each frame's scroll position while it loads`).toEqual(new Set([top]));
    expect((await heights()).content, `${tab}'s content while it loads`).toBeLessThan((await scrolled()).bottom);
    // And on through its reads arriving, to two frames after it has loaded.
    release();
    await expect(page.getByRole("main").getByText("Loading", { exact: true })).toHaveCount(0);
    await twoFrames();
    expect(new Set(await frames()), `${tab}: each frame's scroll position once loaded`).toEqual(new Set([top]));
    await page.unroute(reads);
  }

  // Settings, loaded, still falls short of where the window's bottom was: what is held goes as the window is made
  // shorter, without a scroll, and as the page is scrolled up past it, and all of it at the top.
  const short = (await scrolled()).bottom - (await heights()).content;
  expect(short, "Settings, loaded, short of the window's bottom").toBeGreaterThan(1);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: viewport.height - Math.floor(short / 2) });
  await expect.poll(async () => (await heights()).page).toBe((await scrolled()).bottom);
  // Scrolled halfway up, the window's bottom may be above where the content ends: nothing is held past either.
  await page.evaluate(() => window.scrollTo(0, window.scrollY / 2));
  await expect.poll(async () => (await heights()).page).toBe(Math.max((await heights()).content, (await scrolled()).bottom));
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await heights()).page).toBe((await heights()).content);

  // At the top, nothing is held for the next tab opened, though it loads short too.
  await openMachineTab(page, "Now");
  expect(await page.evaluate(() => document.documentElement.style.minHeight)).toBe("");
});

test("Now's Workflow card names the Loaded Recipe it was loaded from, with its Recipe Slot and since when, in place of a card of its own", async ({ page }) => {
  await page.goto(`/machines/${machines.left.id}`);
  const workflow = region(page, "Workflow");
  const loaded = workflow.getByRole("group", { name: "Loaded Recipe" });
  await expect(loaded).toHaveText(/^Loaded from\s*House\s*Slot 2\s*since \w{3} \d+, \d{4}, \d+:\d\d:\d\d [AP]M$/, { useInnerText: true });
  await expect(loaded.getByRole("link", { name: "House" })).toHaveAttribute("href", `/library/recipes/${recipes.house}`);
  // With the Workflow its tablet reported, as before.
  await expect(field(workflow, "Profile")).not.toBeEmpty();
  await expect(region(page, "Loaded Recipe")).toHaveCount(0);

  // A Machine with none loaded, whose tablet reported no Workflow, says both.
  await page.goto(`/machines/${spareId}`);
  await expect(region(page, "Workflow").getByRole("group", { name: "Loaded Recipe" })).toHaveText("No Recipe is loaded.");
  await expect(region(page, "Workflow").getByText("Its tablet has not reported it yet.")).toBeVisible();
});

test("a Workflow that can't be read again says so, over the one read before", async ({ page }) => {
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${machines.left.id}`);
  const workflow = region(page, "Workflow");
  await expect(field(workflow, "Profile")).not.toBeEmpty();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  const reads = (url: URL) => url.pathname === `/api/machines/${machines.left.id}/workflow`;
  await page.route(reads, (route) => route.fulfill({ status: 500, json: { message: "Out of order" } }));
  await afterDetailsPolls(page, () => expect(page.getByRole("main").getByRole("alert")).toBeVisible({ timeout: CHECK_MS }));
  await expect(field(workflow, "Profile")).not.toBeEmpty();
  // And no longer once it is read again.
  await page.unroute(reads);
  await afterDetailsPolls(page, () => expect(page.getByRole("main").getByRole("alert")).toHaveCount(0, { timeout: CHECK_MS }));
});

test("Now's Shots card gives the Machine's Shots by Recipe over a period, marked where out of spec, each count opening those Shots", async ({ page }) => {
  await page.goto(`/machines/${machines.left.id}`);
  const card = region(page, "Shots");
  await expect(card.getByRole("tab")).toHaveText(["Today", "Yesterday", "7 days"]);
  await expect(card.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  await expect(card.getByText("9 Shots today · 1 unfinished", { exact: true })).toBeVisible();
  const table = card.getByRole("table", { name: "Shots by Recipe today" });
  await expect(table.getByRole("columnheader")).toHaveText(["Recipe", "Shots", "Duration", "vs reference", "Yield against target", "Stopped at target"]);
  // Recipe Slots in their order, then the Shots pulled with no Recipe loaded, in a row of their own.
  await expect(rows(table).getByRole("rowheader")).toHaveText([reads("1 Decaf"), reads("2 House"), "No Recipe loaded"], { useInnerText: true });
  const [decaf, house, none] = [rows(table).nth(0), rows(table).nth(1), rows(table).nth(2)];
  // The Decaf has no Reference Shot, weighed over its target and never stopped at it: both marked.
  await expect(decaf.getByRole("cell")).toHaveText(["3", /^23\.5 s \(.+\)$/, "No reference", "Out of spec: +2.5 g", "Out of spec: 0%"]);
  await expect(decaf.getByRole("link", { name: "No reference" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}&rating=rated`);
  // The House ran long against its Reference Shot, which is marked; its Unfinished Shot is beside the count.
  await expect(house.getByRole("cell")).toHaveText(["5 · 1 unfinished", /^27\.0 s \(.+\)$/, "Out of spec: +3.5 s", "−0.1 g", "100%"]);
  await expect(house.locator("[data-slot=spec-mark]")).toHaveText(["Out of spec: +3.5 s"]);
  await expect(none.getByRole("cell")).toHaveText(["1 · 1 cleaning or calibration", /^23\.5 s \(.+\)$/, "-", "−0.1 g", "100%"]);
  // A count opens its Shots in the Shots list: this Machine's, of that Recipe, over the period's preset.
  await expect(house.getByRole("link", { name: "5 Shots of House" })).toHaveAttribute("href", `/shots?recipeId=${recipes.house}&machineId=${machines.left.id}&period=today`);
  await expect(none.getByRole("link", { name: "1 Shot of no Recipe" })).toHaveAttribute("href", `/shots?recipeId=none&machineId=${machines.left.id}&period=today`);
  await house.getByRole("link", { name: "5 Shots of House" }).click();
  await expect(page.getByRole("heading", { name: "Shots", level: 1 })).toBeVisible();
  await expect(datesPreset(page, "Today")).toBeChecked();
  await expect(filterChip(page, "Machine")).toContainText("Lab Left");
  await expect(filterChip(page, "Recipe")).toContainText("House");

  // Another period, which the address keeps: the Right pulled one Decaf yesterday, and a Recipe in no slot within 7 days.
  await page.goto(`/machines/${machines.right.id}`);
  const right = region(page, "Shots");
  await right.getByRole("tab", { name: "Yesterday" }).click();
  await expect(page).toHaveURL(`/machines/${machines.right.id}?period=yesterday`);
  await expect(right.getByText("1 Shot yesterday", { exact: true })).toBeVisible();
  const yesterday = right.getByRole("table", { name: "Shots by Recipe yesterday" });
  await expect(rows(yesterday).getByRole("rowheader")).toHaveText([reads("1 Decaf")], { useInnerText: true });
  await expect(rows(yesterday).getByRole("link", { name: "1 Shot of Decaf" })).toHaveAttribute("href", `/shots?recipeId=${recipes.decaf}&machineId=${machines.right.id}&period=yesterday`);
  await page.goto(`/machines/${machines.right.id}?period=week`);
  await expect(right.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
  // And keeps through a look at another tab.
  await openMachineTab(page, "Setup");
  await expect(page).toHaveURL(`/machines/${machines.right.id}?period=week&tab=setup`);
  await openMachineTab(page, "Now");
  await expect(page).toHaveURL(`/machines/${machines.right.id}?period=week`);
  await expect(right.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
  await expect(rows(right.getByRole("table", { name: "Shots by Recipe in the last 7 days" })).getByRole("rowheader")).toHaveText([reads("1 Decaf"), reads("2 House"), "Guest", "No Recipe loaded"], {
    useInnerText: true,
  });
  // The Left pulled nothing yesterday.
  await page.goto(`/machines/${machines.left.id}?period=yesterday`);
  await expect(region(page, "Shots").getByText("It pulled no Shots yesterday.")).toBeVisible();
});

test("on Activity, choosing a day's bar in Use shows that day's lists, and its hours by hour", async ({ page }) => {
  await page.goto(`/machines/${machines.right.id}?tab=activity`);
  const use = region(page, "Use");
  const day = region(page, "On one day");
  const dayField = day.getByRole("button", { name: "Day", exact: true });
  // Today, at the Location it is at, until a day is chosen.
  await expect(dayField).toHaveText(dateText(0));
  await day.getByRole("tab", { name: "Loaded Recipes" }).click();
  const loaded = day.getByRole("table", { name: "Loaded Recipes that day" });
  await expect(rows(loaded).getByRole("link")).toHaveText(["House", "Decaf"]);

  // Yesterday's column, the last but one of the 14 charted, clicked on its bar, at the foot of the plot.
  const plot = use.getByRole("figure", { name: "Use by day" }).locator("rect.cursor-pointer");
  const box = (await plot.boundingBox())!;
  await plot.click({ position: { x: (box.width * 12.5) / 14, y: box.height - 3 } });
  await expect(dayField).toHaveText(dateText(-1));
  // Its lists are that day's: it had the Decaf loaded all of yesterday.
  await expect(rows(loaded).getByRole("link")).toHaveText(["Decaf"]);

  // A day's date in the table of numbers chooses it too, for a keyboard.
  await use.getByRole("button", { name: "Show the numbers" }).click();
  const numbers = use.getByRole("table", { name: "Use by day" });
  await expect(rows(numbers)).toHaveCount(14);
  await expect(rows(numbers).nth(12).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await rows(numbers).nth(10).getByRole("button").click();
  await expect(dayField).toHaveText(dateText(-3));
  await expect(rows(loaded).getByRole("link")).toHaveText(["Guest"]);
  // Anywhere in a day's column chooses it, as above a quiet day's bar: the day before yesterday's.
  await plot.click({ position: { x: (box.width * 11.5) / 14, y: 4 } });
  await expect(dayField).toHaveText(dateText(-2));
  await expect(rows(loaded).getByRole("link")).toHaveText(["Decaf"]);
  await rows(numbers).nth(10).getByRole("button").click();
  await expect(dayField).toHaveText(dateText(-3));
  // By hour, Use charts the hours of the day chosen, and a day chosen there is the lists' too.
  await use.getByRole("tab", { name: "By hour" }).click();
  await expect(use.getByRole("button", { name: "Day", exact: true })).toHaveText(dateText(-3));
  await expect(use.getByRole("figure", { name: "Use by hour" })).toBeVisible();
});

test("Setup holds its hardware and software in one card, its Location with its Location History, its sharing, its tablet's library, its token and its deliveries set aside", async ({ page }) => {
  await page.goto(`/machines/${machines.left.id}?tab=setup`);
  await expect.poll(() => cardNames(page)).toEqual(["Hardware and software", "Location", "Sharing", "Library", "Token", "Deliveries set aside"]);
  // What the Identity, Versions and Tablets cards held, and when it was last seen.
  const hardware = region(page, "Hardware and software");
  const part = (name: string) => hardware.locator(`dl[aria-label="${name}"]`);
  await expect(part("Hardware").locator("dt")).toHaveText(["Model", "Serial", "Identification", "Connection id", "Aliases", "Last seen"]);
  await expect(field(part("Hardware"), "Model")).toHaveText("DE1Pro");
  await expect(field(part("Hardware"), "Serial")).toHaveText("10071");
  await expect(field(part("Hardware"), "Identification")).toHaveText("Identified by its model and serial");
  await expect(field(part("Hardware"), "Last seen")).toHaveText(/^\w{3} \d+, \d{4}, /);
  await expect(part("Software").locator("dt")).toHaveText(["Firmware", "Decaid", "Plugin", "DYE2", "Streamline"]);
  await expect(field(part("Software"), "Plugin")).toHaveText(/^\d+\.\d+\.\d+/);
  await expect(part("Tablet").locator("dt")).toHaveText(["Tablet id", "First seen", "Last seen"]);
  await expect(field(part("Tablet"), "Tablet id")).toHaveText(/^[0-9a-f-]{36}$/);
  for (const gone of ["Identity", "Versions", "Tablets", "Status"]) await expect(region(page, gone)).toHaveCount(0);

  await expect(field(region(page, "Location"), "Location")).toHaveText("Lab");
  await expect(region(page, "Location").getByRole("list", { name: "Location History" }).getByRole("listitem")).toHaveCount(1);
  await expect(region(page, "Sharing").getByRole("switch")).toBeChecked();
  await expect(rows(region(page, "Library").getByRole("table", { name: "Library" })).first()).toContainText("Beans");
  await expect(region(page, "Token").getByRole("button", { name: "Issue new token" })).toBeVisible();
  // None were set aside, which it says, without standing out.
  await expect(region(page, "Deliveries set aside")).toHaveText(/None$/);
});

test.describe("on a phone", () => {
  test.use(PHONE);

  /** The page is no wider than the screen: what is wider, such as a table, scrolls within it. */
  async function expectFits(page: Page) {
    const widths = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(widths, `${page.url()} fits the screen`).toEqual({ scrollWidth: 390, clientWidth: 390 });
  }

  /**
   * A table wider than its card scrolls sideways within it, and the card then says so above it; a card whose tables
   * fit says nothing.
   */
  async function expectSaysIfItScrolls(card: Locator) {
    const wider = await card.getByRole("table").evaluateAll((tables) => tables.some((table) => table.parentElement!.scrollWidth > table.parentElement!.clientWidth));
    await expect(card.getByText("This table scrolls sideways."), `${await card.getAttribute("aria-label")} ${wider ? "scrolls" : "fits"}`).toHaveCount(wider ? 1 : 0);
  }

  /** Each element's left edge and top, to the pixel. */
  const corners = async (elements: Locator) => (await boxes(...(await elements.all()))).map((box) => ({ x: Math.round(box!.x), y: Math.round(box!.y) }));

  test("the four tabs fit one row, each tab fits the screen, the Live View's tiles are two to a row and the Shots card is a block for each Recipe", async ({ page }) => {
    await page.goto(`/machines/${benchId}`);
    await expect(page.getByRole("heading", { name: "Lab Bench", level: 1 })).toBeVisible();
    await expect(tabs(page)).toHaveText(["Now", "Activity", "Settings", "Setup"]);
    expect(new Set((await corners(tabs(page))).map((corner) => corner.y)).size).toBe(1);
    // The tiles: the Machine State's across both columns, then two to a row.
    const tiles = region(page, "Live View").getByRole("group");
    await expect(tiles.first()).toBeVisible();
    const lefts = (await corners(tiles)).map((corner) => corner.x);
    expect(lefts.length).toBeGreaterThan(4);
    expect(new Set(lefts).size).toBe(2);
    await expectFits(page);

    for (const [tab, card] of [
      ["Activity", "On one day"],
      ["Settings", "Paired devices"],
      ["Setup", "Library"],
    ] as const) {
      await openMachineTab(page, tab);
      await expect(region(page, card)).toBeVisible();
      await expect(page.getByRole("main").getByText("Loading", { exact: true })).toHaveCount(0);
      expect(new Set((await corners(tabs(page))).map((corner) => corner.y)).size).toBe(1);
      await expectFits(page);
      await expectSaysIfItScrolls(region(page, card));
      if (tab !== "Activity") continue;
      // Each of the day's lists, the Bench's tablet having reported a Workflow and a Machine State today.
      for (const list of ["Loaded Recipes", "Machine States"]) {
        await region(page, card).getByRole("tab", { name: list }).click();
        await expect(region(page, card).getByText("Loading", { exact: true })).toHaveCount(0);
        await expectFits(page);
        await expectSaysIfItScrolls(region(page, card));
      }
    }
    // The Dial-in trail and the Paired devices are wider than a phone, so each says it scrolls sideways.
    await openMachineTab(page, "Settings");
    await expect(region(page, "Paired devices").getByText("This table scrolls sideways.")).toBeVisible();
    await (await openCard(page, "Settings History")).getByText("Loading", { exact: true }).waitFor({ state: "detached" });
    await expectSaysIfItScrolls(region(page, "Settings History"));
    await expectFits(page);

    // The Right's Loaded Recipes today, a list with rows.
    await page.goto(`/machines/${machines.right.id}?tab=activity`);
    await region(page, "On one day").getByRole("tab", { name: "Loaded Recipes" }).click();
    await expect(rows(region(page, "On one day").getByRole("table", { name: "Loaded Recipes that day" }))).toHaveCount(2);
    await expectSaysIfItScrolls(region(page, "On one day"));
    await expectFits(page);

    // The Left's Shots, a block for each Recipe in place of the table, with what is out of spec marked.
    await page.goto(`/machines/${machines.left.id}`);
    const card = region(page, "Shots");
    const blocks = card.getByRole("list", { name: "Shots by Recipe today" }).getByRole("listitem");
    await expect(blocks).toHaveText(
      [
        reads("1 Decaf 3 Shots · 23.5 s (<range>) No reference Out of spec: +2.5 g vs target · Out of spec: 0% stopped at target"),
        reads("2 House 5 Shots · 27.0 s (<range>) Out of spec: +3.5 s vs reference −0.1 g vs target · 100% stopped at target 1 unfinished"),
        reads("No Recipe loaded 1 Shot · 23.5 s (<range>) −0.1 g vs target · 100% stopped at target 1 cleaning or calibration"),
      ],
      { useInnerText: true },
    );
    await expect(card.getByRole("table")).toBeHidden();
    await expectFits(page);
    // The Machines list's table scrolls within the page, which stays as wide as the screen.
    await page.goto("/machines");
    await expect(page.getByRole("table", { name: "Machines" })).toBeVisible();
    await expect(page.getByRole("main").getByText("This table scrolls sideways.")).toBeVisible();
    await expectFits(page);
  });
});
