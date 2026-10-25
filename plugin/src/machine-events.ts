import { MACHINE_SETTING_PARTS, type MachineStateDelivery, type WorkflowDelivery, dye2RecipeIdOf, sameValue } from "@decent-sync/protocol";

/**
 * Holds back the changes of the tablet's Workflow the plugin sends while it
 * writes into it, clearing its grinder, batch and Basket (`LibraryWrites`)
 * or for its Loaded Recipe (`LoadedRecipes`), or saves a change of it into
 * the Loaded Recipe, and sends the latest once released (`MachineEvents`).
 */
export interface WorkflowChanges {
  hold(): void;
  release(): void;
  /**
   * Whether DYE2 is not there (`WorkflowDelivery.dye2Absent`), which every
   * Workflow delivery queued from then on carries: the latest Workflow is
   * sent again as it changes, where it names a recipe, which the server
   * reads otherwise then.
   */
  dye2Absent(absent: boolean): void;
}

/** What MachineEvents needs of the plugin's one outbox (`Outbox`). */
export interface EventOutbox {
  nextId(): string;
  enqueue(delivery: WorkflowDelivery | MachineStateDelivery): void;
  /** Drops a delivery that is no longer needed, unless it was ever sent: whether it dropped it. */
  supersede(id: string): boolean;
}

/**
 * Workflow changes and machine state transitions, sent through the outbox as
 * timed events. Each carries the time the plugin observed it, by its own
 * clock in UTC, since the outbox may deliver it minutes later. A state
 * update's own `timestamp` is the tablet's local time without an offset, so
 * it is not used. The server records only changes, judged against what it
 * stored last, so sending one again is harmless.
 */
export class MachineEvents implements WorkflowChanges {
  /** The latest Workflow Decaid reported, and when. */
  private workflow: Record<string, unknown> | undefined;
  private reportedAt = now();
  /**
   * How many of the plugin's writes into the Workflow, and saves of its
   * changes into the Loaded Recipe, are under way: the server's writes
   * (`LibraryWrites`), whose answers the server reads first, a Loaded
   * Recipe's (`LoadedRecipes`), whose echo is no change of the tablet's, and
   * a save, whose recipes the server reads first. A change Decaid reports
   * meanwhile is sent once none is.
   */
  private holds = 0;
  /**
   * Set once a resend was asked for while held (`resend`), and no change was
   * reported while held: the Workflow `release` sends is then that resend
   * alone, which the next welcome's replaces unless it was ever sent. One
   * that holds a change too is no resend: replacing it would lose the change.
   */
  private heldResend = false;
  /** Set once a change was reported while held. */
  private heldReport = false;
  /** A change reported while held, which `release` sends. */
  private heldChange = false;
  /**
   * When Decaid reported the Workflow first naming the recipe it names now
   * (`dye2RecipeIdOf`), where that was while held: `release` sends it as the
   * delivery's `recipeNamedAt`, as a later report meanwhile, such as the
   * plugin's own write's, gives the delivery its `observedAt`.
   */
  private heldNamedAt: string | undefined;
  /** The delivery that sent it again on the latest welcome, which the next welcome's replaces unless it was ever sent. */
  private resent: string | undefined;
  /** The state and substate last queued, so repeated state updates send nothing. */
  private state: { state: string; substate: string } | undefined;
  /** Whether DYE2 is not there, as every Workflow delivery says (`dye2Absent`). */
  private absent = false;

  constructor(
    private readonly outbox: EventOutbox,
    /** Told of each Workflow Decaid reports before it is queued, so it may hold it back (`LoadedRecipes`). */
    private readonly observe: (workflow: Record<string, unknown>) => void = () => {},
    /**
     * Told of each Workflow Decaid reports whose steam, hot water or flush
     * settings differ from the last one's (`machineSettingsDiffer`), once it
     * is queued or held back, so the machine's own settings are read again
     * (`CollectionCapture.readMachineSettings`). The first Workflow after the
     * plugin loads is compared with nothing.
     */
    private readonly machineSettingsChanged: () => void = () => {},
  ) {}

  /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
  workflowUpdated(payload: unknown): void {
    const workflow = object(payload);
    if (!workflow) return;
    const previous = this.workflow;
    this.workflow = workflow;
    this.reportedAt = now();
    this.observe(workflow);
    if (this.holds > 0) {
      if (previous === undefined || dye2RecipeIdOf(previous) !== dye2RecipeIdOf(workflow)) this.heldNamedAt = this.reportedAt;
      this.heldChange = true;
      this.heldReport = true;
    } else this.queueWorkflow(workflow);
    if (previous && machineSettingsDiffer(previous, workflow)) this.machineSettingsChanged();
  }

  /** Holds back the Workflow's changes, as one of the plugin's writes into it begins. */
  hold(): void {
    this.holds++;
  }

  /**
   * Once no write is under way, sends the latest Workflow, observed when
   * Decaid reported it, or now for a resend alone, if it changed while held:
   * that holds the plugin's own writes, and any change a barista made
   * meanwhile. Where the recipe it names changed while held, it says when
   * Decaid first reported it naming that one (`recipeNamedAt`).
   */
  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds > 0) return;
    if (this.heldChange && this.workflow) {
      this.heldChange = false;
      const resend = this.heldResend && !this.heldReport;
      // A change held back keeps the time it was reported, so a Shot pulled after it is not taken for one before it, and when
      // it first named its recipe, so a Shot pulled with that recipe meanwhile is pulled with it.
      const id = this.queueWorkflow(this.workflow, resend ? now() : this.reportedAt, this.heldNamedAt);
      if (resend) this.resent = id;
      this.heldResend = false;
      this.heldReport = false;
      this.heldNamedAt = undefined;
    }
  }

  dye2Absent(absent: boolean): void {
    if (this.absent === absent) return;
    this.absent = absent;
    if (this.workflow && dye2RecipeIdOf(this.workflow) !== null) this.resend();
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
   * unless that was ever sent: one sent on the last connection may still be
   * being stored by the instance that received it, so it is sent again, under
   * its id, ahead of this one, and can never be stored after it. The next
   * state update is sent whatever it is, for the same reason.
   */
  welcome(): void {
    this.state = undefined;
    this.resend();
  }

  /**
   * Sends the latest Workflow again, observed now, as on a welcome: the
   * server asks for it with every collection when the Machine's Location
   * changes (`requestCollections`), so the tablet takes the new Location's
   * settings, or sets them, and its Workflow's grinder, batch and Basket are
   * judged there (ADR-0008).
   */
  resend(): void {
    if (!this.workflow) return;
    if (this.resent !== undefined) this.outbox.supersede(this.resent);
    this.resent = undefined;
    // Sent once the writes under way are answered, which they may hold already.
    if (this.holds > 0) {
      this.heldChange = true;
      this.heldResend = true;
    } else this.resent = this.queueWorkflow(this.workflow);
  }

  /** Queues the Workflow as observed now, returning its delivery's id. */
  private queueWorkflow(workflow: Record<string, unknown>, observedAt = now(), recipeNamedAt?: string): string {
    const delivery: WorkflowDelivery = {
      type: "workflow",
      id: this.outbox.nextId(),
      observedAt,
      workflow,
      ...(this.absent ? { dye2Absent: true } : {}),
      ...(recipeNamedAt !== undefined ? { recipeNamedAt } : {}),
    };
    this.outbox.enqueue(delivery);
    return delivery.id;
  }
}

/**
 * Whether a Workflow's steam, hot water or flush settings
 * (MACHINE_SETTING_PARTS) differ from an earlier one's. Decaid writes those
 * parts to the machine as they change, and reports the Workflow only once
 * the machine holds them (`WorkflowHandler`'s `PUT /workflow` awaits
 * `De1Controller.updateWorkflowSettings` before it sets the Workflow), so
 * the machine's own settings read then are the ones written.
 */
export function machineSettingsDiffer(earlier: Record<string, unknown>, later: Record<string, unknown>): boolean {
  return MACHINE_SETTING_PARTS.some((part) => !sameValue(earlier[part], later[part]));
}

/** Now, by the tablet's clock, in UTC. */
function now(): string {
  return new Date().toISOString();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
