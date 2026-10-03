// Builds decent-sync.reaplugin/ from this workspace: plugin.js bundled by
// esbuild, and manifest.json from manifest.json here plus the repo's version.
//
// Decaid pastes plugin.js into the body of a function and then calls the
// global createPlugin(host), so the bundle must be an ES2020 script with no
// module syntax that declares createPlugin at its top level.

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const outDir = path.join(repo, "decent-sync.reaplugin");

const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const { id, author, name, description, ...rest } = JSON.parse(
  fs.readFileSync(path.join(here, "manifest.json"), "utf8"),
);
const manifest = { id, author, name, description, version, ...rest };

await esbuild.build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(outDir, "plugin.js"),
  bundle: true,
  format: "iife",
  globalName: "__decentSync",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["@decent-sync/source"],
  target: "es2020",
  charset: "utf8",
  legalComments: "none",
  define: {
    __PLUGIN_ID__: JSON.stringify(id),
    __PLUGIN_VERSION__: JSON.stringify(version),
  },
  banner: { js: "// Decent Sync plugin for Decaid. Generated from plugin/ by `npm run build -w plugin`; do not edit." },
  footer: { js: "var createPlugin = __decentSync.createPlugin;" },
  logLevel: "warning",
});

fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built decent-sync.reaplugin ${version}`);
