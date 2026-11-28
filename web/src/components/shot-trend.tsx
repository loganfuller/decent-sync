import { ChevronDownIcon } from "lucide-react";
import { Fragment, type RefObject, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { BatchInLine } from "@/components/batch-name";
import { CollapsibleCard } from "@/components/collapsible-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BucketedGroup, type ShotSummary, type SummaryBucket, api } from "@/lib/api";
import { bucketLabel, bucketTitle } from "@/lib/machine-use";
import { MAX_STARS } from "@/lib/rating";
import { NUMBER_NAMES, shotsText } from "@/lib/shot-summary";
import {
  type BatchMark,
  type Bucket,
  PLOT,
  TREND_NUMBERS,
  TREND_UNITS,
  type TrendNumber,
  type TrendPoint,
  type TrendRow,
  axisSpan,
  axisTicks,
  batchMarks,
  dateOf,
  dayNumber,
  drawnMarks,
  isShare,
  labelPlaces,
  lineX,
  markLead,
  pointText,
  pointTitle,
  trendPoints,
  trendRows,
  untimedShots,
} from "@/lib/shot-trend";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// Each line's color, from the data visualization palette's eight categorical
// slots, in its order, the first as the Shot page's curves draw the record
// shown: each beside the next checked for color vision deficiencies against
// the card's light and dark surfaces. Three of them are faint on the light
// surface, so the numbers are in a table too, and each line is named beside
// its color. One line alone is named by the chart's title, and nothing is
// told by its color.
const COLORS: readonly { theme: { light: string; dark: string }; swatch: string }[] = [
  { theme: { light: "#2a78d6", dark: "#3987e5" }, swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  { theme: { light: "#eb6834", dark: "#d95926" }, swatch: "bg-[#eb6834] dark:bg-[#d95926]" },
  { theme: { light: "#1baf7a", dark: "#199e70" }, swatch: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { theme: { light: "#eda100", dark: "#c98500" }, swatch: "bg-[#eda100] dark:bg-[#c98500]" },
  { theme: { light: "#e87ba4", dark: "#d55181" }, swatch: "bg-[#e87ba4] dark:bg-[#d55181]" },
  { theme: { light: "#008300", dark: "#008300" }, swatch: "bg-[#008300]" },
  { theme: { light: "#6250d6", dark: "#9085e9" }, swatch: "bg-[#6250d6] dark:bg-[#9085e9]" },
  { theme: { light: "#e34948", dark: "#e66767" }, swatch: "bg-[#e34948] dark:bg-[#e66767]" },
];

/** The most lines one chart draws, each in a color of its own: a chart given more draws the first of them. */
export const MOST_LINES = COLORS.length;

const CHART = Object.fromEntries(COLORS.map(({ theme }, line) => [`line${line}`, { theme }])) satisfies ChartConfig;

/** A line's color, as the chart's own style names it. */
const colorOf = (line: number) => `var(--color-line${line})`;

/** The most points each is marked with a dot at: a month by day. Beyond it dots would run together, and the line alone is drawn. */
const MOST_MARKERS = 31;

/** The value axis of a rating, in stars (#532): from none to the most a Shot is rated, marked at each. */
const STARS_AXIS = { domain: [0, MAX_STARS] satisfies [number, number], ticks: Array.from({ length: MAX_STARS + 1 }, (_, stars) => stars) };

/**
 * How one number of the Shots a list's filters find moved (#470), under
 * their summary: by day or week, its median as a line, with a band for the
 * range the middle half of each day's or week's Shots fall in, or, for a
 * share, such as stopped at target, the line alone. A rating is charted in
 * stars, from 0 to 5 (#532). A day or week is each
 * Shot's Location's own, as the server counts them, so the days charted are
 * calendar days, the browser's own time zone playing no part; one with no
 * Shots, or none with a value, has no point, and the line runs past it.
 *
 * It starts closed (#544), and reads nothing until opened: `open` is
 * whether it is, which `onOpen` changes, as the list's address keeps it.
 *
 * `filterQuery` is the list's filters as the REST API's query, and `number`
 * and `bucket` those its address keeps, which `onNumber` and `onBucket`
 * change. It is loaded again every 30 s, as the summary is. As another
 * number, bucket or filter is chosen, what was read last stays, faded, under
 * its own title, until the new one's arrives, and goes if that can't be
 * read.
 *
 * Where the filters name one Recipe, `recipe`, the trend is read grouped by
 * it, which brings its Reference Shot: charting duration, that Shot's is a
 * dashed line across the chart. With no Machine named beside it,
 * `recipe.byMachine`, each Machine that pulled the Recipe is a line of its
 * own, named beside its color, its name opening the list at that Machine
 * (`recipe.machinePath`). Either way it is marked where the Recipe's Bean
 * Batch changed (#733), from a second read of the same Shots grouped by
 * Bean Batch.
 */
export function ShotTrendCard({
  filterQuery,
  recipe,
  open,
  onOpen,
  number,
  bucket,
  onNumber,
  onBucket,
}: {
  filterQuery: string;
  recipe?: { byMachine: boolean; machinePath(machineId: string): string };
  open: boolean;
  onOpen(open: boolean): void;
  number: TrendNumber;
  bucket: Bucket;
  onNumber(number: TrendNumber): void;
  onBucket(bucket: Bucket): void;
}) {
  return (
    <CollapsibleCard
      title="Trend"
      open={open}
      onOpenChange={onOpen}
      info={
        <>
          <p>How one number of the Shots these filters find moved, by day or by week. Cleaning, calibration and Unfinished Shots are left out, as in the summary.</p>
          <p>The line is each day's or week's median, and the band around it the range the middle half of its Shots fall in. A share, such as stopped at target, is a line alone.</p>
          <p>
            Filtered to one Recipe and no Machine, each Machine that pulled it is a line of its own. Charting duration, the dashed line is its
            Reference Shot's.
          </p>
          <p>
            Filtered to one Recipe, a vertical line stands on the first day, or week, its Shots were pulled with another Bean Batch, labelled
            with that batch's Batch Code, or its roast date where it has none. The batches are listed under the chart.
          </p>
          <p>A day or week is that of each Shot's Location, in its time zone, or UTC for a Shot with no Location. A week starts on Monday.</p>
          <p>A day or week with no Shots, or none with a value, has no point: the line runs past it to the next.</p>
        </>
      }
    >
      <Trend filterQuery={filterQuery} recipe={recipe} number={number} bucket={bucket} onNumber={onNumber} onBucket={onBucket} />
    </CollapsibleCard>
  );
}

/** The open Trend card's content, which reads the trend while it is shown. */
function Trend({ filterQuery, recipe, number, bucket, onNumber, onBucket }: Omit<Parameters<typeof ShotTrendCard>[0], "open" | "onOpen">) {
  const id = useId();
  const byMachine = recipe?.byMachine === true;
  const query = new URLSearchParams([
    ...new URLSearchParams(filterQuery),
    ["bucket", bucket],
    ["numbers", number],
    // As many Machines as the chart draws lines of.
    ...(recipe ? [["groupBy", byMachine ? "recipe,machine" : "recipe"], ["limit", String(MOST_LINES)]] : []),
  ]).toString();
  // Each trend loaded remembers what it answers, and so what it is to be drawn as.
  // Of one Recipe, the same Shots grouped by Bean Batch too, which its marks are read from.
  const marksQuery = recipe ? new URLSearchParams([...new URLSearchParams(filterQuery), ["bucket", bucket], ["numbers", "duration"], ["groupBy", "beanBatch"]]).toString() : undefined;
  const load = useCallback(async () => {
    const [summary, marks] = await Promise.all([api<ShotSummary<BucketedGroup>>("GET", `/shots/summary?${query}`), marksQuery === undefined ? undefined : readBatchMarks(marksQuery)]);
    return { query, number, bucket, byMachine, summary, marks };
  }, [query, marksQuery, number, bucket, byMachine]);
  const { data: loaded, error } = usePolled(load, DETAILS_POLL_MS);
  const current = loaded?.query === query;
  const groups = loaded && (current || !error) ? loaded.summary.groups : undefined;
  // The previous release's instance, answering during a deploy, knows no bucket and gives none: nothing is drawn of it.
  // Grouped by Recipe and no Shots found, there is no group, and so no line, which the chart says.
  const lines: TrendLine[] | undefined = !groups
    ? undefined
    : loaded!.byMachine
      ? groups.flatMap((group) => (group.by.machine && group.buckets ? [{ id: group.by.machine.id, name: group.by.machine.name, to: recipe?.machinePath(group.by.machine.id), buckets: group.buckets }] : []))
      : groups[0]?.buckets
        ? [{ id: "all", buckets: groups[0].buckets }]
        : recipe && groups.length === 0
          ? [{ id: "all", buckets: [] }]
          : undefined;
  // Each group of a Recipe gives the same Reference Shot, with its own value of the number charted.
  const reference = groups?.[0]?.reference;
  const referenceDuration = loaded?.number === "duration" ? reference?.numbers.duration : undefined;

  return (
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
          {!loaded && !error && <p className="text-sm text-muted-foreground">Loading</p>}
          {loaded && lines && (
            <div className={current ? "grid gap-4" : "grid gap-4 opacity-50"} aria-busy={!current}>
              <TrendChart
                lines={lines}
                of={loaded.byMachine ? "Machine" : undefined}
                number={loaded.number}
                bucket={loaded.bucket}
                reference={reference && typeof referenceDuration === "number" ? { id: reference.id, value: referenceDuration } : undefined}
                marks={loaded.marks}
              />
              {loaded.byMachine && loaded.summary.total > lines.length && (
                <p className="text-xs text-muted-foreground">
                  The lines are of the first {lines.length} Machines by name, of {loaded.summary.total} that pulled it.
                </p>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </CardContent>
  );
}

/** The most groups one read of a summary gives (`readPage` in the server's pagination.ts). */
const PAGE = 100;

/**
 * A Trend's marks (#733), from the Shot Summary of the Shots `query` finds,
 * which names their bucket and groups them by Bean Batch, every page of it.
 * None where it can't be read, so the Trend is drawn without them.
 */
export async function readBatchMarks(query: string): Promise<BatchMark[]> {
  try {
    const page = (offset: number) => api<ShotSummary<BucketedGroup>>("GET", `/shots/summary?${new URLSearchParams([...new URLSearchParams(query), ["limit", String(PAGE)], ["offset", String(offset)]])}`);
    const first = await page(0);
    const groups = [...first.groups];
    while (groups.length < first.total) {
      const next = await page(groups.length);
      if (next.groups.length === 0) break;
      groups.push(...next.groups);
    }
    return batchMarks(groups);
  } catch {
    return [];
  }
}

/**
 * A line of a trend: a group's buckets, as a Shot Summary asked for by
 * `bucket` gives them. `id` tells it from the chart's other lines. Where
 * the chart says what its lines are `of`, `name` names it beside its color,
 * and leads to `to`, as to the line's Shots in the Shots list.
 */
export interface TrendLine {
  id: string;
  name?: string;
  to?: string;
  buckets: readonly SummaryBucket[];
}

/**
 * A trend of `number` by day or week: a chart of its lines, each a group's
 * median with the band of its middle half, a note of any Shots in no day or
 * week, and its numbers as a table on asking. One line is named by the
 * chart's title. With what its lines are `of`, such as Machine, each is
 * named beside its color under the chart, in its tooltips and in the table,
 * the first `MOST_LINES` of them drawn. The time axis runs from the first
 * day or week with a point to the last, or over `days`, where given, as the
 * days the Shots were asked for. `reference` is a Recipe's Reference Shot's
 * own value of the number, drawn as a dashed line across the chart with its
 * value beside it, and named under the chart, where it leads to that Shot.
 *
 * `marks` are the Bean Batches a Trend of one Recipe is marked with (#733,
 * `batchMarks`): a vertical line on the first day or week each was used,
 * labelled at its top with the batch's Batch Code, or its roast date where
 * it has none; the batch of the chart's earliest Shots labelled at its left
 * edge, with no line; a label that would be drawn over another left out;
 * and under the chart a legend entry and the batches, the latest first,
 * each linked. They are the same whatever its lines are of, and the table
 * of numbers holds none of them.
 */
export function TrendChart({
  lines: given,
  of,
  number,
  bucket,
  days,
  reference,
  marks = [],
}: {
  lines: readonly TrendLine[];
  of?: string;
  number: TrendNumber;
  bucket: Bucket;
  days?: { from: string; to: string };
  reference?: { id: string; value: number };
  marks?: readonly BatchMark[];
}) {
  const lines = given.slice(0, MOST_LINES);
  const rows = trendRows(lines.map((line) => trendPoints(line.buckets, number)));
  const untimed = lines.reduce((shots, line) => shots + untimedShots(line.buckets), 0);
  const name = NUMBER_NAMES[number];
  const unit = TREND_UNITS[number];
  const share = isShare(number);
  const referenceText = reference && pointText({ value: reference.value, band: [reference.value, reference.value] }, number).value;
  const span = days ? ([dayNumber(days.from), dayNumber(days.to)] satisfies [number, number]) : axisSpan(rows, bucket);
  const drawn = drawnMarks(marks, span);
  const marked = rows.length > 0 && (drawn.edge !== undefined || drawn.lines.length > 0);

  return (
    <>
      <figure aria-label={`${name} by ${bucket}`} className="grid gap-2">
        <figcaption className="text-sm font-medium">
          {name} {unit && <span className="font-normal text-muted-foreground">({unit})</span>}
        </figcaption>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {number === "grindSetting" ? "Nothing to chart: none of these Shots has a grind setting that is a number." : "Nothing to chart: none of these Shots has a value for it."}
          </p>
        ) : (
          <div className="relative">
            {marked && <BatchMarks drawn={drawn} span={span} />}
            {/* A marked chart is as much taller as its labels need over its plot. */}
            <ChartContainer config={CHART} className={marked ? "aspect-auto h-61 w-full" : "aspect-auto h-56 w-full"}>
              <ComposedChart data={rows} margin={{ top: marked ? PLOT.labels : PLOT.top, right: PLOT.right, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="at"
                  type="number"
                  domain={span}
                  ticks={axisTicks(span, bucket)}
                  height={PLOT.bottom}
                  tickLine={false}
                  axisLine={false}
                  // Room for the first and last dots, which sit on the axis's ends.
                  padding={{ left: PLOT.pad, right: PLOT.pad }}
                  tickFormatter={(at: number) => bucketLabel({ date: dateOf(at) })}
                />
                {/* A share from none of the Shots to all of them, and a rating from no stars to five; any other number fitted to what the Shots had. */}
                <YAxis
                  width={PLOT.left}
                  tickLine={false}
                  axisLine={false}
                  domain={share ? [0, 100] : number === "rating" ? STARS_AXIS.domain : ["auto", "auto"]}
                  ticks={number === "rating" ? STARS_AXIS.ticks : undefined}
                  tickFormatter={(value: number) => (share ? `${value}%` : String(value))}
                />
                <ChartTooltip
                  cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.5 }}
                  content={({ active, payload }) => (active && payload?.[0] ? <PointTip row={payload[0].payload as TrendRow} lines={lines} of={of} number={number} bucket={bucket} /> : null)}
                />
                {/* Every band under every line. A line, and its band, run past a day or week it has no point of. */}
                {!share &&
                  lines.map((line, index) => (
                    <Area
                      key={line.id}
                      dataKey={(row: TrendRow) => row.points[index]?.band}
                      type="linear"
                      stroke="none"
                      fill={colorOf(index)}
                      fillOpacity={0.15}
                      activeDot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  ))}
                {/* Under the lines, which cross it; the value axis grows to hold it. */}
                {reference && (
                  <ReferenceLine
                    y={reference.value}
                    ifOverflow="extendDomain"
                    stroke="var(--muted-foreground)"
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    label={{ value: `Reference ${referenceText}`, position: "insideBottomRight", fill: "var(--muted-foreground)", fontSize: 12 }}
                  />
                )}
                {lines.map((line, index) => (
                  <Line
                    key={line.id}
                    dataKey={(row: TrendRow) => row.points[index]?.value}
                    type="linear"
                    stroke={colorOf(index)}
                    strokeWidth={2}
                    // Each day or week marked, ringed in the surface's color where dots meet a line, while there is room for them.
                    dot={rows.length <= MOST_MARKERS ? { r: 4, fill: colorOf(index), stroke: "var(--card)", strokeWidth: 2 } : false}
                    activeDot={{ r: 5, fill: colorOf(index), stroke: "var(--card)", strokeWidth: 2 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </ComposedChart>
            </ChartContainer>
          </div>
        )}
      </figure>
      {(of !== undefined || reference || (marked && drawn.lines.length > 0)) && (
        <ul aria-label="Lines" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {of !== undefined &&
            lines.map((line, index) => (
              <li key={line.id} className="flex items-center gap-1.5">
                <Swatch line={index} />
                {line.to === undefined ? (
                  line.name
                ) : (
                  <Link to={line.to} className="underline underline-offset-4">
                    {line.name}
                  </Link>
                )}
              </li>
            ))}
          {reference && (
            <li className="flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden className="w-3.5 shrink-0 border-t-2 border-dashed border-muted-foreground" />
              <Link to={`/shots/${encodeURIComponent(reference.id)}`} className="underline underline-offset-4">
                Reference Shot
              </Link>
              <span className="tabular-nums">{referenceText}</span>
            </li>
          )}
          {marked && drawn.lines.length > 0 && (
            <li className="flex items-center gap-1.5 text-muted-foreground">
              <span aria-hidden className="h-3.5 w-0.5 shrink-0 bg-foreground" />
              Another Bean Batch from this {bucket}
            </li>
          )}
        </ul>
      )}
      {rows.length > 0 && marks.length > 0 && (
        <ul aria-label={`Bean Batches in these ${bucket}s`} className="grid gap-1 text-sm">
          {[...marks].reverse().map((mark) => (
            <li key={mark.batch.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-muted-foreground">{markLead(mark, marks, bucket)}</span>
              <BatchInLine batch={mark.batch} id={mark.batch.id} roasted />
            </li>
          ))}
        </ul>
      )}
      {untimed > 0 && (
        <p className="text-xs text-muted-foreground">
          {shotsText(untimed)} whose time is unknown {untimed === 1 ? "is" : "are"} in no day or week.
        </p>
      )}
      {rows.length > 0 && <Numbers rows={rows} lines={lines} of={of} number={number} bucket={bucket} />}
    </>
  );
}

/** The width an element is drawn at, in pixels, as it is laid out and as it changes: undefined until it is measured. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number | undefined] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * A chart's marks, drawn over it: a vertical line from its top to its time
 * axis for each batch with one, and the labels, the edge's at the plot's
 * left and each line's beside its top, placed by the chart's own scale
 * (`lineX`) and kept off each other (`labelPlaces`). Nothing of it is read
 * out or pointed at: the list under the chart names each batch, and the
 * chart's points keep their tooltips.
 */
function BatchMarks({ drawn, span }: { drawn: ReturnType<typeof drawnMarks>; span: readonly [number, number] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} aria-hidden="true" data-slot="batch-marks" className="pointer-events-none absolute inset-0">
      {width !== undefined && (
        <>
          {drawn.lines.map((mark) => (
            <span key={mark.batch.id} data-slot="batch-mark-line" data-day={mark.start} className="absolute top-0.5 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: lineX(mark.at, span, width), bottom: PLOT.bottom }} />
          ))}
          {labelPlaces(drawn, span, width).map((label) => (
            <span
              key={label.mark.batch.id}
              data-slot="batch-mark-label"
              className={`absolute top-0.5 inline-flex h-5.5 items-center justify-center rounded-md border text-[13px] whitespace-nowrap ${label.code ? "font-mono font-medium" : ""} ${label.mark === drawn.edge ? "bg-card text-muted-foreground" : "bg-muted text-foreground"}`}
              style={{ left: label.left, width: label.width }}
            >
              {label.text}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/** A line's color, beside its name. */
function Swatch({ line }: { line: number }) {
  return <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${COLORS[line]!.swatch}`} />;
}

/** How many Shots a point's value rests on: said of those its day's or week's numbers cover where some had no value. */
function restsOn(point: TrendPoint): string {
  return point.shots === point.covered ? String(point.shots) : `${point.shots} of ${point.covered}`;
}

/**
 * What a day or week held, shown as it is pointed at: its value, the middle
 * half's range, and how many Shots they rest on. Of lines named, each line
 * that has a point of it is a row instead, its name beside its color, then
 * its value, range and Shots, so a day eight lines share still fits the
 * chart it is shown over.
 */
function PointTip({ row, lines, of, number, bucket }: { row: TrendRow; lines: readonly TrendLine[]; of: string | undefined; number: TrendNumber; bucket: Bucket }) {
  const frame = "grid min-w-44 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl";
  const title = <div className="font-medium">{pointTitle(row.start, bucket)}</div>;
  if (of !== undefined) {
    return (
      <div className={frame}>
        {title}
        <div className="grid grid-cols-[auto_auto_auto] items-center gap-x-3 gap-y-1">
          {row.points.map((point, index) => {
            if (!point) return null;
            const text = pointText(point, number);
            const shots = point.shots === point.covered ? shotsText(point.shots) : `${point.shots} of ${shotsText(point.covered)}`;
            return (
              <Fragment key={lines[index]!.id}>
                <span className="flex items-center gap-1.5">
                  <Swatch line={index} />
                  {lines[index]!.name}
                </span>
                <span className="text-right font-medium tabular-nums">{text.value}</span>
                <span className="text-muted-foreground tabular-nums">{text.range ? `${text.range} · ${shots}` : shots}</span>
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }
  const point = row.points[0];
  if (!point) return null;
  const text = pointText(point, number);
  const terms = [[NUMBER_NAMES[number], text.value], ...(text.range ? [["Middle half", text.range]] : []), ["Shots", restsOn(point)]];
  return (
    <div className={frame}>
      {title}
      {terms.map(([term, value]) => (
        <div key={term} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{term}</span>
          <span className="font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Every number the chart draws and its tooltips give, as a table, shown on asking: a row for each day or week, and, of lines named, for each line with a point of it. */
function Numbers({ rows, lines, of, number, bucket }: { rows: readonly TrendRow[]; lines: readonly TrendLine[]; of: string | undefined; number: TrendNumber; bucket: Bucket }) {
  const [open, setOpen] = useState(false);
  const name = NUMBER_NAMES[number];
  const share = isShare(number);
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
              {of !== undefined && <TableHead>{of}</TableHead>}
              <TableHead className="text-right">Shots</TableHead>
              <TableHead className="text-right">{share ? name : "Median"}</TableHead>
              {!share && <TableHead className="text-right">Middle half</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.flatMap((row) =>
              row.points.map((point, index) => {
                if (!point) return null;
                const text = pointText(point, number);
                return (
                  <TableRow key={`${row.start} ${lines[index]!.id}`}>
                    <TableCell className="whitespace-nowrap">{bucketTitle({ date: row.start })}</TableCell>
                    {of !== undefined && <TableCell>{lines[index]!.name}</TableCell>}
                    <TableCell className="text-right tabular-nums">{restsOn(point)}</TableCell>
                    <TableCell className="text-right tabular-nums">{text.value}</TableCell>
                    {!share && <TableCell className="text-right tabular-nums">{text.range}</TableCell>}
                  </TableRow>
                );
              }),
            )}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}
