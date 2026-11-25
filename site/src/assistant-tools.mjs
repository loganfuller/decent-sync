// The Assistant tools page of the Reference: every tool the server's MCP
// endpoint offers an assistant, with the description the server gives the
// assistant itself. It has no Markdown file. It is written as the site is
// built, from the server's own tool definitions (server/src/mcp/tools.ts,
// `toolDefinitions`), read from the compiled server, so no list of tools is
// kept by hand and the page can't drift from what the server offers
// (docs/DEVELOPMENT.md, The documentation site).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The compiled module that lists the server's tools, which `npm run build -w server` makes. */
const COMPILED = fileURLToPath(new URL("../../server/dist/mcp/tools.js", import.meta.url));

export const TOOLS_PAGE = {
    id: "reference/assistant-tools",
    title: "Assistant tools",
    description: "Every MCP tool an assistant can call, with what it does.",
};

/**
 * Every tool the server offers, as the server declares it, in the order
 * declared. Read in a Node process of its own, since the compiled server is
 * no part of the site's build and loads NestJS and the database client.
 *
 * @returns {{ name: string, title: string, description: string, readOnly: boolean }[]}
 */
export function readTools() {
    if (!existsSync(COMPILED)) {
        throw new Error(
            "The Assistant tools page is written from the compiled server, which is not built. Run `npm run build -w protocol && npm run build -w server` first, or `npm run build:site`, which does.",
        );
    }
    const read = "const { toolDefinitions } = await import(process.argv[1]); process.stdout.write(JSON.stringify(toolDefinitions()));";
    const tools = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", read, pathToFileURL(COMPILED).href], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
    if (!Array.isArray(tools) || tools.length === 0) throw new Error("The compiled server lists no tools for the Assistant tools page.");
    return tools;
}

const escaped = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** Text as one line of an HTML block: a blank line would end the block and hand the rest to Markdown. */
const cell = (text) => escaped(text.trim()).replace(/\s*\n\s*/g, "<br>");

/** A table of tools, as HTML, so that nothing in a description is read as Markdown or ends a cell. */
function table(tools) {
    const rows = tools.map(({ name, title, description }) => `<tr><td><code>${cell(name)}</code><br>${cell(title)}</td><td>${cell(description)}</td></tr>`);
    return ["<table>", "<thead><tr><th>Tool</th><th>What it does</th></tr></thead>", "<tbody>", ...rows, "</tbody>", "</table>"].join("\n");
}

/**
 * The page's body, in Markdown: the tools that read, then the tools that
 * change, each in a table of its name, its title and its description.
 *
 * @param {{ name: string, title: string, description: string, readOnly: boolean }[]} tools
 * @returns {string}
 */
export function toolsBody(tools) {
    const reading = tools.filter((tool) => tool.readOnly);
    const changing = tools.filter((tool) => !tool.readOnly);
    return [
        `An assistant works with Decent Sync through the tools on this page, ${tools.length} in all: ${reading.length} that read and ${changing.length} that change something. They are what the server's MCP endpoint offers a Connected App. [Assistants](../../guide/assistants/) covers connecting one and what it may do as you, and [On the internet](../../self-hosting/internet/#assistants) covers what the server needs and how to turn assistants off.`,
        "This page is written from the server's own tool definitions each time the site is built, so it lists exactly the tools of the release it documents. Each description is the one the server gives the assistant, word for word. It is written for the assistant to read, so it names the fields of its answers and other tools as the assistant sees them. The words in capitals are defined in the [Glossary](../../reference/glossary/).",
        "Every tool acts as the person who approved the app, within what their account may do: where a description says Admins only, the tool refuses anyone else's app. Every answer is kept to a size an assistant can read whole, so a list comes a page at a time.",
        "## Tools that read",
        "Any Connected App may call these, whether it was approved to read only or to read and change.",
        table(reading),
        "## Tools that change something",
        "Only an app approved to read and change may call these, and only for an Admin or Staff. A Viewer's app is refused each of them.",
        table(changing),
    ].join("\n\n");
}

/**
 * Wraps a loader of the site's pages to add the Assistant tools page to the
 * same collection, as `withRootPages` adds the Glossary.
 *
 * @param {import("astro/loaders").Loader} docs
 * @returns {import("astro/loaders").Loader}
 */
export function withAssistantTools(docs) {
    return {
        name: `${docs.name}-with-assistant-tools`,
        async load(context) {
            await docs.load(context);
            const { id, title, description } = TOOLS_PAGE;
            const body = toolsBody(readTools());
            const filePath = "../server/src/mcp/tools.ts";
            const data = await context.parseData({ id, data: { title, description }, filePath });
            const digest = createHash("sha256").update(body).digest("hex");
            context.store.set({ id, data, body, filePath, digest, rendered: await context.renderMarkdown(body) });
        },
    };
}
