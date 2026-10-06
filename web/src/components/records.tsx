import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Field, Fields } from "@/components/fields";
import { describeHardware } from "@/components/machines";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Location } from "@/lib/api";
import type { CurveInfo, Sample } from "@/lib/curves";
import { formatInZone } from "@/lib/zoned-time";

// Pieces the Shots and Steam Records pages share.

/** How a Shot or Steam Record is credited: to a Machine, or else the Pending Machine holding it, and its Location. */
export interface Credit {
  machine: { id: string; name: string } | null;
  pendingMachine: { id: string; model: string; serial: string } | null;
  /** Credited to the Machine whose tablet reported it, as only a Shot recording no hardware is. */
  machineInferred?: boolean;
  /** Where its Machine was when it was recorded; null when unknown, and its times are then in UTC. */
  location: Location | null;
  /** Its Location came through an inferred Machine. */
  locationInferred?: boolean;
}

/** The time zone a record's times are shown in: its Location's, or UTC when its Location is unknown. */
export function recordTimeZone(record: Pick<Credit, "location">): string {
  return record.location?.timeZone ?? "UTC";
}

/** A time of a record, in its Location's time zone with the zone named, such as "Oct 4, 2026, 2:14 PM EDT". */
export function recordTime(at: string | null, record: Pick<Credit, "location">): string {
  return at ? formatInZone(at, recordTimeZone(record)) : "Time not known";
}

export function secondsText(seconds: number | null): string | undefined {
  return seconds === null ? undefined : `${seconds.toFixed(1)} s`;
}

export function numberText(value: number | null, unit?: string): string | undefined {
  if (value === null) return undefined;
  return unit ? `${round(value)} ${unit}` : String(round(value));
}

export function round(value: number): number {
  return Number(value.toFixed(2));
}

const INFERRED_MACHINE = "This Shot recorded no machine hardware, so it is credited to the Machine whose tablet reported it.";
const INFERRED_LOCATION = "This Location follows from an inferred Machine's Location History.";

/** Marks a credit that was inferred rather than recorded. */
export function InferredBadge({ what }: { what: "Machine" | "Location" }) {
  return (
    <Badge variant="outline" title={what === "Machine" ? INFERRED_MACHINE : INFERRED_LOCATION}>
      Inferred
    </Badge>
  );
}

/** The Machine a record is credited to, linked, or the Pending Machine holding it, and whether that was inferred. */
export function MachineCredit({ record }: { record: Credit }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {record.machine ? (
        <Link to={`/machines/${record.machine.id}`} className="underline-offset-4 hover:underline">
          {record.machine.name}
        </Link>
      ) : record.pendingMachine ? (
        <>
          <span>{describeHardware(record.pendingMachine)}</span>
          <Badge variant="secondary">Pending Machine</Badge>
        </>
      ) : (
        <span className="text-muted-foreground">No Machine</span>
      )}
      {record.machineInferred && <InferredBadge what="Machine" />}
    </span>
  );
}

/** A record's Location, whether it was inferred, or that it is unknown and its times are in UTC. */
export function LocationCredit({ record }: { record: Credit }) {
  if (!record.location) return <span className="text-muted-foreground">No Location, times in UTC</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {record.location.name}
      {record.locationInferred && <InferredBadge what="Location" />}
    </span>
  );
}

/** A value, or a dash for one the record did not record. */
export function OrNone({ children }: { children: string | undefined }) {
  return children === undefined ? <span className="text-muted-foreground">-</span> : <>{children}</>;
}

/** Fields read from a record, as a card; ones it did not record are left out. */
export function RecordCard({ title, description, fields, empty }: { title: string; description: string; fields: [string, string][]; empty?: string }) {
  return (
    <Card role="region" aria-label={title}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {fields.length > 0 ? (
          <Fields label={title}>
            {fields.map(([term, value]) => (
              <Field key={term} term={term}>
                {value}
              </Field>
            ))}
          </Fields>
        ) : (
          <p className="text-sm text-muted-foreground">{empty ?? "Nothing recorded."}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** A record's samples as a table, for reading exact values. */
export function MeasurementsTable<C extends string>({ curves, samples }: { curves: Record<C, CurveInfo>; samples: Sample<C>[] }) {
  const shown = Object.keys(curves) as C[];
  return (
    <RecordCollapsible label="Measurements as a table" description={`${samples.length} samples, as recorded.`}>
      <div className="max-h-[32rem] overflow-auto rounded-lg border">
        <Table aria-label="Measurements">
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              {shown.map((curve) => (
                <TableHead key={curve}>
                  {curves[curve].label} ({curves[curve].unit})
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className="tabular-nums">
            {samples.map((sample, index) => (
              <TableRow key={index}>
                <TableCell>{sample.seconds.toFixed(2)} s</TableCell>
                {shown.map((curve) => (
                  <TableCell key={curve}>
                    <OrNone>{numberText(sample.values[curve])}</OrNone>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </RecordCollapsible>
  );
}

/** The record as its tablet sent it, but its measurements. */
export function RecordAsSent({ record }: { record: Record<string, unknown> }) {
  return (
    <RecordCollapsible label="Record as sent" description="Everything its tablet sent about it, but its measurements.">
      <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(record, null, 2)}</pre>
    </RecordCollapsible>
  );
}

function RecordCollapsible({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <Collapsible className="grid gap-2">
      <div className="flex items-center gap-3">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="group">
            {label}
            <ChevronDownIcon data-icon="inline-end" className="transition-transform group-data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <span className="text-sm text-muted-foreground">{description}</span>
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
