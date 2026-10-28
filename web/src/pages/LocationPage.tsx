import { useCallback } from "react";
import { Link, useParams } from "react-router";
import { useStaffLocationIds } from "@/auth";
import { LocationMachinesCard } from "@/components/loaded-recipes";
import { LocationRecipesCard } from "@/components/recipes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ApiError, api, type Location, type Machine, type Recipe } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

/**
 * One Location: its Recipes, in its Recipe Slots and in none, and its
 * Machines and the Recipe each has loaded. Loaded every 5 s, so a change
 * made on a tablet shows.
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
      const [{ locations }, { recipes }, { machines }] = await Promise.all([
        api<{ locations: Location[] }>("GET", "/locations"),
        api<{ recipes: Recipe[] }>("GET", `/locations/${encodeURIComponent(id)}/recipes`),
        api<{ machines: Machine[] }>("GET", "/machines"),
      ]);
      const here = machines.filter((machine) => machine.location?.id === id);
      return { location: locations.find((location) => location.id === id), recipes, machines: here };
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
  const { location, recipes, machines } = data;

  return (
    <section className="grid gap-6">
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
      {location && <LocationRecipesCard location={location} recipes={recipes} onChanged={reload} />}
      <LocationMachinesCard machines={machines} />
    </section>
  );
}
