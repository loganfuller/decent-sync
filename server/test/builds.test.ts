import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILDS, type Build, rebuildCommand, staleBuilds } from "./support/build-table.mjs";

// Which builds are older than their sources, in the root build script's order,
// and the command that rebuilds them, through build-table.mjs's interface, on
// a copy of each build's layout in a temporary directory rather than the
// repo's own builds.

let root: string;
const sourcesAt = new Date("2026-10-26T10:00:00Z");
const builtAt = new Date("2026-10-26T10:05:00Z");

/** Writes a file under the temporary root, last modified at `at`. */
function write(relative: string, at: Date): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, relative);
  fs.utimesSync(file, at, at);
}

/** A file in each path: the path itself where it names a file, as one with an extension does, or one inside the directory. */
function fill(relative: string, at: Date): void {
  write(path.extname(relative) ? relative : path.join(relative, "index.js"), at);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-builds-"));
  for (const { sources } of Object.values(BUILDS)) sources.forEach((source) => fill(source, sourcesAt));
  for (const { outputs } of Object.values(BUILDS)) outputs.forEach((output) => fill(output, builtAt));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("staleBuilds", () => {
  it("finds none when every output is newer than every source", () => {
    expect(staleBuilds(root)).toEqual([]);
  });

  it("names the protocol and the plugin, which is built from its sources too, after a protocol source changes", () => {
    write("protocol/src/messages.ts", new Date("2026-10-26T10:10:00Z"));
    const stale = staleBuilds(root);
    expect(stale).toEqual([
      { build: "protocol", reason: "protocol/src/messages.ts changed after protocol/dist/index.js was built" },
      { build: "plugin", reason: "protocol/src/messages.ts changed after decent-sync.reaplugin/plugin.js was built" },
    ]);
    expect(rebuildCommand(stale.map(({ build }) => build))).toBe("npm run build -w protocol && npm run build -w plugin");
  });

  it("lists every stale build in the root build script's order, with why", () => {
    fs.rmSync(path.join(root, "server/nest-cli.json"));
    fs.rmSync(path.join(root, "web/dist"), { recursive: true });
    fs.rmSync(path.join(root, "decent-sync.reaplugin/plugin.js"));
    write("protocol/tsconfig.json", new Date("2026-10-26T10:10:00Z"));
    expect(staleBuilds(root)).toEqual([
      { build: "protocol", reason: "protocol/tsconfig.json changed after protocol/dist/index.js was built" },
      { build: "plugin", reason: "decent-sync.reaplugin/plugin.js is missing" },
      { build: "web", reason: "web/dist is missing" },
      { build: "server", reason: "server/nest-cli.json, which it is built from, is missing" },
    ]);
  });

  it("counts an output directory holding nothing as stale", () => {
    fs.rmSync(path.join(root, "server/dist/index.js"));
    expect(staleBuilds(root)).toEqual([{ build: "server", reason: "server/dist holds nothing" }]);
  });

  it("leaves out the generated Prisma client", () => {
    write("server/src/generated/prisma/client.ts", new Date("2026-10-26T10:10:00Z"));
    expect(staleBuilds(root)).toEqual([]);
  });
});

describe("rebuildCommand", () => {
  it("rebuilds the builds given, one after another, in the root build script's order", () => {
    const builds: Build[] = ["server", "protocol", "web"];
    expect(rebuildCommand(builds)).toBe("npm run build -w protocol && npm run build -w web && npm run build -w server");
  });
});

describe("BUILDS", () => {
  it("is in the order the root build script builds them", () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
    expect(scripts.build).toBe(rebuildCommand(Object.keys(BUILDS) as Build[]));
  });
});
