// Builds the latest release, the newest vX.Y.Z tag on main, which Seam 1 tests
// run beside the change (server/test/support/latest-release.mjs, ADR-0025).
// It fetches main and the tags from origin, extracts the tag's tree into a
// directory of its own outside the checkout, installs its dependencies with
// `npm ci`, and builds its protocol, management interface and server, leaving
// its plugin as committed at the tag. A tag already built is left as it is,
// so each tag is built once on a machine, for every checkout; the builds of
// earlier tags are removed once a later one is built. It builds in a
// directory of its own and moves the build into place only once finished, so
// a build cut short is never taken for one, and runs in other checkouts at
// the same time do no harm. It never touches this checkout's builds, and
// connects to no database.
//
// Usage: node scripts/build-latest-release.mjs (npm run build:latest-release)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoDir } from "../server/test/support/build-table.mjs";
import { RELEASE_TAG, latestReleaseTag, releaseDir, releasesDir } from "../server/test/support/latest-release.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/** The workspaces built; the plugin is used as committed at the tag. */
const BUILT = ["protocol", "web", "server"];

const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  git("fetch", "--quiet", "--tags", "origin", "main");
} catch (error) {
  console.warn(`Could not fetch main and the tags from origin, so using those this clone holds: ${String(error.stderr ?? error.message).trim()}`);
}
// Which tags are on main can't be told from a shallow history.
if (git("rev-parse", "--is-shallow-repository") === "true") {
  fail("This clone's history is shallow: fetch all of it (`git fetch --unshallow origin`; in CI, actions/checkout with `fetch-depth: 0`).");
}
let tag;
try {
  tag = latestReleaseTag();
} catch (error) {
  fail(error.message);
}
const dir = releaseDir(tag);
if (fs.existsSync(dir)) {
  console.log(`The latest release, ${tag}, is already built in ${dir}.`);
  process.exit(0);
}

const root = releasesDir();
fs.mkdirSync(root, { recursive: true });
removeAbandonedBuilds();
const building = path.join(root, `.building-${tag}-${process.pid}`);
fs.rmSync(building, { recursive: true, force: true });
fs.mkdirSync(building);
try {
  console.log(`Building the latest release, ${tag}, in ${building}`);
  const archive = spawnSync("git", ["archive", "--format=tar", tag], { cwd: repoDir, maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${tag} failed: ${archive.stderr}`);
  run("tar", ["-x", "-C", building], { input: archive.stdout });
  run(npm, ["ci", "--no-audit", "--no-fund"]);
  for (const workspace of BUILT) run(npm, ["run", "build", "-w", workspace]);
} catch (error) {
  fs.rmSync(building, { recursive: true, force: true });
  fail(`Building ${tag} failed: ${error.message}`);
}
try {
  fs.renameSync(building, dir);
} catch (error) {
  // Another checkout's run built it first.
  fs.rmSync(building, { recursive: true, force: true });
  if (!fs.existsSync(dir)) fail(`Could not move the build of ${tag} into ${dir}: ${error.message}`);
}
for (const entry of fs.readdirSync(root)) {
  if (RELEASE_TAG.test(entry) && entry !== tag) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
}
console.log(`Built the latest release, ${tag}, in ${dir}.`);

/**
 * Runs a command in the release's tree, its output shown. The variables npm
 * sets for a script it runs, such as `npm run build:latest-release`, are left
 * out, as they describe this checkout.
 */
function run(command, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("npm_") && name !== "INIT_CWD"));
  const { status, signal, error } = spawnSync(command, args, { cwd: building, env, stdio: [options.input ? "pipe" : "ignore", "inherit", "inherit"], ...options });
  if (error) throw error;
  if (status !== 0) throw new Error(`\`${[command, ...args].join(" ")}\` failed (${signal ?? `exit ${status}`})`);
}

/** Removes the directories that runs no longer running left building. */
function removeAbandonedBuilds() {
  for (const entry of fs.readdirSync(root)) {
    const pid = /^\.building-v[\d.]+-(\d+)$/.exec(entry)?.[1];
    if (pid !== undefined && !running(Number(pid))) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
