// The test durations manifest, vitest.durations.json, and the estimates read
// from it. vitest.config.ts deals the test files out to CI's shards by these
// estimates, and scripts/update-test-durations.mjs writes the manifest, so both
// estimate a file the manifest lacks the same way.

import fs from "node:fs";
import path from "node:path";

export const manifestName = "vitest.durations.json";

/** The manifest in `root`: each test file's typical CI duration in whole seconds, by its path. */
export function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, manifestName), "utf8"));
}

/** Writes `durations` as the manifest in `root`, its keys sorted. */
export function writeManifest(root, durations) {
  const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => compareText(a, b)));
  fs.writeFileSync(path.join(root, manifestName), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Each file's estimated duration in whole seconds: its manifest entry, or for a
 * file the manifest lacks, its size times the median seconds per byte of the
 * manifest's files in its Vitest project. When the manifest has none of that
 * project's files, the median is taken over every manifest entry whose file
 * is in `root`, so the estimate does not depend on which projects a run
 * includes. `files` are `{ path, project, size }`, the path relative to `root`
 * with POSIX separators, and every file of each project they include. Returns
 * them as `{ ...file, seconds }`, in the same order.
 */
export function estimateDurations(files, manifest, root) {
  const perByte = (group) => median(group.filter((file) => file.size > 0).map((file) => manifest[file.path] / file.size));
  const known = files.filter((file) => Object.hasOwn(manifest, file.path));
  const byProject = new Map();
  let overall;
  for (const file of files) {
    if (Object.hasOwn(manifest, file.path) || byProject.has(file.project)) continue;
    let rate = perByte(known.filter((other) => other.project === file.project));
    if (rate === undefined) {
      overall ??= perByte(Object.keys(manifest).flatMap((entry) => {
        const size = fs.statSync(path.join(root, entry), { throwIfNoEntry: false })?.size;
        return size === undefined ? [] : [{ path: entry, size }];
      }));
      if (overall === undefined) throw new Error(`${manifestName} has no entry for any test file to estimate from.`);
      rate = overall;
    }
    byProject.set(file.project, rate);
  }
  return files.map((file) => ({
    ...file,
    seconds: Object.hasOwn(manifest, file.path) ? manifest[file.path] : Math.round(file.size * byProject.get(file.project)),
  }));
}

/** Orders estimated files longest first, ties by path, then by project. */
export function longestFirst(a, b) {
  return b.seconds - a.seconds || compareText(a.path, b.path) || compareText(a.project ?? "", b.project ?? "");
}

/**
 * Deals estimated files out to `count` shards, longest first, each to the
 * shard with the smallest summed estimate so far. On a tie it goes to the
 * shard with the fewest files, so files estimated at 0 s are spread out
 * rather than all landing on one, and then to the lowest.
 */
export function dealOut(files, count) {
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const file of [...files].sort(longestFirst)) {
    const lightest = shards.reduce((least, shard) =>
      shard.seconds < least.seconds || (shard.seconds === least.seconds && shard.files.length < least.files.length) ? shard : least,
    );
    lightest.files.push(file);
    lightest.seconds += file.seconds;
  }
  return shards.map((shard) => shard.files);
}

// A per-file line of Vitest's default reporter, once the job, step and
// timestamp before it and its colour codes are gone:
// ` ✓  server  server/test/recipe-settings.test.ts (15 tests) 85439ms`.
// A failed file is marked × or ❯ instead, and the count can carry a suffix,
// as in `(3 tests | 1 skipped)`. Per-test lines name no test file.
const fileLine = /^\s*([✓↓×❯])\s+(?:\S+\s+)?(\S+\.test\.ts)\s+\(\d+ tests?(?: \|[^)]*)?\)\s+(\d+)ms\s*$/;
// Colour codes, as escape bytes or as the literal text `gh` prints for them (`^[[32m`).
const colours = /(?:\u001b|\^\[)\[[0-9;]*m/g;
// A sharded Vitest job, `vitest (i/n)`, and no other job that runs Vitest.
const shardJob = /^vitest \(\d+\/\d+\)$/;

/**
 * Each test file's duration in milliseconds from one run's log as
 * `gh run view --log` prints it, read only from the sharded Vitest jobs and
 * leaving out failed files.
 */
export function readRunLog(log) {
  const durations = new Map();
  for (const line of log.split("\n")) {
    const [job, , rest] = line.split("\t");
    if (rest === undefined || !shardJob.test(job)) continue;
    const match = fileLine.exec(rest.replace(/^\S+Z /, "").replace(colours, ""));
    if (match && match[1] !== "×" && match[1] !== "❯") durations.set(match[2], Number(match[3]));
  }
  return durations;
}

export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
