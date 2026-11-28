import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { OrNone } from "@/components/records";
import { MOST_LINES, TrendChart, readBatchMarks } from "@/components/shot-trend";
import { SpecMark } from "@/components/spec-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BucketedGroup, type Recipe, type ShotSummary, type SummaryGroup, api } from "@/lib/api";
import { PERIODS, type Period, type SpecLine, betweenMachinesLine, periodDays } from "@/lib/overview";
import { type Judged, RECIPE_TRENDS, TREND_DAYS, TREND_PRESET, machineNumbers, machineShotsPath, recipeTrend, trendDays } from "@/lib/recipe-numbers";
import { NUMBER_NAMES, shotsText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// How a Recipe is pulling (#474, #547), on its page: a period's numbers on
// each Machine, each set against its Reference Shot's and marked where the
// server judged it out of spec (#543), so the Machine that is off stands
// out, and a 30-day trend with a line for each Machine and the Reference
// Shot's duration across it, so a coffee ageing or a grinder drifting
// shows. Both are the Shot Summary of the Recipe's Shots, grouped by Recipe
// and then Machine, and each Machine's open its Shots in the Shots list. A
// day is the Recipe's Location's own, and the Shots of it are those the
// Shots list's date filters find, each by its own Location's time zone.

/** The most groups one read of a summary gives (`readPage` in the server's pagination.ts). */
const PAGE = 100;

/** A Machine's Shots of the Recipe, as a summary's group names one: none for a group with no Machine, which a Recipe's Shots never make. */
function machineOf(group: Pick<SummaryGroup, "by">): { id: string; name: string } | undefined {
  return group.by.machine ?? undefined;
}

/** What says that a summary holds more Machines than are shown. */
function MoreMachines({ shown, total, what }: { shown: number; total: number; what: string }) {
  if (total <= shown) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {what} the first {shown} Machines by name, of {total} that pulled it.
    </p>
  );
}

/** A number that is marked, being out of spec, or as it is otherwise; a dash for none. */
function JudgedNumber({ judged }: { judged: Judged | undefined }) {
  if (!judged) return <OrNone>{undefined}</OrNone>;
  return judged.marked ? <SpecMark>{judged.text}</SpecMark> : <>{judged.text}</>;
}

/** A difference that is marked, being out of spec, or muted otherwise: in full, or, with `short`, without the words a column's heading says. */
function Difference({ line, short = false }: { line: SpecLine; short?: boolean }) {
  const words = short ? line.short : line.text;
  return line.marked ? <SpecMark>{words}</SpecMark> : <span className="text-muted-foreground">{words}</span>;
}

/**
 * A period's numbers of a Recipe on each Machine that pulled it (#547): how
 * many Shots, linked to them in the Shots list, with any Unfinished and
 * cleaning or calibration Shots beside the count; their median duration,
 * with the range the middle half fall in; the duration's difference from
 * the Recipe's Reference Shot's, marked when out of spec and muted
 * otherwise; and their yield against target and the share stopped at
 * target, each marked when out of spec. A last row says how far apart the
 * Machines are, marked when out of spec. The period's days are the Recipe's
 * Location's. On a narrow screen each Machine is a block of a few lines, so
 * nothing scrolls sideways. It is loaded again every 30 s.
 */
export function RecipeByMachineCard({ recipe, period }: { recipe: Recipe; period: Period }) {
  const { id } = recipe;
  const timeZone = recipe.location?.timeZone;
  const load = useCallback(async () => {
    const days = periodDays(period, timeZone ?? "UTC");
    // By Recipe too, which has the server judge each Machine's Shots against its Reference Shot, and its Machines against each other.
    const query = new URLSearchParams({ recipeId: id, from: days.from, to: days.to, groupBy: "recipe,machine", limit: String(PAGE) });
    return { period, summary: await api<ShotSummary>("GET", `/shots/summary?${query}`) };
  }, [id, timeZone, period]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  // One period's numbers never stand under another's name while the next load is on its way.
  const data = polled.data?.period === period ? polled.data : undefined;
  const { error } = polled;
  const { pulled, shots: preset } = PERIODS.find((each) => each.period === period)!;
  const rows = (data?.summary.groups ?? []).flatMap((group) => {
    const machine = machineOf(group);
    return machine ? [{ machine, group, numbers: machineNumbers(group), to: machineShotsPath(id, machine.id, preset) }] : [];
  });
  // Set against the Reference Shot only where the server did so: a Recipe with none, or the previous release's answer,
  // has no such column. The summary's reference is the one the page shows: one cleared or replaced here is gone from
  // beside the numbers at once, until the numbers are read again.
  const referenced = rows[0]?.group.reference?.id === recipe.referenceShot?.id && rows.some((row) => row.numbers.against);
  // Each group of the Recipe gives the same judgement between its Machines.
  const between = betweenMachinesLine(rows[0]?.group.spec?.betweenMachines);
  const label = `By Machine ${pulled}`;

  return (
    <Card role="region" aria-label="By Machine">
      <CardHeader>
        <CardTitleWithInfo title="By Machine">
          <p>
            How its Shots went on each Machine that pulled it, today, yesterday or in the last 7 days: its Location's days, in its time zone.
            Cleaning and calibration Shots, and Unfinished Shots, in which nothing poured, are counted beside the Shots and left out of the
            numbers.
          </p>
          <p>
            Duration is the median, with the range the middle half of the Shots fall in, and beside it how far that is from its Reference
            Shot's: out of spec more than 10% from it. Yield against target is the median of the yield weighed less each Shot's own target, out
            of spec more than 5% from target. Stopped at target is the share, of the Shots that recorded what stopped them, that Decaid
            stopped at their target weight or volume: out of spec under 90%. Fewer than 3 Shots are not judged.
          </p>
          <p>
            Between Machines is how far apart the fastest and slowest Machines' median durations are: out of spec more than 10% of the slower
            one's, counting Machines with at least 3 Shots.
          </p>
          <p>A Machine's count opens its Shots in the Shots list. The numbers are read again every 30 seconds.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read the numbers: {error}</AlertDescription>
          </Alert>
        )}
        {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
        {data && rows.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled with it {pulled}.</p>}
        {data && rows.length > 0 && (
          <>
            <div className="min-w-0 rounded-lg border tabular-nums max-sm:hidden">
              <Table aria-label={label}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Machine</TableHead>
                    <TableHead>Shots</TableHead>
                    <TableHead>{NUMBER_NAMES.duration}</TableHead>
                    {referenced && <TableHead>vs reference</TableHead>}
                    {/* The long headings wrap, so six columns fit the card beside the Reference Shot's. */}
                    <TableHead className="h-auto py-2 whitespace-normal">{NUMBER_NAMES.yieldAgainstTarget}</TableHead>
                    <TableHead className="h-auto py-2 whitespace-normal">{NUMBER_NAMES.stoppedAtTarget}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ machine, group, numbers, to }) => (
                    <TableRow key={machine.id}>
                      <TableHead scope="row" className="h-auto py-2 font-medium whitespace-normal text-foreground">
                        <MachineLink machine={machine} />
                      </TableHead>
                      <TableCell className="whitespace-normal">
                        <Link to={to} className="underline underline-offset-4" aria-label={`${shotsText(group.counts.shots)} on ${machine.name}`}>
                          {group.counts.shots}
                        </Link>
                        {numbers.leftOut.length > 0 && <span className="text-muted-foreground"> · {numbers.leftOut.join(" · ")}</span>}
                      </TableCell>
                      <TableCell>
                        <Median numbers={numbers} />
                      </TableCell>
                      {referenced && <TableCell>{numbers.against ? <Difference line={numbers.against} short /> : <OrNone>{undefined}</OrNone>}</TableCell>}
                      <TableCell>
                        <JudgedNumber judged={numbers.yield} />
                      </TableCell>
                      <TableCell>
                        <JudgedNumber judged={numbers.stopping} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {between && (
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="row" className="font-normal text-muted-foreground">
                        Between Machines
                      </TableHead>
                      <TableCell colSpan={referenced ? 5 : 4}>
                        <Difference line={between} />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <ul aria-label={label} className="divide-y rounded-lg border text-sm tabular-nums sm:hidden">
              {rows.map(({ machine, group, numbers, to }) => (
                <li key={machine.id} className="grid justify-items-start gap-1 px-3 py-2.5">
                  <span className="font-semibold">
                    <MachineLink machine={machine} />
                  </span>
                  <span>
                    <Link to={to} className="underline underline-offset-4">
                      {shotsText(group.counts.shots)}
                    </Link>
                    {numbers.duration && " · "}
                    {numbers.duration && <Median numbers={numbers} />}
                  </span>
                  {referenced && numbers.against && <Difference line={numbers.against} />}
                  {(numbers.yield || numbers.stopping) && (
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      {numbers.yield && <JudgedNumber judged={{ ...numbers.yield, text: `${numbers.yield.text} vs target` }} />}
                      {numbers.yield && numbers.stopping && <span aria-hidden="true">·</span>}
                      {numbers.stopping && <JudgedNumber judged={{ ...numbers.stopping, text: `${numbers.stopping.text} stopped at target` }} />}
                    </span>
                  )}
                  {numbers.leftOut.length > 0 && <span className="text-muted-foreground">{numbers.leftOut.join(" · ")}</span>}
                </li>
              ))}
              {between && (
                <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <span className="text-muted-foreground">Between Machines</span>
                  <Difference line={between} />
                </li>
              )}
            </ul>
          </>
        )}
        {data && <MoreMachines shown={rows.length} total={data.summary.total} what="These are" />}
      </CardContent>
    </Card>
  );
}

/** A Machine's name, linked to its page. */
function MachineLink({ machine }: { machine: { id: string; name: string } }) {
  return (
    <Link to={`/machines/${encodeURIComponent(machine.id)}`} className="underline-offset-4 hover:underline">
      {machine.name}
    </Link>
  );
}

/** A Machine's median duration, with the range the middle half fall in beside it: a dash where no Shot had one. */
function Median({ numbers }: { numbers: ReturnType<typeof machineNumbers> }) {
  if (!numbers.duration) return <OrNone>{undefined}</OrNone>;
  return (
    <>
      <span className="font-semibold">{numbers.duration.median}</span> <span className="text-muted-foreground">({numbers.duration.range})</span>
    </>
  );
}

/**
 * A Recipe's trend over the last 30 days, by day: its duration, its yield
 * against target or its grind setting, one at a time, a line for each
 * Machine that pulled it, with the band of its middle half, on the chart
 * the Shots list's trend uses. Charting duration, its Reference Shot's is a
 * dashed, labelled line across the chart (#547), and the chart is marked
 * where the Recipe's Bean Batch changed (#733). The days are the Recipe's
 * Location's, the last of them today. The number charted is kept in the
 * page's address as `trend`, duration as none, so the view survives a
 * reload and coming back from a Machine's Shots, which its name under the
 * chart opens in the Shots list. One read gives all three numbers, again
 * every 30 s, so another is charted at once. On a narrow screen the choice
 * of number scrolls within its own row.
 */
export function RecipeTrendCard({ recipe }: { recipe: Recipe }) {
  const { id } = recipe;
  const timeZone = recipe.location?.timeZone;
  const [params, setParams] = useSearchParams();
  const number = recipeTrend(params.get("trend"));
  const setNumber = (chosen: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (recipeTrend(chosen) === RECIPE_TRENDS[0]) next.delete("trend");
      else next.set("trend", recipeTrend(chosen));
      return next;
    });
  const load = useCallback(async () => {
    const days = trendDays(timeZone);
    // By Recipe too, which brings its Reference Shot's own numbers with each group; as many Machines as the chart draws lines of.
    const query = new URLSearchParams({ recipeId: id, ...days, groupBy: "recipe,machine", bucket: "day", numbers: RECIPE_TRENDS.join(","), limit: String(MOST_LINES) });
    // The same Shots grouped by Bean Batch too, which the trend's marks are read from (#733).
    const marksQuery = new URLSearchParams({ recipeId: id, ...days, groupBy: "beanBatch", bucket: "day", numbers: "duration" });
    const [summary, marks] = await Promise.all([api<ShotSummary<BucketedGroup>>("GET", `/shots/summary?${query}`), readBatchMarks(marksQuery.toString())]);
    return { days, summary, marks };
  }, [id, timeZone]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const groups = data?.summary.groups ?? [];
  const lines = groups.flatMap((group) => {
    const machine = machineOf(group);
    return machine ? [{ id: machine.id, name: machine.name, to: machineShotsPath(id, machine.id, TREND_PRESET, number), buckets: group.buckets ?? [] }] : [];
  });
  // The summary's reference is the one the page shows: one cleared here is gone from the chart at once.
  const reference = groups[0]?.reference?.id === recipe.referenceShot?.id ? groups[0]?.reference : undefined;
  const referenceDuration = number === "duration" ? reference?.numbers.duration : undefined;

  return (
    <Card role="region" aria-label="Trend">
      <CardHeader>
        <CardTitleWithInfo title="Trend">
          <p>
            How its Shots moved over the last {TREND_DAYS} days, by day, on each Machine that pulled it. The days are its Location's, in its time
            zone, the last of them today. Cleaning, calibration and Unfinished Shots are left out.
          </p>
          <p>
            A line is a Machine's median of each day, and the band around it the range the middle half of that day's Shots fall in. A day with no
            Shots, or none with a value, has no point: the line runs past it to the next. Charting duration, the dashed line is its Reference
            Shot's.
          </p>
          <p>Yield against target is the yield weighed less each Shot's own target. A grind setting is charted where it is a number, such as 8.8.</p>
          <p>
            A vertical line stands on the first day its Shots were pulled with another Bean Batch, labelled with that batch's Batch Code, or its
            roast date where it has none. The batches of these days are listed under the chart.
          </p>
          <p>A Machine's name under the chart opens its Shots of these days in the Shots list.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        <Tabs value={number} onValueChange={setNumber} className="gap-4">
          {/* Its own row, which scrolls where the three don't fit, so the page never does. */}
          <div className="overflow-x-auto">
            <TabsList aria-label="Number">
              {RECIPE_TRENDS.map((name) => (
                <TabsTrigger key={name} value={name}>
                  {NUMBER_NAMES[name]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value={number} className="grid gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>Could not read the trend: {error}</AlertDescription>
              </Alert>
            )}
            {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
            {data && lines.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled with it in the last {TREND_DAYS} days.</p>}
            {data && lines.length > 0 && (
              <TrendChart
                lines={lines}
                of="Machine"
                number={number}
                bucket="day"
                days={data.days}
                reference={reference && typeof referenceDuration === "number" ? { id: reference.id, value: referenceDuration } : undefined}
                marks={data.marks}
              />
            )}
            {data && <MoreMachines shown={lines.length} total={data.summary.total} what="The lines are of" />}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
