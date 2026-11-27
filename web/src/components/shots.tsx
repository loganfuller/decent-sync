import { StarIcon } from "lucide-react";
import { Link } from "react-router";
import { BatchCell } from "@/components/batch-name";
import { grinderName } from "@/components/grinders";
import { profilePath } from "@/components/profiles";
import { OrNone, recordTime, round } from "@/components/records";
import type { ListedShot } from "@/lib/api";
import { roastedBeforeShot } from "@/lib/batch-name";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { dateIn } from "@/lib/machine-activity";
import { MAX_STARS, ratingText, starsOf } from "@/lib/rating";

// Pieces the Shots list and Shot page share; `records.tsx` has those Steam Records share too.

/** When a Shot was pulled, in its Location's time zone with the zone named, such as "Oct 4, 2026, 2:14 PM EDT". */
export function shotTime(shot: ListedShot): string {
  return recordTime(shot.pulledAt, shot);
}

/** The Bean as the Shot recorded it: its roaster and name, either of which may be missing. */
export function beanText(shot: Pick<ListedShot, "coffeeRoaster" | "coffeeName">): string | undefined {
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

/**
 * The Library's Bean Batch the Shot used, on the Shot's page (#732): the
 * batch, linked, with its Batch Code, over its roast day and how many days
 * after it the Shot was pulled, by the Shot's day at its Location, such as
 * "Roasted 17 Nov, 10 days before this Shot". The days are left out for a
 * batch with no roast date, a Shot pulled before it, and one whose time
 * isn't known.
 */
export function ShotBatch({ shot }: { shot: Pick<ListedShot, "beanBatch" | "pulledAt" | "location"> }) {
  if (shot.beanBatch === null) return <LibraryLink to={null}>{undefined}</LibraryLink>;
  const before = roastedBeforeShot(shot.beanBatch.roastDate, shot.pulledAt === null ? undefined : dateIn(shot.location?.timeZone, Date.parse(shot.pulledAt)));
  return <BatchCell batch={shot.beanBatch} id={shot.beanBatch.id} also={before === undefined ? undefined : `, ${before}`} />;
}

/** The Library's Grinder the Shot used. */
export function ShotGrinder({ shot }: { shot: Pick<ListedShot, "grinder"> }) {
  return <LibraryLink to={shot.grinder && `/library/grinders/${shot.grinder.id}`}>{shot.grinder ? grinderName(shot.grinder) : undefined}</LibraryLink>;
}

/** The Library's Recipe the Shot was pulled with, as its Machine had it loaded; none where it had none loaded. */
export function ShotRecipe({ shot }: { shot: Pick<ListedShot, "recipe"> }) {
  if (shot.recipe === null) return <OrNone>{undefined}</OrNone>;
  return <LibraryLink to={`${LIBRARY_KINDS.recipe.pages}/${shot.recipe.id}`}>{shot.recipe.name ?? "Unnamed Recipe"}</LibraryLink>;
}

/** The Library's Basket the Shot used, as DYE2 recorded it. */
export function ShotBasket({ shot }: { shot: Pick<ListedShot, "basket"> }) {
  return <LibraryLink to={shot.basket && `${LIBRARY_KINDS.basket.pages}/${shot.basket.id}`}>{shot.basket ? (shot.basket.name ?? "Unnamed Basket") : undefined}</LibraryLink>;
}

/** The profile the Shot recorded, linked to the Library's Profile it was pulled with, if the Library has it. */
export function ShotProfile({ shot }: { shot: Pick<ListedShot, "profile" | "profileTitle"> }) {
  if (shot.profile === null) return <OrNone>{shot.profileTitle ?? undefined}</OrNone>;
  return (
    <LibraryLink to={profilePath(shot.profile.id)}>{shot.profileTitle ?? shot.profile.title ?? "Untitled Profile"}</LibraryLink>
  );
}

/**
 * A Shot's rating as stars (#544): five, filled as far as the rating
 * reaches, so one of 3.5 stars has three and a half, and what is drawn agrees
 * with the rating filter, which counts the rating itself: a Shot drawn with
 * fewer than four is not among "4 stars or more". Named by the rating, such
 * as "3.5 stars"; a dash for a Shot not rated.
 */
export function Stars({ rating }: { rating: number | null }) {
  const text = ratingText(rating);
  if (text === undefined) return <OrNone>{undefined}</OrNone>;
  const stars = starsOf(rating);
  return (
    <span role="img" aria-label={text} title={text} className="inline-flex items-center gap-px align-middle">
      {Array.from({ length: MAX_STARS }, (_, index) => (
        <RatingStar key={index} index={index} stars={stars} />
      ))}
    </span>
  );
}

/** One star of a rating of `stars`, the star at `index`, from 0, filled as far as the rating reaches into it; `size` is its size, as a class. */
export function RatingStar({ index, stars, size = "size-3" }: { index: number; stars: number; size?: string }) {
  // How much of this star the rating fills, from none to all of it.
  const filled = Math.min(1, Math.max(0, stars - index));
  return (
    <span aria-hidden className={`relative ${size}`}>
      <StarIcon className={`${size} text-muted-foreground`} />
      {filled > 0 && (
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${filled * 100}%` }}>
          <StarIcon className={`${size} fill-current`} />
        </span>
      )}
    </span>
  );
}
