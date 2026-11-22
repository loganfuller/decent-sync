# Streamline v0.2.31 and DYE2 v0.1.42 on Decaid v0.9.2

What Streamline v0.2.31 and DYE2 v0.1.42 write to Decaid v0.9.2 around
steam, recorded as `../streamline-v0.2.24/` and `../dye2-v0.1.40/` record
them: each request a page or the recording script sent, and the status and
body Decaid answered, its JSON parsed. Requests the script sent stand for
Decent Sync's plugin (its load write, its `record` call), for Decent Sync's
server (a recipe's record written), or for another device's Streamline (its
remembered values). They were recorded for decent-sync #616, which has a
Recipe hold steam "Off" as DYE2 does, and loading a Recipe switch steam as
it holds it: what Streamline's strip and DYE2's dashboard write for a recipe
with steam on and with steam off, what DYE2's `record` saves after, what
"Off" saved in DYE2's recipe editor does, what the plugin's load writes
change, and the labels of Streamline's settings pages that #616 renames.

A step is `{streamlineBefore, exchanges, alsoSent, after, streamline, tiles,
pushes, events, timing}`:

- `streamlineBefore`: Streamline's remembered steam values,
  `last-steam-temp`, `last-steam-duration` and `last-steam-flow` in
  `streamline-app`, read just before the step's action (null where none is
  stored). New in this directory, so that each apply shows what was
  remembered before it as well as after.
- `exchanges`: what the step's action sent. On Streamline's page every
  request but a read is kept, whatever its route; of the reads, only those
  of DYE2's `selection` route and `recipes` key, the Workflow, and
  Streamline's keys in `streamline-app`. On DYE2's pages, every request but
  a read, and reads of `selection`, `recipes` and the Workflow. Some steps
  also hold entries that are no exchange:
  - in `editor.json`, `{"shown": ...}`, what DYE2's recipe editor showed as
    it opened (its steam mode, and its steam, steam temperature, milk stop,
    hot water, hot water time and flow, flush, flush temperature and flow
    steppers), `{"shownAfter": ...}`, what it showed just before Save, and
    on the steps that set "Off", `{"shownAfterPreset": ...}`, what it showed
    once the steam temperature's Off preset was tapped, and `{"minusTaps":
    n}`, how many taps of the steam temperature's − then brought it to Off;
  - in `auto-steam.json`, `{"isAutoSteamActive": ...}`, what Streamline's
    own `isAutoSteamActive` answered once the flag was set or removed.
- `alsoSent`, where present: what the open Streamline page (`streamline`)
  sent meanwhile that the action did not take, most often its answer to a
  write from DYE2's page or the script.
- `after`: reads made 2.5 s after the step: the Workflow, DYE2's derived
  selection, DYE2's recipes.
- `streamline`: Streamline's remembered steam values, read then.
- `tiles`: what the open Streamline page's main-page steam tile showed then:
  its time (`duration`, "Off" for 0), its flow, its two mode buttons'
  classes, and whether the main page was shown.
- `pushes`, `events`, `timing`: as in `../dye2-v0.1.26/`, what DYE2's
  `changed` socket heard, the `context` and `steamSettings` of each Workflow
  Decaid sent plugins in a `workflowUpdated` (heard through
  `../dye2-v0.1.26/workflow-recorder/`; the precedents keep only the
  context), and when each came, in ms from the step's start.

The same shorthands as `../streamline-v0.2.24/` keep the files small: a read
of `/workflow` or DYE2's `recipes` answering what the last read of it (or
post, for `recipes`) in the file did is `"unchanged": true`, and outside
`library.json` a whole profile is `{"$profile": "<title>/<hash>"}`, its copy
in `library.json`'s `profileCopies`. Each file's `cells` (in the files with
steps on Streamline's strip) and `pills` (`dashboard.json`) are what the
strip's five buttons and DYE2's dashboard's recipe pills showed, not steps.

The recipes, written as Decent Sync's server writes records for #616
(`recipeRecord`, `recipeWorkflow` and `recordOf` in
server/src/library/recipe-intake.ts at `origin/main` `341927b8`, with #616's
"Off"): each field only where the Recipe holds one, so in
`dashboardVariables` only the steam, hot water and flush settings it holds;
its embedded Workflow as DYE2's `buildRecipeWorkflow` builds one, with
explicit nulls for the parts it names none of, `Classic Italian espresso` at
its brew temperature, and partial `steamSettings`, `hotWaterData` and
`rinseData` of the settings it holds ("Off" being `steamSettings:
{targetTemperature: 0, duration: 0}`, with `steamTempC: 0` and `steamTimeS:
0` in `dashboardVariables`); a blank barista and drinker; shown, in strip
buttons 1 to 5; a whole record in `jsonb`'s key order; a made-up global id
that stays the same through the run. Each names the grinder `Fixture
Grinder 64` and `Classic Italian espresso` at 93 °C; recipe `1` also names
`Fixture Ethiopia` and its batch.

| Recipe | Name | Steam mode | Settings it holds |
|---|---|---|---|
| `1` | `Fixture Steam Recipe` | time | every setting a Recipe may hold, as `../streamline-v0.2.24/`'s recipe `1`: steam 150 °C, 40 s, 1.2 ml/s, milk stop 65 °C; hot water 85 °C, 35 s, 200 ml, 6 ml/s; flush 88 °C, 5 s, 6 ml/s |
| `2` | `Fixture Steam Temperature Only` | time | a steam temperature of 145 °C only |
| `3` | `Fixture No Steam` | none | none |
| `4` | `Fixture Steam Off` | time | "Off": `steamTempC` 0, `steamTimeS` 0 |
| `5` | `Fixture Steam Time Only` | time | a steam time of 35 s only |

Every step file starts the same way: `seeded`, the five records written
from the script as above (so what an earlier file's `record` or editor saved
does not carry over; the Workflow and Streamline's remembered values do);
`steamStart`, `PUT /workflow {"steamSettings":{"targetTemperature":160,
"duration":30}}` from the script, so each file starts with steam on and
known; `started`, Streamline's main page loaded (the first exchange, the
script's write of its DYE2 switch into Streamline's mirror of it, as
`../streamline-v0.2.24/` describes); and `cells`. A strip tap on the
highlighted recipe does nothing in v0.2.31 (`if (active) return` in
src/modules/dyeStrip.js), so where a recipe is applied from the strip twice
in a row, recipe `3`, which holds no steam setting and writes none, is
applied between (`applyRecipe3First`, `applyRecipe3Between`, ...). "Off from
the script" is `PUT /workflow {"steamSettings":{"targetTemperature":0,
"duration":0}}`, as Streamline's off writes it. `record` is `POST
/plugins/dye2.reaplugin/record` from the script, as Decent Sync's plugin
calls it after each change.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (the bean `Fixture Ethiopia` and its batch, the grinder `Fixture Grinder 64`, the bundled profile `Classic Italian espresso`, `GET /info`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `recorder`, the recorder's install (`PUT /plugins/workflow-recorder.reaplugin/source` and its `enable`, both with Decaid's token, the source left out of the body); `bundledDye2`, the bundled DYE2's entry in `GET /plugins` (v0.1.37); `install`, `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}` with Decaid's token and its answer; `listed`, DYE2's entry after (v0.1.42, loaded); then every DYE2 key and the Workflow before any recipe was written, and Streamline's remembered steam values (none) |
| `strip.json` | Item 1, Streamline's strip, its DYE2 switch on. `seeded`, `steamStart`, `started`, `cells`. With steam on: `applyRecipe3SteamOn`, `applyRecipe1SteamOn`, `applyRecipe2SteamOn`, `applyRecipe5SteamOn`, `applyRecipe4SteamOn`; `recordAfterRecipe4`. With steam off: `applyRecipe3SteamOff`; `applyRecipe1SteamOff` (steam comes on); `steamOffBeforeRecipe2`; `applyRecipe2SteamOff`; `recordAfterRecipe2SteamOff`; `steamOffBeforeRecipe5`; `applyRecipe5SteamOff`; `recordAfterRecipe5SteamOff`; `steamOffBeforeRemembered`; `rememberedOtherwise`, `last-steam-temp` 140 and `last-steam-duration` 25 written from the script; `applyRecipe2Remembered`; `recordAfterRecipe2Remembered`; `steamOffBeforeRecipe5Remembered`; `applyRecipe5Remembered`; `recordAfterRecipe5Remembered`; `rememberedDeleted`, `DELETE` of both keys from the script; `steamOffBeforeNothingRemembered`; `applyRecipe3Between`; `applyRecipe5NothingRemembered`; `recordAfterRecipe5NothingRemembered`; `steamOffBeforeRecipe2NothingRemembered`; `applyRecipe2NothingRemembered`; `recordAfterRecipe2NothingRemembered`. Added (below): `rememberedDeletedAgain`; `steamOffBeforeRecipe2Defaults`; `applyRecipe3BetweenAgain`; `applyRecipe2Defaults`; `recordAfterRecipe2Defaults` |
| `dashboard.json` | Item 2, DYE2's dashboard (`dashboard`) on a page of its own, Streamline's main page left open. `seeded`, `steamStart`, `started`, `cells`. With steam on: `applyRecipe1SteamOn`; `pills`; `applyRecipe2SteamOn`; `applyRecipe5SteamOn`; `applyRecipe4SteamOn`; `recordAfterRecipe4`. With steam off: `applyRecipe3SteamOff`; `applyRecipe1SteamOff`; `steamOffBeforeRecipe2`; `applyRecipe2SteamOff`; `recordAfterRecipe2SteamOff`; `steamOffBeforeRecipe5`; `applyRecipe5SteamOff`; `recordAfterRecipe5SteamOff`. Each apply opens the dashboard afresh and taps the recipe's pill, as `../dye2-v0.1.40/dashboard-applies.json` does |
| `editor.json` | Item 3, DYE2's recipe editor (`recipe-edit?id=`) on a page of its own, its Machine Settings section opened, Streamline's main page left open. `seeded`, `steamStart`, `started`, `cells`; `applyRecipe3First`, `applyRecipe1`, from the strip; `editorOff`, recipe `1` opened, its steam temperature's Off preset tapped, then its − tapped until it showed Off (below), and SAVE; `recordAfterEditorOff`; `heaterOn`, steam turned on through Streamline's `setSteamHeaterEnabled` (as `../streamline-v0.2.24/` calls it); `recordAfterHeaterOn`; `editorOnSteamOn`, recipe `1` opened, a steam temperature of 155 typed, its steam mode Time tapped (already lit) and a steam time of 45 typed, and SAVE, while the Workflow's steam was on; `recordAfterEditorOnSteamOn`; `editorOffAgain`, "Off" saved as in `editorOff`; `steamOffFromScript`; `editorOnSteamOff`, 155 and 45 saved onto recipe `1`, holding "Off", while the Workflow's steam was off; `recordAfterEditorOnSteamOff`; `applyRecipe4`, from the strip; `editorOnRecipe4SteamOff`, 155 and 45 saved onto recipe `4`, the server's record of "Off", while steam was off |
| `load-write.json` | Item 4, writes from the script standing for Decent Sync's plugin, Streamline's main page open. `seeded`, `steamStart`, `started`, `cells`; `steamOffFirst`; `applyRecipe3First`; `applyRecipe1SteamOff` (steam comes on); `loadWriteMatching`, `PUT /workflow {"steamSettings":{"targetTemperature":150,"duration":40}}`, recipe `1`'s, already the Workflow's; `applyRecipe4SteamOn`; `loadWriteOff`, "Off" written again; `applyRecipe3Again`; `applyRecipe1Again` (steam back on); `recordRewrittenOff`, recipe `1`'s record rewritten from the script to hold "Off" (`steamTempC` and `steamTimeS` 0, its embedded `steamSettings` 0 and 0), record only, as the server writes a Loaded Recipe edited elsewhere; `loadWriteOffEdit`, "Off" written into the Workflow; `recordAfterOffEdit` |
| `auto-steam.json` | Item 5, Streamline's main page. `seeded`, `steamStart`, `started`, `cells`; `applyRecipe3First`; `autoSteamActive`, Auto Steam's session flag set (below); `applyRecipe1AutoSteam`, recipe `1` from the strip; `autoSteamEnded`, the flag removed |
| `settings-labels.json` | Item 6, not exchanges: Streamline's settings page opened from the main page's settings button at Quick Adjustments › Shot control (`shotControl`), Quick Adjustments › Hot Water (`hotWater`) and Calibration › Sensor Calibration (`sensorCalibration`, where "Flow calibration" is). Each holds `location`, the saved location the page opened at; `exchanges`, what it sent; and `shown`: `lines`, the content area's visible text (`innerText`), line by line; `labels`, each element of the content area naming a translation key (`data-i18n-key`) with its text and id; `inputs`, each input of the content area with its value and its `step`, `min`, `max` and `aria-labelledby` attributes; `buttons`, each button's label with its step (`data-delta`) or its `onclick`; `outsideContent`, the text of every other visible element naming a translation key (the page's header and its two navigation columns) |
| `keys.json` | Not exchanges: DYE2's recipes and stored selection at the end |

## How they were recorded

They were recorded on 2026-11-22 between 13:57 and 14:06 (UTC) by Decaid's
v0.9.2 Linux arm64 release (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answers `0.9.2`, build
3191, commit `875b7a6a`), run headless in a throwaway Ubuntu 24.04 container
as `../dye2-v0.1.40/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account` with its simulated machine and scale and
its data new (`shared_preferences.json` holding only `simulateDevices`
`["machine","scale"]`, `onboardingCompleted` and `accountStepSeen`), its
port 8080 published to the host's `localhost:8080`. No tablet, server or
other device was contacted, and the pages could reach no address but
Decaid's and Streamline's: the script aborts every other request a page
makes (Streamline's favicon on Decent's site among them).

- **The token.** Decaid was started with `DECAID_EXTENSIONS_TOKEN` in its
  environment set to 64 hexadecimal characters from `openssl rand -hex 32`.
  The script had the same value in its own environment and sent it with
  three requests: the recorder's source and enable, and DYE2's install. The
  token is in no file: a request that carried it holds `"token": "launch"`.
  No request a page sent carried a token, and none was refused.
- **DYE2** v0.1.42 is the latest release (tag commit `60383c6`; `gh release
  list` on the day showed v0.1.42 as Latest). The script installs it over
  the bundled v0.1.37 with `POST /api/v1/plugins/install/github-release
  {"repo":"decentespresso/dye2"}`, which Decaid answered `{"message":"Plugin
  installed","id":"dye2.reaplugin","version":"0.1.42","loaded":true}`.
- **Streamline** v0.2.31 is its repository's files at the tag (`git archive
  v0.2.31`, commit `e9c08d5`), served as static files at
  `http://localhost:13999/` by `python3 -m http.server`, each file opening it
  in a browser context of its own, its DYE2 switch (`streamline.dye2Enabled`)
  on and its strip on recipes (`streamline.dyeStripMode` `R`), both set
  before it loads, as `../dye2-v0.1.40/` describes. Before the pages are
  opened the script sends `PUT /machine/state/idle`, not recorded:
  Streamline covers its page with a screensaver while the machine sleeps.
- **The heater switch.** As in `../streamline-v0.2.24/`, `heaterOn` calls
  `setSteamHeaterEnabled(true)` in the page's own module (`await
  import("/src/modules/api.js")`), the writer behind the main page's steam
  tile's + from Off.
- **"Off" in DYE2's editor.** The steam temperature's Off preset chip does
  not change the number in v0.1.42 (What they show, below), so `editorOff`
  and `editorOffAgain` tap it, keep what the editor then showed
  (`shownAfterPreset`), and then tap the steam temperature's − until the
  number reads Off (4 taps from 150 °C, 5 from 155 °C), as a barista can.
  The steam temperature and time of `editorOnSteamOn`, `editorOnSteamOff`
  and `editorOnRecipe4SteamOff` are typed into the steppers' numbers, a tap
  on a number opening it for typing, and Enter.
- **Auto Steam.** A real Auto Steam session needs Decent's Auto Steam
  plugin and a calibrated pitcher, which a headless Decaid does not have.
  Streamline's apply asks only `isAutoSteamActive()` (src/modules/api.js),
  which reads `{"active": true}` from the page's `streamline.autoSteamSession`
  storage key, so `autoSteamActive` writes that key in the page and
  `autoSteamEnded` removes it. The page's Auto Steam session object itself
  was never started; only the flag the apply reads was set.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (`@playwright/test` 1.63.0), from the repository root, with Node
  v26.13.0: `DECAID_EXTENSIONS_TOKEN=<token> node
  server/test/fixtures/decaid/streamline-v0.2.31/record.mjs <output dir>`.
  It restarts no Decaid and pulls no Shot. It reads `DECAID` and `SKIN` from
  the environment for other addresses. The run recorded here was the first
  on its fresh Decaid and took nine minutes. A trial run on another fresh
  one, before the script tapped the steam temperature's − after the Off
  preset, before `strip.json`'s last five steps were added and before
  `settings-labels.json` kept each button's step, recorded the same steam,
  hot water and flush writes, remembered values, tiles and `record` answers
  in the steps of `strip.json`, `dashboard.json`, `load-write.json` and
  `auto-steam.json` the two runs share (compared step by step on a summary
  of each, not byte for byte), and in `editor.json` "Off" saves that changed
  nothing, as the preset alone does.

## Edits

Everything named (bean, batch, grinder, recipes) was made up for the
recording; the profile is Decaid's bundled one. The simulated machine names
no real hardware, `GET /info`'s `localIp` was empty, and nothing of the
host's is in the files, so nothing is scrubbed. As recorded, the files were
compacted (`compactAll`). Nothing else was changed.

## What they show

Each finding names the step that shows it. "Steam on" and "steam off" are
the Workflow's steam as an apply found it; a Workflow's steam is written
`temperature/time` below.

- **The strip with steam on writes each steam setting the recipe holds, and
  nothing else of steam** (`strip.json`; `recipeSteamPatch` in
  streamline-js:src/modules/steam-mode.js). Recipe `1` PUT `steamSettings:
  {flow: 1.2, duration: 40, targetTemperature: 150, stopAtTemperature: 65}`,
  `hotWaterData: {volume: 200, targetTemperature: 85, duration: 35, flow: 6}`
  and `rinseData: {duration: 5, targetTemperature: 88, flow: 6}`
  (`applyRecipe1SteamOn`): the steam temperature, the flush temperature and
  the flush flow v0.2.28 left out are all written now, and so is the steam
  flow, in the unit (ml/s) the recipe's steam mode (time) is not using.
  Recipe `2` PUT `steamSettings: {targetTemperature: 145}` alone, the
  Workflow keeping its 40 s (`applyRecipe2SteamOn`); recipe `5`
  `{duration: 35}` alone, the Workflow keeping 145 °C
  (`applyRecipe5SteamOn`); recipe `3` no steam, hot water or flush part at
  all (`applyRecipe3SteamOn`). Recipe `4` PUT `{targetTemperature: 0,
  duration: 0}`: steam off whole, the tile "Off" (`applyRecipe4SteamOn`).
- **The strip with steam off brings steam on, both halves**
  (`strip.json`). Recipe `3` left it off (`applyRecipe3SteamOff`). Recipe
  `1` PUT the same body as with steam on, 150/40 (`applyRecipe1SteamOff`).
  Recipe `2`, holding only 145 °C, PUT `{targetTemperature: 145, duration:
  40}`, the time Streamline remembered (`applyRecipe2SteamOff`); recipe `5`,
  holding only 35 s, PUT `{duration: 35, targetTemperature: 145}`, the
  temperature it remembered (`applyRecipe5SteamOff`). With 140 and 25
  remembered from the script, recipe `2` PUT 145/25 and recipe `5` 145/35:
  the recipe's own half, the remembered value for the other
  (`applyRecipe2Remembered`, `applyRecipe5Remembered`). With both keys
  deleted, recipe `5` PUT 150/35, the 150 °C default
  (`applyRecipe5NothingRemembered`); recipe `2` then PUT 145/35, not the
  30 s default, as recipe `5`'s apply had just remembered its 35 s
  (`applyRecipe2NothingRemembered`). With the keys deleted again, recipe `2`
  PUT 145/30, the default (`applyRecipe2Defaults`). The steam flow (1.2) is
  left alone in each of these, the Workflow's being usable.
- **What Streamline remembers, before and after each strip apply**
  (`strip.json`, each step's `streamlineBefore` and `streamline`;
  `mergeRecipeLiveSettings` in src/modules/dyeStrip.js). An apply that
  leaves steam on remembers what it wrote: recipe `1` all three values
  (null/null/null to 150/40/1.2, with `last-milk-stop` 65,
  `last-hot-water-volume` 200, `last-hot-water-temp` 85 and
  `last-flush-duration` 5), recipe `2` `last-steam-temp` 145 only, recipe
  `5` `last-steam-duration` 35 only; with steam off, recipe `2` and `5`
  remember both halves they wrote (for example 140/25 to 145/25 at
  `applyRecipe2Remembered`). Recipe `3` remembers nothing. Recipe `4`,
  turning steam off, writes the Workflow's steam as it found it into both
  keys, 145 and 35, the values to come back to (`applyRecipe4SteamOn`). Off
  from the script remembers nothing (each `steamOffBefore*` step).
- **DYE2's dashboard writes what the record holds, whatever the Workflow's
  steam** (`dashboard.json`; `recipeMachineSettings` in
  dye2:dye2-plugin/src/utils/dev-api.ts and `applyRecipe` in
  dye2:dye2-plugin/src/pages/dashboard.ts). Each tap PUT `profile`,
  `context` and only the steam fields that differed from the Workflow's,
  and no `hotWaterData` or `rinseData`, which already matched what recipe
  `1` holds; it posted no `selection` (DYE2 derives it from the Workflow's
  `recipeId`). With steam on: recipe `1` `steamSettings: {targetTemperature:
  150, duration: 40}` (`applyRecipe1SteamOn`), recipe `2`
  `{targetTemperature: 145}` (`applyRecipe2SteamOn`), recipe `5`
  `{duration: 35}` (`applyRecipe5SteamOn`), recipe `4` `{targetTemperature:
  0, duration: 0}` (`applyRecipe4SteamOn`), as the strip. With steam off,
  recipe `3` wrote no steam (`applyRecipe3SteamOff`) and recipe `1`
  150/40, steam on (`applyRecipe1SteamOff`), but **a temperature-only
  record left the steam time at 0**: recipe `2` PUT `{targetTemperature:
  145}` and left the Workflow at 145/0, a temperature Decaid reads as steam
  on under a tile reading "Off" (`applyRecipe2SteamOff`). **A time-only
  record left the temperature at 0**: recipe `5` PUT `{duration: 35}` and
  left the Workflow at 0/35, steam off by its temperature under a tile
  reading "35s" (`applyRecipe5SteamOff`). Streamline, open meanwhile,
  remembered the steam time each dashboard write moved (40, 35; in each
  step's `alsoSent`), never the temperature: after recipe `1`'s 150 °C,
  `last-steam-temp` stayed 145.
- **DYE2's `record` after an apply made while steam was off saves nothing
  of steam into a record holding none** (`strip.json`:
  `recordAfterRecipe2SteamOff`, `recordAfterRecipe5SteamOff`,
  `recordAfterRecipe2Remembered`, `recordAfterRecipe5Remembered`,
  `recordAfterRecipe5NothingRemembered`,
  `recordAfterRecipe2NothingRemembered`, `recordAfterRecipe2Defaults`;
  `dashboard.json`: `recordAfterRecipe2SteamOff`,
  `recordAfterRecipe5SteamOff`). Each answered `{"saved":false}`, and
  records `2` and `5` still held only 145 °C and only 35 s. From the strip
  the time or temperature steam came on with was in the Workflow before
  Streamline armed the recipe (it posts `selection` after its PUT), and
  from the dashboard the Workflow stayed as the tap left it (145/0, 0/35),
  so in neither case had the field the record lacks moved since the apply
  (`movedSinceArming` in dye2:dye2-plugin/src/utils/workflow-record.ts).
  Where `../streamline-v0.2.24/`'s `recordOnRecipe2` saved a steam time into
  recipe `2`, steam had been turned on after the apply.
- **A record holding "Off" keeps it through `record`** after its own apply
  (`strip.json` and `dashboard.json`, `recordAfterRecipe4`: `{"saved":
  false}`, recipe `4` still 0 and 0) and after the server's Loaded Recipe
  write of "Off" (`load-write.json`, `recordAfterOffEdit`, below).
- **"Off" saved in DYE2's editor** (`editor.json`, `editorOff`; the steam
  "Off" save rule in dye2:dye2-plugin/src/pages/recipe-edit.ts). The save
  wrote recipe `1` with `steamTempC: 0` and `steamTimeS: 0` (the time
  zeroed with the temperature, its other settings as they were) and an
  embedded `steamSettings: {targetTemperature: 0, duration: 0, flow: 1.2,
  stopAtTemperature: 65}`, and, recipe `1` being the selected one,
  `reapplyIfSelected` PUT the record's whole embedded Workflow with that
  `steamSettings`, its `hotWaterData` and `rinseData`, and `recipeId` "1":
  steam off, the tile "Off". Streamline remembered nothing from it
  (150/40/1.2 before and after). `record` then answered `{"saved":true}`
  but saved only the flush temperature, 25 over 88, recipe `1` keeping "Off"
  (`recordAfterEditorOff`; the simulated machine's flush temperature, as
  `../streamline-v0.2.24/` describes).
- **Steam turned back on after an editor "Off", then `record`, loses "Off"**
  (`editor.json`). Streamline's heater switch read DYE2's recipes and its
  three remembered values and PUT `{targetTemperature: 150, duration: 40}`,
  the remembered values, not the record's 0 (`heaterOn`). `record` then
  answered `{"saved":true}` and wrote `steamTempC: 150` and `steamTimeS: 40`
  into recipe `1`, in `dashboardVariables` and its embedded `steamSettings`,
  over its "Off" (`recordAfterHeaterOn`): a record holding "Off" holds 0 in
  both fields, which `itemPatch` takes for held fields to keep in step once
  steam is on.
- **An editor save of a steam temperature and time onto the loaded record
  turns steam on, whatever the Workflow's steam** (`editor.json`). With
  steam on, 155 and 45 saved onto recipe `1` wrote them into the record and
  PUT `steamSettings: {targetTemperature: 155, duration: 45, flow: 1.2,
  stopAtTemperature: 65}` (`editorOnSteamOn`); Streamline then remembered
  `last-steam-duration` 45 and kept `last-steam-temp` 150. With steam off
  from the script and recipe `1` holding "Off" again (`editorOffAgain`,
  `steamOffFromScript`), the same save PUT the same body and turned steam
  on at 155/45, the tile "45s" (`editorOnSteamOff`). The server's own "Off"
  record did the same: recipe `4`, applied (steam off) and saved with 155
  and 45, PUT `steamSettings: {targetTemperature: 155, duration: 45}` and
  steam came on (`editorOnRecipe4SteamOff`). `record` after each answered
  `{"saved":false}`.
- **The plugin's load writes change nothing where they match**
  (`load-write.json`). After recipe `1` applied from the strip with steam
  off (steam on at 150/40), `PUT /workflow` of 150 and 40 changed no field,
  and Streamline wrote and remembered nothing (`loadWriteMatching`). After
  recipe `4` with steam on (steam off), "Off" written again changed nothing
  (`loadWriteOff`).
- **The server's Loaded Recipe write of "Off" made on another Machine**
  (`load-write.json`). Recipe `1`'s record rewritten to "Off" changed
  neither the Workflow (150/40) nor the tile ("40s") nor anything
  remembered (`recordRewrittenOff`). "Off" then written into the Workflow
  turned steam off, the tile "Off", and Streamline remembered nothing
  (150/40/1.2 before and after) (`loadWriteOffEdit`). `record` after
  answered `{"saved":true}`, but saved only the simulated machine's flush
  temperature, 25 over 88: no steam field, the record still holding 0 and 0
  (`recordAfterOffEdit`). Decent Sync will see that flush temperature as an
  edit from the tablet; it is the simulated machine's, not a barista's.
- **Auto Steam keeps its steam time, flow and temperature**
  (`auto-steam.json`). With the flag set (`isAutoSteamActive` true,
  `autoSteamActive`), recipe `1`'s apply PUT `steamSettings:
  {stopAtTemperature: 65}` with its hot water and flush, and no steam
  temperature, time or flow: the Workflow kept 160/30, and Streamline
  remembered no steam value, only the milk stop, hot water and flush ones
  (`applyRecipe1AutoSteam`).
- **The settings labels #616 renames, as Streamline v0.2.31 shows them**
  (`settings-labels.json`). Quick Adjustments' navigation and the page's
  heading read "Shot control". Its rows read "Weight Look-ahead" and
  "Volume Look-ahead", each with no unit and no range shown, values 1 and
  0.3, the input's only bound `min="0"`, its − and + stepping by 0.1 and
  by 0.05; their descriptions are kept whole in `lines` (`shotControl`).
  Quick Adjustments › Hot Water's heading reads "Hot Water Settings", with
  "Duration (seconds)" ("5 – 120 s", step 5), "Flow" ("1.0 – 10.0 ml/s",
  though its input's bounds are 0.1 and 8, step 0.1), "Stop at Weight"
  ("Requires a connected scale"), and "Hot Water Look-ahead", no unit, step
  0.05, `min="0"`, "Used when Stop at Weight is on and a scale is
  connected. Higher values stop the water sooner." (`hotWater`). Calibration
  › Sensor Calibration reads "Flow calibration", value 1.00, no unit, its −
  and + calling `sensorCalFlowAdjust(-1)` and `(1)`, with "The machine's own
  flow calibration, the same setting as the De1App's Flow multiplier. The
  DE1 estimates flow rather than measuring it; this scales that estimate.
  1.0 leaves it unchanged. Range 0.13 to 2.0." (`sensorCalibration`). That
  page opened with its sensor calibration warning showing ("Bad calibration
  settings might make your espresso machine unuseable. ...", Cancel, Ok),
  and its `labels` also list the collapsed "Advanced" section's labels.
  Opening the pages wrote only Streamline's saved settings location.
- **DYE2 v0.1.42's preset chips in the recipe editor change nothing**
  (`editor.json`, `editorOff` and `editorOffAgain`, `shownAfterPreset`).
  A tap on the steam temperature's "Off" chip left the number at 150 °C
  (155 °C): `applyPreset` in dye2:dye2-plugin/src/utils/shared-components.ts
  sets the `textContent` of the stepper's value, which `stepperHtml` now
  renders as an `<input>`, whose value it does not change. Saved straight
  after the tap, the record would keep its steam temperature. The
  steppers' − and a typed number work.
- **Not recorded.** A real Auto Steam session (above); the steam tile's −
  through 0 and Streamline's Quick Adjustments › Steam page, which go
  through the same heater switch as `heaterOn`; a recipe whose steam mode
  is flow; DYE2's editor's steam time typed or stepped to Off (the steam
  temperature's "Off" was used); a save in DYE2's editor of a recipe that
  is not the selected one, which `reapplyIfSelected` leaves out of the
  Workflow; Streamline with its DYE2 switch off; and Streamline's settings
  pages' Save, which no step here needed.

## What was not as expected before the recording

- With both remembered keys deleted, recipe `5` then recipe `2` were
  expected to come back at the 150 °C and 30 s defaults. Recipe `5`'s apply
  remembered its own 35 s, so recipe `2` came back at 145/35
  (`applyRecipe2NothingRemembered`); `strip.json`'s last five steps were
  added to show recipe `2` meeting nothing remembered (145/30,
  `applyRecipe2Defaults`).
- The editor's "Off" preset does nothing in DYE2 v0.1.42 (above); "Off" was
  saved with the steam temperature's − instead.
- DYE2's `record` after steam came back on did save into a record holding
  "Off": 150 and 40 over its 0 and 0 (`recordAfterHeaterOn`).
- `record` after the server's write of "Off" answered `saved: true`; what
  it saved was the simulated machine's flush temperature, not steam
  (`recordAfterOffEdit`).
