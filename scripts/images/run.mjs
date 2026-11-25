// Generates the README's and the documentation site's images: runs the image spec on a fresh test server, then
// encodes its captures. The images land in the output directory named as in stills.ts, the raw captures in its raw/.
//
// Usage: node scripts/images/run.mjs <output directory>, the last one named
//   npm run readme-images [-- <directory>]   into dist/readme-images, to look at and copy over into docs/images/
//   npm run site-images                       into site/generated/, which the site's build reads
// Needs `npm run build` first, the test PostgreSQL (TEST_DATABASE_URL) and ffmpeg. The spec reads SKIP_STILLS,
// SKIP_LIVE, STILLS, SCREENSHOT_ZONE and SAMPLE_SHOTS from the environment (README.md beside this file).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode, requireFfmpeg } from "./encode.mjs";
import { STILLS } from "./stills.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
/** Marks a directory this script made, which it may empty on the next run; `.readme-images` is the earlier name. */
const MARKERS = [".images", ".readme-images"];

try {
  // The last directory named: `npm run readme-images -- <directory>` names one after the script's own.
  const named = process.argv.slice(2).at(-1);
  if (!named) throw new Error("Usage: node scripts/images/run.mjs <output directory>, or npm run readme-images or npm run site-images");
  const out = path.resolve(named);
  // Before the 4-minute capture rather than after it.
  requireFfmpeg();
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length > 0 && !entries.some((entry) => MARKERS.includes(entry))) {
      throw new Error(`${out} is not empty and was not made by this script. Name a new directory, or one an earlier run made.`);
    }
    fs.rmSync(out, { recursive: true });
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKERS[0]), "");
  const raw = path.join(out, "raw");

  const run = spawnSync("npx", ["playwright", "test", "--config", path.join(here, "playwright.config.ts"), "--output", path.join(out, "playwright")], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, SCREENSHOT_DIR: raw },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`The image spec failed (exit ${run.status}); its trace is under ${path.join(out, "playwright")}`);

  for (const output of encode(raw, out)) console.log(path.relative(process.cwd(), output));
  const readme = Object.entries(STILLS).filter(([, still]) => still.readme).map(([name]) => name);
  console.log(`README.md shows ${readme.join(", ")}, committed in docs/images/: look at each, and copy over those the change redraws. The site builds the rest.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
