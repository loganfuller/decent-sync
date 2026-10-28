import { type Build, rebuildCommand, staleBuilds, staleness } from "./build-table.mjs";

// Tests run the builds, not the sources: the server as a process, and the
// plugin as Decaid loads it. A build older than its sources would test code
// that no longer exists, so tests refuse to start until it is rebuilt. The
// builds and their sources are in build-table.mjs, which `npm run build:stale`
// reads too. Nothing here builds: a build run under tests already running in
// this checkout would rewrite what they run.

export { type Build, type StaleBuild, rebuildCommand, staleBuilds } from "./build-table.mjs";

const checked = new Set<Build>();

/**
 * Throws unless every output of each build is newer than every file it is
 * built from. Each is checked once per process. The error names every stale
 * build, not only those given, so that one rebuild covers them all.
 */
export function assertBuilt(...builds: Build[]): void {
  for (const build of builds) {
    if (checked.has(build)) continue;
    if (staleness(build) !== undefined) {
      const stale = staleBuilds();
      throw new Error(
        [
          "The tests run the builds, and these are older than their sources:",
          ...stale.map(({ build, reason }) => `- ${build}: ${reason}`),
          `Run \`${rebuildCommand(stale.map(({ build }) => build))}\`, or \`npm run build:stale\`, before the tests.`,
        ].join("\n"),
      );
    }
    checked.add(build);
  }
}
