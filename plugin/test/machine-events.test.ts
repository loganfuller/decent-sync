import { describe, expect, it } from "vitest";
import { type EventOutbox, MachineEvents } from "../src/machine-events.js";

// How the plugin's Workflow deliveries are held while its writes into the
// Workflow are under way, and which of them a welcome's resend replaces:
// MachineEvents on an outbox that records what it is given. The outbox
// drops a delivery it is told to supersede that was never sent, as here,
// where nothing connects.

type Workflow = Record<string, unknown>;

/** MachineEvents on an outbox recording each Workflow queued, and the deliveries it was told to supersede. */
function events() {
  let next = 0;
  const queued: { id: string; workflow: Workflow }[] = [];
  const superseded = new Set<string>();
  const outbox: EventOutbox = {
    nextId: () => `delivery-${++next}`,
    enqueue: (delivery) => {
      if (delivery.type === "workflow") queued.push({ id: delivery.id, workflow: delivery.workflow as Workflow });
    },
    supersede: (id) => {
      superseded.add(id);
    },
  };
  /** The Workflows queued that are still to be sent. */
  const kept = () => queued.filter(({ id }) => !superseded.has(id)).map(({ workflow }) => workflow);
  return { machineEvents: new MachineEvents(outbox), queued: () => queued.map(({ workflow }) => workflow), kept };
}

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
});
