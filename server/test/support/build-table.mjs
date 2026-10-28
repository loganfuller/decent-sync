// Each build the tests run, and whether it is older than its sources. Plain
// JavaScript, so that both the tests (server/test/support/builds.ts) and
// `npm run build:stale` (scripts/build-stale.mjs), which runs under plain
// Node, read the one table.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Each build's outputs, and what it is built from, configuration included,
 * relative to the repo, in the order the root `build` script builds them. Each
 * build writes every one of its outputs afresh: Nest, Vite and the protocol's
 * build empty their output directories first. The Prisma client in
 * server/src/generated is left out, as every typecheck generates it again; the
 * schema it is generated from is in. Each key is also the build's workspace.
 */
export const BUILDS = {
  protocol: { outputs: ["protocol/dist"], sources: ["protocol/src", "protocol/tsconfig.build.json", "protocol/tsconfig.json", "tsconfig.base.json"] },
  // The repo's package.json holds the plugin's version.
  plugin: {
    outputs: ["decent-sync.reaplugin/plugin.js", "decent-sync.reaplugin/manifest.json"],
    sources: ["plugin/src", "plugin/manifest.json", "plugin/build.mjs", "protocol/src", "package.json"],
  },
  web: { outputs: ["web/dist"], sources: ["web/src", "web/index.html", "web/vite.config.ts", "web/tsconfig.app.json", "tsconfig.base.json"] },
  server: {
    outputs: ["server/dist"],
    sources: ["server/src", "server/prisma/schema.prisma", "server/tsconfig.json", "server/tsconfig.build.json", "server/nest-cli.json", "tsconfig.base.json"],
    ignore: "server/src/generated",
  },
};

/**
 * Why the build in `root` is older than its sources, or undefined when every
 * one of its outputs is newer than every file it is built from.
 */
export function staleness(build, root = repoDir) {
  const { outputs, sources, ignore } = BUILDS[build];
  const missing = outputs.find((output) => !fs.existsSync(path.join(root, output)));
  if (missing) return `${missing} is missing`;
  // Its build would fail now, so what was built from it is out of date.
  const gone = sources.find((source) => !fs.existsSync(path.join(root, source)));
  if (gone) return `${gone}, which it is built from, is missing`;
  const built = files(root, outputs);
  if (built.length === 0) return `${outputs.join(" and ")} holds nothing`;
  const oldest = built.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a));
  const changed = files(root, sources, ignore && path.join(root, ignore)).find((source) => source.mtimeMs > oldest.mtimeMs);
  if (changed) return `${path.relative(root, changed.file)} changed after ${path.relative(root, oldest.file)} was built`;
  return undefined;
}

/** Each build in `root` older than its sources, with why, in the order of BUILDS. */
export function staleBuilds(root = repoDir) {
  return Object.keys(BUILDS).flatMap((build) => {
    const reason = staleness(build, root);
    return reason === undefined ? [] : [{ build, reason }];
  });
}

/** The command that rebuilds exactly these builds, one after another, in the order of BUILDS. */
export function rebuildCommand(builds) {
  return Object.keys(BUILDS)
    .filter((build) => builds.includes(build))
    .map((build) => `npm run build -w ${build}`)
    .join(" && ");
}

/** Every file under the paths, files or directories, with when it was last modified, leaving out those under `ignore`. */
function files(root, paths, ignore) {
  return paths.flatMap((relative) => {
    const start = path.join(root, relative);
    if (!fs.existsSync(start)) return [];
    const found = fs.statSync(start).isDirectory()
      ? fs
          .readdirSync(start, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(entry.parentPath, entry.name))
      : [start];
    return found
      .filter((file) => !ignore || !file.startsWith(ignore + path.sep))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }));
  });
}
