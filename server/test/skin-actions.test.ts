import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { SimulatedPlugins, bundledPlugins } from "./support/decaid-plugins.js";
import { SimulatedSkins, recordedSkin } from "./support/decaid-skins.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #661: Software Actions on a Tablet's Skins, Reload and
// Restart the Skin view, and the start of Decaid's own update, made through
// the REST API, sent to the built plugin in a simulated tablet whose Decaid
// manages its Skins as Decaid v0.9.3 does (decaid-skins.ts, from
// fixtures/decaid/tablet-software-v0.9.3/skin-management.json), and
// answered, against real servers sharing one PostgreSQL database. A Skin
// that reports its page is played by the test, through the plugin's `page`
// endpoint, as site/src/content/docs/technical/skin-authors.md tells a Skin's author to. Serials are made up.

interface ActionView {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  account: { id: string; name: string | null } | null;
  outcome: "done" | "refused" | "notConfirmed" | null;
  note: string | null;
  answeredAt: string | null;
  refusal: { reason: string; state?: string | null; status?: number | null; message?: string | null } | null;
  result: Record<string, unknown> | null;
}
interface SkinView {
  id: string;
  name: string | null;
  version: string | null;
  default: boolean;
  served: boolean;
  removable: boolean;
  pageReported: boolean;
  updates: Record<string, unknown>;
}
interface ShowingView {
  skin: { id: string; name: string | null; version: string | null } | null;
  page: { version: string | null; loadedAt: string; reportedAt: string } | null;
  newerInstalled: boolean;
  nextDefault: { id: string; name: string | null } | null;
}
interface SoftwareView {
  decaid: { update: Record<string, unknown> | null };
  skins: SkinView[] | null;
  showing: ShowingView | null;
}
interface Frame { type: string; id?: string; name?: string; softwareActionId?: string }

const CAFE = "streamline-cafe.js";
const CAFE_DEV = "streamline-cafe.js-dist";
const STREAMLINE_DIST = "streamline.js-dist";
const COMMIT = "d7729dc9532ae31d606447ee0648e20284268b2c";
const ARCHIVE = `https://github.com/loganfuller/streamline-cafe-js/archive/${COMMIT}.zip`;

describe("Skin actions, Reload and Restart the Skin view, and Decaid's update", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let elsewhere: LocationView;
  let serial = 68_000;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Skins cafe", "America/Toronto");
    elsewhere = await api.createLocation("Skins elsewhere", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine at the cafe whose tablet is connected, its Decaid holding the Skins a new v0.9.3 comes with, Streamline served. */
  async function connected(name: string, options: { skins?: SimulatedSkins; plugins?: SimulatedPlugins } = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet; skins: SimulatedSkins; plugins: SimulatedPlugins }> {
    const machine = await api.createMachine(name, cafe.id);
    const skins = options.skins ?? new SimulatedSkins();
    const plugins = options.plugins ?? new SimulatedPlugins({ plugins: bundledPlugins() });
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), plugins, skins });
    await api.waitForOnline(machine);
    await expect.poll(async () => (await software(machine)).skins?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
    return { machine, tablet, skins, plugins };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/software-actions`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ softwareAction: ActionView }>("POST", path(machine), body, 201)).softwareAction;
  async function refused(machine: CreatedMachine, body: unknown, status: number, as = api): Promise<string> {
    const response = await as.call("POST", path(machine), body);
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return text;
  }
  const read = async (machine: CreatedMachine, id: string, as = api) => (await as.get<{ softwareAction: ActionView }>(`${path(machine)}/${id}`)).softwareAction;
  async function answered(machine: CreatedMachine, id: string, as = api): Promise<ActionView> {
    await expect.poll(async () => (await read(machine, id, as)).outcome, { timeout: 20_000 }).not.toBeNull();
    return read(machine, id, as);
  }
  const done = async (machine: CreatedMachine, body: unknown, as = api) => answered(machine, (await make(machine, body, as)).id, as);
  const software = async (machine: CreatedMachine, as = api) => (await as.get<{ tabletSoftware: SoftwareView }>(`/machines/${machine.machine.id}/tablet-software`)).tabletSoftware;
  const skin = async (machine: CreatedMachine, id: string) => (await software(machine)).skins?.find((entry) => entry.id === id);

  /** Reports a page to the plugin as a Skin that supports Reload does as its page loads: its id, its version and when it loaded, now by default: the plugin's Date reads the real time, where the tablet's timer clock (`readClock`) does not. */
  async function reportPage(tablet: SimulatedTablet, skinId: string, version: string, loadedAt = new Date().toISOString()): Promise<number> {
    return (await tablet.callEndpoint("page", { method: "PUT", body: { skinId, version, loadedAt } })).status;
  }
  /** Has the test play a Skin that loads its page again when the plugin pushes a reload on `changes`, reporting the fresh page. */
  function reloadsWhenAsked(tablet: SimulatedTablet, skinId: string, version: () => string): void {
    tablet.onEmit = (event, payload) => {
      if (event === "changes" && (payload as { what?: unknown }).what === "reload") setTimeout(() => void reportPage(tablet, skinId, version()), 5);
    };
  }

  /** Puts an action in the database for the connection holding the Machine, without the server's checks, and announces it: what the plugin is sent whatever the server would refuse. */
  async function stored(machine: CreatedMachine, kind: string, params: unknown): Promise<string> {
    const id = randomUUID();
    const database = await server.connectDatabase();
    try {
      await database.query(
        `INSERT INTO software_actions (id, machine_id, session_id, tablet_id, kind, params, time_ms)
         SELECT $1::uuid, id, connected_session_id, connected_tablet_id, $3, $4::jsonb, 60000 FROM machines WHERE id = $2::uuid`,
        [id, machine.machine.id, kind, JSON.stringify(params)],
      );
      await database.query("SELECT pg_notify('software_actions', $1)", [machine.machine.id]);
    } finally {
      await database.end();
    }
    return id;
  }

  it("installs a Skin from a repository's latest release, a branch or a commit's archive, each done with the Skin it installed", async () => {
    const { machine, tablet, skins } = await connected("Skins installed");
    skins.offer({ repo: "loganfuller/streamline-cafe-js" }, recordedSkin(CAFE));
    skins.offer({ repo: "decentespresso/streamline-js", branch: "dist" }, recordedSkin(STREAMLINE_DIST));
    skins.offer({ url: ARCHIVE }, recordedSkin(CAFE_DEV));

    const release = await done(machine, { kind: "installSkin", repo: "loganfuller/streamline-cafe-js" });
    expect(release).toMatchObject({ kind: "installSkin", params: { repo: "loganfuller/streamline-cafe-js", branch: null }, outcome: "done", result: { skinId: CAFE, name: "Streamline Cafe", version: "0.2.31-cafe.1" } });
    expect(await skin(machine, CAFE)).toMatchObject({ updates: { how: "followsReleases", repo: "loganfuller/streamline-cafe-js" }, removable: true, default: false, served: false });

    const branch = await done(machine, { kind: "installSkin", repo: "decentespresso/streamline-js", branch: "dist" });
    expect(branch).toMatchObject({ params: { branch: "dist" }, outcome: "done", result: { skinId: STREAMLINE_DIST } });
    expect(await skin(machine, STREAMLINE_DIST)).toMatchObject({ updates: { how: "followsBranch", branch: "dist" } });

    const pinned = await done(machine, { kind: "installSkin", url: ARCHIVE });
    expect(pinned).toMatchObject({ params: { url: ARCHIVE }, outcome: "done", result: { skinId: CAFE_DEV, name: "Streamline Cafe Dev" } });
    expect(await skin(machine, CAFE_DEV)).toMatchObject({ updates: { how: "pinned", commit: COMMIT, url: ARCHIVE } });
    expect(skins.managed).toEqual(["POST /webui/skins/install/github-release", "POST /webui/skins/install/github-branch", "POST /webui/skins/install/url"]);

    // Decaid fails a commit named as a Skin's branch (#659), so the server points to its archive's URL instead.
    expect(await refused(machine, { kind: "installSkin", repo: "loganfuller/streamline-cafe-js", branch: COMMIT }, 400)).toContain(`only by its archive's URL: ${ARCHIVE}`);
    // A repository Decaid can't install from: its own words.
    expect(await done(machine, { kind: "installSkin", repo: "example/nothing-here" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", status: 500, message: expect.stringContaining("The repository, release, or download was not found") } });

    // The Skins read back after the install were sent before its answer, naming it.
    const sent = tablet.sent as Frame[];
    const answer = sent.findIndex((frame) => frame.type === "softwareActed" && frame.id === release.id);
    expect(sent.slice(0, answer).filter((frame) => frame.type === "collection" && frame.name === "skins").at(-1)?.softwareActionId).toBe(release.id);
  });

  it("chooses the default Skin, which shows only after a restart of the Skin view, and restarts it onto that Skin", async () => {
    const skins = new SimulatedSkins();
    skins.install(recordedSkin(CAFE));
    const { machine } = await connected("Skins default", { skins });
    expect((await software(machine)).showing).toMatchObject({ skin: { id: "streamline.js" }, page: null, nextDefault: null });

    const chosen = await done(machine, { kind: "chooseDefaultSkin", skinId: CAFE });
    expect(chosen).toMatchObject({ params: { skin: { id: CAFE, name: "Streamline Cafe" } }, outcome: "done", result: { skinId: CAFE } });
    // Still serving Streamline: the page says the new default shows after a restart.
    await expect.poll(async () => (await software(machine)).showing).toMatchObject({ skin: { id: "streamline.js" }, nextDefault: { id: CAFE, name: "Streamline Cafe" } });

    const restarted = await done(machine, { kind: "restartSkinView" });
    expect(restarted).toMatchObject({ kind: "restartSkinView", outcome: "done", result: { skinId: CAFE, name: "Streamline Cafe" } });
    expect(skins.managed.slice(-2)).toEqual(["POST /webui/server/stop", "POST /webui/server/start"]);
    await expect.poll(async () => (await software(machine)).showing).toMatchObject({ skin: { id: CAFE }, nextDefault: null });
    expect(await skin(machine, CAFE)).toMatchObject({ default: true, served: true, removable: false });
  });

  it("starts the Skin server again where its start fails once, and says plainly when the Tablet is left with no Skin served", async () => {
    const { machine, skins } = await connected("Skins restart fails");
    skins.failStarts = 1;
    expect(await done(machine, { kind: "restartSkinView" })).toMatchObject({ outcome: "done", result: { skinId: "streamline.js" } });
    expect(skins.managed).toEqual(["POST /webui/server/stop", "POST /webui/server/start", "POST /webui/server/start"]);

    skins.failStarts = 2;
    const left = await done(machine, { kind: "restartSkinView" });
    expect(left).toMatchObject({ outcome: "refused", refusal: { reason: "noSkinServed", message: "Decaid's Skin server did not start again: Failed to start: SocketException: Failed to create server socket" } });
    expect(skins.servedId()).toBeNull();
    await expect.poll(async () => (await software(machine)).showing?.skin).toBeNull();
    // A restart serves it again.
    expect(await done(machine, { kind: "restartSkinView" })).toMatchObject({ outcome: "done" });
    expect(skins.servedId()).toBe("streamline.js");
  });

  it("checks the Skins for updates, with a result for each", async () => {
    const skins = new SimulatedSkins();
    skins.install(recordedSkin(CAFE));
    skins.offerNewer(CAFE, "0.2.32-cafe.1");
    const { machine } = await connected("Skins checked", { skins });
    const checked = await done(machine, { kind: "checkSkinUpdates" });
    expect(checked.outcome).toBe("done");
    const results = checked.result!.results as { item: string; status: string; version?: string }[];
    expect(results).toContainEqual({ item: CAFE, status: "updated", version: "0.2.32-cafe.1" });
    // A Skin Decaid comes with is answered for by its repository, as Decaid names it.
    expect(results).toContainEqual({ item: "decentespresso/streamline-js", status: "alreadyCurrent" });
    expect(await skin(machine, CAFE)).toMatchObject({ version: "0.2.32-cafe.1" });
  });

  it("answers an update check Decaid stopped waiting on, but went on with, from the check it joins", async () => {
    const skins = new SimulatedSkins();
    skins.install(recordedSkin(CAFE));
    skins.offerNewer(CAFE, "0.2.32-cafe.1");
    // host.localApi gives up after its time, as Decaid's does after a minute, while the check goes on.
    skins.checkMs = 1_500;
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    plugins.localApiTimeoutMs = 1_000;
    const { machine } = await connected("Skins check timed out", { skins, plugins });
    const checked = await done(machine, { kind: "checkSkinUpdates" });
    expect(checked).toMatchObject({ outcome: "done", refusal: null });
    expect(checked.result!.results).toContainEqual({ item: CAFE, status: "updated", version: "0.2.32-cafe.1" });
    // Asked twice, it ran once.
    expect(skins.managed.filter((taken) => taken === "POST /webui/skins/update")).toHaveLength(2);
    expect(skins.checksRun).toBe(1);
  });

  it("names a Skin the check updated as updated where the check asked again ran after it, and found it current", async () => {
    const skins = new SimulatedSkins();
    skins.install(recordedSkin(CAFE));
    skins.offerNewer(CAFE, "0.2.32-cafe.1");
    skins.checkMs = 1_500;
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    plugins.localApiTimeoutMs = 1_000;
    const { machine, tablet } = await connected("Skins check ended before the join", { skins, plugins });
    const action = await make(machine, { kind: "checkSkinUpdates" });
    // The check asked again arrives only once the first has ended, and so runs one of its own.
    await expect.poll(() => skins.managed.includes("POST /webui/skins/update")).toBe(true);
    const held = tablet.holdRequests("POST", "/webui/skins/update");
    await expect.poll(() => held.arrived === 1 && skins.checksRun === 1).toBe(true);
    skins.checkMs = 0;
    held.release();
    const checked = await answered(machine, action.id);
    expect(checked).toMatchObject({ outcome: "done" });
    expect(skins.checksRun).toBe(2);
    expect(checked.result!.results).toContainEqual({ item: CAFE, status: "updated", version: "0.2.32-cafe.1" });
    expect(checked.result!.results).toContainEqual({ item: "decentespresso/streamline-js", status: "alreadyCurrent" });
  });

  it("removes a Skin, refuses the default and one Decaid comes with, and has the plugin refuse the default whatever it is sent", async () => {
    const skins = new SimulatedSkins();
    skins.install(recordedSkin(CAFE));
    skins.install(recordedSkin(CAFE_DEV));
    skins.makeDefault(CAFE, true);
    const { machine, tablet } = await connected("Skins removed", { skins });
    expect(await done(machine, { kind: "removeSkin", skinId: CAFE_DEV })).toMatchObject({ params: { skin: { id: CAFE_DEV, name: "Streamline Cafe Dev" } }, outcome: "done", result: { skinId: CAFE_DEV, name: "Streamline Cafe Dev" } });
    await expect.poll(async () => await skin(machine, CAFE_DEV)).toBeUndefined();

    expect(await refused(machine, { kind: "removeSkin", skinId: CAFE }, 400)).toContain("is the default Skin, which can't be removed");
    expect(await refused(machine, { kind: "removeSkin", skinId: "insight" }, 400)).toContain("comes with Decaid, which keeps it");
    expect(await refused(machine, { kind: "removeSkin", skinId: "no-such-skin" }, 409)).toContain("The Tablet reports no such Skin");

    // Sent all the same, as by a server that checked nothing, the plugin refuses and asks Decaid nothing.
    const sent = await stored(machine, "removeSkin", { skin: { id: CAFE, name: "Streamline Cafe" } });
    expect(await answered(machine, sent)).toMatchObject({ outcome: "refused", refusal: { reason: "notAllowed", message: "The plugin does not remove the default Skin: choose another default first" } });
    expect(skins.managed).toEqual([`DELETE /webui/skins/${CAFE_DEV}`]);
    expect(skins.listed().some((entry) => entry.id === CAFE)).toBe(true);
    expect(tablet.logs.some((line) => line.includes("The plugin does not remove the default Skin"))).toBe(true);

    // Nor the Skin on screen once another is the default: Decaid would serve its deleted folder until the Skin view restarts.
    expect(await done(machine, { kind: "chooseDefaultSkin", skinId: "streamline.js" })).toMatchObject({ outcome: "done" });
    await expect.poll(async () => await skin(machine, CAFE)).toMatchObject({ default: false, served: true, removable: false });
    expect(await refused(machine, { kind: "removeSkin", skinId: CAFE }, 400)).toContain("Streamline Cafe is on screen now, so it can't be removed: restart the Skin view onto the default first");
    const onScreen = await stored(machine, "removeSkin", { skin: { id: CAFE, name: "Streamline Cafe" } });
    expect(await answered(machine, onScreen)).toMatchObject({ outcome: "refused", refusal: { reason: "notAllowed", message: "The plugin does not remove the Skin on screen: restart the Skin view onto the default first" } });
    expect(skins.managed).toEqual([`DELETE /webui/skins/${CAFE_DEV}`, "PUT /webui/skins/default"]);
    expect(skins.listed().some((entry) => entry.id === CAFE)).toBe(true);
  });

  it("offers Reload only once the Skin served reported its page, done when its fresh page reports in, and not confirmed otherwise", async () => {
    const { machine, tablet, skins } = await connected("Skins reload");
    // A Skin that ignores the page report: Reload is refused, and the restart still works.
    expect((await software(machine)).skins!.find((entry) => entry.served)).toMatchObject({ id: "streamline.js", pageReported: false });
    expect(await refused(machine, { kind: "reloadSkin" }, 409)).toContain("Streamline.js has not reported its page, so it can't be asked to reload: restart the Skin view instead");

    // The page endpoint takes only a page's report.
    expect((await tablet.callEndpoint("page")).status).toBe(405);
    const invalid = await tablet.callEndpoint("page", { method: "PUT", body: { skinId: "", loadedAt: "yesterday" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toContain("Give skinId");

    const firstLoad = new Date(Date.now() - 60_000).toISOString();
    expect(await reportPage(tablet, "streamline.js", "0.2.31", firstLoad)).toBe(204);
    await expect.poll(async () => (await software(machine)).showing?.page).toMatchObject({ version: "0.2.31", loadedAt: firstLoad });
    const shown = await software(machine);
    expect(shown.skins!.find((entry) => entry.served)).toMatchObject({ pageReported: true });
    // Streamline as installed is 0.2.32 in the recording: a newer build than the page showing.
    expect(shown.showing).toMatchObject({ skin: { id: "streamline.js", version: "0.2.32" }, newerInstalled: true });

    // A Skin that reloads when asked.
    reloadsWhenAsked(tablet, "streamline.js", () => "0.2.32");
    const reloaded = await done(machine, { kind: "reloadSkin" });
    expect(reloaded).toMatchObject({ kind: "reloadSkin", params: { skin: { id: "streamline.js" } }, outcome: "done", result: { skinId: "streamline.js", version: "0.2.32", page: { skinId: "streamline.js", version: "0.2.32" } } });
    expect(tablet.pushes("changes")).toContainEqual({ what: "reload" });
    await expect.poll(async () => (await software(machine)).showing).toMatchObject({ page: { version: "0.2.32" }, newerInstalled: false });
    // Nothing of Decaid's Skins was asked to change.
    expect(skins.managed).toEqual([]);

    // A Skin that heard the push and did not reload: not confirmed, saying so, with the restart the way on.
    tablet.onEmit = undefined;
    const ignored = await done(machine, { kind: "reloadSkin" });
    expect(ignored).toMatchObject({ outcome: "notConfirmed", note: "The Skin was asked to reload, but no fresh page reported in within 15 s", refusal: null, result: null });

    // Another Skin's page reporting in, as one still open in a browser, does not confirm it either.
    reloadsWhenAsked(tablet, "passione", () => "1.0.0");
    const elsewhere = await done(machine, { kind: "reloadSkin" });
    expect(elsewhere).toMatchObject({ outcome: "notConfirmed", note: "The Skin was asked to reload, but no fresh page reported in within 15 s", result: null });
  });

  it("keeps no page reported from another device, and asks the Skin to reload after Decaid loaded the plugin again", async () => {
    const { machine, tablet } = await connected("Skins reload after a load");
    expect(await reportPage(tablet, "streamline.js", "0.2.31", new Date(Date.now() - 60_000).toISOString())).toBe(204);
    await expect.poll(async () => (await software(machine)).showing?.page).toMatchObject({ version: "0.2.31" });

    // A browser on the cafe's network showing the same Skin: answered, not kept, and its fresh page confirms no Reload.
    const fromBrowser = async (version: string) =>
      (await tablet.callEndpoint("page", { method: "PUT", headers: { host: "192.168.1.20:8080" }, body: { skinId: "streamline.js", version, loadedAt: new Date().toISOString() } })).status;
    expect(await fromBrowser("0.2.32")).toBe(204);
    tablet.onEmit = (event, payload) => {
      if (event === "changes" && (payload as { what?: unknown }).what === "reload") setTimeout(() => void fromBrowser("0.2.32"), 5);
    };
    expect(await done(machine, { kind: "reloadSkin" })).toMatchObject({ outcome: "notConfirmed", result: null });
    expect((await software(machine)).showing?.page).toMatchObject({ version: "0.2.31" });

    // Decaid keeps the Skin's socket open as it loads the plugin again, so the Skin reports nothing until its page loads:
    // the server keeps the page it had, Reload still goes, and the page that loads after the push confirms it, though
    // its load time, by the Skin view's clock, which runs behind once the Tablet has slept, is before the push.
    const again = await tablet.reload();
    await api.waitForOnline(machine);
    await expect.poll(async () => (await software(machine)).skins!.find((entry) => entry.served)?.pageReported).toBe(true);
    again.onEmit = (event, payload) => {
      if (event === "changes" && (payload as { what?: unknown }).what === "reload") setTimeout(() => void reportPage(again, "streamline.js", "0.2.32", new Date(Date.now() - 30_000).toISOString()), 5);
    };
    expect(await done(machine, { kind: "reloadSkin" })).toMatchObject({ outcome: "done", result: { skinId: "streamline.js", version: "0.2.32" } });
    await expect.poll(async () => (await software(machine)).showing?.page).toMatchObject({ version: "0.2.32" });
  });

  it("runs neither Reload nor the restart while the Machine is busy, refusing each with its state", async () => {
    const { machine, tablet, skins } = await connected("Skins busy");
    await reportPage(tablet, "streamline.js", "0.2.32");
    await expect.poll(async () => (await software(machine)).showing?.page).not.toBeNull();
    for (const [state, substate] of [
      ["espresso", "pouring"],
      ["steam", "steaming"],
      ["flush", "pouring"],
      ["hotWater", "pouring"],
    ] as const) {
      tablet.reportState(state, substate);
      for (const kind of ["reloadSkin", "restartSkinView"]) {
        expect(await done(machine, { kind })).toMatchObject({ outcome: "refused", refusal: { reason: "machineBusy", state } });
      }
    }
    expect(skins.managed).toEqual([]);
    expect(tablet.pushes("changes")).not.toContainEqual({ what: "reload" });
  });

  it("lets Staff at the Machine's Location reload and restart, and no one else but Admins, and no other Skin action to Staff", async () => {
    const { machine, tablet } = await connected("Skins staff");
    await reportPage(tablet, "streamline.js", "0.2.32");
    await expect.poll(async () => (await software(machine)).showing?.page).not.toBeNull();
    reloadsWhenAsked(tablet, "streamline.js", () => "0.2.32");
    const staff = await api.staffAt("skins-staff@example.com", cafe);
    const away = await api.staffAt("skins-away@example.com", elsewhere);
    const { link } = await api.invite("skins-viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Vic Viewer", password: "vic's password 1" }));

    expect(await done(machine, { kind: "reloadSkin" }, staff)).toMatchObject({ outcome: "done", account: { name: null } });
    expect(await done(machine, { kind: "restartSkinView" }, staff)).toMatchObject({ outcome: "done" });
    for (const kind of ["reloadSkin", "restartSkinView"]) {
      expect(await refused(machine, { kind }, 403, away)).toContain("You can reload or restart the Skin only of a Machine at a Location you work at");
      expect(await refused(machine, { kind }, 403, viewer)).toBeTruthy();
    }
    for (const body of [{ kind: "installSkin", repo: "loganfuller/streamline-cafe-js" }, { kind: "chooseDefaultSkin", skinId: "passione" }, { kind: "checkSkinUpdates" }, { kind: "removeSkin", skinId: "passione" }, { kind: "startDecaidUpdate" }, { kind: "checkDecaidUpdate" }]) {
      expect(await refused(machine, body, 403, staff)).toContain("Only an Admin can do this");
    }
    expect((await staff.call("GET", `/machines/${machine.machine.id}/skin-sources`)).status).toBe(403);
  });

  it("starts Decaid's update on the Tablet only where it offers one, saying plainly when Android's permission to install apps is not granted", async () => {
    const plugins = new SimulatedPlugins({ plugins: bundledPlugins() });
    const { machine } = await connected("Skins Decaid update", { plugins });
    expect(await refused(machine, { kind: "startDecaidUpdate" }, 409)).toContain("Decaid offers no update it can install on this Tablet: check for its update first");

    plugins.offerDecaid("0.9.4");
    expect(await done(machine, { kind: "checkDecaidUpdate" })).toMatchObject({ outcome: "done" });
    await expect.poll(async () => (await software(machine)).decaid.update).toMatchObject({ phase: "available", latestVersion: "0.9.4", installable: true });

    plugins.installOn = "androidNotPermitted";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({
      params: { version: "0.9.4" },
      outcome: "refused",
      refusal: { reason: "installNotPermitted", message: "Installation requires approval on the Android device" },
    });

    plugins.installOn = "linux";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", message: "In-app install is not supported on this platform" } });

    // Decaid ignores the command while it checks, so the plugin does not send it then.
    plugins.installOn = "androidPermitted";
    const offered = plugins.update;
    plugins.update = { ...offered, phase: "checking" };
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({
      outcome: "refused",
      refusal: { reason: "decaid", message: "Decaid is checking for its update now: start the update once the check ends" },
    });
    plugins.update = offered;

    // Its first `installing` comes before it launches the installer, which can still fail.
    plugins.installOn = "androidInstallFails";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", message: "Couldn't install the app update. Try again." } });
    // Or ends without the installer opening, as where it was cancelled.
    plugins.installOn = "androidInstallerNotOpened";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", message: "Decaid did not open Android's installer" } });

    // A download slower than the action's time: not confirmed, saying how far it got, as the installer opens later.
    plugins.installOn = "androidSlowDownload";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({
      outcome: "notConfirmed",
      note: "Decaid was still downloading its update (62%) after 95 s: Android's installer opens at the Tablet once it finishes",
    });
    plugins.update = offered;

    // A release withdrawn since: Decaid checks again before it downloads, and finds none.
    plugins.installOn = "androidPermitted";
    plugins.offerDecaid(null);
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({ outcome: "refused", refusal: { reason: "decaid", message: "Decaid found no update to install" } });
    plugins.offerDecaid("0.9.4");
    expect(await done(machine, { kind: "checkDecaidUpdate" })).toMatchObject({ outcome: "done" });
    await expect.poll(async () => (await software(machine)).decaid.update).toMatchObject({ phase: "available", installable: true });

    plugins.installOn = "androidPermitted";
    expect(await done(machine, { kind: "startDecaidUpdate" })).toMatchObject({ outcome: "done", result: { decaid: { phase: "installing", latestVersion: "0.9.4" } } });
    await expect.poll(async () => (await software(machine)).decaid.update).toMatchObject({ phase: "installing" });
  });

  it("suggests the sources the other Machines' Skins were installed from, leaving out those Decaid comes with", async () => {
    // Ids of this test's own, as other tests' Machines hold the recorded ones.
    const pinned = { ...recordedSkin(CAFE_DEV), id: "sources-pinned.js" };
    const branch = { ...recordedSkin(STREAMLINE_DIST, "branchInstalled"), id: "sources-branch.js" };
    const first = new SimulatedSkins();
    first.install(pinned);
    first.install(branch);
    await connected("Skins source A", { skins: first });
    const second = new SimulatedSkins();
    second.install(pinned);
    await connected("Skins source B", { skins: second });
    const third = new SimulatedSkins();
    third.install({ ...branch, id: "sources-only-here.js" });
    const { machine } = await connected("Skins source C", { skins: third });
    const sources = (await api.get<{ skinSources: { skinId: string; repo: string | null; branch: string | null; url: string | null; machines: number; updates: { how: string } }[] }>(`/machines/${machine.machine.id}/skin-sources`)).skinSources;
    expect(sources).toContainEqual(expect.objectContaining({ skinId: "sources-pinned.js", url: ARCHIVE, repo: null, branch: null, updates: expect.objectContaining({ how: "pinned" }), machines: 2 }));
    expect(sources).toContainEqual(expect.objectContaining({ skinId: "sources-branch.js", repo: "decentespresso/streamline-js", branch: "dist", url: null, machines: 1 }));
    // Neither a Skin Decaid comes with nor one of its own Machine's is suggested.
    expect(sources.some((source) => source.skinId === "insight" || source.skinId === "streamline.js")).toBe(false);
    expect(sources.some((source) => source.skinId === "sources-only-here.js")).toBe(false);
  });
});
