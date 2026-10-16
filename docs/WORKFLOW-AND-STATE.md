# Workflow changes and machine state transitions

Ticket [#13](https://github.com/loganfuller/decent-sync/issues/13) extends
protocol version 1 with two deliveries, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `workflow` | `id` (delivery id), `observedAt`, `workflow` (opaque, as Decaid's `workflowUpdated` event gave it), and from #177 `loadBefore` and `unrecorded` (The Loaded Recipe, below) |
| Plugin to server | `machineState` | `id`, `observedAt`, `state` and `substate` (Decaid's names, such as `espresso` and `preinfusion`) |

Both are acknowledged with `ack` once stored, or set aside because storing
them fails in a way that would repeat, as Shots are (`AI_PROTOCOL_NOTES.md`,
Deliveries set aside). The protocol version stays 1, as it does for any
change until v1 (ADR-0017).

## Plugin

`plugin/src/machine-events.ts` turns Decaid's events into deliveries, through
the plugin's one outbox (`plugin/src/outbox.ts`), which Shots share:

- `workflowUpdated` carries the whole Workflow. Decaid sends it just after
  loading the plugin and on every change (`PluginManager` in
  `decaid:lib/src/plugins/plugin_manager.dart`), so the plugin never reads
  `GET /workflow`. Every one is sent.
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
  collections, so it is taken in at the new Location: its settings give way
  to the Location's, and its grinder and batch are cleared if the Location
  does not offer them (`LIBRARY.md`, Joining a Location).

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
Machine, is also taken into its Location's steam and rinse settings in the
same transaction (tickets #86 and #137, `LIBRARY.md`, Steam and rinse
settings): only those settings count as edits, timed by `observedAt`, and a
change of its hot water, which is each Machine's own, is none. While the plugin writes the shared settings
into the Workflow, it holds back the `workflowUpdated` its write causes until
the write's answer is queued, then sends the latest Workflow, so the server
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
[#177](https://github.com/loganfuller/decent-sync/issues/177) makes it the
recipe DYE2 has selected on the tablet. From v0.1.20, DYE2 keeps one
selected recipe or favourite, which its dashboard and Streamline's DYE strip
select as they apply one (`dye2:dye2-plugin/src/utils/workflow-record.ts`).
The plugin follows that selection and records the Loaded Recipe in the
Workflow (`decentSyncRecipeId` in `context.extras`, LOADED_RECIPE_KEY), so a
load made while the tablet is offline is recorded too, and Decaid copies it
onto every Shot pulled with it. The server reads it from the Workflow
deliveries.

### Plugin

`plugin/src/loaded-recipes.ts` follows DYE2's selection, through
`plugin/src/dye2-selection.ts`, and writes what the pure
`plugin/src/loaded-recipe-rules.ts` works out:

- **Reading the selection.** The plugin reads `GET
  /api/v1/plugins/dye2.reaplugin/selection` on each push on DYE2's
  `changed` socket (`/ws/v1/plugins/dye2.reaplugin/changed`, opened through
  `host.transport` and counted, with the connections to the server, against
  Decaid's 8 transports, leaving one for the server), about 2 s after the
  latest change of the Workflow, past DYE2's 1.5 s wait before it records,
  to catch the clears DYE2 does not push (decentespresso/dye2#24), and on
  its poll (the plugin's poll interval), when it also reads `GET
  /api/v1/plugins` and DYE2's recipes. Each read is one piece of work in
  one queue, in turn.
- **What it decides.** A selection of a recipe in a Recipe Slot carrying a
  Recipe's global id, made on the profile the Workflow holds (its
  `profileFingerprint` equal to `dye2Fingerprint` of the Workflow's profile,
  DYE2's own test, or none), loads that Recipe where the Workflow does not
  name it already. Any other selection, a favourite, a recipe of no Recipe's
  slot or made on another profile, or none, unloads the Loaded Recipe. A 404
  tells nothing: DYE2 is not loaded, as while it reloads or updates, and
  records nothing. A first answer of none after the plugin loads, or after
  a 404, is taken only once a later read confirms it, at the latest on the
  poll, as DYE2 restores its stored selection after its load (`onLoad`,
  then `storageRead`). The Machine has no Loaded Recipe where Decaid's
  plugins list has no DYE2, or one neither loaded nor to load at startup
  (`loaded` and `autoLoad` both false), at once, or one not loaded for
  longer than twice the poll interval: the plugin unloads it, drops a
  selection of its own still to make, keeps a clear, and keeps `{}` as
  DYE2's stored selection once (below). A loaded DYE2 counts whatever its
  `autoLoad`. Dialling in a Recipe's values by hand loads nothing.
- **Holding the Workflow back.** While a Recipe is loaded, or the Workflow
  names one the plugin does not take as loaded, each change of the
  Workflow is held back (Held back, below) until a read of the selection
  after it decides on it, at most 10 s while changes keep coming. So the
  server never reads a recipe applied from DYE2's dashboard, whose Workflow
  still names the Recipe loaded before, as a change of that one, nor a
  Workflow naming a Recipe the plugin has not loaded. Not while DYE2
  answered 404 last, as no read can decide then. The first Workflow after
  the plugin loads names the Loaded Recipe it takes until it decides.
- **A load.** Once DYE2 is found still to have the slot selected, or
  answers 404, the plugin reads the Workflow and writes into it, in one
  `PUT /workflow`, which Decaid merges into it, what it holds otherwise of
  the recipe's current dose, yield (its dose times its ratio where it holds
  none), grind setting, grinder, RPM, Basket and Profile (whole, from its
  `profileSnapshot` or the tablet's record of its `profileId`, only where
  its `profileKey` differs), its brew temperature, its Bean Batch, read from
  the tablet's records with its Bean's name and roaster as `coffeeName` and
  `coffeeRoaster`, all four hot water settings from the record's own field
  (RECIPE_FIELD), and the Recipe's global id (`loadWrite`). A brew
  temperature is written as Streamline's Brew tile writes one
  (`profileAtBrewTemperature` in `protocol/`, after `shiftedTemperatures` in
  `streamline-js:src/modules/brew-temp.js`): the first step goes to it and
  every other moves by the same amount, from the tablet's record of the
  Profile's own step temperatures, so the profile keeps its shape however
  often it is moved; nothing for a profile with no usable first step
  temperature. Decaid refuses to change the hot water settings while no
  machine is connected, so the rest is then written without them. With the
  write, the plugin attaches to the next Workflow delivery queued
  (`WorkflowDelivery.loadBefore`) each part it changed, what the Workflow
  held of it before and what it wrote, so the server can tell a part set
  back to its value before the load (Stale values, below). A write that
  changed the profile, as one from a stale copy or of another Profile,
  changes DYE2's fingerprint, and DYE2 clears its selection: the plugin
  selects the slot again right after, as DYE2's dashboard does after an
  apply, where DYE2 answers none or still that slot (Selecting again,
  below). Selecting cancels a record DYE2 had pending, so a brew
  temperature changed in the 1.5 s before it is not recorded. Streamline
  adopts a Workflow change made elsewhere (ADR-0021), so it takes the hot
  water as its own, and the plugin sets none of its values.
- **The id kept.** On every read and every change of the Workflow, the
  plugin keeps the Workflow naming the Loaded Recipe, or none, setting the
  key to null to clear it, as Decaid merges `extras` key by key: a DYE2
  page sends back the Workflow it read as it opened, with whatever id it
  held then.
- **An unload on a change of grinder or Bean.** DYE2 keeps its selection
  through a change of grinder or Bean, and would record the other grinder's
  or Bean's grind into the Recipe (decentespresso/dye2#19). So a change of
  the Workflow's grinder to one the Recipe's record does not name, or of its
  Bean Batch to one of another Bean (its batch's Bean, read from the
  tablet's batch record), unloads the Recipe at once, and the plugin clears
  DYE2's selection while it still names the slot, keeping `{}` after. A
  grinder or batch cleared is no such change, as Streamline clears them
  after each Shot, nor is a batch set back to the one the load replaced,
  before the first espresso since (`stateUpdate`), which the server writes
  back; any other grinder set back unloads it.
- **Selecting again.** A selection or clear of the plugin's that Decaid
  fails, or that DYE2 answers 404, is tried again at the next read once DYE2
  answers (unlike #176's, which took a 404 as done), and gives way to
  something else DYE2 selected since. Until a selection of the plugin's
  lands, its reads neither unload the Recipe nor keep `{}`.
- **A yield set in Streamline** writes the profile's target weight, which
  clears DYE2's selection before DYE2 records anything (decentespresso/dye2#18).
  Where the read after it finds none, and the Workflow's profile differs
  from the one the Loaded Recipe was selected on in its target weight or
  volume alone (`targetsOnlyDiffer`), the plugin selects the slot again,
  without a load's write, and marks the held Workflow delivery
  `unrecorded`, so the server takes from it every field DYE2 would have
  recorded that differs from the Recipe. A wake profile Streamline sends
  with another yield is taken in the same way (decentespresso/streamline-js#153).
- **A cleared selection kept cleared.** DYE2 restores its stored selection
  as it loads, and stores a cleared one as `null`, which Decaid's store does
  not keep, so a cleared selection comes back (decentespresso/dye2#22). So
  where DYE2 answers none after a recipe, after the plugin's own clear, and
  once as DYE2 becomes unavailable while a Recipe is loaded, the plugin
  posts `{}` to `/api/v1/store/dye2.reaplugin/selection`, which DYE2
  restores as none, then reads the selection again, and keeps that instead
  should DYE2 have selected something meanwhile. A slot move's clear keeps
  nothing.
- **Moving to another slot.** Before a post of DYE2's recipes the server's
  write makes that moves the Loaded Recipe to another slot, the plugin clears
  DYE2's selection of the old slot, keeping nothing, so DYE2 never records
  into a recipe put there; after it, it selects the new slot. Reads decide
  nothing meanwhile.
- **Capture-only.** The server tells the plugin whether its Machine is
  capture-only (`captureOnly`, sent after `welcome` and whenever it
  changes). On one, the plugin loads nothing, unloads nothing and runs none
  of the workarounds above; a recipe selected there stays selected and
  recorded into. Until told, as offline, it takes its Machine to take part.
- **Held back.** `MachineEvents` holds the Workflow's changes while any of
  the plugin's writes into it is under way, or a decision on one is, a
  count shared with the writes of the shared settings, and sends the
  latest once none is, then the changes of the machine's state reported
  meanwhile, each as observed. So the server reads a Workflow change
  reported before a change of state, as a DYE2 dashboard's send just before
  an espresso, before it. A change of the Workflow during a write of the
  plugin's is that write's echo, which the write holds. A welcome's resend
  of the Workflow asked for while held is the Workflow released, which the
  next welcome replaces unless it was ever sent, but where a change was held
  too: replacing that would lose the change. What a delivery carries
  besides the Workflow (`loadBefore`, `unrecorded`) goes to the next one
  queued, held or not, and to the resend that replaces it; where several
  loads come before one delivery, each part keeps its earliest `before`. A
  held change, and a held change of state, is kept in plugin storage only
  once it is queued: an unload of the plugin while one is held loses it.
- **When Decaid fails.** A read or write Decaid fails is logged once until
  one succeeds, and tried again at the next read, push or poll.

Known limits: Decaid has no conditional write, so a barista's change of a
field a write sets, made in the moment between the plugin's read and its
write, is written over, as for a settings write (ADR-0021); and a barista
selecting another recipe in the moment between the plugin's check of the
selection and its write has the write land there. A held change of state
is lost if the plugin stops meanwhile; the window for a part set back
(below) then stays open to the next espresso. ADR-0022 lists the gaps
accepted until DYE2 and Streamline fix them upstream.

### Server

The Loaded Recipe a Workflow delivery names is taken into its Machine's
state in the transaction storing it, from a connection that is not
mismatched, for its token's Machine, after the tablet's lock and its
Workflow's grinder and batch, before its Location's settings
(`takeInLoadedRecipe` in `server/src/machine-events/loaded-recipes.ts`):
one of the Recipes in a slot of the Machine's Location while it takes part
in the Library there, and none otherwise, as on a Capture-only Machine, or
one the Workflow names that was taken out of its slot or Archived, or is of
a Location the Machine left. Each Machine's Loaded
Recipes are kept in `loaded_recipes`, the Recipe from when to when, its
current one the entry not unloaded, at most one per Machine. A change of it
unloads the current one and loads the new one at the time the plugin
observed the Workflow, by the tablet's clock, which a delivery made offline
keeps, but never before the Machine's latest entry. The Recipe's row is
locked after the Location's lock, which a Recipe's slots, its edits and its
hard delete take before its row; the hard delete removes its entries. A
Machine made capture-only shows no Loaded Recipe from its first Workflow
delivery after the switch, though its Workflow may still name one (below);
a change of Location asks for one at once. A delivery carrying `loadBefore`
keeps it with the Machine's current entry (`load_before`), replacing a
load's before, until a `machineState` delivery of `espresso` from the
Machine's own tablet clears it (`espressoStarted`), in delivery order.

### Following the Recipe

Tickets [#146](https://github.com/loganfuller/decent-sync/issues/146) and
#177 have a Machine follow its Loaded Recipe both ways (ADR-0022). The parts
of a Workflow that follow it are its Profile, Grinder, dose, yield, grind
setting, RPM, Basket, Bean Batch, four hot water settings and brew
temperature, its profile's first step's (`LOADED_RECIPE_PARTS` in
`protocol/`). The Workflow's Profile is held as the Library Profile it is,
found as a Shot's is (`profileOfSql`). The server keeps, per tablet, the
Recipe its Workflow last named and those parts as the Workflow held them,
reported, recorded by DYE2, or as Decaid returned the plugin's write of
them (`tablet_loaded_recipes`), as it keeps the shared settings
(`tablet_settings`), so the plugin's own write is never read as the
tablet's edit. The pure `server/src/library/loaded-recipe-intake.ts` maps
the parts to the Recipe's content both ways.

- **What DYE2 records.** DYE2 records a change of the Workflow's dose,
  yield, grind setting, brew temperature, and the hot water value of the
  Recipe's mode (its temperature for `temp`, its volume otherwise), into
  the recipe's record (`recordedParts`), which the plugin reports with
  DYE2's recipes: the tablet's change of the record, taken in as any is
  (`LIBRARY.md`, Taking in a tablet's recipes). The Workflow's change of
  them is no edit: DYE2 is their only recorder, so the change is one edit.
  Each value recorded is held as the Workflow's (`recordedByDye2`). Its
  steam and flush values are the Location's settings (ADR-0014): the
  Workflow change and the record change of one are one edit, as a value the
  settings hold already changes nothing.
- **What the Workflow edits.** A Workflow delivery naming the Recipe its
  Machine went on having loaded, not as it joins its Location, is the
  tablet's edit of the Recipe in each of its RPM, Basket, Bean Batch and
  hot water settings but the one DYE2 records (`workflowEditedParts`,
  decentespresso/dye2#21 and #27), and in a delivery marked `unrecorded`
  the parts DYE2 records too (decentespresso/dye2#18), each it holds
  otherwise than it last did, timed when the plugin observed it, merged
  with what the Workflow had seen of the Recipe's edits (ADR-0020), from the
  Machine's tablet, whatever app made it. What the Workflow has seen is,
  from a load, what the tablet's record of the Recipe had seen, and from the
  answer to a write of it, the latest edit of the Recipe the write carried,
  once the Workflow holds every part of the Recipe but one naming an item
  its Location no longer offers the tablet, as a Basket Archived there
  (`holdsWhole`). A dose, yield, RPM, hot water setting or brew temperature
  is the Recipe's as it is, and a grind setting as the number DYE2 keeps;
  DYE2's ratio is kept only while the yield is the dose times it. A Basket,
  and a Bean Batch of the Recipe's Bean, are read through the tablet's map,
  which moves the Recipe to that batch; one the map does not hold yet, as a
  bag added and picked at once, waits, and is taken in, timed when it was
  observed, as the report of the tablet's batches or baskets maps it
  (`settlePendingParts`). A batch of another Bean is none of the Recipe's,
  as the plugin unloads it then. A value the Recipe holds already is no
  edit.
- **Kept in the Workflow.** Streamline clears the batch, coffee, grinder,
  Basket and RPM after each Shot, and as it starts while DYE2 is not loaded
  or its DYE2 switch is off (`clearDyeWorkflowContext`). That is neither an
  edit nor an unload: while the Recipe is loaded, each clear of one the
  Recipe holds is held as cleared, so its value is written back, once for
  that clear (`KEPT_PARTS`, decentespresso/streamline-js#149), and the next
  Shot records it. A Shot started before the write lands records none.
- **Stale values.** A part set back is stale, no edit, and the Recipe's
  value is written back (into the Workflow, and the record where it differs)
  where it is:
  - the Recipe's previous value, which the tablet's record of it held just
    before the server's latest write of it, set by another tablet or in the
    management interface, as for a stale save (ADR-0005);
  - what the Workflow held of a part the server's write has not changed
    yet, as one Decaid refused for want of a machine, while the Recipe holds
    another, recorded by DYE2 from the Workflow left behind the record
    (`recordedByDye2`); or
  - what the plugin's write of the load replaced (`load_before`, `setBackToLoad`),
    before the Machine's first espresso since the load, for any part the
    load changed but the Grinder, a change of which unloads it (interim for
    DYE2's dashboard copy, decentespresso/dye2#28): DYE2's dashboard reads the
    Workflow once, as it opens, and sends that whole copy back with each
    change made there and on Done. A part the apply set, which the load
    write left alone, is never stale this way. The server checks the
    delivery carrying `loadBefore` as well as later ones: a dashboard tap
    during the load write is merged into that delivery, which takes a part
    holding its before-value as the Workflow's, so the Recipe's is written
    back. For a part DYE2 records, the value it recorded is compared.

  A part set back over the reporting tablet's own latest edit of the field
  is an edit, its barista undoing a tweak, as #176 has it.
- **The same edit once.** A field of the tablet's record that sets the
  Recipe's value its own latest edit set already is no edit
  (`withoutOwnEdits` in `recipe-intake.ts`), so a change a delivery marked
  `unrecorded` brought, which DYE2 may then record too, is one edit.
- **To every Machine that has it loaded.** An edit of a Recipe from
  anywhere, a tablet, the management interface or a Conflict's value used,
  commits with a `NOTIFY` on `library_changes` naming its Location, and
  each writer there plans, after the Recipe's record and the items it names
  (`loadedRecipeDue`, last in `changesDue`), a `write` of the
  `loadedRecipe` kind carrying the Recipe's fields its tablet's Workflow
  holds otherwise, by the tablet's ids, with the names DYE2 copies beside a
  Grinder, a Basket and a batch, each expecting the value the Workflow last
  held, its Profile whole, expecting nothing, as a skin overrides parts of
  the one it loads, and its brew temperature (`profile.steps.0.temperature`,
  its Profile's first step's where the Recipe holds none), with any Profile
  written (`partsWrite`). The plugin judges a change of the Workflow's
  Grinder or Bean by the tablet's record, and DYE2 records the Workflow's
  dial into the record, so the dial and the batch wait until the tablet's
  record of the Recipe, written first, holds them (`heldByRecord`); the rest
  of the write goes ahead. The plugin writes nothing unless the Workflow
  still names the Recipe and DYE2 still has its slot selected, or answers
  404 (it refuses the write otherwise, and the writer tries it again once it
  changes), and sets a part only while it holds the value expected or none,
  so a barista's change since is kept, and reaches the server in the answer,
  where it is the tablet's edit, timed when the plugin had Decaid's answer;
  a brew temperature moves every step of the profile written, or else the
  Workflow's, by the same amount. A write that changed the profile has the
  slot selected again (Selecting again, above). The Workflow change the
  write causes is sent after the answer, which records what Decaid returned
  as the Workflow's (`recordLoadedRecipeWritten`). Decaid refuses hot water
  while no machine is connected: the rest is written, and the hot water
  once the machine is back and the plugin reconnects. A write is made to the
  Workflow of a Machine only while its Loaded Recipe is the Recipe its
  Workflow names; a Machine with no Loaded Recipe keeps its own hot water.
- **Unloads the server decides.** A Workflow naming a Recipe that is not
  its Machine's Loaded Recipe, as one taken out of its slot or Archived, or
  of a Location the Machine left, or the one the server last had as its
  Loaded Recipe as it was made capture-only, is due the same `write`,
  clearing the Workflow's Loaded Recipe (`LOADED_RECIPE_FIELD`, null) while
  it still names that Recipe; the plugin then clears DYE2's selection where
  it still names the Recipe's slot, as last seen, and keeps `{}`. A Recipe
  moved to another slot stays loaded. A Capture-only Machine's writer writes
  this, and nothing else, whatever its reports. The Workflow the plugin
  then sends names none, which unloads it on the server. A recipe selected
  while its Machine is capture-only, which nothing there shares, stays
  selected and recorded into there, as does one loaded on the tablet before
  the switch that the server had not heard of yet, as while offline; once
  its sharing is turned back on, the plugin reads the selection again, and
  it is the Machine's Loaded Recipe where it is one of its Location's
  slotted Recipes. A recipe Streamline applies from a record names its
  Recipe, which the server writes into its embedded Workflow, so Shots
  pulled on a Capture-only Machine can name a Recipe that was never that
  Machine's Loaded Recipe: Shots are linked to Recipes by the Machine's
  Loaded Recipes (`loaded_recipes`, `SHOTS.md`), not by the id alone.

Known limits: a stale copy and a set-back look alike, and are told apart
only by who made the field's latest edit (ADR-0005), and, for what a load
replaced, by whether an espresso has started since. So a barista who
deliberately sets back another Machine's, or the management interface's,
change of a part to its value just before, or a part to exactly what the
load replaced before pulling a Shot, has it written back, and changes it
through another value, or in the management interface. A Workflow naming a
Recipe its Machine has loaded, delivered after a stale one, as from a
tablet that was offline, is compared with what the tablet last held, so
its changes are edits timed when they were observed, and lose to later
edits it had not seen.

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
also shows its current Workflow, loaded every 30 s rather than every 5 s as
the state is, and its Loaded Recipe with its history, loaded again as the
Loaded Recipe changes. Each Location's page lists its Machines and the
Recipe each has loaded.

`server/test/machine-events.test.ts` covers this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL,
`server/test/loaded-recipes.test.ts` the Loaded Recipe,
`server/test/loaded-recipe-following.test.ts` Machines following it both ways, `server/test/loaded-recipe-intake.test.ts` its pure module,
`plugin/test/loaded-recipe-rules.test.ts` the plugin's, and `plugin/test/machine-events.test.ts` what is held back,
`server/test/durable-outbox.test.ts` the deliveries kept across unloads and
their bound, and
`e2e/workflow-and-state.spec.ts` and `e2e/loaded-recipes.spec.ts` the
management interface.
`server/test/binding-deadlocks.test.ts` races deliveries, collections
included, against a hello or an Admin binding the Machine's hardware, in
both orders.
