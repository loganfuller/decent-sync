import { useCallback } from "react";
import { LibraryNav } from "@/components/bean-batches";
import { ConflictsTable } from "@/components/conflicts";
import { PageTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { api, type Conflict } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** The Library's open Conflicts, the latest first, to use a losing value or dismiss each. */
export function ConflictsPage() {
  const load = useCallback(async () => (await api<{ conflicts: Conflict[] }>("GET", "/conflicts")).conflicts, []);
  const { data: conflicts, error, reload } = usePolled(load, DETAILS_POLL_MS);

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title="Conflicts">
          <p>
            Edits that lost to another edit of the same field, made without seeing it. The later edit stands everywhere; each that lost is kept here
            until someone uses its value, which makes it a new edit written to every tablet that holds the item, or dismisses it.
          </p>
        </PageTitleWithInfo>
        <LibraryNav />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {conflicts?.length === 0 && <p className="text-muted-foreground">No open Conflicts.</p>}
      {conflicts && conflicts.length > 0 && (
        <div className="rounded-lg border">
          <ConflictsTable conflicts={conflicts} showItem onResolved={reload} />
        </div>
      )}
    </section>
  );
}
