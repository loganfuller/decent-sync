import { afterAll, describe, expect, it } from "vitest";
import type { DecaidAnswer } from "./support/decaid-beans.js";
import {
  DYE2_NAMESPACE,
  type Dye2Exchange,
  type Dye2Step,
  SimulatedDye2,
  dye2MainRecording,
  dye2ProfileFingerprint,
  dye2Selection,
  openDye2Dashboard,
  recordedDye2MainTablet,
} from "./support/simulated-dye2.js";
import { type SimulatedStreamline, startStreamline } from "./support/simulated-streamline.js";
import { SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";

// The simulated DYE2 `main` (2cf631c) and Streamline `main` (c006dac)
// against what they were recorded doing on Decaid v0.9.0's Linux release
// (fixtures/decaid/dye2-2cf631c/, whose README says what each step was): the
// steps are made again on one simulated tablet in the recording's order, from
// the recording's library, the pages' actions through the helpers and the
// script's requests as recorded, and each answer, each read once DYE2 would
// have recorded, each push and the context of each Workflow change must be
// what was recorded. No settings are given, so the plugin does not connect.

/** How much faster the tablet's clock runs: DYE2's 1.5 s wait and 3 s echo window shrink with it. */
const TIME_SCALE = 20;

type Record_ = Record<string, unknown>;

const tablets: SimulatedTablet[] = [];
afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

/** A tablet loaded as the recording's was when its selection's steps began, and the context of each Workflow change on it, in order. */
function load(dye2: SimulatedDye2): { tablet: SimulatedTablet; events: unknown[] } {
  const tablet = SimulatedTablet.load({ settings: {}, api: recordedDye2MainTablet("10001"), dye2, timeScale: TIME_SCALE });
  tablets.push(tablet);
  const events: unknown[] = [];
  tablet.onWorkflowChange((workflow) => events.push(structuredClone(workflow.context ?? null)));
  return { tablet, events };
}

/** Waits that long on the tablet's clock. */
const waitTablet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms / TIME_SCALE));

/** Waits past DYE2's wait before it records, and its write, as the recording waited 2.5 s. */
const settled = () => waitTablet(2500).then(() => new Promise((resolve) => setTimeout(resolve, 50)));

const responses = (exchanges: Dye2Exchange[]) => exchanges.map(({ response }) => response);
const putBody = (step: Dye2Step) => step.exchanges.find(({ request }) => request.method === "PUT" && request.path === "/workflow")!.request.body;
/** The step's exchanges but its writes of Streamline's remembered values, which the helpers keep without answering. */
const workflowAndSelection = (step: Dye2Step) => step.exchanges.filter(({ request }) => request.path === "/workflow" || request.path.endsWith("/selection"));

describe("The simulated DYE2 main and Streamline main, made again as recorded", () => {
  runAsSteps();
  const dye2 = new SimulatedDye2();
  const { tablet, events } = load(dye2);
  const library = dye2MainRecording<{ profiles: { id: string; profile: { title: string } }[]; beans: Record_[]; beanBatches: Record_[]; grinders: Record_[] }>("library");
  const classic = library.profiles.find((record) => record.profile.title === "Classic Italian espresso")!;
  const adaptive = library.profiles.find((record) => record.profile.title === "Adaptive v3")!;
  const plugins = dye2MainRecording<Record<string, { listed: unknown[]; selection: Dye2Exchange; store?: Dye2Exchange }>>("plugins");
  const dashboard = dye2MainRecording<Record<string, Dye2Step>>("dashboard");
  const recording = dye2MainRecording<Record<string, Dye2Step>>("recording");
  const restore = dye2MainRecording<Record<string, Dye2Exchange & { written: Dye2Exchange; answers: Dye2Exchange[] } & Dye2Step>>("restore");
  const streamlineSteps = dye2MainRecording<Record<string, Dye2Step>>("streamline");
  const recordedShot = dye2MainRecording<{ pulled: Dye2Exchange }>("shot").pulled.response.body as Record_;
  let shots = 0;
  const pullShot = () => tablet.pullShot({ ...recordedShot, id: `dye2-2cf631c-shot-${++shots}` });
  const listed = async () => ((await tablet.callApi("GET", "/plugins")).body as { id: string }[]).filter((plugin) => plugin.id === DYE2_NAMESPACE);
  const selection = () => tablet.callApi("GET", `/plugins/${DYE2_NAMESPACE}/selection`);

  /** Sends the step's requests as recorded, waiting the tablet's time given before each, and resolves with Decaid's answers. */
  async function replay(step: Dye2Step, gaps: number[] = []): Promise<DecaidAnswer[]> {
    const answers: DecaidAnswer[] = [];
    for (const [index, { request }] of step.exchanges.entries()) {
      if (gaps[index]) await waitTablet(gaps[index]);
      answers.push(await tablet.callApi(request.method, request.path, request.body));
    }
    return answers;
  }

  /** A step's pushes and Workflow changes, counted from now. */
  function mark(): { pushes: number; events: number } {
    return { pushes: dye2.pushes.length, events: events.length };
  }

  /** Checks a step made again, once DYE2 would have recorded: its reads after, its pushes and its Workflow changes as recorded. */
  async function checkAfter(step: Dye2Step, from: { pushes: number; events: number }): Promise<void> {
    const answers: DecaidAnswer[] = [];
    for (const { request } of step.after) answers.push(await tablet.callApi(request.method, request.path));
    expect(answers).toEqual(responses(step.after));
    expect(dye2.pushes.slice(from.pushes)).toEqual(step.pushes);
    expect(events.slice(from.events)).toEqual(step.events);
  }

  /** Replays a step of the script's requests, and checks it once DYE2 would have recorded. */
  async function replayed(step: Dye2Step, gaps: number[] = []): Promise<void> {
    const from = mark();
    expect(await replay(step, gaps)).toEqual(responses(step.exchanges));
    await settled();
    await checkAfter(step, from);
  }

  /** A recipe applied on a dashboard opened afresh, and DYE2's 3 s echo window waited out, as the recording selected between steps. */
  const select = async (slot = "1") => {
    await (await openDye2Dashboard(tablet)).applyRecipe(slot);
    await waitTablet(3500);
  };

  /** Decaid restarted, keeping its data: DYE2 loaded again, and the recording's sockets opened once it had. */
  const restart = async () => {
    await dye2.reload();
    await waitTablet(5000);
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

  it("applies a recipe on DYE2's dashboard as recorded, reading it again, and selects it with its baselines, marking the Workflow", async () => {
    const step = dashboard.applySlot1!;
    const from = mark();
    const page = await openDye2Dashboard(tablet);
    const applied = await page.applyRecipe("1");
    expect(page.lastSent).toEqual(putBody(step));
    expect([applied.workflow, applied.selection]).toEqual(responses(step.exchanges.filter(({ request }) => request.method !== "GET")));
    await settled();
    await checkAfter(step, from);

    // A batch written elsewhere, with nothing armed, is taken as the batch armed; a hot water volume the recipe does not hold is recorded.
    await replayed(dashboard.writtenElsewhere!);

    // The page's copy goes back whole with a dial tap, its batch with it, which clears the selection; Done sends it again.
    for (const [name, act] of [
      ["dialTap", () => page.tap("grind", 2.8)],
      ["done", () => page.done()],
    ] as const) {
      const recorded = dashboard[name]!;
      const before = mark();
      const answer = await act();
      expect(page.lastSent).toEqual(putBody(recorded));
      expect([answer]).toEqual(responses(recorded.exchanges));
      await settled();
      await checkAfter(recorded, before);
    }
  });

  it("clears its selection on a recent favourite and on {}, and selects a saved favourite, as recorded", async () => {
    await replayed(dashboard.applyRecent!);
    // As recorded between the steps: slot 2 applied on the dashboard.
    await (await openDye2Dashboard(tablet)).applyRecipe("2");
    await waitTablet(1500);
    for (const name of ["applySavedFavourite", "clear"]) await replayed(dashboard[name]!);
  });

  it("records each change of the Workflow into the selected recipe as recorded, and clears on a change of profile, batch or grinder", async () => {
    const selected = recording.select!;
    const from = mark();
    const page = await openDye2Dashboard(tablet);
    const applied = await page.applyRecipe("1");
    expect(page.lastSent).toEqual(putBody(selected));
    expect([applied.workflow, applied.selection]).toEqual(responses(selected.exchanges.filter(({ request }) => request.method !== "GET")));
    await waitTablet(3500);
    await checkAfter(selected, from);
    const gaps: Record<string, number[]> = { debounced: [0, 300], echo: [0, 0, 500], afterEcho: [1000] };
    for (const name of ["grind", "dose", "yieldInContext", "brewTemperature", "hotWaterActiveMode", "hotWaterOtherMode", "steamActiveMode", "steamOtherMode", "flush", "debounced", "echo", "afterEcho", "profileChange"]) {
      await replayed(recording[name]!, gaps[name]);
    }
    await select();
    for (const name of ["targetWeightOnly", "rpm", "basket", "machineSettingAdopted", "batchFromEmpty", "batchSwitch"]) await replayed(recording[name]!);
    await select();
    await replayed(recording.grinderSwitch!);
    // As recorded before selecting from Node: a batch, and no grinder, whose Workflow change the recorder heard only once the step had begun.
    const ethiopia = library.beans.find((bean) => bean.name === "Fixture Ethiopia")!;
    const batch = library.beanBatches.find((candidate) => candidate.beanId === ethiopia.id)!;
    const before = mark();
    await tablet.callApi("PUT", "/workflow", { context: { beanBatchId: batch.id, coffeeName: ethiopia.name, coffeeRoaster: ethiopia.roaster, grinderId: null, grinderModel: null } });
    const withBatch = recording.selectWithBatch!;
    expect(await replay(withBatch)).toEqual(responses(withBatch.exchanges));
    await waitTablet(3500);
    await checkAfter(withBatch, before);
    await replayed(recording.batchCleared!);
  });

  it("pushes once a Shot is stored, keeping its selection", async () => {
    // As recorded: Decaid restarted, then slot 2 selected.
    await restart();
    await select("2");
    const step = recording.shot!;
    const from = mark();
    pullShot();
    await settled();
    await checkAfter(step, from);
  });

  it("restores {} as no selection, and a stored recipe as it was, even one made on another profile, which the next change clears", async () => {
    await replayed(restore.clearBeforeRestore!);
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
    await replayed(restore.driftedClearedOnChange!);
  });

  let streamline: SimulatedStreamline;

  /**
   * A Streamline action, checked as recorded: the Workflow it sent, what
   * Decaid and DYE2 answered the action's Workflow writes and selections
   * where it gives them (null where it gives none, as Streamline's clear),
   * then, once DYE2 would have recorded, the step's reads, pushes and
   * Workflow changes.
   */
  async function inStreamline(step: Dye2Step, act: () => Promise<(DecaidAnswer | undefined)[] | null>): Promise<void> {
    const from = mark();
    const sentFrom = streamline.sent.length;
    const answers = await act();
    expect(streamline.sent.slice(sentFrom)).toEqual(step.exchanges.filter(({ request }) => request.method === "PUT").map(({ request }) => request.body));
    if (answers) expect(answers.filter((answer) => answer !== undefined)).toEqual(responses(workflowAndSelection(step).filter(({ request }) => request.method !== "GET")));
    await settled();
    await checkAfter(step, from);
  }

  it("clears the Workflow's DYE2 fields as Streamline starts with nothing selected, and applies and selects a recipe from its DYE strip", async () => {
    streamline = await startStreamline(tablet);
    await inStreamline(streamlineSteps.started!, async () => {
      await streamline.shotStored();
      return null;
    });
    const step = streamlineSteps.applySlot2!;
    await inStreamline(step, async () => {
      const applied = await streamline.applyRecipe("2");
      return [applied.workflow, applied.selection];
    });
    for (const { request } of step.exchanges.filter(({ request }) => request.path.startsWith("/store/streamline-app/"))) {
      expect(streamline.remembered(request.path.slice("/store/streamline-app/".length) as never)).toEqual(request.body);
    }
  });

  it("sends the Workflow's profile with the yield from the Drink and Dose tiles, which DYE2 records, keeping its selection", async () => {
    await inStreamline(streamlineSteps.drinkTile!, async () => [await streamline.setYield(37)]);
    await inStreamline(streamlineSteps.doseTile!, async () => [await streamline.setDose(20)]);
    await inStreamline(streamlineSteps.applySlot2Again!, async () => {
      const applied = await streamline.applyRecipe("2");
      return [applied.workflow, applied.selection];
    });
  });

  it("clears only the barista, drinker and note after a Shot with a recipe selected, which records nothing", async () => {
    // As recorded: Decaid restarted, then Streamline loaded again, which, with the recipe selected, has nothing to clear.
    await restart();
    await inStreamline(streamlineSteps.restarted!, async () => {
      await streamline.shotStored();
      return null;
    });
    await replayed(streamlineSteps.writtenBeforeShot!);
    const step = streamlineSteps.shotCleared!;
    await inStreamline(step, async () => {
      pullShot();
      await streamline.shotStored();
      return null;
    });
  });

  it("leaves the dial alone on a wake onto the selected recipe's profile, and sends the other profile's dial on a wake onto it", async () => {
    await inStreamline(streamlineSteps.wake!, async () => [await streamline.wake(classic.id)]);
    await inStreamline(streamlineSteps.wakeOtherProfile!, async () => [await streamline.wake(adaptive.id)]);
  });

  it("clears the Workflow's DYE2 fields after a Shot with nothing selected", async () => {
    // As recorded: Decaid restarted, then Streamline loaded again.
    await restart();
    await streamline.shotStored();
    await settled();
    await replayed(streamlineSteps.writtenBeforeShotNoSelection!);
    await inStreamline(streamlineSteps.shotClearedNoSelection!, async () => {
      pullShot();
      await streamline.shotStored();
      return null;
    });
  });

  it("retries a strip apply's selection that failed, which clears the recipe selected before, and clears DYE2's selection with its strip switched off", async () => {
    // As recorded: slot 1 selected on DYE2's dashboard.
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await waitTablet(3500);
    const retried = streamlineSteps.applyRetried!;
    const from = mark();
    const sentFrom = streamline.sent.length;
    dye2.refuseSelections(2);
    const applied = await streamline.applyRecipe("2");
    await streamline.settled();
    const posts = workflowAndSelection(retried).filter(({ request }) => request.method !== "GET");
    expect([applied.workflow, applied.selection]).toEqual(responses(posts.slice(0, 2)).map((response, index) => (index === 1 ? { status: 503, body: { error: "Refused for the test" } } : response)));
    expect(posts.map(({ response }) => response.status)).toEqual([200, 503, 503, 200]);
    expect(dye2.asked.slice(-1)).toEqual([{ kind: "recipe", id: "2" }]);
    expect(streamline.sent.slice(sentFrom)).toEqual([putBody(retried)]);
    await settled();
    await checkAfter(retried, from);
    await inStreamline(streamlineSteps.applySlot2BeforeOff!, async () => {
      const again = await streamline.applyRecipe("2");
      return [again.workflow, again.selection];
    });
    await inStreamline(streamlineSteps.stripOff!, async () => [await streamline.switchDye2Off()]);
    expect(dye2Selection(tablet)).toBeNull();
  });
});

describe("The simulated DYE2's fingerprint", () => {
  it("is the one DYE2 main stored, for the profile as workflowUpdated carried it and as GET /workflow answered it", () => {
    for (const entry of dye2MainRecording<{ workflowUpdated: unknown; workflow: unknown; profileFingerprint: string }[]>("fingerprints")) {
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
    const { tablet } = load(dye2);
    const transport = tablet as unknown as Transport;
    const { handle } = await transport.open({ kind: "websocket", url });
    const events: Record<string, unknown>[] = [];
    transport.onEvent(handle, (event) => events.push(event));
    await (await openDye2Dashboard(tablet)).applyRecipe("1");
    await expect.poll(() => events).toEqual([{ type: "data", dataType: "text", data: '{"what":"workflow"}' }]);

    const recorded = dye2MainRecording<{ disabled: { socketOpened: { status: number } }; enabled: { socketOpenBeforeClosed: boolean; socketOpenBeforeHeard: unknown[] } }>("plugins");
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
    const { tablet } = load(dye2);
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
