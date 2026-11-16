import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { PageTitleWithInfo } from "@/components/info-tip";
import { describeHardware } from "@/components/machines";
import { LocationCredit, MachineCredit, OrNone, recordTime, secondsText } from "@/components/records";
import { ANY, type ListFilter, ListPagination, type ListState, NONE, RECORD_FILTERS, RecordFilterBar, type RecordList, useRecordFilters, useRecordList } from "@/components/record-lists";
import { batchName } from "@/components/bean-batches";
import { ReferenceMark } from "@/components/reference-shots";
import { grinderName } from "@/components/grinders";
import { ShotSummaryCard } from "@/components/shot-summary";
import { ShotTrendCard } from "@/components/shot-trend";
import { ShotRecipe, Stars, beanText, gramsText } from "@/components/shots";
import { SpecMark } from "@/components/spec-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ListedShot, type ShotFilterOptions, type ShotPage } from "@/lib/api";
import { type Difference, RATINGS, dayGroups, durationDifference, ratingChoiceText, stopNote, timeOfDay, yieldDifference } from "@/lib/shot-list";
import { baristaKey, numbersParam, shownNumbers } from "@/lib/shot-summary";
import { bucketParam, trendBucket, trendNumber } from "@/lib/shot-trend";

/** The list's query parameters, which are the REST API's: the page's address is a list anyone can share. */
const FILTERS = [...RECORD_FILTERS, "coffeeRoaster", "coffeeName", "barista", "profileTitle", "beanId", "profileId", "beanBatchId", "grinderId", "recipeId", "basketId", "rating"] as const;

/**
 * Every Shot, newest first, across every Location (#544): its date presets
 * and the chips of the filters set, with the rest behind one button; the
 * Shot Summary of the Shots they find, with the numbers chosen, which the
 * address keeps as `numbers`, apart from the filters; the trend of one of
 * its numbers by day or week, closed until opened, which the address keeps
 * as `trend`, the number charted, there only while it is open, and
 * `bucket`; and the Shots, under a heading for each day, each with what a
 * dial-in reader looks for and what of it is out of spec.
 * Times are each Shot's Location's, and dates are read in each Shot's own
 * Location's time zone; Shots with no Location use UTC. Staff see all of it.
 */
export function ShotsPage() {
  const list = useRecordList<ShotPage>("/shots", FILTERS, (page) => page.shots);
  const { data, error, params } = list;
  const [, setParams] = useSearchParams();
  const common = useRecordFilters(list);
  const own = useShotFilters(list);
  const numbers = shownNumbers(params.get("numbers"));
  const trend = trendNumber(params.get("trend"));
  const bucket = trendBucket(params.get("bucket"));
  // The rows stay where they are: the numbers shown, and the trend's number and bucket, are no filter.
  const keep = (name: string, param: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (param === null) next.delete(name);
      else next.set(name, param);
      return next;
    });
  const onNumbers = (chosen: typeof numbers) => keep("numbers", numbersParam(chosen));
  // The one Recipe the filters name, which the summary and the trend are read by, for its Reference Shot.
  const named = params.get("recipeId");
  const recipeId = named === null || named === NONE ? undefined : named;
  const byMachine = !params.has("machineId") && !params.has("pendingMachineId");
  /** The list as it is, at one Machine: where a Machine's line of the trend leads. */
  const machinePath = (machineId: string) => {
    const next = new URLSearchParams(params);
    next.delete("offset");
    next.set("machineId", machineId);
    return `/shots?${next}`;
  };

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-4">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Shots">
          <p>
            Every Shot pulled at every Location, newest first. Times are shown in each Shot's Location's time zone, and
            dates are read in it too; a Shot with no Location uses UTC.
          </p>
          <p>
            Beside a Shot's yield is its difference from its own target, and beside its duration its difference from its Recipe's Reference
            Shot's, where its Recipe has one. Each is marked where it is out of spec: a yield more than 5% from target, or a duration more than
            10% from the reference. How a Shot stopped is said where it was not at its target.
          </p>
        </PageTitleWithInfo>
      </div>

      <RecordFilterBar
        list={list}
        noun="Shot"
        filters={[...common.filters, ...own.filters]}
        error={common.error ?? own.error}
        description="Dates and times are read in each Shot's Location's time zone, so 7:00 means 7:00 wherever it was pulled. To includes the whole of its day unless a time is given."
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data?.total === 0 && <p className="text-muted-foreground">{list.filtered ? "No Shots match these filters." : "No Shots yet."}</p>}
      {data && data.total > 0 && (
        <>
          <ShotSummaryCard filterQuery={list.filterQuery} recipeId={recipeId} numbers={numbers} onNumbers={onNumbers} />
          <ShotTrendCard
            filterQuery={list.filterQuery}
            recipe={recipeId === undefined ? undefined : { byMachine, machinePath }}
            open={params.has("trend")}
            onOpen={(open) => keep("trend", open ? trend : null)}
            number={trend}
            bucket={bucket}
            onNumber={(chosen) => keep("trend", chosen)}
            onBucket={(chosen) => keep("bucket", bucketParam(chosen))}
          />
        </>
      )}
      {data && data.shots.length > 0 && (
        <>
          <ShotRows shots={data.shots} list={list} />
          <ListPagination list={list} noun="Shots" />
        </>
      )}
    </section>
  );
}

/** A difference beside its number: marked where it is out of spec, and muted otherwise. */
function Beside({ difference }: { difference: Difference | undefined }) {
  if (!difference) return null;
  return difference.marked ? <SpecMark>{difference.text}</SpecMark> : <span className="text-muted-foreground">{difference.text}</span>;
}

/** What kind of Shot it is, where its numbers are judged by none of the margins: an Unfinished Shot, or a cleaning or calibration Shot. */
function KindBadge({ shot }: { shot: ListedShot }) {
  if (shot.spec?.cleaningOrCalibration) return <Badge variant="outline">Cleaning or calibration</Badge>;
  return shot.spec?.unfinished ? <Badge variant="outline">Unfinished</Badge> : null;
}

/**
 * The page's Shots under a heading for each day (`dayGroups`): a table on a
 * wide screen, and on a narrow one two lines for each Shot, so nothing
 * scrolls sideways. An Unfinished Shot's row is muted.
 */
function ShotRows({ shots, list }: { shots: ListedShot[]; list: RecordList<ShotPage> }) {
  const groups = dayGroups(shots);
  const state = { list: list.search } satisfies ListState;
  // A Location is said of each Shot unless the list is of one, and on a narrow screen a Recipe likewise.
  const located = !list.params.has("locationId");
  const named = list.params.get("recipeId");
  const oneRecipe = named !== null && named !== NONE;
  return (
    <>
      <div className="rounded-lg border max-lg:hidden">
        <Table aria-label="Shots">
          <TableHeader>
            <TableRow>
              <TableHead>Pulled</TableHead>
              <TableHead>Machine</TableHead>
              <TableHead>Recipe</TableHead>
              <TableHead>Grind</TableHead>
              <TableHead>Dose</TableHead>
              <TableHead>Yield</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Rating</TableHead>
              <TableHead>Barista</TableHead>
            </TableRow>
          </TableHeader>
          {groups.map((group, index) => (
            <DayRows key={`${index} ${group.heading}`} heading={group.heading}>
              {group.shots.map((shot) => (
                <ShotRow key={shot.id} shot={shot} state={state} located={located} />
              ))}
            </DayRows>
          ))}
        </Table>
      </div>
      <div role="group" aria-label="Shots" className="overflow-hidden rounded-lg border lg:hidden">
        {groups.map((group, index) => (
          <section key={`${index} ${group.heading}`} aria-label={group.heading} className="border-t first:border-t-0">
            <h2 className="bg-muted/50 px-3 py-1.5 text-[0.8125rem] font-medium text-muted-foreground">{group.heading}</h2>
            <ul>
              {group.shots.map((shot) => (
                <NarrowShot key={shot.id} shot={shot} state={state} withRecipe={!oneRecipe} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

/** A day's rows of the table, a group of its own, under the heading that names it. */
function DayRows({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    // A day's last row keeps its line where another day follows.
    <TableBody className="not-last:[&_tr:last-child]:border-b">
      <TableRow className="bg-muted/50 hover:bg-muted/50">
        <TableHead colSpan={9} scope="rowgroup" className="h-8 text-[0.8125rem]">
          {heading}
        </TableHead>
      </TableRow>
      {children}
    </TableBody>
  );
}

/** The Shot's page, from its time: named by its whole time, with its date and zone, which its day's heading and its Location otherwise give. */
function TimeLink({ shot, state }: { shot: ListedShot; state: ListState }) {
  const whole = recordTime(shot.pulledAt, shot);
  return (
    <Link to={`/shots/${encodeURIComponent(shot.id)}`} state={state} title={whole} aria-label={whole} className="font-medium underline-offset-4 hover:underline">
      {timeOfDay(shot)}
    </Link>
  );
}

/** A Shot's row of the table. */
function ShotRow({ shot, state, located }: { shot: ListedShot; state: ListState; located: boolean }) {
  const stopped = stopNote(shot.spec, shot.stopReason);
  // Its profile and its Bean, by its name, or its roaster where it recorded no name, and its Location, each where there is one.
  const recorded = [shot.profileTitle?.trim() || undefined, shot.coffeeName?.trim() || shot.coffeeRoaster?.trim() || undefined].filter((part) => part !== undefined);
  return (
    <TableRow className={shot.spec?.unfinished ? "text-muted-foreground" : undefined}>
      <TableCell>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <TimeLink shot={shot} state={state} />
          <ReferenceMark shot={shot} />
          <KindBadge shot={shot} />
        </div>
      </TableCell>
      <TableCell className="min-w-28 whitespace-normal">
        <MachineCredit record={shot} />
      </TableCell>
      <TableCell className="min-w-40 whitespace-normal">
        <div className="font-medium">{shot.recipe ? <ShotRecipe shot={shot} /> : <span className="font-normal text-muted-foreground">No Recipe</span>}</div>
        <div className="text-xs text-muted-foreground">
          {recorded.join(" · ")}
          {located && recorded.length > 0 && " · "}
          {located && <LocationCredit record={shot} />}
        </div>
      </TableCell>
      <TableCell>
        <OrNone>{shot.grinderSetting ?? undefined}</OrNone>
      </TableCell>
      <TableCell>
        <OrNone>{gramsText(shot.actualDose, shot.targetDose)}</OrNone>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <OrNone>{gramsText(shot.actualYield, shot.targetYield)}</OrNone>
          <Beside difference={yieldDifference(shot.spec)} />
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <OrNone>{secondsText(shot.duration)}</OrNone>
          <Beside difference={durationDifference(shot.spec)} />
        </div>
        {stopped && <div className="text-xs text-muted-foreground">{stopped}</div>}
      </TableCell>
      <TableCell>
        <Stars rating={shot.enjoyment} />
      </TableCell>
      <TableCell>
        <OrNone>{shot.barista ?? undefined}</OrNone>
      </TableCell>
    </TableRow>
  );
}

/**
 * A Shot on a narrow screen, the whole of it leading to its page, in two
 * lines, neither of which wraps: its time and Machine, with its duration
 * and the duration's difference, on the first; and on the second its grind
 * setting, its yield with its difference, how it stopped where not at its
 * target, and its Recipe, where the list isn't of one, with its rating
 * across from them. What a line has no room for is cut short, the Machine's
 * name on the first and the last of the second.
 */
function NarrowShot({ shot, state, withRecipe }: { shot: ListedShot; state: ListState; withRecipe: boolean }) {
  const machine = shot.machine?.name ?? (shot.pendingMachine ? describeHardware(shot.pendingMachine) : "No Machine");
  const recipe = shot.recipe ? (shot.recipe.name ?? "Unnamed Recipe") : "No Recipe";
  const after = [stopNote(shot.spec, shot.stopReason), withRecipe ? recipe : undefined].filter((part) => part !== undefined);
  return (
    <li className="border-t">
      <Link
        to={`/shots/${encodeURIComponent(shot.id)}`}
        state={state}
        // One column no wider than the row, so a long line is cut short rather than widening it.
        className={`grid grid-cols-1 gap-0.5 px-3 py-2.5 tabular-nums hover:bg-muted/50 ${shot.spec?.unfinished ? "text-muted-foreground" : ""}`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">{timeOfDay(shot)}</span>
            <span className="truncate text-muted-foreground">· {machine}</span>
            {shot.referenceOf && <Badge variant="secondary">Reference</Badge>}
            <KindBadge shot={shot} />
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <OrNone>{secondsText(shot.duration)}</OrNone>
            <Beside difference={durationDifference(shot.spec)} />
          </span>
        </span>
        <span className="flex items-center justify-between gap-2 text-[0.8125rem] text-muted-foreground">
          <span className="min-w-0 truncate">
            {shot.grinderSetting ? `grind ${shot.grinderSetting} · ` : ""}
            {gramsText(shot.actualYield, shot.targetYield) ?? "no yield"} <Beside difference={yieldDifference(shot.spec)} />
            {after.map((part) => ` · ${part}`)}
          </span>
          {shot.enjoyment !== null && shot.enjoyment !== 0 && (
            <span className="shrink-0">
              <Stars rating={shot.enjoyment} />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

// Recorded values are prefixed, so none can be mistaken for ANY or NONE.

/** A text filter's Select value: no filter, Shots that recorded none (an empty parameter), or a recorded value. */
function textChoice(value: string | null): string {
  if (value === null) return ANY;
  return value === "" ? NONE : `=${value}`;
}

function textFilter(choice: string): string | null {
  if (choice === ANY) return null;
  return choice === NONE ? "" : choice.slice(1);
}

/** A Bean as a Select value: its roaster and name, either null when the Shots recorded none. */
function beanChoice(roaster: string | null, name: string | null): string {
  return JSON.stringify([roaster, name]);
}

/** What a filter by a Library item is set to, as its chip says it: `none` for Shots linked to none, the item's name, or that no listed Shot is linked to it; nothing while the items load. */
function linkValue(value: string | null, options: ({ id: string; name: string } | null)[] | undefined, none: string): string | undefined {
  if (value === NONE) return none;
  return options && (options.find((option) => option?.id === value)?.name ?? "No Shots");
}

/**
 * What names the Library's Bean or Profile an address filters by (#547),
 * read once for its chip: nothing while it is read, and that it is unknown
 * for one that can't be.
 */
function useItemName(path: string, id: string | null, name: (item: Record<string, { name?: string | null; title?: string | null }>) => string): string | undefined {
  const [read, setRead] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (id === null) return;
    let current = true;
    api<Record<string, { name?: string | null; title?: string | null }>>("GET", `${path}/${encodeURIComponent(id)}`).then(
      (item) => current && setRead({ id, name: name(item) }),
      () => current && setRead({ id, name: "Unknown" }),
    );
    return () => {
      current = false;
    };
    // `name` reads the same of an item each time.
  }, [path, id]);
  return read?.id === id ? read.name : undefined;
}

/**
 * The Shots list's own filters, behind its Filters button beside those every
 * record list has: by the Recipe, Bean Batch, Grinder and Basket of the
 * Library a Shot is linked to, by what it recorded, its Bean, Barista and
 * profile, and by its rating; with what went wrong reading their choices,
 * if anything. The Library's Bean and Profile a Shot is linked to are filters
 * too (#547), set only by the address a Bean's or a Profile's page opens the
 * list with: each is a chip, which removes it, and has no control.
 */
function useShotFilters(list: RecordList<ShotPage>): { filters: ListFilter[]; error: string | undefined } {
  const id = useId();
  const [options, setOptions] = useState<ShotFilterOptions>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api<ShotFilterOptions>("GET", "/shots/filters").then(
      (loaded) => current && setOptions(loaded),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The filters could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, []);

  const { params } = list;
  const roaster = params.get("coffeeRoaster");
  const bean = params.get("coffeeName");
  // The filter finds a Barista by any spelling of the name and offers each Barista once (#468), so the choice shown
  // for the address's spelling is the one that is the same Barista, or none recorded for a blank one.
  const barista = params.get("barista");
  const baristaChoice =
    barista === null ? null : baristaKey(barista) === "" ? "" : (options?.baristas.find((name) => name !== null && baristaKey(name) === baristaKey(barista)) ?? barista);
  const profile = params.get("profileTitle");
  const rating = params.get("rating");
  const batches = options?.beanBatches.map((batch) => batch && { id: batch.id, name: batchName(batch) });
  const grinders = options?.grinders.map((grinder) => grinder && { id: grinder.id, name: `${grinderName(grinder)}${grinder.location ? `, ${grinder.location.name}` : ""}` });
  const recipes = options?.recipes.map((recipe) => recipe && { id: recipe.id, name: `${recipe.name ?? "Unnamed Recipe"}${recipe.location ? `, ${recipe.location.name}` : ""}` });
  const baskets = options?.baskets.map((basket) => basket && { id: basket.id, name: basket.name ?? "Unnamed Basket" });
  const libraryBean = useItemName("/beans", params.get("beanId"), ({ bean }) => bean?.name ?? "Unnamed Bean");
  const libraryProfile = useItemName("/profiles", params.get("profileId"), ({ profile }) => profile?.title ?? "Untitled Profile");

  const filters: ListFilter[] = [
    {
      label: "Recipe",
      names: ["recipeId"],
      value: linkValue(params.get("recipeId"), recipes, "None loaded"),
      control: (
        <LinkFilter
          id={`${id}-recipe`}
          label="Recipe"
          any="Any Recipe"
          none="Pulled with no Recipe loaded"
          value={params.get("recipeId")}
          options={recipes}
          onChange={(recipeId) => list.filter({ recipeId })}
        />
      ),
    },
    {
      label: "Bean",
      names: ["coffeeRoaster", "coffeeName"],
      value: beanText({ coffeeRoaster: roaster, coffeeName: bean }) ?? "None recorded",
      control: (
        <Field>
          <FieldLabel htmlFor={`${id}-bean`}>Bean</FieldLabel>
          <Select
            value={roaster === null && bean === null ? ANY : beanChoice(roaster || null, bean || null)}
            onValueChange={(choice) => {
              if (choice === ANY) return list.filter({ coffeeRoaster: null, coffeeName: null });
              const [chosenRoaster, chosenName] = JSON.parse(choice) as [string | null, string | null];
              list.filter({ coffeeRoaster: chosenRoaster ?? "", coffeeName: chosenName ?? "" });
            }}
          >
            <SelectTrigger id={`${id}-bean`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any Bean</SelectItem>
              {options?.beans.map((option) => (
                <SelectItem key={beanChoice(option.coffeeRoaster, option.coffeeName)} value={beanChoice(option.coffeeRoaster, option.coffeeName)}>
                  {beanText(option) ?? "No Bean recorded"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ),
    },
    { label: "Library Bean", names: ["beanId"], value: libraryBean },
    {
      label: "Bean Batch",
      names: ["beanBatchId"],
      value: linkValue(params.get("beanBatchId"), batches, "Not linked"),
      control: (
        <LinkFilter
          id={`${id}-batch`}
          label="Bean Batch"
          any="Any Bean Batch"
          none="Not linked to a Bean Batch"
          value={params.get("beanBatchId")}
          options={batches}
          onChange={(beanBatchId) => list.filter({ beanBatchId })}
        />
      ),
    },
    {
      label: "Grinder",
      names: ["grinderId"],
      value: linkValue(params.get("grinderId"), grinders, "Not linked"),
      control: (
        <LinkFilter
          id={`${id}-grinder`}
          label="Grinder"
          any="Any Grinder"
          none="Not linked to a Grinder"
          value={params.get("grinderId")}
          options={grinders}
          onChange={(grinderId) => list.filter({ grinderId })}
        />
      ),
    },
    {
      label: "Basket",
      names: ["basketId"],
      value: linkValue(params.get("basketId"), baskets, "Not linked"),
      control: (
        <LinkFilter
          id={`${id}-basket`}
          label="Basket"
          any="Any Basket"
          none="Not linked to a Basket"
          value={params.get("basketId")}
          options={baskets}
          onChange={(basketId) => list.filter({ basketId })}
        />
      ),
    },
    {
      label: "Barista",
      names: ["barista"],
      value: baristaChoice || "None recorded",
      control: (
        <TextFilter id={`${id}-barista`} label="Barista" any="Any Barista" value={baristaChoice} options={options?.baristas} onChange={(chosen) => list.filter({ barista: chosen })} />
      ),
    },
    {
      label: "Profile",
      names: ["profileTitle"],
      value: profile || "None recorded",
      control: (
        <TextFilter id={`${id}-profile`} label="Profile" any="Any profile" value={profile} options={options?.profiles} onChange={(profileTitle) => list.filter({ profileTitle })} />
      ),
    },
    { label: "Library Profile", names: ["profileId"], value: libraryProfile },
    {
      label: "Rating",
      names: ["rating"],
      value: rating === null ? undefined : ratingChoiceText(rating),
      control: (
        <Field>
          <FieldLabel htmlFor={`${id}-rating`}>Rating</FieldLabel>
          <Select value={rating ?? ANY} onValueChange={(choice) => list.filter({ rating: choice === ANY ? null : choice })}>
            <SelectTrigger id={`${id}-rating`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any rating</SelectItem>
              {RATINGS.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {ratingChoiceText(choice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ),
    },
  ];
  return { filters, error };
}

/** A filter by what Shots recorded as text: any, a value recorded, or none recorded. */
function TextFilter({
  id,
  label,
  any,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  any: string;
  value: string | null;
  options: (string | null)[] | undefined;
  onChange(value: string | null): void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={textChoice(value)} onValueChange={(choice) => onChange(textFilter(choice))}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{any}</SelectItem>
          {options?.map((option) => (
            <SelectItem key={textChoice(option ?? "")} value={textChoice(option ?? "")}>
              {option ?? "None recorded"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * A filter by the Library item Shots are linked to: any, one of the items
 * listed, by its id, or none (`none`, as the REST API takes it). An item
 * linked to no listed Shot, as one opened from its page, is still named.
 */
function LinkFilter({
  id,
  label,
  any,
  none,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  any: string;
  none: string;
  value: string | null;
  options: ({ id: string; name: string } | null)[] | undefined;
  onChange(value: string | null): void;
}) {
  const items = options ?? [];
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value ?? ANY} onValueChange={(choice) => onChange(choice === ANY ? null : choice)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{any}</SelectItem>
          {items.map((option) =>
            option === null ? null : (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ),
          )}
          {value !== null && value !== NONE && !items.some((option) => option?.id === value) && (
            <SelectItem value={value}>{options ? `No Shots linked to this ${label}` : label}</SelectItem>
          )}
          {(items.includes(null) || value === NONE) && <SelectItem value={NONE}>{none}</SelectItem>}
        </SelectContent>
      </Select>
    </Field>
  );
}
