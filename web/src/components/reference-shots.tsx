import { type FormEvent, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useMayChange } from "@/auth";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { ConfirmButton, useLocations } from "@/components/machines";
import { profilePath } from "@/components/profiles";
import { OrNone, recordTime, secondsText } from "@/components/records";
import { gramsText } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type ListedShot, type Recipe, type Shot } from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";

// A Recipe's Reference Shot (ADR-0029): the one Shot chosen to show how its
// Shots should go, from any Machine or Location. Its card on the Recipe's
// page, cleared there; the control on a Shot's page that makes the Shot one,
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

/**
 * The Recipe page's Reference Shot card: the Shot, linked, with its dose,
 * yield and duration and when and where it was pulled, a note where its
 * Profile is another than the Recipe's, and, for whoever may edit the
 * Recipe, a control to clear it.
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

  return (
    <Card role="region" aria-label="Reference Shot">
      <CardHeader>
        <CardTitleWithInfo title="Reference Shot">
          <p>
            The one Shot chosen to show how this Recipe's Shots should go. It can be any Shot, from any Machine or Location, and stays through
            edits to the Recipe until someone chooses another or clears it. Choose one from a Shot's page. Nothing of it reaches a tablet.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <FormError error={error} />}
        {shot === null ? (
          <p className="text-sm text-muted-foreground">None chosen.</p>
        ) : (
          <>
            {shot.profileDiffers && (
              <Alert role="status" aria-label="Another Profile">
                <AlertDescription>
                  It was pulled on {shot.profile?.title ?? shot.profileTitle ?? "a Profile the Library doesn't have"}, not the Recipe's Profile,{" "}
                  {recipe.uses.profile?.title ?? "untitled"}, so its curves describe another program.
                </AlertDescription>
              </Alert>
            )}
            <Fields label="Reference Shot">
              <Field term="Pulled">
                <Link to={`/shots/${encodeURIComponent(shot.id)}`} className="underline-offset-4 hover:underline">
                  {recordTime(shot.pulledAt, shot)}
                </Link>
              </Field>
              <Field term="Machine">
                {shot.machine ? (
                  <Link to={`/machines/${shot.machine.id}`} className="underline-offset-4 hover:underline">
                    {shot.machine.name}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">A Pending Machine</span>
                )}
              </Field>
              <Field term="Location">
                <OrNone>{shot.location?.name}</OrNone>
              </Field>
              <Field term="Profile">
                {shot.profile ? (
                  <Link to={profilePath(shot.profile.id)} className="underline-offset-4 hover:underline">
                    {shot.profileTitle ?? shot.profile.title ?? "Untitled Profile"}
                  </Link>
                ) : (
                  <OrNone>{shot.profileTitle ?? undefined}</OrNone>
                )}
              </Field>
              <Field term="Dose">
                <OrNone>{gramsText(shot.actualDose, shot.targetDose)}</OrNone>
              </Field>
              <Field term="Yield">
                <OrNone>{gramsText(shot.actualYield, shot.targetYield)}</OrNone>
              </Field>
              <Field term="Duration">
                <OrNone>{secondsText(shot.duration)}</OrNone>
              </Field>
            </Fields>
            {mayChange && (
              <div>
                <ConfirmButton
                  label="Clear"
                  ariaLabel="Clear its Reference Shot"
                  title={`Clear ${recipeName(recipe)}'s Reference Shot?`}
                  description="The Recipe has no Reference Shot until someone chooses another from a Shot's page. The Shot itself is kept, and nothing changes on tablets."
                  confirmLabel="Clear it"
                  onConfirm={() => void clear()}
                />
              </div>
            )}
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
  const mayChange = useMayChange();
  const references = shot.referenceOf ?? [];
  if (references.length === 0 && !mayChange) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
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
        <Button variant="outline">Make it a Reference Shot</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make it a Reference Shot</DialogTitle>
          <DialogDescription>
            A Recipe's Reference Shot shows how its Shots should go. It has one, so this replaces any it has. Nothing changes on tablets.
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
