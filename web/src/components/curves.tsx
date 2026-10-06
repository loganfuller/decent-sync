import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { numberText } from "@/components/records";
import { type CurveInfo, type Sample, chartPoints, lastSecond } from "@/lib/curves";

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
 * compared with. `label` names the record shown, such as "This Shot".
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
  const until = Math.max(lastSecond(current), previous ? lastSecond(previous.samples) : 0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {(Object.keys(curves) as C[]).map((curve) => (
        <CurveChart key={curve} curve={curve} info={curves[curve]} currentLabel={label} current={current} previous={previous} until={until} />
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
  until,
}: {
  curve: C;
  info: CurveInfo;
  currentLabel: string;
  current: Sample<C>[];
  previous?: Compared<C>;
  until: number;
}) {
  const { label, unit } = info;
  const points = chartPoints(curve, current, previous?.samples, until);
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
              domain={[0, Math.max(1, Math.ceil(until))]}
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
                  labelFormatter={(_, payload) => `${Number((payload[0]?.payload.seconds ?? 0).toFixed(2))} s`}
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
