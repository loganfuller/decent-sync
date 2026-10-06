import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { CURVES, type Curve, type Sample, chartPoints, lastSecond } from "@/lib/shot-curves";

// Colors from the data visualization palette's first two categorical slots,
// checked for color vision deficiencies against light and dark surfaces: this
// Shot and its target are blue, the Shot compared with it orange. The target
// is also dashed, so it never relies on color alone.
const THIS_SHOT = { light: "#2a78d6", dark: "#3987e5" };
const PREVIOUS_SHOT = { light: "#eb6834", dark: "#d95926" };

/** Legends and tooltips name the series in this order, whichever are drawn. */
const ORDER: Record<string, number> = { current: 0, target: 1, previous: 2 };
const byOrder = (item: { dataKey?: unknown }) => ORDER[String(item.dataKey)] ?? 3;

/**
 * A Shot's pressure, flow, weight and temperature, each its own chart on a
 * shared time axis, with the targets it followed and, when given, the same
 * curves of the Shot it is compared with.
 */
export function ShotCurves({ current, previous }: { current: Sample[]; previous?: Sample[] }) {
  const until = Math.max(lastSecond(current), previous ? lastSecond(previous) : 0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {(Object.keys(CURVES) as Curve[]).map((curve) => (
        <CurveChart key={curve} curve={curve} current={current} previous={previous} until={until} />
      ))}
    </div>
  );
}

function CurveChart({ curve, current, previous, until }: { curve: Curve; current: Sample[]; previous?: Sample[]; until: number }) {
  const { label, unit } = CURVES[curve];
  const points = chartPoints(curve, current, previous, until);
  const hasTarget = points.some((point) => point.target !== null);
  const hasValue = points.some((point) => point.current !== null || point.previous !== null);
  const config = {
    current: { label: "This Shot", theme: THIS_SHOT },
    target: { label: "Target", theme: THIS_SHOT },
    previous: { label: "Previous Shot", theme: PREVIOUS_SHOT },
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
            {/* Temperatures stay far from zero, so their axis fits them; the others start at zero. */}
            <YAxis
              width={40}
              tickLine={false}
              axisLine={false}
              domain={curve === "temperature" ? [(min: number) => Math.floor(min - 2), (max: number) => Math.ceil(max + 2)] : [0, "auto"]}
              allowDecimals={false}
            />
            <ChartTooltip
              // Recharts sorts only its own tooltip's items, so these are sorted here.
              content={({ active, payload, label }) => (
                <ChartTooltipContent
                  active={active}
                  label={label}
                  payload={[...(payload ?? [])].sort((a, b) => byOrder(a) - byOrder(b))}
                  labelFormatter={(_, payload) => `${payload[0]?.payload.seconds ?? 0} s`}
                  formatter={(value, name) => (
                    <div className="flex w-full justify-between gap-4">
                      <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                      <span className="font-mono tabular-nums">
                        {Number(value)} {unit}
                      </span>
                    </div>
                  )}
                />
              )}
            />
            <ChartLegend content={<ChartLegendContent />} itemSorter={byOrder} />
            {previous && (
              <Line dataKey="previous" type="linear" stroke="var(--color-previous)" strokeWidth={2} dot={false} isAnimationActive={false} />
            )}
            {hasTarget && (
              <Line
                dataKey="target"
                type="stepAfter"
                stroke="var(--color-target)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
            )}
            {/* Above the default line layer, so it stays in front of the Shot compared with, which mounts after it. */}
            <Line dataKey="current" type="linear" stroke="var(--color-current)" strokeWidth={2} dot={false} isAnimationActive={false} zIndex={410} />
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="text-sm text-muted-foreground">Not recorded.</p>
      )}
    </figure>
  );
}
