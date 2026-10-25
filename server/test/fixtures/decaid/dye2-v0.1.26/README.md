# DYE2 v0.1.26 and Streamline `main` at cec5664 on Decaid v0.9.0

What DYE2 and Streamline write to Decaid as a barista uses them, how DYE2
names the recipe being dialled in (`context.extras.dye.recipeId` in the
Workflow), when it clears it, and what its `record` and `save-recipe` routes
write, recorded as exchanges: each request a page or the recording script
sent to DYE2's keys in Decaid's store (`/store/dye2.reaplugin/recipes`,
`baskets`, `equipment`, `selection`, `autoFavourites`), DYE2's `selection`,
`record` and `save-recipe` routes, Streamline's remembered values
(`/store/streamline-app/*`), the Workflow and single Shots, and the status
and body Decaid answered, its JSON parsed. Requests the script sent stand for
the plugin's, or for anything else on the tablet changing the Workflow. They
replace `../dye2-2cf631c/` for decent-sync #216.

Two kinds of step. In `recipes.json` a step is the list of exchanges of one
save on DYE2's recipe editor, all the page's reads of those routes kept but
DYE2's favourites (which hold whole Shots' Workflows). Everywhere else a step
is `{exchanges, after, pushes, events, timing}`: its exchanges (of the reads,
on DYE2's dashboard and Select Recipe only those of `selection` and
`recipes`, on Streamline only those of `selection` and DYE2's stored mirror of
it); `after`, reads made 2.5 s after the step, once DYE2 has followed the
change (any of `GET /plugins/dye2.reaplugin/selection`, `GET
/store/dye2.reaplugin/selection`, `GET /store/dye2.reaplugin/recipes`, `GET
/workflow`, in that order); `pushes`, what DYE2's `changed` socket heard
meanwhile; `events`, the `context` of each Workflow Decaid sent plugins in a
`workflowUpdated` meanwhile, heard through `workflow-recorder/`; and
`timing`, when each push and event came, in ms from the step's start. A step
that restarts Decaid hears nothing while the sockets are closed.

Two shorthands keep the files small (Edits, below). A read whose answer is
the same as the last one of that route read or posted before it in the same
file, in document order, keeps its status and `"unchanged": true` in place
of its `body`: reads of `GET /store/dye2.reaplugin/recipes` and `GET
/workflow`, and in `loading.json`'s snapshots each of DYE2's keys and the
Workflow (`{"unchanged": true}`). And outside `library.json`,
`fingerprints.json` and `restart.json`, which keep every profile whole, a
whole profile is `{"$profile": "<title>/<hash>"}`, its one copy in
`library.json`'s `profileCopies` under that name.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made: two beans, `Fixture Ethiopia` and `Fixture Brazil`, a batch of each, the grinders `Fixture Grinder 64` and `Fixture Grinder 83`, the bundled profiles the recipes use (`Adaptive v3`, `Classic Italian espresso`), Decaid's default Workflow, the simulated machine's settings and the bundled DYE2 (v0.1.4) as `GET /plugins` listed it. Then, after `recipes.json`: DYE2's recipes and baskets and the Workflow (`workflowAfterEditor`). And `profileCopies`, the one copy of each profile the other files name by `$profile` |
| `store.json` | Decaid's store before anything wrote DYE2's keys: `GET` of `recipes`, never written (`null`); `POST []` (`{}`); `GET`; `DELETE` (`{}`); `GET` (`null`); `DELETE` again (`{}`) |
| `loading.json` | `seeded`: DYE2's keys and the Workflow as DYE2 before v0.1.25 left them, written from the script (below), and read back. `install`: `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}`, its answer and when it came (`answeredAtMs`), `GET /plugins` after, every key of DYE2's and the Workflow read ten times over 6 s from the moment the install was sent (`reads`, each with `atMs`), and the Workflows plugins were sent meanwhile |
| `plugins.json` | The install's exchange, DYE2's entry in `GET /plugins` (version `0.1.26`, `source` the release), its `selection` and its `skin` route |
| `recipes.json` | DYE2's recipe editor (`recipe-edit?new=1` or `?id=`): `newInEmptySlot`, `Fixture Slot Recipe` saved on tab 5, empty (Bean, `Adaptive v3` from the library, Grinder, Basket, dose 18, yield 36, brew 92, steam by time 30, flush 5, hot water by temperature 85, grind 2.5, RPM 900); `newInNoSlot`, `Fixture Library Recipe` with no tab, its profile read from the Workflow (`Classic Italian espresso`), Bean, Grinder, Basket, dose 19, yield 38, brew 93, steam by flow 1.2, flush 4, hot water by volume 150, grind 3, RPM 1100; `moveToHeldSlot`, the library recipe given tab 1, which recipe `1` holds (SAVE, then SAVE again on its "REPLACE … ON 1?"); `takeOffStrip`, the slot 5 recipe's active tab tapped off; `editFields`, the library recipe's dose 19.5 and grind 3.2; `hideFromStreamline`, recipe `3`'s "Show on Streamline Dashboard" switched off; `saveMachineSettings`, the slot recipe's steam temperature 150, milk stop 60, hot water time 30 and flow 4, flush temperature 90 and flow 6; `steamOff`, its steam temperature set by the `Off` preset; `newFromFavouriteEditor`, the Auto Favourites page's add card, only a title typed, SAVE TO RECIPE |
| `shot.json` | `dashboard`: the library recipe applied on DYE2's dashboard (`applied`), the Brazil batch set from the script (`batchSet`), Decaid restarted, a Shot pulled (`pulled`), the Shot read (`shot`) and DYE2's favourites after (`favourites`, the recent one the Shot made). `streamline.pulled`: the Shot `streamline.json`'s `shotPulled` stored |
| `dye2-applies.json` | `applyInSlot`, the library recipe's pill (slot 1) on DYE2's dashboard; `applyFromSelectRecipe`, recipe `1` (no slot) picked on Select Recipe and confirmed; `applyFavourite`, the recent favourite's pill; `applyBeforeEdit`, the library recipe's pill again; `editSelected`, its grind set to 3.3 in DYE2's editor while it is selected |
| `dashboard.json` | DYE2's dashboard (decentespresso/dye2#31): `applyInSlot`; `writtenElsewhere`, a `PUT /workflow` from the script after the page read the Workflow (the Ethiopia batch, the 18g Basket, a hot water volume of 90); `dialTap`, the grind `+`; `done` |
| `recording.json` | `select`, the library recipe's pill; then one Workflow change from the script per step, each followed by `POST /plugins/dye2.reaplugin/record`: `dose`, `yield`, `grind`, `rpm`, `basket`, `brewTemperature` (every step 1 degree up), `steamHeld` (flow), `hotWaterHeld` (volume), `flushHeld` (duration), `notHeldMoved` (hot water temperature 75 to 80, which the recipe does not hold), `notHeldNotMoved` (hot water flow written at its apply-time value), `steamOff` (steam temperature 0 with a steam flow of 1.6), `steamBackOn` (steam temperature 150), `steamTimeZero` (steam duration 0), `clearedValue` (grind null), `anotherBatch`, `anotherGrinder`, `twiceInARow` (a dose, then `record` twice) and `nothingSelected` (`recipeId` null, then `record`) |
| `unloads.json` | The library recipe selected on the dashboard, then from the script: `profileChange` (`Adaptive v3` whole); `selectAgain`; `sameProfileWrittenBack` (the Workflow's own profile); `targetWeightOnly`; `anotherBatch`; `anotherGrinder`; `batchAndGrinderBack`; `newProfileWithSameRecipeId` (`Adaptive v3` and the same `recipeId` in one PUT); `selectBeforeTwoPuts`; `twoPuts` (`recipeId: null`, then `Adaptive v3` with the recipe's `recipeId`); `profileChangeAfterTwoPuts` (`Classic Italian espresso`); `selectAdaptive`, recipe `1` (`Adaptive v3`, whose steps hold limiters of value 0) from Select Recipe; `limiterZeroAsNull`, its profile written with those limiters null, as Streamline sends it; `limiterZeroWritten`, written back with them |
| `restart.json` | The library recipe selected (`select`); `disableEnable` (`POST .../disable`, `.../enable`, the selection read at once and 3 s on); `decaidRestart`; `decaidRestartRecordChanged`, the recipe's record rewritten from the script with its profile's last step at 8.5 bar while DYE2 runs, then Decaid restarted (`recordRestoredAfterDecaidRestart` puts it back); `disableEnableAfterRestart`; `recordProfileChangedWhileAway`, the same record change made while DYE2 is disabled (`recordRestored`); `selectBeforeLiveChange` and `liveProfileChangedWhileAway`, `Adaptive v3` written while DYE2 is disabled; `reapplyAfterLiveChange`, the recipe's pill tapped then; `selectBeforeRecordAfterRestart`, `reloadBeforeRecord` and `recordAfterRestart` (dose 21, brew 1 degree up, milk stop 60, then `record`); `selectBeforeChangeWhileAway` and `recordChangedWhileAway` (dose 21.5, brew 1 degree up and milk stop 65 written while DYE2 is disabled, then `record` once it is back) |
| `save-recipe.json` | `POST /plugins/dye2.reaplugin/save-recipe` from the script: `intoEmptySlot` (`{"slot":5}`), `intoHeldSlot` (`{"slot":4}`), `noSlot` (`{}`) |
| `streamline.json` | `freeSlot5`, DYE2's editor taking the recipe in slot 5 off the strip (exchanges only); Streamline's DYE strip: `started`, its page load; `applyFromStrip`, recipe `2` (Grinder and Basket held); `doseTile`, the Dose tile's `+`; `saveChanges`, `saveToEmptyCell` ("Save to recipe 5" on the blank fifth button), `replaceFilledCell` ("Replace <name>" on the fourth) and `clearButton` ("Clear button" on recipe `2`, applied again in `applyBeforeClear`), each a long press and its menu item, with the menu's labels (`menu`); after a Decaid restart, `restarted`, the page loaded again; `applyBeforeShot`, the library recipe from the strip; `writtenBeforeShot`, a barista, drinker and note from the script; `shotPulled`; then `steamTimeZero`, `heaterOff` and `heaterOn`, called through the page's own module |
| `fingerprints.json` | Not exchanges: after each load (`dashboardInSlot`, `selectRecipeNoSlot`, `streamlineStrip`, `streamlineStripLibraryRecipe`), the Workflow's profile as the last `workflowUpdated` carried it, as `GET /workflow` answered it, the recipe record's `workflow.profile` and `profileSnapshot`, the fingerprint of each by v0.1.26's `profileFingerprint` (ported in `record.mjs`), and whether the record's matches the Workflow's |
| `keys.json` | Not exchanges: DYE2's keys at the end, its four migration flags included |

## How they were recorded

They were recorded on 2026-10-24 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, SHA-256
`b76e64c89792cc3d7101ba211ecb81040fe353a46d353c7b0e73374f193970df`, as
`decaid-0.9.0-SHA256SUMS.txt` names it; `GET /info` answers
`0.9.0+2977`, commit `b9f9d055`), run headless in a throwaway Ubuntu 24.04
container: Xvfb as its display, a D-Bus system bus and Avahi running, started
as `xvfb-run -a dbus-run-session -- decaid --serial --bypass-onboarding
--no-account` with `~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected, and its clock in UTC. Its
data was new, as on a fresh install. Container port 8080 was published to the
host's `localhost:8080`, since Streamline calls Decaid at its page's host on
port 8080.

- **DYE2** v0.1.26 is the latest release, so the script installs it with
  `POST /api/v1/plugins/install/github-release {"repo":"decentespresso/dye2"}`
  over the bundled v0.1.4, after seeding DYE2's keys (below): the release
  asset `dye2.reaplugin-v0.1.26.zip` (SHA-256
  `89822886f48f45729003e903a46dbd2a2e2f99186296a0876c7a1b0b9c68fe81`, as
  GitHub lists it; its `plugin.js` is byte for byte `dye2:dye2.reaplugin/plugin.js`
  at the tag, only its manifest's version differs: `0.1.26`, not `0.1.24`).
  `GET /api/v1/plugins` lists it loaded as version `0.1.26`, `source`
  `{"kind":"github_release","releaseTag":"v0.1.26",…}`.
- **The seeded keys.** Before the install the script writes, as DYE2 before
  v0.1.25 left them (shapes from the 2cf631c recording): two baskets; recipes
  `1` (`Adaptive v3` by `profileId`), `2` (`Classic Italian espresso` as a
  `profileSnapshot`, Grinder and Basket) and `3` (a name only) with no
  `stripSlot`; `4` with none and a `capturedAt` older than a recipe with an
  opaque id holding `stripSlot` 4, as a v0.1.25 editor saves one; a
  `suggested: true` row in slot 5; the stored selection of recipe `2`, armed;
  and the Workflow with recipe `2` applied and `context.extras.dye.selection`
  `{"kind":"recipe","id":"2"}`.
- **The Workflow recorder**, `workflow-recorder/` beside this README, a
  throwaway plugin that pushes each `workflowUpdated` payload on its own
  `workflow` socket, is installed by the script with `PUT
  /api/v1/plugins/workflow-recorder.reaplugin/source` and enabled. It ran only
  in that Decaid.
- **Streamline** at cec5664 is its repository's files at that commit (`git
  archive cec5664`), served as static files at `http://localhost:13999/`, its
  DYE strip turned on, showing recipes, by setting `streamline.dye2Enabled`
  to `true` and `streamline.dyeStripMode` to `R` in the page's local storage
  before it loaded. Its long-press menu is a pointer held 900 ms on a strip
  button (Streamline's long press is 500 ms) and the menu item clicked. The
  steam tile's time and the heater switch are `setTargetSteamDuration(0)` and
  `setSteamHeaterEnabled(false|true)` called through the page's own module
  (`streamline-js:src/modules/api.js`), as its tile and its Settings switch
  call them; driving the numpad and the Settings page was not needed for
  what they write.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (1280x800 for DYE2, 1920x1200 for Streamline) and keeps sockets
  open on DYE2's `changed` endpoint (from the install on) and the recorder's,
  from the repository root: `RESTART_DECAID=<command> node
  server/test/fixtures/decaid/dye2-v0.1.26/record.mjs <output dir>`. Each
  request a page sends is fetched by Playwright and its answer handed to the
  page unchanged. Before each Shot it runs the command `RESTART_DECAID` names,
  which restarted Decaid in the container keeping its data, as the earlier
  recordings found the simulated machine storing only the first Shot after a
  start; Shots are pulled with `PUT /api/v1/machine/state/espresso`, and
  those requests are not in the files. It reads `DECAID` and `SKIN` from the
  environment for other addresses. The run recorded here was the third on a
  fresh Decaid; the second, before `restart.json`'s steps were completed,
  gave the same answers, selections and event counts in every other file.

## Edits

Everything named (beans, batches, grinders, baskets, recipes, beverage,
barista, drinker and note) was made up for the recording; the profiles are
Decaid's bundled ones. The simulated machine reports serial `mock-de1` and
names no real hardware, so nothing is scrubbed. The Shots' measurements are
trimmed to their first, last, peak-pressure and peak-flow samples, in their
order. DYE2's `createdAt` and `capturedAt` are UTC, set by the browser or by
DYE2; the Shots' `timestamp` is Decaid's local time without an offset, which
was UTC.

As recorded the files came to 7.3 MB, mostly whole `recipes` lists and
profiles read again unchanged. The script's last pass (`compactAll` in
`record.mjs`; `record.mjs <dir> --compact` applies it to files already
written) replaced each answer that repeated the last one in its file with
`"unchanged": true`, and each whole profile outside `library.json`,
`fingerprints.json` and `restart.json` with a `$profile` reference to its
copy in `library.json`'s `profileCopies` (eight distinct profiles: the two
bundled ones at the brew temperatures, target weights and limiters
recorded). `store.json` is left as recorded. Nothing else was removed.

## What they show

- **Loading** (`loading.json`). Decaid answered the install in under 1 s,
  and by the next read 50 ms later DYE2 had done everything its first load
  does: `migrate()` (`dye2:dye2-plugin/src/plugin.ts`) stored `selection` as
  `{}` and wrote `{"context":{"extras":{"dye":{"selection":null}}}}` into
  the Workflow, one `workflowUpdated` within 20 ms of the answer, leaving the
  key in the Workflow as `null` from then on (every later event carries
  `selection: null`); `migrateRecipes` wrote `recipes` once, rows `1`, `2`,
  `3` taking `stripSlot` 1, 2, 3 (`migrateRecipeSlots` in
  `dye2:dye2-plugin/src/utils/recent-favs.ts`), the `suggested` row dropped
  (`dropSuggestedRecipes`), and of the two rows on slot 4 the newer
  (`capturedAt`) kept it while `4` got `stripSlot: null`
  (`dedupeRecipeSlots`); and it stored `selectionMigrated`,
  `recipesMigrated`, `favSlotsMigrated` and `favProfilesMigrated`, all
  `true`, beside new `autoFavourites` and `shotIndex` keys. No other row
  changed, and nothing was pushed before the socket could open.
- **Recipe ids and slots** (`recipes.json`). The editor saves a new recipe
  under `crypto.randomUUID()` (`initRecipeEdit` in
  `dye2:dye2-plugin/src/pages/recipe-edit.ts`, `newId` in
  `dye2:dye2-plugin/src/utils/dev-api.ts`), with `stripSlot` the tab
  targeted, or `null` for none (`updateRecipe`). Every save posts the whole
  list. A tab another recipe holds asks for a second SAVE, then
  `takeSlot` sets the holder's `stripSlot` to `null` in the same post, its
  `capturedAt` untouched (`moveToHeldSlot`). Tapping the active tab saves
  `stripSlot: null` (`takeOffStrip`). Switching "Show on Streamline
  Dashboard" off saves `showOnStreamlineDashboard: false` and keeps the slot.
  Each save changes only the fields edited (`recipeChanges`) and rebuilds
  the embedded `workflow` (`buildRecipeWorkflow`), and bumps `capturedAt`.
  A mode switch parks the other mode's shown value, so the new slot recipe
  also holds `steamFlowMls` 0.8 and `hotWaterMl` 75, the form's defaults.
  The Machine Settings are saved as in the 2cf631c recording, `Off` as
  `steamTempC: 0` with `steamSettings.targetTemperature` 0 in the embedded
  `workflow`.
- **DYE2 no longer saves favourites.** The Auto Favourites page's add card
  opens `auto-fav-edit`, whose SAVE TO RECIPE saves a recipe through
  `updateRecipe` (`dye2:dye2-plugin/src/pages/auto-fav-edit.ts`), in no slot
  and with neither `showOnStreamlineDashboard` nor a whole profile: only
  `profileTitle`, so its embedded `workflow` holds no profile and an apply
  sends none (`newFromFavouriteEditor`). The only favourites left are the
  recents DYE2 computes from Shots (`shot.json`'s `favourites`).
- **DYE2's dashboard apply** (`dye2-applies.json`, `dashboard.json`) reads the
  Workflow again and sends only what differs from it
  (`workflowPatch`/`pushWorkflow` in `dye2:dye2-plugin/src/pages/dashboard.ts`):
  the recipe's values, its profile at its brew temperature (only the keys
  that differ, the `steps` whole), `beanBatchId` null for a recipe naming a
  Bean but no batch, the machine settings it holds as partial parts, and
  `context.extras.dye.recipeId` (`setRecipeId`), sent only when the Workflow
  did not already name it. It still never applies the Basket, so recipe `1`
  read `modified: true` straight after its apply from Select Recipe, its
  Basket being another (`applyFromSelectRecipe`). Select Recipe applies a
  recipe in no slot the same way, through `dye_selectedRecipeId` and the
  dashboard's load. A recent favourite's pill sends `recipeId: null`
  (`applyAutoFavourite`), and `GET /selection` then answers the recent,
  `{"kind":"favourite","id":"recent:…","modified":false,"auto":true}`.
- **Editing the selected recipe** in DYE2's editor applies it again
  (`reapplyIfSelected`): the save, then the saved record's whole embedded
  `workflow` as a `PUT /workflow`, then `POST /selection` with its id, the
  compatibility route, which writes `recipeId` again; two events, both
  naming it, and it stays selected, `modified: false` (`editSelected`).
- **A dial tap and Done over a change made elsewhere** (`dashboard.json`):
  the tap sends `{"context":{"grinderSetting":"3.4"}}` alone and Done sends
  nothing, so the batch, Basket and hot water written from the script stand
  (dye2#31 fixed). Another batch kept `recipeId`; the selection reads
  `modified: true` for the Basket.
- **`GET /selection`** is derived on every call: `{kind,id,modified}` for the
  recipe `recipeId` names, `null` when it names none and no favourite matches,
  `modified: true` while a field the recipe holds differs
  (`recipeModified` in `dye2:dye2-plugin/src/utils/workflow-record.ts`). A
  cleared grind does not count as different (`clearedValue` answers
  `modified: false`). DYE2 mirrors it to the `selection` key and pushes
  `{"what":"workflow"}` only when it changes.
- **`record`** (`recording.json`, `handleRecord` and `recordWorkflow`). It
  answers `{"saved":true|false,"kind":"recipe","id":…}`, or
  `{"saved":false,"reason":"no recipe is selected"}` with no `recipeId`. It
  writes into the recipe every field it holds that the Workflow holds
  otherwise (`itemPatch`), not only the one just changed: the `dose` step
  saved the dose and the 18g Basket left by `writtenElsewhere`, so `basket`
  then saved nothing. Dose, yield, grind, RPM, Basket (id and name together),
  steam flow, hot water volume and flush duration were each written into
  `dashboardVariables` and the embedded `workflow`. The brew temperature was
  written once it moved off its apply-time value (94 from 93), the embedded
  profile shifted with it but its `target_weight` left at 36 while the yield
  is 40. A hot water temperature the recipe did not hold was adopted once it
  moved off its apply-time value (`notHeldMoved`); one written at that value
  was not (`notHeldNotMoved`). With steam off (temperature 0) nothing of
  steam was written, the steam flow 1.6 sent with it included, and that flow
  was written by the next `record` once steam was back on (`steamBackOn`).
  A steam time of 0 with steam on was adopted as `steamTimeS: 0`, the
  embedded `steamSettings.duration` 0 (`steamTimeZero`). A cleared grind,
  another batch and another grinder wrote nothing and kept `recipeId`. A
  second `record` with nothing changed answers `saved: false`. `record` never
  changes `capturedAt`, and each saving call pushes two or three times.
- **What clears `recipeId`** (`unloads.json`, `workflowChanged` and
  `idProfileChanged`): a profile change by the fingerprint, 10 to 15 ms after
  the change's event DYE2 writes `{"context":{"extras":{"dye":{"recipeId":null}}}}`,
  a second event, then one push (`profileChange`); and a PUT of another
  profile carrying the same `recipeId` (`newProfileWithSameRecipeId`). Kept:
  the same profile written back, a change of only `target_weight`, another
  batch, another grinder, and a profile whose value-0 limiters are written as
  null, or back as `{value:0}` (`limiterZeroAsNull`, `limiterZeroWritten`).
  `recipeId: null` then the new profile with the recipe's id keeps it, with
  the new profile as DYE2's baseline: `profileChangeAfterTwoPuts`, back to
  `Classic Italian espresso`, the recipe's own, cleared it (`twoPuts`).
- **Restarts do not run DYE2's restart check** (`restart.json`). This
  contradicts the issue and the design notes. After `disableEnable`,
  `decaidRestart` and `disableEnableAfterRestart` the recipe stayed selected,
  as expected, its record's profile being the live one. But it also stayed
  selected after its record's profile was changed (last step 8.5 bar) and
  Decaid restarted (`decaidRestartRecordChanged`), after the same change
  while DYE2 was disabled (`recordProfileChangedWhileAway`), and after
  `Adaptive v3` was written into the Workflow while DYE2 was disabled
  (`liveProfileChangedWhileAway`, now `modified: true`). Decaid dispatches a
  `workflowUpdated` with the current Workflow to a plugin as it loads it
  (`loadPlugin` in `decaid:lib/src/plugins/plugin_manager.dart`), and that
  event's `workflowChanged`, not cold, runs before the cold one `onLoad`
  starts after reading `GET /workflow`: with no baseline it skips the check
  and takes the live profile as the baseline, so the cold call compares the
  live profile with itself. Decaid's log shows DYE2 reading `recipes` twice
  and `/machine/settings` once after each load, and never writing the
  Workflow. So after a restart DYE2's baseline is the Workflow as it found
  it: tapping the recipe's own pill then (`reapplyAfterLiveChange`, the
  profile going back to `Classic Italian espresso` under the same id)
  cleared `recipeId`, decentespresso/dye2#38's case.
- **`record` after a restart** has that baseline: a dose, brew temperature and
  milk stop changed after the reload were all written, the brew temperature
  and the milk stop (not held) having moved off their values at the reload
  (`recordAfterRestart`); changed while DYE2 was away, the dose and the milk
  stop (held since the step before) were written but not the brew
  temperature, which was the baseline already (`recordChangedWhileAway`,
  `modified: true` after).
- **`save-recipe`** (`save-recipe.json`, `handleSaveRecipe`) answers `{id,
  name}`, the id `recipe-<base-36 time><4 random>`, the name proposed from
  the profile and the drinks (`Classic Americano`, then with the bean and a
  counter, `proposeRecipeName`), and appends a row with `stripSlot` the
  `slot` sent or `null`; the slot's previous holder keeps its row with
  `stripSlot: null`. The row holds every field the Workflow holds (all the
  steam, hot water and flush settings, the flush temperature and flow from
  `GET /machine/settings`), Grinder, Bean by name with no `beanId`, the
  profile as `profileSnapshot` and `workflow.profile`, and no
  `showOnStreamlineDashboard`. Then DYE2 writes `{"v":1,"recipeId":…}` into
  the Workflow, one event, and pushes. It read `modified: true` at once on
  this Decaid only: its `flushTempC` is the simulated machine's 25
  (`MockDe1.setFlushTemperature` does nothing), the Workflow's 90.
- **Streamline's strip** (`streamline.json`). The page load wrote only its
  favourite profiles, nothing of the Workflow (`started`; `restarted` also
  rewrote its last hot water volume, 100 then 150). Applying recipe `2`
  remembers its steam, hot water and flush values, PUTs its embedded context,
  Grinder and Basket included (no `assertDeclaredFields` error), its profile
  whole, the machine settings of its modes and `extras.dye`
  `{"v":1,"recipeId":"2"}` (`applyRecipe` and `mergeContext` in
  `streamline-js:src/modules/dyeStrip.js`, `recipeIdPatch` in
  `src/modules/dye-selection.js`), then still `POST /selection
  {"kind":"recipe","id":"2"}`, which writes `recipeId` again: two events. The
  Dose tile sends `{"context":{"targetDoseWeight","targetYield"},"profile":{"target_weight"}}`,
  which keeps `recipeId`. The selected cell's menu is "Edit in DYE2", "Save
  changes", "Replace <name>", "Clear button"; a blank cell's is "Save to
  recipe 5" only. "Save changes" is a bare `POST /record` (`saved: true`, the
  dose written). "Save to recipe 5" and "Replace <name>" are `POST
  /save-recipe {"slot":5}` and `{"slot":4}`, each selecting the new recipe.
  "Clear button" posts the whole `recipes` with that recipe's
  `showOnStreamlineDashboard: false`, its slot kept (`clearCell`), then,
  being the selected cell, `POST /selection {}`, which writes `recipeId: null`
  (`clearSelection`).
- **A Shot with Streamline open** (`shotPulled`): Streamline's only write was
  `{"context":{"extras":{"note":null}}}`, 24 s after the pull, once the Shot
  was stored (`streamline-js:src/modules/app.js`); `recipeId`, the batch, the
  Grinder, the Basket, the barista and the drinker stayed. The stored Shot's
  Workflow carries `context.extras.dye.recipeId`, the note and
  `selection: null` (`shot.json`), as does the Shot pulled after a Decaid
  restart with the recipe applied on DYE2's dashboard.
- **Streamline's steam** (`steamTimeZero`, `heaterOff`, `heaterOn`): a steam
  time of 0 is `{"steamSettings":{"duration":0}}`, the heater untouched;
  switching the heater off remembers the temperature and sends
  `{"steamSettings":{"targetTemperature":0}}`; on, it reads DYE2's stored
  `selection` and sends the selected recipe's steam temperature, or the
  remembered one (150 here; the library recipe holds none). None of them
  calls `record`, and `recipeId` stays.
- **Fingerprints** (`fingerprints.json`). After each load, from DYE2's
  dashboard, Select Recipe and Streamline's strip, the profile the
  `workflowUpdated` carried, the one `GET /workflow` answered and the
  record's embedded `workflow.profile` (and `profileSnapshot` where it has
  one) are equal by DYE2's fingerprint, and equal as JSON too: Decaid keeps
  a profile as sent, limiters of value 0 included.
