# DYE2 v0.1.32 and Streamline `main` at cec5664 on Decaid v0.9.1

What DYE2 v0.1.32 does otherwise than v0.1.26, where it touches what Decent
Sync writes and records, recorded as `../dye2-v0.1.26/` records the rest:
each request a page or the recording script sent to DYE2's keys in Decaid's
store, DYE2's `selection`, `record` and `save-recipe` routes, Streamline's
remembered values, and the Workflow, and the status and body Decaid answered,
its JSON parsed. Requests the script sent stand for the plugin's, or for
anything else on the tablet changing the Workflow. They were recorded for
decent-sync #371.

DYE2 v0.1.32 does everything `../dye2-v0.1.26/` shows but where these files
show otherwise. Between the two, `dye2-plugin/src/` changed in what Decent
Sync relies on only where this README says (What they show, below): the rest
of the diff is the dashboard's recipe rail and dial arrows, the recipe sort by
ratings, Select Recipe's assign mode (which Streamline at cec5664 does not
open), saving a recipe from a Shot's edit page, and the retired stored
selection's code removed. Its equipment and baskets pages save as 2cf631c's
did (`../dye2-2cf631c/`): `createEquipment`, `updateEquipment`,
`deleteEquipment`, `createBasket` and `updateBasket` in `utils/dev-api.ts` did
not change.

A step is `{exchanges, after, pushes, events, timing}`, as in
`../dye2-v0.1.26/`: its exchanges (of the reads, on DYE2's dashboard and
Select Recipe only those of `selection` and `recipes`, on Streamline only
those of `selection` and DYE2's stored mirror of it); `after`, reads made
2.5 s after the step, once DYE2 has followed the change; `pushes`, what DYE2's
`changed` socket heard meanwhile; `events`, the `context` of each Workflow
Decaid sent plugins in a `workflowUpdated` meanwhile, heard through
`../dye2-v0.1.26/workflow-recorder/`; and `timing`, when each push and event
came, in ms from the step's start. In `editor.json` a step is `{opened, form,
exchanges}`: what the editor's form showed of the strip as it opened and once
changed (`activeTab`, the `data-slot` of the tab it targets, null for none,
and `showOnStreamline`, whether its "Show on Streamline Dashboard" switch is
on), and the exchanges of its SAVE. The same shorthands as `../dye2-v0.1.26/`
keep the files small: a read answering what the last read or post of its
route in the file did is `"unchanged": true`, and outside `library.json` a
whole profile is `{"$profile": "<title>/<hash>"}`, its copy in
`library.json`'s `profileCopies`. A profile's hash is of its JSON, so one
profile in two key orders has two copies.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made, as `../dye2-v0.1.26/library.json` does (two beans, a batch of each, the grinder `Fixture Grinder 64`, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, the simulated machine's settings), the bundled DYE2 (v0.1.31) and its migration flags as it left them on the empty store (`bundledFlags`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `seeded`: DYE2's keys and the Workflow as Decent Sync's server and an earlier DYE2 left them, written from the script (below), and read back. `install`: `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}`, its answer and when it came (`answeredAtMs`), `GET /plugins` after, every key of DYE2's and the Workflow read seven times over 6 s from the moment the install was sent (`reads`, each with `atMs`), and the Workflows plugins were sent meanwhile |
| `plugins.json` | The install's exchange, and DYE2's entry in `GET /plugins` (version `0.1.32`, `source` the release) |
| `applies.json` | DYE2's dashboard: `pillsShown`, the recipes its rail showed (not a step); `batchSet`, the Ethiopia's batch from the script; `applyWithBean`, recipe `1`'s pill (the Ethiopia, no batch); `batchSetAgain`; `applyNoBean`, recipe `2`'s (no Bean); `batchSetBeforeSelect`; `selectNoBean`, recipe `3` (no Bean, no slot) picked on Select Recipe and confirmed. Then decentespresso/dye2#38: `applyBeforeProfileEdit`, recipe `1`'s pill; `recordProfileEdited`, its record rewritten from the script with its profile's first step at 6 s, as Decent Sync's server wrote it (in `jsonb`'s key order); `reapplyEdited`, its pill again; `recordInDecaidOrder`, the record rewritten with its profile's first step at 7 s, in Decaid's key order; `ownProfileSameId`, that profile written into the Workflow from the script with the same `recipeId`, one PUT; `applyBeforeJsonbOrder`, its pill; `recordInJsonbOrder`, the record rewritten at 8 s in `jsonb`'s order; `ownProfileJsonbOrderSameId`, that profile written with the same `recipeId`; `applyBeforeOtherProfile`, its pill; `otherProfileSameId`, `Classic Italian espresso` written with the same `recipeId` |
| `streamline.json` | Streamline's DYE strip: `started`, its page load; `cells`, the names its five buttons showed (not a step); `batchSet`; `applyNoBeanFromStrip`, recipe `2`; `applyWithBeanFromStrip`, recipe `1`; `clearButton`, "Clear button" on recipe `1`, a long press and its menu item, with the menu's labels (`menu`); `cellsAfterClear`; and `dashboardPillsAfterClear`, the recipes DYE2's dashboard then showed |
| `recording.json` | `select`, recipe `2`'s pill on DYE2's dashboard; then one Workflow change from the script per step, each followed by `POST /plugins/dye2.reaplugin/record`: `grindText` (`"1.5."`), `grindWord` (`"fine"`), `grindNumber` (`"2.75"`), `batchPicked` (the Ethiopia's batch) |
| `save-recipe.json` | `beanCleared`, the Workflow's batch, coffee and roaster written null from the script; then `POST /plugins/dye2.reaplugin/save-recipe` from the script: `noBean` (`{}`), `withBeverage` (`{"beverage":"Fixture Latte"}`) |
| `editor.json` | DYE2's recipe editor (`recipe-edit?id=` or `?new=1`): `saveCleared`, recipe `1`, which "Clear button" hid, its dose set to 18.2; `saveHiddenInSlot`, recipe `4`, seeded hidden in slot 4, its dose set to 18.8; `hideSlotted`, recipe `2`'s "Show on Streamline Dashboard" switched off; `slotHidden`, recipe `4`'s tab 4 tapped; `newWithoutBean`, `Fixture New No Bean` on tab 5, empty, with no Bean, `Adaptive v3`, the Grinder, dose 18 and yield 36; `grindText`, `grindWord` and `grindNumber`, recipe `3`'s grind typed as `1.5.`, `fine` and `2.75` |
| `keys.json` | Not exchanges: DYE2's recipes, baskets and stored selection at the end, and its six migration flags |

## How they were recorded

They were recorded on 2026-10-29 by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1+3027`,
commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container as
`../dye2-v0.1.26/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account` with its simulated machine and scale, its
clock in UTC and its data new, container port 8080 published to the host's
`localhost:8080`.

- **The bundled DYE2.** Decaid v0.9.1 bundles DYE2 v0.1.31, which loaded as
  Decaid first started and ran its migrations on the empty store, setting
  `selectionMigrated`, `recipesMigrated`, `favSlotsMigrated` and
  `favProfilesMigrated` (`library.json`, `bundledFlags`), as on a tablet that
  ran v0.1.26.
- **The seeded keys.** With it running, the script writes two baskets and
  five recipes: `1` (the Ethiopia, slot 1), `2` (no Bean, slot 2) and `3` (no
  Bean, no slot), each as Decent Sync's server wrote one before #371 (its
  fields at the paths `recipeRecord` writes, a profile in `jsonb`'s key order,
  an embedded Workflow with no flags and, naming no Bean, no coffee, roaster
  or batch, and a made-up global id); `4` (the Brazil), in slot 4 but hidden,
  as "Clear button" leaves a recipe the server wrote; and a recipe naming no
  Bean with an opaque id, in no slot, as DYE2 v0.1.26's editor saved one. And
  the Workflow on the Ethiopia's batch.
- **DYE2** v0.1.32 is the latest release, so the script installs it with
  `POST /api/v1/plugins/install/github-release {"repo":"decentespresso/dye2"}`
  over the bundled one: the release asset `dye2.reaplugin-v0.1.32.zip`
  (SHA-256 `d06de87922f182186372f73dbd7c25203bb88aa8216c58aa933c3c26b7c13544`,
  as GitHub lists it), whose installed `plugin.js` (SHA-256
  `bf223187572fc14f08abbae4bce342e0f43a63f1f3084a7e59493ce0665c8487`) is byte
  for byte the `dist` branch's at `7765e78`, which deploys it.
- **Streamline** at cec5664 is served and switched to its DYE strip as for
  `../dye2-v0.1.26/`.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium as `../dye2-v0.1.26/record.mjs` does, from the repository root:
  `node server/test/fixtures/decaid/dye2-v0.1.32/record.mjs <output dir>`. It
  restarts no Decaid and pulls no Shot. It reads `DECAID` and `SKIN` from the
  environment for other addresses. The run recorded here was the second on a
  fresh Decaid; the first stopped at the editor, its profile chip for
  `Classic Italian espresso` not shown, and its profile edits set a pressure
  on `Adaptive v3`'s flow steps, which Decaid drops, so changed no profile.

## Edits

Everything named (beans, batches, grinder, baskets, recipes, beverage) was
made up for the recording; the profiles are Decaid's bundled ones. The
simulated machine reports serial `mock-de1` and names no real hardware, so
nothing is scrubbed. DYE2's `createdAt` and `capturedAt` are UTC. As recorded,
the files were compacted as `../dye2-v0.1.26/` describes (`compactAll`).
Nothing else was changed.

## What they show

- **Loading** (`loading.json`). Decaid answered the install within a second,
  and by the read at 1.5 s DYE2 had run the one migration v0.1.32 adds to the
  recipes (`clearBeanlessRecipeWorkflows` in
  `dye2:dye2-plugin/src/utils/recent-favs.ts`): recipes `2`, `3` and the one
  from the editor, naming no Bean, hold `coffeeName`, `coffeeRoaster` and
  `beanBatchId` null in their embedded Workflow's context, no flag added; `1`
  and `4` are as seeded, `4` still in slot 4 and hidden. It set
  `recipeBeansMigrated` and `favBeansMigrated`. Nothing else changed, and the
  Workflow was not written.
- **A recipe naming no Bean clears the Workflow's** (`applies.json`,
  `streamline.json`; DYE2 `ce38984`). DYE2's dashboard applies it with
  `coffeeName`, `coffeeRoaster` and `beanBatchId` null, flagged null in
  `extras.dye` (`applyNoBean`); so does Select Recipe (`selectNoBean`), and
  Streamline's strip, which PUTs the stored Workflow as it is
  (`applyNoBeanFromStrip`); after each, the Workflow names no batch. A recipe
  naming a Bean and no batch clears the batch as before (`applyWithBean`).
- **A recipe applied again on its own profile keeps its id**
  (`applies.json`; decentespresso/dye2#38, `e5e1120`). DYE2 clears
  `recipeId` once the Workflow's profile moves off the one it took when the id
  appeared, but no longer where the profile that arrives is the recipe's own,
  by `profileFingerprint` of the profile its record holds
  (`recipeProfileChanged`), and takes that one as the new baseline. The
  fingerprint keeps each step's keys in the order the record holds them: in
  Decaid's order the profile is the recipe's own (`ownProfileSameId`, kept);
  in `jsonb`'s, as Decent Sync's server writes a record, it is another
  (`reapplyEdited`, `ownProfileJsonbOrderSameId`, cleared), so the Workflow's
  profile, in Decaid's order, never matches a record the server wrote.
  Another profile clears it as before (`otherProfileSameId`).
- **On the strip exactly while in a slot** (`editor.json`,
  `streamline.json`; DYE2 `f88ace0`). The editor opens a recipe hidden from
  the strip on no tab, its switch off, whatever its `stripSlot`
  (`stripTargetOf` in `utils/recipe-strip.ts`), and saves it with `stripSlot`
  null (`saveCleared`, `saveHiddenInSlot`): `updateRecipe` nulls the slot of
  any row it saves hidden. Switching the switch off releases the tab
  targeted, so the recipe is saved hidden in no slot (`hideSlotted`), and
  tapping a tab turns it on (`slotHidden`). Streamline's "Clear button" still
  posts the recipes with that one's `showOnStreamlineDashboard` false and its
  `stripSlot` kept (`clearButton`), and DYE2 rewrites nothing until its editor
  next saves it; the strip and DYE2's dashboard both leave it out
  (`cellsAfterClear`, `dashboardPillsAfterClear`).
- **A new recipe naming no Bean** (`editor.json`, `newWithoutBean`) is saved
  with the three null in its embedded Workflow and flagged null in
  `extras.dye` (`buildRecipeWorkflow` in `utils/dev-api.ts`).
- **Grind settings as typed** (`recording.json`, `editor.json`; DYE2
  `d858b73`). `record` saves the Workflow's `grinderSetting` as a number where
  it reads as one and otherwise as the text, trimmed (`grindValue` in
  `utils/workflow-record.ts`): `"1.5."` and `"fine"` as text, `"2.75"` as
  2.75. The editor keeps text typed into its grind field as typed, and shows a
  number typed to a tenth, saving `2.75` as 2.8. A batch picked is saved into
  no recipe (`batchPicked`, `saved: false`).
- **`save-recipe`** (`save-recipe.json`) names a recipe from the profile's
  first word, the Workflow's bean, and a beverage the caller gives, and adds
  the day where there is no bean (`Classic 29 Oct`, `Classic Fixture Latte 29
  Oct`, `proposeRecipeName`), and keeps the beverage in the row, `""` for
  none. A Workflow naming no Bean gives a row with no coffee, roaster or batch
  keys in its embedded Workflow at all, as `GET /workflow` leaves out a null.
- **The machine's settings, read at most once a minute** (decentespresso/dye2#40,
  `ec73c81`): `record` no longer reads `GET /machine/settings` itself, and
  `readMachineSettings` keeps a successful read for 60 s (`MACHINE_TTL_MS`),
  dropping it as a recipe is applied and whenever the Workflow's
  `rinseData` moves. Decaid's log of the run shows DYE2 reading them once as
  `recording.json`'s `select` applied recipe `2`, then not at all for the four
  `record` calls over the next 8 s. The simulated machine keeps no flush
  temperature written to it (`MockDe1.setFlushTemperature` does nothing), so a
  flush temperature set on the machine within the minute, which DYE2 then
  misses, could not be recorded.
