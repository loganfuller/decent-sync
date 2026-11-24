import { type Browser, type Locator, type Page, expect, test } from "@playwright/test";
import { SimulatedPlugins, bundledPlugins } from "../server/test/support/decaid-plugins.js";
import { SimulatedSkins, recordedSkin } from "../server/test/support/decaid-skins.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { type SimulatedTablet, derivedDe1Pro } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, openCard, rows } from "./support/locators.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";
import { expectTip } from "./support/tooltips.js";

// A Machine's Skins on its Software tab (#661): the Skins with how each
// updates, what the Tablet shows above them, and the Software Actions an
// Admin makes on them: installing a Skin from a suggestion, choosing the
// default, which shows after a restart, restarting the Skin view behind a
// confirmation, checking the Skins for updates and removing one; Reload of
// a Skin that reports its page, done and not confirmed; the restart refused
// while the Machine is busy and leaving no Skin served; what Staff at the
// Machine's Location, Staff elsewhere and Viewers are offered; and starting
// Decaid's update on the Tablet, with each outcome in the log. The simulated
// tablets run the built plugin, their Decaid managing its Skins as Decaid
// v0.9.3 does (decaid-skins.ts); a Skin that reports its page is played by
// the test through the plugin's `page` endpoint. The Skins are recorded
// entries renamed to made-up repositories; serials are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const MENU_COMMIT = "5b0c8e7d2f4a6b1c3e9d8f7a6b5c4d3e2f1a0b9c";

/** A recorded Skin's entry given a made-up id, name, version and source, with the folder Decaid would keep it in. */
function exampleSkin(base: Record<string, unknown>, skin: { id: string; name: string; version: string; sourceUrl: string }): Record<string, unknown> {
  const metadata = base.reaMetadata as Record<string, unknown>;
  return { ...base, id: skin.id, name: skin.name, version: skin.version, path: `/root/.local/share/decaid/web-ui/${skin.id}`, reaMetadata: { ...metadata, skinId: skin.id, sourceUrl: skin.sourceUrl } };
}

const corner = exampleSkin(recordedSkin("streamline-cafe.js", "releaseInstalled"), { id: "corner-cafe.js", name: "Corner Cafe", version: "1.4.0", sourceUrl: "github_release:example/corner-cafe@v1.4.0" });
const nightShift = exampleSkin(recordedSkin("streamline.js-dist", "branchInstalled"), { id: "night-shift.js", name: "Night Shift", version: "0.3.0-dev.12", sourceUrl: "github_branch:example/night-shift@dev" });
const menuBoard = exampleSkin(recordedSkin("streamline-cafe.js-dist"), {
  id: "menu-board.js",
  name: "Menu Board",
  version: "2.0.1",
  sourceUrl: `https://github.com/example/menu-board/archive/${MENU_COMMIT}.zip`,
});

let corners: { id: string; name: string };
let frontId: string;
let front: SimulatedTablet;
let skins: SimulatedSkins;
let plugins: SimulatedPlugins;

test.beforeEach(({ page }) => signInAsAdmin(page));

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const strip = (page: Page) => page.getByRole("group", { name: "What the Tablet shows" });
const skinRow = (page: Page, name: string) => rows(page.getByRole("table", { name: "Skins" })).filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) });
const cell = (row: Locator, index: number) => row.getByRole("cell").nth(index);

interface Reported {
  decaid: { update: unknown };
  skins: { id: string; pageReported: boolean }[] | null;
  showing: { skin: { id: string } | null; page: { version: string | null } | null; newerInstalled: boolean; nextDefault: unknown } | null;
}
async function software(page: Page, machineId: string): Promise<Reported> {
  return ((await (await page.request.get(`/api/machines/${machineId}/tablet-software`)).json()) as { tabletSoftware: Reported }).tabletSoftware;
}

/** Reports a page to the plugin as a Skin that supports Reload does as it loads: its id, version and when it loaded, now, as the plugin's clock reads it. */
async function reportPage(tablet: SimulatedTablet, skinId: string, version: string): Promise<void> {
  const answer = await tablet.callEndpoint("page", { method: "PUT", body: { skinId, version, loadedAt: new Date().toISOString() } });
  expect(answer.status).toBe(204);
}

/** Has the test play a Skin that loads its page again when the plugin pushes a reload, reporting the fresh page. */
function reloadsWhenAsked(tablet: SimulatedTablet, skinId: string, version: string): void {
  tablet.onEmit = (event, payload) => {
    if (event === "changes" && (payload as { what?: unknown }).what === "reload") setTimeout(() => void reportPage(tablet, skinId, version), 5);
  };
}

/** Restarts the Skin view from the strip, confirming it. */
async function restart(page: Page) {
  await strip(page).getByRole("button", { name: "Restart the Skin view" }).click();
  await page.getByRole("alertdialog", { name: "Restart the Skin view?" }).getByRole("button", { name: "Restart" }).click();
}

test("an Admin reads the Skins with how each updates, installs one from a suggestion, makes it the default and restarts the Skin view onto it, checks for updates and removes one", async ({ page }) => {
  corners = await createLocation(page, "Corners");
  // Another Machine, whose Corner Cafe and Menu Board the install form suggests.
  const backSkins = new SimulatedSkins();
  backSkins.install(corner);
  backSkins.install(menuBoard);
  await tabletAt(page, server, "Back bar", corners, "27002", {}, { skins: backSkins });
  const { machine, token } = await createMachine(page, "Front bar", corners.id);
  frontId = machine.id;
  skins = new SimulatedSkins();
  skins.install(nightShift);
  skins.install(menuBoard);
  skins.offer({ repo: "example/corner-cafe" }, corner);
  plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
  front = server.keep(() => syncingTablet({ token }, { url: server.url() }, { api: derivedDe1Pro({ serial: "27001" }), plugins, skins }));
  await front.waitForLog(/^Connected to /);
  await expect.poll(async () => (await software(page, frontId)).skins?.length ?? 0, { timeout: 15_000 }).toBe(9);

  await page.goto(`/machines/${frontId}?tab=software`);
  const card = region(page, "Skins");
  const status = card.getByRole("status");
  const table = page.getByRole("table", { name: "Skins" });
  await expect(table.getByRole("columnheader")).toHaveText(["Skin", "Version", "Updates", "Actions"]);
  for (const [name, updates] of [
    ["Streamline.js", "Comes with Decaid"],
    ["Night Shift", "Follows a branch · example/night-shift, dev"],
    ["Menu Board", "Pinned at 5b0c8e7"],
    ["Passione", "Comes with Decaid"],
  ]) {
    await expect(cell(skinRow(page, name!), 2)).toHaveText(updates!);
  }
  await expectTip(skinRow(page, "Menu Board"), "how it updates", `Installed from https://github.com/example/menu-board/archive/${MENU_COMMIT}.zip, which no update check moves.`);
  await expect(cell(skinRow(page, "Streamline.js"), 0)).toHaveText(/^Streamline\.js\s*Default\s*Showing now$/);
  // The default is neither made the default again nor removed; one Decaid comes with is never removed.
  await expect(skinRow(page, "Streamline.js").getByRole("button", { name: /^(?!About )/ })).toHaveCount(0);
  await expect(skinRow(page, "Passione").getByRole("button", { name: /^(?!About )/ })).toHaveText(["Make default"]);
  await expect(skinRow(page, "Night Shift").getByRole("button", { name: /^(?!About )/ })).toHaveText(["Make default", "Remove"]);

  // Streamline doesn't report its page: the strip names it and offers only the restart.
  await expect(strip(page)).toContainText("The Tablet is serving Streamline.js.This Skin doesn't report which build it has loaded.");
  await expect(strip(page).getByRole("button", { name: /^(?!About )/ })).toHaveText(["Restart the Skin view"]);

  // A commit named as the branch is refused in the form, which points to its archive.
  await card.getByRole("button", { name: "Install Skin" }).click();
  const install = page.getByRole("dialog", { name: "Install Skin" });
  await expect(install).toContainText("On Front bar");
  await install.getByRole("radio", { name: "Branch" }).click();
  await install.getByLabel("GitHub repository").fill("example/menu-board");
  await install.getByLabel("Branch", { exact: true }).and(install.getByRole("textbox")).fill(MENU_COMMIT);
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await expect(install.getByRole("alert")).toHaveText(`Decaid installs a Skin from a commit only by its archive's URL: https://github.com/example/menu-board/archive/${MENU_COMMIT}.zip`);

  // The Back bar's Skins are suggested with how each updates, and picking one fills the form.
  const suggestions = install.getByRole("region", { name: "In use on your other Machines" });
  await expect(suggestions.getByRole("button")).toHaveText(["Corner Cafe 1.4.0 · follows releasesexample/corner-cafe · on 1 Machine", "Menu Board 2.0.1 · pinnedexample/menu-board at 5b0c8e7 · on 1 Machine"]);
  await suggestions.getByRole("button", { name: /^Menu Board/ }).click();
  await expect(install.getByRole("radio", { name: "URL" })).toBeChecked();
  await expect(install.getByLabel("URL").and(install.getByRole("textbox"))).toHaveValue(`https://github.com/example/menu-board/archive/${MENU_COMMIT}.zip`);
  await suggestions.getByRole("button", { name: /^Corner Cafe/ }).click();
  await expect(install.getByRole("radio", { name: "Latest release" })).toBeChecked();
  await expect(install.getByLabel("GitHub repository")).toHaveValue("example/corner-cafe");
  await expect(install).toContainText("A Skin newly installed is not the default: its row then offers Make default.");
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await expect(install).toHaveCount(0);
  await expect(status).toHaveText("DoneInstalled the Skin Corner Cafe · example/corner-cafe. Done · 1.4.0.");
  await expect(cell(skinRow(page, "Corner Cafe"), 2)).toHaveText("Follows releases · example/corner-cafe");

  // Made the default, it shows only after a restart, which the strip offers.
  await skinRow(page, "Corner Cafe").getByRole("button", { name: "Make Corner Cafe the default" }).click();
  await expect(status).toHaveText("DoneMade Corner Cafe the default Skin. Done. It shows once the Skin view restarts.");
  await expect(cell(skinRow(page, "Corner Cafe"), 0)).toHaveText(/^Corner Cafe\s*Default$/);
  await expect(strip(page)).toContainText("Corner Cafe is the default now, and shows after a restart of the Skin view.");

  // The restart asks first, saying what the Tablet's screen does.
  await strip(page).getByRole("button", { name: "Restart the Skin view" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Restart the Skin view?" });
  await expect(confirm).toContainText(
    "The Tablet's screen goes blank for a moment, then loads the default Skin, Corner Cafe. Anything a barista was typing is lost. A Skin that hung is loaded again this way.",
  );
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(skins.managed.filter((request) => request.includes("/webui/server/"))).toEqual([]);
  await restart(page);
  await expect(status).toHaveText("DoneRestarted the Skin view. Done · showing Corner Cafe 1.4.0.");
  await expect(strip(page)).toContainText("The Tablet is serving Corner Cafe.");
  await expect(strip(page)).not.toContainText("after a restart");
  await expect(cell(skinRow(page, "Corner Cafe"), 0)).toHaveText(/^Corner Cafe\s*Default\s*Showing now$/);

  // A newer release of Corner Cafe.
  skins.offerNewer("corner-cafe.js", "1.4.1");
  await card.getByRole("button", { name: "Check Skins for updates" }).click();
  await expect(status).toHaveText("DoneChecked Skins for updates. Done · Corner Cafe updated to 1.4.1, 9 already current.");
  await expect(cell(skinRow(page, "Corner Cafe"), 1)).toHaveText("1.4.1");

  // Removed only once confirmed.
  await skinRow(page, "Menu Board").getByRole("button", { name: "Remove Menu Board" }).click();
  const remove = page.getByRole("alertdialog", { name: "Remove Menu Board?" });
  await expect(remove).toContainText("Decaid deletes it from the Tablet. It can be installed again from here.");
  await remove.getByRole("button", { name: "Remove" }).click();
  await expect(status).toHaveText("DoneRemoved the Skin Menu Board. Done.");
  await expect(skinRow(page, "Menu Board")).toHaveCount(0);
});

test("a Skin that reports its page shows its build and since when, a newer build installed, and Reload, done or not confirmed with its note", async ({ page }) => {
  // Corner Cafe 1.4.0 loaded before its update to 1.4.1.
  await reportPage(front, "corner-cafe.js", "1.4.0");
  await expect.poll(async () => (await software(page, frontId)).showing).toMatchObject({ page: { version: "1.4.0" }, newerInstalled: true });
  await page.goto(`/machines/${frontId}?tab=software`);
  const status = region(page, "Skins").getByRole("status");
  await expect(strip(page)).toContainText(/^The Tablet is showing Corner Cafe 1\.4\.0, loaded at \w{3} \d+, \d{4}, \d+:\d\d:\d\d [AP]M\.1\.4\.1 is installed and shows after a reload\./);
  await expectTip(strip(page), "what the Tablet shows", /^As the Skin last reported, at .+, by the Tablet's clock\.$/);
  await expect(strip(page).getByRole("button", { name: /^(?!About )/ })).toHaveText(["Reload", "Restart the Skin view"]);

  reloadsWhenAsked(front, "corner-cafe.js", "1.4.1");
  await strip(page).getByRole("button", { name: "Reload" }).click();
  await expect(status).toHaveText("DoneReloaded the Skin Corner Cafe. Done · showing 1.4.1.");
  await expect(strip(page)).toContainText(/^The Tablet is showing Corner Cafe 1\.4\.1, loaded at /);
  await expect(strip(page)).not.toContainText("is installed and shows after a reload");

  // A Skin that heard the push and did not reload: its note, with the restart suggested.
  front.onEmit = undefined;
  await strip(page).getByRole("button", { name: "Reload" }).click();
  await expect(status).toHaveText(
    "Not confirmedReloaded the Skin Corner Cafe. The Skin was asked to reload, but no fresh page reported in within 15 s. Restart the Skin view to load it again.",
    { timeout: 30_000 },
  );
  await expectTip(status, "this outcome", "The Tablet asked the Skin to load its page again, but no fresh page reported in. A Skin that hung reloads only when the Skin view restarts.");
});

test("the restart is refused while the Machine is busy, and says plainly when the Tablet is left with no Skin served", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const status = region(page, "Skins").getByRole("status");
  front.reportState("espresso", "pouring");
  await restart(page);
  await expect(status).toHaveText("RefusedRestarted the Skin view. Refused: the Machine was pulling a shot.");
  front.reportState("idle", "idle");

  skins.failStarts = 2;
  await restart(page);
  await expect(status).toHaveText(
    "No Skin shownRestarted the Skin view. The Skin view did not start again, so the Tablet shows no Skin now: restart it again, or reopen Decaid at the Tablet.",
  );
  await expectTip(status, "this outcome", "Decaid's Skin server did not start again: Failed to start: SocketException: Failed to create server socket.");
  await expect(strip(page)).toContainText("The Tablet shows no Skin now.");
  await expect(strip(page).getByRole("button", { name: /^(?!About )/ })).toHaveText(["Restart the Skin view"]);
  await restart(page);
  await expect(status).toHaveText("DoneRestarted the Skin view. Done · showing Corner Cafe 1.4.1.");
  // Shown by the page Corner Cafe last reported, which it reports again as it loads.
  await expect(strip(page)).toContainText("The Tablet is showing Corner Cafe 1.4.1");
});

test("Staff at the Machine's Location are offered Reload and the restart and nothing else, and Staff elsewhere and Viewers nothing", async ({ page, browser }) => {
  await reportPage(front, "corner-cafe.js", "1.4.1");
  await expect.poll(async () => (await software(page, frontId)).showing?.page).not.toBeNull();
  reloadsWhenAsked(front, "corner-cafe.js", "1.4.1");
  await asNew(page, browser, "staff", corners.id, async (samsPage) => {
    await samsPage.goto(`/machines/${frontId}?tab=software`);
    await expect(strip(samsPage)).toContainText("The Tablet is showing Corner Cafe 1.4.1");
    expect(await offeredButtons(samsPage)).toEqual(["Reload", "Restart the Skin view"]);
    const status = region(samsPage, "Skins").getByRole("status");
    await strip(samsPage).getByRole("button", { name: "Reload" }).click();
    await expect(status).toHaveText("DoneReloaded the Skin Corner Cafe. Done · showing 1.4.1.");
    await restart(samsPage);
    await expect(status).toHaveText("DoneRestarted the Skin view. Done · showing Corner Cafe 1.4.1.");
  });
  const elsewhere = await createLocation(page, "Elsewhere");
  await asNew(page, browser, "staff", elsewhere.id, async (otherPage) => {
    await otherPage.goto(`/machines/${frontId}?tab=software`);
    await expect(strip(otherPage)).toContainText("Corner Cafe");
    expect(await offeredButtons(otherPage)).toEqual([]);
  });
  await asNew(page, browser, "viewer", undefined, async (valsPage) => {
    await valsPage.goto(`/machines/${frontId}?tab=software`);
    await expect(strip(valsPage)).toContainText("Corner Cafe");
    expect(await offeredButtons(valsPage)).toEqual([]);
  });
});

test("an Admin starts Decaid's update on the Tablet behind a confirmation, refused in plain words without Android's permission, and the log shows each outcome", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const decaid = region(page, "Decaid");
  const status = decaid.getByRole("status");
  await expect(decaid.getByRole("button", { name: "Start the update on the Tablet" })).toHaveCount(0);
  plugins.offerDecaid("0.9.4");
  await decaid.getByRole("button", { name: "Check now" }).click();
  await expect(status).toHaveText("DoneChecked for Decaid's update. Done · 0.9.4 is available.");
  const offer = decaid.getByRole("group", { name: "Decaid's update" });
  await expect(offer).toHaveText(/^Decaid 0\.9\.4 can be installed\. Someone at the Tablet taps Open once it is, as Decaid does not reopen by itself\.Start the update on the Tablet$/);

  /** Starts the update, confirming it. */
  async function start() {
    await offer.getByRole("button", { name: "Start the update on the Tablet" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Start Decaid's update on the Tablet?" });
    await expect(confirm).toContainText(
      "Decaid downloads 0.9.4 and installs it through Android's installer. Someone at the Tablet must then tap Open in the installer: Decaid does not reopen by itself, and the Machine is offline until it does.",
    );
    await confirm.getByRole("button", { name: "Start the update" }).click();
  }

  plugins.installOn = "androidNotPermitted";
  await start();
  await expect(status).toHaveText(
    "RefusedStarted Decaid's update to 0.9.4 on the Tablet. Refused: Android's permission for Decaid to install apps has not been granted on the Tablet. Someone there must allow it (Android settings, Apps, Decaid, Install unknown apps), or start the update on Decaid's own screen.",
  );
  await expectTip(status, "this outcome", "Decaid said: Installation requires approval on the Android device.");

  plugins.installOn = "linux";
  await start();
  await expect(status).toHaveText("RefusedStarted Decaid's update to 0.9.4 on the Tablet. Refused: In-app install is not supported on this platform.");

  plugins.installOn = "androidPermitted";
  await start();
  await expect(status).toHaveText(
    "DoneStarted Decaid's update to 0.9.4 on the Tablet. Done · Installing 0.9.4. Someone at the Tablet must now tap Open in Android's installer: Decaid does not reopen by itself.",
  );
  await expect(field(decaid, "Update")).toHaveText("Installing 0.9.4");
  await expect(offer).toHaveCount(0);

  // The log, newest first, with each outcome.
  const log = await openCard(page, "Software Actions");
  const table = log.getByRole("table", { name: "Software Actions" });
  const outcomes = await rows(table).evaluateAll((found) => found.map((row) => [...row.querySelectorAll("td")].slice(1).map((td) => td.textContent?.trim() ?? "")));
  const without = (made: string[]) => [made[0], made[2]];
  expect(outcomes.map(without)).toEqual([
    ["Started Decaid's update to 0.9.4 on the Tablet", "Done · Installing 0.9.4"],
    ["Started Decaid's update to 0.9.4 on the Tablet", "Refused: In-app install is not supported on this platform"],
    [
      "Started Decaid's update to 0.9.4 on the Tablet",
      "Refused: Android's permission for Decaid to install apps has not been granted on the Tablet. Someone there must allow it (Android settings, Apps, Decaid, Install unknown apps), or start the update on Decaid's own screen",
    ],
    ["Checked for Decaid's update", "Done · 0.9.4 is available"],
    ["Restarted the Skin view", "Done · showing Corner Cafe 1.4.1"],
    ["Reloaded the Skin Corner Cafe", "Done · showing 1.4.1"],
    ["Restarted the Skin view", "Done · showing Corner Cafe 1.4.1"],
    ["Restarted the Skin view", "The Skin view did not start again, so the Tablet shows no Skin now: restart it again, or reopen Decaid at the Tablet"],
    ["Restarted the Skin view", "Refused: the Machine was pulling a shot"],
    ["Reloaded the Skin Corner Cafe", "Not confirmed · The Skin was asked to reload, but no fresh page reported in within 15 s"],
    ["Reloaded the Skin Corner Cafe", "Done · showing 1.4.1"],
    ["Removed the Skin Menu Board", "Done"],
    ["Checked Skins for updates", "Done · Corner Cafe updated to 1.4.1, 9 already current"],
    ["Restarted the Skin view", "Done · showing Corner Cafe 1.4.0"],
    ["Made Corner Cafe the default Skin", "Done"],
    ["Installed the Skin Corner Cafe · example/corner-cafe", "Done · 1.4.0"],
  ]);
  // The Staff member's two are named to the Admin.
  await expect(rows(table).nth(4).getByRole("cell").nth(2)).toHaveText("Sam Staff");
});

/**
 * The controls the page's main part offers but for those that explain, those
 * that open or close a card, and the line above the tabs, whose times say
 * more on asking.
 */
async function offeredButtons(page: Page): Promise<string[]> {
  await expect(page.getByRole("main").getByText("Loading", { exact: true })).toHaveCount(0);
  const names = await page
    .getByRole("main")
    .locator("button, input, [role=switch], [role=combobox]")
    .evaluateAll((controls) => controls.filter((control) => !control.closest('[role=group][aria-label="Status"]')).map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim() ?? ""));
  return names.filter((name) => !/^About /.test(name) && !/^(Show|Hide) /.test(name));
}

/** Runs `work` with a page signed in as a new account, in a context of its own: Staff working at the Location, or a Viewer. */
async function asNew(page: Page, browser: Browser, role: "staff" | "viewer", locationId: string | undefined, work: (page: Page) => Promise<void>) {
  const email = `${role}-${Date.now()}@example.com`;
  const response = await page.request.post("/api/invites", { data: { email, role, locationIds: locationId ? [locationId] : [] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: role === "staff" ? "Sam Staff" : "Val Viewer", password: "account password 1" },
    });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
