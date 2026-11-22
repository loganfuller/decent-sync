import { type Profile, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import {
  LANE_CEILING,
  type LabelBox,
  TAG_HEIGHT,
  besideLine,
  besideUpright,
  clear,
  clearest,
  cupStep,
  densified,
  graphLayout,
  handleBox,
  labelBaseline,
  labelBox,
  laneRanges,
  laneTicks,
  movedLeft,
  placeLabels,
  placeTags,
  spaced,
  timeAxis,
} from "../src/lib/profile-graph-layout";

// The Profile graph's layout (#578): its time axis, lanes and their ranges,
// and the scales each way between time and value and the graph's pixels.
// And where what is written on it goes (#621): clear of each other, the
// curves, and a Draft's handles, their tags and the bracket.

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

// What #621 moved into the layout: every place a label takes is weighed
// against what is drawn there, a Draft's handles and their tags among it.
describe("where labels go among what is drawn", () => {
  const overlaps = (a: LabelBox, b: LabelBox) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const lane = { top: 44, bottom: 164 };
  const plot = { left: 36, right: 700, ...lane };

  it("takes the first place that covers nothing drawn, before one outside its lane, before one on a curve", () => {
    const places = [labelBox(100, 60, 80), labelBox(100, 74, 80), labelBox(100, 88, 80)];
    expect(clearest(places, plot)).toBe(0);
    // A handle on the first, a curve through the second.
    expect(clearest(places, plot, [[120, 70]], [{ left: 90, right: 110, top: 50, bottom: 62 }])).toBe(2);
    // Something drawn is kept off before a curve is.
    expect(clearest(places.slice(0, 2), plot, [[120, 70]], [{ left: 90, right: 110, top: 50, bottom: 62 }])).toBe(1);
    // And a place outside is taken before one over something drawn.
    expect(clearest([labelBox(100, 60, 80), labelBox(10, 60, 80)], plot, [], [{ left: 90, right: 110, top: 50, bottom: 62 }])).toBe(1);
    expect(clear(places[0]!, plot, [])).toBe(true);
    expect(clear(places[0]!, plot, [{ left: 90, right: 110, top: 50, bottom: 62 }])).toBe(false);
    expect(clear(labelBox(10, 60, 80), plot, [])).toBe(false);
    expect(labelBaseline(labelBox(100, 60, 80))).toBe(60);
  });

  it("keeps a lane's labels off a Draft's handle, its tag and the bracket", () => {
    const handle = handleBox({ kind: "point", x: 90, y: 100 });
    const tag = { left: 105, right: 170, top: 91, bottom: 109 };
    const [baseline] = placeLabels([{ x: 50, width: 120, top: 100, bottom: 100 }], lane.top, lane.bottom, [], [handle, tag]);
    for (const drawn of [handle, tag]) expect(overlaps(labelBox(50, baseline!, 120), drawn)).toBe(false);
  });

  it("finds a label to cross a curve between two points far apart, as between a Shot's few samples", () => {
    const sparse: [number, number][] = [
      [40, 150],
      [240, 50],
    ];
    const places = [labelBox(100, 104, 80), labelBox(100, 150, 80)];
    // The points alone miss the label lying on the line between them.
    expect(clearest(places, plot, sparse)).toBe(0);
    expect(clearest(places, plot, densified(sparse))).toBe(1);
    const dense = densified(sparse);
    expect(dense[0]).toEqual([40, 150]);
    expect(dense.at(-1)).toEqual([240, 50]);
    for (let index = 1; index < dense.length; index++) expect(Math.abs(dense[index]![0] - dense[index - 1]![0])).toBeLessThanOrEqual(4);
    // A gap in a curve is not drawn across.
    expect(densified([[0, 0], null, [100, 0]])).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it("offers a stop's name on one side of its line down the lane, then on the other", () => {
    const places = besideLine(300, 80, lane, "right");
    expect(places.length % 2).toBe(0);
    const [right, left] = [places.slice(0, places.length / 2), places.slice(places.length / 2)];
    expect(right.every((box) => box.left === 306 && box.right === 386)).toBe(true);
    expect(left.every((box) => box.right === 294 && box.left === 214)).toBe(true);
    expect(labelBaseline(right[0]!)).toBe(lane.top + 16);
    for (const side of [right, left]) {
      expect(side.every((box) => box.top >= lane.top && box.bottom <= lane.bottom)).toBe(true);
      for (let row = 1; row < side.length; row++) expect(side[row]!.top).toBeGreaterThanOrEqual(side[row - 1]!.bottom);
    }
    expect(besideLine(300, 80, lane, "left")[0]!.right).toBe(294);

    // The run's "Stops at" beside a bracket standing right of its line, under the run's curve along the lane's top: left of the line, below the curve.
    const bracket = handleBox({ kind: "bracket", x: 340, top: 44, bottom: 420 });
    const curve = densified([
      [36, 56],
      [300, 56],
    ]);
    const taken = besideLine(300, 80, lane, "right")[clearest(besideLine(300, 80, lane, "right"), plot, curve, [bracket])]!;
    expect(taken.right).toBe(294);
    expect(taken.top).toBeGreaterThan(57);
    // And a compared record's name keeps off the run's, taken first.
    const other = besideLine(250, 100, lane, "left");
    const second = other[clearest(other, plot, curve, [bracket, taken, { left: 299, right: 301, top: 44, bottom: 420 }])]!;
    expect(overlaps(second, taken)).toBe(false);
    expect(clear(second, plot, [bracket, taken])).toBe(true);
  });

  it("draws a label beside a bracket that crosses its band: where it was if they do not meet, else on the side that takes it whole, else the wider", () => {
    const bracket = (x: number) => handleBox({ kind: "bracket", x, top: 44, bottom: 420 });
    expect(besideUpright(100, 400, 120, null)).toEqual({ from: 100, to: 400 });
    expect(besideUpright(100, 400, 120, bracket(300))).toEqual({ from: 100, to: 400 });
    expect(besideUpright(100, 400, 120, bracket(40))).toEqual({ from: 100, to: 400 });
    // Across the label: it goes right of the bracket, whole.
    expect(besideUpright(100, 400, 120, bracket(150))).toEqual({ from: 159, to: 400 });
    // No side takes it whole: the wider one, which it is cut to.
    expect(besideUpright(100, 300, 200, bracket(180))).toEqual({ from: 189, to: 300 });
    expect(besideUpright(100, 300, 200, bracket(240))).toEqual({ from: 100, to: 231 });
    // On the band's start: just right of it.
    expect(besideUpright(104, 400, 120, bracket(100))).toEqual({ from: 109, to: 400 });
  });

  it("moves a lane's name left of a bracket standing on it, and leaves it where there is no room", () => {
    const name = { left: 610, right: 696, top: 44, bottom: 62 };
    const bracket = handleBox({ kind: "bracket", x: 690, top: 44, bottom: 420 });
    expect(movedLeft(name, [], 36)).toEqual(name);
    expect(movedLeft(name, [bracket], 36)).toEqual({ ...name, left: 593, right: 679 });
    // Past a tag left of the bracket too.
    const tag = { left: 600, right: 680, top: 50, bottom: 68 };
    expect(movedLeft(name, [bracket, tag], 36).right).toBe(596);
    expect(movedLeft(name, [{ left: 40, right: 700, top: 44, bottom: 62 }], 36)).toEqual(name);
  });

  it("leaves out a name in a row that would run into one already written", () => {
    expect(spaced([{ left: 0, right: 30 }, { left: 32, right: 60 }, { left: 64, right: 90 }, { left: 100, right: 130 }])).toEqual([true, false, true, true]);
    expect(spaced([])).toEqual([]);
  });

  describe("a Draft's handles and their tags", () => {
    const layout = graphLayout({ width: 712, end: 60, tick: 10, ranges: laneRanges(profile, run) });
    const bracket = { kind: "bracket" as const, x: layout.x(40), top: layout.plot.top, bottom: layout.plot.bottom };

    it("covers a point's circle, and a bracket's line down the plot with the room either side that takes the pointer", () => {
      expect(handleBox({ kind: "point", x: 100, y: 80 })).toEqual({ left: 91, right: 109, top: 71, bottom: 89 });
      expect(handleBox(bracket)).toEqual({ left: bracket.x - 7, right: bracket.x + 7, top: layout.plot.top, bottom: layout.plot.bottom });
    });

    it("puts the bracket's tag in the gap under the first lane, below every band's name and outcome, held inside the graph and right of the lanes' values", () => {
      const [tag] = placeTags(layout, [{ shape: bracket, width: 90 }]);
      expect(tag!.top).toBeGreaterThanOrEqual(layout.lanes.pressure.bottom);
      expect(tag!.bottom).toBeLessThanOrEqual(layout.lanes.flow.top);
      expect(tag!.bottom - tag!.top).toBe(TAG_HEIGHT);
      expect((tag!.left + tag!.right) / 2).toBeCloseTo(bracket.x);
      // The bands' names and outcomes are written above the plot.
      expect(tag!.top).toBeGreaterThan(layout.plot.top);
      const [atEnd] = placeTags(layout, [{ shape: { ...bracket, x: layout.x(60) }, width: 90 }]);
      expect(atEnd!.right).toBe(layout.width);
      const [atStart] = placeTags(layout, [{ shape: { ...bracket, x: layout.plot.left }, width: 90 }]);
      expect(atStart!.left).toBe(layout.plot.left);
    });

    it("puts a point's tag on its right, level with it, and on its left at the graph's edge or where another handle is in the way", () => {
      const point = (x: number, y: number) => ({ kind: "point" as const, x, y });
      const [right] = placeTags(layout, [{ shape: point(200, 100), width: 60 }]);
      expect(right).toEqual({ left: 215, right: 275, top: 91, bottom: 109 });
      const [edge] = placeTags(layout, [{ shape: point(690, 100), width: 60 }]);
      expect(edge!.right).toBe(675);
      // Two points on one line, as a target and an exit of the same value: neither tag covers the other point or its tag.
      const handles = [
        { shape: point(260, 100), width: 60 },
        { shape: point(200, 100), width: 70 },
      ];
      const tags = placeTags(layout, handles);
      expect(tags[1]!.right).toBeLessThan(200);
      expect(overlaps(tags[0]!, tags[1]!)).toBe(false);
      for (const tag of tags) for (const handle of handles) expect(overlaps(tag, handleBox(handle.shape))).toBe(false);
    });

    it("keeps a point's tag inside the graph, beside another tag in its way, as a short ramp's target and exit a bar apart on a phone", () => {
      // A first step ramping smoothly to 9 bar over 5 s that moves on over 8 bar, then 9 bar.
      const ramp: Profile = {
        ...profile,
        steps: [step({ name: "Ramp", transition: "smooth", seconds: 5, exit: { type: "pressure", condition: "over", value: 8 } }), step({ name: "Brew" })],
      };
      const ran = simulateProfile({ profile: ramp, puck: standardPuck(0), dose: 18, stopAt: 36, model: "DE1" });
      const phone = graphLayout({ width: 361, end: 60, tick: 10, ranges: laneRanges(ramp, ran) });
      const { start, end } = ran.steps[0]!;
      // As the editor places them: the target at the step's maximum time, the exit 30% along its band, the bracket at its maximum time.
      const shapes = [
        { kind: "point" as const, x: phone.x(start! + 5), y: phone.y("pressure", 9) },
        { kind: "point" as const, x: phone.x(start!) + (phone.x(end!) - phone.x(start!)) * 0.3, y: phone.y("pressure", 8) },
        { kind: "bracket" as const, x: phone.x(start! + 5), top: phone.plot.top, bottom: phone.plot.bottom },
      ];
      const tags = placeTags(phone, [
        { shape: shapes[0]!, width: 44 },
        { shape: shapes[1]!, width: 66 },
        { shape: shapes[2]!, width: 86 },
      ]);
      tags.forEach((tag, index) => {
        expect(tag.left).toBeGreaterThanOrEqual(phone.plot.left);
        expect(tag.right).toBeLessThanOrEqual(phone.width);
        for (const other of tags.slice(index + 1)) expect(overlaps(tag, other)).toBe(false);
        shapes.forEach((shape, at) => {
          if (at !== index) expect(overlaps(tag, handleBox(shape))).toBe(false);
        });
      });
    });

    it("keeps a point's tag inside its lane, off the bracket and its tag, as a pause's target at 0 bar beside a short step's bracket", () => {
      const { pressure, flow } = layout.lanes;
      // A 5 s pause: its target at 0 bar, 62% along, and its bracket at its end.
      const pause = { kind: "point" as const, x: layout.x(3.1), y: pressure.bottom };
      const end = { ...bracket, x: layout.x(5) };
      const handles = [
        { shape: pause, width: 40 },
        { shape: end, width: 90 },
      ];
      const tags = placeTags(layout, handles);
      expect(tags[0]!.bottom).toBe(pressure.bottom);
      expect(overlaps(tags[0]!, tags[1]!)).toBe(false);
      expect(overlaps(tags[0]!, handleBox(end))).toBe(false);
      expect(overlaps(tags[1]!, handleBox(pause))).toBe(false);
      // On a phone, where its left would run into the lane's values: past the bracket instead.
      const phone = graphLayout({ width: 361, end: 60, tick: 10, ranges: laneRanges(profile, run) });
      const shapes = [
        { kind: "point" as const, x: phone.x(3.1), y: phone.lanes.pressure.bottom },
        { kind: "bracket" as const, x: phone.x(5), top: phone.plot.top, bottom: phone.plot.bottom },
      ];
      const onPhone = placeTags(phone, [
        { shape: shapes[0]!, width: 40 },
        { shape: shapes[1]!, width: 90 },
      ]);
      expect(onPhone[0]!.left).toBeGreaterThanOrEqual(phone.plot.left);
      expect(onPhone[0]!.left).toBeGreaterThan(handleBox(shapes[1]!).right);
      expect(overlaps(onPhone[0]!, onPhone[1]!)).toBe(false);
      expect(overlaps(onPhone[1]!, handleBox(shapes[0]!))).toBe(false);
      // At the top of a lane, its tag doesn't rise into the band text above the plot, or into the gap above the flow lane.
      const [top] = placeTags(layout, [{ shape: { kind: "point", x: 200, y: pressure.top }, width: 40 }]);
      expect(top!.top).toBe(pressure.top);
      const [flowTop] = placeTags(layout, [{ shape: { kind: "point", x: 200, y: flow.top + 2 }, width: 40 }]);
      expect(flowTop!.top).toBe(flow.top);
    });

    it("moves the bracket's tag aside, off a point standing at the first lane's foot on the bracket, as a smooth step down to 0 bar", () => {
      const foot = { kind: "point" as const, x: bracket.x, y: layout.lanes.pressure.bottom };
      const tags = placeTags(layout, [
        { shape: foot, width: 40 },
        { shape: bracket, width: 90 },
      ]);
      expect(overlaps(tags[1]!, handleBox(foot))).toBe(false);
      expect(tags[1]!.top).toBeGreaterThanOrEqual(layout.lanes.pressure.bottom);
      expect(tags[1]!.bottom).toBeLessThanOrEqual(layout.lanes.flow.top);
      expect(overlaps(tags[0]!, tags[1]!)).toBe(false);
    });
  });
});
