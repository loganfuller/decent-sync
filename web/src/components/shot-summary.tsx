import { ChevronDownIcon } from "lucide-react";
import { useCallback } from "react";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type LastSteps, api, type ShotSummary, type SummaryGroup } from "@/lib/api";
import { MEDIAN_TEXT, type MedianText, NUMBERS, NUMBER_NAMES, type NumberName, countNotes, settingText, shareText, shotsText } from "@/lib/shot-summary";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** What each number shown as a median rests on, for the note under it where some Shots had no value: "12 of 40 Shots …". */
const RESTS_ON: Record<keyof typeof MEDIAN_TEXT, string> = {
  yieldAgainstTarget: "had a target and a yield",
  duration: "had a duration",
  ratio: "had a dose and a yield",
  peakPressure: "had a peak pressure",
  peakFlow: "had a peak flow",
  rating: "rated",
  grindSetting: "had a grind setting that is a number",
  tds: "had a TDS",
  extractionYield: "had an extraction yield",
  timeToFirstDrip: "read 1 g on the scale",
};

/**
 * The Shot Summary of the Shots a list's filters find (#466, #469), above
 * its rows: how many there are and the `numbers` chosen, by default their
 * duration and yield against target, each as a median with the range the
 * middle half fall in, and the share that stopped on weight. The Shots
 * count says how many cleaning, calibration and Unfinished Shots were left
 * out where there are any, and how many still await their stored numbers.
 *
 * `filterQuery` is the list's filters as the REST API's query, so the
 * summary follows them, and `numbers` those its address keeps, which
 * `onNumbers` changes; it is loaded again every 30 s, less often than the
 * rows, as it reads every Shot the filters find. What the last filters and
 * numbers gave stays until the next ones' arrives, as the rows do, a number
 * just chosen showing a dash until then, but not while a load has failed
 * since the last that succeeded: it would stand under that failure as
 * theirs until the next load, 30 s on. So filters changed after a failed
 * load show dashes until theirs arrives.
 */
export function ShotSummaryCard({ filterQuery, numbers, onNumbers }: { filterQuery: string; numbers: NumberName[]; onNumbers(numbers: NumberName[]): void }) {
  const query = new URLSearchParams([...new URLSearchParams(filterQuery), ["numbers", numbers.join(",")]]).toString();
  // Each summary loaded remembers the query it answers.
  const load = useCallback(async () => ({ query, summary: await api<ShotSummary>("GET", `/shots/summary?${query}`) }), [query]);
  const { data: loaded, error } = usePolled(load, DETAILS_POLL_MS);
  const group = loaded && (loaded.query === query || !error) ? loaded.summary.groups[0] : undefined;

  return (
    <Card role="region" aria-label="Summary">
      <CardHeader>
        <CardTitleWithInfo title="Summary">
          <p>
            How the Shots these filters find went, leaving out cleaning and calibration Shots, and Unfinished Shots, in which nothing poured: the
            Machine never reached pouring and the scale never read 1 g.
          </p>
          <p>Each number is a median, with the range the middle half of the Shots fall in. Choose which to show with Numbers.</p>
          <p>Yield against target is the yield weighed less the Shot's own target, for Shots with both. The ratio is the yield weighed over the dose weighed.</p>
          <p>Stopped on weight is the share, of the Shots that recorded what stopped them, that stopped at their target weight.</p>
          <p>A rating of 0 is no rating, as DYE2 records one with no stars. A grind setting counts where it is a number, such as 8.8.</p>
          <p>
            Time to first drip and the last step are worked out from each Shot's measurements. For Shots stored before they were, that happens in
            the background, and the count says how many are still waiting.
          </p>
        </CardTitleWithInfo>
        <CardAction>
          <NumbersChoice numbers={numbers} onNumbers={onNumbers} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read the summary: {error}</AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          <Figure term="Shots" value={group && String(group.counts.shots)} notes={group && countNotes(group.counts)} />
          {numbers.map((name) => (
            <NumberFigure key={name} name={name} group={group} />
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** The choice of numbers shown, at least one, each ticked or not, the menu staying open to tick another. */
function NumbersChoice({ numbers, onNumbers }: { numbers: NumberName[]; onNumbers(numbers: NumberName[]): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Numbers <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {NUMBERS.map((name) => {
          const shown = numbers.includes(name);
          return (
            <DropdownMenuCheckboxItem
              key={name}
              checked={shown}
              disabled={shown && numbers.length === 1}
              onCheckedChange={(checked) => onNumbers(checked ? NUMBERS.filter((each) => each === name || numbers.includes(each)) : numbers.filter((each) => each !== name))}
              onSelect={(event) => event.preventDefault()}
            >
              {NUMBER_NAMES[name]}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One of the numbers chosen, as `group` gives it: a dash until it does. */
function NumberFigure({ name, group }: { name: NumberName; group: SummaryGroup | undefined }) {
  const covered = group?.counts.shots;
  /** How many Shots a number rests on, said only where some of those covered had no value for it. */
  const restsOn = (shots: number | undefined, which: string) => (shots === undefined || covered === undefined || shots === covered ? undefined : `${shots} of ${shotsText(covered)} ${which}`);
  const term = NUMBER_NAMES[name];
  switch (name) {
    case "stoppedOnWeight": {
      const number = group?.numbers.stoppedOnWeight;
      return <Figure term={term} value={number && shareText(number.share)} notes={[restsOn(number?.shots, "recorded what stopped them")]} />;
    }
    case "lastStep": {
      const number = group?.numbers.lastStep;
      return <LastStepFigure lastStep={number} restsOn={restsOn(number?.shots, "ended in a step")} />;
    }
    case "grindSetting": {
      const number = group?.numbers.grindSetting;
      const span = number && number.lowest !== null && number.highest !== null && number.lowest !== number.highest ? `From ${settingText(number.lowest)} to ${settingText(number.highest)}` : undefined;
      return <Figure term={term} number={number && MEDIAN_TEXT.grindSetting(number)} notes={[span, restsOn(number?.shots, RESTS_ON.grindSetting)]} />;
    }
    default: {
      const number = group?.numbers[name];
      return <Figure term={term} number={number && MEDIAN_TEXT[name](number)} notes={[restsOn(number?.shots, RESTS_ON[name])]} />;
    }
  }
}

/** The steps the Shots ended in, those most of them did first, each with how many, and how many ended in others. */
function LastStepFigure({ lastStep, restsOn }: { lastStep: LastSteps | undefined; restsOn: string | undefined }) {
  const listed = lastStep?.mostCommon ?? [];
  const others = lastStep ? lastStep.shots - listed.reduce((sum, step) => sum + step.shots, 0) : 0;
  return (
    <div className="grid content-start gap-0.5">
      <dt className="text-muted-foreground">{NUMBER_NAMES.lastStep}</dt>
      <dd className="tabular-nums">
        {listed.length === 0 ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <ul className="grid gap-0.5">
            {listed.map((step) => (
              <li key={`${step.frame} ${step.name}`}>
                <span className="font-semibold">{step.name ?? `Step ${step.frame + 1}`}</span> <span className="text-muted-foreground">({step.shots})</span>
              </li>
            ))}
            {others > 0 && <li className="text-muted-foreground">Other steps ({others})</li>}
          </ul>
        )}
        {restsOn && <p className="text-xs text-muted-foreground">{restsOn}</p>}
      </dd>
    </div>
  );
}

/** One of a summary's numbers: its value, or its median with the middle half's range beside it, a dash for none, and notes under it. */
function Figure({ term, value, number, notes }: { term: string; value?: string; number?: MedianText; notes?: (string | undefined)[] }) {
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
        {notes?.map(
          (note) =>
            note && (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ),
        )}
      </dd>
    </div>
  );
}
