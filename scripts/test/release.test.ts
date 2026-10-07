import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginDir = path.join(repo, "decent-sync.reaplugin");
const { version } = JSON.parse(fs.readFileSync(path.join(pluginDir, "manifest.json"), "utf8")) as { version: string };

function run(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(repo, "scripts", script), ...args], { encoding: "utf8" });
}

describe("the release tag check", () => {
  it("accepts the tag naming the plugin manifest's version", () => {
    const result = run("check-release-tag.mjs", `v${version}`);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails a tag whose version differs from the manifest's", () => {
    const [major, minor, patch] = version.split(".").map(Number);
    const result = run("check-release-tag.mjs", `v${major}.${minor}.${patch! + 1}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`does not match the plugin manifest's version ${version}`);
  });

  it.each([version, `v${version}-beta.1`, "latest", ""])("fails %j, which is not vX.Y.Z", (tag) => {
    const result = run("check-release-tag.mjs", tag);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not vX.Y.Z");
  });
});

describe("a release's upgrade notes", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-upgrading-"));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  /** Writes an UPGRADING.md and runs the script on it for a tag. */
  function notesFor(tag: string, upgrading: string) {
    const file = path.join(scratch, "UPGRADING.md");
    fs.writeFileSync(file, upgrading);
    return run("release-notes.mjs", tag, file);
  }

  const upgrading = [
    "# Upgrading",
    "",
    "What to do.",
    "",
    "## 0.3.0",
    "",
    "### Approve the plugin update on every tablet",
    "",
    "It adds `pluginStorage`.",
    "",
    "## 0.2.0",
    "",
    "Recreate the database.",
    "",
  ].join("\n");

  it("are the section headed with the tag's version, without its heading", () => {
    const result = notesFor("v0.3.0", upgrading);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("### Approve the plugin update on every tablet\n\nIt adds `pluginStorage`.\n");
    expect(notesFor("v0.2.0", upgrading).stdout).toBe("Recreate the database.\n");
  });

  it("are nothing for a version without a section", () => {
    const result = notesFor("v0.2.1", upgrading);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("stop the release while notes wait under Unreleased", () => {
    const result = notesFor("v0.3.0", upgrading.replace("## 0.3.0", "## Unreleased"));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Retitle them 0.3.0, the version being released");
  });
});

describe("the plugin release ZIP", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-release-"));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("holds only decent-sync.reaplugin/ with the committed manifest.json and plugin.js", () => {
    const result = run("package-plugin.mjs", scratch);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const zipPath = result.stdout.trim();
    expect(zipPath).toBe(path.join(scratch, `decent-sync.reaplugin-v${version}.zip`));
    expect(fs.readdirSync(scratch)).toEqual([path.basename(zipPath)]);

    const extracted = path.join(scratch, "extracted");
    execFileSync("unzip", ["-q", zipPath, "-d", extracted]);
    // Decaid installs the one top-level folder that holds manifest.json.
    expect(fs.readdirSync(extracted)).toEqual(["decent-sync.reaplugin"]);
    const root = path.join(extracted, "decent-sync.reaplugin");
    expect(fs.readdirSync(root).sort()).toEqual(["manifest.json", "plugin.js"]);
    for (const file of ["manifest.json", "plugin.js"]) {
      expect(fs.readFileSync(path.join(root, file))).toEqual(fs.readFileSync(path.join(pluginDir, file)));
    }
  });
});
