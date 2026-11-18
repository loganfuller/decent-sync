import { profileOf } from "@decent-sync/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { CollapsibleCard } from "@/components/collapsible-card";
import { Curves } from "@/components/curves";
import { CardTitleWithInfo } from "@/components/info-tip";
import { describeHardware } from "@/components/machines";
import { ReferenceShotControl } from "@/components/reference-shots";
import type { ListState } from "@/components/record-lists";
import { Measurements, SentRecord } from "@/components/records";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { ShotEditsCard } from "@/components/shot-edits";
import { HowItWentCard, ShotComparison, ShotDetailsCard } from "@/components/shot-page";
import { shotTime } from "@/components/shots";
import { record } from "@/components/workflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ApiError, api, type Recipe, type Shot } from "@/lib/api";
import { SHOT_CURVES, type Sample, type ShotCurve, shotSamples } from "@/lib/curves";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { STATUS_POLL_MS } from "@/lib/use-polled";

interface ShotData {
  shot: Shot;
  samples: Sample<ShotCurve>[];
}

/** What a Shot's curves are drawn over: its Recipe's Reference Shot's, those of the Shot before it on its Machine, or nothing. */
type Compared = "reference" | "previous" | "nothing";

/** How each Shot compared with is named: in the curves' legends and tooltips, and in the comparison under them. */
const COMPARED = {
  reference: { label: "Reference Shot", comparison: "Comparison with the Reference Shot" },
  previous: { label: "Previous Shot", comparison: "Comparison with the previous Shot" },
} as const;

/**
 * One Shot, in the order a reader asks (#546): which Shot it is, its Recipe
 * and Machine in its title; how it went, in one card of figures, where its
 * rating and note are edited (#514, ADR-0031); its curves, drawn over its
 * Recipe's Reference Shot's when the page opens (#473), with the two Shots
 * side by side under them; and then everything else, once each, in cards
 * closed until opened: its Details, its measurements, the edits of its
 * rating and note, and its record as sent. Beside the title it says which
 * Recipes it is the Reference Shot of, with a control making it one.
 */
export function ShotPage() {
  const { id = "" } = useParams();
  // Keyed, so a comparison chosen for one Shot never carries over to the next one opened.
  return <ShotDetails key={id} id={id} />;
}

async function loadShot(id: string): Promise<ShotData> {
  const path = `/shots/${encodeURIComponent(id)}`;
  // A Shot never changes its curves, only its metadata. It is read again only while an edit of it awaits its tablet.
  const [{ shot }, { measurements }] = await Promise.all([
    api<{ shot: Shot }>("GET", path),
    api<{ measurements: unknown }>("GET", `${path}/measurements`),
  ]);
  return { shot, samples: shotSamples(measurements, profileOf(record(shot.record.workflow)?.profile)) };
}

function ShotDetails({ id }: { id: string }) {
  const state = useLocation().state as ListState | null;
  const [data, setData] = useState<ShotData>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // What the person chose to compare it with; until they choose, it is its Recipe's Reference Shot, where there is one.
  const [chosen, setChosen] = useState<Compared>();
  // Each Shot it has been compared with, by its id, so one is read once: a Map, as an id may be any text.
  const [others, setOthers] = useState<ReadonlyMap<string, ShotData>>(new Map());
  // Why a Shot it was compared with could not be loaded, by that Shot's id: shown while it is the one compared with, until it is read again.
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  // Its Recipe as last read, by the id read: null for one that could not be read, or was deleted since.
  const [recipeRead, setRecipeRead] = useState<{ id: string; recipe: Recipe | null }>();
  // Why its Recipe's Reference Shot isn't offered, where its Recipe could not be read: apart from a comparison's own failure.
  const [referenceError, setReferenceError] = useState<string>();
  // Counts the times the Shot was read again or edited, so an answer that arrives after a later one's changes nothing:
  // a read begun before an edit would otherwise show the Shot as it was before it.
  const shotReads = useRef(0);
  /** The Shot as the server read it just now, its curves kept, unless a later read or edit has been asked for since `read`. */
  const show = useCallback((shot: Shot, read: number) => {
    // An answer without its edits is the previous release's, as during a deploy (ADR-0025): what is shown stays.
    if (shotReads.current === read && shot.edits !== undefined) setData((loaded) => loaded && { ...loaded, shot });
  }, []);
  const reread = useCallback(async () => {
    const read = ++shotReads.current;
    const { shot } = await api<{ shot: Shot }>("GET", `/shots/${encodeURIComponent(id)}`);
    show(shot, read);
  }, [id, show]);
  // Making it a Reference Shot changes what it says of that, so the Shot is read again, its curves kept.
  const changed = useCallback(() => {
    reread().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "The Shot could not be loaded"));
  }, [reread]);
  // While an edit awaits its tablet, the Shot is read again, as often as a Machine's status is, until the tablet has
  // it: each read once the last was answered, and a read that fails is left to the next.
  const awaitingTablet = data?.shot.editStanding === "awaitingTablet";
  useEffect(() => {
    if (!awaitingTablet) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const wait = () => {
      timer = setTimeout(() => {
        void (document.hidden ? Promise.resolve() : reread().catch(() => undefined)).then(() => {
          if (!stopped) wait();
        });
      }, STATUS_POLL_MS);
    };
    wait();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [awaitingTablet, reread]);

  useEffect(() => {
    let current = true;
    loadShot(id).then(
      (loaded) => current && setData(loaded),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Shot could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  // Its Recipe, for the Reference Shot it has and the Recipe Slot it is in: read with the Shot, and again when the Shot
  // becomes its own Recipe's Reference Shot, or stops being it.
  const recipeId = data?.shot.recipe?.id;
  const isOwnReference = data?.shot.referenceOf?.some((recipe) => recipe.id === recipeId) ?? false;
  useEffect(() => {
    setReferenceError(undefined);
    if (recipeId === undefined) return;
    let current = true;
    api<{ recipe: Recipe }>("GET", `/recipes/${encodeURIComponent(recipeId)}`).then(
      ({ recipe }) => current && setRecipeRead({ id: recipeId, recipe }),
      (caught: unknown) => {
        if (!current) return;
        setRecipeRead({ id: recipeId, recipe: null });
        // A Recipe deleted since is one with no Reference Shot.
        if (!(caught instanceof ApiError && caught.status === 404)) setReferenceError(caught instanceof Error ? caught.message : "The Recipe could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [recipeId, isOwnReference]);
  // What it may be compared with is settled once its Recipe has been read, where it has one.
  const read = recipeRead?.id === recipeId ? recipeRead : undefined;
  const settled = data !== undefined && (recipeId === undefined || read !== undefined);
  const recipe = read?.recipe ?? undefined;
  // Its Recipe's Reference Shot: none for a Shot pulled with no Recipe, a Recipe with none, or one whose Reference Shot
  // is hidden, and none for that Shot itself, which has no other to compare with.
  const referenceId = isOwnReference || !recipe?.referenceShot || recipe.referenceShot.id === id ? undefined : recipe.referenceShot.id;

  const comparable = { reference: referenceId, previous: data?.shot.previousShot?.id };
  // Its Reference Shot when the page opens, where it has one, and otherwise nothing, until the person chooses. A
  // choice of a Shot there no longer is, as its Reference Shot once it becomes that itself, is one of nothing.
  const wanted = chosen ?? (referenceId !== undefined ? "reference" : "nothing");
  const compared = wanted !== "nothing" && comparable[wanted] !== undefined ? wanted : "nothing";
  const comparedId = compared === "nothing" ? undefined : comparable[compared];
  // The Shot compared with is read once it is the one compared with, and again, after a read that failed, at the next
  // choice of it: under another name too, as where its Recipe's Reference Shot is also the Shot before it. A read
  // still under way is not begun again, and its answer is kept whatever is compared with by then.
  const reading = useRef(new Set<string>());
  useEffect(() => {
    if (comparedId === undefined || others.has(comparedId) || reading.current.has(comparedId)) return;
    reading.current.add(comparedId);
    setFailures((failed) => new Map([...failed].filter(([id]) => id !== comparedId)));
    loadShot(comparedId)
      .then(
        (other) => setOthers((loaded) => new Map(loaded).set(comparedId, other)),
        (caught: unknown) => setFailures((failed) => new Map(failed).set(comparedId, caught instanceof Error ? caught.message : "The Shot it is compared with could not be loaded")),
      )
      .finally(() => reading.current.delete(comparedId));
    // Only a change of what it is compared with reads one: `others` changes as each arrives.
  }, [comparedId, compared]);

  const back = (
    <Link to={`/shots${state?.list ?? ""}`} className="text-sm text-muted-foreground hover:text-foreground">
      ← Shots
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Shot. Its Pending Machine may have been dismissed.</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="grid gap-4">
        {back}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  const { shot, samples } = data;
  const other = comparedId === undefined ? undefined : others.get(comparedId);
  const failure = comparedId === undefined ? undefined : failures.get(comparedId);
  const shown = compared !== "nothing" && other ? { ...COMPARED[compared], ...other } : undefined;
  // Only what the Shot has is offered.
  const choices: [Compared, string][] = [];
  if (comparable.reference !== undefined) choices.push(["reference", "Reference Shot"]);
  if (comparable.previous !== undefined) choices.push(["previous", `Previous Shot on this ${shot.machine ? "Machine" : "Pending Machine"}`]);
  choices.push(["nothing", "Nothing"]);
  return (
    <section className="grid grid-cols-1 gap-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {/* No wider than the page, so a long name wraps, within a word where it must. */}
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-2xl font-semibold wrap-anywhere">
              {shot.recipe ? (
                <Link to={`${LIBRARY_KINDS.recipe.pages}/${shot.recipe.id}`} className="underline-offset-4 hover:underline">
                  {shot.recipe.name ?? "Unnamed Recipe"}
                </Link>
              ) : (
                "No Recipe loaded"
              )}{" "}
              on{" "}
              {shot.machine ? (
                <Link to={`/machines/${shot.machine.id}`} className="underline-offset-4 hover:underline">
                  {shot.machine.name}
                </Link>
              ) : shot.pendingMachine ? (
                describeHardware(shot.pendingMachine)
              ) : (
                "no Machine"
              )}
            </h1>
            {!shot.machine && shot.pendingMachine && <Badge variant="secondary">Pending Machine</Badge>}
          </div>
          <p className="text-muted-foreground tabular-nums wrap-anywhere">
            {shotTime(shot)} · {shot.location?.name ?? "No Location, times in UTC"}
          </p>
        </div>
        <ReferenceShotControl shot={shot} onChanged={changed} />
      </div>

      {shot.machineInferred && (
        <Alert>
          <AlertTitle>Inferred credit</AlertTitle>
          <AlertDescription>
            This Shot recorded no machine hardware, so it is credited to {shot.machine?.name ?? "the Machine"}, whose tablet
            reported it.
            {shot.locationInferred && ` Its Location, ${shot.location!.name}, comes from that Machine's Location History, so it is inferred too.`}
          </AlertDescription>
        </Alert>
      )}

      <HowItWentCard
        shot={shot}
        reference={isOwnReference ? "own" : recipe?.referenceShot === null ? "none" : undefined}
        onEdited={(edited) => show(edited, ++shotReads.current)}
      />

      <Card role="region" aria-label="Curves">
        <CardHeader className="gap-3 max-sm:grid-cols-1 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
          <CardTitleWithInfo title="Curves">
            <p>
              Seconds from the start of the Shot's profile. Dashed lines are the targets the Machine reported. Flow is the pump's, and weight
              flow the rate coffee lands in the cup, as the scale measured it. Temperature is the group temperature, measured at the group
              head, the sensor closest to the coffee.
            </p>
            <p>
              Grey vertical lines mark where the profile moved from one step to another. The measurements table names each sample's step.
            </p>
            <p>
              Preheat, shaded before 0 s, is the Machine heating its water before the profile starts. Its targets are the heater test's, not the
              profile's, and it doesn't count toward the duration or the peaks.
            </p>
          </CardTitleWithInfo>
          {settled && choices.length > 1 && (
            <div className="flex min-w-0 items-center gap-2.5 max-sm:grid max-sm:grid-cols-1 max-sm:gap-1.5">
              <span className="text-muted-foreground max-sm:text-[0.8125rem]">Compare with</span>
              {/* On a narrow screen it scrolls within its own row, to the card's edges. */}
              <div className="min-w-0 overflow-x-auto py-0.5 max-sm:-mx-(--card-spacing) max-sm:px-(--card-spacing)">
                {/* It always has a choice, so pressing the one chosen changes nothing. */}
                <Segmented label="Compare with" value={compared} onValueChange={(choice) => choice && setChosen(choice as Compared)} className="whitespace-nowrap">
                  {choices.map(([choice, label]) => (
                    <SegmentedItem key={choice} value={choice}>
                      {label}
                    </SegmentedItem>
                  ))}
                </Segmented>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6">
          {settled && choices.length === 1 && (
            <p className="text-sm text-muted-foreground">There is no earlier Shot on {shot.machine?.name ?? "this Pending Machine"} to compare it with.</p>
          )}
          {referenceError && (
            <Alert variant="destructive">
              <AlertDescription>Its Recipe's Reference Shot could not be read, so it is not offered here: {referenceError}</AlertDescription>
            </Alert>
          )}
          {failure !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          {samples.length > 0 ? (
            <Curves curves={SHOT_CURVES} label="This Shot" current={samples} previous={shown && { label: shown.label, samples: shown.samples }} />
          ) : (
            <p className="text-sm text-muted-foreground">No measurements were recorded.</p>
          )}
          {shown && <ShotComparison shot={shot} other={shown.shot} label={shown.label} name={shown.comparison} />}
        </CardContent>
      </Card>

      <ShotDetailsCard shot={shot} samples={samples} recipe={recipe} />

      <CollapsibleCard
        title="Measurements"
        info={
          <p>
            Each sample its tablet recorded, {samples.length} of them, as recorded, for reading exact values. Those in its Preheat are marked, and
            each names the step of its Profile it was in.
          </p>
        }
      >
        {/* One column that may shrink below what it holds, so a wide table or a long line scrolls in its box rather than widening the page. */}
        <CardContent className="grid grid-cols-1">
          {samples.length > 0 ? (
            <Measurements curves={SHOT_CURVES} samples={samples} steps />
          ) : (
            <p className="text-sm text-muted-foreground">No measurements were recorded.</p>
          )}
        </CardContent>
      </CollapsibleCard>

      <ShotEditsCard shot={shot} />

      <CollapsibleCard title="Record as sent" info={<p>Everything its tablet sent about it, but its measurements.</p>}>
        <CardContent className="grid grid-cols-1">
          <SentRecord record={shot.record} />
        </CardContent>
      </CollapsibleCard>
    </section>
  );
}
