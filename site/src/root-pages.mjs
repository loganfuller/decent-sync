// The pages of the site that are a Markdown file at the repository's root,
// which agents and the release script read there. Each is rendered from that
// file as the site is built, with no copy under src/content/docs/, so editing
// the root file changes its page (docs/DEVELOPMENT.md, The documentation
// site).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = new URL("../../", import.meta.url);
const BLOB = "https://github.com/loganfuller/decent-sync/blob/main/";
const SITE_PAGES = "site/src/content/docs/";

/** Each root file's page: its address, and the title and description its page has in place of the file's own heading. */
export const ROOT_PAGES = [
    { id: "reference/glossary", file: "GLOSSARY.md", title: "Glossary", description: "The terms Decent Sync uses, each defined once." },
    { id: "reference/upgrade-notes", file: "UPGRADING.md", title: "Upgrade notes", description: "What each release needs of you before you pull its image." },
];

const INLINE_LINK = /(\]\()([^)\s]+)(\))/g;

/** A root file's link as its page gives it: a page of the site by its address, anything else in the repository on GitHub. */
function pageLink(target) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
    const [path, fragment] = target.split("#");
    const hash = fragment === undefined ? "" : `#${fragment}`;
    if (path.startsWith(SITE_PAGES) && /\.mdx?$/.test(path)) return `../../${path.slice(SITE_PAGES.length).replace(/\.mdx?$/, "")}/${hash}`;
    return `${BLOB}${path}${hash}`;
}

/**
 * A root file's Markdown as the body of its page: without its own first
 * heading, which the page's title replaces, and with the links it makes
 * relative to the repository's root made to work from the page.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function pageBody(markdown) {
    let fenced = false;
    let titled = false;
    const lines = [];
    for (const line of markdown.split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) {
            lines.push(line);
            continue;
        }
        if (!titled && /^# /.test(line)) {
            titled = true;
            continue;
        }
        lines.push(line.replace(INLINE_LINK, (_, open, target, close) => `${open}${pageLink(target)}${close}`));
    }
    return lines.join("\n").replace(/^\n+/, "");
}

/**
 * Wraps Starlight's loader of src/content/docs/ to add the root files' pages
 * to the same collection, so each is a page like any other: in the sidebar,
 * the search and its own table of contents.
 *
 * @param {import("astro/loaders").Loader} docs
 * @returns {import("astro/loaders").Loader}
 */
export function withRootPages(docs) {
    return {
        name: "docs-with-root-pages",
        async load(context) {
            await docs.load(context);
            const add = async ({ id, file, title, description }) => {
                const body = pageBody(readFileSync(new URL(file, REPOSITORY_ROOT), "utf8"));
                const filePath = `../${file}`;
                const data = await context.parseData({ id, data: { title, description }, filePath });
                const digest = createHash("sha256").update(body).digest("hex");
                context.store.set({ id, data, body, filePath, digest, rendered: await context.renderMarkdown(body) });
            };
            for (const page of ROOT_PAGES) await add(page);
            // `astro dev` draws a page again when its root file is saved.
            const paths = new Map(ROOT_PAGES.map((page) => [fileURLToPath(new URL(page.file, REPOSITORY_ROOT)), page]));
            context.watcher?.add([...paths.keys()]);
            context.watcher?.on("change", (changed) => {
                const page = paths.get(changed);
                if (page) add(page).catch((error) => context.logger.error(`${page.file}: ${error.message}`));
            });
        },
    };
}
