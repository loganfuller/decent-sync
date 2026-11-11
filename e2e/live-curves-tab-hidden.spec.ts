import { type Page, expect, test } from "@playwright/test";
import { liveFixture } from "../server/test/support/live-fixtures.js";
import type { SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { SPEED, connectedTabletOn, first, openMachinePage, shotOf, ticks } from "./support/live-curves.js";
import { field } from "./support/locators.js";
import { setTabHidden } from "./support/polling.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View's shot curves (#263) where the page's tab is hidden for a
// while, as an Admin in New York: which Shot they link, their own where
// nothing else happened meanwhile and the Machine's Shots where the shot ended
// unseen or another came and went. A simulated tablet running the built plugin
// replays the test tablet's DE1Pro's recorded shot
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/, #259), its scale on, SPEED
// times as fast as recorded (e2e/support/live-curves.ts). Serials are made up.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const connectedTablet = connectedTabletOn(server);

/** Idle snapshots the Machine goes on sending after a shot, which reach the page once its stream is open again. */
async function goOnIdling(tablet: SimulatedTablet): Promise<void> {
  await tablet.replayLive(liveFixture("idle.json").slice(0, 50), { speed: SPEED }).to();
}

/** Waits for the server to have the Shot as the Machine's last. */
async function lastShotIs(page: Page, machineId: string, id: string): Promise<void> {
  await expect.poll(async () => ((await (await page.request.get(`/api/machines/${machineId}`)).json()) as { machine: { lastShot: { id: string } | null } }).machine.lastShot?.id).toBe(id);
}

test("a Shot arriving while the tab is hidden is linked where nothing else happened meanwhile, and the Machine's Shots where the shot ended unseen", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 5");
  const tablet = await connectedTablet(token, "28005");
  const card = await openMachinePage(page, machine.id, tablet);
  const curves = card.getByRole("region", { name: "Curves" });
  const frames = liveFixture("shot.json");

  // Over while the page watched, its Shot arriving with the tab hidden; idle since, so it is linked.
  await tablet.replayLive(frames, { speed: SPEED }).to();
  await expect(curves.getByText("Waiting for its Shot")).toBeVisible();
  await setTabHidden(page, true);
  tablet.pullShot(shotOf("shot-while-hidden", "28005", new Date()));
  await lastShotIs(page, machine.id, "shot-while-hidden");
  await setTabHidden(page, false);
  await goOnIdling(tablet);
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveAttribute("href", "/shots/shot-while-hidden");

  // Ended with the tab hidden: the page can't tell its Shot from another's, so it links the Machine's.
  const replay = tablet.replayLive(frames, { speed: SPEED });
  await replay.to(first(frames, "espresso", "pouring"));
  await expect(curves.getByRole("link")).toHaveCount(0);
  await setTabHidden(page, true);
  await replay.to();
  tablet.pullShot(shotOf("shot-ended-unseen", "28005", new Date()));
  await lastShotIs(page, machine.id, "shot-ended-unseen");
  await setTabHidden(page, false);
  await goOnIdling(tablet);
  await expect(field(card.getByRole("group", { name: "Machine State" }), "Machine State")).toHaveText("Idle");
  await expect(curves.getByRole("link", { name: "Find its Shot among the Machine's" })).toHaveAttribute("href", `/shots?machineId=${machine.id}`);
  await expectTip(curves, "finding its Shot", /^This page missed what the Machine sent for a while/);
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveCount(0);
});

test("the Machine's Shots are linked, not a later shot's Shot, where a whole shot came and went while the tab was hidden", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 6");
  const tablet = await connectedTablet(token, "28006");
  const card = await openMachinePage(page, machine.id, tablet);
  const curves = card.getByRole("region", { name: "Curves" });
  const frames = liveFixture("shot.json");

  await tablet.replayLive(frames, { speed: SPEED }).to();
  await expect(curves.getByText("Waiting for its Shot")).toBeVisible();
  const shown = await ticks(curves, "Pressure").allTextContents();
  // Hidden before its Shot arrives; then another shot is pulled, and both Shots arrive.
  await setTabHidden(page, true);
  tablet.pullShot(shotOf("shot-seen-ending", "28006", new Date()));
  await tablet.replayLive(frames, { speed: SPEED }).to();
  tablet.pullShot(shotOf("shot-later-unseen", "28006", new Date()));
  await lastShotIs(page, machine.id, "shot-later-unseen");
  await setTabHidden(page, false);
  await expect(field(page, "Last Shot").getByRole("link")).toHaveAttribute("href", "/shots/shot-later-unseen");
  await goOnIdling(tablet);
  await expect(curves.getByRole("link", { name: "Find its Shot among the Machine's" })).toHaveAttribute("href", `/shots?machineId=${machine.id}`);
  await expect(curves.getByRole("link", { name: "Open its Shot" })).toHaveCount(0);
  // Still the curves of the shot the page saw.
  await expect(ticks(curves, "Pressure")).toHaveText(shown);
});
