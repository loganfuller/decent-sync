// Rebuilds only the builds older than their sources, one after another in the
// root `build` script's order, and stops at the first that fails. The tests
// refuse to start while one is stale (server/test/support/builds.ts), and name
// them all.

import { spawnSync } from "node:child_process";
import { repoDir, staleBuilds } from "../server/test/support/build-table.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const stale = staleBuilds();
if (stale.length === 0) {
  console.log("Every build is newer than its sources.");
  process.exit(0);
}
for (const { build, reason } of stale) {
  console.log(`\nBuilding ${build}: ${reason}`);
  const { status, signal } = spawnSync(npm, ["run", "build", "-w", build], { cwd: repoDir, stdio: "inherit" });
  if (status !== 0) {
    console.error(`\nThe ${build} build failed (${signal ?? `exit ${status}`}); the builds after it were not run.`);
    process.exit(status || 1);
  }
}
console.log(`\nRebuilt ${stale.map(({ build }) => build).join(", ")}.`);
