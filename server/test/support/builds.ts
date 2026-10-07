import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests run the builds, not the sources: the server as a process, and the
// plugin as Decaid loads it. A build older than its sources would test code
// that no longer exists, so tests refuse to start until it is rebuilt.

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Each build's outputs, and what it is built from, relative to the repo. Each
 * build writes every one of its outputs afresh (Nest and Vite empty their
 * output directories first). The Prisma client in server/src/generated is left
 * out, as every typecheck generates it again; the schema it is generated from
 * is in.
 */
const BUILDS = {
  protocol: { outputs: ["protocol/dist"], sources: ["protocol/src", "protocol/tsconfig.build.json", "tsconfig.base.json"] },
  server: {
    outputs: ["server/dist"],
    sources: ["server/src", "server/prisma/schema.prisma", "server/tsconfig.json", "server/tsconfig.build.json", "server/nest-cli.json", "tsconfig.base.json"],
    ignore: "server/src/generated",
  },
  // The repo's package.json holds the plugin's version.
  plugin: {
    outputs: ["decent-sync.reaplugin/plugin.js", "decent-sync.reaplugin/manifest.json"],
    sources: ["plugin/src", "plugin/manifest.json", "plugin/build.mjs", "protocol/src", "package.json"],
  },
  web: { outputs: ["web/dist"], sources: ["web/src", "web/index.html", "web/vite.config.ts"] },
} satisfies Record<string, { outputs: string[]; sources: string[]; ignore?: string }>;

export type Build = keyof typeof BUILDS;

const checked = new Set<Build>();

/** Throws unless every output of each build is newer than every file it is built from. Each is checked once per process. */
export function assertBuilt(...builds: Build[]): void {
  for (const build of builds) {
    if (checked.has(build)) continue;
    const { outputs, sources, ...rest } = BUILDS[build];
    const ignore = "ignore" in rest ? path.join(repoDir, rest.ignore) : undefined;
    const missing = outputs.find((output) => !fs.existsSync(path.join(repoDir, output)));
    if (missing) throw new Error(`${missing} is missing: run \`npm run build\` before the tests`);
    const built = files(outputs);
    const oldest = built.reduce((a, b) => (b.mtimeMs < a.mtimeMs ? b : a));
    const changed = files(sources, ignore).filter((source) => source.mtimeMs > oldest.mtimeMs);
    if (changed.length > 0) {
      const what = path.relative(repoDir, changed[0]!.file);
      throw new Error(`${what} changed after ${path.relative(repoDir, oldest.file)} was built: run \`npm run build\` before the tests`);
    }
    checked.add(build);
  }
}

/** Every file under the paths, files or directories, with when it was last modified, leaving out those under `ignore`. */
function files(paths: readonly string[], ignore?: string): { file: string; mtimeMs: number }[] {
  return paths.flatMap((relative) => {
    const start = path.join(repoDir, relative);
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
