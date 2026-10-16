import { afterAll, describe, expect, it } from "vitest";
import type { DecaidAnswer } from "./support/decaid-beans.js";
import { shotFixture } from "./support/shot-fixtures.js";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  SimulatedDye2,
  dye2ProfileFingerprint,
  dye2Selection,
  dye2V020Recording,
  openDye2Dashboard,
  recordedDye2V020Tablet,
} from "./support/simulated-dye2.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated DYE2 v0.1.20 and Streamline v0.2.14 against what they were
// recorded doing on Decaid v0.8.7's Linux release
// (fixtures/decaid/dye2-v0.1.20/, whose README says what each step was):
// the steps are made again on one simulated tablet in the recording's order,
// from the recording's library, the pages' actions through the helpers and
// the script's requests as recorded, and each answer, each read once DYE2
// would have recorded and each push must be what was recorded. No settings
// are given, so the plugin does not connect.

/** How much faster the tablet's clock runs: DYE2's 1.5 s wait and 3 s echo window shrink with it. */
const TIME_SCALE = 20;

/** A step recorded: its exchanges, the reads made once DYE2 would have recorded, and the pushes heard meanwhile. */
interface Step {
  exchanges: Dye2Exchange[];
  after: Dye2Exchange[];
  pushes: unknown[];
}

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

function load(dye2: SimulatedDye2): SimulatedTablet {
  const tablet = SimulatedTablet.load({ settings: {}, api: recordedDye2V020Tablet("10177"), dye2, timeScale: TIME_SCALE });
  tablets.push(tablet);
  return tablet;
}

/** Waits that long on the tablet's clock. */
const waitTablet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms / TIME_SCALE));

/** Waits past DYE2's wait before it records, and its write, as the recording waited 2.5 s. */
const settled = () => waitTablet(2500).then(() => new Promise((resolve) => setTimeout(resolve, 50)));

/** Sends the step's requests as recorded, waiting the tablet's time given before each, and resolves with Decaid's answers. */
async function replay(tablet: SimulatedTablet, step: Step, gaps: number[] = []): Promise<DecaidAnswer[]> {
  const answers: DecaidAnswer[] = [];
  for (const [index, { request }] of step.exchanges.entries()) {
    if (gaps[index]) await waitTablet(gaps[index]);
    answers.push(await tablet.callApi(request.method, request.path, request.body));
  }
  return answers;
}

/** The step's reads made again, once DYE2 would have recorded. */
async function readAfter(tablet: SimulatedTablet, step: Step): Promise<DecaidAnswer[]> {
  const answers: DecaidAnswer[] = [];
  for (const { request } of step.after) answers.push(await tablet.callApi(request.method, request.path));
  return answers;
}

const responses = (exchanges: Dye2Exchange[]) => exchanges.map(({ response }) => response);
const putBody = (step: Step) => step.exchanges.find(({ request }) => request.method === "PUT" && request.path === "/workflow")!.request.body;

/** Checks a step made again: its reads after and its pushes as recorded. */
async function checkAfter(tablet: SimulatedTablet, dye2: SimulatedDye2, step: Step, pushedBefore: number): Promise<void> {
  expect(await readAfter(tablet, step)).toEqual(responses(step.after));
  expect(dye2.pushes.slice(pushedBefore)).toEqual(step.pushes);
}

describe("The simulated DYE2 v0.1.20 and Streamline v0.2.14, made again as recorded", () => {
  runAsSteps();
  const dye2 = new SimulatedDye2();
  const tablet = load(dye2);
  const library = dye2V020Recording<{ profiles: { id: string; profile: { title: string } }[] }>("library");
  const classic = library.profiles.find((record) => record.profile.title === "Classic Italian espresso")!;
  const plugins = dye2V020Recording<Record<string, { listed: unknown[]; selection: Dye2Exchange; store?: Dye2Exchange }>>("plugins");
  const dashboard = dye2V020Recording<Record<string, Step>>("dashboard");
  const recording = dye2V020Recording<Record<string, Step>>("recording");
  const restore = dye2V020Recording<Record<string, Dye2Exchange & { written: Dye2Exchange; answers: Dye2Exchange[] } & Step>>("restore");
  const streamlineSteps = dye2V020Recording<Record<string, Step>>("streamline");
  const listed = async () => ((await tablet.callApi("GET", "/plugins")).body as { id: string }[]).filter((plugin) => plugin.id === DYE2_NAMESPACE);
  const selection = () => tablet.callApi("GET", `/plugins/${DYE2_NAMESPACE}/selection`);
  /** Slot 1 applied on a dashboard opened afresh, and DYE2's 3 s echo window waited out, as the recording selected it between steps. */
  const select = async (slot = "1") => {
    await (await openDye2Dashboard(tablet)).applyRecipe(slot);
    await waitTablet(3500);
  };

  it("is listed loaded, disabled and enabled as DYE2 was, answering 404 while not loaded", async () => {
    expect(await listed()).toEqual(plugins.loaded!.listed);
    expect(await selection()).toEqual(plugins.loaded!.selection.response);
    dye2.disable();
    expect(await listed()).toEqual(plugins.disabled!.listed);
    expect(await selection()).toEqual(plugins.disabled!.selection.response);
    expect(await tablet.callApi("GET", "/store/dye2.reaplugin/selection")).toEqual(plugins.disabled!.store!.response);
    await dye2.enable();
    expect(await listed()).toEqual(plugins.enabled!.listed);
    expect(await selection()).toEqual(plugins.enabled!.selection.response);
    // Its push once it has refreshed its recent favourites, as it loads.
    await expect.poll(() => dye2.pushes.length).toBe(1);
  });

  it("applies a recipe on DYE2's dashboard as recorded, and selects it with DYE2's fingerprint and brew temperature", async () => {
    const step = dashboard.applySlot1!;
    const pushed = dye2.pushes.length;
    const page = await openDye2Dashboard(tablet);
    const applied = await page.applyRecipe("1");
    expect(page.workflow).toEqual(putBody(step));
    expect([applied.workflow, applied.selection]).toEqual(responses(step.exchanges));
    await settled();
    await checkAfter(tablet, dye2, step, pushed);

    const elsewhere = dashboard.writtenElsewhere!;
    let before = dye2.pushes.length;
    expect(await replay(tablet, elsewhere)).toEqual(responses(elsewhere.exchanges));
    await settled();
    await checkAfter(tablet, dye2, elsewhere, before);

    // The page's copy goes back whole with a dial tap, which DYE2 records, and on Done.
    for (const [name, act] of [
      ["dialTap", () => page.tap("grind", 2.6)],
      ["done", () => page.done()],
    ] as const) {
      const recorded = dashboard[name]!;
      before = dye2.pushes.length;
      const answer = await act();
      expect(page.workflow).toEqual(putBody(recorded));
      expect([answer]).toEqual(responses(recorded.exchanges));
      await settled();
      await checkAfter(tablet, dye2, recorded, before);
    }
  });

  it("clears its selection on a recent favourite and on {}, and selects a saved favourite, as recorded", async () => {
    const recent = dashboard.applyRecent!;
    let before = dye2.pushes.length;
    expect(await replay(tablet, recent)).toEqual(responses(recent.exchanges));
    await settled();
    await checkAfter(tablet, dye2, recent, before);
    // As recorded between the steps: slot 2 applied on the dashboard.
    await (await openDye2Dashboard(tablet)).applyRecipe("2");
    for (const name of ["applySavedFavourite", "clear"]) {
      const step = dashboard[name]!;
      before = dye2.pushes.length;
      expect(await replay(tablet, step)).toEqual(responses(step.exchanges));
      await settled();
      await checkAfter(tablet, dye2, step, before);
    }
  });

  it("records each change of the Workflow into the selected recipe as recorded, and clears on a change of profile", async () => {
    const selected = recording.select!;
    let before = dye2.pushes.length;
    const page = await openDye2Dashboard(tablet);
    const applied = await page.applyRecipe("1");
    expect(page.workflow).toEqual(putBody(selected));
    expect([applied.workflow, applied.selection]).toEqual(responses(selected.exchanges));
    await waitTablet(3500);
    await checkAfter(tablet, dye2, selected, before);
    const gaps: Record<string, number[]> = { debounced: [0, 300], echo: [0, 0, 500], afterEcho: [1000] };
    for (const name of ["grind", "dose", "yieldInContext", "brewTemperature", "hotWaterActiveMode", "hotWaterOtherMode", "steamActiveMode", "steamOtherMode", "flush", "debounced", "echo", "afterEcho", "profileChange"]) {
      const step = recording[name]!;
      before = dye2.pushes.length;
      expect(await replay(tablet, step, gaps[name])).toEqual(responses(step.exchanges));
      await settled();
      await checkAfter(tablet, dye2, step, before);
    }
    await select();
    const targetWeight = recording.targetWeightOnly!;
    before = dye2.pushes.length;
    expect(await replay(tablet, targetWeight)).toEqual(responses(targetWeight.exchanges));
    await settled();
    await checkAfter(tablet, dye2, targetWeight, before);
  });

  it("restores its stored selection as it loads again, and pushes once a Shot is stored", async () => {
    // As recorded: slot 1 selected, the profile changed, which clears it but leaves it stored, and Decaid restarted.
    await select();
    await tablet.callApi("PUT", "/workflow", { profile: classic.profile });
    await dye2.reload();
    await settled();
    const step = recording.shot!;
    const before = dye2.pushes.length;
    tablet.pullShot(shotFixture());
    await settled();
    await checkAfter(tablet, dye2, step, before);
  });

  it("restores {} as no selection, and a stored recipe as it was, even one made on another profile, which the next change clears", async () => {
    expect(await tablet.callApi("GET", "/store/dye2.reaplugin/selection")).toEqual(restore.storedAfterClear!.response);
    for (const name of ["restoreEmpty", "restoreRecipe", "restoreDrifted"]) {
      const step = restore[name]!;
      const { request } = step.written;
      expect(await tablet.callApi(request.method, request.path, request.body)).toEqual(step.written.response);
      dye2.disable();
      await dye2.enable();
      const answers: DecaidAnswer[] = [];
      for (let read = 0; read < step.answers.length; read++) answers.push(await selection());
      expect(answers).toEqual(responses(step.answers));
    }
    // Past the push of DYE2's last load.
    await settled();
    const change = restore.driftedClearedOnChange!;
    const before = dye2.pushes.length;
    expect(await replay(tablet, change)).toEqual(responses(change.exchanges));
    await settled();
    await checkAfter(tablet, dye2, change, before);
  });

  let streamline: SimulatedStreamline;

  it("applies and selects a recipe from Streamline's DYE strip as recorded", async () => {
    streamline = await startStreamline(tablet);
    for (const name of ["applySlot2"]) {
      const step = streamlineSteps[name]!;
      const before = dye2.pushes.length;
      const applied = await streamline.applyRecipe("2");
      const put = step.exchanges.find(({ request }) => request.method === "PUT")!;
      const posted = step.exchanges.find(({ request }) => request.path.endsWith("/selection"))!;
      expect([applied.workflow, applied.selection]).toEqual([put.response, posted.response]);
      for (const { request } of step.exchanges.filter(({ request }) => request.path.startsWith("/store/streamline-app/"))) {
        expect(streamline.remembered(request.path.slice("/store/streamline-app/".length) as never)).toEqual(request.body);
      }
      await settled();
      await checkAfter(tablet, dye2, step, before);
    }
  });

  it("writes the yield from Streamline's Drink tile as the profile's target weight, which clears DYE2's selection, as recorded", async () => {
    const step = streamlineSteps.drinkTile!;
    const before = dye2.pushes.length;
    expect([await streamline.setYield(37)]).toEqual(responses(step.exchanges));
    await settled();
    await checkAfter(tablet, dye2, step, before);
    const again = streamlineSteps.applySlot2Again!;
    const applied = await streamline.applyRecipe("2");
    expect([applied.workflow, applied.selection]).toEqual(responses(again.exchanges.filter(({ request }) => request.method !== "POST" || !request.path.startsWith("/store/"))));
  });

  it("clears the batch, coffee, grinder, Basket and RPM after a Shot as Streamline did, which records nothing", async () => {
    // As recorded: Decaid restarted, then a batch and Basket written.
    await dye2.reload();
    await settled();
    const written = streamlineSteps.writtenBeforeShot!;
    let before = dye2.pushes.length;
    expect(await replay(tablet, written)).toEqual(responses(written.exchanges));
    await settled();
    await checkAfter(tablet, dye2, written, before);
    const step = streamlineSteps.shotCleared!;
    before = dye2.pushes.length;
    tablet.pullShot({ ...shotFixture(), id: "dye2-v0.1.20-cleared" });
    await streamline.shotStored();
    await settled();
    await checkAfter(tablet, dye2, step, before);
  });

  it("re-sends a profile's saved dial on a wake as Streamline did, and clears DYE2's selection with its strip switched off", async () => {
    const wake = streamlineSteps.wake!;
    let before = dye2.pushes.length;
    expect([await streamline.wake(classic.id)]).toEqual(responses(wake.exchanges));
    await settled();
    await checkAfter(tablet, dye2, wake, before);
    await streamline.applyRecipe("2");
    await settled();
    const off = streamlineSteps.stripOff!;
    before = dye2.pushes.length;
    expect([await streamline.switchDye2Off()]).toEqual(responses(off.exchanges));
    await settled();
    await checkAfter(tablet, dye2, off, before);
    expect(dye2Selection(tablet)).toBeNull();
  });
});

describe("The simulated DYE2's fingerprint", () => {
  it("is the one DYE2 v0.1.20 stored, for the profile as workflowUpdated carried it and as GET /workflow answered it", () => {
    for (const entry of dye2V020Recording<{ workflowUpdated: unknown; workflow: unknown; profileFingerprint: string }[]>("fingerprints")) {
      expect(dye2ProfileFingerprint(entry.workflowUpdated)).toBe(entry.profileFingerprint);
      expect(dye2ProfileFingerprint(entry.workflow)).toBe(entry.profileFingerprint);
    }
  });
});

/** The simulated tablet's `host.transport`, as the plugin calls it. */
interface Transport {
  open(options: unknown): Promise<{ handle: string }>;
  onEvent(handle: string, listener: (event: Record<string, unknown>) => void): void;
}

describe("DYE2's changed socket on the simulated tablet", () => {
  const url = "ws://localhost:8080/ws/v1/plugins/dye2.reaplugin/changed";

  it("hears each push, is refused while DYE2 is not loaded, and stays open across DYE2's reload, as recorded", async () => {
    const dye2 = new SimulatedDye2();
    const tablet = load(dye2);
    const transport = tablet as unknown as Transport;
    const { handle } = await transport.open({ kind: "websocket", url });
    const events: Record<string, unknown>[] = [];
    transport.onEvent(handle, (event) => events.push(event));
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await expect.poll(() => events).toEqual([{ type: "data", dataType: "text", data: '{"what":"workflow"}' }]);

    const recorded = dye2V020Recording<{ disabled: { socketOpened: { status: number } }; enabled: { socketOpenBeforeClosed: boolean; socketOpenBeforeHeard: unknown[] } }>("plugins");
    dye2.disable();
    await expect(transport.open({ kind: "websocket", url })).rejects.toThrow(`HTTP status code: ${recorded.disabled.socketOpened.status}`);
    await expect(transport.open({ kind: "websocket", url: "ws://localhost:8080/ws/v1/plugins/dye2.reaplugin/selection" })).rejects.toThrow("HTTP status code: 404");
    await dye2.enable();
    expect(recorded.enabled.socketOpenBeforeClosed).toBe(false);
    await expect.poll(() => events.slice(1).map((event) => JSON.parse(String(event.data)))).toEqual(recorded.enabled.socketOpenBeforeHeard);
    expect(events.some((event) => event.type === "close")).toBe(false);
    await expect(transport.open({ kind: "websocket", url: "ws://localhost:8080/ws/v1/plugins/dye2.reaplugin/selection" })).rejects.toThrow("HTTP status code: 400");
  });

  it("holds DYE2's restore of its stored selection, so it answers none meanwhile", async () => {
    const dye2 = new SimulatedDye2();
    const tablet = load(dye2);
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    expect(dye2Selection(tablet)).toEqual({ kind: "recipe", id: "1" });
    const release = dye2.holdRestore();
    const loaded = dye2.reload();
    expect(await tablet.callApi("GET", "/plugins/dye2.reaplugin/selection")).toEqual({ status: 200, body: null });
    release();
    await loaded;
    expect(dye2Selection(tablet)).toEqual({ kind: "recipe", id: "1" });
  });
});
