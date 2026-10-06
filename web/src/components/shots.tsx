import { recordTime, round } from "@/components/records";
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
