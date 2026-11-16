import type { ReactNode } from "react";
import { Link } from "react-router";
import { CollapsibleCard } from "@/components/collapsible-card";
import { CurveMark } from "@/components/curves";
import { InfoTip } from "@/components/info-tip";
import { OrNone, numberText, secondsText } from "@/components/records";
import { RatingAndNote } from "@/components/shot-edits";
import { ShotBasket, ShotBatch, ShotGrinder, ShotProfile, ShotRecipe, beanText } from "@/components/shots";
import { SpecMark } from "@/components/spec-mark";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { amount, record, shotRecordParts, workflowParts } from "@/components/workflow";
import type { Recipe, Shot } from "@/lib/api";
import { type Sample, type ShotCurve, lastRecordedWeight } from "@/lib/curves";
import { type Difference, durationDifference, ratedShotsPath, yieldDifference } from "@/lib/shot-list";
import { stoppedText } from "@/lib/stops";

// The cards of a Shot's page (#546) under its title: How it went, the
// comparison under its curves, and Details. The page itself, with its
// curves and what they are compared with, is `pages/ShotPage.tsx`.

/** What a Shot's duration is read against: its Recipe's Reference Shot, which it is itself (`own`), or which its Recipe, once read, has none of (`none`). */
export type Reference = "own" | "none" | undefined;

/** A weight in grams as weighed, to hundredths. */
function grams(weight: number | null): string | undefined {
  return numberText(weight, "g");
}

/** A difference under its figure: marked where it is out of spec, and muted otherwise. */
function Against({ difference, against }: { difference: Difference; against: string }) {
  const words = `${difference.text} ${against}`;
  return difference.marked ? <SpecMark>{words}</SpecMark> : <span className="text-muted-foreground">{words}</span>;
}

/** One figure of How it went: what it is, its value, large, and under it what it is read against. */
function Figure({ term, value, words = false, children }: { term: string; value: string | undefined; words?: boolean; children?: ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
      {/* Words are set smaller than a number, on a line as tall. */}
      <dd className={words ? "flex min-h-8 items-center text-base leading-tight font-semibold wrap-anywhere" : "text-2xl leading-8 font-semibold"}>
        <OrNone>{value}</OrNone>
      </dd>
      {children && <dd>{children}</dd>}
    </div>
  );
}

/**
 * How a Shot went, in one card of figures under its title: its duration
 * against its Recipe's Reference Shot's and its yield against its own
 * target, each difference marked where the server judged it out of spec
 * and muted otherwise (#543), its dose with its target, how it stopped, in
 * words, and its rating and note, edited here (`RatingAndNote`). An
 * Unfinished Shot and a cleaning or calibration Shot say what they are
 * beside the title, and carry no mark, as the server judges neither.
 */
export function HowItWentCard({ shot, reference, onEdited }: { shot: Shot; reference: Reference; onEdited(shot: Shot): void }) {
  const spec = shot.spec;
  const duration = durationDifference(spec);
  const against = yieldDifference(spec);
  const judged = spec !== undefined && !spec.unfinished && !spec.cleaningOrCalibration;
  return (
    <Card role="region" aria-label="How it went">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2>How it went</h2>
          {spec?.cleaningOrCalibration ? (
            <Kind name="Cleaning or calibration Shot">
              By its profile's type, as recorded. It is judged against no margin, and a Shot Summary leaves it out of its numbers.
            </Kind>
          ) : (
            spec?.unfinished && (
              <Kind name="Unfinished Shot">
                Nothing poured: its Machine never reached pouring and its scale never read a gram. It is judged against no margin, and a Shot Summary
                counts it apart.
              </Kind>
            )
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* The last column, its rating and note, is wider than a number's. */}
        <dl aria-label="How it went" className="grid grid-cols-2 gap-x-4 gap-y-4 tabular-nums md:grid-cols-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.4fr)]">
          <Figure term="Duration" value={secondsText(shot.duration)}>
            {reference === "own" ? (
              <span className="text-muted-foreground">Its Recipe's Reference Shot</span>
            ) : duration ? (
              <Against difference={duration} against="vs reference" />
            ) : (
              reference === "none" &&
              judged &&
              shot.recipe && (
                <Link to={ratedShotsPath(shot.recipe.id)} className="text-muted-foreground underline decoration-dotted underline-offset-4">
                  No reference
                </Link>
              )
            )}
          </Figure>
          <Figure term="Yield" value={grams(shot.actualYield)}>
            {against && shot.targetYield !== null ? (
              <Against difference={against} against={`vs its ${grams(shot.targetYield)} target`} />
            ) : (
              shot.targetYield !== null && <span className="text-muted-foreground">target {grams(shot.targetYield)}</span>
            )}
          </Figure>
          <Figure term="Dose" value={grams(shot.actualDose)}>
            {shot.targetDose !== null && <span className="text-muted-foreground">target {grams(shot.targetDose)}</span>}
          </Figure>
          {/* In words, by the kind the server gives it (#543); as recorded for a reason of no kind, and from the previous release. */}
          <Figure term="Stopped" value={stoppedText(spec?.stopped, shot.stopReason)} words />
          <RatingAndNote shot={shot} onEdited={onEdited} />
        </dl>
      </CardContent>
    </Card>
  );
}

/** What kind of Shot it is, where it is judged by none of the margins, with what that means in a tooltip. */
function Kind({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="outline">{name}</Badge>
      <InfoTip label={`About ${name}`}>
        <p>{children}</p>
      </InfoTip>
    </span>
  );
}

/** The numbers a Shot is compared by, under its curves: each Shot's, in this order. */
const COMPARED: [string, string, (shot: Shot) => string | undefined][] = [
  ["Duration", "Duration", (shot) => secondsText(shot.duration)],
  ["Yield", "Yield", (shot) => grams(shot.actualYield)],
  // The previous release answers with no time to first drip, as it may during a deploy (ADR-0025).
  ["Time to first drip", "First drip", (shot) => secondsText(shot.timeToFirstDrip ?? null)],
  ["Peak pressure", "Peak pressure", (shot) => numberText(shot.peakPressure, "bar")],
  ["Grind setting", "Grind", (shot) => shot.grinderSetting ?? undefined],
];

/**
 * This Shot and the one its curves are drawn over, the previous one on its
 * Machine or its Recipe's Reference Shot, side by side: a row for each, by
 * the line its curves are drawn with, the other's name linking to it. On a
 * narrow screen each Shot's numbers are a few lines under its name, so
 * nothing scrolls sideways. `label` names the other, and `name` the
 * comparison.
 */
export function ShotComparison({ shot, other, label, name }: { shot: Shot; other: Shot; label: string; name: string }) {
  const otherLink = (
    <Link to={`/shots/${encodeURIComponent(other.id)}`} className="underline underline-offset-4">
      {label}
    </Link>
  );
  const shots = [
    { key: "current", shot, heading: "This Shot" as ReactNode },
    { key: "previous", shot: other, heading: otherLink },
  ] as const;
  return (
    <>
      <div className="min-w-0 rounded-lg border tabular-nums max-sm:hidden">
        <Table aria-label={name}>
          <TableHeader>
            <TableRow>
              <TableHead />
              {COMPARED.map(([number]) => (
                <TableHead key={number}>{number}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shots.map(({ key, shot: shown, heading }) => (
              <TableRow key={key}>
                <TableHead scope="row">
                  <span className="flex items-center gap-2 font-semibold text-foreground">
                    <CurveMark of={key} />
                    {heading}
                  </span>
                </TableHead>
                {COMPARED.map(([number, , value]) => (
                  <TableCell key={number}>
                    <OrNone>{value(shown)}</OrNone>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label={name} className="divide-y rounded-lg border tabular-nums sm:hidden">
        {shots.map(({ key, shot: shown, heading }) => (
          <li key={key} className="grid gap-1.5 px-3 py-2.5">
            <span className="flex items-center gap-2 font-semibold">
              <CurveMark of={key} />
              {heading}
            </span>
            <dl className="flex flex-wrap gap-x-3.5 gap-y-0.5">
              {COMPARED.map(([number, short, value]) => (
                <div key={number} className="flex gap-1.5">
                  <dt className="text-muted-foreground">{short}</dt>
                  <dd>
                    <OrNone>{value(shown)}</OrNone>
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Every other fact of a Shot, once each, in one card closed until opened
 * (#546): what it was pulled with, each Library item linked, then what its
 * machine and scale measured, the steam, hot water and flush settings it
 * was set up with, and the machine as the Shot recorded it. What it was
 * pulled with is always listed, with a dash for what it recorded none of;
 * the rest only where recorded. `recipe` is its Recipe as read, for the
 * Recipe Slot it is in.
 */
export function ShotDetailsCard({ shot, samples, recipe }: { shot: Shot; samples: Sample<ShotCurve>[]; recipe: Recipe | undefined }) {
  const zone = shot.location
    ? `Times on this page are in ${shot.location.name}'s time zone, ${shot.location.timeZone}.`
    : "Its Location is unknown, so times on this page are in UTC.";
  return (
    <CollapsibleCard
      title="Details"
      info={
        <>
          <p>
            What it was pulled with and what its Machine and scale measured, as recorded on its tablet. A Recipe Slot is the one its Recipe is in now.{" "}
            {zone}
          </p>
          <p>
            The time to first drip is from the start of its profile to the scale's first reading of 1 g or more. The last weight recorded is the
            scale's last reading in its curves: just before the stop, as Decaid records none after it, or earlier where the scale dropped out. So
            the yield, which Decaid weighs until the flow settles, less it is roughly what dripped after the stop, unless the yield was edited on
            the tablet. The flow at the stop is the scale's weight flow at that last reading, the rate coffee was landing in the cup.
          </p>
        </>
      }
    >
      <CardContent>
        <dl aria-label="Details" className="grid grid-cols-2 gap-x-6 gap-y-3 tabular-nums lg:grid-cols-3">
          {detailsOf(shot, samples, recipe).map(([term, value]) => (
            <div key={term} className="min-w-0">
              <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
              <dd className="wrap-anywhere">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </CollapsibleCard>
  );
}

/**
 * The name the Shot recorded for a Library item it is linked to, where that is another than the item's name now, as
 * after the item was renamed: said beside its link, so what the Shot recorded is not lost.
 */
function RecordedAs({ recorded, linked }: { recorded: string | null; linked: string | null }) {
  if (recorded === null || recorded.trim() === (linked ?? "").trim()) return null;
  return <span className="text-muted-foreground"> (recorded as {recorded})</span>;
}

/** The Details list's terms and values, in order. */
function detailsOf(shot: Shot, samples: Sample<ShotCurve>[], recipe: Recipe | undefined): [string, ReactNode][] {
  const workflow = workflowParts(record(shot.record.workflow) ?? {});
  const recorded = shotRecordParts(shot.record);
  const lastWeight = lastRecordedWeight(samples);
  const slot = recipe?.slot ?? null;
  const measured: [string, string | undefined][] = [
    ["Burrs", workflow.burrs],
    ["Tools", recorded.tools],
    ["Drinker", recorded.drinker],
    ["Brew temperature", workflow.brewTemperature],
    ["Peak pressure", numberText(shot.peakPressure, "bar")],
    ["Peak flow", numberText(shot.peakFlow, "ml/s")],
    // The previous release answers with neither stored value, as it may during a deploy (ADR-0025).
    ["Time to first drip", secondsText(shot.timeToFirstDrip ?? null)],
    ["Last weight recorded", lastWeight ? `${amount(lastWeight.weight, "g")} at ${secondsText(lastWeight.seconds)}` : undefined],
    ["Flow at the stop", numberText(shot.flowAtStop ?? null, "g/s")],
    ["TDS", numberText(shot.tds, "%")],
    ["Extraction yield", numberText(shot.extractionYield, "%")],
    ["Steam", workflow.steam],
    ["Hot water", workflow.hotWater],
    ["Flush", workflow.flush],
  ];
  return [
    [
      "Recipe",
      <>
        <ShotRecipe shot={shot} />
        {shot.recipe && slot !== null && ` (slot ${slot})`}
      </>,
    ],
    ["Profile", <ShotProfile shot={shot} />],
    ["Bean", <OrNone>{beanText(shot)}</OrNone>],
    // One its tablet named by an id the Library has no Bean Batch for reads as not linked, as one it named none of.
    ["Bean Batch", shot.beanBatch ? <ShotBatch shot={shot} /> : <span className="text-muted-foreground">Not linked</span>],
    [
      "Grinder",
      <>
        {/* The Library's Grinder, linked, or else its model as recorded. */}
        {shot.grinder ? <ShotGrinder shot={shot} /> : shot.grinderModel === null && shot.grinderSetting !== null ? "Grind setting" : <OrNone>{shot.grinderModel ?? undefined}</OrNone>}
        {shot.grinder && <RecordedAs recorded={shot.grinderModel} linked={shot.grinder.model} />}
        {shot.grinderSetting !== null && ` ${shot.grinder || shot.grinderModel !== null ? "at " : ""}${shot.grinderSetting}`}
      </>,
    ],
    [
      "Basket",
      shot.basket ? (
        <>
          <ShotBasket shot={shot} />
          <RecordedAs recorded={shot.basketName} linked={shot.basket.name} />
        </>
      ) : (
        <OrNone>{shot.basketName ?? undefined}</OrNone>
      ),
    ],
    ["Barista", <OrNone>{shot.barista ?? undefined}</OrNone>],
    ...measured.flatMap(([term, value]): [string, ReactNode][] => (value === undefined ? [] : [[term, value]])),
    ["Machine, as recorded", recorded.machine ?? <span className="text-muted-foreground">It recorded no machine hardware</span>],
  ];
}
