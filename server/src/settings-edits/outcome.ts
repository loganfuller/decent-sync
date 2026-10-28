import { type SettingsEdited, type SettingsEditedRefusal, isEditable, isSettingsCollectionName, sameValue, settingsField } from "@decent-sync/protocol";

// What came of a Settings Edit (ADR-0023), decided from what it sent and the
// plugin's answer, which carries the edit's fields as the plugin read them
// back after writing: a pure module.

/** A field the Machine stored otherwise than the edit asked: what it holds, or nothing where the read-back did not hold it. */
export interface HeldOtherwise {
  field: string;
  /** As read back; absent where the read-back failed or left the field out. */
  holds?: unknown;
}

export type DecidedOutcome =
  /** Every field read back is within half its step of the value sent. */
  | { outcome: "applied" }
  /** Some field was stored otherwise, as when Decaid truncates a flow multiplier, each named with what it holds. */
  | { outcome: "adjusted"; adjusted: HeldOtherwise[] }
  /**
   * The plugin did not write it, or Decaid refused, with the fields the
   * read-back after a Decaid refusal shows changed from what the edit
   * expected, as Decaid applies its settings fields one at a time; none for
   * a wake schedule added, which expected nothing.
   */
  | { outcome: "refused"; reason: SettingsEditedRefusal; changed: string[] };

/**
 * What the edit sent: its collection, each field's new value, and what each
 * was expected to hold; for a wake schedule (`scheduled`), the whole
 * schedule as reported, or nothing for an add.
 */
export interface SentEdit {
  collection: string;
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
  scheduled?: boolean;
}

/** Decides what came of an edit from its answer. */
export function decideOutcome(edit: SentEdit, answer: Pick<SettingsEdited, "outcome" | "reason" | "values">): DecidedOutcome {
  if (answer.outcome === "refused") {
    const values = answer.values;
    // A schedule added had no values before it to change from.
    const before = edit.scheduled && Object.keys(edit.expected).length === 0 ? undefined : edit.expected;
    const changed = answer.reason === "decaid" && values && before ? Object.keys(edit.fields).filter((field) => field in values && !sameValue(values[field], before[field])) : [];
    return { outcome: "refused", reason: answer.reason ?? "decaid", changed };
  }
  const adjusted = heldOtherwise(edit, answer.values);
  return adjusted.length === 0 ? { outcome: "applied" } : { outcome: "adjusted", adjusted };
}

/** The edit's fields the values read back do not hold as sent, within half a step, in the edit's order. */
export function heldOtherwise(edit: Pick<SentEdit, "collection" | "fields">, values: Record<string, unknown> | null | undefined): HeldOtherwise[] {
  return Object.entries(edit.fields).flatMap(([field, sent]): HeldOtherwise[] => {
    if (!values || !(field in values)) return [{ field }];
    return holdsAsSent(edit.collection, field, sent, values[field]) ? [] : [{ field, holds: values[field] }];
  });
}

/**
 * Whether a value read back holds what was sent: within half the field's
 * step for a number, a step of 1 for a whole number or a time of day, and
 * the same JSON for anything else (`sameValue`).
 */
function holdsAsSent(collection: string, path: string, sent: unknown, read: unknown): boolean {
  const step = stepOf(collection, path);
  if (step !== undefined && typeof sent === "number" && typeof read === "number") return Math.abs(read - sent) <= step / 2;
  return sameValue(sent, read);
}

function stepOf(collection: string, path: string): number | undefined {
  // A wake schedule's fields have no step: its keep-awake time is a whole number, compared as it is.
  const field = isSettingsCollectionName(collection) ? settingsField(collection, path) : undefined;
  if (!field || !isEditable(field)) return undefined;
  if (field.kind === "number") return field.step;
  return field.kind === "wholeNumber" || field.kind === "timeOfDay" ? 1 : undefined;
}
