import { describe, expect, it } from "vitest";
import { baristaKey, durationText, shareText, shotsText, signedText, yieldAgainstTargetText } from "../src/lib/shot-summary";

// How a Shot Summary's numbers read on the Shots list (#466), and who a
// Barista's name names, for the Barista filter's choice (#468).

const NONE = { shots: 0, median: null, p25: null, p75: null };

describe("a Shot Summary's numbers as text", () => {
  it("reads a duration as its median in seconds with the middle half's range", () => {
    expect(durationText({ shots: 20, median: 26, p25: 25.62, p75: 26.649 })).toEqual({ median: "26.0 s", range: "25.6–26.6" });
    expect(durationText({ shots: 1, median: 23.549, p25: 23.549, p75: 23.549 })).toEqual({ median: "23.5 s", range: "23.5–23.5" });
    expect(durationText(NONE)).toBeUndefined();
  });

  it("reads a yield against target in grams, each with its sign, and its range with a word between", () => {
    expect(yieldAgainstTargetText({ shots: 8, median: -0.55, p25: -1.3, p75: 0.05 })).toEqual({ median: "−0.6 g", range: "−1.3 to +0.1" });
    expect(yieldAgainstTargetText({ shots: 3, median: 2.4, p25: 0.5, p75: 3 })).toEqual({ median: "+2.4 g", range: "+0.5 to +3.0" });
    expect(yieldAgainstTargetText(NONE)).toBeUndefined();
  });

  it("signs a difference, but one that rounds to nothing", () => {
    expect([1, -1, 0.04, -0.04, 0, -0.05, 12.345].map(signedText)).toEqual(["+1.0", "−1.0", "0.0", "0.0", "0.0", "−0.1", "+12.3"]);
  });

  it("reads a share as a whole percentage, and none where there is none", () => {
    expect([0, 0.875, 5 / 6, 1].map(shareText)).toEqual(["0%", "88%", "83%", "100%"]);
    expect(shareText(null)).toBeUndefined();
  });

  it("counts Shots in words", () => {
    expect([0, 1, 2].map(shotsText)).toEqual(["0 Shots", "1 Shot", "2 Shots"]);
  });
});

describe("a Barista's name", () => {
  it("is read without the blanks around it or the case of A to Z, as the server reads one", () => {
    expect([" Jules", "JULES\t", "jules", "Jules Verne"].map(baristaKey)).toEqual(["jules", "jules", "jules", "jules verne"]);
    expect(["", "   ", "\n", " \t\r\n\f\v"].map(baristaKey)).toEqual(["", "", "", ""]);
    // Only the blanks the server leaves out: a name within another space is another Barista, as it is there.
    expect(["\u00a0Jules", "Jules\u2003", "\u00a0"].map(baristaKey)).toEqual(["\u00a0jules", "jules\u2003", "\u00a0"]);
    // Other letters as they are, as JavaScript folds some unlike the server, such as a final sigma or a dotted I.
    expect(["ΣΑΣ", "İpek", "Élodie", "ÉLODIE"].map(baristaKey)).toEqual(["ΣΑΣ", "İpek", "Élodie", "Élodie"]);
  });
});
