// Fails when the committed decent-sync.reaplugin/ differs from a fresh build,
// because Decaid installs whatever is committed. Compares the rebuilt files with
// the git index, which on a fresh CI checkout is the commit under test.

import { execFileSync } from "node:child_process";

const dir = "decent-sync.reaplugin";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

execFileSync(npm, ["run", "build", "-w", "plugin"], { stdio: "inherit" });

const changed = git("diff", "--name-only", "--", dir).trim();
const added = git("ls-files", "--others", "--exclude-standard", "--", dir).trim();
if (changed || added) {
  console.error(`\n${dir}/ is stale: a fresh build differs from the committed files.`);
  if (changed) console.error(`Changed:\n${changed}`);
  if (added) console.error(`Not committed:\n${added}`);
  console.error("Run `npm run build -w plugin` and commit the result.");
  process.exit(1);
}
console.log(`${dir}/ matches a fresh build.`);
