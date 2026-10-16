# DYE2 v0.1.20 and Streamline v0.2.14 on Decaid v0.8.7

How DYE2 keeps its selected recipe and records into it, and how Streamline
applies, selects and clears, recorded as exchanges: each request a page or
the recording script sent to DYE2's `selection` endpoint, DYE2's keys in
Decaid's store (`recipes`, and `selection`, DYE2's own storage), Streamline's
remembered values (`/store/streamline-app/*`) and the Workflow, and the status
and body Decaid answered, its JSON parsed. Of the reads a page sent, only
those of DYE2's selection are kept. Requests the script sent stand for the
plugin's, or for anything else on the tablet changing the Workflow. Each step
also keeps the reads made once DYE2 would have recorded (`after`, 2.5 s after
the step, past DYE2's 1.5 s wait) and the pushes heard on DYE2's `changed`
socket during it (`pushes`). `server/test/support/simulated-dye2.ts`
simulates DYE2 and Streamline from them, and
`server/test/simulated-dye2-selection.test.ts` checks it against them.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the recording's library was made, through DYE2's pages and Decaid's API: two beans, `Fixture Ethiopia` and `Fixture Brazil`, a batch of each, the grinder `Fixture Grinder 64`, the bundled profiles the recipes use, DYE2's two baskets and two recipes (slot 1 on `Adaptive v3` with hot water by temperature and steam by time, slot 2 on `Classic Italian espresso` read from the Workflow, with hot water by volume and steam by flow), the id of a saved favourite with only its title typed, and the Workflow |
| `plugins.json` | `GET /api/v1/plugins`, DYE2's entry only, and its `selection` while loaded (`loaded`); after `POST .../disable` (`disabled`), with the selection, its store key and an attempt to open the `changed` socket; after `POST .../enable` (`enabled`), with what the socket opened before the disable heard |
| `dashboard.json` | DYE2's dashboard: `applySlot1`, tapping slot 1's pill; `writtenElsewhere`, a `PUT /workflow` from the script, as the plugin's load write would make, of the other bean's batch, a Basket and a hot water volume; `dialTap`, a tap of the grind `+`; `done`; `applyRecent`, tapping the recent favourite the Shot pulled before made; `applySavedFavourite`, the saved favourite chosen on the Auto Favourites page and applied as the dashboard opens; and `clear`, `POST .../selection {}` from the script |
| `recording.json` | `select`, slot 1 applied on the dashboard, then one change of the Workflow per step from the script: `grind`, `dose`, `yieldInContext` (the context's yield only), `brewTemperature` (every step's temperature 1 degree up), `hotWaterActiveMode` and `hotWaterOtherMode`, `steamActiveMode` and `steamOtherMode`, `flush`, `debounced` (two grinds 300 ms apart), `echo` (the grind set off the recipe's, then slot 1 selected, then a change within 3 s), `afterEcho` (a change past 3 s), `profileChange` (the other profile), `targetWeightOnly` (slot 1 applied again, then its profile with only `target_weight` changed), and `shot`, a Shot pulled |
| `restore.json` | `storedAfterClear`, DYE2's stored selection after the clears above; `restoreEmpty`, `restoreRecipe` and `restoreDrifted`: a value written to `POST /store/dye2.reaplugin/selection`, then DYE2 disabled and enabled, and its selection read ten times at once and again 1.5 s later; `driftedClearedOnChange`, a Workflow change after the drifted restore |
| `streamline.json` | Streamline's DYE strip: `applySlot2`; `drinkTile`, a tap of the Drink tile's `+`; `applySlot2Again`; `writtenBeforeShot`, a batch and Basket written from the script; `shotCleared`, a Shot pulled with Streamline open; `wake`, `loadProfileForWake` called on the profile the Drink tile saved a yield for; `applySlot2BeforeOff`; and `stripOff`, its DYE2 switch turned off |
| `fingerprints.json` | Not exchanges: after each recipe selected (`dashboardSlot1`, `dashboardSlot2`, `streamlineSlot2`), the Workflow's profile as the last `workflowUpdated` event carried it to plugins, as `GET /workflow` answered it, and the `profileFingerprint` DYE2 answered |

## How they were recorded

They were recorded on 2026-10-16 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container as
`../dye2-v0.1.19/README.md` describes, with its clock in UTC, its simulated
machine and scale connected, and its data new. Container port 8080 was
published to the host and forwarded to the host's `localhost:8080`, since
Streamline calls Decaid at its page's host on port 8080.

Decaid v0.9.0 keeps these the same: its store, Workflow writes and the
`workflowUpdated` event are unchanged, as `../dye2-v0.1.19/README.md` says,
but a Shot pulled now naming `Fixture Grinder 64` also carries its burrs,
`Fixture 64mm flat`, as `grinderBurrs` in its Workflow's context.

- **DYE2** v0.1.20 was installed over the bundled v0.1.4 with `POST
  /api/v1/plugins/install/github-release` and `{"repo":"decentespresso/dye2"}`,
  which installs the latest release; `GET /api/v1/plugins` confirmed the
  version.
- **The Workflow recorder**, `workflow-recorder/` beside this README, a
  throwaway plugin that pushes each `workflowUpdated` payload on its own
  `workflow` socket, was installed with `PUT
  /api/v1/plugins/workflow-recorder.reaplugin/source` and enabled. It ran only
  in that Decaid.
- **Streamline** v0.2.14 is the release's `streamline.js-v0.2.14.zip`,
  unzipped and served as static files at `http://localhost:13999/`, its DYE
  strip turned on, showing recipes, through the page's local storage as in
  the v0.1.19 recording. Its strip switched off is `window.applyDye2Enabled(false)`
  with `streamline.dye2Enabled` set to `false`, as its Extensions setting
  does; its wake re-send is `loadProfileForWake` called through the page's
  own module (`src/modules/profileManager.js`), as its wake does.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium and keeps sockets open on DYE2's `changed` endpoint and the
  recorder's, from the repository root: `RESTART_DECAID=<command> node
  server/test/fixtures/decaid/dye2-v0.1.20/record.mjs <output dir>`. Decaid's
  simulated machine stored only the first Shot pulled after Decaid started
  (later ones poured on and were never stored), so before each later Shot the
  script runs the command `RESTART_DECAID` names, which restarted Decaid in
  the container keeping its data, then opens the sockets again. The Shots
  are pulled on `Classic Italian espresso`, with `PUT
  /api/v1/machine/state/espresso`. It reads `DECAID` and `SKIN` from the
  environment for other addresses.

## Edits

Everything named (beans, batches, grinder, baskets, recipes, favourite,
barista and drinker) was made up for the recording; the profiles are Decaid's
bundled ones. The simulated machine reports serial `mock-de1` and names no
real hardware, so nothing is scrubbed.

## What they show

- **Loaded or not.** `GET /api/v1/plugins` lists DYE2 with `loaded` and
  `autoLoad` both true while it runs, and both false once disabled, still
  listed with its version. While it is not loaded Decaid answers its
  `selection` endpoint 404 with `{"error":"plugin with dye2.reaplugin not
  loaded"}`, and refuses a new socket on `changed` with the same 404. A socket
  opened before the disable is not closed: it stays open, silent, and hears
  the pushes of DYE2 once enabled again (`_handlePluginSocketEndpoint` in
  `decaid:lib/src/services/webserver/plugins_handler.dart` listens to every
  emit of that plugin id and endpoint, whichever load made it). Decaid's API
  has no unload without a disable: an unloaded DYE2 that would load at start
  (`loaded` false, `autoLoad` true) was not recorded.
- **Selecting.** A `POST .../selection` of `{kind, id}` answers DYE2's
  selection, `{kind, id, profileFingerprint, armedBrewC}`, the fingerprint of
  the Workflow's profile as DYE2 read it from `GET /workflow` and the
  temperature of its first step, and pushes `{"what":"workflow"}`. `{}`
  answers `null`, pushes nothing, and leaves the stored selection as it was:
  DYE2 stores `null`, which Decaid's plugin storage refuses (its log shows a
  `TypeError` from `_handlePluginStorage`), so `GET
  /store/dye2.reaplugin/selection` still answers the selection cleared. A
  recent favourite applied posts `{}`; a saved one selects
  `{"kind":"favourite"}`.
- **Its dashboard copy.** The dashboard sends the whole Workflow it read as
  it opened, with each change made there, on each tap and on Done: the batch,
  coffee and hot water volume the script wrote meanwhile went back to the
  page's (`dialTap`). Decaid merges a `PUT /workflow` into the Workflow, so
  the Basket, which the page's copy did not hold, stayed. DYE2 recorded the
  tap's grind into the selected recipe; Done, sending the same copy again,
  recorded nothing and pushed nothing.
- **Recording.** Each change of a field the recipe holds is recorded into
  it after DYE2's wait, `workflow.context` kept in step for the dose, yield
  and grind, and pushed once written: the grind, dose, yield, the steam and
  hot water values of the recipe's modes, and the flush. A change of the
  other mode's value, or one that leaves every field as the recipe holds it,
  records nothing and pushes nothing. The brew temperature is recorded once
  the first step's temperature moves off `armedBrewC`, which then follows it.
  Two changes within the wait record the later one only. A change within 3 s
  of a selection whose recorded fields equal the Workflow's at the selection
  is DYE2's echo and is ignored; after 3 s the same values are recorded
  (`echo`, `afterEcho`). A change of profile, or of only its `target_weight`,
  clears the selection, records nothing and pushes nothing. Each Shot stored
  pushes once, after DYE2 refreshes its recent favourites.
- **Restoring.** DYE2 restores its stored selection as it loads, `{}` as no
  selection, and the selection stored as it was, its fingerprint and
  `armedBrewC` included, even one made on another profile. Here every read
  from the first after `POST .../enable` answered already found it restored:
  Decaid answers the enable once DYE2 has loaded, by when it has read its
  storage. A restored selection made on another profile is cleared at the
  Workflow's next change, recording nothing.
- **The fingerprint.** The profile `workflowUpdated` carried and the one `GET
  /workflow` answered are the same, and DYE2's `profileFingerprint` is
  `profileFingerprint` of them (`dye2:dye2-plugin/src/utils/workflow-record.ts`).
- **Streamline applying a recipe** keeps its steam, hot water and flush values
  under `streamline-app`, sends the whole Workflow with the recipe's embedded
  context merged in, its Profile at its own step temperatures (slot 2, saved
  at 93, goes at 94), then selects it, which pushes.
- **The Drink tile** sends `{context: {targetDoseWeight, targetYield}, profile}`,
  the profile being Streamline's library record of the active profile with
  `target_weight` set to the yield. That clears DYE2's selection, which
  records nothing and pushes nothing.
- **After a Shot** Streamline sends `{context: {beanBatchId, coffeeName,
  coffeeRoaster, grinderId, grinderModel, baristaName, drinkerName: null,
  extras: {basketId, basketName, rpm, note, dye: null}}}`, leaving the dose,
  yield and grind setting (`clearDyeWorkflowContext` in
  `streamline-js:src/modules/dyeStrip.js`; DYE2 v0.1.20 writes no
  `extras.dye` marker, so the clear is not scoped). The selection stays, as no
  field DYE2 records changed.
- **A wake** sends `{profile, context: {targetDoseWeight, targetYield,
  grinderSetting}}`: the profile with `target_weight` at the yield saved for
  it, here the Drink tile's 37, the dose saved, else the last dose set, else
  18, and the grind saved, else the last set, else null, which clears the
  Workflow's grind setting. The changed target weight cleared DYE2's
  selection.
- **The strip switched off** posts `{}` to DYE2's `selection`, which answers
  `null`, with no Workflow change.
