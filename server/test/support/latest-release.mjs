// The latest release, which Seam 1 runs beside the change (ADR-0025): the
// newest vX.Y.Z tag on main, built from its tag by `npm run
// build:latest-release` (scripts/build-latest-release.mjs) into a directory of
// its own outside the checkout, one per tag, which every checkout on the
// machine shares. Plain JavaScript, so that both the tests (test-server.ts and
// simulated-tablet.ts) and the script, which runs under plain Node, read the
// one rule.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoDir } from "./build-table.mjs";

/** The command that builds the latest release. */
export const BUILD_COMMAND = "npm run build:latest-release";

/** A release's tag, such as v1.3.0. */
export const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * The newest vX.Y.Z tag on main (`origin/main`), of the tags this clone
 * holds. Throws, saying how to fetch them, when it holds none.
 */
export function latestReleaseTag(root = repoDir) {
  const fetchThem =
    "fetch main's history and its tags (`git fetch --tags origin main`; in CI, actions/checkout with `fetch-depth: 0`)";
  let listed;
  try {
    listed = execFileSync("git", ["tag", "--merged", "origin/main", "--list", "v*"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Cannot list the release tags on origin/main (${String(error.stderr ?? error.message).trim()}): ${fetchThem}`);
  }
  const tags = listed.split("\n").filter((tag) => RELEASE_TAG.test(tag));
  if (tags.length === 0) throw new Error(`No vX.Y.Z tag is on origin/main: ${fetchThem}`);
  return tags.sort(compareVersions).at(-1);
}

/**
 * Where each release is built: decent-sync/releases in the user's cache
 * directory ($XDG_CACHE_HOME, or else ~/.cache).
 */
export function releasesDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "decent-sync", "releases");
}

/** The directory the release with this tag is built in, built or not. */
export function releaseDir(tag) {
  return path.join(releasesDir(), tag);
}

/**
 * The directory holding the latest release's build: its tree at its tag, its
 * plugin as committed there, and its protocol, management interface and
 * server built. Throws, naming the command that builds it, while it is not
 * built.
 */
export function latestReleaseDir(root = repoDir) {
  const tag = latestReleaseTag(root);
  const dir = releaseDir(tag);
  if (!fs.existsSync(path.join(dir, "server/dist/main.js"))) {
    throw new Error(`Tests that run the latest release need its build, and ${tag} is not built in ${dir}: run \`${BUILD_COMMAND}\`.`);
  }
  return dir;
}

function compareVersions(a, b) {
  const [, ...x] = RELEASE_TAG.exec(a).map(Number);
  const [, ...y] = RELEASE_TAG.exec(b).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
