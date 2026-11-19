// The starting shapes a new Profile can begin from (#579, ADR-0032): a short
// set of profiles of plain steps, each with a title and a line on what it is
// for, which a Draft starts from as a copy to change freely. Held here, not
// only in the management interface's source, so an assistant can start a
// Draft from one through the MCP endpoint as the page does.
//
// Pure: no Node or browser API, as the plugin bundles this package.

import type { FlowStep, PressureStep, Profile } from "./profile.js";

/** A starting shape: its key, its title, what it is for, and its profile. */
export interface StartingShape {
  /** How the REST API and the MCP endpoint name it. */
  key: string;
  title: string;
  /** What it is for, in a line for a person. */
  description: string;
  profile: Profile;
}

const TEMPERATURE = 93;

/** A step whose pump controls flow, at once, with no exit, limit or weight but those given. */
function flow(name: string, target: number, seconds: number, more: Partial<FlowStep> = {}): FlowStep {
  return { name, pump: "flow", transition: "fast", exit: null, volume: 0, seconds, weight: null, temperature: TEMPERATURE, sensor: "coffee", flow: target, limiter: null, ...more };
}

/** A step whose pump controls pressure, at once, with no exit, limit or weight but those given. */
function pressure(name: string, target: number, seconds: number, more: Partial<PressureStep> = {}): PressureStep {
  return { name, pump: "pressure", transition: "fast", exit: null, volume: 0, seconds, weight: null, temperature: TEMPERATURE, sensor: "coffee", pressure: target, limiter: null, ...more };
}

/** A profile of the steps, stopping at `stopAt` g, its first `preinfusion` steps preinfusion. */
function shape(title: string, steps: Profile["steps"], stopAt: number, preinfusion: number): Profile {
  return {
    version: "2",
    title,
    notes: "",
    author: "",
    beverage_type: "espresso",
    steps,
    target_volume: 0,
    target_weight: stopAt,
    target_volume_count_start: preinfusion,
    tank_temperature: 0,
  };
}

/** The fill every shape but the blank one starts with: 4 ml/s until the puck pushes back, for at most 20 s. */
const fill = (over: number) => flow("Fill", 4, 20, { exit: { type: "pressure", condition: "over", value: over } });

/** The starting shapes, in the order New Profile offers them; built by a call marked pure, so the plugin's bundle, which uses none, leaves them out. */
export const STARTING_SHAPES: readonly StartingShape[] = /* @__PURE__ */ shapes();

function shapes(): readonly StartingShape[] {
  return [
    {
      key: "classic",
      title: "Classic 9 bar",
      description: "A short preinfusion, then a flat 9 bar. For a traditional espresso from a darker roast.",
      profile: shape("Classic 9 bar", [fill(4), pressure("Pour", 9, 60)], 36, 1),
    },
    {
      key: "lever",
      title: "Declining lever",
      description: "Rises to a peak, then eases off as a spring lever does. A softer, sweeter finish.",
      profile: shape("Declining lever", [fill(3), pressure("Peak", 9, 4), pressure("Decline", 6, 9, { transition: "smooth" }), pressure("Finish", 6, 30)], 36, 1),
    },
    {
      key: "steady-flow",
      title: "Steady flow",
      description: "Holds the flow and lets pressure follow the puck. Forgiving when the grind is a little off.",
      profile: shape("Steady flow", [fill(3), flow("Pour", 2, 60, { limiter: { value: 9, range: 0.6 } })], 36, 1),
    },
    {
      key: "blooming",
      title: "Blooming",
      description: "Wets the puck, pauses, then extracts. For light roasts that need time to open up.",
      profile: shape("Blooming", [fill(3), flow("Bloom", 0, 15), pressure("Extract", 8, 60, { limiter: { value: 3, range: 0.6 } })], 36, 2),
    },
    {
      key: "long",
      title: "Long and gentle",
      description: "Low pressure and a longer run. For a bigger, lighter cup.",
      profile: shape("Long and gentle", [fill(2), pressure("Pour", 6, 60)], 54, 1),
    },
    {
      key: "blank",
      title: "Blank",
      description: "Three plain steps, to shape yourself.",
      profile: shape("New Profile", [flow("Step 1", 4, 10), pressure("Step 2", 6, 10), pressure("Step 3", 6, 30)], 36, 1),
    },
  ];
}

/** The starting shape of the key, or undefined for none. */
export function startingShape(key: string): StartingShape | undefined {
  return STARTING_SHAPES.find((each) => each.key === key);
}
