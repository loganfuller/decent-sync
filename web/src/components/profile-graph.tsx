import { type Profile, type ProfileLimits, type Range, type Sample, type ShotCurve, type SimulatedRun, sentStep, stepTarget } from "@decent-sync/protocol";
import { type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, type SVGProps, useEffect, useId, useRef, useState } from "react";
import { RECORD_CLASSES, RECORD_VARIABLES } from "@/components/record-colors";
import {
  type GraphLayout,
  type HandleShape,
  LANES,
  type LabelBox,
  type Lane,
  type LaneLabel,
  type LaneRanges,
  LANE_VALUES_GAP,
  TAG_HEIGHT,
  besideLine,
  besideUpright,
  clear,
  clearest,
  cupStep,
  densified,
  graphLayout,
  handleBox,
  labelBaseline,
  labelBox,
  laneRanges,
  movedLeft,
  laneTicks,
  placeLabels,
  placeTags,
  pointInPlot,
  spaced,
  timeAxis,
} from "@/lib/profile-graph-layout";
import { exitRange, held, targetRange } from "@/lib/profile-edits";
import { exitText, limitText, measure, seconds, stepEndText, stepName } from "@/lib/profile-words";

// A Profile's graph (#578): a simulated run of it in lanes of pressure, flow
// and temperature on one time axis, each step a band named at the top with
// how long it ran and why it ended, the plan dashed behind the run, each
// step's exit a threshold and its limit a band in the lane each acts in, the
// stop marked with the plan it never reached faint beyond it, and marks for
// the first drip and each 10 g in the cup. Drawn in the Shot page's colours:
// blue for the run, orange for the Shot or version compared with it, dashed
// grey for the plan. Pointing at a moment, or moving to it with the arrow
// keys on the graph's time slider, reads the values there.
//
// Editing a Draft (#579), it draws the run of the version the Draft started
// from faint behind it, and handles on the selected step: its target, its
// exit and its maximum time, a bracket of its own past the band's end where
// the step ends sooner. Each is dragged, or moved with the arrow keys as a
// slider; while one is dragged the axes hold still.
//
// What is written in the plot is placed clear of what else is there (#621):
// the lanes' names, the steps' labels, "Not reached" and where each record
// stops keep off one another and the curves, and off a Draft's handles,
// their tags and the bracket, which are drawn over the graph. The bracket's
// tag sits in the gap under the first lane, so it covers no band's name or
// outcome, and the selected step's exit is said by its handle's tag alone.
//
// Its layout (profile-graph-layout.ts) is apart from its drawing, the
// drawing is hidden from screen readers, which read the graph in words from
// its caption, and the readout has its own state, so pointing redraws only
// the readout.

/** A Shot, or another run, drawn over the run in orange. */
export interface GraphCompared {
  /** What the legend and readout call it, such as "The Shot, as it ran" or "Version 1, simulated". */
  label: string;
  samples: Sample<ShotCurve>[];
  /** Where it stopped, s, marked with its name, such as "The Shot stopped"; none to leave it unmarked. */
  stop?: { seconds: number; label: string } | null;
}

/** A run drawn faint behind the run, such as the version a Draft started from, simulated on the same puck. */
export interface GraphBaseline {
  /** What the legend calls it, such as "Version 2, simulated". */
  label: string;
  run: SimulatedRun;
}

/** What a handle on the graph sets of the selected step: its target, its exit's value or its maximum time. */
export type HandleField = "target" | "exit" | "seconds";

/** A Draft's graph being edited: the step selected, whose handles are drawn, and what a handle or a band chosen changes. */
export interface GraphEditing {
  /** The selected step, by index. */
  step: number;
  /** The ranges each handle holds its value to: the widest of the account's models'. */
  limits: ProfileLimits;
  /** A step chosen on the graph, by its band. */
  onSelect(step: number): void;
  /** A handle moved, to `value`. */
  onChange(field: HandleField, value: number): void;
}

/** The graph's width as laid out, measured, so its text stays its size at any width. */
function useWidth(): [RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** The sample at or nearest before `at`, s, of samples in time order; undefined before the first. */
function sampleAt<C extends string>(samples: readonly Sample<C>[], at: number): Sample<C> | undefined {
  let low = 0;
  let high = samples.length - 1;
  if (high < 0 || samples[0]!.seconds > at) return undefined;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (samples[middle]!.seconds <= at) low = middle;
    else high = middle - 1;
  }
  return samples[low];
}

/** The sample at `at`, s, of samples running until `until`, s; undefined before they start and after they end. */
function sampleWithin<C extends string>(samples: readonly Sample<C>[], at: number, until: number): Sample<C> | undefined {
  return at > until + 0.05 ? undefined : sampleAt(samples, at);
}

/** An SVG path through points, broken where a point is null. */
function pathOf(points: readonly ([number, number] | null)[]): string {
  let path = "";
  let drawing = false;
  for (const point of points) {
    if (point === null) {
      drawing = false;
      continue;
    }
    path += `${drawing ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    drawing = true;
  }
  return path;
}

let measuring: { context: CanvasRenderingContext2D | null; family: string } | undefined;

/** How wide text is drawn, px, at `size` px and `weight`, in the page's font; an estimate where there is no canvas to measure with. */
function textWidth(text: string, size: number, weight = 400): number {
  measuring ??= typeof document === "undefined" ? { context: null, family: "" } : { context: document.createElement("canvas").getContext("2d"), family: getComputedStyle(document.body).fontFamily };
  if (!measuring.context) return text.length * size * 0.56;
  measuring.context.font = `${weight} ${size}px ${measuring.family}`;
  return measuring.context.measureText(text).width;
}

/** Text cut to `width`, px, with an ellipsis where it doesn't fit whole. */
function fitText(text: string, width: number, size: number, weight = 400): string {
  if (textWidth(text, size, weight) <= width) return text;
  let kept = text;
  while (kept.length > 0 && textWidth(`${kept.trimEnd()}…`, size, weight) > width) kept = kept.slice(0, -1);
  return kept.trim() === "" ? "" : `${kept.trimEnd()}…`;
}

/** Text drawn cut to fit, with the whole of it as its title where it was cut. */
function FittedText({ text, width, size, weight = 400, ...props }: { text: string; width: number; size: number; weight?: number } & SVGProps<SVGTextElement>) {
  const fitted = fitText(text, width, size, weight);
  return (
    <text {...props}>
      {fitted !== text && <title>{text}</title>}
      {fitted}
    </text>
  );
}

/** The plan beyond a run's stop: each step it did not finish, its target held for the time the machine would run it. */
function planBeyond(profile: Profile, run: SimulatedRun): { from: number; until: number; lane: "pressure" | "flow"; target: number }[] {
  const plan: { from: number; until: number; lane: "pressure" | "flow"; target: number }[] = [];
  let at = run.stop.seconds;
  for (const ran of run.steps) {
    const step = profile.steps[ran.index];
    if (!step) continue;
    const sent = sentStep(step, run.model);
    const finished = ran.end !== null && (ran.reason !== "stop" || ran.end - (ran.start ?? 0) >= sent.seconds);
    if (finished || sent.seconds <= 0) continue;
    const left = ran.start === null ? sent.seconds : sent.seconds - (run.stop.seconds - ran.start);
    if (left <= 0) continue;
    const target = step.pump === "pressure" ? step.pressure : step.flow;
    plan.push({ from: at, until: at + left, lane: step.pump, target });
    at += left;
  }
  return plan;
}

/** A label in a lane: its text, the band it is in, and the lines it may sit above or below. */
interface StepLabel {
  key: string;
  lane: Lane;
  band: number;
  x: number;
  text: string;
  /** Its text whole, where it was cut to fit its band. */
  whole: string;
  width: number;
  top: number;
  bottom: number;
}

export function ProfileGraph({
  profile,
  run,
  runLabel = "Simulated",
  compared,
  baseline,
  editing,
  label,
  ranges: pinned,
}: {
  profile: Profile;
  run: SimulatedRun;
  /** What the legend calls the run. */
  runLabel?: string;
  compared?: GraphCompared | null;
  /** A run drawn faint behind it, such as that of the version a Draft started from. */
  baseline?: GraphBaseline | null;
  /** The selected step's handles, for a Draft. */
  editing?: GraphEditing | null;
  /** The graph in words, for screen readers. */
  label: string;
  /** Lane ranges held as given, as while a target is dragged, rather than fitted to what is drawn. */
  ranges?: Partial<LaneRanges>;
}) {
  const [ref, width] = useWidth();
  const clipId = useId();
  const captionId = useId();
  // The axes as they were when a handle began to be dragged, held still until it is let go.
  const [stillAxes, setStillAxes] = useState<{ end: number; tick: number; ranges: LaneRanges } | null>(null);

  const comparedSamples = (compared?.samples ?? []).filter((sample) => sample.seconds >= 0 && sample.shade === null);
  const comparedEnd = comparedSamples.at(-1)?.seconds ?? 0;
  const baselineRun = baseline?.run;
  const beyond = planBeyond(profile, run);
  // The selected step's maximum time, from its start: the axis shows it, up to about half again as long as the run.
  const selectedRan = editing ? run.steps[editing.step] : undefined;
  const selectedStep = editing ? profile.steps[editing.step] : undefined;
  const bracketAt = selectedRan?.start !== null && selectedRan?.start !== undefined && selectedStep ? selectedRan.start + selectedStep.seconds : null;
  const reached = Math.max(run.duration, comparedEnd, baselineRun?.duration ?? 0, bracketAt === null ? 0 : Math.min(bracketAt, run.duration * 1.6));
  const axis = stillAxes ?? timeAxis(reached, Math.max(beyond.at(-1)?.until ?? reached, bracketAt ?? 0));
  const fitted = { ...laneRanges(profile, run, [...comparedSamples, ...(baselineRun?.samples ?? [])]), ...pinned };
  const layout = graphLayout({ width, end: axis.end, tick: axis.tick, ranges: stillAxes?.ranges ?? fitted });
  const { end } = layout;
  const { x, y, plot, lanes, height, short, cupY, ranges } = layout;

  // A Draft's handles on the selected step and their tags, drawn over the graph: what is written in the plot keeps clear of them.
  const handles = editing ? editHandles(layout, profile, run, editing) : [];
  const tags = placeTags(layout, handles.map((handle) => ({ shape: handle.shape, width: tagWidth(handle.tag) })));
  const bracket = handles.flatMap((handle) => (handle.shape.kind === "bracket" ? [handleBox(handle.shape)] : []))[0] ?? null;
  const covered = [...handles.map((handle) => handleBox(handle.shape)), ...tags];

  // The plan in the lane of each sample's pump, a pump stopped as 0; null where the pump controls the other.
  const stepOf = (sample: Sample<ShotCurve>) => (sample.step ? profile.steps[sample.step.frame] : undefined);
  const planPoints = (lane: "pressure" | "flow") =>
    run.samples.map((sample): [number, number] | null => (stepOf(sample)?.pump === lane ? [x(sample.seconds), y(lane, sample.targets[lane] ?? 0)] : null));
  const temperaturePlan = run.samples.map((sample): [number, number] | null => (sample.targets.temperature === null ? null : [x(sample.seconds), y("temperature", sample.targets.temperature)]));
  const runPoints = (lane: "pressure" | "flow") => run.samples.map((sample): [number, number] | null => (sample.values[lane] === null ? null : [x(sample.seconds), y(lane, sample.values[lane]!)]));
  const comparedPoints = (lane: Lane) =>
    comparedSamples.map((sample): [number, number] | null => (sample.values[lane] === null || sample.values[lane] === undefined ? null : [x(sample.seconds), y(lane, sample.values[lane]!)]));
  const baselinePoints = (lane: "pressure" | "flow") =>
    (baselineRun?.samples ?? []).map((sample): [number, number] | null => (sample.values[lane] === null ? null : [x(sample.seconds), y(lane, sample.values[lane]!)]));
  const points: Record<Lane, { run: ([number, number] | null)[]; plan: ([number, number] | null)[]; compared: ([number, number] | null)[] }> = {
    pressure: { run: runPoints("pressure"), plan: planPoints("pressure"), compared: [...comparedPoints("pressure"), ...baselinePoints("pressure")] },
    flow: { run: runPoints("flow"), plan: planPoints("flow"), compared: [...comparedPoints("flow"), ...baselinePoints("flow")] },
    temperature: { run: [], plan: temperaturePlan, compared: comparedPoints("temperature") },
  };

  const bands = run.steps.flatMap((ran) => (ran.start !== null && ran.end !== null && ran.end > ran.start ? [{ ...ran, start: ran.start, end: ran.end }] : []));
  const notReached = run.steps.some((ran) => ran.start === null);
  const preinfusionEnd = profile.target_volume_count_start > 0 ? run.steps[profile.target_volume_count_start - 1]?.end : null;
  const showsPreinfusion = preinfusionEnd !== null && preinfusionEnd !== undefined && preinfusionEnd > 0;

  // Each band's labels in the lanes: its limit, its exit and its temperature where it differs from the first step's.
  const stepLabels: StepLabel[] = bands.flatMap((band) => {
    const step = profile.steps[band.index];
    if (!step) return [];
    // In its band, and beside the bracket where that crosses it.
    const labelled = (key: string, lane: Lane, whole: string, top: number, bottom: number): StepLabel => {
      const from = x(band.start) + 4;
      const to = Math.max(from, x(band.end) - 4);
      const part = besideUpright(from, to, Math.min(textWidth(whole, 11), to - from), bracket);
      const text = fitText(whole, Math.max(0, part.to - part.from), 11);
      return { key, lane, band: band.index, x: part.from, text, whole, width: textWidth(text, 11), top, bottom };
    };
    const labels: StepLabel[] = [];
    const { limit, capped, exit } = marksOf(step);
    if (limit) {
      labels.push(
        labelled("limit", capped, `${capitalised(limitText(step) ?? "")}, easing over ${measure(limit.range)} ${capped === "flow" ? "ml/s" : "bar"}`, y(capped, limit.value + limit.range), y(capped, limit.value)),
      );
    }
    // The selected step's exit is said by its handle's tag, on the same line.
    if (exit && !(editing?.step === band.index && handles.some((handle) => handle.name === "exit"))) labels.push(labelled("exit", exit.type, `Moves on ${exitText(exit)}`, y(exit.type, exit.value), y(exit.type, exit.value)));
    if (band.index === 0 || step.temperature !== profile.steps[0]?.temperature || step.sensor !== profile.steps[0]?.sensor) {
      const text = band.index === 0 ? `${measure(step.temperature)} °C at the ${step.sensor}` : `${signed(step.temperature - profile.steps[0]!.temperature)} °C, at the ${step.sensor}`;
      labels.push(labelled("temperature", "temperature", text, y("temperature", step.temperature), y("temperature", step.temperature)));
    }
    return labels;
  });
  const within = (lane: Lane): LabelBox => ({ left: plot.left, right: plot.right, top: lanes[lane].top, bottom: lanes[lane].bottom });
  const pick = (candidates: LabelBox[], lane: Lane, curves: readonly (readonly [number, number])[], taken: readonly LabelBox[]) => candidates[clearest(candidates, within(lane), curves, taken)]!;
  const lineBox = (at: number): LabelBox => ({ left: x(at) - 1, right: x(at) + 1, top: plot.top, bottom: plot.bottom });

  // Each lane's name at its right, or left of a handle, its tag or the bracket where one stands on it there; a row lower, down the lane, where no place left of them is clear.
  const titles = Object.fromEntries(
    LANES.map((lane) => {
      const text = `${lane.title} (${lane.unit})`;
      const wide = textWidth(text, 12, 500);
      const rows = Array.from({ length: Math.floor((lanes[lane.key].bottom - lanes[lane.key].top - 18) / 16) + 1 }, (_, row) => {
        const top = lanes[lane.key].top + row * 16;
        return movedLeft({ left: plot.right - 4 - wide, right: plot.right - 4, top, bottom: top + 18 }, covered, plot.left);
      });
      return [lane.key, { text, box: rows.find((box) => clear(box, within(lane.key), covered)) ?? rows[0]! }];
    }),
  ) as Record<Lane, { text: string; box: LabelBox }>;
  // Each lane's curves, as what is written there keeps off them: the compared record's points and the baseline's are two curves, as `points` joins them.
  const laneCurves = Object.fromEntries(
    LANES.map((lane) => [lane.key, [points[lane.key].run, points[lane.key].plan, comparedPoints(lane.key), lane.key === "temperature" ? [] : baselinePoints(lane.key)].flatMap((curve) => densified(curve))]),
  ) as Record<Lane, [number, number][]>;
  const curvesIn = (lane: Lane) => laneCurves[lane];
  // The preinfusion bar's name under its start, a row or two lower under a handle, or right of the bracket; else further down the
  // lane there, then right of whichever handle or tag is in its way; off the curves where it can be.
  const preinfusion = (() => {
    if (!showsPreinfusion) return null;
    const wide = textWidth("Preinfusion", 11);
    const rows = Array.from({ length: Math.floor((lanes.pressure.bottom - 2 - (plot.top + 16)) / 13) + 1 }, (_, row) => row);
    const lefts = [plot.left + 4, ...(bracket ? [bracket.right + 4] : [])];
    const at = (left: number, row: number) => labelBox(Math.max(plot.left, Math.min(left, plot.right - wide)), plot.top + 16 + row * 13, wide);
    const candidates = [
      ...lefts.flatMap((left) => rows.slice(0, 3).map((row) => at(left, row))),
      ...lefts.flatMap((left) => rows.slice(3).map((row) => at(left, row))),
      ...covered.flatMap((box) => rows.map((row) => at(box.right + 4, row))),
    ];
    return pick(candidates, "pressure", curvesIn("pressure"), [...covered, titles.pressure.box]);
  })();
  // What is written in a lane before its steps' labels.
  const named = (lane: Lane): LabelBox[] => [
    { ...titles[lane].box, right: titles[lane].box.right + 4 },
    ...(lane === "pressure" && preinfusion ? [{ left: preinfusion.left - 4, right: preinfusion.right + 4, top: preinfusion.top - 2, bottom: preinfusion.bottom + 2 }] : []),
    ...covered,
  ];

  // The steps' labels, kept apart from each other, the lane's name, the preinfusion bar's, the handles and the curves, lane by lane.
  const baselines = new Map<StepLabel, number>();
  for (const lane of LANES) {
    const here = stepLabels.filter((each) => each.lane === lane.key);
    const placed = placeLabels(here.map((each): LaneLabel => ({ x: each.x, width: each.width, top: each.top, bottom: each.bottom })), lanes[lane.key].top, lanes[lane.key].bottom, curvesIn(lane.key), named(lane.key));
    here.forEach((each, index) => baselines.set(each, placed[index]!));
  }
  const written = (lane: Lane): LabelBox[] => [...named(lane), ...stepLabels.flatMap((each) => (each.lane === lane && each.text !== "" ? [labelBox(each.x, baselines.get(each)!, each.width)] : []))];

  // "Not reached" in the middle of what the run left of the plan, on the wider side of the bracket where that stands there, a row or two
  // up or down, or on the other side, where a handle, its tag or what is written there is in the way; left out where nowhere is clear.
  const unreached = (() => {
    if (!notReached) return null;
    const [from, to] = [x(run.stop.seconds), x(end)];
    const parts = bracket && bracket.right > from && bracket.left < to ? [[from, bracket.left] as const, [bracket.right, to] as const] : [[from, to] as const];
    const wide = textWidth("Not reached", 12);
    const middle = (lanes.pressure.top + lanes.pressure.bottom) / 2;
    const roomy = parts.filter((part) => part[1] - part[0] > 80).sort((one, other) => other[1] - other[0] - (one[1] - one[0]));
    const candidates = roomy.flatMap((part) => [0, -1, 1, -2, 2].map((row) => labelBox((part[0] + part[1] - wide) / 2, middle + row * 13, wide)));
    if (candidates.length === 0) return null;
    const taken = written("pressure");
    const box = pick(candidates, "pressure", [], taken);
    return clear(box, within("pressure"), taken) ? box : null;
  })();

  // Where each record stops: its name beside its line, down its lane to a row clear of the curves, the thresholds, the
  // handles and what is written there, on the other side of the line where no row on the first is.
  const ruled = (lane: Lane): [number, number][] => [
    ...bands.flatMap((band) => {
      const { limit, capped, exit } = marksOf(profile.steps[band.index]);
      return [...(limit && capped === lane ? [y(lane, limit.value)] : []), ...(exit && exit.type === lane ? [y(lane, exit.value)] : [])].flatMap((at) => densified([[x(band.start), at], [x(band.end), at]]));
    }),
    ...beyond.flatMap((part) => (part.lane === lane ? densified([[x(part.from), y(lane, part.target)], [x(Math.min(part.until, end)), y(lane, part.target)]]) : [])),
  ];
  // The first of `texts`, from the fullest, that has a place clear beside its line; the fullest where none has.
  const stopLabel = (texts: string[], size: number, weight: number, at: number, lane: Lane, first: "left" | "right", curves: readonly (readonly [number, number])[], taken: LabelBox[]) => {
    const places = texts.map((text) => ({ text, box: pick(besideLine(x(at), textWidth(text, size, weight), lanes[lane], first), lane, curves, taken) }));
    return places.find((place) => clear(place.box, within(lane), taken)) ?? places[0]!;
  };
  const baselineStop = baseline && baselineRun && Math.abs(baselineRun.stop.seconds - run.stop.seconds) > 0.3 ? { seconds: baselineRun.stop.seconds, text: `${baseline.label.replace(/, simulated$/, "")} stops` } : null;
  const comparedStop = compared?.stop ? { seconds: compared.stop.seconds, texts: [`${compared.stop.label}, ${seconds(compared.stop.seconds)}`, compared.stop.label, seconds(compared.stop.seconds)] } : null;
  const stopLines = [lineBox(run.stop.seconds), ...(comparedStop ? [lineBox(comparedStop.seconds)] : []), ...(baselineStop ? [lineBox(baselineStop.seconds)] : [])];
  const inPressure = [...curvesIn("pressure"), ...ruled("pressure")];
  const beside = [...written("pressure"), ...(unreached ? [unreached] : [])];
  // A label is beside its own line, so that one is left out of what it keeps off. Where its words find no clear place, as on a phone, the run's is its time alone, and the compared record's its name alone, then its time alone.
  const stop = stopLabel([`${run.stop.reason === "weight" ? "Stops" : "Ends"} at ${seconds(run.stop.seconds)}`, seconds(run.stop.seconds)], 12, 600, run.stop.seconds, "pressure", "right", inPressure, [...beside, ...stopLines.slice(1)]);
  // The compared record's on the side away from the run's stop first, so the two seldom cross.
  const comparedStopLabel = comparedStop
    ? stopLabel(comparedStop.texts, 11, 400, comparedStop.seconds, "pressure", comparedStop.seconds > run.stop.seconds ? "right" : "left", inPressure, [...beside, stop.box, ...stopLines.filter((_, index) => index !== 1)])
    : null;
  const baselineStopBox = baselineStop
    ? pick(
        besideLine(x(baselineStop.seconds), textWidth(baselineStop.text, 11), lanes.flow, baselineStop.seconds > run.stop.seconds ? "right" : "left"),
        "flow",
        [...curvesIn("flow"), ...ruled("flow")],
        [...written("flow"), ...stopLines.slice(0, comparedStop ? 2 : 1)],
      )
    : null;

  // The weight in the cup: its first drip, then each 10 g, or a larger round step on a heavier run (`cupStep`), as run.
  const cupMarks: { at: number; text: string }[] = [];
  if (run.timeToFirstDrip !== null) cupMarks.push({ at: run.timeToFirstDrip, text: "First drip" });
  const gramStep = cupStep(run.weight);
  let grams = gramStep;
  for (const sample of run.samples) {
    if (grams >= run.weight) break;
    while (grams < run.weight && (sample.values.weight ?? 0) >= grams) {
      cupMarks.push({ at: sample.seconds, text: `${grams} g` });
      grams += gramStep;
    }
  }
  // A mark's name is held right of the lanes' values, as a first drip's soon after the start is, and left out where it would run into the one before it,
  // and a time where it would run into the axis's end, as on a phone.
  const cupBoxes = cupMarks.map((mark) => {
    const [drip, wide] = [mark.text === "First drip", textWidth(short && mark.text === "First drip" ? "Drip" : mark.text, 11)];
    const left = Math.max(plot.left, drip ? x(mark.at) + 2 - wide : x(mark.at) - wide / 2);
    return { left, right: left + wide };
  });
  const cupNames = spaced(cupBoxes);
  const times = layout.timeTicks();
  const timesWritten = spaced(
    times
      .map((at) => {
        const wide = textWidth(at === end ? `${at} s` : `${at}`, 12);
        return at === end ? { left: x(at) - wide, right: x(at) } : { left: x(at) - wide / 2, right: x(at) + wide / 2 };
      })
      .reverse(),
  ).reverse();

  return (
    <figure ref={ref} aria-labelledby={captionId} style={RECORD_VARIABLES} className="m-0 grid min-w-0 gap-3">
      <figcaption id={captionId} className="sr-only">
        {label}
      </figcaption>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="8">
            <line x1="1" y1="4" x2="21" y2="4" className={RECORD_CLASSES.current.stroke} strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          {runLabel}
        </span>
        {baseline && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="8">
              <line x1="1" y1="4" x2="21" y2="4" className="stroke-muted-foreground/50" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            {baseline.label}
          </span>
        )}
        {compared && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="8">
              <line x1="1" y1="4" x2="21" y2="4" className={RECORD_CLASSES.previous.stroke} strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            {compared.label}
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="8">
            <line x1="1" y1="4" x2="21" y2="4" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          The plan
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="8">
            <line x1="1" y1="4" x2="21" y2="4" className="stroke-foreground" strokeWidth="1.5" strokeDasharray="1 4" strokeLinecap="round" />
          </svg>
          Moves on
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="10">
            <rect x="1" y="1" width="20" height="8" className="fill-foreground/10" />
          </svg>
          Limit
        </span>
      </div>
      {width > 0 && (
        <GraphPointer
          layout={layout}
          profile={profile}
          run={run}
          runLabel={runLabel}
          compared={compared ? { label: compared.label, samples: comparedSamples, end: comparedEnd } : undefined}
          onPick={editing ? (at) => {
            const band = bands.find((each) => at >= each.start && at <= each.end);
            if (band) editing.onSelect(band.index);
          } : undefined}
          overlay={
            editing && (
              <EditHandles
                handles={handles}
                tags={tags}
                editing={editing}
                onHold={(holding) => setStillAxes(holding ? { end: layout.end, tick: layout.tick, ranges: layout.ranges } : null)}
              />
            )
          }
        >
          {/* What the graph shows is its caption, in words; the drawing is left out of what screen readers read. */}
          <svg role="none" width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block text-xs" data-graph-end={end}>
            <defs>
              {bands.map((band) => (
                <clipPath key={band.index} id={`${clipId}-band-${band.index}`}>
                  <rect x={x(band.start)} y={0} width={Math.max(0, x(band.end) - x(band.start) - 2)} height={height} />
                </clipPath>
              ))}
            </defs>
            <g aria-hidden="true">
              {/* Each step a band, every other one shaded, named at the top with how long it ran and why it ended, cut to fit it. */}
              {bands.map((band, order) => {
                const room = Math.max(0, x(band.end) - x(band.start) - 8);
                return (
                  <g key={band.index} data-step-band={band.index}>
                    {order % 2 === 0 && <rect x={x(band.start)} y={plot.top} width={x(band.end) - x(band.start)} height={plot.bottom - plot.top} className="fill-muted/60" />}
                    {editing?.step === band.index && (
                      <g data-selected-band>
                        <rect x={x(band.start)} y={plot.top} width={x(band.end) - x(band.start)} height={plot.bottom - plot.top} className="fill-(--this-record)/[0.07] dark:fill-(--this-record-dark)/[0.14]" />
                        <line x1={x(band.start)} x2={x(band.end)} y1={plot.top - 1} y2={plot.top - 1} className={RECORD_CLASSES.current.stroke} strokeWidth={2} />
                      </g>
                    )}
                    <line x1={x(band.start)} x2={x(band.start)} y1={plot.top} y2={plot.bottom} className="stroke-border" />
                    <g clipPath={`url(#${clipId}-band-${band.index})`}>
                      <FittedText
                        text={`${band.index + 1}  ${stepName(band, band.index)}`}
                        width={room}
                        size={13}
                        weight={600}
                        x={x(band.start) + 4}
                        y={14}
                        className="fill-foreground text-[13px] font-semibold"
                      />
                      <FittedText text={bandDetail(profile, run, band)} width={room} size={12} x={x(band.start) + 4} y={31} className="fill-muted-foreground" />
                    </g>
                  </g>
                );
              })}

              {/* Each lane's grid, values and name. */}
              {LANES.map((lane) => (
                <g key={lane.key} data-lane={lane.key}>
                  {laneTicks(lane.key, ranges[lane.key], lanes[lane.key].bottom - lanes[lane.key].top).map((value) => (
                    <g key={value}>
                      <line x1={plot.left} x2={plot.right} y1={y(lane.key, value)} y2={y(lane.key, value)} className="stroke-border" strokeWidth={value === ranges[lane.key][0] ? 1 : 0.5} />
                      <text x={plot.left - LANE_VALUES_GAP} y={y(lane.key, value) + 4} textAnchor="end" className="fill-muted-foreground" data-lane-value>
                        {measure(value)}
                      </text>
                    </g>
                  ))}
                  <text x={titles[lane.key].box.right} y={titles[lane.key].box.top + 14} textAnchor="end" className="fill-foreground font-medium" data-lane-name>
                    {titles[lane.key].text}
                  </text>
                </g>
              ))}

              {showsPreinfusion && preinfusion && (
                <g data-preinfusion>
                  <rect x={plot.left} y={plot.top} width={x(preinfusionEnd) - plot.left} height={3} className="fill-muted-foreground/50" />
                  <text x={preinfusion.left} y={labelBaseline(preinfusion)} className="fill-muted-foreground text-[11px]">
                    Preinfusion
                  </text>
                </g>
              )}

              {/* Limits as bands in the lane each caps, and exits as thresholds in the lane each watches. */}
              {bands.map((band) => {
                const step = profile.steps[band.index];
                if (!step) return null;
                const { limit, capped, exit } = marksOf(step);
                return (
                  <g key={band.index}>
                    {limit && (
                      <g data-limit={band.index}>
                        <rect
                          x={x(band.start)}
                          width={x(band.end) - x(band.start)}
                          y={y(capped, limit.value + limit.range)}
                          height={Math.max(1, y(capped, limit.value) - y(capped, limit.value + limit.range))}
                          className="fill-foreground/[0.07]"
                        />
                        <line x1={x(band.start)} x2={x(band.end)} y1={y(capped, limit.value)} y2={y(capped, limit.value)} className="stroke-foreground/40" />
                        <StepLabelText labels={stepLabels} baselines={baselines} band={band.index} which="limit" />
                      </g>
                    )}
                    {exit && (
                      <g data-exit={band.index}>
                        <line
                          x1={x(band.start)}
                          x2={x(band.end)}
                          y1={y(exit.type, exit.value)}
                          y2={y(exit.type, exit.value)}
                          className="stroke-foreground"
                          strokeWidth={1.5}
                          strokeDasharray="1 4"
                          strokeLinecap="round"
                        />
                        <StepLabelText labels={stepLabels} baselines={baselines} band={band.index} which="exit" />
                      </g>
                    )}
                    <StepLabelText labels={stepLabels} baselines={baselines} band={band.index} which="temperature" />
                  </g>
                );
              })}

              {/* The plan, dashed behind the run, and faint beyond its stop. */}
              <g className="stroke-muted-foreground" fill="none" strokeWidth={1.5} strokeDasharray="4 3" data-plan>
                <path d={pathOf(points.pressure.plan)} />
                <path d={pathOf(points.flow.plan)} />
                <path d={pathOf(points.temperature.plan)} />
              </g>
              <g className="stroke-muted-foreground/40" fill="none" strokeWidth={1.5} strokeDasharray="4 3" data-plan-beyond>
                {beyond.map((part, index) => (
                  <line key={index} x1={x(part.from)} x2={x(Math.min(part.until, end))} y1={y(part.lane, part.target)} y2={y(part.lane, part.target)} />
                ))}
              </g>
              {unreached && (
                <text x={(unreached.left + unreached.right) / 2} y={labelBaseline(unreached)} textAnchor="middle" className="fill-muted-foreground" data-not-reached>
                  Not reached
                </text>
              )}

              {baseline && baselineRun && (
                <g data-baseline>
                  <g className="stroke-muted-foreground/45" fill="none" strokeWidth={2} strokeLinejoin="round">
                    <path d={pathOf(baselinePoints("pressure"))} />
                    <path d={pathOf(baselinePoints("flow"))} />
                  </g>
                  {baselineStop && baselineStopBox && (
                    <g data-baseline-stop>
                      <line x1={x(baselineStop.seconds)} x2={x(baselineStop.seconds)} y1={plot.top} y2={plot.bottom} className="stroke-muted-foreground/50" strokeDasharray="3 3" />
                      <text {...besideAt(baselineStopBox, x(baselineStop.seconds))} className="fill-muted-foreground text-[11px]">
                        {baselineStop.text}
                      </text>
                    </g>
                  )}
                </g>
              )}
              {compared && (
                <g className={RECORD_CLASSES.previous.stroke} fill="none" strokeWidth={2} strokeLinejoin="round" data-compared>
                  <path d={pathOf(points.pressure.compared)} />
                  <path d={pathOf(points.flow.compared)} />
                  <path d={pathOf(points.temperature.compared)} />
                </g>
              )}
              <g className={RECORD_CLASSES.current.stroke} fill="none" strokeWidth={2.5} strokeLinejoin="round" data-run>
                <path d={pathOf(points.pressure.run)} />
                <path d={pathOf(points.flow.run)} />
              </g>

              {/* Where the compared record stopped, and where the run stops. */}
              {comparedStop && comparedStopLabel && (
                <g data-compared-stop>
                  <line x1={x(comparedStop.seconds)} x2={x(comparedStop.seconds)} y1={plot.top} y2={plot.bottom} className={RECORD_CLASSES.previous.stroke} strokeDasharray="3 3" />
                  <text {...besideAt(comparedStopLabel.box, x(comparedStop.seconds))} className="fill-foreground text-[11px]">
                    {comparedStopLabel.text}
                  </text>
                </g>
              )}
              <g data-stop>
                <line x1={x(run.stop.seconds)} x2={x(run.stop.seconds)} y1={plot.top} y2={plot.bottom + 4} className="stroke-foreground" />
                <text {...besideAt(stop.box, x(run.stop.seconds))} className="fill-foreground font-semibold">
                  {stop.text}
                </text>
                {(["pressure", "flow"] as const).map((lane) => {
                  const last = run.samples.at(-1)?.values[lane];
                  return last === null || last === undefined ? null : (
                    <circle key={lane} cx={x(run.stop.seconds)} cy={y(lane, last)} r={4} className={`${RECORD_CLASSES.current.fill} stroke-background`} strokeWidth={2} />
                  );
                })}
              </g>

              {/* The weight in the cup along the time axis: the first drip's name left of its mark, so the next mark's never meets it, unless that would put it over the lanes' values, where it is held right of them; a name that would still meet the one before it is left out (`cupBoxes`, `spaced`). */}
              <g data-cup>
                <text x={4} y={cupY + 4} className="fill-muted-foreground text-[11px]">
                  {short ? "Cup" : "In the cup"}
                </text>
                {run.timeToFirstDrip !== null && <line x1={x(run.timeToFirstDrip)} x2={x(run.stop.seconds)} y1={cupY} y2={cupY} className="stroke-foreground" />}
                {cupMarks.map((mark, index) => {
                  const drip = mark.text === "First drip";
                  return (
                    <g key={mark.text} data-cup-mark={mark.text}>
                      <line x1={x(mark.at)} x2={x(mark.at)} y1={cupY - 4} y2={cupY + 4} className="stroke-foreground" />
                      {cupNames[index] && (
                        <text x={drip ? cupBoxes[index]!.right : (cupBoxes[index]!.left + cupBoxes[index]!.right) / 2} y={cupY - 8} textAnchor={drip ? "end" : "middle"} className="fill-muted-foreground text-[11px]">
                          {short && drip ? "Drip" : mark.text}
                        </text>
                      )}
                    </g>
                  );
                })}
                <text x={x(run.stop.seconds) + 6} y={cupY + 4} className="fill-foreground text-[11px] font-semibold">
                  {`${measure(run.weight)} g`}
                </text>
              </g>

              {/* The time axis. */}
              {times.map((at, index) => timesWritten[index] && (
                <text key={at} x={x(at)} y={height - 6} textAnchor={at === end ? "end" : "middle"} className="fill-muted-foreground" data-time-value>
                  {at === end ? `${at} s` : at}
                </text>
              ))}
            </g>
          </svg>
        </GraphPointer>
      )}
    </figure>
  );
}

/** What a step draws in the lanes: its limit, in the lane it caps, and its exit, where it has them. */
function marksOf(step: Profile["steps"][number] | undefined) {
  return {
    limit: step?.limiter && step.limiter.value > 0 ? step.limiter : null,
    capped: step?.pump === "pressure" ? ("flow" as const) : ("pressure" as const),
    exit: step?.exit && step.exit.value > 0 && step.seconds > 0 ? step.exit : null,
  };
}

/** Where text placed in `box` beside an upright line at `line` is drawn: from the box's left on the line's right, to its right on the line's left. */
function besideAt(box: LabelBox, line: number): { x: number; y: number; textAnchor: "start" | "end" } {
  return box.left >= line ? { x: box.left, y: labelBaseline(box), textAnchor: "start" } : { x: box.right, y: labelBaseline(box), textAnchor: "end" };
}

/** How wide a handle's tag is, px, its text in its padding. */
function tagWidth(tag: string): number {
  return Math.ceil(textWidth(tag, 11, 600)) + 12;
}

/** One of a band's labels in a lane, where it was placed. */
function StepLabelText({ labels, baselines, band, which }: { labels: StepLabel[]; baselines: Map<StepLabel, number>; band: number; which: string }) {
  const label = labels.find((each) => each.band === band && each.key === which);
  const baseline = label && baselines.get(label);
  if (!label || baseline === undefined) return null;
  return (
    <text x={label.x} y={baseline} className="fill-muted-foreground text-[11px]">
      {label.text !== label.whole && <title>{label.whole}</title>}
      {label.text}
    </text>
  );
}

/** A row of the readout: what it names, its value, and the record it is of, which its mark shows. */
interface ReadoutRow {
  term: string;
  value: string;
  of: "run" | "plan" | "compared";
}

/** The values at the moment pointed at: the run's, against its plan, and the compared record's; "Stopped" for one that has. */
function readoutRows(profile: Profile, runLabel: string, sample: Sample<ShotCurve> | undefined, compared: { label: string; sample: Sample<ShotCurve> | undefined } | undefined): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  if (sample) {
    const step = sample.step ? profile.steps[sample.step.frame] : undefined;
    const of = (lane: "pressure" | "flow") => (step?.pump === lane ? ` of ${measure(sample.targets[lane] ?? 0)}` : "");
    rows.push(
      { term: "Pressure", value: `${measure(sample.values.pressure ?? 0)} bar${of("pressure")}`, of: "run" },
      { term: "Flow", value: `${measure(sample.values.flow ?? 0)} ml/s${of("flow")}`, of: "run" },
      { term: "In the cup", value: `${measure(sample.values.weight ?? 0)} g`, of: "run" },
    );
    // Temperature is not simulated: the plan's.
    if (sample.targets.temperature !== null && sample.targets.temperature !== undefined) rows.push({ term: "Temperature", value: `${measure(sample.targets.temperature)} °C planned`, of: "plan" });
  } else rows.push({ term: runLabel, value: "Stopped", of: "run" });
  if (compared) {
    const values = compared.sample?.values;
    const temperature = values?.temperature === null || values?.temperature === undefined ? "" : `, ${measure(values.temperature)} °C`;
    rows.push({
      term: compared.label,
      value: !values ? "Stopped" : [values.pressure, values.flow].every((value) => value !== null) ? `${measure(values.pressure!)} bar, ${measure(values.flow!)} ml/s${temperature}` : "-",
      of: "compared",
    });
  }
  return rows;
}

/**
 * The graph, `children`, and the moment pointed at on it, or moved to with
 * the arrow keys on its time slider: a line there with each record's points
 * on it, and the values in a tooltip over the graph, as the Shot page's
 * charts give them. Its own state, so pointing redraws only this, not the
 * graph it is given. The pointer is read on the graph itself, in its own
 * coordinates, as `layout`'s inverses take them, and reaches the graph's
 * labels, whose titles show their whole text; the slider takes the keys.
 */
function GraphPointer({
  layout,
  profile,
  run,
  runLabel,
  compared,
  onPick,
  overlay,
  children,
}: {
  layout: GraphLayout;
  profile: Profile;
  run: SimulatedRun;
  runLabel: string;
  compared: { label: string; samples: Sample<ShotCurve>[]; end: number } | undefined;
  /** A moment clicked on the graph, s, as to choose the step there. */
  onPick?(seconds: number): void;
  /** What is laid over the graph and takes its own pointer, such as a Draft's handles. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const [pointer, setPointer] = useState<number | null>(null);
  const slider = useRef<HTMLDivElement>(null);
  // Each record's values only while it runs: none for the run after it stopped, nor for the Shot after it did.
  const runEnd = Math.max(run.duration, run.samples.at(-1)?.seconds ?? 0);
  const last = Math.max(run.duration, compared?.end ?? 0);
  const pointed = pointer === null ? undefined : sampleWithin(run.samples, pointer, runEnd);
  const pointedCompared = pointer === null || !compared ? undefined : sampleWithin(compared.samples, pointer, compared.end);
  const showing = pointer !== null && (pointed !== undefined || pointedCompared !== undefined);
  const rows = showing ? readoutRows(profile, runLabel, pointed, compared ? { label: compared.label, sample: pointedCompared } : undefined) : [];
  const heading = showing ? `${seconds(pointer)}${pointed?.step ? ` · ${pointed.step.name}` : ""}` : "";

  const onPointer = (event: PointerEvent<HTMLDivElement>) => {
    const at = layout.secondsAt(event.clientX - event.currentTarget.getBoundingClientRect().left);
    setPointer(at < 0 || at > last ? null : at);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey || event.key === "PageUp" || event.key === "PageDown" ? 5 : 0.5;
    if (["ArrowRight", "ArrowUp", "PageUp"].includes(event.key)) setPointer((at) => Math.min(last, (at ?? -by) + by));
    else if (["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)) setPointer((at) => Math.max(0, (at ?? by) - by));
    else if (event.key === "Home") setPointer(0);
    else if (event.key === "End") setPointer(last);
    else if (event.key === "Escape") setPointer(null);
    else return;
    event.preventDefault();
  };

  const at = pointer ?? 0;
  const px = layout.x(at);
  // The tooltip on the side of the line with more room, as wide as that room allows, its text wrapping within it.
  const onLeft = px > layout.width / 2;
  const room = Math.max(96, (onLeft ? px : layout.width - px) - 18);
  return (
    <div
      className="relative touch-pan-y"
      style={{ width: layout.width, height: layout.height }}
      onPointerMove={onPointer}
      onPointerDown={onPointer}
      // A click gives the slider the keys, as a click on a slider does, so the arrows move on from where it was:
      // on the click, after the press has moved the focus where a press does.
      onClick={(event) => {
        onPick?.(layout.secondsAt(event.clientX - event.currentTarget.getBoundingClientRect().left));
        slider.current?.focus({ preventScroll: true });
      }}
      onPointerLeave={(event) => event.pointerType === "mouse" && setPointer(null)}
    >
      {children}
      {showing && (
        <svg aria-hidden className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height}>
          <line x1={px} x2={px} y1={layout.plot.top} y2={layout.plot.bottom} className="stroke-foreground/50" />
          {pointed &&
            (["pressure", "flow"] as const).map((lane) =>
              pointed.values[lane] === null ? null : (
                <circle key={lane} cx={px} cy={layout.y(lane, pointed.values[lane]!)} r={4} className={`${RECORD_CLASSES.current.fill} stroke-background`} strokeWidth={2} />
              ),
            )}
          {pointedCompared &&
            (["pressure", "flow"] as const).map((lane) =>
              pointedCompared.values[lane] === null || pointedCompared.values[lane] === undefined ? null : (
                <circle key={`c-${lane}`} cx={px} cy={layout.y(lane, pointedCompared.values[lane]!)} r={4} className={`${RECORD_CLASSES.previous.fill} stroke-background`} strokeWidth={2} />
              ),
            )}
        </svg>
      )}
      {showing && (
        <div
          data-readout
          aria-hidden
          className="pointer-events-none absolute grid items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
          style={{ top: layout.plot.top + 34, maxWidth: room, minWidth: Math.min(128, room), ...(onLeft ? { right: layout.width - px + 10 } : { left: px + 10 }) }}
        >
          <div className="font-medium">{heading}</div>
          <div className="grid gap-1.5">
            {rows.map((row) => (
              <div key={row.term} className="flex w-full items-center gap-2">
                <div
                  className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${
                    row.of === "run" ? RECORD_CLASSES.current.background : row.of === "compared" ? RECORD_CLASSES.previous.background : "border-[1.5px] border-dashed border-muted-foreground"
                  }`}
                />
                <div className="flex flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 leading-tight">
                  <span className="text-muted-foreground">{row.term}</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">{row.value}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        ref={slider}
        role="slider"
        tabIndex={0}
        aria-label="A moment on the graph"
        aria-valuemin={0}
        aria-valuemax={Math.round(last * 10) / 10}
        aria-valuenow={Math.round(at * 10) / 10}
        aria-valuetext={showing ? `${heading}: ${rows.map((row) => `${row.term} ${row.value}`).join(", ")}` : "Move along the graph with the arrow keys to read its values"}
        className="pointer-events-none absolute inset-x-0 bottom-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ top: layout.plot.top }}
        onKeyDown={onKey}
      />
      {overlay}
    </div>
  );
}

/**
 * One handle on the graph, a slider to the keyboard and to assistive
 * technology: dragged, it sets the value at the pointer (`valueAt`, from the
 * pointer's place on the graph, px); the arrow keys move it by `step`, ten
 * at a time with Shift or Page Up and Down, and Home and End to its range's
 * ends. While it is dragged the graph's axes hold still (`onHold`).
 */
function Handle({
  shape,
  label,
  value,
  range,
  step,
  text,
  tag,
  valueAt,
  onValue,
  onHold,
  name,
  tagBox,
}: {
  shape: HandleShape;
  label: string;
  value: number;
  range: Range;
  step: number;
  /** The value in words, for assistive technology. */
  text: string;
  /** What its tag on the graph reads. */
  tag: string;
  valueAt(x: number, y: number): number;
  onValue(value: number): void;
  onHold(holding: boolean): void;
  /** What tests and styles find it by. */
  name: string;
  /** Where its tag is, on the graph, as `placeTags` places it. */
  tagBox: LabelBox;
}) {
  const dragging = useRef(false);
  // A handle taken away mid-drag, as when its step's band changes, lets the axes go, as its pointerup never comes.
  const hold = useRef(onHold);
  hold.current = onHold;
  useEffect(
    () => () => {
      if (dragging.current) hold.current(false);
    },
    [],
  );
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.parentElement!.getBoundingClientRect();
    onValue(valueAt(event.clientX - box.left, event.clientY - box.top));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey || event.key === "PageUp" || event.key === "PageDown" ? step * 10 : step;
    let next: number;
    if (["ArrowUp", "ArrowRight", "PageUp"].includes(event.key)) next = value + by;
    else if (["ArrowDown", "ArrowLeft", "PageDown"].includes(event.key)) next = value - by;
    else if (event.key === "Home") next = range.min;
    else if (event.key === "End") next = range.max;
    else return;
    event.preventDefault();
    event.stopPropagation();
    onValue(held(next, range));
  };
  const point = shape.kind === "point";
  const style = point
    ? { left: shape.x - 9, top: shape.y - 9, width: 18, height: 18 }
    : { left: shape.x - 7, top: shape.top, width: 14, height: shape.bottom - shape.top };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation={point ? "vertical" : "horizontal"}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={value}
      aria-valuetext={text}
      data-handle={name}
      className={`group absolute ${point ? "z-20 cursor-ns-resize" : "z-10 cursor-ew-resize"} touch-none outline-none select-none`}
      style={style}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        onHold(true);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        if (dragging.current) move(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (!dragging.current) return;
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onHold(false);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onHold(false);
      }}
      onLostPointerCapture={() => {
        if (!dragging.current) return;
        dragging.current = false;
        onHold(false);
      }}
    >
      {point ? (
        <span className="absolute inset-0.5 rounded-full border-2 border-(--this-record) bg-background shadow-sm group-focus-visible:ring-2 group-focus-visible:ring-ring dark:border-(--this-record-dark)" />
      ) : (
        <span className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 group-focus-visible:ring-2 group-focus-visible:ring-ring ${RECORD_CLASSES.current.background}`} />
      )}
      <span
        aria-hidden
        data-handle-tag={name}
        className={`pointer-events-none absolute flex items-center justify-center rounded text-[11px] leading-none font-semibold whitespace-nowrap text-white ${RECORD_CLASSES.current.background}`}
        style={{ left: tagBox.left - style.left, top: tagBox.top - style.top, width: tagBox.right - tagBox.left, height: TAG_HEIGHT }}
      >
        {tag}
      </span>
    </div>
  );
}

/** A handle on the selected step: what it sets, where it is, and what it reads. */
interface EditHandle {
  name: HandleField;
  shape: HandleShape;
  label: string;
  value: number;
  range: Range;
  step: number;
  /** The value in words, for assistive technology. */
  text: string;
  /** What its tag on the graph reads. */
  tag: string;
  valueAt(x: number, y: number): number;
}

/** The selected step's handles: its target, its exit where it has one, and its maximum time; none for a step the run never came to. A step of no length keeps them, at its start, so its maximum time can be brought back. Its points stand inside the plot, off the lanes' values (`pointInPlot`). */
function editHandles(layout: GraphLayout, profile: Profile, run: SimulatedRun, editing: GraphEditing): EditHandle[] {
  const ran = run.steps[editing.step];
  const step = profile.steps[editing.step];
  if (!ran || !step || ran.start === null || ran.end === null || ran.end < ran.start) return [];
  const start = ran.start;
  const along = (fraction: number) => layout.x(start) + (layout.x(ran.end!) - layout.x(start)) * fraction;
  const name = stepName(step, editing.step);
  const unit = (lane: "pressure" | "flow") => (lane === "pressure" ? "bar" : "ml/s");
  const target = stepTarget(step);
  const targetLimits = targetRange(step, editing.limits);
  // A step that gets to its target over the whole step gets there at its maximum time.
  const targetX = pointInPlot(layout.plot, step.transition === "smooth" ? layout.x(start + step.seconds) : along(0.62));
  const exit = step.exit && step.seconds > 0 ? step.exit : null;
  const timeRange = editing.limits.seconds;
  const offAxis = start + step.seconds > layout.end;
  return [
    {
      name: "target",
      shape: { kind: "point", x: targetX, y: layout.y(step.pump, target) },
      label: `${name}'s target, ${unit(step.pump)}`,
      value: target,
      range: targetLimits,
      step: 0.1,
      text: `${measure(target)} ${unit(step.pump)}`,
      tag: `${measure(target)} ${unit(step.pump)}`,
      valueAt: (_, y) => held(layout.valueAt(step.pump, y), targetLimits),
    },
    ...(exit
      ? [
          {
            name: "exit" as const,
            shape: { kind: "point" as const, x: pointInPlot(layout.plot, along(0.3)), y: layout.y(exit.type, exit.value) },
            label: `${name}'s exit, ${exit.type} ${exit.condition}, ${unit(exit.type)}`,
            value: exit.value,
            range: exitRange(exit.type, editing.limits),
            step: 0.1,
            text: capitalised(exitText(exit)),
            tag: capitalised(exitText(exit)),
            valueAt: (_: number, y: number) => held(layout.valueAt(exit.type, y), exitRange(exit.type, editing.limits)),
          },
        ]
      : []),
    {
      name: "seconds",
      shape: { kind: "bracket", x: layout.x(start + step.seconds), top: layout.plot.top, bottom: layout.plot.bottom },
      label: `${name}'s maximum time, s`,
      value: step.seconds,
      range: timeRange,
      step: 0.5,
      text: `At most ${seconds(step.seconds)}`,
      tag: `At most ${seconds(step.seconds)}${offAxis ? " ›" : ""}`,
      valueAt: (x) => held(layout.secondsAt(x) - start, timeRange),
    },
  ];
}

/** The selected step's handles, each with its tag where `placeTags` put it. */
/** The selected step's handles, its points over its bracket, so a point held inside the plot near a bracket there still takes the pointer (#637). */
function EditHandles({ handles, tags, editing, onHold }: { handles: EditHandle[]; tags: LabelBox[]; editing: GraphEditing; onHold(holding: boolean): void }) {
  return (
    <>
      {handles.map(({ name, ...handle }, index) => (
        <Handle key={name} name={name} {...handle} tagBox={tags[index]!} onValue={(value) => editing.onChange(name, value)} onHold={onHold} />
      ))}
    </>
  );
}

/** How long a band's step ran and why it ended, such as "5.3 s · over 4 bar". */
function bandDetail(profile: Profile, run: SimulatedRun, band: { index: number; start: number; end: number; reason: string | null }): string {
  const ran = run.steps[band.index]!;
  const step = profile.steps[band.index];
  const length = seconds(band.end - band.start);
  if (band.reason === "time") return `${length}, in full`;
  if (band.reason === "exit" && step?.exit) return `${length} · ${exitText(step.exit)}`;
  const why = stepEndText(profile, run, ran);
  return why ? `${length} · ${why.replace(/^the Shot /, "")}` : length;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function signed(value: number): string {
  return `${value < 0 ? "−" : "+"}${measure(Math.abs(value))}`;
}
