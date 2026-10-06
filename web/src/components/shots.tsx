import { Link } from "react-router";
import { describeHardware } from "@/components/machines";
import { Badge } from "@/components/ui/badge";
import type { ShotSummary } from "@/lib/api";
import { formatInZone } from "@/lib/zoned-time";

// Pieces the Shots list and Shot page share.

/** The time zone a Shot's times are shown in: its Location's, or UTC when its Location is unknown. */
export function shotTimeZone(shot: ShotSummary): string {
  return shot.location?.timeZone ?? "UTC";
}

/** When a Shot was pulled, in its Location's time zone with the zone named, such as "Oct 4, 2026, 2:14 PM EDT". */
export function shotTime(shot: ShotSummary): string {
  return shot.pulledAt ? formatInZone(shot.pulledAt, shotTimeZone(shot)) : "Time not known";
}

/** The Bean as the Shot recorded it: its roaster and name, either of which may be missing. */
export function beanText(shot: Pick<ShotSummary, "coffeeRoaster" | "coffeeName">): string | undefined {
  const parts = [shot.coffeeRoaster, shot.coffeeName].filter((part): part is string => !!part?.trim());
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** A weight in grams, as weighed if it was, otherwise as targeted, which is said. */
export function gramsText(actual: number | null, target: number | null): string | undefined {
  if (actual !== null) return `${round(actual)} g`;
  return target !== null ? `${round(target)} g target` : undefined;
}

export function secondsText(seconds: number | null): string | undefined {
  return seconds === null ? undefined : `${seconds.toFixed(1)} s`;
}

export function numberText(value: number | null, unit?: string): string | undefined {
  if (value === null) return undefined;
  return unit ? `${round(value)} ${unit}` : String(round(value));
}

function round(value: number): number {
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

/** The Machine a Shot is credited to, linked, or the Pending Machine holding it, and whether that was inferred. */
export function MachineCredit({ shot }: { shot: ShotSummary }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shot.machine ? (
        <Link to={`/machines/${shot.machine.id}`} className="underline-offset-4 hover:underline">
          {shot.machine.name}
        </Link>
      ) : shot.pendingMachine ? (
        <>
          <span>{describeHardware(shot.pendingMachine)}</span>
          <Badge variant="secondary">Pending Machine</Badge>
        </>
      ) : (
        <span className="text-muted-foreground">No Machine</span>
      )}
      {shot.machineInferred && <InferredBadge what="Machine" />}
    </span>
  );
}

/** A Shot's Location, whether it was inferred, or that it is unknown and its times are in UTC. */
export function LocationCredit({ shot }: { shot: ShotSummary }) {
  if (!shot.location) return <span className="text-muted-foreground">No Location, times in UTC</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shot.location.name}
      {shot.locationInferred && <InferredBadge what="Location" />}
    </span>
  );
}

/** A value, or a dash for one the Shot did not record. */
export function OrNone({ children }: { children: string | undefined }) {
  return children === undefined ? <span className="text-muted-foreground">-</span> : <>{children}</>;
}
