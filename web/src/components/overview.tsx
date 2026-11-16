import { type CSSProperties, type ReactNode, useCallback } from "react";
import { Link, useSearchParams } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { CaptureOnlyBadge } from "@/components/machine-sharing";
import { describeMachineState } from "@/components/machines";
import { RelativeTime } from "@/components/relative-time";
import { SpecMark } from "@/components/spec-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Location, type Machine, type Recipe, type ShotSummary, type SummaryGroup, api } from "@/lib/api";
import {
  type OverviewColumn,
  type OverviewRow,
  PERIODS,
  type Period,
  type SpecLine,
  betweenMachinesLine,
  cellFilters,
  cellLines,
  coveredText,
  daysSinceRoast,
  lastShotMarks,
  offlineKind,
  overviewColumns,
  overviewRows,
  periodDays,
  periodOf,
} from "@/lib/overview";
import { ratedShotsPath } from "@/lib/shot-list";
import { durationText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";
import { cn } from "@/lib/utils";

// The Overview (#471, #543; GLOSSARY.md): a block for a Location, which the
// home page shows for every Location and each Location's page for its own.
// A block has a status card for each of its Machines, and a table whose
// columns are those Machines and whose rows are the Recipes pulled there in
// the period: a cell gives what a Shot Summary grouped by Recipe and Machine
// gives of a Machine's Shots of a Recipe, and marks what the server judged
// out of spec (GLOSSARY.md), and a last column how far apart the Recipe's
// Machines are.

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
        time zone. What is out of spec is marked with a triangle.
      </p>
      <p>
        A card is a Machine that is there now, or that pulled Shots there in the period: whether it is online, what it is doing, its last Shot and
        its Loaded Recipe. An offline Machine is marked, unless it went offline asleep.
      </p>
      <p>
        A row is a Recipe, with its Reference Shot's duration, the Shot chosen to show how its Shots should go, and its Bean Batch's days since
        roast: those in the Location's Recipe Slots first, then the others, then the Shots pulled with no Recipe loaded.
      </p>
      <p>
        A cell counts a Machine's Shots of a Recipe and gives their median duration, with how far that is from the Reference Shot's: out of spec
        more than 10% from it. Their yield shows only when out of spec, the median more than 5% from each Shot's own target, and their stopping
        only when under 90% of them stopped at target: Decaid stopping the Shot at its target weight or, with no scale, its target volume. Fewer
        than 3 Shots are not judged, and show what is beyond a margin unmarked. Cleaning and calibration Shots, and Unfinished Shots, in which
        nothing poured, are counted beside them and left out of the numbers.
      </p>
      <p>
        Between Machines is how far apart the fastest and slowest Machines' median durations of a Recipe are: out of spec more than 10% of the
        slower one's, counting Machines with at least 3 Shots.
      </p>
      <p>A cell opens its Shots in the Shots list. The status is read again every 5 seconds, and the numbers every 30.</p>
    </>
  );
}

/** What a block's numbers are read from: the period they are of, its days at the Location, the Recipes its rows name, and the summary's groups. */
interface Numbers {
  period: Period;
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
  return { period, ...days, recipes: [...recipes, ...others], groups };
}

/**
 * A Location's block of the Overview for a period: `machines` is every
 * Machine, as the Machines page reads them, which the page showing the
 * block reads again every 5 s, and the block reads its numbers every 30 s,
 * and anew when the period changes. `title` heads it, with how many Shots
 * the period's numbers cover beside it, or, with no `action`, across from
 * it; `action` is what else its heading holds, as a block's own
 * `PeriodChoice`, and `panel` makes its content the period's tab panel.
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
  const { id, timeZone } = location;
  const load = useCallback(() => readNumbers({ id, timeZone }, period), [id, timeZone, period]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  // One period's numbers never stand under another's name while the next load is on its way.
  const data = polled.data?.period === period ? polled.data : undefined;
  const covered = data && (
    <p className="text-sm text-muted-foreground tabular-nums">
      {coveredText(data.groups, period)}
    </p>
  );
  const numbers = <OverviewNumbers location={location} machines={machines} period={period} data={data} error={polled.error} />;
  return (
    <Card role="region" aria-label={label}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {title}
          {action && covered}
        </div>
        {action ?? covered}
      </CardHeader>
      <CardContent>{panel ? <TabsContent value={period}>{numbers}</TabsContent> : numbers}</CardContent>
    </Card>
  );
}

/** A Location's block on its own page, titled Overview, with its own choice of period in its heading. */
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

/**
 * How a block's table shares its width, by how many Machines it has. Two
 * fit a phone (390 px), so the table is as wide as the block, the Recipe
 * column a share of it. With three or more it has a least width, 6.5rem for
 * each Machine beside its other columns: the Recipe's, 8rem on a phone and
 * 14rem from 640 px, where Between Machines takes 9rem more. Where the
 * block is narrower than that, on a phone, and at any width with enough
 * Machines, as eight at 1280 px, the table scrolls in its own container
 * under the Recipe column, which stays in place. That column is of a fixed
 * width then, however many Machines there are, as a share of a table that
 * grows with them would come to cover the cells it scrolls over.
 */
function tableWidths(machines: number): { table: string; recipe: string } {
  return machines > 2
    ? { table: "min-w-[calc(8rem+var(--machines)*6.5rem)] sm:min-w-[calc(23rem+var(--machines)*6.5rem)]", recipe: "w-32 sm:w-56" }
    : { table: "", recipe: "w-[36%] sm:w-[30%]" };
}

/** What stays in place as a wide table scrolls sideways: the Recipe column, over the cells. */
const STICKY = "sticky left-0 z-10";

/** A block's status cards and its table: a card and a column for each Machine and a row for each Recipe pulled, or that nothing was. */
function OverviewNumbers({ location, machines, period, data, error }: { location: Location; machines: Machine[]; period: Period; data: Numbers | undefined; error: string | undefined }) {
  const { id } = location;
  const columns = overviewColumns(data?.groups ?? [], machines, id);
  const rows = data ? overviewRows(data.groups, data.recipes, id) : [];
  const pulled = PERIODS.find((each) => each.period === period)!.pulled;
  const widths = tableWidths(columns.length);

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
        <>
          <ul aria-label={`Machines at ${location.name}`} className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {columns.map((column) => (
              <MachineCard key={column.id} column={column} timeZone={location.timeZone} />
            ))}
          </ul>
          {rows.length > 0 && data && (
            <div className="min-w-0 overflow-hidden rounded-lg border">
              {/* Its columns share the width left by the Recipe's, so two Machines' cells are as wide as each other at any width. */}
              <Table aria-label={`Recipes by Machine at ${location.name}`} className={cn("table-fixed", widths.table)} style={{ "--machines": columns.length } as CSSProperties}>
                <TableHeader>
                  <TableRow className="bg-muted hover:bg-muted">
                    <TableHead scope="col" className={cn(STICKY, widths.recipe, "h-auto bg-muted py-2 text-[13px] text-muted-foreground sm:px-3")}>
                      Recipe
                    </TableHead>
                    {columns.map((column) => (
                      <TableHead key={column.id} scope="col" className="h-auto border-l py-2 align-top text-[13px] wrap-anywhere whitespace-normal text-muted-foreground sm:px-3">
                        {column.name}
                      </TableHead>
                    ))}
                    <TableHead scope="col" className="hidden h-auto w-36 border-l px-3 py-2 align-top text-[13px] whitespace-normal text-muted-foreground sm:table-cell">
                      Between Machines
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const between = betweenMachinesLine(row.betweenMachines);
                    return (
                      <TableRow key={row.recipe?.id ?? "none"} className="hover:bg-transparent">
                        <TableHead scope="row" className={cn(STICKY, "h-auto bg-card px-2 py-3 align-top font-normal whitespace-normal sm:px-3")}>
                          <RecipeHeading row={row} locationId={id} today={data.today} between={between} />
                        </TableHead>
                        {columns.map((column) => {
                          const group = row.cells.get(column.id);
                          return (
                            <TableCell key={column.id} className="border-l px-2 py-3 align-top whitespace-normal sm:px-3">
                              {group && <ShotsCell group={group} to={`/shots?${cellFilters(id, column.id, row.recipe?.id ?? null, data.period)}`} />}
                            </TableCell>
                          );
                        })}
                        <TableCell className="hidden border-l px-3 py-3 align-top whitespace-normal tabular-nums sm:table-cell">{between && <Line line={between} />}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {data && rows.length === 0 && <p className="text-sm text-muted-foreground">No Shots were pulled here {pulled}.</p>}
    </div>
  );
}

/** A line that is marked, being out of spec, or muted otherwise: in full, or, with `short`, as a narrow screen has room for. */
function Line({ line, short = false }: { line: SpecLine; short?: boolean }) {
  // Both wordings are in the page, each shown at its own widths, so the words a narrow screen drops are still read out there.
  const words = short ? (
    <>
      <span aria-hidden="true" className="sm:hidden">
        {line.short}
      </span>
      <span className="max-sm:sr-only">{line.text}</span>
    </>
  ) : (
    line.text
  );
  return line.marked ? <SpecMark>{words}</SpecMark> : <span className="text-muted-foreground">{words}</span>;
}

/**
 * A Machine's status card: its name, linked to its page; whether it is
 * online, and what it is doing, or, offline, when it was last seen; its
 * last Shot, as how long ago, with its Recipe and duration, linked to the
 * Shot, and a mark for whatever of it is out of spec; its Loaded Recipe
 * with its Recipe Slot; that it is capture-only; and where it is now if not
 * here. Its times are by the Location's clock.
 */
function MachineCard({ column, timeZone }: { column: OverviewColumn; timeZone: string }) {
  const { machine } = column;
  return (
    <li className="grid content-start gap-1 rounded-lg border px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link to={`/machines/${encodeURIComponent(column.id)}`} className="min-w-0 font-semibold wrap-anywhere underline-offset-4 hover:underline">
          {column.name}
        </Link>
        {machine && <MachineStatus machine={machine} timeZone={timeZone} />}
        {machine && <CaptureOnlyBadge machine={machine} />}
      </div>
      {machine && (
        <>
          <LastShot machine={machine} timeZone={timeZone} />
          <LoadedRecipe machine={machine} />
          {!column.here && <div className="text-muted-foreground">Now at {machine.location?.name ?? "no Location"}</div>}
        </>
      )}
    </li>
  );
}

/**
 * Whether a Machine is online, and its Machine State; or, offline, how
 * (`offlineKind`), with when it was last seen. Offline reads louder than
 * online: one that went offline awake is marked, and one that went offline
 * asleep, as a Machine left for the night does, is muted.
 */
function MachineStatus({ machine, timeZone }: { machine: Machine; timeZone: string }) {
  if (machine.online) {
    return (
      <>
        <Badge>Online</Badge>
        <span className="text-muted-foreground">{machine.machineState ? describeMachineState(machine.machineState) : "State not reported"}</span>
      </>
    );
  }
  const kind = offlineKind(machine);
  return (
    <>
      {kind === "awake" ? (
        <SpecMark label={null} className="rounded-4xl px-2 text-xs">
          Offline
        </SpecMark>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          {kind === "asleep" ? "Offline, asleep" : "Offline"}
        </Badge>
      )}
      <span className="text-muted-foreground">
        {machine.lastSeenAt === null ? (
          "Never connected"
        ) : (
          <>
            Last seen <RelativeTime at={machine.lastSeenAt} timeZone={timeZone} />
          </>
        )}
      </span>
    </>
  );
}

/** A Machine's last Shot on its status card: how long ago, then its Recipe and duration, linked to the Shot, and what of it is out of spec, marked. */
function LastShot({ machine, timeZone }: { machine: Machine; timeZone: string }) {
  const last = machine.lastShot;
  if (!last) return <div className="text-muted-foreground">No Shots yet</div>;
  // The previous release's answer during a deploy gives neither its Recipe nor its duration (ADR-0025): the link is the Shot alone.
  const named = last.recipe === undefined ? ["Open"] : [last.recipe?.name ?? (last.recipe ? "Unnamed Recipe" : "No Recipe"), ...(last.duration != null ? [`${last.duration.toFixed(1)} s`] : [])];
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-muted-foreground">Last Shot {last.pulledAt ? <RelativeTime at={last.pulledAt} timeZone={timeZone} /> : "at a time not known"}</span>
      <Link to={`/shots/${encodeURIComponent(last.id)}`} className="tabular-nums underline-offset-4 hover:underline">
        {named.join(" · ")}
      </Link>
      {last.spec?.unfinished && <span className="text-muted-foreground">Unfinished</span>}
      {last.spec?.cleaningOrCalibration && <span className="text-muted-foreground">Cleaning or calibration</span>}
      {lastShotMarks(last.spec).map((mark) => (
        <SpecMark key={mark} className="tabular-nums">
          {mark}
        </SpecMark>
      ))}
    </div>
  );
}

/** A Machine's Loaded Recipe on its status card, linked to its page, with its Recipe Slot now, or that it is in none or Archived. */
function LoadedRecipe({ machine }: { machine: Machine }) {
  if (!machine.loadedRecipe) return <div className="text-muted-foreground">No Recipe loaded</div>;
  const { recipe } = machine.loadedRecipe;
  return (
    <div className="text-muted-foreground">
      Loaded:{" "}
      <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="text-foreground underline-offset-4 hover:underline">
        {recipe.name ?? "Unnamed Recipe"}
      </Link>{" "}
      ({recipe.archived ? "Archived" : recipe.slot === null ? "no slot" : `slot ${recipe.slot}`})
    </div>
  );
}

/**
 * A row's heading: the Recipe, with its Recipe Slot here, or the Location
 * it belongs to; its Reference Shot's duration, linked to that Shot, or "No
 * reference", linked to the Recipe's Shots in the Shots list, to choose one
 * from; and its Bean Batch's days since roast. On a narrow screen, which
 * has no Between Machines column, how far apart its Machines are is under
 * them. For the Shots pulled with no Recipe loaded, that alone.
 */
function RecipeHeading({ row, locationId, today, between }: { row: OverviewRow; locationId: string; today: string; between: SpecLine | undefined }) {
  const { recipe, details, reference } = row;
  if (!recipe) return <span className="text-muted-foreground">No Recipe loaded</span>;
  const elsewhere = recipe.location && recipe.location.id !== locationId ? recipe.location.name : undefined;
  const days = daysSinceRoast(details?.uses.beanBatch?.roastDate ?? null, today);
  const duration = reference?.numbers.duration ?? null;
  return (
    <div className="grid gap-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {row.slot !== null && (
          <Badge variant="outline" aria-label={`Slot ${row.slot}`} className="rounded-md px-1.5 text-muted-foreground tabular-nums">
            {row.slot}
          </Badge>
        )}
        <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="font-semibold wrap-anywhere underline-offset-4 hover:underline">
          {recipe.name ?? "Unnamed Recipe"}
        </Link>
        {details?.archived ? <Badge variant="secondary">Archived</Badge> : elsewhere !== undefined && <Badge variant="outline">{elsewhere}</Badge>}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {reference ? (
          <Link to={`/shots/${encodeURIComponent(reference.id)}`} className="underline-offset-4 hover:underline">
            Reference{duration !== null && ` ${duration.toFixed(1)} s`}
          </Link>
        ) : (
          <Link to={ratedShotsPath(recipe.id)} className="underline decoration-dotted underline-offset-4">
            No reference
          </Link>
        )}
        {days !== undefined && ` · ${days} d since roast`}
      </span>
      {between && (
        <span className="tabular-nums sm:hidden">
          <Line line={between} />
        </span>
      )}
    </div>
  );
}

/**
 * A cell: how many Shots its numbers cover and their median duration, and
 * under them what the server's judgement has it say (`cellLines`): the
 * duration's difference from the Reference Shot's, marked when out of spec;
 * the yield against target and the Shots stopped at target, only when out
 * of spec or, for a cell too small to judge, beyond a margin; and the
 * Unfinished Shots and the cleaning and calibration Shots left out of its
 * numbers. It opens the Shots in the Shots list. A narrow screen gives each
 * line without the words the column and the row already say.
 */
function ShotsCell({ group, to }: { group: SummaryGroup; to: string }) {
  const { counts, numbers } = group;
  const lines = cellLines(group);
  const median = numbers.duration && durationText(numbers.duration)?.median;
  return (
    <Link to={to} className="-m-1.5 grid justify-items-start gap-1 rounded-md p-1.5 tabular-nums hover:bg-muted">
      <span>
        <span className="font-semibold">{counts.shots}</span>
        <span className="text-muted-foreground">
          <span className="max-sm:sr-only"> {counts.shots === 1 ? "Shot" : "Shots"}</span>
          {median && " · "}
        </span>
        {median && <span className="font-semibold">{median}</span>}
      </span>
      {lines.duration && <Line line={lines.duration} short />}
      {lines.yield && <Line line={lines.yield} short />}
      {lines.stopping && <Line line={lines.stopping} short />}
      {lines.leftOut.length > 0 && <span className="text-muted-foreground">{lines.leftOut.join(" · ")}</span>}
    </Link>
  );
}
