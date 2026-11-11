import { ChevronDownIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BucketedGroup, type ShotSummary, type SummaryBucket, api } from "@/lib/api";
import { bucketLabel, bucketTitle } from "@/lib/machine-use";
import { NUMBER_NAMES, shotsText } from "@/lib/shot-summary";
import { type Bucket, TREND_NUMBERS, TREND_UNITS, type TrendNumber, type TrendPoint, axisSpan, axisTicks, dateOf, pointText, pointTitle, trendPoints, untimedShots } from "@/lib/shot-trend";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// The trend's color, the data visualization palette's first categorical
// slot, as the Shot page's curves draw the record shown: checked for color
// vision deficiencies against the card's light and dark surfaces. There is
// one series, which the chart's title names, so nothing is told by color.
const CHART = { value: { label: "Median", theme: { light: "#2a78d6", dark: "#3987e5" } } } satisfies ChartConfig;

/** The most points each is marked with a dot at: a month by day. Beyond it dots would run together, and the line alone is drawn. */
const MOST_MARKERS = 31;

/**
 * How one number of the Shots a list's filters find moved (#470), under
 * their summary: by day or week, its median as a line, with a band for the
 * range the middle half of each day's or week's Shots fall in, or, for a
 * share, such as stopped on weight, the line alone. A day or week is each
 * Shot's Location's own, as the server counts them, so the days charted are
 * calendar days, the browser's own time zone playing no part; one with no
 * Shots, or none with a value, has no point, and the line runs past it.
 *
 * `filterQuery` is the list's filters as the REST API's query, and `number`
 * and `bucket` those its address keeps, which `onNumber` and `onBucket`
 * change. It is loaded again every 30 s, as the summary is. As another
 * number, bucket or filter is chosen, what was read last stays, faded, under
 * its own title, until the new one's arrives, and goes if that can't be
 * read.
 */
export function ShotTrendCard({
  filterQuery,
  number,
  bucket,
  onNumber,
  onBucket,
}: {
  filterQuery: string;
  number: TrendNumber;
  bucket: Bucket;
  onNumber(number: TrendNumber): void;
  onBucket(bucket: Bucket): void;
}) {
  const id = useId();
  const query = new URLSearchParams([...new URLSearchParams(filterQuery), ["bucket", bucket], ["numbers", number]]).toString();
  // Each trend loaded remembers what it answers, and so what it is to be drawn as.
  const load = useCallback(async () => ({ query, number, bucket, summary: await api<ShotSummary<BucketedGroup>>("GET", `/shots/summary?${query}`) }), [query, number, bucket]);
  const { data: loaded, error } = usePolled(load, DETAILS_POLL_MS);
  const current = loaded?.query === query;
  // The previous release's instance, answering during a deploy, knows no bucket and gives none: nothing is drawn of it.
  const buckets = loaded && (current || !error) ? loaded.summary.groups[0]?.buckets : undefined;

  return (
    <Card role="region" aria-label="Trend">
      <CardHeader>
        <CardTitleWithInfo title="Trend">
          <p>How one number of the Shots these filters find moved, by day or by week. Cleaning, calibration and Unfinished Shots are left out, as in the summary.</p>
          <p>The line is each day's or week's median, and the band around it the range the middle half of its Shots fall in. A share, such as stopped on weight, is a line alone.</p>
          <p>A day or week is that of each Shot's Location, in its time zone, or UTC for a Shot with no Location. A week starts on Monday.</p>
          <p>A day or week with no Shots, or none with a value, has no point: the line runs past it to the next.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        <Tabs value={bucket} onValueChange={(chosen) => onBucket(chosen === "week" ? "week" : "day")} className="gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <TabsList>
              <TabsTrigger value="day">By day</TabsTrigger>
              <TabsTrigger value="week">By week</TabsTrigger>
            </TabsList>
            <Field className="w-auto">
              <FieldLabel htmlFor={`${id}-number`} className="sr-only">
                Number
              </FieldLabel>
              <Select value={number} onValueChange={(chosen) => onNumber(chosen as TrendNumber)}>
                <SelectTrigger id={`${id}-number`} className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TREND_NUMBERS.map((name) => (
                    <SelectItem key={name} value={name}>
                      {NUMBER_NAMES[name]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <TabsContent value={bucket} className="grid gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>Could not read the trend: {error}</AlertDescription>
              </Alert>
            )}
            {loaded && buckets && (
              <div className={current ? "grid gap-4" : "grid gap-4 opacity-50"} aria-busy={!current}>
                <TrendFigures buckets={buckets} number={loaded.number} bucket={loaded.bucket} />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** A group's buckets as a trend of `number`: its chart, a note of any Shots in no day or week, and its numbers as a table on asking. */
function TrendFigures({ buckets, number, bucket }: { buckets: readonly SummaryBucket[]; number: TrendNumber; bucket: Bucket }) {
  const points = trendPoints(buckets, number);
  const untimed = untimedShots(buckets);
  const name = NUMBER_NAMES[number];
  const unit = TREND_UNITS[number];
  const share = number === "stoppedOnWeight";
  const span = axisSpan(points, bucket);

  return (
    <>
      <figure aria-label={`${name} by ${bucket}`} className="grid gap-2">
        <figcaption className="text-sm font-medium">
          {name} {unit && <span className="font-normal text-muted-foreground">({unit})</span>}
        </figcaption>
        {points.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to chart: none of these Shots has a value for it.</p>
        ) : (
          <ChartContainer config={CHART} className="aspect-auto h-56 w-full">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                domain={span}
                ticks={axisTicks(span, bucket)}
                tickLine={false}
                axisLine={false}
                // Room for the first and last dots, which sit on the axis's ends.
                padding={{ left: 12, right: 12 }}
                tickFormatter={(at: number) => bucketLabel({ date: dateOf(at) })}
              />
              {/* A share from none of the Shots to all of them; any other number fitted to what the Shots had. */}
              <YAxis width={44} tickLine={false} axisLine={false} domain={share ? [0, 100] : ["auto", "auto"]} tickFormatter={(value: number) => (share ? `${value}%` : String(value))} />
              <ChartTooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.5 }}
                content={({ active, payload }) => (active && payload?.[0] ? <PointTip point={payload[0].payload as TrendPoint} number={number} bucket={bucket} /> : null)}
              />
              {!share && <Area dataKey="band" type="linear" stroke="none" fill="var(--color-value)" fillOpacity={0.15} activeDot={false} isAnimationActive={false} />}
              <Line
                dataKey="value"
                type="linear"
                stroke="var(--color-value)"
                strokeWidth={2}
                // Each day or week marked, ringed in the surface's color where dots meet the line, while there is room for them.
                dot={points.length <= MOST_MARKERS ? { r: 4, fill: "var(--color-value)", stroke: "var(--card)", strokeWidth: 2 } : false}
                activeDot={{ r: 5, fill: "var(--color-value)", stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </figure>
      {untimed > 0 && (
        <p className="text-xs text-muted-foreground">
          {shotsText(untimed)} whose time is unknown {untimed === 1 ? "is" : "are"} in no day or week.
        </p>
      )}
      {points.length > 0 && <Numbers points={points} number={number} bucket={bucket} />}
    </>
  );
}

/** How many Shots a point's value rests on: said of those its day's or week's numbers cover where some had no value. */
function restsOn(point: TrendPoint): string {
  return point.shots === point.covered ? String(point.shots) : `${point.shots} of ${point.covered}`;
}

/** What a day or week held, shown as it is pointed at: its value, the middle half's range, and how many Shots they rest on. */
function PointTip({ point, number, bucket }: { point: TrendPoint; number: TrendNumber; bucket: Bucket }) {
  const text = pointText(point, number);
  const rows = [[NUMBER_NAMES[number], text.value], ...(text.range ? [["Middle half", text.range]] : []), ["Shots", restsOn(point)]];
  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{pointTitle(point.start, bucket)}</div>
      {rows.map(([term, value]) => (
        <div key={term} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{term}</span>
          <span className="font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Every number the chart draws and its tooltips give, as a table, shown on asking. */
function Numbers({ points, number, bucket }: { points: readonly TrendPoint[]; number: TrendNumber; bucket: Bucket }) {
  const [open, setOpen] = useState(false);
  const name = NUMBER_NAMES[number];
  const share = number === "stoppedOnWeight";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid min-w-0 gap-2">
      <div>
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm">
            {open ? "Hide the numbers" : "Show the numbers"}
            <ChevronDownIcon data-icon="inline-end" className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <Table aria-label={`${name} by ${bucket}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{bucket === "day" ? "Day" : "Week of"}</TableHead>
              <TableHead className="text-right">Shots</TableHead>
              <TableHead className="text-right">{share ? name : "Median"}</TableHead>
              {!share && <TableHead className="text-right">Middle half</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point) => {
              const text = pointText(point, number);
              return (
                <TableRow key={point.start}>
                  <TableCell className="whitespace-nowrap">{bucketTitle({ date: point.start })}</TableCell>
                  <TableCell className="text-right tabular-nums">{restsOn(point)}</TableCell>
                  <TableCell className="text-right tabular-nums">{text.value}</TableCell>
                  {!share && <TableCell className="text-right tabular-nums">{text.range}</TableCell>}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}
