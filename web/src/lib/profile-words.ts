import { type Profile, type ProfileStep, type RunStep, type SimulatedRun, type StepExit, stepTarget } from "@decent-sync/protocol";

// A profile and a simulated run of it in plain words, as a Profile's page
// says them (#578): what each step has the Machine do, when it moves on, and
// what the simulation did with it.

/** A number as the page writes a measure: to a tenth at most, without a trailing 0. */
export function measure(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Seconds to a tenth, such as "5.3 s". */
export function seconds(value: number): string {
  return `${(Math.round(value * 10) / 10).toFixed(1)} s`;
}

/** A step's name, or "Step n" for one with none, `index` from 0. */
export function stepName(step: { name: string }, index: number): string {
  return step.name.trim() || `Step ${index + 1}`;
}

const UNITS = { pressure: "bar", flow: "ml/s" } as const;

/** What the step's pump is asked for, such as "Pumps 8 ml/s at once" or "Holds 6 bar at once", with its limit and its temperature against the first step's. */
export function stepAction(profile: Profile, index: number): string {
  const step = profile.steps[index]!;
  const target = stepTarget(step);
  const how = step.transition === "smooth" ? "over the step" : "at once";
  const parts = [
    target <= 0
      ? "Stops the pump"
      : step.pump === "flow"
        ? `${step.transition === "smooth" ? "Ramps to" : "Pumps"} ${measure(target)} ml/s ${how}`
        : `${step.transition === "smooth" ? "Ramps to" : "Holds"} ${measure(target)} bar ${how}`,
  ];
  const limit = limitText(step);
  if (limit) parts.push(limit);
  const temperature = relativeTemperature(profile, index);
  if (temperature) parts.push(temperature);
  return parts.join(", ");
}

/** The step's limit, such as "flow limited to 1.5 ml/s"; null for none. A limit caps what the pump does not control. */
export function limitText(step: ProfileStep): string | null {
  if (step.limiter === null || step.limiter.value <= 0) return null;
  const capped = step.pump === "pressure" ? "flow" : "pressure";
  return `${capped} limited to ${measure(step.limiter.value)} ${UNITS[capped]}`;
}

/** A later step's temperature against the first's, such as "20 °C cooler"; null for the first step and one at the same temperature. */
export function relativeTemperature(profile: Profile, index: number): string | null {
  if (index === 0) return null;
  const difference = profile.steps[index]!.temperature - profile.steps[0]!.temperature;
  if (Math.abs(difference) < 0.05) return null;
  return `${measure(Math.abs(difference))} °C ${difference < 0 ? "cooler" : "hotter"}`;
}

/** An exit, such as "over 4 bar". */
export function exitText(exit: StepExit): string {
  return `${exit.condition} ${measure(exit.value)} ${UNITS[exit.type]}`;
}

/** When the step moves on, such as "Over 4 bar, or after 15 s", "After 90 s", or "At once" for a step of no length, whose exit never holds it. */
export function stepMovesOn(step: ProfileStep): string {
  if (step.seconds <= 0) return "At once";
  const ends = [
    ...(step.exit && step.exit.value > 0 ? [exitText(step.exit)] : []),
    ...(step.weight !== null && step.weight > 0 ? [`${measure(step.weight)} g in the cup`] : []),
    ...(step.volume > 0 ? [`${measure(step.volume)} ml pumped`] : []),
  ];
  const time = `after ${measure(step.seconds)} s`;
  const text = ends.length === 0 ? time : `${ends.join(", ")}, or ${time}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a run's step ended, such as "pressure passed 4 bar" or "in full"; null for a step it never came to. */
export function stepEndText(profile: Profile, run: SimulatedRun, ran: RunStep): string | null {
  const step = profile.steps[ran.index];
  if (ran.start === null || ran.end === null || !step) return null;
  if (ran.end === ran.start && ran.reason !== "stop") return "passed through at once";
  switch (ran.reason) {
    case "exit":
      return step.exit ? `${step.exit.type} ${step.exit.condition === "over" ? "passed" : "fell under"} ${measure(step.exit.value)} ${UNITS[step.exit.type]}` : "its exit";
    case "weight":
      return `${measure(step.weight ?? 0)} g reached the cup`;
    case "water":
      return `pumped its ${measure(step.volume)} ml`;
    case "stop":
      return run.stop.reason === "weight" ? `the Shot stopped at ${measure(run.stopAt ?? run.weight)} g` : "the Shot stopped";
    default:
      return "in full";
  }
}

/** What the simulation did with a step, such as "5.3 s, pressure passed 4 bar", or "Not reached". */
export function stepSimulated(profile: Profile, run: SimulatedRun, index: number): string {
  const ran = run.steps[index];
  const why = ran ? stepEndText(profile, run, ran) : null;
  if (!ran || ran.start === null || ran.end === null || why === null) return "Not reached";
  if (why === "passed through at once") return "Passed through at once";
  return `${seconds(ran.end - ran.start)}, ${why}`;
}

/** The figures a Profile states once, each with what a Recipe replaces: its brew temperature, stop-at weight, where preinfusion ends and its water tank. */
export function profileFacts(profile: Profile): { term: string; text: string }[] {
  const first = profile.steps[0];
  const ends = profile.target_volume_count_start;
  const last = profile.steps[ends - 1];
  return [
    { term: "Brew temperature", text: first ? `${measure(first.temperature)} °C, unless a Recipe sets its own` : "None, as it has no steps" },
    {
      term: "Stops at",
      text:
        profile.target_weight !== null && profile.target_weight > 0
          ? `${measure(profile.target_weight)} g, unless a Recipe sets a yield`
          : "When its last step ends, unless a Recipe sets a yield",
    },
    { term: "Preinfusion", text: ends <= 0 || !last ? "None" : `Ends after ${stepName(last, ends - 1)}` },
    { term: "Water tank", text: profile.tank_temperature > 0 ? `Preheated to ${measure(profile.tank_temperature)} °C` : "Not preheated" },
  ];
}

/** Where two profiles differ, in the Profile page's words: each step's action and when it moves on, then what each states once. */
export function differences(a: Profile, b: Profile): [string, string, string][] {
  const rows: [string, string, string][] = [];
  const count = Math.max(a.steps.length, b.steps.length);
  for (let index = 0; index < count; index++) {
    const stepA = a.steps[index];
    const stepB = b.steps[index];
    const name = stepName(stepA ?? stepB!, index);
    if (!stepA || !stepB) {
      rows.push([`Step ${index + 1}`, stepA ? `${name}: ${stepAction(a, index)}` : "None", stepB ? `${name}: ${stepAction(b, index)}` : "None"]);
      continue;
    }
    if (stepName(stepA, index) !== stepName(stepB, index)) rows.push([`Step ${index + 1} is named`, stepName(stepA, index), stepName(stepB, index)]);
    const actionA = stepAction(a, index);
    const actionB = stepAction(b, index);
    if (actionA !== actionB) rows.push([`${name} does`, actionA, actionB]);
    // The limit's easing, which the step's words leave out but the Machine follows.
    const easing = (step: ProfileStep) => (step.limiter && step.limiter.value > 0 ? `Over ${measure(step.limiter.range)} ${UNITS[step.pump === "pressure" ? "flow" : "pressure"]}` : null);
    const easingA = easing(stepA);
    const easingB = easing(stepB);
    if (easingA && easingB && easingA !== easingB) rows.push([`${name} eases its limit`, easingA, easingB]);
    const onA = stepMovesOn(stepA);
    const onB = stepMovesOn(stepB);
    if (onA !== onB) rows.push([`${name} moves on`, onA, onB]);
  }
  const factsB = profileFacts(b);
  profileFacts(a).forEach((fact, index) => {
    if (fact.text !== factsB[index]!.text) rows.push([fact.term, fact.text, factsB[index]!.text]);
  });
  if (a.beverage_type !== b.beverage_type) rows.push(["Kind of drink", a.beverage_type, b.beverage_type]);
  return rows;
}
