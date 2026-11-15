import { GRINDER_SETTING_RANGE_FIELDS } from "@decent-sync/protocol";

// The rules of a Grinder's range and defaults (GRINDER_RANGE_FIELDS in
// protocol/), as DYE2's Grinders page keeps them from v0.1.37 (`submitForm`
// in dye2:dye2-plugin/src/pages/grinders.ts, `buildGrinderBody` in
// utils/grinder-form.ts), for a Grinder created or edited in the management
// interface or through the MCP endpoint: a lowest above a highest is
// refused, for the setting and for the RPM, and a Grinder with named
// positions holds no range or default for its setting. A default outside the
// range is accepted, as DYE2 saves one as typed and bounds it as it is used.
// What a tablet's record holds is taken in as sent. Pure, so module tests
// can drive it.

/** Each range, by what a refusal calls it, with the fields holding its lowest and highest. */
const RANGES = [
  ["setting", "settingMin", "settingMax"],
  ["RPM", "rpmMin", "rpmMax"],
] as const;

/**
 * The range of `content` whose lowest is above its highest, as a refusal
 * says it, or null: of those `changed` holds an end of, so an edit of
 * something else is not refused for a range tablets' edits merged to.
 */
function reversed(content: Readonly<Record<string, unknown>>, changed: Readonly<Record<string, unknown>>): string | null {
  for (const [what, lowest, highest] of RANGES) {
    const [low, high] = [content[lowest], content[highest]];
    if ((lowest in changed || highest in changed) && typeof low === "number" && typeof high === "number" && low > high) {
      return `The lowest ${what} cannot be above the highest`;
    }
  }
  return null;
}

/** That a Grinder with named positions holds no range or default for its setting, where `set` gives it one, or null. */
function namedWithRange(content: Readonly<Record<string, unknown>>, set: Readonly<Record<string, unknown>>): string | null {
  if (!hasNamedPositions(content) || !GRINDER_SETTING_RANGE_FIELDS.some((field) => (set[field] ?? null) !== null)) return null;
  return "A Grinder with named positions holds no range or default for its setting";
}

/** Whether a Grinder's setting is one of its named positions, as Decaid's `settingType` says: any but `numeric`, which one holding none is. */
function hasNamedPositions(content: Readonly<Record<string, unknown>>): boolean {
  return (content.settingType ?? "numeric") !== "numeric";
}

/** What is wrong with a new Grinder's content, or null. */
export function newGrinderProblem(content: Readonly<Record<string, unknown>>): string | null {
  return reversed(content, content) ?? namedWithRange(content, content);
}

/**
 * An edit of a Grinder as it is to be made over its content (`values`, each
 * field it changes with its value, null to clear it), or what is wrong with
 * it: a lowest above a highest, where it changes either, or a range or
 * default of the setting it sets on a Grinder it leaves with named
 * positions. An edit that leaves the Grinder with named positions clears
 * the range and default of its setting where it holds one, as DYE2's edit
 * writes the three null.
 */
export function grinderEdit(content: Readonly<Record<string, unknown>>, values: Readonly<Record<string, unknown>>): { values: Record<string, unknown> } | { problem: string } {
  const after = { ...content, ...values };
  const problem = reversed(after, values) ?? namedWithRange(after, values);
  if (problem !== null) return { problem };
  const edited: Record<string, unknown> = { ...values };
  if (hasNamedPositions(after)) {
    for (const field of GRINDER_SETTING_RANGE_FIELDS) {
      if (!(field in values) && (content[field] ?? null) !== null) edited[field] = null;
    }
  }
  return { values: edited };
}
