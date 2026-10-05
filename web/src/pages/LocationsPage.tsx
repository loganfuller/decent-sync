import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useIsAdmin, useStaffLocationIds } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Location } from "@/lib/api";

const TIME_ZONE_LIST = "time-zones";

/** Locations: creating them, and renaming them or changing their time zone. Staff see which they work at. */
export function LocationsPage() {
  const isAdmin = useIsAdmin();
  const worksAt = useStaffLocationIds();
  const [locations, setLocations] = useState<Location[]>();
  const [timeZones, setTimeZones] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  // Remounts the new-Location form, clearing it, after each creation.
  const [created, setCreated] = useState(0);

  const reload = useCallback(async () => {
    try {
      setLocations((await api<{ locations: Location[] }>("GET", "/locations")).locations);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The Locations could not be loaded");
    }
  }, []);

  useEffect(() => {
    void reload();
    // Only for the forms, which only Admins have.
    if (!isAdmin) return;
    api<{ timeZones: string[] }>("GET", "/time-zones").then(
      ({ timeZones }) => setTimeZones(timeZones),
      // Only suggestions are lost; the server still checks what is entered.
      () => setTimeZones([]),
    );
  }, [reload, isAdmin]);

  async function create(values: LocationValues) {
    await api("POST", "/locations", values);
    setCreated((count) => count + 1);
    await reload();
  }

  async function update(id: string, values: LocationValues) {
    await api("PATCH", `/locations/${id}`, values);
    setEditing(undefined);
    await reload();
  }

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Locations</h1>
        <p className="text-muted-foreground">
          The sites where your machines are used. Each Location's time zone sets the local times shown for it.
        </p>
      </div>

      <datalist id={TIME_ZONE_LIST}>
        {timeZones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>

      {isAdmin && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>
              <h2>New Location</h2>
            </CardTitle>
            <CardDescription>The time zone starts as this browser's.</CardDescription>
          </CardHeader>
          <CardContent>
            <LocationForm
              key={created}
              label="New Location"
              initial={{ name: "", timeZone: browserTimeZone() }}
              submitLabel="Create Location"
              onSubmit={create}
            />
          </CardContent>
        </Card>
      )}

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {locations?.length === 0 && <p className="text-muted-foreground">No Locations yet.</p>}
      {locations && locations.length > 0 && (
        <ul aria-label="Locations" className="grid max-w-xl divide-y rounded-lg border">
          {locations.map((location) => (
            <li key={location.id} className="p-4">
              {editing === location.id ? (
                <LocationForm
                  label={`Edit ${location.name}`}
                  initial={location}
                  submitLabel="Save"
                  onSubmit={(values) => update(location.id, values)}
                  onCancel={() => setEditing(undefined)}
                />
              ) : (
                <div className="flex items-center gap-4">
                  <div className="grid flex-1 gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                      {location.name}
                      {worksAt.has(location.id) && <Badge variant="secondary">You work here</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">{location.timeZone}</span>
                  </div>
                  {isAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Edit ${location.name}`}
                      onClick={() => setEditing(location.id)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface LocationValues {
  name: string;
  timeZone: string;
}

/** A Location's name and time zone, suggesting time zones the server accepts. */
function LocationForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: LocationValues;
  submitLabel: string;
  onSubmit(values: LocationValues): Promise<void>;
  onCancel?(): void;
}) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [timeZone, setTimeZone] = useState(initial.timeZone);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ name, timeZone });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={label} className="grid gap-4" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-time-zone`}>Time zone</Label>
        <Input
          id={`${id}-time-zone`}
          list={TIME_ZONE_LIST}
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
          placeholder="Europe/London"
          autoComplete="off"
          required
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The browser's IANA time zone. A server in Docker or on fly.io runs in UTC, so its own is no guide. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}
