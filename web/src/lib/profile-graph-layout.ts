import type { Profile, Sample, ShotCurve, SimulatedRun } from "@decent-sync/protocol";

// The Profile graph's layout (#578), apart from its drawing, so the drag
// editing of #579 can turn a point under the pointer back into a time and a
// value: the time axis, the lanes and their ranges, and the scales between
// seconds and values and the graph's pixels, each way.

export type Lane = "pressure" | "flow" | "temperature";

export const LANES: readonly { key: Lane; title: string; unit: string }[] = [
  { key: "pressure", title: "Pressure", unit: "bar" },
  { key: "flow", title: "Flow", unit: "ml/s" },
  { key: "temperature", title: "Temperature", unit: "°C" },
];

/** Each lane's range, low to high, in its unit. */
export type LaneRanges = Record<Lane, readonly [number, number]>;

/** The highest a pressure or flow lane reaches, bar or ml/s, past any a Machine runs at, so a Profile's outlandish value can't stretch it away. */
export const LANE_CEILING = 20;
/** The range of temperatures, °C, the temperature lane may span. */
export const TEMPERATURE_FLOOR = 0;
export const TEMPERATURE_CEILING = 110;
/** Below this width, px, as a phone's, the lanes are shorter. */
export const NARROW = 560;

const TOP = 44;
const LEFT = 36;
const RIGHT = 8;
const LANE_GAP = 22;
const CUP_ROW = 30;
const AXIS_ROW = 22;

/** A round top for an axis holding `value`, at least `least`, on a step of `step`. */
function roundUp(value: number, least: number, step: number): number {
  return Math.max(least, Math.ceil((value + 0.001) / step) * step);
}

/**
 * The time axis, s: its end, a little past what was reached so the plan
 * beyond a stop shows without dwarfing the run, but no further than the plan
 * runs, and its tick, so that the axis has a dozen intervals at most past
 * 40 s, however long a run, as a fine or coarse puck runs for minutes.
 */
export function timeAxis(reached: number, plannedEnd: number): { end: number; tick: number } {
  const span = Math.min(Math.max(reached * 1.15, reached + 3), Math.max(plannedEnd, reached + 1));
  const tick = span > 1440 ? 300 : span > 720 ? 120 : span > 240 ? 60 : span > 90 ? 20 : span > 40 ? 10 : 5;
  return { end: Math.max(tick, Math.ceil(span / tick) * tick), tick };
}

/**
 * The grams between marks of the weight in the cup: 10 g, or the next of
 * 20, 50, 100 and so on that keeps to ten marks at most, as a pour-over or a
 * long run on a coarse puck puts hundreds of grams or more in the cup.
 */
export function cupStep(weight: number): number {
  for (let step = 10; ; step *= 10) {
    for (const each of [step, step * 2, step * 5]) if (weight / each <= 10) return each;
  }
}

/**
 * Each lane's range: what the run, its plan, the steps' targets, exits and
 * limits, and the compared record reach in it, pressure and flow from 0 to
 * at most `LANE_CEILING`, temperature within `TEMPERATURE_FLOOR` and
 * `TEMPERATURE_CEILING`.
 */
export function laneRanges(profile: Profile, run: SimulatedRun, compared: readonly Sample<ShotCurve>[] = []): LaneRanges {
  const laneMax = (lane: "pressure" | "flow") => {
    const values = [
      ...run.samples.map((sample) => Math.max(sample.values[lane] ?? 0, sample.targets[lane] ?? 0)),
      ...compared.map((sample) => sample.values[lane] ?? 0),
      ...profile.steps.map((step) => (step.pump === lane ? (step.pump === "pressure" ? step.pressure : step.flow) : 0)),
      ...profile.steps.map((step) => (step.exit?.type === lane ? step.exit.value : 0)),
      ...profile.steps.map((step) => (step.limiter && step.limiter.value > 0 && (step.pump === "pressure" ? "flow" : "pressure") === lane ? step.limiter.value : 0)),
    ];
    return roundUp(Math.min(LANE_CEILING, Math.max(0, ...values)), 4, 2);
  };
  const temperatures = [
    ...profile.steps.map((step) => step.temperature).filter((value) => value > 0),
    ...compared.flatMap((sample) => (sample.values.temperature === null || sample.values.temperature === undefined ? [] : [sample.values.temperature])),
  ].map((value) => Math.min(TEMPERATURE_CEILING, Math.max(TEMPERATURE_FLOOR, value)));
  const low = temperatures.length > 0 ? Math.floor((Math.min(...temperatures) - 2) / 5) * 5 : 80;
  const high = temperatures.length > 0 ? Math.max(low + 10, Math.ceil((Math.max(...temperatures) + 2) / 5) * 5) : 100;
  return { pressure: [0, laneMax("pressure")], flow: [0, laneMax("flow")], temperature: [low, high] };
}

/** A lane's grid values: every 2 or 4 bar or ml/s, every 5 or 10 °C, and never more than a dozen or so, whatever the range. */
export function laneTicks(lane: Lane, [low, high]: readonly [number, number]): number[] {
  if (!(high > low)) return [low];
  const step = Math.max(lane === "temperature" ? (high - low > 20 ? 10 : 5) : high > 12 ? 4 : 2, (high - low) / 12);
  const ticks: number[] = [];
  for (let value = low; value <= high + 0.001; value += step) ticks.push(value);
  return ticks;
}

export interface GraphLayout {
  width: number;
  height: number;
  /** Shorter lanes, as on a phone. */
  short: boolean;
  /** The time axis's end and tick, s. */
  end: number;
  tick: number;
  ranges: LaneRanges;
  /** Where the lanes are drawn: from the left of the first lane's values to the right edge, and from the top of the first lane to the bottom of the last. */
  plot: { left: number; right: number; top: number; bottom: number };
  /** Each lane's box, top to bottom. */
  lanes: Record<Lane, { top: number; bottom: number }>;
  /** The row of the weight in the cup. */
  cupY: number;
  /** A time's x, held to the axis. */
  x(seconds: number): number;
  /** A value's y in its lane, held to the lane's range. */
  y(lane: Lane, value: number): number;
  /** The time at an x, unheld: before 0 or past the end where the x is. */
  secondsAt(x: number): number;
  /** The value at a y in a lane, unheld: outside the range where the y is outside the lane. */
  valueAt(lane: Lane, y: number): number;
  /** The time axis's labelled times, s. */
  timeTicks(): number[];
}

/**
 * The graph laid out at `width`, px, on a time axis to `end`, s, with a tick
 * every `tick`, and lanes of `ranges`, which the caller may pin, as while a
 * target is dragged, so the lane under the pointer does not rescale.
 */
export function graphLayout({ width, end, tick, ranges }: { width: number; end: number; tick: number; ranges: LaneRanges }): GraphLayout {
  const short = width > 0 && width < NARROW;
  const laneHeight = short ? 84 : 120;
  const laneTop = (index: number) => TOP + index * (laneHeight + LANE_GAP);
  const lanes = Object.fromEntries(LANES.map((lane, index) => [lane.key, { top: laneTop(index), bottom: laneTop(index) + laneHeight }])) as Record<Lane, { top: number; bottom: number }>;
  const bottom = lanes.temperature.bottom;
  const right = Math.max(LEFT + 40, width - RIGHT);
  const plotWidth = right - LEFT;
  const span = (lane: Lane) => {
    const [low, high] = ranges[lane];
    return high > low ? high - low : 1;
  };
  return {
    width,
    height: bottom + CUP_ROW + AXIS_ROW,
    short,
    end,
    tick,
    ranges,
    plot: { left: LEFT, right, top: TOP, bottom },
    lanes,
    cupY: bottom + 18,
    x: (seconds) => LEFT + (Math.min(Math.max(seconds, 0), end) / end) * plotWidth,
    y: (lane, value) => {
      const [low, high] = ranges[lane];
      return lanes[lane].bottom - ((Math.min(Math.max(value, low), high) - low) / span(lane)) * laneHeight;
    },
    secondsAt: (x) => ((x - LEFT) / plotWidth) * end,
    valueAt: (lane, y) => ranges[lane][0] + ((lanes[lane].bottom - y) / laneHeight) * span(lane),
    timeTicks: () => Array.from({ length: Math.floor(end / tick) + 1 }, (_, index) => index * tick),
  };
}

/** A label to place in a lane: its left and width, px, and the lines it may sit above (`top`) or below (`bottom`), such as a threshold, or a limit band's edges. */
export interface LaneLabel {
  x: number;
  width: number;
  top: number;
  bottom: number;
}

/** A box drawn on the graph, px. */
export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Text's height, px, as the lane labels are drawn, and the gap kept from a line. */
const LABEL_HEIGHT = 11;
const LABEL_GAP = 4;

/**
 * Where each label's baseline goes, in order, in a lane from `laneTop` to
 * `laneBottom`: above its line, else below it, else further off, each kept
 * clear of the labels placed before it and, where it can be, of the curves'
 * points `curves` ([x, y], px), and inside the lane. `taken` are boxes
 * already drawn there, such as the lane's name.
 */
export function placeLabels(
  labels: readonly LaneLabel[],
  laneTop: number,
  laneBottom: number,
  curves: readonly (readonly [number, number])[] = [],
  taken: readonly LabelBox[] = [],
): number[] {
  const placed: LabelBox[] = [...taken];
  return labels.map((label) => {
    const candidates: number[] = [];
    for (let away = 0; away < 4; away++) {
      candidates.push(label.top - LABEL_GAP - away * (LABEL_HEIGHT + 2));
      candidates.push(label.bottom + LABEL_GAP + LABEL_HEIGHT + away * (LABEL_HEIGHT + 2));
    }
    const box = (baseline: number) => ({ left: label.x, right: label.x + label.width, top: baseline - LABEL_HEIGHT, bottom: baseline + 2 });
    const cost = (baseline: number) => {
      const here = box(baseline);
      const clashes = placed.filter((other) => other.left < here.right && here.left < other.right && other.top < here.bottom && here.top < other.bottom).length;
      const outside = here.top < laneTop || here.bottom > laneBottom ? 1 : 0;
      const crossed = curves.filter(([x, y]) => x >= here.left && x <= here.right && y >= here.top - 1 && y <= here.bottom + 1).length > 0 ? 1 : 0;
      return clashes * 100 + outside * 10 + crossed;
    };
    let best = candidates[0]!;
    for (const candidate of candidates) if (cost(candidate) < cost(best)) best = candidate;
    placed.push(box(best));
    return best;
  });
}
