import { Link } from "react-router";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { CaptureOnlyBadge } from "@/components/machine-sharing";
import { formatTime } from "@/components/machines";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LoadedRecipe, Machine } from "@/lib/api";

/** A Recipe a Machine loaded, linked to its page, with its slot now, or that it is in none or Archived. */
export function LoadedRecipeLink({ loaded }: { loaded: LoadedRecipe }) {
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
 * (ADR-0022), as the Machine's status gives it. The ones it had before are
 * listed by day in its Activity card (machine-activity.tsx).
 */
export function LoadedRecipeCard({ machine }: { machine: Machine }) {
  const current = machine.loadedRecipe;
  return (
    <Card role="region" aria-label="Loaded Recipe">
      <CardHeader>
        <CardTitleWithInfo title="Loaded Recipe">
          <p>
            The Recipe its tablet last applied, in DYE2 or on Streamline's strip, which every change on the machine is saved into.
            Changing the profile there, or applying a favourite, unloads it.
          </p>
          <p>Its Activity lists the Recipes it had loaded, day by day.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

/** Each Machine at a Location and the Recipe it has loaded, on the Location's page. */
export function LocationMachinesCard({ machines }: { machines: Machine[] }) {
  return (
    <Card role="region" aria-label="Machines">
      <CardHeader>
        <CardTitleWithInfo title="Machines">
          <p>The Machines here now, each flagged if it is capture-only, and the Recipe each has loaded.</p>
        </CardTitleWithInfo>
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
