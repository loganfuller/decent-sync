import { type ReactNode, useState } from "react";
import { CardTitleWithInfo } from "@/components/info-tip";
import { useMayChangeAt } from "@/components/library-forms";
import { formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Location, type ProfileAtLocation } from "@/lib/api";

/** An item shown or hidden at each Location: a Profile, Basket or Tool. */
interface ShownItem {
  archived: boolean;
  /** The Locations showing it, none while it is Archived. */
  shownAt: ProfileAtLocation[];
  /** Each Location that has decided whether it shows it, kept while it is Archived. */
  locations: { location: Location; shown: boolean; since: string }[];
}

/** Where an item shown per Location is shown, by Location name. */
export function shownAtText(item: Pick<ShownItem, "archived" | "shownAt">): string {
  if (item.archived) return "Nowhere: Archived";
  return item.shownAt.length === 0 ? "Nowhere" : item.shownAt.map((here) => here.location.name).join(", ");
}

/**
 * Whether each Location shows an item: an Admin, or Staff working there,
 * shows or hides it there, which is written to that Location's tablets. An
 * Archived item is shown nowhere, but each Location's choice is kept, so
 * restoring it shows it again where it is shown. `path` is the item's in the
 * REST API; `description` and `archivedNote` say what showing, hiding and
 * Archiving do on tablets.
 */
export function ShownLocationsCard({
  item,
  path,
  description,
  archivedNote,
  onChanged,
}: {
  item: ShownItem;
  path: string;
  description: ReactNode;
  archivedNote: ReactNode;
  onChanged(): Promise<void> | void;
}) {
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const decided = new Map(item.locations.map((here) => [here.location.id, here]));

  async function show(location: Location, shown: boolean) {
    setBusy(location.id);
    setError(undefined);
    try {
      await api("PUT", `${path}/locations/${location.id}`, { shown });
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
        <CardTitleWithInfo title="Locations">
          <p>{description}</p>
        </CardTitleWithInfo>
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
        {item.archived && <p className="text-sm text-muted-foreground">{archivedNote}</p>}
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
