import { SHOT_STATE } from "@decent-sync/protocol";

// Whether the Machine is pulling a Shot, for the plugin's writes into the
// Workflow, which it holds meanwhile (ADR-0022). Decaid writes a Workflow's
// profile to the machine the moment it changes, whatever the machine is
// doing (`WorkflowDeviceSync._onChange` and `_drain` in
// decaid:lib/src/controllers/workflow_device_sync.dart), replacing the
// frames a Shot is still running, and sends a Bengle the Workflow's yield as
// it changes (`BengleSawBridge`), moving where its Shot stops. A Shot runs
// while the machine state Decaid reports is SHOT_STATE, as Streamline v0.2.18
// holds its own profile switches (`profileSendBlocked` in
// streamline-js:src/modules/profile-send-gate.js). It ends once Decaid has
// stored it (`shotStored`), as Decaid stores the Shot with the Workflow as it
// holds it then, up to its 4 s stopping backstop after the state leaves
// espresso (`_persistShotIfNeeded` in
// decaid:lib/src/controllers/de1_state_manager.dart), or SHOT_STORED_WITHIN_MS
// after the state left it, for an espresso Decaid stores no Shot of, as a
// cleaning profile's. An unknown state, before the first update, or once
// no machine is connected, is no Shot, as for Streamline: Decaid sends no
// update as its machine goes.

/** How long after the state leaves espresso a Shot ends, should Decaid store none. */
export const SHOT_STORED_WITHIN_MS = 10_000;

export class ShotGate {
  private pulling = false;
  /** Set from the state leaving espresso until Decaid stores the Shot, or SHOT_STORED_WITHIN_MS have passed. */
  private storing: ReturnType<typeof setTimeout> | undefined;
  /** Those waiting for the Shot to end (`ended`). */
  private readonly waiting = new Set<() => void>();
  /** Told each time a Shot ends (`onEnd`). */
  private readonly ends = new Set<() => void>();
  private stopped = false;

  /** Whether a Shot is being pulled, or is yet to be stored. */
  running(): boolean {
    return this.pulling || this.storing !== undefined;
  }

  /** Decaid's `stateUpdate`, with the machine's state. */
  state(state: string): void {
    if (state === SHOT_STATE) {
      this.pulling = true;
      this.clearStoring();
      return;
    }
    if (!this.pulling) return;
    this.pulling = false;
    this.storing = setTimeout(() => this.end(), SHOT_STORED_WITHIN_MS);
  }

  /** Decaid stored a Shot (`shotStored`). */
  shotStored(): void {
    if (this.storing !== undefined) this.end();
  }

  /** No machine is connected, so no Shot is pulled. */
  machineGone(): void {
    if (this.running()) this.end();
  }

  /**
   * Resolves once no Shot is being pulled, or after `withinMs`, or as the
   * plugin stops: whether it stopped.
   */
  ended(withinMs: number): Promise<boolean> {
    if (!this.running() || this.stopped) return Promise.resolve(this.stopped);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve(this.stopped);
      };
      const timer = setTimeout(done, withinMs);
      this.waiting.add(done);
    });
  }

  /** Calls `listener` each time a Shot ends. */
  onEnd(listener: () => void): void {
    this.ends.add(listener);
  }

  stop(): void {
    this.stopped = true;
    this.clearStoring();
    for (const done of [...this.waiting]) done();
  }

  /** The Shot ended: whatever waits for it goes on. */
  private end(): void {
    this.pulling = false;
    this.clearStoring();
    for (const done of [...this.waiting]) done();
    for (const listener of this.ends) listener();
  }

  private clearStoring(): void {
    if (this.storing !== undefined) clearTimeout(this.storing);
    this.storing = undefined;
  }
}
