# AI Web Notes

Conventions of the management interface (`web/`) that no single file states.

## Components

- Add shadcn/ui components with `npx shadcn add`, which writes them to `web/src/components/ui/` (`web/components.json`).

## Page width

- Every page is at most 1152 px wide, and a Draft's alone grows to 1600 px, the header with it (`web/src/pages/Shell.tsx`).
- From a 1500 px window a Draft's steps and Trial Shots are a rail left of the graph, and under it in a narrower one (`web/src/pages/DraftPage.tsx`).

## Profile graph

- What the graph writes in its plot is placed by `web/src/lib/profile-graph-layout.ts` (`clearest`, `placeLabels`, `besideLine`, `movedLeft`) against what is already there: other text, the curves, and a Draft's handles, their tags and the bracket (`handleBox`, `placeTags`). Text added to the plot goes through it too, rather than at a fixed place.
- A handle's tag is HTML over the graph, sized and placed by `placeTags`; the bracket's sits in the gap under the pressure lane, as the band names and outcomes fill the margin above the plot.
- `graphClashes` (`e2e/support/graph-text.ts`) lists each piece of the graph's text drawn over another, or under a handle, its tag or the bracket; a spec that draws a new state of the graph expects it empty.

## Phone width

- Every page fits a phone's width, which `e2e/phone-width.spec.ts` checks.
- A table's bordered wrapper that is a grid item takes `min-w-0`, so the table scrolls in its own container rather than widening the page.

## MCP parity

- The Overview reads only what the REST API already gives, so the MCP endpoint has no tool of its own for it.
