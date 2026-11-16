import { useCallback } from "react";
import { Link } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { SlotBadge } from "@/components/machines";
import { PeriodChoice, PeriodTabs, readSummaryGroups, useOverviewPeriod } from "@/components/overview";
import { OrNone } from "@/components/records";
import { SpecMark } from "@/components/spec-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { type Machine, type Recipe, api } from "@/lib/api";
import { type OverviewRow, PERIODS, type SpecLine, coveredText, overviewRows } from "@/lib/overview";
import { type Judged, machineNumbers, machineShotsPath } from "@/lib/recipe-numbers";
import { ratedShotsPath } from "@/lib/shot-list";
import { NUMBER_NAMES, shotsText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// How a Machine's Shots are landing (#545), on its page: a period's Shots by
// Recipe, each Recipe's numbers set against its Reference Shot's and marked
// where the server judged them out of spec (#543), as the Recipe's page sets
// each Machine's (#547). It is the Shot Summary of the Machine's Shots,
// grouped by Recipe and then Machine, over the Shots list's date preset of
// the period, so a Recipe's count opens exactly the Shots it counts.

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
 * A Machine's Shots by Recipe, today, yesterday or in the last 7 days, which
 * the page's address keeps as `period`, as the Overview's does: a row for
 * each Recipe pulled, those in its Location's Recipe Slots first, with how
 * many Shots, linked to them in the Shots list, with any Unfinished and
 * cleaning or calibration Shots beside the count; their median duration,
 * with the range the middle half fall in; the duration's difference from the
 * Recipe's Reference Shot's, or "No reference", linked to the Recipe's rated
 * Shots, to choose one from; and their yield against target and the share
 * stopped at target, each marked when out of spec. The Shots pulled with no
 * Recipe loaded are a row of their own, last. The days are each Shot's own
 * Location's, as the Shots list's are. On a narrow screen each Recipe is a
 * block of a few lines, so nothing scrolls sideways. It is loaded again
 * every 30 s.
 */
export function MachineShotsCard({ machine }: { machine: Machine }) {
  const [period, setPeriod] = useOverviewPeriod();
  const { id } = machine;
  const locationId = machine.location?.id;
  const load = useCallback(async () => {
    const { shots: preset } = PERIODS.find((each) => each.period === period)!;
    const [groups, recipes] = await Promise.all([
      // By Machine too, which has the server judge the Machine's Shots of each Recipe against its Reference Shot. Every page of it, as the Overview reads its own.
      readSummaryGroups({ machineId: id, period: preset, groupBy: "recipe,machine" }),
      // For the Recipe Slots at the Location it is at, which order its rows.
      locationId === undefined ? [] : api<{ recipes: Recipe[] }>("GET", `/locations/${encodeURIComponent(locationId)}/recipes`).then((read) => read.recipes),
    ]);
    return { period, groups, recipes };
  }, [id, locationId, period]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  // One period's numbers never stand under another's name while the next load is on its way.
  const data = polled.data?.period === period ? polled.data : undefined;
  const { error } = polled;
  const { pulled, shots: preset } = PERIODS.find((each) => each.period === period)!;
  const rows = data
    ? overviewRows(data.groups, data.recipes, locationId ?? "").flatMap((row) => {
        const group = row.cells.get(id);
        return group ? [{ row, group, numbers: machineNumbers(group), to: machineShotsPath(row.recipe?.id ?? "none", id, preset) }] : [];
      })
    : [];
  const label = `Shots by Recipe ${pulled}`;

  return (
    <PeriodTabs period={period} onPeriod={setPeriod}>
      <Card role="region" aria-label="Shots">
        <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <CardTitleWithInfo title="Shots">
              <p>
                How its Shots went, by Recipe, today, yesterday or in the last 7 days: each Shot's own Location's days, in its time zone. Cleaning
                and calibration Shots, and Unfinished Shots, in which nothing poured, are counted beside the Shots and left out of the numbers.
              </p>
              <p>
                Duration is the median, with the range the middle half of the Shots fall in, and beside it how far that is from the Recipe's
                Reference Shot's: out of spec more than 10% from it. Yield against target is the median of the yield weighed less each Shot's own
                target, out of spec more than 5% from target. Stopped at target is the share, of the Shots that recorded what stopped them, that
                Decaid stopped at their target weight or volume: out of spec under 90%. Fewer than 3 Shots are not judged.
              </p>
              <p>A Recipe's count opens its Shots in the Shots list. The numbers are read again every 30 seconds.</p>
            </CardTitleWithInfo>
            {data && <p className="text-sm text-muted-foreground tabular-nums">{coveredText(data.groups, period)}</p>}
          </div>
          <PeriodChoice />
        </CardHeader>
        <CardContent>
          <TabsContent value={period} className="grid grid-cols-1 gap-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>Could not read the numbers: {error}</AlertDescription>
              </Alert>
            )}
            {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
            {data && rows.length === 0 && <p className="text-sm text-muted-foreground">It pulled no Shots {pulled}.</p>}
            {data && rows.length > 0 && (
              <>
                <div className="min-w-0 rounded-lg border tabular-nums max-sm:hidden">
                  <Table aria-label={label}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recipe</TableHead>
                        <TableHead>Shots</TableHead>
                        <TableHead>{NUMBER_NAMES.duration}</TableHead>
                        <TableHead>vs reference</TableHead>
                        {/* The long headings wrap, so six columns fit the card. */}
                        <TableHead className="h-auto py-2 whitespace-normal">{NUMBER_NAMES.yieldAgainstTarget}</TableHead>
                        <TableHead className="h-auto py-2 whitespace-normal">{NUMBER_NAMES.stoppedAtTarget}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(({ row, group, numbers, to }) => (
                        <TableRow key={row.recipe?.id ?? "none"}>
                          <TableHead scope="row" className="h-auto py-2 font-medium whitespace-normal text-foreground">
                            <RecipeName row={row} />
                          </TableHead>
                          <TableCell className="whitespace-normal">
                            <Link to={to} className="underline underline-offset-4" aria-label={`${shotsText(group.counts.shots)} of ${recipeText(row)}`}>
                              {group.counts.shots}
                            </Link>
                            {numbers.leftOut.length > 0 && <span className="text-muted-foreground"> · {numbers.leftOut.join(" · ")}</span>}
                          </TableCell>
                          <TableCell>
                            <Median numbers={numbers} />
                          </TableCell>
                          <TableCell>
                            <AgainstReference row={row} against={numbers.against} short />
                          </TableCell>
                          <TableCell>
                            <JudgedNumber judged={numbers.yield} />
                          </TableCell>
                          <TableCell>
                            <JudgedNumber judged={numbers.stopping} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <ul aria-label={label} className="divide-y rounded-lg border text-sm tabular-nums sm:hidden">
                  {rows.map(({ row, group, numbers, to }) => (
                    <li key={row.recipe?.id ?? "none"} className="grid justify-items-start gap-1 px-3 py-2.5">
                      <span className="font-semibold">
                        <RecipeName row={row} />
                      </span>
                      <span>
                        <Link to={to} className="underline underline-offset-4">
                          {shotsText(group.counts.shots)}
                        </Link>
                        {numbers.duration && " · "}
                        {numbers.duration && <Median numbers={numbers} />}
                      </span>
                      {row.recipe && <AgainstReference row={row} against={numbers.against} />}
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
                </ul>
              </>
            )}
          </TabsContent>
        </CardContent>
      </Card>
    </PeriodTabs>
  );
}

/** What a row's Recipe is called: its name, or that none was loaded. */
function recipeText(row: OverviewRow): string {
  return row.recipe ? (row.recipe.name ?? "Unnamed Recipe") : "no Recipe";
}

/** A row's Recipe, linked to its page, with its Recipe Slot at the Machine's Location before it; or that none was loaded. */
function RecipeName({ row }: { row: OverviewRow }) {
  if (!row.recipe) return <span className="font-normal text-muted-foreground">No Recipe loaded</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {row.slot !== null && <SlotBadge slot={row.slot} />}
      <Link to={`/library/recipes/${encodeURIComponent(row.recipe.id)}`} className="wrap-anywhere underline-offset-4 hover:underline">
        {row.recipe.name ?? "Unnamed Recipe"}
      </Link>
    </span>
  );
}

/**
 * How far a row's median duration is from its Recipe's Reference Shot's,
 * marked when out of spec; "No reference" for a Recipe with none, linked to
 * its rated Shots, to choose one from; and a dash for the Shots pulled with
 * no Recipe, or where the server set nothing against a reference, as the
 * previous release's answer during a deploy doesn't (ADR-0025).
 */
function AgainstReference({ row, against, short = false }: { row: OverviewRow; against: SpecLine | undefined; short?: boolean }) {
  if (against) return <Difference line={against} short={short} />;
  if (!row.recipe || row.reference) return <OrNone>{undefined}</OrNone>;
  return (
    <Link to={ratedShotsPath(row.recipe.id)} className="text-muted-foreground underline decoration-dotted underline-offset-4">
      No reference
    </Link>
  );
}

/** A row's median duration, with the range the middle half fall in beside it: a dash where no Shot had one. */
function Median({ numbers }: { numbers: ReturnType<typeof machineNumbers> }) {
  if (!numbers.duration) return <OrNone>{undefined}</OrNone>;
  return (
    <>
      <span className="font-semibold">{numbers.duration.median}</span> <span className="text-muted-foreground">({numbers.duration.range})</span>
    </>
  );
}
