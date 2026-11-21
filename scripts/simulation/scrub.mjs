// Turns Shots pulled from a Decent Sync instance (pull.mjs) into corpus
// Shots (#599): each holding only what the simulation reads of it, its
// profile's steps, its samples timed from the start of its profile, its
// dose, yield, stop reason and Machine model, and nothing that names a
// person, a Location, a Machine, a Bean, a Grinder, a Basket or a Profile.
// corpus/README.md says what a corpus Shot holds and how to add some.
//
// Usage: node scripts/simulation/scrub.mjs <pulled folder> [<corpus folder>] [--ids <file>] [--set | --sets] [--no-sets-for <Machine name>]...
//   <pulled folder>   Shots as pull.mjs saves them, `{ shot, measurements }`, one per file.
//   <corpus folder>   where to write them, corpus/shots by default; each is named for its model and numbered on from the last there.
//   --ids <file>      only the Shots whose ids the file lists, one per line.
//   --set             all of them as one set, as the Shots of a designed session on one coffee, grind and dose.
//   --sets            sets inferred: Shots of one Machine, coffee, grinder, grind setting, dose and Basket, each pulled within
//                     SET_HOURS of another of them, two or more to a set.
//   --no-sets-for     a Machine whose Shots join no inferred set, as one whose recorded coffee is not kept up to date.
// It writes only into the corpus folder. Read every Shot it writes before committing it: the repo is public.

import fs from "node:fs";
import path from "node:path";
import { profileOf, shotSamples, simulationShotOf } from "@decent-sync/protocol";
import { isTea } from "./scorecard.mjs";

/** How far apart two Shots of a set may be pulled, h, where sets are inferred. */
export const SET_HOURS = 6;

/** The Machine models Decaid names (`DecentMachineModel`), the only text a corpus Shot's `model` may hold. */
export const DECAID_MODELS = ["Unknown", "DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL", "Bengle"];
/** What Decaid records as stopping a Shot (`ShotDecisionReason`). */
export const STOP_REASONS = ["noScale", "targetWeight", "targetVolume", "apiStop", "appStop", "machineEnded", "profileAdvance", "profileSkip", "error", "disconnected", "stoppingBackstop"];

const SAMPLE_COLUMNS = ["seconds", "frame", "pressure", "flow", "targetPressure", "targetFlow", "weight"];
const PROFILE_KEYS = ["beverage_type", "steps", "target_volume", "target_weight", "target_volume_count_start", "tank_temperature"];
const STEP_KEYS = ["name", "pump", "transition", "exit", "volume", "seconds", "weight", "temperature", "sensor", "pressure", "flow", "limiter"];

const round = (value, places) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

/**
 * A pulled Shot as a corpus Shot, or a string saying why it can't be one:
 * a profile Decaid would not read, or a record naming no Machine model.
 * Its samples are its own after Preheat, timed from the first of them, as
 * the simulation reads them (`shotSamples`), with pressures, flows and
 * targets to three places and weights to two.
 */
export function scrubShot(file, set = null) {
  const record = file.shot?.record;
  const raw = record?.workflow?.profile;
  const profile = profileOf(raw);
  if (!profile) return "its profile can't be read";
  const model = record.workflow?.machine?.model;
  if (!DECAID_MODELS.includes(model)) return "its record names no Machine model";
  const shot = simulationShotOf(record, file.measurements);
  const samples = shotSamples(file.measurements, profile).filter((sample) => sample.shade === null);
  const columns = Object.fromEntries(SAMPLE_COLUMNS.map((column) => [column, []]));
  for (const sample of samples) {
    columns.seconds.push(round(sample.seconds, 3));
    columns.frame.push(sample.step ? sample.step.frame : null);
    columns.pressure.push(round(sample.values.pressure, 3));
    columns.flow.push(round(sample.values.flow, 3));
    columns.targetPressure.push(round(sample.targets.pressure, 3));
    columns.targetFlow.push(round(sample.targets.flow, 3));
    columns.weight.push(round(sample.values.weight, 2));
  }
  const yielded = record.annotations?.actualYield ?? file.shot.actualYield ?? null;
  return {
    model,
    dose: shot.dose,
    yield: typeof yielded === "number" ? round(yielded, 1) : null,
    stopReason: STOP_REASONS.includes(shot.stopReason) ? shot.stopReason : null,
    ...(isTea(file.shot.profileTitle ?? raw?.title) ? { tea: true } : {}),
    ...(set ? { set } : {}),
    profile: {
      beverage_type: profile.beverage_type,
      steps: profile.steps.map((step, n) => ({ ...step, name: String(n + 1) })),
      target_volume: profile.target_volume,
      target_weight: profile.target_weight,
      target_volume_count_start: profile.target_volume_count_start,
      tank_temperature: profile.tank_temperature,
    },
    samples: columns,
  };
}

/**
 * Why an object is not a corpus Shot, as a list of problems, empty where it
 * is one: any field outside the scrubbed shape, and any text but a step's
 * number, a set's label and the names Decaid gives a model, a stop reason,
 * a beverage type, a pump, a transition, a sensor and an exit.
 */
export function corpusProblems(shot) {
  const problems = [];
  const only = (object, keys, where) => {
    if (typeof object !== "object" || object === null || Array.isArray(object)) return problems.push(`${where} must be an object`), false;
    for (const key of Object.keys(object)) if (!keys.includes(key)) problems.push(`${where}.${key} is outside the scrubbed shape`);
    return true;
  };
  const number = (value, where, nullable = false) => (typeof value === "number" && Number.isFinite(value)) || (nullable && value === null) || problems.push(`${where} must be a number${nullable ? " or null" : ""}`);
  const oneOf = (value, values, where, nullable = false) => values.includes(value) || (nullable && value === null) || problems.push(`${where} must be one of ${values.join(", ")}`);
  if (!only(shot, ["model", "dose", "yield", "stopReason", "tea", "set", "profile", "samples"], "shot")) return problems;
  oneOf(shot.model, DECAID_MODELS, "model");
  number(shot.dose, "dose", true);
  number(shot.yield, "yield", true);
  oneOf(shot.stopReason, STOP_REASONS, "stopReason", true);
  if ("tea" in shot && shot.tea !== true) problems.push("tea must be true where present");
  if ("set" in shot && !(typeof shot.set === "string" && /^s\d+$/.test(shot.set))) problems.push("set must be s and a number");
  if (only(shot.profile, PROFILE_KEYS, "profile")) {
    oneOf(shot.profile.beverage_type, ["espresso", "pourover", "cleaning", "calibrate", "manual"], "profile.beverage_type");
    for (const key of ["target_volume", "target_weight"]) number(shot.profile[key], `profile.${key}`, true);
    for (const key of ["target_volume_count_start", "tank_temperature"]) number(shot.profile[key], `profile.${key}`);
    if (!Array.isArray(shot.profile.steps)) problems.push("profile.steps must be a list");
    else
      shot.profile.steps.forEach((step, n) => {
        const where = `profile.steps[${n}]`;
        if (!only(step, STEP_KEYS, where)) return;
        if (step.name !== String(n + 1)) problems.push(`${where}.name must be its number, ${n + 1}`);
        oneOf(step.pump, ["pressure", "flow"], `${where}.pump`);
        oneOf(step.transition, ["fast", "smooth"], `${where}.transition`);
        oneOf(step.sensor, ["coffee", "water"], `${where}.sensor`);
        for (const key of ["volume", "seconds", "temperature"]) number(step[key], `${where}.${key}`);
        number(step.weight, `${where}.weight`, true);
        number(step[step.pump], `${where}.${step.pump}`);
        const idle = step.pump === "pressure" ? "flow" : step.pump === "flow" ? "pressure" : null;
        if (idle && idle in step) problems.push(`${where}.${idle} is outside the scrubbed shape for a ${step.pump} step`);
        if (step.exit !== null && only(step.exit, ["type", "condition", "value"], `${where}.exit`)) {
          oneOf(step.exit.type, ["pressure", "flow"], `${where}.exit.type`);
          oneOf(step.exit.condition, ["over", "under"], `${where}.exit.condition`);
          number(step.exit.value, `${where}.exit.value`);
        }
        if (step.limiter !== null && only(step.limiter, ["value", "range"], `${where}.limiter`)) {
          number(step.limiter.value, `${where}.limiter.value`);
          number(step.limiter.range, `${where}.limiter.range`);
        }
      });
  }
  if (only(shot.samples, SAMPLE_COLUMNS, "samples")) {
    const length = shot.samples.seconds?.length;
    for (const column of SAMPLE_COLUMNS) {
      const values = shot.samples[column];
      if (!Array.isArray(values) || values.length !== length) problems.push(`samples.${column} must be a list as long as samples.seconds`);
      else if (!values.every((value) => value === null || (typeof value === "number" && Number.isFinite(value)))) problems.push(`samples.${column} must hold only numbers and nulls`);
    }
  }
  return problems;
}

/**
 * Sets inferred among pulled Shots, by id: Shots of one Machine, coffee,
 * grinder, grind setting, dose and Basket, each pulled within SET_HOURS of
 * the one before it, two or more to a set; none for a Machine named in
 * `excluded`.
 */
export function inferSets(files, excluded = []) {
  const groups = new Map();
  for (const { shot } of files) {
    if (excluded.includes(shot.machine?.name)) continue;
    const context = shot.record?.workflow?.context ?? {};
    const coffee = shot.beanBatchId ?? `${context.coffeeRoaster ?? ""}/${context.coffeeName ?? ""}`;
    // A Pending Machine's Shot names it by its pendingMachine, with no machineId.
    const machine = shot.machineId ? `machine ${shot.machineId}` : shot.pendingMachine?.id ? `pending ${shot.pendingMachine.id}` : null;
    if (!machine || coffee === "/" || context.grinderSetting === undefined) continue;
    const key = [machine, coffee, shot.grinderId ?? context.grinderModel, context.grinderSetting, simulationShotOf(shot.record, null).dose, shot.basketId ?? context.extras?.basketName ?? null].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shot);
  }
  const sets = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.pulledAt.localeCompare(b.pulledAt));
    let run = [group[0]];
    for (const shot of group.slice(1)) {
      if (Date.parse(shot.pulledAt) - Date.parse(run.at(-1).pulledAt) <= SET_HOURS * 3600e3) run.push(shot);
      else (run.length > 1 && sets.push(run.map((s) => s.id)), (run = [shot]));
    }
    if (run.length > 1) sets.push(run.map((s) => s.id));
  }
  return sets;
}

function main(args) {
  const flag = (name) => args.includes(name);
  const value = (name) => args.flatMap((arg, n) => (arg === name ? [args[n + 1]] : []));
  const positional = args.filter((arg, n) => !arg.startsWith("--") && !["--ids", "--no-sets-for"].includes(args[n - 1]));
  const [from, into = path.join(import.meta.dirname, "corpus", "shots")] = positional;
  if (!from) throw new Error("Usage: node scripts/simulation/scrub.mjs <pulled folder> [<corpus folder>] [--ids <file>] [--set | --sets] [--no-sets-for <Machine name>]...");
  const ids = value("--ids").length > 0 ? new Set(fs.readFileSync(value("--ids")[0], "utf8").split(/\s+/).filter(Boolean)) : null;
  const files = fs
    .readdirSync(from)
    .filter((file) => file.endsWith(".json") && file !== "list.json")
    .map((file) => JSON.parse(fs.readFileSync(path.join(from, file), "utf8")))
    .filter((file) => file.shot && (!ids || ids.has(file.shot.id)))
    .sort((a, b) => a.shot.pulledAt.localeCompare(b.shot.pulledAt));
  fs.mkdirSync(into, { recursive: true });
  const existing = fs.readdirSync(into).filter((file) => file.endsWith(".json"));
  let setNumber = Math.max(0, ...existing.map((file) => Number(JSON.parse(fs.readFileSync(path.join(into, file), "utf8")).set?.slice(1) ?? 0)));
  const setOf = new Map();
  if (flag("--set")) {
    setNumber++;
    for (const file of files) setOf.set(file.shot.id, `s${setNumber}`);
  } else if (flag("--sets")) {
    for (const set of inferSets(files, value("--no-sets-for"))) {
      setNumber++;
      for (const id of set) setOf.set(id, `s${setNumber}`);
    }
  }
  const next = new Map();
  let written = 0;
  for (const file of files) {
    const scrubbed = scrubShot(file, setOf.get(file.shot.id) ?? null);
    if (typeof scrubbed === "string") {
      console.log(`left out ${file.shot.id}: ${scrubbed}`);
      continue;
    }
    const prefix = scrubbed.model.toLowerCase();
    if (!next.has(prefix)) next.set(prefix, Math.max(0, ...existing.filter((name) => name.startsWith(`${prefix}-`)).map((name) => Number(name.slice(prefix.length + 1, -5)))) + 1);
    const name = `${prefix}-${String(next.get(prefix)).padStart(3, "0")}.json`;
    next.set(prefix, next.get(prefix) + 1);
    fs.writeFileSync(path.join(into, name), `${JSON.stringify(scrubbed)}\n`);
    written++;
  }
  console.log(`wrote ${written} corpus Shots to ${into}${setOf.size > 0 ? `, ${new Set(setOf.values()).size} sets` : ""}`);
}

if (import.meta.main) main(process.argv.slice(2));
