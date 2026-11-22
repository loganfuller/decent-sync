# AI Web Notes

Conventions of the management interface (`web/`) that no single file states.

## Components

- Add shadcn/ui components with `npx shadcn add`, which writes them to `web/src/components/ui/` (`web/components.json`).

## Page width

- Every page is at most 1152 px wide, and a Draft's alone grows to 1600 px, the header with it (`web/src/pages/Shell.tsx`).
- From a 1500 px window a Draft's steps and Trial Shots are a rail left of the graph, and under it in a narrower one (`web/src/pages/DraftPage.tsx`).

## Phone width

- Every page fits a phone's width, which `e2e/phone-width.spec.ts` checks.
- A table's bordered wrapper that is a grid item takes `min-w-0`, so the table scrolls in its own container rather than widening the page.

## MCP parity

- The Overview reads only what the REST API already gives, so the MCP endpoint has no tool of its own for it.
