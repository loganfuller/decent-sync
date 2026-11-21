// The simulation's scorecard (#599): how close the simulation of a Profile
// (protocol/src/simulation.ts) comes to recorded Shots. Each Shot's own steps
// run on its own puck, ended as it ended (`shotFit`), and the run is held to
// the Shot: its duration within 5% or 1 s, whichever is more, and its peak
// pressure within 0.5 bar, the margin docs/LIBRARY.md states. Where Shots
// are marked as one set (the same coffee, grind and dose), each Shot's puck
// is also run with each other Shot's steps and held to that Shot.
//
// It reads a folder of Shots of either shape: as the REST API gives them,
// `{ shot, measurements }` from `GET /api/shots/:id` and
// `/api/shots/:id/measurements` (what pull.mjs saves), or scrubbed corpus
// Shots (scrub.mjs, corpus/README.md). score.mjs prints it.

import fs from "node:fs";
import path from "node:path";
import {
  MAX_PROFILE_STEPS,
  fitToShot,
  lastRecordedWeight,
  runFigures,
  shotFigures,
  shotFit,
  shotFitStop,
  shotPuck,
  simulateProfile,
  simulationShotOf,
  stepSpans,
  stepTarget,
  underManualControl,
} from "@decent-sync/protocol";

/** The margin a run is held to: its duration within MARGIN_SHARE of the Shot's or MARGIN_SECONDS, whichever is more, and its peak pressure within MARGIN_BAR. */
export const MARGIN_SHARE = 0.05;
export const MARGIN_SECONDS = 1;
export const MARGIN_BAR = 0.5;
/** How close each step's end must come to the Shot's, s, for its steps to count as ending alike. */
export const STEP_SECONDS = 1;

/**
 * A pour that met no coffee, as a flush through an empty portafilter or a
 * Shot stopped at once: its pressure never reached NO_COFFEE_BAR and its
 * scale never read NO_COFFEE_GRAMS. On the 944 recorded Shots measured for
 * #599, the 27 such pours weighed under 2 g; the next lowest weight of a
 * Shot under 1.5 bar was 32 g.
 */
export const NO_COFFEE_BAR = 1.5;
export const NO_COFFEE_GRAMS = 5;

/** Whether a Shot's samples after Preheat show a pour that met no coffee (NO_COFFEE_BAR, NO_COFFEE_GRAMS). */
export function metNoCoffee(samples) {
  const shot = samples.filter((sample) => sample.shade === null);
  return shot.every((sample) => (sample.values.pressure ?? 0) < NO_COFFEE_BAR && (sample.values.weight ?? 0) < NO_COFFEE_GRAMS);
}

/** The kinds of Profile the scorecard reports apart (`profileKind`). */
export const PROFILE_KINDS = ["pressure", "declining", "low pressure", "flow", "fast flow", "bloom"];

/** The made-up instant a corpus Shot's samples are timed from. */
const CORPUS_EPOCH_MS = Date.parse("2000-01-01T00:00:00Z");

// Reading Shots --------------------------------------------------------------------

/**
 * Every Shot in a folder, by file name: each `.json` file holding one Shot,
 * `{ shot, measurements }` as the REST API gives them, or a corpus Shot.
 * A REST Shot counts as tea where its profile's title says tea, and is in
 * the set its file's `set` names, if any.
 */
export function readShots(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => shotEntry(path.basename(file, ".json"), JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))));
}

/** A Shot as the scorecard reads it, from either shape. */
export function shotEntry(name, file) {
  if (file && typeof file === "object" && "shot" in file) {
    const record = file.shot?.record ?? null;
    const title = file.shot?.profileTitle ?? record?.workflow?.profile?.title ?? "";
    return { name, record, measurements: file.measurements ?? null, tea: isTea(title), set: typeof file.set === "string" ? file.set : null };
  }
  return { name, ...corpusRecord(file), tea: file.tea === true, set: file.set ?? null };
}

/** Whether a profile's title names tea, as Decaid's tea portafilter profiles do. */
export function isTea(title) {
  return /\btea\b/i.test(String(title ?? ""));
}

/**
 * A corpus Shot as a record and measurements in Decaid's shape, which
 * `simulationShotOf` reads: its samples timed from CORPUS_EPOCH_MS, and its
 * profile with the title, author and notes it was scrubbed of left empty.
 */
export function corpusRecord(shot) {
  const samples = shot.samples;
  const measurements = samples.seconds.map((seconds, n) => ({
    machine: {
      timestamp: new Date(CORPUS_EPOCH_MS + Math.round(seconds * 1000)).toISOString().slice(0, 23),
      ...(samples.frame[n] === null ? {} : { profileFrame: samples.frame[n] }),
      ...(samples.pressure[n] === null ? {} : { pressure: samples.pressure[n] }),
      ...(samples.flow[n] === null ? {} : { flow: samples.flow[n] }),
      ...(samples.targetPressure[n] === null ? {} : { targetPressure: samples.targetPressure[n] }),
      ...(samples.targetFlow[n] === null ? {} : { targetFlow: samples.targetFlow[n] }),
    },
    ...(samples.weight[n] === null ? {} : { scale: { weight: samples.weight[n] } }),
  }));
  return {
    record: {
      workflow: { profile: { title: "", author: "", notes: "", version: null, ...shot.profile }, context: { targetDoseWeight: shot.dose }, machine: { model: shot.model } },
      annotations: { actualDoseWeight: shot.dose },
      stopReason: shot.stopReason,
    },
    measurements,
  };
}

// Kinds of Profile ------------------------------------------------------------------

/**
 * The kind of a Shot's Profile, from its steps and the step the Shot spent
 * longest in, its main step:
 *
 * - bloom: a step after the first asks for no flow, or 0.5 bar or less, for 10 s or more;
 * - fast flow: its main step's pump controls flow, above 4 ml/s, as a turbo or filter-like Profile;
 * - flow: its main step's pump controls flow, at 4 ml/s or less;
 * - declining: its main step asks at least 1 bar less than an earlier step did, as a lever Profile;
 * - low pressure: its main step asks less than 7 bar;
 * - pressure: its main step asks 7 bar or more.
 */
export function profileKind(profile, samples) {
  const steps = profile.steps;
  if (steps.some((step, n) => n > 0 && step.seconds >= 10 && stepTarget(step) <= (step.pump === "pressure" ? 0.5 : 0))) return "bloom";
  const spans = stepSpans(samples.filter((sample) => sample.shade === null)).filter((span) => steps[span.frame]);
  const longest = spans.reduce((best, span) => (!best || span.until - span.from > best.until - best.from ? span : best), null);
  const index = longest ? longest.frame : steps.reduce((best, step, n) => (step.seconds > steps[best].seconds ? n : best), 0);
  const main = steps[index];
  if (main.pump === "flow") return main.flow > 4 ? "fast flow" : "flow";
  if (steps.slice(0, index).some((step) => step.pump === "pressure" && step.pressure >= main.pressure + 1)) return "declining";
  return main.pressure < 7 ? "low pressure" : "pressure";
}

// Scoring one Shot ------------------------------------------------------------------

/**
 * One Shot scored: its model (null where its record names none), its kind
 * of Profile (null where its profile can't be read or has no steps),
 * whether it is tea, met no coffee (`metNoCoffee`) or ran under manual
 * control, and, where it has a fit, how far the run lands from it. `noFit`
 * says why it has none.
 */
export function scoreShot(entry) {
  const shot = simulationShotOf(entry.record, entry.measurements);
  const scored = { name: entry.name, model: shot.model, tea: entry.tea, set: entry.set, kind: null, noCoffee: metNoCoffee(shot.samples), manual: false, noFit: null, errors: null, within: false, stepsAlike: false, curves: null };
  if (!shot.profile || shot.profile.steps.length === 0) return { ...scored, noFit: "its profile can't be read" };
  scored.kind = profileKind(shot.profile, shot.samples);
  scored.manual = shot.model !== null && underManualControl(shot.samples, shot.profile, shot.model);
  const puck = shotPuck(shot.samples, shot.dose);
  if (!puck) return { ...scored, noFit: "no sample shows its puck" };
  if (!shotFit(shot, puck)) return { ...scored, noFit: noFitReason(shot, scored.manual) };
  const stop = shotFitStop(shot.samples, shot.stopReason, shot.model, shot.profile);
  const { run, fit } = fitToShot({ samples: shot.samples, profile: shot.profile, puck, stopAt: stop.stopAt, model: shot.model });
  const errors = figureErrors(fit.shot, fit.simulated);
  return { ...scored, errors, within: withinMargin(fit.shot, fit.simulated), stepsAlike: stepsAlike(fit.shot, fit.simulated), curves: curveDistances(shot.samples, run) };
}

function noFitReason(shot, manual) {
  if (shot.profile.steps.length > MAX_PROFILE_STEPS) return "more steps than a machine takes";
  if (shot.model === null) return "its record names no model";
  if (manual) return "manual control";
  return "no run can end as it did";
}

/** How far a run's figures land from a Shot's: duration in s and as a share of the Shot's, time to first drip in s (null where either has none), peak pressure in bar. */
export function figureErrors(real, simulated) {
  const duration = simulated.duration - real.duration;
  return {
    duration,
    durationShare: real.duration > 0 ? duration / real.duration : null,
    timeToFirstDrip: real.timeToFirstDrip === null || simulated.timeToFirstDrip === null ? null : simulated.timeToFirstDrip - real.timeToFirstDrip,
    peakPressure: simulated.peakPressure - real.peakPressure,
  };
}

/** Whether a run lands within the margin of a Shot: its duration within MARGIN_SHARE or MARGIN_SECONDS, and its peak pressure within MARGIN_BAR. */
export function withinMargin(real, simulated) {
  return Math.abs(simulated.duration - real.duration) <= Math.max(MARGIN_SECONDS, MARGIN_SHARE * real.duration) && Math.abs(simulated.peakPressure - real.peakPressure) <= MARGIN_BAR;
}

/** Whether a run came to the steps a Shot came to, each ending within STEP_SECONDS of the Shot's. */
export function stepsAlike(real, simulated) {
  return real.steps.length === simulated.steps.length && real.steps.every((step, n) => simulated.steps[n].index === step.index && Math.abs(simulated.steps[n].end - step.end) <= STEP_SECONDS);
}

/**
 * How far a run's curves are from a Shot's: the root mean square of the
 * difference in pressure (bar), flow (ml/s) and weight (g), at each of the
 * Shot's samples after Preheat up to the end of the shorter of the two;
 * weight null where the Shot weighed nothing.
 */
export function curveDistances(samples, run) {
  const shot = samples.filter((sample) => sample.shade === null);
  const times = run.samples.map((sample) => sample.seconds);
  const until = Math.min(shot.at(-1)?.seconds ?? 0, times.at(-1) ?? 0);
  const sums = { pressure: [0, 0], flow: [0, 0], weight: [0, 0] };
  for (const sample of shot) {
    if (sample.seconds > until) break;
    for (const curve of ["pressure", "flow", "weight"]) {
      const real = sample.values[curve];
      if (real === null) continue;
      const simulated = interpolate(times, run.samples.map((s) => s.values[curve] ?? 0), sample.seconds);
      sums[curve][0] += (simulated - real) ** 2;
      sums[curve][1]++;
    }
  }
  const rms = ([sum, count]) => (count > 0 ? Math.sqrt(sum / count) : null);
  return { pressure: rms(sums.pressure), flow: rms(sums.flow), weight: rms(sums.weight) };
}

function interpolate(xs, ys, x) {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let low = 0;
  let high = xs.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (xs[middle] <= x) low = middle;
    else high = middle;
  }
  return ys[low] + ((ys[high] - ys[low]) * (x - xs[low])) / (xs[high] - xs[low] || 1);
}

// One Shot's puck predicting another ----------------------------------------------

/**
 * For each set, each Shot's puck run with each other Shot's own steps and
 * dose, ended as that Shot ended, and held to it: `same` where the two ran
 * the same steps (temperatures and names aside), `different` otherwise.
 * Shots of no model, that met no coffee, with no puck, or with no fit take
 * no part.
 */
export function setPairs(entries) {
  const sets = new Map();
  for (const entry of entries) {
    if (entry.set === null || entry.tea) continue;
    const shot = simulationShotOf(entry.record, entry.measurements);
    if (!shot.profile || shot.model === null || metNoCoffee(shot.samples)) continue;
    const puck = shotPuck(shot.samples, shot.dose);
    if (!puck || !shotFit(shot, puck)) continue;
    const stop = shotFitStop(shot.samples, shot.stopReason, shot.model, shot.profile);
    const steps = JSON.stringify(shot.profile.steps.map(({ name: _name, temperature: _temperature, sensor: _sensor, ...step }) => step));
    if (!sets.has(entry.set)) sets.set(entry.set, []);
    sets.get(entry.set).push({ name: entry.name, shot, puck, stop, steps });
  }
  const pairs = [];
  for (const [set, shots] of sets) {
    for (const from of shots) {
      for (const to of shots) {
        if (from === to) continue;
        const weighed = lastRecordedWeight(to.shot.samples) !== null;
        const profile = weighed ? to.shot.profile : { ...to.shot.profile, steps: to.shot.profile.steps.map((step) => ({ ...step, weight: null })) };
        const run = simulateProfile({ profile, puck: from.puck, dose: to.puck.dose, stopAt: to.stop.stopAt, stopOn: "reached", model: to.shot.model });
        const real = shotFigures(to.shot.samples);
        const simulated = runFigures(run);
        pairs.push({ set, from: from.name, to: to.name, model: to.shot.model, same: from.steps === to.steps, errors: figureErrors(real, simulated), within: withinMargin(real, simulated) });
      }
    }
  }
  return pairs;
}

// The scorecard ---------------------------------------------------------------------

/**
 * The scorecard of a folder's Shots: for each model, all its coffee Shots and
 * each kind of Profile apart; tea, Shots with a profile that can't be read,
 * naming no model, that met no coffee or under manual control apart,
 * counting toward no share, each under the first of these it is; and the
 * set pairs. A Shot that has no fit for any other reason counts as outside
 * the margin.
 */
export function scorecard(entries) {
  const shots = entries.map(scoreShot);
  const apart = (shot) => (shot.tea ? "tea" : shot.kind === null ? "unreadable" : shot.model === null ? "noModel" : shot.noCoffee ? "noCoffee" : shot.manual ? "manual" : null);
  const coffee = shots.filter((shot) => apart(shot) === null);
  const models = {};
  for (const model of ["DE1", "Bengle"]) {
    const ofModel = coffee.filter((shot) => shot.model === model);
    if (ofModel.length === 0) continue;
    models[model] = { all: summary(ofModel), kinds: Object.fromEntries(PROFILE_KINDS.flatMap((kind) => {
      const ofKind = ofModel.filter((shot) => shot.kind === kind);
      return ofKind.length > 0 ? [[kind, summary(ofKind)]] : [];
    })) };
  }
  const pairs = setPairs(entries);
  return {
    shots,
    models,
    tea: summary(shots.filter((shot) => shot.tea)),
    unreadable: shots.filter((shot) => apart(shot) === "unreadable").length,
    noModel: shots.filter((shot) => apart(shot) === "noModel").length,
    noCoffee: shots.filter((shot) => apart(shot) === "noCoffee").length,
    manual: shots.filter((shot) => apart(shot) === "manual").length,
    sets: { same: pairSummary(pairs.filter((pair) => pair.same)), different: pairSummary(pairs.filter((pair) => !pair.same)) },
  };
}

function summary(shots) {
  const fitted = shots.filter((shot) => shot.errors !== null);
  const absolute = (pick) => fitted.map(pick).filter((value) => value !== null && value !== undefined).map(Math.abs);
  return {
    shots: shots.length,
    fitted: fitted.length,
    within: shots.filter((shot) => shot.within).length,
    share: shots.length > 0 ? shots.filter((shot) => shot.within).length / shots.length : null,
    duration: spread(absolute((shot) => shot.errors.durationShare)),
    timeToFirstDrip: spread(absolute((shot) => shot.errors.timeToFirstDrip)),
    peakPressure: spread(absolute((shot) => shot.errors.peakPressure)),
    stepsAlike: fitted.length > 0 ? fitted.filter((shot) => shot.stepsAlike).length / fitted.length : null,
    curves: {
      pressure: median(fitted.map((shot) => shot.curves.pressure).filter((value) => value !== null)),
      flow: median(fitted.map((shot) => shot.curves.flow).filter((value) => value !== null)),
      weight: median(fitted.map((shot) => shot.curves.weight).filter((value) => value !== null)),
    },
  };
}

function pairSummary(pairs) {
  return { pairs: pairs.length, within: pairs.filter((pair) => pair.within).length, duration: spread(pairs.map((pair) => Math.abs(pair.errors.durationShare ?? 0))) };
}

/** The median and the worst tenth's lower bound (the 90th percentile, nearest rank) of some values; nulls where there are none. */
export function spread(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, worstTenth: null };
  return { median: median(sorted), worstTenth: sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)] };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Printing --------------------------------------------------------------------------

/** The scorecard as text: one table of models and kinds, then what counts toward no share, then the set pairs. */
export function formatScorecard(card) {
  const lines = [];
  const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
  const fixed = (value, places) => (value === null ? "-" : value.toFixed(places));
  const header = ["", "Shots", "Within", "Share", "Duration", "p90", "First drip s", "p90", "Peak bar", "p90", "Steps 1 s", "RMS bar", "RMS ml/s", "RMS g"];
  const rows = [header];
  const row = (label, s) => [
    label,
    String(s.shots),
    String(s.within),
    percent(s.share),
    percent(s.duration.median),
    percent(s.duration.worstTenth),
    fixed(s.timeToFirstDrip.median, 1),
    fixed(s.timeToFirstDrip.worstTenth, 1),
    fixed(s.peakPressure.median, 2),
    fixed(s.peakPressure.worstTenth, 2),
    percent(s.stepsAlike),
    fixed(s.curves.pressure, 2),
    fixed(s.curves.flow, 2),
    fixed(s.curves.weight, 1),
  ];
  for (const [model, { all, kinds }] of Object.entries(card.models)) {
    rows.push(row(model, all));
    for (const [kind, s] of Object.entries(kinds)) rows.push(row(`  ${kind}`, s));
  }
  if (card.tea.shots > 0) rows.push(row("Tea (no share)", card.tea));
  const widths = header.map((_, n) => Math.max(...rows.map((r) => r[n].length)));
  for (const r of rows) lines.push(r.map((cell, n) => (n === 0 ? cell.padEnd(widths[n]) : cell.padStart(widths[n]))).join("  "));
  lines.push("");
  lines.push(`Within: duration within ${MARGIN_SHARE * 100}% or ${MARGIN_SECONDS} s and peak pressure within ${MARGIN_BAR} bar; a Shot with no fit counts as outside. Errors are medians and 90th percentiles of fitted Shots; Steps 1 s: share of fitted Shots whose every step ended within ${STEP_SECONDS} s.`);
  lines.push(`Counted toward no share: ${card.unreadable} with a profile that can't be read, ${card.noModel} naming no model, ${card.noCoffee} that met no coffee (under ${NO_COFFEE_BAR} bar and ${NO_COFFEE_GRAMS} g throughout), ${card.manual} under manual control.`);
  for (const [label, s] of [["same steps", card.sets.same], ["different steps", card.sets.different]]) {
    if (s.pairs === 0) continue;
    lines.push(`One Shot's puck on another of its set, ${label}: ${s.pairs} pairs, ${s.within} within (${percent(s.within / s.pairs)}), duration error median ${percent(s.duration.median)}, p90 ${percent(s.duration.worstTenth)}.`);
  }
  return lines.join("\n");
}
