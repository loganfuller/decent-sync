// Prints a release's upgrade notes: the section of UPGRADING.md headed with the
// tag's version, without its heading, which the release workflow puts at the
// top of the GitHub release's notes. Prints nothing for a version without
// notes. Fails while UPGRADING.md has notes under Unreleased, since they belong
// to the release being tagged and must be retitled with its version first.
//
// Usage: node scripts/release-notes.mjs vX.Y.Z [UPGRADING.md]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? "";
const file = process.argv[3] ?? path.join(repo, "UPGRADING.md");
const version = tag.replace(/^v/, "");

/** Each `## ` section's lines, by its heading. */
const sections = new Map();
let heading;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const match = /^## (.+?)\s*$/.exec(line);
  if (match) {
    heading = match[1];
    sections.set(heading, []);
  } else if (heading !== undefined) {
    sections.get(heading).push(line);
  }
}

if (sections.has("Unreleased")) {
  console.error(
    `UPGRADING.md has notes under Unreleased. Retitle them ${version}, the version being released, ` +
      "commit that, and tag that commit.",
  );
  process.exit(1);
}
const notes = (sections.get(version) ?? []).join("\n").trim();
if (notes) process.stdout.write(`${notes}\n`);
