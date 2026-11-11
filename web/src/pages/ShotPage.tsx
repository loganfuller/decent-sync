import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { Curves } from "@/components/curves";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ReferenceShotControl } from "@/components/reference-shots";
import type { ListState } from "@/components/record-lists";
import {
  LocationCredit,
  MachineCredit,
  MeasurementsTable,
  OrNone,
  RecordAsSent,
  RecordCard,
  numberText,
  secondsText,
} from "@/components/records";
import { ShotBasket, ShotBatch, ShotGrinder, ShotProfile, ShotRecipe, beanText, gramsText, shotTime } from "@/components/shots";
import { amount, present, record, text, workflowFields } from "@/components/workflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Recipe, type Shot } from "@/lib/api";
import { SHOT_CURVES, type Sample, type ShotCurve, lastRecordedWeight, shotSamples } from "@/lib/curves";

interface ShotData {
  shot: Shot;
  samples: Sample<ShotCurve>[];
}

/** What a Shot is compared with: nothing, the Shot before it on its Machine, or its Recipe's Reference Shot. */
type Compared = "nothing" | "previous" | "reference";

/** How each Shot compared with is named: in the curves' legends and tooltips, and in the comparison's table. */
const COMPARED = {
  previous: { label: "Previous Shot", comparison: "Comparison with the previous Shot", failed: "The previous Shot could not be loaded" },
  reference: { label: "Reference Shot", comparison: "Comparison with the Reference Shot", failed: "The Reference Shot could not be loaded" },
} as const;

/**
 * One Shot: its curves, everything recorded about it, how it was credited,
 * a comparison with the previous Shot on the same Machine or with its
 * Recipe's Reference Shot (#473), which Recipes it is the Reference Shot of,
 * and a control making it one.
 */
export function ShotPage() {
  const { id = "" } = useParams();
  // Keyed, so a comparison chosen for one Shot never carries over to the next one opened.
  return <ShotDetails key={id} id={id} />;
}

async function loadShot(id: string): Promise<ShotData> {
  const path = `/shots/${encodeURIComponent(id)}`;
  // A Shot never changes its curves, only its metadata, so neither is polled.
  const [{ shot }, { measurements }] = await Promise.all([
    api<{ shot: Shot }>("GET", path),
    api<{ measurements: unknown }>("GET", `${path}/measurements`),
  ]);
  return { shot, samples: shotSamples(measurements, record(shot.record.workflow)?.profile) };
}

function ShotDetails({ id }: { id: string }) {
  const state = useLocation().state as ListState | null;
  const [data, setData] = useState<ShotData>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  const [comparing, setComparing] = useState<Compared>("nothing");
  // Each Shot it has been compared with, by its id, so one is read once: a Map, as an id may be any text.
  const [others, setOthers] = useState<ReadonlyMap<string, ShotData>>(new Map());
  // Counts the choices made, so a load that fails after a later choice says nothing of that one.
  const choicesMade = useRef(0);
  const [compareError, setCompareError] = useState<string>();
  const [referenceId, setReferenceId] = useState<string>();
  const compareId = useId();
  // Making it a Reference Shot changes what it says of that, so the Shot is read again, its curves kept.
  const changed = useCallback(() => {
    api<{ shot: Shot }>("GET", `/shots/${encodeURIComponent(id)}`).then(
      ({ shot }) => setData((loaded) => loaded && { ...loaded, shot }),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : "The Shot could not be loaded"),
    );
  }, [id]);

  useEffect(() => {
    let current = true;
    loadShot(id).then(
      (loaded) => current && setData(loaded),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Shot could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  // Its Recipe's Reference Shot, which the Recipe's own read gives: none for a Shot pulled with no Recipe, a Recipe with
  // none, or one whose Reference Shot is hidden. Read again when the Recipes it is the Reference Shot of change, as its
  // own Recipe may be among them, and then it has no other to compare with.
  const recipeId = data?.shot.recipe?.id;
  const isOwnReference = data?.shot.referenceOf?.some((recipe) => recipe.id === recipeId) ?? false;
  useEffect(() => {
    setReferenceId(undefined);
    if (recipeId === undefined || isOwnReference) return;
    let current = true;
    api<{ recipe: Recipe }>("GET", `/recipes/${encodeURIComponent(recipeId)}`).then(
      ({ recipe }) => current && setReferenceId(recipe.referenceShot && recipe.referenceShot.id !== id ? recipe.referenceShot.id : undefined),
      (caught: unknown) => {
        // A Recipe deleted since is one with no Reference Shot.
        if (!current || (caught instanceof ApiError && caught.status === 404)) return;
        setCompareError(caught instanceof Error ? caught.message : "Its Recipe's Reference Shot could not be read");
      },
    );
    return () => {
      current = false;
    };
  }, [id, recipeId, isOwnReference]);

  const comparable = { previous: data?.shot.previousShot?.id, reference: referenceId };
  // What it is compared with, where there is still such a Shot: its Reference Shot may have become itself.
  const compared = comparing !== "nothing" && comparable[comparing] !== undefined ? comparing : "nothing";
  const comparedId = compared === "nothing" ? undefined : comparable[compared];
  async function compare(choice: Compared) {
    const made = ++choicesMade.current;
    setComparing(choice);
    setCompareError(undefined);
    const otherId = choice === "nothing" ? undefined : comparable[choice];
    if (choice === "nothing" || otherId === undefined || others.has(otherId)) return;
    try {
      const other = await loadShot(otherId);
      setOthers((loaded) => new Map(loaded).set(otherId, other));
    } catch (caught) {
      if (choicesMade.current === made) setCompareError(caught instanceof Error ? caught.message : COMPARED[choice].failed);
    }
  }

  const back = (
    <Link to={`/shots${state?.list ?? ""}`} className="text-sm text-muted-foreground hover:text-foreground">
      ← Shots
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Shot. Its Pending Machine may have been dismissed.</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="grid gap-4">
        {back}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  const { shot, samples } = data;
  const other = comparedId === undefined ? undefined : others.get(comparedId);
  const shown = compared !== "nothing" && other ? { ...COMPARED[compared], ...other } : undefined;
  const on = shot.machine?.name ?? "this Pending Machine";
  const choices: [Compared, string][] = [["nothing", "Nothing"]];
  if (comparable.previous !== undefined) choices.push(["previous", `The previous Shot on ${on}`]);
  if (comparable.reference !== undefined) choices.push(["reference", "Its Recipe's Reference Shot"]);
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Shot pulled {shotTime(shot)}</h1>
        <p className="text-muted-foreground">
          {[shot.profileTitle, beanText(shot), shot.barista].filter(Boolean).join(", ") || "No profile, Bean or Barista recorded"}
        </p>
      </div>

      <ReferenceShotControl shot={shot} onChanged={changed} />

      {shot.machineInferred && (
        <Alert>
          <AlertTitle>Inferred credit</AlertTitle>
          <AlertDescription>
            This Shot recorded no machine hardware, so it is credited to {shot.machine?.name ?? "the Machine"}, whose tablet
            reported it.
            {shot.locationInferred && ` Its Location, ${shot.location!.name}, comes from that Machine's Location History, so it is inferred too.`}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Shot</h2>
            </CardTitle>
            <CardDescription>
              {shot.location ? `Times in ${shot.location.name}'s time zone, ${shot.location.timeZone}.` : "Its Location is unknown, so times are in UTC."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="Shot">
              <Field term="Pulled">{shotTime(shot)}</Field>
              <Field term="Machine">
                <MachineCredit record={shot} />
              </Field>
              <Field term="Location">
                <LocationCredit record={shot} />
              </Field>
              <Field term="Recipe">
                <ShotRecipe shot={shot} />
              </Field>
              <Field term="Profile">
                <ShotProfile shot={shot} />
              </Field>
              <Field term="Bean">
                <OrNone>{beanText(shot)}</OrNone>
              </Field>
              <Field term="Bean Batch">
                <ShotBatch shot={shot} />
              </Field>
              <Field term="Grinder">
                <ShotGrinder shot={shot} />
              </Field>
              <Field term="Basket">
                <ShotBasket shot={shot} />
              </Field>
              <Field term="Dose">
                <OrNone>{gramsText(shot.actualDose, shot.targetDose)}</OrNone>
              </Field>
              <Field term="Yield">
                <OrNone>{gramsText(shot.actualYield, shot.targetYield)}</OrNone>
              </Field>
              <Field term="Duration">
                <OrNone>{secondsText(shot.duration)}</OrNone>
              </Field>
              <Field term="Enjoyment">
                <OrNone>{numberText(shot.enjoyment)}</OrNone>
              </Field>
              <Field term="Barista">
                <OrNone>{shot.barista ?? undefined}</OrNone>
              </Field>
              <Field term="Peak pressure">
                <OrNone>{numberText(shot.peakPressure, "bar")}</OrNone>
              </Field>
              <Field term="Peak flow">
                <OrNone>{numberText(shot.peakFlow, "ml/s")}</OrNone>
              </Field>
            </Fields>
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          <RecordCard title="Annotations" description={ANNOTATIONS_TIP} fields={annotationFields(shot, lastRecordedWeight(samples))} />
          <RecordCard
            title="Machine at the time"
            description="The machine's identity as the Shot recorded it."
            fields={machineFields(shot.record)}
            empty="It recorded no machine hardware."
          />
        </div>
      </div>

      <RecordCard
        title="Workflow"
        description="What its machine was set up to do when it was pulled."
        fields={shotWorkflowFields(shot.record)}
        empty="It recorded no Workflow."
      />

      <Card role="region" aria-label="Curves">
        <CardHeader>
          <CardTitleWithInfo title="Curves">
            <p>
              Seconds from the start of the Shot's profile. Dashed lines are the targets the Machine reported. Flow is the pump's, and weight
              flow the rate coffee lands in the cup, as the scale measured it. Temperature is the group temperature, measured at the group
              head, the sensor closest to the coffee.
            </p>
            <p>
              Grey vertical lines mark where the profile moved from one step to another. The measurements table names each sample's step.
            </p>
            <p>
              Preheat, shaded before 0 s, is the Machine heating its water before the profile starts. Its targets are the heater test's, not the
              profile's, and it doesn't count toward the duration or the peaks.
            </p>
          </CardTitleWithInfo>
        </CardHeader>
        <CardContent className="grid gap-6">
          {choices.length > 1 ? (
            <div className="grid gap-2">
              <p id={`${compareId}-label`} className="text-sm font-medium">
                Compare with
              </p>
              <RadioGroup aria-labelledby={`${compareId}-label`} value={compared} onValueChange={(choice) => void compare(choice as Compared)}>
                {choices.map(([choice, label]) => (
                  <div key={choice} className="flex items-center gap-3">
                    <RadioGroupItem id={`${compareId}-${choice}`} value={choice} />
                    <Label htmlFor={`${compareId}-${choice}`} className="font-normal">
                      {label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">There is no earlier Shot on {on} to compare it with.</p>
          )}
          {compareError && (
            <Alert variant="destructive">
              <AlertDescription>{compareError}</AlertDescription>
            </Alert>
          )}
          {samples.length > 0 ? (
            <Curves curves={SHOT_CURVES} label="This Shot" current={samples} previous={shown && { label: shown.label, samples: shown.samples }} />
          ) : (
            <p className="text-sm text-muted-foreground">No measurements were recorded.</p>
          )}
          {shown && <Comparison shot={shot} other={shown.shot} label={shown.label} name={shown.comparison} />}
          {samples.length > 0 && <MeasurementsTable curves={SHOT_CURVES} samples={samples} steps />}
        </CardContent>
      </Card>

      <RecordAsSent record={shot.record} />
    </section>
  );
}

const ANNOTATIONS_TIP =
  "How it turned out, as recorded on the tablet. The time to first drip is from the start of its profile to the scale's first reading of 1 g or more. The last weight recorded is the scale's last reading in its curves: just before the stop, as Decaid records none after it, or earlier where the scale dropped out. So the yield weighed, which Decaid weighs until the flow settles, less it is roughly what dripped after the stop, unless the yield was edited on the tablet. The flow at the stop is the scale's weight flow at that last reading, the rate coffee was landing in the cup.";

/**
 * Decaid's annotations: the weighed dose and yield, with what the scale's samples show beside the yield (its time to
 * first drip, the last weight they recorded and the flow at the stop), refractometer readings, enjoyment and notes. The
 * time to first drip and the flow at the stop are the Shot's stored ones, which a Shot stored before they were kept has
 * once the server has worked them out.
 */
function annotationFields(shot: Shot, lastWeight: { weight: number; seconds: number } | null): [string, string][] {
  const annotations = record(shot.record.annotations);
  return present([
    ["Dose weighed", amount(annotations?.actualDoseWeight, "g")],
    ["Yield weighed", amount(annotations?.actualYield, "g")],
    // The previous release answers with neither stored value, as it may during a deploy (ADR-0025).
    ["Time to first drip", secondsText(shot.timeToFirstDrip ?? null)],
    ["Last weight recorded", lastWeight ? `${amount(lastWeight.weight, "g")} at ${secondsText(lastWeight.seconds)}` : undefined],
    ["Flow at the stop", numberText(shot.flowAtStop ?? null, "g/s")],
    ["TDS", amount(annotations?.drinkTds, "%")],
    ["Extraction yield", amount(annotations?.drinkEy, "%")],
    ["Enjoyment", text(annotations?.enjoyment)],
    ["Notes", text(annotations?.espressoNotes)],
    ["Stopped by", text(shot.record.stopReason)],
  ]);
}

/** The hardware the Shot recorded in its Workflow (Decaid v0.7.6 and later), and how Decaid knew it. */
function machineFields(shot: Record<string, unknown>): [string, string][] {
  const machine = record(record(shot.workflow)?.machine);
  return present([
    ["Model", text(machine?.model)],
    ["Serial", text(machine?.serialNumber)],
    ["Firmware", text(machine?.firmwareVersion)],
    ["Flow calibration", text(machine?.flowCalibration)],
    ["Provenance", text(machine?.provenanceStatus)],
  ]);
}

/** The Workflow's parts a Machine page shows, and the ones only a Shot's record has. */
function shotWorkflowFields(shot: Record<string, unknown>): [string, string][] {
  const workflow = record(shot.workflow);
  if (!workflow) return [];
  const context = record(workflow.context);
  const extras = record(context?.extras);
  // DYE2's Edit Shot page records the Basket and Tools in the annotations' extras, over the Workflow's (`shotBasketRpm` in DYE2).
  const edited = record(record(shot.annotations)?.extras);
  const basket = edited?.basketId != null || edited?.basketName != null ? edited : extras;
  const toolNames = (from: Record<string, unknown> | undefined) =>
    Array.isArray(from?.equipmentNames) ? from.equipmentNames : from?.equipmentName != null ? [from.equipmentName] : [];
  const tools = [...toolNames(edited), ...toolNames(extras)].filter((name): name is string => typeof name === "string" && name !== "");
  return [
    ...workflowFields(workflow),
    ...present([
      ["Drinker", text(context?.drinkerName)],
      ["Basket", text(basket?.basketName)],
      ["Tools", tools.length > 0 ? [...new Set(tools)].join(", ") : undefined],
      ["Bean Batch, by its tablet's id", text(context?.beanBatchId)],
    ]),
  ];
}

/**
 * This Shot and the one it is compared with, the previous one on its Machine
 * or its Recipe's Reference Shot, side by side: `label` heads the other's
 * column, linking to it, and `name` names the table.
 */
function Comparison({ shot, other, label, name }: { shot: Shot; other: Shot; label: string; name: string }) {
  const rows: [string, (shown: Shot) => string | undefined][] = [
    ["Pulled", shotTime],
    ["Profile", (shown) => shown.profileTitle ?? undefined],
    ["Bean", beanText],
    ["Grind setting", (shown) => text(record(record(shown.record.workflow)?.context)?.grinderSetting)],
    ["Dose", (shown) => gramsText(shown.actualDose, shown.targetDose)],
    ["Yield", (shown) => gramsText(shown.actualYield, shown.targetYield)],
    ["Duration", (shown) => secondsText(shown.duration)],
    ["Peak pressure", (shown) => numberText(shown.peakPressure, "bar")],
    ["Enjoyment", (shown) => numberText(shown.enjoyment)],
    ["Barista", (shown) => shown.barista ?? undefined],
  ];
  return (
    <div className="min-w-0 rounded-lg border">
      <Table aria-label={name}>
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead>This Shot</TableHead>
            <TableHead>
              <Link to={`/shots/${encodeURIComponent(other.id)}`} className="underline underline-offset-4">
                {label}
              </Link>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([label, value]) => (
            <TableRow key={label}>
              <TableHead scope="row">{label}</TableHead>
              <TableCell>
                <OrNone>{value(shot)}</OrNone>
              </TableCell>
              <TableCell>
                <OrNone>{value(other)}</OrNone>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
