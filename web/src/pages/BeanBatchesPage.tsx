import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { BatchBadges, LibraryNav, atText, batchName } from "@/components/bean-batches";
import { NewBatchDialog } from "@/components/library-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type BeanBatchSummary, type BeanSummary } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The Library's Bean Batches, the Locations each is at and its remaining weight at each. Batches join the Library from tablets, or are created here. */
export function BeanBatchesPage() {
  const load = useCallback(async () => (await api<{ batches: BeanBatchSummary[] }>("GET", "/bean-batches")).batches, []);
  const { data: batches, error } = usePolled(load, DETAILS_POLL_MS);
  // The Beans a new batch may be of.
  const [beans, setBeans] = useState<BeanSummary[]>();
  useEffect(() => {
    let current = true;
    api<{ beans: BeanSummary[] }>("GET", "/beans").then(
      ({ beans }) => current && setBeans(beans),
      () => current && setBeans([]),
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Bean Batches</h1>
        <p className="text-muted-foreground">
          The Bean Batches in the Library. A batch entered on a tablet is at that tablet's Location, and is written, with its
          Bean, to every tablet there. Archiving it on a tablet finishes it at that tablet's Location, and the remaining
          weight entered on a tablet is that Location's. Here, a batch is added at Locations or finished there, its
          remaining weight set at each.
        </p>
        <LibraryNav />
        <div className="mt-2">
          <NewBatchDialog beans={beans} />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {batches?.length === 0 && <p className="text-muted-foreground">No Bean Batches yet. They join the Library as tablets at a Location report them, or as they are created here.</p>}
      {batches && batches.length > 0 && (
        <div className="rounded-lg border">
          <Table aria-label="Bean Batches">
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Roaster</TableHead>
                <TableHead>At</TableHead>
                <TableHead>Created at</TableHead>
                <TableHead>Attention</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((batch) => (
                <TableRow key={batch.id}>
                  <TableCell className="font-medium">
                    <Link to={`/library/bean-batches/${batch.id}`} className="underline-offset-4 hover:underline">
                      {batchName(batch)}
                    </Link>
                  </TableCell>
                  <TableCell>{batch.bean.roaster ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{atText(batch.locations)}</TableCell>
                  <TableCell>{batch.createdLocation?.name ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    <BatchBadges batch={batch} />
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
