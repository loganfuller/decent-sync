---
status: accepted
---

# Every MCP response keeps within a size budget

An assistant reads a tool's result whole only if its client takes it inline, so every tool of the MCP endpoint (ADR-0026) keeps its response within a budget that Claude and ChatGPT take inline: **45,000 characters** of one compact JSON copy of the response, as `@nestjs/mcp` serializes it (`JSON.stringify`), whatever the tool's options. Defaults aim at 15,000 to 20,000, which the follow-ups of milestone 6 that change each tool's shape work towards: a page of 20 Recipes is about 27,000 today. One guard, shared by every tool (`BudgetedTool` in `server/src/mcp/budget.ts`, declared in place of `@Tool`), measures each response after serializing it, and only a response over the cap is changed:

- **Free text is cut first,** the longest first and no shorter than it must be, but never shorter than 200 characters. Each cut string ends in `…[cut]`, and a `cut` note, first in the response, says so and how to have more of it, such as asking without curves. A tool that changes something refuses a value holding `…[cut]`, so an assistant that read a field cut, such as a Bean's notes read with its history, can't save the cut text over the whole.
- **Then each page ends sooner,** every page of the response at the same number of entries, and at least one, with `more: true`. A page's `offset` is unchanged, so the next starts at its offset plus its length.
- **Structured data is never cut:** ids, a Profile's steps wherever they are, and the parts a tool names, a Machine's Machine Settings and Tablet Settings and a Settings Edit's values, which are settings to read and set again. Any other string is free text, a Profile's notes inside its content included. A single item that can't fit even with its text cut is returned as it is then, and logged as a warning.

Every tool also declares `_meta: { "anthropic/maxResultSizeChars": 100000 }` in `tools/list`, so a slight overrun stays inline in Claude Code. Every page serializes `total`, `offset` and `more` before its list, so a client that cuts the end of a result keeps them.

**The clients, as checked on 2026-11-08.** Claude and ChatGPT are the clients the budget is for.

- **Claude Code** keeps a text result inline up to 50,000 characters, or up to a tool's `_meta["anthropic/maxResultSizeChars"]`, at most 500,000, and saves a longer one to a file; it warns above 10,000 tokens ([Claude Code, MCP output limits and warnings](https://code.claude.com/docs/en/mcp#mcp-output-limits-and-warnings); the override came in 2.1.91). A `find_shots` page of 50 Shots of one morning at Roux was 56,851 characters, which it saved to a file.
- **claude.ai** takes about 150,000 characters, as found while designing #431; it publishes no figure.
- **ChatGPT** publishes no limit. It cuts a long result silently at a line boundary, and shows the model both `structuredContent` and the text block. Logan chose not to measure where it cuts, so its limit is recorded as unknown.
- **Codex CLI** (about 40 KB, cutting out the middle), **Gemini CLI** (40,000 characters, [gemini-cli#19365](https://github.com/google-gemini/gemini-cli/pull/19365)) and **VS Code Copilot** (to a file above 8 KiB) will cut or spill the larger results: an accepted trade-off. The Codex and VS Code figures were found while designing #431; neither publishes one.

**Both copies stay.** Tools keep returning `structuredContent` and the JSON text block, which doubles what is sent but not what the budget counts: the MCP client libraries validate a result against its output schema, and code-mode clients type it from it.

**Where meanings live.** Most clients never show an output schema to the model: Claude Code, VS Code and Codex give it the serialized `structuredContent`, and Anthropic's tool definitions have no place for one. So what a model needs to read a result correctly goes in the tool's description, or in the data itself, never only in an output schema's descriptions: a Shot's `temperature` curve is the group temperature, its duration and peaks leave out the Preheat, each `stopReason` Decaid records means what the description says. What every tool shares, such as units and how a cut response reads, is in the server's instructions too (`server/src/mcp/instructions.ts`), but each description stands on its own, as not every client shows those.

## Considered Options

- **Sending one copy, `structuredContent` or the text block.** It would halve what is sent, but client libraries validate against the output schema and code-mode clients type from it, while clients without either read only the text. Rejected.
- **Truncating the serialized text at the cap.** Invalid JSON, and it loses a page's paging fields. Rejected.
- **A budget per tool.** One cap is enough to reason about, and a tool that runs small keeps well under it. Rejected.
- **Ending pages first, cutting text only for a lone entry.** A page of hostile names would hold two or three entries; cutting text first keeps the entries, which an assistant reading a list needs more than every character of a long note, and a smaller `limit` brings back the rest. Rejected.
- **Relying on `anthropic/maxResultSizeChars` alone,** set high. Only Claude Code honors it. Rejected: it covers a slight overrun there.

## Consequences

- **A new tool is declared with `BudgetedTool`,** naming the parts of its response that are structured data and how to have more of what it cuts. `server/test/assistants.test.ts` checks that every tool declares `_meta`, which only `BudgetedTool` adds.
- **`server/test/assistant-budget.test.ts` runs every read tool** at its largest options on realistic data and on hostile data, through `Assistant.callWithinBudget`. A change to what a tool returns adds its assertions there.
- **A tool may cut text of its own** to keep each entry of a list small, as `find_shots` cuts the names people type beyond about 60 characters and a Shot's notes beyond about 200 (#437). Its cuts end in `…[cut]` and it gives the same `cut` note first; the guard, shortening such a response further, gives the note again only where what it keeps still holds cut text. Since a cut name matches nothing, `find_shots` refuses a filter holding `…[cut]`, as a change is refused.
- **A page may hold fewer than `limit`.** The tools' descriptions say so, and to continue from its offset plus its length.
- **Two lists within one item aren't pages:** a Bean's Bean Batches in `get_library_item` and a Machine's refused changes in `get_machine`. The guard can't shorten them, so past about 85 batches or 150 refusals the item is returned whole and logged. A later change to those tools' shapes can page them.
- **ADR-0025:** this changes only the MCP tools' output, metadata and refusals, so a call that reaches the previous release during a deploy may get its larger response once.
