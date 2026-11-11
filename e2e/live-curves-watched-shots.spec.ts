import { expect, test } from "@playwright/test";
import { liveFixture, machineDisconnects } from "../server/test/support/live-fixtures.js";
import { RawConnection, helloWith } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { SPEED, connectedTabletOn, first, last, openMachinePage, playToPouring, shotOf, ticks } from "./support/live-curves.js";
import { field } from "./support/locators.js";
import { setTabHidden } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View's curves of a shot (#263) on a page watching it, as an Admin
// in New York: growing as the shot runs and linking its Shot once it arrives,
// ending at a takeover by a Tablet that streams nothing, and labelled partial
// on a page opened mid-shot. A simulated tablet running the built plugin
// replays the test tablet's DE1Pro's recorded shot
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259), its scale on, SPEED
// times as fast as recorded (e2e/support/live-curves.ts), in parts where a test
// looks at what the card shows. On a loaded machine the page may miss any
// snapshot but the last before a pause, so a replay pauses just past each one
// an axis is read from (`playToPouring`). Serials are made up.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const connectedTablet = connectedTabletOn(server);

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
  await playToPouring(replay, frames, card);
  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Shot curves", exact: true })).toBeVisible();
  for (const chart of ["Pressure", "Flow", "Weight", "Weight flow", "Temperature"]) {
    await expect(curves.getByRole("figure", { name: chart, exact: true }).locator(".recharts-line")).not.toHaveCount(0);
    // Preheat before 0 s, then preinfusion, read as the samples' recorded times.
    await expect(ticks(curves, chart)).toHaveText(["-2 s", "0 s", "2 s", "4 s", "6 s", "8 s"]);
  }
  await expect(curves.getByText("Partial", { exact: true })).toHaveCount(0);
  await expectTip(curves, "the curves", /^Drawn as the shot runs, as its Shot's page draws them/);
  // Not over yet, so nothing is linked.
  await expect(curves.getByText(/^Waiting for its/)).toHaveCount(0);

  // The rest: 23.8 s pouring and 4.2 s ending it, played to its last snapshot, where the axis ends, then idle.
  await replay.to(last(frames, "espresso", "pouringDone") + 1);
  await expect(ticks(curves, "Pressure")).toHaveText(["0 s", "10 s", "20 s", "30 s"]);
  await replay.to();
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

  // The Machine switched off and on again: hidden while its Tablet isn't connected to it, the curves keep their link.
  const { disconnected, reconnected } = machineDisconnects();
  tablet.disconnectMachine(disconnected);
  await expect(card).toContainText("Its Tablet is online, but not connected to the Machine.");
  await expect(curves).toBeHidden();
  tablet.connectMachine(reconnected);
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveAttribute("href", "/shots/shot-live");
  await expect(card).not.toContainText("not connected to the Machine");
});

test("a shot's curves end at a takeover by a Tablet that streams nothing, so the first Tablet's next shot, once it is back, starts curves of its own", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 7");
  const tablet = await connectedTablet(token, "28007");
  const card = await openMachinePage(page, machine.id, tablet);
  const frames = liveFixture("shot.json");
  const espresso = first(frames, "espresso", "preparingForShot");
  const pouring = first(frames, "espresso", "pouring");
  await playToPouring(tablet.replayLive(frames, { speed: SPEED }), frames, card);
  const curves = card.getByRole("region", { name: "Curves" });
  await expect(ticks(curves, "Pressure")).toHaveText(["-2 s", "0 s", "2 s", "4 s", "6 s", "8 s"]);

  // A Tablet on the previous release, which the server never asks to stream, takes the Machine over, and the page's
  // next poll finds it.
  const silent = await RawConnection.welcomed(server.url(), helloWith(token, { wireRevision: 1, machine: { model: "DE1Pro", serial: "28007" } }));
  await tablet.waitForLog(/^Another tablet connected with this Machine's token and took over\./);
  await expect(card).toContainText("Waiting for its Tablet to send what it is doing.");
  // Meanwhile the first Tablet's Decaid sees the shot end and the Machine go idle, which it doesn't stream.
  await tablet.replayLive(frames.slice(pouring), { speed: SPEED }).to();

  // That Tablet leaves, and the first connects again and streams its next shot from its first frame: had the page missed
  // that one, its curves would be partial.
  await silent.close();
  await expect.poll(() => tablet.delivered.filter((frame) => (frame as { type?: string }).type === "liveStart").length, { timeout: 30_000 }).toBe(2);
  const next = frames.slice(espresso);
  await playToPouring(tablet.replayLive(next, { speed: SPEED }), next, card);
  // Its Preheat and preinfusion alone, as the first shot's were: joined to them, the axis would span both shots.
  await expect(ticks(curves, "Pressure")).toHaveText(["-2 s", "0 s", "2 s", "4 s", "6 s", "8 s"]);
  await expect(curves.getByText("Partial", { exact: true })).toHaveCount(0);
});

test("a shot's curves, its page opened mid-shot, are labelled partial", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 2");
  const tablet = await connectedTablet(token, "28002");
  const frames = liveFixture("shot.json");
  const replay = tablet.replayLive(frames, { speed: SPEED });
  // Begun with nobody watching, so the plugin isn't streaming, though it tracks how long the Machine has been pulling it.
  const pouring = first(frames, "espresso", "pouring");
  await replay.to(pouring);
  const card = await openMachinePage(page, machine.id, tablet);
  // Paused just past the axis's start and end, as `playToPouring` pauses: the page's first snapshot, the first of
  // pouring, and the shot's last.
  await replay.to(pouring + 1);
  await expect(field(card.getByRole("group", { name: "Machine State" }), "Machine State")).toHaveText("Pulling a shot Pouring");
  await replay.to(last(frames, "espresso", "pouringDone") + 1);

  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Shot curves", exact: true })).toBeVisible();
  await expect(curves.getByText("Partial", { exact: true })).toBeVisible();
  await expectTip(curves, "partial curves", "The shot began before this page's data started coming, so its start isn't drawn.");
  // Drawn from the page's first frame, at 0 s, with no Preheat before it: its 28 s of pouring and ending.
  await expect(ticks(curves, "Pressure")).toHaveText(["0 s", "5 s", "10 s", "15 s", "20 s", "25 s"]);
});
