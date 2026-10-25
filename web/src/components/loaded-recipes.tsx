import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Field, Fields } from "@/components/fields";
import { CaptureOnlyBadge } from "@/components/machine-sharing";
import { formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type LoadedRecipe, type Machine } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** How many of a Machine's Loaded Recipes its page lists, latest first. */
const HISTORY_LIMIT = 20;

/** A Recipe a Machine loaded, linked to its page, with its slot now, or that it is in none or Archived. */
function LoadedRecipeLink({ loaded }: { loaded: LoadedRecipe }) {
  const { recipe } = loaded;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="underline underline-offset-4">
        {recipe.name ?? "Unnamed Recipe"}
      </Link>
      {recipe.archived ? (
        <Badge variant="secondary">Archived</Badge>
      ) : recipe.slot === null ? (
        <Badge variant="outline">No slot</Badge>
      ) : (
        <Badge variant="outline">Slot {recipe.slot}</Badge>
      )}
    </span>
  );
}

/**
 * The Machine's Loaded Recipe, the Recipe its Workflow was last loaded from
 * (ADR-0022), and the ones it had before, each from when its tablet loaded it
 * until it loaded another or none. The history is loaded again as soon as
 * the Loaded Recipe the Machine's status shows changes.
 */
export function LoadedRecipeCard({ machine }: { machine: Machine }) {
  const current = machine.loadedRecipe;
  const load = useCallback(
    () => api<{ entries: LoadedRecipe[]; total: number }>("GET", `/machines/${encodeURIComponent(machine.id)}/loaded-recipes?limit=${HISTORY_LIMIT}`),
    [machine.id],
  );
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  // Loaded again as the Machine loads or unloads a Recipe; the first load is usePolled's.
  const shown = current?.id ?? null;
  const seen = useRef(shown);
  useEffect(() => {
    if (seen.current === shown) return;
    seen.current = shown;
    void reload();
  }, [shown, reload]);
  return (
    <Card role="region" aria-label="Loaded Recipe">
      <CardHeader>
        <CardTitle>
          <h2>Loaded Recipe</h2>
        </CardTitle>
        <CardDescription>
          The Recipe its tablet last applied, in DYE2 or on Streamline's strip, which every change on the machine is saved
          into. Changing the profile there, or applying a favourite, unloads it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {current ? (
          <Fields label="Loaded now">
            <Field term="Recipe">
              <LoadedRecipeLink loaded={current} />
            </Field>
            <Field term="Since">{formatTime(current.loadedAt)}</Field>
          </Fields>
        ) : (
          <p className="text-sm text-muted-foreground">No Recipe is loaded.</p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {data && data.entries.length > 0 && (
          <section className="grid gap-2">
            <h3 className="font-medium">History</h3>
            <Table aria-label="Loaded Recipe history">
              <TableHeader>
                <TableRow>
                  <TableHead>Recipe</TableHead>
                  <TableHead>Loaded</TableHead>
                  <TableHead>Unloaded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <LoadedRecipeLink loaded={entry} />
                    </TableCell>
                    <TableCell>{formatTime(entry.loadedAt)}</TableCell>
                    <TableCell>{entry.unloadedAt ? formatTime(entry.unloadedAt) : "Still loaded"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.total > data.entries.length && (
              <p className="text-sm text-muted-foreground">
                The latest {data.entries.length} of {data.total}.
              </p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

/** Each Machine at a Location and the Recipe it has loaded, on the Location's page. */
export function LocationMachinesCard({ machines }: { machines: Machine[] }) {
  return (
    <Card role="region" aria-label="Machines">
      <CardHeader>
        <CardTitle>
          <h2>Machines</h2>
        </CardTitle>
        <CardDescription>The Machines here now, each flagged if it is capture-only, and the Recipe each has loaded.</CardDescription>
      </CardHeader>
      <CardContent>
        {machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Machine is here.</p>
        ) : (
          <Table aria-label="Loaded Recipes here">
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead>Loaded Recipe</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.map((machine) => (
                <TableRow key={machine.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/machines/${encodeURIComponent(machine.id)}`} className="underline-offset-4 hover:underline">
                        {machine.name}
                      </Link>
                      <CaptureOnlyBadge machine={machine} />
                    </div>
                  </TableCell>
                  <TableCell>{machine.loadedRecipe ? <LoadedRecipeLink loaded={machine.loadedRecipe} /> : <span className="text-muted-foreground">None</span>}</TableCell>
                  <TableCell>{machine.loadedRecipe ? formatTime(machine.loadedRecipe.loadedAt) : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
