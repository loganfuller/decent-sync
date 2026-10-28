import { CartesianGrid, type LabelProps, Line, LineChart, ReferenceArea, ReferenceLine, Text, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { numberText } from "@/components/records";
import {
  type CurveInfo,
  type Sample,
  type ShadedSpan,
  chartPoints,
  firstSecond,
  lastSecond,
  phaseChanges,
  secondTicks,
  shadeAt,
  shadedSpans,
  stepAt,
  stepChanges,
} from "@/lib/curves";

// Colors from the data visualization palette's first two categorical slots,
// checked for color vision deficiencies against light and dark surfaces: this
// record and its target are blue, the record compared with it orange. The
// target is also dashed, so it never relies on color alone.
const THIS_RECORD = { light: "#2a78d6", dark: "#3987e5" };
const PREVIOUS_RECORD = { light: "#eb6834", dark: "#d95926" };

/** Legends and tooltips name the series in this order, whichever are drawn. */
const ORDER: Record<string, number> = { current: 0, target: 1, previous: 2 };
const byOrder = (item: { dataKey?: unknown }) => ORDER[String(item.dataKey)] ?? 3;

/** The record a chart compares with the one shown, and what its legend and tooltips call it, such as "Previous Shot". */
export interface Compared<C extends string> {
  label: string;
  samples: Sample<C>[];
}

/**
 * A record's curves, each its own chart on a shared time axis, with the
 * targets it followed and, when given, the same curves of the record it is
 * compared with, both from 0 s. `label` names the record shown, such as
 * "This Shot". Its shaded phases, which its duration leaves out, are shaded
 * and named: a Shot's Preheat, or a Steam Record's lead-in, before 0 s, and
 * a Steam Record's pauses, puffs and purge after it. A dashed vertical line
 * marks each change of a Shot's Profile step, as Streamline marks them
 * (`addStepMarker`), and each place two of a Steam Record's shaded phases
 * meet, the record shown's only.
 */
export function Curves<C extends string>({
  curves,
  label,
  current,
  previous,
}: {
  curves: Record<C, CurveInfo>;
  label: string;
  current: Sample<C>[];
  previous?: Compared<C>;
}) {
  const from = Math.min(firstSecond(current), previous ? firstSecond(previous.samples) : 0);
  const until = Math.max(lastSecond(current), previous ? lastSecond(previous.samples) : 0);
  const lines = [...stepChanges(current), ...phaseChanges(current)];
  // Every time before 0 s is in the lead-in, whichever record it is from.
  const lead = [...current, ...(previous?.samples ?? [])].find((sample) => sample.seconds < 0)?.shade ?? undefined;
  // The lead-in is shaded from the axis's start; a span ending at the record's last sample runs to the axis's end.
  const spans = shadedSpans(current).filter((span) => span.from >= 0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {(Object.keys(curves) as C[]).map((curve) => (
        <CurveChart
          key={curve}
          curve={curve}
          info={curves[curve]}
          currentLabel={label}
          current={current}
          previous={previous}
          lines={lines}
          lead={lead}
          spans={spans}
          from={from}
          until={until}
        />
      ))}
    </div>
  );
}

function CurveChart<C extends string>({
  curve,
  info,
  currentLabel,
  current,
  previous,
  lines,
  lead,
  spans,
  from,
  until,
}: {
  curve: C;
  info: CurveInfo;
  currentLabel: string;
  current: Sample<C>[];
  previous?: Compared<C>;
  lines: number[];
  lead: string | undefined;
  spans: ShadedSpan[];
  from: number;
  until: number;
}) {
  const { label, unit } = info;
  const points = chartPoints(curve, current, previous?.samples, from, until);
  const start = Math.floor(from);
  const end = Math.max(1, Math.ceil(until));
  const hasTarget = points.some((point) => point.target !== null);
  const hasValue = points.some((point) => point.current !== null || point.previous !== null);
  // A reading with no value either side draws no line, so it is marked: 8 pixels across, in its series' color.
  const lone = (key: "current" | "target" | "previous") =>
    function LoneReading({ index, cx, cy }: { index: number; cx?: number; cy?: number }) {
      const isolated = points[index]?.[key] != null && points[index - 1]?.[key] == null && points[index + 1]?.[key] == null;
      if (!isolated || cx === undefined || cy === undefined) return null;
      return <circle key={`${key}-${index}`} data-lone-reading={key} cx={cx} cy={cy} r={4} fill={`var(--color-${key})`} />;
    };
  const config = {
    current: { label: currentLabel, theme: THIS_RECORD },
    target: { label: "Target", theme: THIS_RECORD },
    previous: { label: previous?.label, theme: PREVIOUS_RECORD },
  } satisfies ChartConfig;

  return (
    <figure aria-label={label} className="grid gap-2">
      <figcaption className="text-sm font-medium">
        {label} <span className="font-normal text-muted-foreground">({unit})</span>
      </figcaption>
      {hasValue ? (
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="seconds"
              type="number"
              domain={[start, end]}
              ticks={secondTicks(start, end)}
              tickLine={false}
              axisLine={false}
              tickFormatter={(seconds: number) => `${seconds} s`}
            />
            <YAxis
              width={40}
              tickLine={false}
              axisLine={false}
              domain={info.fit ? [(min: number) => Math.floor(min - 2), (max: number) => Math.ceil(max + 2)] : [0, "auto"]}
              allowDecimals={false}
            />
            <ChartTooltip
              // Recharts sorts only its own tooltip's items, so these are sorted here.
              content={({ active, payload, label }) => (
                <ChartTooltipContent
                  active={active}
                  label={label}
                  // A series with no value at this time, as a target where a step sets none, is left out.
                  payload={(payload ?? []).filter((item) => item.value != null).sort((a, b) => byOrder(a) - byOrder(b))}
                  labelFormatter={(_, payload) => {
                    const seconds: number = payload[0]?.payload.seconds ?? 0;
                    return secondsLabel(seconds, seconds < 0 ? lead : (stepAt(current, seconds)?.name ?? shadeAt(current, seconds) ?? undefined));
                  }}
                  formatter={(value, name) => (
                    <div className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                      {/* To hundredths, as the measurements table shows them: a probe may report 48.97000000000001. */}
                      <span className="font-mono tabular-nums">{numberText(Number(value), unit)}</span>
                    </div>
                  )}
                />
              )}
            />
            <ChartLegend content={<ChartLegendContent />} itemSorter={byOrder} />
            {start < 0 && <ReferenceArea x1={start} x2={0} {...shading(lead)} />}
            {spans.map((span) => (
              <ReferenceArea key={span.from} x1={span.from} x2={span.until < lastSecond(current) ? span.until : end} {...shading(span.name)} />
            ))}
            {lines.map((seconds) => (
              // Muted, longer dashes than a target's, and behind the curves' line layer (400).
              <ReferenceLine
                key={seconds}
                x={seconds}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.6}
                strokeDasharray="8 4"
                zIndex={300}
              />
            ))}
            {previous && (
              <Line dataKey="previous" type="linear" stroke="var(--color-previous)" strokeWidth={2} dot={lone("previous")} isAnimationActive={false} />
            )}
            {hasTarget && (
              <Line
                dataKey="target"
                type="stepAfter"
                stroke="var(--color-target)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={lone("target")}
                isAnimationActive={false}
              />
            )}
            {/* Above the default line layer, so it stays in front of the record compared with, which mounts after it. */}
            <Line
              dataKey="current"
              type="linear"
              stroke="var(--color-current)"
              strokeWidth={2}
              dot={lone("current")}
              isAnimationActive={false}
              zIndex={410}
            />
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="text-sm text-muted-foreground">Not recorded.</p>
      )}
    </figure>
  );
}

/** A time on the chart, to hundredths, and the shaded phase or step it is in, if any. */
function secondsLabel(seconds: number, name: string | undefined): string {
  const text = `${Number(seconds.toFixed(2))} s`;
  return name ? `${text}, ${name}` : text;
}

/** A shaded phase's shading, and its name at the top of it. */
function shading(name: string | undefined) {
  return { fill: "var(--muted-foreground)", fillOpacity: 0.12, label: name && { value: name, content: ShadeName } };
}

/** About the widest a character of a shaded phase's name is drawn, in pixels, at the chart's text size. */
const NAME_CHARACTER_WIDTH = 7;

/**
 * A shaded phase's name, at the top of its shading, as Recharts places a
 * label inside an area's top, drawn only where the shading is wide enough
 * for it at the chart's width, as a short pause on a long record isn't.
 */
function ShadeName({ value, viewBox }: LabelProps) {
  const name = String(value ?? "");
  // An area's is a cartesian box.
  const { x = 0, y = 0, width = 0 } = viewBox && "width" in viewBox ? viewBox : {};
  if (width < name.length * NAME_CHARACTER_WIDTH + 4) return null;
  return (
    <Text x={x + width / 2} y={y + 5} textAnchor="middle" verticalAnchor="start" className="recharts-label fill-muted-foreground text-xs">
      {name}
    </Text>
  );
}
