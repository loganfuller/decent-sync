import { type Locator, type Page, expect, test } from "@playwright/test";
import { type LiveFixtureFrame, liveFixture, openingFrames } from "../server/test/support/live-fixtures.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { derivedShot, shotFixture } from "../server/test/support/shot-fixtures.js";
import { type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "../server/test/support/simulated-tablet.js";
import { derivedSteam, liveSteamFixture, withSteams } from "../server/test/support/steam-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field } from "./support/locators.js";
import { setTabHidden } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View's curves of a shot or of steaming (#263), as an Admin in New
// York. A simulated tablet running the built plugin replays the test tablet's
// DE1Pro's recorded streams (server/test/fixtures/decaid/de1pro-live-v0.9.0/,
// #259), its scale on, SPEED times as fast as recorded, in parts where a test
// looks at what the card shows. Steaming, its pauses, puffs and purge, and a
// flush are only tested from these real recordings, as Decaid's simulated
// machine produces none of them. Serials are made up, from 28001.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const SPEED = 5;

/** A Machine's tablet, connected, its scale on, polling every 5 s of its time, which runs 50 times faster here. */
async function connectedTablet(token: string, serial: string, api: DecaidApi = derivedDe1Pro({ serial })): Promise<SimulatedTablet> {
  const tablet = syncingTablet({ token }, { url: server.url() }, { api, sockets: { ...openingFrames(), scale: "connected" } });
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** The Machine's page, once its tablet streams to it. */
async function openMachinePage(page: Page, machineId: string, tablet: SimulatedTablet): Promise<Locator> {
  await page.goto(`/machines/${machineId}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  return page.getByRole("region", { name: "Live View" });
}

/** The index of a recording's first machine snapshot in that state and substate, and at a target flow above 0, or of 0, where `flowing` says. */
function first(frames: LiveFixtureFrame[], state: string, substate: string, flowing?: boolean): number {
  const index = frames.findIndex(({ source, frame }) => {
    const reported = frame.state as { state: string; substate: string } | undefined;
    if (source !== "machine" || reported?.state !== state || reported.substate !== substate) return false;
    return flowing === undefined || (frame.targetFlow as number) > 0 === flowing;
  });
  if (index < 0) throw new Error(`No snapshot in ${state}, ${substate}`);
  return index;
}

/** The times a chart's axis is marked at, as it shows them, such as "10 s". */
function ticks(curves: Locator, chart: string): Locator {
  return curves.getByRole("figure", { name: chart }).locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value");
}

/** A Shot the Machine's tablet stores, pulled at a UTC time, recording the Machine's hardware so it is credited to it. */
function shotOf(id: string, serial: string, pulledAt: Date): Record<string, unknown> {
  const workflow = shotFixture().workflow as Record<string, Record<string, unknown>>;
  return derivedShot(id, { timestamp: pulledAt.toISOString(), workflow: { ...workflow, machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial } } });
}

test("a shot's curves grow as it runs, then link its Shot once it arrives, not one before it, and keep that link", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 1");
  const tablet = await connectedTablet(token, "28001");
  tablet.pullShot(shotOf("shot-before", "28001", new Date(Date.now() - 3_600_000)));
  const card = await openMachinePage(page, machine.id, tablet);
  await expect(field(page, "Last Shot").getByRole("link")).toHaveAttribute("href", "/shots/shot-before");

  const frames = liveFixture("shot.json");
  const replay = tablet.replayLive(frames, { speed: SPEED });
  // The Shot before this one is stored as it begins, so the page most likely sees it only while this one runs.
  tablet.pullShot(shotOf("shot-just-before", "28001", new Date(Date.now() - 60_000)));
  // Its 2.9 s of Preheat and 7.7 s of preinfusion.
  await replay.to(first(frames, "espresso", "pouring"));
  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Shot curves", exact: true })).toBeVisible();
  for (const chart of ["Pressure", "Flow", "Weight", "Temperature"]) {
    await expect(curves.getByRole("figure", { name: chart }).locator(".recharts-line")).not.toHaveCount(0);
    // Preheat before 0 s, then preinfusion, read as the samples' recorded times.
    await expect(ticks(curves, chart)).toHaveText(["-2 s", "0 s", "2 s", "4 s", "6 s", "8 s"]);
  }
  await expect(curves.getByText("Partial", { exact: true })).toHaveCount(0);
  await expectTip(curves, "the curves", /^Drawn as the shot runs, as its Shot's page draws them/);
  // Not over yet, so nothing is linked.
  await expect(curves.getByText(/^Waiting for its/)).toHaveCount(0);

  // The rest: 23.8 s pouring and 4.2 s ending it, then idle.
  await replay.to();
  await expect(ticks(curves, "Pressure")).toHaveText(["0 s", "10 s", "20 s", "30 s"]);
  await expect(field(card.getByRole("group", { name: "Machine State" }), "Machine State")).toHaveText("Idle");
  await expect(curves.getByText("Waiting for its Shot")).toBeVisible();
  // The page loads the Machine again, its last Shot the one just before: it isn't linked.
  await page.waitForResponse((response) => new URL(response.url()).pathname === `/api/machines/${machine.id}` && response.ok());
  await expect(field(page, "Last Shot").getByRole("link")).toHaveAttribute("href", "/shots/shot-just-before");
  await expect(curves.getByRole("link")).toHaveCount(0);

  tablet.pullShot(shotOf("shot-live", "28001", new Date()));
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveAttribute("href", "/shots/shot-live");
  await expect(curves.getByText("Waiting for its Shot")).toHaveCount(0);

  // Another shot pulled while the tab is hidden: these curves, still shown, keep their own Shot's link.
  await setTabHidden(page, true);
  await tablet.replayLive(frames, { speed: SPEED }).to();
  tablet.pullShot(shotOf("shot-unseen", "28001", new Date()));
  await setTabHidden(page, false);
  await expect(field(page, "Last Shot").getByRole("link")).toHaveAttribute("href", "/shots/shot-unseen");
  await expect(ticks(curves, "Pressure")).toHaveText(["0 s", "10 s", "20 s", "30 s"]);
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveAttribute("href", "/shots/shot-live");
});

test("a shot's curves, its page opened mid-shot, are labelled partial", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 2");
  const tablet = await connectedTablet(token, "28002");
  const frames = liveFixture("shot.json");
  const replay = tablet.replayLive(frames, { speed: SPEED });
  // Begun with nobody watching, so the plugin isn't streaming, though it tracks how long the Machine has been pulling it.
  await replay.to(first(frames, "espresso", "pouring"));
  const card = await openMachinePage(page, machine.id, tablet);
  await replay.to();

  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Shot curves", exact: true })).toBeVisible();
  await expect(curves.getByText("Partial", { exact: true })).toBeVisible();
  await expectTip(curves, "partial curves", "The shot began before this page's data started coming, so its start isn't drawn.");
  // Drawn from the page's first frame, at 0 s, with no Preheat before it: its 28 s of pouring and ending.
  await expect(ticks(curves, "Pressure")).toHaveText(["0 s", "5 s", "10 s", "15 s", "20 s", "25 s"]);
});

test("steaming's Machine States are named from a real steaming, its curves drawn, and its Steam Record linked once it arrives", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 3");
  // A Steam Record from before, the Machine's newest as steaming begins.
  const before = derivedSteam("steam-before", { timestamp: new Date(Date.now() - 3_600_000).toISOString() }, liveSteamFixture("steam-record"));
  const tablet = await connectedTablet(token, "28003", withSteams(derivedDe1Pro({ serial: "28003" }), [before]));
  await expect.poll(async () => (await page.request.get(`/api/steam-records/steam-before`)).status()).toBe(200);
  const card = await openMachinePage(page, machine.id, tablet);
  const state = card.getByRole("group", { name: "Machine State" });
  // The Machine's newest Steam Record, read as the card sees steaming begin.
  const held = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/steam-records" && response.ok());

  // Steam Purge Mode Normal: stop turned pouring into pouringDone, at a target flow of 0 as the flow fell, then the purge.
  const frames = liveFixture("steam.json");
  const replay = tablet.replayLive(frames, { speed: SPEED });
  const named: [number, string, string][] = [
    [first(frames, "steam", "preparingForShot"), "preparingForShot", "Steaming Preparing"],
    [first(frames, "steam", "pouring", true), "pouring", "Steaming"],
    [first(frames, "steam", "pouringDone", false), "pouringDone", "Steaming Paused"],
    [first(frames, "steam", "pouringDone", true), "pouringDone", "Purging"],
  ];
  for (const [index, substate, text] of named) {
    await replay.to(index + 1);
    await expect(field(state, "Machine State")).toHaveText(text);
    await expectTip(state, "Machine State", `Decaid reports steam, ${substate}.`);
    // Away from the icon, so the next hover opens its tooltip again.
    await page.mouse.move(0, 0);
  }
  await held;
  // The Steam Record of a steaming before it arrives late, as the plugin looks for new ones every 30 s by default, and
  // the card reads it while this one steams: it isn't this one's.
  tablet.storeSteam(derivedSteam("steam-just-before", { timestamp: new Date(Date.now() - 60_000).toISOString() }, liveSteamFixture("steam-record")));
  await page.waitForResponse(async (response) => new URL(response.url()).pathname === "/api/steam-records" && (await response.text()).includes("steam-just-before"));
  await replay.to();
  await expect(field(state, "Machine State")).toHaveText("Idle");

  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Steaming curves", exact: true })).toBeVisible();
  await expect(curves.getByText("Partial", { exact: true })).toHaveCount(0);
  for (const chart of ["Steam temperature", "Pressure", "Flow"]) {
    const figure = curves.getByRole("figure", { name: chart });
    await expect(figure.locator(".recharts-line")).not.toHaveCount(0);
    // Preparing before 0 s, then the pause and the purge, with a line where they meet, as its Steam Record's page shades them.
    await expect(figure.locator(".recharts-reference-area")).toHaveCount(3);
    await expect(figure.locator(".recharts-reference-line")).toHaveCount(1);
    for (const phase of ["Paused", "Purge"]) await expect(figure.getByText(phase, { exact: true })).toBeVisible();
  }
  // No milk probe on a DE1, so no milk temperature (#265), and no scale's weight.
  for (const chart of ["Milk temperature", "Weight"]) await expect(curves.getByRole("figure", { name: chart })).toHaveCount(0);
  await expectTip(curves, "the curves", /^Drawn as the Machine steams, as its Steam Record's page draws them/);
  await expect(curves.getByText("Waiting for its Steam Record")).toBeVisible();
  // Read again once steaming has ended, the one before still the newest: it isn't linked.
  await page.waitForResponse(async (response) => new URL(response.url()).pathname === "/api/steam-records" && (await response.text()).includes("steam-just-before"));
  await expect(curves.getByRole("link")).toHaveCount(0);

  // Decaid stores it as steaming ends, and the plugin finds it.
  tablet.storeSteam(derivedSteam("steam-live", { timestamp: new Date().toISOString() }, liveSteamFixture("steam-record")));
  const link = curves.getByRole("link", { name: "Open its Steam Record" });
  await expect(link).toHaveAttribute("href", "/steam-records/steam-live");
  await link.click();
  await expect(page.getByRole("heading", { name: /^Steam Record from / })).toBeVisible();
});

test("Two Tap Stop's puffs and a flush are named from real ones, and the last curves stay through a flush and idle until the next shot", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 4");
  const tablet = await connectedTablet(token, "28004");
  const card = await openMachinePage(page, machine.id, tablet);
  const state = card.getByRole("group", { name: "Machine State" });
  const curves = card.getByRole("region", { name: "Curves" });

  // Steam Purge Mode Two Tap Stop: the first tap cut the flow, then puffs until the second began the purge.
  const steaming = liveFixture("steam-two-tap-stop.json");
  const steamingReplay = tablet.replayLive(steaming, { speed: SPEED });
  const named: [number, string, string][] = [
    [first(steaming, "steam", "pouring", true), "pouring", "Steaming"],
    [first(steaming, "steam", "pouring", false), "pouring", "Steaming Paused"],
    [first(steaming, "steam", "puffing"), "puffing", "Steaming Puffing"],
    [first(steaming, "steam", "pouringDone", false), "pouringDone", "Steaming Paused"],
    [first(steaming, "steam", "pouringDone", true), "pouringDone", "Purging"],
  ];
  for (const [index, substate, text] of named) {
    await steamingReplay.to(index + 1);
    await expect(field(state, "Machine State")).toHaveText(text);
    await expectTip(state, "Machine State", `Decaid reports steam, ${substate}.`);
    await page.mouse.move(0, 0);
  }
  await steamingReplay.to();
  await expect(curves.getByRole("heading", { name: "Steaming curves", exact: true })).toBeVisible();
  await expect(curves.getByRole("figure", { name: "Flow" }).getByText("Puffing", { exact: true })).toBeVisible();
  const steamingTicks = await ticks(curves, "Flow").allTextContents();

  // A flush, then idle: neither is a shot or steaming, so the steaming's curves stay.
  const flush = liveFixture("flush.json");
  const flushReplay = tablet.replayLive(flush, { speed: SPEED });
  await flushReplay.to(first(flush, "flush", "pouring") + 1);
  await expect(field(state, "Machine State")).toHaveText("Flushing");
  await expectTip(state, "Machine State", "Decaid reports flush, pouring.");
  await page.mouse.move(0, 0);
  await flushReplay.to();
  const idle = liveFixture("idle.json");
  await tablet.replayLive(idle.slice(0, 50), { speed: SPEED }).to();
  await expect(field(state, "Machine State")).toHaveText("Idle");
  await expect(curves.getByRole("heading", { name: "Steaming curves", exact: true })).toBeVisible();
  await expect(ticks(curves, "Flow")).toHaveText(steamingTicks);

  // The next shot's start replaces them.
  const shot = liveFixture("shot.json");
  await tablet.replayLive(shot, { speed: SPEED }).to(first(shot, "espresso", "preinfusion"));
  await expect(curves.getByRole("heading", { name: "Shot curves", exact: true })).toBeVisible();
  await expect(curves.getByRole("heading", { name: "Steaming curves", exact: true })).toHaveCount(0);
});
