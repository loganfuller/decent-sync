# DYE2 `main` at 2cf631c's equipment and baskets pages on Decaid v0.9.0

What DYE2's equipment page (its tools) and baskets page write to Decaid's
store as a barista uses them, recorded as exchanges: each request the page
sent to `/store/dye2.reaplugin/equipment` or `/store/dye2.reaplugin/baskets`,
and the status and body Decaid answered, its JSON parsed. They were recorded
with the rest of DYE2 at 2cf631c and Streamline at c006dac; the rest was
replaced by `../dye2-v0.1.26/` for decent-sync #216, which records neither
page. DYE2 v0.1.26 saves both as 2cf631c did: between the two, its
`pages/equipment.ts` and `pages/baskets.ts` changed only in their styles,
and `createEquipment`, `updateEquipment`, `deleteEquipment`, `createBasket`
and `updateBasket` in `utils/dev-api.ts` not at all.
`server/test/support/simulated-dye2.ts` replays them (`dye2PagesRecording`,
`dye2PagesKeys`, `saveInDye2`), and `server/test/simulated-dye2-writes.test.ts`
checks the replay against them.

A step is the list of exchanges of one action on the page, all the page's
reads of that route kept.

| File | What it holds |
|---|---|
| `tools.json` | DYE2's equipment page: `createWdtTool` with two fields, `createPuckScreen` with one, `createSpareTamper` with none, `editWdtTool` changing a field's value, and `deleteSpareTamper` |
| `baskets.json` | DYE2's baskets page: `create18gBasket` with every field, `create20gBasket` without notes, and `edit18gBasket` changing its notes and diameter |

## How they were recorded

They were recorded on 2026-10-16 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container: Xvfb as its
display, a D-Bus system bus and Avahi running, started as `xvfb-run -a
dbus-run-session -- decaid --serial --bypass-onboarding --no-account` with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
and its clock in UTC. Its data was new, as on a fresh install.

- **DYE2** at 2cf631c, its built plugin at `dye2:dye2.reaplugin/` at that
  commit, was copied into Decaid's
  `~/.local/share/decaid/plugins/dye2.reaplugin/` before Decaid first
  started, so Decaid kept it over its bundled v0.1.4.
- **The script**, `record.mjs`, drove the pages in Playwright's headless
  Chromium (1280x800), each request a page sent fetched by Playwright and its
  answer handed to the page unchanged:
  `node server/test/fixtures/decaid/dye2-2cf631c/record.mjs <output dir>`.
  It recorded the other files, now removed, too, with the throwaway plugin
  `workflow-recorder/` installed; for these two files only the pages were
  driven.

## Edits

Everything named (baskets and tools) was made up for the recording. DYE2's
`createdAt` is UTC, set by the browser. Nothing else was changed.

## What they show

- Every save reads the list and posts it whole. A new item gets an id from
  `crypto.randomUUID()` and `createdAt` now; an edit keeps the item's id and
  `createdAt` (`updateEquipment`, `updateBasket`); a deleted tool is left out
  of the list posted (`deleteEquipment`); and a new tool whose name the list
  holds already, in any case, is not written (`createEquipment`).
