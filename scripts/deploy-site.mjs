// Builds the documentation site at this checkout's version and places it in a
// checkout of the branch GitHub Pages serves (gh-pages), which the release
// workflow then commits and pushes. Each minor release's build is kept at a
// path of its own, vX.Y, built to be served there, and the latest minor's
// build is at the root as well. So a patch release replaces its minor's build,
// a deploy of one minor leaves every other minor's path as it was, and a
// deploy of an older minor leaves the root alone. `versions.json` at the root
// lists the minors, newest first, and names the latest, for the site's version
// selector (site/src/versions.mjs).
//
// Usage: node scripts/deploy-site.mjs <checkout of gh-pages>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minorOf, newestFirst } from "../site/src/versions.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MINOR = /^v(\d+)\.(\d+)$/;

// The site's version selector reads versions.json with the same names and order.
export { minorOf };

/** The minors a checkout of gh-pages holds a build of, newest first. */
export function deployedMinors(pagesDir) {
  return fs
    .readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MINOR.test(entry.name))
    .map((entry) => entry.name)
    .sort(newestFirst);
}

/**
 * Places `version`'s builds in `pagesDir`. `build(base)` builds the site to be
 * served at the path `base` under the site's root path (`""` for the root
 * itself, `/v1.13` for a minor's own) and returns the directory it built.
 * Returns the minor's path and whether it is the latest, and so at the root.
 */
export function deploy(pagesDir, version, build) {
  const minor = minorOf(version);
  const minors = [...new Set([minor, ...deployedMinors(pagesDir)])].sort(newestFirst);
  const latest = minors[0] === minor;

  fs.rmSync(path.join(pagesDir, minor), { recursive: true, force: true });
  fs.cpSync(build(`/${minor}`), path.join(pagesDir, minor), { recursive: true });

  if (latest) {
    // The root holds the latest build among the minors' own directories,
    // which stay, as does the checkout's .git.
    for (const entry of fs.readdirSync(pagesDir)) {
      if (entry === ".git" || MINOR.test(entry)) continue;
      fs.rmSync(path.join(pagesDir, entry), { recursive: true, force: true });
    }
    fs.cpSync(build(""), pagesDir, { recursive: true });
  }

  // GitHub Pages would otherwise run Jekyll, which drops Astro's _astro directory.
  fs.writeFileSync(path.join(pagesDir, ".nojekyll"), "");
  fs.writeFileSync(path.join(pagesDir, "versions.json"), `${JSON.stringify({ latest: minors[0], versions: minors }, null, 2)}\n`);
  return { minor, latest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pagesDir = process.argv[2];
  if (!pagesDir || !fs.existsSync(pagesDir)) {
    console.error("Usage: node scripts/deploy-site.mjs <checkout of gh-pages>");
    process.exit(1);
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const { ROOT_BASE } = await import("../site/site.config.mjs");
  // The Assistant tools page is written from the compiled server's tool definitions (site/src/assistant-tools.mjs),
  // so the server is built here, at the commit being deployed. A ref from before that page was generated has no need
  // of it, and builds as it did.
  if (fs.existsSync(path.join(repo, "site", "src", "assistant-tools.mjs"))) {
    for (const workspace of ["protocol", "server"]) execFileSync("npm", ["run", "build", "-w", workspace], { cwd: repo, stdio: "inherit" });
  }
  const { minor, latest } = deploy(pagesDir, version, (base) => {
    execFileSync("npm", ["run", "build", "-w", "site"], { cwd: repo, stdio: "inherit", env: { ...process.env, SITE_BASE: ROOT_BASE + base } });
    return path.join(repo, "site", "dist");
  });
  console.log(`Placed the site for v${version} at ${ROOT_BASE}/${minor}/${latest ? ` and, as the latest, at ${ROOT_BASE}/` : ""}`);
}
