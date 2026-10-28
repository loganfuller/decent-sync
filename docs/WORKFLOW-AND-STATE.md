# Workflow changes and machine state transitions

Ticket [#13](https://github.com/loganfuller/decent-sync/issues/13) extends
protocol version 1 with two deliveries, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `workflow` | `id` (delivery id), `observedAt`, `workflow` (opaque, as Decaid's `workflowUpdated` event gave it), from #189 `dye2Absent`, while DYE2 is not there to keep the recipe the Workflow names (The Loaded Recipe, below), and from #235 `recipeNamedAt`, when a change held back first named its recipe (Held back, below) |
| Plugin to server | `machineState` | `id`, `observedAt`, `state` and `substate` (Decaid's names, such as `espresso` and `preinfusion`) |

Both are acknowledged with `ack` once stored, or set aside because storing
them fails in a way that would repeat, as Shots are (`AI_PROTOCOL_NOTES.md`,
Deliveries set aside). The protocol version stays 1, as it does for any
change (ADR-0017).

## Plugin

`plugin/src/machine-events.ts` turns Decaid's events into deliveries, through
the plugin's one outbox (`plugin/src/outbox.ts`), which Shots share:

- `workflowUpdated` carries the whole Workflow. Decaid sends it just after
  loading the plugin and on every change (`PluginManager` in
  `decaid:lib/src/plugins/plugin_manager.dart`), so the plugin never reads
  `GET /workflow`. Every one is sent. One whose steam, hot water or flush
  settings differ from the last one's has the machine's own settings read
  again too, as Decaid wrote them to the machine (`COLLECTIONS.md`).
- `stateUpdate` arrives several times a second while a machine is connected.
  Only a change of state or substate from the last one queued is sent.
- On every `welcome`, the latest Workflow is sent again in a new delivery,
  observed then, replacing one an earlier `welcome` queued unless that was
  ever handed to a connection, and the next state update is sent whatever it
  is. One handed to an earlier connection may still be being stored by the
  instance that received it, so it is sent again, under its id, ahead of the
  new one, and the server never stores it after the new one. A reconnect may
  stand for other hardware, after a tablet moved to another machine. A
  delivery still queued from the last connection may already have been
  stored for the last hardware, and its resend then changes nothing, so the
  new hardware gets the Workflow only from this new delivery. The server
  records nothing for either if it is unchanged.
- When the server sends `requestCollections`, as when the Machine's Location
  changes, the latest Workflow is sent again the same way, before the
  collections, so it is taken in at the new Location: its grinder, batch
  and Basket are cleared if the Location does not offer them (`LIBRARY.md`,
  Joining a Location).

`observedAt` is when the plugin observed the event, from its own clock in UTC
(`new Date().toISOString()`), because the outbox may deliver it minutes later.
A state update's own `timestamp` is the tablet's local time without an offset,
like a Shot's sample times, so it is not used; the validator refuses a time
without its `Z`. Deliveries go in order, one awaiting acknowledgment at a
time, and what a connection left unacknowledged is sent again first on the
next, with the same delivery ids, ahead of the Workflow sent on `welcome`, so
a reconnect never replaces changes made while disconnected. A reload sends the
current Workflow, and the next state update, again.

### Kept across unloads

Ticket [#93](https://github.com/loganfuller/decent-sync/issues/93) makes
these deliveries survive an unload. The outbox keeps each Workflow and
machine state delivery in Decaid's plugin storage until the server
acknowledges it (`plugin/src/kept-deliveries.ts`, through the commands of
`plugin/src/storage.ts`, which the tablet's id shares):

- **Written before it is sent.** A delivery is written to plugin storage, and
  the record of what is kept after it, and is sent only once Decaid has
  answered both, in whichever order they land: a write still waiting its
  turn takes the data of a later write to the same key, so the queue of
  writes stays bounded however slow Decaid is. One acknowledged, or replaced
  as the Workflow sent on the last `welcome` is, is removed from what is
  kept, its key overwritten by its sequence number alone. Decaid answers each
  command with an event, one at a time; a write it leaves unanswered for
  10 s counts as failed, is logged, and the delivery is sent anyway, perhaps
  kept only in memory. From then on, until Decaid answers anything again,
  writes are sent without waiting for answers, so a Decaid failing every
  write holds up no delivery and logs once. As the plugin unloads, it sends
  the writes still waiting their turn without waiting for answers, the one
  awaiting an answer again first, as Decaid finishes a retiring generation's
  writes but drops one it received just before if it handles the unload
  first; so an acknowledgment that arrives just before an unload is recorded
  and its delivery not sent again.
- **Sent first after a reload.** As it loads, before it sends anything, the
  plugin reads back what earlier loads kept and queues it, oldest first,
  ahead of everything queued since, such as the Workflow Decaid sends after
  loading it. Each goes with its original delivery id and `observedAt`, so the
  server's handling of each delivery once still applies (below), as for a
  reconnect. Reading them back stops at any read Decaid fails or leaves
  unanswered, never taking it for nothing kept, logs it, and starts again
  after 5 s, doubling to at most 5 minutes, until it succeeds. Nothing is
  sent meanwhile, Shots and collections included, so nothing kept is ever
  sent after a newer delivery. This rests on Decaid's reads failing all
  together: it reads the plugin's storage from memory, so a read fails only
  when its store does, or when it does not answer in 10 s, and a Decaid that
  cannot read the plugin's storage as the plugin loads cannot read the
  tablet's id either, without which the plugin does not connect. Workflow
  and machine state deliveries queued meanwhile, for the time 2,001 reads at
  most take, or longer while Decaid fails them, are held to the limits
  below, and kept once the reading back ends: an unload before then loses
  them. Nothing kept sends nothing extra.
- **Under the token they were made with.** Deliveries belong to the token's
  Machine, and the server records each delivery id per Machine, so the key
  `outbox` also holds a 32-bit hash of the token, never the token. A load
  with another token, as after a barista enters another Machine's token,
  which reloads the plugin, sends none of what was kept, logs it, and
  overwrites it.
- **Bounded.** Decaid stores no null, so `host.storage` deletes no key, and
  it keeps a plugin's whole storage in memory. So deliveries are kept in a
  ring of 2,000 keys, `outbox.0` to `outbox.1999`, reused in turn, each
  holding one delivery with its sequence number, and the key `outbox` holds
  the range of sequence numbers kept; a key whose delivery is acknowledged or
  dropped holds only its sequence number. At most 2,000 deliveries are kept, about
  a busy day of a Machine's state transitions, and at most 2 Mi characters of
  their JSON (`MAX_KEPT` and `MAX_KEPT_CHARACTERS`), which a few hundred
  Workflows reach first. Keeping one more past either drops the oldest, from
  memory too, unless it has been sent; the plugin logs that it is dropping
  some once per connection. The server's history then has a gap before the
  oldest it receives, and the Workflow and state sent on the next `welcome`
  still bring the current ones. In memory too, the outbox holds no more of
  them than it keeps, but for one sent and awaiting its acknowledgment, and
  while it reads back what was kept, those read back as well as those held
  meanwhile. It holds new Shots and Steam Records by their ids until it sends
  them (`SHOTS.md`, `STEAM_RECORDS.md`); only Shot edits, one per edit, are
  held whole, as before.
- **Not kept.** Shots, Steam Records, their indices and collections keep
  milestone 1's recovery: every load scans and indexes the tablet's records,
  the server requests what it lacks, and every `welcome` sends each
  collection. The answers to the server's Library writes are not kept either
  (`LIBRARY.md`, How the plugin writes).

Resetting the tablet's Decaid data loses what is kept, as it loses the
tablet's id. A Decaid backup holds it as it holds the id, and restoring one
sends again what was kept when it was taken: the server changes nothing for a
delivery whose id it still has (below).

## Server

`server/src/machine-events/machine-events.service.ts` appends each delivery to
`workflow_events` or `machine_state_events`, handling each delivery once.

First it locks whoever the event belongs to (below), then records the
delivery's id in `machine_event_deliveries`, keyed by the token's Machine,
whether or not the delivery turns out to change anything
(`creditFirstDelivery` in `server/src/machines/credit.ts`). A delivery whose
id is already recorded is acknowledged and changes nothing: the plugin keeps a
delivery's id when it sends it again, and always through the same token, so a
resend changes nothing, through any connection or instance, even after other
changes, and even when the first delivery changed nothing either. A resend
arriving while the first is still being stored waits for it, at that lock or
on the record's key.

The lock comes first because the record references the token's Machine, and
whatever writes a row referencing a Machine locks first (`lockMachine` in
`server/src/machines/machines.service.ts`). Recorded first, the record's
foreign-key check held the Machine's row against an update of its model and
serial while the delivery waited for the row lock, so a hello or an Admin
binding the Machine's hardware under that lock deadlocked with it.

Each id is kept for 90 days from when it was recorded, by PostgreSQL's clock
(`DELIVERY_ID_RETENTION_DAYS` in `server/src/machines/delivery-id-cleanup.ts`).
Every server instance deletes older ones as it starts and then hourly, at
most 1,000 in each statement, oldest first. Each statement runs on its own,
outside any delivery's transaction, and skips rows another transaction has
locked, so it waits for no delivery, and instances running it at once delete
different rows. A failed run is logged and the next tries again. The index on
`received_at` finds the rows to delete.

Deleting them is safe because a resend comes from the plugin on its next
welcomed connection, or from its next load, which reads back the deliveries
kept in plugin storage (above), far sooner than 90 days unless the plugin
stays unloaded, or the server unreachable, that long, or an old Decaid backup
is restored. A resend that comes later anyway is handled as a new delivery.
Only one delivery awaits acknowledgment at a time, so only that one can have
been stored without the plugin knowing, and it is sent again ahead of
anything newer. It is stored only if it differs from the latest event, so at
worst it puts one stale event after a newer one another tablet's mismatched
session stored for the same Machine.

An event belongs to the session's token's Machine, or for a mismatched
session, to its reported hardware: the Machine that has it, or else its
Pending Machine (ADR-0015), as an inferred Shot or a Steam Record is
(`creditReporter` in `server/src/machines/credit.ts`). Whoever is chosen is
locked: the Machine's row, or the hardware's advisory lock for a Pending
Machine. Under that lock, one statement inserts the event unless the latest
event stored for the same Machine or Pending Machine (the highest `id`) has
the same Workflow (jsonb equality) or state and substate. That makes the
history transitions only, judged by what is stored rather than what any
instance or connection remembers, so it holds across reconnects, instances and
restarts. A mismatched session's events are judged against the latest of
whoever has its hardware, so a tablet moved onto another Machine's hardware
adds only what changes that Machine's own. Creating a machine entry for a
Pending Machine's hardware, binding it at `hello` or entering it by hand hands
its events over with its Shots and Steam Records (`transferPendingRecords`).

A Workflow from a connection that is not mismatched, for its token's
Machine, is also taken in at its Location in the same transaction
(`takeInWorkflow` in `server/src/library/joining.ts`): as its tablet joins
the Location, its grinder, batch and Basket are cleared where the Location
does not offer them (`LIBRARY.md`, Joining a Location), and its Loaded
Recipe is taken in (The Loaded Recipe, below). A change of the Workflow of a
Machine with a Recipe loaded is saved into that Recipe, by DYE2 as the
plugin asks it to and by the server for what DYE2 saves none of (Following
the Recipe, below), and a Machine with none keeps its own steam, hot water
and flush settings (`LIBRARY.md`, Steam, hot water and flush settings).
While the plugin writes into the
Workflow, it holds back the `workflowUpdated` its write causes until the
write's answer is queued, then sends the latest Workflow, so the server
reads its own write as the answer rather than as the tablet's edit.

The current Workflow and machine state are the latest events stored, which
for one tablet are also the latest observed. `observed_at` keeps the tablet's
time, which may be wrong or jump; `received_at` is PostgreSQL's.

Known limits: a state update that arrives on a connection whose `hello`
reported no machine belongs to the token's Machine, as everything on that
connection does, until the plugin reconnects with the hardware the machine
then reports (ADR-0015). While the server is unreachable for long, the plugin
keeps only the newest 2,000 events, up to 2 Mi characters (above).

## The Loaded Recipe

Ticket [#145](https://github.com/loganfuller/decent-sync/issues/145) keeps
each Machine's Loaded Recipe (ADR-0022), and ticket
[#216](https://github.com/loganfuller/decent-sync/issues/216) makes it the
recipe its Workflow names. DYE2 v0.1.26 and streamline-js `main` at
`cec5664`, the supported floor (ADR-0017), keep no selection of their own:
DYE2's dashboard, its Select Recipe page and Streamline's DYE strip set
`context.extras.dye.recipeId` in the Workflow to the id of DYE2's record of
the recipe they apply (`DYE2_RECIPE_FIELD` and `dye2RecipeIdOf` in
`protocol/`; `recipeIdPatch` in `streamline-js:src/modules/dye-selection.js`,
decentespresso/dye2#36), and DYE2 clears it once the Workflow's profile
moves off the one it held when that id appeared (`workflowChanged` in
`dye2:dye2-plugin/src/plugin.ts`). So a recipe applied while the tablet is
offline is named too, and Decaid copies the field onto every Shot pulled
with it. The server reads the Loaded Recipe from it in the Workflow
deliveries; the plugin writes into the Workflow what loading a Recipe needs,
clears the field to unload one, and has DYE2 save each change of the
Workflow into it.

### Plugin

`plugin/src/loaded-recipes.ts` follows the recipe the Workflow names,
through `plugin/src/dye2.ts`, and writes what the pure
`plugin/src/loaded-recipe-rules.ts` works out:

- **What it decides.** On each change of the Workflow Decaid reports
  (`observe`), and on each read of DYE2's recipes, whoever made it
  (`sawRecipes`), the plugin decides on the latest Workflow once it has
  read the recipes (`decide`): the record its field names, where it carries
  a Recipe's global id (`loadable`, in a Recipe Slot or not), is the Loaded
  Recipe, and none otherwise. One it has not loaded yet loads it (A load,
  below), as does a record the Workflow named before it carried its global
  id, as one DYE2's `save-recipe` made and named at once, once the server's
  write gives it one. The Recipe the first Workflow names after the plugin
  loads is taken as loaded already, and nothing is written for it. A change
  naming the Recipe it has loaded is saved into it (Saving each change,
  below). A Workflow naming nothing, or a record no Recipe's, unloads it in
  the plugin, which writes nothing for that. Dialling in a Recipe's values
  by hand loads nothing.
- **Its own writes.** Each write of the plugin's into the Workflow, a
  load's, the server's and the clears below, runs as one (`ownWrite`): the
  Workflow's changes are held back meanwhile (Held back, below), and a
  change Decaid reports during it is its echo, neither a load nor saved. A
  change reported meanwhile that leaves the Workflow holding other than the
  write's answer is another's, as a barista's, and decided on once the write
  is done.
- **A load.** In its turn among the reads and writes of the tablet's lists
  (`LibraryAccess.run`), the plugin reads the Workflow, and where it still
  names the record, writes into it, in one `PUT /workflow`, which Decaid
  merges into it, what it holds otherwise of the recipe's current dose,
  yield (its dose times its ratio where it holds none), grind setting,
  grinder, RPM, Basket and Profile (whole, at the recipe's brew temperature,
  from its embedded Workflow, else its `profileSnapshot` or the tablet's
  record of its `profileId`, only where its `profileKey` differs), its Bean
  Batch (`beanBatchId`) with its Bean's name and roaster (`beanName`,
  `beanRoaster`) as `coffeeName` and `coffeeRoaster`, and each steam, hot
  water and flush setting the record holds in DYE2's field of it
  (`RECIPE_SETTINGS`), as DYE2's dashboard applies them and Streamline's
  strip does only in part (decentespresso/streamline-js#154, interim,
  ADR-0022), but a steam temperature into a Workflow whose steam is off
  (`steamOff`), which would turn steam on (`loadWrite`). A value the record
  holds none of is left as the Machine has it, which the server takes into
  the Recipe (Following the Recipe, below). It writes no brew temperature:
  DYE2's dashboard applies a recipe's, moving its profile as Streamline's
  Brew tile does (`shiftedTemperatures` in
  `streamline-js:src/modules/brew-temp.js`), the first step to it and every
  other by the same amount, and Streamline's strip applies the record's
  embedded Workflow, which holds its profile so moved
  (decentespresso/dye2#26). Both apply its batch too
  (decentespresso/dye2#27), so the load write writes it only over a stale
  copy, and a stale copy's brew temperature is written by the server's
  Loaded Recipe write after the load (To every Machine that has it loaded,
  below). Decaid refuses to change the steam, hot water and flush settings
  while no machine is connected (`MACHINE_SETTING_PARTS`), so the rest is
  then written without them. A Machine that applied an out-of-date copy of
  the Recipe ends with its current values through the load and that Loaded
  Recipe write, which are worked out from which Recipe is loaded, never by
  matching values. Streamline adopts a Workflow change made elsewhere
  (ADR-0021), so it takes the settings written as its own, but for the
  steam temperature it turns steam back on at: with each load whose record
  holds a steam temperature of 135 °C or more, written or left out for steam
  off, the plugin sets Streamline's `last-steam-temp` to it where that key
  holds a number (`keepStreamlineSteamTemperature`, interim until
  decentespresso/streamline-js#156). Once Decaid takes a load's write, where
  it changed the Workflow, the plugin pushes `{"what":"workflow"}` on its
  `changed` endpoint, so Streamline's tiles show the steam, hot water and
  flush settings its strip left out at once rather than at its 20 s poll
  (ticket #207, `AI_RUNTIME_NOTES.md`, Skins).
- **A write that changes the profile.** DYE2 clears the Workflow's
  `recipeId` once its profile moves off the one it held when the id
  appeared, by DYE2's fingerprint (`dye2Fingerprint` in `protocol/`, a copy
  of `profileFingerprint` in `dye2:dye2-plugin/src/utils/workflow-record.ts`:
  the title, tank temperature and steps, but each step's temperature, a step
  limiter of value 0 read as none), even where the same write names the same
  id (`idProfileChanged`). So a write of the plugin's that changes the
  profile so (`changesProfile`), as a load from a stale copy, or the
  server's write after the Recipe's Profile was edited, is made as two `PUT
  /workflow` (`putNamingRecipe`): `recipeId` cleared (`clearRecipe`), then
  the write with `recipeId` set to the record again (`withRecipe`), which
  DYE2 takes as a new apply of the recipe on the new profile; where Decaid
  refuses the second, the recipe is named again alone. Both run as one write
  of the plugin's, so the server never reads the Workflow between them, and
  reads no unload (interim, until decentespresso/dye2#38, ADR-0022).
- **Saving each change.** Every change on a Machine with a Recipe loaded is
  saved into it (ADR-0022). After each change of the Workflow naming the
  Loaded Recipe, the plugin holds the change back and, in its turn among the
  reads and writes of the tablet's lists (`LibraryAccess.run`), so never
  during a post of `recipes`, which DYE2's save rewrites too, calls DYE2's
  `POST /api/v1/plugins/dye2.reaplugin/record` (`recordIntoRecipe`), the
  call Streamline's Save changes makes. Where DYE2 answers that it saved,
  the plugin reads DYE2's recipes and queues them, connected or not
  (`CollectionCapture.recipesNow`), before it releases the change, so the
  server takes in the edit before the Workflow that brought it (`saveSoon`).
  One call waiting its turn covers the changes after it, as DYE2 saves the
  Workflow as it is then. It makes none for the echo of its own writes, for
  the change that loads a Recipe, which may be a stale copy's, as the load
  write follows instead, or for a change of the profile from the Workflow
  before it, by `dye2Fingerprint`: DYE2's profile picker changes only the
  profile, and DYE2 clears `recipeId` a moment later, so a save in between
  would write the new profile's brew temperature into the Recipe. A call
  that fails is logged, and the next change calls again.
- **DYE2's recipes on each push.** DYE2 pushes `{"what":"workflow"}` on its
  `changed` socket (`/ws/v1/plugins/dye2.reaplugin/changed`, opened through
  `host.transport` and counted, with the connections to the server, against
  Decaid's 8 transports, leaving one for the server) as the recipe the
  Workflow names changes, after it saves into a recipe, and after it
  refreshes its recent favourites. On each push the plugin reads DYE2's
  recipes as its poll of the tablet's lists does
  (`CollectionCapture.readRecipes`, while connected), and sends them if they
  changed: a Save changes made in Streamline reaches the server within
  seconds, not only on that poll. A push lost while the socket opens is
  made up for by the poll.
- **Clearing a record it replaces.** Before a post of DYE2's recipes that
  removes the record the Workflow names, or gives its id to another
  Recipe's record, by the global ids they carry (`vacatedIds` in
  `loaded-recipe-rules.ts`), as the server's writes do as a Machine joins a
  Location whose Recipes' ids are slot numbers too (`LIBRARY.md`, Joining a
  Location), the plugin writes `recipeId: null` into the Workflow first
  (`beforePost`), as one write of its own, and posts nothing if Decaid does
  not take it: so the Workflow never names a Recipe it did not apply. A
  record given its global id, as one a Location takes in, is the same
  recipe.
- **DYE2 not there.** On its poll (the plugin's poll interval) the plugin
  reads `GET /api/v1/plugins`, then DYE2's recipes. The Machine has no
  Loaded Recipe where Decaid's plugins list has no DYE2, or one neither
  loaded nor to load at startup (`loaded` and `autoLoad` both false), at
  once, or one not loaded for longer than twice the poll interval: the
  plugin delivers the Workflow again with `dye2Absent`, where it names a
  recipe, as it does every Workflow until DYE2 is back, whatever it names,
  and writes no load and saves nothing meanwhile. A loaded DYE2 counts
  whatever its `autoLoad`.
- **Capture-only.** The server tells the plugin whether its Machine is
  capture-only (`captureOnly`, sent after `welcome` and whenever it
  changes). On one, the plugin writes no load and saves nothing; a recipe
  applied there stays named in the Workflow. The server's clear of the
  Recipe it last had loaded is written there all the same (Unloads the
  server decides, below). Until told, as offline, it takes its Machine to
  take part.
- **Held back.** `MachineEvents` holds the Workflow's changes while any of
  the plugin's writes into it, or a save into the Loaded Recipe, is under
  way, a count shared with the Library's writes into the Workflow, as a
  joining tablet's clear (`LIBRARY.md`, Joining a Location), and sends the
  latest once none is, observed when Decaid last reported it. Where the
  recipe it names changed while held, the delivery also says when Decaid
  first reported it naming that recipe (`recipeNamedAt`), which the server
  loads the Recipe from, so a later report meanwhile, as of the plugin's
  own write, does not leave a Shot pulled with the recipe taken for one
  pulled before it was loaded; the Workflow's other parts, as its edits of
  the Recipe, keep the time of the latest report. Changes of the machine's
  state are not held. A
  welcome's resend of the Workflow asked for while held is the Workflow
  released, which the next welcome replaces unless it was ever sent, but
  where a change was held too: replacing that would lose the change. A held
  change is kept in plugin storage only once it is queued: an unload of the
  plugin while one is held loses it.
- **During a Shot.** Decaid writes a Workflow's profile to the machine the
  moment it changes, whatever the machine is doing (`WorkflowDeviceSync` in
  `decaid:lib/src/controllers/workflow_device_sync.dart`), replacing the
  frames of a Shot still running, sends a Bengle the Workflow's yield as it
  changes (`BengleSawBridge`), and stores a Shot with the Workflow it holds
  once the Shot ends (`_persistShotIfNeeded` in
  `decaid:lib/src/controllers/de1_state_manager.dart`). So from the machine
  state `espresso` (`SHOT_STATE`, Decaid's `stateUpdate`) until Decaid
  stores the Shot (`shotStored`), or `SHOT_STORED_WITHIN_MS` (10 s) after
  the state left `espresso` for one it stores none of, the plugin makes no
  write into the Workflow (`plugin/src/shot-gate.ts`, ticket #217). A load
  decided on meanwhile is held, the latest only, and made once the Shot
  ends, while the Workflow still names its Recipe; it is kept in Decaid's
  plugin storage (`heldLoad`) until it is made, so a load held as the
  plugin stops is made once it loads again, where the Workflow still names
  that Recipe. The server's changes are held too, every kind (`LIBRARY.md`,
  How the plugin writes), and planned afresh once the Shot ends, so a
  Recipe edited twice during it is written once, with its latest values,
  and a write that changes the profile goes out as its two `PUT /workflow`
  together. Saves into the Loaded Recipe are not held: a change made on the
  Machine during its own Shot is saved at once. An unknown state, before
  the first update or once no machine is connected (the plugin's read of
  the machine's hardware finds none, and Decaid has reported no state for
  3 s, as one failed read is no machine gone), is no Shot, as for
  Streamline.
- **When Decaid fails.** A read, write or save Decaid fails is logged once
  until one succeeds, and tried again at the next change, push or poll.

Known limits: Decaid has no conditional write, so a barista's change of a
field a write sets, made in the moment between the plugin's read and its
write, is written over (ADR-0021); and a barista applying another recipe in
the moment between the plugin's check that the Workflow names the Recipe
and its write has the write land there. ADR-0022 lists the gaps accepted
until DYE2 and Streamline fix them upstream.

### Server

A Workflow delivery names the Recipe the tablet's map of its recipes holds
under the record id its `recipeId` names (`tablet_recipes`, read under the
tablet's lock, `mappedRecipe`), and none for a Workflow naming nothing, a
record the map does not hold, or any while it carries `dye2Absent`. That
Loaded Recipe is taken into its Machine's state in the transaction storing
the delivery, from a connection that is not mismatched, for its token's
Machine, after the tablet's lock and its Workflow's grinder, batch and
Basket (`takeInWorkflow` in `server/src/library/joining.ts`, which has
`takeInLoadedRecipe` in `server/src/machine-events/loaded-recipes.ts` take
it in): one of the Recipes of the Machine's Location not Archived, in a
Recipe Slot or not, while it takes part in the Library there, and none
otherwise, as on a Capture-only Machine, or one the Workflow names that was
Archived, or is of a Location the Machine left. Each Machine's Loaded
Recipes are kept in `loaded_recipes`, the Recipe from when to when, its
current one the entry not unloaded, at most one per Machine. A change of it
unloads the current one and loads the new one at the time the plugin
observed the Workflow, or first saw it name the recipe where it held the
change back meanwhile (`recipeNamedAt`), by the tablet's clock, which a
delivery made offline keeps, but never before the Machine's latest entry
(`switchLoaded`). The
Recipe's row is locked after the Location's lock, which a Recipe's slots,
its edits and its hard delete take before its row; the hard delete removes
its entries. A Machine made capture-only shows no Loaded Recipe from its
first Workflow delivery after the switch, though its Workflow may still name
one (below); a change of Location asks for one at once.

The server keeps, per tablet, what its Workflow last named
(`tablet_loaded_recipes`): the record id; the Recipe the map holds under it,
or none while it holds none yet; when the plugin observed the Workflow first
naming that id (`named_at`, its `recipeNamedAt` where it says), kept while later Workflows name it; the parts
of the Workflow that follow the Recipe as it last held them (`held`); and
the Recipe's parts as that Workflow last took them, written there or held
already (`base`). A Workflow naming nothing forgets it.

- **A recipe named before its record arrives.** A Workflow can name a
  record the map does not hold yet, as one DYE2's `save-recipe` made and
  named at once, whose record reaches the server in the report after it. The
  server keeps the id with no Recipe, and once the map comes to hold a
  record of that id, as the report takes it in as a new Recipe of the
  Location (`LIBRARY.md`, Taking in a tablet's recipes) or an answer
  records it, and the Machine's latest Workflow still names it, the Recipe
  is taken in as that Workflow naming it, loaded from `named_at`, never
  before the Machine's latest entry, and its parts as the plugin observed
  that Workflow, which times the Recipe's edits from it (`recipeMapped`); and
  the Shots the tablet reported naming that id are linked to it
  (`linkRecipeShots`, `SHOTS.md`). A Workflow naming a record the map held
  already, as one of the Location the Machine left, never takes this path,
  so it never loads another Recipe the map gives that id later.

### Following the Recipe

Tickets [#146](https://github.com/loganfuller/decent-sync/issues/146),
#173, #177, #187 and #216 have a Machine follow its Loaded Recipe both ways
(ADR-0022). The parts of a Workflow that follow it are its Profile,
Grinder, dose, yield, grind setting, RPM, Basket, Bean Batch, brew
temperature, its profile's first step's, and the eleven steam, hot water and
flush settings, each part named as the Recipe's content field
(`LOADED_RECIPE_PARTS` and `RECIPE_SETTINGS` in `protocol/`). Its Grinder is
`grinderId` and `grinderModel`, as DYE2 applies a recipe's, not the
grinder's burrs: Decaid copies onto each Shot it pulls the burrs of the
grinder the Shot names (`PersistenceController.persistShot` in
`decaid:lib/src/controllers/persistence_controller.dart`) and leaves the
Workflow's alone, so Shots record the burrs of the grinder loaded, while the
Workflow may go on showing a previous grinder's. The Workflow's Profile is
held as the Library Profile it is, found as a Shot's is (`profileOfSql`).
Each Workflow delivery from the Machine's tablet sets `held` to its parts,
so the plugin's own write, whose answer the server reads first, is never
read as the tablet's edit, and what stays the Machine's own is never written
back (below). The pure `server/src/library/loaded-recipe-intake.ts` maps the
parts to the Recipe's content both ways.

- **What DYE2 saves.** The plugin's call of DYE2's `record` after each
  change (Saving each change, above) has DYE2 write into the recipe's record
  each value of the Workflow that differs (`RECORDED_PARTS`; `itemPatch` in
  `dye2:dye2-plugin/src/utils/workflow-record.ts`): the dose, yield, grind
  setting, RPM and Basket, where the record holds one; the brew temperature
  once it moves off its value at the apply; and each steam, hot water and
  flush setting the record holds, or holds none of once it moves off its
  value at the apply. It writes no steam setting while steam is off, no
  value cleared, and never the batch, grinder or Profile. The plugin reports
  the recipes, and the tablet's change of the record is taken in as any is
  (`LIBRARY.md`, Taking in a tablet's recipes), the Recipe's edit, but for
  what is no edit (`recordedByDye2`): a value the Recipe holds already, as
  DYE2 saving the plugin's own write back; and a value that is what the
  Workflow held of a part whose write of the server's is still to land,
  while the Recipe holds another (`unwritten`), as DYE2 then saved the
  Workflow left behind the record, as a barista's change landing between
  the plugin's write of the record and its write of the Workflow has it do,
  or a write Decaid refused for want of a machine. That value is written
  back over, into the record and the Workflow. Each value DYE2 saved is held
  as the Workflow's, and one taken as an edit as the Workflow having taken
  the Recipe's new value (`base`), so it is written into no Workflow it came
  from. So is a save the plugin's read of the list caught just before its
  post, as the answer to the post carries it (`recordRecipeWritten`). The
  server derives the steam, hot water and flush settings of each record's
  embedded Workflow as DYE2 copies them there, from the settings the record
  holds, and carries into it the field flags DYE2's editor saves there
  (`withHeldFieldFlags`), so no write of the server's takes out one DYE2
  then adds back (ADR-0005). A save of DYE2's editor, which stamps the
  record's `capturedAt` anew where DYE2's `record` keeps it
  (`savedInEditor`), is no save from the Workflow: none of it is judged so,
  and as the Workflow does not hold its values yet, they are written into
  the Workflow of every Machine that has the Recipe loaded, the saving
  one's included.
- **What Decent Sync records itself.** From a Workflow that goes on naming
  the Recipe its Machine had loaded (not one that loads it, nor one named
  again as the tablet joins its Location), the server records, as that
  tablet's edit of the Recipe, timed as the plugin observed the Workflow,
  merged per field with Conflicts and judged by what the tablet's record of
  the Recipe has seen (ADR-0020, `editContent`), each change from `held` of
  what DYE2 saves none of (`valuesFromWorkflow` in
  `loaded-recipe-intake.ts`, `recordFromWorkflow`): a dose, yield, grind
  setting, RPM or Basket the Recipe holds none of; a Grinder, one of the
  Location's not Archived; and a Bean Batch of the Recipe's own Bean, or any
  batch, with its Bean, for a Recipe naming no Bean. It skips a Workflow
  whose profile, by `dye2Fingerprint`, differs from the Machine's Workflow
  stored before it (`profileChanged`), as DYE2 clears `recipeId` a moment
  later. A part recorded is taken as the Workflow having taken it (`base`),
  but one that lost to an edit the tablet had not seen, which is written
  back. The Recipe's tablets are written the edit, and the Workflows of the
  other Machines that have it loaded.
- **What stays the Machine's own.** A batch of another Bean, which keeps
  the Recipe loaded, its Shots linked to it; a value cleared; steam turned
  off; and a steam setting changed while steam is off, which DYE2 does not
  save. None is an edit, and `held` takes it while `base` still holds the
  Recipe's, so no write of the Recipe's value is planned over it.
- **A load.** On a Workflow that loads the Recipe, the Recipe gains, from
  the Workflow as it stands, each of the values Decent Sync records itself
  that it holds none of (`valuesFromWorkflow` with no `held`): so a Recipe
  made without a grinder, Basket, RPM or dial takes those the Machine is
  using. A value it holds is never taken from a load, which may be a stale
  copy's. Its `base` starts as the parts the Workflow holds already as the
  Recipe does (`heldAlready`), so every other part the Recipe holds is
  written into it once (To every Machine that has it loaded, below), the
  load write's answer holding most of them already. A Workflow naming the
  Recipe again as the tablet joins its Location gains it nothing; one naming
  it while its Machine still has it loaded, the tablet's record of what it
  named forgotten, is taken as having taken the Recipe's parts as they
  stand, so nothing is written for them until they change.
- **Steam on and off.** Steam on and off stays each Machine's own
  (ADR-0022, Steam on and off). The server reads each delivered Workflow's
  steam temperature only as one of its parts, never as an edit, and steam
  is off below `STEAM_ON_FROM` (135 °C), as Decaid judges it (`steamOff`).
  DYE2 saves no steam setting while steam is off, so steam turned off
  reaches no Recipe. A steam time of 0 DYE2 saves is a value, as Streamline
  v0.2.18 reads it as "no timer". A steam temperature below 135 °C in a
  record, as DYE2's editor saves "Off" (0), is never taken in
  (`steamOffPaths` in `recipe-intake.ts`), and the Recipe's is written back
  into the record.
- **The same edit once.** A field of the tablet's record that sets the
  Recipe's value its own latest edit set already is no edit
  (`withoutOwnEdits` in `recipe-intake.ts`), so the same edit reaching the
  server twice is one.
- **To every Machine that has it loaded.** An edit of a Recipe from
  anywhere, a tablet, the management interface or a Conflict's value used,
  commits with a `NOTIFY` on `library_changes` naming its Location, and
  each writer there plans, after the Recipe's record and the items it names
  (`loadedRecipeDue`, last in `changesDue`), a `write` of the
  `loadedRecipe` kind carrying each part of the Recipe that changed since
  its tablet's Workflow took it (`base`) and that the Workflow holds
  otherwise (`held`, `dueParts`), by the tablet's ids, with the names DYE2
  copies beside a Grinder, a Basket and a batch, each expecting the value
  the Workflow last held, its Profile whole, expecting nothing, as a skin
  overrides parts of the one it loads, and its brew temperature
  (`profile.steps.0.temperature`, its Profile's first step's where the
  Recipe holds none), with any Profile written, and each steam, hot water
  and flush setting the Recipe holds, its steam temperature included
  whatever the Machine's steam state (`partsWrite`). It expects too the
  record id the Workflow named (`DYE2_RECIPE_FIELD`). DYE2 saves the
  Workflow's dial, RPM and Basket into the record, so they wait until the
  tablet's record of the Recipe, written first, holds them
  (`heldByRecord`); the rest of the write goes ahead, its Grinder and batch
  included. The plugin writes nothing unless the Workflow it has just read
  still names that record (it refuses the write otherwise, and the writer
  tries it again once it changes), and sets a part only while it holds the
  value expected, the value written or none, so a barista's change since is
  kept, which its own save brings to the Recipe; a brew temperature moves
  every step of the profile written, or else the Workflow's, by the same
  amount. A write changing the profile is made as two, so the Recipe stays
  loaded (A write that changes the profile, above). It leaves the steam
  temperature out of `PUT /workflow` where the Workflow it has just read has
  steam off (`steamOff`), as a barista may turn steam off after the server
  plans the write. The steam time, flow and milk stop are written as usual,
  as they do not turn steam on. With each write carrying a steam
  temperature of 135 °C or more, written or left out, the plugin sets
  Streamline's `last-steam-temp` to it, as on a load (A load, above). The
  Workflow change the write causes is sent after the answer, which records
  what Decaid returned as the Workflow's (`recordLoadedRecipeWritten`),
  where it still names the record: each part the write set held as Decaid
  returned it, and, by the latest edit the write carried, as taken by the
  Workflow (`base`) each part it set, each it left out that the Workflow
  holds as the Recipe does, or holds otherwise than before as a barista
  changed it meanwhile, which the plugin kept, and a steam temperature left
  out of a Workflow whose steam is off, so none is written again until the
  Recipe changes. Decaid refuses the steam, hot water and flush settings
  while no machine is connected: the rest is written, and those, still due,
  once the machine is back and the plugin reconnects. Once Decaid takes a write that
  changed the Workflow, the plugin pushes `{"what":"workflow"}` on its
  `changed` endpoint, as after a load (A load, above): a skin reads the
  Workflow on the push after the Recipe's record, written first, before the
  write reaches it. A write is made to the Workflow of a Machine only while
  its Loaded Recipe is the Recipe its Workflow names; a Machine with no
  Loaded Recipe keeps its own steam, hot water and flush settings.
- **Unloads the server decides.** A Workflow naming a Recipe that is not
  its Machine's Loaded Recipe, as one Archived, or of a Location the Machine
  left, as it joins another (ticket
  [#148](https://github.com/loganfuller/decent-sync/issues/148)), or the
  one the server last had as its Loaded Recipe as it was made capture-only,
  is due the same `write`, naming `DYE2_RECIPE_FIELD` alone, null, and
  expecting the record id the Workflow named: the plugin writes
  `{"context":{"extras":{"dye":{"recipeId":null}}}}` into the Workflow, as
  DYE2 does, where it still names that record, and answers naming the
  field, or writes nothing and answers naming none where it names another.
  Either answer has the server no longer hold the Workflow's parts for the
  Recipe, and the Workflow the plugin then sends brings what it names: none,
  which unloads it on the server. A Recipe moved to another slot keeps its
  record id, and stays loaded. A Capture-only Machine's writer writes this,
  and nothing else, whatever its reports. A recipe applied while its Machine
  is capture-only, which nothing there shares, stays named in the Workflow,
  as does one loaded on the tablet before the switch that the server had not
  heard of yet, as while offline; once its sharing is turned back on, it is
  the Machine's Loaded Recipe where it is one of its Location's Recipes. The
  field names a recipe applied on a Capture-only Machine too, so Shots
  pulled there can name a Recipe that was never that Machine's Loaded
  Recipe: Shots are linked to Recipes by the Machine's Loaded Recipes
  (`loaded_recipes`, `SHOTS.md`), not by the field alone.

Known limits: a Recipe applied again from a stale copy while it is loaded,
as a strip button tapped on a Streamline dashboard that has not read its
recipes again, is a change of the Workflow, not a load, so the plugin has
DYE2 save the copy's values into the Recipe. ADR-0022 lists this and the
other gaps accepted until DYE2 and Streamline fix them upstream.

## REST API

All endpoints require the account session, and answer 404 for an unknown
Machine. Pending Machines' events are not exposed; they appear on the Machine
that takes their hardware over. Staff read them as Admins do.

- `GET /api/machines` and `GET /api/machines/:id` include `machineState:
  { state, substate, observedAt } | null`, the latest stored.
- `GET /api/machines/:id/workflow` returns `{ workflow }`, the latest Workflow
  event `{ id, observedAt, receivedAt, workflow }` or null; `workflow` is
  Decaid's, as sent.
- `GET /api/machines` and `GET /api/machines/:id` include `loadedRecipe:
  { id, recipe: { id, name, slot, locationId, archived }, loadedAt,
  unloadedAt } | null`, the Machine's Loaded Recipe now, `unloadedAt` null.
- `GET /api/machines/:id/loaded-recipes?limit=20&offset=0` returns
  `{ entries, total, limit, offset }`, its Loaded Recipes, latest first, each
  as `loadedRecipe` is, with `unloadedAt` the time it was unloaded. Limit is
  1–100.
- `GET /api/machines/:id/workflow-events?limit=20&offset=0` and
  `GET /api/machines/:id/machine-state-events?limit=20&offset=0` return
  `{ events, total, limit, offset }`, latest first. A state event is
  `{ id, state, substate, observedAt, receivedAt }`. Limit is 1–100.

The Machines list shows each Machine's state and last Shot; the Machine page
also shows its current Workflow, its fields as a Shot's page shows them, the
brew temperature read from its profile's first step as Streamline's Brew tile
reads it (`web/src/components/workflow.tsx`, tested in
`web/test/workflow.test.ts`), loaded every 30 s rather than every 5 s as the
state is, and its Loaded Recipe with its history, loaded again as the
Loaded Recipe changes. Each Location's page lists its Machines and the
Recipe each has loaded.

`server/test/machine-events.test.ts` covers this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL,
`server/test/loaded-recipes.test.ts` the Loaded Recipe,
`server/test/loaded-recipe-following.test.ts` Machines following it both ways, `server/test/shot-holds.test.ts` the writes held during a Shot, with `plugin/test/shot-gate.test.ts` when one runs, `server/test/recipe-settings.test.ts` its steam, hot water and flush settings and steam on and off, `server/test/loaded-recipe-intake.test.ts` its pure module,
`plugin/test/loaded-recipe-rules.test.ts` the plugin's, `plugin/test/dye2-fingerprint.test.ts` its copy of DYE2's profile fingerprint, and `plugin/test/machine-events.test.ts` what is held back,
`server/test/durable-outbox.test.ts` the deliveries kept across unloads and
their bound, and
`e2e/workflow-and-state.spec.ts` and `e2e/loaded-recipes.spec.ts` the
management interface.
`server/test/binding-deadlocks.test.ts` races deliveries, collections
included, against a hello or an Admin binding the Machine's hardware, in
both orders.
