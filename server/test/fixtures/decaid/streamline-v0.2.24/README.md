# Streamline v0.2.24 and DYE2 v0.1.36 on Decaid v0.9.1

What Streamline v0.2.24 and DYE2 v0.1.36 write to Decaid v0.9.1, recorded as
`../dye2-v0.1.33/` records DYE2 and Streamline: each request a page or the
recording script sent, and the status and body Decaid answered, its JSON
parsed. Requests the script sent stand for the plugin's (its load write, its
`record` call, the previous and the new release's Workflow writes), for
Decent Sync's server (a recipe's record written), or for another device's
Streamline (its remembered values). They were recorded for decent-sync #461,
and take the place of `streamline-v0.2.23/`, recorded for #394 with DYE2
v0.1.33: its steam steps made again on v0.2.24, whose heater switch brings
steam back at the steam time it was switched off at; a profile switch after a
dial-in; the Grind tile's label; and DYE2 v0.1.36's Grinders page, where a tap
on a grinder's card writes it into the Workflow.

A step is `{exchanges, alsoSent, after, streamline, tiles, pushes, events,
timing}`:

- `exchanges`: what the step's action sent. On Streamline's pages every
  request but a read is kept, whatever its route; of the reads, only those
  of DYE2's `selection` route and `recipes` key, the Workflow, and
  Streamline's keys in `streamline-app` (its remembered values). On DYE2's
  Grinders page and grinder picker, every request but a read, and reads of
  `selection`, `recipes` and the Workflow. Some steps also hold an entry that
  is no exchange:
  - the Settings toggle's, `{"toggle": <checked>}`, the toggle's state once
    the action was done;
  - the Grind label's and the grinder picker's, `{"navigated": [...]}`, each
    address the page went to, in order, without its origin;
  - those on a DYE2 grinder grid, `{"cards": [...]}`, each grinder's name and
    whether its card was the highlighted one, and the hold's
    `{"editorOpen": <whether the grinder's form was open>}`;
  - `labelDye2Off`, `{"settingsLocation", "mainPageShown"}`, where
    Streamline's settings page was opened.
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
  settings page is open, null once the page is closed or on a DYE2 page).
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
buttons 1 to 3, each naming the grinder `Fixture Grinder 64`:

| Recipe | Name | Steam mode | Settings it holds |
|---|---|---|---|
| `1` | `Fixture Steam Recipe` | time | every setting a Recipe may hold (`RECIPE_SETTINGS` in protocol/src/index.ts): steam 150 °C, 40 s, 1.2 ml/s, milk stop 65 °C; hot water 85 °C, 35 s, 200 ml, 6 ml/s; flush 88 °C, 5 s, 6 ml/s |
| `2` | `Fixture Steam Temperature Only` | time | a steam temperature of 145 °C, no steam time |
| `3` | `Fixture No Steam` | none | none |

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (a bean, `Fixture Ethiopia`, and a batch of it, the grinders `Fixture Grinder 64` and `Fixture Grinder 83`, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, the simulated machine's settings and advanced settings, `GET /info`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `bundledDye2`, the bundled DYE2's entry in `GET /plugins` (v0.1.31); `install`, `POST /plugins/install/github-branch` of DYE2 v0.1.36's `dist` deploy and its answer; `listed`, DYE2's entry after (v0.1.36, loaded); `seeded`, the script's writes of DYE2's recipes and the Workflow as Decent Sync's server leaves them, every DYE2 key and the Workflow read back, and Streamline's remembered steam values (none) |
| `strip.json` | Step 1, Streamline's DYE strip with its DYE2 switch on: `started`, its page load; `cells`, the names its five buttons showed (not a step); `applyRecipe1`, `applyRecipe2`, `applyRecipe3`, each recipe's button tapped |
| `heater.json` | Steps 2 to 4, the steam heater switched through `setSteamHeaterEnabled` (below). With Streamline's DYE2 switch on: `reseeded`; `startedDye2On`; `applyRecipe3First` and `applyRecipe1` from the strip; `loadWrite`, recipe `1`'s settings written into the Workflow from the script, as the plugin's load write writes a Loaded Recipe's; `heaterOffDye2On`; `heaterOnDye2On`; `heaterOffAgainDye2On`; `rememberedOtherwise`, `last-steam-temp` 140 and `last-steam-duration` 25 written from the script; `heaterOnRecipeWins`. With it off, on a new page: `startedDye2Off`; `heaterOffDye2Off`; `heaterOnDye2Off`; `heaterOffAgainDye2Off`; `rememberedOtherwiseDye2Off` (140 and 25); `heaterOnRememberedDye2Off`. With it on again: `startedRecipe2`; `applyRecipe2`; `loadWriteRecipe2`, its 145 °C written from the script; `heaterOffRecipe2`; `heaterOnRecipe2`; `heaterOffRecipe2Again`; `rememberedDurationRemoved`, `DELETE` of `last-steam-duration` from the script; `heaterOnRecipe2NothingRemembered` |
| `tile.json` | Step 6, the main page's steam tile, DYE2 switch on: `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `heaterOff`; `plusFromOff`, the tile's + (`#steam-plus`) tapped while it shows "Off"; `steamTimeZeroHeaterOn`, `PUT /workflow {"steamSettings":{"duration":0}}` from the script while the heater is on; `plusWithHeaterOn`, the tile's + tapped then |
| `settings.json` | Step 5, Settings › Calibration › Steam's heater toggle (`#steamHeaterToggle`), DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `workflowSteamOtherwise`, the Workflow's steam written 155 °C and 35 s from the script; `opened`, the settings page opened from the main page's settings button at Calibration › Steam; `toggleOff`; `saveOff`, Save (`#save-settings-btn`), which returns to the main page; `openedAgain`; `toggleOn`; `saveOn`; `openedThird`; `toggleOffAgain`; `saveOffAgain`; `openedFresh`, the page loaded afresh at `?page=settings` (Calibration › Steam) while steam is off; `toggleOnFresh`; `saveOnFresh` |
| `record.json` | Step 7, DYE2's `record` (`POST /plugins/dye2.reaplugin/record` from the script, as the plugin calls it after each change). DYE2 switch on: `reseeded`; `startedDye2On`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `recordLoaded`; `heaterOff`; `recordOff`. DYE2 switch off, on a new page: `startedDye2Off`; `heaterOnDye2Off`; `recordOnDye2Off`; `heaterOffDye2Off`; `recordOffDye2Off`; `rememberedOtherwise` (140 and 25); `heaterOnRememberedDye2Off`; `recordOnRememberedDye2Off`. DYE2 switch on, on a new page: `startedRecipe2`; `heaterOffBeforeRecipe2`; `recordOffBeforeRecipe2`; `applyRecipe2WhileOff`, recipe `2` from the strip while steam is off; `heaterOnRecipe2`; `recordOnRecipe2` |
| `steam-off-edit.json` | Step 9, a Recipe edited while its Machine's steam is off, DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `heaterOff`; `recordRewritten`, recipe `1`'s record rewritten from the script as Decent Sync's server writes an edit (steam 155 °C, 45 s, 1.0 ml/s, record only); `previousPluginWrite`, `PUT /workflow {"steamSettings":{"duration":45,"flow":1}}`, as the plugin of a release before 1.6.3 wrote it (no temperature while off); `steamTimeBackToZero`, `{"steamSettings":{"duration":0}}`; `newPluginWrite`, `{"steamSettings":{"flow":1,"stopAtTemperature":65}}`, as the plugin writes it; `reloaded`, Streamline loaded again |
| `settings-kept.json` | Step 10, on a page of its own (`settings`): `started`; `machineBefore`, `GET /machine/settings` and `/machine/settings/advanced` (not a step); `fanSaved`, Calibration › Fan typed to 45 and saved; `refillKitSaved`, Calibration › Refill Kit set to Force Off and saved; `machineSaved` (not a step); `restoreRecord`, Streamline's restore record (`userMachineSettings` in the page's IndexedDB `shot_history`, store `settings`; not a step); `editedElsewhere`, `POST /machine/settings {"fan":50}` and `POST /machine/settings/advanced {"refillKitSetting":2}` from the script, the routes Decent Sync's Settings Edits use (`plugin/src/settings-edits.ts`); `settingsOpened`, the settings page loaded afresh at Calibration › Fan and left open for about 15 s; `machineAfter`; `restoreRecordAfter` |
| `profile-switch.json` | Step 11, a profile switch after a dial-in, DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `selectClassic`, `Classic Italian espresso` picked in the profile selector (opened from `#profile-select-btn`) and Confirmed (`#confirm-profile-btn`); `dosePlus`, the dose tile's + (`#dose-in-plus`); `selectAdaptive`, `Adaptive v3` Confirmed; `selectClassicAgain`; `applyRecipe1Again`, from the strip; `asleep`, `PUT /machine/state/sleeping` from the script, once `Classic Italian espresso` was set as the profile to load on a wake (`wakeProfileEnabled`, `wakeProfileId` in the page's storage); `woken`, `PUT /machine/state/idle` from the script, and what Streamline sent in the 8 s after |
| `grind-label.json` | Step 12, the Grind tile's label (`#grind-label`) tapped. DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `labelWithRecipe`; `backWithoutSaving`, Streamline's main page loaded again; `selectClassic`, a profile switch, which leaves the Workflow naming no recipe; `labelWithNoRecipe`, with the cards DYE2's grinder picker showed; `pickerConfirm`, `Fixture Grinder 83`'s card tapped and CONFIRM (`#dye-confirm-btn`). DYE2 switch off, on a new page: `startedDye2Off`; `labelDye2Off` |
| `grinders-page.json` | Step 13, DYE2 v0.1.36's Grinders page (`grinders`) in its own page while Streamline's main page stays open, DYE2 switch on: `reseeded`; `started`; `applyRecipe3First`, `applyRecipe1`; `loadWrite`; `opened`, the page loaded; `tapOther`, `Fixture Grinder 83`'s card tapped; `recordAfterTap`, DYE2's `record` from the script; `holdCard`, `Fixture Grinder 64`'s card held for 800 ms, and its form's CANCEL; `tapBack`, `Fixture Grinder 64`'s card tapped; `recordAfterTapBack`; `selectClassic`, a profile switch in Streamline, which leaves the Workflow naming no recipe; `openedNoRecipe`, the page loaded again; `tapOtherNoRecipe`; `recordNoRecipe` |
| `keys.json` | Not exchanges: DYE2's recipes and stored selection at the end |

## How they were recorded

They were recorded on 2026-11-10 (UTC) by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1`, build
3027, commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container
as `../dye2-v0.1.33/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account` with its simulated machine and scale, its
data new, container port 8080 published to the host's `localhost:8080`. No
tablet was contacted: the owner's three tablets run Streamline v0.2.23 and
DYE2 v0.1.35 pinned, so they hold nothing of these releases, and no record
shapes were read from one.

- **DYE2** v0.1.36 is the latest release and the floor. The script installs
  it as a pinned tablet has it: `POST /api/v1/plugins/install/github-branch
  {"repo":"decentespresso/dye2",
  "branch":"fbdde5a3b5829beaf6cddbb771dc8fb686203217"}`, the `dist` deploy
  of the v0.1.36 tag's `c5ae831`, over the bundled v0.1.31. Decaid answered
  `{"message":"Plugin installed","id":"dye2.reaplugin","version":"0.1.36",
  "loaded":true}`. The installed `plugin.js` (SHA-256
  `015f2ac032bc22f4ae32c0e33c924937ca79d48092f9ab0234e8c050735ee7cb`) and
  `manifest.json` (SHA-256
  `71d9be18939e4a4e432d1bb573053e885efccd7e97e080e5487dac84b2cacfe4`) are
  byte for byte the tag's `dye2.reaplugin/`.
- **The seeded keys.** Once it is loaded, the script writes recipes `1` to
  `3` (above) as Decent Sync's server writes them (`recipeRecord` and
  `recipeWorkflow` in server/src/library/recipe-intake.ts: the settings
  each holds in `dashboardVariables` and in its embedded Workflow, shown
  exactly while in a slot, a whole record in `jsonb`'s key order, its Bean's
  coffee, roaster and batch or explicit nulls for none, and a made-up global
  id), and the Workflow on the Ethiopia's batch. Each step group after the
  first starts by writing the seeded records again (`reseeded`), as the
  server writes a Recipe's record back, so what an earlier group's `record`
  saved does not carry over. The Workflow, Streamline's remembered values
  and what it saved for a profile do: from `dosePlus` on, Streamline holds a
  dose of 19 g for `Classic Italian espresso`
  (`streamlineProfileOverrides`), which steps 12 and 13's switches to that
  profile send.
- **Streamline** v0.2.24 is its repository's files at the tag (`git archive
  v0.2.24`, commit `10d2bc0`), served as static files at
  `http://localhost:13999/` and switched to its DYE strip as for
  `../dye2-v0.1.26/`. Each group opens it in a browser context of its own,
  its DYE2 switch (`streamline.dye2Enabled`) set before it loads. Streamline
  mirrors that switch into Decaid's store (`streamlineSettings`,
  src/modules/settingsSync.js) and takes the store's value over the page's
  own as it loads, so the script writes the store's too each time it loads
  a page (the first exchange of each `started*` step and of `reloaded`).
  With the switch off, Streamline shows no DYE strip.
- **Another origin than Decaid's.** Streamline is served from port 13999 and
  DYE2's pages from Decaid's 8080, so Streamline opens a DYE2 page by sending
  the whole page there, with `?return=` naming its own address, where a skin
  served from DYE2's own origin opens it in an overlay
  (`openPluginOverlay` in src/modules/dyeStrip.js). What the DYE2 page writes
  is the same either way.
- **The heater switch.** Streamline v0.2.24's main page has no steam heater
  switch of its own: its steam tile's − at the shortest time and + from Off
  call `setSteamHeaterEnabled` (`switchSteamHeater` in src/modules/ui.js),
  as does its descaling page. The `heater*` steps call that function in the
  page's own module (`await import("/src/modules/api.js")`), the one writer
  behind each of them. `plusFromOff` and `plusWithHeaterOn` tap the tile's
  + itself.
- **The wake.** The script sets the profile to load on a wake in the page's
  own storage, as Streamline's settings page does, which Streamline mirrors
  into Decaid's store (`asleep`'s `alsoSent`), and puts the simulated machine
  to sleep and wakes it through `PUT /api/v1/machine/state/{state}`.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (`@playwright/test` 1.63.0), from the repository root, with Node
  v26.13.0: `node server/test/fixtures/decaid/streamline-v0.2.24/record.mjs
  <output dir>`. It restarts no Decaid and pulls no Shot. It reads `DECAID`
  and `SKIN` from the environment for other addresses. The run recorded here
  was the first on its fresh Decaid and took about twelve minutes. A trial
  run on another fresh one, before the script kept each address a page went
  to, recorded the same writes, remembered values and tiles in every step,
  but for the ids Decaid gave.

## Edits

Everything named (bean, batch, grinders, recipes) was made up for the
recording; the profiles are Decaid's bundled ones. The simulated machine
names no real hardware, and nothing of the host's is in the files, so
nothing is scrubbed. As recorded, the files were compacted as
`../dye2-v0.1.33/` describes (`compactAll`). Nothing else was changed.

## What they show

- **The strip applies as v0.2.23's did** (`strip.json`;
  `mergeRecipeLiveSettings` in streamline-js:src/modules/dyeStrip.js,
  `65460d4`). Recipe `1`'s button PUT its context and profile with
  `steamSettings: {duration: 40, stopAtTemperature: 65}`, `hotWaterData:
  {volume: 200, targetTemperature: 85, duration: 35, flow: 6}` and
  `rinseData: {duration: 5}`, after keeping `last-steam-duration` 40,
  `last-milk-stop` 65, `last-hot-water-volume` 200, `last-hot-water-temp` 85
  and `last-flush-duration` 5. No steam temperature, no steam flow (the
  recipe's steam mode is time), no flush temperature or flow. Recipe `2`
  (steam mode time, no steam time) and recipe `3` wrote their context and
  profile only.
- **Steam off keeps the time it was at** (`heater.json`, every `heaterOff*`
  step; `steamHeaterFor` in src/modules/api.js). Streamline reads the
  Workflow, keeps `last-steam-temp` and `last-steam-duration` (each where
  above 0), and PUTs `{"steamSettings":{"targetTemperature":0,
  "duration":0}}`. The simulated machine's shot settings then echo a steam
  time of 0, and **Streamline no longer takes it**: `last-steam-duration`
  read 40 after `heaterOffDye2On`, where v0.2.23 wrote 0 over it within a
  second (`steamDurationResyncable` in src/modules/steam-mode.js,
  `resyncDriftedShotSettings` in src/modules/app.js;
  decentespresso/streamline-js#191, `27c0e69`).
- **Steam on, DYE2 switch on** (`heater.json`). Streamline reads DYE2's
  recipes (and its stored selection, whose read is not kept) and its three
  remembered values, and PUTs `{"steamSettings":{"targetTemperature":150,
  "duration":40}}`, recipe `1`'s (`heaterOnDye2On`). The recipe's values win
  over remembered ones of 140 and 25, and Streamline then keeps
  `last-steam-duration` 40 (`heaterOnRecipeWins`). No flow is written: the
  Workflow's is usable.
- **Steam on, DYE2 switch off** (`heater.json`). Streamline reads no DYE2
  key. With only what it remembered itself, it PUT
  `{"targetTemperature":150,"duration":40}` (`heaterOnDye2Off`): the
  temperature and the time steam was at as it turned it off, where v0.2.23
  PUT a steam time of 1 s. With remembered values of 140 and 25 written from
  the script it PUT `{"targetTemperature":140,"duration":25}`
  (`heaterOnRememberedDye2Off`), the remembered values over the recipe's.
- **Recipe `2`, no steam time** (`heater.json`). With the DYE2 switch on,
  steam came back at `{"targetTemperature":145,"duration":25}`
  (`heaterOnRecipe2`): the recipe's temperature, and the 25 s steam was at
  as it was turned off, where v0.2.23 PUT 1 s. With `last-steam-duration`
  removed, `{"targetTemperature":145,"duration":30}`
  (`heaterOnRecipe2NothingRemembered`): Streamline holds no steam time for
  `Classic Italian espresso`, so the default 30 s.
- **Settings › Calibration › Steam** (`settings.json`; `setSteamHeaterOn` and
  `flushPendingChanges` in src/settings/settings.js). The toggle stages; it
  writes nothing until Save. Off and Save PUT
  `{"steamSettings":{"targetTemperature":0,"duration":0}}` and keep nothing
  (Save keeps only values above 0), and `last-steam-duration` stayed 35, the
  time the main page had adopted from the script's write. On and Save, in
  the same page session, PUT `{"targetTemperature":155,"duration":35}`, the
  values the page turned off (the Workflow's, set from the script), not
  recipe `1`'s 150 and 40, and kept `last-steam-duration` 35 and
  `last-steam-temp` 155. Loaded afresh while steam was off, on and Save PUT
  `{"targetTemperature":155,"duration":35}` too (`saveOnFresh`): as it
  loaded, the page read `last-steam-temp` (155) and `last-steam-duration`
  (35) from the store (`seedRememberedSteamValues`), where in v0.2.23 the
  time kept was 0 and the page fell to 30 s.
- **The steam tile** (`tile.json`). With the heater off it shows "Off"
  (`heaterOff`). Its + from Off calls `setSteamHeaterEnabled(true)`, the same
  path as above, and PUT `{"targetTemperature":150,"duration":40}`, recipe
  `1`'s with the DYE2 switch on (`plusFromOff`). A steam time of 0 written
  from the script while the heater is on shows "Off" with the Workflow's
  steam temperature still 150, and `last-steam-duration` stays 40
  (`steamTimeZeroHeaterOn`). The tile's + then PUT `{"steamSettings":{}}`
  and changed nothing: with the heater on, `steamHeaterFor(true)` returns no
  patch (`plusWithHeaterOn`).
- **DYE2's `record` around steam** (`record.json`). Right after the load
  write it answered `saved: true` (`recordLoaded`): it saved the simulated
  machine's flush temperature, 25, over recipe `1`'s 88, as DYE2 reads the
  flush temperature from the machine's settings, which Decaid's simulated
  machine holds at 25 whatever the Workflow's is. With steam off it answered
  `saved: false` (`recordOff`, `recordOffDye2Off`,
  `recordOffBeforeRecipe2`). After steam came back on with the DYE2 switch
  off at 150 °C and 40 s, the recipe's own, it answered `saved: false`
  (`recordOnDye2Off`), where v0.2.23's 1 s was saved into recipe `1`. After
  it came back at remembered values of 140 and 25, it saved `steamTempC: 140`
  and `steamTimeS: 25` (`recordOnRememberedDye2Off`). Recipe `2`, applied
  while steam was off (the Workflow's steam time 0 at the apply) and then
  turned back on at 145 °C and the 25 s Streamline remembered, took
  `steamTimeS: 25`, a field it did not hold (`recordOnRecipe2`;
  `movedSinceArming` in dye2:dye2-plugin/src/utils/workflow-record.ts).
- **A Recipe edited while steam is off** (`steam-off-edit.json`). An earlier
  plugin's write of the new steam time and flow into a Workflow whose steam
  is off left it at `{targetTemperature: 0, duration: 45, flow: 1}`.
  Streamline's tile showed "45s" with the heater off, and Streamline adopted
  `last-steam-duration` 45 (`previousPluginWrite`), a time of 1 s or more
  being one it still takes. Putting the time back to 0 showed "Off", and
  `last-steam-duration` stayed 45, where v0.2.23 adopted 0
  (`steamTimeBackToZero`). The plugin's write of flow and milk stop alone
  changed neither the tile's time ("Off") nor any remembered value
  (`newPluginWrite`).
- **The fan threshold and refill kit kept** (`settings-kept.json`;
  `splitDifferences` and `decaidKeepsMachineSettings` in
  src/settings/settings-restore.js, `464a448`), as in v0.2.23. Saved on
  Streamline's page, 45 and Force Off went to `POST /machine/settings
  {"fan":45}` and `POST /machine/settings/advanced {"refillKitSetting":0}`
  (both answered 202), and its restore record tracked both. After the script
  wrote 50 and Auto-Detect (2), the settings page, loaded afresh and left
  open, sent no write to either route. Its restore record took the machine's
  50 and 2 (`restoreRecordAfter`), and the machine kept them
  (`machineAfter`).
- **A profile switch leaves the dose and grind setting**
  (`profile-switch.json`; `profileSwitchDial` in
  src/modules/profile-overrides.js, `f8e8638`). With recipe `1` applied, 18 g
  and a grind setting of 2.5, the selector's Confirm of `Classic Italian
  espresso` PUT the profile with `context: {targetYield: 36, extras: {dye:
  {v: 1, recipeId: null}}}`: no dose and no grind setting, so the Workflow
  kept 18 g and 2.5, and named no recipe (`selectClassic`). The dose tile's +
  PUT 19 g and saved `{"targetDoseWeight":19}` for that profile in
  `streamlineProfileOverrides` (`dosePlus`). `Adaptive v3`, which Streamline
  holds nothing for, was sent with the yield alone again, the Workflow
  keeping 19 g (`selectAdaptive`), and `Classic Italian espresso` with
  `targetDoseWeight: 19`, the dose saved for it, and still no grind setting
  (`selectClassicAgain`). With recipe `1` applied again and the machine put
  to sleep and woken, Streamline's wake onto `Classic Italian espresso` PUT
  the same: the profile, 19 g, the yield and `recipeId: null` (`woken`).
- **The Grind label** (`grind-label.json`; `openGrinderSurface` in
  src/modules/dyeStrip.js, `7871fa6`). With recipe `1` named in the
  Workflow, the label sent the page to DYE2's `recipe-edit?return=…&id=1`,
  the recipe's editor, which then dropped the `id` from its address; nothing
  was written (`labelWithRecipe`). With no recipe named, it sent the page to
  DYE2's `grinder-picker?return=…`, which highlighted neither grinder; no
  write (`labelWithNoRecipe`). `Fixture Grinder 83`'s card and CONFIRM PUT
  `{"context":{"grinderId":"…","grinderModel":"Fixture Grinder 83",
  "extras":{"dye":{"v":1,"grinderId":true,"grinderModel":true}}}}`, and the
  page went back to the `?return=` address, Streamline's main page
  (`pickerConfirm`; `leavePicker` in
  dye2:dye2-plugin/src/pages/grinder-picker.ts). With Streamline's DYE2
  switch off, the label opened Streamline's own settings at Connection ›
  Grinder (`bluetooth`, `ble_grinder`), keeping that location in
  `streamlineSettings`, and wrote nothing into the Workflow (`labelDye2Off`).
- **A tap on DYE2's Grinders page picks the grinder** (`grinders-page.json`;
  `renderGrinderCards` in dye2:dye2-plugin/src/pages/grinders.ts,
  `fa1d93f`). The page highlights the grinder the live Workflow names,
  `Fixture Grinder 64` (`opened`). A tap on `Fixture Grinder 83`'s card PUT
  `{"context":{"grinderId":"…","grinderModel":"Fixture Grinder 83",
  "extras":{"dye":{"v":1,"grinderId":true,"grinderModel":true}}}}` at once,
  the picker's CONFIRM's body, and moved the highlight; the Workflow went on
  naming recipe `1`, its grind setting 2.5 (`tapOther`). DYE2's `record`
  after answered `saved: true` and saved no grinder: recipe `1`'s record kept
  `Fixture Grinder 64`, and took only the simulated machine's flush
  temperature, as `recordLoaded` above; DYE2's selection then read
  `modified: true` (`recordAfterTap`). A hold of 800 ms on `Fixture Grinder
  64`'s card opened its form and wrote nothing, the highlight staying where
  it was (`holdCard`). A tap on it wrote it back (`tapBack`), and `record`
  answered `saved: false` (`recordAfterTapBack`). With no recipe named, the
  tap wrote the same body (`tapOtherNoRecipe`), and `record` answered
  `{"saved":false,"reason":"no recipe is selected"}` (`recordNoRecipe`).
- **Not recorded.** Streamline's Quick Adjustments › Steam page, the
  descaling page's use of the heater switch, a steam flow put back by
  `steamOnPatch` (the Workflow's flow was usable throughout), the
  per-profile steam fallback (`activeProfileSteamFallback`: no profile held
  a steam time in Streamline), a profile switch from the favourite buttons
  or the selector's context menu, which go through `profileSwitchDial` too,
  the Grind label with a favourite applied, a save in DYE2's recipe editor
  opened from the label, DYE2's editor's steam time of 0, which
  `../dye2-v0.1.35/steam.json` records, and Streamline's steam counter,
  touch sounds and its `[AUDIT]` log lines, which write nothing to Decaid.
