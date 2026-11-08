import { describe, expect, it, vi } from "vitest";
import type { MachineStateDelivery, WorkflowDelivery } from "@decent-sync/protocol";
import { type EventOutbox, MachineEvents, machineSettingsDiffer } from "../src/machine-events.js";

// How the plugin's Workflow deliveries are held while its writes into the
// Workflow are under way, and which of them a welcome's resend replaces:
// MachineEvents on an outbox that records what it is given. The outbox
// drops a delivery it is told to supersede that was never sent, as here,
// where nothing connects.

type Workflow = Record<string, unknown>;

/**
 * MachineEvents on an outbox recording each Workflow queued, and the
 * deliveries it was told to supersede, counting the times it said the
 * machine's own settings changed.
 */
function events() {
  let next = 0;
  const queued: { id: string; workflow: Workflow }[] = [];
  const deliveries: (WorkflowDelivery | MachineStateDelivery)[] = [];
  const superseded = new Set<string>();
  /** The deliveries handed to a connection, which the outbox does not drop. */
  const sent = new Set<string>();
  const outbox: EventOutbox = {
    nextId: () => `delivery-${++next}`,
    enqueue: (delivery) => {
      deliveries.push(delivery);
      if (delivery.type === "workflow") queued.push({ id: delivery.id, workflow: delivery.workflow as Workflow });
    },
    supersede: (id) => {
      if (sent.has(id)) return false;
      superseded.add(id);
      return true;
    },
  };
  /** The Workflows queued that are still to be sent. */
  const kept = () => queued.filter(({ id }) => !superseded.has(id)).map(({ workflow }) => workflow);
  const machineSettings = { changes: 0 };
  const machineEvents = new MachineEvents(outbox, () => {}, () => machineSettings.changes++);
  return { machineEvents, queued: () => queued.map(({ workflow }) => workflow), kept, deliveries, superseded, sent, machineSettings };
}

const state = (name: string) => ({ state: { state: name, substate: "ready" } });

const dosed = (dose: number): Workflow => ({ context: { targetDoseWeight: dose } });

describe("Workflow changes held while the plugin writes into the Workflow", () => {
  it("sends a resend asked for while held once released, which the next welcome's replaces as it was never sent", () => {
    const { machineEvents, queued, kept } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.hold();
    machineEvents.welcome();
    machineEvents.release();
    expect(queued()).toEqual([dosed(18), dosed(18)]);
    machineEvents.welcome();
    expect(kept()).toEqual([dosed(18), dosed(18)]);
  });

  it("keeps a change reported while held, with a resend asked for meanwhile, though the next welcome sends the Workflow again", () => {
    const { machineEvents, queued, kept } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.hold();
    machineEvents.welcome();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.release();
    machineEvents.workflowUpdated(dosed(20));
    machineEvents.welcome();
    expect(queued()).toEqual([dosed(18), dosed(19), dosed(20), dosed(20)]);
    // 19 was a change, not only the welcome's resend: replacing it would lose it.
    expect(kept()).toEqual([dosed(18), dosed(19), dosed(20), dosed(20)]);
  });

  it("sends the changes of state reported while held at once, ahead of the Workflow held", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.stateUpdate(state("espresso"));
    expect(deliveries.map((delivery) => (delivery.type === "workflow" ? delivery.workflow : delivery.state))).toEqual([dosed(18), "espresso"]);
    machineEvents.release();
    expect(deliveries.map((delivery) => (delivery.type === "workflow" ? delivery.workflow : delivery.state))).toEqual([dosed(18), "espresso", dosed(19)]);
  });

  it("sends a change held back with the time of the latest report, and where it named another recipe, when it first named it, as before the plugin's own write", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T12:00:00Z") });
    try {
      const { machineEvents, deliveries } = events();
      const times = () => deliveries.flatMap((delivery) => (delivery.type === "workflow" ? [[delivery.observedAt, delivery.recipeNamedAt ?? null]] : []));
      const named = (recipeId: string, dose: number): Workflow => ({ context: { targetDoseWeight: dose, extras: { dye: { v: 1, recipeId } } } });
      machineEvents.workflowUpdated(named("recipe-a", 18));
      machineEvents.hold();
      vi.advanceTimersByTime(1_000);
      // Saved through DYE2's `save-recipe` while the plugin writes the last Loaded Recipe's parts, then that write's echo.
      machineEvents.workflowUpdated(named("recipe-b", 18));
      vi.advanceTimersByTime(1_000);
      machineEvents.workflowUpdated(named("recipe-b", 19));
      vi.advanceTimersByTime(1_000);
      machineEvents.release();
      expect(times()).toEqual([
        ["2026-11-01T12:00:00.000Z", null],
        ["2026-11-01T12:00:02.000Z", "2026-11-01T12:00:01.000Z"],
      ]);
      // Naming the same recipe throughout, it says nothing of when.
      machineEvents.hold();
      vi.advanceTimersByTime(1_000);
      machineEvents.workflowUpdated(named("recipe-b", 20));
      machineEvents.release();
      expect(times().at(-1)).toEqual(["2026-11-01T12:00:04.000Z", null]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Who changed the Workflow", () => {
  /** Each Workflow delivery's dose and cause, with the plugin's write where it names one. */
  const causes = (deliveries: (WorkflowDelivery | MachineStateDelivery)[]) =>
    deliveries.flatMap((delivery) =>
      delivery.type === "workflow" ? [[(delivery.workflow.context as Workflow).targetDoseWeight, delivery.cause, ...(delivery.pluginWrite ? [delivery.pluginWrite] : [])]] : [],
    );

  it("sends a change reported while nothing is held as another's, and one released after a write of the plugin's Decaid took as the plugin's, by that write", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    for (const write of ["load", "loadedRecipe", "clear", "steamOn"] as const) {
      // As LoadedRecipes.ownWrite does: Decaid reports the write's change before it answers it.
      machineEvents.hold();
      machineEvents.workflowUpdated(dosed(19));
      machineEvents.wrote(write);
      machineEvents.release();
      machineEvents.workflowUpdated(dosed(18));
    }
    expect(causes(deliveries)).toEqual([
      [18, "other"],
      ...["load", "loadedRecipe", "clear", "steamOn"].flatMap((write) => [
        [19, "plugin", write],
        [18, "other"],
      ]),
    ]);
  });

  it("sends a change made by another while the plugin's write was held back with it, as the plugin's, by the first write Decaid took", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    // A save into the Loaded Recipe holds a barista's change, then turns steam back on first, as with the Recipe's load after it.
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(20));
    machineEvents.wrote("steamOn");
    machineEvents.release();
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(21));
    machineEvents.wrote("load");
    machineEvents.release();
    expect(causes(deliveries)).toEqual([[18, "other"]]);
    machineEvents.release();
    expect(causes(deliveries)).toEqual([
      [18, "other"],
      [21, "plugin", "steamOn"],
    ]);
  });

  it("sends a change held back while no write of the plugin's was taken as another's, as during a save, or a write Decaid refused", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.release();
    // Told of a write outside a hold, as none is, it changes nothing.
    machineEvents.wrote("load");
    machineEvents.workflowUpdated(dosed(20));
    // A write Decaid took that changed nothing: the next change is another's.
    machineEvents.hold();
    machineEvents.wrote("loadedRecipe");
    machineEvents.release();
    machineEvents.workflowUpdated(dosed(21));
    expect(causes(deliveries)).toEqual([
      [18, "other"],
      [19, "other"],
      [20, "other"],
      [21, "other"],
    ]);
  });

  it("sends the Workflow sent again on a welcome as another's, alone or held back, but where a write of the plugin's made a change held with it", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.welcome();
    machineEvents.hold();
    machineEvents.welcome();
    machineEvents.release();
    // Held back with a write Decaid took that changed nothing, it is still the resend alone.
    machineEvents.hold();
    machineEvents.welcome();
    machineEvents.wrote("load");
    machineEvents.release();
    machineEvents.hold();
    machineEvents.welcome();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.wrote("clear");
    machineEvents.release();
    expect(causes(deliveries)).toEqual([
      [18, "other"],
      [18, "other"],
      [18, "other"],
      [18, "other"],
      [19, "plugin", "clear"],
    ]);
  });
});

describe("DYE2 absent", () => {
  it("sends a Workflow naming a recipe again as DYE2 goes and comes back, every delivery meanwhile saying so, and once held, as released", () => {
    const { machineEvents, deliveries } = events();
    const absent = () => deliveries.flatMap((delivery) => (delivery.type === "workflow" ? [[delivery.workflow, delivery.dye2Absent ?? false]] : []));
    const selected = (dose: number): Workflow => ({ context: { targetDoseWeight: dose, extras: { dye: { v: 1, recipeId: "4b1f0a3e-6c1d-4e7a-9a52-1f0d3c7b2e81" } } } });
    machineEvents.workflowUpdated(selected(18));
    machineEvents.dye2Absent(false);
    machineEvents.dye2Absent(true);
    machineEvents.dye2Absent(true);
    machineEvents.workflowUpdated(selected(19));
    machineEvents.hold();
    machineEvents.dye2Absent(false);
    expect(absent()).toEqual([
      [selected(18), false],
      [selected(18), true],
      [selected(19), true],
    ]);
    machineEvents.release();
    expect(absent().at(-1)).toEqual([selected(19), false]);
  });

  it("sends a Workflow naming no recipe no more often as DYE2 goes, as the server reads none from it anyway", () => {
    const { machineEvents, queued, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.dye2Absent(true);
    expect(queued()).toEqual([dosed(18)]);
    machineEvents.workflowUpdated(dosed(19));
    expect(deliveries.at(-1)).toMatchObject({ workflow: dosed(19), dye2Absent: true });
  });
});

describe("The machine's own settings read again on a Workflow change", () => {
  // The test tablet's steam, hot water and flush settings (server/test/fixtures/decaid/de1pro-v0.8.7/workflow.json).
  const steam = { targetTemperature: 160, duration: 120, flow: 2.500000000000001, stopAtTemperature: 0 };
  const hotWater = { targetTemperature: 65, duration: 30, volume: 100, flow: 10 };
  const rinse = { targetTemperature: 90, duration: 5, flow: 6 };
  const workflow = (changes: Workflow = {}): Workflow => ({
    context: { targetDoseWeight: 18 },
    steamSettings: steam,
    hotWaterData: hotWater,
    rinseData: rinse,
    ...changes,
  });

  it("tells only of a change of the steam, hot water or flush settings, whatever their fields' order", () => {
    expect(machineSettingsDiffer(workflow(), workflow())).toBe(false);
    expect(machineSettingsDiffer(workflow(), workflow({ context: { targetDoseWeight: 19 }, profile: { title: "Londonium" } }))).toBe(false);
    expect(machineSettingsDiffer(workflow(), workflow({ steamSettings: { stopAtTemperature: 0, flow: 2.500000000000001, duration: 120, targetTemperature: 160 } }))).toBe(false);
    expect(machineSettingsDiffer(workflow(), workflow({ steamSettings: { ...steam, flow: 1.5 } }))).toBe(true);
    expect(machineSettingsDiffer(workflow(), workflow({ hotWaterData: { ...hotWater, volume: 120 } }))).toBe(true);
    expect(machineSettingsDiffer(workflow(), workflow({ rinseData: { ...rinse, targetTemperature: 92 } }))).toBe(true);
    const { rinseData: _rinse, ...withoutRinse } = workflow();
    expect(machineSettingsDiffer(workflow(), withoutRinse)).toBe(true);
  });

  it("compares each Workflow with the last one reported, held or not, the first one after loading with nothing", () => {
    const { machineEvents, machineSettings } = events();
    machineEvents.workflowUpdated(workflow());
    expect(machineSettings.changes).toBe(0);
    machineEvents.workflowUpdated(workflow({ context: { targetDoseWeight: 19 } }));
    expect(machineSettings.changes).toBe(0);
    machineEvents.workflowUpdated(workflow({ steamSettings: { ...steam, flow: 1.5 } }));
    expect(machineSettings.changes).toBe(1);
    // As while the plugin writes a Loaded Recipe into the Workflow.
    machineEvents.hold();
    machineEvents.workflowUpdated(workflow({ steamSettings: { ...steam, flow: 1.5 }, rinseData: { ...rinse, flow: 4 } }));
    expect(machineSettings.changes).toBe(2);
    machineEvents.release();
    // A welcome sends the Workflow again, and reads the machine's settings itself.
    machineEvents.welcome();
    machineEvents.workflowUpdated(workflow({ steamSettings: { ...steam, flow: 1.5 }, rinseData: { ...rinse, flow: 4 } }));
    expect(machineSettings.changes).toBe(2);
  });
});

describe("The machine's state told to the Shot gate", () => {
  it("tells of the state in every update, a repeated one included, but queues only a change", () => {
    let next = 0;
    const queued: (WorkflowDelivery | MachineStateDelivery)[] = [];
    const reported: string[] = [];
    const machineEvents = new MachineEvents(
      { nextId: () => `delivery-${++next}`, enqueue: (delivery) => queued.push(delivery), supersede: () => true },
      () => {},
      () => {},
      (state) => reported.push(state),
    );
    const update = (state: string, substate: string) => machineEvents.stateUpdate({ state: { state, substate } });
    update("espresso", "pouring");
    // Repeated, as after the gate was opened on finding no machine.
    update("espresso", "pouring");
    update("idle", "idle");
    expect(reported).toEqual(["espresso", "espresso", "idle"]);
    expect(queued.map((delivery) => delivery.type === "machineState" && delivery.state)).toEqual(["espresso", "idle"]);
  });
});
