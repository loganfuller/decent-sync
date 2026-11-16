import { useCallback } from "react";
import { Link } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { api, type ShotPage } from "@/lib/api";
import { LIBRARY_KINDS, type ShotsKind } from "@/lib/library-kinds";
import { PERIODS, type Period, periodDays } from "@/lib/overview";
import { shotsText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// The Shots a Library item's page tells of (#547): how many are linked to
// it, and a link that opens them in the Shots list, which lists them, sums
// them up and charts them.

/**
 * A Library item's Shots, in one line: how many used it, counted again as
 * often as its history is read, and a link that opens them in the Shots
 * list, filtered to it. `within` narrows both to a period, as a Recipe's
 * page does to the one its numbers are of: the count is of the period's
 * days in `timeZone`, the Recipe's Location's, and the link opens the list
 * at its own preset of the same days.
 */
export function ItemShotsCard({ kind, id, within }: { kind: ShotsKind; id: string; within?: { period: Period; timeZone: string | undefined } }) {
  const { shotsFilter: filter, name } = LIBRARY_KINDS[kind];
  const period = within?.period;
  const timeZone = within?.timeZone;
  const load = useCallback(async () => {
    const days = period === undefined ? undefined : periodDays(period, timeZone ?? "UTC");
    // A page of one Shot, for the list's total.
    const query = new URLSearchParams({ [filter]: id, limit: "1", ...(days && { from: days.from, to: days.to }) });
    return { period, total: (await api<ShotPage>("GET", `/shots?${query}`)).total };
  }, [filter, id, period, timeZone]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  // One period's count never stands under another's name while the next is on its way.
  const data = polled.data?.period === period ? polled.data : undefined;
  const preset = PERIODS.find((each) => each.period === period);
  const counted = data && `${data.total === 0 ? "No Shots" : shotsText(data.total)}${preset ? ` ${preset.pulled}` : data.total === 0 ? " yet" : ""}`;

  return (
    <Card role="region" aria-label="Shots">
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CardTitleWithInfo title="Shots">
            <p>
              The Shots pulled with this {name} on any Machine{preset ? `, ${preset.pulled}: its Location's days, in its time zone` : ""}. The Shots list lists them, newest
              first, with their summary and trend.
            </p>
          </CardTitleWithInfo>
          {counted && <p className="text-sm text-muted-foreground tabular-nums">{counted}</p>}
        </div>
        {/* An item no Shot used has none to open; a period with none may still be widened in the list. */}
        {data && (data.total > 0 || preset) && (
          <Link to={`/shots?${new URLSearchParams({ [filter]: id, ...(preset && { period: preset.shots }) })}`} className="text-sm underline underline-offset-4">
            Open in the Shots list
          </Link>
        )}
      </CardHeader>
      {polled.error && (
        <CardContent>
          <Alert variant="destructive">
            <AlertDescription>Could not count its Shots: {polled.error}</AlertDescription>
          </Alert>
        </CardContent>
      )}
    </Card>
  );
}
