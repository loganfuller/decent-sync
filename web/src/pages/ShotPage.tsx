import { useCallback, useEffect, useId, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { Curves } from "@/components/curves";
import { Field, Fields } from "@/components/fields";
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
import { beanText, gramsText, shotTime } from "@/components/shots";
import { amount, present, record, text, workflowFields } from "@/components/workflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field as FormField, FieldLabel } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Shot } from "@/lib/api";
import { SHOT_CURVES, type Sample, type ShotCurve, shotSamples } from "@/lib/curves";

interface ShotData {
  shot: Shot;
  samples: Sample<ShotCurve>[];
}

/**
 * One Shot: its curves, everything recorded about it, how it was credited,
 * and a comparison with the previous Shot on the same Machine.
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
  return { shot, samples: shotSamples(measurements) };
}

function ShotDetails({ id }: { id: string }) {
  const state = useLocation().state as ListState | null;
  const [data, setData] = useState<ShotData>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  const [comparing, setComparing] = useState(false);
  const [previous, setPrevious] = useState<ShotData>();
  const [previousError, setPreviousError] = useState<string>();
  const compareId = useId();

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

  const previousId = data?.shot.previousShot?.id;
  const compare = useCallback(
    async (checked: boolean) => {
      setComparing(checked);
      if (!checked || !previousId || previous) return;
      setPreviousError(undefined);
      try {
        setPrevious(await loadShot(previousId));
      } catch (caught) {
        setPreviousError(caught instanceof Error ? caught.message : "The previous Shot could not be loaded");
      }
    },
    [previousId, previous],
  );

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
  const shown = comparing && previous ? previous : undefined;
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Shot pulled {shotTime(shot)}</h1>
        <p className="text-muted-foreground">
          {[shot.profileTitle, beanText(shot), shot.barista].filter(Boolean).join(", ") || "No profile, Bean or Barista recorded"}
        </p>
      </div>

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
              <Field term="Profile">
                <OrNone>{shot.profileTitle ?? undefined}</OrNone>
              </Field>
              <Field term="Bean">
                <OrNone>{beanText(shot)}</OrNone>
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
          <RecordCard title="Annotations" description="How it turned out, as recorded on the tablet." fields={annotationFields(shot.record)} />
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
          <CardTitle>
            <h2>Curves</h2>
          </CardTitle>
          <CardDescription>Seconds from the start of the Shot. Dashed lines are the targets its profile set.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {shot.previousShot ? (
            <FormField orientation="horizontal">
              <Checkbox id={compareId} checked={comparing} onCheckedChange={(checked) => void compare(checked === true)} />
              <FieldLabel htmlFor={compareId} className="font-normal">
                Compare with the previous Shot on {shot.machine?.name ?? "this Pending Machine"}
              </FieldLabel>
            </FormField>
          ) : (
            <p className="text-sm text-muted-foreground">
              There is no earlier Shot on {shot.machine?.name ?? "this Pending Machine"} to compare it with.
            </p>
          )}
          {previousError && (
            <Alert variant="destructive">
              <AlertDescription>{previousError}</AlertDescription>
            </Alert>
          )}
          {samples.length > 0 ? (
            <Curves curves={SHOT_CURVES} label="This Shot" current={samples} previous={shown && { label: "Previous Shot", samples: shown.samples }} />
          ) : (
            <p className="text-sm text-muted-foreground">No measurements were recorded.</p>
          )}
          {shown && <Comparison shot={shot} previous={shown.shot} />}
          {samples.length > 0 && <MeasurementsTable curves={SHOT_CURVES} samples={samples} />}
        </CardContent>
      </Card>

      <RecordAsSent record={shot.record} />
    </section>
  );
}

/** Decaid's annotations: the weighed dose and yield, refractometer readings, enjoyment and notes. */
function annotationFields(shot: Record<string, unknown>): [string, string][] {
  const annotations = record(shot.annotations);
  return present([
    ["Dose weighed", amount(annotations?.actualDoseWeight, "g")],
    ["Yield weighed", amount(annotations?.actualYield, "g")],
    ["TDS", amount(annotations?.drinkTds, "%")],
    ["Extraction yield", amount(annotations?.drinkEy, "%")],
    ["Enjoyment", text(annotations?.enjoyment)],
    ["Notes", text(annotations?.espressoNotes)],
    ["Stopped by", text(shot.stopReason)],
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
  return [
    ...workflowFields(workflow),
    ...present([
      ["Drinker", text(context?.drinkerName)],
      ["Basket", text(extras?.basketName)],
      ["Bean Batch, by its tablet's id", text(context?.beanBatchId)],
    ]),
  ];
}

/** This Shot and the previous one on its Machine, side by side. */
function Comparison({ shot, previous }: { shot: Shot; previous: Shot }) {
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
    <div className="rounded-lg border">
      <Table aria-label="Comparison with the previous Shot">
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead>This Shot</TableHead>
            <TableHead>
              <Link to={`/shots/${encodeURIComponent(previous.id)}`} className="underline underline-offset-4">
                Previous Shot
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
                <OrNone>{value(previous)}</OrNone>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
