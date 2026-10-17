import { describe, expect, it } from "vitest";
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

  it("holds the changes of state reported while held, and sends them after the Workflow once released", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.hold();
    machineEvents.workflowUpdated(dosed(19));
    machineEvents.stateUpdate(state("espresso"));
    expect(deliveries.map((delivery) => delivery.type)).toEqual(["workflow"]);
    machineEvents.release();
    expect(deliveries.map((delivery) => (delivery.type === "workflow" ? delivery.workflow : delivery.state))).toEqual([dosed(18), dosed(19), "espresso"]);
    machineEvents.stateUpdate(state("idle"));
    expect(deliveries.at(-1)).toMatchObject({ type: "machineState", state: "idle" });
  });

  it("attaches a load's values to the next Workflow delivery, keeping each part's earliest before across loads", () => {
    const { machineEvents, deliveries } = events();
    machineEvents.hold();
    machineEvents.attach({ loadBefore: { batch: { before: "b0", written: "b1" } } });
    machineEvents.attach({ loadBefore: { batch: { before: "b1", written: "b2" }, rpm: { before: 800, written: 900 } } });
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.release();
    expect(deliveries[0]).toMatchObject({
      type: "workflow",
      loadBefore: { batch: { before: "b0", written: "b2" }, rpm: { before: 800, written: 900 } },
    });
    machineEvents.workflowUpdated(dosed(19));
    expect(deliveries[1]).not.toHaveProperty("loadBefore");
  });

  it("carries a load's values into the welcome's resend that replaces the delivery carrying them", () => {
    const { machineEvents, deliveries, superseded } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.attach({ loadBefore: { basket: { before: "k0", written: "k1" } } });
    machineEvents.welcome();
    expect(deliveries[1]).toMatchObject({ loadBefore: { basket: { before: "k0", written: "k1" } } });
    machineEvents.welcome();
    expect(superseded.has(deliveries[1]!.id)).toBe(true);
    expect(deliveries[2]).toMatchObject({ loadBefore: { basket: { before: "k0", written: "k1" } } });
  });

  it("does not carry a load's values into a resend replacing a delivery already sent, which the server took them from", () => {
    const { machineEvents, deliveries, sent } = events();
    machineEvents.workflowUpdated(dosed(18));
    machineEvents.attach({ loadBefore: { basket: { before: "k0", written: "k1" } } });
    machineEvents.welcome();
    sent.add(deliveries[1]!.id);
    machineEvents.welcome();
    expect(deliveries[2]).not.toHaveProperty("loadBefore");
  });
});

describe("DYE2 absent", () => {
  it("sends a Workflow whose DYE2 field names a recipe again as DYE2 goes and comes back, every delivery meanwhile saying so, and once held, as released", () => {
    const { machineEvents, deliveries } = events();
    const absent = () => deliveries.flatMap((delivery) => (delivery.type === "workflow" ? [[delivery.workflow, delivery.dye2Absent ?? false]] : []));
    const selected = (dose: number): Workflow => ({ context: { targetDoseWeight: dose, extras: { dye: { v: 1, selection: { kind: "recipe", id: "1" } } } } });
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

  it("sends a Workflow whose DYE2 field names nothing no more often as DYE2 goes, as the server reads none from it anyway", () => {
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
