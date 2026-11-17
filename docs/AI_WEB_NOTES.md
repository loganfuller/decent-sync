# AI Web Notes

Conventions of the management interface (`web/`) that no single file states.

## Components

- Add shadcn/ui components with `npx shadcn add`, which writes them to `web/src/components/ui/` (`web/components.json`).

## Phone width

- Every page fits a phone's width, which `e2e/phone-width.spec.ts` checks.
- A table's bordered wrapper that is a grid item takes `min-w-0`, so the table scrolls in its own container rather than widening the page.

## MCP parity

- The Overview reads only what the REST API already gives, so the MCP endpoint has no tool of its own for it.
