# DYE2 v0.1.33 and Streamline v0.2.21 on Decaid v0.9.1

What DYE2 v0.1.33 and Streamline v0.2.21 do otherwise than DYE2 v0.1.32 and
Streamline `main` at cec5664, where it touches what Decent Sync writes and
records, recorded as `../dye2-v0.1.32/` records what v0.1.32 does otherwise
than v0.1.26: each request a page or the recording script sent to DYE2's keys
in Decaid's store, DYE2's `selection` and `record` routes, Streamline's
remembered values, and the Workflow, and the status and body Decaid
answered, its JSON parsed. Requests the script sent stand for the plugin's,
or for anything else on the tablet changing the Workflow. They were recorded
for decent-sync #387.

DYE2 v0.1.33 does everything `../dye2-v0.1.32/` shows but where these files
show otherwise. Between the two, `dye2-plugin/src/` changed in what Decent
Sync relies on only where this README says (What they show, below): the rest
of the diff is the dashboard's shot history search and filters, its chart
(ECharts in place of Plotly), Edit Shot's layout and the jump into past
Shots. Its Select Recipe page's assign mode and its basket picker did not
change; Streamline opens the assign mode from v0.2.20 (`35c5917`).

A step is `{exchanges, after, pushes, events, timing}`, as in
`../dye2-v0.1.26/`: its exchanges (of the reads, on DYE2's dashboard and
basket picker only those of `selection` and `recipes`, on Streamline only
those of `selection` and DYE2's stored mirror of it); `after`, reads made
2.5 s after the step, once DYE2 has followed the change; `pushes`, what DYE2's
`changed` socket heard meanwhile; `events`, the `context` of each Workflow
Decaid sent plugins in a `workflowUpdated` meanwhile, heard through
`../dye2-v0.1.26/workflow-recorder/`; and `timing`, when each push and event
came, in ms from the step's start. The same shorthands as `../dye2-v0.1.26/`
keep the files small: a read answering what the last read or post of its
route in the file did is `"unchanged": true`, and outside `library.json` a
whole profile is `{"$profile": "<title>/<hash>"}`, its copy in
`library.json`'s `profileCopies`. A profile's hash is of its JSON, so one
profile in two key orders has two copies.

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (a bean, `Fixture Ethiopia`, and a batch of it, the grinder `Fixture Grinder 64`, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, the simulated machine's settings), the bundled DYE2 (v0.1.31) and its migration flags as it left them on the empty store (`bundledFlags`), DYE2's recipes at the end (`recipes`), and `profileCopies` |
| `loading.json` | `seeded`: DYE2's keys and the Workflow as Decent Sync's server leaves them, written from the script (below), and read back. `install`: `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}`, its answer and when it came (`answeredAtMs`), `GET /plugins` after, every key of DYE2's and the Workflow read seven times over 6 s from the moment the install was sent (`reads`, each with `atMs`), and the Workflows plugins were sent meanwhile |
| `plugins.json` | The install's exchange, and DYE2's entry in `GET /plugins` (version `0.1.33`, `source` the release) |
| `applies.json` | decentespresso/dye2#43, on DYE2's dashboard: `applyBeforeProfileEdit`, recipe `1`'s pill; `recordProfileEdited`, its record rewritten from the script with its profile's first step at 6 s, in `jsonb`'s key order, as Decent Sync's server writes an edited Profile; `reapplyEdited`, its pill again; `recordProfileEditedAgain`, the record rewritten so at 8 s; `ownProfileSameId`, that profile written into the Workflow from the script, in Decaid's key order, with the same `recipeId`, one PUT, as the plugin's load writes one; `otherProfileSameId`, `Classic Italian espresso` written with the same `recipeId` |
| `baskets.json` | DYE2's `record` of a Basket, on DYE2's dashboard and basket picker: `applyNoBasket`, recipe `2`'s pill (it holds no Basket, nor does the Workflow); `basketPicked`, `Fixture 18g Precision` picked and confirmed on the basket picker, as the dashboard's Basket field opens it; `recordPicked`, `POST /plugins/dye2.reaplugin/record` from the script, as the plugin calls it after each change; `applyOverBasket`, recipe `1`'s pill (it holds none, the Workflow holds `Fixture 18g Precision`); `recordUnmoved`; `basketPickedAgain`, `Fixture 20g High-flow` picked; `recordMoved`; `basketCleared`, the Workflow's Basket written null from the script, as the dashboard's Clear writes it; `recordCleared`; `applyHolding`, recipe `4`'s pill (it holds `Fixture 18g Precision`); `basketPickedOnHolding`, `Fixture 20g High-flow` picked; `recordOnHolding` |
| `streamline.json` | Streamline's DYE strip: `started`, its page load; `cells`, the names its five buttons showed (not a step); `applyFromStrip`, recipe `2`'s button; `tapHighlighted`, the same button tapped again; `filledMenu` and `emptyMenu`, the long-press menus' labels on recipe `1`'s button and on the empty third one (not steps); `replace`, "Replace" on recipe `4`'s button, which opened DYE2's Select Recipe page at the address in `opened`, where recipe `3` was picked and assigned (`confirmLabel`, the button's label), Streamline loading again on the return; `cellsAfterReplace` |
| `keys.json` | Not exchanges: DYE2's recipes, baskets and stored selection at the end, and its six migration flags |
| `skins.json` | Not exchanges of DYE2's: `POST /webui/skins/install/url` of Streamline's `dist` deploy of v0.2.21 (`installed`), as the owner's tablets run it, and `GET /webui/skins` after (`skins`) |

## How they were recorded

They were recorded on 2026-10-31 by Decaid's v0.9.1 Linux arm64 release
(`decaid-linux-arm64-0.9.1.tar.gz`, SHA-256
`b048626001f6c6e1eff1b4941e12213f05cf6bed9a6b0a81cbf41f80fc081740`, as
`decaid-0.9.1-SHA256SUMS.txt` names it; `GET /info` answers `0.9.1+3027`,
commit `14361a94`), run headless in a throwaway Ubuntu 24.04 container as
`../dye2-v0.1.26/` describes: Xvfb as its display, a D-Bus system bus and
Avahi running, started as `xvfb-run -a dbus-run-session -- decaid --serial
--bypass-onboarding --no-account` with its simulated machine and scale, its
clock in UTC and its data new, container port 8080 published to the host's
`localhost:8080`. No tablet was contacted: the owner's were not reachable
from where this was recorded, so no record shapes were read from one.

- **The bundled DYE2.** Decaid v0.9.1 bundles DYE2 v0.1.31, which loaded as
  Decaid first started and ran its migrations on the empty store, setting
  `selectionMigrated`, `recipesMigrated`, `favSlotsMigrated` and
  `favProfilesMigrated` (`library.json`, `bundledFlags`).
- **The seeded keys.** With it running, the script writes two baskets and
  four recipes, each as Decent Sync's server writes one since #371 (its
  fields at the paths `recipeRecord` writes, shown exactly while in a slot, a
  whole record in `jsonb`'s key order, an embedded Workflow with no flags, its
  Bean's coffee, roaster and batch or explicit nulls for none, and a made-up
  global id): `1` (the Ethiopia and its batch, `Adaptive v3`, slot 1), `2`
  (no Bean, `Classic Italian espresso`, slot 2), `3` (no Bean, `Classic
  Italian espresso`, no slot) and `4` (the Ethiopia, `Classic Italian
  espresso`, holding `Fixture 18g Precision`, slot 4). And the Workflow on the
  Ethiopia's batch, with no Basket.
- **DYE2** v0.1.33 is the latest release, so the script installs it with
  `POST /api/v1/plugins/install/github-release {"repo":"decentespresso/dye2"}`
  over the bundled one: the release asset `dye2.reaplugin-v0.1.33.zip`
  (SHA-256 `86e3529c7157e2b2c979329419d3fb663529579d1e904f826dc4165f2c98d5bf`,
  as GitHub lists it), whose installed `plugin.js` (SHA-256
  `aa9222cca817172583a6ab3cdb73ec496bdd80dc6d32ab9e7aff1a98f15d9ad5`) and
  `manifest.json` are byte for byte the `dist` branch's at `a98bc5f`, which
  deploys it and which the owner's tablets are pinned to.
- **Streamline** v0.2.21 is its repository's files at the tag (`git archive
  v0.2.21`), served as static files at `http://localhost:13999/` and switched
  to its DYE strip as for `../dye2-v0.1.26/`. As DYE2 is on another origin
  there, "Replace" opens DYE2's page in the whole tab rather than an overlay,
  and DYE2 sends it back to Streamline's address, which loads again.
  `skins.json` installs the `dist` deploy of the tag, `aa45652`, by URL, as
  the owner's tablets did; Decaid had meanwhile updated the bundled
  `streamline.js` to v0.2.21 by itself.
- **The script**, `record.mjs`, drives the pages in Playwright's headless
  Chromium as `../dye2-v0.1.32/record.mjs` does, from the repository root:
  `node server/test/fixtures/decaid/dye2-v0.1.33/record.mjs <output dir>`. It
  restarts no Decaid and pulls no Shot. It reads `DECAID` and `SKIN` from the
  environment for other addresses. The run recorded here was the first on a
  fresh Decaid. Afterwards `replace`'s `confirmLabel`, which that run kept as
  the last of its exchanges, was moved beside them, as `record.mjs` now
  writes it.

## Edits

Everything named (bean, batch, grinder, baskets, recipes) was made up for the
recording; the profiles are Decaid's bundled ones. The simulated machine
reports serial `mock-de1` and names no real hardware, so nothing is
scrubbed. As recorded, the files were compacted as `../dye2-v0.1.26/`
describes (`compactAll`). Nothing else was changed but `confirmLabel`
(above).

## What they show

- **Loading** (`loading.json`). Decaid answered the install in about a
  second. By the read at 1.5 s DYE2 had run the two migrations v0.1.32
  added, which the bundled v0.1.31 had not, setting `recipeBeansMigrated` and
  `favBeansMigrated` and changing no recipe, as the seeded ones hold the
  nulls already. v0.1.33 adds no migration. The Workflow was not written.
- **A recipe applied again on its own profile keeps its id, whatever its
  record's key order** (`applies.json`; decentespresso/dye2#43, `026054e`).
  DYE2's `profileFingerprint` sorts every object's keys (`sortKeysReplacer`
  in `dye2:dye2-plugin/src/utils/workflow-record.ts`), so the profile a
  record holds in `jsonb`'s order is the Workflow's in Decaid's: the
  dashboard's apply of recipe `1` after its record's profile changed keeps it
  named (`reapplyEdited`), and so does the record's profile written into the
  Workflow with the same `recipeId` in one PUT (`ownProfileSameId`), where
  v0.1.32 cleared both. Another profile clears it as before
  (`otherProfileSameId`).
- **A Basket picked since the apply is saved into a recipe holding none**
  (`baskets.json`; `163a7c8`). DYE2 notes the Workflow's `basketId` as a
  recipe is applied, null for none (`armedMachine` in `workflowChanged`), and
  `record` saves a Basket that moved off it, its id and name together, into a
  recipe holding none (`movedSinceArming`): `recordPicked` and `recordMoved`
  saved, `recordUnmoved` did not, as the Basket the Workflow held as recipe
  `1` was applied is no pick. It removes none (`recordCleared`), and saves a
  change of one the recipe holds as before (`recordOnHolding`). Meanwhile
  DYE2's selection marks the recipe modified (`basketPicked`,
  `basketPickedAgain`), which Streamline's strip stars (`cf98e25`), until
  `record` saves it. DYE2's dashboard applies no Basket, as before: applying
  recipe `4` left the Workflow's alone (`applyHolding`).
- **Streamline's strip** (`streamline.json`). A tap on the highlighted
  button, the recipe DYE2's selection names, sends nothing (`tapHighlighted`,
  `0af3b9d`). A filled button's long-press menu offers "Edit in DYE2",
  "Replace <name>" and "Clear button" ("Save changes" only on the
  highlighted one), and an empty button's "Select recipe" and "Save to
  recipe N" (`filledMenu`, `emptyMenu`). "Replace" no longer saves the
  Workflow into the button (`35c5917`): it opens DYE2's Select Recipe page
  with `slot` set, whose ASSIGN TO 4 saves the recipe picked in slot 4,
  shown, through `updateRecipe`, whose `takeSlot` leaves the slot's previous
  holder in no slot and still shown, and applies nothing (`replace`).
- **Streamline's `dist` build carries a version of its own**
  (`skins.json`; streamline-js `800a521`): Decaid lists the deploy of
  v0.2.21 as `streamline.js-dist`, named `Streamline.js Dev`, version
  `0.2.21-dev.c568255.686`.
- **Not recorded.** Streamline's settings page's restore of machine
  settings, which from v0.2.20 keeps a value changed elsewhere but where the
  Machine reads what Decaid wrote as it connected (`splitDifferences` and
  `RESET_ON_CONNECT` in `streamline-js:src/settings/settings-restore.js`;
  ADR-0023), was read in its source: Decent Sync simulates none of that page's
  restore. Nor its wake profile, which from v0.2.19 sends its profile
  (`profile.wake` in `streamline-js:src/modules/workflow-fields.js`).
