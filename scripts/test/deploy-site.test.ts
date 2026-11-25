import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { deploy, deployedMinors, minorOf } from "../deploy-site.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-deploy-site-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

let count = 0;
const emptyDir = (name: string) => fs.mkdtempSync(path.join(temp, `${name}-${count++}-`));

/** A checkout of gh-pages, with a .git as a real one has. */
function pagesCheckout() {
  const dir = emptyDir("pages");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/gh-pages\n");
  return dir;
}

/** Stands in for the site's build: a home page and a Guide page naming the version and the path they were built for. */
function buildOf(version: string, pages: string[] = ["guide/index.html"]) {
  return (base: string) => {
    const dir = emptyDir("build");
    for (const page of ["index.html", ...pages]) {
      fs.mkdirSync(path.dirname(path.join(dir, page)), { recursive: true });
      fs.writeFileSync(path.join(dir, page), `${version} at ${base || "/"}`);
    }
    return dir;
  };
}

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");
const versions = (dir: string) => JSON.parse(read(dir, "versions.json")) as { latest: string; versions: string[] };

describe("the documentation site's deploy", () => {
  it("names a version's minor", () => {
    expect(minorOf("1.13.0")).toBe("v1.13");
    expect(minorOf("2.0.11")).toBe("v2.0");
    expect(() => minorOf("v1.13.0")).toThrow("is not a version X.Y.Z");
    expect(() => minorOf("1.13")).toThrow("is not a version X.Y.Z");
  });

  it("puts a first deploy at its minor's path and at the root", () => {
    const pages = pagesCheckout();

    expect(deploy(pages, "1.13.0", buildOf("1.13.0"))).toEqual({ minor: "v1.13", latest: true });

    expect(read(pages, "index.html")).toBe("1.13.0 at /");
    expect(read(pages, "v1.13/index.html")).toBe("1.13.0 at /v1.13");
    expect(read(pages, "v1.13/guide/index.html")).toBe("1.13.0 at /v1.13");
    expect(fs.existsSync(path.join(pages, ".nojekyll"))).toBe(true);
    expect(versions(pages)).toEqual({ latest: "v1.13", versions: ["v1.13"] });
    expect(read(pages, ".git/HEAD")).toBe("ref: refs/heads/gh-pages\n");
  });

  it("leaves another minor's path in place when a newer minor takes the root", () => {
    const pages = pagesCheckout();
    deploy(pages, "1.13.0", buildOf("1.13.0", ["guide/index.html", "old-page/index.html"]));

    expect(deploy(pages, "1.14.0", buildOf("1.14.0"))).toEqual({ minor: "v1.14", latest: true });

    expect(read(pages, "v1.13/index.html")).toBe("1.13.0 at /v1.13");
    expect(read(pages, "v1.13/old-page/index.html")).toBe("1.13.0 at /v1.13");
    expect(read(pages, "v1.14/index.html")).toBe("1.14.0 at /v1.14");
    expect(read(pages, "index.html")).toBe("1.14.0 at /");
    // The root is the new build alone: a page the latest release dropped is gone from it.
    expect(fs.existsSync(path.join(pages, "old-page"))).toBe(false);
    expect(versions(pages)).toEqual({ latest: "v1.14", versions: ["v1.14", "v1.13"] });
    expect(deployedMinors(pages)).toEqual(["v1.14", "v1.13"]);
  });

  it("replaces its minor's build with a patch release", () => {
    const pages = pagesCheckout();
    deploy(pages, "1.14.0", buildOf("1.14.0", ["guide/index.html", "dropped/index.html"]));

    deploy(pages, "1.14.1", buildOf("1.14.1"));

    expect(read(pages, "v1.14/index.html")).toBe("1.14.1 at /v1.14");
    expect(fs.existsSync(path.join(pages, "v1.14", "dropped"))).toBe(false);
    expect(read(pages, "index.html")).toBe("1.14.1 at /");
    expect(versions(pages).versions).toEqual(["v1.14"]);
  });

  it("leaves the root alone when an older minor is deployed", () => {
    const pages = pagesCheckout();
    deploy(pages, "1.13.0", buildOf("1.13.0"));
    deploy(pages, "1.14.0", buildOf("1.14.0"));

    expect(deploy(pages, "1.13.1", buildOf("1.13.1"))).toEqual({ minor: "v1.13", latest: false });

    expect(read(pages, "v1.13/index.html")).toBe("1.13.1 at /v1.13");
    expect(read(pages, "index.html")).toBe("1.14.0 at /");
    expect(read(pages, "v1.14/index.html")).toBe("1.14.0 at /v1.14");
    expect(versions(pages)).toEqual({ latest: "v1.14", versions: ["v1.14", "v1.13"] });
  });

  it("orders minors by number, not by text", () => {
    const pages = pagesCheckout();
    deploy(pages, "1.9.0", buildOf("1.9.0"));
    deploy(pages, "1.10.0", buildOf("1.10.0"));

    expect(deploy(pages, "1.9.1", buildOf("1.9.1")).latest).toBe(false);
    expect(read(pages, "index.html")).toBe("1.10.0 at /");
    expect(versions(pages).versions).toEqual(["v1.10", "v1.9"]);
  });
});
