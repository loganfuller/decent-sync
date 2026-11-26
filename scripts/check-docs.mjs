// Checks the relative links of the repository's Markdown: the README,
// AGENTS.md, the docs, the stubs left where a document moved to the site, and
// every other Markdown file. A link to a file or folder that isn't there
// fails, and so does a link to a heading its file doesn't have. Links to
// other sites are not followed.
//
// The documentation site's own pages (site/src/content/) are left out: they
// link to each other by address, not by file, and the site's build checks
// those (site/check-links.mjs). A link into them from elsewhere is checked.
//
// It also holds README.md to its word budget. The README is the pitch, for
// someone deciding whether to try Decent Sync, and what a change adds for
// people to read or do belongs on the documentation site's page for its area
// (AGENTS.md, Documentation). The budget keeps it from growing back.
//
// Usage: node scripts/check-docs.mjs [directory]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Folders that hold no Markdown of the repository's own: installed packages,
// builds and test output.
const SKIPPED_NAMES = new Set(["node_modules", "dist", "generated", "test-results", "playwright-report"]);
const SKIPPED_PATHS = new Set(["site/src/content"]);

/** The most words README.md may hold, counted as `wc -w` counts them: its markup and its images' alt text included. */
export const README_WORD_BUDGET = 1500;

const MARKDOWN = /\.mdx?$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
// [text](target), ![alt](target) and either with a title, the target bare or in angle brackets.
const INLINE = /\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// [label]: target
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/;
const ATTRIBUTE = /\s(href|src|srcset|id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Every Markdown file under `root` the check reads, as paths relative to it
 * with forward slashes, sorted.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function markdownFiles(root) {
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name) || SKIPPED_PATHS.has(relative)) continue;
                walk(relative);
            } else if (entry.isFile() && MARKDOWN.test(entry.name)) found.push(relative);
        }
    };
    walk("");
    return found.sort();
}

/** A heading's anchor as GitHub and the site make it, before any `-1` for a repeat. */
function slug(heading) {
    return heading
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\- ]/gu, "")
        .replace(/ /g, "-");
}

/** A file's lines outside its code blocks, with inline code blanked, each with its line number. */
function prose(text) {
    const lines = [];
    let fence = null;
    text.split("\n").forEach((line, index) => {
        const marker = FENCE.exec(line)?.[1];
        if (fence !== null) {
            if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            return;
        }
        if (marker !== undefined) {
            fence = marker;
            return;
        }
        lines.push({ number: index + 1, text: line.replace(/(`+)(?:(?!\1).)+\1/g, (code) => " ".repeat(code.length)), raw: line });
    });
    return lines;
}

/** The anchors a Markdown file answers to: its headings', and any `id` or `name` it gives an element. */
function anchors(text) {
    const found = new Set();
    const seen = new Map();
    for (const { text: line, raw } of prose(text)) {
        const heading = HEADING.exec(raw)?.[1];
        if (heading !== undefined) {
            const base = slug(heading);
            const count = seen.get(base) ?? 0;
            seen.set(base, count + 1);
            found.add(count === 0 ? base : `${base}-${count}`);
        }
        for (const [, name, double, single] of line.matchAll(ATTRIBUTE)) {
            if (/^(id|name)$/i.test(name)) found.add(double ?? single);
        }
    }
    return found;
}

/** What a line links to. */
function targets(line) {
    const found = [];
    for (const [, angled, bare] of line.matchAll(INLINE)) found.push(angled ?? bare);
    const definition = DEFINITION.exec(line);
    if (definition) found.push(definition[1] ?? definition[2]);
    for (const [, name, double, single] of line.matchAll(ATTRIBUTE)) {
        const value = double ?? single;
        if (/^srcset$/i.test(name)) for (const candidate of value.split(",")) found.push(candidate.trim().split(/\s+/)[0]);
        else if (/^(href|src)$/i.test(name)) found.push(value);
    }
    return found.filter((target) => target !== "");
}

/**
 * The relative links of the Markdown under `root` that do not resolve: one
 * line each, naming the file, the line and the link. Empty when all resolve.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function brokenLinks(root) {
    const problems = [];
    const anchorsOf = new Map();
    const anchorsIn = (file) => {
        if (!anchorsOf.has(file)) anchorsOf.set(file, anchors(fs.readFileSync(file, "utf8")));
        return anchorsOf.get(file);
    };

    for (const file of markdownFiles(root)) {
        const absolute = path.join(root, file);
        for (const { number, text } of prose(fs.readFileSync(absolute, "utf8"))) {
            for (const target of targets(text)) {
                // Another site, a mail address, or a protocol-relative address.
                if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
                const at = target.indexOf("#");
                const [linked, fragment] = at === -1 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)];
                let decoded;
                try {
                    decoded = [decodeURIComponent(linked.split("?")[0]), decodeURIComponent(fragment)];
                } catch {
                    problems.push(`${file}:${number}: "${target}" is not an address`);
                    continue;
                }
                const [linkedPath, heading] = decoded;
                // A path from the root, as GitHub reads a leading slash.
                const resolved = linkedPath === "" ? absolute : linkedPath.startsWith("/") ? path.join(root, linkedPath) : path.resolve(path.dirname(absolute), linkedPath);
                if (!fs.existsSync(resolved)) {
                    problems.push(`${file}:${number}: "${target}" names no file or folder`);
                    continue;
                }
                if (heading === "" || !MARKDOWN.test(resolved) || !fs.statSync(resolved).isFile()) continue;
                const known = anchorsIn(resolved);
                if (!known.has(heading) && !known.has(heading.toLowerCase())) problems.push(`${file}:${number}: "${target}" names no heading of that file`);
            }
        }
    }
    return problems;
}

/**
 * How many words the README at `root` holds, as `wc -w` counts them: every
 * run of characters between spaces or line ends, markup included. Undefined
 * where `root` has no README.md.
 *
 * @param {string} root
 * @returns {number | undefined}
 */
export function readmeWords(root) {
    const readme = path.join(root, "README.md");
    if (!fs.existsSync(readme)) return undefined;
    return fs.readFileSync(readme, "utf8").split(/\s+/).filter((word) => word !== "").length;
}

/**
 * What is wrong with the README's length: one line saying how far over its
 * budget it is and where its detail belongs. Empty within the budget.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function readmeOverBudget(root) {
    const words = readmeWords(root);
    if (words === undefined || words <= README_WORD_BUDGET) return [];
    return [
        `README.md holds ${words} words, ${words - README_WORD_BUDGET} over its budget of ${README_WORD_BUDGET}: it is the pitch, so move the detail to the documentation site's page for its area (site/src/content/docs/) and link to it`,
    ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(process.argv[2] ?? repo);
    const links = brokenLinks(root);
    const length = readmeOverBudget(root);
    if (links.length > 0) {
        console.error(`${links.length} relative link${links.length === 1 ? "" : "s"} in the Markdown ${links.length === 1 ? "does" : "do"} not resolve:`);
        for (const problem of links) console.error(`  ${problem}`);
    }
    for (const problem of length) console.error(problem);
    if (links.length > 0 || length.length > 0) process.exit(1);
    console.log(`Every relative link in ${markdownFiles(root).length} Markdown files resolves.`);
    const words = readmeWords(root);
    if (words !== undefined) console.log(`README.md holds ${words} of the ${README_WORD_BUDGET} words of its budget.`);
}
