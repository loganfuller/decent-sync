import { useCallback, useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMayChange } from "@/auth";
import { BatchBadges, LibraryNav, atText, batchName } from "@/components/bean-batches";
import { PageTitleWithInfo } from "@/components/info-tip";
import { NewBatchDialog } from "@/components/library-forms";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type BeanBatchSummary, type BeanSummary } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The words searched for, kept in the address. */
const SEARCH = "q";

/** Whether a batch matches the words searched for, each in its Bean's name, its roaster or its Batch Code, ignoring case. */
function matches(batch: BeanBatchSummary, search: string): boolean {
  const text = [batch.bean.name, batch.bean.roaster, batch.batchCode].filter((part) => part !== null).join(" ").toLowerCase();
  return search.toLowerCase().split(/\s+/).every((word) => text.includes(word));
}

/**
 * The Library's Bean Batches, each with its Batch Code, the Locations it is
 * at and its remaining weight at each, found by Bean, roaster or Batch Code.
 * Batches join the Library from tablets, or are created here.
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

  const shown = (batches ?? []).filter((batch) => matches(batch, search));

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Bean Batches">
          <p>
            The Bean Batches in the Library. A batch entered on a tablet is at that tablet's Location, and is written, with its
            Bean, to every tablet there. Archiving it on a tablet finishes it at that tablet's Location, and the remaining
            weight entered on a tablet is that Location's. Here, a batch is added at Locations or finished there, its
            remaining weight set at each.
          </p>
          <p>
            A batch's Batch Code is the roaster's own identifier for it, as on its label, which no other batch that is not
            Archived holds. The search finds a batch by its Bean, its roaster or its Batch Code.
          </p>
        </PageTitleWithInfo>
        <LibraryNav />
        {mayChange && (
          <div className="mt-2">
            <NewBatchDialog beans={beans} />
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {batches?.length === 0 && <p className="text-muted-foreground">No Bean Batches yet. They join the Library as tablets at a Location report them, or as they are created here.</p>}
      {batches && batches.length > 0 && (
        <div role="search" aria-label="Find a batch" className="flex flex-wrap items-end gap-3">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-search`}>Find a batch</Label>
            <Input
              id={`${id}-search`}
              className="w-72"
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
          </div>
          {search.trim() !== "" && (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              {shown.length} of {batches.length} {batches.length === 1 ? "batch" : "batches"}
            </p>
          )}
        </div>
      )}
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
                <TableHead>Created at</TableHead>
                <TableHead>Attention</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((batch) => (
                <TableRow key={batch.id}>
                  <TableCell className="font-medium">
                    <Link to={`/library/bean-batches/${batch.id}`} className="underline-offset-4 hover:underline">
                      {batchName(batch)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono font-medium">{batch.batchCode ?? <span className="font-sans font-normal text-muted-foreground">-</span>}</TableCell>
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
