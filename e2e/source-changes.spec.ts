import { type Locator, type Page, expect, test } from "@playwright/test";
import { type ListedPlugin, SimulatedPlugins, bundledPlugins, recordedPlugin } from "../server/test/support/decaid-plugins.js";
import { SimulatedSkins, recordedSkin } from "../server/test/support/decaid-skins.js";
import { type FakeGitHub, githubEnv, startFakeGitHub } from "../server/test/support/fake-github.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { derivedDe1Pro } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { openCard, openRowMenu, rows } from "./support/locators.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// Changing how an installed plugin or Skin updates from its row's menu on a
// Machine's Software tab (#678, ADR-0035): each row's buttons and its menu,
// the dialog, filled in with how the item updates now and offering what it
// may change to, what Decent Sync's own plugin is held to, a Skin that comes
// with Decaid offering none, a change done with the version before and
// after and the permissions a plugin's new build adds, pinning one where it
// is now, which the server finds through a stand-in for GitHub
// (fake-github.ts), following releases in one step, and a change refused:
// for a build older than the one installed, for a source holding another
// item, and for a Tablet whose plugin is of the previous release. The
// simulated tablet runs the built plugin, its Decaid installing as Decaid
// v0.9.3 does; the phone's layout is e2e/phone-width.spec.ts's. Skins and
// plugins are recorded entries renamed to made-up repositories, and the
// serial is made up.
let github: FakeGitHub;
const server = useFreshServer(async () => {
  github = await startFakeGitHub();
  return { env: { SYNC_HEARTBEAT_SECONDS: "1", ...githubEnv(github) } };
});
test.afterAll(async () => {
  await github?.close();
});

const UPLOADER_COMMIT = "41ae8cf7f1ec7edf8c7cc1f77e800593e14aa265";
const FLIGHT_URL = "https://github.com/example/tasting-flight/releases/download/v0.2.31-flight.2/tasting-flight.js-v0.2.31-flight.2.zip";
const BOARD_URL = "https://github.com/example/menu-board/releases/download/v2.0.1/menu-board.js-v2.0.1.zip";

/** A Skin's entry as Decaid lists one, a recorded one's with another id, name, version and source. */
function exampleSkin(base: Record<string, unknown>, skin: { id: string; name: string; version: string; sourceUrl: string }): Record<string, unknown> {
  const metadata = base.reaMetadata as Record<string, unknown>;
  return { ...base, id: skin.id, name: skin.name, version: skin.version, path: `/root/.local/share/decaid/web-ui/${skin.id}`, reaMetadata: { ...metadata, skinId: skin.id, sourceUrl: skin.sourceUrl } };
}

const tastingFlight = exampleSkin(recordedSkin("streamline-cafe.js-dist"), { id: "tasting-flight.js", name: "Tasting Flight", version: "0.2.31-flight.2", sourceUrl: FLIGHT_URL });
const menuBoard = exampleSkin(recordedSkin("streamline-cafe.js-dist"), { id: "menu-board.js", name: "Menu Board", version: "2.0.1", sourceUrl: BOARD_URL });
const nightShift = exampleSkin(recordedSkin("streamline.js-dist", "branchInstalled"), { id: "night-shift.js", name: "Night Shift", version: "0.3.0-dev.12", sourceUrl: "github_branch:example/night-shift@dev" });
const released = (skin: Record<string, unknown>, repo: string, version: string) =>
  exampleSkin(recordedSkin("streamline-cafe.js", "releaseInstalled"), { id: String(skin.id), name: String(skin.name), version, sourceUrl: `github_release:${repo}@v${version}` });

/** The Uploader, following its repository's releases, derived from Decaid's shot upload plugin as recorded. */
const uploader: ListedPlugin = {
  ...recordedPlugin("shot-upload.reaplugin"),
  id: "uploader.reaplugin",
  name: "Uploader",
  version: "0.4.1",
  source: { ...recordedPlugin("decent-sync.reaplugin", "releaseInstalled").source, repo: "example/uploader", releaseTag: "v0.4.1" },
};

let frontId: string;
let skins: SimulatedSkins;
let plugins: SimulatedPlugins;

test.beforeEach(({ page }) => signInAsAdmin(page));

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const pluginRow = (page: Page, name: string) => rows(page.getByRole("table", { name: "Plugins" })).filter({ has: page.getByRole("cell", { name, exact: true }) });
const skinRow = (page: Page, name: string) => rows(page.getByRole("table", { name: "Skins" })).filter({ has: page.getByRole("cell", { name: new RegExp(`^${name}`) }) });
const cell = (row: Locator, index: number) => row.getByRole("cell").nth(index);

/** Opens the dialog that changes how a row's plugin or Skin updates, from its menu. */
async function openChange(page: Page, row: Locator, name: string): Promise<Locator> {
  await (await openRowMenu(page, row, name)).getByRole("menuitem", { name: `Change how ${name} updates` }).click();
  const dialog = page.getByRole("dialog", { name: `Change how ${name} updates` });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("each row keeps its buttons with the rest in its menu, and the dialog opens filled in with how the item updates now, offering what it may change to", async ({ page }) => {
  const corners = await createLocation(page, "Corners");
  const { machine, token } = await createMachine(page, "Front bar", corners.id);
  frontId = machine.id;
  skins = new SimulatedSkins();
  for (const skin of [nightShift, menuBoard, tastingFlight]) skins.install(skin);
  skins.makeDefault("tasting-flight.js", true);
  skins.offer({ repo: "example/tasting-flight" }, released(tastingFlight, "example/tasting-flight", "0.2.32-flight.1"));
  skins.offer({ repo: "example/menu-board" }, released(menuBoard, "example/menu-board", "2.1.0"));
  // A repository that holds another Skin than the one it is named for.
  skins.offer({ repo: "example/nsx" }, exampleSkin(recordedSkin("streamline-cafe.js", "releaseInstalled"), { id: "sidecar.js", name: "Sidecar", version: "1.0.0", sourceUrl: "github_release:example/nsx@v1.0.0" }));
  plugins = new SimulatedPlugins({ plugins: [uploader, ...bundledPlugins()] });
  // The Uploader's installed release, by its tag's commit; a branch whose build adds a permission; and one with an older build.
  github.tag("example/uploader", "v0.4.1", UPLOADER_COMMIT);
  plugins.offer("example/uploader", { branch: UPLOADER_COMMIT, commit: UPLOADER_COMMIT, manifest: uploader });
  plugins.offer("example/uploader", { branch: "next", commit: "a".repeat(40), manifest: { ...uploader, version: "0.5.0", permissions: [...uploader.permissions, "events.workflow"] } });
  plugins.offer("example/uploader", { branch: "old", commit: "b".repeat(40), manifest: { ...uploader, version: "0.4.0" } });
  server.keep(() => syncingTablet({ token }, { url: server.url() }, { api: derivedDe1Pro({ serial: "27801" }), plugins, skins })).waitForLog(/^Connected to /);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/machines/${frontId}/tablet-software`)).json()) as { tabletSoftware: { skins: unknown[] | null; plugins: unknown[] | null } }).tabletSoftware, { timeout: 20_000 })
    .toMatchObject({ skins: expect.arrayContaining([expect.objectContaining({ id: "tasting-flight.js" })]), plugins: expect.arrayContaining([expect.objectContaining({ id: "uploader.reaplugin" })]) });

  await page.goto(`/machines/${frontId}?tab=software`);
  // A plugin's row: its settings as a button, and in its menu changing how it updates, disabling it and removing it, set apart.
  await expect(pluginRow(page, "Visualizer upload").getByRole("button", { name: "Visualizer upload settings" })).toBeVisible();
  let menu = await openRowMenu(page, pluginRow(page, "Visualizer upload"), "Visualizer upload");
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Disable", "Remove"]);
  await expect(menu.getByRole("separator")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // A Skin's row: making it the default as a button, and in its menu changing how it updates and removing it. One Pinned at a
  // release's download may follow its releases instead; the default one is neither made the default nor removed.
  await expect(skinRow(page, "Night Shift").getByRole("button", { name: "Make Night Shift the default" })).toBeVisible();
  menu = await openRowMenu(page, skinRow(page, "Night Shift"), "Night Shift");
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Remove"]);
  await page.keyboard.press("Escape");
  await expect(skinRow(page, "Tasting Flight").getByRole("button", { name: /^Make / })).toHaveCount(0);
  menu = await openRowMenu(page, skinRow(page, "Tasting Flight"), "Tasting Flight");
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Follow releases instead"]);
  await page.keyboard.press("Escape");
  menu = await openRowMenu(page, skinRow(page, "Menu Board"), "Menu Board");
  await expect(menu.getByRole("menuitem")).toHaveText(["Change how it updates…", "Follow releases instead", "Remove"]);
  await page.keyboard.press("Escape");
  // One that comes with Decaid has nothing for a menu, so none, and says why its way of updating can't be changed.
  await expect(skinRow(page, "Passione").getByRole("button", { name: /^(?!About )/ })).toHaveText(["Make default"]);
  await expectTip(skinRow(page, "Passione"), "how it updates", "Decaid restores it from its own repository each time it starts, so how it updates can't be changed.");

  // The dialog for a Skin Pinned at a release's download: its URL filled in, with what such a URL means.
  let dialog = await openChange(page, skinRow(page, "Tasting Flight"), "Tasting Flight");
  await expect(dialog).toContainText("On Front bar");
  await expect(dialog).toContainText("Now: 0.2.31-flight.2 · Pinned · example/tasting-flight at v0.2.31-flight.2");
  // Already pinned, it is not offered pinning where it is now.
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  for (const choice of ["Follow releases", "Follow a branch", "Pin to a commit", "From a URL"]) await expect(dialog.getByRole("radio", { name: choice, exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "From a URL" })).toBeChecked();
  await expect(dialog.getByLabel("URL").and(dialog.getByRole("textbox"))).toHaveValue(FLIGHT_URL);
  await expect(dialog.getByRole("status")).toContainText("This Skin will be Pinned at v0.2.31-flight.2");
  await expect(dialog).toContainText("Decaid installs what the chosen source serves now, which may be another version. The default Skin stays as it is.");
  // Only the chosen way shows its fields.
  await expect(dialog.getByLabel("GitHub repository")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Follow a branch" }).click();
  // The repository is the one its release's download names.
  await expect(dialog.getByLabel("GitHub repository")).toHaveValue("example/tasting-flight");
  await expect(dialog.getByLabel("Branch", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "URL", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  // What is entered is checked before anything is asked of the Tablet.
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give a branch");
  await dialog.getByLabel("GitHub repository").fill("not a repository");
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the GitHub repository as owner/name, such as decentespresso/streamline-js. Give a branch");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // One following a branch opens on that branch.
  dialog = await openChange(page, skinRow(page, "Night Shift"), "Night Shift");
  await expect(dialog.getByRole("radio", { name: "Follow a branch" })).toBeChecked();
  await expect(dialog.getByLabel("GitHub repository")).toHaveValue("example/night-shift");
  await expect(dialog.getByLabel("Branch", { exact: true })).toHaveValue("dev");
  // A Skin is pinned to a commit by its archive, so its full id is asked for.
  await dialog.getByRole("radio", { name: "Pin to a commit" }).click();
  await dialog.getByLabel("Commit", { exact: true }).fill("5b0c8e7");
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the commit's full id, 40 characters");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // A plugin following releases opens on them, is offered no URL, and may be pinned where it is: at the commit its release's tag points at.
  dialog = await openChange(page, pluginRow(page, "Uploader"), "Uploader");
  await expect(dialog).toContainText("Now: 0.4.1 · Follows releases · example/uploader");
  await expect(dialog.getByRole("radio", { name: "Pin where it is now" })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(dialog.getByRole("radio", { name: "From a URL" })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Follow releases" })).toBeChecked();
  await expect(dialog.getByLabel("GitHub repository")).toHaveValue("example/uploader");
  await expect(dialog).toContainText("Its settings stay, and it stays enabled or disabled as it is.");
  await dialog.getByRole("radio", { name: "Pin where it is now" }).click();
  await expect(dialog).toContainText("Installs commit 41ae8cf, which v0.4.1 points at. No update check moves it.");
  await expect(dialog.getByLabel("GitHub repository")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Decent Sync's own plugin follows only its own repository's releases or is pinned to one of its commits, and says why.
  dialog = await openChange(page, pluginRow(page, "Decent Sync"), "Decent Sync");
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  for (const choice of ["Follow releases", "Pin to a commit"]) await expect(dialog.getByRole("radio", { name: choice, exact: true })).toBeVisible();
  await expect(dialog.getByLabel("GitHub repository")).toHaveCount(0);
  await expect(dialog).toContainText("Of loganfuller/decent-sync.");
  await expect(dialog).toContainText(
    "Decent Sync's own plugin only follows the releases of loganfuller/decent-sync or is pinned to one of its commits: a build from anywhere else could cut the Tablet off from the server, with no way back from here.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("a Skin Pinned at a release's download is changed to follow its repository's releases: the latest is installed over it, it stays the default, and the result gives its version before and after", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const dialog = await openChange(page, skinRow(page, "Tasting Flight"), "Tasting Flight");
  await dialog.getByRole("button", { name: "Follow releases of example/tasting-flight instead" }).click();
  await expect(dialog.getByRole("radio", { name: "Follow releases" })).toBeChecked();
  await expect(dialog.getByLabel("GitHub repository")).toHaveValue("example/tasting-flight");
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(dialog).toBeHidden();
  const status = region(page, "Skins").getByRole("status");
  await expect(status).toHaveText("DoneChanged how Tasting Flight updates · follows releases of example/tasting-flight. Done · 0.2.31-flight.2 → 0.2.32-flight.1.");
  const row = skinRow(page, "Tasting Flight");
  await expect(cell(row, 0)).toHaveText(/^Tasting Flight\s*Default\s*Showing now$/);
  await expect(cell(row, 1)).toHaveText("0.2.32-flight.1");
  await expect(cell(row, 2)).toHaveText("Follows releases · example/tasting-flight");
  expect(skins.defaultSkinId()).toBe("tasting-flight.js");
  // Following releases now, it is offered pinning where it is, and no longer following them instead.
  await expect((await openRowMenu(page, row, "Tasting Flight")).getByRole("menuitem")).toHaveText(["Change how it updates…"]);
  await page.keyboard.press("Escape");
});

test("Follow releases instead, on a Skin Pinned at a release's download, makes the change in one step, with no dialog", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  await (await openRowMenu(page, skinRow(page, "Menu Board"), "Menu Board")).getByRole("menuitem", { name: "Have Menu Board follow releases instead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(region(page, "Skins").getByRole("status")).toHaveText("DoneChanged how Menu Board updates · follows releases of example/menu-board. Done · 2.0.1 → 2.1.0.");
  await expect(cell(skinRow(page, "Menu Board"), 2)).toHaveText("Follows releases · example/menu-board");
  expect(skins.managed).toContain("POST /webui/skins/install/github-release");
});

test("a plugin is pinned where it is now, keeps its state as its source changes, and its result lists the permissions its new build adds; a build older than the one installed is refused in Decaid's words", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const status = region(page, "Plugins").getByRole("status");
  const row = pluginRow(page, "Uploader");
  await expect(cell(row, 3)).toHaveText("Enabled");

  let dialog = await openChange(page, row, "Uploader");
  await dialog.getByRole("radio", { name: "Pin where it is now" }).click();
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(status).toHaveText("DoneChanged how Uploader updates · pinned to example/uploader at 41ae8cf. Done · 0.4.1.");
  await expect(cell(row, 2)).toHaveText("Pinned · example/uploader at 41ae8cf");
  await expect(cell(row, 3)).toHaveText("Enabled");

  // Pinned there, it opens on its commit, and is no longer offered pinning where it is.
  dialog = await openChange(page, row, "Uploader");
  await expect(dialog.getByRole("radio", { name: "Pin to a commit" })).toBeChecked();
  await expect(dialog.getByLabel("Commit", { exact: true })).toHaveValue(UPLOADER_COMMIT);
  await expect(dialog.getByRole("radio", { name: "Pin where it is now" })).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Follow a branch" }).click();
  await dialog.getByLabel("Branch", { exact: true }).fill("next");
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(status).toHaveText(
    "DoneChanged how Uploader updates · follows example/uploader, next. Done · 0.4.1 → 0.5.0 · adds the permission events.workflow. Its new build holds what it adds with no approval asked, as Decaid asks for none when a plugin is installed again.",
  );
  await expect(cell(row, 1)).toHaveText("0.5.0");
  await expect(cell(row, 2)).toHaveText("Follows a branch · example/uploader, next");
  await expect(cell(row, 3)).toHaveText("Enabled");

  dialog = await openChange(page, row, "Uploader");
  await dialog.getByLabel("Branch", { exact: true }).fill("old");
  await dialog.getByRole("button", { name: "Change" }).click();
  await expect(status).toHaveText(
    "RefusedChanged how Uploader updates · follows example/uploader, old. Refused by Decaid: Plugin uploader.reaplugin 0.5.0 is installed; remove it before installing 0.4.0. Decaid installs no build older than the one installed. Removing the plugin first would delete its settings, so nothing was changed.",
  );
  await expect(cell(row, 1)).toHaveText("0.5.0");
  await expect(cell(row, 2)).toHaveText("Follows a branch · example/uploader, next");
});

test("a change to a source that holds another Skin is refused, the Skin Decaid installed beside it removed again, and the log tells each change with what came of it", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const dialog = await openChange(page, skinRow(page, "Night Shift"), "Night Shift");
  await dialog.getByRole("radio", { name: "Follow releases" }).click();
  await dialog.getByLabel("GitHub repository").fill("example/nsx");
  await dialog.getByRole("button", { name: "Change" }).click();
  const status = region(page, "Skins").getByRole("status");
  await expect(status).toHaveText(
    "RefusedChanged how Night Shift updates · follows releases of example/nsx. Refused: That source holds another Skin, Sidecar, not Night Shift. Decaid installed it beside it, and the plugin removed it again. Night Shift is unchanged.",
  );
  await expect(skinRow(page, "Sidecar")).toHaveCount(0);
  await expect(cell(skinRow(page, "Night Shift"), 2)).toHaveText("Follows a branch · example/night-shift, dev");
  expect(skins.listed().some((skin) => skin.id === "sidecar.js")).toBe(false);

  const log = await openCard(page, "Software Actions");
  const entries = rows(log.getByRole("table", { name: "Software Actions" }));
  await expect(entries.nth(0).getByRole("cell").nth(1)).toHaveText("Changed how Night Shift updates · follows releases of example/nsx");
  await expect(entries.nth(0).getByRole("cell").nth(3)).toHaveText(/^Refused: That source holds another Skin, Sidecar, not Night Shift\./);
  await expect(entries.nth(1).getByRole("cell").nth(3)).toHaveText(/^Refused by Decaid: Plugin uploader\.reaplugin 0\.5\.0 is installed/);
  await expect(entries.nth(3).getByRole("cell").nth(1)).toHaveText("Changed how Uploader updates · pinned to example/uploader at 41ae8cf");
  await expect(entries.nth(3).getByRole("cell").nth(3)).toHaveText("Done · 0.4.1");
  await expect(entries.nth(5).getByRole("cell").nth(1)).toHaveText("Changed how Tasting Flight updates · follows releases of example/tasting-flight");
  await expect(entries.nth(5).getByRole("cell").nth(3)).toHaveText("Done · 0.2.31-flight.2 → 0.2.32-flight.1");
});

test("a Tablet whose plugin is of the previous release is told to update before it is sent a change, in the dialog and by the server", async ({ page }) => {
  // The release before this spoke wire revision 5, which the server keeps from each plugin's hello.
  const db = await server.connectDatabase();
  try {
    await db.query("UPDATE machines SET wire_revision = 5 WHERE id = $1", [frontId]);
    await page.goto(`/machines/${frontId}?tab=software`);
    const dialog = await openChange(page, skinRow(page, "Night Shift"), "Night Shift");
    await expect(dialog.getByRole("alert")).toHaveText(
      /^The Tablet's plugin must update first\s*Its Decent Sync plugin is from a release before this could be changed from here\. Check the plugins for updates, then try again\.$/,
    );
    await expect(dialog.getByRole("button", { name: "Change" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // The server refuses one all the same, at once, with nothing kept.
    const made = await page.request.post(`/api/machines/${frontId}/software-actions`, {
      data: { kind: "changeSkinSource", skinId: "night-shift.js", seen: { version: "0.3.0-dev.12", updates: { how: "followsBranch", repo: "example/night-shift", branch: "dev" } }, repo: "example/night-shift" },
    });
    expect(made.status()).toBe(409);
    expect(await made.text()).toContain("The Tablet's plugin must update before it can change how a plugin or Skin updates");
    // Every other action is offered as before.
    await expect(region(page, "Skins").getByRole("button", { name: "Check Skins for updates" })).toBeEnabled();
  } finally {
    await db.query("UPDATE machines SET wire_revision = 6 WHERE id = $1", [frontId]);
    await db.end();
  }
});
