import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { brokenLinks, markdownFiles, README_WORD_BUDGET, readmeOverBudget, readmeWords } from "../check-docs.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-check-docs-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

let count = 0;

/** A scratch repository holding these files, by path. */
function repository(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(temp, `repo-${count++}-`));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const run = (root?: string) =>
  spawnSync(process.execPath, [path.join(repo, "scripts", "check-docs.mjs"), ...(root === undefined ? [] : [root])], { encoding: "utf8" });

describe("the docs check", () => {
  it("passes Markdown whose relative links all resolve", () => {
    const root = repository({
      "README.md": [
        "# Thing",
        "",
        "See [the guide](docs/GUIDE.md), [its setup](docs/GUIDE.md#setting-it-up), [the docs](docs/),",
        "[this page's end](#the-end), [from the root](/docs/GUIDE.md) and ![a picture](docs/images/one.png).",
        '<img src="docs/images/one.png" alt="A picture"> <source srcset="docs/images/one.png 1x, docs/images/two.png 2x">',
        "",
        "[defined]: docs/GUIDE.md",
        "",
        "## The end",
      ].join("\n"),
      "docs/GUIDE.md": "# Guide\n\n## Setting it up\n\nBack to [the README](../README.md#thing) and on to [a title](<images/one.png> \"One\").\n",
      "docs/images/one.png": "",
      "docs/images/two.png": "",
    });

    expect(brokenLinks(root)).toEqual([]);
    const result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 Markdown files");
  });

  it("fails on a relative link to a file that is not there, naming the file, the line and the link", () => {
    const root = repository({
      "README.md": "# Thing\n\nSee [the guide](docs/GIUDE.md).\n",
      "docs/GUIDE.md": "# Guide\n\n![A picture](images/gone.png)\n\n[defined]: ../MISSING.md\n",
    });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("3 relative links in the Markdown do not resolve");
    expect(result.stderr).toContain('README.md:3: "docs/GIUDE.md" names no file or folder');
    expect(result.stderr).toContain('docs/GUIDE.md:3: "images/gone.png" names no file or folder');
    expect(result.stderr).toContain('docs/GUIDE.md:5: "../MISSING.md" names no file or folder');
  });

  it("fails on an image or link an HTML element names that is not there", () => {
    const root = repository({ "README.md": '<picture><source srcset="dark.svg"><img src="light.svg"></picture>\n<a href="docs/">docs</a>\n' });

    expect(brokenLinks(root)).toEqual([
      'README.md:1: "dark.svg" names no file or folder',
      'README.md:1: "light.svg" names no file or folder',
      'README.md:2: "docs/" names no file or folder',
    ]);
  });

  it("fails on a link to a heading the file does not have", () => {
    const root = repository({
      "README.md": "# Thing\n\n[Setup](docs/GUIDE.md#set-up), [the second](docs/GUIDE.md#steps-1), [a third](docs/GUIDE.md#steps-2) and [here](#nowhere).\n",
      "docs/GUIDE.md": "# Guide\n\n## Setting it up\n\n### Steps\n\n## Taking it down\n\n### Steps\n\n```md\n## Set up\n```\n",
    });

    expect(brokenLinks(root)).toEqual([
      'README.md:3: "docs/GUIDE.md#set-up" names no heading of that file',
      'README.md:3: "docs/GUIDE.md#steps-2" names no heading of that file',
      'README.md:3: "#nowhere" names no heading of that file',
    ]);
  });

  it("makes a heading's anchor as GitHub does", () => {
    const root = repository({
      "README.md": "[a](G.md#flyio) [b](G.md#3-write-flytoml) [c](G.md#a-recipes-reference-shot) [d](G.md#reporting-the-page-and-reloading) [e](G.md#the-server_url-setting) [f](G.md#linked) [g](G.md#by-hand)\n",
      "G.md": "# fly.io\n\n## 3. Write fly.toml\n\n## A Recipe's Reference Shot\n\n## Reporting the page, and reloading\n\n## The `SERVER_URL` setting\n\n## [Linked](https://example.com)\n\n<a id=\"by-hand\"></a>\n",
    });

    expect(brokenLinks(root)).toEqual([]);
  });

  it("follows no link to another site, and reads none in code", () => {
    const root = repository({
      "README.md": [
        "[A site](https://example.com/gone.md), [mail](mailto:someone@example.com) and [another](//example.com/x).",
        "Written `[like this](missing.md)`.",
        "",
        "```md",
        "[An example](missing.md)",
        "```",
        "",
        "~~~~",
        "```",
        "[Still an example](missing.md)",
        "~~~~",
      ].join("\n"),
    });

    expect(brokenLinks(root)).toEqual([]);
  });

  it("leaves out installed packages, builds and the site's pages, but checks a link into them", () => {
    const root = repository({
      "README.md": "[The page](site/src/content/docs/guide/shots.md#finding-a-shot) and [a missing one](site/src/content/docs/guide/gone.md).\n",
      "site/README.md": "[Missing](gone.md)\n",
      "site/src/content/docs/guide/shots.md": "---\ntitle: Shots\n---\n\n## Finding a Shot\n\n[Another page](../../guide/machines/)\n",
      "node_modules/thing/README.md": "[Missing](gone.md)\n",
      "site/dist/page.md": "[Missing](gone.md)\n",
      ".cache/notes.md": "[Missing](gone.md)\n",
    });

    expect(markdownFiles(root)).toEqual(["README.md", "site/README.md"]);
    expect(brokenLinks(root)).toEqual([
      'README.md:1: "site/src/content/docs/guide/gone.md" names no file or folder',
      'site/README.md:1: "gone.md" names no file or folder',
    ]);
  });

  it("passes this repository, with the stubs the moved documents left", () => {
    expect(markdownFiles(repo)).toEqual(expect.arrayContaining(["AGENTS.md", "README.md", "docs/PLUGIN.md", "docs/SELF-HOSTING.md"]));
    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("the README's word budget", () => {
  /** A README of this many words, over several lines, with an image as the README writes one. */
  const readme = (words: number) => {
    const image = '<img src="docs/images/one.png" alt="One picture" width="800">';
    const markup = image.split(/\s+/).length;
    return `${image}\n\n${Array.from({ length: words - markup }, (_, index) => (index % 12 === 11 ? "word\n" : "word")).join(" ")}\n`;
  };

  it("is 1,500 words", () => {
    expect(README_WORD_BUDGET).toBe(1500);
  });

  it("passes a README of exactly its budget, counting its markup as words, and says how much of it is used", () => {
    const root = repository({ "README.md": readme(README_WORD_BUDGET), "docs/images/one.png": "" });

    expect(readmeWords(root)).toBe(README_WORD_BUDGET);
    expect(readmeOverBudget(root)).toEqual([]);
    const result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("README.md holds 1500 of the 1500 words of its budget.");
  });

  it("fails a README one word over its budget, saying by how much and where the detail belongs", () => {
    const root = repository({ "README.md": readme(README_WORD_BUDGET + 1), "docs/images/one.png": "" });

    expect(brokenLinks(root)).toEqual([]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("README.md holds 1501 words, 1 over its budget of 1500");
    expect(result.stderr).toContain("the documentation site's page for its area");
    expect(result.stdout).toBe("");
  });

  it("reports a README over its budget beside a link that does not resolve", () => {
    const root = repository({ "README.md": `${readme(README_WORD_BUDGET + 40)}\nSee [the guide](docs/GIUDE.md).\n`, "docs/images/one.png": "" });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 relative link in the Markdown does not resolve");
    expect(result.stderr).toContain("README.md holds 1543 words, 43 over its budget of 1500");
  });

  it("holds no other Markdown to it, and passes a folder with no README", () => {
    const long = `# Guide\n\n${"word ".repeat(README_WORD_BUDGET * 2)}\n`;
    const root = repository({ "README.md": "# Thing\n\nSee [the guide](docs/GUIDE.md).\n", "docs/GUIDE.md": long, "docs/README.md": long });
    expect(readmeOverBudget(root)).toEqual([]);
    expect(run(root).status).toBe(0);

    const bare = repository({ "docs/GUIDE.md": long });
    expect(readmeWords(bare)).toBeUndefined();
    const result = run(bare);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("README.md");
  });

  it("passes this repository's README", () => {
    expect(readmeWords(repo)).toBeLessThanOrEqual(README_WORD_BUDGET);
    expect(readmeOverBudget(repo)).toEqual([]);
  });
});
