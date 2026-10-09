import { useCallback } from "react";
import { Link } from "react-router";
import { LibraryNav } from "@/components/bean-batches";
import { GrinderBadges, grinderLocationText, grinderName } from "@/components/grinders";
import { NewGrinderDialog } from "@/components/library-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type GrinderSummary } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The Library's Grinders and the Location each belongs to. Grinders join the Library from tablets, or are created here at a Location. */
export function GrindersPage() {
  const load = useCallback(async () => (await api<{ grinders: GrinderSummary[] }>("GET", "/grinders")).grinders, []);
  const { data: grinders, error } = usePolled(load, DETAILS_POLL_MS);

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Grinders</h1>
        <p className="text-muted-foreground">
          The grinders at each Location. A Grinder created on a tablet belongs to that tablet's Location and is written to
          every tablet there, and to no other. Archiving or deleting it on a tablet there Archives it.
        </p>
        <LibraryNav />
        <div className="mt-2">
          <NewGrinderDialog />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {grinders?.length === 0 && <p className="text-muted-foreground">No Grinders yet. They join the Library as tablets at a Location report them, or as they are created here.</p>}
      {grinders && grinders.length > 0 && (
        <div className="rounded-lg border">
          <Table aria-label="Grinders">
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Burrs</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grinders.map((grinder) => (
                <TableRow key={grinder.id}>
                  <TableCell className="font-medium">
                    <Link to={`/library/grinders/${grinder.id}`} className="underline-offset-4 hover:underline">
                      {grinderName(grinder)}
                    </Link>
                  </TableCell>
                  <TableCell>{grinder.burrs || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{grinderLocationText(grinder)}</TableCell>
                  <TableCell>
                    <GrinderBadges grinder={grinder} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
