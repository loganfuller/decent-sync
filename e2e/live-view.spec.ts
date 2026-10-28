import { type Request, expect, test } from "@playwright/test";
import { machineSnapshots, socketFrames, stateOf } from "../server/test/support/live-fixtures.js";
import { syncingTablet } from "../server/test/support/loaded-tablets.js";
import { type SimulatedTablet, derivedDe1Pro, workflowFixture } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { field, machineRow } from "./support/locators.js";
import { setTabHidden } from "./support/polling.js";
import { createLocation, createMachine, signInAsAdmin } from "./support/seed.js";
import { expectTip } from "./support/tooltips.js";

// The Live View on a Machine's page (#260, #261, #262), as an Admin and as
// Staff in New York. A simulated tablet running the built plugin sends the
// test tablet's DE1Pro's recorded machine snapshots
// (server/test/fixtures/decaid/de1pro-live-v0.9.0/) as Decaid's
// `stateUpdate`, and serves its local sockets' recorded frames, at first what
// each sent as it opened. Serials are made up, from 27001.
const server = useFreshServer();
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const shot = machineSnapshots("shot.json");
const hotWater = machineSnapshots("hot-water.json");
/** The first snapshot of a recording in that state and substate. */
const first = (snapshots: Record<string, unknown>[], state: string, substate: string) =>
  snapshots.find((snapshot) => stateOf(snapshot).state === state && stateOf(snapshot).substate === substate)!;

/** A Machine's tablet, connected, polling every 5 s of its time, which runs 50 times faster here. */
async function connectedTablet(token: string, serial: string): Promise<SimulatedTablet> {
  const tablet = syncingTablet({ token }, { url: server.url() }, { api: derivedDe1Pro({ serial }) });
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}

test("the Live View names each Machine State of a shot and a hot water pour, with Decaid's own in a tooltip, and shows its measurements", async ({ page }) => {
  const { machine, token } = await createMachine(page, "Bar 1");
  // Opened before the tablet connects, so nothing has come yet.
  await page.goto(`/machines/${machine.id}`);
  const card = page.getByRole("region", { name: "Live View" });
  await expect(card).toContainText("Waiting for its Tablet to send what it is doing.");
  // The card sits above the grid of cards, below those that ask for action.
  await expect(page.getByRole("region").first()).toHaveAccessibleName("Live View");
  const tablet = await connectedTablet(token, "27001");
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });

  const state = card.getByRole("group", { name: "Machine State" });
  // A shot's steps by their names in the Workflow's profile, which its frames index; before its first, its Preheat.
  // Reloaded for the Workflow its tablet has reported, which the page reads every 30 s; within the stream's linger.
  const profile = workflowFixture().profile as { title: string; steps: { name: string }[] };
  await page.reload();
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
