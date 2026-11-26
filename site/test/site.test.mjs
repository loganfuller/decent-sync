// What a reader or the owner would notice of the built site: a missing page,
// a link that leads nowhere, a home page that scrolls sideways on a phone, a
// search that finds nothing. The site is built once, as a minor release's own
// build, and opened in a browser as GitHub Pages serves it.
//
//   npm test -w site
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { brokenLinks } from "../check-links.mjs";
import { ROOT_BASE, SITE } from "../site.config.mjs";
import { canonicalAtRoot } from "../src/canonical.mjs";
import { readTools, TOOLS_PAGE } from "../src/assistant-tools.mjs";
import { pageBody, ROOT_PAGES } from "../src/root-pages.mjs";
import { minorOf } from "../src/versions.mjs";
import { serve } from "./support/serve.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));

// The sections and pages of #680, at the addresses the management interface
// will link to. Changing one here is changing a published address.
const SECTIONS = [
    ["Get started", ["get-started/what-decent-sync-is", "get-started/quick-start", "get-started/locations-and-machines", "get-started/install-the-plugin", "get-started/invite-people"]],
    ["Guide", ["guide/library-and-recipes", "guide/profiles-and-drafts", "guide/shots", "guide/machines", "guide/assistants", "guide/accounts-and-roles"]],
    ["Self-hosting", ["self-hosting/docker-compose", "self-hosting/local-network", "self-hosting/internet", "self-hosting/fly-io", "self-hosting/upgrading", "self-hosting/configuration"]],
    ["Reference", ["reference/glossary", "reference/tablet-plugin", "reference/assistant-tools", "reference/upgrade-notes"]],
    ["Technical", ["technical/architecture", "technical/internals", "technical/skin-authors", "technical/development"]],
    ["Project", ["project/roadmap", "project/releases"]],
];
const PAGES = SECTIONS.flatMap(([, pages]) => pages);

// The pages #683 wrote from the README, the self-hosting document and the
// plugin document, the two rendered from a file at the repository's root, and
// the Technical and Project pages #687 wrote as the README was cut to a pitch.
const WRITTEN = [...SECTIONS[0][1], ...SECTIONS[2][1], "reference/glossary", "reference/tablet-plugin", "reference/upgrade-notes", ...SECTIONS[4][1], ...SECTIONS[5][1]];

const GITHUB = "https://github.com/loganfuller/decent-sync";

const repository = join(root, "..");
const repositoryFile = (path) => readFileSync(join(repository, path), "utf8");
/** A built page's text as a reader sees it: no tags, and entities as their characters. */
const text = (html) =>
    html
        .replace(/<[^>]+>/g, "")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

// The minor this checkout documents, built at its own path as the deploy builds it.
const current = minorOf(version);
const base = `${ROOT_BASE}/${current}`;
let dist;

before(() => {
    dist = mkdtempSync(join(tmpdir(), "decent-sync-site-"));
    execFileSync("npx", ["astro", "build", "--outDir", dist], { cwd: root, env: { ...process.env, SITE_BASE: base }, stdio: ["ignore", "ignore", "inherit"] });
});

after(() => rmSync(dist, { recursive: true, force: true }));

const read = (path) => readFileSync(join(dist, path, "index.html"), "utf8");

describe("the built site", () => {
    test("has every page at its address", () => {
        for (const page of PAGES) assert.ok(existsSync(join(dist, page, "index.html")), `${page} is missing`);
    });

    // The Guide pages written so far (#685, #686), by what a reader would miss, never by their wording: the page
    // itself, its images, its steps, and its way to the Glossary. The last two show no image.
    const GUIDE_STILLS = {
        "guide/shots": ["shots", "shot", "overview", "recipe"],
        "guide/machines": ["machines", "live-view", "phone", "machine-activity", "machine-settings", "machine-software"],
        "guide/assistants": [],
        "guide/accounts-and-roles": [],
    };
    const content = (path) => {
        const html = read(path);
        return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    };

    for (const [path, stills] of Object.entries(GUIDE_STILLS)) {
        test(`${path} is written, with its images, its steps and a link to the Glossary`, () => {
            const main = content(path);
            assert.ok(!main.includes("This page is not written yet"), `${path} is still a placeholder`);
            for (const still of stills) assert.ok(main.includes(`data-still="${still}"`), `${path} lacks the image ${still}`);
            assert.ok(main.includes("<ol"), `${path} has no steps`);
            assert.ok(main.includes('href="../../reference/glossary/"'), `${path} does not link to the Glossary`);
        });
    }

    test("states the out-of-spec margins in one table, with the least Shots a group needs", () => {
        const main = content("guide/shots");
        const from = main.indexOf('id="what-out-of-spec-means"');
        assert.ok(from > 0, "guide/shots has no section on what out of spec means");
        const section = main.slice(from, main.indexOf("<h2", from + 1));
        const tables = section.match(/<table[\s\S]*?<\/table>/g) ?? [];
        assert.equal(tables.length, 1, "the section states its margins in one table");
        const headings = [...tables[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(([, heading]) => heading.trim());
        assert.ok(headings.includes("Least Shots"), `the margins table has no column for the least Shots: ${headings.join(", ")}`);
        for (const margin of ["10%", "5%", "90%"]) assert.ok(tables[0].includes(margin), `the margins table lacks ${margin}`);
        // Stated once: no other table of the page gives a margin.
        const others = (main.match(/<table[\s\S]*?<\/table>/g) ?? []).filter((table) => table !== tables[0]);
        for (const table of others) assert.ok(!/\b(10|5|90)%/.test(table), "a margin is stated in a second table");
    });

    test("sends the Assistants page's reader to the tools, and to the self-hosting page on assistants and turning them off", () => {
        const main = content("guide/assistants");
        assert.ok(main.includes('href="../../reference/assistant-tools/"'), "guide/assistants does not link to the Assistant tools reference");
        assert.ok(main.includes('href="../../self-hosting/internet/#assistants"'), "guide/assistants does not link to the self-hosting page's section on assistants");
        const hosting = read("self-hosting/internet");
        assert.ok(hosting.includes('id="assistants"') && hosting.includes('id="turning-assistants-off"'), "self-hosting/internet no longer covers assistants and turning them off");
    });

    // The reference is written from the server's own tool definitions as the site is built (src/assistant-tools.mjs),
    // so the test reads the same definitions, never a list of its own.
    test("lists every tool the server defines on the Assistant tools page, each with its description, from no file of its own", () => {
        for (const extension of ["md", "mdx"]) assert.ok(!existsSync(join(root, "src", "content", "docs", `${TOOLS_PAGE.id}.${extension}`)), `${TOOLS_PAGE.id} has a hand-written copy`);
        const main = content(TOOLS_PAGE.id);
        assert.ok(!main.includes("This page is not written yet"), `${TOOLS_PAGE.id} is still a placeholder`);
        const tools = readTools();
        assert.ok(tools.length > 20 && tools.some((tool) => tool.name === "find_shots"), "the tools were not read from the server");
        const rows = [...main.matchAll(/<tr><td><code>([^<]+)<\/code>[\s\S]*?<\/tr>/g)].map(([row, name]) => [name, text(row).replace(/\s+/g, " ")]);
        assert.deepEqual(rows.map(([name]) => name).sort(), tools.map((tool) => tool.name).sort(), "the page's rows are not the server's tools");
        const shown = new Map(rows);
        for (const { name, title, description } of tools) {
            assert.ok(shown.get(name).includes(title), `${name} lacks its title`);
            assert.ok(description.trim().length > 0 && shown.get(name).includes(description.trim().replace(/\s+/g, " ")), `${name} lacks its description`);
        }
    });

    test("lists the six sections and every page in its sidebar, in order", () => {
        const html = read("guide/shots");
        const sidebar = html.slice(html.search(/<nav[^>]*aria-label="Main"/));
        let from = 0;
        for (const [label, pages] of SECTIONS) {
            const at = sidebar.indexOf(`>${label}<`, from);
            assert.ok(at >= from, `the sidebar lacks the section ${label}, or has it out of order`);
            from = at;
            for (const page of pages) {
                const link = sidebar.indexOf(`href="${base}/${page}/"`, from);
                assert.ok(link >= from, `the sidebar's ${label} lacks ${page}, or has it out of order`);
                from = link;
            }
        }
    });

    test("says which release it documents on every page", () => {
        for (const page of ["", ...PAGES]) assert.match(read(page), new RegExp(`This site documents <span[^>]*>v${version.replaceAll(".", "\\.")}</span>`), page || "home");
    });

    test("names the latest release's page as the canonical address of a minor release's page", () => {
        assert.match(read("guide/shots"), new RegExp(`<link rel="canonical" href="${SITE}${ROOT_BASE}/guide/shots/"`));
        assert.match(read(""), new RegExp(`<link rel="canonical" href="${SITE}${ROOT_BASE}/"`));
    });

    test("has no broken internal link", () => {
        assert.deepEqual(brokenLinks(dist, base), []);
    });

    test("has each Get started, Self-hosting, plugin, Technical and Project page written, and no page left saying what it will hold", () => {
        for (const page of PAGES) assert.ok(!read(page).includes("This page is not written yet"), `${page} is not written`);
        for (const page of WRITTEN) assert.match(read(page), /<h2 /, `${page} has no section`);
    });

    // The Technical and Project pages (#687), by what a developer would miss: a decision record or a document with no
    // way to it from the site. Each list is read from the repository, so adding a record or a document fails here
    // until its page links it.
    test("gives every architecture decision record a line on the Architecture page, with what is shared, the connections and the protocol", () => {
        const main = content("technical/architecture");
        for (const section of ["what-is-shared-with-which-machines", "the-three-connections", "the-protocol-in-outline", "the-design-decisions"]) {
            assert.ok(main.includes(`id="${section}"`), `technical/architecture lacks its section ${section}`);
        }
        for (const connection of ["the-plugins-websocket", "the-rest-api", "the-mcp-endpoint"]) assert.ok(main.includes(`id="${connection}"`), `technical/architecture lacks ${connection}`);
        const records = readdirSync(join(repository, "docs/adr")).filter((file) => /^\d{4}-.+\.md$/.test(file));
        assert.ok(records.length >= 35, "the decision records were not read from docs/adr/");
        for (const record of records) {
            const line = main.match(new RegExp(`<li>\\s*<a href="${GITHUB}/blob/main/docs/adr/${record}"[^>]*>ADR-${record.slice(0, 4)}</a>([\\s\\S]*?)</li>`));
            assert.ok(line, `technical/architecture has no line for docs/adr/${record}`);
            assert.ok(text(line[1]).trim().length > 20, `technical/architecture says nothing of docs/adr/${record}`);
        }
    });

    test("links every implementer spec, note and agent convention from the Internals page, each with what it covers, and the decision records", () => {
        const main = content("technical/internals");
        // The two stubs left where a document moved to the site are no documents of their own.
        const stubs = ["PLUGIN.md", "SELF-HOSTING.md"];
        const documents = [
            ...readdirSync(join(repository, "docs")).filter((file) => file.endsWith(".md") && !stubs.includes(file)).map((file) => `docs/${file}`),
            ...readdirSync(join(repository, "docs/agents")).filter((file) => file.endsWith(".md")).map((file) => `docs/agents/${file}`),
            "AGENTS.md",
            "GLOSSARY.md",
            "UPGRADING.md",
        ];
        for (const spec of ["docs/SHOTS.md", "docs/STEAM_RECORDS.md", "docs/WORKFLOW-AND-STATE.md", "docs/COLLECTIONS.md", "docs/LIBRARY.md"]) assert.ok(documents.includes(spec), `${spec} was not read from docs/`);
        for (const document of documents) assert.ok(main.includes(`href="${GITHUB}/blob/main/${document}"`), `technical/internals does not link ${document}`);
        // A document in a table has a line on what it covers beside its link.
        for (const [, row] of main.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
            const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell).trim());
            if (cells.length > 0) assert.ok(cells.length === 2 && cells[1].length > 20, `technical/internals says nothing of ${cells[0]}`);
        }
        assert.ok(main.includes(`href="${GITHUB}/tree/main/docs/adr"`), "technical/internals does not link the decision records");
        assert.ok(main.includes('href="../../technical/architecture/#the-design-decisions"'), "technical/internals does not lead to each decision's line");
        assert.ok(main.includes('href="../../technical/development/"'), "technical/internals does not link the Development page");
    });

    test("leads from the Development page to the development guide, and from the Roadmap to the releases", () => {
        assert.ok(content("technical/development").includes(`href="${GITHUB}/blob/main/docs/DEVELOPMENT.md"`), "technical/development does not link the development guide");
        const roadmap = content("project/roadmap");
        assert.ok(roadmap.includes('id="planned-next"'), "project/roadmap does not say what is planned next");
        assert.ok(roadmap.includes('href="../../project/releases/"'), "project/roadmap does not link the Releases page");
        const releases = content("project/releases");
        assert.ok(releases.includes(`href="${GITHUB}/releases"`), "project/releases does not link the releases on GitHub");
        assert.ok(releases.includes(`href="${GITHUB}/releases/tag/v1.0.0"`), "project/releases does not say what each release added");
    });

    test("has every setting the server and the Compose file read on the Configuration page", () => {
        const page = text(read("self-hosting/configuration"));
        const server = [...repositoryFile("server/src/config.ts").matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name);
        const compose = [...repositoryFile("docker-compose.yml").matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name);
        // What only the server's own tests set.
        const settings = [...new Set([...server, ...compose])].filter((name) => !name.startsWith("TEST_"));
        assert.ok(settings.includes("DATABASE_URL") && settings.includes("POSTGRES_PASSWORD"), "the settings were not read from the code");
        for (const setting of settings) assert.ok(page.includes(setting), `the Configuration page lacks ${setting}`);
    });

    test("lists each notice the tablet shows on the tablet plugin's page", () => {
        const page = text(read("reference/tablet-plugin"));
        assert.ok(page.includes("Decent Sync has not reached its server for 10 minutes."));
    });

    test("renders the Glossary and the Upgrade notes from the files at the repository's root, with no copy", () => {
        for (const { id, file, title } of ROOT_PAGES) {
            for (const extension of ["md", "mdx"]) assert.ok(!existsSync(join(root, "src", "content", "docs", `${id}.${extension}`)), `${id} has a copy of ${file}`);
            const html = read(id);
            assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`));
            const headings = [...repositoryFile(file).matchAll(/^## (.+)$/gm)].map(([, heading]) => heading);
            assert.ok(headings.length > 3, `${file} has no sections`);
            const shown = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map(([, heading]) => text(heading));
            for (const heading of headings) assert.ok(shown.includes(heading), `${id} lacks ${file}'s section ${heading}`);
        }
        // The root file's own links, made to work from the page.
        const notes = read("reference/upgrade-notes");
        assert.ok(notes.includes('href="https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0025-each-release-runs-beside-the-previous-one.md"'));
        assert.ok(notes.includes('href="../../self-hosting/upgrading/#if-you-skipped-a-release"'));
    });
});

// README.md is the pitch (#687): it links to the site for everything else, so each of its links must lead to a page
// this build has, and it must stay the pitch.
describe("the README", () => {
    const readme = repositoryFile("README.md");
    const address = `${SITE}${ROOT_BASE}/`;
    const links = [...readme.matchAll(new RegExp(`${address.replaceAll(".", "\\.")}([^\\s)"#]*)(?:#([^\\s)"]+))?`, "g"))].map(([, path, heading]) => ({ path, heading }));
    const sections = [...readme.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading);
    /** A section's text, from its heading to the next. */
    const section = (heading) => {
        const from = readme.indexOf(`## ${heading}\n`);
        const to = readme.indexOf("\n## ", from + 1);
        return readme.slice(from, to === -1 ? undefined : to);
    };

    test("links only to pages and headings the site has", () => {
        assert.ok(links.length >= 20, "the README's links to the site were not read");
        for (const { path, heading } of links) {
            const link = `${address}${path}${heading ? `#${heading}` : ""}`;
            assert.ok(path === "" || path.endsWith("/"), `${link} lacks its trailing slash`);
            assert.ok(existsSync(join(dist, path, "index.html")), `${link} names no page of the site`);
            if (heading) assert.ok(read(path).includes(`id="${heading}"`), `${link} names no heading of that page`);
        }
    });

    test("links to the site before its first section", () => {
        assert.ok(readme.slice(0, readme.indexOf("\n## ")).includes(`](${address})`), "the README's top has no link to the site");
    });

    // Changing the pitch's sections is changing this list: the sections that went (its features, its per-release
    // table, connecting an assistant and installing the plugin) are pages of the site now.
    test("keeps to the pitch's sections, in order", () => {
        assert.deepEqual(sections, ["What you get", "Who it's for", "How it works", "Quick start", "Documentation", "For developers", "Status", "License"]);
    });

    test("links each line of what you get to its page of the site, and each section of the site from its table", () => {
        const benefits = section("What you get").split(/\n(?=- )/).slice(1);
        assert.equal(benefits.length, 8);
        for (const benefit of benefits) assert.ok(benefit.includes(`](${address}`), `no page is linked from: ${benefit.split("\n")[0]}`);
        const documentation = section("Documentation");
        for (const page of ["get-started/", "guide/", "self-hosting/", "reference/"]) assert.ok(documentation.includes(`](${address}${page}`), `the Documentation table links nothing under ${page}`);
        const developers = section("For developers");
        for (const page of [...SECTIONS[4][1], "reference/assistant-tools"]) assert.ok(developers.includes(`](${address}${page}/)`), `For developers does not link ${page}`);
        const status = section("Status");
        for (const page of SECTIONS[5][1]) assert.ok(status.includes(`](${address}${page}/)`), `Status does not link ${page}`);
    });

    // The Live View GIF and at most three stills, each in light and dark, committed in docs/images/, which holds no
    // image the README does not show.
    test("shows the Live View and at most three stills, which are the images committed", () => {
        const marked = [...repositoryFile("scripts/images/stills.ts").matchAll(/^  "?([a-z-]+)"?: \{ readme: true, file: "(gif|png)"/gm)].map(([, name, file]) => ({ name, file }));
        assert.ok(marked.some(({ name, file }) => name === "live-view" && file === "gif"), "the README's images were not read from scripts/images/stills.ts");
        assert.ok(marked.filter(({ file }) => file === "png").length <= 3, "the README shows more than three stills");
        const committed = marked.flatMap(({ name, file }) => [`${name}-dark.${file}`, `${name}-light.${file}`]).sort();
        const shown = [...readme.matchAll(/(?:src|srcset)="docs\/images\/([^"]+)"/g)].map(([, file]) => file).sort();
        assert.deepEqual(shown, committed, "the README does not show each image scripts/images/stills.ts marks for it, in light and dark");
        assert.deepEqual(readdirSync(join(repository, "docs/images")).sort(), committed, "docs/images/ holds an image the README does not show, or lacks one it does");
    });
});

describe("a root file's page", () => {
    test("drops the file's own first heading, which the page's title replaces", () => {
        assert.equal(pageBody("# Upgrading\n\nWhat to do.\n\n## 1.2.0\n\n# Not a title\n"), "What to do.\n\n## 1.2.0\n\n# Not a title\n");
    });

    test("changes with the root file", () => {
        assert.notEqual(pageBody("# Glossary\n\n**Machine**:\nA machine.\n"), pageBody("# Glossary\n\n**Machine**:\nA Decent espresso machine.\n"));
    });

    test("links to a page of the site by its address, and to anything else in the repository on GitHub", () => {
        const body = pageBody(
            [
                "# Upgrading",
                "[Upgrading](site/src/content/docs/self-hosting/upgrading.md#if-you-skipped-a-release), [the plugin](site/src/content/docs/reference/tablet-plugin.md),",
                "[ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md), [a site](https://example.com/x.md) and [below](#120).",
            ].join("\n"),
        );
        assert.equal(
            body,
            [
                "[Upgrading](../../self-hosting/upgrading/#if-you-skipped-a-release), [the plugin](../../reference/tablet-plugin/),",
                "[ADR-0025](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0025-each-release-runs-beside-the-previous-one.md), [a site](https://example.com/x.md) and [below](#120).",
            ].join("\n"),
        );
    });

    test("leaves a code block as it is written", () => {
        const block = "```md\n# A heading\n[A link](docs/x.md)\n```\n";
        assert.equal(pageBody(`# Title\n\n${block}`), block);
    });
});

describe("the documents that moved to the site", () => {
    const address = new RegExp(`\\]\\(${SITE}${ROOT_BASE}/([a-z-]+/[a-z-]+)/\\)`, "g");
    const linked = (file) => [...repositoryFile(file).matchAll(address)].map(([, page]) => page);

    test("leave a stub at the self-hosting document's path, linking to each Self-hosting page", () => {
        const pages = linked("docs/SELF-HOSTING.md");
        for (const page of [...SECTIONS[2][1], "get-started/invite-people"]) assert.ok(pages.includes(page), `the stub lacks ${page}`);
        for (const page of pages) assert.ok(PAGES.includes(page), `${page} is no page of the site`);
        assert.ok(repositoryFile("docs/SELF-HOSTING.md").split("\n").length < 25, "the stub holds more than its links");
    });

    test("leave a stub at the plugin document's path, linking to its three pages", () => {
        assert.deepEqual(linked("docs/PLUGIN.md"), ["get-started/install-the-plugin", "reference/tablet-plugin", "technical/skin-authors"]);
        assert.ok(repositoryFile("docs/PLUGIN.md").split("\n").length < 25, "the stub holds more than its links");
    });
});

describe("a page's canonical address", () => {
    test("replaces the minor release's path with the root's", () => {
        assert.equal(canonicalAtRoot("https://example.test/decent-sync/v1.13/guide/shots/", "/decent-sync/v1.13", "/decent-sync"), "https://example.test/decent-sync/guide/shots/");
        assert.equal(canonicalAtRoot("https://example.test/decent-sync/v1.13/", "/decent-sync/v1.13", "/decent-sync"), "https://example.test/decent-sync/");
    });

    test("leaves an address outside that path alone", () => {
        assert.equal(canonicalAtRoot("https://example.test/decent-sync/v1.130/", "/decent-sync/v1.13", "/decent-sync"), "https://example.test/decent-sync/v1.130/");
    });
});

describe("the link check", () => {
    /** A build of `pages`, each a path and its body, served at /docs. */
    function build(pages) {
        const dir = mkdtempSync(join(tmpdir(), "decent-sync-links-"));
        for (const [path, body] of Object.entries(pages)) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), `<!doctype html><html><body>${body}</body></html>`);
        }
        return dir;
    }
    const check = (pages) => {
        const dir = build(pages);
        try {
            return brokenLinks(dir, "/docs");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };

    test("passes links that resolve: relative, from the root, to a heading, to a file, to another site", () => {
        assert.deepEqual(
            check({
                "index.html": '<a href="guide/shots/">a</a> <a href="/docs/guide/shots/#find">b</a> <img src="/docs/a.png" srcset="/docs/a.png 1x, a.png 2x"> <a href="https://example.test/nowhere">c</a> <a href="mailto:someone@example.test">d</a>',
                "guide/shots/index.html": '<h2 id="find">Find</h2> <a href="../../">home</a> <a href="#find">here</a>',
                "a.png": "",
            }),
            [],
        );
    });

    test("fails a link to a page that is not there", () => {
        const problems = check({ "index.html": '<a href="guide/shot/">a</a>' });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /^index\.html: "guide\/shot\/" names no page or file/);
    });

    test("fails a link to a heading the page lacks", () => {
        const problems = check({ "index.html": '<a href="guide/#margins">a</a>', "guide/index.html": '<h2 id="find">Find</h2>' });
        assert.match(problems[0], /names no heading/);
    });

    test("fails a missing image", () => {
        assert.match(check({ "index.html": '<img src="/docs/missing.png">' })[0], /names no page or file/);
    });

    test("fails a link from the root that leaves the path the site is served at", () => {
        assert.match(check({ "index.html": '<a href="/guide/">a</a>', "guide/index.html": "" })[0], /leaves the site/);
    });

    test("fails a link to a page without its trailing slash", () => {
        assert.match(check({ "index.html": '<a href="guide">a</a>', "guide/index.html": "" })[0], /needs a trailing slash/);
    });
});

describe("the site in a browser", () => {
    let site;
    let browser;

    before(async () => {
        site = await serve(dist, base);
        browser = await chromium.launch();
    });

    after(async () => {
        await browser?.close();
        await site?.close();
    });

    /** Opens `path` in a window `width` wide with the device set to `scheme`. */
    async function open(path, width, scheme = "light") {
        const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: scheme });
        await page.goto(site.url + path);
        return page;
    }

    for (const scheme of ["light", "dark"]) {
        for (const [name, width] of [["a phone", 390], ["a desktop", 1360]]) {
            test(`shows the home page on ${name} in ${scheme} without scrolling sideways`, async () => {
                const page = await open("", width, scheme);
                assert.equal(await page.getAttribute("html", "data-theme"), scheme);
                await page.getByRole("heading", { level: 1, name: "Your Decent espresso machines, working as one." }).waitFor();
                for (const heading of ["What you get", "Who it's for", "Running in a few minutes.", "For developers"]) {
                    assert.ok(await page.getByRole("heading", { name: heading }).isVisible(), heading);
                }
                // A phone's page is the shorter one, without how it works.
                assert.equal(await page.getByRole("heading", { name: "How it works" }).isVisible(), width > 640);
                assert.ok(await page.getByText("docker compose up -d").isVisible());
                const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
                assert.ok(scrollWidth <= clientWidth, `the page is ${scrollWidth} wide in a window of ${clientWidth}`);
                await page.close();
            });
        }
    }

    test("leads from the home page to the quick start and the guide", async () => {
        const page = await open("", 1360);
        await page.getByRole("link", { name: "Get started" }).click();
        await page.getByRole("heading", { level: 1, name: "Quick start" }).waitFor();
        await page.goBack();
        await page.getByRole("link", { name: "Read the guide" }).click();
        await page.getByRole("heading", { level: 1, name: "Library and Recipes" }).waitFor();
        await page.close();
    });

    test("finds a page by a word of it", async () => {
        const page = await open("", 1360);
        await page.getByRole("button", { name: "Search" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByPlaceholder("Search").fill("Glossary");
        await dialog.getByRole("link", { name: "Glossary", exact: true }).first().click();
        await page.getByRole("heading", { level: 1, name: "Glossary" }).waitFor();
        await page.close();
    });

    test("switches between light and dark", async () => {
        const page = await open("guide/shots/", 1360, "light");
        const select = page.locator("header starlight-theme-select select");
        await select.selectOption("dark");
        assert.equal(await page.getAttribute("html", "data-theme"), "dark");
        await select.selectOption("light");
        assert.equal(await page.getAttribute("html", "data-theme"), "light");
        await page.close();
    });

    // Each of the generator's images is there twice, once a theme (Still.astro).
    test("shows each image in the site's theme, light or dark", async () => {
        const page = await open("", 1360, "light");
        const images = page.locator("img[data-still]");
        const shown = async () => {
            const themes = new Set();
            for (const image of await images.all()) if (await image.isVisible()) themes.add(`${await image.getAttribute("data-still")} ${await image.getAttribute("data-still-theme")}`);
            return [...themes].sort();
        };
        assert.deepEqual(await shown(), ["live-view light", "overview light"]);
        await page.locator("header starlight-theme-select select").selectOption("dark");
        assert.deepEqual(await shown(), ["live-view dark", "overview dark"]);
        await page.close();
    });

    test("lists a page's own headings, and every page in the sidebar", async () => {
        const page = await open("guide/shots/", 1360);
        assert.ok(await page.getByRole("heading", { name: "On this page" }).isVisible());
        const sidebar = page.getByRole("navigation", { name: "Main" });
        for (const [label] of SECTIONS) assert.ok(await sidebar.getByText(label, { exact: true }).isVisible(), label);
        assert.equal(await sidebar.getByRole("link", { name: "Shots and out of spec" }).getAttribute("aria-current"), "page");
        await sidebar.getByRole("link", { name: "Machines", exact: true }).click();
        await page.getByRole("heading", { level: 1, name: "Machines" }).waitFor();
        await page.close();
    });

    test("opens the sidebar from the menu on a phone", async () => {
        const page = await open("guide/shots/", 390);
        const sidebar = page.getByRole("navigation", { name: "Main" });
        assert.equal(await sidebar.getByRole("link", { name: "Glossary" }).isVisible(), false);
        await page.getByRole("button", { name: "Menu" }).click();
        await sidebar.getByRole("link", { name: "Glossary" }).click();
        await page.getByRole("heading", { level: 1, name: "Glossary" }).waitFor();
        await page.close();
    });
});

// The deploy's gh-pages branch in small: this build at its minor's path and,
// standing for a newer minor, at the root; an older minor with only a home
// page; and versions.json naming the three.
describe("the version selector", () => {
    const NEWER = "v99.0";
    const OLDER = "v0.1";
    let pages;
    let site;
    let browser;

    const listing = (...versions) => writeFileSync(join(pages, "versions.json"), JSON.stringify({ latest: versions[0], versions }));

    before(async () => {
        pages = mkdtempSync(join(tmpdir(), "decent-sync-pages-"));
        cpSync(dist, pages, { recursive: true });
        symlinkSync(dist, join(pages, current));
        mkdirSync(join(pages, OLDER));
        writeFileSync(join(pages, OLDER, "index.html"), `<!doctype html><title>${OLDER}</title><h1>The home page of ${OLDER}</h1>`);
        listing(NEWER, current, OLDER);
        site = await serve(pages, ROOT_BASE);
        browser = await chromium.launch();
    });

    after(async () => {
        await browser?.close();
        await site?.close();
        rmSync(pages, { recursive: true, force: true });
    });

    async function open(path, width = 1360) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        await page.goto(site.url + path);
        return page;
    }

    /** The header's selector, once it lists what versions.json holds. */
    async function selector(page, count) {
        const select = page.locator("header ds-version-select select");
        await page.waitForFunction((n) => document.querySelector("header ds-version-select select")?.options.length === n, count);
        return select;
    }

    test("lists the minors deployed, the latest first, and shows the one being read", async () => {
        const page = await open(`${current}/guide/shots/`);
        const select = await selector(page, 3);
        assert.ok(await select.isVisible());
        assert.deepEqual(await select.locator("option").allTextContents(), [NEWER, current, OLDER]);
        assert.equal(await select.inputValue(), current);
        await page.close();
    });

    test("opens the same page in the minor chosen, the latest at the root", async () => {
        const page = await open(`${current}/guide/shots/`);
        await (await selector(page, 3)).selectOption(NEWER);
        await page.waitForURL(`${site.url}guide/shots/`);
        await page.getByRole("heading", { level: 1, name: "Shots and out of spec" }).waitFor();
        await page.close();
    });

    test("opens the minor's home page where it has no such page", async () => {
        const page = await open(`${current}/guide/shots/`);
        await (await selector(page, 3)).selectOption(OLDER);
        await page.waitForURL(`${site.url}${OLDER}/`);
        await page.getByRole("heading", { level: 1, name: `The home page of ${OLDER}` }).waitFor();
        await page.close();
    });

    test("says on a page of an older minor that it is not the latest, and links to the latest", async () => {
        const page = await open(`${current}/guide/machines/`);
        const notice = page.locator("ds-older-release");
        await notice.waitFor();
        assert.match(await notice.innerText(), new RegExp(`documentation for ${current.replace(".", "\\.")}, which is not the latest release`));
        await notice.getByRole("link", { name: `Read this page for ${NEWER}` }).click();
        await page.waitForURL(`${site.url}guide/machines/`);
        await page.close();
    });

    test("says nothing of the latest on the latest minor's pages", async () => {
        listing(current, OLDER);
        try {
            const page = await open(`${current}/guide/shots/`);
            await selector(page, 2);
            assert.equal(await page.locator("ds-older-release").isVisible(), false);
            await page.close();
        } finally {
            listing(NEWER, current, OLDER);
        }
    });

    test("works from the menu at phone width", async () => {
        const page = await open(`${current}/guide/shots/`, 390);
        await selector(page, 3);
        assert.equal(await page.locator("header ds-version-select select").isVisible(), false);
        await page.getByRole("button", { name: "Menu" }).click();
        const select = page.locator("ds-version-select select:visible");
        assert.equal(await select.inputValue(), current);
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
        assert.ok(scrollWidth <= clientWidth, `the page is ${scrollWidth} wide in a window of ${clientWidth}`);
        await select.selectOption(NEWER);
        await page.waitForURL(`${site.url}guide/shots/`);
        await page.close();
    });
});
