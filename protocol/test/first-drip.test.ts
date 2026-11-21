import fs from "node:fs";
import { poured, shotSamples, timeToFirstDrip } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";

// A Shot's time to first drip (#609), case by case, from the table other ports of the rule, such as the cafe skin's, test too.
interface FirstDripCase {
  name: string;
  preheat: Array<[number, number | null]>;
  samples: Array<[number, number | null]>;
  poured: boolean;
  firstDrip: number | null;
  unfinished: boolean;
}

const { cases } = JSON.parse(fs.readFileSync(new URL("./fixtures/first-drip-cases.json", import.meta.url), "utf8")) as { cases: FirstDripCase[] };
const START_MS = Date.parse("2026-11-21T08:00:00Z");

/** A case as Decaid records a Shot: its Preheat's samples in `preparingForShot`, then its profile's, in `pouring` from the second where it poured. */
function measurementsOf(shot: FirstDripCase) {
  const measurement = (seconds: number, weight: number | null, substate: string) => ({
    machine: { timestamp: new Date(START_MS + Math.round(seconds * 1000)).toISOString(), state: { state: "espresso", substate }, pressure: 0, flow: 0 },
    scale: weight === null ? null : { weight, weightFlow: 0 },
  });
  return [
    ...shot.preheat.map(([seconds, weight]) => measurement(seconds, weight, "preparingForShot")),
    ...shot.samples.map(([seconds, weight], n) => measurement(seconds, weight, shot.poured && n > 0 ? "pouring" : "preinfusion")),
  ];
}

describe("timeToFirstDrip", () => {
  it.each(cases)("$name", (shot) => {
    const samples = shotSamples(measurementsOf(shot));
    expect(samples.filter((sample) => sample.shade === null).map((sample) => sample.seconds)).toEqual(shot.samples.map(([seconds]) => seconds));
    expect(timeToFirstDrip(samples)).toBe(shot.firstDrip);
    // An Unfinished Shot, as a stored Shot's columns decide it (`UNFINISHED` in server/src/shots/summary.ts).
    expect(!poured(samples) && timeToFirstDrip(samples) === null).toBe(shot.unfinished);
  });
});
