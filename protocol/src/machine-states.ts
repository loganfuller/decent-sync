// Machine State names (#258), defined once for the plugin, which restarts a
// Live View's time in state only when the name changes, and the management
// interface, which shows them in the Live View and the Machines list.
//
// Decaid reports a state and a substate (`MachineState` and
// `MachineSubstate` in decaid:lib/src/models/device/machine.dart), and on
// the wire their Dart enum names, which are what this module reads. Firmware
// 1358 reports the warm-up after a wake as `idle` with `preparingForShot`
// (#259), which Streamline also takes for heating (`isHeatingState` in
// streamline-js:src/modules/app.js); no device on Decaid v0.9.0 reports
// `heating` or `preheating` (`mapDe1ToMachineState` in
// decaid:lib/src/models/device/impl/de1/de1.utils.dart).

import { STEAM_PHASE_NAMES, steamPhaseOf } from "./steam-phases.js";

/** A Machine State as the management interface shows it. */
export interface MachineStateName {
  /** Such as Pulling a shot; one Decaid's names don't give is Decaid's state in words. */
  name: string;
  /** What the substate adds, such as Preinfusion, or null for nothing. */
  detail: string | null;
  /** What Decaid's own names mean, beside them in a tooltip, or null. */
  note: string | null;
}

interface StateRow {
  name: string;
  /** The detail each substate gives; a substate missing here is shown in words, but for `idle`. */
  details?: Readonly<Record<string, string | null>>;
  note?: string;
}

/** The detail of the substate under which Decaid warms up for an activity. */
const HEATING_UP = { preparingForShot: "Heating up" } as const;

const STATES: Readonly<Record<string, StateRow>> = {
  espresso: { name: "Pulling a shot", details: { preparingForShot: "Preparing", preinfusion: "Preinfusion", pouring: "Pouring", pouringDone: "Ending" } },
  hotWater: { name: "Pouring hot water", details: { ...HEATING_UP, pouring: null } },
  flush: { name: "Flushing", details: { ...HEATING_UP, pouring: null } },
  steamRinse: { name: "Cleaning the steam wand", details: { pouring: null } },
  cleaning: { name: "Cleaning" },
  descaling: { name: "Descaling" },
  idle: { name: "Idle", details: HEATING_UP },
  schedIdle: { name: "Idle", details: HEATING_UP, note: "Woken by a wake schedule" },
  sleeping: { name: "Asleep" },
  needsWater: { name: "Needs water" },
  error: { name: "Error" },
  airPurge: { name: "Draining for transport" },
  booting: { name: "Starting up" },
  busy: { name: "Busy" },
  calibration: { name: "Calibrating" },
  selfTest: { name: "Self test" },
  fwUpgrade: { name: "Updating firmware" },
  heating: { name: "Heating" },
  preheating: { name: "Heating" },
};

/**
 * The Machine State Decaid's state and substate name, from #258's table:
 *
 * - `skipStep` is Pulling a shot, with Next step;
 * - `steam` follows a Steam Record's phases (`steamPhaseOf`), so needs the
 *   snapshot's target flow: its purge is Purging, and Preparing, Paused and
 *   Puffing are details of Steaming, as is a substate the phases don't name,
 *   in words;
 * - an error substate is the detail of Error in words, without its `error`;
 * - substate `idle` adds nothing, nor does `pouring` where it is the activity
 *   the name says, such as a hot water pour;
 * - any other state or substate is shown by Decaid's name in words.
 *
 * `snapshot` is the machine snapshot it came in, for its target flow.
 */
export function nameMachineState(state: string, substate: string, snapshot?: unknown): MachineStateName {
  if (state === "skipStep") return { name: "Pulling a shot", detail: "Next step", note: null };
  if (state === "steam") {
    const phase = steamPhaseOf({ ...record(snapshot), state: { state, substate } });
    if (phase === "purge") return { name: "Purging", detail: null, note: null };
    const detail = phase === null ? substateInWords(substate) : phase === "steaming" ? null : STEAM_PHASE_NAMES[phase];
    return { name: "Steaming", detail, note: null };
  }
  const row = STATES[state];
  if (!row) return { name: capitalised(decaidNameInWords(state)), detail: substateInWords(substate), note: null };
  const listed = row.details?.[substate];
  const detail = listed !== undefined ? listed : state === "error" ? errorInWords(substate) : substateInWords(substate);
  return { name: row.name, detail, note: row.note ?? null };
}

/** The Machine State a machine snapshot, as `stateUpdate` carries it, reports, with Decaid's names; null if it reports none. */
export function machineStateOf(snapshot: unknown): (MachineStateName & { state: string; substate: string }) | null {
  const reported = record(record(snapshot).state);
  const { state, substate } = reported;
  if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return null;
  return { state, substate, ...nameMachineState(state, substate, snapshot) };
}

/** A Machine State on one line, its detail after its name: "Pulling a shot · Preinfusion". */
export function machineStateText({ name, detail }: Pick<MachineStateName, "name" | "detail">): string {
  return detail === null ? name : `${name} · ${detail}`;
}

/** Decaid's camelCase names as words, such as "hotWater" as "hot water"; abbreviations such as "OOM" and "NaN" stay. */
export function decaidNameInWords(name: string): string {
  const parts = name.match(/NaN|[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [name];
  return parts.map((part) => (/^[A-Z][a-z]+$/.test(part) ? part.toLowerCase() : part)).join(" ");
}

function substateInWords(substate: string): string | null {
  return substate === "idle" ? null : capitalised(decaidNameInWords(substate));
}

/** An error substate, such as `errorWLevel`, in words without its `error`: "W level". */
function errorInWords(substate: string): string | null {
  const rest = substate.startsWith("error") && substate.length > "error".length ? substate.slice("error".length) : substate;
  return substateInWords(rest);
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
