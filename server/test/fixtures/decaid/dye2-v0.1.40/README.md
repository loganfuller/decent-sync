# DYE2 v0.1.40 and Streamline v0.2.27 on Decaid v0.9.2

What DYE2 v0.1.40 and Streamline v0.2.27 write to Decaid v0.9.2, recorded as
`../streamline-v0.2.24/` records Streamline v0.2.24 and DYE2 v0.1.36: each
request a page or the recording script sent, and the status and body Decaid
answered, its JSON parsed. Requests the script sent stand for Decent Sync's
plugin (its `record` call, the load write's clears) or for Decent Sync's
server (a recipe's record written). They were recorded for decent-sync #550,
which raises the minimums to these releases: applying a recipe now clears
what it names none of, a grinder pick brings the grinder's grind setting and
RPM, DYE2's recipe editor can clear a grinder or Basket, its Grinders page
archives a grinder, its profile picker writes the dose and yield, and SAVE
TO RECIPE on Edit Auto Favourite makes a recipe.

A step is `{exchanges, alsoSent, after, pushes, events, timing}`:

- `exchanges`: what the step's action sent. On every page each request but
  a read is kept, whatever its route. Of the reads: on DYE2's pages, those
  of DYE2's `selection` route, its `recipes` key and the Workflow (and, in
  `grinder-archive.json`, Decaid's grinders; in `save-to-recipe.json`,
  DYE2's `autoFavourites` key); on Streamline, the same three, and in
  `editor.json` Decaid's grinders. Some steps also hold an entry that is no
  exchange:
  - `{"shown": ...}` and `{"shownAfter": ...}`, what DYE2's recipe editor
    showed as it opened and once chips were tapped: each chip of its grinder
    and Basket rows with whether it was the lit one, and its dose, yield,
    grind setting and RPM steppers; in `save-to-recipe.json`, what Edit Auto
    Favourite showed before its save (`alwaysDisplay`, `favNumber`, the
    button's label);
  - `{"tabs": [...]}`, the dashboard's grinder tabs with the active one, and
    `{"cards": [...]}`, each card of a DYE2 grid with whether it was
    highlighted or shown archived;
  - `{"tiles": ...}`, what Streamline's dose, grind and Drink tiles showed;
  - `{"button": ...}`, the label of the grinder form's archive button as it
    was tapped, and `{"highlightedAsOpened": [...]}`, the cards the profile
    picker highlighted as it opened.
- `alsoSent`, where present: what the open Streamline page (`streamline`)
  sent meanwhile that the action did not take.
- `after`: reads made 2.5 s after the step. By default the Workflow, DYE2's
  derived selection and DYE2's recipes, in that order; `save-to-recipe.json`
  adds DYE2's `autoFavourites`; `editor.json`'s `grinderDeleted` adds
  `GET /grinders?includeArchived=true`; `grinder-archive.json` reads that
  and `GET /grinders` alone; a `reseeded` step reads nothing.
- `pushes`, `events`, `timing`: as in `../dye2-v0.1.26/`, what DYE2's
  `changed` socket heard, the `context` of each Workflow Decaid sent plugins
  in a `workflowUpdated` (heard through `../dye2-v0.1.26/workflow-recorder/`),
  and when each came, in ms from the step's start.

The same shorthands as `../streamline-v0.2.24/` keep the files small: a read
of `/workflow` or DYE2's `recipes` answering what the last read or post of
it in the file did is `"unchanged": true`, and outside `library.json` a
whole profile is `{"$profile": "<title>/<hash>"}`, its copy in
`library.json`'s `profileCopies`. In `grinder-picks.json` each pick is an
object of four steps (`reseeded`, `applied`, `picked`, `recorded`).

The grinders, made through `POST /api/v1/grinders`, each numeric with a
small step of 0.5 for the grind setting and 50 for the RPM:

| Grinder | `extras` | What a pick brings |
|---|---|---|
| `Fixture Grinder 64` | none | The grinder the seeded recipes name |
| `Fixture Grinder Default` | `settingDefault` 12, `rpmDefault` 900 | Its defaults |
| `Fixture Grinder Range` | `settingMin` 2, `settingMax` 10, `rpmMin` 400, `rpmMax` 1200 | The middles of its ranges, 6 and 800 |
| `Fixture Grinder Plain` | none | Neither; also the one archived and unarchived |
| `Fixture Grinder Gone` | none | Deleted from the tablet in `editor.json` |

The recipes, as Decent Sync's server wrote records before #550
(`recipeRecord`, `recipeWorkflow` and `recordOf` in
server/src/library/recipe-intake.ts at `origin/main`): a field only where
the Recipe holds one, so no null for a part it names none of and no
`targetYield` in its embedded Workflow for no yield. Each group of steps
writes the recipes it uses, in Streamline's strip buttons 1 on, in the order
its file's row below gives.

| Recipe | Name | What it holds |
|---|---|---|
| `1` | `Fixture Full Recipe` | Every part: `Fixture Ethiopia` and its batch, `Adaptive v3` at 92 °C, 18 g in, 36 g out, grind setting 2.5, RPM 1000, feed rate `MF`, `Fixture Grinder 64`, the Basket `Fixture 18g Precision` |
| `2` | `Fixture Bare Server` | `Classic Italian espresso` at 93 °C and none of the parts: no Bean, grinder, Basket, dose, grind setting, RPM, feed rate or yield |
| `3` | `Fixture Bare DYE2` | As `2`, then saved by DYE2 v0.1.40's recipe editor (`editorSavedBare`) |
| `4` | `Fixture RPM Zero Server` | `Classic Italian espresso`, 19 g in, 38 g out, grind setting 3, `rpm: 0` (`extras.rpm: 0` in its embedded Workflow), `Fixture Grinder 64` |
| `5` | `Fixture RPM Zero DYE2` | As `4`, then saved by DYE2 v0.1.40's recipe editor (`editorSavedRpmZero`) |
| `6` | `Fixture Grinder Only` | `Classic Italian espresso`, 19 g in, 38 g out, `Fixture Grinder 64`, no grind setting and no RPM |
| `7` | `Fixture Gone Grinder` | `Classic Italian espresso`, 20 g in, 40 g out, grind setting 4, RPM 700, `Fixture Grinder Gone` |
| `8` | `Fixture Ratio Recipe` | `Fixture Ethiopia` and its batch, `Adaptive v3` at 92 °C, 18 g in, 45 g out, grind setting 2.5, `Fixture Grinder 64` |

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (the bean and its batch, the five grinders, DYE2's `baskets` key, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, each naming a yield of 36 g, `GET /info`), the grinders at the end with the archived ones (`grindersAtEnd`), and `profileCopies` |
| `loading.json` | `recorder`, the recorder's install: `PUT /plugins/workflow-recorder.reaplugin/source` without a token (401) and with Decaid's (200), and its `enable` with it, the source left out of each body; `bundledDye2`, the bundled DYE2's entry in `GET /plugins` (v0.1.37); `installRefused`, `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}` without a token (401); `install`, the same with Decaid's token; `listed`, DYE2's entry in `GET /plugins` after (v0.1.40, loaded); `basketsWritten`, the script's write of DYE2's `baskets` key; then every DYE2 key and the Workflow before any recipe was written |
| `dashboard-applies.json` | Items 1 and 2 on DYE2's dashboard, recipes `1` to `5`: `seeded`; `editorSavedBare` and `editorSavedRpmZero`, recipes `3` and `5` opened in DYE2's recipe editor (`recipe-edit?id=`) and saved as they showed; `applyFull`, recipe `1`'s pill; `pills`, the pills the dashboard showed (not a step); `applyBareServer`; `applyFullAgain`; `applyBareDye2`; `applyFullThird`; `applyRpmZeroServer`; `applyFullFourth`; `applyRpmZeroDye2`. Each apply opens the dashboard afresh and taps the recipe's pill |
| `strip-applies.json` | Items 1 to 3 on Streamline's strip, the same records as `dashboard-applies.json` left them: `started`, its page load; `cells`, the names its five buttons showed (not a step); then the same eight applies by the same names, each a strip button tapped |
| `grinder-picks.json` | Item 4, recipes `1` and `6`. Nine picks with recipe `1` loaded, named by surface and grinder: `tabDefault`, `tabRange`, `tabPlain` (the dashboard's grinder tabs); `cardDefault`, `cardRange`, `cardPlain` (a card tapped on DYE2's Grinders page, `grinders`); `pickerDefault`, `pickerRange`, `pickerPlain` (a card tapped in the grinder picker, `grinder-picker`, and CONFIRM, `#dye-confirm-btn`). Then `grinderOnlyTabDefault`, `grinderOnlyTabRange`, `grinderOnlyTabPlain`, the tabs with recipe `6` loaded. Each holds `reseeded`, the records written back; `applied`, the recipe's pill on the dashboard; `picked`; `recorded`, `POST /plugins/dye2.reaplugin/record` from the script |
| `editor.json` | Item 5, recipes `1` and `7`: `seeded`; `applyFull`, recipe `1`'s pill; `grinderDeleted`, `DELETE /grinders/{id}` of `Fixture Grinder Gone` from the script; `streamlineStarted`; `stripGoneGrinder`, recipe `7` from Streamline's strip; `applyFullAgain`; `dashboardGoneGrinder`, recipe `7`'s pill; `editorGoneGrinder`, recipe `7` opened in the editor and saved as it showed; `applyFullThird`; `editorNoneChips`, recipe `1` opened in the editor, None tapped in its grinder row and its Basket row, and saved |
| `grinder-archive.json` | Item 6, DYE2's Grinders page: `opened`; `archived`, `Fixture Grinder Plain`'s card held for 800 ms, which opens its form, and ARCHIVE (`#dye-modal-archive`), its confirmation accepted; `unarchived`, its card tapped, which opens the form of an archived grinder, and the same button, then labelled UNARCHIVE. Each ends with the grinder's own record, `GET /grinders/{id}` |
| `profile-picker.json` | Item 7, recipe `8`: `seeded`; `applyRatio`, its pill; `confirmOwn`, `Adaptive v3`'s card in DYE2's profile picker (`profile-picker`) and CONFIRM; `recordAfterOwn`; `reseeded`; `applyRatioAgain`; `confirmOther`, `Classic Italian espresso`'s card and CONFIRM; `recordAfterOther` |
| `save-to-recipe.json` | Item 8, recipe `1`: `seeded`; `applyFull`; `saved`, Edit Auto Favourite (`auto-fav-edit`) opened afresh, which takes the Workflow as its snapshot, a title typed and SAVE TO RECIPE (`#afe-save-btn`), "Always display on Dashboard" as it opens (Yes, number 1); `pillsAfterSave` (not a step); `savedNotDisplayed`, the same with it set to No |
| `explicit-nulls.json` | Item 9, writes from the script, recipe `1`: `seeded`; `applyFull`; `clearedAll`, `PUT /workflow {"context":{"targetDoseWeight":null,"grinderSetting":null,"grinderId":null,"grinderModel":null,"targetYield":0,"extras":{"rpm":null,"feedRate":null,"basketId":null,"basketName":null}}}`; `yieldNull`, `{"context":{"targetYield":null}}`; `applyFullAgain`; then one part a write: `doseNull`, `grindNull`, `grinderNull`, `rpmNull`, `feedRateNull`, `basketNull`, `yieldZero` |
| `yield-set.json` | Item 10, Streamline's main page open, recipes `1` and `2`: `seeded`; `started`; `applyBareFirst`, `applyFull`, `applyBare`, strip buttons; `recordUnmoved`; `drinkPlus`, the Drink tile's + (`#drink-out-plus`) tapped; `recordAfterPlus`; `yieldForty`, `PUT /workflow {"context":{"targetYield":40}}` from the script; `recordAfterForty` |
| `keys.json` | Not exchanges: DYE2's recipes, favourites and stored selection at the end |
| `grinder-form.json` | Recorded apart, for decent-sync #551 (A grinder's range and defaults, below): the form of DYE2's Grinders page saving a grinder's range and defaults |

## How they were recorded

They were recorded on 2026-11-15 (UTC) by Decaid's v0.9.2 Linux arm64 release
(`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answers `0.9.2`, build
3191, commit `875b7a6a`), run headless in a throwaway Ubuntu 24.04 container
as `../streamline-v0.2.24/` describes: Xvfb as its display, a D-Bus system
bus and Avahi running, started as `xvfb-run -a dbus-run-session -- decaid
--serial --bypass-onboarding --no-account` with its simulated machine and
scale and its data new. No tablet was contacted.

- **The token.** Decaid was started with `DECAID_EXTENSIONS_TOKEN` in its
  environment set to 64 hexadecimal characters from `openssl rand -hex 32`,
  as `../simulated-devices-v0.9.2/` describes. The script had the same
  value in its own environment and sent it with three requests: the
  recorder's source and enable, and DYE2's install. The token is in no
  file: a request that carried it holds `"token": "launch"`. Without it the
  source PUT and the install each answered 401, `Missing or malformed
  bearer token` (`loading.json`). No request a page sent carried a token,
  and none was refused: DYE2's own routes, Decaid's store, the Workflow and
  the grinders need none.
- **DYE2** v0.1.40 is the latest release (tag commit `3baa763`). The script
  installs it over the bundled v0.1.37 with `POST
  /api/v1/plugins/install/github-release {"repo":"decentespresso/dye2"}`,
  which Decaid answered `{"message":"Plugin installed","id":"dye2.reaplugin",
  "version":"0.1.40","loaded":true}`. Left alone, this Decaid brought the
  bundled DYE2 to v0.1.40 by itself about ten minutes after its first start
  (seen on a trial run, in its log: `Plugin installed: dye2.reaplugin
  (0.1.40)`).
- **The seeded keys.** Once DYE2 is loaded, the script makes the library,
  writes DYE2's `baskets` key, and before each group of steps writes the
  recipes that group uses as the server wrote them (`seeded`, `reseeded`),
  each with a made-up global id that stays the same through the run. So
  what one group's `record` or editor saved does not carry into the next,
  but for `strip-applies.json`, which follows `dashboard-applies.json`
  without a write between. The Workflow carries over.
- **Records saved by DYE2's editor.** Recipes `3` and `5` are the server's
  records opened in DYE2 v0.1.40's recipe editor and saved with nothing
  changed. The save rewrote the record: `steamMode: "flow"` added to its
  `dashboardVariables`, and its embedded Workflow built by v0.1.40's
  `buildRecipeWorkflow`, with the nulls, DYE2's flags (`extras.dye`), and
  for recipe `3` a `targetYield` of 0.
- **Streamline** v0.2.27 is its repository's files at the tag (`git archive
  v0.2.27`, commit `7cd21bd`), served as static files at
  `http://localhost:13999/`, with the host's `localhost:8080` forwarded to
  the container's Decaid, as Streamline calls port 8080 of the host its
  page came from. Each group opens it in a browser context of its own, its
  DYE2 switch (`streamline.dye2Enabled`) on and its strip on recipes
  (`streamline.dyeStripMode` `R`), both set before it loads; the script
  writes the switch into Streamline's mirror of it in Decaid's store too
  (the first exchange of each `started` step), as `../streamline-v0.2.24/`
  describes. Before the pages are opened the script sends `PUT
  /machine/state/idle`, not recorded: Streamline covers its page with a
  screensaver while the machine sleeps.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium (`@playwright/test` 1.63.0), from the repository root, with Node
  v26.13.0: `DECAID_EXTENSIONS_TOKEN=<token> node
  server/test/fixtures/decaid/dye2-v0.1.40/record.mjs <output dir>`. It
  restarts no Decaid and pulls no Shot. It reads `DECAID` and `SKIN` from
  the environment for other addresses. The run recorded here was the first
  on its fresh Decaid and took eleven minutes. A trial run on another fresh
  one, before the profile picker's steps used recipe `8` and
  `yield-set.json` applied recipe `2` first, recorded the same writes and
  answers in every step of the other seven step files, but for the ids and
  times Decaid gave and for `save-to-recipe.json`'s `applyFull`, where the
  dashboard sent what differed from another Workflow.

## A grinder's range and defaults

`grinder-form.json` was recorded for decent-sync #551, which has a Grinder
hold the range and defaults DYE2 keeps in a grinder's `extras`, on another
fresh Decaid v0.9.2 of the same build, started the same way with a token of
its own, on 2026-11-15 (UTC). Its script, `record-grinder-form.mjs`,
installs DYE2 v0.1.40 over the bundled v0.1.37 as `record.mjs` does, and
drives the form of DYE2's Grinders page in Playwright's headless Chromium:
`DECAID_EXTENSIONS_TOKEN=<token> node
server/test/fixtures/decaid/dye2-v0.1.40/record-grinder-form.mjs <output
dir>`. Streamline was not loaded, and no recipe or Workflow is written:
nothing here goes through them. The token is in no file.

A step is `{exchanges, after}`: every request but a read that the form or
the script sent, each with Decaid's answer, and then the grinder as Decaid
holds it (`GET /grinders/{id}`). A step of the form's also holds three
entries that are no exchange: `{"shown": ...}`, what its inputs showed as it
opened; `{"typed": ...}`, what was typed over them, by input name; and
`{"error": ...}`, the error it showed after SAVE, null for none. The form
is opened on a grinder as the dashboard's long-press opens it
(`grinders?edit=<id>`), or for a new one by its ADD NEW GRINDER card.
`versions` holds Decaid's and DYE2's, and `grindersAtEnd` the grinders at
the end.

| Step | What it holds |
|---|---|
| `made` | From the script: `Fixture Grinder Form` created with a small step of 0.5 for its setting and 50 for its RPM, and in its `extras` a made-up global id, as Decent Sync's plugin writes one, and a Beanconqueror key |
| `rangeSaved` | A feed rate note, a setting from 0 to 10 with a default of 4, and an RPM from 400 to 1200 with a default of 900, typed and saved |
| `otherEdited` | Its notes alone changed |
| `settingReversed`, `rpmReversed` | A Setting Min of 12 over its Max of 10, and an RPM Min of 1500 over its Max of 1200 |
| `defaultOutside` | A Setting Min of 10, equal to its Max, a Setting Default of 40 and an RPM Default of 100, each outside its range |
| `defaultCleared` | The Setting Min back to 0, and both defaults emptied |
| `belowZero` | A Setting Min of -5 and a Setting Default of -1.5 |
| `topLevel` | From the script: `PUT /grinders/{id} {"settingMin":1,"settingMax":20,"rpmDefault":700}`, as the previous release's plugin writes a Grinder's range |
| `inExtras` | From the script: the same three in `extras`, over its other keys, as this release's plugin writes them |
| `namedPositions` | Its Setting Type changed to Preset, with three values |
| `numericAgain` | Its Setting Type changed back to Numeric |
| `created` | A new grinder, `Fixture Grinder Ranged`, with a setting from 0 to 50 and an RPM Default of 800 |
| `createdNamed` | A new preset grinder, `Fixture Grinder Named`, with an RPM from 300 to 1400 |
| `createdReversed` | A new grinder with a Setting Min of 9 over a Max of 3 |

What it shows, none of it contradicting what decent-sync #551 says:

- **The range and defaults are saved in `extras`, over its other keys**
  (`rangeSaved`; `buildGrinderBody` in
  dye2:dye2-plugin/src/utils/grinder-form.ts). The form PUT the grinder's
  fields with `extras: {bcUuid, decentSyncId, feedRate: "manual FF/MF/SF",
  settingMin: 0, settingMax: 10, settingDefault: 4, rpmMin: 400, rpmMax:
  1200, rpmDefault: 900}`, and Decaid held them so: the global id and the
  feed rate note stay, and a lowest setting of 0 is 0. An edit of another
  field sent the same `extras` again (`otherEdited`).
- **A lowest above a highest is refused, and nothing is sent**
  (`settingReversed`, `rpmReversed`, `createdReversed`; `submitForm` in
  dye2:dye2-plugin/src/pages/grinders.ts). The form showed `Setting Min must
  not be greater than Setting Max.` or `RPM Min must not be greater than RPM
  Max.` and sent no request; the grinder stayed as it was. A lowest equal to
  a highest is saved (`defaultOutside`).
- **A default outside the range is saved as typed** (`defaultOutside`): 40
  with a setting of 10 to 10, and 100 with an RPM of 400 to 1200.
- **A blank is null on an edit, and left out of a new grinder**
  (`defaultCleared`, `created`). Emptied, each default was sent and held as
  null. The new grinder's `extras` hold only what was typed, `{feedRate:
  null, settingMin: 0, settingMax: 50, rpmDefault: 800}`.
- **A number below 0 is saved** (`belowZero`): the form's inputs set no
  lowest value.
- **An edit to named positions clears the setting's three, and keeps the
  RPM's** (`namedPositions`). The form PUT `settingType: "preset"` with
  `settingMin`, `settingMax` and `settingDefault` each null in `extras` and
  the RPM's as they were. Edited back to a numbered dial, the three stayed
  null (`numericAgain`). A new preset grinder's `extras` hold none of the
  three and its RPM's range (`createdNamed`).
- **Decaid drops a range sent at the record's top, and keeps one in
  `extras`** (`topLevel`, `inExtras`). The top-level write answered 200 with
  the record as it was but for its `updatedAt`, its `extras` whole; the one
  in `extras` was held.
- **Not recorded.** A grinder's range bounding the steppers of DYE2's
  dashboard and Streamline's Grind tile, which write nothing of the
  grinder's; and a pick, which `grinder-picks.json` holds.

## Edits

Everything named (bean, batch, grinders, Baskets, recipes) was made up for
the recording; the profiles are Decaid's bundled ones. The simulated machine
names no real hardware, and nothing of the host's is in the files, so
nothing is scrubbed. As recorded, the files were compacted (`compactAll`),
but for `grinder-form.json`, which has no shorthands. Nothing else was
changed.

## What they show

Nothing recorded contradicts what decent-sync #550 says DYE2 v0.1.40,
Streamline v0.2.27 and Decaid v0.9.2 do. Three things it does not say are
marked **Not in the ticket** below.

- **DYE2's dashboard apply clears** (`dashboard-applies.json`; `applyRecipe`
  in dye2:dye2-plugin/src/pages/dashboard.ts). After recipe `1`, recipe
  `2`'s pill PUT its profile with `context: {targetDoseWeight: null,
  targetYield: 0, grinderId: null, grinderModel: null, grinderSetting: null,
  beanBatchId: null, coffeeName: null, coffeeRoaster: null, baristaName:
  null, drinkerName: null, extras: {rpm: null, feedRate: null, basketId:
  null, basketName: null, dye: {...}}}` (`applyBareServer`), and recipe `3`'s
  pill PUT the same but for the recipe id (`applyBareDye2`): the dashboard
  builds its write from the record's `dashboardVariables`, so the record the
  server wrote and the one DYE2 saved apply alike. The Workflow after held
  `targetYield: 0`, no `targetDoseWeight`, `grinderSetting`, `grinderId` or
  `grinderModel` key, and `extras.rpm`, `feedRate`, `basketId` and
  `basketName` each null. The dashboard sends only what differs from the
  Workflow it read, so recipe `1`'s first apply sent no dose or yield, the
  Workflow holding 18 and 36 already (`applyFull`).
- **Streamline's strip clears whatever the record holds**
  (`strip-applies.json`; `clearInheritedFields` in
  streamline-js:src/modules/workflow-fields.js). Recipe `2`'s button, whose
  record's Workflow holds none of the fields, PUT `context: {coffeeName:
  null, beanBatchId: null, coffeeRoaster: null, grinderId: null,
  grinderModel: null, baristaName: null, drinkerName: null, grinderSetting:
  null, targetDoseWeight: null, targetYield: 0, extras: {basketId: null,
  basketName: null, rpm: null, feedRate: null, dye: {v: 1, recipeId: "2"}}}`
  with its profile (`applyBareServer`), and recipe `3`'s button the same
  values (`applyBareDye2`). The Workflow after was as after the dashboard's
  applies, and the dose and grind tiles showed a dash, the Drink tile `0g`.
- **An RPM of 0 applies as none** (`applyRpmZeroServer`, `applyRpmZeroDye2`
  in both files). After recipe `1` (RPM 1000), the dashboard PUT
  `extras.rpm: null` for recipe `4`, whose record holds `rpm: 0` and
  `extras.rpm: 0`, and for recipe `5`; so did the strip. The Workflow after
  held `extras.rpm: null`. DYE2's editor showed recipe `5`'s RPM as `0` and
  its save kept `rpm: 0` in `dashboardVariables` while writing `extras.rpm:
  null` into its embedded Workflow (`editorSavedRpmZero`).
- **The strip applies a recipe holding a feed rate** (`strip-applies.json`,
  `applyFull` and the three after it). Recipe `1`'s button PUT its context
  with `extras: {rpm: 1000, feedRate: "MF", basketId, basketName, dye}` and
  its profile, answered 200, and the Workflow held `feedRate: "MF"`.
- **A grinder pick brings its grind setting and RPM, and `record` saves
  only numbers into a record holding them** (`grinder-picks.json`;
  `grinderDefaultsPatch` in dye2:dye2-plugin/src/utils/grinder-form.ts).
  With recipe `1` loaded (2.5 and 1000 on `Fixture Grinder 64`):
  - `Fixture Grinder Default` wrote `grinderSetting: 12` and `extras.rpm:
    900`; `Fixture Grinder Range` 6 and 800; `Fixture Grinder Plain`
    `grinderSetting: null` and `extras.rpm: null`, after which the Workflow
    held no `grinderSetting` key and `extras.rpm: null`. The three surfaces
    wrote the same values. A card on the Grinders page and the picker's
    CONFIRM PUT `{"context":{"grinderId","grinderModel","grinderSetting",
    "extras":{"rpm","dye":{"v":1,"grinderId":true,"grinderModel":true,
    "rpm":true}}}}` (`rpm: null` among the flags for a null); a tab PUT the
    same context fields with the flags that changed. The Workflow went on
    naming recipe `1` after each.
  - `record` after a pick of `Default` or `Range` answered `{"saved":true,
    "kind":"recipe","id":"1"}` and saved the grind setting and RPM the pick
    brought (12 and 900, or 6 and 800) into recipe `1`'s record, and **not
    the grinder**: the record went on naming `Fixture Grinder 64`
    (`tabDefault.recorded`, and the same for the other five).
  - `record` after a pick of `Plain` answered `saved: false`: it saves no
    clear, and the record kept 2.5 and 1000 on `Fixture Grinder 64`
    (`tabPlain.recorded`, `cardPlain.recorded`, `pickerPlain.recorded`).
  - With recipe `6` loaded, which holds no grind setting or RPM, the picks
    wrote the same values and `record` answered `saved: false` after each,
    the record unchanged (`grinderOnlyTabDefault`, `grinderOnlyTabRange`,
    `grinderOnlyTabPlain`).
- **The editor's None chips** (`editor.json`, `editorNoneChips`;
  `renderPickerChips` in dye2:dye2-plugin/src/pages/recipe-edit.ts). Recipe
  `1`'s editor lit `Fixture Grinder 64` and `Fixture 18g Precision`; with
  None tapped in each row, its save wrote the record with `grinderId: null`,
  `grinderModel: null`, `basketId: null` and `basketName: null` in
  `dashboardVariables` and in its embedded Workflow, its grind setting 2.5
  and RPM 1000 kept. As the Workflow named recipe `1`, the save also PUT the
  embedded Workflow, so the Workflow lost its grinder and Basket and kept
  2.5 and 1000.
- **A recipe naming a grinder deleted from the tablet** (`editor.json`).
  `DELETE /grinders/{id}` answered `{"success":true,"id":...}`
  (`grinderDeleted`). From Streamline's strip, recipe `7` was PUT with
  `grinderId: null` and `grinderModel: null`, after the strip read `GET
  /grinders?includeArchived=true`, and with its grind setting `"4"` and RPM
  700 as they were (`stripGoneGrinder`; `dropDeletedGrinder` in
  streamline-js:src/modules/dye-selection.js). DYE2's dashboard PUT the same
  nulls, 4 and 700 (`dashboardGoneGrinder`). Its editor lit None in the
  grinder row, and its save wrote `grinderId: null` and `grinderModel: null`
  into the record, 4 and 700 kept (`editorGoneGrinder`).
- **Archive and unarchive** (`grinder-archive.json`; `toggleArchive` in
  dye2:dye2-plugin/src/pages/grinders.ts). ARCHIVE sent `PUT /grinders/{id}
  {"archived":true}`, answered 200 with the whole record, `archived: true`
  and a new `updatedAt`. `GET /grinders` then left the grinder out and `GET
  /grinders?includeArchived=true` listed it; the page showed its card last,
  as archived. UNARCHIVE sent `{"archived":false}`, and `GET /grinders`
  listed it again.
- **The profile picker writes the yield, and the dose at the ratio**
  (`profile-picker.json`; `profileTargetsPatch` in
  dye2:dye2-plugin/src/pages/profile-picker.ts). With recipe `8` loaded, 18
  g in and 45 g out, CONFIRM on `Adaptive v3` PUT `{"profile": <the
  library's Adaptive v3>, "context": {"targetYield": 36, "targetDoseWeight":
  14.5}}`: the profile's 36 g, and 36 / (45 / 18) = 14.4 rounded to the half
  gram. The Workflow's `recipeId` stayed `"8"` and DYE2's selection recipe
  `8` (`confirmOwn`). CONFIRM on `Classic Italian espresso` PUT the same
  context with that profile; Decaid's answer still held `recipeId: "8"`, and
  DYE2's plugin then cleared it in a write of its own, the second
  `workflowUpdated` holding `recipeId: null` and DYE2's selection reading
  null (`confirmOther`). `record` then answered `{"saved":false,
  "reason":"no recipe is selected"}` (`recordAfterOther`).
- **Not in the ticket: on the recipe's own profile, `record` saves what the
  picker wrote.** The picker sends the library's profile, not the recipe's
  at its brew temperature, so after `confirmOwn` the Workflow ran `Adaptive
  v3` from 93 °C where recipe `8` holds 92. `record` then answered `saved:
  true` and saved `dose: 14.5`, `drink: 36` and `brewC: 93` into recipe `8`
  (`recordAfterOwn`).
- **SAVE TO RECIPE adds a recipe under a UUID, in no slot**
  (`save-to-recipe.json`, `saved` and `savedNotDisplayed`). The page POSTed
  DYE2's `recipes` with one more record: `id` a UUID (`crypto.randomUUID`),
  `stripSlot: null`, no `showOnStreamlineDashboard` key, the Bean, grinder,
  Basket, dose, yield, grind setting, RPM and feed rate of the Workflow in
  its fields, `barista` and `drinker` null, and an embedded Workflow of a
  `context` alone, as `buildRecipeWorkflow` builds it. The Workflow was not
  written and went on naming recipe `1`; the dashboard's rail then showed
  the new recipe's pill after recipe `1`'s (`pillsAfterSave`). With "Always
  display on Dashboard" as it opens (Yes), the page also POSTed DYE2's
  `autoFavourites` with a favourite of the same title at `favSlot: 1`
  (`saved`); set to No, it wrote the recipe alone (`savedNotDisplayed`).
- **Not in the ticket: the recipe SAVE TO RECIPE adds names its profile by
  title alone.** Opened afresh, the page takes its snapshot from the
  Workflow, whose profile holds no `id`. The record it added holds
  `profileId: null`, `profileTitle: "Adaptive v3"`, `profileSnapshot: null`,
  no profile in its embedded Workflow and no `brewC`.
- **Explicit nulls in a Workflow write** (`explicit-nulls.json`). The write
  clearing every part answered 200 (`clearedAll`). In Decaid's answer and in
  `GET /workflow` after, a cleared `targetDoseWeight`, `grinderSetting`,
  `grinderId` or `grinderModel` is an absent key; a cleared `extras.rpm`,
  `feedRate`, `basketId` or `basketName` is a key holding null, as `extras`
  is merged key by key; and the yield reads `targetYield: 0`. The Bean,
  which the write did not name, stayed, as did `recipeId`. `{"context":
  {"targetYield":null}}` answered 400, `{"error":"Invalid request",
  "message":"FormatException: Field \"targetYield\" cannot be null"}`, and
  changed nothing (`yieldNull`). Each part cleared in a write of its own
  answered 200 and read back the same way (`doseNull` to `yieldZero`).
- **Not in the ticket: DYE2's `record` saves no yield into a record holding
  none** (`yield-set.json`). With recipe `2` applied from the strip, the
  Workflow's yield 0, `record` answered `saved: false` (`recordUnmoved`).
  The Drink tile's + PUT `{"context":{"targetDoseWeight":null,
  "targetYield":1}}` (`drinkPlus`), and `record` answered `saved: false`
  (`recordAfterPlus`). After `PUT /workflow {"context":{"targetYield":40}}`
  from the script, `record` answered `{"saved":false,"kind":"recipe",
  "id":"2"}` again, and recipe `2`'s record stayed without a `drink`
  (`recordAfterForty`). So a yield set on a Machine reaches a Recipe holding
  none only through what Decent Sync records itself. Streamline's Drink
  tile still showed `1g` 2.5 s after the script's write of 40
  (`yieldForty`).
- **DYE2's selection reads `modified: true` right after an apply** of a
  record the server wrote, in every file (for one, `applyFull` in
  `dashboard-applies.json`), as it did for recipes `3` and `5`, which
  DYE2's editor had saved.
- **Not recorded.** A grinder pick from Streamline's Grind label (it opens
  the same grinder picker, `../streamline-v0.2.24/grind-label.json`); a
  grinder whose default lies outside its range, which a pick clamps; a
  preset grinder; a favourite applied from the strip, which Streamline
  leaves as an overlay; SAVE TO RECIPE on a favourite opened from the Auto
  Favourites page's card rather than afresh; Streamline's reload notice
  (`checkSkinUpdate`) and its following of Decaid's theme
  (`followDecaidTheme`), which write nothing to the Workflow or DYE2's
  keys; and a Shot.
