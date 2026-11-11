import { describe, expect, it } from "vitest";
import { MAX_HARDWARE_LENGTH } from "@decent-sync/protocol";
import { extractCurves, extractShot, recordingSeconds, shotHardware, shotVersion, shownDuration } from "../src/shots/extraction.js";
import { burrsShotFixture, preheatShotFixture, shotFixture } from "./support/shot-fixtures.js";
import { dye2Recording } from "./support/simulated-dye2.js";

// A scrubbed real tablet record, in the layout of Decaid v0.8.7's Workflow and
// ShotRecord serializers, which Decaid v0.9.0 still serves as it was stored,
// one Decaid v0.9.0 recorded from its simulated machine, one it recorded
// with a recipe applied on DYE2 v0.1.26's dashboard
// (fixtures/decaid/dye2-v0.1.26/shot.json, ticket #216), and one the test
// tablet's Decaid v0.9.0 recorded with a long Preheat (ticket #287).
describe("Shot extraction", () => {
  it("extracts a real native espresso including curves and tablet-local library names", () => {
    const shot = shotFixture();
    expect(extractShot(shot)).toMatchObject({
      profileTitle: "Londonium", profileId: "profile:98fa00c191551b435845", targetDose: 18, targetYield: 36,
      actualDose: 18, actualYield: 35.9, barista: "Fixture Barista",
      beanBatchId: "416d62df-2554-4a8a-b266-c0029bc459b2", grinderId: "e2d50b3d-a6d9-48bb-9b50-1efb4df60229", coffeeName: "Ethiopia Generic 100g Sample",
    });
    // Its first sample, 4.386 s before the next, is in Preheat.
    expect(extractCurves(shot, shot.measurements)).toMatchObject({ preheat: 4.386, duration: 23.549, peakPressure: 9.004638671875, peakFlow: 9.502197265625 });
    expect(shotHardware(shot)).toEqual({ model: "DE1Pro", serial: "10001" });
    const longest = "9".repeat(MAX_HARDWARE_LENGTH);
    const workflow = shot.workflow as Record<string, unknown>;
    expect(shotHardware({ ...shot, workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: longest } } })).toEqual({ model: "DE1Pro", serial: longest });
  });

  it("extracts the burrs Decaid copied onto the Shot from its Grinder's record, over those its Workflow held", () => {
    // Its Workflow held "Inherited burrs", as one a repeated Shot brought would (shot-grinder-burrs-setup.json).
    expect(extractShot(burrsShotFixture())).toMatchObject({ grinderId: "1629e825-59e0-46b6-a3db-2346fcfd90b5", grinderBurrs: "Fixture 64mm flat" });
    // Pulled on Decaid v0.8.7, which recorded no burrs.
    expect(extractShot(shotFixture()).grinderBurrs).toBeNull();
  });

  it("places Decaid's offset-free local times using the UTC createdAt saved after the last sample", () => {
    const shot = shotFixture();
    // The fixture was pulled at 14:14:10 local time, UTC-4.
    expect(extractCurves(shot, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T18:14:10.690Z"));
    // The same wall-clock times on a tablet at UTC+5:30.
    expect(extractCurves({ ...shot, createdAt: "2026-10-04T08:44:42.666246Z" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T08:44:10.690Z"));
    expect(extractCurves({ ...shot, timestamp: "2026-10-04T14:14:10.690+02:00" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T12:14:10.690Z"));
    // Read back after the tablet moved from UTC-4 to UTC+1; its samples keep the zone they were recorded in.
    expect(extractCurves({ ...shot, timestamp: "2026-10-04T19:14:10.690852" }, shot.measurements).pulledAt).toEqual(new Date("2026-10-04T18:14:10.690Z"));
    expect(extractCurves({ ...shot, createdAt: undefined }, shot.measurements).pulledAt).toBeNull();
    expect(extractCurves(shot, []).pulledAt).toBeNull();
  });

  it("measures duration across a daylight-saving change in the tablet's local times", () => {
    // Derived: the Shot's first two samples after its Preheat, at times either side of Chicago's changes, two seconds apart.
    const shot = shotFixture();
    const [, first, second] = shot.measurements as { machine: Record<string, unknown> }[];
    const at = (sample: { machine: Record<string, unknown> }, timestamp: string) => ({ ...sample, machine: { ...sample.machine, timestamp } });
    for (const [before, after] of [
      ["2026-03-08T01:59:59.000000", "2026-03-08T03:00:01.000000"],
      ["2026-11-01T01:59:59.000000", "2026-11-01T01:00:01.000000"],
    ]) {
      expect(extractCurves(shot, [at(first!, before!), at(second!, after!)]).duration).toBe(2);
    }
    // A jump that is not whole quarter hours, or a clock set back, is a correction of unknown size.
    expect(extractCurves(shot, [at(first!, "2026-10-04T14:14:10.000000"), at(second!, "2026-10-04T14:21:10.000000")]).duration).toBe(0);
    expect(extractCurves(shot, [at(first!, "2026-10-04T14:14:10.000000"), at(second!, "2026-10-04T13:59:09.000000")]).duration).toBe(0);
    const setBack = ["2026-10-04T14:14:10.000000", "2026-10-04T14:14:11.000000", "2026-10-04T14:14:01.000000", "2026-10-04T14:14:02.000000"];
    expect(extractCurves(shot, setBack.map((timestamp) => at(first!, timestamp))).duration).toBe(2);
  });

  it("leaves a Shot's Preheat out of its duration and peaks, but not its pull time", () => {
    const shot = preheatShotFixture();
    const curves = extractCurves(shot, shot.measurements);
    // Its 43 samples of Preheat, from 15:53:17.453 to the first of the profile's at 15:53:24.816, then 25.83 s to the last.
    expect(curves.preheat).toBeCloseTo(7.363, 3);
    expect(curves.duration).toBeCloseTo(25.833, 3);
    // Preheat's flow, at the heater test's 8 ml/s, peaked at 8.053; the profile's at 8.045.
    expect(curves).toMatchObject({ peakFlow: 8.045166015625, peakPressure: 8.01220703125 });
    // Pulled at 15:53:17 local time, UTC-4: when the recording started.
    expect(curves.pulledAt).toEqual(new Date("2026-10-25T19:53:17.461Z"));
  });

  it("finds no Preheat in a Shot whose first sample is not preparingForShot, and changes nothing there", () => {
    // Derived: the real Shot without its Preheat's samples, and with their substate missing or another, which no Preheat has.
    const shot = preheatShotFixture();
    const samples = shot.measurements as { machine: Record<string, unknown> }[];
    const after = samples.slice(43);
    const whole = extractCurves(shot, samples);
    expect(extractCurves(shot, after)).toMatchObject({ preheat: 0, duration: whole.duration, peakFlow: whole.peakFlow, peakPressure: whole.peakPressure });
    const relabelled = (state: unknown) => samples.map((sample, n) => (n < 43 ? { ...sample, machine: { ...sample.machine, state } } : sample));
    for (const state of [{ state: "espresso" }, { state: "espresso", substate: "preinfusion" }, undefined]) {
      expect(extractCurves(shot, relabelled(state))).toMatchObject({ preheat: 0, peakFlow: 8.053466796875 });
      expect(extractCurves(shot, relabelled(state)).duration).toBeCloseTo(whole.preheat! + whole.duration!, 3);
    }
  });

  it("ends Preheat at the first sample with another substate, so a later preparingForShot sample is not in it", () => {
    // Derived: the real Shot with one sample of its profile, its peak flow's, marked preparingForShot.
    const shot = preheatShotFixture();
    const samples = shot.measurements as { machine: Record<string, unknown> }[];
    const peak = samples.findIndex((sample, n) => n >= 43 && sample.machine.flow === 8.045166015625);
    const marked = samples.map((sample, n) => (n === peak ? { ...sample, machine: { ...sample.machine, state: { state: "espresso", substate: "preparingForShot" } } } : sample));
    expect(extractCurves(shot, marked)).toEqual(extractCurves(shot, samples));
    // Nor is a preparingForShot sample after one without a time.
    const untimed = samples.map((sample, n) => (n === 0 ? { ...sample, machine: { ...sample.machine, timestamp: undefined, state: { state: "espresso" } } } : sample));
    expect(extractCurves(shot, untimed)).toMatchObject({ preheat: 0, peakFlow: 8.053466796875 });
  });

  it("counts a Shot that never left Preheat as all Preheat, with a duration of 0 and no peaks", () => {
    // Derived: the real Shot's Preheat alone, as a Shot stopped before its profile started would record.
    const shot = preheatShotFixture();
    const curves = extractCurves(shot, (shot.measurements as unknown[]).slice(0, 43));
    expect(curves).toMatchObject({ duration: 0, peakFlow: null, peakPressure: null });
    // From its first sample to its last, at 15:53:24.620; the profile's first was not recorded.
    expect(curves.preheat).toBeCloseTo(7.166, 3);
  });

  it("works out what a Shot's samples show of how it went: its first drip, the step it ended in, whether it poured, and the scale at the stop", () => {
    const shot = preheatShotFixture();
    const samples = shot.measurements as { machine: Record<string, unknown>; scale: Record<string, unknown> | null }[];
    // The whole Shot: its scale first read 1 g 7.945 s into its profile, and it stopped on weight in its last step, at
    // 32.4 g, landing at 2.82 g/s.
    expect(extractCurves(shot, samples)).toMatchObject({
      timeToFirstDrip: 7.945,
      lastStepFrame: 6,
      lastStepName: "Extraction",
      poured: true,
      lastWeight: 32.4,
      lastWeightSeconds: 25.833,
      flowAtStop: 2.8189155419461156,
    });
    // Derived: stopped in Pressurize, before its Profile's last steps.
    expect(extractCurves(shot, samples.slice(0, 120))).toMatchObject({
      timeToFirstDrip: 7.945,
      lastStepFrame: 4,
      lastStepName: "Pressurize",
      poured: true,
      lastWeight: 4.6,
      lastWeightSeconds: 15.841,
      flowAtStop: 0.975336540336653,
    });
    // Derived: stopped in its preinfusion, an Unfinished Shot, its scale tared and still at 0.
    expect(extractCurves(shot, samples.slice(0, 72))).toMatchObject({
      timeToFirstDrip: null,
      lastStepFrame: 2,
      lastStepName: "Compressing",
      poured: false,
      lastWeight: 0,
      lastWeightSeconds: 5.845,
      flowAtStop: 0,
    });
    // Derived: stopped in its Preheat, an Unfinished Shot too, with nothing else to show.
    expect(extractCurves(shot, samples.slice(0, 43))).toMatchObject({
      timeToFirstDrip: null,
      lastStepFrame: null,
      lastStepName: null,
      poured: false,
      lastWeight: null,
      lastWeightSeconds: null,
      flowAtStop: null,
    });
    // Derived: with no scale, it still poured and ended in its last step.
    expect(extractCurves(shot, samples.map((sample) => ({ ...sample, scale: null })))).toMatchObject({
      timeToFirstDrip: null,
      lastStepFrame: 6,
      lastStepName: "Extraction",
      poured: true,
      lastWeight: null,
      lastWeightSeconds: null,
      flowAtStop: null,
    });
  });

  it("names the step a Shot ended in from its own Workflow's profile, or Step N where that names none", () => {
    // Recorded with a recipe applied on DYE2's dashboard, on Classic Italian espresso.
    const recorded = dye2Recording<{ dashboard: { shot: { response: { body: Record<string, unknown> } } } }>("shot").dashboard.shot.response.body;
    expect(extractCurves(recorded, recorded.measurements)).toMatchObject({ lastStepFrame: 3, lastStepName: "rise and hold" });
    // Derived: the same Shot with no profile in its Workflow.
    expect(extractCurves({ ...recorded, workflow: { ...(recorded.workflow as object), profile: undefined } }, recorded.measurements)).toMatchObject({
      lastStepFrame: 3,
      lastStepName: "Step 4",
    });
    // Decaid's simulated machine, on a profile of one step.
    const simulated = burrsShotFixture();
    expect(extractCurves(simulated, simulated.measurements)).toMatchObject({ lastStepFrame: 0, lastStepName: "Free flow", timeToFirstDrip: 0.594 });
    // Derived: a frame no profile has, which a record may still hold, is kept as it is.
    const shot = shotFixture();
    const beyond = (shot.measurements as { machine: Record<string, unknown> }[]).map((sample) => ({ ...sample, machine: { ...sample.machine, profileFrame: 3e10 } }));
    expect(extractCurves(shot, beyond)).toMatchObject({ lastStepFrame: 3e10, lastStepName: "Step 30000000001" });
  });

  // The Unfinished Shot rule (#467): a Shot with no sample in the pouring substate. Every Shot the fixtures hold ran until
  // it stopped on weight, so each must have poured, whatever its profile counts as preinfusion.
  it("finds that every fixture Shot poured, on each profile the fixtures hold a Shot of", () => {
    const dye2 = dye2Recording<Record<"dashboard" | "streamline", Record<string, { response: { body: Record<string, unknown> } }>>>("shot");
    const shots = [shotFixture(), preheatShotFixture(), burrsShotFixture(), dye2.dashboard.shot!.response.body, dye2.streamline.pulled!.response.body];
    const profile = (shot: Record<string, unknown>) => (shot.workflow as { profile: Record<string, unknown> }).profile;
    const checked = shots.map((shot) => ({
      profile: profile(shot).title,
      type: profile(shot).beverage_type,
      // How many of its steps its profile counts as preinfusion, of how many.
      preinfusion: `${String(profile(shot).target_volume_count_start)} of ${(profile(shot).steps as unknown[]).length}`,
      stopReason: shot.stopReason,
      poured: extractCurves(shot, shot.measurements).poured,
    }));
    expect(checked).toEqual([
      { profile: "Londonium", type: "espresso", preinfusion: "2 of 7", stopReason: "targetWeight", poured: true },
      { profile: "Adaptive v3", type: "espresso", preinfusion: "3 of 7", stopReason: "targetWeight", poured: true },
      { profile: "Default", type: "espresso", preinfusion: "0 of 1", stopReason: "targetWeight", poured: true },
      { profile: "Classic Italian espresso", type: "espresso", preinfusion: "2 of 4", stopReason: "targetWeight", poured: true },
      { profile: "Classic Italian espresso", type: "espresso", preinfusion: "2 of 4", stopReason: "targetWeight", poured: true },
    ]);
  });

  it("stores the whole recording as the duration, as the release before does, and shows it without Preheat", () => {
    const shot = preheatShotFixture();
    const curves = extractCurves(shot, shot.measurements);
    const recording = recordingSeconds(curves)!;
    // As the release before computed it: every sample's gap, Preheat's included.
    expect(recording).toBeCloseTo(33.196, 3);
    expect(shownDuration(recording, curves.preheat)).toBe(25.833);
    // A Shot not computed again keeps the release before's duration, with no Preheat stored.
    expect(shownDuration(recording, null)).toBe(recording);
    expect([recordingSeconds({ preheat: null, duration: null }), shownDuration(null, null)]).toEqual([null, null]);
  });

  it("tolerates absent, unfamiliar and mistyped optional fields", () => {
    for (const shot of [{}, { workflow: null, annotations: "unknown", measurements: [{ machine: null }, { machine: { pressure: "high" } }] }]) {
      expect(Object.values(extractShot(shot))).toEqual(expect.arrayContaining([null]));
      // Every value is null, but whether it poured, which it didn't.
      const curves = extractCurves(shot, shot.measurements);
      expect(curves).toEqual({ ...Object.fromEntries(Object.keys(curves).map((key) => [key, null])), poured: false });
      expect(shotHardware(shot)).toBeNull();
    }
    // Every value is null, but the Tools, a list, which is empty.
    expect(extractShot({})).toEqual({ ...Object.fromEntries(Object.keys(extractShot({})).map((key) => [key, null])), toolIds: [] });
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record<string, unknown>;
    const tooLong = "9".repeat(MAX_HARDWARE_LENGTH + 1);
    for (const machine of [
      undefined,
      { model: "DE1Pro", serialNumber: "0" },
      { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" },
      // Longer than a hello may report: no Machine or Pending Machine could hold it.
      { model: "DE1Pro", serialNumber: tooLong },
      { model: tooLong, serialNumber: "10001" },
    ]) {
      expect(shotHardware({ ...fixture, workflow: { ...workflow, machine } })).toBeNull();
    }
  });

  it("reads the Basket and Tools DYE2 recorded, its Edit Shot page's over the Workflow's, and the record id of the recipe the Workflow named", () => {
    const shot = shotFixture();
    const workflow = shot.workflow as Record<string, unknown>;
    const context = workflow.context as Record<string, unknown>;
    const pulled = (extras: Record<string, unknown>, annotations: Record<string, unknown> = {}) =>
      extractShot({ ...shot, annotations, workflow: { ...workflow, context: { ...context, extras } } });

    // As recorded: the Shot pulled with the library recipe applied on DYE2's dashboard names it by its opaque id, and the
    // Basket the recipe applied.
    const recorded = dye2Recording<{ dashboard: { shot: { response: { body: Record<string, unknown> } } } }>("shot").dashboard.shot.response.body;
    expect(extractShot(recorded)).toMatchObject({
      recipeRecordId: "05fd1e80-61e3-46ef-b202-2cbad5eb7983",
      basketId: "9567d681-444c-4492-95cd-29ecbc48870d",
      toolIds: [],
    });

    expect(pulled({ basketId: "picked", basketName: "20 g", equipmentIds: ["wdt"], dye: { v: 1, selection: null, recipeId: "2" } })).toMatchObject({
      basketId: "picked",
      toolIds: ["wdt"],
      recipeRecordId: "2",
    });
    // The Edit Shot page's Basket, and its Tools, single or listed, beside the Workflow's.
    expect(pulled({ basketId: "picked", equipmentIds: ["wdt"] }, { extras: { basketId: "edited", equipmentIds: ["screen", "wdt"] } })).toMatchObject({
      basketId: "edited",
      toolIds: ["screen", "wdt"],
    });
    expect(pulled({ basketId: "picked" }, { extras: { equipmentId: "tamper" } })).toMatchObject({ basketId: "picked", toolIds: ["tamper"] });
    // A Basket its page set by name alone is the page's, as DYE2 reads it, with no id.
    expect(pulled({ basketId: "picked" }, { extras: { basketName: "Unlisted" } }).basketId).toBeNull();
    // Ids that are not text name nothing; a recipe id DYE2 wrote as a number is read as text, as DYE2's `recipeIdOf` reads it.
    expect(pulled({ dye: { recipeId: 3 }, basketId: 7, equipmentIds: [3, ""] })).toMatchObject({ recipeRecordId: "3", basketId: null, toolIds: [] });
    // A recipe cleared, or none, names nothing, and so does DYE2's stored selection, which it no longer writes.
    expect(pulled({ dye: { v: 1, recipeId: null } }).recipeRecordId).toBeNull();
    expect(pulled({ dye: { recipeId: "" } }).recipeRecordId).toBeNull();
    expect(pulled({ dye: { selection: { kind: "recipe", id: "2" } } }).recipeRecordId).toBeNull();
    expect(pulled({}).recipeRecordId).toBeNull();
  });

  it("versions by updatedAt alone, retaining Decaid's microseconds, and finds none in other records", () => {
    expect(shotVersion({ updatedAt: "2026-10-04T12:00:00.000002Z", createdAt: "2026-10-03T12:00:00Z" })).toBe("2026-10-04T12:00:00.000002Z");
    for (const updatedAt of [undefined, null, "2026-10-03T12:00:00", "2026-10-03T12:00:00+02:00", "2026-13-03T12:00:00Z", "unfamiliar"]) {
      expect(shotVersion({ updatedAt, createdAt: "2026-10-03T12:00:00Z", timestamp: "2026-10-03T12:00:00" })).toBeNull();
    }
  });
});
