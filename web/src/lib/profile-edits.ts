import { type ExitCondition, type ExitType, type Profile, type ProfileLimits, type ProfileStep, type Range, type StepPump, stepTarget } from "@decent-sync/protocol";

// The edits a Draft's editor makes to its profile (#579): its steps added,
// duplicated, deleted and moved, with where preinfusion ends kept on the
// step it ended on; a step's pump switched; and temperatures given relative
// to the first step's, as a Recipe's brew temperature moves them all. Each
// returns a new profile and leaves the one given as it was.

/** A number held to its range, to a tenth, as a handle dragged on the graph sets one. */
export function held(value: number, range: Range): number {
  return Math.round(Math.min(range.max, Math.max(range.min, value)) * 10) / 10;
}

/** A number held to its range, kept as typed but for arithmetic's noise, to a thousandth: a value is kept as authored, not at a model's resolution. */
export function clamped(value: number, range: Range): number {
  return Math.round(Math.min(range.max, Math.max(range.min, value)) * 1000) / 1000;
}

/** A step's target's range among the limits: its pump's. */
export function targetRange(step: ProfileStep, limits: ProfileLimits): Range {
  return limits[step.pump];
}

/** A step's limit's range among the limits: a flow limit's on a step whose pump controls pressure, a pressure limit's on one controlling flow. */
export function limitRange(step: ProfileStep, limits: ProfileLimits): Range {
  return step.pump === "pressure" ? limits.flowLimit : limits.pressureLimit;
}

/** An exit's range among the limits: the quantity's it watches. */
export function exitRange(type: ExitType, limits: ProfileLimits): Range {
  return type === "pressure" ? limits.pressureExit : limits.flowExit;
}

/** The step with its target set. */
export function withTarget(step: ProfileStep, target: number): ProfileStep {
  return step.pump === "pressure" ? { ...step, pressure: target } : { ...step, flow: target };
}

/**
 * The step with its pump controlling the other quantity, toward a target of
 * that quantity: its limit, which caps that quantity, is dropped, as its
 * value means the other's, and its target starts at a middling one: 6 bar,
 * or 2 ml/s.
 */
export function withPump(step: ProfileStep, pump: StepPump): ProfileStep {
  if (step.pump === pump) return step;
  const { pressure: _, flow: __, ...rest } = step as ProfileStep & { pressure?: number; flow?: number };
  return pump === "pressure" ? { ...rest, pump, pressure: 6, limiter: null } : { ...rest, pump, flow: 2, limiter: null };
}

/** How a step moves on, as the editor's choice names it: when its time is up, or when a quantity goes over or under its exit's value. */
export type MovesOn = "time" | `${ExitType}-${ExitCondition}`;

/** The step's choice of how it moves on. */
export function movesOn(step: ProfileStep): MovesOn {
  return step.exit === null ? "time" : `${step.exit.type}-${step.exit.condition}`;
}

/**
 * The step moving on as chosen: with no exit, at its time, or at an exit of
 * the quantity and condition chosen, keeping its exit's value where it
 * watched the same quantity, else at a middling one, 4 bar or 2 ml/s.
 */
export function withMovesOn(step: ProfileStep, choice: MovesOn, limits: ProfileLimits): ProfileStep {
  if (choice === "time") return { ...step, exit: null };
  const [type, condition] = choice.split("-") as [ExitType, ExitCondition];
  const value = step.exit?.type === type ? step.exit.value : type === "pressure" ? 4 : 2;
  return { ...step, exit: { type, condition, value: clamped(value, exitRange(type, limits)) } };
}

/** The step that ends preinfusion, by index, or null where none is preinfusion: the last of the first `target_volume_count_start` steps there are. */
export function preinfusionEnd(profile: Profile): number | null {
  const count = Math.min(profile.target_volume_count_start, profile.steps.length);
  return count > 0 ? count - 1 : null;
}

/**
 * The profile with new steps, where `moved[i]` is where its step `i` went,
 * or null where it was deleted: preinfusion ends on the step it ended on,
 * wherever it went, or, where that step was deleted, on the nearest kept
 * before it, or nowhere.
 */
function withSteps(profile: Profile, steps: ProfileStep[], moved: readonly (number | null)[]): Profile {
  const end = preinfusionEnd(profile);
  let count = 0;
  if (end !== null) {
    for (let index = end; index >= 0; index--) {
      const to = moved[index];
      if (to !== null && to !== undefined) {
        count = to + 1;
        break;
      }
    }
  }
  return { ...profile, steps, target_volume_count_start: count };
}

/** A plain step to add after `base`: 6 bar at once for 10 s, at `base`'s temperature, measured where it is measured. */
function plainStep(base: ProfileStep | undefined): ProfileStep {
  return { name: "New step", pump: "pressure", transition: "fast", exit: null, volume: 0, seconds: 10, weight: null, temperature: base?.temperature ?? 93, sensor: base?.sensor ?? "coffee", pressure: 6, limiter: null };
}

function inserted(profile: Profile, at: number, step: ProfileStep): Profile {
  const steps = [...profile.steps.slice(0, at), step, ...profile.steps.slice(at)];
  return withSteps(
    profile,
    steps,
    profile.steps.map((_, index) => (index < at ? index : index + 1)),
  );
}

/** The profile with a plain step added after the step at `after`, or as the first where there are none. */
export function addStep(profile: Profile, after: number): Profile {
  const at = Math.min(profile.steps.length, Math.max(0, after + 1));
  return inserted(profile, at, plainStep(profile.steps[at - 1] ?? profile.steps[0]));
}

/** The profile with a copy of the step at `index` after it. */
export function duplicateStep(profile: Profile, index: number): Profile {
  const step = profile.steps[index];
  return step ? inserted(profile, index + 1, structuredClone(step)) : profile;
}

/** The profile without the step at `index`. */
export function deleteStep(profile: Profile, index: number): Profile {
  if (!profile.steps[index]) return profile;
  return withSteps(
    profile,
    profile.steps.filter((_, at) => at !== index),
    profile.steps.map((_, at) => (at === index ? null : at < index ? at : at - 1)),
  );
}

/** The profile with the step at `from` moved to `to`, the steps between closing up. */
export function moveStep(profile: Profile, from: number, to: number): Profile {
  if (!profile.steps[from] || to < 0 || to >= profile.steps.length || from === to) return profile;
  const order = profile.steps.map((_, index) => index);
  order.splice(from, 1);
  order.splice(to, 0, from);
  const moved = profile.steps.map((_, index) => order.indexOf(index));
  return withSteps(
    profile,
    order.map((index) => profile.steps[index]!),
    moved,
  );
}

/** The profile with the step at `index` replaced. */
export function setStep(profile: Profile, index: number, step: ProfileStep): Profile {
  return { ...profile, steps: profile.steps.map((each, at) => (at === index ? step : each)) };
}

/** The profile with preinfusion ending after the step at `index`, or none for null. */
export function withPreinfusionEnd(profile: Profile, index: number | null): Profile {
  return { ...profile, target_volume_count_start: index === null ? 0 : Math.min(profile.steps.length, index + 1) };
}

/** The profile's brew temperature: its first step's, which a Recipe's brew temperature replaces, moving the others with it. */
export function brewTemperature(profile: Profile): number | null {
  return profile.steps[0]?.temperature ?? null;
}

/** The profile at a brew temperature: every step's temperature moved by as much as the first step's, held to the range. */
export function withBrewTemperature(profile: Profile, temperature: number, range: Range): Profile {
  const first = brewTemperature(profile);
  if (first === null) return profile;
  const by = temperature - first;
  return { ...profile, steps: profile.steps.map((step) => ({ ...step, temperature: clamped(step.temperature + by, range) })) };
}

/** A step's temperature relative to the first step's, °C, to a tenth; 0 for the first. */
export function relativeTo(profile: Profile, index: number): number {
  const first = brewTemperature(profile) ?? 0;
  return Math.round(((profile.steps[index]?.temperature ?? first) - first) * 10) / 10;
}

/** The profile with the step at `index`'s temperature set relative to the first step's, held to the range. */
export function withRelativeTemperature(profile: Profile, index: number, relative: number, range: Range): Profile {
  const step = profile.steps[index];
  const first = brewTemperature(profile);
  if (!step || first === null) return profile;
  return setStep(profile, index, { ...step, temperature: clamped(first + relative, range) });
}

/** The step's target, to a tenth, as a handle shows it. */
export function targetOf(step: ProfileStep): number {
  return Math.round(stepTarget(step) * 10) / 10;
}
