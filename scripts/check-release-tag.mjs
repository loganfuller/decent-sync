// Fails unless a release tag is vX.Y.Z naming the committed plugin manifest's
// version. Decaid's release install refuses a release whose tag does not match
// the manifest it downloads, and the server image is tagged with the same
// version, so one tag versions the whole repo.
//
// Usage: node scripts/check-release-tag.mjs vX.Y.Z

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repo, "decent-sync.reaplugin", "manifest.json");

const tag = process.argv[2] ?? "";
const { version } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// Decaid accepts only plain X.Y.Z versions, so prerelease tags cannot install.
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  fail(`Release tag "${tag}" is not vX.Y.Z.`);
}
if (tag !== `v${version}`) {
  fail(
    `Release tag ${tag} does not match the plugin manifest's version ${version}. ` +
      "Set the version in the root package.json, run `npm run build -w plugin`, commit, and tag that commit.",
  );
}
console.log(`Release tag ${tag} matches the plugin manifest.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
