# Workflow changes and machine state transitions

Ticket [#13](https://github.com/loganfuller/decent-sync/issues/13) extends
protocol version 1 with two deliveries, defined and validated in `protocol/`:

| Direction | Message | Fields |
|---|---|---|
| Plugin to server | `workflow` | `id` (delivery id), `observedAt`, `workflow` (opaque, as Decaid's `workflowUpdated` event gave it), from #177 `loadBefore`, and from #189 `dye2Absent` (The Loaded Recipe, below) |
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
Recipe is taken in (The Loaded Recipe, below). Its steam and rinse settings
are each Machine's own, and no change of them is an edit (ticket #190,
`LIBRARY.md`, Steam and rinse settings). While the plugin writes into the
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
[#177](https://github.com/loganfuller/decent-sync/issues/177) makes it the
recipe DYE2 has selected on the tablet. DYE2 keeps one selected recipe or
favourite, which its dashboard and Streamline's DYE strip select as they
apply one (`dye2:dye2-plugin/src/utils/workflow-record.ts`, at `2cf631c`,
the supported floor, ADR-0017).
DYE2 writes its selection into the Workflow
(`context.extras.dye.selection`, `{kind, id}` or null, DYE2_SELECTION_FIELD,
decentespresso/dye2#20), so a selection made while the tablet is offline is
recorded too, and Decaid copies it onto every Shot pulled with it. Ticket
[#189](https://github.com/loganfuller/decent-sync/issues/189) has the server
read the Loaded Recipe from it in the Workflow deliveries; the plugin
follows the selection, writing nothing of it into the Workflow.

### Plugin

`plugin/src/loaded-recipes.ts` follows DYE2's selection, through
`plugin/src/dye2-selection.ts`, and writes what the pure
`plugin/src/loaded-recipe-rules.ts` works out:

- **Reading the selection.** The plugin reads `GET
  /api/v1/plugins/dye2.reaplugin/selection` on each push on DYE2's
  `changed` socket (`/ws/v1/plugins/dye2.reaplugin/changed`, opened through
  `host.transport` and counted, with the connections to the server, against
  Decaid's 8 transports, leaving one for the server), about 2 s after the
  latest change of the Workflow it holds back, past DYE2's 1.5 s wait
  before it records, which decides on the changes held back meanwhile
  (below), and on its poll (the plugin's poll interval), when it also reads
  `GET /api/v1/plugins`. A change it does not hold back is read after by
  no one: DYE2 pushes on every change of which item it has selected, a
  clear included (decentespresso/dye2#24). Each read reads DYE2's recipes
  too, and is one piece of work in one queue, in turn.
- **DYE2's recipes on each push.** DYE2 pushes after it records into its
  selected recipe, so on each push the plugin also reads DYE2's recipes as
  its poll of the tablet's lists does (`CollectionCapture.readRecipes`,
  while connected), and sends them if they changed: a recording reaches the
  server within seconds, not only on that poll.
- **What it decides.** A selection of a recipe in a Recipe Slot carrying a
  Recipe's global id, made on the Workflow as it holds it now
  (`selectedOn`), loads that Recipe where the plugin has not loaded it
  already. Made on it is DYE2's own test of a change off a selection
  (`profileDrifted` and `contextDrifted`): its `profileFingerprint` equal
  to `dye2Fingerprint` of the Workflow's profile, and its
  `armedBeanBatchId` and `armedGrinderId` equal to the Workflow's batch and
  grinder, each answered as none counting as no difference, as DYE2 then
  takes the first one set. Any other selection, a favourite, a recipe of no
  Recipe's slot or made on another profile, batch or grinder, or none,
  unloads the Loaded Recipe. A 404
  tells nothing: DYE2 is not loaded, as while it reloads or updates, and
  records nothing. A first answer of none after the plugin loads, or after
  a 404, is taken only once a later read confirms it, at the latest on the
  poll, as DYE2 restores its stored selection after its load (`onLoad`,
  then `storageRead`). The Machine has no Loaded Recipe where Decaid's
  plugins list has no DYE2, or one neither loaded nor to load at startup
  (`loaded` and `autoLoad` both false), at once, or one not loaded for
  longer than twice the poll interval: the plugin unloads it, drops a
  selection of its own still to make, and keeps a clear, and delivers the
  Workflow again with `dye2Absent`, where DYE2's field there names
  something, as it does every Workflow until DYE2 is back, whatever DYE2's
  field last named. A loaded DYE2 counts whatever its
  `autoLoad`. Dialling in a Recipe's values by hand loads nothing.
- **Holding the Workflow back.** While a Recipe is loaded, or the
  Workflow's DYE2 field names one, each change of the Workflow is held back
  (Held back, below) until a read of the selection after it decides on it,
  no selection of the plugin's is still to land, nor the Loaded Recipe
  moving to another slot, and the latest Workflow's field names what DYE2
  answered, at most 10 s, when the Workflow goes as it is. DYE2 writes its
  field after the change that changed its selection, so the server never
  reads a recipe applied from DYE2's dashboard, whose hot water the
  Workflow reports while the field still names the Recipe loaded before,
  as an edit of that one (until #173), nor the null DYE2 writes as it
  clears its selection on the plugin's own write, which the plugin selects
  again (Selecting again, below), as an unload. Not while DYE2 answered 404
  last, as no read can decide then. The Recipe the first Workflow's field
  names after the plugin loads is the one it takes as loaded until it
  decides.
- **A load.** Once DYE2 is found still to have the slot selected, or
  answers 404, the plugin reads the Workflow and writes into it, in one
  `PUT /workflow`, which Decaid merges into it, what it holds otherwise of
  the recipe's current dose, yield (its dose times its ratio where it holds
  none), grind setting, grinder, RPM, Basket and Profile (whole, at the
  recipe's brew temperature, from its embedded Workflow, else its
  `profileSnapshot` or the tablet's record of its `profileId`, only where
  its `profileKey` differs), its Bean Batch (`beanBatchId`) with its Bean's
  name and roaster (`beanName`, `beanRoaster`) as `coffeeName` and
  `coffeeRoaster`, and all four hot water settings from the record's own
  field (RECIPE_FIELD) (`loadWrite`). It writes no Recipe id, and no
  brew temperature: DYE2's dashboard applies a recipe's, moving its profile
  as Streamline's Brew tile does (`shiftedTemperatures` in
  `streamline-js:src/modules/brew-temp.js`), the first step to it and every
  other by the same amount, and Streamline's strip applies the record's
  embedded Workflow, which holds its profile so moved
  (decentespresso/dye2#26). Both apply its batch too
  (decentespresso/dye2#27), so the load write writes it only over a stale
  copy, and a stale copy's brew temperature is written by the server's
  Loaded Recipe write after the load (To every Machine that has it loaded,
  below). Decaid refuses to change the hot water settings while no
  machine is connected, so the rest is then written without them. With the
  write, the plugin attaches to the next Workflow delivery queued
  (`WorkflowDelivery.loadBefore`) each part it changed but the Profile, what
  the Workflow held of it before and what it wrote, so the server can tell a part set
  back to its value before the load (Stale values, below). A write that
  changes what DYE2 clears its selection on, the profile, by DYE2's
  fingerprint, as one from a stale copy or of another Profile, or the batch
  or grinder, as one over a stale copy's (`clearsSelection`, judged by what
  the write sets, not by Decaid's answer, which holds a barista's change made
  meanwhile too), has DYE2 clear it: the plugin selects the slot again right
  after, as DYE2's dashboard does after an apply, where DYE2 answers none or
  still that slot (Selecting again, below). Selecting cancels a record DYE2 had pending, so a brew
  temperature changed in the 1.5 s before it is not recorded. Streamline
  adopts a Workflow change made elsewhere (ADR-0021), so it takes the hot
  water as its own, and the plugin sets none of its values.
- **An unload on a change of grinder or batch.** DYE2 clears its selection
  itself on a change of the Workflow's batch or grinder off the one it held
  as the recipe was selected, a clear of either included, another batch of
  the Recipe's Bean too (decentespresso/dye2#19), so its clear unloads the
  Recipe, and the Recipe keeps its batch: a Recipe is the dial-in for one
  roast. The plugin makes no unload or clear of its own for them, and looks
  up no batch's Bean (#188). A batch or grinder set back to the one the load
  replaced is such a change too, so nothing is written back.
- **Selecting again.** A selection or clear of the plugin's that Decaid
  fails, or that DYE2 answers 404, is tried again at the next read once DYE2
  answers (unlike #176's, which took a 404 as done), and gives way to
  something else DYE2 selected since. DYE2 answering that slot still, but
  made on another Workflow than it holds now, as before it has handled the
  write, has the slot selected again too. None is made while a write of
  the server's it is for is yet to answer; one Decaid never answers may
  have landed, so the slot is then selected again once DYE2 has none. A
  write of the plugin's that DYE2 clears its selection on selects the slot
  again only where the Workflow it wrote over still held what the selection
  was made on, as DYE2 last answered it (`reselectAfter`): a barista who
  changed the profile, batch or grinder first, as while DYE2 answered 404,
  had DYE2 clear it, or will once DYE2 restores it. And a selection to be
  made again is dropped once the Workflow moves off what the write left, as
  a barista picking another batch before it was made. Until a selection of
  the plugin's lands, its reads do not unload the Recipe, and the Workflow's
  changes stay held back, so the server reads one change, the field naming
  the slot again.
- **DYE2's stored selection.** DYE2 keeps its selection in its plugin
  storage and restores it as it loads, storing a cleared one as `{}` itself
  (decentespresso/dye2#22); the plugin never writes that store key. It keeps
  the one it had as it unloads, which it restores over a Bean or grinder
  switched meanwhile: made on another batch or grinder, the plugin writes
  no load for it (What it decides, above), and refuses the server's writes
  for it (`mayWrite`), though the field, which DYE2 restores unchanged, has
  the server take it as loaded until DYE2 clears it at the Workflow's next
  change. One restored over no such switch loads its Recipe again.
- **Moving to another slot.** Before a post of DYE2's recipes the server's
  write makes that moves the Loaded Recipe out of its slot, the plugin clears
  DYE2's selection of the old slot, so DYE2 never records into a recipe put
  there; once it is posted in another, it selects the new slot. Reads decide
  nothing meanwhile. The server's clear of a Recipe that left every slot clears no slot holding
  another Recipe's record by then, whose selection the barista made.
- **A slot emptied or filled anew.** DYE2 keeps its selection through its
  recipe's removal from the list. So before a post of DYE2's recipes that
  removes the recipe in a slot DYE2 has selected, or replaces it with
  another Recipe's record (`vacatedSlots` in `loaded-recipe-rules.ts`), as
  the server's writes do as a Machine joins a Location (`LIBRARY.md`,
  Joining a Location), the plugin clears that selection, which DYE2 stores
  cleared, whether or not the recipe is the Loaded Recipe: DYE2 would otherwise
  record into the recipe put there, and the plugin load it. A record given
  its global id, as one a Location takes in, is the same recipe. A clear
  DYE2 answers 404 to is tried again once it answers.
- **Capture-only.** The server tells the plugin whether its Machine is
  capture-only (`captureOnly`, sent after `welcome` and whenever it
  changes). On one, the plugin loads nothing, unloads nothing and runs none
  of the workarounds above; a recipe selected there stays selected and
  recorded into. Until told, as offline, it takes its Machine to take part.
- **Held back.** `MachineEvents` holds the Workflow's changes while any of
  the plugin's writes into it is under way, or a decision on one is, a
  count shared with the Library's writes into the Workflow, as a joining
  tablet's clear (`LIBRARY.md`, Joining a Location), and sends the
  latest once none is, then the changes of the machine's state reported
  meanwhile, each as observed. So the server reads a Workflow change
  reported before a change of state, as a DYE2 dashboard's send just before
  an espresso, before it. A change of the Workflow during a write of the
  plugin's is that write's echo, which the write holds. A welcome's resend
  of the Workflow asked for while held is the Workflow released, which the
  next welcome replaces unless it was ever sent, but where a change was held
  too: replacing that would lose the change. What a delivery carries
  besides the Workflow (`loadBefore`) goes to the next one
  queued, held or not, and to the resend that replaces it; where several
  loads come before one delivery, each part keeps its earliest `before`. A
  held change, and a held change of state, is kept in plugin storage only
  once it is queued: an unload of the plugin while one is held loses it.
- **When Decaid fails.** A read or write Decaid fails is logged once until
  one succeeds, and tried again at the next read, push or poll.

Known limits: Decaid has no conditional write, so a barista's change of a
field a write sets, made in the moment between the plugin's read and its
write, is written over (ADR-0021); and a barista
selecting another recipe in the moment between the plugin's check of the
selection and its write has the write land there. A held change of state
is lost if the plugin stops meanwhile; the window for a part set back
(below) then stays open to the next espresso. ADR-0022 lists the gaps
accepted until DYE2 and Streamline fix them upstream.

### Server

A Workflow delivery names the Recipe whose record is in the slot of the
recipe its DYE2 field names, by the tablet's map of its recipes' slots
(`tablet_recipes`, read under the tablet's lock), and none for a favourite,
nothing, or any field while it carries `dye2Absent` (`selectedRecipe`). That
Loaded Recipe is taken into its Machine's state in the transaction storing it, from a connection that is not
mismatched, for its token's Machine, after the tablet's lock and its
Workflow's grinder, batch and Basket (`takeInWorkflow` in
`server/src/library/joining.ts`, which has `takeInLoadedRecipe` in
`server/src/machine-events/loaded-recipes.ts` take it in): one of the
Recipes in a slot of the Machine's Location while it takes part in the
Library there, and none otherwise, as on a Capture-only Machine, or
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
load's before, until a `machineState` delivery from the Machine's own tablet
of `espresso`, after a stored state that was not, clears it
(`espressoStarted`), in delivery order: Decaid reports each substate of a
Shot, and the plugin resends the state on every welcome.

### Following the Recipe

Tickets [#146](https://github.com/loganfuller/decent-sync/issues/146),
#177 and #187 have a Machine follow its Loaded Recipe both ways (ADR-0022). The parts
of a Workflow that follow it are its Profile, Grinder, dose, yield, grind
setting, RPM, Basket, Bean Batch, four hot water settings and brew
temperature, its profile's first step's (`LOADED_RECIPE_PARTS` in
`protocol/`). Its Grinder is `grinderId` and `grinderModel`, as DYE2 applies a
recipe's, not the grinder's burrs: Decaid copies onto each Shot it pulls
the burrs of the grinder the Shot names (`PersistenceController.persistShot`
in `decaid:lib/src/controllers/persistence_controller.dart`) and leaves the
Workflow's alone, so Shots record the burrs of the grinder loaded, while the
Workflow may go on showing a previous grinder's. The Workflow's Profile is
held as the Library Profile it is, found as a Shot's is (`profileOfSql`).
The server keeps, per tablet, the Recipe its Workflow last named and those parts as the Workflow held them,
reported, recorded by DYE2, or as Decaid returned the plugin's write of
them (`tablet_loaded_recipes`), so the plugin's own write is never read as the
tablet's edit. The pure `server/src/library/loaded-recipe-intake.ts` maps
the parts to the Recipe's content both ways.

- **What DYE2 records.** DYE2 records a change of the Workflow's dose,
  yield, grind setting, RPM, Basket, brew temperature, and hot water volume
  and temperature, into the recipe's record (`RECORDED_PARTS`,
  decentespresso/dye2#21), which the plugin reports with DYE2's recipes:
  the tablet's change of the record, taken in as any is (`LIBRARY.md`,
  Taking in a tablet's recipes). It records only a field the record holds,
  so a Recipe with no RPM or Basket gains one only by an edit in DYE2's
  editor or the management interface. The Workflow's change of them is no
  edit: DYE2 is their only recorder, so the change is one edit. Each value
  recorded is held as the Workflow's (`recordedByDye2`), one a stale save's
  rule takes as unchanged (`before_write`) too, as it is still what the
  Workflow holds. So is a recording the plugin's read of the list caught
  just before its post, as the answer to the post carries it
  (`recordRecipeWritten`). The server writes both the hot water volume and
  temperature into each record, whatever the Recipe's mode, as DYE2 holds
  each once it moves, and carries into the embedded Workflow it writes the
  steam, hot water and flush settings and field flags DYE2 copies there
  (`withHeldWorkflowSettings`), so no write of the server's takes out one
  DYE2 then records back: that kept a read and post of the list under way at nearly
  every recording, and DYE2's recording at risk of being lost to it
  (ADR-0005). A save of DYE2's editor, which stamps the
  record's `capturedAt` anew where a recording keeps it (`savedInEditor`),
  is no recording: the parts DYE2 records are held as the tablet's latest
  Workflow holds them (`heldAfterEditorSave`), whatever the report brings
  with it, so the save's values are written into the Workflow of every
  Machine that has the Recipe loaded, the saving one's included. Where DYE2
  recorded a change whose Workflow reaches the server only after the report,
  the write of it finds the Workflow holding the value written already,
  which the plugin writes all the same, so its answer has it held. DYE2
  applies no save to the Workflow, so a change of that Workflow before the
  save is reported has DYE2 record its old values back over the save, which
  the server never sees (an accepted gap, ADR-0022, decentespresso/dye2#33). DYE2 never records a batch: another batch on the
  Machine, of the Recipe's Bean or not, unloads it (An unload on a change of
  grinder or batch, above). Where the Recipe holds no batch, DYE2 takes the
  first one picked as the one it was applied with
  (decentespresso/dye2#19), so the Recipe stays loaded, and stays without
  one until an edit gives it one, which, written into that Workflow, DYE2
  clears its selection on, and the plugin selects it again (To every
  Machine that has it loaded, below). Its
  steam and flush values are no edit, recorded or in the Workflow: they
  stay the Machine's own (`LIBRARY.md`, Steam and rinse settings).
- **What the Workflow edits.** A Workflow delivery naming the Recipe its
  Machine went on having loaded, not as it joins its Location, is the
  tablet's edit of the Recipe in its hot water duration and flow
  (`WORKFLOW_EDITED_PARTS`), whose record fields the server does not take
  in, until a Recipe holds them as DYE2's recipe does (#173), each it holds otherwise than it last did, timed when
  the plugin observed it, merged
  with what the Workflow had seen of the Recipe's edits (ADR-0020), from the
  Machine's tablet, whatever app made it. What the Workflow has seen is,
  from a load, what the tablet's record of the Recipe had seen, and from the
  answer to a write of it, the latest edit of the Recipe the write carried,
  once the Workflow holds every part of the Recipe but one naming an item
  its Location no longer offers the tablet, as a Basket Archived there
  (`holdsWhole`). A hot water setting is the Recipe's as it is (`partEdits`,
  which reads a dose, yield, RPM or brew temperature as it is too, and a
  grind setting as the number DYE2 keeps, keeping DYE2's ratio only while
  the yield is the dose times it). A value the Recipe holds already is no
  edit.
- **Kept in the Workflow.** While DYE2 has a recipe selected, Streamline's
  clear after each Shot leaves the batch, coffee, grinder, Basket and RPM,
  and clears only the barista, drinker and note
  (`clearDyeWorkflowContext`, decentespresso/streamline-js#149), so the next
  Shot records the Recipe's. Where DYE2 is loaded and Streamline's DYE2
  switch on but DYE2's stored selection names no recipe, Streamline still
  clears them; where DYE2 is not loaded or the switch is off, it leaves
  them. A part cleared is neither an edit nor an unload, and is held as it
  was, so nothing is written back (ADR-0022's accepted gaps).
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
    load changed but the Grinder and batch, a change of which unloads it (interim for
    DYE2's dashboard copy, decentespresso/dye2#31): DYE2's dashboard reads the
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
  (`withoutOwnEdits` in `recipe-intake.ts`), so a change the Workflow
  brought, which DYE2 records too, as the hot water volume of a Recipe by
  temperature, is one edit.
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
  written (`partsWrite`). DYE2 records the Workflow's dial, RPM and Basket
  into the record, so they wait until the tablet's record of the Recipe,
  written first, holds them (`heldByRecord`); the rest of the write goes
  ahead, its Grinder and batch included. The plugin writes nothing unless
  DYE2 still has the Recipe's slot selected, made on the Workflow as it
  holds it now (`selectedOn`), or answers 404, or has nothing selected
  while the plugin is still to select the slot again after a write of its
  own (it refuses the write otherwise, and the writer tries it again once it
  changes), and sets a part only while it holds the value expected, the value written or none,
  so a barista's change since is kept, and reaches the server in the answer,
  where it is the tablet's edit, timed when the plugin had Decaid's answer;
  a brew temperature moves every step of the profile written, or else the
  Workflow's, by the same amount. A write that changed the profile, batch
  or grinder, which DYE2 clears its selection on, has the slot selected
  again (Selecting again, above), so an edit of the Recipe's batch or
  grinder leaves it loaded on every Machine (#188). The Workflow change the
  write causes is sent after the answer, which records what Decaid returned
  as the Workflow's (`recordLoadedRecipeWritten`), where its DYE2 field
  still names the Recipe, or names nothing after a write of the profile,
  batch or grinder, as the plugin is selecting the slot again. Decaid refuses hot water
  while no machine is connected: the rest is written, and the hot water
  once the machine is back and the plugin reconnects. A write is made to the
  Workflow of a Machine only while its Loaded Recipe is the Recipe its
  Workflow's DYE2 field names; a Machine with no Loaded Recipe keeps its
  own hot water.
- **Unloads the server decides.** A Workflow naming a Recipe that is not
  its Machine's Loaded Recipe, as one taken out of its slot or Archived, or
  of a Location the Machine left, as it joins another (ticket
  [#148](https://github.com/loganfuller/decent-sync/issues/148)), or the
  one the server last had as its Loaded Recipe as it was made capture-only,
  is due the same `write`, naming DYE2's field (`DYE2_SELECTION_FIELD`,
  null): the plugin clears DYE2's selection where it still names the
  Recipe's slot, as last seen, writing nothing into the Workflow, and
  answers naming that field, which has the server no longer hold the
  Workflow's parts for the Recipe. A Recipe moved to another slot stays
  loaded. A Capture-only Machine's writer writes this, and nothing else,
  whatever its reports. DYE2 writes its field as it clears its selection,
  and the Workflow the plugin then sends names none, which unloads it on
  the server. A recipe selected
  while its Machine is capture-only, which nothing there shares, stays
  selected and recorded into there, as does one loaded on the tablet before
  the switch that the server had not heard of yet, as while offline; once
  its sharing is turned back on, the plugin reads the selection again, and
  it is the Machine's Loaded Recipe where it is one of its Location's
  slotted Recipes. DYE2's field names a recipe selected on a Capture-only
  Machine too, so Shots pulled there can name a Recipe that was never that
  Machine's Loaded Recipe: Shots are linked to Recipes by the Machine's
  Loaded Recipes (`loaded_recipes`, `SHOTS.md`), not by the field alone.

Known limits: a stale copy and a set-back look alike, and are told apart
only by who made the field's latest edit (ADR-0005), and, for what a load
replaced, by whether an espresso has started since. DYE2's recording
reaches the server with the tablet's recipes on DYE2's push after it
records, so a set-back it recorded within seconds of an espresso starting
can still be judged after it, and taken as an edit. So a barista who
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
also shows its current Workflow, its fields as a Shot's page shows them
(`web/src/components/workflow.tsx`), loaded every 30 s rather than every 5 s as
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
