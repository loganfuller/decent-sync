import { SETTINGS_EDIT_STATES } from "@decent-sync/protocol";
import type { ShotGate } from "./shot-gate.js";

/**
 * Whether the Machine is running nothing, for the plugin's reads of the
 * machine's own settings and sensor calibration, which wait meanwhile
 * (`CollectionCapture`, #403). Decaid answers each by reading the machine
 * over its Bluetooth or USB connection, and a read the machine leaves
 * unanswered has Decaid v0.9.1 drop the machine, which during a Shot costs
 * the Shot. The machine runs nothing while the latest state Decaid reported
 * (`stateUpdate`) is one of SETTINGS_EDIT_STATES, the states a Settings Edit
 * goes ahead in, and no Shot is yet to be stored (`ShotGate.running`). Before
 * the first state update it runs nothing. Decaid sends no update as its
 * machine goes, so the latest state reported still decides then: a machine
 * that went away busy stays busy until Decaid reports a state again.
 */
export class MachineActivity {
  private latest: string | undefined;
  /** Whether it ran nothing as last judged, so only a turn to running nothing is told. */
  private wasRunningNothing = true;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly shot: Pick<ShotGate, "running" | "onEnd">) {
    shot.onEnd(() => this.judge());
  }

  runningNothing(): boolean {
    return (this.latest === undefined || (SETTINGS_EDIT_STATES as readonly string[]).includes(this.latest)) && !this.shot.running();
  }

  /** Decaid's `stateUpdate`, with the machine's state, after the `ShotGate` is told of it. */
  state(state: string): void {
    this.latest = state;
    this.judge();
  }

  /** Calls `listener` each time the machine turns to running nothing. */
  onRunningNothing(listener: () => void): void {
    this.listeners.add(listener);
  }

  private judge(): void {
    const now = this.runningNothing();
    const turned = now && !this.wasRunningNothing;
    this.wasRunningNothing = now;
    if (turned) for (const listener of this.listeners) listener();
  }
}
