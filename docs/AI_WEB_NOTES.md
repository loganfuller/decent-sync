# AI Web Notes

Conventions of the management interface (`web/`) that no single file states.

## Components

- Add shadcn/ui components with `npx shadcn add`, which writes them to `web/src/components/ui/` (`web/components.json`).
- A message of what came of something asked of a Machine, shown where it was asked (a Software Action's, a Settings Edit's), is a `StatusAlert` (`web/src/components/status-alert.tsx`): pending ones have no close button, a plain success goes by itself after 8 s unless hovered, focused or its tab is hidden, and the rest stay until dismissed.

## Naming a Bean Batch

- A page names a Bean Batch through `web/src/lib/batch-name.ts` and `web/src/components/batch-name.tsx` alone, never by joining its Bean and roast date itself (#732).
- The forms are in a line (`BatchInLine`), in a table's cell or over any second line (`BatchCell`), where its Bean is already said (`BatchOfBean`), and in words (`batchWords`), for a dialog, an option of a select and an accessible name.
- A date Decaid recorded as a day is written by `recordedDayText`, which reads the day from its text, so no time zone moves it; `recordedDayWithYear` where the date is itself the value shown.
- The day is as the browser's locale writes one, "17 Nov" or "Nov 17", as `dayText` writes a weight line's.

## Pure modules

- A module in `web/src/lib/` imports another by a relative path (`./batch-name`): Vitest's `web` project resolves no `@/` alias at run time, and only types come through `@/lib/api`.

## Page width

- Every page is at most 1152 px wide, and a Draft's alone grows to 1600 px, the header with it (`web/src/pages/Shell.tsx`).
- From a 1500 px window a Draft's steps and Trial Shots are a rail left of the graph, and under it in a narrower one (`web/src/pages/DraftPage.tsx`).

## Profile graph

- What the graph writes in its plot is placed by `web/src/lib/profile-graph-layout.ts` (`clearest`, `placeLabels`, `besideLine`, `movedLeft`) against what is already there: other text, the curves, and a Draft's handles, their tags and the bracket (`handleBox`, `placeTags`). Text added to the plot goes through it too, rather than at a fixed place.
- A handle's tag is HTML over the graph, sized and placed by `placeTags`; the bracket's sits in the gap under the pressure lane, as the band names and outcomes fill the margin above the plot.
- The axes' numbers keep clear of what is drawn near them: a lane writes as many values as fit at its height without touching (`laneTicks`), a Draft's point handles stand inside the plot (`pointInPlot`), the lanes' values end `LANE_VALUES_GAP` left of the plot, clear of a bracket on its edge, and the cup row's names are held right of them.
- `graphClashes` (`e2e/support/graph-text.ts`) lists each piece of the graph's text drawn over another, or under a handle, its tag or the bracket; a spec that draws a new state of the graph expects it empty.

## Tabs

- A link that replaces part of a page, as a Machine page's tabs do, passes its click to what `useKeptScroll` (`web/src/lib/use-kept-scroll.ts`) returns, so the page doesn't shrink under a reader scrolled down while the new part loads.
- The component that calls `useKeptScroll` is held on Back and Forward too, with nothing passed: the hook notes where each history entry was scrolled while the component is mounted, and holds the page that tall in the render that returns to one.

## Phone width

- Every page fits a phone's width, which `e2e/phone-width.spec.ts` checks.
- A table's bordered wrapper that is a grid item takes `min-w-0`, so the table scrolls in its own container rather than widening the page.
- A Library item's History keeps its Changed column at least 16 rem wide (`CHANGED`, `web/src/components/item-history.tsx`), so in a narrow card the table scrolls sideways rather than breaking each value to a letter a line.
- Below `md` (`useNarrowScreen`, `web/src/lib/use-screen.ts`) a Machine's Software tab renders lists in place of its tables, and its buttons at the default size. At either width a row keeps the same buttons (approving a plugin's update, its settings, making a Skin the default) and has the rest in a menu at its end (#678), whose dialogs open from `ConfirmDialog` or with their state held by the menu (`useMenuDialog`), and a row with nothing for the menu has none; `expectTabFits` in `e2e/phone-width.spec.ts` checks nothing in its cards reaches past them or scrolls sideways.

## MCP parity

- The Overview reads only what the REST API already gives, so the MCP endpoint has no tool of its own for it.
