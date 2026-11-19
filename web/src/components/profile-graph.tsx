import { type Profile, type Sample, type ShotCurve, type SimulatedRun, sentStep } from "@decent-sync/protocol";
import { type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject, type SVGProps, useEffect, useId, useRef, useState } from "react";
import { RECORD_CLASSES, RECORD_VARIABLES } from "@/components/record-colors";
import { type GraphLayout, LANES, type Lane, type LaneLabel, type LaneRanges, graphLayout, laneRanges, laneTicks, placeLabels, timeAxis } from "@/lib/profile-graph-layout";
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
  label,
  ranges: pinned,
}: {
  profile: Profile;
  run: SimulatedRun;
  /** What the legend calls the run. */
  runLabel?: string;
  compared?: GraphCompared | null;
  /** The graph in words, for screen readers. */
  label: string;
  /** Lane ranges held as given, as while a target is dragged, rather than fitted to what is drawn. */
  ranges?: Partial<LaneRanges>;
}) {
  const [ref, width] = useWidth();
  const clipId = useId();
  const captionId = useId();

  const comparedSamples = (compared?.samples ?? []).filter((sample) => sample.seconds >= 0 && sample.shade === null);
  const comparedEnd = comparedSamples.at(-1)?.seconds ?? 0;
  const beyond = planBeyond(profile, run);
  const reached = Math.max(run.duration, comparedEnd);
  const { end, tick } = timeAxis(reached, beyond.at(-1)?.until ?? reached);
  const layout = graphLayout({ width, end, tick, ranges: { ...laneRanges(profile, run, comparedSamples), ...pinned } });
  const { x, y, plot, lanes, height, short, cupY, ranges } = layout;

  // The plan in the lane of each sample's pump, a pump stopped as 0; null where the pump controls the other.
  const stepOf = (sample: Sample<ShotCurve>) => (sample.step ? profile.steps[sample.step.frame] : undefined);
  const planPoints = (lane: "pressure" | "flow") =>
    run.samples.map((sample): [number, number] | null => (stepOf(sample)?.pump === lane ? [x(sample.seconds), y(lane, sample.targets[lane] ?? 0)] : null));
  const temperaturePlan = run.samples.map((sample): [number, number] | null => (sample.targets.temperature === null ? null : [x(sample.seconds), y("temperature", sample.targets.temperature)]));
  const runPoints = (lane: "pressure" | "flow") => run.samples.map((sample): [number, number] | null => (sample.values[lane] === null ? null : [x(sample.seconds), y(lane, sample.values[lane]!)]));
  const comparedPoints = (lane: Lane) =>
    comparedSamples.map((sample): [number, number] | null => (sample.values[lane] === null || sample.values[lane] === undefined ? null : [x(sample.seconds), y(lane, sample.values[lane]!)]));
  const points: Record<Lane, { run: ([number, number] | null)[]; plan: ([number, number] | null)[]; compared: ([number, number] | null)[] }> = {
    pressure: { run: runPoints("pressure"), plan: planPoints("pressure"), compared: comparedPoints("pressure") },
    flow: { run: runPoints("flow"), plan: planPoints("flow"), compared: comparedPoints("flow") },
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
    const room = Math.max(0, x(band.end) - x(band.start) - 8);
    const labelled = (key: string, lane: Lane, whole: string, top: number, bottom: number): StepLabel => {
      const text = fitText(whole, room, 11);
      return { key, lane, band: band.index, x: x(band.start) + 4, text, whole, width: textWidth(text, 11), top, bottom };
    };
    const labels: StepLabel[] = [];
    const limit = step.limiter && step.limiter.value > 0 ? step.limiter : null;
    if (limit) {
      const capped = step.pump === "pressure" ? "flow" : "pressure";
      labels.push(
        labelled("limit", capped, `${capitalised(limitText(step) ?? "")}, easing over ${measure(limit.range)} ${capped === "flow" ? "ml/s" : "bar"}`, y(capped, limit.value + limit.range), y(capped, limit.value)),
      );
    }
    const exit = step.exit && step.exit.value > 0 && step.seconds > 0 ? step.exit : null;
    if (exit) labels.push(labelled("exit", exit.type, `Moves on ${exitText(exit)}`, y(exit.type, exit.value), y(exit.type, exit.value)));
    if (band.index === 0 || step.temperature !== profile.steps[0]?.temperature || step.sensor !== profile.steps[0]?.sensor) {
      const text = band.index === 0 ? `${measure(step.temperature)} °C at the ${step.sensor}` : `${signed(step.temperature - profile.steps[0]!.temperature)} °C, at the ${step.sensor}`;
      labels.push(labelled("temperature", "temperature", text, y("temperature", step.temperature), y("temperature", step.temperature)));
    }
    return labels;
  });
  // Kept apart from each other, the lane's name, the preinfusion bar's and the curves, lane by lane.
  const baselines = new Map<StepLabel, number>();
  for (const lane of LANES) {
    const here = stepLabels.filter((each) => each.lane === lane.key);
    const title = `${lane.title} (${lane.unit})`;
    const taken = [{ left: plot.right - 4 - textWidth(title, 12, 500), right: plot.right, top: lanes[lane.key].top, bottom: lanes[lane.key].top + 18 }];
    if (lane.key === "pressure" && showsPreinfusion) taken.push({ left: plot.left, right: plot.left + 8 + textWidth("Preinfusion", 11), top: lanes.pressure.top, bottom: lanes.pressure.top + 20 });
    const curves = [...points[lane.key].run, ...points[lane.key].plan, ...points[lane.key].compared].filter((point) => point !== null);
    const placed = placeLabels(here.map((each): LaneLabel => ({ x: each.x, width: each.width, top: each.top, bottom: each.bottom })), lanes[lane.key].top, lanes[lane.key].bottom, curves, taken);
    here.forEach((each, index) => baselines.set(each, placed[index]!));
  }

  // The weight in the cup: its first drip, then each 10 g, as run.
  const cupMarks: { at: number; text: string }[] = [];
  if (run.timeToFirstDrip !== null) cupMarks.push({ at: run.timeToFirstDrip, text: "First drip" });
  for (let grams = 10; grams < run.weight; grams += 10) {
    const crossing = run.samples.find((sample) => (sample.values.weight ?? 0) >= grams);
    if (crossing) cupMarks.push({ at: crossing.seconds, text: `${grams} g` });
  }

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
        <GraphPointer layout={layout} profile={profile} run={run} runLabel={runLabel} compared={compared ? { label: compared.label, samples: comparedSamples, end: comparedEnd } : undefined}>
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
                  {laneTicks(lane.key, ranges[lane.key]).map((value) => (
                    <g key={value}>
                      <line x1={plot.left} x2={plot.right} y1={y(lane.key, value)} y2={y(lane.key, value)} className="stroke-border" strokeWidth={value === ranges[lane.key][0] ? 1 : 0.5} />
                      <text x={plot.left - 6} y={y(lane.key, value) + 4} textAnchor="end" className="fill-muted-foreground">
                        {measure(value)}
                      </text>
                    </g>
                  ))}
                  <text x={plot.right - 4} y={lanes[lane.key].top + 14} textAnchor="end" className="fill-foreground font-medium">
                    {`${lane.title} (${lane.unit})`}
                  </text>
                </g>
              ))}

              {showsPreinfusion && (
                <g data-preinfusion>
                  <rect x={plot.left} y={plot.top} width={x(preinfusionEnd) - plot.left} height={3} className="fill-muted-foreground/50" />
                  <text x={plot.left + 4} y={plot.top + 16} className="fill-muted-foreground text-[11px]">
                    Preinfusion
                  </text>
                </g>
              )}

              {/* Limits as bands in the lane each caps, and exits as thresholds in the lane each watches. */}
              {bands.map((band) => {
                const step = profile.steps[band.index];
                if (!step) return null;
                const limit = step.limiter && step.limiter.value > 0 ? step.limiter : null;
                const capped = step.pump === "pressure" ? "flow" : "pressure";
                const exit = step.exit && step.exit.value > 0 && step.seconds > 0 ? step.exit : null;
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
              {notReached && x(end) - x(run.stop.seconds) > 80 && (
                <text x={(x(run.stop.seconds) + x(end)) / 2} y={(lanes.pressure.top + lanes.pressure.bottom) / 2} textAnchor="middle" className="fill-muted-foreground">
                  Not reached
                </text>
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
              {compared?.stop && (
                <g data-compared-stop>
                  <line x1={x(compared.stop.seconds)} x2={x(compared.stop.seconds)} y1={plot.top} y2={plot.bottom} className={RECORD_CLASSES.previous.stroke} strokeDasharray="3 3" />
                  {/* On the side away from the run's stop, so the two never cross. */}
                  <text
                    x={x(compared.stop.seconds) + (compared.stop.seconds > run.stop.seconds ? 4 : -4)}
                    y={lanes.pressure.bottom - 6}
                    textAnchor={compared.stop.seconds > run.stop.seconds ? "start" : "end"}
                    className="fill-foreground text-[11px]"
                  >
                    {`${compared.stop.label}, ${seconds(compared.stop.seconds)}`}
                  </text>
                </g>
              )}
              <g data-stop>
                <line x1={x(run.stop.seconds)} x2={x(run.stop.seconds)} y1={plot.top} y2={plot.bottom + 4} className="stroke-foreground" />
                {/* Left of the line and a row lower where right of it would run into the lane's name. */}
                <text
                  x={x(run.stop.seconds) + (x(run.stop.seconds) > plot.right - 220 ? -6 : 6)}
                  y={plot.top + (x(run.stop.seconds) > plot.right - 220 ? 32 : 16)}
                  textAnchor={x(run.stop.seconds) > plot.right - 220 ? "end" : "start"}
                  className="fill-foreground font-semibold"
                >
                  {`${run.stop.reason === "weight" ? "Stops" : "Ends"} at ${seconds(run.stop.seconds)}`}
                </text>
                {(["pressure", "flow"] as const).map((lane) => {
                  const last = run.samples.at(-1)?.values[lane];
                  return last === null || last === undefined ? null : (
                    <circle key={lane} cx={x(run.stop.seconds)} cy={y(lane, last)} r={4} className={`${RECORD_CLASSES.current.fill} stroke-background`} strokeWidth={2} />
                  );
                })}
              </g>

              {/* The weight in the cup along the time axis: the first drip's name left of its mark, so the next mark's never meets it. */}
              <g data-cup>
                <text x={4} y={cupY + 4} className="fill-muted-foreground text-[11px]">
                  {short ? "Cup" : "In the cup"}
                </text>
                {run.timeToFirstDrip !== null && <line x1={x(run.timeToFirstDrip)} x2={x(run.stop.seconds)} y1={cupY} y2={cupY} className="stroke-foreground" />}
                {cupMarks.map((mark) => {
                  const drip = mark.text === "First drip";
                  return (
                    <g key={mark.text} data-cup-mark={mark.text}>
                      <line x1={x(mark.at)} x2={x(mark.at)} y1={cupY - 4} y2={cupY + 4} className="stroke-foreground" />
                      <text x={x(mark.at) + (drip ? 2 : 0)} y={cupY - 8} textAnchor={drip ? "end" : "middle"} className="fill-muted-foreground text-[11px]">
                        {short && drip ? "Drip" : mark.text}
                      </text>
                    </g>
                  );
                })}
                <text x={x(run.stop.seconds) + 6} y={cupY + 4} className="fill-foreground text-[11px] font-semibold">
                  {`${measure(run.weight)} g`}
                </text>
              </g>

              {/* The time axis. */}
              {layout.timeTicks().map((at) => (
                <text key={at} x={x(at)} y={height - 6} textAnchor={at === end ? "end" : "middle"} className="fill-muted-foreground">
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
  children,
}: {
  layout: GraphLayout;
  profile: Profile;
  run: SimulatedRun;
  runLabel: string;
  compared: { label: string; samples: Sample<ShotCurve>[]; end: number } | undefined;
  children: ReactNode;
}) {
  const [pointer, setPointer] = useState<number | null>(null);
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
    </div>
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
