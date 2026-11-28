import { useCallback, useEffect, useId, useState } from "react";
import { useSearchParams } from "react-router";
import { useMayChange } from "@/auth";
import { BatchCell } from "@/components/batch-name";
import { BatchBadges, LibraryNav, totalText } from "@/components/bean-batches";
import { PageTitleWithInfo } from "@/components/info-tip";
import { NewBatchDialog } from "@/components/library-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type BeanBatchSummary, type BeanSummary } from "@/lib/api";
import { batchMatches } from "@/lib/batch-picker";
import { atLines } from "@/lib/remaining-weight";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The words searched for, kept in the address. */
const SEARCH = "q";

/**
 * The Library's Bean Batches, each by its Bean over its roast day (#732),
 * with its Batch Code in a column of its own, the Locations it is at, a line
 * each with its remaining weight there, and its remaining weight in all,
 * found by Bean, roaster or Batch Code. New Batch, the search and
 * its count of matches share one row (#726). Batches join the Library from
 * tablets, or are created here.
 */
export function BeanBatchesPage() {
  const mayChange = useMayChange();
  const id = useId();
  const [params, setParams] = useSearchParams();
  const search = params.get(SEARCH) ?? "";
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

  // As the batch picker finds one (`batchMatches`): each word in its Bean's name, its roaster or its Batch Code, ignoring case.
  const shown = (batches ?? []).filter((batch) => batchMatches(batch, search));

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Bean Batches">
          <p>
            The Bean Batches in the Library. A batch entered on a tablet is at that tablet's Location, and is written, with its
            Bean, to every tablet there. Archiving it on a tablet finishes it at that tablet's Location. A batch's remaining
            weight at a Location is the weight last entered there, here or on a tablet, less the dose of each Shot pulled
            there with it since; one with no weight entered is not tracked there.
          </p>
          <p>
            A batch's Batch Code is the roaster's own identifier for it, as on its label, which no other batch that is not
            Archived holds. The search finds a batch by its Bean, its roaster or its Batch Code.
          </p>
        </PageTitleWithInfo>
        <LibraryNav />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {(mayChange || (batches && batches.length > 0)) && (
        <div className="flex flex-wrap items-center gap-3">
          {mayChange && <NewBatchDialog beans={beans} />}
          {batches && batches.length > 0 && (
            <div role="search" aria-label="Find a batch" className="flex min-w-0 flex-wrap items-center gap-3">
              {/* Named for a screen reader, with no label drawn above it: its placeholder says what it finds by. */}
              <Label htmlFor={`${id}-search`} className="sr-only">
                Find a batch
              </Label>
              <Input
                id={`${id}-search`}
                className="w-72 max-w-full"
                type="search"
                placeholder="Bean, roaster or Batch Code"
                value={search}
                onChange={(event) => {
                  const next = new URLSearchParams(params);
                  if (event.target.value === "") next.delete(SEARCH);
                  else next.set(SEARCH, event.target.value);
                  setParams(next, { replace: true });
                }}
              />
              {search.trim() !== "" && (
                <p role="status" className="text-sm text-muted-foreground">
                  {shown.length} of {batches.length} {batches.length === 1 ? "batch" : "batches"}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {batches?.length === 0 && <p className="text-muted-foreground">No Bean Batches yet. They join the Library as tablets at a Location report them, or as they are created here.</p>}
      {batches && batches.length > 0 && shown.length === 0 && <p className="text-muted-foreground">No batch matches.</p>}
      {shown.length > 0 && (
        <div className="min-w-0 rounded-lg border">
          <Table aria-label="Bean Batches">
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Batch Code</TableHead>
                <TableHead>Roaster</TableHead>
                <TableHead>At</TableHead>
                <TableHead className="text-right">Remaining in all</TableHead>
                <TableHead>Attention</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((batch) => (
                <TableRow key={batch.id} className="align-top">
                  <TableCell className="whitespace-normal">
                    <BatchCell batch={batch} id={batch.id} code={false} />
                  </TableCell>
                  <TableCell className="font-mono font-medium">{batch.batchCode ?? <span className="font-sans font-normal text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{batch.bean.roaster ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="whitespace-normal">
                    {batch.locations.length === 0
                      ? "Nowhere"
                      : atLines(batch.locations).map((here) => (
                          <div key={here.id}>
                            {here.name}
                            {here.weight !== undefined && <span className="text-muted-foreground"> {here.weight}</span>}
                          </div>
                        ))}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${batch.locations.some((here) => here.remainingWeight !== null) ? "" : "text-muted-foreground"}`}>{totalText(batch) ?? "-"}</TableCell>
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
