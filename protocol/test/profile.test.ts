import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Profile,
  type ProfileStep,
  MAX_PROFILE_STEPS,
  PROFILE_LIMITS,
  checkProfile,
  holdToLimits,
  profileId,
  profileStepsKey,
  readProfile,
  stepsKey,
} from "../src/index.js";
import { sha256Hex } from "../src/sha256.js";

// The ids Decaid v0.9.2 gave every profile it bundles, and profiles posted to
// it that differ in what its hash covers or only in what it leaves out
// (server/test/fixtures/decaid/profile-ids-v0.9.2/README.md). v0.9.2 is the
// oldest supported Decaid and its newest release.

interface Posted {
  name: string;
  sameIdAs: string;
  request: { body: { profile: Record<string, unknown> } };
  response: { status: number; body: { id: string; profile: unknown } };
}

const recorded = JSON.parse(fs.readFileSync(new URL("../../server/test/fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as {
  bundled: Array<{ id: string; profile: unknown; isDefault: boolean }>;
  posted: Posted[];
};

function read(value: unknown): Profile {
  const read = readProfile(value);
  if (!read.profile) throw new Error(read.problem);
  return read.profile;
}

function posted(name: string): Posted {
  return recorded.posted.find((exchange) => exchange.name === name)!;
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
  it("is Decaid's for every profile it bundles", () => {
    expect(recorded.bundled).toHaveLength(73);
    for (const record of recorded.bundled) expect(profileId(read(record.profile)), record.id).toBe(record.id);
  });

  it("is Decaid's for each profile posted to it, as sent, before Decaid read it", () => {
    for (const exchange of recorded.posted) {
      expect(exchange.response.status, exchange.name).toBe(201);
      expect(profileId(read(exchange.request.body.profile)), exchange.name).toBe(exchange.response.body.id);
    }
  });

  it("tells apart what Decaid's hash tells apart, and nothing else", () => {
    const id = (name: string) => posted(name).response.body.id;
    for (const exchange of recorded.posted) {
      if (exchange.sameIdAs === "differs") expect(id(exchange.name), exchange.name).not.toBe(id("base"));
      else expect(id(exchange.name), exchange.name).toBe(id(exchange.sameIdAs));
    }
    // The hand-made cases the ticket names.
    expect(id("weightZero")).not.toBe(id("base"));
    expect(id("limiterZero")).not.toBe(id("base"));
    expect(id("numbersAsText")).toBe(id("base"));
    expect(id("stepRenamed")).not.toBe(id("base"));
  });

  it("leaves out title, author and notes", () => {
    const profile = plain();
    expect(profileId({ ...profile, title: "Other", author: "Someone", notes: "Notes" })).toBe(profileId(profile));
  });
});

describe("reading a profile", () => {
  it("reads a profile Decaid wrote as it is, its fields in Decaid's order", () => {
    const written = [...recorded.bundled.map((record) => record.profile), ...recorded.posted.map((exchange) => exchange.response.body.profile)];
    for (const profile of written) expect(JSON.stringify(read(profile))).toBe(JSON.stringify(profile));
  });

  it("reads it as Decaid writes it back", () => {
    for (const exchange of recorded.posted) {
      const held = readProfile(posted(exchange.sameIdAs === "differs" ? exchange.name : exchange.sameIdAs).response.body.profile);
      expect(held.problem, exchange.name).toBeUndefined();
    }
    expect(read(posted("numbersAsText").request.body.profile)).toEqual(read(posted("base").request.body.profile));
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
      { code: "pumpTooSlow", step: 0, path: "steps.0.flow", message: 'Step 1, "fill" asks for 10 ml/s, and the pump gives about 8 ml/s at most.' },
      { code: "weightNeedsScale", step: 1, path: "steps.1.weight", message: 'Step 2, "pour" ends at a weight in the cup, which needs a scale connected.' },
    ]);
    expect(checkProfile({ ...profile, steps: [{ ...profile.steps[1]!, weight: 0 }] }).advice).toEqual([]);
  });
});

describe("SHA-256", () => {
  it("is Node's for text of any length and any characters", () => {
    const samples = ["", "abc", "é", "日本語", "🙂", "\ud800 lone", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)];
    for (let n = 0; n < 50; n++) samples.push(randomBytes(n * 7).toString("latin1"));
    for (const text of samples) expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});
