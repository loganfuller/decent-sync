import type { WorkflowDelivery } from "@decent-sync/protocol";
import type { WorkflowChanges } from "./library-writes.js";
import type { Outbox } from "./outbox.js";

/**
 * Workflow changes and machine state transitions, sent through the outbox as
 * timed events. Each carries the time the plugin observed it, by its own
 * clock in UTC, since the outbox may deliver it minutes later. A state
 * update's own `timestamp` is the tablet's local time without an offset, so
 * it is not used. The server records only changes, judged against what it
 * stored last, so sending one again is harmless.
 */
export class MachineEvents implements WorkflowChanges {
  /** The latest Workflow Decaid reported. */
  private workflow: Record<string, unknown> | undefined;
  /**
   * Set while the plugin writes the shared settings into the Workflow
   * (`LibraryWrites`): a change Decaid reports meanwhile is sent once the
   * write's answer is queued, so the server reads the answer first.
   */
  private held = false;
  /** A change reported while held, which `release` sends. */
  private heldChange = false;
  /** The delivery that sent it again on the latest welcome, which the next welcome's replaces. */
  private resent: string | undefined;
  /** The state and substate last queued, so repeated state updates send nothing. */
  private state: { state: string; substate: string } | undefined;

  constructor(private readonly outbox: Outbox) {}

  /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
  workflowUpdated(payload: unknown): void {
    const workflow = object(payload);
    if (!workflow) return;
    this.workflow = workflow;
    if (this.held) this.heldChange = true;
    else this.queueWorkflow(workflow);
  }

  /** Holds back the Workflow's changes, as a write of the shared settings begins. */
  hold(): void {
    this.held = true;
  }

  /**
   * Sends the latest Workflow, observed now, if it changed while held: that
   * holds the plugin's own write, and any change a barista made meanwhile.
   */
  release(): void {
    this.held = false;
    if (!this.heldChange || !this.workflow) return;
    this.heldChange = false;
    this.queueWorkflow(this.workflow);
  }

  /**
   * Decaid's `stateUpdate`, which arrives several times a second while a
   * machine is connected: only a change of state or substate is sent.
   */
  stateUpdate(payload: unknown): void {
    const reported = object(object(payload)?.state);
    const state = reported?.state;
    const substate = reported?.substate;
    if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return;
    if (this.state?.state === state && this.state.substate === substate) return;
    this.state = { state, substate };
    this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
  }

  /**
   * On every welcome, before the outbox sends, the latest Workflow again,
   * observed now, behind whatever the last connection left unacknowledged.
   * The connection may stand for other hardware than the last one did,
   * after the tablet moved to another machine, and the server changes nothing
   * for a delivery it has handled, even one handled for the last hardware but
   * not acknowledged, so it is always a new delivery; the server records
   * nothing if it is unchanged. It replaces the one the last welcome queued,
   * if that is still queued. The next state update is sent whatever it is,
   * for the same reason.
   */
  welcome(): void {
    this.state = undefined;
    this.resend();
  }

  /**
   * Sends the latest Workflow again, observed now, as on a welcome: the
   * server asks for it with every collection when the Machine's Location
   * changes (`requestCollections`), so the tablet takes the new Location's
   * settings, or sets them, and its Workflow's grinder and batch are judged
   * there (ADR-0008).
   */
  resend(): void {
    if (!this.workflow) return;
    if (this.resent !== undefined) this.outbox.discard(this.resent);
    this.resent = undefined;
    // Sent once the write under way is answered, which it may hold already.
    if (this.held) this.heldChange = true;
    else this.resent = this.queueWorkflow(this.workflow);
  }

  /** Queues the Workflow as observed now, returning its delivery's id. */
  private queueWorkflow(workflow: Record<string, unknown>): string {
    const delivery: WorkflowDelivery = { type: "workflow", id: this.outbox.nextId(), observedAt: now(), workflow };
    this.outbox.enqueue(delivery);
    return delivery.id;
  }
}

/** Now, by the tablet's clock, in UTC. */
function now(): string {
  return new Date().toISOString();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
