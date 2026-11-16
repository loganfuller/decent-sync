import { useCallback, useId } from "react";
import { Link, useSearchParams } from "react-router";
import { LibraryNav } from "@/components/bean-batches";
import { PageTitleWithInfo } from "@/components/info-tip";
import { RecipesTable } from "@/components/recipes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api, type Location, type Recipe } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/**
 * The Library's Recipes (#547): every Location's, a table for each
 * Location, in Recipe Slot order with those in no slot after, each with its
 * Reference Shot's duration. Archived Recipes show on asking, which the
 * address keeps as `archived`. A Recipe is created on its Location's page.
 */
export function RecipesPage() {
  const id = useId();
  const [params, setParams] = useSearchParams();
  const archived = params.has("archived");
  const showArchived = (shown: boolean) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (shown) next.set("archived", "1");
      else next.delete("archived");
      return next;
    });
  const load = useCallback(async () => {
    const { locations } = await api<{ locations: Location[] }>("GET", "/locations");
    // A Location's list comes in Recipe Slot order, those in no slot after, by name.
    return Promise.all(locations.map(async (location) => ({ location, recipes: (await api<{ recipes: Recipe[] }>("GET", `/locations/${encodeURIComponent(location.id)}/recipes`)).recipes })));
  }, []);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const hidden = data?.reduce((count, { recipes }) => count + recipes.filter((recipe) => recipe.archived).length, 0) ?? 0;

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Recipes">
          <p>
            Every Location's Recipes: its Recipe Slots, 1 to 9, shared by its Machines, then the Recipes kept there in no slot. A Recipe belongs to
            one Location, and is created on that Location's page, or on a tablet there.
          </p>
          <p>
            A Reference Shot is the one Shot chosen to show how a Recipe's Shots should go: its duration opens it, and "No reference" opens the
            Recipe's rated Shots, to choose one from.
          </p>
        </PageTitleWithInfo>
        <LibraryNav />
        <div className="mt-2 flex items-center gap-2">
          <Checkbox id={`${id}-archived`} checked={archived} onCheckedChange={(checked) => showArchived(checked === true)} />
          <Label htmlFor={`${id}-archived`}>Show archived{hidden > 0 && <span className="font-normal text-muted-foreground tabular-nums"> ({hidden})</span>}</Label>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {data?.length === 0 && <p className="text-muted-foreground">No Locations yet. A Recipe belongs to a Location.</p>}
      {data?.map(({ location, recipes }) => {
        const shown = recipes.filter((recipe) => archived || !recipe.archived);
        return (
          <section key={location.id} aria-label={`Recipes at ${location.name}`} className="grid grid-cols-1 gap-2">
            <h2 className="text-base font-semibold">
              <Link to={`/locations/${encodeURIComponent(location.id)}`} className="underline-offset-4 hover:underline">
                {location.name}
              </Link>
            </h2>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">{recipes.length === 0 ? "No Recipes here yet." : "Its Recipes are all Archived."}</p>
            ) : (
              <RecipesTable label={`Recipes at ${location.name}`} recipes={shown} slots />
            )}
          </section>
        );
      })}
    </section>
  );
}
