// Regenerates the README's images: runs the README spec on a fresh test server, then encodes its captures. The images
// land in the output directory named as in docs/images/, to look at and copy over; the raw captures in its raw/.
//
// Usage: npm run readme-images [-- <output directory>]   (default dist/readme-images)
// Needs `npm run build` first, the test PostgreSQL (TEST_DATABASE_URL) and ffmpeg. The spec reads SKIP_STILLS,
// SKIP_LIVE, STILLS, SCREENSHOT_ZONE, SCREENSHOT_ZONE_HOURS and SAMPLE_SHOTS from the environment (README.md beside
// this file).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode, requireFfmpeg } from "./encode.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(repo, "dist/readme-images"));
/** Marks a directory this script made, which it may empty on the next run. */
const MARKER = ".readme-images";

try {
  // Before the 4-minute capture rather than after it.
  requireFfmpeg();
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(`${out} is not empty and was not made by this script. Name a new directory, or one an earlier run made.`);
    }
    fs.rmSync(out, { recursive: true });
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), "");
  const raw = path.join(out, "raw");

  const run = spawnSync("npx", ["playwright", "test", "--config", path.join(here, "playwright.config.ts"), "--output", path.join(out, "playwright")], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, SCREENSHOT_DIR: raw },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`The README spec failed (exit ${run.status}); its trace is under ${path.join(out, "playwright")}`);

  for (const output of encode(raw, out)) console.log(path.relative(process.cwd(), output));
  console.log(`Look at each image, then copy those the change redraws into docs/images/.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
