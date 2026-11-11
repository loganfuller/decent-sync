import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { OrNone } from "@/components/records";
import { MOST_LINES, TrendChart } from "@/components/shot-trend";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type BucketedGroup, type Recipe, type ShotSummary, type SummaryGroup, type SummaryNumber, api } from "@/lib/api";
import { RECIPE_TRENDS, TREND_DAYS, machineShotsPath, recipeDays, recipeTrend } from "@/lib/recipe-numbers";
import { type MedianText, NUMBER_NAMES, durationText, shareText, shotsText, signedText, yieldAgainstTargetText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// How a Recipe is pulling (#474), on its page: today's numbers on each
// Machine, with its Reference Shot's beside them, so the Machine that is
// off stands out, and a 30-day trend with a line for each Machine, so a
// coffee ageing or a grinder drifting shows. Both are the Shot Summary of
// the Recipe's Shots, grouped by Machine, and each Machine's open its Shots
// in the Shots list. A day is the Recipe's Location's own, and the Shots of
// it are those the Shots list's date filters find, each by its own
// Location's time zone.

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

/**
 * Today's numbers of a Recipe on each Machine that pulled it: how many
 * Shots, with any Unfinished and cleaning or calibration Shots beside the
 * count, their median duration and yield against target, each with the
 * range the middle half fall in, and the share stopped on weight. Under
 * them are the duration and yield against target of the Recipe's Reference
 * Shot, where it has one. Today is the Recipe's Location's day, and a
 * Machine's count opens its Shots of it in the Shots list. It is loaded
 * again every 30 s.
 */
export function RecipeTodayCard({ recipe }: { recipe: Recipe }) {
  const { id } = recipe;
  const timeZone = recipe.location?.timeZone;
  const load = useCallback(async () => {
    const { today } = recipeDays(timeZone);
    // By Recipe too, which brings its Reference Shot's own numbers with each group.
    const query = new URLSearchParams({ recipeId: id, from: today, to: today, groupBy: "recipe,machine", limit: String(PAGE) });
    return { today, summary: await api<ShotSummary>("GET", `/shots/summary?${query}`) };
  }, [id, timeZone]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const groups = data?.summary.groups ?? [];
  // The summary's reference is the one the page shows: one cleared here is gone from under the numbers at once.
  const reference = groups[0]?.reference?.id === recipe.referenceShot?.id ? groups[0]?.reference : undefined;

  return (
    <Card role="region" aria-label="Today">
      <CardHeader>
        <CardTitleWithInfo title="Today">
          <p>
            How its Shots went today on each Machine that pulled it, today being its Location's day, in its time zone. Cleaning and calibration
            Shots, and Unfinished Shots, in which nothing poured, are counted beside the Shots and left out of the numbers.
          </p>
          <p>
            Duration and yield against target are medians, with the range the middle half of the Shots fall in. Yield against target is the yield
            weighed less each Shot's own target. Stopped on weight is the share, of the Shots that recorded what stopped them, that stopped at
            their target weight.
          </p>
          <p>Under them are its Reference Shot's own duration and yield against target, where it has one, to read each Machine's against.</p>
          <p>A Machine's count opens its Shots in the Shots list. The numbers are read again every 30 seconds.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read today's numbers: {error}</AlertDescription>
          </Alert>
        )}
        {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
        {data && groups.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled with it today.</p>}
        {data && groups.length > 0 && (
          <div className="min-w-0 rounded-lg border">
            <Table aria-label="Today by Machine">
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead>Shots</TableHead>
                  <TableHead>{NUMBER_NAMES.duration}</TableHead>
                  <TableHead>{NUMBER_NAMES.yieldAgainstTarget}</TableHead>
                  <TableHead>{NUMBER_NAMES.stoppedOnWeight}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => {
                  const machine = machineOf(group);
                  return machine && <MachineRow key={machine.id} machine={machine} group={group} to={machineShotsPath(id, machine.id, { from: data.today, to: data.today })} />;
                })}
              </TableBody>
              {reference && (
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell>
                      <Link to={`/shots/${encodeURIComponent(reference.id)}`} className="underline-offset-4 hover:underline">
                        Reference Shot
                      </Link>
                    </TableCell>
                    <TableCell />
                    <TableCell className="tabular-nums">
                      <OrNone>{typeof reference.numbers.duration === "number" ? `${reference.numbers.duration.toFixed(1)} s` : undefined}</OrNone>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <OrNone>{typeof reference.numbers.yieldAgainstTarget === "number" ? `${signedText(reference.numbers.yieldAgainstTarget)} g` : undefined}</OrNone>
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        )}
        {data && <MoreMachines shown={groups.length} total={data.summary.total} what="These are" />}
      </CardContent>
    </Card>
  );
}

/** A Machine's row: the Machine, its count of Shots, which opens them in the Shots list, with those left out of the numbers beside it, and the numbers. */
function MachineRow({ machine, group, to }: { machine: { id: string; name: string }; group: SummaryGroup; to: string }) {
  const { counts, numbers } = group;
  const leftOut = [
    ...(counts.unfinished > 0 ? [`${counts.unfinished} unfinished`] : []),
    ...(counts.cleaningAndCalibration > 0 ? [`${counts.cleaningAndCalibration} cleaning or calibration`] : []),
  ];
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link to={`/machines/${encodeURIComponent(machine.id)}`} className="underline-offset-4 hover:underline">
          {machine.name}
        </Link>
      </TableCell>
      <TableCell className="min-w-28 whitespace-normal">
        <Link to={to} className="underline underline-offset-4">
          {shotsText(counts.shots)}
        </Link>
        {leftOut.length > 0 && <span className="text-muted-foreground"> · {leftOut.join(" · ")}</span>}
      </TableCell>
      <TableCell className="tabular-nums">
        <Median number={numbers.duration} text={durationText} />
      </TableCell>
      <TableCell className="tabular-nums">
        <Median number={numbers.yieldAgainstTarget} text={yieldAgainstTargetText} />
      </TableCell>
      <TableCell className="tabular-nums">
        <OrNone>{numbers.stoppedOnWeight && shareText(numbers.stoppedOnWeight.share)}</OrNone>
      </TableCell>
    </TableRow>
  );
}

/** A number as its median, with the range the middle half fall in beside it: a dash where no Shot had one. */
function Median({ number, text }: { number: SummaryNumber | undefined; text(number: SummaryNumber): MedianText | undefined }) {
  const read = number && text(number);
  if (!read) return <OrNone>{undefined}</OrNone>;
  return (
    <>
      {read.median} <span className="text-muted-foreground">({read.range})</span>
    </>
  );
}

/**
 * A Recipe's trend over the last 30 days, by day: its duration, its yield
 * against target or its grind setting, one at a time, a line for each
 * Machine that pulled it, with the band of its middle half, on the chart
 * the Shots list's trend uses. The days are the Recipe's Location's, the
 * last of them today. The number charted is kept in the page's address as
 * `trend`, duration as none, so the view survives a reload and coming back
 * from a Machine's Shots, which its name under the chart opens in the
 * Shots list. One read gives all three numbers, again every 30 s, so
 * another is charted at once.
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
    const { trend: days } = recipeDays(timeZone);
    // As many Machines as the chart draws lines of.
    const query = new URLSearchParams({ recipeId: id, ...days, groupBy: "machine", bucket: "day", numbers: RECIPE_TRENDS.join(","), limit: String(MOST_LINES) });
    return { days, summary: await api<ShotSummary<BucketedGroup>>("GET", `/shots/summary?${query}`) };
  }, [id, timeZone]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const lines = (data?.summary.groups ?? []).flatMap((group) => {
    const machine = machineOf(group);
    return machine && data ? [{ id: machine.id, name: machine.name, to: machineShotsPath(id, machine.id, data.days, number), buckets: group.buckets ?? [] }] : [];
  });

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
            Shots, or none with a value, has no point: the line runs past it to the next.
          </p>
          <p>Yield against target is the yield weighed less each Shot's own target. A grind setting is charted where it is a number, such as 8.8.</p>
          <p>A Machine's name under the chart opens its Shots of these days in the Shots list.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        <Tabs value={number} onValueChange={setNumber} className="gap-4">
          <TabsList aria-label="Number">
            {RECIPE_TRENDS.map((name) => (
              <TabsTrigger key={name} value={name}>
                {NUMBER_NAMES[name]}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={number} className="grid gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>Could not read the trend: {error}</AlertDescription>
              </Alert>
            )}
            {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
            {data && lines.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled with it in the last {TREND_DAYS} days.</p>}
            {data && lines.length > 0 && <TrendChart lines={lines} of="Machine" number={number} bucket="day" days={data.days} />}
            {data && <MoreMachines shown={lines.length} total={data.summary.total} what="The lines are of" />}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
