// Packages the committed decent-sync.reaplugin/ as the release's one ZIP,
// decent-sync.reaplugin-vX.Y.Z.zip, and checks what it holds. Decaid's release
// install extracts it and installs the single folder holding manifest.json, so
// the folder stays the ZIP's top-level entry, as in Decent's own plugin releases.
// The folder's package.json only makes it a workspace member and is left out.
//
// Usage: node scripts/package-plugin.mjs [output directory, default dist]
// Prints the ZIP's path. Needs the zip and unzip commands.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = "decent-sync.reaplugin";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(repo, "dist"));

const { version } = JSON.parse(fs.readFileSync(path.join(repo, dir, "manifest.json"), "utf8"));
const zipPath = path.join(outDir, `${dir}-v${version}.zip`);

const files = fs
  .readdirSync(path.join(repo, dir))
  .filter((name) => name !== "package.json")
  .sort()
  .map((name) => `${dir}/${name}`);

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
// -X leaves out file attributes that vary between machines.
execFileSync("zip", ["-X", "-q", zipPath, `${dir}/`, ...files], { cwd: repo });

const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n");
for (const required of [`${dir}/manifest.json`, `${dir}/plugin.js`]) {
  if (!entries.includes(required)) fail(`${path.basename(zipPath)} is missing ${required}`);
}
const stray = entries.filter((entry) => !entry.startsWith(`${dir}/`));
if (stray.length > 0) fail(`${path.basename(zipPath)} has entries outside ${dir}/: ${stray.join(", ")}`);

console.log(zipPath);

function fail(message) {
  console.error(message);
  process.exit(1);
}
