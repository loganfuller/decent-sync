import { type Browser, type Locator, type Page, expect, test } from "@playwright/test";
import { type ListedPlugin, SimulatedPlugins, bundledPlugins, recordedPlugin, skinsOn093 } from "../server/test/support/decaid-plugins.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { RawConnection, type SimulatedTablet, derivedDe1Pro, helloWith } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { boxes } from "./support/layout.js";
import { field, openCard, openMachineTab, rows } from "./support/locators.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";
import { expectTip } from "./support/tooltips.js";

// A Machine's Software tab (#660): its Tablet Software, Decaid, the plugins
// with how each updates and the Skins, and the Software Actions an Admin
// makes on them: checking for Decaid's update and the plugins', approving
// an update that waits, installing a plugin from a suggestion or a typed
// repository, enabling and disabling one, changing its settings, a secret
// among them, removing one behind a confirmation, and the automatic update
// checks' Settings Edit, with the log of them all, which starts closed. An
// action is refused while the Machine is busy, at once while it is offline,
// and not at all where the Tablet's plugin is from before Software Actions.
// Staff read the lists and the log and are offered only the restart of the
// Skin view; Viewers are e2e/viewers.spec.ts's, and the Skins' actions
// e2e/software-skins.spec.ts's. The simulated tablets run the built plugin, their
// Decaid managing its plugins as Decaid v0.9.3 does (decaid-plugins.ts);
// the repositories, commits, serials and settings are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

const SETTINGS_VIEWER_COMMIT = "0659563fed357054181a4753274392feec810ae6";
const UPLOADER_COMMIT = "41ae8cf7f1ec7edf8c7cc1f77e800593e14aa265";
const TIME_TO_READY_COMMIT = "451e2bb172243153c87122d86666000d55bb162c";
const TIME_TO_READY_NEXT = "a74df584b7c1e5187a028ef2daae5ee9c59aa9f0";

/** A source as Decaid's list records a branch install, derived from the one recorded for DYE2's: a commit's for a pinned one. */
function branchSource(repo: string, branch: string, commit: string): Record<string, unknown> {
  return { ...recordedPlugin("dye2.reaplugin", "branchInstalled").source, repo, branch, commit };
}

/** A source as Decaid's list records a latest release install, derived from the one recorded for Decent Sync's. */
function releaseSource(repo: string, tag: string): Record<string, unknown> {
  return { ...recordedPlugin("decent-sync.reaplugin", "releaseInstalled").source, repo, releaseTag: tag };
}

/** The Uploader, derived from Decaid's shot upload plugin as recorded, as the server's tests derive it. */
const uploader = { ...recordedPlugin("shot-upload.reaplugin"), id: "uploader.reaplugin", name: "Uploader", version: "0.4.1" };

/**
 * The Front bar's plugins: those a new Decaid v0.9.3 lists, Time To Ready
 * following a branch, the Settings Viewer pinned at a commit and the shot
 * upload following releases.
 */
function frontPlugins(): ListedPlugin[] {
  return bundledPlugins().map((plugin) => {
    if (plugin.id === "time-to-ready.reaplugin") return { ...plugin, source: branchSource("example/time-to-ready", "main", TIME_TO_READY_COMMIT) };
    if (plugin.id === "settings.reaplugin") return { ...plugin, source: branchSource("example/settings-viewer", SETTINGS_VIEWER_COMMIT, SETTINGS_VIEWER_COMMIT) };
    if (plugin.id === "shot-upload.reaplugin") return { ...plugin, source: releaseSource("example/shot-upload", "v0.2.4") };
    return plugin;
  });
}

let mainStreet: { id: string; name: string };
let frontId: string;
let front: SimulatedTablet;
let managed: SimulatedPlugins;

test.beforeEach(({ page }) => signInAsAdmin(page));

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/** A plugin's row in the Plugins table, by the name it reports. */
const pluginRow = (page: Page, name: string) => rows(page.getByRole("table", { name: "Plugins" })).filter({ has: page.getByRole("cell", { name, exact: true }) });
const cell = (row: Locator, index: number) => row.getByRole("cell").nth(index);

interface Reported {
  decaid: { update: unknown; automaticUpdateCheck: boolean | null };
  plugins: { id: string; settings: { name: string; value?: unknown }[] }[] | null;
  skins: unknown[] | null;
}
async function software(page: Page, machineId: string): Promise<Reported> {
  return ((await (await page.request.get(`/api/machines/${machineId}/tablet-software`)).json()) as { tabletSoftware: Reported }).tabletSoftware;
}

test("an Admin reads the Tablet's Decaid, plugins and Skins with how each updates, checks for Decaid's update and the plugins', and approves one that waits", async ({ page }) => {
  mainStreet = await createLocation(page, "Main Street");
  // Another Machine, whose Uploader is pinned at a commit: the install form suggests it later.
  await tabletAt(page, server, "Back bar", mainStreet, "26002", skinsOn093(), {
    plugins: new SimulatedPlugins({ plugins: [...bundledPlugins(), { ...uploader, loaded: true, autoLoad: true, source: branchSource("example/uploader", UPLOADER_COMMIT, UPLOADER_COMMIT), pendingUpdate: null }] }),
  });
  const { machine, token } = await createMachine(page, "Front bar", mainStreet.id);
  frontId = machine.id;
  managed = new SimulatedPlugins({ plugins: frontPlugins() });
  front = server.keep(() => syncingTablet({ token }, { url: server.url() }, { api: { ...derivedDe1Pro({ serial: "26001" }), ...skinsOn093() }, plugins: managed }));
  await front.waitForLog(/^Connected to /);
  await expect.poll(async () => (await software(page, frontId)).plugins?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await software(page, frontId)).decaid.update).not.toBeNull();
  await expect.poll(async () => (await software(page, frontId)).skins).not.toBeNull();

  await page.goto(`/machines/${frontId}?tab=software`);
  const decaid = region(page, "Decaid");
  await expect(field(decaid, "Version")).toHaveText("0.9.3 · build 3265");
  await expect(field(decaid, "Update")).toHaveText("Up to date");
  await expect(field(decaid, "Automatic update checks")).toHaveText("On, every 12 hoursEdit");
  // Nothing says the checks are off.
  await expect(page.getByText("Automatic update checks are off")).toHaveCount(0);

  // Each plugin, with how it updates and from where, and whether it is enabled.
  const table = page.getByRole("table", { name: "Plugins" });
  await expect(table.getByRole("columnheader")).toHaveText(["Plugin", "Version", "Updates", "State", "Actions"]);
  for (const [name, updates] of [
    ["Decent Sync", "Not updated"],
    ["Time To Ready", "Follows a branch · example/time-to-ready, main"],
    ["Settings Viewer", "Pinned · example/settings-viewer at 0659563"],
    ["Decent shot upload", "Follows releases · example/shot-upload"],
    ["Visualizer upload", "Not updated"],
  ]) {
    await expect(cell(pluginRow(page, name!), 2)).toHaveText(updates!);
    await expect(cell(pluginRow(page, name!), 3)).toHaveText("Enabled");
  }
  await expect(cell(pluginRow(page, "Time To Ready"), 1)).toHaveText("1.0.5");
  await expectTip(pluginRow(page, "Settings Viewer"), "how it updates", "Installed from one fixed build, which no update check moves.");
  // Decent Sync's own plugin has its settings and nothing that would cut the Tablet off.
  await expect(pluginRow(page, "Decent Sync").getByRole("button", { name: /^(?!About )/ })).toHaveText(["Settings"]);
  await expect(pluginRow(page, "Visualizer upload").getByRole("button", { name: /^(?!About )/ })).toHaveText(["Settings", "Disable", "Remove"]);

  // The Skins: the default one marked, each one that comes with Decaid saying what Decaid may do as it starts.
  const skins = page.getByRole("table", { name: "Skins" });
  await expect(skins.getByRole("columnheader")).toHaveText(["Skin", "Version", "Updates", "Actions"]);
  const defaultSkin = rows(skins).filter({ has: page.getByText("Default", { exact: true }) });
  await expect(defaultSkin).toHaveCount(1);
  await expect(cell(defaultSkin, 0)).toHaveText(/^Streamline\.js\s*Default\s*Showing now$/);
  await expect(cell(defaultSkin, 2)).toHaveText("Comes with Decaid");
  await expectTip(defaultSkin, "how it updates", "Decaid may put its latest release back when it starts.");
  // Neither made the default again nor removed.
  await expect(defaultSkin.getByRole("button", { name: /^(?!About )/ })).toHaveCount(0);

  // Decaid finds a newer release of itself.
  managed.offerDecaid("0.9.4");
  await decaid.getByRole("button", { name: "Check now" }).click();
  await expect(decaid.getByRole("status")).toHaveText("DoneChecked for Decaid's update. Done · 0.9.4 is available.");
  await expect(field(decaid, "Update")).toHaveText("0.9.4 is available");

  // A newer release of the shot upload, and a newer commit of Time To Ready's branch, which adds a permission.
  managed.offer("example/shot-upload", { manifest: { ...recordedPlugin("shot-upload.reaplugin"), version: "0.2.5" }, tag: "v0.2.5" });
  const timeToReady = recordedPlugin("time-to-ready.reaplugin");
  managed.offer("example/time-to-ready", { manifest: { ...timeToReady, version: "1.0.6", permissions: [...timeToReady.permissions, "notifications"] }, branch: "main", commit: TIME_TO_READY_NEXT });
  const plugins = region(page, "Plugins");
  await plugins.getByRole("button", { name: "Check for updates" }).click();
  await expect(plugins.getByRole("status")).toContainText("Checked plugins for updates. Done · Decent shot upload updated to 0.2.5, 1 already current, Time To Ready waits for approval.");
  await expect(cell(pluginRow(page, "Decent shot upload"), 1)).toHaveText("0.2.5");
  await expect(cell(pluginRow(page, "Time To Ready"), 2)).toHaveText("Follows a branch · example/time-to-ready, main1.0.6 waits for approval · adds: notifications");

  await pluginRow(page, "Time To Ready").getByRole("button", { name: "Approve Time To Ready's update" }).click();
  await expect(plugins.getByRole("status")).toHaveText("DoneApproved Time To Ready's update to 1.0.6. Done · 1.0.6.");
  await expect(cell(pluginRow(page, "Time To Ready"), 1)).toHaveText("1.0.6");
  await expect(cell(pluginRow(page, "Time To Ready"), 2)).toHaveText("Follows a branch · example/time-to-ready, main");
});

test("an Admin installs a plugin from a suggestion, enables it, changes another's settings with a secret it never shows, disables one and removes one behind a confirmation", async ({ page }) => {
  managed.offer("example/uploader", { manifest: uploader, branch: UPLOADER_COMMIT, commit: UPLOADER_COMMIT });
  await page.goto(`/machines/${frontId}?tab=software`);
  const plugins = region(page, "Plugins");
  const status = plugins.getByRole("status");

  // A repository that isn't one is refused in the form, which stays open.
  await plugins.getByRole("button", { name: "Install plugin" }).click();
  const install = page.getByRole("dialog", { name: "Install plugin" });
  await expect(install).toContainText("On Front bar");
  await install.getByLabel("GitHub repository").fill("not a repository");
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await expect(install.getByRole("alert")).toHaveText("Give the GitHub repository as owner/name, such as decentespresso/dye2");

  // The Back bar's Uploader is suggested, and picking it fills the form.
  const suggestions = install.getByRole("region", { name: "In use on your other Machines" });
  await expect(suggestions.getByRole("button")).toHaveText(["Uploader 0.4.1 · pinnedexample/uploader at 41ae8cf · on 1 Machine"]);
  await suggestions.getByRole("button").click();
  await expect(install.getByLabel("GitHub repository")).toHaveValue("example/uploader");
  await expect(install.getByRole("radio", { name: "Branch or commit" })).toBeChecked();
  await expect(install.getByLabel("Branch or commit", { exact: true }).and(install.getByRole("textbox"))).toHaveValue(UPLOADER_COMMIT);
  await expect(install).toContainText("A commit stays pinned. A branch follows its newest commit.");
  await expect(install).toContainText("A plugin newly installed is not enabled: its row then offers Enable.");
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await expect(install).toHaveCount(0);
  await expect(status).toHaveText("DoneInstalled the plugin Uploader · example/uploader at 41ae8cf. Done · 0.4.1.");
  const uploaderRow = pluginRow(page, "Uploader");
  await expect(cell(uploaderRow, 2)).toHaveText("Pinned · example/uploader at 41ae8cf");
  await expect(cell(uploaderRow, 3)).toHaveText("Disabled");
  await uploaderRow.getByRole("button", { name: "Enable Uploader" }).click();
  await expect(status).toHaveText("DoneEnabled Uploader. Done.");
  await expect(cell(uploaderRow, 3)).toHaveText("Enabled");

  // A typed repository Decaid finds nothing at is refused in Decaid's words.
  await plugins.getByRole("button", { name: "Install plugin" }).click();
  await install.getByLabel("GitHub repository").fill("example/no-such-plugin");
  await install.getByRole("button", { name: "Install", exact: true }).click();
  await expect(status).toHaveText(
    "RefusedInstalled a plugin · example/no-such-plugin. Refused by Decaid: Couldn't install the plugin. The repository, release, or download was not found. Check the address and try again.",
  );

  // The Visualizer upload's settings, its password among them, written but never shown.
  await pluginRow(page, "Visualizer upload").getByRole("button", { name: "Visualizer upload settings" }).click();
  const form = page.getByRole("dialog", { name: "Visualizer upload settings" });
  await expect(form).toContainText("Saving restarts this plugin on the Tablet.");
  const password = form.getByLabel("Visualizer password", { exact: true });
  await expect(password).toHaveValue("");
  await expect(form.getByText("Not set", { exact: true })).toBeVisible();
  await expect(form.getByRole("switch", { name: "Upload shots automatically" })).toBeChecked();
  await expect(form.getByLabel("Minimum shot length", { exact: true })).toHaveValue("5");
  await expectTip(form, "Visualizer username", "Visualiser username");
  await form.getByLabel("Visualizer username", { exact: true }).fill("front-bar");
  await password.fill("made-up-secret");
  await form.getByLabel("Minimum shot length", { exact: true }).fill("8");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(status).toHaveText("DoneChanged Visualizer upload's settings · Visualizer username, Visualizer password, Minimum shot length. Done.");
  await pluginRow(page, "Visualizer upload").getByRole("button", { name: "Visualizer upload settings" }).click();
  await expect(form.getByLabel("Visualizer username", { exact: true })).toHaveValue("front-bar");
  await expect(form.getByLabel("Minimum shot length", { exact: true })).toHaveValue("8");
  await expect(password).toHaveValue("");
  await expect(form.getByText("Set", { exact: true })).toBeVisible();
  await expect(page.getByText("made-up-secret")).toHaveCount(0);
  await form.getByRole("button", { name: "Cancel" }).click();
  const visualizer = (await software(page, frontId)).plugins!.find((plugin) => plugin.id === "visualizer.reaplugin")!;
  expect(visualizer.settings.find((setting) => setting.name === "Password")!.value).toEqual({ isSet: true });

  // Decent Sync's own: its server address and Token shown only, its poll interval changeable.
  await pluginRow(page, "Decent Sync").getByRole("button", { name: "Decent Sync settings" }).click();
  const own = page.getByRole("dialog", { name: "Decent Sync settings" });
  await expect(own.getByRole("group", { name: "Server URL" })).toContainText(`${server.url()}Set on the Tablet, and not changed from here.`);
  await expect(own.getByRole("group", { name: "Token" })).toContainText("SetSet on the Tablet, and not changed from here.");
  await expect(own.getByRole("textbox")).toHaveCount(0);
  await expect(own.getByLabel("Poll interval (seconds)", { exact: true })).toHaveValue("5");
  await own.getByRole("button", { name: "Cancel" }).click();

  await pluginRow(page, "Visualizer upload").getByRole("button", { name: "Disable Visualizer upload" }).click();
  await expect(status).toHaveText("DoneDisabled Visualizer upload. Done.");
  await expect(cell(pluginRow(page, "Visualizer upload"), 3)).toHaveText("Disabled");

  // Removed only once confirmed.
  await pluginRow(page, "dcamp").getByRole("button", { name: "Remove dcamp" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove dcamp?" });
  await expect(confirm).toContainText("Its settings on this Tablet are deleted. What it stored stays on the Tablet.");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(status).toHaveText("DoneRemoved dcamp. Done.");
  await expect(pluginRow(page, "dcamp")).toHaveCount(0);

  // The settings changed are in the Settings History, tied to the Software Action that changed them.
  await openMachineTab(page, "Settings");
  const history = await openCard(page, "Settings History");
  const changed = (name: string) => rows(history.getByRole("table", { name: "Settings History" })).filter({ has: page.getByRole("cell", { name, exact: true }) });
  await expect(changed("Visualizer upload: Visualizer username").getByRole("cell").nth(1)).toHaveText("Plugin settings");
  await expect(changed("Visualizer upload: Visualizer username").getByRole("cell").nth(3)).toHaveText("Set: front-bar");
  await expect(changed("Visualizer upload: Visualizer password").getByRole("cell").nth(3)).toHaveText("Not set to Set");
  await expect(changed("Visualizer upload: Visualizer password").getByRole("cell").nth(4)).toHaveText(
    "YouChanged Visualizer upload's settings · Visualizer username, Visualizer password, Minimum shot length",
  );
  await expect(changed("Visualizer upload: Visualizer password").getByRole("cell").nth(5)).toHaveText("Done");
});

test("an Admin turns the automatic update checks off, with both notes, and the tab says so above the lists until they are on again", async ({ page }) => {
  await page.goto(`/machines/${frontId}?tab=software`);
  const decaid = region(page, "Decaid");
  /** Turns them on or off, and waits until the Machine has applied it. */
  async function turn(on: boolean) {
    await decaid.getByRole("button", { name: "Edit automatic update checks" }).click();
    const form = decaid.getByRole("form", { name: "Edit automatic update checks" });
    const toggle = form.getByRole("switch", { name: "Automatic update checks" });
    await expect(toggle).toBeChecked({ checked: !on });
    await expect(form).toContainText("A change takes effect when Decaid next starts. While they are off, nothing on the Tablet updates by itself, Decent Sync's plugin included.");
    await toggle.click();
    await form.getByRole("button", { name: "Save" }).click();
    await expect(decaid.getByRole("status")).toContainText("Applied");
  }

  await turn(false);
  await expect(field(decaid, "Automatic update checks")).toHaveText("OffEdit");
  const banner = page.getByRole("alert").filter({ hasText: "Automatic update checks are off" });
  await expect(banner).toContainText("Nothing on the Tablet updates by itself, Decent Sync's plugin included, until they are turned on again.");
  const [bannerBox, pluginsBox] = await boxes(banner, region(page, "Plugins"));
  expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(pluginsBox!.y);

  // The Settings tab shows them as it shows a read-only setting, with where they are edited, and offers no switch.
  await openMachineTab(page, "Settings");
  const tabletSettings = page.getByRole("region", { name: "Tablet Settings", exact: true });
  await expect(field(tabletSettings, "Automatic update checks")).toHaveText("Off");
  await expectTip(tabletSettings, "Automatic update checks", "Edited on the Software tab");
  await tabletSettings.getByRole("button", { name: "Edit Tablet Settings" }).click();
  await expect(tabletSettings.getByRole("switch", { name: "Automatic update checks" })).toHaveCount(0);
  await tabletSettings.getByRole("button", { name: "Cancel" }).click();

  await openMachineTab(page, "Software");
  await turn(true);
  await expect(field(decaid, "Automatic update checks")).toHaveText("On, every 12 hoursEdit");
  await expect(banner).toHaveCount(0);
});

test("an action is refused while the Machine is busy, its message staying until dismissed, one done goes by itself unless held, and the log, which starts closed, shows when, what, who and what came of each", async ({ page }) => {
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${frontId}?tab=software`);
  front.reportState("espresso", "pouring");
  const plugins = region(page, "Plugins");
  await pluginRow(page, "Time To Ready").getByRole("button", { name: "Disable Time To Ready" }).click();
  const refused = plugins.getByRole("status");
  await expect(refused).toHaveText("RefusedDisabled Time To Ready. Refused: the Machine was pulling a shot.");
  await expect(cell(pluginRow(page, "Time To Ready"), 3)).toHaveText("Enabled");
  front.reportState("idle", "idle");
  // A refusal stays until dismissed.
  await page.clock.fastForward(20_000);
  await expect(refused).toHaveText("RefusedDisabled Time To Ready. Refused: the Machine was pulling a shot.");
  await refused.getByRole("button", { name: "Dismiss" }).click();
  await expect(refused).toHaveCount(0);

  // One done goes by itself after a while, but not while the pointer is over it or focus is inside it.
  const decaid = region(page, "Decaid");
  await decaid.getByRole("button", { name: "Check now" }).click();
  const done = decaid.getByRole("status");
  await expect(done).toHaveText("DoneChecked for Decaid's update. Done · 0.9.4 is available.");
  await done.hover();
  await page.clock.fastForward(20_000);
  await expect(done).toHaveText("DoneChecked for Decaid's update. Done · 0.9.4 is available.");
  const dismiss = done.getByRole("button", { name: "Dismiss" });
  await dismiss.focus();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(20_000);
  await expect(done).toBeVisible();
  await dismiss.blur();
  // Its time starts again once they leave.
  await page.clock.fastForward(7_000);
  await expect(done).toBeVisible();
  await page.clock.fastForward(1_500);
  await expect(done).toHaveCount(0);

  const log = region(page, "Software Actions");
  await expect(log.getByRole("button", { name: "Show Software Actions" })).toBeVisible();
  await expect(log.getByRole("table")).toHaveCount(0);
  await openCard(page, "Software Actions");
  const table = log.getByRole("table", { name: "Software Actions" });
  await expect(table.getByRole("columnheader")).toHaveText(["When", "Action", "Made by", "Outcome"]);
  const when = /^\w{3} \d+, \d{4}, \d+:\d\d:\d\d [AP]M$/;
  await expect(rows(table).first().getByRole("cell")).toHaveText([when, "Checked for Decaid's update", "You", "Done · 0.9.4 is available"]);
  // Newest first, each as it was made, Decaid's words on its refusal, those whose messages went among them.
  await expect(rows(table).getByRole("cell").filter({ hasText: /^(?!\w{3} \d+, \d{4})/ })).toHaveText([
    "Checked for Decaid's update",
    "You",
    "Done · 0.9.4 is available",
    "Disabled Time To Ready",
    "You",
    "Refused: the Machine was pulling a shot",
    "Removed dcamp",
    "You",
    "Done",
    "Disabled Visualizer upload",
    "You",
    "Done",
    "Changed Visualizer upload's settings · Visualizer username, Visualizer password, Minimum shot length",
    "You",
    "Done",
    "Installed a plugin · example/no-such-plugin",
    "You",
    "Refused by Decaid: Couldn't install the plugin. The repository, release, or download was not found. Check the address and try again.",
    "Enabled Uploader",
    "You",
    "Done",
    "Installed the plugin Uploader · example/uploader at 41ae8cf",
    "You",
    "Done · 0.4.1",
    "Approved Time To Ready's update to 1.0.6",
    "You",
    "Done · 1.0.6",
    "Checked plugins for updates",
    "You",
    "Done · Decent shot upload updated to 0.2.5, 1 already current, Time To Ready waits for approval",
    "Checked for Decaid's update",
    "You",
    "Done · 0.9.4 is available",
  ]);

  // A check done with a plugin that failed stays until dismissed, as what went wrong does.
  managed.failUpdatesOf("shot-upload.reaplugin", "Couldn't update the plugin. Try again.");
  await plugins.getByRole("button", { name: "Check for updates" }).click();
  const failed = plugins.getByRole("status");
  await expect(failed).toContainText("Checked plugins for updates. Done · ");
  await expect(failed).toContainText("Decent shot upload failed: Couldn't update the plugin. Try again.");
  await page.clock.fastForward(20_000);
  await expect(failed).toContainText("Decent shot upload failed: Couldn't update the plugin. Try again.");
  managed.failUpdatesOf("shot-upload.reaplugin", null);
});

test("an action no Tablet answers in time is not confirmed, and a Tablet whose plugin is from before Software Actions is offered none", async ({ page }) => {
  // A connection that takes Software Actions and answers none.
  const raw = await createMachine(page, "Raw bar", mainStreet.id);
  await RawConnection.welcomed(server.url(), helloWith(raw.token), 300);
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${raw.machine.id}`)).json()) as { machine: { online: boolean } }).machine.online).toBe(true);
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${raw.machine.id}?tab=software`);
  await expect(region(page, "Plugins")).toContainText("Its Tablet has not reported its plugins yet.");
  const decaid = region(page, "Decaid");
  await decaid.getByRole("button", { name: "Check now" }).click();
  const status = decaid.getByRole("status");
  await expect(status).toHaveText("Waiting for the Tablet…Checked for Decaid's update. Sent to the Tablet, waiting for its answer.");
  // Waiting, it neither goes nor can be dismissed.
  await expect(status.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  // Its time passes.
  const db = await server.connectDatabase();
  try {
    await db.query("UPDATE software_actions SET made_at = made_at - interval '3 minutes' WHERE machine_id = $1", [raw.machine.id]);
  } finally {
    await db.end();
  }
  await expect(status).toHaveText("Not confirmedChecked for Decaid's update. Check the lists before trying again.");
  // Not confirmed, it stays until dismissed.
  await page.clock.fastForward(20_000);
  await expect(status).toHaveText("Not confirmedChecked for Decaid's update. Check the lists before trying again.");
  await expect(status.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expectTip(status, "this outcome", "The Tablet didn't answer in time, or its connection closed first. Check the lists before trying again: it may have been done all the same.");
  const log = await openCard(page, "Software Actions");
  await expect(rows(log.getByRole("table")).first().getByRole("cell").nth(3)).toHaveText("Not confirmed");

  // The previous release's plugin, at wire revision 4.
  const old = await createMachine(page, "Old bar", mainStreet.id);
  await RawConnection.welcomed(server.url(), helloWith(old.token, { wireRevision: 4 }), 300);
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${old.machine.id}`)).json()) as { machine: { online: boolean } }).machine.online).toBe(true);
  await page.goto(`/machines/${old.machine.id}?tab=software`);
  await expect(page.getByRole("alert").filter({ hasText: "The Tablet's plugin must update before it can take a Software Action" })).toBeVisible();
  await expect(region(page, "Decaid")).toBeVisible();
  expect(await offeredButtons(page)).toEqual([]);
});

test("while the Machine is offline its actions are disabled with the reason, and one made as it went offline is refused at once with the server's words", async ({ page }) => {
  await page.clock.install();
  await page.goto(`/machines/${frontId}?tab=software`);
  const decaid = region(page, "Decaid");
  await expect(decaid.getByRole("button", { name: "Check now" })).toBeEnabled();
  // The page's clock stops, so it still reads the Machine as online.
  await page.clock.pauseAt(new Date(Date.now() + 1_000));
  await front.unload();
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${frontId}`)).json()) as { machine: { online: boolean } }).machine.online).toBe(false);
  await decaid.getByRole("button", { name: "Check now" }).click();
  await expect(decaid.getByRole("alert")).toHaveText("The Machine is offline: a Software Action is made only while its Tablet is connected, and is never kept for later");

  await page.clock.runFor(6_000);
  await expect(page.getByText("Software Actions are made only while the Machine is online and its Tablet connected.")).toBeVisible();
  for (const name of ["Check now", "Check for updates", "Install plugin", "Edit automatic update checks", "Disable Time To Ready", "Visualizer upload settings", "Remove Uploader"]) {
    await expect(page.getByRole("main").getByRole("button", { name, exact: true })).toBeDisabled();
  }
  // Its lists stay as last reported.
  await expect(cell(pluginRow(page, "Uploader"), 3)).toHaveText("Enabled");
});

test("Staff read the lists and the log and are offered only the restart of the Skin view, and are shown no plugin setting's value", async ({ page, browser }) => {
  await asStaff(page, browser, async (samsPage) => {
    await samsPage.goto(`/machines/${frontId}?tab=software`);
    await expect(cell(pluginRow(samsPage, "Visualizer upload"), 3)).toHaveText("Disabled");
    await expect(field(region(samsPage, "Decaid"), "Automatic update checks")).toHaveText("On, every 12 hours");
    await expect(rows(samsPage.getByRole("table", { name: "Skins" })).filter({ has: samsPage.getByText("Default", { exact: true }) })).toHaveCount(1);
    const log = await openCard(samsPage, "Software Actions");
    // Who made each is named to Admins only.
    await expect(rows(log.getByRole("table")).first().getByRole("cell").nth(2)).toHaveText("An account");
    // At the Machine's Location, the restart of the Skin view, as its Skin doesn't report its page to be reloaded.
    expect(await offeredButtons(samsPage)).toEqual(["Restart the Skin view"]);
    const visualizer = (await software(samsPage, frontId)).plugins!.find((plugin) => plugin.id === "visualizer.reaplugin")!;
    expect(visualizer.settings.every((setting) => !("value" in setting))).toBe(true);

    // The Settings History says a setting changed, and whether a secret is set, but not what to.
    await openMachineTab(samsPage, "Settings");
    const history = await openCard(samsPage, "Settings History");
    const changed = (name: string) => rows(history.getByRole("table", { name: "Settings History" })).filter({ has: samsPage.getByRole("cell", { name, exact: true }) });
    await expect(changed("Visualizer upload: Visualizer username").getByRole("cell").nth(3)).toHaveText("Set: Hidden");
    await expect(changed("Visualizer upload: Visualizer password").getByRole("cell").nth(3)).toHaveText("Not set to Set");
    await expect(changed("Visualizer upload: Visualizer password").getByRole("cell").nth(4)).toHaveText(/^An account/);
  });
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

/** Signs a new Staff member at Main Street in, in a context of their own, for `work`. */
async function asStaff(page: Page, browser: Browser, work: (page: Page) => Promise<void>) {
  const email = `staff-${Date.now()}@example.com`;
  const response = await page.request.post("/api/invites", { data: { email, role: "staff", locationIds: [mainStreet.id] } });
  expect(response.status()).toBe(201);
  const { link } = (await response.json()) as { link: string };
  const context = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await context.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: { name: "Sam Staff", password: "account password 1" } });
    expect(accepted.status()).toBe(201);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}
