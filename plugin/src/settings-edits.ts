import {
  type EditableSettingsCollection,
  MAX_REFUSAL_LENGTH,
  SETTINGS_EDIT_STATES,
  type SettingsEdit,
  type SettingsEdited,
  isEditableSettingsCollection,
  sameValue,
  settingsRefusalText,
  validateSettingsEdit,
} from "@decent-sync/protocol";
import type { Reading } from "./change-detection.js";
import { type Answer, request } from "./decaid.js";
import type { Outbox } from "./outbox.js";

// Settings Edits (ADR-0023): one-off writes of a settings collection's
// fields that the server asks for, made through Decaid's routes, those
// Streamline's settings page uses. Decaid and the Machine stay the source of
// truth: nothing is written back later.

/** Where each collection a Settings Edit changes is read and written, in Decaid v0.9.0's API (rest_v1.yml). */
const ROUTES: Readonly<Record<EditableSettingsCollection, string>> = {
  machineSettings: "/machine/settings",
};

/**
 * Reads of the settings collections and Settings Edits, one at a time, in
 * the order they are asked for, apart from the Library's reads and writes
 * (`LibraryAccess`): an edit never waits for a Library write's answer, and
 * a report of a settings collection either holds an edit's write or was
 * queued, to be sent, before the edit began.
 */
export class SettingsAccess {
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const done = this.queue.then(work);
    this.queue = done.catch(() => {});
    return done;
  }
}

/**
 * Queues a report of a settings collection read within `SettingsAccess.run`:
 * if it changed since the last one queued, or whatever it holds when
 * `always`, and counts a read of the machine's own settings for their
 * interval (`CollectionCapture.reportSettings`).
 */
export type SettingsReport = (name: EditableSettingsCollection, reading: Reading, always: boolean) => void;

/**
 * Carries out the server's Settings Edits one at a time, in the order they
 * arrive, within the reads of the settings collections, and answers each
 * through the outbox. For each it reads the machine's state, going ahead
 * only while the machine runs nothing (SETTINGS_EDIT_STATES); reads the
 * collection, going ahead only while every field the edit sets still holds
 * the value it expected; checks the fields against their definitions,
 * writing none without one; and writes only those fields. Whether Decaid
 * took the write or not, it reads the collection again and queues it as a
 * report before the answer, so the server takes in the read-back first.
 * Decaid's settings writes apply fields one at a time, so the read-back
 * decides what each field holds. A Shot started between the state's read
 * and the write is an accepted gap (#220).
 */
export class SettingsEdits {
  constructor(
    private readonly access: SettingsAccess,
    private readonly outbox: Outbox,
    private readonly report: SettingsReport,
    private readonly log: (message: string) => void,
  ) {}

  /** Carries out an edit once the reads and edits before it are done, and queues its answer. It never rejects. */
  apply(edit: SettingsEdit): Promise<void> {
    return this.access.run(async () => {
      let answer: SettingsEdited;
      try {
        answer = await this.carryOut(edit);
      } catch (error) {
        answer = refusedByDecaid(edit, null, `Decaid did not answer: ${describe(error)}`);
      }
      if (answer.outcome === "refused") this.log(`Did not carry out Settings Edit ${edit.id}: ${describeRefusal(answer)}`);
      this.outbox.enqueue(answer);
    });
  }

  private async carryOut(edit: SettingsEdit): Promise<SettingsEdited> {
    if (!isEditableSettingsCollection(edit.collection)) return refusedByDecaid(edit, null, `This plugin does not write ${edit.collection}`);
    // The server checked them as it took the edit; never is a field without a definition written.
    const refusals = validateSettingsEdit(edit, "admin");
    if (refusals.length > 0) return refusedByDecaid(edit, null, `Not written: ${refusals.map((refusal) => settingsRefusalText(edit.collection, refusal)).join("; ")}`);
    const state = await request("GET", "/machine/state");
    if (!state.ok) return refusedByDecaid(edit, state.status, decaidMessage(state));
    const machineState = stateOf(state.text);
    if (machineState === null) return refusedByDecaid(edit, state.status, "Decaid's answer names no machine state");
    if (!(SETTINGS_EDIT_STATES as readonly string[]).includes(machineState)) {
      return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "machineBusy", state: machineState };
    }

    const route = ROUTES[edit.collection];
    const before = await readObject(route);
    if (!before.ok) return refusedByDecaid(edit, before.answer.status, decaidMessage(before.answer));
    this.report(edit.collection, { kind: "value", value: before.value, etag: null }, false);
    if (Object.keys(edit.fields).some((field) => !sameValue(before.value[field], edit.expected[field]))) {
      return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "changedSince", values: edited(edit, before.value) };
    }

    let written: Answer | undefined;
    let failure = "";
    try {
      written = await request("POST", route, edit.fields);
    } catch (error) {
      failure = describe(error);
    }
    // Read back whether or not Decaid took it: a refusal part-way leaves the fields before it written.
    const after = await readObject(route).catch(() => undefined);
    this.report(edit.collection, after?.ok ? { kind: "value", value: after.value, etag: null } : { kind: "unavailable" }, true);
    const values = after?.ok ? { values: edited(edit, after.value) } : {};
    if (written?.ok) return { type: "settingsEdited", id: edit.id, outcome: "written", ...values };
    return { ...refusedByDecaid(edit, written?.status ?? null, written ? decaidMessage(written) : `Decaid did not answer: ${failure}`), ...values };
  }
}

/** A collection's read: its value, an object, or Decaid's answer refusing it. Throws if Decaid does not answer. */
async function readObject(route: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; answer: Answer }> {
  const answer = await request("GET", route);
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (isObject(value)) return { ok: true, value };
  return { ok: false, answer: answer.ok ? { ...answer, text: "Decaid's answer is not an object" } : answer };
}

/** The edit's fields as a read holds them; a field it does not hold is left out. */
function edited(edit: SettingsEdit, value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(edit.fields).filter((field) => field in value).map((field) => [field, value[field]]));
}

function refusedByDecaid(edit: SettingsEdit, status: number | null, message: string): SettingsEdited {
  return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "decaid", status, message: message.slice(0, MAX_REFUSAL_LENGTH) };
}

/** The machine's state in Decaid's answer to `GET /machine/state` (`MachineStateSnapshot`), or null if it names none. */
function stateOf(text: string): string | null {
  const snapshot = parsed(text);
  const state = isObject(snapshot) && isObject(snapshot.state) ? snapshot.state.state : undefined;
  return typeof state === "string" && state !== "" ? state : null;
}

/**
 * What Decaid said in refusing: its `error`, its `message` or both, as its
 * routes answer one or the other (the machine and presence routes `error`,
 * `/settings` `message`), or its body as text, such as shelf's `Internal
 * Server Error`.
 */
function decaidMessage(answer: Answer): string {
  const body = parsed(answer.text);
  const said = isObject(body) ? [body.error, body.message].filter((part): part is string => typeof part === "string" && part !== "") : [];
  if (said.length > 0) return said.join(": ");
  return answer.text === "" ? `Decaid answered ${answer.status}` : answer.text;
}

function describeRefusal(answer: SettingsEdited): string {
  switch (answer.reason) {
    case "machineBusy":
      return `the machine is ${answer.state}`;
    case "changedSince":
      return "a setting changed on the tablet since the report it was made over";
    case "decaid":
      return `${answer.status === null ? "" : `Decaid answered ${answer.status}: `}${answer.message}`;
    default:
      return String(answer.reason);
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
