import { useCallback } from "react";
import { Link, useParams } from "react-router";
import { useStaffLocationIds } from "@/auth";
import { LocationSettingsCard } from "@/components/location-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ApiError, api, type Location, type LocationSettings } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

/**
 * One Location: its steam, hot water and rinse settings for each model of
 * Machine it has, which its Machines of that model share. Loaded every 5 s,
 * so a change made on a tablet shows.
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
      const [{ locations }, { settings }] = await Promise.all([
        api<{ locations: Location[] }>("GET", "/locations"),
        api<{ settings: LocationSettings[] }>("GET", `/locations/${encodeURIComponent(id)}/settings`),
      ]);
      return { location: locations.find((location) => location.id === id), settings };
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
  const { location, settings } = data;

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

      <div className="grid gap-1">
        <h2 className="text-xl font-semibold">Steam, hot water and rinse</h2>
        <p className="text-muted-foreground">
          The Machines of each model here share these settings, set on any of their tablets or here. A Bengle and a DE1 read the same
          values differently, so each model has its own.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {settings.length === 0 && <p className="text-muted-foreground">No Machines here yet.</p>}
      {settings.map((model) => (
        <LocationSettingsCard key={model.model} settings={model} onSaved={reload} />
      ))}
    </section>
  );
}
