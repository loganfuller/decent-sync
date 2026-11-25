// Checks the built site's internal links: every link, image, stylesheet and
// script a page names within the site must be a file of the build, and a
// link to a heading must name one the page has. It reads the built HTML, so
// it covers the home page's components as well as the Markdown pages.
// `npm run build -w site` runs it after the build, so a broken link fails it.
//
//   node check-links.mjs [dist] [base]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT_BASE } from "./site.config.mjs";

const ELEMENT = /<(?:a|area|img|link|script|source)\b[^>]*>/gi;
const ATTRIBUTE = /\s(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ID = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const decode = (value) =>
    value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Every `.html` file under `dir`. */
function htmlFiles(dir) {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
        .map((entry) => join(entry.parentPath, entry.name));
}

/** What a page links to: each `href` and `src`, and each address of a `srcset`. */
function references(html) {
    const found = [];
    for (const [element] of html.matchAll(ELEMENT)) {
        for (const [, name, double, single] of element.matchAll(ATTRIBUTE)) {
            const value = decode(double ?? single ?? "");
            if (name.toLowerCase() === "srcset") {
                for (const candidate of value.split(",")) found.push(candidate.trim().split(/\s+/)[0]);
            } else found.push(value);
        }
    }
    return found.filter((reference) => reference !== "");
}

function ids(html) {
    const found = new Set();
    for (const [, double, single] of html.matchAll(ID)) found.add(decode(double ?? single ?? ""));
    return found;
}

/**
 * The broken internal links of the build in `dist`, served at the path
 * `base`: one line each, naming the page and the link. Empty when all resolve.
 *
 * @param {string} dist
 * @param {string} base such as `/decent-sync`
 * @returns {string[]}
 */
export function brokenLinks(dist, base) {
    const origin = "http://site.invalid";
    const pages = new Map(htmlFiles(dist).map((file) => [file, readFileSync(file, "utf8")]));
    const idsOf = new Map();
    const problems = [];

    for (const [file, html] of pages) {
        const path = relative(dist, file).split(sep).join("/");
        const address = `${origin}${base}/${path.replace(/index\.html$/, "")}`;
        for (const reference of new Set(references(html))) {
            let url;
            try {
                url = new URL(reference, address);
            } catch {
                problems.push(`${path}: "${reference}" is not an address`);
                continue;
            }
            // Another site, or a mail or data address.
            if (url.origin !== origin) continue;
            if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
                problems.push(`${path}: "${reference}" leaves the site, which is served at ${base}/. Link to a page of the site with a relative path.`);
                continue;
            }
            let target = decodeURIComponent(url.pathname.slice(base.length + 1));
            if (target === "" || target.endsWith("/")) target += "index.html";
            const targetFile = join(dist, ...target.split("/"));
            if (!existsSync(targetFile) || !statSync(targetFile).isFile()) {
                const missingSlash = existsSync(join(targetFile, "index.html"));
                problems.push(`${path}: "${reference}" ${missingSlash ? "needs a trailing slash" : "names no page or file of the site"}`);
                continue;
            }
            const heading = decodeURIComponent(url.hash.slice(1));
            if (heading === "" || !pages.has(targetFile)) continue;
            if (!idsOf.has(targetFile)) idsOf.set(targetFile, ids(pages.get(targetFile)));
            if (!idsOf.get(targetFile).has(heading)) problems.push(`${path}: "${reference}" names no heading of that page`);
        }
    }
    return problems.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const dist = process.argv[2] ?? fileURLToPath(new URL("dist", import.meta.url));
    const base = (process.argv[3] ?? process.env.SITE_BASE ?? ROOT_BASE).replace(/\/$/, "");
    const problems = brokenLinks(dist, base);
    if (problems.length > 0) {
        console.error(`${problems.length} broken internal link${problems.length === 1 ? "" : "s"}:`);
        for (const problem of problems) console.error(`  ${problem}`);
        process.exit(1);
    }
    console.log("Every internal link of the site resolves.");
}
