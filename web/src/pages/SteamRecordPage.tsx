import { useEffect, useState } from "react";
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
  recordTime,
  secondsText,
} from "@/components/records";
import { amount, present, record } from "@/components/workflow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api, type SteamRecord } from "@/lib/api";
import { STEAM_CURVES, type Sample, type SteamCurve, steamSamples } from "@/lib/curves";

interface SteamRecordData {
  steamRecord: SteamRecord;
  samples: Sample<SteamCurve>[];
}

/** One Steam Record: its milk temperature and curves, how it was credited, and its steam settings. */
export function SteamRecordPage() {
  const { id = "" } = useParams();
  return <SteamRecordDetails key={id} id={id} />;
}

async function loadSteamRecord(id: string): Promise<SteamRecordData> {
  const path = `/steam-records/${encodeURIComponent(id)}`;
  // A Steam Record is stored once and never changes, only its credit, so neither is polled.
  const [{ steamRecord }, { measurements }] = await Promise.all([
    api<{ steamRecord: SteamRecord }>("GET", path),
    api<{ measurements: unknown }>("GET", `${path}/measurements`),
  ]);
  const stopAt = record(record(steamRecord.record.workflow)?.steamSettings)?.stopAtTemperature;
  return { steamRecord, samples: steamSamples(measurements, typeof stopAt === "number" && stopAt > 0 ? stopAt : null) };
}

function SteamRecordDetails({ id }: { id: string }) {
  const state = useLocation().state as ListState | null;
  const [data, setData] = useState<SteamRecordData>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    loadSteamRecord(id).then(
      (loaded) => current && setData(loaded),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : "The Steam Record could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id]);

  const back = (
    <Link to={`/steam-records${state?.list ?? ""}`} className="text-sm text-muted-foreground hover:text-foreground">
      ← Steam Records
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Steam Record. Its Pending Machine may have been dismissed.</p>
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

  const { steamRecord, samples } = data;
  const time = recordTime(steamRecord.steamedAt, steamRecord);
  const milk = numberText(steamRecord.peakMilkTemperature, "°C");
  const carriedOver = carriedOverReading(steamRecord, samples);
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Steam Record from {time}</h1>
        <p className="text-muted-foreground">
          {[milk && `Milk to ${milk}`, steamRecord.barista].filter(Boolean).join(", ") || "No milk temperature or Barista recorded"}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Steam Record</h2>
            </CardTitle>
            <CardDescription>
              {steamRecord.location
                ? `Times in ${steamRecord.location.name}'s time zone, ${steamRecord.location.timeZone}.`
                : "Its Location is unknown, so times are in UTC."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Fields label="Steam Record">
              <Field term="Steamed">{time}</Field>
              <Field term="Machine">
                <MachineCredit record={steamRecord} />
              </Field>
              <Field term="Location">
                <LocationCredit record={steamRecord} />
              </Field>
              <Field term="Duration">
                <OrNone>{secondsText(steamRecord.duration)}</OrNone>
              </Field>
              <Field term="Peak milk temperature">
                <OrNone>{milk}</OrNone>
                {carriedOver !== undefined && (
                  <span className="block text-muted-foreground">
                    Leaves out the {numberText(carriedOver, "°C")} it started with: the milk probe's last reading of the Steam
                    Record before, which Decaid carries over.
                  </span>
                )}
              </Field>
              <Field term="Final milk temperature">
                <OrNone>{numberText(steamRecord.finalMilkTemperature, "°C")}</OrNone>
              </Field>
              <Field term="Barista">
                <OrNone>{steamRecord.barista ?? undefined}</OrNone>
              </Field>
            </Fields>
          </CardContent>
        </Card>

        <RecordCard
          title="Steam settings"
          description="What its Workflow set when it started."
          fields={steamSettingsFields(steamRecord.record)}
          empty="It recorded no steam settings."
        />
      </div>

      <Card role="region" aria-label="Curves">
        <CardHeader>
          <CardTitle>
            <h2>Curves</h2>
          </CardTitle>
          <CardDescription>
            Seconds from the start of the Steam Record. Dashed lines are targets: the milk temperature its Workflow stops
            steaming at, and those its machine reported.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {samples.length > 0 ? (
            <Curves curves={STEAM_CURVES} label="This Steam Record" current={samples} />
          ) : (
            <p className="text-sm text-muted-foreground">No measurements were recorded.</p>
          )}
          {samples.length > 0 && <MeasurementsTable curves={STEAM_CURVES} samples={samples} />}
        </CardContent>
      </Card>

      <RecordAsSent record={steamRecord.record} />
    </section>
  );
}

/**
 * The milk temperature a Steam Record started with, when its peak leaves it
 * out: Decaid starts each with the probe's latest reading, which until the
 * probe reports again is the last of the Steam Record before, and the server
 * leaves that out of the peak when the next reading is lower. Only a reading
 * above the peak can have been left out, so only then is it shown.
 */
function carriedOverReading(steamRecord: SteamRecord, samples: Sample<SteamCurve>[]): number | undefined {
  const first = samples.find((sample) => sample.values.milkTemperature !== null)?.values.milkTemperature;
  const peak = steamRecord.peakMilkTemperature;
  return first != null && peak !== null && first > peak ? first : undefined;
}

/** The steam settings its Workflow recorded, as Decaid names them; a stop at a milk temperature of 0 is off. */
function steamSettingsFields(steamRecord: Record<string, unknown>): [string, string][] {
  const steam = record(record(steamRecord.workflow)?.steamSettings);
  const stopAt = steam?.stopAtTemperature;
  return present([
    ["Steam temperature", amount(steam?.targetTemperature, "°C")],
    ["Duration", amount(steam?.duration, "s")],
    ["Flow", amount(steam?.flow, "ml/s")],
    ["Stops at milk temperature", typeof stopAt === "number" && stopAt <= 0 ? "Off" : amount(stopAt, "°C")],
  ]);
}
