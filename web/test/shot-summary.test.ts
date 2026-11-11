import { describe, expect, it } from "vitest";
import { DEFAULT_NUMBERS, MEDIAN_TEXT, baristaKey, countNotes, durationText, numbersParam, ratioText, settingText, shareText, shotsText, shownNumbers, signedText, yieldAgainstTargetText } from "../src/lib/shot-summary";

// How a Shot Summary's numbers read on the Shots list (#466, #469), which of
// them its address keeps, and who a Barista's name names, for the Barista
// filter's choice (#468).

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

  it("reads a ratio as yield to one gram of dose, and each other number with its unit and places", () => {
    expect(ratioText({ shots: 4, median: 2.25, p25: 1.875, p75: 2.5 })).toEqual({ median: "1:2.25", range: "1.88–2.50" });
    expect(ratioText(NONE)).toBeUndefined();
    const one = (value: number) => ({ shots: 1, median: value, p25: value, p75: value });
    expect(MEDIAN_TEXT.peakPressure(one(9.004638671875))).toEqual({ median: "9.0 bar", range: "9.0–9.0" });
    expect(MEDIAN_TEXT.peakFlow(one(8.409423828125))).toEqual({ median: "8.4 ml/s", range: "8.4–8.4" });
    expect(MEDIAN_TEXT.rating(one(7))).toEqual({ median: "7.0", range: "7.0–7.0" });
    expect(MEDIAN_TEXT.tds(one(9.125))).toEqual({ median: "9.13%", range: "9.13–9.13" });
    expect(MEDIAN_TEXT.extractionYield(one(19.84))).toEqual({ median: "19.8%", range: "19.8–19.8" });
    expect(MEDIAN_TEXT.timeToFirstDrip(one(11.32125))).toEqual({ median: "11.3 s", range: "11.3–11.3" });
    expect(MEDIAN_TEXT.grindSetting({ shots: 5, median: 8, p25: 6.5, p75: 9.125 })).toEqual({ median: "8", range: "6.5–9.13" });
  });

  it("reads a grind setting as Grinders' scales are written, without trailing zeros", () => {
    expect([2, 6.5, 8.8, 12, 9.125, 1.999].map(settingText)).toEqual(["2", "6.5", "8.8", "12", "9.13", "2"]);
  });
});

describe("the notes under a summary's count", () => {
  it("say how many Shots were left out and how many await their stored values, each where there are any", () => {
    expect(countNotes({ shots: 12, unfinished: 0, cleaningAndCalibration: 0, awaitingValues: 0 })).toEqual([]);
    expect(countNotes({ shots: 12, unfinished: 1, cleaningAndCalibration: 1, awaitingValues: 1 })).toEqual([
      "1 Unfinished Shot left out",
      "1 cleaning or calibration Shot left out",
      "1 still awaits its first drip and last step",
    ]);
    expect(countNotes({ shots: 12, unfinished: 3, cleaningAndCalibration: 2, awaitingValues: 9 })).toEqual([
      "3 Unfinished Shots left out",
      "2 cleaning and calibration Shots left out",
      "9 still await their first drip and last step",
    ]);
  });
});

describe("the numbers the Shots list shows", () => {
  it("reads them from the address in their own order, the default where it names none it knows", () => {
    expect(shownNumbers(null)).toEqual(DEFAULT_NUMBERS);
    expect(shownNumbers("")).toEqual(DEFAULT_NUMBERS);
    expect(shownNumbers("lastStep,ratio,duration")).toEqual(["duration", "ratio", "lastStep"]);
    // A number a later release gives, in an address shared from it, is left out.
    expect(shownNumbers("ratio,brewTemperature")).toEqual(["ratio"]);
    expect(shownNumbers("brewTemperature")).toEqual(DEFAULT_NUMBERS);
  });

  it("keeps them in the address in their own order, and nothing for the default", () => {
    expect(numbersParam(["lastStep", "ratio"])).toBe("ratio,lastStep");
    expect(numbersParam(["stoppedOnWeight", "yieldAgainstTarget", "duration"])).toBeNull();
    expect(numbersParam(["yieldAgainstTarget", "duration"])).toBe("yieldAgainstTarget,duration");
    expect(numbersParam([])).toBeNull();
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
