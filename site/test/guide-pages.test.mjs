// The Guide pages that are written (#684), read as their source: each is a
// page of tasks with steps, shows images the generator makes, links the
// Glossary, and names only controls the management interface has.
//
//   npm test -w site
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const WRITTEN = ["library-and-recipes", "profiles-and-drafts"];
const source = (page) => readFileSync(join(repository, "site/src/content/docs/guide", `${page}.mdx`), "utf8");

/** Every file under a folder, as one text, with the entities JSX writes an apostrophe and a quote as read back. */
function textOf(folder) {
    const files = readdirSync(join(repository, folder), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name));
    return files
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
        .join("\n")
        .replaceAll("&apos;", "'")
        .replaceAll("&quot;", '"');
}

describe("a written Guide page", () => {
    const stills = readFileSync(join(repository, "scripts/images/stills.ts"), "utf8");
    // What the management interface says: its own source, and the starting shapes it reads from protocol/.
    const said = `${textOf("web/src")}\n${textOf("protocol/src")}`;

    for (const page of WRITTEN) {
        const text = source(page);

        test(`${page} is written, by task, with steps`, () => {
            assert.doesNotMatch(text, /This page is not written yet/);
            assert.ok((text.match(/^## /gm) ?? []).length >= 5, "it has a heading for each task");
            assert.match(text, /^1\. .+\n2\. /m, "it has numbered steps");
        });

        test(`${page} links the Glossary`, () => {
            assert.match(text, /\]\(\.\.\/\.\.\/reference\/glossary\/\)/);
        });

        test(`${page} shows images the generator makes`, () => {
            const shown = [...text.matchAll(/<Still name="([^"]+)" alt="[^"]{20,}"/g)].map((match) => match[1]);
            assert.ok(shown.length >= 2, "it shows at least two images, each with its alt text");
            for (const name of shown) assert.match(stills, new RegExp(`^  "?${name}"?: \\{`, "m"), `${name} is not in scripts/images/stills.ts`);
        });

        // A page writes a control's name in bold, as the interface writes it. A name the interface no longer has fails here.
        test(`${page} names only controls the management interface has`, () => {
            const named = new Set([...text.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]));
            assert.ok(named.size >= 20, "it names its controls in bold");
            const missing = [...named].filter((name) => !said.includes(name));
            assert.deepEqual(missing, [], "named in bold, but not a label in web/src or protocol/src");
        });
    }
});
