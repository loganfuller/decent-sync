import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// CI runs the tests in shards (`--shard=i/n`), one job each. Vitest's own
// sharding splits the files evenly by count, in hash order, which left one
// shard with half again the work of another: a file's tests take from under a
// second to a minute. Its size follows its duration well enough, so this
// deals the files out largest first, each to the shard with the fewest bytes
// so far. Every shard computes the same split from the same files.
class SizeBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const sized = files.map((spec) => ({ spec, size: fs.statSync(spec.moduleId).size }));
    sized.sort((a, b) => b.size - a.size || (a.spec.moduleId < b.spec.moduleId ? -1 : a.spec.moduleId > b.spec.moduleId ? 1 : 0));
    const shards = Array.from({ length: count }, () => ({ specs: [] as TestSpecification[], size: 0 }));
    for (const { spec, size } of sized) {
      const lightest = shards.reduce((least, shard) => (shard.size < least.size ? shard : least));
      lightest.specs.push(spec);
      lightest.size += size;
    }
    return shards[index - 1]!.specs;
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
    sequence: { sequencer: SizeBalancedSequencer },
    projects: [
      { extends: true, test: { name: "protocol", include: ["protocol/test/**/*.test.ts"] } },
      { extends: true, test: { name: "plugin", include: ["plugin/test/**/*.test.ts"] } },
      { extends: true, test: { name: "server", include: ["server/test/**/*.test.ts"] } },
      { extends: true, test: { name: "scripts", include: ["scripts/test/**/*.test.ts"] } },
      { extends: true, test: { name: "web", include: ["web/test/**/*.test.ts"] } },
    ],
  },
});
