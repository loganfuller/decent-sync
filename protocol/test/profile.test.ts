import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Profile,
  type ProfileStep,
  MAX_PROFILE_STEPS,
  MODEL_LIMITS,
  PROFILE_LIMITS,
  checkProfile,
  holdToLimits,
  outOfRange,
  unrunnable,
  widestLimits,
  profileId,
  profileStepsKey,
  readProfile,
  readProfileFile,
  STARTING_SHAPES,
  simulateProfile,
  standardPuck,
  startingShape,
  stepsKey,
} from "../src/index.js";
import { sha256Hex } from "../src/sha256.js";

// The ids Decaid gave every profile it bundles, and profiles posted to it that
// differ in what its hash covers or only in what it leaves out, recorded on
// v0.9.2, the oldest supported Decaid, and v0.9.3, which bundles 21 more
// (server/test/fixtures/decaid/profile-ids-v0.9.2/README.md and
// profile-ids-v0.9.3/README.md).

interface Posted {
  name: string;
  sameIdAs: string;
  request: { body: { profile: Record<string, unknown> } };
  response: { status: number; body: { id: string; profile: unknown } };
}

interface Recording {
  bundled: Array<{ id: string; profile: unknown; isDefault: boolean }>;
  posted: Posted[];
}

function recording(version: string): Recording {
  return JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/profile-ids-${version}/profile-ids.json`, import.meta.url), "utf8")) as Recording;
}

const RECORDINGS = [
  { version: "v0.9.2", recorded: recording("v0.9.2"), bundled: 73 },
  { version: "v0.9.3", recorded: recording("v0.9.3"), bundled: 94 },
];

/** The minimum's recording, for the tests that need only one. */
const recorded = RECORDINGS[0]!.recorded;

function read(value: unknown): Profile {
  const read = readProfile(value);
  if (!read.profile) throw new Error(read.problem);
  return read.profile;
}

function posted(name: string, from: Recording = recorded): Posted {
  return from.posted.find((exchange) => exchange.name === name)!;
}

/** A plain profile of two steps, for the limits and checks. */
function plain(): Profile {
  return read({
    version: "2",
    title: "Plain",
    author: "",
    notes: "",
    beverage_type: "espresso",
    steps: [
      { name: "fill", pump: "flow", transition: "fast", exit: { type: "pressure", condition: "over", value: 4 }, volume: 0, seconds: 8, temperature: 92, sensor: "coffee", flow: 6, limiter: null },
      { name: "pour", pump: "pressure", transition: "smooth", exit: null, volume: 0, seconds: 30, temperature: 92, sensor: "coffee", pressure: 9, limiter: { value: 2.5, range: 0.6 } },
    ],
    target_volume: 0,
    target_weight: 36,
    target_volume_count_start: 1,
    tank_temperature: 0,
  });
}

describe("Decaid's id", () => {
  describe.each(RECORDINGS)("on Decaid $version", ({ recorded, bundled }) => {
    it("is Decaid's for every profile it bundles", () => {
      expect(recorded.bundled).toHaveLength(bundled);
      for (const record of recorded.bundled) expect(profileId(read(record.profile)), record.id).toBe(record.id);
    });

    it("is Decaid's for each profile posted to it, as sent, before Decaid read it", () => {
      for (const exchange of recorded.posted) {
        expect(exchange.response.status, exchange.name).toBe(201);
        expect(profileId(read(exchange.request.body.profile)), exchange.name).toBe(exchange.response.body.id);
      }
    });

    it("tells apart what Decaid's hash tells apart, and nothing else", () => {
      const id = (name: string) => posted(name, recorded).response.body.id;
      for (const exchange of recorded.posted) {
        if (exchange.sameIdAs === "differs") expect(id(exchange.name), exchange.name).not.toBe(id("base"));
        else expect(id(exchange.name), exchange.name).toBe(id(exchange.sameIdAs));
      }
      // The hand-made cases #576 names.
      expect(id("weightZero")).not.toBe(id("base"));
      expect(id("limiterZero")).not.toBe(id("base"));
      expect(id("numbersAsText")).toBe(id("base"));
      expect(id("stepRenamed")).not.toBe(id("base"));
    });
  });

  it("is the same on v0.9.3 for every profile v0.9.2 bundles or was posted, and v0.9.3 bundles 21 more", () => {
    const [minimum, next] = RECORDINGS.map(({ recorded }) => recorded) as [Recording, Recording];
    const ids = (recording: Recording) => recording.bundled.map((record) => record.id);
    expect(ids(next)).toEqual(expect.arrayContaining(ids(minimum)));
    expect(next.posted.map((exchange) => exchange.response.body.id)).toEqual(minimum.posted.map((exchange) => exchange.response.body.id));
    // The 21, among them the first of kind calibrate and a third cleaning one: #655's ids, computed from Decaid's files.
    expect(ids(next).filter((id) => !ids(minimum).includes(id)).sort()).toEqual(
      [
        "profile:f1b836e535b0b57f44a2",
        "profile:0ef8e395628904bd569a",
        "profile:676679ab3b3a0aff25c6",
        "profile:a258c0df3be3b337299f",
        "profile:5dcb9d71df6f51e695b8",
        "profile:474283e3a1fe28dc288c",
        "profile:06788710759408842c45",
        "profile:d555bef4d3eabbdef1c5",
        "profile:cd62fa222bb9f96ee318",
        "profile:be84050f7564ed7e7cce",
        "profile:28d47321846585be3d40",
        "profile:9e902a31f13fb8ea2c8e",
        "profile:242a62e1111b4a1bc47e",
        "profile:badeb80f41ebf99c93e3",
        "profile:ebbb87f21857d2265eca",
        "profile:df9b460c57d718fe7a26",
        "profile:e25775e340d9105fb043",
        "profile:622c4e81ee33585caced",
        "profile:27405f374ef44c8a96ef",
        "profile:109e603197b501223f15",
        "profile:dc4323dd98c57603d583",
      ].sort(),
    );
  });

  it("leaves out title, author and notes", () => {
    const profile = plain();
    expect(profileId({ ...profile, title: "Other", author: "Someone", notes: "Notes" })).toBe(profileId(profile));
  });
});

describe("reading a profile", () => {
  it.each(RECORDINGS)("reads a profile Decaid $version wrote as it is, its fields in Decaid's order", ({ recorded }) => {
    const written = [...recorded.bundled.map((record) => record.profile), ...recorded.posted.map((exchange) => exchange.response.body.profile)];
    for (const profile of written) expect(JSON.stringify(read(profile))).toBe(JSON.stringify(profile));
  });

  it.each(RECORDINGS)("reads it as Decaid $version writes it back", ({ recorded }) => {
    for (const exchange of recorded.posted) {
      const held = readProfile(posted(exchange.sameIdAs === "differs" ? exchange.name : exchange.sameIdAs, recorded).response.body.profile);
      expect(held.problem, exchange.name).toBeUndefined();
    }
    expect(read(posted("numbersAsText", recorded).request.body.profile)).toEqual(read(posted("base", recorded).request.body.profile));
  });

  it("keeps only the fields Decaid knows, typed as Decaid writes them", () => {
    const profile = read(posted("unknownFields").request.body.profile);
    expect(Object.keys(profile).sort()).toEqual(
      ["author", "beverage_type", "notes", "steps", "tank_temperature", "target_volume", "target_volume_count_start", "target_weight", "title", "version"].sort(),
    );
    expect(Object.keys(profile.steps[0]!).sort()).toEqual(["exit", "flow", "limiter", "name", "pump", "seconds", "sensor", "temperature", "transition", "volume", "weight"].sort());
    expect(profile.steps[0]!.exit).toEqual({ type: "pressure", condition: "over", value: 4 });
    expect(profile.steps[0]!.limiter).toEqual({ value: 4, range: 0.6 });
  });

  it("reads Decaid's defaults where it holds none", () => {
    const profile = read({ steps: [], beverage_type: "Latte", version: 2 });
    expect(profile).toMatchObject({ version: "2", title: "", author: "", notes: "", beverage_type: "espresso", target_volume: null, target_weight: null, target_volume_count_start: 0, tank_temperature: 0 });
    expect(read({ steps: [], target_volume_count_start: 2.7 }).target_volume_count_start).toBe(2);
    expect(read({ steps: [], target_weight: "none" }).target_weight).toBeNull();
  });

  it("refuses what Decaid refuses, naming the step and field", () => {
    const step = plain().steps[0]!;
    expect(readProfile(null).problem).toBe("A profile must be an object");
    expect(readProfile({ steps: [{ ...step, pump: "weight" }] }).problem).toBe('Step 1: pump must be "pressure" or "flow"');
    expect(readProfile({ steps: [step, { ...step, name: 3 }] }).problem).toBe("Step 2: name must be text");
    expect(readProfile({ steps: [{ ...step, transition: "Fast" }] }).problem).toBe('Step 1: transition must be "fast" or "smooth"');
    expect(readProfile({ steps: [{ ...step, seconds: "eight" }] }).problem).toBe("Step 1: seconds must be a number");
    expect(readProfile({ steps: [{ ...step, flow: undefined }] }).problem).toBe("Step 1: flow must be a number");
    expect(readProfile({ steps: [{ ...step, exit: { type: "weight", condition: "over", value: 1 } }] }).problem).toBe('Step 1: exit.type must be "pressure" or "flow"');
    expect(readProfile({ steps: [], target_volume_count_start: "1.5" }).problem).toBe("target_volume_count_start must be a whole number");
    // Beyond what a double holds exactly, which Decaid's int would read as another number: refused, not hashed as one near it.
    for (const count of ["9007199254740993", "1".repeat(400), 2 ** 60]) expect(readProfile({ steps: [], target_volume_count_start: count }).problem, String(count)).toBe("target_volume_count_start must be a whole number");
    expect(readProfile({ steps: [], target_volume_count_start: "9007199254740991" }).profile?.target_volume_count_start).toBe(9007199254740991);
  });

  it("refuses a number written as text that JavaScript can't read as Decaid does", () => {
    const step = plain().steps[0]!;
    for (const text of ["0x10", "NaN", "Infinity", "1e400"]) expect(readProfile({ steps: [{ ...step, seconds: text }] }).problem, text).toBe("Step 1: seconds must be a number");
    // Dart takes U+0085 off around a number, as JavaScript's trim does not.
    expect(readProfile({ steps: [{ ...step, seconds: "\u00852\u0085", weight: "\u00853" }], target_volume_count_start: "\u00854" }).profile).toMatchObject({ steps: [{ seconds: 2, weight: 3 }], target_volume_count_start: 4 });
    expect(readProfile({ steps: [{ ...step, weight: "0x10" }] }).problem).toBe("Step 1: weight must be a number");
  });
});

describe("the steps key", () => {
  it("leaves out each step's temperature and the target weight, and nothing else the id covers", () => {
    const profile = plain();
    const moved = { ...profile, target_weight: 40, steps: profile.steps.map((step) => ({ ...step, temperature: step.temperature + 2 })) };
    expect(profileStepsKey(moved)).toBe(profileStepsKey(profile));
    expect(profileStepsKey({ ...profile, steps: [{ ...profile.steps[0]!, seconds: 9 }, profile.steps[1]!] })).not.toBe(profileStepsKey(profile));
    expect(profileStepsKey({ ...profile, tank_temperature: 90 })).not.toBe(profileStepsKey(profile));
    expect(profileStepsKey({ ...profile, title: "Other" })).toBe(profileStepsKey(profile));
  });

  it("reads a limiter of value 0 as none, as Streamline sends one", () => {
    const profile = plain();
    const zero = { ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, limiter: { value: 0, range: 0.6 } }] };
    const none = { ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, limiter: null }] };
    expect(profileStepsKey(zero)).toBe(profileStepsKey(none));
    expect(stepsKey(zero.steps)).toBe(stepsKey(none.steps));
    expect(stepsKey(profile.steps)).not.toBe(stepsKey(none.steps));
  });
});

describe("the limits", () => {
  it("are the spec's", () => {
    expect(PROFILE_LIMITS).toMatchObject({
      pressure: { min: 0, max: 12 },
      flow: { min: 0, max: 15 },
      temperature: { min: 0, max: 105 },
      seconds: { min: 0, max: 127 },
      volume: { min: 0, max: 500 },
      weight: { min: 0, max: 500 },
      flowLimit: { min: 0, max: 8 },
      pressureLimit: { min: 0, max: 12 },
      limiterRange: { min: 0, max: 5 },
      tankTemperature: { min: 0, max: 110 },
    });
    expect(MAX_PROFILE_STEPS).toBe(20);
  });

  it("hold each value to the nearest end of its range, and report what they held", () => {
    const profile = plain();
    const wild: Profile = {
      ...profile,
      tank_temperature: 120,
      target_weight: -1,
      steps: [
        { ...profile.steps[0]!, flow: 16, seconds: 200, temperature: 110, exit: { type: "pressure", condition: "over", value: 13 }, limiter: { value: 13, range: 6 } },
        { ...profile.steps[1]!, pressure: 12.5, volume: 600, weight: 501, limiter: { value: 9, range: 0.6 } },
      ],
    } as Profile;
    const { profile: held, held: report } = holdToLimits(wild);
    expect(held.steps[0]).toMatchObject({ flow: 15, seconds: 127, temperature: 105, exit: { value: 12 }, limiter: { value: 12, range: 5 } });
    expect(held.steps[1]).toMatchObject({ pressure: 12, volume: 500, weight: 500, limiter: { value: 8, range: 0.6 } });
    expect(held).toMatchObject({ tank_temperature: 110, target_weight: 0 });
    expect(report).toEqual(
      expect.arrayContaining([
        { step: 0, path: "steps.0.flow", from: 16, to: 15 },
        { step: 0, path: "steps.0.limiter.value", from: 13, to: 12 },
        { step: 1, path: "steps.1.limiter.value", from: 9, to: 8 },
        { step: null, path: "tank_temperature", from: 120, to: 110 },
        { step: null, path: "target_weight", from: -1, to: 0 },
      ]),
    );
    expect(report).toHaveLength(12);
    expect(wild.steps[0]).toMatchObject({ flow: 16 });
  });

  it("hold a flow exit to the flow exit's range and a pressure exit to the pressure's", () => {
    const profile = plain();
    const flowExit: Profile = { ...profile, steps: [{ ...profile.steps[0]!, exit: { type: "flow", condition: "under", value: 9 } }] };
    expect(holdToLimits(flowExit).profile.steps[0]!.exit).toEqual({ type: "flow", condition: "under", value: 8 });
  });

  it("hold only what is out of range, keeping a tank temperature of -0.0, which Decaid hashes as written", () => {
    const profile = plain();
    const signed: Profile = { ...profile, tank_temperature: -0, steps: [{ ...profile.steps[0]!, pump: "pressure", pressure: 13 }, ...profile.steps.slice(1)] };
    const { profile: held, held: report } = holdToLimits(signed);
    expect(report).toEqual([{ step: 0, path: "steps.0.pressure", from: 13, to: 12 }]);
    expect(Object.is(held.tank_temperature, -0)).toBe(true);
  });

  it("leave a profile within them as it is", () => {
    const profile = plain();
    const { profile: held, held: report } = holdToLimits(profile);
    expect(held).toBe(profile);
    expect(report).toEqual([]);
  });
});

describe("the ranges by model", () => {
  it("are a DE1's as Streamline's, and a Bengle's the same but for flow targets, limits and exits up to its pump's 20 ml/s", () => {
    expect(MODEL_LIMITS.DE1).toBe(PROFILE_LIMITS);
    expect(MODEL_LIMITS.Bengle).toEqual({ ...PROFILE_LIMITS, flow: { min: 0, max: 20 }, flowLimit: { min: 0, max: 20 }, flowExit: { min: 0, max: 20 } });
    expect(MODEL_LIMITS.Bengle.pressure).toEqual({ min: 0, max: 12 });
    expect(MODEL_LIMITS.Bengle.pressureExit).toEqual({ min: 0, max: 12 });
  });

  it("widen to the widest of the models', a DE1's for none", () => {
    expect(widestLimits([])).toEqual(MODEL_LIMITS.DE1);
    expect(widestLimits(["DE1"])).toEqual(MODEL_LIMITS.DE1);
    expect(widestLimits(["DE1", "Bengle"])).toEqual(MODEL_LIMITS.Bengle);
  });

  it("say what a model can't run, as authored, with each value's range", () => {
    const profile = plain();
    const fast: Profile = {
      ...profile,
      steps: [{ ...profile.steps[0]!, flow: 18 } as ProfileStep, { ...profile.steps[1]!, limiter: { value: 12, range: 0.6 }, exit: { type: "flow", condition: "over", value: 9 } }],
    };
    expect(unrunnable(fast, "DE1")).toEqual([
      { step: 0, path: "steps.0.flow", from: 18, to: 15, range: { min: 0, max: 15 } },
      { step: 1, path: "steps.1.exit.value", from: 9, to: 8, range: { min: 0, max: 8 } },
      { step: 1, path: "steps.1.limiter.value", from: 12, to: 8, range: { min: 0, max: 8 } },
    ]);
    expect(unrunnable(fast, "Bengle")).toEqual([]);
    // Judged as authored: 15.01 ml/s is outside a DE1's range, though the machine would be sent it as 15.
    expect(unrunnable({ ...profile, steps: [{ ...profile.steps[0]!, flow: 15.01 } as ProfileStep] }, "DE1").map((value) => value.from)).toEqual([15.01]);
    expect(unrunnable(profile, "DE1")).toEqual([]);
  });

  it("take rounding noise at a range's end as in it, as a bundled cleaning profile's -4e-16 bar", () => {
    const profile = plain();
    const noisy: Profile = { ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, pressure: -3.885780586188048e-16 } as ProfileStep] };
    expect(outOfRange(noisy)).toEqual([]);
    expect(outOfRange({ ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, pressure: -0.001 } as ProfileStep] })).toHaveLength(1);
    for (const { recorded } of RECORDINGS) for (const record of recorded.bundled) expect(unrunnable(read(record.profile), "DE1"), record.id).toEqual([]);
  });
});

describe("the checks", () => {
  it("find nothing in a plain profile", () => {
    expect(checkProfile(plain())).toEqual({ blocking: [], advice: [] });
  });

  it("stop publishing for no title, no steps, a step with no name and a value out of range, each naming its step", () => {
    const profile = plain();
    expect(checkProfile({ ...profile, title: " ", steps: [] }).blocking.map((check) => check.code)).toEqual(["noTitle", "noSteps"]);
    const checks = checkProfile({ ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, name: "", pressure: 13 } as ProfileStep] });
    expect(checks.blocking).toEqual([
      { code: "stepNoName", step: 1, path: "steps.1.name", message: "Step 2 has no name." },
      { code: "outOfRange", step: 1, path: "steps.1.pressure", message: "Step 2: its pressure is 13, outside 0 to 12." },
    ]);
    const many = { ...profile, steps: Array.from({ length: 21 }, () => profile.steps[0]!) };
    expect(checkProfile(many).blocking.map((check) => check.code)).toEqual(["tooManySteps"]);
  });

  it("stop publishing steps the Library has, naming its Profile, and a title in use where it would be shown", () => {
    const profile = plain();
    const checks = checkProfile(profile, { libraryProfiles: [{ id: profileId(profile), title: "Already here" }], titlesInUse: ["plain "] });
    expect(checks.blocking).toEqual([
      { code: "sameSteps", step: null, path: "steps", message: 'Its steps are those of "Already here", which the Library has.' },
      { code: "titleInUse", step: null, path: "title", message: 'A Profile shown there is titled "Plain" already.' },
    ]);
    expect(checkProfile(profile, { libraryProfiles: [{ id: "profile:00000000000000000000", title: "Other" }], titlesInUse: ["Other"] }).blocking).toEqual([]);
  });

  it("advise of a weight limit, an exit on a step of no length and a flow above the pump's, each naming its step", () => {
    const profile = plain();
    const checks = checkProfile({
      ...profile,
      steps: [
        { ...profile.steps[0]!, seconds: 0, flow: 10 } as ProfileStep,
        { ...profile.steps[1]!, weight: 4 },
      ],
    });
    expect(checks.blocking).toEqual([]);
    expect(checks.advice).toEqual([
      { code: "exitOnNoLength", step: 0, path: "steps.0.exit", message: 'Step 1, "fill" has no length, so the machine leaves it at once and its exit never applies.' },
      { code: "pumpTooSlow", step: 0, path: "steps.0.flow", message: "Step 1, \"fill\" asks for 10 ml/s, and a DE1's pump gives about 8 ml/s at most." },
      { code: "weightNeedsScale", step: 1, path: "steps.1.weight", message: 'Step 2, "pour" ends at a weight in the cup, which needs a scale connected.' },
    ]);
    expect(checkProfile({ ...profile, steps: [{ ...profile.steps[1]!, weight: 0 }] }).advice).toEqual([]);
    // A time the machine is sent as none, in tenths rounded, has no length either; 0.05 s is sent as a tenth.
    const timed = (seconds: number) => checkProfile({ ...profile, steps: [{ ...profile.steps[0]!, seconds }] }).advice.map((check) => check.code);
    expect(timed(0.04)).toEqual(["exitOnNoLength"]);
    expect(timed(0.05)).toEqual([]);
  });
});

describe("the checks of a simulated run", () => {
  const run = (profile: Profile) => simulateProfile({ profile, puck: standardPuck(0), stopAt: profile.target_weight, model: "DE1" });
  const steps = () => plain().steps as [ProfileStep, ProfileStep];

  it("advise of a step whose target the run never comes near, as when a limit holds it back, naming the step", () => {
    const [fill, pour] = steps();
    // A flow limit of 0.4 ml/s holds a medium puck under 5 bar for the pour's whole 30 s, short of the 36 g it stops at.
    const limited = { ...plain(), steps: [fill, { ...pour, limiter: { value: 0.4, range: 0.1 } } as ProfileStep] };
    expect(checkProfile(limited, { run: run(limited) }).advice).toEqual([
      { code: "targetNotReached", step: 1, path: "steps.1.pressure", message: expect.stringMatching(/^Step 2, "pour" never reaches its 9 bar on the puck simulated: the nearest it comes is [\d.]+ bar, before its time is up\.$/) },
    ]);
    const flat = { ...plain(), steps: [fill, { ...pour, transition: "fast", pressure: 6, limiter: null } as ProfileStep] };
    expect(checkProfile(flat, { run: run(flat) }).advice).toEqual([]);
  });

  it("advise of a ramp the Shot stops before it gets to its target", () => {
    const [fill, pour] = steps();
    // A decline to 2 bar over 60 s, stopped at 36 g long before it gets there.
    const cut = { ...plain(), steps: [fill, { ...pour, pressure: 2, limiter: null, seconds: 60 } as ProfileStep] };
    expect(checkProfile(cut, { run: run(cut) }).advice.map((check) => [check.code, check.step, check.message.endsWith("before the Shot stops.")])).toEqual([["targetNotReached", 1, true]]);
  });

  it("leave a step alone that ended at its exit, its water or its weight, and one the run never came to", () => {
    const [plainFill, pour] = steps();
    // The fill exits over 3 bar, the next pumps its 3 ml, and the Shot stops at 10 g in the third, before the fourth.
    const fill = { ...plainFill, exit: { type: "pressure", condition: "over", value: 3 } } as ProfileStep;
    const ended = {
      ...plain(),
      target_weight: 10,
      steps: [fill, { ...pour, volume: 3 }, { ...pour, name: "hold", transition: "fast", pressure: 4, limiter: null }, { ...pour, name: "never", pressure: 2, limiter: null }] as ProfileStep[],
    };
    const ran = run(ended);
    expect(ran.steps.map((step) => step.reason)).toEqual(["exit", "water", "stop", null]);
    expect(checkProfile(ended, { run: ran }).advice).toEqual([]);
    // A step held well under its 9 bar, ended at 2 g in the cup.
    const weighed = { ...plain(), target_weight: 0, steps: [fill, { ...pour, transition: "fast", limiter: { value: 0.5, range: 0.1 }, weight: 2 } as ProfileStep] };
    const stopped = run(weighed);
    expect(stopped.steps.map((step) => step.reason)).toEqual(["exit", "weight"]);
    expect(checkProfile(weighed, { run: stopped }).advice.map((check) => check.code)).toEqual(["weightNeedsScale"]);
  });

  it("leave a step alone that ran under 3 s, and one asking for a flow the pump can't give, which is advised of already", () => {
    const [fill, pour] = steps();
    // A 2 s rise to 9 bar, held back by a limit, and carried on by the pour.
    const rise = { ...pour, name: "rise", transition: "fast", seconds: 2, limiter: { value: 0.8, range: 0.2 } } as ProfileStep;
    const short = { ...plain(), steps: [fill, rise, { ...pour, transition: "fast", limiter: null } as ProfileStep] };
    const ranShort = run(short);
    expect(ranShort.steps[1]).toMatchObject({ reason: "time" });
    expect(checkProfile(short, { run: ranShort }).advice).toEqual([]);
    // 11 ml/s, past what a DE1's pump gives, for 30 s.
    const flush = { ...plain(), steps: [{ name: "flush", pump: "flow", transition: "fast", exit: null, volume: 0, seconds: 30, weight: null, temperature: 92, sensor: "coffee", flow: 11, limiter: null } as ProfileStep] };
    expect(checkProfile(flush, { run: run(flush) }).advice.map((check) => check.code)).toEqual(["pumpTooSlow"]);
    // Simulated on a Bengle, whose pump gives it, a DE1's too slow pump is no reason to leave out the step a limit of 4 bar holds back on the puck.
    const limited = { ...flush, steps: [fill, { ...flush.steps[0]!, limiter: { value: 4, range: 0.6 } } as ProfileStep] };
    const onBengle = simulateProfile({ profile: limited, puck: standardPuck(0), stopAt: limited.target_weight, model: "Bengle" });
    expect(checkProfile(limited, { models: ["DE1", "Bengle"], run: onBengle }).advice.map((check) => check.code)).toEqual(["pumpTooSlow", "targetNotReached"]);
    // On a DE1, its pump the reason, pumpTooSlow alone.
    expect(checkProfile(limited, { models: ["DE1", "Bengle"], run: run(limited) }).advice.map((check) => check.code)).toEqual(["pumpTooSlow"]);
  });
});

describe("a profile file to import", () => {
  it("reads a bare profile, and a whole record by its profile", () => {
    const profile = plain();
    expect(readProfileFile(profile)).toEqual({ profile });
    const record = { id: profileId(profile), parentId: null, profile, isDefault: false, visibility: "visible", metadata: { source: "user" } };
    expect(readProfileFile(record)).toEqual({ profile });
  });

  it("says why it can't be read, as readProfile does", () => {
    expect(readProfileFile([])).toEqual({ problem: "A profile must be an object" });
    expect(readProfileFile({ profile: { ...plain(), steps: [{ pump: "steam" }] } }).problem).toMatch(/^Step 1/);
  });
});

describe("the starting shapes", () => {
  it("are six, each with its own key, a title and a line on what it is for", () => {
    expect(STARTING_SHAPES.map((shape) => shape.key)).toEqual(["classic", "lever", "steady-flow", "blooming", "long", "blank"]);
    for (const shape of STARTING_SHAPES) {
      expect(shape.title, shape.key).not.toBe("");
      expect(shape.description, shape.key).toMatch(/\.$/);
      expect(startingShape(shape.key)).toBe(shape);
    }
    expect(startingShape("none")).toBeUndefined();
  });

  it("read as Decaid reads them, plain steps a DE1 runs, with nothing to stop or advise of on a medium puck", () => {
    for (const shape of STARTING_SHAPES) {
      expect(readProfile(shape.profile), shape.key).toEqual({ profile: shape.profile });
      expect(checkProfile(shape.profile, { run: simulateProfile({ profile: shape.profile, puck: standardPuck(0), stopAt: shape.profile.target_weight, model: "DE1" }) }), shape.key).toEqual({ blocking: [], advice: [] });
      expect(holdToLimits(shape.profile).held, shape.key).toEqual([]);
    }
    // Each its own steps, so no two publish as one Profile.
    expect(new Set(STARTING_SHAPES.map((shape) => profileId(shape.profile))).size).toBe(STARTING_SHAPES.length);
  });
});

describe("the checks by model", () => {
  const profile = plain();
  const withFlow = (flow: number): Profile => ({ ...profile, steps: [{ ...profile.steps[0]!, flow } as ProfileStep, profile.steps[1]!] });

  it("are a DE1's where no model, or only a DE1, is given", () => {
    const de1 = checkProfile(withFlow(18), { models: ["DE1"] });
    expect(de1).toEqual(checkProfile(withFlow(18)));
    expect(de1.blocking).toEqual([{ code: "outOfRange", step: 0, path: "steps.0.flow", message: 'Step 1, "fill": its flow is 18, outside 0 to 15.' }]);
    expect(checkProfile(withFlow(18), { models: [] })).toEqual(de1);
  });

  it("hold a profile to the widest of the models' ranges, advising of a value one of them can't run, naming it", () => {
    const checks = checkProfile(withFlow(18), { models: ["Bengle", "DE1"] });
    expect(checks.blocking).toEqual([]);
    expect(checks.advice).toEqual([
      { code: "pumpTooSlow", step: 0, path: "steps.0.flow", message: "Step 1, \"fill\" asks for 18 ml/s, and a DE1's pump gives about 8 ml/s at most, and a Bengle's heater keeps up with about 15 ml/s at most." },
      { code: "modelCantRun", step: 0, path: "steps.0.flow", message: 'Step 1, "fill": its flow is 18, which a DE1 can\'t run: a DE1 takes 0 to 15.' },
    ]);
    const limited: Profile = { ...profile, steps: [profile.steps[0]!, { ...profile.steps[1]!, limiter: { value: 12, range: 0.6 } }] };
    expect(checkProfile(limited, { models: ["DE1", "Bengle"] }).advice).toEqual([
      { code: "modelCantRun", step: 1, path: "steps.1.limiter.value", message: 'Step 2, "pour": its limit is 12, which a DE1 can\'t run: a DE1 takes 0 to 8.' },
    ]);
    expect(checkProfile(withFlow(22), { models: ["DE1", "Bengle"] }).blocking).toEqual([
      { code: "outOfRange", step: 0, path: "steps.0.flow", message: 'Step 1, "fill": its flow is 22, outside 0 to 20.' },
    ]);
  });

  it("advise of a flow above what each model keeps up with: a DE1's pump's 8 ml/s and a Bengle's heater's 15", () => {
    expect(checkProfile(withFlow(10), { models: ["Bengle"] }).advice).toEqual([]);
    expect(checkProfile(withFlow(16), { models: ["Bengle"] }).advice).toEqual([
      { code: "pumpTooSlow", step: 0, path: "steps.0.flow", message: "Step 1, \"fill\" asks for 16 ml/s, and a Bengle's heater keeps up with about 15 ml/s at most." },
    ]);
    expect(checkProfile(withFlow(10), { models: ["DE1", "Bengle"] }).advice.map((check) => check.message)).toEqual([
      "Step 1, \"fill\" asks for 10 ml/s, and a DE1's pump gives about 8 ml/s at most.",
    ]);
  });
});

describe("SHA-256", () => {
  it("is Node's for text of any length and any characters", () => {
    const samples = ["", "abc", "é", "日本語", "🙂", "\ud800 lone", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)];
    for (let n = 0; n < 50; n++) samples.push(randomBytes(n * 7).toString("latin1"));
    for (const text of samples) expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
