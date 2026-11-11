import { expect, test } from "@playwright/test";
import { bengleSteam, liveFixture } from "../server/test/support/live-fixtures.js";
import { derivedDe1Pro } from "../server/test/support/simulated-tablet.js";
import { derivedSteam, liveSteamFixture, withSteams } from "../server/test/support/steam-fixtures.js";
import { useFreshServer } from "./support/fresh-server.js";
import { SPEED, connectedTabletOn, first, openMachinePage, ticks } from "./support/live-curves.js";
import { field } from "./support/locators.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View's Machine States and curves of steaming and a flush (#263),
// and a Bengle's milk temperature (#265) and own scale, as an Admin in New
// York. A simulated tablet running the built plugin replays the test tablet's
// DE1Pro's recorded streams (server/test/fixtures/decaid/de1pro-live-v0.9.0/,
// #259), its scale on, SPEED times as fast as recorded
// (e2e/support/live-curves.ts), in parts where a test looks at what the card
// shows. Steaming, its pauses, puffs and purge, and a flush are only tested
// from these real recordings, as Decaid's simulated machine produces none of
// them. A Bengle's milk probe is tested from Decaid's simulated Bengle
// steaming (bengle-live-v0.9.0/, #265), as the test tablet's DE1Pro has none.
// Serials are made up.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const connectedTablet = connectedTabletOn(server);

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
    const figure = curves.getByRole("figure", { name: chart, exact: true });
    await expect(figure.locator(".recharts-line")).not.toHaveCount(0);
    // Preparing before 0 s, then the pause and the purge, with a line where they meet, as its Steam Record's page shades them.
    await expect(figure.locator(".recharts-reference-area")).toHaveCount(3);
    await expect(figure.locator(".recharts-reference-line")).toHaveCount(1);
    for (const phase of ["Paused", "Purge"]) await expect(figure.getByText(phase, { exact: true })).toBeVisible();
  }
  // No milk probe on a DE1, so no milk temperature (#265), as a tile or a curve, and no scale's weight.
  await expect(card.getByRole("group", { name: "Milk temperature" })).toHaveCount(0);
  for (const chart of ["Milk temperature", "Weight"]) await expect(curves.getByRole("figure", { name: chart, exact: true })).toHaveCount(0);
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
  await expect(curves.getByRole("figure", { name: "Flow", exact: true }).getByText("Puffing", { exact: true })).toBeVisible();
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

test("a Bengle's milk temperature shows while its probe reports, as a tile and in steaming's curves, and its own scale's battery doesn't", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 9");
  const tablet = await connectedTablet(token, "28009", derivedDe1Pro({ model: "Bengle", serial: "28009" }));
  tablet.attachMilkProbe();
  const card = await openMachinePage(page, machine.id, tablet);
  const tile = (name: string) => card.getByRole("group", { name });
  await expect.poll(() => tablet.openDecaidSockets()).toContain("sensor");

  // Idle, as recorded: the Bengle's own scale, which always reports a battery of 100, and the probe yet to read.
  const frames = bengleSteam();
  const replay = tablet.replayLive(frames, { speed: SPEED });
  await replay.to(first(frames, "steam", "idle"));
  await expect(field(tile("Scale"), "Weight")).toHaveText("0.0 g");
  await expect(field(tile("Scale"), "Scale")).toHaveText("Connected");
  await expect(tile("Scale").getByText("Battery")).toHaveCount(0);
  await expect(tile("Milk temperature")).toHaveCount(0);

  // Steaming: the probe reads with each snapshot, the milk warming.
  const readings = frames.flatMap(({ source, frame }, index) => (source === "sensor" ? [{ index, temperature: frame.temperature as number }] : []));
  const fifth = readings[4]!;
  await replay.to(fifth.index + 1);
  await expect(field(tile("Milk temperature"), "Milk temperature")).toHaveText(`${fifth.temperature.toFixed(1)} °C`);
  await replay.to();
  await expect(field(tile("Machine State"), "Machine State")).toHaveText("Idle");

  const curves = card.getByRole("region", { name: "Curves" });
  await expect(curves.getByRole("heading", { name: "Steaming curves", exact: true })).toBeVisible();
  for (const chart of ["Milk temperature", "Steam temperature", "Pressure", "Flow"]) {
    await expect(curves.getByRole("figure", { name: chart, exact: true }).locator(".recharts-line")).not.toHaveCount(0);
  }
  await expect(curves.getByRole("figure", { name: "Milk temperature" })).not.toContainText("Not recorded.");
});

test("an Unidentified Bengle's own scale shows no battery either", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 10");
  // A Bengle reporting serial 0: an Unidentified Machine, bound to no model, though its connection reports a Bengle.
  const tablet = await connectedTablet(token, "0", derivedDe1Pro({ model: "Bengle", serial: "0", connectionId: "00:00:5E:00:53:22" }));
  const card = await openMachinePage(page, machine.id, tablet);
  await expect(page.getByRole("region", { name: "Unidentified Machine" })).toBeVisible();
  const tile = (name: string) => card.getByRole("group", { name });
  const frames = bengleSteam();
  await tablet.replayLive(frames, { speed: SPEED }).to(first(frames, "steam", "idle"));
  await expect(field(tile("Scale"), "Weight")).toHaveText("0.0 g");
  await expect(tile("Scale").getByText("Battery")).toHaveCount(0);
});
