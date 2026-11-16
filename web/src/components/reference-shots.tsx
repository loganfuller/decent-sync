import { type FormEvent, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useIsAdmin, useStaffLocationIds } from "@/auth";
import { SmallCurve } from "@/components/curves";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { ConfirmButton, useLocations } from "@/components/machines";
import { recordTime, secondsText } from "@/components/records";
import { Stars, gramsText } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type ListedShot, type Recipe, type Shot } from "@/lib/api";
import { SHOT_CURVES, type Sample, type ShotCurve, shotSamples } from "@/lib/curves";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { ratedShotsPath } from "@/lib/shot-list";
import { signedText } from "@/lib/shot-summary";

// A Recipe's Reference Shot (ADR-0029): the one Shot chosen to show how its
// Shots should go, from any Machine or Location. Its card on the Recipe's
// page, with its curves in small, cleared there; the control on a Shot's page that makes the Shot one,
// offering the Shot's own Recipe first; and the Shots list's mark of one. It
// is the server's alone, so choosing or clearing it changes nothing on
// tablets. Whoever may edit the Recipe chooses and clears it.

/** A Recipe's name as lists show it. */
function recipeName(recipe: { name: string | null }): string {
  return recipe.name ?? "Unnamed Recipe";
}

/** The Recipes a Shot is the Reference Shot of, each linked, with its Location. */
function ReferenceOfLinks({ recipes }: { recipes: NonNullable<ListedShot["referenceOf"]> }) {
  return (
    <>
      {recipes.map((recipe, index) => (
        <span key={recipe.id}>
          {index > 0 && ", "}
          <Link to={`${LIBRARY_KINDS.recipe.pages}/${recipe.id}`} className="underline-offset-4 hover:underline">
            {recipeName(recipe)}
          </Link>
          {recipe.location && ` at ${recipe.location.name}`}
        </span>
      ))}
    </>
  );
}

/** The Shots list's mark of a Shot that is a Recipe's Reference Shot, naming those Recipes in its tip. */
export function ReferenceMark({ shot }: { shot: ListedShot }) {
  if (!shot.referenceOf) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary">Reference</Badge>
      <InfoTip label="About Reference">
        <p>
          The Reference Shot of <ReferenceOfLinks recipes={shot.referenceOf} />.
        </p>
      </InfoTip>
    </span>
  );
}

/** The curves a Reference Shot's card draws in small. */
const CARD_CURVES = ["pressure", "flow", "weight"] as const satisfies readonly ShotCurve[];

/**
 * A Reference Shot's pressure, flow and weight curves in small, side by
 * side, read once for each Shot: a Shot's curves never change.
 */
function ReferenceCurves({ shotId }: { shotId: string }) {
  const [read, setRead] = useState<{ id: string; samples?: Sample<ShotCurve>[]; error?: string }>();
  useEffect(() => {
    let current = true;
    api<{ measurements: unknown }>("GET", `/shots/${encodeURIComponent(shotId)}/measurements`).then(
      ({ measurements }) => current && setRead({ id: shotId, samples: shotSamples(measurements) }),
      (caught: unknown) => current && setRead({ id: shotId, error: failure(caught, "Its curves could not be loaded") }),
    );
    return () => {
      current = false;
    };
  }, [shotId]);
  const shown = read?.id === shotId ? read : undefined;
  if (shown?.error) return <FormError error={shown.error} />;
  return (
    <div className="grid grid-cols-3 gap-2" aria-busy={!shown}>
      {CARD_CURVES.map((curve) =>
        shown?.samples ? (
          <SmallCurve key={curve} curve={curve} info={SHOT_CURVES[curve]} samples={shown.samples} label={`${SHOT_CURVES[curve].label} curve of the Reference Shot`} />
        ) : (
          // As tall as a curve and its name, so the card keeps its height as they arrive.
          <div key={curve} className="h-[4.75rem]" />
        ),
      )}
    </div>
  );
}

/**
 * The Recipe page's Reference Shot card (#547): the Shot's pressure, flow
 * and weight curves in small, its duration and its yield against its own
 * target, its rating, when and where it was pulled and its grind setting,
 * with a note where its Profile is another than the Recipe's, and a way to
 * open it. Whoever may edit the Recipe is led to its rated Shots to choose
 * another, unless it is Archived, and clears it here. A Recipe with none says so, and leads to
 * its rated Shots too.
 */
export function ReferenceShotCard({ recipe, mayChange, onChanged }: { recipe: Recipe; mayChange: boolean; onChanged(): void }) {
  const shot = recipe.referenceShot ?? null;
  const [error, setError] = useState<string>();

  async function clear() {
    setError(undefined);
    try {
      await api("PUT", `/recipes/${recipe.id}/reference-shot`, { shotId: null });
      onChanged();
    } catch (caught) {
      setError(failure(caught, "The Reference Shot could not be cleared"));
    }
  }

  const againstTarget = shot && shot.actualYield !== null && shot.targetYield !== null ? `${signedText(shot.actualYield - shot.targetYield)} g vs target` : undefined;
  const went = shot ? [secondsText(shot.duration), againstTarget ?? gramsText(shot.actualYield, shot.targetYield)].filter((part) => part !== undefined) : [];
  const rated = shot?.enjoyment != null && shot.enjoyment !== 0;

  return (
    <Card role="region" aria-label="Reference Shot">
      <CardHeader>
        <CardTitleWithInfo title="Reference Shot">
          <p>
            The one Shot chosen to show how this Recipe's Shots should go. It can be any Shot, from any Machine or Location, and stays through
            edits to the Recipe until someone chooses another or clears it. Choose one from a Shot's page. A Skin on a tablet at the Recipe's
            Location draws it, and each of those tablets keeps a copy for when the server can't be reached, while the Recipe is in a Recipe Slot.
            A Skin may choose it on a tablet there too: the Recipe's history then names the Machine it was chosen on.
          </p>
          <p>Its curves are its pressure, flow and weight from the start of its profile. Its yield is against its own target.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && <FormError error={error} />}
        {shot === null ? (
          <p className="text-sm text-muted-foreground">
            None chosen.{" "}
            <Link to={ratedShotsPath(recipe.id)} className="underline decoration-dotted underline-offset-4">
              Its rated Shots
            </Link>
          </p>
        ) : (
          <>
            {shot.profileDiffers && (
              <Alert role="status" aria-label="Another Profile">
                <AlertDescription>
                  {/* The Recipe's Profile is named where the Library has it with a title: one it no longer has has none either. */}
                  It was pulled on {shot.profile?.title ?? shot.profileTitle ?? "a Profile the Library doesn't have"}, not the Recipe's Profile
                  {recipe.uses.profile?.title ? `, ${recipe.uses.profile.title},` : ","} so its curves describe another program.
                </AlertDescription>
              </Alert>
            )}
            <ReferenceCurves shotId={shot.id} />
            <div className="grid gap-1 text-sm">
              <p className="font-semibold tabular-nums">{went.length > 0 ? went.join(" · ") : "No duration or yield recorded"}</p>
              {/* The previous release's answer during a deploy gives no rating (ADR-0025): nothing is said of it. */}
              {shot.enjoyment !== undefined && <p>{rated ? <Stars rating={shot.enjoyment} /> : <span className="text-muted-foreground">Not rated</span>}</p>}
              <p className="text-muted-foreground">
                Pulled {recordTime(shot.pulledAt, shot)} on{" "}
                {shot.machine ? (
                  <Link to={`/machines/${shot.machine.id}`} className="underline-offset-4 hover:underline">
                    {shot.machine.name}
                  </Link>
                ) : (
                  "a Pending Machine"
                )}
                {shot.location && ` at ${shot.location.name}`}
                {shot.grinderSetting != null && ` · grind ${shot.grinderSetting}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to={`/shots/${encodeURIComponent(shot.id)}`} aria-label="Open its Reference Shot">
                  Open
                </Link>
              </Button>
              {mayChange && (
                <>
                  {/* An Archived Recipe's may be cleared, but none is chosen for it until it is restored. */}
                  {!recipe.archived && (
                    <Button asChild variant="outline">
                      <Link to={ratedShotsPath(recipe.id)}>Choose another</Link>
                    </Button>
                  )}
                  <ConfirmButton
                    label="Clear"
                    ariaLabel="Clear its Reference Shot"
                    title={`Clear ${recipeName(recipe)}'s Reference Shot?`}
                    description="The Recipe has no Reference Shot until someone chooses another from a Shot's page. The Shot itself is kept. Tablets at the Recipe's Location stop drawing it."
                    confirmLabel="Clear it"
                    onConfirm={() => void clear()}
                  />
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A Recipe a Shot can be made the Reference Shot of, with the Location it belongs to. */
interface Choice {
  recipe: Recipe;
  locationName: string;
}

/**
 * The Recipes the person may make the Shot the Reference Shot of: those not
 * Archived at each Location they change Recipes at, and not those it is the
 * Reference Shot of already. Loaded once `load` is set, as the dialog opens.
 */
function useChoices(shot: Shot, load: boolean): { choices: Choice[] | undefined; error: string | undefined } {
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [choices, setChoices] = useState<Choice[]>();
  const [error, setError] = useState<string>();
  const changeable = locations?.filter((location) => mayChangeAt(location.id));
  const key = changeable?.map((location) => location.id).join(",");

  useEffect(() => {
    if (!load || !changeable) return;
    let current = true;
    Promise.all(
      changeable.map(async (location) => {
        const { recipes } = await api<{ recipes: Recipe[] }>("GET", `/locations/${location.id}/recipes`);
        return recipes.map((recipe) => ({ recipe, locationName: location.name }));
      }),
    ).then(
      (each) => {
        if (!current) return;
        const already = new Set((shot.referenceOf ?? []).map((recipe) => recipe.id));
        setChoices(each.flat().filter(({ recipe }) => !recipe.archived && !already.has(recipe.id)));
      },
      (caught: unknown) => current && setError(failure(caught, "The Recipes could not be loaded")),
    );
    return () => {
      current = false;
    };
    // The Locations' ids stand for them, so a list read again with the same ones loads nothing more.
  }, [load, key, shot.referenceOf]);

  return { choices, error: locationsError ?? error };
}

/**
 * Says which Recipes the Shot is the Reference Shot of, if any, and offers
 * whoever may edit a Recipe to make it one: its own Recipe first, then the
 * others they may edit, by Location. A Recipe has one Reference Shot, so
 * this replaces any it has.
 */
export function ReferenceShotControl({ shot, onChanged }: { shot: Shot; onChanged(): void }) {
  // An Admin changes Recipes anywhere, and Staff at the Locations they work at, if any.
  const isAdmin = useIsAdmin();
  const staffLocations = useStaffLocationIds();
  const mayChange = isAdmin || staffLocations.size > 0;
  const references = shot.referenceOf ?? [];
  if (references.length === 0 && !mayChange) return null;
  return (
    // Beside the Shot's title, and under it, as wide as the page, on a narrow screen.
    <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
      {references.length > 0 && (
        <p className="text-sm">
          <Badge variant="secondary">Reference Shot</Badge> of <ReferenceOfLinks recipes={references} />
        </p>
      )}
      {mayChange && <ChooseReferenceDialog shot={shot} onChosen={onChanged} />}
    </div>
  );
}

// A Select's value for no Recipe chosen yet, which no Recipe's id can be.
const UNCHOSEN = "";

function ChooseReferenceDialog({ shot, onChosen }: { shot: Shot; onChosen(): void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const { choices, error: loadError } = useChoices(shot, open);
  const [chosen, setChosen] = useState(UNCHOSEN);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const own = choices?.find(({ recipe }) => recipe.id === shot.recipe?.id);
  const others = (choices ?? []).filter((choice) => choice !== own);
  const byLocation = [...new Set(others.map((choice) => choice.locationName))].map((locationName) => ({
    locationName,
    choices: others.filter((choice) => choice.locationName === locationName),
  }));
  // Its own Recipe is chosen to begin with, where it is offered.
  useEffect(() => {
    if (open && own && chosen === UNCHOSEN) setChosen(own.recipe.id);
  }, [open, own, chosen]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen === UNCHOSEN) return setError("Choose the Recipe");
    setError(undefined);
    setSaving(true);
    try {
      await api("PUT", `/recipes/${chosen}/reference-shot`, { shotId: shot.id });
      setOpen(false);
      setChosen(UNCHOSEN);
      onChosen();
    } catch (caught) {
      setError(failure(caught, "The Reference Shot could not be chosen"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setChosen(UNCHOSEN);
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="max-sm:w-full">
          Make it a Reference Shot
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make it a Reference Shot</DialogTitle>
          <DialogDescription>
            A Recipe's Reference Shot shows how its Shots should go. It has one, so this replaces any it has. Tablets at the Recipe's Location draw it
            from then on.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          {(error ?? loadError) && <FormError error={error ?? loadError} />}
          {choices === undefined && !loadError && <p className="text-sm text-muted-foreground">Loading the Recipes…</p>}
          {choices?.length === 0 && <p className="text-sm text-muted-foreground">There is no other Recipe you may change that it could be the Reference Shot of.</p>}
          {choices !== undefined && choices.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-recipe`}>Recipe</Label>
              <Select value={chosen} onValueChange={setChosen}>
                <SelectTrigger id={`${id}-recipe`} className="w-full">
                  <SelectValue placeholder="Choose a Recipe" />
                </SelectTrigger>
                <SelectContent>
                  {own && (
                    <SelectGroup>
                      <SelectLabel>Pulled with</SelectLabel>
                      <SelectItem value={own.recipe.id}>
                        {recipeName(own.recipe)} at {own.locationName}
                      </SelectItem>
                    </SelectGroup>
                  )}
                  {byLocation.map((group) => (
                    <SelectGroup key={group.locationName}>
                      <SelectLabel>At {group.locationName}</SelectLabel>
                      {group.choices.map(({ recipe }) => (
                        <SelectItem key={recipe.id} value={recipe.id}>
                          {recipeName(recipe)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Button type="submit" disabled={saving || !choices || choices.length === 0}>
              Make it the Reference Shot
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
