import { type ReactNode, useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { LoadedRecipeLink } from "@/components/loaded-recipes";
import { StatusBadge, describeMachineState, lastShotText } from "@/components/machines";
import { usedBatchText } from "@/components/recipes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Location, type Machine, type Recipe, type ShotSummary, type SummaryGroup, api } from "@/lib/api";
import { type OverviewColumn, type OverviewRow, PERIODS, type Period, cellFilters, daysSinceRoast, overviewColumns, overviewRows, periodDays, periodOf } from "@/lib/overview";
import { durationText, referenceDurationText, shareText, shotsText, yieldAgainstTargetText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// The Overview (#471; GLOSSARY.md): a block for a Location, which the home
// page shows for every Location and each Location's page for its own. A
// block's columns are its Machines, each with its status as the Machines
// page gives it, and its rows the Recipes pulled there in the period, a
// cell giving what a Shot Summary grouped by Recipe and Machine gives of a
// Machine's Shots of a Recipe, with the duration of the Recipe's Reference
// Shot beside theirs (#473).

/** The most groups one read of a summary gives (`readPage` in the server's pagination.ts). */
const PAGE = 100;

/**
 * The Overview's period, which the page's address keeps as `period`, so a
 * page reloaded, shared or come back to from a cell's Shots shows the same:
 * today where it names none.
 */
export function useOverviewPeriod(): [Period, (period: Period) => void] {
  const [params, setParams] = useSearchParams();
  const setPeriod = (period: Period) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (period === "today") next.delete("period");
      else next.set("period", period);
      return next;
    });
  return [periodOf(params.get("period")), setPeriod];
}

/** The tabs a period is chosen with: `PeriodChoice` within them offers the periods, and a `TabsContent` of the period holds what it shows. */
export function PeriodTabs({ period, onPeriod, className, children }: { period: Period; onPeriod(period: Period): void; className?: string; children: ReactNode }) {
  return (
    <Tabs value={period} onValueChange={(chosen) => onPeriod(periodOf(chosen))} className={className}>
      {children}
    </Tabs>
  );
}

/** The choice of period: today, yesterday or the last 7 days. */
export function PeriodChoice() {
  return (
    <TabsList aria-label="Period">
      {PERIODS.map(({ period, label }) => (
        <TabsTrigger key={period} value={period}>
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** What explains a block, in the tooltip beside the Overview's title. */
export function OverviewAbout() {
  return (
    <>
      <p>
        Each Location's Machines, and the Recipes pulled there today, yesterday or in the last 7 days, which are that Location's own days, in its
        time zone.
      </p>
      <p>
        A column is a Machine that is there now, or that pulled Shots there in the period, with its status, Machine State, Loaded Recipe and last
        Shot. A row is a Recipe, with its Bean Batch now: those in the Location's Recipe Slots first, then the others, then the Shots pulled with no
        Recipe loaded.
      </p>
      <p>
        A cell counts a Machine's Shots of a Recipe, and gives their median duration, their median yield against each Shot's own target, and the
        share that stopped on weight, of those that recorded what stopped them. Cleaning and calibration Shots, and Unfinished Shots, in which
        nothing poured, are counted beside them and left out of the numbers.
      </p>
      <p>
        Where the Recipe has a Reference Shot, the Shot chosen to show how its Shots should go, its duration is beside the median, so a Machine
        running fast or slow against it shows.
      </p>
      <p>A cell opens its Shots in the Shots list. The status is read again every 5 seconds, and the numbers every 30.</p>
    </>
  );
}

/** What a block's numbers are read from: a period's days at its Location, the Recipes its rows name, and the summary's groups. */
interface Numbers {
  from: string;
  to: string;
  today: string;
  recipes: Recipe[];
  groups: SummaryGroup[];
}

/**
 * Reads a block's numbers: the Shot Summary of the Location's Shots in the
 * period's days there, as they are now, grouped by Recipe and then Machine,
 * every page of it; the Location's Recipes, for their Recipe Slots and Bean
 * Batches; and any other Recipe the groups name, as another Location's,
 * which a corrected Location History brings.
 */
async function readNumbers(location: Pick<Location, "id" | "timeZone">, period: Period): Promise<Numbers> {
  const days = periodDays(period, location.timeZone);
  const page = async (offset: number) => {
    const query = new URLSearchParams({ locationId: location.id, from: days.from, to: days.to, groupBy: "recipe,machine", limit: String(PAGE), offset: String(offset) });
    return api<ShotSummary>("GET", `/shots/summary?${query}`);
  };
  const [{ recipes }, first] = await Promise.all([api<{ recipes: Recipe[] }>("GET", `/locations/${encodeURIComponent(location.id)}/recipes`), page(0)]);
  const groups = [...first.groups];
  while (groups.length < first.total) {
    const next = await page(groups.length);
    if (next.groups.length === 0) break;
    groups.push(...next.groups);
  }
  const elsewhere = new Set(groups.flatMap(({ by }) => (by.recipe && !recipes.some((recipe) => recipe.id === by.recipe!.id) ? [by.recipe.id] : [])));
  const others = await Promise.all([...elsewhere].map(async (id) => (await api<{ recipe: Recipe }>("GET", `/recipes/${encodeURIComponent(id)}`)).recipe));
  return { ...days, recipes: [...recipes, ...others], groups };
}

/**
 * A Location's block of the Overview for a period: `machines` is every
 * Machine, as the Machines page reads them, which the page showing the
 * block reads again every 5 s, and the block reads its numbers every 30 s,
 * and anew when the period changes. `title` heads it, with `action` beside
 * it, and `panel` makes its content the period's tab panel, for a block
 * holding its own `PeriodChoice`.
 */
export function OverviewBlock({
  location,
  machines,
  period,
  label,
  title,
  action,
  panel = false,
}: {
  location: Location;
  machines: Machine[];
  period: Period;
  /** What names the block to a screen reader. */
  label: string;
  title: ReactNode;
  action?: ReactNode;
  panel?: boolean;
}) {
  // Keyed by the period, so one period's numbers never stand under another's name while the next load is on its way.
  const numbers = <OverviewNumbers key={period} location={location} machines={machines} period={period} />;
  return (
    <Card role="region" aria-label={label}>
      <CardHeader>
        {title}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{panel ? <TabsContent value={period}>{numbers}</TabsContent> : numbers}</CardContent>
    </Card>
  );
}

/** A Location's block on its own page, titled Overview, with its own choice of period. */
export function LocationOverviewCard({ location, machines }: { location: Location; machines: Machine[] }) {
  const [period, setPeriod] = useOverviewPeriod();
  return (
    <PeriodTabs period={period} onPeriod={setPeriod}>
      <OverviewBlock
        location={location}
        machines={machines}
        period={period}
        label="Overview"
        title={
          <CardTitleWithInfo title="Overview">
            <OverviewAbout />
          </CardTitleWithInfo>
        }
        action={<PeriodChoice />}
        panel
      />
    </PeriodTabs>
  );
}

/** A Location's block on the home page, titled by the Location, which links to its page. */
export function HomeOverviewBlock({ location, machines, period }: { location: Location; machines: Machine[]; period: Period }) {
  return (
    <OverviewBlock
      location={location}
      machines={machines}
      period={period}
      label={location.name}
      title={
        <CardTitle>
          <h2>
            <Link to={`/locations/${encodeURIComponent(location.id)}`} className="underline-offset-4 hover:underline">
              {location.name}
            </Link>
          </h2>
        </CardTitle>
      }
    />
  );
}

/** A block's table: a column for each Machine and a row for each Recipe pulled, or that nothing was. */
function OverviewNumbers({ location, machines, period }: { location: Location; machines: Machine[]; period: Period }) {
  const { id, timeZone } = location;
  const load = useCallback(() => readNumbers({ id, timeZone }, period), [id, timeZone, period]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const columns = overviewColumns(data?.groups ?? [], machines, id);
  const rows = data ? overviewRows(data.groups, data.recipes, id) : [];
  const pulled = PERIODS.find((each) => each.period === period)!.pulled;

  return (
    <div className="grid grid-cols-1 gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not read the numbers: {error}</AlertDescription>
        </Alert>
      )}
      {columns.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Machine is here.</p>
      ) : (
        <div className="min-w-0 rounded-lg border">
          <Table aria-label={`Recipes by Machine at ${location.name}`}>
            {/* With no row under it, the heading row is the table's last, and has no line under it. */}
            <TableHeader className={rows.length === 0 ? "[&_tr]:border-b-0" : undefined}>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-auto w-72 py-2 align-top">Recipe</TableHead>
                {columns.map((column) => (
                  <TableHead key={column.id} scope="col" className="h-auto min-w-52 py-2 align-top font-normal whitespace-normal">
                    <MachineHeading column={column} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data &&
                rows.map((row) => (
                  <TableRow key={row.recipe?.id ?? "none"} className="hover:bg-transparent">
                    <TableHead scope="row" className="h-auto min-w-44 py-2 align-top whitespace-normal">
                      <RecipeHeading row={row} locationId={id} today={data.today} />
                    </TableHead>
                    {columns.map((column) => {
                      const group = row.cells.get(column.id);
                      return (
                        <TableCell key={column.id} className="align-top whitespace-normal">
                          {group && <ShotsCell group={group} to={`/shots?${cellFilters(id, column.id, row.recipe?.id ?? null, data)}`} />}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {data && rows.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled here {pulled}.</p>}
    </div>
  );
}

/** A column's heading: the Machine, with its status, Machine State, Loaded Recipe and last Shot, as the Machines page gives them, and where it is now if not here. */
function MachineHeading({ column }: { column: OverviewColumn }) {
  const { machine } = column;
  return (
    <div className="grid gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Link to={`/machines/${encodeURIComponent(column.id)}`} className="font-medium text-foreground underline-offset-4 hover:underline">
          {column.name}
        </Link>
        {machine && <StatusBadge machine={machine} />}
      </span>
      {machine && (
        <>
          <span>{machine.machineState ? describeMachineState(machine.machineState) : <span className="text-muted-foreground">State not reported</span>}</span>
          <span>{machine.loadedRecipe ? <LoadedRecipeLink loaded={machine.loadedRecipe} /> : <span className="text-muted-foreground">No Recipe loaded</span>}</span>
          <span className="text-muted-foreground">Last Shot: {lastShotText(machine)}</span>
          {!column.here && <span className="text-muted-foreground">Now at {machine.location?.name ?? "no Location"}</span>}
        </>
      )}
    </div>
  );
}

/** A row's heading: the Recipe, with its Recipe Slot here, or the Location it belongs to, and its Bean Batch now with its days since roast; or that the Shots had none. */
function RecipeHeading({ row, locationId, today }: { row: OverviewRow; locationId: string; today: string }) {
  const { recipe, details } = row;
  if (!recipe) return <span className="font-normal text-muted-foreground">No Recipe loaded</span>;
  const elsewhere = recipe.location && recipe.location.id !== locationId ? recipe.location.name : undefined;
  const batch = details && usedBatchText(details);
  const days = daysSinceRoast(details?.uses.beanBatch?.roastDate ?? null, today);
  return (
    <div className="grid gap-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="underline-offset-4 hover:underline">
          {recipe.name ?? "Unnamed Recipe"}
        </Link>
        {details?.archived ? (
          <Badge variant="secondary">Archived</Badge>
        ) : elsewhere !== undefined ? (
          <Badge variant="outline">{elsewhere}</Badge>
        ) : row.slot === null ? (
          <Badge variant="outline">No slot</Badge>
        ) : (
          <Badge variant="outline">Slot {row.slot}</Badge>
        )}
      </span>
      {batch !== undefined && (
        <span className="font-normal text-muted-foreground">
          {batch}
          {days !== undefined && ` · ${days} ${days === 1 ? "day" : "days"} since roast`}
        </span>
      )}
    </div>
  );
}

/**
 * A cell: how many Shots its numbers cover, with the Unfinished Shots and
 * the cleaning and calibration Shots left out of them beside it, and their
 * median duration, median yield against target and the share stopped on
 * weight, each where the Shots give one. Beside the median duration is the
 * duration of the Recipe's Reference Shot, where it has one. It opens the
 * Shots in the Shots list.
 */
function ShotsCell({ group, to }: { group: SummaryGroup; to: string }) {
  const { counts, numbers } = group;
  const leftOut = [
    ...(counts.unfinished > 0 ? [`${counts.unfinished} unfinished`] : []),
    ...(counts.cleaningAndCalibration > 0 ? [`${counts.cleaningAndCalibration} cleaning or calibration`] : []),
  ];
  const median = numbers.duration && durationText(numbers.duration)?.median;
  const duration = median && referenceDurationText(median, group.reference);
  const against = numbers.yieldAgainstTarget && yieldAgainstTargetText(numbers.yieldAgainstTarget)?.median;
  const onWeight = numbers.stoppedOnWeight && shareText(numbers.stoppedOnWeight.share);
  const medians = [...(duration ? [duration] : []), ...(against ? [`${against} vs target`] : []), ...(onWeight ? [`${onWeight} on weight`] : [])];
  return (
    <Link to={to} className="-m-1 grid gap-0.5 rounded-md p-1 hover:bg-muted">
      <span>
        <span className="font-semibold">{shotsText(counts.shots)}</span>
        {leftOut.length > 0 && <span className="text-muted-foreground"> · {leftOut.join(" · ")}</span>}
      </span>
      {medians.length > 0 && <span className="text-muted-foreground tabular-nums">{medians.join(" · ")}</span>}
    </Link>
  );
}
