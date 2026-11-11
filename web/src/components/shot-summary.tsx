import { useCallback, useId, useState } from "react";
import { Link } from "react-router";
import { batchName } from "@/components/bean-batches";
import { grinderName } from "@/components/grinders";
import { CardTitleWithInfo } from "@/components/info-tip";
import { describeHardware } from "@/components/machines";
import { beanText } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ShotSummary, type SummaryGroup, type SummaryGroupedBy } from "@/lib/api";
import { GROUPINGS, type Grouping, type MedianText, durationText, groupFilters, shareText, shotsText, yieldAgainstTargetText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** How many groups the table of groups shows at a time. */
const GROUPS_PAGE = 25;

/** Each grouping as its control and its column name it. */
const GROUPING_LABELS: Record<Grouping, string> = {
  location: "Location",
  machine: "Machine",
  recipe: "Recipe",
  bean: "Bean",
  beanBatch: "Bean Batch",
  profile: "Profile",
  grinder: "Grinder",
  basket: "Basket",
  barista: "Barista",
};

/** A Select's value for no grouping, which none of `GROUPINGS` spells. */
const NO_GROUPING = "none";

/**
 * The Shot Summary of the Shots a list's filters find (#466), above its
 * rows: how many there are, their duration and yield against target, each as
 * a median with the range the middle half fall in, and the share that
 * stopped on weight; or, grouped by one or two of what Shots have (#468), a
 * table of its groups, each with the same numbers, 25 at a time. A group's
 * count links to the list with the group as its filters (`groupHref`), which
 * find its Shots.
 *
 * `filterQuery` is the list's filters as the REST API's query, so the
 * summary follows them; it is loaded again every 30 s, less often than the
 * rows, as it reads every Shot the filters find. What the last filters and
 * grouping gave stays until the next ones' arrives, as the rows do, but not
 * while a load has failed since the last that succeeded: it would stand
 * under that failure as theirs until the next load, 30 s on. So filters or
 * a grouping changed after a failed load show no numbers until theirs
 * arrive.
 */
export function ShotSummaryCard({
  filterQuery,
  groupBy,
  onGroupBy,
  groupHref,
}: {
  filterQuery: string;
  /** What the summary is grouped by, from the page's address: none, one or two. */
  groupBy: Grouping[];
  onGroupBy(groupBy: Grouping[]): void;
  /** The address of the list with these filters set, or cleared where null, and no grouping. */
  groupHref(filters: Record<string, string | null>): string;
}) {
  // The page of groups shown, which starts over with the filters and the grouping.
  const grouping = groupBy.join();
  const scope = `${filterQuery}|${grouping}`;
  const [paged, setPaged] = useState({ scope, offset: 0 });
  const offset = paged.scope === scope ? paged.offset : 0;
  const query = new URLSearchParams([
    ...new URLSearchParams(filterQuery),
    ...(grouping ? [["groupBy", grouping], ["limit", String(GROUPS_PAGE)], ["offset", String(offset)]] : []),
  ]).toString();
  // Each summary loaded remembers the filters, grouping and page it answers.
  const load = useCallback(
    async () => ({ query, groupBy: grouping ? (grouping.split(",") as Grouping[]) : [], summary: await api<ShotSummary>("GET", `/shots/summary${query ? `?${query}` : ""}`) }),
    [query, grouping],
  );
  const { data: loaded, error } = usePolled(load, DETAILS_POLL_MS);
  const shown = loaded && (loaded.query === query || !error) ? loaded : undefined;
  // What is shown is grouped as it was asked for, until the next grouping's arrives.
  const grouped = shown ? shown.groupBy.length > 0 : groupBy.length > 0;

  return (
    <Card role="region" aria-label="Summary">
      <CardHeader>
        <CardTitleWithInfo title="Summary">
          <p>How the Shots these filters find went, leaving out cleaning and calibration Shots.</p>
          <p>Duration and yield against target are each a median, with the range the middle half of the Shots fall in.</p>
          <p>Yield against target is the yield weighed less the Shot's own target, for Shots with both.</p>
          <p>Stopped on weight is the share, of the Shots that recorded what stopped them, that stopped at their target weight.</p>
          <p>Group them by one or two things, such as Recipe then Machine, to compare. A group's count opens its Shots in the list.</p>
          <p>A Barista is one person whatever the case of the name typed and the spaces around it, shown as last spelled.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read the summary: {error}</AlertDescription>
          </Alert>
        )}
        <GroupingControl groupBy={groupBy} onGroupBy={onGroupBy} />
        {!grouped && <Figures group={shown?.summary.groups[0]} />}
        {grouped && shown && (
          <Groups
            groupBy={shown.groupBy}
            summary={shown.summary}
            groupHref={groupHref}
            // Only for the grouping and filters shown: a page of the ones before is not theirs to turn.
            goTo={shown.query === query ? (at) => setPaged({ scope, offset: at }) : undefined}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The grouping control: what to group the summary by, and then by, each one of what Shots have or nothing. */
function GroupingControl({ groupBy, onGroupBy }: { groupBy: Grouping[]; onGroupBy(groupBy: Grouping[]): void }) {
  const id = useId();
  const [first, second] = groupBy;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field>
        <FieldLabel htmlFor={`${id}-first`}>Group by</FieldLabel>
        <Select
          value={first ?? NO_GROUPING}
          // The second grouping stays, unless it is the one now chosen first.
          onValueChange={(choice) => onGroupBy(choice === NO_GROUPING ? [] : [choice as Grouping, ...(second !== undefined && second !== choice ? [second] : [])])}
        >
          <SelectTrigger id={`${id}-first`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUPING}>No grouping</SelectItem>
            {GROUPINGS.map((grouping) => (
              <SelectItem key={grouping} value={grouping}>
                {GROUPING_LABELS[grouping]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-second`}>Then by</FieldLabel>
        <Select value={second ?? NO_GROUPING} disabled={first === undefined} onValueChange={(choice) => onGroupBy(choice === NO_GROUPING ? [first!] : [first!, choice as Grouping])}>
          <SelectTrigger id={`${id}-second`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUPING}>Nothing more</SelectItem>
            {GROUPINGS.filter((grouping) => grouping !== first).map((grouping) => (
              <SelectItem key={grouping} value={grouping}>
                {GROUPING_LABELS[grouping]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

/** How many Shots a number rests on, said only where some of those covered had no value for it. */
function restsOn(shots: number | undefined, covered: number | undefined, which?: string): string | undefined {
  if (shots === undefined || covered === undefined || shots === covered) return undefined;
  return `${shots} of ${shotsText(covered)}${which ? ` ${which}` : ""}`;
}

/** The numbers of one group, every Shot the filters find: dashes while there is none to show. */
function Figures({ group }: { group: SummaryGroup | undefined }) {
  const covered = group?.counts.shots;
  const leftOut = group?.counts.cleaningAndCalibration ?? 0;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
      <Figure term="Shots" value={covered === undefined ? undefined : String(covered)} note={leftOut > 0 ? `${leftOut} cleaning ${leftOut === 1 ? "or calibration Shot" : "and calibration Shots"} left out` : undefined} />
      <Figure term="Duration" number={group && durationText(group.numbers.duration)} note={restsOn(group?.numbers.duration.shots, covered, "had a duration")} />
      <Figure
        term="Yield against target"
        number={group && yieldAgainstTargetText(group.numbers.yieldAgainstTarget)}
        note={restsOn(group?.numbers.yieldAgainstTarget.shots, covered, "had a target and a yield")}
      />
      <Figure
        term="Stopped on weight"
        value={group && shareText(group.numbers.stoppedOnWeight.share)}
        note={restsOn(group?.numbers.stoppedOnWeight.shots, covered, "recorded what stopped them")}
      />
    </dl>
  );
}

/** One of a summary's numbers: its value, or its median with the middle half's range beside it, a dash for none, and a note under it. */
function Figure({ term, value, number, note }: { term: string; value?: string; number?: MedianText; note?: string }) {
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="tabular-nums">
        <Amount value={value} number={number} className="text-lg font-semibold" />
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </dd>
    </div>
  );
}

/** A number as it reads: its value, or its median with the middle half's range beside it; a dash for none. */
function Amount({ value, number, className }: { value?: string; number?: MedianText; className?: string }) {
  const shown = number?.median ?? value;
  if (shown === undefined) return <span className="text-muted-foreground">-</span>;
  return (
    <>
      <span className={className}>{shown}</span>
      {number && <span className="text-muted-foreground"> ({number.range})</span>}
    </>
  );
}

/**
 * The table of a summary's groups, in the server's order: what each is
 * grouped by, a column for each grouping, then its count, which opens its
 * Shots, and its numbers, each saying how many Shots it rests on where some
 * had no value. Below it, which groups of them all are shown, and the pages
 * either side, turned by `goTo`, unless the groups are those of the filters
 * or grouping before.
 */
function Groups({
  groupBy,
  summary,
  groupHref,
  goTo,
}: {
  groupBy: Grouping[];
  summary: ShotSummary;
  groupHref(filters: Record<string, string | null>): string;
  goTo: ((offset: number) => void) | undefined;
}) {
  const { groups, total, offset } = summary;
  if (groups.length === 0) {
    // A page past the last group, as when groups left while it was open.
    return total === 0 ? null : (
      <Button variant="outline" size="sm" className="justify-self-start" disabled={!goTo} onClick={() => goTo?.(0)}>
        Back to the first groups
      </Button>
    );
  }
  return (
    <>
      <div className="min-w-0 rounded-lg border">
        <Table aria-label="Groups">
          <TableHeader>
            <TableRow>
              {groupBy.map((grouping) => (
                <TableHead key={grouping}>{GROUPING_LABELS[grouping]}</TableHead>
              ))}
              <TableHead>Shots</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Yield against target</TableHead>
              <TableHead>Stopped on weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => {
              const { counts, numbers } = group;
              const names = groupBy.map((grouping) => groupName(grouping, group.by));
              return (
                <TableRow key={JSON.stringify(group.by)}>
                  {groupBy.map((grouping, n) => (
                    <TableCell key={grouping} className="min-w-28 font-medium whitespace-normal">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {names[n]!.none ? <span className="font-normal text-muted-foreground">{names[n]!.text}</span> : names[n]!.text}
                        {grouping === "machine" && group.by.pendingMachine && <Badge variant="secondary">Pending Machine</Badge>}
                      </span>
                    </TableCell>
                  ))}
                  <TableCell className="tabular-nums">
                    <Link to={groupHref(groupFilters(group.by))} aria-label={`${shotsText(counts.shots)}: ${names.map((name) => name.text).join(", ")}`} className="underline underline-offset-4">
                      {counts.shots}
                    </Link>
                    <CellNote>{counts.cleaningAndCalibration > 0 ? `${counts.cleaningAndCalibration} left out` : undefined}</CellNote>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <Amount number={durationText(numbers.duration)} />
                    <CellNote>{restsOn(numbers.duration.shots, counts.shots)}</CellNote>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <Amount number={yieldAgainstTargetText(numbers.yieldAgainstTarget)} />
                    <CellNote>{restsOn(numbers.yieldAgainstTarget.shots, counts.shots)}</CellNote>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <Amount value={shareText(numbers.stoppedOnWeight.share)} />
                    <CellNote>{restsOn(numbers.stoppedOnWeight.shots, counts.shots)}</CellNote>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Groups {offset + 1}–{offset + groups.length} of {total}
        </p>
        {total > GROUPS_PAGE && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!goTo || offset === 0} onClick={() => goTo?.(Math.max(0, offset - GROUPS_PAGE))}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={!goTo || offset + GROUPS_PAGE >= total} onClick={() => goTo?.(offset + GROUPS_PAGE)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/** What a table's cell says under its number, if anything. */
function CellNote({ children }: { children: string | undefined }) {
  return children ? <p className="text-xs text-muted-foreground">{children}</p> : null;
}

/**
 * What a group is named by for a grouping, as the list's filter of the same
 * name names its choice, and whether it is that grouping's group of Shots
 * with none.
 */
function groupName(grouping: Grouping, by: SummaryGroupedBy): { text: string; none?: true } {
  const at = (location: { name: string } | null) => (location ? `, ${location.name}` : "");
  const named = (text: string | undefined, none: string): { text: string; none?: true } => (text === undefined ? { text: none, none: true } : { text });
  switch (grouping) {
    case "location":
      return named(by.location?.name, "No Location");
    case "machine":
      return { text: by.machine?.name ?? (by.pendingMachine ? describeHardware(by.pendingMachine) : "No Machine") };
    case "recipe":
      return named(by.recipe ? `${by.recipe.name ?? "Unnamed Recipe"}${at(by.recipe.location)}` : undefined, "No Recipe loaded");
    case "bean":
      return named(by.bean ? beanText({ coffeeRoaster: by.bean.roaster, coffeeName: by.bean.name }) : undefined, "No Bean recorded");
    case "beanBatch":
      return named(by.beanBatch ? batchName(by.beanBatch) : undefined, "Not linked to a Bean Batch");
    case "profile":
      return named(by.profile ?? undefined, "No profile recorded");
    case "grinder":
      return named(by.grinder ? `${grinderName(by.grinder)}${at(by.grinder.location)}` : undefined, "Not linked to a Grinder");
    case "basket":
      return named(by.basket ? (by.basket.name ?? "Unnamed Basket") : undefined, "Not linked to a Basket");
    case "barista":
      return named(by.barista ?? undefined, "No Barista recorded");
  }
}
