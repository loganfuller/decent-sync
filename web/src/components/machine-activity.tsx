import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { CollapsibleCard } from "@/components/collapsible-card";
import { LoadedRecipeLink } from "@/components/loaded-recipes";
import { DayField } from "@/components/machine-use";
import { describeMachineState } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type LoadedRecipe, type Machine, type MachineActivity, type MachineStateEvent, type TrailEntry, type TrailRecipe, api } from "@/lib/api";
import { ACTIVITY_KINDS, type ActivityKind, TRAIL_KINDS, type TrailValue, dateIn, madeBy, trailLines, whenText } from "@/lib/machine-activity";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// What happened on a Machine over a chosen day (#476), on its page: its
// Workflow changes as a dial-in trail, its Loaded Recipes and its Machine
// States, each latest first, a page at a time, as `get_machine_activity`
// gives an assistant the same from the same service.

const PAGE_SIZE = 20;

/** What each list says when it holds nothing. */
const NOTHING: Record<ActivityKind, string> = {
  workflowChanges: "Its tablet had reported no Workflow by then.",
  loadedRecipes: "No Recipe was loaded then.",
  machineStates: "Its tablet had reported no Machine State by then.",
};

/** A time as the lists show it (`whenText`): on the wall clock of the Location the Machine was at then. */
type When = (at: string) => string;

/**
 * A Machine's activity over one day. Shown closed until opened, as the
 * Settings Edits and Settings History cards are, as most who read the page
 * do not need it: it loads nothing while closed, and starts at today's
 * dial-in trail each time it is opened.
 */
export function MachineActivityCard({ machine }: { machine: Machine }) {
  return (
    <CollapsibleCard
      title="Activity"
      info={
        <>
          <p>
            What happened on this Machine over one day, latest first: what changed in its Workflow, the Recipes it had loaded and its Machine States. The day is
            that of the Location it was at then, and so is each time, by its tablet's clock.
          </p>
          <p>
            The dial-in trail lists each Recipe loaded or unloaded and what changed between them, from what to what. Changes within 5 seconds of each other from
            one source are one entry. A change made by the tablet may be a barista's, its skin's or DYE2's, which can't be told apart.
          </p>
          <p>
            Where its tablet had reported any by then, each list ends with what was in effect as the day began, which dates from before it. The trail's last entry
            is a Workflow whole: that one, or else the first of the day. A Machine State lasts until the next one its tablet reports.
          </p>
        </>
      }
    >
      <ActivityLists machine={machine} />
    </CollapsibleCard>
  );
}

/**
 * The day and its lists, while their card is open: today, at the Location
 * the Machine is at, until another is chosen. The day is the Location's the
 * Machine was at then, as the server reads a date, and each time is shown on
 * that Location's wall clock, the browser's own time zone playing no part.
 * One list is shown at a time, and only that one is loaded, again every
 * 30 s.
 */
function ActivityLists({ machine }: { machine: Machine }) {
  const [kind, setKind] = useState<ActivityKind>("workflowChanges");
  const [chosen, setChosen] = useState<string>();
  const day = chosen ?? dateIn(machine.location?.timeZone);
  const when: When = (at) => whenText(at, day, machine.locationHistory);

  return (
    <CardContent>
      <Tabs value={kind} onValueChange={(value) => setKind(ACTIVITY_KINDS.find((found) => found.kind === value)?.kind ?? "workflowChanges")} className="gap-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* On a row of its own on a phone, where the day chosen doesn't fit beside it. */}
          <div className="max-sm:basis-full">
            <TabsList>
              {ACTIVITY_KINDS.map(({ kind: value, label }) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <DayField id="activity-day" label="Day" value={day} onChange={setChosen} />
        </div>
        <TabsContent value={kind}>
          {/* Keyed, so a list starts at its latest page for each day and kind, and shows nothing read for another. */}
          <ActivityList key={`${kind} ${day}`} machineId={machine.id} kind={kind} day={day} when={when} />
        </TabsContent>
      </Tabs>
    </CardContent>
  );
}

/** One kind of a Machine's activity over a day, a page at a time: the page read last stays while another loads. */
function ActivityList({ machineId, kind, day, when }: { machineId: string; kind: ActivityKind; day: string; when: When }) {
  const [offset, setOffset] = useState(0);
  // Each page read remembers where it starts.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ from: day, to: day, kind, limit: String(PAGE_SIZE), offset: String(offset) });
    return { offset, activity: await api<MachineActivity>("GET", `/machines/${encodeURIComponent(machineId)}/activity?${query}`) };
  }, [machineId, kind, day, offset]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const { workflowChanges, loadedRecipes, machineStates } = data?.activity ?? {};
  const page = workflowChanges ?? loadedRecipes ?? machineStates;
  const first = data ? data.offset + 1 : 0;
  const last = data && page ? data.offset + page.entries.length : 0;
  // A list that shrank to end before the page shown, as when a change is undone within 5 seconds and so leaves the
  // trail, goes back to its last page, rather than show none of it with no way back.
  const end = page?.total;
  const read = data?.offset;
  useEffect(() => {
    if (end !== undefined && read !== undefined && read > 0 && read >= end) setOffset(Math.max(0, Math.ceil(end / PAGE_SIZE) - 1) * PAGE_SIZE);
  }, [end, read]);

  return (
    <div className="grid gap-3">
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not read its activity: {error}</AlertDescription>
        </Alert>
      )}
      {page?.total === 0 && <p className="text-sm text-muted-foreground">{NOTHING[kind]}</p>}
      {workflowChanges && workflowChanges.entries.length > 0 && <Trail entries={workflowChanges.entries} when={when} />}
      {loadedRecipes && loadedRecipes.entries.length > 0 && <LoadedRecipes entries={loadedRecipes.entries} when={when} />}
      {machineStates && machineStates.entries.length > 0 && <MachineStates entries={machineStates.entries} when={when} />}
      {data && page && page.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {first}–{last} of {page.total}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
              Newer
            </Button>
            <Button variant="outline" size="sm" disabled={last >= page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
              Older
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The dial-in trail: when each entry began, what it is, what changed, from what to what, the Recipe loaded then, and who made it. */
function Trail({ entries, when }: { entries: TrailEntry[]; when: When }) {
  return (
    <Table aria-label="Dial-in trail">
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>What</TableHead>
          <TableHead>Changes</TableHead>
          <TableHead>Loaded Recipe</TableHead>
          <TableHead>Made by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry, n) => (
          // Each cell from the top, as the Workflow in effect runs to many lines.
          <TableRow key={`${entry.observedAt} ${n}`}>
            <TableCell className="align-top">{when(entry.observedAt)}</TableCell>
            <TableCell className="align-top whitespace-normal">
              {TRAIL_KINDS[entry.kind]}
              {entry.replaced && (
                <>
                  , replacing <RecipeLink recipe={entry.replaced} />
                </>
              )}
            </TableCell>
            <TableCell className="min-w-56 align-top whitespace-normal">
              <ul className="grid gap-0.5">
                {trailLines(entry).map(({ label, before, after }) => (
                  <li key={label}>
                    <span className="text-muted-foreground">{label}:</span>{" "}
                    {before && (
                      <>
                        <Value value={before} /> to{" "}
                      </>
                    )}
                    <Value value={after} />
                  </li>
                ))}
              </ul>
            </TableCell>
            <TableCell className="align-top whitespace-normal">
              {entry.loadedRecipe ? <RecipeLink recipe={entry.loadedRecipe} /> : <span className="text-muted-foreground">None</span>}
            </TableCell>
            <TableCell className="align-top whitespace-normal">{madeBy(entry)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A value of a trail entry's line, linked to the Library item it names, if any. */
function Value({ value }: { value: TrailValue }) {
  if (value.to === undefined) return value.text;
  return (
    <Link to={value.to} className="underline underline-offset-4">
      {value.text}
    </Link>
  );
}

function RecipeLink({ recipe }: { recipe: TrailRecipe }) {
  return (
    <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="underline underline-offset-4">
      {recipe.name ?? "Unnamed Recipe"}
    </Link>
  );
}

/** Each Recipe the Machine had loaded at any time in the day, latest loaded first. */
function LoadedRecipes({ entries, when }: { entries: LoadedRecipe[]; when: When }) {
  return (
    <Table aria-label="Loaded Recipes that day">
      <TableHeader>
        <TableRow>
          <TableHead>Recipe</TableHead>
          <TableHead>Loaded</TableHead>
          <TableHead>Unloaded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>
              <LoadedRecipeLink loaded={entry} />
            </TableCell>
            <TableCell>{when(entry.loadedAt)}</TableCell>
            <TableCell>{entry.unloadedAt ? when(entry.unloadedAt) : "Still loaded"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Each Machine State the Machine went into, latest first, the last the one it was in as the day began. */
function MachineStates({ entries, when }: { entries: MachineStateEvent[]; when: When }) {
  return (
    <Table aria-label="Machine States that day">
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Machine State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{when(entry.observedAt)}</TableCell>
            <TableCell>{describeMachineState(entry)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
