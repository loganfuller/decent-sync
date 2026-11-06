# Streamline v0.2.23 and DYE2 v0.1.33 on Decaid v0.9.1

What Streamline v0.2.23 writes to Decaid v0.9.1 around steam, with DYE2
v0.1.33, recorded as `../dye2-v0.1.33/` records DYE2 and Streamline: each
request a page or the recording script sent, and the status and body Decaid
answered, its JSON parsed. Requests the script sent stand for the plugin's
(its load write, its `record` call, the previous and the new release's
Workflow writes), for Decent Sync's server (a recipe's record written), or
for another device's Streamline (its remembered values). They were recorded
for decent-sync #394: Streamline's steam off and on patches from its heater
switch with its DYE2 switch on and off and from its Settings toggle, a steam
time of 0 saved in DYE2's editor, a Recipe edited while its Machine's steam
is off, v0.2.23's DYE strip apply, and v0.2.22's restore keeping a fan
threshold and refill kit changed elsewhere.

A step is `{exchanges, alsoSent, after, streamline, tiles, pushes, events,
timing}`:

- `exchanges`: what the step's action sent. On Streamline's pages every
  request but a read is kept, whatever its route; of the reads, only those
  of DYE2's `selection` route and `recipes` key, the Workflow, and
  Streamline's keys in `streamline-app` (its remembered values). On DYE2's
  editor, every request but a read, and reads of `selection` and `recipes`.
  The Settings toggle's steps also hold `{"toggle": <checked>}`, the
  toggle's state once the action was done.
- `alsoSent`, where present: what an open Streamline page sent meanwhile
  that the action did not take, by page name (`dye2On`, `dye2Off`,
  `settings`), most often Streamline's answer to a write from the script.
- `after`: reads made 2.5 s after the step: the Workflow, DYE2's derived
  selection, DYE2's recipes.
- `streamline`: Streamline's remembered steam values, `last-steam-temp`,
  `last-steam-duration` and `last-steam-flow` in `streamline-app`, read
  then (null where none is stored).
- `tiles`: what each open Streamline page's main-page steam tile showed
  then: its time (`duration`, "Off" for 0), its flow, its two mode
  buttons' classes, and whether the main page was shown (false while the
  settings page is open, null once the page is closed).
- `pushes`, `events`, `timing`: as in `../dye2-v0.1.26/`, what DYE2's
  `changed` socket heard, the `context` of each Workflow Decaid sent plugins
  in a `workflowUpdated` (heard through `../dye2-v0.1.26/workflow-recorder/`),
  and when each came, in ms from the step's start.

The same shorthands as `../dye2-v0.1.33/` keep the files small: a read of
`/workflow` or DYE2's `recipes` answering what the last read or post of it in
the file did is `"unchanged": true`, and outside `library.json` a whole
profile is `{"$profile": "<title>/<hash>"}`, its copy in `library.json`'s
`profileCopies`.

The recipes, as Decent Sync's server writes them, in Streamline's strip
buttons 1 to 3:

| Recipe | Name | Steam mode | Settings it holds |
|---|---|---|---|
| `1` | `Fixture Steam Recipe` | time | every setting a Recipe may hold (`RECIPE_SETTINGS` in protocol/src/index.ts): steam 150 °C, 40 s, 1.2 ml/s, milk stop 65 °C; hot water 85 °C, 35 s, 200 ml, 6 ml/s; flush 88 °C, 5 s, 6 ml/s |
| `2` | `Fixture Steam Temperature Only` | time | a steam temperature of 145 °C, no steam time |
| `3` | `Fixture No Steam` | none | none |

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (a bean, `Fixture Ethiopia`, and a batch of it, the grinder `Fixture Grinder 64`, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, the simulated machine's settings and advanced settings, `GET /info`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `bundledDye2`, the bundled DYE2's entry in `GET /plugins` (v0.1.31); `install`, `POST /plugins/install/github-branch` of DYE2 v0.1.33's `dist` deploy and its answer; `listed`, DYE2's entry after (v0.1.33, loaded); `seeded`, the script's writes of DYE2's recipes and the Workflow as Decent Sync's server leaves them, every DYE2 key and the Workflow read back, and Streamline's remembered steam values (none) |
| `strip.json` | Step 1, Streamline's DYE strip with its DYE2 switch on: `started`, its page load; `cells`, the names its five buttons showed (not a step); `applyRecipe1`, `applyRecipe2`, `applyRecipe3`, each recipe's button tapped |
| `heater.json` | Steps 2 to 4, the steam heater switched through `setSteamHeaterEnabled` (below). With Streamline's DYE2 switch on: `reseeded`; `startedDye2On`; `applyRecipe3First` and `applyRecipe1` from the strip; `loadWrite`, recipe `1`'s settings written into the Workflow from the script, as the plugin's load write writes a Loaded Recipe's; `heaterOffDye2On`; `heaterOnDye2On`; `heaterOffAgainDye2On`; `rememberedOtherwise`, `last-steam-temp` 140 and `last-steam-duration` 25 written from the script; `heaterOnRecipeWins`. With it off, on a new page: `startedDye2Off`; `heaterOffDye2Off`; `heaterOnDye2Off`; `heaterOffAgainDye2Off`; `rememberedOtherwiseDye2Off` (140 and 25); `heaterOnRememberedDye2Off`. With it on again: `startedRecipe2`; `applyRecipe2`; `loadWriteRecipe2`, its 145 °C written from the script; `heaterOffRecipe2`; `heaterOnRecipe2`; `heaterOffRecipe2Again`; `rememberedDurationRemoved`, `DELETE` of `last-steam-duration` from the script; `heaterOnRecipe2NothingRemembered` |
| `tile.json` | Step 6, the main page's steam tile, DYE2 switch on: `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `heaterOff`; `plusFromOff`, the tile's + (`#steam-plus`) tapped while it shows "Off" |
| `settings.json` | Step 5, Settings › Calibration › Steam's heater toggle (`#steamHeaterToggle`), DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `workflowSteamOtherwise`, the Workflow's steam written 155 °C and 35 s from the script; `opened`, the settings page opened from the main page's settings button at Calibration › Steam; `toggleOff`; `saveOff`, Save (`#save-settings-btn`), which returns to the main page; `openedAgain`; `toggleOn`; `saveOn`; `openedThird`; `toggleOffAgain`; `saveOffAgain`; `openedFresh`, the page loaded afresh at `?page=settings` (Calibration › Steam) while steam is off; `toggleOnFresh`; `saveOnFresh` |
| `record.json` | Step 7, DYE2's `record` (`POST /plugins/dye2.reaplugin/record` from the script, as the plugin calls it after each change). DYE2 switch on: `reseeded`; `startedDye2On`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `recordLoaded`; `heaterOff`; `recordOff`. DYE2 switch off, on a new page: `startedDye2Off`; `heaterOnDye2Off`; `recordOnDye2Off`; `heaterOffDye2Off`; `recordOffDye2Off`; `rememberedOtherwise` (140 and 25); `heaterOnRememberedDye2Off`; `recordOnRememberedDye2Off`. DYE2 switch on, on a new page: `startedRecipe2`; `heaterOffBeforeRecipe2`; `recordOffBeforeRecipe2`; `applyRecipe2WhileOff`, recipe `2` from the strip while steam is off; `heaterOnRecipe2`; `recordOnRecipe2` |
| `editor.json` | Step 8, DYE2 v0.1.33's recipe editor (`recipe-edit?id=1`) in its own page while Streamline's main page stays open, DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `steamTimeZeroSaved`, the editor opened on recipe `1`, its steam mode Time chosen, its steam stepper typed to 0 and SAVE tapped, with `form`, what the stepper showed before and after; `recordAfterSave`; `plusWithHeaterOn`, the tile's + tapped after |
| `steam-off-edit.json` | Step 9, a Recipe edited while its Machine's steam is off, DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `heaterOff`; `recordRewritten`, recipe `1`'s record rewritten from the script as Decent Sync's server writes an edit (steam 155 °C, 45 s, 1.0 ml/s, record only); `previousPluginWrite`, `PUT /workflow {"steamSettings":{"duration":45,"flow":1}}`, as the previous plugin release writes it (no temperature while off); `steamTimeBackToZero`, `{"steamSettings":{"duration":0}}`; `newPluginWrite`, `{"steamSettings":{"flow":1,"stopAtTemperature":65}}`, as the new plugin writes it; `reloaded`, Streamline loaded again |
| `settings-kept.json` | Step 10, on a page of its own (`settings`): `started`; `machineBefore`, `GET /machine/settings` and `/machine/settings/advanced` (not a step); `fanSaved`, Calibration › Fan typed to 45 and saved; `refillKitSaved`, Calibration › Refill Kit set to Force Off and saved; `machineSaved` (not a step); `restoreRecord`, Streamline's restore record (`userMachineSettings` in the page's IndexedDB `shot_history`, store `settings`; not a step); `editedElsewhere`, `POST /machine/settings {"fan":50}` and `POST /machine/settings/advanced {"refillKitSetting":2}` from the script, the routes Decent Sync's Settings Edits use (`plugin/src/settings-edits.ts`); `settingsOpened`, the settings page loaded afresh at Calibration › Fan and left open for about 15 s; `machineAfter`; `restoreRecordAfter` |
| `keys.json` | Not exchanges: DYE2's recipes and stored selection at the end |

## How they were recorded

They were recorded on 2026-11-06 (UTC) by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1`, build
3027, commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container
as `../dye2-v0.1.33/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account` with its simulated machine and scale, its
data new, container port 8080 published to the host's `localhost:8080`. No
tablet was contacted: the owner's three tablets run Streamline v0.2.21 pinned,
so they hold nothing of v0.2.23, and no record shapes were read from one.

- **DYE2** v0.1.33 is the floor, and v0.1.34 is the latest release, so the
  script installs DYE2 as the owner's tablets have it: `POST
  /api/v1/plugins/install/github-branch {"repo":"decentespresso/dye2",
  "branch":"a98bc5f46eef334ec4b94c1f8ef4815201dda461"}`, the `dist` deploy
  of the v0.1.33 tag's `d0ceeb5`, over the bundled v0.1.31. Decaid answered
  `{"message":"Plugin installed","id":"dye2.reaplugin","version":"0.1.33",
  "loaded":true}`. The installed `plugin.js` (SHA-256
  `aa9222cca817172583a6ab3cdb73ec496bdd80dc6d32ab9e7aff1a98f15d9ad5`) and
  `manifest.json` (SHA-256
  `573102f4c6f76805ab6f7975ce466d56447103b6e4291988bef69ab85fac62e6`) are
  byte for byte the `dist` branch's at `a98bc5f`.
- **The seeded keys.** Once it is loaded, the script writes recipes `1` to
  `3` (above) as Decent Sync's server writes them (`recipeRecord` and
  `recipeWorkflow` in server/src/library/recipe-intake.ts: the settings
  each holds in `dashboardVariables` and in its embedded Workflow, shown
  exactly while in a slot, a whole record in `jsonb`'s key order, its Bean's
  coffee, roaster and batch or explicit nulls for none, and a made-up global
  id), and the Workflow on the Ethiopia's batch. Each step group after the
  first starts by writing the seeded records again (`reseeded`), as the
  server writes a Recipe's record back, so what an earlier group's `record`
  saved does not carry over.
- **Streamline** v0.2.23 is its repository's files at the tag (`git archive
  v0.2.23`, commit `2622007`), served as static files at
  `http://localhost:13999/` and switched to its DYE strip as for
  `../dye2-v0.1.26/`. Each group opens it in a browser context of its own,
  its DYE2 switch (`streamline.dye2Enabled`) set before it loads. Streamline
  mirrors that switch into Decaid's store (`streamlineSettings`,
  src/modules/settingsSync.js) and takes the store's value over the page's
  own as it loads, so the script writes the store's too each time it loads
  a page (the first exchange of each `started*` step and of `reloaded`).
  With the switch off,
  Streamline shows no DYE strip.
- **The heater switch.** Streamline v0.2.23's main page has no steam heater
  switch of its own: its steam tile's − at the shortest time and + from Off
  call `setSteamHeaterEnabled` (`switchSteamHeater` in src/modules/ui.js),
  as does its descaling page. The `heater*` steps call that function in the
  page's own module (`await import("/src/modules/api.js")`), the one writer
  behind each of them. `plusFromOff` and `plusWithHeaterOn` tap the tile's
  + itself.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (`@playwright/test` 1.63.0) as `../dye2-v0.1.33/record.mjs`
  does, from the repository root, with Node v26.13.0: `node
  server/test/fixtures/decaid/streamline-v0.2.23/record.mjs <output dir>`.
  It restarts no Decaid and pulls no Shot. It reads `DECAID` and `SKIN` from
  the environment for other addresses. The run recorded here was the first
  of this script on a fresh Decaid and took about nine minutes.

## Edits

Everything named (bean, batch, grinder, recipes) was made up for the
recording; the profiles are Decaid's bundled ones. The simulated machine
names no real hardware, and nothing of the host's is in the files, so
nothing is scrubbed. As recorded, the files were compacted as
`../dye2-v0.1.33/` describes (`compactAll`). Nothing else was changed.

## What they show

- **The strip applies more of a recipe** (`strip.json`; `mergeRecipeLiveSettings`
  in streamline-js:src/modules/dyeStrip.js, `65460d4`). Recipe `1`'s button
  PUT its context and profile with `steamSettings: {duration: 40,
  stopAtTemperature: 65}`, `hotWaterData: {volume: 200, targetTemperature:
  85, duration: 35, flow: 6}` and `rinseData: {duration: 5}`, after keeping
  `last-steam-duration` 40, `last-milk-stop` 65, `last-hot-water-volume`
  200, `last-hot-water-temp` 85 and `last-flush-duration` 5. No steam
  temperature, no steam flow (the recipe's steam mode is time), no flush
  temperature or flow. Recipe `2` (steam mode time, no steam time) and
  recipe `3` wrote their context and profile only. As the issue describes.
- **Steam off** (`heater.json`, every `heaterOff*` step; `steamHeaterFor`
  in src/modules/api.js). Streamline reads the Workflow, keeps
  `last-steam-temp` and `last-steam-duration` (each where above 0), and PUTs
  `{"steamSettings":{"targetTemperature":0,"duration":0}}`. **Then, within a
  second, it writes `last-steam-duration` 0 itself**: the simulated machine's
  shot settings echo a steam time of 0, and Streamline's drift check on each
  shot settings frame (`resyncDriftedShotSettings` in src/modules/app.js,
  `resyncIfDrifted` and `decideResync` in src/modules/resync-policy.js)
  adopts it as an outside change. Unlike `resyncSteamFromStore`, that path has
  no steam-off guard. So after any steam off from Streamline, its remembered
  steam time is 0, and only its remembered temperature survives. This is not
  in the issue's account.
- **Steam on, DYE2 switch on** (`heater.json`). Streamline reads DYE2's
  recipes (and its stored selection, whose read is not kept) and its three
  remembered values, and PUTs `{"steamSettings":{"targetTemperature":150,
  "duration":40}}`, recipe `1`'s, then keeps `last-steam-duration` 40
  (`heaterOnDye2On`). The recipe's values win over remembered ones of 140
  and 25 (`heaterOnRecipeWins`). No flow is written: the Workflow's is
  usable.
- **Steam on, DYE2 switch off** (`heater.json`). Streamline reads no DYE2
  key. With only what it remembered itself, it PUT
  `{"targetTemperature":150,"duration":1}` (`heaterOnDye2Off`): the
  remembered 150, and a steam time of 1 s, because the remembered time was
  the adopted 0, which `steamOnPatch` takes as a value and clamps to 1. With
  remembered values of 140 and 25 written from the script it PUT
  `{"targetTemperature":140,"duration":25}` (`heaterOnRememberedDye2Off`),
  the remembered values over the recipe's, as the issue describes.
- **Recipe `2`, no steam time** (`heater.json`). With the DYE2 switch on,
  steam came back at `{"targetTemperature":145,"duration":1}`
  (`heaterOnRecipe2`): the recipe's temperature, and 1 s from the adopted 0.
  With `last-steam-duration` removed, `{"targetTemperature":145,
  "duration":30}` (`heaterOnRecipe2NothingRemembered`): Streamline holds no
  steam time for `Classic Italian espresso`, so the default 30 s.
- **Settings › Calibration › Steam** (`settings.json`; `setSteamHeaterOn` and
  `flushPendingChanges` in src/settings/settings.js). The toggle stages; it
  writes nothing until Save. Off and Save PUT
  `{"steamSettings":{"targetTemperature":0,"duration":0}}` and keep nothing
  (Save keeps only values above 0); the main page then adopted
  `last-steam-duration` 0 as above. On and Save, in the same page session,
  PUT `{"targetTemperature":155,"duration":35}`, the values the page turned
  off (the Workflow's, set from the script), not recipe `1`'s 150 and 40,
  and kept `last-steam-duration` 35 and `last-steam-temp` 155. **Loaded
  afresh while steam was off, on and Save PUT
  `{"targetTemperature":155,"duration":30}`** (`saveOnFresh`): as it loaded,
  the page read `last-steam-temp` (155) and `last-steam-duration` (0) from
  the store, the reads of `seedRememberedSteamValues`, the one code path in
  v0.2.23 that reads those two keys together, which seeds what the toggle
  turns back on to where above 0. So the temperature came from Streamline's
  remembered value, and the time fell to 30 s because the remembered time
  was 0. The issue names only the page's own last values or the Workflow's.
- **The steam tile** (`tile.json`). With the heater off it shows "Off"
  (`heaterOff`). Its + from Off calls `setSteamHeaterEnabled(true)`, the same
  path as above, and PUT `{"targetTemperature":150,"duration":40}`, recipe
  `1`'s with the DYE2 switch on (`plusFromOff`).
- **DYE2's `record` around steam** (`record.json`). Right after the load
  write it answered `saved: true` and changed no record (`recordLoaded`).
  With steam off it answered `saved: false` (`recordOff`,
  `recordOffDye2Off`, `recordOffBeforeRecipe2`). After steam came back on
  with the DYE2 switch off at 150 °C and 1 s, it saved `steamTimeS: 1` into
  recipe `1` (`recordOnDye2Off`). After it came back at remembered values of
  140 and 25, it saved `steamTempC: 140` and `steamTimeS: 25`
  (`recordOnRememberedDye2Off`). Recipe `2`, applied while steam was off (the
  Workflow's steam time 0 at the apply) and then turned back on at 145 °C and
  1 s, took `steamTimeS: 1`, a field it did not hold (`recordOnRecipe2`;
  `movedSinceArming` in dye2:dye2-plugin/src/utils/workflow-record.ts).
- **A steam time of 0 saved in DYE2's editor** (`editor.json`). With steam
  mode Time and the stepper typed to 0 (it showed "0s"), SAVE wrote recipe
  `1` with `steamTimeS: 0`, a number, in `dashboardVariables`, and
  `steamSettings.duration` 0 in its embedded Workflow. As recipe `1` was the
  selected one, the editor applied it again (`reapplyIfSelected`): one PUT
  of the embedded Workflow, its context with the recipe id, its profile,
  `steamSettings: {targetTemperature: 150, duration: 0, flow: 1.2,
  stopAtTemperature: 65}`, `hotWaterData: {targetTemperature: 85, duration:
  35, volume: 200, flow: 6}` and `rinseData: {targetTemperature: 88,
  duration: 5, flow: 6}`. Streamline adopted `last-steam-duration` 0, and its
  tile showed "Off" while the Workflow's steam temperature stayed 150, the
  heater on. `record` after answered `saved: true` and changed nothing. The
  tile's + then PUT `{"steamSettings":{}}` and changed nothing: with the
  heater on, `steamHeaterFor(true)` returns no patch.
- **A Recipe edited while steam is off** (`steam-off-edit.json`). The
  previous plugin's write of the new steam time and flow into a Workflow
  whose steam is off left it at `{targetTemperature: 0, duration: 45, flow:
  1}`. Streamline's tile showed "45s" with the heater off, and Streamline
  adopted `last-steam-duration` 45 (`previousPluginWrite`), which its next
  steam on with the DYE2 switch off would use. Putting the time back to 0
  showed "Off" and adopted 0 again (`steamTimeBackToZero`). The new
  plugin's write of flow and milk stop alone changed neither the tile's time
  ("Off") nor any remembered value (`newPluginWrite`). The tile's flow
  showed the old 1.2 until Streamline was loaded again (`reloaded`, "1.0"):
  shot settings frames carry no steam flow.
- **The fan threshold and refill kit kept** (`settings-kept.json`;
  `splitDifferences` and `decaidKeepsMachineSettings` in
  src/settings/settings-restore.js, `464a448`). Saved on Streamline's page,
  45 and Force Off went to `POST /machine/settings {"fan":45}` and `POST
  /machine/settings/advanced {"refillKitSetting":0}` (both answered 202), and
  its restore record tracked both. After the script wrote 50 and Auto-Detect
  (2), the settings page, loaded afresh and left open, sent no write to
  either route. Its restore record took the machine's 50 and 2
  (`restoreRecordAfter`), and the machine kept them (`machineAfter`). Decaid
  reports version `0.9.1`, which v0.2.23 counts as keeping these values, so
  nothing is restored.
- **Not recorded.** Streamline's Quick Adjustments › Steam page, the
  descaling page's use of the heater switch, a steam flow put back by
  `steamOnPatch` (the Workflow's flow was usable throughout), and the
  per-profile steam fallback (`activeProfileSteamFallback`): no profile held
  a steam time in Streamline.
