import { type Profile, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { LANE_CEILING, cupStep, graphLayout, laneRanges, laneTicks, placeLabels, timeAxis } from "../src/lib/profile-graph-layout";

// The Profile graph's layout (#578): its time axis, lanes and their ranges,
// and the scales each way between time and value and the graph's pixels.

const step = (fields: Record<string, unknown>) =>
  ({ name: "", pump: "pressure", pressure: 9, transition: "fast", exit: null, volume: 0, seconds: 30, weight: null, temperature: 92, sensor: "coffee", limiter: null, ...fields }) as Profile["steps"][number];

const profile: Profile = {
  version: "2",
  title: "Lever",
  notes: "",
  author: "",
  beverage_type: "espresso",
  steps: [step({ name: "Fill", pump: "flow", flow: 6, seconds: 10, exit: { type: "pressure", condition: "over", value: 3 } }), step({ name: "Pour", temperature: 88, limiter: { value: 2.5, range: 1 } })],
  target_volume: null,
  target_weight: 36,
  target_volume_count_start: 0,
  tank_temperature: 0,
};
const run = simulateProfile({ profile, puck: standardPuck(0), dose: 18, stopAt: 36, model: "DE1" });

describe("timeAxis", () => {
  it("runs a little past what was reached, but no further than the plan", () => {
    expect(timeAxis(30, 60)).toEqual({ end: 35, tick: 5 });
    expect(timeAxis(30, 31)).toEqual({ end: 35, tick: 5 });
    expect(timeAxis(100, 200)).toEqual({ end: 120, tick: 20 });
  });

  it("keeps to a dozen intervals at most, however long the run", () => {
    expect(timeAxis(200, 400)).toEqual({ end: 240, tick: 20 });
    expect(timeAxis(500, 1000)).toEqual({ end: 600, tick: 60 });
    expect(timeAxis(1000, 2000)).toEqual({ end: 1200, tick: 120 });
    expect(timeAxis(2026, 2026)).toEqual({ end: 2100, tick: 300 });
    for (const reached of [45, 95, 250, 700, 800, 1300, 1500, 3000]) {
      const { end, tick } = timeAxis(reached, reached * 2);
      expect(end / tick, String(reached)).toBeLessThanOrEqual(12);
    }
  });
});

describe("cupStep", () => {
  it("marks each 10 g of an espresso, and a round step keeping to ten marks on a heavier run", () => {
    expect(cupStep(36)).toBe(10);
    expect(cupStep(100)).toBe(10);
    expect(cupStep(150)).toBe(20);
    expect(cupStep(340)).toBe(50);
    expect(cupStep(8470)).toBe(1000);
    for (const weight of [5, 99, 101, 201, 999, 1001, 25_000]) expect(weight / cupStep(weight), String(weight)).toBeLessThanOrEqual(10);
  });
});

describe("laneRanges", () => {
  it("fits what each lane draws, on round values", () => {
    const ranges = laneRanges(profile, run);
    expect(ranges.pressure).toEqual([0, 10]);
    expect(ranges.flow[0]).toBe(0);
    expect(ranges.flow[1]).toBeGreaterThanOrEqual(6);
    expect(ranges.temperature).toEqual([85, 95]);
  });

  it("holds an outlandish target to the ceiling", () => {
    const wild: Profile = { ...profile, steps: [step({ pressure: 1e20, temperature: 1e20 })] };
    const ranges = laneRanges(wild, simulateProfile({ profile: wild, puck: standardPuck(0), dose: 18, stopAt: 36, model: "DE1" }));
    expect(ranges.pressure[1]).toBeLessThanOrEqual(LANE_CEILING + 2);
    expect(ranges.temperature[1]).toBeLessThanOrEqual(115);
  });
});

describe("laneTicks", () => {
  it("steps by 2 or 4, 5 or 10, and never gives more than a dozen or so", () => {
    expect(laneTicks("pressure", [0, 10])).toEqual([0, 2, 4, 6, 8, 10]);
    expect(laneTicks("pressure", [0, 16])).toEqual([0, 4, 8, 12, 16]);
    expect(laneTicks("temperature", [85, 95])).toEqual([85, 90, 95]);
    expect(laneTicks("flow", [0, 1e9]).length).toBeLessThanOrEqual(13);
  });
});

describe("graphLayout", () => {
  const ranges = laneRanges(profile, run);
  const layout = graphLayout({ width: 800, end: 40, tick: 5, ranges });

  it("lays the lanes out top to bottom inside the plot, shorter on a narrow screen", () => {
    expect(layout.lanes.pressure.top).toBe(layout.plot.top);
    expect(layout.lanes.pressure.bottom).toBeLessThan(layout.lanes.flow.top);
    expect(layout.lanes.flow.bottom).toBeLessThan(layout.lanes.temperature.top);
    expect(layout.lanes.temperature.bottom).toBe(layout.plot.bottom);
    expect(layout.cupY).toBeGreaterThan(layout.plot.bottom);
    expect(layout.height).toBeGreaterThan(layout.cupY);
    expect(layout.short).toBe(false);
    const phone = graphLayout({ width: 350, end: 40, tick: 5, ranges });
    expect(phone.short).toBe(true);
    expect(phone.lanes.pressure.bottom - phone.lanes.pressure.top).toBeLessThan(layout.lanes.pressure.bottom - layout.lanes.pressure.top);
  });

  it("turns a time and a value into a point and back", () => {
    for (const seconds of [0, 12.5, 40]) expect(layout.secondsAt(layout.x(seconds))).toBeCloseTo(seconds, 9);
    for (const value of [0, 3.5, 10]) expect(layout.valueAt("pressure", layout.y("pressure", value))).toBeCloseTo(value, 9);
    expect(layout.valueAt("temperature", layout.y("temperature", 91))).toBeCloseTo(91, 9);
  });

  it("holds a point to the axis and the lane, but turns a point outside them into a time or value outside them", () => {
    expect(layout.x(-5)).toBe(layout.x(0));
    expect(layout.x(50)).toBe(layout.x(40));
    expect(layout.y("pressure", 30)).toBe(layout.lanes.pressure.top);
    expect(layout.secondsAt(layout.plot.right + 100)).toBeGreaterThan(40);
    expect(layout.valueAt("pressure", layout.lanes.pressure.top - 20)).toBeGreaterThan(10);
  });

  it("keeps ranges the caller pins, as while a target is dragged past them", () => {
    const pinned = graphLayout({ width: 800, end: 40, tick: 5, ranges: { ...ranges, pressure: [0, 12] } });
    expect(pinned.ranges.pressure).toEqual([0, 12]);
    expect(pinned.valueAt("pressure", pinned.lanes.pressure.top)).toBeCloseTo(12, 9);
  });

  it("labels the time axis every tick to its end", () => {
    expect(layout.timeTicks()).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40]);
  });
});

describe("placeLabels", () => {
  const box = (baseline: number, x: number, width: number) => ({ left: x, right: x + width, top: baseline - 11, bottom: baseline + 2 });
  const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it("puts a label above its line where it can", () => {
    expect(placeLabels([{ x: 50, width: 80, top: 100, bottom: 100 }], 40, 160)).toEqual([96]);
  });

  it("keeps two labels on near lines apart", () => {
    const labels = [
      { x: 50, width: 120, top: 100, bottom: 100 },
      { x: 60, width: 120, top: 104, bottom: 110 },
    ];
    const [first, second] = placeLabels(labels, 40, 160);
    expect(overlaps(box(first!, 50, 120), box(second!, 60, 120))).toBe(false);
  });

  it("moves a label off a curve, and clear of what is already drawn", () => {
    const [onCurve] = placeLabels([{ x: 50, width: 80, top: 100, bottom: 100 }], 40, 160, [[70, 92]]);
    expect(onCurve).toBe(104 + 11);
    const [clear] = placeLabels([{ x: 50, width: 80, top: 100, bottom: 100 }], 40, 160, [], [{ left: 40, right: 200, top: 80, bottom: 98 }]);
    expect(overlaps(box(clear!, 50, 80), { left: 40, right: 200, top: 80, bottom: 98 })).toBe(false);
  });

  it("stays in its lane", () => {
    const [low] = placeLabels([{ x: 50, width: 80, top: 44, bottom: 44 }], 40, 160);
    expect(low! - 11).toBeGreaterThanOrEqual(40);
  });
});
