import type { CSSProperties } from "react";

// Colors from the data visualization palette's first two categorical slots,
// checked for color vision deficiencies against light and dark surfaces: this
// record and its target are blue, the record compared with it orange. The
// target is also dashed, so it never relies on color alone. Kept apart from
// the recharts charts (curves.tsx), so a page drawing without recharts, as
// the Profile graph does, needn't load it for them.
export const THIS_RECORD = { light: "#2a78d6", dark: "#3987e5" };
export const PREVIOUS_RECORD = { light: "#eb6834", dark: "#d95926" };

/** The colors above as CSS variables, which `RECORD_CLASSES` read: set on an element holding anything drawn with them. */
export const RECORD_VARIABLES = {
  "--this-record": THIS_RECORD.light,
  "--this-record-dark": THIS_RECORD.dark,
  "--previous-record": PREVIOUS_RECORD.light,
  "--previous-record-dark": PREVIOUS_RECORD.dark,
} as CSSProperties;

/** Classes drawing in the colors above, in light and dark, within an element given `RECORD_VARIABLES`. */
export const RECORD_CLASSES = {
  current: {
    stroke: "stroke-(--this-record) dark:stroke-(--this-record-dark)",
    fill: "fill-(--this-record) dark:fill-(--this-record-dark)",
    background: "bg-(--this-record) dark:bg-(--this-record-dark)",
  },
  previous: {
    stroke: "stroke-(--previous-record) dark:stroke-(--previous-record-dark)",
    fill: "fill-(--previous-record) dark:fill-(--previous-record-dark)",
    background: "bg-(--previous-record) dark:bg-(--previous-record-dark)",
  },
} as const;

/**
 * The line a record's curves are drawn with, as a mark beside its name where the two records are named apart from the
 * charts, such as a comparison's table: in the colors above.
 */
export function CurveMark({ of }: { of: "current" | "previous" }) {
  return <span aria-hidden style={RECORD_VARIABLES} className={`h-0.5 w-3.5 shrink-0 rounded-full ${RECORD_CLASSES[of].background}`} />;
}
