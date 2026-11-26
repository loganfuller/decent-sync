import { useCallback } from "react";
import { Link, useParams } from "react-router";
import { useStaffLocationIds } from "@/auth";
import { LocationBatchesCard } from "@/components/bean-batches";
import { LocationOverviewCard } from "@/components/overview";
import { LocationRecipesCard } from "@/components/recipes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ApiError, api, type BatchHere, type Location, type Machine, type Recipe } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

/**
 * One Location: its block of the Overview (#471, #543), whose status cards
 * are its Machines, each with the Recipe it has loaded, and its Recipes, in
 * its Recipe Slots and in none, and the Bean Batches there, each with its
 * Remaining Weight there (#707). Loaded every 5 s, so a change made on a
 * tablet shows; the Overview's numbers are read every 30 s.
 */
export function LocationPage() {
  const { id = "" } = useParams();
  return <LocationDetails key={id} id={id} />;
}

function LocationDetails({ id }: { id: string }) {
  const worksAt = useStaffLocationIds();
  // Null once the Location is found gone.
  const load = useCallback(async () => {
    try {
      const [{ locations }, { recipes }, { machines }, batches] = await Promise.all([
        api<{ locations: Location[] }>("GET", "/locations"),
        api<{ recipes: Recipe[] }>("GET", `/locations/${encodeURIComponent(id)}/recipes`),
        api<{ machines: Machine[] }>("GET", "/machines"),
        // A server of the release before has no such list, as during a deploy (ADR-0025): the page goes without the card.
        api<{ batches: BatchHere[] }>("GET", `/locations/${encodeURIComponent(id)}/bean-batches`).then(
          ({ batches }) => batches,
          (caught: unknown) => {
            if (caught instanceof ApiError && caught.status === 404) return undefined;
            throw caught;
          },
        ),
      ]);
      // Every Machine: the Overview shows one that pulled Shots here and has since moved.
      return { location: locations.find((location) => location.id === id), recipes, machines, batches };
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) return null;
      throw caught;
    }
  }, [id]);
  const { data, error, reload } = usePolled(load);

  const back = (
    <Link to="/locations" className="text-sm text-muted-foreground hover:text-foreground">
      ← Locations
    </Link>
  );
  if (data === null) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Location.</p>
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
  const { location, recipes, machines, batches } = data;

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {location?.name ?? "Location"}
          {worksAt.has(id) && <Badge variant="secondary">You work here</Badge>}
        </h1>
        <p className="text-muted-foreground">{location?.timeZone}</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {location && <LocationOverviewCard location={location} machines={machines} />}
      {location && <LocationRecipesCard location={location} recipes={recipes} onChanged={reload} />}
      {location && batches && <LocationBatchesCard locationId={location.id} batches={batches} />}
    </section>
  );
}
