# DYE2 `main` at 2cf631c and Streamline `main` at c006dac on Decaid v0.9.0

What DYE2 and Streamline write to Decaid as a barista uses them, and how DYE2
keeps its selected recipe, records into it and marks the Workflow with it,
recorded as exchanges: each request a page or the recording script sent to
DYE2's keys in Decaid's store (`/store/dye2.reaplugin/recipes`, `baskets`,
`equipment`, and `selection`, DYE2's own storage), DYE2's `selection`
endpoint, Streamline's remembered values (`/store/streamline-app/*`), the
Workflow and single Shots, and the status and body Decaid answered, its JSON
parsed. Requests the script sent stand for the plugin's, or for anything else
on the tablet changing the Workflow. `server/test/support/simulated-dye2.ts`
and `simulated-streamline.ts` simulate DYE2 and Streamline from them;
`server/test/simulated-dye2-writes.test.ts` and
`simulated-dye2-selection.test.ts` check them against these files.

Two kinds of step. In `tools.json`, `baskets.json`, `recipes.json` and
`shot.json` a step is the list of exchanges of one action on a DYE2 page, all
the page's reads of those routes kept; `shot.json`'s `pulled` and `edited`
are each a single read of the Shot. In the other files a step is `{exchanges,
after, pushes, events}`: its exchanges, of the reads only those of DYE2's
selection (and, on DYE2's dashboard, of its recipes, Streamline's of DYE2's
stored selection); `after`, reads made once DYE2 would have recorded (2.5 s
after the step, past DYE2's 1.5 s wait); `pushes`, what DYE2's `changed`
socket heard meanwhile; and `events`, the `context` of each Workflow Decaid
sent plugins in a `workflowUpdated` meanwhile, heard through
`workflow-recorder/`. An event can arrive just after its step's window: the
one of the Workflow change made before `selectWithBatch` arrived within it.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made, before DYE2's pages were used: two beans, `Fixture Ethiopia` and `Fixture Brazil`, a batch of each, the grinders `Fixture Grinder 64` and `Fixture Grinder 83`, the bundled profiles the recipes use, Decaid's default Workflow (`workflow`) and the simulated machine's settings (`machineSettings`, from `GET /machine/settings`). Then, as the selection's steps began (`plugins.json` onwards): DYE2's recipes and baskets, the id of a saved favourite with only its title typed, the Workflow (`selectionWorkflow`) and DYE2's stored selection (`storedSelection`, `{}`) |
| `store.json` | Decaid's store, sent from the host, before DYE2 wrote anything: `GET` of `recipes`, never written, which answers `null`; `POST` of an empty list, which answers `{}`; `GET`; `DELETE`, which answers `{}`; `GET`, `null` again; `DELETE` again, of a key it no longer holds, which answers `{}` |
| `tools.json` | DYE2's equipment page: `createWdtTool` with two fields, `createPuckScreen` with one, `createSpareTamper` with none, `editWdtTool` changing a field's value, and `deleteSpareTamper` |
| `baskets.json` | DYE2's baskets page: `create18gBasket` with every field, `create20gBasket` without notes, and `edit18gBasket` changing its notes and diameter |
| `recipes.json` | DYE2's recipe editor: `saveSlot1` (name, beverage, barista, drinker, Bean, `Adaptive v3` from the library, Grinder, Basket, two Tools, one with a value of its own, dose 18, yield 36, brew temperature 92, steam by time 30, flush 5, hot water by temperature 85, grind 2.5, RPM 900); `saveSlot2` with its Profile read from the Workflow (`Classic Italian espresso`), then a name, Bean, Grinder, Basket, one Tool, dose 19, yield 36, steam by flow 1.2, flush 4, hot water by volume 150, grind 3, RPM 1100; `editSlot1` changing its dose to 18.5, grind to 2.7 and hot water temperature to 88; and `saveBlankSlot3`, only its name typed. The Machine Settings section was left blank |
| `dye2-applies.json` | DYE2's dashboard: `applySlot1`, `applySlot2`, `applyBlankSlot3` and `applySlot1Again`, tapping each recipe's pill on a dashboard opened afresh, and `pickBasket`, picking `Fixture 20g High-flow` for the next Shot |
| `shot.json` | `pulled`: the Shot then pulled, read with `GET /shots/{id}`. DYE2's Edit Shot page: `openEditShot`, `pickShotBasket` choosing `Fixture 18g Precision`, and `saveShot` adding both Tools, one with a value of its own; `edited`: the Shot read again |
| `keys.json` | Not exchanges: DYE2's three keys as `GET` answered them after `shot.json`'s steps |
| `plugins.json` | `GET /api/v1/plugins`, DYE2's entry only, and its `selection` while loaded (`loaded`); after `POST .../disable` (`disabled`), with the selection, its store key and an attempt to open the `changed` socket; after `POST .../enable` (`enabled`), with what the socket opened before the disable heard |
| `dashboard.json` | DYE2's dashboard: `applySlot1`; `writtenElsewhere`, a `PUT /workflow` from the script, as the plugin's load write would make, of the other bean's batch, a Basket and a hot water volume; `dialTap`, a tap of the grind `+`; `done`; `applyRecent`, the recent favourite a Shot pulled with a batch made; `applySavedFavourite`, the saved favourite chosen on the Auto Favourites page and applied as the dashboard opens; and `clear`, `POST .../selection {}` from the script |
| `recording.json` | `select`, slot 1 applied on the dashboard, then one change of the Workflow per step from the script: `grind`, `dose`, `yieldInContext`, `brewTemperature` (every step 1 degree up), `hotWaterActiveMode` and `hotWaterOtherMode`, `steamActiveMode` and `steamOtherMode`, `flush`, `debounced` (two grinds 300 ms apart), `echo` (the grind set off the recipe's, then slot 1 selected from the script, then a change within 3 s), `afterEcho`, `profileChange`; slot 1 applied again, then `targetWeightOnly` (its profile with only `target_weight` changed), `rpm` (`extras.rpm`), `basket` (`extras.basketId` and `basketName`), `machineSettingAdopted` (the steam temperature, which slot 1 does not hold), `batchFromEmpty` (a batch set, none having been armed) and `batchSwitch` (the other batch); slot 1 applied again, then `grinderSwitch` (the other grinder); a batch set and the grinder cleared, then `selectWithBatch`, slot 1 selected from the script, and `batchCleared`; and, after a restart and slot 2 applied on the dashboard, `shot`, a Shot pulled |
| `restore.json` | `clearBeforeRestore`, `POST .../selection {}`; `storedAfterClear`, DYE2's stored selection then; `restoreEmpty`, `restoreRecipe` and `restoreDrifted`: a value written to `POST /store/dye2.reaplugin/selection`, then DYE2 disabled and enabled, and its selection read ten times at once and again 1.5 s later; `driftedClearedOnChange`, a Workflow change after the drifted restore |
| `streamline.json` | Streamline's DYE strip, nothing selected in DYE2: `started`, what Streamline wrote as its page loaded; `applySlot2`; `drinkTile` and `doseTile`, a tap of each tile's `+`; `applySlot2Again`; after a restart, `restarted`, the page loaded again; `writtenBeforeShot`, a batch, coffee, Basket, barista, drinker and note written from the script; `shotCleared`, a Shot pulled with Streamline open; `wake`, `loadProfileForWake` called on the selected recipe's profile, and `wakeOtherProfile`, on `Adaptive v3`; after a restart and the page loaded again, `writtenBeforeShotNoSelection` and `shotClearedNoSelection`, the same with nothing selected; `selectedOnDashboard`, slot 1 applied on DYE2's dashboard; `applyRetried`, slot 2 applied on the strip with its first two selections answered 503 by the recording (`injected` on those answers); `applySlot2BeforeOff`; and `stripOff`, its DYE2 switch turned off |
| `fingerprints.json` | Not exchanges: after each recipe selected (`dashboardSlot1`, `dashboardSlot2`, `streamlineSlot2`), the Workflow's profile as the last `workflowUpdated` event carried it to plugins, as `GET /workflow` answered it, and the `profileFingerprint` DYE2 answered |

## How they were recorded

They were recorded on 2026-10-16 by Decaid's v0.9.0 Linux arm64 release
(`decaid-linux-arm64-0.9.0.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container: Xvfb as its
display, a D-Bus system bus and Avahi running, started as `xvfb-run -a
dbus-run-session -- decaid --serial --bypass-onboarding --no-account` with
`~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected, and its clock in UTC. Its
data was new, as on a fresh install. Container port 8080 was published to the
host's `localhost:8080`, since Streamline calls Decaid at its page's host on
port 8080.

- **DYE2** at 2cf631c is untagged, and its repository's archive holds more
  than one directory, so neither `install/github-release` nor
  `install/github-branch` installs it (the latter, given the commit, answers
  `Plugin package has no manifest.json`). Its built plugin is committed at
  `dye2:dye2.reaplugin/`, built from that commit (its `plugin.js` holds
  `syncSelectionMarker`, `contextDrifted`, `withMachineSettings` and the
  editor's Machine Settings). That directory at 2cf631c (`git archive
  2cf631c dye2.reaplugin`) was copied into Decaid's
  `~/.local/share/decaid/plugins/dye2.reaplugin/` before Decaid first
  started, so Decaid kept it over its bundled v0.1.4, being newer
  (`_copyBundledPlugins` in `decaid:lib/src/plugins/plugin_loader_service.dart`).
  `GET /api/v1/plugins` lists it loaded as version `0.1.19`, the version its
  manifest at 2cf631c still names, with `source` null.
- **The Workflow recorder**, `workflow-recorder/` beside this README, a
  throwaway plugin that pushes each `workflowUpdated` payload on its own
  `workflow` socket, was installed with `PUT
  /api/v1/plugins/workflow-recorder.reaplugin/source` and enabled. It ran only
  in that Decaid.
- **Streamline** at c006dac is its repository's files at that commit (`git
  archive c006dac`), served as static files at `http://localhost:13999/`, its
  DYE strip turned on, showing recipes, by setting `streamline.dye2Enabled`
  to `true` and `streamline.dyeStripMode` to `R` in the page's local storage
  before it loaded, as its Extensions setting does. Its strip switched off is
  `window.applyDye2Enabled(false)` with `streamline.dye2Enabled` set to
  `false`; its wake is `loadProfileForWake` called through the page's own
  module (`src/modules/profileManager.js`).
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (1280x800 for DYE2, 1920x1200 for Streamline) and keeps sockets
  open on DYE2's `changed` endpoint and the recorder's, from the repository
  root: `RESTART_DECAID=<command> node
  server/test/fixtures/decaid/dye2-2cf631c/record.mjs <output dir>`. Each
  request a page sends is fetched by Playwright and its answer handed to the
  page unchanged, so an answer is recorded even when a page navigates away
  before reading it; for `applyRetried` it answered two selections itself.
  Before reading slot 2's values from the Workflow it sets the Workflow's
  profile to `Classic Italian espresso`; before the selection's steps it saves
  the favourite, sets the Ethiopia batch, pulls a Shot, sets `Classic Italian
  espresso` and clears DYE2's selection. As Decaid v0.8.7's simulated machine
  stored only the first Shot pulled after Decaid started, before each later
  Shot the script runs the command `RESTART_DECAID` names, which
  restarted Decaid in the container keeping its data, then opens the sockets
  again. Shots are pulled with `PUT /api/v1/machine/state/espresso`. Those
  requests are not in the files. It reads `DECAID` and `SKIN` from the
  environment for other addresses.

## Edits

Everything named (beans, batches, grinders, baskets, tools, recipes,
favourite, beverage, barista, drinker and note) was made up for the
recording; the profiles are Decaid's bundled ones. The simulated machine
reports serial `mock-de1` and names no real hardware, so nothing is
scrubbed. The Shot's measurements in `shot.json` are trimmed to their first,
last, peak-pressure and peak-flow samples, in their order. DYE2's
`createdAt` and `capturedAt` are UTC, set by the browser; the Shot's
`timestamp` is Decaid's local time without an offset, which was UTC.

## What they show

- **DYE2's lists.** Every save reads the list and posts it whole, as before.
  The editor now saves a recipe as only what changed from the record it
  loaded, laid over the record read again (`recipeChanges` and
  `updateRecipe` in `dye2:dye2-plugin/src/utils/dev-api.ts`), so a blank
  field is left out of `dashboardVariables`, not saved as 0 or null: slot 3
  holds only its modes, and the Grinder and Basket slot 1 showed. Steam and
  hot water each keep the value of the mode shown, and the other mode's value
  the recipe held. Each save rebuilds the embedded `workflow`
  (`buildRecipeWorkflow`): its context with the recipe's dose, yield, grind,
  RPM, Grinder, Basket and Bean, `beanBatchId` null for a Bean picked without
  a batch, as the editor's Bean chips pick none, each flagged in
  `extras.dye`; its profile at the recipe's brew temperature; and every
  machine setting the recipe holds, as partial parts.
- **DYE2's dashboard apply** reads the recipes again first (dye2#28), then
  sends the whole Workflow it read as it opened with the recipe's dose,
  yield, grind (as a number), RPM, Grinder, barista and drinker, its Bean's
  coffee, roaster and batch, null for a batch it does not hold, which Decaid
  drops, so the Workflow's batch is cleared (dye2#27), its Profile at the
  recipe's brew temperature, every step moved by as much (`Adaptive v3`'s 93
  and 88 at slot 1's 92 go as 92 and 87, dye2#26), and every machine setting
  the recipe holds laid over the Workflow's, but not its Basket. The fields it
  set are flagged `true` in `context.extras.dye` (`markDye`), and the copy it
  sends leaves out DYE2's `extras.dye.selection`. Then it selects the recipe.
- **Selecting** answers `{kind, id, profileFingerprint, armedBrewC,
  armedBeanBatchId, armedGrinderId, armedMachine}`: the fingerprint of the
  Workflow's profile, its first step's temperature, its batch and grinder
  (`""` for none), and its steam, hot water and flush settings, the flush
  temperature and flow from `GET /machine/settings` (here 25 and 6, while
  the Workflow's `rinseData` says 90 and 6). DYE2 then writes the selected
  item into the Workflow as `context.extras.dye.selection`, `{kind, id}`, and
  `null` once cleared, a `PUT /workflow` of that alone, heard in `events`; a
  Shot pulled then carries it (`shot.json`'s `pulled`). It is stored as it
  is, and a cleared selection as `{}` (dye2#22). Every change of which item
  is selected pushes once, a clear, a drift and a strip switched off included
  (dye2#24); selecting the same item again, or clearing with nothing
  selected, pushes nothing.
- **The fingerprint** is `profileFingerprint` in
  `dye2:dye2-plugin/src/utils/workflow-record.ts`: title, tank temperature
  and steps but their temperatures, the target weight and volume left out
  (dye2#18). A change of only `target_weight` keeps the selection and records
  nothing (`targetWeightOnly`); the Drink tile's yield is recorded.
- **Recording.** Each change of a field the recipe holds is recorded after
  DYE2's wait, its embedded `workflow` kept in step, and pushed: grind, dose,
  yield, brew temperature, RPM, Basket (id and name together), and its steam,
  hot water and flush settings. A steam, hot water or flush setting the
  recipe does not hold is recorded once it moves off its value at the
  selection (`hotWaterOtherMode`, `steamOtherMode`, `machineSettingAdopted`,
  and the hot water volume of `writtenElsewhere`). A dashboard or Edit Shot
  basket pick writes the Workflow's Basket, which is recorded into the recipe
  selected (`pickBasket`, `pickShotBasket`). The echo window and the
  debounce are as before. The yield recorded into the embedded `workflow` is
  its context's alone: its profile keeps its `target_weight`, so the strip's
  next apply sends the recorded yield with the old target weight
  (`applySlot2Again`).
- **Clearing.** A change of profile, or of the batch or grinder the
  selection was made on, clears it (`profileChange`, `batchSwitch`,
  `grinderSwitch`, `batchCleared`), recording nothing, pushing once and
  marking the Workflow `null`. Selected with no batch (`armedBeanBatchId`
  `""`), a batch set later is kept and taken as the one armed
  (`batchFromEmpty`, `writtenElsewhere`, `writtenBeforeShot`). DYE2's own dashboard copy can clear it: after `writtenElsewhere`
  the dial tap sent the copy's batch, none, which cleared the selection.
- **Restoring.** DYE2 restores its stored selection as it loads, `{}` as
  none, and one stored without the armed fields with them null, adopted from
  the next Workflow change. A restored selection made on another profile is
  cleared at the Workflow's next change, which now pushes.
- **Streamline applying a recipe** keeps the steam, hot water and flush
  values of the recipe's modes under `streamline-app`, sends the whole
  Workflow with the recipe's embedded context merged in, so with its
  `beanBatchId` null, which clears the Workflow's batch, and its Profile
  (limiters of 0 sent as null), then selects it. A selection that fails is
  tried again 2 s later in the background (streamline-js#148): here the
  apply's change of profile had already cleared slot 1, selected before, and
  the retry selected slot 2. While DYE2 records, Streamline saves nothing
  into a recipe itself (`pluginRecordsDialIn`): its Drink and Dose tiles
  send `{context: {targetDoseWeight, targetYield}, profile}`, the Workflow's
  own profile with `target_weight` at the yield (streamline-js#155), which
  keeps DYE2's selection, and DYE2 records the yield and dose.
- **Streamline's clear**, after each Shot and as its page loads
  (`clearDyeWorkflowContext` in `streamline-js:src/modules/dyeStrip.js`):
  with DYE2 loaded and its stored selection naming a recipe, only the
  barista, drinker and note (streamline-js#149; `restarted` found none to
  clear). With nothing selected, everything DYE2-shaped: batch, coffee,
  roaster, grinder, barista, drinker, and in `extras` the Basket, RPM, note,
  `streamlineBean` and `dye`, DYE2's marker and flags with it (`started`,
  `shotClearedNoSelection`). The scoped clear by `extras.dye` flags is never
  used with this DYE2: Streamline takes only v0.1.20 or later to mark its
  writes (`DYE_MARKER_VERSION` in `src/modules/dye-context.js`), and DYE2 at
  2cf631c reports 0.1.19.
- **A wake** onto the profile the Workflow holds while DYE2's stored
  selection names a recipe sends nothing (`recipeHoldsDial` in
  `src/modules/profileManager.js`, streamline-js#153). Onto another profile
  it sends `{profile, context: {targetDoseWeight, targetYield,
  grinderSetting}}`, the grind null, clearing the selection on the change of
  profile.
- **The strip switched off** posts `{}` to DYE2's `selection`, which clears
  it and pushes.
