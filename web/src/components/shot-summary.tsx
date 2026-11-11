import { useCallback } from "react";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { api, type ShotSummary } from "@/lib/api";
import { type MedianText, durationText, shareText, shotsText, yieldAgainstTargetText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/**
 * The Shot Summary of the Shots a list's filters find (#466), above its
 * rows: how many there are, their duration and yield against target, each as
 * a median with the range the middle half fall in, and the share that
 * stopped on weight. `filterQuery` is the list's filters as the REST API's
 * query, so the summary follows them; it is loaded again every 30 s, less
 * often than the rows, as it reads every Shot the filters find. The numbers
 * of the last filters stay until the next ones' arrive, as the rows do, but
 * not while a load has failed since the last that succeeded: they would
 * stand under that failure as these filters' until the next load, 30 s on.
 * So filters changed after a failed load show dashes until theirs arrives.
 */
export function ShotSummaryCard({ filterQuery }: { filterQuery: string }) {
  // Each summary loaded remembers the filters it answers.
  const load = useCallback(async () => ({ filterQuery, summary: await api<ShotSummary>("GET", `/shots/summary${filterQuery ? `?${filterQuery}` : ""}`) }), [filterQuery]);
  const { data: loaded, error } = usePolled(load, DETAILS_POLL_MS);
  const group = loaded && (loaded.filterQuery === filterQuery || !error) ? loaded.summary.groups[0] : undefined;
  const covered = group?.counts.shots;
  const leftOut = group?.counts.cleaningAndCalibration ?? 0;
  /** How many Shots a number rests on, said only where some of those covered had no value for it. */
  const restsOn = (shots: number | undefined, which: string) => (shots === undefined || covered === undefined || shots === covered ? undefined : `${shots} of ${shotsText(covered)} ${which}`);

  return (
    <Card role="region" aria-label="Summary">
      <CardHeader>
        <CardTitleWithInfo title="Summary">
          <p>How the Shots these filters find went, leaving out cleaning and calibration Shots.</p>
          <p>Duration and yield against target are each a median, with the range the middle half of the Shots fall in.</p>
          <p>Yield against target is the yield weighed less the Shot's own target, for Shots with both.</p>
          <p>Stopped on weight is the share, of the Shots that recorded what stopped them, that stopped at their target weight.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read the summary: {error}</AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          <Figure term="Shots" value={covered === undefined ? undefined : String(covered)} note={leftOut > 0 ? `${leftOut} cleaning ${leftOut === 1 ? "or calibration Shot" : "and calibration Shots"} left out` : undefined} />
          <Figure term="Duration" number={group && durationText(group.numbers.duration)} note={restsOn(group?.numbers.duration.shots, "had a duration")} />
          <Figure
            term="Yield against target"
            number={group && yieldAgainstTargetText(group.numbers.yieldAgainstTarget)}
            note={restsOn(group?.numbers.yieldAgainstTarget.shots, "had a target and a yield")}
          />
          <Figure
            term="Stopped on weight"
            value={group && shareText(group.numbers.stoppedOnWeight.share)}
            note={restsOn(group?.numbers.stoppedOnWeight.shots, "recorded what stopped them")}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

/** One of a summary's numbers: its value, or its median with the middle half's range beside it, a dash for none, and a note under it. */
function Figure({ term, value, number, note }: { term: string; value?: string; number?: MedianText; note?: string }) {
  const shown = number?.median ?? value;
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="tabular-nums">
        {shown === undefined ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <>
            <span className="text-lg font-semibold">{shown}</span>
            {number && <span className="text-muted-foreground"> ({number.range})</span>}
          </>
        )}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </dd>
    </div>
  );
}
