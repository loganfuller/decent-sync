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

Decent Sync supports Decaid v0.9.2 and later. A `shotUpdated` carries the
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
real tablet record. See the fixtures' README for provenance. A Shot's target
yield (`target_yield`) is its Workflow's yield where above 0, or else, for a
Workflow holding no yield, its profile's target weight where above 0. A yield
of 0 is stop-at-weight off, so no target: Decaid stops a Shot at its weight
only for a yield above 0 (`ShotSequencer`), and from v0.1.37 DYE2 applies a
recipe naming no yield with one of 0 (ADR-0022, #550), so a Shot whose
Workflow held 0 has none, whatever its profile's target weight. A Shot stored
before #550 with a target of 0 keeps it. A Shot's batch
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
  `extractionYield`. Each gives `spec`, how it stands against the margins
  (#543; Shot Summaries, Out of spec). And each gives two of the values its samples show, as
  stored (`measuredValues`, above): `timeToFirstDrip`, in seconds, and
  `lastStep` (`{ frame, name }`), the step of its Profile it ended in, each
  null where the Shot has none, and until a Shot stored before they were
  kept is computed again. The MCP endpoint's `find_shots` lists these rows
  compactly: each Library item by the Library's id and name, or a null id
  and the name the Shot recorded, each field with no value left out, the
  names people type, a step's among them, cut beyond about 60 characters
  and notes beyond about 200, which `get_shot` reads whole, with
  `grinderModel` and `basketName`. A row's `spec` holds each part that has
  a value, and `unfinished` and `cleaningOrCalibration` only when true;
  `get_shot` gives it whole.
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
  - `period` (#544), in place of `from` and `to`: `today`, `yesterday`,
    `7days` or `30days`, the seven or thirty days that end with today. The
    days are each Shot's own Location's, counted back from its own today on
    that Location's wall clock as the database's clock has it, or UTC's for
    a Shot with no Location (`PERIODS` in `server/src/record-filters.ts`).
    So a list across Locations in different time zones holds each one's own
    today, which no one date for `from` and `to` names, and an address that
    holds a period reads as that period whenever it is opened. A period
    given beside `from` or `to` is a 400, as is one of any other name. The
    management interface's date presets are these. `find_shots`,
    `summarise_shots` and `find_steam_records` take `period` too, refused
    beside their `from` or `to`, a date or a moment.
  - `rating` (#544): `rated`, Shots rated above 0; `unrated`, the rest,
    those rated 0, as DYE2 writes no stars, or recording no rating; or a
    least number of stars of five, `2`, `3`, `4` or `5`, each two points of
    Decaid's rating from 0 to 10, as a Shot Summary's rating reads one, so
    `4` finds ratings of 8 and over. It reads the Shot's rating as its row
    gives it, so an edit made through the server (below) is followed at
    once. Any other value is a 400. `find_shots` and `summarise_shots` take
    it too (`server/test/ratings-and-periods.test.ts` covers both filters,
    through the REST API and an assistant).
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
  its `by`, `counts` and `numbers`, and, grouped by Recipe, its Recipe's
  Reference Shot as `reference`, where it has one. `groupBy` names what to
  group them by:
  none, one, or two separated by a comma, such as `groupBy=recipe,machine`;
  another name, a third or one given twice is a 400. `numbers` names the
  numbers each group gives, one or more separated by a comma, such as
  `numbers=ratio,lastStep`, and without it the default three; an empty one,
  another name or one given twice is a 400. `bucket`, `day` or `week`,
  gives each group as its `buckets` in place of its `counts` and `numbers`,
  one for each day or week it has Shots of (Shot Summaries, Buckets); any
  other is a 400. `limit`, 1–100 and 20 if not
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
  `GET /api/shots/:id` also gives `edits`, the edits of its rating and note
  made through the server, newest first, the newest 100 of them (A rating and note edited
  through the server, below): each `{ id, fields, account, connectedApp,
  machine, tabletId, madeAt, state, dropped, writtenAt }`. `fields` holds what it set, `rating`, `note` or both;
  `account` is who made it (`{ id, name }`, the name given to an Admin
  only, as other accounts' names are personal information) and
  `connectedApp` the Connected App they made it through (`{ id, name,
  host }`), null for the management interface; for an edit made on a
  Machine's tablet (#515) `account` is null, and `machine` is that Machine
  (`{ id, name }`) and `tabletId` its tablet, each null for an account's
  edit; `madeAt` is PostgreSQL's
  time; `state` says where it stands with the tablet holding the Shot:
  `awaitingTablet` until that tablet answers; `written` once it has
  written it, with `writtenAt`; `dropped` where it was never written, as
  the tablet changed every field it set later than it was made; and
  `noTablet` where the tablet answered that it no longer holds the Shot,
  so the edit stays on the server alone. `dropped` lists the fields of it
  the tablet changed later, `rating`, `note` or both, and is empty for
  most: an edit of both fields of which one was dropped stands as the
  other does (When two edits cross, below). It gives `editStanding` too,
  where those edits stand with that tablet as a whole (`editStanding` in
  `server/src/shots/shot-edits.ts`): `awaitingTablet` while any of them
  awaits it; `noTablet` where the latest of them found that tablet no
  longer holding the Shot, while the Shot still reads as that edit set
  it; null otherwise, as for a Shot never edited through the server. A
  Shot that came back to its tablet, as one restored from a backup, and
  was changed there is stored whole over an edit that had no tablet to
  reach (When two edits cross, below), so it no longer reads as that edit
  set it, unless the tablet holds the same, and `editStanding` is null
  again, though the edit stays listed as `noTablet`. A field of that edit
  the tablet had changed later, before it lost the Shot, is left out of
  the comparison. An edit whose tablet never connects again, as one
  replaced, and so never answers, awaits it for good, and reads
  `awaitingTablet`: ADR-0031
  has such an edit marked as having no tablet to reach, which the server
  can't tell from a tablet that is off. The MCP endpoint's `get_shot`
  gives `editStanding` always, and with `edits: true` the edits, as a
  page (`{ total, offset, more, entries }`) of the newest 100 at most,
  which the response's budget may end sooner (ADR-0028): `total` is how
  many the Shot has, and `more` whether older ones are left out, which no
  offset reaches. Each has its time on the Shot's Location's clock,
  `account`, `connectedApp`, the `rating` or `note` it set, `state` and
  `dropped`.
- `PATCH /api/shots/:id` edits the Shot's rating, its note or both, with
  `{ rating?, note? }`, and returns `{ shot }` as `GET /api/shots/:id`
  then gives it. An Admin edits any Shot the list lists, and Staff those
  at a Location they work at: 403 for any other, a Shot at no Location
  among them, and for a Viewer; 404 for a Shot the list doesn't list; 400
  for a value it doesn't take, a field other than those two, or a body
  with neither (below).
- `GET /api/shots/:id/measurements` returns `{ measurements }`, as sent by
  Decaid (null when none were sent).
- `GET /api/machines/:id/set-aside-deliveries?limit=20&offset=0` returns
  `{ deliveries, total, limit, offset }`: the deliveries from that Machine's
  tablet set aside, latest first, each with `receivedAt`, `type`,
  `deliveryId`, `recordId`, `sqlState` and `error`, never its message.
- Machine list and detail responses include
  `lastShot: { id, pulledAt, recipe, duration, spec } | null`, by credited
  hardware rather than the tablet that delivered it: with the Recipe it was
  pulled with (`{ id, name }`, or null), its duration as the list shows it,
  and its `spec`, how it stands against the margins, as the Shot's own read
  gives it (#543; Shot Summaries, Out of spec), so a status line needs no
  second read.

Dismissed Pending Shots are hidden from every read, including filter choices
and previous Shots; adoption restores access. No capture endpoint writes to
the tablet; an edit of a Shot's rating or note does (below).

`server/test/shot-lists.test.ts` covers the filters, alone and combined,
across Locations in different time zones and both of New York's 2025-2026
daylight-saving changes, and previous Shots.

## A rating and note edited through the server

Ticket [#512](https://github.com/loganfuller/decent-sync/issues/512) makes
the first edit of a Shot that does not come from the tablet holding it
(ADR-0031): a Shot's rating, its note or both, changed through `PATCH
/api/shots/:id`. The server applies it to the Shot it holds at once, keeps
it with who made it, and writes it into the Shot on the tablet that holds
it, now if that tablet is connected and otherwise when it next connects.
Everything else about a Shot still comes only from its tablet. Ticket
[#514](https://github.com/loganfuller/decent-sync/issues/514) edits them
on the Shot's page (Management interface, below) and through the MCP
endpoint's `edit_shot`, and ticket
[#515](https://github.com/loganfuller/decent-sync/issues/515) from another
tablet at the Shot's Location (Edited from a tablet, below). Ticket
[#513](https://github.com/loganfuller/decent-sync/issues/513) settles what
happens when such an edit and a change made on the tablet cross, and when
the tablet no longer holds the Shot (When two edits cross, below).

- **What is edited.** `rating` is a number from 0 to 10, whole or not,
  where 0 is unrated, and `note` is text, where empty is none
  (`isShotRating` and `isShotNote` in `protocol/`). Those are the values
  Decaid's own Shot update takes for `annotations.enjoyment` and
  `annotations.espressoNotes` (`_updateShot` and `_enjoymentRangeError` in
  `decaid:lib/src/services/webserver/shots_handler.dart`, read at v0.9.1
  and v0.9.2, where they are the same), with three differences. Decaid also
  takes null for either, clearing the rating and keeping the note as empty
  text; an edit says those as 0 and empty, so each has one way to be said.
  A note holding a NUL or a surrogate without its pair is refused, as
  PostgreSQL stores neither (`AI_PROTOCOL_NOTES.md`, Deliveries set aside).
  And a note is as long as a request's body may be, 100 KB, where Decaid's
  may be 1 MiB. A request carries either or both, and a field it leaves
  out is left alone. Any other field is refused: a Shot's doses, yield,
  TDS and the rest stay as its tablet recorded them.
- **Who may.** An Admin, for any Shot the Shots list lists; Staff, for a
  Shot credited to a Location they work at, by its Location History, so a
  Shot at no Location, as a Pending Machine's, is an Admin's alone; a
  Viewer never. A Shot the list doesn't list, as a dismissed Pending
  Machine's, is refused as not found.
- **Applied at once** (`ShotEditsService.make` in
  `server/src/shots/shot-edits.service.ts`). In one transaction, holding
  the Shot's advisory lock as storing a delivery of it does, the server
  sets the rating and note in the Shot's stored record as Decaid's update
  leaves them: `annotations.enjoyment`, `annotations.espressoNotes` and
  `shotNotes`, Decaid's older name for the note, which it keeps equal to
  it; and the `enjoyment` column, which lists and Shot Summaries read. The
  record is changed in place (`jsonb_set`), so the rest stays as Decaid
  sent it, its `updatedAt` included, and the Shot's version stays the
  tablet's. So every read, the Shots list and a Shot Summary show the edit
  as soon as the request returns, and each tablet keeping the Shot as a
  Recipe's Reference Shot is sent its copy again (`announceReferenceShots`).
- **The edit is kept** as a row of `shot_edits`: the Shot, by its id with
  no foreign key, as a Recipe names its Reference Shot; the `rating` and
  `note` it set, each null where it left that field alone; the account
  that made it and the Connected App it made it through, if one, each set
  to null if deleted, though a lapsed Connected App an edit names is kept,
  as one a Settings Edit names is (`connected-apps/cleanup.ts`); `number`,
  from its column's sequence, taken as the row is inserted under the
  Shot's lock, so one Shot's edits are numbered in the order they were
  applied, whatever PostgreSQL's clock does; `made_at`, PostgreSQL's
  `clock_timestamp()` at that insert; `written_at`, null while it awaits
  its tablet; and, each null but where it applies, `rating_dropped_at` and
  `note_dropped_at`, when a later change of that field on the tablet
  overtook it, and `unreachable_at`, when its tablet answered that it no
  longer holds the Shot (When two edits cross, below). A Shot's read lists the newest 100 (`MAX_LISTED_EDITS`),
  newest first, by that number: a Shot has a handful, and each may hold a
  note as long as a request. An edit made on a Machine's tablet (#515)
  names that Machine and tablet (`machine_id`, `tablet_id`) and no account,
  as a version of a Library item made on a tablet does; each is set to
  null if its Machine or tablet is deleted.
- **Which tablet.** The tablet that holds a Shot is the one that last
  reported it (`shots.tablet_id`): the one whose report of the Shot's
  newest version the server stored, as a delivery that is no newer than
  what is stored changes nothing of it, or, for a Shot stored before Shots
  kept their tablet, the one whose index lists it. An edit is a write that
  tablet is due, worked out from the database each time, as its other
  writes are (`ShotEditsService.due`). The transaction that makes an edit
  notifies `shot_edits` with the tablet's id, read from the Shot's row as
  it is changed, and every instance wakes its connection from that tablet,
  if it has one (`ShotEditWrites` in `server/src/sync/shot-edit-writes.ts`).
  A connection also looks when it is welcomed, so a tablet that was off is
  written what was made meanwhile, when its instance listens anew, and when
  it reports a Shot or lists its Shots, which may make its tablet the one
  holding a Shot with an edit still to write.
- **A Shot at a time, as where its edits left it.** What a Shot is due is
  one write: the latest rating and the latest note its edits still
  awaiting their tablet set, so three edits made while its tablet was off
  reach it as one, and an edit a later one overtook is never written by
  itself. The server sends it as `shotEdit` (`{ id, shotId, version,
  rating?, note? }`, the id that of the last edit it carries, and the
  version the Shot's `updatedAt` as the server holds it), through the
  connection's `Sender`,
  the Shot whose edit has waited longest first, and the next only once
  the plugin has answered it, with `shotEdited`, and a `written` answer is
  recorded (`ShotEditsService.written`): it marks that edit and those of
  its Shot made before it, while the answering tablet holds the Shot. An
  edit made meanwhile goes in the next write. Only an answer to a write
  the connection sent, and has had no answer to, counts. A write Decaid
  refuses, or the plugin leaves unanswered for 60 s, leaves its edits
  awaiting their tablet, and the connection sends that Shot nothing more
  for a while, rather than ask again at once; the other Shots' go on. It
  is tried again within ten heartbeat intervals, five minutes as they are
  set by default, on one timer for every Shot so held, since Decaid may
  refuse for a moment, as when its API is over its limit
  (`admission_control.dart`), while a tablet may stay connected for days;
  and on the tablet's next connection. The plugin carries out the writes
  it is sent one at a time, in the order they arrive, so one tried again
  while an earlier one is still under way lands after it. A look for what
  is due that fails, as while the database can't be reached, is tried
  again on the same timer. A refusal is logged, with Decaid's answer, and
  kept nowhere else.
- **The plugin** (`plugin/src/shot-edits.ts`) reads the Shot first (`GET
  /api/v1/shots/{id}`), and writes nothing where the tablet no longer
  holds it or holds a later version than the edit was sent for (When two
  edits cross, below). Otherwise it writes the edit through Decaid's
  own Shot update, `PUT /api/v1/shots/{id}` with `{ annotations: {
  enjoyment?, espressoNotes? } }`, holding only the fields the edit
  carries: Decaid merges the body into the Shot it holds, so a rating
  leaves the note alone, and the reverse. It carries them out one at a
  time, and waits out no Shot being pulled, as an edit touches neither the
  Workflow nor a recipe (ADR-0022). It answers on the connection that
  asked, at once, outside its outbox: the answer is no delivery, is never
  acknowledged, and is not sent again. One lost with its connection leaves
  the edit awaiting its tablet, so the server sends it again on the next
  connection, and Decaid's update, given values the Shot already holds,
  changes nothing.
- **Decaid then reports the Shot as updated** (`shotUpdated`, with its
  `updatedAt` moved to now where its content changed), which the plugin
  queues in its outbox and the server stores as any edit made on the
  tablet, the newer version replacing the stored metadata whole, but for
  the rating and note of edits still awaiting the tablet, which stay set
  in it (When two edits cross, below). It holds what the edit set, so it
  changes nothing the edit hadn't already, and it makes no row of
  `shot_edits`: only an edit made through the server does, by an account
  or from another tablet.
- **Only where the tablet is written anything.** Nothing is written to a
  mismatched connection's tablet (ADR-0004), so an edit of a Shot such a
  tablet holds waits until that tablet connects as its Machine. A
  Capture-only Machine's tablet is written its Shots' edits: they are no
  part of the Library. An edit of a Shot no tablet is known to hold, or
  whose tablet never connects again, waits for good, as ADR-0031 accepts;
  one whose tablet connects and no longer holds the Shot is marked so,
  and waits no more.
- **Releases (ADR-0025).** `shotEdit` and `shotEdited` came in wire
  revision 3 (`SHOT_EDITS_WIRE_REVISION`; `AI_PROTOCOL_NOTES.md`, A Shot's
  edits). The server sends an edit only to a plugin at it, so one for a
  tablet on the previous release's plugin awaits that tablet until its
  plugin is at it. The previous release's instance neither listens for
  `shot_edits` nor knows the table, so a tablet it holds during a deploy is
  sent nothing until it connects to an instance of this release, and a
  `shotUpdated` reaching that instance is an ordinary Shot update. The
  migration adds the table only.
- **Verified** through Seam 1 with the built plugin in simulated tablets,
  which carry out Decaid's Shot update as its source has it at v0.9.1 and
  v0.9.2 (`server/test/support/decaid-shots.ts`): that update was read,
  not run on a tablet or recorded from one. `server/test/shot-edits.test.ts`
  covers a rating and a note edited alone and together, the server's reads
  at once, the tablet's own Shot afterwards, the edit marked written and
  the tablet's report making no second edit, edits made at once, edits
  made while the tablet is off, written as one, one Decaid refuses, tried
  again, two instances on one database, who may, and the refusals; and the
  write with raw frames: a Shot's edits sent again until answered as
  written, a refusal holding that Shot back, an answer to an edit not
  sent, an edit made while a write is under way, left for the next, a
  Shot reported by another tablet, whose first tablet's answer no
  longer counts, a Capture-only Machine's tablet, a mismatched connection,
  a Shot no tablet held until an index listed it, a Shot's newest hundred
  edits listed, and a plugin behind the wire revision. `server/test/shot-edit-writes.test.ts`
  runs the connection's writer on a clock the test moves: its order, a
  refusal, its retry, an answer that comes late, a look that fails. The mixed-versions suite
  leaves an edit awaiting a tablet on the previous release's plugin, and
  one the previous release's instance holds.
- **Through an assistant** (#514, ADR-0026). `edit_shot`
  (`server/src/mcp/record-changes.tools.ts`) takes a Shot's id with a
  `rating`, a `note` or both, calls `ShotEditsService.make` as the
  account, through its Connected App, and returns the Shot as `get_shot`
  reads it, without curves. It needs the `change` scope besides `read`,
  is refused wherever the REST route is, with its message, and refuses a
  note holding text a response cut, as every changing tool does. No tool
  is added for the plugin's endpoints, which only a Skin calls.
  `server/test/assistant-shot-edits.test.ts` covers it through Seam 1: a
  rating and a note edited alone and together, listed by the REST API as
  made through the Connected App and written to the tablet; `get_shot`
  saying an edit awaits its tablet, and has none to reach, and listing
  the edits; Staff at and away from the Shot's Location; the refusals;
  a Connected App that may only read and a Viewer's; and a long note
  within the budget. `server/test/assistant-budget.test.ts` reads a
  Shot's hundred edits, each note far longer than any typed.

### Edited from a tablet

Ticket [#515](https://github.com/loganfuller/decent-sync/issues/515) has a
Skin edit a Shot's rating and note from its tablet, whichever tablet holds
the Shot: a PUT to the plugin's `shot` endpoint with a `rating`, a `note`
or both (`editShot` in `plugin/src/skin-api.ts`; `PLUGIN.md`, Editing a
Shot's rating and note). It is one call for any Shot, and two paths.

- **The values** are those the REST route takes (`isShotRating`,
  `isShotNote`), with a note of at most 40,000 characters
  (`MAX_SKIN_NOTE_LENGTH` in `protocol/`), so that the request to the
  server fits one frame however its JSON escapes it. The plugin checks them
  before it asks Decaid or the server, so a request is refused the same
  way whichever tablet holds the Shot, where Decaid alone would take a null
  and a longer note. The answer is the Shot's rating and note as they then
  are (`SkinShotEdited`, read from its record by `shotRatingAndNote`): the
  rating null where it has none, and the note null where it has none or
  only blanks, as a Reference Shot's read gives them.
- **A Shot the tablet holds** is written through Decaid's own Shot update,
  `PUT /api/v1/shots/{id}` with only the fields given in its annotations,
  as the plugin writes an edit the server sends it. The plugin sends that
  update first and reads nothing before it: Decaid answers 200 with the
  Shot where it holds it, and 404 where it doesn't, so whether the tablet
  holds the Shot is decided as it is written. It needs no connection, and
  not that the Machine is served. Decaid reports the Shot as updated, and
  that report reaches the server from the plugin's outbox as any edit made
  on the tablet does: the newer version is stored, no row of `shot_edits`
  is made, and the Shot names no one. A refusal from Decaid, or no answer,
  is told the Skin (`shotUnwritten`), and the server is not asked.
- **Any other Shot** the plugin asks the server to edit, with the request
  `editShot` (`AI_PROTOCOL_NOTES.md`, Requests for a Skin).
  `SkinRequestsService.editShot` makes it through `ShotEditsService`, the
  service the REST route and `edit_shot` use (`makeOnTablet`), so it is
  applied at once, announced to the tablets keeping the Shot as a Recipe's
  Reference Shot, written to the tablet that holds the Shot and decided
  against that tablet's own changes exactly as an account's edit is (When
  two edits cross, below).
- **Which Shots.** A served tablet edits the Shots its list lists
  (`locationLists` in `location-shots.ts`): those credited to the Location
  its Machine is served at. Any other is refused as no such Shot, whether
  or not the server holds it. That is narrower than what the tablet reads
  whole: the Reference Shot of one of its Location's Recipes that was
  pulled at another Location is read, and not edited. A Machine that is
  not served is refused as every request is, with why.
- **A Shot the server believes the asking tablet holds** is edited the
  same way, where that tablet's Decaid answers that it doesn't, as once
  the Shot is deleted there. The server makes the edit, as the asking
  Machine's, and sends it to that same tablet, which answers that it no
  longer holds the Shot: the edit stays on the server, with no tablet to
  reach. A Machine's Shot held by the tablet it had before, since
  replaced, is edited from its new tablet the same way, as that
  Machine's, and awaits the old tablet, for good if it never connects
  again. So an edit made on a tablet is nearly always of another
  Machine's Shot, and not always.
- **Who made it.** The edit's row names the connection's Machine and its
  tablet and no account, which the Shot's read gives as `machine` and
  `tabletId`, `get_shot` as `machine`, and the Shot page's card as the
  Machine's name, linked.
- **Made as the request is handled, or not at all.** In one transaction
  that takes the Shot's lock, then holds the Machine's row if the
  connection still holds the Machine (`lockHeldMachine`), then reads
  whether the Machine is served and where, as a choice of a Reference Shot
  does: a hello taking the Machine, a move and a sharing switch each take
  that row, so the edit is made only by a connection holding a Machine
  served at the Shot's Location as it commits. The Shot's lock comes
  first, as storing a Shot takes them: a Shot's first full record is
  credited under the Shot's lock, taking its Machine's row. Taken the
  other way round, an edit of a Shot credited to the asking Machine could
  wait on that delivery while it waited on the edit.
- **Never queued.** While the plugin isn't connected, or its server is the
  previous release's, the request is refused at once, as unreachable or
  too old to ask, and nothing is kept: no edit is made later. An edit the
  plugin sent and has no answer to, as when its connection closes
  meanwhile, may have been made, as a choice may.
- **At once, behind nothing.** The request waits for nothing the tablet has
  still to report (`FOLLOWS_REPORTS`): it is of a Shot the tablet doesn't
  hold, so none of its reports is of that Shot, and a rating given while a
  tablet catches up after an outage is not refused for the wait. One case
  is left to the rules above: a Shot deleted on the tablet whose last
  report is still in its outbox. The server takes the edit first and the
  report after it, and decides the two as it decides any edit against a
  tablet's version, by their times.
- **Releases (ADR-0025).** The ask came in requests' wire revision, 3,
  before any release had requests, so it has no check of its own. The
  migration adds two nullable columns, with their indexes and keys, to a
  table the previous release neither reads nor writes. A tablet the
  previous release's instance holds during a deploy edits its own Shots as
  before, as that needs no server, and is refused any other as too old to
  ask. The previous release's plugin has no `shot` endpoint, so Decaid
  answers a Skin 404 for it.
- **Verified** through Seam 1 with the built plugin in simulated tablets,
  three at one Location and one at another
  (`server/test/skin-shot-edits.test.ts`): a rating edited on the other
  tablet's Shot, with the server's read at once, a Shot Summary, the
  Location's list and the pulling tablet's own Shot afterwards; the edit
  listed as made on that Machine and tablet with no account, in the REST
  read and through `get_shot`; a note edited leaving the rating alone,
  both, and both cleared; the tablet's own Shot written through Decaid
  with nothing asked of the server and no edit kept; a Reference Shot's
  copy on each tablet following either kind of edit; an edit made while
  the pulling tablet is off, written when it reconnects; an edit asked at
  once while a Shot just pulled is still to be delivered; another
  Location's Shot refused, though the tablet reads it whole as a
  Reference Shot; the requests the plugin refuses itself; Decaid's
  refusal; raw frames from a Capture-only connection and with values no
  plugin sends; and, with the server stopped, the tablet's own Shot
  edited and reaching the server once it is back, and another tablet's
  refused and unchanged then, the edit crossing two instances on one
  database once asked again; and a Shot deleted on the tablet the server
  credits with it, edited from that tablet, kept as its Machine's with no
  tablet to reach. The mixed-versions suite has a tablet the
  previous release's instance holds edit its own Shot and be refused
  another's as too old to ask. Nothing was run on a real tablet.

### When two edits cross

An edit made through the server and a change made on the tablet that holds
the Shot may each be made without seeing the other, as while that tablet is
off. Ticket [#513](https://github.com/loganfuller/decent-sync/issues/513)
decides them (ADR-0031).

- **The rule.** The later edit of a field wins, and nothing is kept of the
  other: no Conflict is made, as the Library makes one (ADR-0020), so a
  Shot never waits on someone to settle it. The rating and the note are
  decided apart: an edit of the rating leaves the note alone, and the
  reverse, so two people editing different fields both keep theirs.
- **Which is later.** An edit made through the server is timed by
  PostgreSQL's clock as it is applied (`shot_edits.made_at`). A change made
  on the tablet is timed by the `updatedAt` Decaid gives the Shot there,
  the version its report carries, as every edit on a tablet is. Decaid
  times a Shot, not a field: a field the tablet changed is timed by the
  Shot's last change of anything, which may be later than the field's own.
  Where the two times are equal the edit made through the server stands.
- **What the tablet holds.** A report carries the Shot's metadata whole, so
  to tell a field the tablet changed from one it only reports again, the
  Shot keeps the rating and note its tablet holds, as far as the server
  knows (`shots.held_rating` and `held_note`: 0 for no rating, empty for no
  note, and both null for a Shot never edited through the server). They
  are set as an edit is made while no other awaits the tablet, to what the
  record held before it, since the two then read the same; as a write is
  answered `written`, to what it carried (`ShotEditsService.written`); and
  as a newer version from a tablet is stored, to what it reports, with
  that version (`held_version_at`; Releases, below).
- **A newer version from the tablet** is decided as it is stored, under the
  Shot's lock (`settleShotEdits` in `server/src/shots/shot-edits.ts`,
  called by `ShotsService.store` for a Shot with held values). For each
  field that an edit still awaiting the tablet sets:
  - it reads as the tablet held it: the tablet didn't change it, so the
    server's edit stands, and is still written;
  - it reads as the latest edit of it set it: the two agree, and the edit
    stands until a write of it is answered, which changes nothing there;
  - it reads as a write the reporting connection sent, and has had no
    answer to, carried it: this is Decaid's report of that write, which
    Decaid raises before it answers the plugin, so it commonly reaches the
    server before the plugin's answer does. It is no change of the
    tablet's, and an edit made since the write was sent stands;
  - otherwise the tablet changed it. Where the version is later than the
    latest awaiting edit of the field, the tablet's value stands, and
    every awaiting edit of that field is dropped. Where that edit is the
    later, it stands, and is still written.

  A field no awaiting edit sets is the tablet's, as before. The record
  stored is the tablet's with the edits that stand set in it, as
  `ShotEditsService.make` set them, so the Shot goes on reading as edited
  until its tablet is written, and never reads as an earlier value while a
  later edit awaits.
- **Never undone.** An edit awaiting a tablet never overwrites a later
  change made on it, whichever of the tablet's report and the server's
  write arrives first. Each `shotEdit` is sent for the version of the Shot
  the server holds, and the plugin, having read the Shot, writes only where
  the tablet's `updatedAt` is no later (`isLaterRecordTime` in `protocol/`,
  which compares to the microsecond). Where it is later, the tablet
  changed the Shot and the server has yet to take that in: the plugin
  writes nothing and answers `changed`. The tablet's report of that
  version is in the plugin's outbox, or, where the plugin was reloaded
  since, comes once its index has the server request the Shot. The server
  sends that Shot nothing more on the connection until the connection
  reports it (`ShotEditWrites.reported`), when the edits have been decided
  against the version reported and what still stands is due for it; had
  the report come in since the look that sent the write began, and before
  the write's answer, the Shot is looked at again at once. A report that never comes leaves the
  Shot to the retry every ten heartbeat intervals.
- **Two edits through the server** of one field are applied in the order
  they are made, under the Shot's lock, so the later is what the Shot
  holds, and one write carries the later to the tablet. Where the first is
  being written as the second is made, the tablet's report of the first
  write leaves the second standing (above), and the second is written
  next.
- **A dropped edit is still listed** on the Shot's read, as `dropped`,
  with the fields the tablet changed later (`rating_dropped_at`,
  `note_dropped_at`). An edit of both fields of which the tablet changed
  one later is dropped for that field alone: the other is still written,
  and the edit reads as that one stands, with the dropped field named.
  An earlier edit of the field that a dropped one had overtaken is dropped
  with it.
- **A tablet that no longer holds the Shot,** as one reset or replaced, or
  one whose barista deleted the Shot, answers `notHeld`: Decaid there
  answers the plugin's read of the Shot, or its update, with 404. The
  server marks every edit of the Shot awaiting that tablet
  (`ShotEditsService.unreachable`, `unreachable_at`), which the Shot's
  read lists as `noTablet`. The edit stays on the server, as the Shot
  reads, and is not sent again, on that connection or the tablet's next. A
  later edit of the Shot is sent once, and marked in turn. Should a tablet
  report the Shot again at a later version, as one restored from a backup,
  that version is stored as any is: no edit awaits it, so nothing of the
  edits is set in it.
- **Two clocks.** "Later" compares a tablet's clock with PostgreSQL's, and
  nothing corrects one for the other. It misleads only for a change on the
  tablet and an edit through the server of the same field of the same
  Shot made closer together than the two clocks are apart. A tablet a
  minute ahead wins against an edit made up to a minute after its change,
  and the edit is dropped. A tablet a minute behind loses a change it made
  up to a minute after the edit, which is then written over it. Edits
  of different fields are decided rightly whatever the clocks say, and so
  are edits further apart than the clocks, but for a field timed by the
  Shot's last change rather than its own (Which is later, above). No
  allowance is built:
  - the Shot's own comparison of versions has none. `ShotsService.store`
    takes a version as newer where its `updatedAt` is later at all, to the
    microsecond, and a tie keeps what is stored. It compares a tablet's
    clock with itself, which this comparison cannot;
  - an allowance would move the misleading window, not shrink it. Counting
    a tablet's change as the later when it was made up to some time before
    the edit would have every tablet whose clock is right win edits it
    should lose, so that one whose clock is slow loses fewer;
  - ADR-0031 accepts that a tablet whose clock is wrong can win or lose an
    edit it shouldn't, as ADR-0003 and ADR-0020 do for the Library, and a
    rating made in two places within the clocks' error of each other is
    rare.

  How far real tablets' clocks run from a server's was not measured.
- **What it does not cover.**
  - Decaid's Shot update takes no condition, so a change made on the
    tablet between the plugin's read of the Shot and its write, a moment
    apart, is not seen, and is overwritten where it is of a field the edit
    sets. An update Decaid makes only where the Shot is still at a
    given `updatedAt` would close it; none is asked for upstream yet.
  - The tablet's report of a write is told from a change of the tablet's
    by what the reporting connection has sent and had no answer to. Where
    the plugin wrote an edit and its answer was lost with the connection,
    the next connection knows of no such write. The report then reads as
    the edit set it, which is as the latest edit set it unless another
    edit of the same field was made since: only then, and where the
    tablet's clock puts the write later than that edit, is that edit
    dropped as if the tablet had changed the field, and the Shot left as
    the earlier edit set it on both sides.
  - A version the tablet holds that the server never stores stays later
    than the server's: an edit of that Shot is answered `changed` each
    time it is tried, and awaits its tablet. So it is for one whose
    delivery is set aside (`AI_PROTOCOL_NOTES.md`, Deliveries set aside),
    and for any later version of that Shot whose report is lost with a
    reload of the plugin, as a Shot with a delivery set aside is not
    requested again.
  - A change made on the tablet in the moment between Decaid making the
    plugin's write and the server taking the plugin's answer reads, in the
    tablet's report, as a change of a field an edit still awaits. The
    tablet's value stands, as it is the later, but the edit is listed as
    dropped though it was written for that moment.
  - A write that goes unanswered for 60 s is sent again under the same
    id, so a late answer to the first is taken as the second's. A refusal
    so taken leaves the edit to the next retry, though the second write
    was made.
- **Releases (ADR-0025).** Additions only: `shotEdit`'s `version` and
  `shotEdited`'s `changed` and `notHeld` are within wire revision 3, which
  no release has, and the migration adds nullable columns to `shot_edits`
  and `shots`, which the previous release neither reads nor writes. The
  previous release's instance stores a version a tablet reports to it
  whole: it decides nothing, and leaves what the tablet holds as it was.
  Where an edit made through an instance of this release awaits that
  tablet during a deploy, the Shot then reads as the tablet reported it,
  and that version may hold a later change of the edit's field. This
  release tells such a version by the version the held values were set at
  (`shots.held_version_at`), which it sets with every version it stores of
  such a Shot, so one that differs from the Shot's was the previous
  release's to store. It decides that version, as it would have on storing
  it (`settleStoredVersion`), before it relies on the record: as an edit
  of the Shot is made, as a newer version is stored, and as a write to its
  tablet is looked for. Until one of those the Shot reads as the tablet
  reported it. Only the last version the previous release stored is
  there to decide against.
- **Verified** through Seam 1 with the built plugin in a simulated tablet
  (`server/test/shot-edit-conflicts.test.ts`): a rating edited through the
  server while the tablet is off and changed on the tablet later, the
  tablet's standing on both sides and the edit marked dropped; the same
  with the tablet changing only the note, the server's rating written and
  the tablet's note standing; the tablet's change made before the server's
  edit, which is written; two edits of the rating through the server, both
  awaiting, the tablet ending with the later; each with the tablet's
  report reaching the server before the server's write reaches the tablet,
  by holding the plugin's reads of the Shot until the report is stored,
  and after it, by holding the Shot's lock until the plugin has answered;
  and a tablet that no longer holds the Shot, its edit kept, marked and
  not sent on its next connection, whether Decaid refuses the read or the
  update. With raw frames: an edit of both fields of which the tablet
  changed one later, and both; the tablet's report of a write under way
  arriving before its answer, and after it, with an edit made meanwhile;
  a rating the tablet changed before the edit, repeated in its next
  report; an answer lost with its connection; and a Shot no longer held,
  with an edit made since the write was sent.
  `server/test/shot-edit-writes.test.ts` covers the connection's writer
  holding a Shot back until it is reported. With raw frames too: a version
  timed at the edit's own time, which leaves the edit standing, and an
  answer of `notHeld` from a tablet no longer the one holding the Shot,
  which marks nothing. The mixed-versions suite has a tablet's change
  stored by the previous release's instance: a later change of the edit's
  field, which is not written over and drops the edit once this release's
  instance holds the tablet; a change of the other field, followed by an
  edit of that field made later and by a second version that instance
  stores, both edits then written; and, with raw frames, a version that
  instance stored decided before a newer one, reported by a tablet that
  is written no edits, so that storing the newer one is what decides it.
  `isLaterRecordTime` is tested in `protocol/`. Decaid's answers were read
  in its source, as for #512, not run on a tablet.

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
its numbers from this route alone, a cell opening as the list's filters
(`e2e/overview.spec.ts`, `web/test/overview.test.ts`). Ticket [#469](https://github.com/loganfuller/decent-sync/issues/469)
gives the other numbers, each when asked for, and counts Unfinished Shots
apart. Ticket [#473](https://github.com/loganfuller/decent-sync/issues/473)
gives a group by Recipe its Recipe's Reference Shot. Ticket [#470](https://github.com/loganfuller/decent-sync/issues/470)
buckets a group's Shots by day or week, in the REST route and the tool, and
charts one number of them as a trend on the Shots list. As the list has no
grouping, its trend is one line, of the Shots its filters find. Ticket [#474](https://github.com/loganfuller/decent-sync/issues/474)
shows a Recipe's Shots grouped by Machine on its page, today's and the
last 30 days' by day, a line for each Machine, from this route alone.
Ticket [#543](https://github.com/loganfuller/decent-sync/issues/543) adds
the number stopped at target, judges each group, each Recipe between its
Machines and each Shot within spec or out of spec against three margins
(Out of spec, below), and redraws the Overview around that judgement.

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
- **Buckets.** `bucket` is `day` or `week`. With it a group gives, in place
  of its `counts` and `numbers`, its `buckets`: one for each day or week it
  has Shots of, oldest first, each `{ start, counts, numbers }`, its
  `start` the day, or the Monday its week starts on, as a date, such as
  `2026-03-02`, and its counts and numbers those of its own Shots, as a
  group's are of the group's. A day or week with no Shot has no bucket, so
  a trend's gaps are the reader's to draw. Without a grouping there is one
  group, whose buckets are empty where the filters find no Shot.
  - **A day and a week** are those of the Shot's Location, on that
    Location's wall clock, or UTC's for a Shot with none, as the date
    filters read a day (`bucketSql`, `recordFilterSql`): the Shots a day's
    bucket holds are those `from` and `to` that day find. So one bucket may
    hold Shots of Locations in different zones, pulled hours apart, and two
    Shots pulled a minute apart at two Locations may be in different days.
    A week starts on Monday (`date_trunc('week', …)`, ISO 8601's), each
    Location's own. A day the clocks change is 23 or 25 hours long.
  - **A Shot whose time is unknown** (`pulledAt` null: it recorded a time
    with no offset and nothing to work one out from) is in no day or week.
    Such Shots are a group's last bucket, its `start` null, so a group's
    buckets' counts still add up to the list's `total` for its filters. No
    date filter finds them.
  - **Paging** is unchanged: a page is a number of groups, and each group on
    it has every one of its buckets, so none is split between two pages.
    `total` counts the groups. The Shots are put together by group and
    bucket at once (`GROUP BY` both), the groups themselves are counted and
    paged apart, and the buckets of the groups on the page are joined to
    them by the group's keys as one value, as the steps are.
  - **A Recipe's Reference Shot** is given once, on the group, before its
    buckets, and in none of them.
  - **Through an assistant,** `summarise_shots` takes `bucket` and gives the
    same. The budget's guard ends a page of groups sooner to fit (ADR-0028),
    never a group's buckets: 30 days by day by Recipe and Machine, about
    380 characters a day at the default numbers, fill a page at 3 groups,
    and with every number, about 960 a day, at one. A single group can't be
    shortened, so one of more than about 115 days at the default numbers, or
    45 with every number, is over the budget: a summary of every Shot by
    day reaches that on any server a few months old. The tool refuses a
    page whose first group alone can't fit (`overBudget` in
    `server/src/mcp/budget.ts`), saying to give `from` and `to` for a
    shorter range, bucket by week or ask for fewer numbers, rather than
    return it whole. The REST route has no such limit.
  - **What it costs.** Little beside the summary itself. Measured through
    the REST route, on the development machine, on a scratch database of
    50,000 copies of a real Shot's record spread over a year on four
    Machines, each with a Recipe loaded, the medians of four reads: as one
    group, 293 ms without a bucket, 308 ms by day (365 buckets) and 305 ms
    by week; by Recipe and Machine, 353 ms without, 404 ms by day and 387 ms
    by week; and with every number, by Recipe and Machine, 812 ms without
    and 900 ms by day. A year by day in five groups is 440,000 characters
    of JSON at the default numbers.
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
  summary gives `yieldAgainstTarget`, `duration`, `stoppedOnWeight` and
  `stoppedAtTarget`: with the count, what the Overview reads (#465, #543).
  `stoppedOnWeight` stays among them for the latest release's pages, which
  read it (ADR-0025), until #559 removes it. A group gives those named,
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
  - `stoppedAtTarget` (`GLOSSARY.md`, Stopped at target): `{ shots, share,
    atTarget, byHand, machineEnded, error, other }`. `shots` is how many
    Shots recorded a stop reason, as `stoppedOnWeight`'s; `atTarget` how
    many of them Decaid stopped at their target, its weight on the scale
    (`targetWeight`) or, with no scale, its volume (`targetVolume`), and
    `share` that part of them, null where none recorded one. The rest are
    counted by how they stopped: `byHand`, the Stop button in Decaid's own
    app or a stop through its API, as a Skin's (`appStop`, `apiStop`);
    `machineEnded`, the Machine ending the Shot itself, as its profile ran
    out; `error`, an error state or a dropped connection (`error`,
    `disconnected`); and `other`, any other reason. The five add up to
    `shots`. The kinds are `STOP_KINDS` in `server/src/shots/spec.ts`, of
    Decaid's `ShotDecisionReason`
    (`decaid:lib/src/models/data/shot_state_event.dart`, the same at v0.9.1
    and v0.9.2).
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
    where its numbers cover none. The REST API and the tool give it on that
    scale, as they are released (ADR-0025) and a Skin and DYE2 read it; the
    management interface shows it in stars, two points each (#532,
    Management interface), and `summarise_shots`' description says a star
    is two points.
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
  - Each of those but `stoppedOnWeight` and `stoppedAtTarget` is `{ shots, median, p25, p75 }`:
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
- **A Recipe's Reference Shot** (#473, ADR-0029; `LIBRARY.md`). Grouped by
  Recipe, alone or with a second grouping, a group whose Recipe has a
  Reference Shot gives `reference`: `{ id, numbers }`, the Shot's id and its
  own value of each number asked for, in their order, to read the group's
  against. A Recipe with none gives no `reference`, nor one whose Reference
  Shot the Shots list doesn't list, its Pending Machine dismissed, nor the
  group of Shots with no Recipe, nor any group of a summary not grouped by
  Recipe.
  - It is the Recipe's, not the group's: with a second grouping each group
    of the Recipe gives the same one, and the summary's filters need not
    find it, so a day's Shots at one Location are read against a Shot
    pulled at another a month before. It is given whatever kind of Shot it
    is, a cleaning or an Unfinished Shot too. It sits on the group, so
    with a `bucket` it is given once, before the group's buckets, and none
    of them holds it.
  - A value is the Shot's own, worked out as each Shot's is for the group's
    numbers (`NumberSql.own`), null where it has none or one too large to
    count: `stoppedOnWeight` and `stoppedAtTarget` are each true or false,
    null where it recorded no stop reason, `lastStep` is `{ frame, name }`,
    and each other a number.
  - It is read in the summary's one statement, for the groups on the page
    alone, each by its id (`reference_shot_id`), so it is of the same
    moment as the numbers beside it.
  - A group's median duration is judged against the Reference Shot's
    (Out of spec, below), which #465 left out of scope and #543 builds. The
    management interface shows it in the Overview: a row's heading gives the
    Reference Shot's duration, and each cell how far its median is from it.
    The Shots list's Summary card, never grouped, shows none.
- **Out of spec** (#543; `GLOSSARY.md`). The server judges Shots against
  three margins, named once in `server/src/shots/spec.ts` (`MARGINS`), the
  same for every Location and Recipe; setting them in the management
  interface, and a marginal level between the two, are #548's.
  - **The margins.** A duration is out of spec more than 10% of the
    Recipe's Reference Shot's duration from it, either way. A yield is out
    of spec more than 5% of the Shot's own target from it, either way. A
    group's stopping is out of spec where under 90% of the Shots that
    recorded what stopped them stopped at target. At a margin exactly,
    10%, 5% or 90%, it is within spec: each is compared in whole
    millionths, or whole Shots, so a float's rounding moves no edge.
  - **A group's judgement.** Each group of a summary with no bucket gives
    `spec`, whichever numbers were asked for: `yield` and
    `stoppedAtTarget`, each `{ judgement, beyondMargin }`, and, grouped by
    Recipe, where the group's Recipe has a Reference Shot with a duration,
    `duration`, `{ judgement, beyondMargin, difference }`, its median
    duration less the Reference Shot's, in seconds. `judgement` is
    `withinSpec`, `outOfSpec` or `notJudged`: a judgement needs at least 3
    Shots with a value, and fewer are not judged. `beyondMargin` says
    whether what they have is beyond the margin, judged or not, null with
    nothing to measure, so the few Shots of a group not judged still say
    which way they lean, which the Overview shows unmarked. A group's
    duration is its median's; its yield the median of each Shot's yield
    less its own target as a share of that target (`yieldShare`, to
    millionths), not the median of `yieldAgainstTarget` over a target, as
    its Shots may have different targets; its stopping
    `stoppedAtTarget`'s share. Each is of the Shots the group's numbers
    cover, so an Unfinished Shot and a cleaning or calibration Shot judge
    nothing. A bucketed summary carries no judgement, in its groups or
    their buckets.
  - **Between Machines.** A summary grouped by Recipe and Machine, in
    either order, gives each group with a Recipe `spec.betweenMachines`:
    `{ judgement, beyondMargin, apart }`, the same on each of the Recipe's
    groups, as its Reference Shot is. `apart` is how far apart its fastest
    and slowest Machines' median durations are, in seconds, and the Recipe
    is out of spec between Machines where that is more than 10% of the
    slower one's. Only Machines with at least 3 Shots with a duration are
    counted, where there are two or more of them, so a Machine with fewer
    is left out of both the number and the judgement; where there are not,
    `apart` is of every Machine that pulled the Recipe, not judged, and
    null where fewer than two did. A Pending Machine's Shots are no
    Machine's. It is worked out from every group of the Recipe the filters
    find (`MACHINE_SPREAD`), in the summary's one statement, not the
    page's alone, so it is the same whichever page a Recipe's groups fall
    on. The group of Shots pulled with no Recipe has none.
  - **One Shot.** A Shot's read, a Shots list's row and a Machine's
    `lastShot` give `spec` (`ShotSpec`; `shotSpecs` in
    `server/src/shots/shot-specs.ts`, which reads each Shot by the
    expressions a summary reads it by, so a Shot and a group of it alone
    are judged alike): `duration`, `{ difference, outOfSpec }`, its
    duration less that of the Reference Shot of the Recipe it was pulled
    with, null where that Recipe has none with a duration or it was pulled
    with no Recipe, so a Recipe's Reference Shot pulled with that Recipe is
    at no difference; `yield`, `{ againstTarget, outOfSpec }`, its yield
    less its own target, in grams, null where its target is 0 or missing or
    it weighed none; `stopped`, how it stopped: `targetWeight`,
    `targetVolume`, `byHand`, `machineEnded`, `error`, or `other`, for
    which `stopReason` gives the reason as recorded, null where it recorded
    none; and `unfinished` and `cleaningOrCalibration`, whether it is an
    Unfinished Shot or a cleaning or calibration Shot, neither of which is
    judged: their `duration` and `yield` are null. One Shot is not subject
    to the 3 a group needs.
  - **What it costs.** A judgement reads each Shot's stop reason from its
    record whichever numbers are named, once where a number reads it too,
    so a summary that names only numbers read from columns now reads the
    record once more for each Shot: about 100 ms of 50,000 Shots, as each
    read from the record was measured for #469 (What the other numbers
    cost, below). The medians a judgement reads are sorted apart from the
    numbers' own quartiles.
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
`server/test/shot-summary-buckets.test.ts` covers the buckets the same way:
day and week buckets against values worked out by hand, at two Locations
in different time zones and a Machine at none, with Shots either side of
each one's midnight between a Sunday and a Monday; each bucket's Shots
against those the date filters find; a Shot whose time is unknown; buckets
under one and two groupings, with pages that never split a group; each
bucket's own steps; and a Recipe's Reference Shot once on its group. The
assistant tests check the tool's buckets against the route's, and a month
by day by Recipe and Machine within the budget, its pages ending sooner
with each group's 30 days whole.
`server/test/shot-spec.test.ts` covers what is out of spec through Seam 1,
with one Shot a simulated tablet stores and copies of its row made in
PostgreSQL, so that each margin's edge is exact: each margin at its edge
and beyond it, fewer than 3 Shots not judged, a Recipe with no Reference
Shot, each stop reason under its kind, between Machines across pages and
with a Machine of fewer than 3 Shots left out, one Shot's judgement in its
read and its row, a Machine's last Shot, and each of those through an
assistant.
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

## On a tablet

A Skin on a tablet lists the Shots at its Machine's Location and reads any
of them whole, through the plugin's `shots` and `shot` endpoints (ticket
[#509](https://github.com/loganfuller/decent-sync/issues/509), ADR-0030;
`PLUGIN.md`, For a Skin's author, has the endpoints, a row's fields and the
refusals). The plugin asks the server with a `request` over its connection
(`AI_PROTOCOL_NOTES.md`, Requests for a Skin), and the server reads the
answer in `server/src/shots/location-shots.ts`. Neither is a REST route or a
tool: only a Skin calls them.

- **Which Shots.** Those the Shots list lists for the Location the
  connection's Machine is at now, as `GET /api/shots?locationId=` does:
  stored with their full record, credited to that Location by Location
  History (`shots.location_id`), whichever Machine pulled them, and not a
  dismissed Pending Machine's (`shotListedSql`). A Pending Machine's Shots
  are at no Location, so none is listed until it is adopted. A Shot credited
  to another Location once its Machine's Location History is corrected
  leaves the list and joins that Location's, wherever its tablet is now.
- **Who is served.** A Machine that takes part in the Library, as its
  status says. Whether it is served, which Location it is at and that
  Location's Shots are read in one snapshot, so a Machine moved meanwhile is
  never answered one Location's Shots as another's.
- **Order and paging.** Newest first by when they were pulled, then by id,
  as the Shots list orders them, a page of up to 50 (`MAX_SHOTS_PAGE`), with
  no filters and no total. A page's `nextCursor` holds its last Shot's pull
  time and id, and the next page starts just past them: a Shot credited to a
  Location has a pull time, which never changes once its full record is
  stored, so paging is by keyset on the index on the Location and
  `pulled_at` (`shots_location_id_pulled_at_id_idx`), one index range
  however many Shots the other Locations hold, and a Shot
  pulled or dropped since the first page neither repeats a row nor skips
  one. The server reads one Shot beyond the page to say whether another
  follows. A cursor it never gave is refused, not read as the first page.
- **A row.** Its columns as the Shots list reads them: the pull time, the
  Machine, the Bean's roaster and name as recorded, the dose and yield
  weighed and aimed for, the duration without its Preheat, the rating
  (`enjoyment`) and the Barista. Whether it has a note is read from its
  record as the Shot page reads the note. Whether it is an Unfinished Shot
  is as a Shot Summary counts one (`UNFINISHED` and not `LEFT_OUT` in
  `summary.ts`): nothing poured, and it is no cleaning or calibration Shot. Whether the
  asking tablet holds it is whether that tablet last reported it
  (`shots.tablet_id`).
- **Its Recipe.** The Recipe it was pulled with (`shotRecipeSql`), whichever
  Location that Recipe belongs to, by id and name, and by the id of the
  asking tablet's record of it (`tablet_recipes.local_id`), null where that
  tablet holds none.
- **The Recipes it is the Reference Shot of** are those of the asking
  tablet's Location that are not Archived, named as its Recipe is. The REST
  read names every Recipe, at any Location and Archived or not; a tablet is
  named only what its Location offers.
- **A Shot whole.** Its record with its `measurements`, as stored, which is
  as Decaid sent them, so a Skin draws it with the code that draws its
  tablet's own; with its Recipe and the Recipes it is the Reference Shot of,
  named as a row names them. The answer is sent in chunks the plugin
  confirms (`AI_PROTOCOL_NOTES.md`, Chunked messages), so a Shot whose
  record passes 1 MiB is read whole.
- **What waits for a slow tablet is bounded.** A request that arrives
  while more than 32 MiB wait to be sent on its connection has no answer,
  as when something on the tablet's network asks for long Shots faster than
  the tablet takes them. Nor is an answer sent that is longer than a plugin
  puts back together, about 16.7 million characters, which would have it drop its
  connection (`AI_PROTOCOL_NOTES.md`, Requests for a Skin).
- **Only its own Location's.** A tablet reads whole only a Shot its list
  would list. Any other, and an id that is no Shot's, is refused as no such
  Shot, without saying whether the server holds it.
- **And the Reference Shots of its Location's Recipes** (#510). A tablet
  reads a Recipe's Reference Shot whole through the plugin's `reference`
  endpoint, a Shot pulled at another Location included, as one may be chosen
  from anywhere (ADR-0029). That widens what a tablet reads by exactly that:
  the same Shot asked for through `shot` is still no such Shot.
  `server/src/shots/location-references.ts` reads it, and the copies each
  tablet keeps (`LIBRARY.md`, A Recipe's Reference Shot).
- **A Shot a tablet may read whole is one it may choose** (#511) as the
  Reference Shot of one of its Location's Recipes: a Shot its list lists,
  or the Reference Shot of one of those Recipes (`readableWhole`;
  `LIBRARY.md`, A tablet may choose a Recipe's Reference Shot).
- **A Shot its list lists is one it may edit** (#515): its rating and its
  note, through a PUT to `shot`, written by Decaid where the tablet holds
  the Shot and by the server where it doesn't (Edited from a tablet,
  above). The Reference Shot of one of its Recipes that another Location
  pulled is not one of them.

`server/test/skin-shots.test.ts` covers them through the built plugin in
simulated tablets, two at one Location and one at another.

## Management interface

`/shots` lists Shots with the REST filters in its address, so a filtered
list can be shared or reloaded, the Bean Batch, Grinder, Recipe and Basket
among them. What narrows it is in one bar above everything else (#544;
`RecordFilterBar` in `web/src/components/record-lists.tsx`, which the Steam
Records list shares):

- **Date presets**, always in view: Today, Yesterday, 7 days and 30 days,
  each the REST API's `period` of that name, so the days are each Shot's
  Location's own and the address holds the preset, not its dates; and
  Custom, which opens the From and To fields, the REST API's `from` and
  `to`. Custom is the one chosen while the address holds either date. None
  is chosen until one is pressed, and pressing the one chosen clears it. A
  preset takes the dates' place, and Custom the preset's.
- **The Filters button**, which says how many of the other filters are set
  and opens them: in a sheet from the bottom of a narrow screen, whose
  button says how many Shots they find and closes it, and in a popover on a
  wide one (from 640 px). Each change is made at once, in the address.
  They are by Location, Machine or Pending Machine, Recipe, Bean, Bean
  Batch, Grinder, Basket, Barista, profile and rating: any rating, rated,
  not rated, 5 stars, or 4, 3 or 2 stars or more, the REST API's `rating`.
- **A chip for each filter that is set**, naming it and what it is set to,
  such as "Recipe: House, Lab", with a button that removes it; on a narrow
  screen a chip shows what it is set to alone. Clear, and the sheet's Clear
  all, remove every chip's filter and leave the dates.

"No reference", on the Overview, and "Its rated Shots" on the Reference
Shot card of a Recipe with none, open the list at that Recipe's rated
Shots (`ratedShotsPath` in `web/src/lib/shot-list.ts`), those a Reference
Shot is chosen from. A cell of the Overview opens the list with its period
as the preset of the same days.

Under the Summary and the Trend, the page's Shots are under a heading for
each day, each Shot's own Location's, by that Location's wall clock, with
today and yesterday named so by its own today, as "Today, Sun Nov 15"
(`dayGroups` in `web/src/lib/shot-list.ts`, with
`web/test/shot-list.test.ts`). The list stays in the order the Shots were
pulled, so where Locations on different dates pulled Shots in turn a
heading comes again rather than a Shot moving out of its place. From 1024
px a Shot is a row of a table:

- when it was pulled, as a time of day, linked to the Shot and named by its
  whole time, with its zone, for a screen reader and on hover; with a
  Reference badge where it is a Recipe's Reference Shot, and an Unfinished
  or a Cleaning or calibration badge where the server says it is one
  (`spec.unfinished`, `spec.cleaningOrCalibration`);
- its Machine, and its Recipe, linked, or "No Recipe", over a muted second
  line of its profile's title, its Bean's name, and, where the list isn't
  filtered to one Location, its Location;
- its grind setting, as recorded, and its dose;
- its yield, with its difference from its own target beside it, and its
  duration, with its difference from its Recipe's Reference Shot's, each as
  the row's `spec` gives it (Shot Summaries, Out of spec): marked, with the
  triangle, where out of spec, and muted otherwise; a Shot whose Recipe has
  no Reference Shot has nothing beside its duration;
- under its duration, how it stopped, in words, only where it was not at
  its target: "stopped by hand", "ended by the Machine", "stopped by an
  error", or the reason recorded (`stopNote`);
- its rating as five stars, filled as far as the rating reaches, so 3.5
  stars draw as three and a half, as the rating filter counts them, with
  the rating as their name; and its Barista.

An Unfinished Shot's row is muted, and carries no mark, as the server
judges none of it. Below 1024 px each Shot is two lines, the whole of it
leading to the Shot, and neither line wraps, so nothing scrolls sideways:
its time and Machine, its badges, and its duration with the duration's
difference; then its grind setting, its yield with its difference, how it
stopped where not at its target, and its Recipe, where the list isn't
filtered to one, with its rating across from them. What a line has no
room for is cut short. `e2e/shots-list.spec.ts` covers the bar, the rows,
and the Summary's and Trend's parts below, at a desktop's width and at 390
px, on the Shots of `e2e/support/judged-shots.ts`, which the Overview's
spec shares.

Above the rows, its Summary card
(`web/src/components/shot-summary.tsx`) gives the Shot Summary of the Shots
those filters find: how many its numbers cover, with how many Unfinished
Shots and cleaning and calibration Shots were left out where there are any,
and how many still await their first drip and last step; and the numbers
chosen, by default the duration and the yield against target, each as its
median with the middle half's range, such as "26.0 s (25.6–26.6)" and
"−0.1 g (−0.8 to +0.4)" (`web/src/lib/shot-summary.ts`), and the share that
stopped at target (#544), with how the rest stopped under it, such as "2 by
hand · 1 ended by the Machine". Stopped on weight, which it took the place
of, is offered no longer, and an address that names it is read as one
naming a number the page doesn't know; the REST API gives it until #559.
What the server judges out of spec is marked, with the triangle (Shot
Summaries, Out of spec): the yield against target and the share stopped at
target themselves, and, where the filters name one Recipe that has a
Reference Shot, the median duration's difference from that Shot's, on a
line under the duration, such as "+3.5 s vs reference", muted where it is
within spec or the Shots are too few to judge. Its Numbers menu chooses others, at least one, in the
order the REST API gives them: the ratio, as "1:2.10", peak pressure and
flow, the rating (in stars), the grind setting, with its lowest and highest
where they differ, TDS, extraction yield, time to first drip, and the steps
most Shots ended in, each with how many. The choice is kept in the page's
address as
`numbers`, apart from the filters, so it survives a reload and a shared
address, and Clear leaves it; the default is kept as none, and a
name the page doesn't know, as from a later release, is left out. A
number says how many Shots it rests on where some of those covered had no
value for it, and reads as a dash where none had, as one just chosen does
until it loads. The card follows the filters, loads again every 30 s, and is
not shown while no Shot matches. The last filters' numbers stay while the
next ones' load, as the rows do, but give way to dashes while a load has
failed since the last that succeeded, so that they never stand under a
failure as the next filters'. It is one group, of the Shots the filters
find: the page asks for no `groupBy` but, where the filters name one
Recipe, `groupBy=recipe`, whose one group is those same Shots, with the
Recipe's Reference Shot and the judgement of their duration against it.
The Barista filter offers each
Barista once, as the REST API gives them, finds every spelling of the name,
and shows that choice for any spelling an address holds, as one shared
before the choices were folded (`baristaKey` in `web/src/lib/shot-summary.ts`).
It reads a name as the server does but for case beyond A to Z, which the
server folds as its database's collation does, unlike JavaScript for some
letters, such as a final sigma or a dotted I; so for such a name an address
spelled another way shows no choice, never another Barista's.
`e2e/shot-summary.spec.ts` covers both. The rating reads in stars (#532),
as a single Shot's does: the summary gives its median and the middle
half's range on Decaid's scale of 0 to 10, and the card halves each
(`ratingMedianText`, with `starsOf` of `web/src/lib/rating.ts`), to at most
two places without trailing zeros, such as "4 stars (3.5–4.5)", "3.75
stars" for a median between two stars, and "1 star". The share rated
beside it is as the summary gives it. The card's info text says a star is
two points of Decaid's rating, and that a rating of 0 is no rating.

Under the Summary card, the Trend card (`web/src/components/shot-trend.tsx`)
starts closed (#544), as a `CollapsibleCard`, and reads nothing until it is
opened. Open, it
charts one number of the same Shots by day or by week, from the summary
asked for by `bucket` with that number alone: its median as a line, each
day or week marked while there are no more than 31 of them, with a band
for the range the middle half of its Shots fall in, on the chart
components the Shot page's curves use. A share, stopped at target, is a
line alone, from 0 to 100%. A rating is charted in stars (#532): its line
and band, on an axis from 0 to 5 marked at each star, its tooltip and its
table, under the title "Rating (stars)". `trendPoints` halves the
summary's median and range, so a point holds stars, and `pointText` reads
them as the Summary card does. Any number the summary gives but the last
step can be charted; duration by day is the default. Whether it is open,
the number and the bucket are kept in the page's address, apart from the
filters: `trend` is the number charted, there only while the card is open,
so an address that names it opens the card, as a Recipe's page's link to a
Machine's Shots does, and hiding the card takes it out; and `bucket` is
`week`, by day being none. So the view survives a reload and a shared
address. The time axis runs on the dates the server gives, so the
days are each Shot's Location's and the browser's time zone plays no part
(`web/src/lib/shot-trend.ts`, with `web/test/shot-trend.test.ts`). A day or
week with no Shots, or none with a value, has no point, and the line runs
past it to the next. Pointing at a day or week gives its value, range and
how many Shots they rest on, and Show the numbers gives them all as a
table. Shots whose time is unknown are on no chart, and a line under it
says how many there are. The card follows the filters and loads again
every 30 s; what was read last stays, faded, until the next arrives. It is
one line, of the Shots the filters find, and the list has no grouping
control, as the owner chose for the Summary card on 2026-11-10. But where
the filters name exactly one Recipe (#544), the trend is read grouped by
it, which brings its Reference Shot: charting duration, that Shot's is a
dashed line across the chart, labelled with it, and named under the chart,
where it leads to that Shot. With no Machine among the filters it is read
by `recipe,machine`, and draws a line and band for each Machine that
pulled the Recipe, the first eight by name, each named beside its colour
under the chart, in its tooltips and in its table, on the chart the Recipe
page's trend uses (#474, below); a Machine's name opens the list at that
Machine, whose one line is still read against the reference. During a deploy the previous release's instance
knows no `bucket` and gives no buckets, of which nothing is drawn.
`e2e/shot-trend.spec.ts` covers it, and `e2e/shots-list.spec.ts` its lines
by Machine and its reference line.

The Overview (`/`, and each Location's page; `web/src/components/overview.tsx`,
#471, #543) is drawn from `GET /api/machines`, read every 5 s, and `GET
/api/shots/summary` grouped by `recipe,machine` for the Location and the
period's days there, read every 30 s, every page of it. No read was added
for it, so no MCP tool is its own: `list_machines` and `summarise_shots`
give an assistant what it shows.
- **A block's heading** gives the Location, linked to its page, on the home
  page, or "Overview" on the Location's page, with the period's choice
  beside it there, and how many Shots the period's numbers cover, with the
  Unfinished Shots beside them (`coveredText` in `web/src/lib/overview.ts`).
- **A status card** for each Machine there now, or that pulled Shots there
  in the period: its name, linked to its page; "Online" with its Machine
  State; or, offline, how (`offlineKind`): marked "Offline" where its last
  Machine State was not asleep, a muted "Offline, asleep" where it was, as
  a Machine left for the night, each with when it was last seen, and a
  muted "Offline" for one no plugin ever connected for. Then its last Shot,
  from the Machine's `lastShot` alone: how long ago, its Recipe and
  duration, linked to the Shot, and a mark for its duration and its yield
  where its `spec` has them out of spec (`lastShotMarks`); its Loaded
  Recipe with its Recipe Slot; that it is capture-only; and where it is now
  if not here. The Location's page has no Machines card: these cards carry
  what it showed.
- **A row** is a Recipe pulled in the period, as before: its Recipe Slot,
  its name, its Reference Shot's duration, linked to that Shot, or "No
  reference", linked to the Recipe's rated Shots in the Shots list (#544),
  to choose one from, and its Bean Batch's days since roast.
- **A cell** gives the count and the median duration, and under them what
  the group's `spec` has it say (`cellLines`): the duration's difference
  from the reference, marked when out of spec and muted when within spec or
  not judged; the yield against target and "N of M stopped at target", each
  only when out of spec, marked, or, for a cell of fewer than 3 Shots,
  when `beyondMargin`, muted; and the Unfinished and the cleaning or
  calibration Shots left out. A last column, Between Machines, gives the
  row's `betweenMachines.apart`, marked when out of spec and muted
  otherwise. Against the previous release during a deploy, which judges
  nothing (ADR-0025), cells give the count, the median and what they leave
  out, and the cards the last Shot's time.
- **On a phone** (390 px) the cards stack and the table is as wide as the
  block with two Machines, its cells without the words its columns and row
  say ("+3.5 s", "0 of 3 at target"), which a screen reader still hears,
  and how far apart the Machines are under the Recipe's name, in place of
  the last column. With three or more Machines the table is wider than the
  block and scrolls within it, the Recipe column staying in place, of one
  width however many Machines there are (`tableWidths`).
- **The shared parts** the milestone's other tickets use: the mark
  (`SpecMark` in `web/src/components/spec-mark.tsx`), which never rests on
  colour alone, having a triangle, semibold text and "Out of spec" for a
  screen reader, its colours (`--spec-mark` on `--spec-mark-ground`,
  `web/src/index.css`) at 6:1 in the light theme and 7:1 in the dark; a
  relative time (`RelativeTime` in `web/src/components/relative-time.tsx`,
  worded by the pure `web/src/lib/relative-time.ts`: "14 min ago", "3 h
  ago", "Yesterday, 4:12 PM", "2 days ago", "Nov 12"), by the wall clock of
  the time zone given, whose exact time is in a tooltip that opens on
  hover, focus and tap (`TapTooltip` in `web/src/components/info-tip.tsx`,
  which the info icons share); and the words for how a Shot stopped
  (`web/src/lib/stops.ts`), which the Shot page's Stopped field reads.
`e2e/overview.spec.ts` covers it at a desktop's width and at 390 px, and
`web/test/overview.test.ts` and `web/test/relative-time.test.ts` its pure
parts.

A Recipe's page (`/library/recipes/:id`) shows how it is pulling, in two
cards under its Reference Shot (`web/src/components/recipe-numbers.tsx`,
#474), both open, each a read of `GET /api/shots/summary` filtered by the
Recipe (`recipeId`), loaded again every 30 s. No read was added for them.
- **Today** asks for the Recipe's Location's day (`from` and `to` the same
  date, by its time zone's wall clock now, or UTC's for a Recipe at no
  Location) grouped by `recipe,machine`, with the default numbers: a row
  for each Machine that pulled it, with its count of Shots, the Unfinished
  and the cleaning or calibration Shots beside it, the median duration and
  yield against target, each with the middle half's range, and the share
  stopped on weight. Grouping by Recipe too brings the Reference Shot's own
  numbers with each group, and its duration and yield against target are
  the table's last row, shown while the summary's reference is the one the
  page's Recipe names, so one cleared on the page goes at once. A Machine's
  name opens its page, and its count the Shots list with the Recipe, the
  Machine and the day as filters.
- **Trend** asks for the 30 days that end with that day, grouped by
  `machine` and bucketed by day, with `numbers` duration, yield against
  target and grind setting at once, so choosing another charts it without
  another read. The number charted is kept in the page's address as
  `trend`, duration as none. It is drawn by the chart the Shots list's
  trend uses (`TrendChart` in `web/src/components/shot-trend.tsx`), given a
  line for each group: each Machine's median as a line with its middle
  half's band, in a color of its own from the data visualization palette's
  eight categorical slots, in the summary's order of Machines, by name,
  the Machines named beside their colors under the chart, in the tooltip of
  a day, a row for each Machine so that eight fit over the chart, and in
  the table Show the numbers opens (`trendRows` in
  `web/src/lib/shot-trend.ts` puts the lines' points into one chart's
  rows). The time axis spans the 30 days whatever days have Shots. A
  Machine's name under the chart opens the Shots list with the Recipe, the
  Machine and the 30 days as filters, and `trend` the number charted, so
  the list's own trend opens charting the same. The read asks for eight groups, as
  many as the chart has colors; a line under the chart says so where more
  Machines pulled the Recipe, as one under Today's table does past the 100
  groups a page holds.
- A day here is the Recipe's Location's, and the Shots of it are those the
  date filters find, each by its own Location's time zone, as a bucket's
  are: a Shot of the Recipe pulled at another Location, which a corrected
  Location History can bring, is counted in that Location's day of the same
  date.
- A Recipe with no Shots in the period says so in each card. A grind
  setting is a number of the summary only where its whole text is a decimal
  number, so a Recipe whose Shots recorded text, such as "1.1.0", has no
  grind trend: the chart says none of the Shots has a grind setting that is
  a number.
- The latest release has no summary route (ADR-0025), so its instance,
  answering during a deploy, gives each card an error, which the next read
  the new release answers clears.

`web/src/lib/recipe-numbers.ts` holds the pure parts (the days, the number
an address names, the Shots list's address for a Machine), with
`web/test/recipe-numbers.test.ts`, and `e2e/recipe-numbers.spec.ts` covers
the cards with a Recipe's Shots stored through simulated tablets on two
Machines over a month. Neither card gives a rating. One charted there
would read in stars, as its chart is the Shots list's (`TrendChart`), and
one added to Today would read through `ratingMedianText` (#532).

`/shots/:id` shows a Shot's curves (pressure,
flow, weight, weight flow and group temperature, as Streamline draws them,
with the targets its Machine reported),
from 0 s at the first sample after its Preheat, which is shaded and
labelled before 0 s in every chart and marked in the measurements table,
a dashed vertical line at each change of its Profile's step after Preheat
(each sample's `profileFrame`, as Streamline marks them), the step named in
the tooltip and the measurements table,
the Shot it is compared with aligned at 0 s too,
everything its record holds, the Basket's and Tools' names DYE2 stored
and its Grinder's burrs, after the Grinder, among it, the scale's last
weight recorded beside the yield weighed, with its time to first drip and
its flow at the stop as stored, each left out where the Shot has none,
its credit, the Library's Recipe, Bean Batch, Grinder, Basket
and Profile it is linked to, each linking to its page, and a comparison
with the Shot chosen under Compare with: nothing, the previous Shot on its
Machine, or its Recipe's Reference Shot (#473), one at a time, its curves
drawn behind the Shot's own and the same table beside them. The Reference
Shot is the one the Recipe's read gives (`GET /api/recipes/:id`), read
with the Shot, and again when the Shot becomes its own Recipe's Reference
Shot or stops being it; it is not offered for a Shot pulled with no
Recipe, a Recipe with none, or the Reference Shot itself
(`e2e/reference-shots.spec.ts`). Its Rating and note card
(`web/src/components/shot-edits.tsx`, #514) shows the two, the rating as
up to five stars, as DYE2 shows it and the owner's Skin will, each star
two points of the rating from 0 to 10 Decaid keeps (`web/src/lib/rating.ts`,
with `web/test/rating.test.ts`: `starsOf` halves a rating as DYE2's
`enjoymentToStars` does, without rounding it to a whole star, and
`ratingOf` doubles whole stars as its `starsToEnjoyment` does), and a
rating of 0 or none as Unrated. To whoever may edit them, an Admin, or
Staff for a Shot at a Location they work at, it has an Edit button that
opens a form in the card: five stars, a shadcn `ToggleGroup` of which one
is pressed at a time, and pressing it again leaves the Shot unrated, and
the note. How to clear them is behind the Rating label's info icon. A
rating between two stars, as an assistant may set, reads as it is, such
as 4.5 stars, and fills the stars DYE2 would, rounded. The form shows it
so too, with no star pressed, until one is: it sends a rating only where
the stars pressed are another rating than the Shot's, so such a rating
saved untouched stays, and pressing the star it rounds to sets that. It sends `PATCH /api/shots/:id` with only what was changed, so
a rating leaves the note alone, and shows the Shot as the answer gives
it. Where
the read's `editStanding` is not null the card says so in plain sight,
Awaiting its tablet or No tablet to reach, with what that means behind
its info icon, and while an edit awaits its tablet the page reads the
Shot again 5 s after each answer, so the note goes once the tablet has
the edit. A
Viewer and Staff elsewhere see the rating, note and that state, and no
button. The Annotations card leaves the two to it. Its Rating and note
edits card, closed until opened, lists the read's `edits`, newest first:
when each was made, on the Shot's Location's clock, who made it, You for
one's own, by name to an Admin and An account to anyone else, with the
Connected App it was made through, or, for one made on a tablet (#515),
the Machine's name, linked to its page, what it set, and where it stands with
the tablet, one dropped for a later change there marked so, with the
field where only one of two was. During a deploy the previous release's
instance gives neither `edits` nor `editStanding`: a page loaded from it
shows no state and an empty card until it is loaded again, a read of a
page already showing them changes nothing, and a save that reaches that
instance, which has no such route, is answered 404, which the form shows
(`e2e/shot-edits.spec.ts` covers the page). The lists and the comparison name the
rating Rating, where they said Enjoyment, and give it in stars too, such
as "4 stars", with none for a Shot rated 0, as its card says Unrated.
The Summary and Trend cards give it in stars too (#532, above). The REST
API and the tools still give ratings from 0 to 10. Each Bean's, Bean Batch's,
Grinder's, Profile's, Recipe's and Basket's page lists its Shots, ten at a time
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
