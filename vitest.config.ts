import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { dealOut, estimateDurations, longestFirst, readManifest } from "./scripts/test-durations.mjs";

// CI runs the tests in shards (`--shard=i/n`), one job each, and a file is
// the unit of parallelism: Vitest runs a file's tests in turn, on one worker.
// Vitest's own split by count, and a split by size, both left one shard far
// slower than another, since a file's size tracks its duration poorly. So
// this deals the files out by their typical CI durations in
// vitest.durations.json (scripts/update-test-durations.mjs, which the checks
// job runs with --check), longest first, each to the shard with the least
// time so far. A file the manifest lacks is estimated from its size
// (scripts/test-durations.mjs). The split reads only the file list, the
// manifest and file sizes, never Vitest's results cache, so every shard
// computes the same one.
//
// Each shard then starts its longest files first, so that a long file does
// not start last and run on alone. Every project has the same groupOrder and
// maxWorkers, so Vitest's pool runs them as one group taking files from one
// queue, in this order: unlike BaseSequencer.sort, this does not keep each
// project's files together. Where a local results cache exists, files that
// failed last time still go first.
class DurationBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    return dealOut(await this.estimate(files), count)[index - 1]!.map((file) => file.spec);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { cache } = this.ctx;
    const results = (spec: TestSpecification) =>
      cache.getFileTestResults(`${spec.project.name}:${path.relative(this.ctx.config.root, spec.moduleId)}`);
    return (await this.estimate(files))
      .sort((a, b) => {
        const groupOrder = a.spec.project.config.sequence.groupOrder - b.spec.project.config.sequence.groupOrder;
        if (groupOrder !== 0) return groupOrder;
        const [aResults, bResults] = [results(a.spec), results(b.spec)];
        if (aResults && bResults && aResults.failed !== bResults.failed) return aResults.failed ? -1 : 1;
        return longestFirst(a, b);
      })
      .map((file) => file.spec);
  }

  // Estimates every test file of each project in the run, not just the files
  // given, so a file the manifest lacks gets the same estimate however the
  // run is filtered, and in shard() and sort() alike, as in --add-missing.
  private async estimate(files: TestSpecification[]) {
    const { root } = this.ctx.config;
    const key = (project: string, moduleId: string) => `${project}:${moduleId}`;
    const all = new Map<string, { path: string; project: string; size: number }>();
    const add = (project: string, moduleId: string) =>
      all.set(key(project, moduleId), {
        path: path.relative(root, moduleId).split(path.sep).join("/"),
        project,
        size: fs.statSync(moduleId).size,
      });
    for (const project of this.ctx.projects) {
      for (const moduleId of (await project.globTestFiles()).testFiles) add(project.name, moduleId);
    }
    for (const spec of files) add(spec.project.name, spec.moduleId);
    const estimated = new Map(
      estimateDurations([...all].map(([id, file]) => ({ ...file, id })), readManifest(root), root).map(
        (file) => [file.id, file],
      ),
    );
    return files.map((spec) => ({ ...estimated.get(key(spec.project.name, spec.moduleId))!, spec }));
  }
}

// Module tests run against workspace sources. Tests that need a build (the
// committed plugin, the compiled server) read the build output directly.
export default defineConfig({
  resolve: {
    alias: {
      "@decent-sync/protocol": path.resolve(import.meta.dirname, "protocol/src/index.ts"),
    },
  },
  test: {
    // Each server test file runs up to three server instances on one
    // PostgreSQL, whose connection pools each hold up to 10 connections, and
    // PostgreSQL allows 100 by default. Vitest's default of one worker per
    // CPU but one ran out of them on a 10-CPU machine; five peaked near 60.
    maxWorkers: Math.min(5, Math.max(1, availableParallelism() - 1)),
    // Vitest's defaults (a poll gives up after 1 s, a test after 5 s, a hook
    // after 10 s) fail on a busy CI runner well before a server and tablet
    // that are working have caught up. A test bounds its times from below,
    // and leaves the upper bound to these (docs/AI_BUILD_NOTES.md).
    expect: { poll: { timeout: 15_000 } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Checks that no server's or simulated tablet's log holds a secret a test was given.
    setupFiles: ["server/test/support/setup.ts"],
    sequence: { sequencer: DurationBalancedSequencer },
    projects: [
      { extends: true, test: { name: "protocol", include: ["protocol/test/**/*.test.ts"] } },
      { extends: true, test: { name: "plugin", include: ["plugin/test/**/*.test.ts"] } },
      { extends: true, test: { name: "server", include: ["server/test/**/*.test.ts"] } },
      { extends: true, test: { name: "scripts", include: ["scripts/test/**/*.test.ts"] } },
      { extends: true, test: { name: "web", include: ["web/test/**/*.test.ts"] } },
    ],
  },
});
