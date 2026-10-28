import { type Locator, type Request, expect, test } from "@playwright/test";
import { machineDisconnects, machineSnapshots, socketFrames, stateOf } from "../server/test/support/live-fixtures.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { type SimulatedTablet, derivedDe1Pro, workflowFixture } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, machineRow } from "./support/locators.js";
import { setTabHidden } from "./support/polling.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View on a Machine's page (#260, #261, #262, #264), as an Admin and
// as Staff in New York. A simulated tablet running the built plugin sends the
// test tablet's DE1Pro's recorded machine snapshots
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/) as Decaid's
// `stateUpdate`, and serves its local sockets' recorded frames, at first what
// each sent as it opened, and the device lists Decaid sent as its simulated
// machine was disconnected and connected again
// (server/test/fixtures/decaid/simulated-devices-v0.9.0/). Serials are made
// up, from 27001.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const shot = machineSnapshots("shot.json");
const hotWater = machineSnapshots("hot-water.json");
const asleep = machineSnapshots("asleep.json");
/** The first snapshot of a recording in that state and substate. */
const first = (snapshots: Record<string, unknown>[], state: string, substate: string) =>
  snapshots.find((snapshot) => stateOf(snapshot).state === state && stateOf(snapshot).substate === substate)!;

/** A Machine's tablet, connected, polling every 5 s of its time, which runs 50 times faster here. */
async function connectedTablet(token: string, serial: string, connectionId?: string): Promise<SimulatedTablet> {
  const tablet = syncingTablet({ token }, { url: server.url() }, { api: derivedDe1Pro({ serial, ...(connectionId ? { connectionId } : {}) }) });
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

/** The Live View's tiles and curves, which are dimmed while stale. */
const liveContent = (card: Locator) => card.locator(':scope > [data-slot="card-content"]');
/** A time as the page shows it in New York: "Oct 28, 2026, 10:20:05 AM". */
const SHOWN_TIME = String.raw`\w{3} \d+, \d{4}, \d+:\d{2}:\d{2}\s[AP]M`;

test("the Live View names each Machine State of a shot and a hot water pour, with Decaid's own in a tooltip, and shows its measurements", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 1");
  // Opened before the tablet connects, so it is offline.
  await page.goto(`/machines/${machine.id}`);
  const card = page.getByRole("region", { name: "Live View" });
  await expect(card).toContainText("Offline, never seen.");
  // The card sits above the grid of cards, below those that ask for action.
  await expect(page.getByRole("region").first()).toHaveAccessibleName("Live View");
  const tablet = await connectedTablet(token, "27001");
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });

  const state = card.getByRole("group", { name: "Machine State" });
  // A shot's steps by their names in the Workflow's profile, which its frames index; before its first, its Preheat.
  // Reloaded for the Workflow its tablet has reported, which the page reads every 30 s; within the stream's linger.
  const profile = workflowFixture().profile as { title: string; steps: { name: string }[] };
  // Its stream is answered once its lease is held: what is relayed before then doesn't reach it.
  const reopened = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/machines/${machine.id}/live`);
  await page.reload();
  await reopened;
  await expect(page.getByRole("region", { name: "Workflow" })).toContainText(profile.title);
  const steps = profile.steps;
  const named: [string, string, string][] = [
    ["idle", "idle", "Idle"],
    ["espresso", "preparingForShot", "Pulling a shot Preparing"],
    ["espresso", "preinfusion", "Pulling a shot Preinfusion"],
    ["espresso", "pouring", "Pulling a shot Pouring"],
    ["espresso", "pouringDone", "Pulling a shot Ending"],
  ];
  for (const [decaidState, substate, text] of named) {
    const snapshot = tablet.reportSnapshot(first(shot, decaidState, substate));
    await expect(field(state, "Machine State")).toHaveText(text);
    await expectTip(state, "Machine State", `Decaid reports ${decaidState}, ${substate}.`);
    // Away from the icon, so the next hover opens its tooltip again.
    await page.mouse.move(0, 0);
    const step = decaidState !== "espresso" ? "Not pulling a shot" : substate === "preparingForShot" ? "Preheat" : steps[snapshot.profileFrame as number]!.name;
    await expect(field(card, "Profile step")).toHaveText(step);
  }
  // From its first frame, the shot has been one Machine State.
  await expect(field(state, "Time in state")).toHaveText(/^\d+ s$/);

  // The tiles, against their targets: the first pouring frame of the shot.
  tablet.reportSnapshot(first(shot, "espresso", "pouring"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
  const tile = (name: string) => card.getByRole("group", { name });
  const expected: [string, string, string][] = [
    ["Group temperature", "79.7 °C", "82.0 °C"],
    ["Mix temperature", "82.8 °C", "88.0 °C"],
    // Its target from the machine's shot settings, which Decaid sent only as the plugin opened its socket, before the
    // reload: the server sent them again as the reloaded page joined the stream.
    ["Steam temperature", "160.0 °C", "160.0 °C"],
    ["Pressure", "3.1 bar", "2.9 bar"],
    // A flow target of zero is a pressure step's, which sets none.
    ["Flow", "1.0 ml/s", "None"],
  ];
  for (const [name, value, target] of expected) {
    await expect(field(tile(name), name)).toHaveText(value);
    await expect(field(tile(name), "Target")).toHaveText(target);
  }

  // A Machine or Decaid build that sends no steam temperature or flow target: each is shown as not reported.
  const { steamTemperature: _steam, targetFlow: _target, ...without } = first(shot, "espresso", "pouringDone");
  tablet.reportSnapshot(without);
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Ending");
  await expect(field(tile("Steam temperature"), "Steam temperature")).toHaveText("Not reported");
  await expect(field(tile("Flow"), "Target")).toHaveText("Not reported");
  await expect(field(tile("Pressure"), "Target")).not.toHaveText("Not reported");

  // A hot water pour, heating up first.
  for (const [substate, text] of [
    ["preparingForShot", "Pouring hot water Heating up"],
    ["pouring", "Pouring hot water"],
  ]) {
    tablet.reportSnapshot(first(hotWater, "hotWater", substate!));
    await expect(field(state, "Machine State")).toHaveText(text!);
    await expectTip(state, "Machine State", `Decaid reports hotWater, ${substate}.`);
    await page.mouse.move(0, 0);
    await expect(field(state, "Time in state")).toHaveText(/^\d+ s$/);
  }
  await expect(field(card, "Profile step")).toHaveText("Not pulling a shot");
});

test("the Live View shows the steam temperature's target, the water level with Low at or below the refill level, the scale and the Machine's connection to its Tablet", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 5");
  const tablet = await connectedTablet(token, "27005");
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  const tile = (name: string) => card.getByRole("group", { name });

  // What Decaid's sockets sent as they opened: the Machine asleep with its tank just below the refill level, and the
  // scale off. No machine snapshot has come yet, so its values aren't reported.
  await expect(field(tile("Water level"), "Water level")).toHaveText("4.8 mmLow");
  await expect(tile("Water level").getByText("Low", { exact: true })).toBeVisible();
  await expect(field(tile("Water level"), "Refill level")).toHaveText("5.0 mm");
  await expectTip(tile("Water level"), "the refill level", /^The water level, set on the Machine, at which its tank is due a refill\.At or below it, the water level is shown as Low\.$/);
  await expect(field(tile("Steam temperature"), "Target")).toHaveText("160.0 °C");
  await expect(field(tile("Steam temperature"), "Steam temperature")).toHaveText("Not reported");
  await expect(field(tile("Machine State"), "Machine State")).toHaveText("Not reported");
  for (const term of ["Weight", "Weight flow", "Battery"]) await expect(field(tile("Scale"), term)).toHaveText("Not reported");
  await expect(field(tile("Scale"), "Scale")).toHaveText("Not connected");
  await expect(field(tile("Tablet"), "Connection to Tablet")).toHaveText("Connected");

  // The scale is turned on, and sends its weights.
  const [connectedFrame, weight] = socketFrames("scale-connects.json", "scale");
  expect(connectedFrame).toEqual({ status: "connected" });
  tablet.reportOnSocket("scale", connectedFrame!);
  tablet.reportOnSocket("scale", weight!);
  await expect(field(tile("Scale"), "Weight")).toHaveText("16.0 g");
  await expect(field(tile("Scale"), "Weight flow")).toHaveText("0.0 g/s");
  await expect(field(tile("Scale"), "Battery")).toHaveText("80 %");
  await expect(field(tile("Scale"), "Scale")).toHaveText("Connected");

  // The tank is refilled: no longer Low.
  const [refilled] = socketFrames("shot.json", "waterLevels");
  tablet.reportOnSocket("waterLevels", refilled!);
  await expect(field(tile("Water level"), "Water level")).toHaveText("33.8 mm");
  await expect(tile("Water level").getByText("Low", { exact: true })).toHaveCount(0);

  // The scale goes off again: its values are no longer reported.
  tablet.reportOnSocket("scale", { status: "disconnected" });
  await expect(field(tile("Scale"), "Scale")).toHaveText("Not connected");
  await expect(field(tile("Scale"), "Weight")).toHaveText("Not reported");
});

test("the Live View closes its stream while its tab is hidden, and opens it again once the tab is shown", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 4");
  const tablet = await connectedTablet(token, "27004");
  const isStream = (request: Request) => new URL(request.url()).pathname === `/api/machines/${machine.id}/live`;
  const opened: Request[] = [];
  const closed: Request[] = [];
  page.on("request", (request) => isStream(request) && opened.push(request));
  page.on("requestfailed", (request) => isStream(request) && closed.push(request));
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const state = page.getByRole("region", { name: "Live View" }).getByRole("group", { name: "Machine State" });
  tablet.reportSnapshot(first(shot, "espresso", "preinfusion"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Preinfusion");

  await setTabHidden(page, true);
  await expect.poll(() => closed.length).toBe(1);
  expect(opened).toHaveLength(1);

  // Shown again within the stream's linger, it continues without the plugin being stopped and started.
  await setTabHidden(page, false);
  await expect.poll(() => opened.length).toBe(2);
  // Answered once its lease is held: what is relayed before then doesn't reach it.
  await opened[1]!.response();
  tablet.reportSnapshot(first(shot, "espresso", "pouring"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
  expect(tablet.delivered.filter((frame) => (frame as { type?: string }).type === "liveStart")).toHaveLength(1);
  expect(tablet.delivered).not.toContainEqual({ type: "liveStop" });
});

test("the Machines list names each Machine State as the Live View does", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 2");
  const tablet = await connectedTablet(token, "27002");
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  tablet.reportSnapshot(first(hotWater, "hotWater", "preparingForShot"));
  await expect(field(page.getByRole("group", { name: "Machine State" }), "Machine State")).toHaveText("Pouring hot water Heating up");
  await page.goto("/machines");
  await expect(machineRow(page, "Bar 2")).toContainText("Pouring hot water · Heating up");
});

test("Staff see the Live View of a Machine at a Location they don't work at", async ({ page, browser }) => {
  const theirs = await createLocation(page, "Live View, Staff's own");
  const elsewhere = await createLocation(page, "Live View elsewhere");
  const { machine, token } = await createMachine(page, "Bar 3", elsewhere.id);
  const tablet = await connectedTablet(token, "27003");
  const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };
  const invited = await page.request.post("/api/invites", { data: { email: sam.email, role: "staff", locationIds: [theirs.id] } });
  expect(invited.status()).toBe(201);
  const { link } = (await invited.json()) as { link: string };
  const samsBrowser = await browser.newContext({ baseURL: server.url(), timezoneId: "America/New_York" });
  try {
    const accepted = await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam });
    expect(accepted.status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/machines/${machine.id}`);
    await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
    tablet.reportSnapshot(first(shot, "espresso", "preinfusion"));
    const state = samsPage.getByRole("region", { name: "Live View" }).getByRole("group", { name: "Machine State" });
    await expect(field(state, "Machine State")).toHaveText("Pulling a shot Preinfusion");
    await expectTip(state, "Machine State", "Decaid reports espresso, preinfusion.");
  } finally {
    await samsBrowser.close();
  }
});

test("the Live View of an offline Machine is one line, and of one that stops sending is dimmed within 5 s, then offline", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 6");
  // The page's clock runs as usual until the test moves it on.
  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  const card = page.getByRole("region", { name: "Live View" });
  await expect(card).toContainText("Offline, never seen.");
  await expect(card.getByRole("group")).toHaveCount(0);

  const tablet = await connectedTablet(token, "27006");
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  // Once a poll has found it online: a frame that came before a poll found it offline would be offline.
  await expect(field(page.getByLabel("Status", { exact: true }), "Status")).toHaveText("Online");
  const state = card.getByRole("group", { name: "Machine State" });
  tablet.reportSnapshot(first(shot, "espresso", "pouring"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
  await expect(liveContent(card)).toHaveCSS("opacity", "1");
  await expect(card).not.toContainText("No data since");

  // It stops sending: past 5 s, its values are dimmed, with when the last came.
  await page.clock.fastForward(5_500);
  await expect(card).toContainText(new RegExp(`No data since ${SHOWN_TIME}`));
  await expect(liveContent(card)).toHaveCSS("opacity", "0.5");
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
  await expectTip(card, "values not current", "Nothing has come from the Machine for more than 5 s, so the values shown may be out of date.");

  // Its Tablet goes once the server has stored its Machine State, and the page's next poll finds it offline: one
  // line, with that Machine State.
  const storedState = async () => {
    type Viewed = { machine: { machineState: { state: string; substate: string } | null } };
    const { machineState } = ((await (await page.request.get(`/api/machines/${machine.id}`)).json()) as Viewed).machine;
    return machineState && `${machineState.state} ${machineState.substate}`;
  };
  await expect.poll(storedState).toBe("espresso pouring");
  await tablet.unload();
  await page.clock.fastForward(5_000);
  await expect(card).toContainText(new RegExp(`Offline, last seen ${SHOWN_TIME}, last Machine State: Pulling a shot · Pouring since ${SHOWN_TIME}\\.`));
  await expect(card.getByRole("group")).toHaveCount(0);
});

test("the Live View of a Machine whose connection reports other hardware is one line, with nothing live", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 7");
  // Bound to its tablet's machine; then the token is entered on a tablet with another machine.
  const bound = await connectedTablet(token, "27007");
  await bound.unload();
  const mismatched = await connectedTablet(token, "27008", "00:00:5E:00:53:08");
  await page.goto(`/machines/${machine.id}`);
  const card = page.getByRole("region", { name: "Live View" });
  await expect(card).toContainText("Its Tablet reports other hardware than this Machine's, so nothing live is shown.");
  // Seam 1 shows the server never asks a mismatched connection to stream.
  mismatched.reportSnapshot(first(shot, "espresso", "pouring"));
  await expect(card.getByRole("group")).toHaveCount(0);
});

test("the Live View says when a Tablet online isn't connected to its Machine, without its tiles, until it connects again", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 8");
  const tablet = await connectedTablet(token, "27009");
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  const state = card.getByRole("group", { name: "Machine State" });
  tablet.reportSnapshot(first(shot, "espresso", "preinfusion"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Preinfusion");

  // The machine is switched off: its Tablet's device list has it disconnected.
  const { disconnected, reconnected } = machineDisconnects();
  tablet.disconnectMachine(disconnected);
  await expect(card).toContainText("Its Tablet is online, but not connected to the Machine.");
  await expect(card.getByRole("group")).toHaveCount(0);

  // It is switched on again: the device list says so, and its tiles are back.
  tablet.connectMachine(reconnected);
  await expect(field(card.getByRole("group", { name: "Tablet" }), "Connection to Tablet")).toHaveText("Connected");
  await expect(card).not.toContainText("not connected to the Machine");
  tablet.reportSnapshot(first(shot, "espresso", "pouring"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Pouring");
});

test("the Live View shows a Machine whose last snapshot said it was asleep as asleep, not stale, when nothing more comes", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 9");
  const tablet = await connectedTablet(token, "27010");
  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  const state = card.getByRole("group", { name: "Machine State" });

  // Idle, then nothing for more than 5 s: stale.
  tablet.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "idle")!);
  await expect(field(state, "Machine State")).toHaveText("Idle");
  await page.clock.fastForward(5_500);
  await expect(card).toContainText("No data since");
  await expect(liveContent(card)).toHaveCSS("opacity", "0.5");

  // It goes to sleep, and some firmware sends nothing more while it sleeps: asleep, not dimmed.
  tablet.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "sleeping")!);
  await expect(field(state, "Machine State")).toHaveText("Asleep");
  await expect(card).not.toContainText("No data since");
  await expect(liveContent(card)).toHaveCSS("opacity", "1");
  await page.clock.fastForward(5_500);
  await expect(card).toContainText(new RegExp(`Asleep since ${SHOWN_TIME}`));
  await expect(card).not.toContainText("No data since");
  await expect(liveContent(card)).toHaveCSS("opacity", "1");
  await expectTip(card, "an asleep Machine", "Some Machines send nothing while asleep. These are the values it sent as it went to sleep.");
});

test("the Live View of a page opened while the Machine sleeps, on firmware that then sends nothing, shows it asleep from its stored Machine State", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 11");
  const tablet = await connectedTablet(token, "27012");
  // It goes to sleep with nobody watching: its plugin stores the change, but streams nothing.
  tablet.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "sleeping")!);
  type Viewed = { machine: { machineState: { state: string } | null } };
  const storedState = async () => ((await (await page.request.get(`/api/machines/${machine.id}`)).json()) as Viewed).machine.machineState?.state;
  await expect.poll(storedState).toBe("sleeping");

  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  // What Decaid's sockets send as they open, but no snapshot.
  await expect(field(card.getByRole("group", { name: "Machine State" }), "Machine State")).toHaveText("Not reported");
  await page.clock.fastForward(5_500);
  await expect(card).toContainText(new RegExp(`Asleep since ${SHOWN_TIME}`));
  await expect(card).not.toContainText("No data");
  await expect(liveContent(card)).toHaveCSS("opacity", "1");
});

test("the Live View of a tab shown again after the Machine went to sleep unseen shows it asleep, without the values from before", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 12");
  const tablet = await connectedTablet(token, "27013");
  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  const state = card.getByRole("group", { name: "Machine State" });
  tablet.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "idle")!);
  await expect(field(state, "Machine State")).toHaveText("Idle");

  // Hidden, and meanwhile the Machine goes to sleep, on firmware that then sends nothing: its plugin stores the change.
  await setTabHidden(page, true);
  tablet.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "sleeping")!);
  type Viewed = { machine: { machineState: { state: string } | null } };
  const storedState = async () => ((await (await page.request.get(`/api/machines/${machine.id}`)).json()) as Viewed).machine.machineState?.state;
  await expect.poll(storedState).toBe("sleeping");

  // Shown again: the snapshot from before is dropped as the stream opens, and the stored Machine State says asleep.
  await setTabHidden(page, false);
  await expect(field(state, "Machine State")).toHaveText("Not reported");
  await page.clock.fastForward(5_500);
  await expect(card).toContainText(new RegExp(`Asleep since ${SHOWN_TIME}`));
  await expect(field(state, "Machine State")).toHaveText("Not reported");
  await expect(liveContent(card)).toHaveCSS("opacity", "1");
  await expectTip(card, "an asleep Machine", "Some Machines send nothing while asleep. Its Tablet stored that it went to sleep, and has sent nothing from the Machine since this page's stream opened.");
});

test("the Live View follows Tablets taking its Machine over: it drops what the last one sent, but not what a new one sent after a poll was asked", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 10");
  const original = await connectedTablet(token, "27011");
  await page.clock.install();
  await page.goto(`/machines/${machine.id}`);
  await expect.poll(() => original.delivered).toContainEqual({ type: "liveStart" });
  const card = page.getByRole("region", { name: "Live View" });
  const state = card.getByRole("group", { name: "Machine State" });
  original.reportSnapshot(first(shot, "espresso", "preinfusion"));
  await expect(field(state, "Machine State")).toHaveText("Pulling a shot Preinfusion");
  // The page's polls now run only as the test moves its clock on.
  await page.clock.pauseAt(Date.now() + 1_000);

  // A second Tablet takes the Machine over. Its sockets' frames, which name it, drop the first one's snapshot.
  const second = await connectedTablet(token, "27011");
  await original.waitForLog(/^Another tablet connected with this Machine's token and took over\./);
  await expect(field(state, "Machine State")).toHaveText("Not reported");
  type Viewed = { machine: { tablet: { id: string } | null } };
  const path = `/api/machines/${machine.id}`;
  const holderOf = async () => ((await (await page.request.get(path)).json()) as Viewed).machine.tablet!.id;
  const secondId = await holderOf();

  // The page asks for the Machine, which the second Tablet holds, but the answer is held back.
  let fetched!: () => void;
  const answered = new Promise<void>((resolve) => (fetched = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const polls = (url: URL) => url.pathname === path;
  await page.route(polls, async (route) => {
    const response = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response });
  });
  await page.clock.fastForward(5_000);
  await answered;
  await page.clock.fastForward(10);

  // Meanwhile a third takes it over, and its Machine goes to sleep, on firmware that then sends nothing.
  const third = await connectedTablet(token, "27011");
  await second.waitForLog(/^Another tablet connected with this Machine's token and took over\./);
  // Once it streams: the server starts it as it welcomes it, and what its Decaid sends before then isn't forwarded.
  await expect.poll(() => third.delivered).toContainEqual({ type: "liveStart" });
  third.reportSnapshot(asleep.find((snapshot) => stateOf(snapshot).state === "sleeping")!);
  await expect(field(state, "Machine State")).toHaveText("Asleep");

  // The answer naming the second Tablet arrives: asked for before the third's frames came, it drops none of them.
  release();
  const current = page.getByLabel("Current tablet", { exact: true });
  await expect(field(current, "Tablet id")).toHaveText(secondId);
  await expect(field(state, "Machine State")).toHaveText("Asleep");
  await page.unroute(polls);

  // The next poll finds the third Tablet holding the Machine, and keeps its frames too: asleep, not stale.
  await page.clock.fastForward(5_000);
  await expect(field(current, "Tablet id")).toHaveText(await holderOf());
  await expect(field(state, "Machine State")).toHaveText("Asleep");
  await page.clock.fastForward(5_500);
  await expect(card).toContainText(new RegExp(`Asleep since ${SHOWN_TIME}`));
  await expect(card).not.toContainText("No data");
});
