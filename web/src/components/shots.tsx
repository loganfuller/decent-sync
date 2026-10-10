import { Link } from "react-router";
import { batchName } from "@/components/bean-batches";
import { grinderName } from "@/components/grinders";
import { profilePath } from "@/components/profiles";
import { OrNone, recordTime, round } from "@/components/records";
import type { ShotSummary } from "@/lib/api";

// Pieces the Shots list and Shot page share; `records.tsx` has those Steam Records share too.

/** When a Shot was pulled, in its Location's time zone with the zone named, such as "Oct 4, 2026, 2:14 PM EDT". */
export function shotTime(shot: ShotSummary): string {
  return recordTime(shot.pulledAt, shot);
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

/** A link to the Library item a Shot is linked to, or a note that it is linked to none. */
function LibraryLink({ to, children }: { to: string | null; children: string | undefined }) {
  if (to === null) return <span className="text-muted-foreground">Not in the Library</span>;
  return (
    <Link to={to} className="underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

/** The Library's Bean Batch the Shot used. */
export function ShotBatch({ shot }: { shot: Pick<ShotSummary, "beanBatch"> }) {
  return <LibraryLink to={shot.beanBatch && `/library/bean-batches/${shot.beanBatch.id}`}>{shot.beanBatch ? batchName(shot.beanBatch) : undefined}</LibraryLink>;
}

/** The Library's Grinder the Shot used. */
export function ShotGrinder({ shot }: { shot: Pick<ShotSummary, "grinder"> }) {
  return <LibraryLink to={shot.grinder && `/library/grinders/${shot.grinder.id}`}>{shot.grinder ? grinderName(shot.grinder) : undefined}</LibraryLink>;
}

/** The profile the Shot recorded, linked to the Library's Profile it was pulled with, if the Library has it. */
export function ShotProfile({ shot }: { shot: Pick<ShotSummary, "profile" | "profileTitle"> }) {
  if (shot.profile === null) return <OrNone>{shot.profileTitle ?? undefined}</OrNone>;
  return (
    <LibraryLink to={profilePath(shot.profile.id)}>{shot.profileTitle ?? shot.profile.title ?? "Untitled Profile"}</LibraryLink>
  );
}
