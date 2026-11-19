import { type Profile, type Sample, type ShotCurve, type SimulatedRun, sentStep } from "@decent-sync/protocol";
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { exitText, limitText, measure, seconds, stepEndText, stepName } from "@/lib/profile-words";

// A Profile's graph (#578): a simulated run of it in lanes of pressure, flow
// and temperature on one time axis, each step a band named at the top with
// how long it ran and why it ended, the plan dashed behind the run, each
// step's exit a threshold and its limit a band in the lane each acts in, the
// stop marked with the plan it never reached faint beyond it, and marks for
// the first drip and each 10 g in the cup. Drawn in the Shot page's colours:
// blue for the run, orange for the Shot or version compared with it, dashed
// grey for the plan. Pointing at a moment, or moving to it with the arrow
// keys, reads the values there.

/** A Shot, or another run, drawn over the run in orange. */
export interface GraphCompared {
  /** What the legend and readout call it, such as "The Shot, as it ran" or "Version 1, simulated". */
  label: string;
  samples: Sample<ShotCurve>[];
  /** Where it stopped, s, marked with its name, such as "The Shot stopped"; none to leave it unmarked. */
  stop?: { seconds: number; label: string } | null;
}

const BLUE = "stroke-[#2a78d6] dark:stroke-[#3987e5]";
const BLUE_FILL = "fill-[#2a78d6] dark:fill-[#3987e5]";
const ORANGE = "stroke-[#eb6834] dark:stroke-[#d95926]";
const ORANGE_FILL = "fill-[#eb6834] dark:fill-[#d95926]";

type Lane = "pressure" | "flow" | "temperature";
const LANES: { key: Lane; title: string; unit: string }[] = [
  { key: "pressure", title: "Pressure", unit: "bar" },
  { key: "flow", title: "Flow", unit: "ml/s" },
  { key: "temperature", title: "Temperature", unit: "°C" },
];

const TOP = 44;
const LEFT = 36;
const RIGHT = 8;
const LANE_GAP = 22;
const CUP_ROW = 30;
const AXIS_ROW = 22;

/** The graph's width as laid out, measured, so its text stays its size at any width. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
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

/** A round top for an axis holding `value`, at least `least`, on a step of `step`. */
function roundUp(value: number, least: number, step: number): number {
  return Math.max(least, Math.ceil((value + 0.001) / step) * step);
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

export function ProfileGraph({
  profile,
  run,
  runLabel = "Simulated",
  compared,
  label,
  compact = false,
}: {
  profile: Profile;
  run: SimulatedRun;
  /** What the legend calls the run. */
  runLabel?: string;
  compared?: GraphCompared | null;
  /** The graph in words, for screen readers. */
  label: string;
  /** Shorter lanes, as on a phone. */
  compact?: boolean;
}) {
  const [ref, width] = useWidth();
  const [pointer, setPointer] = useState<number | null>(null);
  const clipId = useId();

  const comparedSamples = (compared?.samples ?? []).filter((sample) => sample.seconds >= 0 && sample.shade === null);
  const comparedEnd = comparedSamples.at(-1)?.seconds ?? 0;
  const beyond = planBeyond(profile, run);
  const reached = Math.max(run.duration, comparedEnd);
  const plannedEnd = beyond.at(-1)?.until ?? reached;
  // The axis runs a little past the stop, so the plan beyond it shows without dwarfing the run.
  const span = Math.min(Math.max(reached * 1.15, reached + 3), Math.max(plannedEnd, reached + 1));
  const tick = span > 90 ? 20 : span > 40 ? 10 : 5;
  const end = Math.max(tick, Math.ceil(span / tick) * tick);

  // Shorter lanes on a narrow screen, as a phone's.
  const short = compact || (width > 0 && width < 560);
  const laneHeight = short ? 84 : 120;
  const lanesTop = TOP;
  const laneTop = (index: number) => lanesTop + index * (laneHeight + LANE_GAP);
  const lanesBottom = laneTop(LANES.length - 1) + laneHeight;
  const height = lanesBottom + CUP_ROW + AXIS_ROW;
  const plotRight = Math.max(LEFT + 40, width - RIGHT);
  const x = (at: number) => LEFT + (Math.min(Math.max(at, 0), end) / end) * (plotRight - LEFT);

  // Each lane's range: what the run, the plan, the exits and limits and the compared record reach in it.
  const temperatures = profile.steps.map((step) => step.temperature).filter((value) => value > 0);
  const comparedTemperatures = comparedSamples.flatMap((sample) => (sample.values.temperature === null ? [] : [sample.values.temperature]));
  const laneMax = (lane: "pressure" | "flow") => {
    const values = [
      ...run.samples.map((sample) => Math.max(sample.values[lane] ?? 0, sample.targets[lane] ?? 0)),
      ...comparedSamples.map((sample) => sample.values[lane] ?? 0),
      ...profile.steps.map((step) => (step.pump === lane ? (lane === "pressure" ? (step as { pressure: number }).pressure : (step as { flow: number }).flow) : 0)),
      ...profile.steps.map((step) => (step.exit?.type === lane ? step.exit.value : 0)),
      ...profile.steps.map((step) => (step.limiter && step.limiter.value > 0 && (step.pump === "pressure" ? "flow" : "pressure") === lane ? step.limiter.value : 0)),
    ];
    return roundUp(Math.max(0, ...values), 4, 2);
  };
  const tempValues = [...temperatures, ...comparedTemperatures];
  const tempLow = tempValues.length > 0 ? Math.floor((Math.min(...tempValues) - 2) / 5) * 5 : 80;
  const tempHigh = tempValues.length > 0 ? Math.max(tempLow + 10, Math.ceil((Math.max(...tempValues) + 2) / 5) * 5) : 100;
  const ranges: Record<Lane, [number, number]> = { pressure: [0, laneMax("pressure")], flow: [0, laneMax("flow")], temperature: [tempLow, tempHigh] };
  const y = (lane: Lane, value: number) => {
    const index = LANES.findIndex((entry) => entry.key === lane);
    const [low, high] = ranges[lane];
    const share = (Math.min(Math.max(value, low), high) - low) / (high - low);
    return laneTop(index) + laneHeight - share * laneHeight;
  };
  const yTicks = (lane: Lane): number[] => {
    const [low, high] = ranges[lane];
    const step = lane === "temperature" ? (high - low > 20 ? 10 : 5) : high > 12 ? 4 : 2;
    const ticks: number[] = [];
    for (let value = low; value <= high + 0.001; value += step) ticks.push(value);
    return ticks;
  };

  // The plan in the lane of each sample's pump, a pump stopped as 0; null where the pump controls the other.
  const stepOf = (sample: Sample<ShotCurve>) => (sample.step ? profile.steps[sample.step.frame] : undefined);
  const planPath = (lane: "pressure" | "flow") =>
    pathOf(run.samples.map((sample) => (stepOf(sample)?.pump === lane ? [x(sample.seconds), y(lane, sample.targets[lane] ?? 0)] : null)));
  const temperaturePlan = pathOf(run.samples.map((sample) => (sample.targets.temperature === null ? null : [x(sample.seconds), y("temperature", sample.targets.temperature)])));
  const runPath = (lane: "pressure" | "flow") => pathOf(run.samples.map((sample) => (sample.values[lane] === null ? null : [x(sample.seconds), y(lane, sample.values[lane]!)])));
  const comparedPath = (lane: Lane) =>
    pathOf(comparedSamples.map((sample) => (sample.values[lane] === null || sample.values[lane] === undefined ? null : [x(sample.seconds), y(lane, sample.values[lane]!)])));

  const bands = run.steps.flatMap((ran) => (ran.start !== null && ran.end !== null && ran.end > ran.start ? [{ ...ran, start: ran.start, end: ran.end }] : []));
  const notReached = run.steps.some((ran) => ran.start === null);
  const preinfusionEnd = profile.target_volume_count_start > 0 ? run.steps[profile.target_volume_count_start - 1]?.end : null;

  // The weight in the cup: its first drip, then each 10 g, as run.
  const cupMarks: { at: number; text: string }[] = [];
  if (run.timeToFirstDrip !== null) cupMarks.push({ at: run.timeToFirstDrip, text: "First drip" });
  for (let grams = 10; grams < run.weight; grams += 10) {
    const crossing = run.samples.find((sample) => (sample.values.weight ?? 0) >= grams);
    if (crossing) cupMarks.push({ at: crossing.seconds, text: `${grams} g` });
  }
  const cupY = lanesBottom + 18;

  const pointed = pointer === null ? undefined : sampleAt(run.samples, pointer);
  const pointedCompared = pointer === null ? undefined : sampleAt(comparedSamples, pointer);
  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left - LEFT) / (plotRight - LEFT)) * end;
    setPointer(at < 0 || at > Math.max(run.duration, comparedEnd) ? null : at);
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const by = event.shiftKey ? 5 : 0.5;
    const last = Math.max(run.duration, comparedEnd);
    if (event.key === "ArrowRight") setPointer((at) => Math.min(last, (at ?? -by) + by));
    else if (event.key === "ArrowLeft") setPointer((at) => Math.max(0, (at ?? by) - by));
    else if (event.key === "Home") setPointer(0);
    else if (event.key === "End") setPointer(last);
    else if (event.key === "Escape") setPointer(null);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={ref} className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <svg width="22" height="8">
            <line x1="1" y1="4" x2="21" y2="4" className={BLUE} strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          {runLabel}
        </span>
        {compared && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="8">
              <line x1="1" y1="4" x2="21" y2="4" className={ORANGE} strokeWidth="2.5" strokeLinecap="round" />
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
        <svg
          role="img"
          aria-label={label}
          tabIndex={0}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block touch-pan-y text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={(event) => event.pointerType === "mouse" && setPointer(null)}
          onKeyDown={onKey}
          data-graph-end={end}
        >
          <defs>
            {bands.map((band) => (
              <clipPath key={band.index} id={`${clipId}-band-${band.index}`}>
                <rect x={x(band.start)} y={0} width={Math.max(0, x(band.end) - x(band.start) - 2)} height={height} />
              </clipPath>
            ))}
          </defs>

          {/* Each step a band, every other one shaded, named at the top with how long it ran and why it ended. */}
          {bands.map((band, order) => (
            <g key={band.index} data-step-band={band.index}>
              {order % 2 === 0 && <rect x={x(band.start)} y={lanesTop} width={x(band.end) - x(band.start)} height={lanesBottom - lanesTop} className="fill-muted/60" />}
              <line x1={x(band.start)} x2={x(band.start)} y1={lanesTop} y2={lanesBottom} className="stroke-border" />
              <g clipPath={`url(#${clipId}-band-${band.index})`}>
                <text x={x(band.start) + 4} y={14} className="fill-foreground text-[13px] font-semibold">
                  {`${band.index + 1}  ${stepName(band, band.index)}`}
                </text>
                <text x={x(band.start) + 4} y={31} className="fill-muted-foreground">
                  {bandDetail(profile, run, band)}
                </text>
              </g>
            </g>
          ))}

          {/* Each lane's grid, values and name. */}
          {LANES.map((lane, index) => (
            <g key={lane.key} data-lane={lane.key}>
              {yTicks(lane.key).map((value) => (
                <g key={value}>
                  <line x1={LEFT} x2={plotRight} y1={y(lane.key, value)} y2={y(lane.key, value)} className="stroke-border" strokeWidth={value === ranges[lane.key][0] ? 1 : 0.5} />
                  <text x={LEFT - 6} y={y(lane.key, value) + 4} textAnchor="end" className="fill-muted-foreground">
                    {value}
                  </text>
                </g>
              ))}
              <text x={plotRight - 4} y={laneTop(index) + 14} textAnchor="end" className="fill-foreground font-medium">
                {`${lane.title} (${lane.unit})`}
              </text>
            </g>
          ))}

          {preinfusionEnd !== null && preinfusionEnd !== undefined && preinfusionEnd > 0 && (
            <g data-preinfusion>
              <rect x={LEFT} y={lanesTop} width={x(preinfusionEnd) - LEFT} height={3} className="fill-muted-foreground/50" />
              <text x={LEFT + 4} y={lanesTop + 16} className="fill-muted-foreground text-[11px]">
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
                    <text x={x(band.start) + 4} y={y(capped, limit.value + limit.range) - 4} clipPath={`url(#${clipId}-band-${band.index})`} className="fill-muted-foreground text-[11px]">
                      {`${capitalised(limitText(step) ?? "")}, easing over ${measure(limit.range)}`}
                    </text>
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
                    <text x={x(band.start) + 4} y={y(exit.type, exit.value) - 5} clipPath={`url(#${clipId}-band-${band.index})`} className="fill-muted-foreground text-[11px]">
                      {`Moves on ${exitText(exit)}`}
                    </text>
                  </g>
                )}
                {band.index === 0 || step.temperature !== profile.steps[0]?.temperature || step.sensor !== profile.steps[0]?.sensor ? (
                  <text x={x(band.start) + 4} y={y("temperature", step.temperature) - 6} clipPath={`url(#${clipId}-band-${band.index})`} className="fill-muted-foreground text-[11px]">
                    {band.index === 0
                      ? `${measure(step.temperature)} °C at the ${step.sensor}`
                      : `${signed(step.temperature - profile.steps[0]!.temperature)} °C, at the ${step.sensor}`}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* The plan, dashed behind the run, and faint beyond its stop. */}
          <g className="stroke-muted-foreground" fill="none" strokeWidth={1.5} strokeDasharray="4 3" data-plan>
            <path d={planPath("pressure")} />
            <path d={planPath("flow")} />
            <path d={temperaturePlan} />
          </g>
          <g className="stroke-muted-foreground/40" fill="none" strokeWidth={1.5} strokeDasharray="4 3" data-plan-beyond>
            {beyond.map((part, index) => (
              <line key={index} x1={x(part.from)} x2={x(Math.min(part.until, end))} y1={y(part.lane, part.target)} y2={y(part.lane, part.target)} />
            ))}
          </g>
          {notReached && x(end) - x(run.stop.seconds) > 80 && (
            <text x={(x(run.stop.seconds) + x(end)) / 2} y={laneTop(0) + laneHeight / 2} textAnchor="middle" className="fill-muted-foreground">
              Not reached
            </text>
          )}

          {compared && (
            <g className={ORANGE} fill="none" strokeWidth={2} strokeLinejoin="round" data-compared>
              <path d={comparedPath("pressure")} />
              <path d={comparedPath("flow")} />
              <path d={comparedPath("temperature")} />
            </g>
          )}
          <g className={BLUE} fill="none" strokeWidth={2.5} strokeLinejoin="round" data-run>
            <path d={runPath("pressure")} />
            <path d={runPath("flow")} />
          </g>

          {/* Where the compared record stopped, and where the run stops. */}
          {compared?.stop && (
            <g data-compared-stop>
              <line x1={x(compared.stop.seconds)} x2={x(compared.stop.seconds)} y1={lanesTop} y2={lanesBottom} className={ORANGE} strokeDasharray="3 3" />
              {/* On the side away from the run's stop, so the two never cross. */}
              <text
                x={x(compared.stop.seconds) + (compared.stop.seconds > run.stop.seconds ? 4 : -4)}
                y={laneTop(0) + laneHeight - 6}
                textAnchor={compared.stop.seconds > run.stop.seconds ? "start" : "end"}
                className="fill-foreground text-[11px]"
              >
                {`${compared.stop.label}, ${seconds(compared.stop.seconds)}`}
              </text>
            </g>
          )}
          <g data-stop>
            <line x1={x(run.stop.seconds)} x2={x(run.stop.seconds)} y1={lanesTop} y2={lanesBottom + 4} className="stroke-foreground" />
            {/* Left of the line and a row lower where right of it would run into the lane's name. */}
            <text
              x={x(run.stop.seconds) + (x(run.stop.seconds) > plotRight - 220 ? -6 : 6)}
              y={lanesTop + (x(run.stop.seconds) > plotRight - 220 ? 32 : 16)}
              textAnchor={x(run.stop.seconds) > plotRight - 220 ? "end" : "start"}
              className="fill-foreground font-semibold"
            >
              {`${run.stop.reason === "weight" ? "Stops" : "Ends"} at ${seconds(run.stop.seconds)}`}
            </text>
            {(["pressure", "flow"] as const).map((lane) => {
              const last = run.samples.at(-1)?.values[lane];
              return last === null || last === undefined ? null : (
                <circle key={lane} cx={x(run.stop.seconds)} cy={y(lane, last)} r={4} className={`${BLUE_FILL} stroke-background`} strokeWidth={2} />
              );
            })}
          </g>

          {/* The weight in the cup along the time axis. */}
          <g data-cup>
            <text x={4} y={cupY + 4} className="fill-muted-foreground text-[11px]">
              {short ? "Cup" : "In the cup"}
            </text>
            {run.timeToFirstDrip !== null && <line x1={x(run.timeToFirstDrip)} x2={x(run.stop.seconds)} y1={cupY} y2={cupY} className="stroke-foreground" />}
            {cupMarks.map((mark) => (
              <g key={mark.text} data-cup-mark={mark.text}>
                <line x1={x(mark.at)} x2={x(mark.at)} y1={cupY - 4} y2={cupY + 4} className="stroke-foreground" />
                <text x={x(mark.at)} y={cupY - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {short && mark.text === "First drip" ? "Drip" : mark.text}
                </text>
              </g>
            ))}
            <text x={x(run.stop.seconds) + 6} y={cupY + 4} className="fill-foreground text-[11px] font-semibold">
              {`${measure(run.weight)} g`}
            </text>
          </g>

          {/* The time axis. */}
          {Array.from({ length: end / tick + 1 }, (_, index) => index * tick).map((at) => (
            <text key={at} x={x(at)} y={height - 6} textAnchor={at === end ? "end" : "middle"} className="fill-muted-foreground">
              {at === end ? `${at} s` : at}
            </text>
          ))}

          {pointer !== null && pointed && (
            <Readout
              at={pointer}
              x={x(pointer)}
              top={lanesTop}
              bottom={lanesBottom}
              plotRight={plotRight}
              y={y}
              profile={profile}
              sample={pointed}
              compared={compared && pointedCompared ? { label: compared.label, sample: pointedCompared } : undefined}
            />
          )}
        </svg>
      )}
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

/** The values at the moment pointed at: the run's, against its plan, and the compared record's. */
function Readout({
  at,
  x,
  top,
  bottom,
  plotRight,
  y,
  profile,
  sample,
  compared,
}: {
  at: number;
  x: number;
  top: number;
  bottom: number;
  plotRight: number;
  y: (lane: Lane, value: number) => number;
  profile: Profile;
  sample: Sample<ShotCurve>;
  compared?: { label: string; sample: Sample<ShotCurve> };
}) {
  const step = sample.step ? profile.steps[sample.step.frame] : undefined;
  const of = (lane: "pressure" | "flow") => (step?.pump === lane ? ` of ${measure(sample.targets[lane] ?? 0)}` : "");
  const rows: [string, string][] = [
    ["Pressure", `${measure(sample.values.pressure ?? 0)} bar${of("pressure")}`],
    ["Flow", `${measure(sample.values.flow ?? 0)} ml/s${of("flow")}`],
    ["In the cup", `${measure(sample.values.weight ?? 0)} g`],
  ];
  if (compared) {
    const values = compared.sample.values;
    rows.push([compared.label, [values.pressure, values.flow].every((value) => value !== null) ? `${measure(values.pressure!)} bar, ${measure(values.flow!)} ml/s` : "-"]);
  }
  const boxWidth = compared ? 250 : 190;
  const boxHeight = 30 + rows.length * 18;
  const left = x + 10 + boxWidth > plotRight ? x - 10 - boxWidth : x + 10;
  return (
    <g pointerEvents="none" data-readout>
      <line x1={x} x2={x} y1={top} y2={bottom} className="stroke-foreground/50" />
      {(["pressure", "flow"] as const).map((lane) =>
        sample.values[lane] === null ? null : <circle key={lane} cx={x} cy={y(lane, sample.values[lane]!)} r={4} className={`${BLUE_FILL} stroke-background`} strokeWidth={2} />,
      )}
      {compared &&
        (["pressure", "flow"] as const).map((lane) =>
          compared.sample.values[lane] === null ? null : (
            <circle key={`c-${lane}`} cx={x} cy={y(lane, compared.sample.values[lane]!)} r={4} className={`${ORANGE_FILL} stroke-background`} strokeWidth={2} />
          ),
        )}
      <rect x={left} y={top + 34} width={boxWidth} height={boxHeight} rx={8} className="fill-background stroke-border" />
      <text x={left + 12} y={top + 54} className="fill-foreground font-semibold">
        {`${seconds(at)}${sample.step ? ` · ${sample.step.name}` : ""}`}
      </text>
      {rows.map(([term, value], index) => (
        <g key={term}>
          <text x={left + 12} y={top + 74 + index * 18} className="fill-muted-foreground">
            {term}
          </text>
          <text x={left + boxWidth - 12} y={top + 74 + index * 18} textAnchor="end" className="fill-foreground font-semibold">
            {value}
          </text>
        </g>
      ))}
    </g>
  );
}
