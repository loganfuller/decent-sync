// Encodes the image spec's raw captures into the images README.md and the site show, named as in stills.ts: each still as a
// palette PNG, 1600 px wide (the phone 520), and each theme's Live View frames as a GIF. Needs ffmpeg on PATH.
//
// Usage: node scripts/images/encode.mjs <raw directory> <output directory>
// `npm run readme-images` and `npm run site-images` run it after the spec (README.md beside this file).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Widths of the encoded stills: the page stills are captured at a device scale of 2 from 1280 px, the phone's from 390. */
const STILL_WIDTH = 1600;
const PHONE_WIDTH = 520;
/** The GIF plays at twice the speed of the shot, 8 frames a second, 800 px wide. */
const GIF_SPEED = 2;
/** Seconds, as the GIF plays, that it holds its last frame, the shot finished on the scale, before it loops. */
const GIF_HOLD_SECONDS = 6;
/**
 * The GIF's height after scaling to 800 px: it crops off the sliver of the Weight chart's legend that the capture's
 * clip leaves at the bottom. Recheck it when the Live View card's layout changes.
 */
const GIF_HEIGHT = 482;

/** Fails with what to do when ffmpeg is not on PATH. */
export function requireFfmpeg() {
  const found = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (found.error || found.status !== 0) {
    throw new Error("ffmpeg is not on PATH. Install it (macOS: `brew install ffmpeg`; Debian or Ubuntu: `apt install ffmpeg`) and run again.");
  }
}

function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (run.error || run.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

function encodeStill(input, output) {
  const width = path.basename(input).startsWith("phone-") ? PHONE_WIDTH : STILL_WIDTH;
  ffmpeg(["-i", input, "-vf", `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:reserve_transparent=0[p];[b][p]paletteuse=dither=none`, output]);
}

/**
 * One theme's Live View frames as a GIF: an ffconcat list showing each frame until the next was captured, sped up by
 * GIF_SPEED and cut before the recording turns Idle, then its last frame held by tpad, and a palette of 64 colours.
 * The concat demuxer's handling of the last entry's duration differs with what follows it, so the hold is not in
 * the list.
 */
function encodeLive(framesDir, output) {
  const { frameTimesMs, idleAtMs } = JSON.parse(fs.readFileSync(path.join(framesDir, "capture.json"), "utf8"));
  const kept = frameTimesMs.filter((ms) => ms < idleAtMs).length;
  if (kept < 2) throw new Error(`${framesDir}: fewer than 2 frames were captured before the recording turned Idle`);
  const file = (i) => `file ${String(i).padStart(4, "0")}.png`;
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < kept - 1; i++) lines.push(file(i), `duration ${((frameTimesMs[i + 1] - frameTimesMs[i]) / 1000 / GIF_SPEED).toFixed(4)}`);
  lines.push(file(kept - 1));
  const list = path.join(framesDir, "list.txt");
  fs.writeFileSync(list, `${lines.join("\n")}\n`);
  ffmpeg([
    "-f", "concat", "-safe", "0", "-i", list,
    "-vf", `fps=8,tpad=stop_mode=clone:stop_duration=${GIF_HOLD_SECONDS},scale=800:-1:flags=lanczos,crop=800:${GIF_HEIGHT}:0:0,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    output,
  ]);
  return { kept, captured: frameTimesMs.length, cutAtMs: frameTimesMs[kept - 1] };
}

/** Encodes every capture in `rawDir` into `outDir`, and returns the paths written. */
export function encode(rawDir, outDir) {
  requireFfmpeg();
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const entry of fs.readdirSync(rawDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const input = path.join(rawDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".png")) {
      const output = path.join(outDir, entry.name);
      encodeStill(input, output);
      written.push(output);
    }
    const theme = entry.isDirectory() && /^live-frames-(light|dark)$/.exec(entry.name)?.[1];
    if (theme) {
      const output = path.join(outDir, `live-view-${theme}.gif`);
      const { kept, captured, cutAtMs } = encodeLive(input, output);
      console.log(`${path.basename(output)}: ${kept} of ${captured} frames, cut at ${(cutAtMs / 1000).toFixed(1)} s into the capture`);
      written.push(output);
    }
  }
  if (written.length === 0) throw new Error(`${rawDir} holds no captures to encode`);
  return written;
}

if (import.meta.main) {
  const [rawDir, outDir] = process.argv.slice(2);
  if (!rawDir || !outDir) {
    console.error("Usage: node scripts/images/encode.mjs <raw directory> <output directory>");
    process.exit(1);
  }
  try {
    for (const output of encode(path.resolve(rawDir), path.resolve(outDir))) console.log(output);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
