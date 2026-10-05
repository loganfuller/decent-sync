import type { WorkflowDelivery } from "@decent-sync/protocol";
import { asObject } from "./decaid.js";
import type { Outbox } from "./outbox.js";

/**
 * Workflow changes and machine state transitions, sent through the outbox as
 * timed events. Each carries the time the plugin observed it, by its own
 * clock in UTC, since the outbox may deliver it minutes later. A state
 * update's own `timestamp` is the tablet's local time without an offset, so
 * it is not used. The server records only changes, judged against what it
 * stored last, so sending one again is harmless.
 */
export class MachineEvents {
  /** The latest Workflow Decaid reported, as last queued. */
  private workflow: WorkflowDelivery | undefined;
  /** The state and substate last queued, so repeated state updates send nothing. */
  private state: { state: string; substate: string } | undefined;

  constructor(private readonly outbox: Outbox) {}

  /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
  workflowUpdated(payload: unknown): void {
    const workflow = asObject(payload);
    if (!workflow) return;
    this.queueWorkflow(workflow);
  }

  /**
   * Decaid's `stateUpdate`, which arrives several times a second while a
   * machine is connected: only a change of state or substate is sent.
   */
  stateUpdate(payload: unknown): void {
    const reported = asObject(asObject(payload)?.state);
    const state = reported?.state;
    const substate = reported?.substate;
    if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return;
    if (this.state?.state === state && this.state.substate === substate) return;
    this.state = { state, substate };
    this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
  }

  /**
   * On every welcome, the latest Workflow, unless its delivery is still
   * queued and so is sent anyway. The connection may stand for other
   * hardware than the last one did, after the tablet moved to another
   * machine, so the Workflow is observed again now, and the next state
   * update is sent whatever it is.
   */
  welcome(): void {
    this.state = undefined;
    if (this.workflow && !this.outbox.has(this.workflow.id)) this.queueWorkflow(this.workflow.workflow);
  }

  private queueWorkflow(workflow: Record<string, unknown>): void {
    this.workflow = { type: "workflow", id: this.outbox.nextId(), observedAt: now(), workflow };
    this.outbox.enqueue(this.workflow);
  }
}

/** Now, by the tablet's clock, in UTC. */
function now(): string {
  return new Date().toISOString();
}
