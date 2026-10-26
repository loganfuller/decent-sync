import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { dealOut, estimateDurations, readRunLog } from "../test-durations.mjs";

const prefix = (job: string) => `${job}\tUNKNOWN STEP\t2026-10-26T04:42:32.0286979Z `;

describe("reading a CI run's log", () => {
  it("reads each file's duration with its colour codes as gh prints them or as escape bytes", () => {
    const log = [
      `${prefix("vitest (4/4)")} ^[[32m✓^[[39m ^[[30m^[[42m server ^[[49m^[[39m server/test/machine-identity.test.ts ^[[2m(^[[22m^[[2m39 tests^[[22m^[[2m)^[[22m^[[33m 16801^[[2mms^[[22m^[[39m`,
      `${prefix("vitest (1/4)")} \u001b[32m✓\u001b[39m \u001b[30m\u001b[42m plugin \u001b[49m\u001b[39m plugin/test/loaded-recipe-rules.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m\u001b[32m 37\u001b[2mms\u001b[22m\u001b[39m`,
    ].join("\n");

    expect(readRunLog(log)).toEqual(
      new Map([
        ["server/test/machine-identity.test.ts", 16801],
        ["plugin/test/loaded-recipe-rules.test.ts", 37],
      ]),
    );
  });

  it("reads a count with a suffix", () => {
    const log = `${prefix("vitest (2/4)")}  ✓  server  server/test/recipe-settings.test.ts (3 tests | 1 skipped) 85439ms`;

    expect(readRunLog(log)).toEqual(new Map([["server/test/recipe-settings.test.ts", 85439]]));
  });

  it("leaves out failed files, per-test lines and every other job", () => {
    const log = [
      `${prefix("vitest (2/4)")} ^[[31m❯^[[39m ^[[30m^[[42m server ^[[49m^[[39m server/test/library-equipment.test.ts ^[[2m(^[[22m^[[2m12 tests^[[22m^[[2m | ^[[22m^[[31m1 failed^[[39m^[[2m)^[[22m^[[33m 27699^[[2mms^[[22m^[[39m`,
      `${prefix("vitest (3/4)")}  ×  server  server/test/server-instances.test.ts (9 tests | 1 failed) 30000ms`,
      `${prefix("vitest (2/4)")} ^[[36m ^[[2m❯^[[22m server/test/library-equipment.test.ts:^[[2m502:29^[[22m^[[39m`,
      `${prefix("vitest (1/4)")}        ✓ writes a Shot's measurements (2 tests) 5000ms`,
      `${prefix("vitest latest release (1/4)")}  ✓  server  server/test/collections.test.ts (20 tests) 65000ms`,
      `${prefix("playwright (1/2)")}  ✓  server  server/test/collections.test.ts (20 tests) 65000ms`,
    ].join("\n");

    expect(readRunLog(log)).toEqual(new Map());
  });
});

describe("estimating durations", () => {
  it("takes a file's manifest entry, or its size at its project's median seconds per byte", () => {
    const files = [
      { path: "server/test/a.test.ts", project: "server", size: 1000 },
      { path: "server/test/b.test.ts", project: "server", size: 1000 },
      { path: "server/test/c.test.ts", project: "server", size: 1000 },
      { path: "server/test/new.test.ts", project: "server", size: 2000 },
      { path: "plugin/test/a.test.ts", project: "plugin", size: 1000 },
      { path: "plugin/test/new.test.ts", project: "plugin", size: 3000 },
    ];
    const manifest = { "server/test/a.test.ts": 10, "server/test/b.test.ts": 20, "server/test/c.test.ts": 90, "plugin/test/a.test.ts": 1 };

    expect(estimateDurations(files, manifest, os.tmpdir()).map((file) => file.seconds)).toEqual([10, 20, 90, 40, 1, 3]);
  });

  it("estimates a project the manifest has no file of from every manifest entry on disk, whichever projects are run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-durations-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const dir of ["server/test", "plugin/test"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, "server/test/a.test.ts"), "x".repeat(1000));
    fs.writeFileSync(path.join(root, "plugin/test/a.test.ts"), "x".repeat(1000));
    const manifest = { "server/test/a.test.ts": 30, "plugin/test/a.test.ts": 2, "server/test/gone.test.ts": 500 };
    const newFile = { path: "web/test/new.test.ts", project: "web", size: 1000 };

    expect(estimateDurations([newFile], manifest, root)[0]!.seconds).toBe(16);
    expect(estimateDurations([{ path: "server/test/a.test.ts", project: "server", size: 1000 }, newFile], manifest, root)[1]!.seconds).toBe(16);
  });
});

describe("dealing files out to shards", () => {
  it("deals them longest first, each to the shard with the least time so far, the lowest on a tie", () => {
    const files = [
      { path: "e", seconds: 10 },
      { path: "a", seconds: 50 },
      { path: "d", seconds: 20 },
      { path: "c", seconds: 30 },
      { path: "b", seconds: 30 },
    ];

    expect(dealOut(files, 3).map((shard) => shard.map((file) => file.path))).toEqual([["a"], ["b", "d"], ["c", "e"]]);
  });

  it("spreads files of equal sums over the shards with the fewest files", () => {
    const files = ["a", "b", "c", "d", "e"].map((path) => ({ path, seconds: 0 }));

    expect(dealOut(files, 3).map((shard) => shard.map((file) => file.path))).toEqual([["a", "d"], ["b", "e"], ["c"]]);
  });
});
