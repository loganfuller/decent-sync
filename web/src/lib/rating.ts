import { MAX_SHOT_RATING } from "@decent-sync/protocol";

// A Shot's rating in stars, as the management interface says a single
// Shot's (#514): Decaid keeps a rating from 0 to 10, where 0 is unrated
// (`annotations.enjoyment`), and DYE2 shows it as five stars, each two
// points of it (`enjoymentToStars` and `starsToEnjoyment` in
// dye2:dye2-plugin/src/utils/shared-components.ts), as the owner's Skin
// will.

/** The most stars a Shot is rated. */
export const MAX_STARS = 5;

/** How many of Decaid's points a star is. */
const POINTS_A_STAR = MAX_SHOT_RATING / MAX_STARS;

/**
 * A Shot's rating in stars, as it is: not rounded to a whole star, as DYE2
 * rounds one to show it, since an assistant or another Skin may set a
 * rating between two. 0 for one with no rating.
 */
export function starsOf(rating: number | null): number {
  return (rating ?? 0) / POINTS_A_STAR;
}

/** The rating that many whole stars are, as DYE2 writes it (`starsToEnjoyment`). */
export function ratingOf(stars: number): number {
  return stars * POINTS_A_STAR;
}

/** A count of stars as it reads, to at most two places without trailing zeros: "4", "4.5" or "3.75". */
export function starCountText(stars: number): string {
  return String(Number(stars.toFixed(2)));
}

/** Stars with their word, such as "4 stars", "1 star" or "3.75 stars". */
export function starsText(stars: number): string {
  const count = starCountText(stars);
  return `${count} ${count === "1" ? "star" : "stars"}`;
}

/**
 * A Shot's rating as its stars, to at most two places, such as "4 stars",
 * "1 star" or "4.5 stars"; nothing for one unrated, which is a rating of
 * 0, as DYE2 writes it for no stars and an edit through the server clears
 * it, or none.
 */
export function ratingText(rating: number | null): string | undefined {
  if (rating === null || rating === 0) return undefined;
  return starsText(starsOf(rating));
}
