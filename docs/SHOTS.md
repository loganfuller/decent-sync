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
  on. A Shot naming no recipe, or a record no Recipe's, is linked to none,
  as is one pulled between the plugin's two writes for a change of the
  Loaded Recipe's profile, which carries `recipeId` null (ADR-0022). Pulled
  means from the Shot's start to its last sample, both by the tablet's
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

`curves_revision` names the revision of `extractCurves` the Preheat and
peaks were computed by (`CURVES_REVISION`). A full record stores them at the
current one, and an edit leaves them as they are. `CurvesRefresh` computes
those of an earlier revision again from their measurements, in batches of 20
with their rows locked, skipping any another transaction holds, as the server
starts and then hourly, so it also takes the Shots the previous release
stores while it still serves beside this one during an upgrade. Until then
such a Shot shows the whole recording as its duration. Raising the revision
recomputes every stored Shot the same way. An accepted gap: the previous
release still writes peaks with Preheat in them when it stores a newer full
record of a Shot already computed again, or an edit it read before the
refresh, and those stay until that Shot's next full record here.

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
  id, name }`).
- Filters, each given at most once and combined with AND
  (`server/src/shots/filters.ts`; the Machine, Location and date filters are
  `server/src/record-filters.ts`, which Steam Records lists share):
  - `machineId`, `pendingMachineId`, and `locationId`, which is `none` for
    Shots with no Location. A malformed id is a 404, as in a path.
  - `coffeeRoaster` and `coffeeName` (together, a Bean as each Shot recorded
    it, so the same Bean is found across Machines), `barista` and
    `profileTitle`: exact matches on what the Shot recorded. An empty value
    matches Shots that recorded none.
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
  recorded, sorted ignoring case, with null for Shots that recorded none;
  and the Library's Bean Batches (`{ id, bean: { id, roaster, name },
  roastDate }`, as the Bean Batches list orders them), Grinders (`{ id,
  model, location }`, by model, then Location), Recipes (`{ id, name,
  location }`, by name, then Location) and Baskets (`{ id, name }`, by name)
  listed Shots are linked to, with null last for Shots linked to none.
- `GET /api/shots/:id` returns `{ shot }`, including the stored Decaid metadata
  in `shot.record`, without measurements, and `shot.previousShot`
  (`{ id, pulledAt }` or null): the listed Shot just before it on the same
  Machine, or held by the same Pending Machine, in list order.
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

## Management interface

`/shots` lists Shots with the REST filters in its address, so a filtered
list can be shared or reloaded, the Bean Batch, Grinder, Recipe and Basket
among them; `/shots/:id` shows a Shot's curves (pressure,
flow, weight and group temperature, as Streamline draws them, with the
targets its Machine reported),
from 0 s at the first sample after its Preheat, which is shaded and
labelled before 0 s in every chart and marked in the measurements table,
a dashed vertical line at each change of its Profile's step after Preheat
(each sample's `profileFrame`, as Streamline marks them), the step named in
the tooltip and the measurements table,
the previous Shot it is compared with aligned at 0 s too,
everything its record holds, the Basket's and Tools' names DYE2 stored
and its Grinder's burrs, after the Grinder, among it, its credit, the Library's Recipe, Bean Batch, Grinder, Basket
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
