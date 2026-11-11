import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { Fragment, useCallback, useRef, useState } from "react";
import { Bar, BarChart, type BarShapeProps, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type MachineUse, type UseBucket, api } from "@/lib/api";
import { USE_COUNTS, type UseCount, bucketLabel, bucketTitle, countTotals, durationText, stateTimes } from "@/lib/machine-use";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// Each count's color, from the data visualization palette's first four
// categorical slots, in its order, checked for color vision deficiencies
// against the card's light and dark surfaces. Two of them are faint on the
// light surface, so the numbers are in a table too, and each count is named
// beside its color with its total.
const COLORS: Record<UseCount, { theme: { light: string; dark: string }; swatch: string }> = {
  shots: { theme: { light: "#2a78d6", dark: "#3987e5" }, swatch: "bg-[#2a78d6] dark:bg-[#3987e5]" },
  steamRecords: { theme: { light: "#eb6834", dark: "#d95926" }, swatch: "bg-[#eb6834] dark:bg-[#d95926]" },
  flushes: { theme: { light: "#1baf7a", dark: "#199e70" }, swatch: "bg-[#1baf7a] dark:bg-[#199e70]" },
  hotWaterPours: { theme: { light: "#eda100", dark: "#c98500" }, swatch: "bg-[#eda100] dark:bg-[#c98500]" },
};

const CHART = Object.fromEntries(USE_COUNTS.map(({ key, label }) => [key, { label, theme: COLORS[key].theme }])) satisfies ChartConfig;

const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * How much a Machine was used (#475), on its page: its Shots, Steam Records,
 * flushes and hot water pours charted by day, for the last 14 days unless
 * another range is chosen, or by hour of one day, with the time it spent in
 * each Machine State over them. A day or an hour is that of the Location the
 * Machine was at then, as the server counts them, so the days chosen are
 * calendar days, the browser's own time zone playing no part. It is loaded
 * again every 30 s. As another range is chosen, what was read last stays,
 * faded, until the new range's arrives, and goes if that can't be read, so
 * no figures stand under days they aren't of, and no error of a range since
 * left stands over the one chosen.
 */
export function MachineUseCard({ machineId }: { machineId: string }) {
  const [by, setBy] = useState<MachineUse["by"]>("day");
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [day, setDay] = useState<string>();
  const query = new URLSearchParams(by === "day" ? { ...(range.from && { from: range.from }), ...(range.to && { to: range.to }) } : { by, ...(day && { from: day, to: day }) }).toString();
  // Each answer names the range it was asked for, and `failed` the range the error shown is of, so neither figures nor
  // an error of a range since changed are shown as the new one's. Only the latest load says which range failed, as
  // usePolled keeps only the latest one's error: `loads` counts them.
  const loads = useRef(0);
  const [failed, setFailed] = useState<string>();
  const load = useCallback(async () => {
    const request = ++loads.current;
    try {
      return { query, use: await api<MachineUse>("GET", `/machines/${encodeURIComponent(machineId)}/use${query ? `?${query}` : ""}`) };
    } catch (caught) {
      if (request === loads.current) setFailed(query);
      throw caught;
    }
  }, [machineId, query]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  const use = polled.data?.use;
  const current = polled.data?.query === query;
  const error = failed === query ? polled.error : undefined;
  // The days read, where none was chosen: the server's last 14 days, or today.
  const read = use?.by === by ? { first: use.buckets[0]?.date, last: use.buckets.at(-1)?.date } : {};

  return (
    <Card role="region" aria-label="Use">
      <CardHeader>
        <CardTitleWithInfo title="Use">
          <p>How much this Machine was used in each day, or each hour of one day, at the Location it was at then.</p>
          <p>Every Shot counts, cleaning and calibration Shots too. A flush or a hot water pour is one visit to that Machine State, counted where it began.</p>
          <p>
            A Machine State lasts until the next one its tablet reports, so a Machine whose tablet was off counts as in its last state until the tablet is back.
            Monitoring will correct this.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        <Tabs value={by} onValueChange={(chosen) => setBy(chosen === "hour" ? "hour" : "day")} className="gap-4">
          <div className="flex flex-wrap items-end gap-3">
            {/* On a row of its own on a phone, where the days chosen don't fit beside it. */}
            <div className="max-sm:basis-full">
              <TabsList>
                <TabsTrigger value="day">By day</TabsTrigger>
                <TabsTrigger value="hour">By hour</TabsTrigger>
              </TabsList>
            </div>
            {by === "day" ? (
              <>
                <DayField id="use-from" label="From" value={range.from ?? read.first} onChange={(from) => setRange((chosen) => ({ ...chosen, from }))} />
                <DayField id="use-to" label="To" value={range.to ?? read.last} onChange={(to) => setRange((chosen) => ({ ...chosen, to }))} />
              </>
            ) : (
              <DayField id="use-day" label="Day" value={day ?? read.first} onChange={setDay} />
            )}
          </div>
          <TabsContent value={by} className="grid gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>Could not read its use: {error}</AlertDescription>
              </Alert>
            )}
            {use && (current || !error) && (
              <div className={current ? "grid gap-4" : "grid gap-4 opacity-50"} aria-busy={!current}>
                <UseFigures use={use} />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** A day chosen from a calendar, as a date such as 2026-11-05; "Today" until one is chosen or read. */
export function DayField({ id, label, value, onChange }: { id: string; label: string; value: string | undefined; onChange(day: string): void }) {
  const [open, setOpen] = useState(false);
  const [year, month, dayOfMonth] = (value ?? "").split("-").map(Number);
  const date = value ? new Date(year!, month! - 1, dayOfMonth!) : undefined;
  const pad = (part: number) => String(part).padStart(2, "0");

  return (
    <Field className="w-auto">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" className="w-40 justify-start font-normal">
            <CalendarIcon data-icon="inline-start" />
            {date ? DATE.format(date) : "Today"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            defaultMonth={date}
            captionLayout="dropdown"
            startMonth={new Date(2015, 0)}
            endMonth={new Date(new Date().getFullYear(), 11)}
            onSelect={(chosen) => {
              setOpen(false);
              if (chosen) onChange(`${chosen.getFullYear()}-${pad(chosen.getMonth() + 1)}-${pad(chosen.getDate())}`);
            }}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

/** A range's use: each count's total beside its color, the counts charted by day or hour, the time in each Machine State, and the numbers as a table on asking. */
function UseFigures({ use }: { use: MachineUse }) {
  const totals = countTotals(use.buckets);
  const unit = use.by === "day" ? "day" : "hour";
  if (use.buckets.length === 0) return <p className="text-sm text-muted-foreground">Nothing to count yet: these days are still to come.</p>;

  return (
    <>
      <dl aria-label="Totals" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {USE_COUNTS.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-[2px] ${COLORS[key].swatch}`} />
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-semibold tabular-nums">{totals[key]}</dd>
          </div>
        ))}
      </dl>
      <figure aria-label={`Use by ${unit}`}>
        <ChartContainer config={CHART} className="aspect-auto h-56 w-full">
          <BarChart data={use.buckets.map((bucket) => ({ ...bucket, label: bucketLabel(bucket) }))} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} />
            {/* Every day or hour named where they fit, and otherwise every second or third, evenly. */}
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="equidistantPreserveStart" minTickGap={8} />
            <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
            <ChartTooltip cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }} content={({ active, payload }) => (active && payload?.[0] ? <BucketTip bucket={payload[0].payload as UseBucket} /> : null)} />
            {USE_COUNTS.map(({ key }) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="use"
                fill={`var(--color-${key})`}
                // A gap in the surface's color between the counts of a stack, and between one bar and the next.
                stroke="var(--card)"
                strokeWidth={2}
                maxBarSize={24}
                isAnimationActive={false}
                // Rounded where a stack ends, square where one count meets the next.
                shape={(props: BarShapeProps) => <Rectangle {...props} radius={topCount(props.payload as UseBucket) === key ? [4, 4, 0, 0] : 0} />}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </figure>
      <StateTimes buckets={use.buckets} />
      <Numbers use={use} />
    </>
  );
}

/** The count a day's or hour's stack ends with: the last, in the order they are stacked, that isn't nothing. */
function topCount(bucket: UseBucket): UseCount | undefined {
  return [...USE_COUNTS].reverse().find(({ key }) => bucket[key] > 0)?.key;
}

/** What a day or hour held, shown as it is pointed at: each count, and its time in each Machine State. */
function BucketTip({ bucket }: { bucket: UseBucket }) {
  const times = stateTimes([bucket]);
  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{bucketTitle(bucket)}</div>
      {USE_COUNTS.map(({ key, label }) => (
        <div key={key} className="flex items-center gap-2">
          <span aria-hidden className={`size-2.5 shrink-0 rounded-[2px] ${COLORS[key].swatch}`} />
          <span className="text-muted-foreground">{label}</span>
          <span className="ml-auto font-medium tabular-nums">{bucket[key]}</span>
        </div>
      ))}
      {times.length > 0 && <div className="border-t border-border/50 pt-1.5 font-medium">Time in each Machine State</div>}
      {times.map(({ name, seconds }) => (
        <div key={name} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{name}</span>
          <span className="font-medium tabular-nums">{durationText(seconds)}</span>
        </div>
      ))}
    </div>
  );
}

/** The time spent in each Machine State over the days or hours shown, the longest first, each with a bar as long as its share of the longest. */
function StateTimes({ buckets }: { buckets: readonly UseBucket[] }) {
  const times = stateTimes(buckets);
  const longest = times[0]?.seconds ?? 0;
  return (
    <section aria-label="Time in each Machine State" className="grid gap-2">
      <h3 className="text-sm font-medium">Time in each Machine State</h3>
      {times.length === 0 ? (
        <p className="text-sm text-muted-foreground">Its tablet had reported no Machine State by then.</p>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-sm">
          {times.map(({ name, seconds }) => (
            <Fragment key={name}>
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="contents">
                <span aria-hidden className="h-2 rounded-full bg-muted">
                  <span className="block h-full min-w-0.5 rounded-full bg-muted-foreground/70" style={{ width: `${(seconds / longest) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums">{durationText(seconds)}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Every number the chart draws and its tooltips give, as a table, shown on asking. */
function Numbers({ use }: { use: MachineUse }) {
  const [open, setOpen] = useState(false);
  const unit = use.by === "day" ? "Day" : "Hour";
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
        <Table aria-label={`Use by ${unit.toLowerCase()}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{unit}</TableHead>
              {USE_COUNTS.map(({ key, label }) => (
                <TableHead key={key} className="text-right">
                  {label}
                </TableHead>
              ))}
              <TableHead>Time in each Machine State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {use.buckets.map((bucket) => (
              <TableRow key={`${bucket.date} ${bucket.hour}`}>
                <TableCell className="whitespace-nowrap">{use.by === "day" ? bucketTitle(bucket) : bucketLabel(bucket)}</TableCell>
                {USE_COUNTS.map(({ key }) => (
                  <TableCell key={key} className="text-right tabular-nums">
                    {bucket[key]}
                  </TableCell>
                ))}
                <TableCell className="whitespace-normal">
                  {stateTimes([bucket])
                    .map(({ name, seconds }) => `${name} ${durationText(seconds)}`)
                    .join(", ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}
