# DYE2 v0.1.19 and Streamline v0.2.13 on Decaid v0.8.7

What DYE2 and Streamline write to Decaid as a barista uses them, recorded as
exchanges: each request their pages sent to DYE2's keys in Decaid's store
(`/store/dye2.reaplugin/recipes`, `baskets` and `equipment`, its tools),
Streamline's remembered values (`/store/streamline-app/*`), the Workflow and
single Shots, and the status and body Decaid answered, its JSON parsed. Each
file but `library.json`, `store.json` and `keys.json` holds named steps, each
one action in an app and the exchanges it made, in order, but for
`shot.json`'s `pulled` and `edited`, each a single read of the Shot. The
requests they make to other routes, such as the library's lists, to DYE2's
`autoFavourites` key and to Streamline's other namespaces of the store
(`streamlineSettings` and `streamlineProfileOverrides`) are not kept.
`server/test/support/simulated-dye2.ts` replays these steps on a simulated
tablet, and `server/test/simulated-dye2-writes.test.ts` checks that doing so
leaves what was recorded.

| File | Steps |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed before DYE2 started, made through its API for the recording: two beans, `Fixture Ethiopia` and `Fixture Brazil`, a batch of each, the grinder `Fixture Grinder 64`, the two bundled profiles the recipes use, and Decaid's default Workflow |
| `store.json` | Decaid's store, sent from the host rather than an app, before DYE2 wrote anything: `GET` of `recipes`, never written, which answers `null`; `POST` of an empty list, which answers `{}`; `GET`; `DELETE`, which answers `{}`; `GET`, `null` again; `DELETE` again, of a key it no longer holds, which answers `{}` |
| `tools.json` | DYE2's equipment page: `createWdtTool` with two fields, `createPuckScreen` with one, `createSpareTamper` with none, `editWdtTool` changing a field's value, and `deleteSpareTamper` |
| `baskets.json` | DYE2's baskets page: `create18gBasket` with every field, `create20gBasket` without notes, and `edit18gBasket` changing its notes and diameter. DYE2 cannot delete a basket |
| `recipes.json` | DYE2's recipe editor: `saveSlot1` with every field filled (name, beverage, barista, drinker, Bean, a Profile picked from the library, Grinder, Basket, two Tools, one with a value of its own for this recipe, dose, yield, brew temperature, steam by time, flush, hot water by temperature, grind setting and RPM); `saveSlot2` with its Profile read from the Workflow, then a name, Bean, Grinder, Basket, one Tool, dose, yield, steam by flow, flush, hot water by volume, grind setting and RPM; `editSlot1` changing its dose, grind setting and hot water temperature; and `saveBlankSlot3`, only its name typed |
| `dye2-applies.json` | DYE2's dashboard: `applySlot1`, `applySlot2`, `applyBlankSlot3` and `applySlot1Again`, tapping each recipe's pill, and `pickBasket`, picking `Fixture 20g High-flow` for the next Shot |
| `shot.json` | `pulled`: the Shot then pulled on the simulated machine, read with `GET /shots/{id}`. DYE2's Edit Shot page: `openEditShot`, `pickShotBasket` choosing `Fixture 18g Precision`, and `saveShot` adding both Tools, one with a value of its own; `edited`: the Shot read again |
| `streamline.json` | Streamline's DYE strip: `applySlot2`, tapping slot 2; its auto-save into slot 2 after a barista's change in Streamline of the dose (`autoSaveDose`), grind setting (`autoSaveGrind`), hot water volume (`autoSaveHotWater`) and steam flow (`autoSaveSteam`), each one tap of its `+`; `applySlot1`, tapping slot 1; and `noAutoSaveAfterLibraryProfile`, a grind change that is not saved into it |
| `keys.json` | Not exchanges: DYE2's three keys as `GET` answered them once every step was done |

## How they were recorded

They were recorded on 2026-10-12 by Decaid's v0.8.7 Linux arm64 release
(`decaid-linux-arm64-0.8.7.tar.gz`, checked against the release's SHA-256
sums), run headless in a throwaway Ubuntu 24.04 container as
`../workflow-writes-v0.8.7/README.md` describes, with `TZ=America/Chicago` but
no `tzdata` package, so its clock read UTC: Xvfb as its display, a D-Bus
system bus and Avahi running, started as `decaid --serial --bypass-onboarding
--no-account` with `~/.local/share/decaid/shared_preferences.json` set to
`{"simulateDevices":["machine","scale"],"onboardingCompleted":true,"accountStepSeen":true}`,
so its simulated machine and scale were connected. Its data was new, as on a
fresh install. Container port 8080 was published to the host and forwarded to
the host's `localhost:8080`, since Streamline calls Decaid at its page's host
on port 8080.

- **DYE2** v0.1.19 was installed over the bundled v0.1.4 with `POST
  /api/v1/plugins/install/github-release` and
  `{"repo":"decentespresso/dye2"}`, which installs the latest release, then
  v0.1.19; `GET /api/v1/plugins` confirmed the version. Its pages were opened
  at `http://localhost:8080/api/v1/plugins/dye2.reaplugin/<page>`.
- **Streamline** v0.2.13 is the release's `streamline.js-v0.2.13.zip` (`gh
  release download v0.2.13 --repo decentespresso/streamline-js`), unzipped and
  served as static files at `http://localhost:13999/`. These are the files
  Decaid serves as a skin; Decaid serves an installed skin on a port of its
  own that the container did not publish. Its DYE strip was turned on, showing
  recipes, by setting `streamline.dye2Enabled` to `true` and
  `streamline.dyeStripMode` to `R` in the page's local storage before it
  loaded, as its Extensions setting does.
- **The pages** were driven by `record.mjs`, beside this README, in
  Playwright's headless Chromium (1280x800 for DYE2, 1920x1200 for
  Streamline), from the repository root: `node
  server/test/fixtures/decaid/dye2-v0.1.19/record.mjs <output dir>`. It makes
  the library, records `store.json`, then each file above in its order, and
  writes them all. Each kept request is fetched by Playwright and its answer
  handed to the page unchanged, so an answer is recorded even when a page
  navigates away before reading it. Before reading slot 2's values from the
  Workflow it sets the Workflow's profile to the bundled `Classic Italian
  espresso` with `PUT /api/v1/workflow`, as a skin does; between `pickBasket`
  and `pulled` it starts the Shot with `PUT /api/v1/machine/state/espresso`
  and waits for the simulated machine to end it, and before Streamline starts
  it sets the machine idle. Those requests are not in the files.

To record them again, set up the container as above, install DYE2, serve
Streamline's files and forward port 8080, then run `record.mjs` against
Decaid's new data. It reads `DECAID` and `SKIN` from the environment for other
addresses. A newer DYE2 or Streamline is recorded in a folder of its own.

## Edits

Everything named in the records (beans, batches, grinder, baskets, tools,
recipes, beverage, barista and drinker) was made up for the recording; the
profiles are Decaid's bundled ones. The simulated machine reports serial
`mock-de1` and names no real hardware, so nothing is scrubbed. Every Shot's
measurements in `shot.json` are trimmed to their first, last, peak-pressure
and peak-flow samples, in their order, as `../de1pro-v0.8.7/` trims its Shot.

The DYE2 records' `createdAt` and `capturedAt` are UTC, set by the browser.
The Shot's `timestamp` and sample times are Decaid's local time without an
offset, which in the container was UTC; its `createdAt` and `updatedAt` are
UTC with a `Z`.

## What they show

- **DYE2's lists.** Every save reads the list and posts it whole. A recipe's
  id is its slot, `"1"` to `"5"`, and the list holds only the slots ever
  saved, in the order first saved. The editor rewrites `capturedAt`, `title`,
  `subtitle` and the embedded `workflow` on every save. A blank number is
  saved as 0, but a blank brew temperature as 93, and blank steam and hot
  water as modes flow and volume (`getCurrentRecipeData` in
  `dye2:dye2-plugin/src/pages/recipe-edit.ts`). A slot saved without a Grinder
  or Basket picked keeps those of the slot the editor showed before it, slot
  1's here, as switching tabs does not clear them. A Profile picked from the
  library is named by `profileId`, with `profileSnapshot` null; one read from
  the Workflow has `profileId` null, as the Workflow's profile has no id, and
  the Workflow's profile as `profileSnapshot`, and reading it also takes the
  Workflow's barista, drinker, dose, yield, grind setting, RPM, grinder and
  basket (`readFromWorkflow` in `dye2:dye2-plugin/src/pages/recipe-edit.ts`).
  Steam and hot water each keep only the value of their mode. A Tool's value
  of its own for a recipe is in `equipmentCustom`, keyed by the Tool's id.
  Deleting a tool posts the list without it; DYE2 has no way to delete a
  recipe or a basket.
- **Decaid's store.** A `POST` answers `{}` and replaces the key's value, a
  key never written or deleted answers `null`, and `DELETE` answers `{}`
  whether or not the key is held (`KvStoreHandler` in
  `decaid:lib/src/services/webserver/kv_store_handler.dart`, unchanged in
  v0.8.8).
- **DYE2 applying a recipe** sends the whole Workflow it read, with the
  recipe's dose, yield, grind setting (as a number, which Decaid keeps as
  text), RPM, grinder and Profile, its steam, hot water and flush values of
  its modes, and its barista and drinker when it names them, so applying slot
  2 kept slot 1's. It sets no bean, batch or basket, and not the recipe's brew
  temperature: the Profile is sent with its own step temperatures, so slot 1,
  saved at 92, is applied at `Adaptive v3`'s 93 and 88, and slot 2, saved at
  93, at `Classic Italian espresso`'s 94. Streamline's DYE strip does not
  apply it either. Applying the blank slot sets the dose, yield, grind, RPM,
  steam flow, hot water volume and flush to 0.
- **A basket picked** on the dashboard, or in Edit Shot, writes only the
  Workflow's `context.extras.basketId` and `basketName`, which the Shot pulled
  next records. Edit Shot saves the basket and tools in the Shot's
  `annotations.extras`.
- **Streamline applying a recipe** keeps the steam, hot water and flush values
  of the recipe's modes under `streamline-app` first, then sends the whole
  Workflow, with the recipe's embedded `workflow.context` merged into it and
  its full Profile.
- **Streamline's auto-save** reads the recipes and posts them back with the
  fields it reads from the barista's Workflow change merged into the applied
  recipe's `dashboardVariables` (`recipeAutoSaveFields` in
  `streamline-js:src/modules/dyeStrip.js`): dose and yield for a dose change,
  the grind setting, the hot water volume and mode, the steam flow and mode. A
  dose change sends the Profile too, so it also saves the Profile's first step
  temperature as `brewC`: `autoSaveDose` changed slot 2's from 93 to 94,
  though the barista changed no temperature. It stops, until the next recipe
  or favourite is applied, at the first change whose Workflow answer's
  profile does not match the profile it applied, compared on title, target
  weight and volume, tank temperature and steps but their temperatures
  (`profileFingerprint` in `streamline-js:src/modules/dyeStrip.js`). That
  happens at once after applying a recipe whose Profile has a step limiter
  of 0, as `Adaptive v3`, slot 1's, does: Streamline sends that limiter as
  null (`updateWorkflow` in `streamline-js:src/modules/api.js`) but compares
  with its own copy (`noAutoSaveAfterLibraryProfile`). And a dose or yield
  change sends the yield as the profile's target weight, so it stops there
  unless the two already match; slot 2's profile, `Classic Italian
  espresso`, targets 36 g, as does its yield.
