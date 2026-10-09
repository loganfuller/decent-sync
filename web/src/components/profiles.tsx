import { useState } from "react";
import { useMayChangeAt } from "@/components/library-forms";
import { formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Location, type Profile, type ProfileSummary } from "@/lib/api";

/** A Profile's title as lists show it. */
export function profileTitle(profile: Pick<ProfileSummary, "title">): string {
  return profile.title ?? "Untitled Profile";
}

/** Where a Profile is shown, by Location name. */
export function shownAtText(profile: ProfileSummary): string {
  if (profile.archived) return "Nowhere: Archived";
  return profile.shownAt.length === 0 ? "Nowhere" : profile.shownAt.map((here) => here.location.name).join(", ");
}

/** The address of a Profile's page: its id holds a colon, as Decaid's do. */
export function profilePath(id: string): string {
  return `/library/profiles/${encodeURIComponent(id)}`;
}

/** What sets a Profile apart: one of Decaid's bundled Profiles, or Archived. */
export function ProfileBadges({ profile }: { profile: ProfileSummary }) {
  return (
    <div className="flex flex-wrap gap-1">
      {profile.bundled && <Badge variant="outline">Bundled with Decaid</Badge>}
      {profile.archived && <Badge variant="secondary">Archived</Badge>}
    </div>
  );
}

/**
 * Whether each Location shows a Profile: an Admin, or Staff working there,
 * shows or hides it there, which is written to that Location's tablets. An
 * Archived Profile is shown nowhere, but each Location's choice is kept, so
 * restoring it shows it again where it is shown.
 */
export function ProfileLocationsCard({ profile, onChanged }: { profile: Profile; onChanged(): Promise<void> | void }) {
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const decided = new Map(profile.locations.map((here) => [here.location.id, here]));

  async function show(location: Location, shown: boolean) {
    setBusy(location.id);
    setError(undefined);
    try {
      await api("PUT", `/profiles/${encodeURIComponent(profile.id)}/locations/${location.id}`, { shown });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `It could not be ${shown ? "shown" : "hidden"} at ${location.name}`);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Locations</h2>
        </CardTitle>
        <CardDescription>
          Where it is shown. Showing it at a Location writes it to that Location's tablets, visible; hiding it there hides it on them,
          never deleting it, and changes no other Location.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {locationsError && (
          <Alert variant="destructive">
            <AlertDescription>{locationsError}</AlertDescription>
          </Alert>
        )}
        {profile.archived && (
          <p className="text-sm text-muted-foreground">
            It is Archived, so it is shown nowhere and hidden on every tablet. Restoring it shows it again where it is shown below.
          </p>
        )}
        {locations?.length === 0 ? (
          <p className="text-sm text-muted-foreground">There are no Locations yet.</p>
        ) : (
          <Table aria-label="Locations">
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Shown</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(locations ?? []).map((location) => {
                const here = decided.get(location.id);
                const shown = here?.shown ?? false;
                return (
                  <TableRow key={location.id}>
                    <TableCell className="font-medium">{location.name}</TableCell>
                    <TableCell>
                      <Switch
                        aria-label={`Shown at ${location.name}`}
                        checked={shown}
                        disabled={!mayChangeAt(location.id) || busy !== undefined}
                        onCheckedChange={(checked) => void show(location, checked)}
                      />
                    </TableCell>
                    <TableCell>{here ? formatTime(here.since) : <span className="text-muted-foreground">Never shown</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
