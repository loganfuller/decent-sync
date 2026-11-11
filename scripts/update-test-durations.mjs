// Writes vitest.durations.json, the typical CI duration of each test file,
// which vitest.config.ts deals the files out to CI's shards by.
//
// Rebuilds it from the logs of the last 10 (or --runs n) successful CI runs
// of pushes to main, through `gh`: each file's median over the runs, from the
// sharded Vitest jobs alone, leaving out runs where it failed. GitHub keeps
// logs for 90 days. A file with no CI data yet gets an estimate from its
// size, as vitest.config.ts estimates a file the manifest lacks, and a file
// that is gone is dropped.
//
// Each release rebuilds it (docs/DEVELOPMENT.md), once CI has passed on main
// for the last change the release holds, so that change's test files have
// timings.
//
// Usage: node scripts/update-test-durations.mjs [--runs n]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateDurations, manifestName, median, readRunLog, writeManifest } from "./test-durations.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (command, ...args) =>
  execFileSync(command, args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });

/** The test files of every project in vitest.config.ts, as `{ path, project, size }`. */
function testFiles() {
  const listed = JSON.parse(run(npx, "vitest", "list", "--filesOnly", "--json"));
  return listed.map(({ file, projectName }) => ({
    path: path.relative(repo, file).split(path.sep).join("/"),
    project: projectName,
    size: fs.statSync(file).size,
  }));
}

const [flag, value] = process.argv.slice(2);
const count = flag === "--runs" ? Number(value) : 10;
if ((flag !== undefined && flag !== "--runs") || !Number.isInteger(count) || count < 1) {
  console.error("Usage: node scripts/update-test-durations.mjs [--runs n]");
  process.exit(1);
}

const files = testFiles();
const runs = JSON.parse(
  run("gh", "run", "list", "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--status", "success",
    "--limit", String(count), "--json", "databaseId,headSha"),
);
if (runs.length < count) console.warn(`Only ${runs.length} successful main runs were found.`);

/** Each file's durations in milliseconds, one per run that passed it. */
const samples = new Map();
for (const { databaseId, headSha } of runs) {
  const durations = readRunLog(run("gh", "run", "view", String(databaseId), "--log"));
  console.log(`Run ${databaseId} (${headSha.slice(0, 7)}): ${durations.size} test files`);
  for (const [file, ms] of durations) samples.set(file, [...(samples.get(file) ?? []), ms]);
}

const measured = Object.fromEntries(
  files.filter((file) => samples.has(file.path)).map((file) => [file.path, Math.round(median(samples.get(file.path)) / 1000)]),
);
const estimated = estimateDurations(files, measured, repo);
writeManifest(repo, Object.fromEntries(estimated.map((file) => [file.path, file.seconds])));
for (const file of estimated.filter((file) => !Object.hasOwn(measured, file.path))) {
  console.log(`No CI data for ${file.path}: ${file.seconds} s, estimated from its size`);
}
console.log(`Wrote ${manifestName} for ${files.length} test files from ${runs.length} runs.`);
