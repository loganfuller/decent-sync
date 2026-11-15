import { describe, expect, it } from "vitest";
import { MAX_STARS, ratingOf, ratingText, starCountText, starsOf, starsText } from "../src/lib/rating";

// A Shot's rating in stars (#514): two points of Decaid's 0 to 10 a star, as
// DYE2 has it, with the values DYE2's own conversion gives for whole stars.

describe("a Shot's rating in stars", () => {
  it("halves Decaid's rating, as it is, and doubles whole stars back, as DYE2 does", () => {
    expect(MAX_STARS).toBe(5);
    expect([0, 2, 8, 10].map(starsOf)).toEqual([0, 1, 4, 5]);
    expect([7, 9, 0.3].map(starsOf)).toEqual([3.5, 4.5, 0.15]);
    expect(starsOf(null)).toBe(0);
    expect([0, 1, 4, 5].map(ratingOf)).toEqual([0, 2, 8, 10]);
  });

  it("rounds to a whole star as DYE2 shows one, from the rating as it is", () => {
    // DYE2's enjoymentToStars: Math.round(rating / 2).
    expect([1, 5, 7, 9, 9.9, 0.995].map((rating) => Math.round(starsOf(rating)))).toEqual([1, 3, 4, 5, 5, 0]);
  });

  it("says a rating in stars, one star alone in the singular, and nothing for a Shot unrated", () => {
    expect(ratingText(8)).toBe("4 stars");
    expect(ratingText(2)).toBe("1 star");
    expect(ratingText(9)).toBe("4.5 stars");
    expect(ratingText(1)).toBe("0.5 stars");
    expect(ratingText(7.33)).toBe("3.67 stars");
    expect(ratingText(0)).toBeUndefined();
    expect(ratingText(null)).toBeUndefined();
    // Rated, however little, so not unrated.
    expect(ratingText(0.004)).toBe("0 stars");
  });

  it("says stars, as a median of several Shots' is (#532), to at most two places without trailing zeros", () => {
    expect([4, 1, 3.75, 4.5, 0.5, 3.666, 0.996, 1.004].map(starsText)).toEqual(["4 stars", "1 star", "3.75 stars", "4.5 stars", "0.5 stars", "3.67 stars", "1 star", "1 star"]);
    expect([5, 3.5, 3.625, 0].map(starCountText)).toEqual(["5", "3.5", "3.63", "0"]);
  });
});
