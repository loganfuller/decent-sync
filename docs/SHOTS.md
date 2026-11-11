# Shot capture

Ticket [#9](https://github.com/loganfuller/decent-sync/issues/9) extends protocol
version 1 with these messages, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `shot` | `id` (delivery id), `shotId` (Decaid id), `shot` (opaque record) |
| Plugin to server | `shotUpdated` | The same fields, with the Shot's metadata only |
| Plugin to server | `shotIndex` | `id`, `shots: [{ id, updatedAt? }]`, at most 100 entries |
| Server to plugin | `requestShots` | `shotIds`, at most 100 ids |
| Server to plugin | `ack` | `id` (the logical delivery id) |

Decent Sync supports Decaid v0.9.1 and later. A `shotUpdated` carries the
complete metadata from Decaid's `shotUpdated` event, which
`PersistenceController.updateShot` raises and `decaid:lib/main.dart`
broadcasts, and which has no measurements, so a newer edit replaces the stored metadata whole,
cleared fields included, and preserves stored measurements. A full `shot` is
a complete record; unknown inner fields are accepted and retained. A record
without a UTC `updatedAt` ending in `Z`, or a full record without a measurements array, is
not one those Decaid versions send: the server acknowledges and ignores it,
and logs a warning naming the Machine, the Shot's id (quoted, with anything
that could end or restyle the line escaped), the message type and what the
record lacks, with no field's value. A Shot ignored this way is not
held, so indexes request it again, and it is ignored and logged each time.
The server also acknowledges and ignores a Shot whose id it cannot store
(`isRecordId`: more than `MAX_RECORD_ID_LENGTH`, 128, code units, or a NUL),
without logging it, as the plugin never sends one; Decaid's are UUIDs. A
delivery whose storage fails in a way that would repeat, such as one with a
NUL in a string, is set aside as received and acknowledged as stored, and the
Shot counts as known to that Machine's indexes from then on
(`AI_PROTOCOL_NOTES.md`, Deliveries set aside).

Decaid v0.9.0 reports every Shot it writes. `shotStored` names a new Shot,
pulled or imported: `PersistenceController.storeShot`, which only inserts,
raises it for a Shot a backup import adds (`ShotExportSection` in
`decaid:lib/src/services/webserver/data_export/shot_export_section.dart`),
and for those the de1app importer, as onboarding runs it, and the Shot file
import (`ShotImporter`) add. `shotUpdated` names a changed one: an edit
through `PUT /api/v1/shots/{id}` or on Decaid's history page, and a backup
import that overwrites a Shot whose content changed (`notifyPlugins:
contentChanged`); an overwrite that changes nothing keeps the Shot's
`updatedAt` and reports nothing. The plugin requests a new Shot from its
outbox by id, ahead of backfill, and fetches it with `GET /shots/{id}` only
when the outbox is about to send it, as it fetches backfill. With its
measurements a Shot is tens of KB, so while the server is unreachable the
plugin holds only the ids of the Shots stored meanwhile, and sends them once
a connection is welcomed. A Shot deleted before it is read is skipped. A
`shotUpdated` is queued as Decaid reports it, so
an edit can reach the server before its Shot's full record; the server stores
it as an early edit (below).

On load, the plugin pages `GET /shots?limit=100&offset=...&order=desc` once,
sending each page's ids and edit times. Offsets shift when Shots are deleted
or added during the scan, so each page after the first repeats the previous
page's last 10 positions and resumes after the last Shot already read whose
edit time is unchanged, so Shots that exist for the whole scan are all
indexed. An edit or import that changes a Shot's time can move it from the
part not yet read into the part already read. That needs no reading, as
Decaid reports it in `shotUpdated` (above), so the scan does not compare
the Shots it read with `total`. A Shot moved that way that the server does
not hold yet reaches it only as its metadata, stored as an early edit; its
full record is requested at the next load's index, which the server answers
with `requestShots` for the Shots it lacks, holds without a full record, or
holds at an older version. If no Shot already read reappears (more than the
overlap were deleted between two pages), or the list grows past what the
first page's `total` allows, the scan starts again. After
three passes it logs and leaves the rest to the next load. The index is sent
once per load, replacing milestone 1's "on every `welcome`", as the Steam
Record index is (`STEAM_RECORDS.md`). A reconnect sends no index, only the
deliveries still unacknowledged, and a scan that a disconnect interrupted
carries on where it was, so no page acknowledged before the disconnect is
sent again. A server whose database was wiped or restored therefore learns
which Shots it lacks only when the plugin is reloaded. The server's
`requestShots` lists the Shots it lacks in the order the index offered them,
each once, so backfill goes newest first. The outbox
fetches requested Shots, new ones first, one at a time, when it has nothing
else queued. Only one logical
delivery awaits acknowledgment at a time, and the scan waits while the outbox
has four deliveries. A Shot whose fetch
fails is retried after the other requested Shots; a 404 means the tablet
deleted the record. Shots Decaid imported from the legacy de1app (`de1app-*`
ids), and Shots whose ids the server cannot store, are never indexed or sent
(ADR-0004). Deletion
never removes a server record. The outbox (`plugin/src/outbox.ts`) holds
Shots in memory, and Steam Records and Workflow and machine state events
share it (`STEAM_RECORDS.md`, `WORKFLOW-AND-STATE.md`); only the last are also
kept in plugin storage across unloads, and reload reconciliation recovers
lost Shots and edits.
A delivery too large for one frame, such as a long filter or tea shot, is sent
in chunks and acknowledged once (`AI_PROTOCOL_NOTES.md`).

`ShotsService` serializes a Shot's deliveries with a PostgreSQL advisory lock,
then compares `updatedAt` in PostgreSQL. Edit-time
precision is six fractional digits, matching Decaid, rather than JavaScript's
milliseconds. A tie keeps the stored metadata. An early edit is stored as an
incomplete Shot and acknowledged only after commit, or once set aside. Its full record is still
requested and adds its measurements without rolling back the edit. Incomplete
Shots are hidden from REST reads and Machine status.

Decent Sync assumes a Shot's curves never change once it was pulled. A
backup import that changes a Shot's measurements, alone or with its
metadata, is reported in `shotUpdated` with the metadata only and a new
`updatedAt`: the server stores that version, and never requests the full
record again, so it keeps the old curves. Decaid offers no way to edit
curves (`PUT /api/v1/shots/{id}` refuses `measurements`), so this needs a
backup holding a different copy of the same Shot. An accepted gap.

First full records resolve credit from their own hardware (ADR-0015), or the
session's reporting identity when inferred. A recorded model or serial longer
than `MAX_HARDWARE_LENGTH`, which a `hello` may not report either, names no
hardware: the Shot is inferred, and no Pending Machine is made for it. A
mismatched session's inferred records use its reported hardware, held by a
Pending Machine until adopted.
Hardware is locked before Machine rows and the Pending Machine upsert,
matching identity resolution. The Shot advisory lock holds no Shot row while
waiting for that hardware lock; adoption never takes the Shot advisory lock.
Every path that binds or adopts Pending hardware transfers Shot credit before
removing the Pending Machine. Dismissal hides its Shots without deleting them.

The metadata and analytics live in `shots`; curves live in
`shot_measurements.data`, a separate jsonb column with lz4 compression. List
and status queries never read the measurements table. `extractShot` and
`extractCurves` are pure, optional-field projections tested against a scrubbed
real tablet record. See the fixtures' README for provenance. A Shot's batch
and Grinder are kept by their ids on the tablet that pulled it
(`bean_batch_id` and `grinder_id`, from its Workflow's context), indexed, so
an Admin's hard delete of a Library item a Shot names is refused
(`LIBRARY.md`, Hard deletes). A Shot names the Profile it used by its
Workflow's `profile`'s steps, indexed by hash, or by the `profile_id` a skin
recorded in its Workflow, indexed too. It keeps the Basket and Tools DYE2
recorded by their ids on its tablet (`basket_id`, and `tool_ids`, indexed
by GIN), and the Recipe its Workflow named as loaded by its global id
(`recipe_id`), each indexed. It keeps its Grinder's burrs as its Workflow's
context recorded them (`grinder_burrs`, not indexed, and no list filters by
it), for analytics by Library Grinder and burrs: Decaid v0.9.0 copies onto
each Shot it pulls the burrs of the grinder its `grinderId` names
(`PersistenceController.persistShot`), replacing whatever the Workflow held,
null where that grinder records none, and a Shot naming no grinder keeps
the Workflow's. A Shot imported from a backup, the de1app or a Shot file
keeps the burrs it carries. Shots stored before this keep none until they
are stored again. Decaid keeps the previous grinder's burrs when `PUT
/api/v1/shots/{id}` changes a Shot's `grinderId`, as DYE2's Edit Shot page
does (seen on v0.9.0 on 2026-10-16, decentespresso/decaid#1005).

## Links to the Library

Ticket [#92](https://github.com/loganfuller/decent-sync/issues/92) links each
Shot to the Library's Bean Batch, Grinder and Profile it used, and ticket
[#147](https://github.com/loganfuller/decent-sync/issues/147) to the Recipe
its Machine had loaded and the Basket DYE2 recorded
(`server/src/shots/links.ts`):

- **Bean Batch and Grinder.** A Shot keeps the tablet that reported the
  metadata stored (`tablet_id`), whose ids `bean_batch_id` and `grinder_id`
  are. They resolve through that tablet's map (`tablet_bean_batches`,
  `tablet_grinders`, `LIBRARY.md`) to the Library's items, stored as the
  Shot's links (`library_batch_id`, `library_grinder_id`). A Shot stored
  before Shots kept their tablet takes the tablet whose `shotIndex` lists
  it, as only a tablet holding a Shot lists it, and is linked through that
  tablet's map then (`claimListed`, under the tablet's row lock): so once
  each tablet's plugin loads again and scans its Shots. One no tablet holds
  any more, as one deleted there or on a tablet whose Decaid data was
  reset, stays unlinked.
  Links are set as each delivery's metadata is stored,
  and, for a Shot whose ids the map does not hold yet, as the map gains the
  id (`linkShots`, called wherever a map saves a record), so a Shot reported
  before its batch joined the Library is linked once it does. A link stays
  when the tablet's record leaves its map, as when a barista deletes it
  there, while each delivery of the Shot names the same id; a delivery
  naming another id is linked by that one, or unlinked until the map gains
  it. A link refuses its item's hard delete. Every change to a map holds
  the tablet's row lock, and storing a Shot's metadata holds that row for
  share while it resolves, reading the Shot's links under it, so neither
  misses the other on any instance. A Shot whose ids no map holds stays
  unlinked, and is listed as any other.
- **Profile.** A Profile's id is Decaid's, a hash of what the machine
  executes (`ProfileHash` in
  `decaid:lib/src/models/data/profile_hash.dart`), which a Shot's Workflow
  holds as its `profile` but does not name. What a barista overrides in a
  skin as they pull a Shot is their input to it, not another profile:
  streamline-js's side panel writes the yield into the profile it loads as
  its target weight, and the temperature into every step, and its
  `updateWorkflow` sends a step's limiter of value 0, which is no limiter,
  as null, while the profile's record keeps it
  (`streamline-js:src/modules/ui.js`, `src/modules/api.js`). The dose is
  the Workflow's, outside the profile. So a Shot's candidates are the
  Library Profiles with its steps, but for each step's temperature and with
  a limiter of value 0 as none (`profile_steps_key`, in the migration,
  which the indexes on the steps use), and its version, beverage type, tank
  temperature and volume targets, compared as JSON so `92.0` equals 92. Of
  those, the Shot was pulled with the one whose title it recorded, as a
  skin loads a Profile under its own; then the one whose step temperatures
  and target weight, both or either, it holds; then the one whose steps it
  holds as they are, limiters included, as a copy saved of a profile a skin
  loaded keeps its limiters as the skin sent them. Two alike in all of that
  leave it linked to neither. So a Shot pulled with a Profile, its
  temperature and yield changed, is that Profile's, even where the Library
  has a copy saved at that temperature under another title, while a Shot
  pulled with the copy is the copy's. A copy saved under the same title, as
  streamline-js's profile editor saves an edited Profile, ties with it on
  the title, so a Shot overridden to the copy's temperature is the copy's.
  The hard delete's check of whether a Shot names a Profile, and the
  plugin's, compare steps the same way, temperatures left out. The link is
  read, not stored, so it follows the Library: a Profile joining
  that ties with a Shot's own leaves that Shot linked to neither, and a
  Profile's title edited since leaves its earlier Shots naming the old one,
  so once a second Profile matches them their overrides decide between the
  two.
- **Basket.** DYE2 records a Shot's Basket by its id on the tablet: one its
  Edit Shot page set, in the annotations' extras, wherever that page set a
  Basket or its name, or else the Workflow's as the Shot was pulled, in its
  context's extras, as DYE2 reads it (`shotBasketRpm` in
  `dye2:dye2-plugin/src/utils/recorded-shot.ts`). It is linked through the
  reporting tablet's map (`tablet_baskets`) as the batch and Grinder are
  (`library_basket_id`), as the Shot is stored or as the map gains the id,
  and a Shot edited on DYE2's Edit Shot page is linked again by the
  Basket it sets. Shots stored before this keep none of these ids until
  they are stored again; Shots that reach the server later, as from a
  tablet's backfill, link their Basket where the tablet's map has its id.
- **Recipe.** DYE2's dashboard, its Select Recipe page and Streamline's
  DYE strip name the recipe they apply in the Workflow's context
  (`context.extras.dye.recipeId`, the id of DYE2's record of it, ADR-0022),
  which Decaid copies onto each Shot pulled with it. The Recipe a Shot names
  is the one the reporting tablet's map holds under that record id
  (`tablet_recipes`), stored as the Shot is (`recipe_id`) and kept, as the
  Basket's link is, while the Shot names the same id, so a Shot still names
  its Recipe once the map gives that id to another, as after its Machine
  moved. A Shot naming a record id the map does not hold yet, as one pulled
  with a recipe DYE2's `save-recipe` made and named at once, before the
  plugin reported it, is linked once the map gains the id
  (`linkRecipeShots`), through an index on the id its record names among
  Shots linked to none. A Shot is linked to that Recipe where its Machine
  had it loaded as it was pulled, by the Machine's Loaded Recipes
  (`loaded_recipes`, `WORKFLOW-AND-STATE.md`, The Loaded Recipe), not by the
  field alone: a Capture-only Machine's Workflow names a recipe that is not
  its Loaded Recipe, and its Shots stay unlinked, even once sharing is back
  on. A Shot naming no recipe, or a record no Recipe's, is linked to none.
  Pulled means from the Shot's start to its last sample, both by the tablet's
  clock, as the Loaded Recipes are timed; so a Shot started as the Workflow
  came to name the recipe, before the plugin reported it, is still linked.
  A Machine's Loaded Recipes follow one another, so the link reads only its
  latest entry for that Recipe loaded by the Shot's end, through an index on
  the Machine, the Recipe and the time, however long its history. The link
  is read, not stored (`shotRecipeSql`), so it follows the Loaded Recipes as
  their deliveries arrive, those of a tablet that was offline included, and
  the Shot's credit, as an adoption changes it. A Shot whose time is
  unknown, or that only a Pending Machine holds, is linked to none. Storing
  a Shot locks the Recipe it is linked to, so a hard delete racing it finds
  the Shot linked.
- **Tools** are not shown as links: a Shot's page shows the names DYE2
  stored. Their ids (`tool_ids`), from the annotations' extras and the
  Workflow's, as DYE2's Edit Shot page reads them, are resolved through the
  reporting tablet's map as the Basket is, each in its place
  (`library_tool_ids`, empty text for one the map does not hold), and kept
  while the Shot names the same id, only so a Tool a Shot used is not
  hard-deleted once its record has left the tablet, as when it is Archived
  or hidden at its Location.
- **A Basket or Tool the tablet dropped first.** DYE2 can neither archive
  nor hide one, so a Basket or Tool its Location stops offering is removed
  from the tablet's list, and from its map. A Shot naming it that reaches
  the server only after that, as one found only by a later index rather
  than queued as it was pulled, is linked to neither, and keeps neither
  from being hard-deleted; the plugin holds back only a hard delete's
  removal for a Shot it has yet to send. An accepted gap.
- **The skin's profile id is not used.** The profile id the WorkFlow skin
  (`Sabotage1/WorkFlow-Skin`) records in the Workflow
  (`context.extras.workflowSkin.selectedProfileId`, kept as `profile_id`)
  is the Profile picked in that skin. Decaid merges a Workflow's changes
  into it (`deepMergeJson` in `decaid:lib/src/models/data/json_utils.dart`),
  so it stays as it was when another skin loads another profile: the test
  tablet's Shot names the bundled Adaptive v3 there, picked in the WorkFlow
  skin before streamline-js loaded the Londonium it was pulled with. A hard
  delete still counts it, which only refuses more.

Decaid writes a Shot's `timestamp` and sample times in the tablet's local time
without an offset, and `createdAt` in UTC as it saves the Shot, just after the
last sample. `extractCurves` takes the tablet's offset from that gap, rounded
to a quarter hour, so the pulled-at time needs the curves and is set by the
first full record, which also credits the Shot. Later records and edits change
neither, so a Shot's credit and the time its Location is credited by are
written once, with its Machine's row locked. Duration adds up the gaps between
consecutive samples, leaving out the whole quarter hours a daylight-saving
change adds or takes away; a gap where the tablet's clock was otherwise
corrected counts for nothing (`elapsedSeconds`).

A Shot's recording starts while the Machine is still heating its water for
it, which Decaid's shot screen calls Preheat (`_currentStep` in
`decaid:lib/src/realtime_shot_feature/realtime_shot_feature.dart`): its
leading samples whose `machine.state.substate` is `preparingForShot`, which
Decaid maps from the DE1's `heatWaterTank`, `heatWaterHeater` and
`stabilizeMixTemp` (`decaid:lib/src/models/device/impl/de1/de1.utils.dart`).
The Machine runs water through its heater at the heater test's flow then,
not through the puck, with the heater test's targets. Preheat ends at the
first sample with any other substate, or none; a later `preparingForShot`
sample is not Preheat. The duration counts from that first sample, and the
peaks leave Preheat out, while the pull time is still the recording's start.
`preheat` keeps how long Preheat lasted, up to that first sample, and
`duration` keeps the whole recording, Preheat included, as 1.2.0 stores it
and bounds when a Shot was pulled with a Loaded Recipe by
(`shotRecipeSql`); the REST API shows the duration without Preheat
(`shownDuration`). So the two releases agree on `duration` while both run.

Ticket [#467](https://github.com/loganfuller/decent-sync/issues/467) keeps,
beside the Preheat and peaks, what a Shot's samples show of how it went
(`measuredValues` in `server/src/shots/extraction.ts`, over the pure readers
in `protocol/src/record-samples.ts`), so that a list or a Shot Summary reads
it without the Shot's measurements. Each is a nullable column, and their
seconds count from the start of its profile, its first sample after its
Preheat:

- `time_to_first_drip`: when the scale first read 1 g or more
  (`timeToFirstDrip`), by the sample that carries the reading; null where
  none read that, as on a Shot with no scale. No reading in Preheat counts:
  Decaid records 0 for the scale there until it tares it as the profile
  starts, or, in full gateway mode, the untared reading. Decaid sends that
  tare at the profile's first sample without waiting for the scale
  (`ShotSequencer._handleStateTransition` in
  `decaid:lib/src/controllers/shot_sequencer.dart`), so a reading taken
  before it lands, as of a cup put on the scale during Preheat, is recorded
  as it is, and counts as a first drip a fraction of a second in. In full
  gateway mode a cup on the scale reads so throughout.
- `last_step_frame` and `last_step_name`: the step of its Profile it ended
  in, as the Shot's read works it out (`stepSpans`), null when it stopped
  in its Preheat or its samples name no step. The frame is a float, as a
  record may hold any whole number there.
- `poured`: whether any of its samples is in the `pouring` substate
  (`poured`), which Decaid maps from the DE1's `pour`: the Machine reports
  it once its profile is past the steps it counts as preinfusion (the
  profile's `target_volume_count_start`). It is never null once worked out,
  which no other of them promises. It says what the Machine reported, not
  how much coffee landed: a Shot that reaches its yield while its profile is
  still in those steps, as a fast one stopped on weight in a long
  preinfusion step, never reports pouring, though it ran whole; nor would
  any Shot of a profile that counts every one of its steps as preinfusion,
  which none of those bundled with Decaid v0.9.1 does. So an Unfinished
  Shot (`GLOSSARY.md`) is one with none and no `time_to_first_drip`
  either: nothing poured (Shot Summaries, below).
- `last_weight` and `last_weight_seconds`: the scale's last weight after
  its Preheat, with its seconds (`lastRecordedWeight`), and `flow_at_stop`:
  the scale's weight flow at that reading, in g/s (`flowAtStop`), kept for
  the calibration milestone. Decaid records no sample after the stop, so
  both are before it: just before, unless the scale dropped out or went
  stale during the Shot, from when Decaid records no reading
  (`ShotSequencer._scaleFor`), and both are then as much earlier. A fit of
  the stop on weight is to take only the Shots whose last weight is at
  their end, `last_weight_seconds` against the duration they show. The
  weight flow Decaid records is the one it shows:
  the scale's own where it reports one, or else Decaid's average over its
  smoothing window, which lags the weight (`ScaleController` in
  `decaid:lib/src/controllers/scale_controller.dart`). It is not the flow
  Decaid's stop on weight projects with (`controlWeightFlow`), which it
  never records.

`extractCurves` computes them, so they are stored and computed again as the
Preheat and peaks are.

`curves_revision` names the revision of `extractCurves` those values were
computed by (`CURVES_REVISION`): 1 added the Preheat and left it out of the
peaks, and 2 what a Shot's samples show. A full record stores them at the
current one, and an edit leaves them as they are. `CurvesRefresh` computes
those of an earlier revision again from their measurements, in batches of 20
with their rows locked, skipping any another transaction holds, as the server
starts and then hourly, on every instance, so each Shot is computed by one of
them. Raising the revision recomputes every stored Shot that way. Until it
is computed again, a Shot stored at revision 0 shows the whole recording as
its duration. A Shot whose samples' values have never been computed has
none of them: its row gives neither its time to first drip nor the step it
ended in, and its read neither its time to first drip nor its flow at the
stop. `poured` is null for exactly those Shots, so a Shot Summary can count
the Shots awaiting their values by it (#469); the revision says only whether
the values a Shot has are the current one's.

The previous release, 1.8.2, stores a Shot at revision 1 and knows none of
those columns, so the hourly runs take the Shots it stores while it still
serves beside this one during an upgrade. Its own refresh takes only Shots
below revision 1, and its edits write none of them, so it leaves what this
release computed alone. Where it stores a newer full record of a Shot
already computed, it sets the revision back to 1 and leaves those columns
as they were, and the next hourly run computes them again.

## REST API

All endpoints require a signed-in account: Admin, Staff or Viewer.

- `GET /api/shots?limit=20&offset=0` returns `{ shots, total, limit, offset }`.
  Limit is 1–100; offset is nonnegative. Results are newest pulled-at first,
  with id as the deterministic tie-breaker and undated records last, and
  `total` counts the whole filtered list. Rows include analytics and Machine
  or Pending Machine credit, plus `machineInferred`, without metadata or
  measurements. They also carry the Location the Machine was at when the Shot
  was pulled (`locationId`, and `location: { id, name, timeZone }`, null when
  unknown), and `locationInferred`, true when that Location came through an
  inferred Machine. Correcting the Machine's Location History changes these,
  never the stored record. Each row names the Library items it is linked to
  (Links to the Library, above), each null when none: `beanBatch` (`{ id,
  bean: { id, roaster, name }, roastDate }`), `grinder` (`{ id, model }`),
  `profile` (`{ id, title }`), `recipe` (`{ id, name }`) and `basket` (`{
  id, name }`). A Shot that is a Recipe's Reference Shot (ADR-0029, `LIBRARY.md`)
  names those Recipes, Archived or not, by name, in `referenceOf` (`[{ id,
  name, location }]`), given only where there are any, as `GET
  /api/shots/:id` does; `find_shots` rows give them as `{ id, name }`, and
  `get_shot` with their Location's `{ id, name }`. Each also gives what it recorded beyond those columns, read
  from the parts of its record that hold it as the Shot page shows them
  (`recordedDetails`), each null where it recorded none or blank text:
  `grinderModel` and `basketName`, the names its Grinder and Basket recorded,
  `grinderSetting`, `stopReason`, `notes` (whole), `tds` and
  `extractionYield`. And each gives two of the values its samples show, as
  stored (`measuredValues`, above): `timeToFirstDrip`, in seconds, and
  `lastStep` (`{ frame, name }`), the step of its Profile it ended in, each
  null where the Shot has none, and until a Shot stored before they were
  kept is computed again. The MCP endpoint's `find_shots` lists these rows
  compactly: each Library item by the Library's id and name, or a null id
  and the name the Shot recorded, each field with no value left out, the
  names people type, a step's among them, cut beyond about 60 characters
  and notes beyond about 200, which `get_shot` reads whole, with
  `grinderModel` and `basketName`.
- Filters, each given at most once and combined with AND
  (`server/src/shots/filters.ts`; the Machine, Location and date filters are
  `server/src/record-filters.ts`, which Steam Records lists share):
  - `machineId`, `pendingMachineId`, and `locationId`, which is `none` for
    Shots with no Location. A malformed id is a 404, as in a path.
  - `coffeeRoaster` and `coffeeName` (together, a Bean as each Shot recorded
    it, so the same Bean is found across Machines), `barista` and
    `profileTitle`: exact matches on what the Shot recorded, as the Shots
    page's choices pass them. An empty value matches Shots that recorded
    none. `barista` matches the Barista its name names (Shot Summaries,
    Baristas, below), whatever the name's case and the blanks around it: any
    spelling finds the Shots of every spelling, and an empty or blank one
    those that recorded no name or a blank one.
  - `match`: `exact`, the default, or `words`, for those four to match each
    of their words anywhere in what the Shot recorded, in any order and
    ignoring case as the database's collation folds it (`lower()`), as the
    MCP endpoint's `find_library_items` matches names. Each then holds at
    most 20 words, each a search of every Shot's text; one of no words, only
    spaces, matches Shots that recorded none, as an empty one does, and,
    for `barista`, those that recorded a blank name. The MCP
    endpoint's `find_shots` takes `match` too, matching words unless asked
    for `exact`, which picks one value `list_shot_values` gives alone, a
    Barista by any spelling. A
    text filter holding a NUL character, which no Shot recorded, is a 400,
    as is one of more than 500 characters.
  - `beanBatchId` and `grinderId`: Shots linked to that Library Bean Batch
    or Grinder (Links to the Library, above), whichever tablet's id for it
    they recorded, so a batch is compared across Machines and Locations;
    `none` for Shots linked to none. `beanId`: Shots linked to any of that
    Bean's batches. `profileId`: Shots pulled with that Library Profile.
    `recipeId`: Shots pulled with that Recipe loaded on their Machine, or
    `none` for Shots linked to none. `basketId`: Shots linked to that
    Basket, or `none`. Each item's page lists its Shots through these. A
    malformed id is a 404.
  - `from` and `to`: a local date (`2026-10-05`) or date and time
    (`2026-10-05T06:00`) without an offset, read on each Shot's own
    Location's wall clock, or UTC for a Shot with no Location. `from` is the
    first moment listed; `to` the first moment after them, except that a
    date alone includes the whole of that day. So a day is 23 or 25 hours
    across a daylight-saving change, and an hour the clocks repeat is listed
    twice. Shots whose time is unknown match no time filter.
- `GET /api/shots/filters` returns `{ beans, baristas, profiles,
  beanBatches, grinders, recipes, baskets }`: the distinct Beans (`{
  coffeeRoaster, coffeeName }`), Baristas and profile titles listed Shots
  recorded, sorted ignoring case, with null for Shots that recorded none,
  each Barista once, by its most recent spelling (Shot Summaries, Baristas,
  below), and null for a blank name too;
  and the Library's Bean Batches (`{ id, bean: { id, roaster, name },
  roastDate }`, as the Bean Batches list orders them), Grinders (`{ id,
  model, location }`, by model, then Location), Recipes (`{ id, name,
  location }`, by name, then Location) and Baskets (`{ id, name }`, by name)
  listed Shots are linked to, with null last for Shots linked to none. The
  MCP endpoint's `list_shot_values` gives the same lists, each a page at a
  time, `kinds` asking for some alone: each Bean as `{ roaster, name }`, the
  profile titles as `profileTitles`, a roast date as its day, and a
  Location as `{ id, name }`.
- `GET /api/shots/summary` returns the Shot Summary of the Shots the list
  lists for the same filters, each filter as the list takes it (Shot
  Summaries, below): `{ groups, total, limit, offset }`, each group with
  its `by`, `counts` and `numbers`. `groupBy` names what to group them by:
  none, one, or two separated by a comma, such as `groupBy=recipe,machine`;
  another name, a third or one given twice is a 400. `numbers` names the
  numbers each group gives, one or more separated by a comma, such as
  `numbers=ratio,lastStep`, and without it the default three; an empty one,
  another name or one given twice is a 400. `limit`, 1–100 and 20 if not
  given, and `offset` page the groups, and `total` counts them all. The MCP
  endpoint's `summarise_shots` gives the same for `find_shots`' filters, its
  numbers to hundredths, its `groupBy` and `numbers` lists, a Bean Batch's
  roast date as its day, and its page as a tool's list pages: `total`,
  `offset` and `more` before `groups`, at most 50 of them.
- `GET /api/shots/:id` returns `{ shot }`, including the stored Decaid metadata
  in `shot.record`, without measurements, and `shot.previousShot`
  (`{ id, pulledAt }` or null): the listed Shot just before it on the same
  Machine, or held by the same Pending Machine, in list order. It also gives
  what its measurements show (`measuredDetails`), read in one query of their
  own and timed as the Shot page's curves, in seconds from the first sample
  after its Preheat: `steps`, the steps of its Profile it ran, in order
  (`stepSpans`), each `{ frame, name, from, until }` from its first sample to
  the next step's first, the last to the Shot's last sample, a step that
  ended between two samples left out; `lastStep` (`{ frame, name }`), the
  one it ended in, null when it stopped in its Preheat or its samples
  name no step; and `lastRecordedWeight` (`{ weight, seconds }`), the
  scale's last weight sample after its Preheat, null without one: in
  Preheat Decaid records 0 for the scale until it tares it as the profile
  starts, or, in full gateway mode, the untared reading. Decaid records no sample after the stop, so that
  is the weight just before it, while `actualYield` is what Decaid weighed
  once the flow settled. Those three are read from the samples, so a Shot
  has them whatever its curves revision. Beside them it gives two of its
  stored values (`measuredValues`, above), with the list's
  `timeToFirstDrip`: `flowAtStop`, the scale's weight flow at that last
  weight, in g/s. Each is null where the Shot has none, and until a Shot
  stored before they were kept is computed again. No read gives whether a
  Shot poured: a Shot Summary counts Unfinished Shots by it.
  The MCP endpoint's `get_shot` gives all five too, to hundredths, the
  first three from the same read of the measurements as its curves.
- `GET /api/shots/:id/measurements` returns `{ measurements }`, as sent by
  Decaid (null when none were sent).
- `GET /api/machines/:id/set-aside-deliveries?limit=20&offset=0` returns
  `{ deliveries, total, limit, offset }`: the deliveries from that Machine's
  tablet set aside, latest first, each with `receivedAt`, `type`,
  `deliveryId`, `recordId`, `sqlState` and `error`, never its message.
- Machine list and detail responses include
  `lastShot: { id, pulledAt } | null`, by credited hardware rather than the
  tablet that delivered it.

Dismissed Pending Shots are hidden from every read, including filter choices
and previous Shots; adoption restores access. No capture endpoint writes to
the tablet.

`server/test/shot-lists.test.ts` covers the filters, alone and combined,
across Locations in different time zones and both of New York's 2025-2026
daylight-saving changes, and previous Shots.

## Shot Summaries

A Shot Summary (`GLOSSARY.md`) is what a set of Shots have in common, so
that nobody reads rows, or an assistant pages of them, to learn how a
coffee is pulling. Ticket [#466](https://github.com/loganfuller/decent-sync/issues/466)
builds the first of milestone 7's ([#465](https://github.com/loganfuller/decent-sync/issues/465)):
the Shots a filter finds as one group, with three numbers, in
`server/src/shots/summary.ts`, behind `GET /api/shots/summary`
(`ShotsService.summary`), the MCP endpoint's `summarise_shots` and the
Shots list's Summary card. Ticket [#468](https://github.com/loganfuller/decent-sync/issues/468)
groups them, by up to two of what Shots have, in the REST route and the
tool: the Shots list's card stays one group, as the owner chose on
2026-11-10, a set of Shots being summarised there by filtering to it, and
sets shown side by side being the Overview's: ticket [#471](https://github.com/loganfuller/decent-sync/issues/471)
shows each Location's Shots of a period grouped by Recipe and Machine, on
the home page and the Location's page (`web/src/components/overview.tsx`),
from this route alone, a cell opening as the list's filters
(`e2e/overview.spec.ts`, `web/test/overview.test.ts`). Ticket [#469](https://github.com/loganfuller/decent-sync/issues/469)
gives the other numbers, each when asked for, and counts Unfinished Shots
apart. Buckets are a later ticket's.

- **Which Shots.** Those the Shots list lists for the same filters, read by
  the same conditions (`listed`, `shotFilterSql`), less those whose
  Workflow's profile's type, as the Shot recorded it
  (`workflow.profile.beverage_type`), is `cleaning` or `calibrate`, ignoring
  case, as Decaid reads one (`_parseBeverageType` in
  `decaid:lib/src/models/data/profile.dart`). A Shot that recorded no type,
  which Decaid reads as `espresso`, counts, as does any other type. Less,
  too, its Unfinished Shots (`GLOSSARY.md`, `UNFINISHED`), in which nothing
  poured: `poured` is false and `time_to_first_drip` null, so the Machine
  never reported pouring and the scale never read 1 g after the Preheat.
  Both are needed, as a Shot that reaches its yield while its profile is
  still in the steps it counts as preinfusion never reports pouring, though
  it ran whole (`poured`, above), as a fast Shot stopped on weight in a
  long preinfusion step does. A Shot with no scale is unfinished where it
  never reported pouring. The scale's reading is as `time_to_first_drip`
  takes it (above), so a Shot whose cup was put on the scale during its
  Preheat, read before Decaid's tare landed, or any Shot with a cup on the
  scale in full gateway mode, which never tares, counts as poured though
  nothing poured. A
  cleaning or calibration Shot that never poured is counted as cleaning or
  calibration.
  - `counts` gives four counts, read in one statement: `shots`, how many
    the numbers cover; `unfinished`; `cleaningAndCalibration`; and
    `awaitingValues`, how many of `shots` await their stored values
    (`poured` null), as Shots stored at an earlier curves revision do until
    they are computed again (`CurvesRefresh`). Those count as poured, as
    #465 has it, and have no time to first drip or last step meanwhile. The
    first three add up to the list's `total`.
- **Groups.** `groupBy` takes up to two groupings, each by what the list's
  filter of the same name takes, so a group opens as that filter: the Shots
  the list lists for the summary's filters and the group's are the group's,
  and its `counts` add up to that list's `total`. A group by Bean, Profile
  or Barista opens so only with the text filters matched exactly, the
  REST API's default: `match` is one for every text filter, so where the
  summary's text filters match by words, as `summarise_shots`' do by
  default, no filter finds just such a group's Shots. The tool's
  description says to summarise with no text filter, or with
  `match: exact`, to open them.

  | `groupBy` | Groups by | A group's `by` gives | Its filter |
  |---|---|---|---|
  | `location` | The Location the Shot is credited to | `location: { id, name }` | `locationId`, `none` |
  | `machine` | The Machine it is credited to, or the Pending Machine holding it | `machine: { id, name }` with `pendingMachine: null`, or `machine: null` with `pendingMachine: { id, model, serial }` | `machineId`, or `pendingMachineId` |
  | `recipe` | The Recipe it was pulled with (`shotRecipeSql`) | `recipe: { id, name, location }` | `recipeId`, `none` |
  | `bean` | The roaster and name it recorded, together | `bean: { roaster, name }`, either null where it recorded none | `coffeeRoaster` and `coffeeName`, each empty for none |
  | `beanBatch` | The Library's Bean Batch it is linked to | `beanBatch: { id, bean: { id, roaster, name }, roastDate }` | `beanBatchId`, `none` |
  | `profile` | The profile title it recorded | `profile`, the title | `profileTitle`, empty |
  | `grinder` | The Library's Grinder it is linked to | `grinder: { id, model, location }` | `grinderId`, `none` |
  | `basket` | The Library's Basket it is linked to | `basket: { id, name }` | `basketId`, `none` |
  | `barista` | The Barista it names (Baristas, below) | `barista`, the name | `barista`, empty |

  - `by` holds an entry for each grouping, in their order, and is `{}`
    without one. An entry is null for the group of Shots with none of it:
    no Location, no Recipe loaded, linked to no Bean Batch, Grinder or
    Basket, or recording no Bean, title or Barista. No Shot is without a
    Machine or a Pending Machine, so grouped by Machine each group is one
    or the other's. A Recipe and a Grinder are given with the Location they
    belong to (`location: { id, name }`, null for one with none), as the
    list's filters name them, since two Locations may each have a Recipe
    of one name.
  - Grouping by Profile is by the title recorded, as the list's Profile
    filter is: a Shot's Library Profile is matched as it is read
    (`shotProfileSql`), which took 2 s for 10,000 Shots (#465). Two
    Profiles with one title are one group. Only a Barista's names are
    folded: a Bean or a title in another case is another group.
  - A Bean, a title or a Barista's name longer than a text filter takes,
    500 characters, which no tablet's keyboard types, is still a group,
    named whole. Its filter is refused, as it is when chosen among the
    Shots page's choices, which have always offered what Shots recorded
    whole; an assistant finds its Shots by a few of its words.
  - Without a grouping the summary is one group, there even where the
    filters find no Shot. With one, a group is there only for Shots found,
    so filters that find none give no group.
  - **Order.** Groups are ordered by the first grouping, then the second,
    each by name, ignoring case (`lower()`, folded and ordered as the
    database's collation does), then by id, its group of Shots with none
    last: a Location, Machine, Recipe or Basket by its name, a Grinder by
    its model, a Bean by roaster and then name, as the filter's choices
    are, a Bean Batch as the Bean Batches list orders them, by its Bean's
    name, then roaster, then the latest roast date first, and Pending
    Machines after the Machines, by model and serial. Two items of one
    name are in their ids' order, which need not be the order they were
    made in.
  - **Paging.** A page is a number of groups: `limit` and `offset`, with
    `total`, how many groups there are, read in the same statement as the
    page, so the two agree. An `offset` past the last group gives no group
    and the `total`.
- **Baristas.** A Barista is who a Shot's name for one names (`barista`,
  its Workflow's `context.baristaName`): the name without its case or the
  blanks around it, which are spaces, tabs and line ends (`baristaKeySql`
  in `server/src/shots/filters.ts`). So `jules`, `Jules` and ` JULES ` are
  one Barista, one group and one of the filter's choices, and a name of
  blanks alone is none. Case is folded as the database's collation folds
  it (`lower()`). Nothing else is merged, so `Jules V` is another Barista,
  and no table holds Baristas. A Barista is named by its most recent
  spelling among the listed Shots, without the blanks around it
  (`baristaNamesSql`): one name wherever it is given, in a
  summary's groups whatever its filters, in `GET /api/shots/filters` and in
  `list_shot_values`. The `barista` filter finds every spelling by any of
  them, so for the previous release's page, which passes one spelling as
  recorded, it finds more Shots than it did, never fewer (ADR-0025).
- **The numbers,** each of the Shots covered. `numbers` names those a
  summary gives: in the REST route one or more separated by a comma, such
  as `numbers=ratio,rating`, each once, and in the tool a list. Without it a
  summary gives `yieldAgainstTarget`, `duration` and `stoppedOnWeight`, which
  with the count are the Overview's four (#465). A group gives those named,
  in the order below, and only those are read, so a number read from each
  Shot's record costs only a summary that asks for it.
  - `yieldAgainstTarget`: the yield weighed less the target yield
    (`actual_yield`, `target_yield`), in grams, negative under target. A
    Shot whose target is 0 or missing, or that weighed no yield, has no
    value; nor has one whose yield or target is beyond any weight (1e307 g),
    as a record may hold any number, and the difference of two such fits no
    float8, which would fail the statement.
  - `duration`: the recording's duration less its Preheat, in seconds to the
    millisecond, as the list shows it (`shownDuration`); the whole recording
    for a Shot of an earlier curves revision, until it is computed again.
  - `stoppedOnWeight`: `{ shots, share }`, how many Shots recorded a stop
    reason (`stopReason`, with more in it than spaces, tabs and line ends;
    Decaid writes one of its stop reasons' names or nothing), and the part
    of them, from 0 to 1, whose reason is `targetWeight`; `share` is null
    where none recorded one.
  - `ratio`: the yield weighed over the dose weighed (`actual_yield`,
    `actual_dose`), to millionths. A Shot whose dose is 0 or missing, or
    that weighed no yield, has no value; nor has one whose yield is more
    than 1e300 times its dose, as a quotient beyond what a float8 holds
    would fail the statement.
  - `peakPressure` and `peakFlow`: as the Shot keeps them, leaving out its
    Preheat, in bar and ml/s.
  - `rating`: the Shot's enjoyment (`enjoyment`), on Decaid's scale of 0 to
    10, where above 0: DYE2 writes 0 for no stars, so 0 is unrated. It also
    gives `rated`, the part of the group's Shots rated, from 0 to 1, null
    where its numbers cover none.
  - `grindSetting`: the setting its Workflow recorded
    (`workflow.context.grinderSetting`), where its whole text is a decimal
    number, such as `8.8`, `2.00` or `-.5`, with only spaces, tabs and line
    ends around it, or the record holds a number there (`GRIND_SETTING`). A
    text setting, such as `8.8 fine`, `1e3` or `8,8`, has no value, nor has
    a number too large for a float8. It also gives `lowest` and `highest`.
  - `tds` and `extractionYield`: as recorded on the tablet
    (`annotations.drinkTds`, `annotations.drinkEy`), in %, where the record
    holds a number; text there has no value, as the Shot page shows none.
  - `timeToFirstDrip`: as the Shot keeps it (`time_to_first_drip`, above).
  - Each of those but `stoppedOnWeight` is `{ shots, median, p25, p75 }`:
    how many Shots had a value, their median, and the 25th and 75th
    percentiles, between which the middle half of them fall. A percentile
    is interpolated between the two Shots nearest it (PostgreSQL's
    `percentile_cont`), so the median of two Shots is halfway between them.
    The three are null where no Shot had a value. One or two Shots give the
    same; `shots` says how little it rests on. A value of more than 1e307
    in size, which no Shot records, counts as none (`MAX_VALUE`):
    PostgreSQL interpolates a percentile from the difference of two
    values, which for two such fits no float8 and would make it infinite.
  - `lastStep`: `{ shots, mostCommon }`, how many Shots ended in a step of
    their Profile (`last_step_frame`, above), and the steps most of them
    ended in, at most 10 (`LAST_STEPS`), each `{ frame, name, shots }`, most
    first, then by frame and name, so a group stays small whatever its
    Shots' Profiles; `shots` less the steps' says how many ended in others.
    A step is its frame and name together: two Profiles' steps of one frame
    and name are one. It is not called `steps`, which the MCP endpoint's
    budget keeps whole as a Profile's steps (ADR-0028), as its names are
    free text.
- **Worked out when read,** from the Shot's columns and its record, with
  nothing stored for it, so a Shot's edit, such as its rating, shows in the
  next summary. Differences and quotients are taken in decimal, as the
  columns print, so 35.9 less 36 is -0.1 and 36 over 18 is 2. The REST API
  gives each number as worked out; the management interface and the MCP
  endpoint round them.
- **What it costs.** The profile's type and the stop reason are read from
  each Shot's record, which is most of the time a summary takes: each
  number's values are worked out once per Shot in a `MATERIALIZED` query
  before they are put together, as PostgreSQL otherwise reads the record
  again for every place that uses one of them, which took four times as
  long. Measured on a scratch database of copies of a real Shot's record
  (4.4 KB of JSON), on the development machine: 81 ms for 10,000 Shots and
  395 ms for 50,000, where the same statement reading only the columns took
  14 ms; 52 ms for 30 days of them (6,171 Shots) and 3 ms for a day (206).
  Either field becomes a column only if a summary proves slow (#465).
- **What grouping costs.** Little beside that: the Shots are grouped where
  their numbers are put together, and what names a group is joined to the
  groups, never to each Shot. Measured for #468 through the REST route, on
  the development machine, on a scratch database of 50,000 copies of that
  record: four Machines at two Locations pulling 200 Shots a day each, ten
  in a row with one of its Location's eight Recipes loaded, so 5,000
  Loaded Recipes, with 77 profile titles and 12 Baristas, each spelled
  three ways. The medians of seven reads:

  | Summary | 50,000 Shots | 30 days (24,000) | A day (800) |
  |---|---|---|---|
  | One group | 400 ms | 199 ms | |
  | By Machine | 401 ms | | |
  | By Profile | 407 ms | 200 ms | |
  | By Recipe | 477 ms | | |
  | By Recipe and Machine | 485 ms | 226 ms | 11 ms |
  | By Barista | 427 ms | 217 ms | 25 ms |
  | By Barista and Machine | 431 ms | | |

  A Shot's Recipe is resolved through its Machine's Loaded Recipes for each
  Shot naming one, about 80 ms of 50,000. Naming the Baristas reads every
  listed Shot's name, whatever the summary's filters, about 15 ms of
  50,000, which is half of a day's summary by Barista, and of what
  `GET /api/shots/filters` took, 131 ms, where listing every spelling took
  8 ms. Its spellings are put together before they are ordered: ordering
  every Shot's took 40 ms. Naming them from the Shots summarised alone
  would cost a day's summary less, and give a Barista one name in the
  filter's choices and another in a summary of earlier Shots.
- **What the other numbers cost.** Measured for #469 through the REST
  route, on the development machine, on a scratch database of 50,000 copies
  of a real Shot's record (the table 143 MB), as one group, the medians of
  seven reads: 297 ms with the default numbers; 199 ms with the five read
  from columns alone (ratio, peaks, rating and time to first drip); 144 ms
  with the steps they ended in alone; 513 ms with the three read from the
  record (grind setting, TDS and extraction yield), each read about 100 ms
  of 50,000; and 747 ms with every number, and 386 ms for 24,000 of them.
  Grouped, on the same Shots spread over 400 Baristas and seven profile
  titles, a page of 100 groups: 187 ms with the steps alone by Barista, 202
  ms by Barista and profile (2,800 groups), and 791 ms with every number by
  Barista. The steps are counted for every group at once and joined to
  the page's groups by their keys as one value (`jsonb_build_array`), which
  is hashed: joined on each key instead (`IS NOT DISTINCT FROM`, which
  can't be), PostgreSQL read every Shot again for each group on the page,
  and the steps by Barista took 357 ms. No field becomes a column for it
  (#465).
- **Access.** Staff and Viewers read it, as they read Shots, at every
  Location.

`server/test/shot-summary.test.ts` covers it through Seam 1, with Shots
simulated tablets store, against values worked out by hand from the
fixtures: a date across two Locations in different time zones, cleaning and
calibration Shots, a target of 0, Shots with no stop reason, a Shot's edit,
and every filter's counts against the list's total.
`server/test/shot-summary-groups.test.ts` covers the groups the same way:
one and two groupings against values worked out by hand, each grouping's
order and group of Shots with none, a Pending Machine's group, paging, a
Barista's spellings in the grouping, the filter and the filter's choices,
and, for every grouping, each group's filters finding exactly its Shots.
Its Shots are stored through simulated tablets; their links to the Library
and their Machines' Loaded Recipes are set in PostgreSQL, as
`shot-links.test.ts` and `shot-recipe-links.test.ts` cover how tablets make
them. `server/test/assistant-records.test.ts` checks `summarise_shots`
against the route, grouped and not, and
`server/test/assistant-budget.test.ts` its size, with two groupings at its
largest page on realistic and on hostile data.
`server/test/shot-summary-numbers.test.ts` covers the other numbers and
Unfinished Shots the same way: every number against values worked out by
hand, a rating of 0, a dose of 0, grind settings of text, `2.00` and within
spaces, TDS as text, an Unfinished Shot alone and absent from every number,
a Shot that never reported pouring whose scale read a gram counted as
poured, the four counts against the list's total, the steps most Shots
ended in, Shots at the earlier curves revision counted as awaiting and as
poured until another instance computes them again, and a rating edited on
the tablet. The assistant tests check every number against the route,
whole and by group, and within the budget with two groupings, on realistic
data and with step names and grind settings of 3,000 characters.

## Management interface

`/shots` lists Shots with the REST filters in its address, so a filtered
list can be shared or reloaded, the Bean Batch, Grinder, Recipe and Basket
among them. Above its rows, its Summary card
(`web/src/components/shot-summary.tsx`) gives the Shot Summary of the Shots
those filters find: how many its numbers cover, with how many Unfinished
Shots and cleaning and calibration Shots were left out where there are any,
and how many still await their first drip and last step; and the numbers
chosen, by default the duration and the yield against target, each as its
median with the middle half's range, such as "26.0 s (25.6–26.6)" and
"−0.1 g (−0.8 to +0.4)" (`web/src/lib/shot-summary.ts`), and the share that
stopped on weight. Its Numbers menu chooses others, at least one, in the
order the REST API gives them: the ratio, as "1:2.10", peak pressure and
flow, the rating, the grind setting, with its lowest and highest where they
differ, TDS, extraction yield, time to first drip, and the steps most Shots
ended in, each with how many. The choice is kept in the page's address as
`numbers`, apart from the filters, so it survives a reload and a shared
address, and Clear filters leaves it; the default is kept as none, and a
name the page doesn't know, as from a later release, is left out. A
number says how many Shots it rests on where some of those covered had no
value for it, and reads as a dash where none had, as one just chosen does
until it loads. The card follows the filters, loads again every 30 s, and is
not shown while no Shot matches. The last filters' numbers stay while the
next ones' load, as the rows do, but give way to dashes while a load has
failed since the last that succeeded, so that they never stand under a
failure as the next filters'. It is never grouped: the page asks for no
`groupBy`. The Barista filter offers each
Barista once, as the REST API gives them, finds every spelling of the name,
and shows that choice for any spelling an address holds, as one shared
before the choices were folded (`baristaKey` in `web/src/lib/shot-summary.ts`).
It reads a name as the server does but for case beyond A to Z, which the
server folds as its database's collation does, unlike JavaScript for some
letters, such as a final sigma or a dotted I; so for such a name an address
spelled another way shows no choice, never another Barista's.
`e2e/shot-summary.spec.ts` covers both. `/shots/:id` shows a Shot's curves (pressure,
flow, weight, weight flow and group temperature, as Streamline draws them,
with the targets its Machine reported),
from 0 s at the first sample after its Preheat, which is shaded and
labelled before 0 s in every chart and marked in the measurements table,
a dashed vertical line at each change of its Profile's step after Preheat
(each sample's `profileFrame`, as Streamline marks them), the step named in
the tooltip and the measurements table,
the previous Shot it is compared with aligned at 0 s too,
everything its record holds, the Basket's and Tools' names DYE2 stored
and its Grinder's burrs, after the Grinder, among it, the scale's last
weight recorded beside the yield weighed, with its time to first drip and
its flow at the stop as stored, each left out where the Shot has none,
its credit, the Library's Recipe, Bean Batch, Grinder, Basket
and Profile it is linked to, each linking to its page, and a comparison
with its previous Shot. Each Bean's, Bean Batch's, Grinder's, Profile's,
Recipe's and Basket's page lists its Shots, ten at a time
(`web/src/components/item-shots.tsx`).
Times are shown in each Shot's Location's time zone, or UTC, labelled, for a
Shot with no Location. `web/src/lib/curves.ts` turns Decaid's
measurements into curves, counting time as `elapsedSeconds` does.
`e2e/shots.spec.ts` covers them with Shots seeded through simulated tablets,
`e2e/shot-links.spec.ts` a batch's Shots and the Bean Batch and Grinder
filters, and `e2e/shot-recipe-links.spec.ts` a Recipe's and a Basket's
Shots, their filters, and the hard deletes they decide.

`server/test/shot-measured-values.test.ts` covers what a Shot's samples show
through Seam 1, against values worked out by hand from the fixtures: a Shot
with no scale, one whose scale never read 1 g, one stopped in its
preinfusion and one in its Preheat, and an edit leaving them as they are.
`server/test/shot-curves-refresh.test.ts` covers Shots of an earlier
revision computed again, by two instances starting at once, and
`server/test/latest-release/mixed-versions.test.ts` a Shot the previous
release stores. `web/test/curves.test.ts` holds the module tests of the
readers, and `server/test/shot-extraction.test.ts` checks that every
fixture Shot poured.

`server/test/shots.test.ts` verifies the built plugin through Seam 1, REST
reads, and two server instances sharing PostgreSQL. It includes 205-record
history paging, mid-backfill reconnect with no index page sent again, live
capture and edits, Shots stored,
edited or deleted while the server is unreachable, reload recovery,
unacknowledged edits, deletion, late full records, edits that clear fields,
replays, precise version ordering, restart, hardware attribution, dismissal
and adoption, identity mismatch, transient and persistent API failures, ignored
legacy imports, incompatible records and their warnings, and lists while the measurements
table is locked. `server/test/shot-links.test.ts` covers the links to the
Library the same way, at two Locations on two instances, and
`server/test/shot-recipe-links.test.ts` the Recipe and Basket links, a
Shot pulled offline and one on a Capture-only Machine included, and the
hard deletes of Recipes, Baskets and Tools.
