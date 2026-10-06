import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests run the builds, not the sources: the server as a process, and the
// plugin as Decaid loads it. A build older than its sources would test code
// that no longer exists, so tests refuse to start until it is rebuilt.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Each build, and what it is built from, relative to the repo. The Prisma
 * client in server/src/generated is left out, as every typecheck generates it
 * again; the schema it is generated from is in.
 */
const BUILDS = {
  protocol: { output: "protocol/dist", sources: ["protocol/src"] },
  server: { output: "server/dist", sources: ["server/src", "server/prisma/schema.prisma"], ignore: "server/src/generated" },
  plugin: { output: "decent-sync.reaplugin/plugin.js", sources: ["plugin/src", "protocol/src"] },
  web: { output: "web/dist", sources: ["web/src", "web/index.html"] },
} satisfies Record<string, { output: string; sources: string[]; ignore?: string }>;

export type Build = keyof typeof BUILDS;

const checked = new Set<Build>();

/** Throws unless each build is newer than every file it is built from. Each is checked once per process. */
export function assertBuilt(...builds: Build[]): void {
  for (const build of builds) {
    if (checked.has(build)) continue;
    const { output, sources, ...rest } = BUILDS[build];
    const ignore = "ignore" in rest ? path.join(repoDir, rest.ignore) : undefined;
    const built = newest([output]);
    if (!built) throw new Error(`${output} is missing: run \`npm run build\` before the tests`);
    const changed = newest(sources, ignore);
    if (changed && changed.mtimeMs > built.mtimeMs) {
      throw new Error(`${path.relative(repoDir, changed.file)} changed after ${output} was built: run \`npm run build\` before the tests`);
    }
    checked.add(build);
  }
}

/** The most recently modified file under the paths, files or directories, leaving out those under `ignore`. */
function newest(paths: readonly string[], ignore?: string): { file: string; mtimeMs: number } | undefined {
  let found: { file: string; mtimeMs: number } | undefined;
  for (const relative of paths) {
    const start = path.join(repoDir, relative);
    if (!fs.existsSync(start)) continue;
    const files = fs.statSync(start).isDirectory()
      ? fs
          .readdirSync(start, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(entry.parentPath, entry.name))
      : [start];
    for (const file of files) {
      if (ignore && file.startsWith(ignore + path.sep)) continue;
      const { mtimeMs } = fs.statSync(file);
      if (!found || mtimeMs > found.mtimeMs) found = { file, mtimeMs };
    }
  }
  return found;
}
