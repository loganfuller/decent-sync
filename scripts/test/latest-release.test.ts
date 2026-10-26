import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildsToRemove, latestReleaseTag } from "../../server/test/support/latest-release.mjs";

// The latest release, which Seam 1 runs beside the change, read from a
// scratch repository's tags.

describe("the latest release", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-latest-release-"));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  /** A new repository in the scratch directory, its commits on `main`, which it also records as `origin/main`. */
  function repository(name: string) {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
    const commit = (message: string) => git("commit", "--quiet", "--allow-empty", "-m", message);
    const pushMain = () => git("update-ref", "refs/remotes/origin/main", "main");
    return { dir, git, commit, pushMain };
  }

  it("is the newest vX.Y.Z tag on origin/main, compared by number, annotated or not", () => {
    const { dir, git, commit, pushMain } = repository("on-main");
    for (const [tag, annotated] of [["v1.2.0", false], ["v1.9.0", true], ["v1.10.0", true], ["v1.10.1-rc.1", false], ["latest", false]] as const) {
      commit(tag);
      git("tag", ...(annotated ? ["-a", "-m", tag] : []), tag);
    }
    // A later release tagged off main, and one on main since origin/main was last fetched.
    git("switch", "--quiet", "-c", "hotfix");
    commit("hotfix");
    git("tag", "v2.0.0");
    git("switch", "--quiet", "main");
    pushMain();
    commit("unfetched");
    git("tag", "v1.11.0");

    expect(latestReleaseTag(dir)).toBe("v1.10.0");
  });

  it("fails, saying to fetch them, without a release tag on origin/main or without origin/main", () => {
    const { dir, git, commit, pushMain } = repository("untagged");
    commit("first");
    git("tag", "v1.0.0-beta.1");
    expect(() => latestReleaseTag(dir)).toThrow(/Cannot list the release tags on origin\/main .*git fetch --tags origin main/);

    pushMain();
    expect(() => latestReleaseTag(dir)).toThrow(/No vX\.Y\.Z tag is on origin\/main: .*fetch-depth: 0/);
  });
});

describe("the builds removed once a release is built", () => {
  it("are those of tags earlier than the one just before it, never a later tag's", () => {
    const entries = ["v1.2.0", "v1.10.0", "v1.9.0", "v1.3.1", "v2.0.0", ".building-v1.10.0-123", "notes"];
    expect(buildsToRemove(entries, "v1.10.0")).toEqual(["v1.2.0", "v1.3.1"]);
    expect(buildsToRemove(["v1.3.0", "v1.3.1"], "v1.3.1")).toEqual([]);
    expect(buildsToRemove(["v1.3.1", "v1.4.0"], "v1.3.1")).toEqual([]);
  });
});
