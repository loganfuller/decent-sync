# Workflow changes and machine state transitions

Ticket [#13](https://github.com/loganfuller/decent-sync/issues/13) extends
protocol version 1 with two deliveries, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `workflow` | `id` (delivery id), `observedAt`, `workflow` (opaque, as Decaid's `workflowUpdated` event gave it) |
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
each Machine's Loaded Recipe (ADR-0022): the Recipe its Workflow was last
loaded from. Neither DYE2 nor Streamline records the recipe it applies, so
the plugin works it out from what it sees on the tablet, and records it in
the Workflow, so a load made while the tablet is offline is recorded too,
and Decaid copies it onto every Shot pulled with it. The server reads it
from the Workflow deliveries.

### Plugin

`plugin/src/loaded-recipes.ts` carries out what the pure
`plugin/src/recipe-matching.ts` decides:

- **Each change in turn.** `MachineEvents` tells it of each Workflow Decaid
  reports before queueing it. A change of the Workflow's dial (its profile,
  dose, yield, grinder and grind setting) or of its Bean Batch, and while
  the plugin is deciding or has a write to make, any change of what a load
  writes, is queued, and the plugin decides on each in turn, from the one
  before it, with DYE2's recipes as it reads them then (`decideChange`).
  Each is decided as though at once, so the outcome is the same however
  long the plugin's reads of Decaid take: what the changes decided on leave
  to write (a load, or clearing the Loaded Recipe) is written once none is
  left to decide on. The first Workflow after a load of the plugin is
  decided on too, and may load a recipe it matches (below), but unloads
  nothing.
  - A change of the dial may load a recipe (A load, below), but only one it
    changed a field of that the recipe sets: a recipe leaving a field blank
    matches whatever the Workflow holds there, so a tweak of the Loaded
    Recipe's grind, or Streamline clearing its grinder, loads no recipe in
    another slot that sets no grind, or no grinder. A batch picked in the
    same change, which no app applying a recipe does, stays as picked, and
    a recipe of another Bean is none it loads.
  - Otherwise a change of the profile, grinder or Bean to one the Loaded
    Recipe does not name unloads it (Unloading, below). A change of the Bean
    Batch alone loads nothing, and only a batch of another Bean unloads, so
    the batch a barista picks stays.
  - Any other change made after a load still to be written is the barista's,
    after it: the load leaves the parts it changed as they were changed,
    the dose of a tweak or a batch of the same Bean, say.
  - A load of the recipe the Workflow names already, with nothing left to
    write, its dial set back or applied again as it is now, writes its
    current dial alone: its RPM, Basket, batch and hot water stay as the
    barista left them, where the Workflow holds a value for them, so the
    Recipe applied again after Streamline cleared them has them written
    back. A stale copy of it, matching only a dial it held before, has all
    but its batch corrected, as no app applying a recipe sets one. The
    barista's changes of the dial before such a match are no longer kept:
    the match sets it again. A part the barista cleared on purpose is
    written back as well, as a cleared part cannot tell who cleared it.
  - The first Workflow, as on every load of the plugin, is no change. One
    naming a recipe it matches is written that recipe's dial alone, and one
    naming none loads no recipe of another Bean than its batch's, as when
    the barista unloaded it so before the plugin last unloaded.
- **Held or sent at once.** A change is held back (Held back, below) if the
  Workflow names a Loaded Recipe, which it may unload or replace, or matches
  a recipe as the tablet held it when last read, or a write is still to be
  made. Any other is sent at once, kept in Decaid's plugin storage as it is
  queued, so an unload of the plugin meanwhile loses none (Kept across
  unloads, above): it names no Recipe the server could take it for, and the
  Workflow after a load the plugin then finds, of a recipe saved since it
  last read them, is sent after it.
- **When Decaid fails.** A decision or write Decaid fails (a read or write
  it refuses or leaves unanswered) leaves the changes still to decide on
  and the write still to make as they were, tried again after 5 s, doubling
  to 5 minutes, as no change may come to try them; the Workflow is sent
  meanwhile, as it is.
- **A load.** The Workflow matches one of the tablet's recipes in a Recipe
  Slot carrying its Recipe's global id (`chooseLoad`): every field of the
  five the recipe sets, the Workflow holds, and it sets at least one. A
  recipe has two dials, one each way it is applied: DYE2's dashboard applies
  its `dashboardVariables` and `profileSnapshot`, or the tablet's profile its
  `profileId` names, its yield its dose times its ratio where it holds none,
  and Streamline's strip applies the Workflow embedded in it, which its
  auto-save leaves behind the dial until the server writes it again. A
  grind setting is compared as a number where both read as one, as Decaid
  keeps DYE2's 3 as "3". A Profile carries no id in the Workflow, so it is
  compared by what Decaid hashes for a Profile's id
  (`ProfileHash.calculateProfileHash`), but for what a skin overrides as it
  loads one, its target weight and each step's temperature, and with a
  limiter of value 0 read as none, as a Shot's Profile is found
  (`profileKey`). The match may be with the recipe's record now, or with any
  record of it the tablet held since the plugin loaded, as a DYE2 page or
  Streamline strip opened before the server's latest write applies: the
  plugin keeps, for each Recipe, the dials it held before, from each read of
  DYE2's recipes, its own and `CollectionCapture`'s, at most 20 per Recipe
  (`MAX_EARLIER_DIALS`). Of several matches, the Recipe the Workflow names as
  loaded already wins, then the lowest slot.
- **Recording a load.** The plugin reads the Workflow again, and while it
  holds all a load writes as the Workflow last decided on does
  (`changedParts`), writes into it in one `PUT /workflow`, which Decaid
  merges into it; where Decaid holds a later change, that is decided on
  first, as the next change, and the write made after. It writes what the
  Workflow holds otherwise of the recipe's current dose,
  yield, grind setting, grinder, RPM, Basket and Profile (the full Profile,
  only where its `profileKey` differs), as DYE2 applies them, its Bean Batch
  (`context.beanBatchId`, with its Bean's name and roaster as
  `coffeeName` and `coffeeRoaster`, read from the tablet's records), which
  applying a DYE2 recipe never sets, its four hot water settings from the
  record's own field (RECIPE_FIELD), and the Recipe's global id in
  `context.extras` under LOADED_RECIPE_KEY (`loadWrite`). A value the
  recipe holds none of is left as the Workflow has it. Decaid refuses to
  change the hot water settings while no machine is connected, so the rest
  is then written without them, the Workflow read and checked again first.
  A part changed after the load was decided on is not written. The echo of
  the write, the Workflow Decaid answers it with, is no change: the changes
  Decaid reports before it were made before it took the write, and are
  decided on with the load still pending, as a grinder a barista picked
  then, which the write leaves, unloads it; the load is done once the echo
  is decided on, unless they changed what is pending. Decaid reports each
  change as it sets it, ahead of answering, so where the plugin's read finds
  a change, it waits up to 2 s for Decaid's report of it, and of its write's
  echo, and only where none comes decides on the Workflow it read, or takes
  the answer for the echo. Streamline
  adopts a Workflow change made elsewhere (ADR-0021), so it takes the hot
  water as its own, and the plugin sets none of its values.
- **Unloading.** A change of the Workflow's profile, grinder or Bean (its
  batch's Bean, read from the tablet's batch record) to one the Loaded
  Recipe, as the tablet holds it now, does not name unloads it
  (`unloads`): the plugin sets the key to null, as Decaid keeps a
  Workflow's `extras` whole and merges a write into them key by key, read
  and checked first as a load is. A grinder changed and set back again
  unloads it all the same, as it would had each change been decided at
  once; the Workflow set back loads it again only where it matches it. One
  the recipe names none of, or a grinder or batch cleared, unloads nothing:
  Streamline clears the Workflow's batch, grinder, barista, drinker, Basket
  and RPM once each Shot is stored (`clearDyeWorkflowContext`), so they do
  not label the next Shot, and the Recipe stays loaded through it, its id
  kept, as Decaid merges `extras` key by key. A tweak of
  the dose, yield or grind setting keeps it. Another recipe loaded replaces
  it. A Loaded Recipe the tablet no longer holds in a slot is left for the
  server to unload (#146).
- **Held back.** `MachineEvents` holds the Workflow's changes while any of
  the plugin's writes into it is under way, a count shared with the writes
  of the shared settings, and sends the latest once none is. So the server
  reads only the Workflow after the plugin's write, the Recipe's id in it,
  and never a Workflow naming a Loaded Recipe as a stale copy or another
  recipe applied over it. A welcome's resend of the Workflow asked for
  while held is the Workflow released, which the next welcome replaces
  unless it was ever sent, but where a change was held too: replacing that
  would lose the change. A held change is kept in plugin storage only once
  it is queued: an unload of the plugin while one is held loses it, and the
  Workflow Decaid sends as the plugin loads again brings the current one.

Known limits: Decaid has no conditional write, so a barista's change of
a field a load writes, made in the moments between the plugin's last read
of the Workflow and its write, is written over, as for a settings write
(ADR-0021); the plugin reads everything else it needs first, to keep that
window to one request. The dials a recipe held before are kept only in memory, so a
copy read before the plugin loaded, as a DYE2 page open across a reload of
the plugin, is matched only where its dial is the recipe's now. A barista
who dials in exactly a dial the Loaded Recipe held before, on its Machine,
has the recipe's current one written back, as for a stale copy. DYE2's
dashboard sends the whole Workflow it read as it opened when its Done is
tapped, so a load the plugin writes while it is open is undone then, the
same limit as a change between the plugin's read and its write, held open
longer. The
recipe the Workflow names, applied again after its batch was changed
elsewhere, keeps the Workflow's batch until #146 follows the Recipe's edits.
The plugin judges nothing of what changed while it was not loaded: a
Workflow naming a recipe with another Bean's batch or grinder stays as it is
until its next change, and one applied over another Bean's batch while the
plugin reloaded, as after a change of its settings, is loaded only on the
Workflow's next change of its dial.

### Server

The Loaded Recipe a Workflow delivery names is taken into its Machine's
state in the transaction storing it, from a connection that is not
mismatched, for its token's Machine, after its Location's settings
(`takeInLoadedRecipe` in `server/src/machine-events/loaded-recipes.ts`):
one of the Recipes of the Machine's Location while it takes part in the
Library there, and none otherwise, as on a Capture-only Machine, or one the
Workflow names from a Location the Machine left. Each Machine's Loaded
Recipes are kept in `loaded_recipes`, the Recipe from when to when, its
current one the entry not unloaded, at most one per Machine. A change of it
unloads the current one and loads the new one at the time the plugin
observed the Workflow, by the tablet's clock, which a delivery made offline
keeps, but never before the Machine's latest entry. The Recipe's row is
taken `FOR KEY SHARE` after the tablet's lock, and the Location's where
taking in the Workflow's settings takes it, as when joining, which a hard
delete of the Recipe takes before its row; the hard delete removes its
entries. A Machine made capture-only shows no Loaded Recipe from its next
Workflow delivery on; a change of Location asks for one at once. No `NOTIFY`
is sent: nothing yet follows a Loaded Recipe across instances, which #146
adds.

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
`server/test/loaded-recipes.test.ts` the Loaded Recipe, `server/test/loaded-recipe-races.test.ts` changes made while one is decided,
`plugin/test/recipe-matching.test.ts` its pure module,
`server/test/durable-outbox.test.ts` the deliveries kept across unloads and
their bound, and
`e2e/workflow-and-state.spec.ts` and `e2e/loaded-recipes.spec.ts` the
management interface.
`server/test/binding-deadlocks.test.ts` races deliveries, collections
included, against a hello or an Admin binding the Machine's hardware, in
both orders.
