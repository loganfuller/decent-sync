# DYE2 v0.1.42 and Streamline v0.2.31 on Decaid v0.9.2: a grind setting of 0

What DYE2 v0.1.42 and Streamline v0.2.31 write to Decaid v0.9.2 with a
grind setting of 0, recorded as `../dye2-v0.1.40/` records DYE2 v0.1.40:
each request a page or the recording script sent, and the status and body
Decaid answered, its JSON parsed. Requests the script sent stand for Decent
Sync's plugin (its `record` call), for Decent Sync's server (a recipe's
record written), or for a barista's dial (a Workflow write). They were
recorded for decent-sync #617, which raises the DYE2 minimum to v0.1.42,
where a grind setting of 0 is a dial position (decentespresso/dye2#47):
what DYE2's dashboard and Streamline's strip apply for a recipe at 0, what
DYE2's editor saves for one, what DYE2's `record` saves from a Workflow at
0, what a grinder picked with a default of 0 brings, and DYE2's repair, as
it loads, of a recipe saved at 0 before v0.1.42.

The steps, the shorthands and `compactAll` are `../dye2-v0.1.40/`'s: a step
is `{exchanges, alsoSent, after, pushes, events, timing}`, `after` reading
the Workflow, DYE2's derived selection and its recipes 2.5 s after the
step (5 s after `reloaded` and `reloadedAgain`); a read of `/workflow` or
DYE2's `recipes` answering what the last read or post of it in the file did
is `"unchanged": true`; and outside `library.json` a whole profile is
`{"$profile": "<title>/<hash>"}`, its copy in `library.json`'s
`profileCopies`. Entries that are no exchange: `{"shown": ...}`, what DYE2's
recipe editor showed as it opened; `{"tiles": ...}`, what Streamline's
dose, grind and Drink tiles showed after a strip apply; and `{"tabs":
[...]}`, the dashboard's grinder tabs after a pick.

The grinders, made through `POST /api/v1/grinders`, each numeric with a
small step of 0.5 for the grind setting and 50 for the RPM:

| Grinder | `extras` | What a pick brings |
|---|---|---|
| `Fixture Grinder 64` | none | The grinder the seeded recipes name |
| `Fixture Grinder Zero` | `settingMin` 0, `settingMax` 10, `settingDefault` 0 | A grind setting of 0 |

The recipes, as `../dye2-v0.1.40/record.mjs` writes records, as Decent
Sync's server wrote them before #550, a field only where the Recipe holds
one, a grind setting of 0 among them, and its embedded Workflow holding
`grinderSetting` as text, as this server writes one from #617:

| Recipe | Name | What it holds |
|---|---|---|
| `1` | `Fixture Full Recipe` | As `../dye2-v0.1.40/`'s recipe `1`: `Adaptive v3` at 92 °C, 18 g in, 36 g out, grind setting 2.5, RPM 1000, feed rate `MF`, `Fixture Grinder 64`, the Basket `Fixture 18g Precision`, the Bean and its batch |
| `2` | `Fixture Zero Grind` | `Classic Italian espresso` at 93 °C, 19 g in, 38 g out, `Fixture Grinder 64`, grind setting the number 0, `"0"` in its embedded Workflow |
| `3` | `Fixture Old Zero Grind` | As `2`, but none (null) in its embedded Workflow, as DYE2 saved a recipe at 0 before v0.1.42 |
| `4` | `Fixture No Grind` | As `2`, with no grind setting at all |
| `5` | `Fixture Zero Text` | As `2`, its grind setting the text `"0"` |

| File | What it holds |
|---|---|
| `library.json` | Not exchanges: what Decaid's API listed once the library was made (the bean and its batch, the two grinders, DYE2's `baskets` key, the bundled profiles `Adaptive v3` and `Classic Italian espresso`, `GET /info`), and `profileCopies` |
| `loading.json` | `recorder`, the recorder's install (`PUT /plugins/workflow-recorder.reaplugin/source` and its `enable`, both with Decaid's token, the source left out of the body); `bundledDye2`, the bundled DYE2's entry in `GET /plugins` (v0.1.37); `install`, `POST /plugins/install/github-release {"repo":"decentespresso/dye2"}` with Decaid's token and its answer; `listed`, DYE2's entry after (v0.1.42, loaded); `basketsWritten`; then every DYE2 key and the Workflow before any recipe was written |
| `dashboard-applies.json` | Items 1, DYE2's dashboard, recipes `1`, `2`, `4` and `5`: `seeded`; `applyFull`; `pills` (not a step); `applyZero`; `applyFullAgain`; `applyNoGrind`; `applyZeroAgain`; `applyZeroText`; `applyFullThird`; `editorSavedZero`, recipe `2` opened in DYE2's recipe editor (`recipe-edit?id=2`) and saved as it showed; `applyFullFourth`; `applyZeroSaved`. Each apply opens the dashboard afresh and taps the recipe's pill |
| `strip-applies.json` | Item 2, Streamline's strip, the same recipes seeded again: `seeded`, `started`, `cells` (not a step); `applyFull`, `applyZero`, `applyFullAgain`, `applyNoGrind`, `applyZeroAgain`, `applyZeroText`, each a strip button tapped |
| `record.json` | Item 3, DYE2's dashboard and the script, recipes `1` and `2`: `seeded`; `applyFull`; `dialledZero`, `PUT /workflow {"context":{"grinderSetting":"0"}}`; `recordZero`, `POST /plugins/dye2.reaplugin/record`; `applyZero`; `recordUnmoved`; `dialledNumberZero`, `PUT /workflow {"context":{"grinderSetting":0}}`, the number; `recordNumberZero`; `reseeded`; `applyFullAgain`; `pickedZeroDefault`, `Fixture Grinder Zero`'s tab tapped on the dashboard that applied recipe `1`; `recordAfterPick` |
| `repair.json` | Item 4, recipes `1` and `3`: `seeded`; `started`, Streamline opened; `applyOldZero` and `applyFull` from its strip; `reloaded`, `POST /plugins/dye2.reaplugin/disable` and then `enable`, each with Decaid's token, as an update of DYE2 loads it again; `reloadedAgain`, the same; `startedAgain`, Streamline opened again; `applyFullAgain`, `applyRepaired` (recipe `3`) from its strip |
| `keys.json` | Not exchanges: DYE2's recipes and stored selection at the end |

## How they were recorded

They were recorded on 2026-11-22 between 16:01 and 16:05 (UTC) by Decaid's
v0.9.2 Linux arm64 release (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answers `0.9.2`, build
3191, commit `875b7a6a`), run headless in a throwaway Ubuntu 24.04 container
as `../dye2-v0.1.40/` describes, with its simulated machine and scale and
its data new, its port 8080 published to the host's `localhost:8080`. No
tablet, server or other device was contacted.

- **The token.** Decaid was started with `DECAID_EXTENSIONS_TOKEN` set to 64
  hexadecimal characters from `openssl rand -hex 32`. The script sent it
  with the recorder's source and enable, DYE2's install, and each disable
  and enable of DYE2 in `repair.json`. The token is in no file: a request
  that carried it holds `"token": "launch"`. No request a page sent carried
  a token, and none was refused.
- **DYE2** v0.1.42 is the latest release (tag commit `60383c6`). The script
  installs it over the bundled v0.1.37 with `POST
  /api/v1/plugins/install/github-release {"repo":"decentespresso/dye2"}`,
  which Decaid answered `{"message":"Plugin installed","id":"dye2.reaplugin",
  "version":"0.1.42","loaded":true}`.
- **Streamline** v0.2.31 is its repository's files at the tag (`git archive
  v0.2.31`, commit `e9c08d5`), served at `http://localhost:13999/` by
  `python3 -m http.server`, each group opening it in a browser context of
  its own, its DYE2 switch on and its strip on recipes, as
  `../dye2-v0.1.40/` describes. Before the pages are opened the script sends
  `PUT /machine/state/idle`, not recorded.
- **The script**, `record.mjs`, made from `../dye2-v0.1.40/record.mjs`,
  drives the pages in Playwright's headless Chromium (`@playwright/test`
  1.63.0), from the repository root, with Node v26.13.0:
  `DECAID_EXTENSIONS_TOKEN=<token> node
  server/test/fixtures/decaid/dye2-v0.1.42/record.mjs <output dir>`. It
  pulls no Shot and restarts no Decaid. Its node process did not exit once
  it logged `done`, every file written, and was stopped.
- **DYE2's repair is not an exchange.** DYE2 posts its recipes from inside
  Decaid as it loads, which no page sent, so `reloaded` shows it in its
  `after` read of DYE2's recipes. Decaid's log showed one `POST
  /api/v1/store/dye2.reaplugin/recipes` from DYE2 11 ms after the first
  `enable` and none after the second.

## What they show

- **A grind setting of 0 is applied as `"0"`.** DYE2's dashboard writes
  `grinderSetting` `"0"` for recipe `2` (the number 0) and recipe `5` (the
  text), and `null` for recipe `4`, holding none (`applyZero`,
  `applyNoGrind`). It sends only what differs from its copy of the Workflow,
  which holds Decaid's text, so `applyZeroText` after `applyZeroAgain` sends
  no grind setting at all, and nor does `applyFullFourth` after the editor's
  save, whose re-apply left the Workflow at 2.5. Streamline's strip applies
  each record's embedded Workflow, keeping its `"0"` (`applyZero`,
  `applyZeroText`); its Grind tile shows `0`, and a dash for recipe `4`.
- **DYE2's editor keeps a 0.** It shows recipe `2`'s grind setting as `0`,
  and `editorSavedZero` saves it with `dashboardVariables.grind` 0 and `"0"`
  in its embedded Workflow.
- **DYE2's `record` saves a 0 as the number.** A Workflow at `"0"` over
  recipe `1`'s 2.5 saves `grind` 0 and `"0"` in the embedded Workflow
  (`recordZero`, `saved: true`). A Workflow at the number 0, which Decaid
  keeps as `"0"`, saves nothing over a recipe already at 0
  (`recordNumberZero`, `saved: false`), and nor does a recipe at 0 just
  applied (`recordUnmoved`).
- **A grinder picked with a default of 0 brings the number 0.**
  `pickedZeroDefault` writes `grinderSetting` 0 with the grinder, which
  Decaid keeps as `"0"`; `record` then saves the 0 into recipe `1`.
- **The repair.** Before it, Streamline's strip applies recipe `3`'s
  embedded Workflow's null, clearing the grind setting (`applyOldZero`, its
  Grind tile a dash), though DYE2's dashboard would apply `"0"` from its
  `dashboardVariables`. Once DYE2 loads again, recipe `3`'s embedded Workflow
  holds `"0"` (`reloaded`), its record otherwise unchanged, its `capturedAt`
  included, so the repair is no save of the editor's; loaded again, it
  posts nothing (`reloadedAgain`); and the strip then applies `"0"`
  (`applyRepaired`).

## `baskets.json`: DYE2 v0.1.42's Basket picker archiving, editing and deleting

What DYE2 v0.1.42's Basket picker (`basket-picker`, the page DYE2's
dashboard and Edit Shot open) writes to Decaid's store as a barista
archives, unarchives, edits an archived Basket and deletes one, recorded for
decent-sync #618 by `record-baskets.mjs`, beside this directory's other
files but on a Decaid of its own. As `../dye2-2cf631c/baskets.json`, a step
is a list of exchanges, `{request: {method, path, body?}, response: {status,
body}}`: every read and post of `/store/dye2.reaplugin/baskets` the page
sent, in order (and every other request it sent but a read; there were
none). Two kinds of entry are no request of the page's: an exchange with
`"after": true`, the list as the script read it once the step was done; and
`{"shown": [...]}`, what the picker listed then, in its order, each card's
name, whether it was dimmed as archived (`dye-card-archived`), and its two
lines of text.
`server/test/support/simulated-dye2.ts` acts as this picker
(`archiveBasketInDye2`, `editBasketInDye2`, `deleteBasketInDye2`), and
`server/test/simulated-dye2-writes.test.ts` checks it against these steps.

The list was seeded as Decent Sync's plugin adds a Basket to it
(`writeInList`): each row the write's fields, an id from `randomUUID()`, a
creation time and a made-up global id, `decentSyncId`:

| Row | `name` | `size` | `diameterMm` | `notes` | `createdAt` |
|---|---|---|---|---|---|
| 1 | `Fixture 18g Precision` | `double` | 58.5 | `Fixture notes` | `2026-11-22T09:00:00.000Z` |
| 2 | `Fixture 20g Ridgeless` | `double` | 58 | `Fixture ridgeless notes` | `2026-11-22T09:01:00.000Z` |

The steps, in order, all on one picker page opened once, its sort `Recent`
(newest `createdAt` first). A Basket's editor opens on a 800 ms hold on its
card, or on a tap once it is archived, as the page has it:

| Step | What the barista did |
|---|---|
| `seeded` | Not the page's: the script's `POST` of the two rows, standing for Decent Sync's plugin |
| `opened` | The picker opened: its load read |
| `archive18gBasket` | `Fixture 18g Precision`'s editor opened, ARCHIVE tapped, ARCHIVE tapped in the `dyeConfirm` box |
| `pickerListed` | Not a step: the picker's list after `archive18gBasket` |
| `editArchived18gBasket` | The archived 18g Basket's editor opened, its name changed to `Fixture 18g Precision II` and its notes to `Fixture notes, edited while archived`, SAVE tapped |
| `unarchive18gBasket` | Its editor opened, UNARCHIVE tapped (it asks no confirmation) |
| `archive20gBasket` | `Fixture 20g Ridgeless` archived as the 18g was |
| `delete20gBasket` | The archived 20g Basket's editor opened, DELETE tapped, DELETE tapped in the `dyeConfirm` box |
| `clearNotes18gBasket` | Added to the plan: the 18g Basket's editor opened, its notes emptied, SAVE tapped |

### How `baskets.json` was recorded

On 2026-11-22 at 20:27 (UTC), by the same Decaid v0.9.2 Linux arm64 release
as the files above (`decaid-linux-arm64-0.9.2.tar.gz`, SHA-256
`a2c5d0bb8c54a53bbb4923c5427f3a3a2bd6d9daaad56f78a25fb2b80e233016`, as
`decaid-0.9.2-SHA256SUMS.txt` names it; `GET /info` answered `0.9.2`, build
3191, commit `875b7a6a`), headless in a throwaway container of the Ubuntu
24.04 image the earlier recordings used, started as they describe, with its
simulated machine and scale, its data new and its port 8080 published to
the host's `localhost:8080`. No tablet, server or other device was
contacted. A first run a few minutes earlier, without
`clearNotes18gBasket`, recorded the same requests for the steps it shared;
its Decaid was removed and the file recorded again on a new one.

- **The token.** Decaid was started with `DECAID_EXTENSIONS_TOKEN` set to 64
  hexadecimal characters from `openssl rand -hex 32`. Only DYE2's install
  carried it, and it is in no file. No request the page sent carried a
  token, and none was refused.
- **DYE2** v0.1.42, the latest release, installed over the bundled v0.1.37
  by the script with `POST /api/v1/plugins/install/github-release
  {"repo":"decentespresso/dye2"}` and Decaid's token, which Decaid answered
  `{"message":"Plugin installed","id":"dye2.reaplugin","version":"0.1.42",
  "loaded":true}` (logged, not kept in the file).
- **The script**, `record-baskets.mjs`, made from `record.mjs` and
  `../dye2-2cf631c/record.mjs`, drives the page in Playwright's headless
  Chromium (`@playwright/test` 1.63.0, 1280x800), each request the page sent
  fetched by Playwright and its answer handed to the page unchanged, from
  the repository root with Node v26.13.0:
  `DECAID_EXTENSIONS_TOKEN=<token> node
  server/test/fixtures/decaid/dye2-v0.1.42/record-baskets.mjs <output dir>`.

### Edits to `baskets.json`

None. Every name, note, id and global id was made up for the recording (the
ids and global ids by `randomUUID()` as the script ran); the rows hold no
hardware id or address, and a search for serials, MAC and LAN addresses
found none. The token appears nowhere.

### What `baskets.json` shows

- **Every change reads the list and posts it whole**, then reads it again
  (`afterRowChange`, or the save's own reload): a read, a `POST` of the
  whole list, a read.
- **`updateBasket` merges; it does not replace the row.** It builds the
  row from the page's body, the row's id and its `createdAt`, and
  `kvUpsert` spreads that over the row held (`{ ...arr[i], ...item }`). So
  an edit keeps every field the body leaves out: `decentSyncId` and
  `createdAt` are kept by ARCHIVE, by UNARCHIVE and by the edit of an
  archived row, whose body is only the form (`editArchived18gBasket`); and
  emptying a field on the form does not clear it, as the body then leaves
  it out (`clearNotes18gBasket` posts the row with its notes unchanged, and
  the picker still shows them). An edit changes only the fields on the
  form that hold a value (the name always). The list's other rows are
  posted as read.
- **ARCHIVE writes `archived: true`** on the row, every other field as it
  was, added as its last key (`archive18gBasket`, `archive20gBasket`). The
  picker then lists it dimmed, last, with `Archived · <notes>` as its second
  line (`pickerListed`), and a tap on it opens its editor rather than
  picking it.
- **The edit of an archived row carries `archived: true` over**: the page
  puts it in the body (`editingArchived`), so the row posted is still
  archived, with the new name and notes (`editArchived18gBasket`).
- **UNARCHIVE writes `archived: false`**, keeping the field rather than
  dropping it (`unarchive18gBasket`); the row stays `archived: false` after
  later edits (`clearNotes18gBasket`), since an edit of a row not archived
  sends no `archived` and the merge keeps the `false`.
- **DELETE posts the list without the row**, whether or not it is
  archived: `delete20gBasket` deletes the archived 20g Basket, posting the
  remaining row only, unchanged.
