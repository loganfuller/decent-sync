import type { Profile as ProfileDefinition } from "@decent-sync/protocol";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { formatTime, useLocations } from "@/components/machines";
import { profilePath, profileTitle } from "@/components/profiles";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { type Draft, type Profile, type Published, type RecipeOnProfile, api } from "@/lib/api";
import { differences } from "@/lib/profile-words";
import { definitionOf } from "@/pages/ProfilePage";

// The dialog that publishes a Draft, and returns a Profile to an earlier
// version, through the same choices (#580): what changed, the Locations to
// show it at, a new version's starting with those that showed the one
// before, and the Recipes naming the one it replaces, by Location, each
// with the Machines that have it loaded now, to move to it. It says, for
// each Location chosen, whether the one replaced is hidden there or stays
// shown for a Recipe not moved; and, for a Draft whose source gained a
// newer version since it began, that publishing forks the chain, with how
// that version differs from the Draft. Staff choose only their Locations.

/** What the dialog publishes: a Draft, as it stands now, or a return to an earlier version of a Profile. */
export type PublishTarget =
  | {
      kind: "draft";
      draft: Draft;
      /** The Draft's profile as the page has it now, which it has saved. */
      profile: ProfileDefinition;
      /** The Draft's count of saves as the page has saved it. */
      saves(): number;
    }
  | {
      kind: "return";
      /** The earlier version returned to. */
      to: { id: string; name: string };
      /** The later version, whose page this is. */
      from: Profile;
    };

/** The Profile a target replaces, if any: a new version's source, or the later version returned from. */
function replacedId(target: PublishTarget): string | null {
  if (target.kind === "return") return target.from.id;
  return target.draft.publishesAs === "version" ? (target.draft.startedFrom?.id ?? null) : null;
}

export function PublishDialog({
  target,
  label,
  ariaLabel,
  disabled,
  onPublished,
}: {
  target: PublishTarget;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  onPublished(published: Published): void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const replaces = replacedId(target);
  // What it replaces, its Recipes and, for a Draft, the newer versions' profiles; read once the dialog opens.
  const [replaced, setReplaced] = useState<Profile | null>();
  const [recipes, setRecipes] = useState<RecipeOnProfile[]>();
  const [to, setTo] = useState<ProfileDefinition | null>();
  // For a separate Profile, which replaces none, the one it started from, to say what changed.
  const [startedFrom, setStartedFrom] = useState<Profile | null>(null);
  const [newer, setNewer] = useState<{ id: string; title: string | null; savedAt: string; profile: ProfileDefinition | null }[]>([]);
  const [chosenLocations, setChosenLocations] = useState<Set<string>>();
  const [chosenRecipes, setChosenRecipes] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();

  const draftNewer = target.kind === "draft" ? target.draft.newer : undefined;
  const returnTo = target.kind === "return" ? target.to.id : undefined;
  const comparedTo = target.kind === "draft" && !replaces ? (target.draft.startedFrom?.id ?? null) : null;
  useEffect(() => {
    if (!open) return;
    let current = true;
    const failed = (caught: unknown) => current && setLoadError(failure(caught, "What it replaces could not be loaded"));
    if (replaces) {
      const path = `/profiles/${encodeURIComponent(replaces)}`;
      Promise.all([api<{ profile: Profile }>("GET", path), api<{ recipes: RecipeOnProfile[] }>("GET", `${path}/recipes`)]).then(([{ profile }, { recipes }]) => {
        if (!current) return;
        setReplaced(profile);
        setRecipes(recipes);
        // A new version, and a return, start with the Locations that showed the one it replaces, and their Recipes on it.
        const shown = new Set(profile.locations.filter((here) => here.shown && mayChangeAt(here.location.id)).map((here) => here.location.id));
        setChosenLocations((chosen) => chosen ?? shown);
        setChosenRecipes(new Set(recipes.filter(({ recipe }) => recipe.location && shown.has(recipe.location.id)).map(({ recipe }) => recipe.id)));
      }, failed);
    } else {
      setReplaced(null);
      setRecipes([]);
      setChosenLocations((chosen) => chosen ?? new Set());
    }
    // Only to compare: a source since Archived or gone leaves nothing to compare, and publishing is not held up for it.
    if (comparedTo) api<{ profile: Profile }>("GET", `/profiles/${encodeURIComponent(comparedTo)}`).then(({ profile }) => current && setStartedFrom(profile), () => undefined);
    if (returnTo) api<{ profile: Profile }>("GET", `/profiles/${encodeURIComponent(returnTo)}`).then(({ profile }) => current && setTo(definitionOf(profile)), failed);
    if (draftNewer && draftNewer.length > 0) {
      Promise.all(draftNewer.map((version) => api<{ profile: Profile }>("GET", `/profiles/${encodeURIComponent(version.id)}`).then(({ profile }) => ({ ...version, profile: definitionOf(profile) })))).then(
        (read) => current && setNewer(read),
        failed,
      );
    }
    return () => {
      current = false;
    };
    // mayChangeAt is a new function each render; the account's Locations don't change while the dialog is open.
  }, [open, replaces, returnTo, comparedTo, draftNewer]);

  const reset = () => {
    setReplaced(undefined);
    setRecipes(undefined);
    setTo(undefined);
    setStartedFrom(null);
    setNewer([]);
    setChosenLocations(undefined);
    setChosenRecipes(new Set());
    setError(undefined);
    setLoadError(undefined);
  };

  const after = target.kind === "draft" ? target.profile : to;
  const comparedWith = replaced ?? startedFrom;
  const before = comparedWith ? definitionOf(comparedWith) : null;
  const changes = before && after ? differences(before, after) : null;
  const chosen = chosenLocations ?? new Set<string>();
  const offered = (locations ?? []).filter((location) => mayChangeAt(location.id) || chosen.has(location.id));
  const recipesAt = (locationId: string) => (recipes ?? []).filter(({ recipe }) => recipe.location?.id === locationId);
  const name = (profile: { title: string | null } | null | undefined) => (profile ? profileTitle(profile) : "The Profile");

  const toggleLocation = (locationId: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(locationId);
    else next.delete(locationId);
    setChosenLocations(next);
    // A Location's Recipes start chosen with it, and go with it.
    const these = recipesAt(locationId).map(({ recipe }) => recipe.id);
    setChosenRecipes((was) => {
      const recipesNext = new Set(was);
      for (const recipeId of these) {
        if (on) recipesNext.add(recipeId);
        else recipesNext.delete(recipeId);
      }
      return recipesNext;
    });
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosen.size === 0) return setError("Choose at least one Location to show it at");
    setError(undefined);
    setPublishing(true);
    const moved = [...chosenRecipes].filter((recipeId) => (recipes ?? []).some(({ recipe }) => recipe.id === recipeId && recipe.location && chosen.has(recipe.location.id)));
    try {
      const { published } =
        target.kind === "draft"
          ? await api<{ published: Published }>("POST", `/drafts/${encodeURIComponent(target.draft.id)}/publish`, { locations: [...chosen], recipes: moved, saves: target.saves() })
          : await api<{ published: Published }>("POST", `/profiles/${encodeURIComponent(target.to.id)}/return`, { from: target.from.id, locations: [...chosen], recipes: moved });
      setOpen(false);
      reset();
      onPublished(published);
    } catch (caught) {
      setError(failure(caught, target.kind === "draft" ? "The Draft could not be published" : "The version could not be returned to"));
    } finally {
      setPublishing(false);
    }
  }

  const title = target.kind === "draft" ? "Publish the Draft" : `Return to ${target.to.name}`;
  const description: ReactNode =
    target.kind === "return" ? (
      <>
        {target.to.name} is shown again at the Locations you choose, in place of {name(target.from)}, with the Recipes you choose. Nothing new is created.
      </>
    ) : target.draft.publishesAs === "version" && target.draft.startedFrom ? (
      <>
        As a new version of {target.draft.startedFrom.title ?? "the Profile it started from"}, shown at the Locations you choose in its place, with the Recipes you choose. Tablets
        there get it as they get any Profile, whether or not they are online now.
      </>
    ) : (
      <>As a separate Profile, shown at the Locations you choose. Tablets there get it as they get any Profile, whether or not they are online now.</>
    );
  const loading = replaced === undefined || (target.kind === "return" && to === undefined) || locations === undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant={target.kind === "draft" ? "default" : "outline"} size={target.kind === "draft" ? "default" : "sm"} disabled={disabled} aria-label={ariaLabel}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="grid min-w-0 gap-5" onSubmit={(event) => void submit(event)} aria-label={title}>
          {(error ?? loadError ?? locationsError) && <FormError error={error ?? loadError ?? locationsError} />}
          {loading && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}

          {newer.length > 0 && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                {newer.map((version) => {
                  const rows = version.profile && target.kind === "draft" ? differences(version.profile, target.profile) : [];
                  return (
                    <div key={version.id} className="grid gap-1">
                      <p>
                        A newer version,{" "}
                        <Link to={profilePath(version.id)} className="font-semibold underline underline-offset-4" target="_blank">
                          {profileTitle(version)}
                        </Link>
                        , was saved on {formatTime(version.savedAt)}, after this Draft began. Publishing saves this Draft from the version it started from all the same, so the chain
                        forks: both stay versions.
                      </p>
                      {rows.length > 0 && <ChangesTable caption={`How ${profileTitle(version)} differs from this Draft`} before="The newer version" after="This Draft" rows={rows} />}
                    </div>
                  );
                })}
              </AlertDescription>
            </Alert>
          )}

          {changes && (
            <section className="grid gap-2" aria-label="What changed">
              <h3 className="text-sm font-semibold">What changed</h3>
              {changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing in its steps or what it states once.</p>
              ) : (
                <ChangesTable caption="What changed" before={name(comparedWith)} after={target.kind === "draft" ? "This Draft" : target.to.name} rows={changes} />
              )}
            </section>
          )}

          {!loading && (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-semibold">Show it at</legend>
              {offered.length === 0 && <p className="text-sm text-muted-foreground">There is no Location you may publish to.</p>}
              {offered.map((location) => {
                const inputId = `${id}-location-${location.id}`;
                const here = recipesAt(location.id);
                const kept = here.filter(({ recipe }) => !chosenRecipes.has(recipe.id));
                const showedIt = replaced?.locations.some((place) => place.location.id === location.id && place.shown) ?? false;
                return (
                  <div key={location.id} className="grid gap-2 rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <Checkbox id={inputId} checked={chosen.has(location.id)} disabled={!mayChangeAt(location.id)} onCheckedChange={(checked) => toggleLocation(location.id, checked === true)} />
                      <Label htmlFor={inputId}>{location.name}</Label>
                    </div>
                    {chosen.has(location.id) && replaced && (
                      <>
                        {here.length > 0 && (
                          <ul className="grid gap-1.5 pl-6" aria-label={`Recipes at ${location.name}`}>
                            {here.map(({ recipe, loadedOn }) => {
                              const recipeInput = `${id}-recipe-${recipe.id}`;
                              return (
                                <li key={recipe.id} className="flex items-start gap-2">
                                  <Checkbox
                                    id={recipeInput}
                                    checked={chosenRecipes.has(recipe.id)}
                                    onCheckedChange={(checked) =>
                                      setChosenRecipes((was) => {
                                        const next = new Set(was);
                                        if (checked === true) next.add(recipe.id);
                                        else next.delete(recipe.id);
                                        return next;
                                      })
                                    }
                                  />
                                  <Label htmlFor={recipeInput} className="grid gap-0.5 font-normal">
                                    <span>
                                      Move {recipe.name ?? "the Recipe"}
                                      {recipe.slot !== null && <span className="text-muted-foreground"> · slot {recipe.slot}</span>}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {loadedOn.length === 0 ? "Loaded on no Machine now" : `Loaded now on ${loadedOn.map((machine) => machine.name).join(", ")}, which take the change`}
                                    </span>
                                  </Label>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {showedIt && (
                          <p className="pl-6 text-xs text-muted-foreground">
                            {kept.length > 0
                              ? `${name(replaced)} stays shown here, as ${kept.map(({ recipe }) => recipe.name ?? "a Recipe").join(", ")} still ${kept.length === 1 ? "names" : "name"} it.`
                              : `${name(replaced)} is hidden here.`}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}

          <div>
            <Button type="submit" disabled={publishing || loading || chosen.size === 0}>
              {target.kind === "draft" ? "Publish" : "Return to this version"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rows of what differs between two profiles, before and after. */
function ChangesTable({ caption, before, after, rows }: { caption: string; before: string; after: string; rows: [string, string, string][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-normal" />
            <th scope="col" className="py-1 pr-3 font-normal">
              {before}
            </th>
            <th scope="col" className="py-1 font-normal">
              {after}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([what, was, now]) => (
            <tr key={what} className="border-t align-top">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
                {what}
              </th>
              <td className="py-1 pr-3">{was}</td>
              <td className="py-1">{now}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
