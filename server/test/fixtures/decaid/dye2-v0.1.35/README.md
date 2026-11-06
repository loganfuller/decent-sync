# DYE2 v0.1.35 on Decaid v0.9.1

What DYE2 v0.1.35 does otherwise than v0.1.33, where it touches what Decent
Sync writes and records, recorded as `../dye2-v0.1.33/` records what v0.1.33
does otherwise than v0.1.32: each request a page or the recording script
sent to DYE2's keys in Decaid's store, DYE2's `selection` and `record`
routes, the grinders and the Workflow, and the status and body Decaid
answered, its JSON parsed. Requests the script sent stand for the plugin's,
or for anything else on the tablet changing the Workflow. They were recorded
for decent-sync #395, which follows DYE2 v0.1.34 and, as the owner chose on
2026-11-06, v0.1.35, released that day.

DYE2 v0.1.35 does everything `../dye2-v0.1.33/` shows but where these files
show otherwise. Between the two, `dye2-plugin/src/` changed in what Decent
Sync relies on only where this README says (What they show, below): the rest
of the diff is the stepper values becoming inputs, Edit Shot opening a Shot
older than the 50 newest (decentespresso/dye2#45), the Auto Favourites
page's days off roast and its list of every recent favourite
(decentespresso/dye2#44), the dashboard's DONE waiting for an apply, and
DYE2's dev server.

A step is `{exchanges, after, pushes, events, timing}`, as in
`../dye2-v0.1.26/`, and the same shorthands keep the files small (a read
answering what the last read or post of its route did is `"unchanged":
true`, and outside `library.json` a whole profile is `{"$profile":
"<title>/<hash>"}`, its copy in `library.json`'s `profileCopies`).

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (a bean, `Fixture Ethiopia`, and a batch of it, the grinder `Fixture Grinder 64`, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, the simulated machine's settings), the bundled DYE2 (v0.1.31) and its migration flags as it left them on the empty store (`bundledFlags`), the grinders at the end (`grindersAtEnd`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `seeded`: DYE2's recipes and the Workflow as Decent Sync's server leaves them, written from the script (below), and read back. `install`: `POST /plugins/install/github-branch` of v0.1.35's `dist` deploy, its answer and when it came (`answeredAtMs`), `GET /plugins` after, every key of DYE2's and the Workflow read seven times over 6 s from the moment the install was sent (`reads`), and the Workflows plugins were sent meanwhile |
| `plugins.json` | The install's exchange, and DYE2's entry in `GET /plugins` (version `0.1.35`, `source` the branch, its commit) |
| `feed-rate.json` | The feed rate, on DYE2's dashboard and editor: `applyHolding`, recipe `1`'s pill (it holds `MF`); `pills`, the titles of the rail's pills (not a step); `recordUnmoved`, `POST /plugins/dye2.reaplugin/record` from the script; `changedOnMachine`, the Workflow's feed rate written `SF` from the script, as an Edit Shot copy or another app writes one; `recordChanged`; `applyNone`, recipe `2`'s pill (it holds none); `changedOnNone`, `FF` written; `recordOnNone`; `editorSet`, recipe `2` opened in DYE2's editor (`recipe-edit?id=2`), the Workflow naming it, its Feed Rate typed `1200` and saved, with what the input showed before (`shownBefore`); `editorCleared`, its Feed Rate emptied and saved; `cleared`, the dashboard's Clear, then DONE |
| `grinders.json` | DYE2's grinders page: `globalIdWritten`, the grinder's `extras` written from the script with a made-up global id, as the plugin writes one, beside a Beanconqueror key; `noteSet`, `grinders?edit=<id>` opened, as the dashboard's long-press on a grinder opens it, its Feed Rate typed `manual FF/MF/SF` and saved; `otherEdited`, its notes alone changed; `noteCleared`, its Feed Rate emptied; `topLevel`, `PUT /grinders/{id}` of a top-level `feedRate` from the script, as the previous release's plugin writes a Grinder's note; `inExtras`, the note written in `extras` from the script, its other keys kept, as this release's plugin writes it; `created`, a new grinder saved with a Feed Rate |
| `favourites.json` | Auto Favourites: `reseeded`, the seeded recipes written again from the script; `applied`, recipe `1`'s pill; `saved`, DYE2's Auto Favourites edit page opened afresh (`auto-fav-edit`, as its add card opens it), titled `Fixture Saved Favourite`, Fav Number 1 picked and SAVE; `pillsAfterSave` (not a step); `picked`, the dashboard opened, then the Auto Favourites page (`auto-favs`), the favourite's card tapped and CONFIRM, which goes back to the dashboard, which applies it |
| `steam.json` | Steam: `reseeded`; `applySteam`, recipe `3`'s pill (steam by time, 150 °C, 30 s, flow 1.5, milk stop 60); `steamOff`, `{"targetTemperature":0,"duration":0}` written from the script, as Streamline's heater switch writes steam off; `recordOff`; `changedWhileOff`, the steam flow 2.2 and milk stop 55 written; `recordChangedOff`; `steamOn`, `{"targetTemperature":150,"duration":30}` written, as Streamline turns steam back on with the recipe's; `editorTimeOff`, recipe `3` in DYE2's editor, steam by time, 0 typed and saved; `reseededOff`; `steamOnAgain`; `editorTimeLong`, 300 typed, then its + tapped, and saved; `reseededLong`; `editorTempOff`, its Machine Settings opened, the steam temperature stepped down to Off and saved; `form`, what the editor's inputs showed (not a step) |
| `keys.json` | Not exchanges: DYE2's recipes, Auto Favourites and stored selection at the end, and its six migration flags |

## How they were recorded

They were recorded on 2026-11-06 (UTC) by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`; `GET
/info` answers `0.9.1`, build 3027, commit `14361a94`), run headless in a
throwaway Ubuntu 24.04 container as `../dye2-v0.1.33/` describes, its data
new, container port 8080 published to the host's `localhost:8080`. No tablet
was contacted: the owner's three tablets run DYE2 v0.1.33 pinned, so they
hold nothing of v0.1.35, and no record shapes were read from one. Streamline
was not loaded: nothing here goes through it.

- **The bundled DYE2.** Decaid v0.9.1 bundles DYE2 v0.1.31, which loaded as
  Decaid first started and ran its migrations on the empty store
  (`library.json`, `bundledFlags`).
- **The seeded keys.** With it running, the script writes recipes `1` (the
  Ethiopia and its batch, `Adaptive v3`, slot 1, a feed rate of `MF`), `2`
  (no Bean, `Classic Italian espresso`, slot 2, no feed rate) and `3` (no
  Bean, `Classic Italian espresso`, slot 3, steam by time and its four steam
  settings), each as Decent Sync's server writes one with #395
  (`recipeRecord` and `recipeWorkflow` in
  server/src/library/recipe-intake.ts: its feed rate in `dashboardVariables`
  and in its embedded Workflow's `context.extras`, the settings it holds in
  both, shown exactly while in a slot, a whole record in `jsonb`'s key
  order, its Bean's coffee, roaster and batch or explicit nulls for none, and
  a made-up global id), and the Workflow on the Ethiopia's batch. The
  favourites and steam groups start by writing the seeded records again
  (`reseeded`), as the server writes a Recipe's record back, and the steam
  group does so after each editor save too. The Workflow carries on from
  one group to the next.
- **DYE2** v0.1.35 is the latest release. The script installs it as the
  owner's tablets are to have it: `POST
  /api/v1/plugins/install/github-branch {"repo":"decentespresso/dye2",
  "branch":"3e3138657f8440c869b1714df469b8de7b2912b8"}`, the `dist` deploy
  of the v0.1.35 tag's `c066d43`, over the bundled v0.1.31. Decaid answered
  `{"message":"Plugin installed","id":"dye2.reaplugin","version":"0.1.35",
  "loaded":true}` in 1.2 s. The installed `plugin.js` (SHA-256
  `208161437e905ed8d831c3a753c032d3df66816c6b1a4b06bdb0b4a39d821ff4`) and
  `manifest.json` (SHA-256
  `72d0b97cd9fa18faa367793bfb6e4b6abdef65703dc12d3db49e314e2fd3ef56`) are
  byte for byte those of the release asset `dye2.reaplugin-v0.1.35.zip`
  (SHA-256 `426ecc902577c1dc4d43d1743dc01c37bae92c8daba6a43d24df8faa4464f011`,
  as GitHub lists it) and of the tag's `dye2.reaplugin/`.
- **The script**, `record.mjs`, drives DYE2's pages in Playwright's headless
  Chromium as `../dye2-v0.1.33/record.mjs` does, from the repository root:
  `node server/test/fixtures/decaid/dye2-v0.1.35/record.mjs <output dir>`.
  It restarts no Decaid and pulls no Shot, so DYE2 has no recent favourites.
  It reads `DECAID` from the environment for another address. The run
  recorded here was the first on its fresh Decaid; a trial run on another
  fresh one recorded the same, but for the ids Decaid and DYE2 gave and
  when one selection read came.

## Edits

Everything named (bean, batch, grinders, recipes, favourite) was made up
for the recording; the profiles are Decaid's bundled ones. The simulated
machine reports serial `mock-de1` and names no real hardware, so nothing is
scrubbed. As recorded, the files were compacted as `../dye2-v0.1.26/`
describes (`compactAll`). Nothing else was changed.

## What they show

- **Loading** (`loading.json`). Decaid answered the install in about a
  second. By the read at 1.5 s DYE2 had run the two migrations v0.1.32
  added, which the bundled v0.1.31 had not, setting `recipeBeansMigrated`
  and `favBeansMigrated` and changing no recipe, and written its Shot index
  (`shotIndex`). v0.1.34 and v0.1.35 add no migration. The Workflow was not
  written.
- **A recipe's feed rate is applied, flagged, and saved as the RPM is**
  (`feed-rate.json`; `b144426`, `1358750`).
  - Recipe `1`'s pill writes its `dashboardVariables.feedRate` into the
    Workflow's `context.extras.feedRate`, as text, flagging it
    (`extras.dye.feedRate: true`), in the same `PUT /workflow` as the rest
    of the apply (`applyHolding`).
  - `record` saves a feed rate changed on the Machine into a recipe holding
    one (`recordChanged`: `SF`, into its `dashboardVariables` and its
    embedded Workflow) and into none holding none (`recordOnNone`, `saved:
    false`).
  - A recipe holding none, applied, leaves the Workflow's (`applyNone`).
  - DYE2's editor shows the record's feed rate in a text input and saves it
    as typed (`editorSet`: `"1200"`, a string), a blank one as null
    (`editorCleared`). Each save re-applies the recipe the Workflow names,
    naming it again in that `PUT /workflow` (`extras.dye.recipeId`) and
    asking no `POST .../selection`, as the editor has since v0.1.32. The
    re-apply of a recipe holding no feed rate leaves the Workflow's.
  - The dashboard's Clear, then DONE, writes `extras.feedRate: null` with
    the RPM, Basket and note, and leaves `recipeId` (`cleared`).
  - The selection marks the recipe `modified` from its apply on, with
    nothing for `record` to save: v0.1.34's star for a steam, hot water or
    flush setting the record holds none of (`d0d9068`) takes the flush
    settings DYE2 reads from the machine's settings, which on Decaid's
    simulated machine differ from the Workflow's. Decent Sync reads nothing
    of `modified`.
  - The dashboard's rail holds the three recipes (`pills`), and still
    only those once a saved favourite exists (`favourites.json`,
    `pillsAfterSave`): from v0.1.35 it shows recipes only, recent
    favourites included, which this recording, pulling no Shot, has none of
    (`c969adb`, `renderRecipePills` in `dye2:dye2-plugin/src/pages/dashboard.ts`).
- **A grinder's feed rate note lives in its `extras`** (`grinders.json`).
  DYE2's grinders page sends the whole `extras` as the record holds them,
  the global id and the other app's key included, with `feedRate` set
  (`noteSet`), kept on an edit of another field (`otherEdited`), and null
  once emptied (`noteCleared`), which Decaid keeps. A new grinder with a
  note is created with `extras: {"feedRate": ...}` alone (`created`).
  Decaid drops a top-level `feedRate` and answers the record as it was
  (`topLevel`), and keeps one in `extras` with the other keys (`inExtras`).
- **Auto Favourites save a favourite, and applying it clears the recipe**
  (`favourites.json`; `fac6106`). SAVE on the edit page writes only
  `autoFavourites`, a favourite with a new UUID, Fav Number 1 (`favSlot`),
  the copy mask the page starts with, and a snapshot of the Workflow holding
  its feed rate (`MF`), its profile the library's `Adaptive v3`, and no
  `recipes` (`saved`). Confirmed on the Auto Favourites page, it is applied
  on the dashboard with `recipeId: null` and the favourite's profile, so the
  recipe the Workflow named is no longer named, and the selection becomes
  the favourite (`picked`).
- **Steam** (`steam.json`; `5561549`, `3e063e7`, `996981b`,
  decentespresso/dye2#46).
  - With steam off, `record` saves a steam flow and milk stop changed then
    into recipe `3`, which holds both (`recordChangedOff`: 2.2 and 55), and
    still no steam temperature or time (`recordOff`).
  - DYE2's editor shows a steam time of 0 as `Off` (`form.timeOffTyped`).
    Saved, the record holds a steam time of 0 and its steam temperature of
    150, and the re-apply writes `steamSettings` with a temperature and a
    time of 0, steam off whole (`editorTimeOff`).
  - A steam time of 300 typed shows as `255s`, and its + leaves it at 255
    (`form`); saved, the record and the re-applied Workflow hold 255
    (`editorTimeLong`).
  - The steam temperature stepped down past 135 °C shows `Off`; saved, the
    record holds a steam temperature and a steam time of 0, though the steam
    stepper still showed `30s` (`form.tempOffSteamShown`), and the re-apply
    writes steam off whole (`editorTempOff`).
