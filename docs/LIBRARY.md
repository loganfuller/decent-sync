# The Library

Ticket [#80](https://github.com/loganfuller/decent-sync/issues/80) starts
milestone 2's Library ([#77](https://github.com/loganfuller/decent-sync/issues/77))
with Beans: a Bean entered on a tablet joins the Library and is written to the
other tablets at that tablet's Location. Ticket
[#81](https://github.com/loganfuller/decent-sync/issues/81) adds Bean Batches,
each at the Locations it was added to and not yet finished at, with its
remaining weight at each, and offers each Bean where its batches are. Ticket
[#82](https://github.com/loganfuller/decent-sync/issues/82) adds Profiles,
each shown or hidden at each Location, and ticket
[#83](https://github.com/loganfuller/decent-sync/issues/83) Grinders, each
belonging to one Location. Ticket
[#84](https://github.com/loganfuller/decent-sync/issues/84) has an edit of
an item's content on any tablet reach every tablet that holds it, merged per
field with the latest edit winning, keeping each accepted edit as a history
entry and each that lost as a Conflict (Edits, below), and ticket
[#85](https://github.com/loganfuller/decent-sync/issues/85) shows the
Conflicts and each item's history in the management interface, where a
Conflict's value is used or the Conflict dismissed (Resolving Conflicts,
below). Ticket [#86](https://github.com/loganfuller/decent-sync/issues/86)
shared each Location's steam, hot water and rinse settings between its
Machines, ticket [#137](https://github.com/loganfuller/decent-sync/issues/137)
took hot water out of them, and ticket
[#190](https://github.com/loganfuller/decent-sync/issues/190) the rest, each
Machine's own, until ticket
[#173](https://github.com/loganfuller/decent-sync/issues/173) had a Recipe
hold every steam, hot water and flush setting, as DYE2's recipe does (Steam,
hot water and flush settings, below). Ticket
[#87](https://github.com/loganfuller/decent-sync/issues/87) creates and edits
Beans, Bean Batches and Grinders in the management interface, Archives and
restores them, adds and finishes batches at Locations there, and lets an
Admin hard-delete an item no Shot names (Editing in the management
interface, below), and ticket
[#88](https://github.com/loganfuller/decent-sync/issues/88) shows and hides
Profiles at Locations there, which is how a lab Profile reaches a cafe,
Archives and restores them, and lets an Admin hard-delete one. Ticket
[#89](https://github.com/loganfuller/decent-sync/issues/89) has a Machine
joining a Location take on its state, clearing its Workflow's grinder and
batch where the Location does not offer them (Joining a Location, below),
and ticket [#90](https://github.com/loganfuller/decent-sync/issues/90) lets
an Admin turn a Machine's sharing off, making it a Capture-only Machine,
and back on, which joins its Location again (Who takes part, below), and
has a joining Machine bring nothing of its own to a Location that offers
items of that kind already, archiving or hiding them on its tablet
instead. Ticket [#92](https://github.com/loganfuller/decent-sync/issues/92)
links each Shot to the Bean Batch, Grinder and Profile it used, through its
tablet's map, so Shots are filtered by them and each item's page lists its
Shots (`SHOTS.md`, Links to the Library). Ticket
[#130](https://github.com/loganfuller/decent-sync/issues/130) had the plugin
set the values Streamline remembers of the settings it writes, until
Streamline itself took a change made elsewhere (Steam, hot water and flush
settings, below). Ticket
[#135](https://github.com/loganfuller/decent-sync/issues/135) describes each
kind of Library item once on each side, so milestone 3's kinds are each
added in one place (Adding a Library kind, below). Ticket
[#138](https://github.com/loganfuller/decent-sync/issues/138) adds Baskets
and Tools, which DYE2 keeps in lists in Decaid's store: taken in from those
lists, shown or hidden at each Location, and written back to them (Taking in
a tablet's baskets and tools, below). Ticket
[#140](https://github.com/loganfuller/decent-sync/issues/140) adds Recipes,
DYE2's recipes, each belonging to one Location and in one of its Recipe
Slots or none: taken in from DYE2's recipes, and each Location's Recipes
written to its tablets, naming what they use by each tablet's own ids
(Taking in a tablet's recipes, below), which ticket
[#216](https://github.com/loganfuller/decent-sync/issues/216) has written
under one record id each, the same on every tablet there, with their slots
as DYE2's `stripSlot`, nine to a Location, of which Streamline's DYE strip
shows 1 to 5 (tickets
[#506](https://github.com/loganfuller/decent-sync/issues/506) and
[#502](https://github.com/loganfuller/decent-sync/issues/502)), every Recipe
not Archived on every tablet there; ticket
[#143](https://github.com/loganfuller/decent-sync/issues/143) has the
management interface create and edit them, move them between slots, and
Archive and restore them, and ticket
[#144](https://github.com/loganfuller/decent-sync/issues/144) copy one to a
Location (Editing in the management interface, below). Ticket
[#147](https://github.com/loganfuller/decent-sync/issues/147) links each
Shot to the Recipe its Machine had loaded and the Basket DYE2 recorded
(`SHOTS.md`, Links to the Library), and lets an Admin hard-delete a Recipe
no Shot was pulled with, and a Basket or Tool no Shot or Recipe names (Hard
deletes, below). Ticket [#148](https://github.com/loganfuller/decent-sync/issues/148)
has a Machine joining a Location take on its Recipes, and drop its own
recipes, baskets and tools unless the Location has none of their kind yet,
its Workflow losing a Basket the Location does not show and a Loaded Recipe
of another Location, whose `recipeId` is cleared from it (Joining a
Location, below). It
follows ADR-0003, ADR-0005, ADR-0006, ADR-0008, ADR-0016, ADR-0018,
ADR-0019, ADR-0020 and ADR-0021.

## Who takes part

A Machine takes part while it is at a Location, the Location of the latest
entry of its Location History, with its sharing on. A Machine with no
Location is a Capture-only Machine, and so is one an Admin turned sharing
off for (`machines.sharing`, on by default): its tablet's beans, bean
batches, grinders and profiles, and its Workflow, are captured as in
milestone 1 (`COLLECTIONS.md`, `WORKFLOW-AND-STATE.md`), but not taken into
the Library, and nothing of the Library is written to it, not even a hard delete's (Settings Edits still reach it, ADR-0023). Its page says it is capture-only, and why.

- **The capture-only switch.** Only an Admin turns it, under the Machine's
  row lock, which taking in its tablet's reports and recording its answers
  hold too, so each is decided wholly before or after it, on any instance
  (`sharing.service.ts`). The switch commits with a `NOTIFY` on
  `machine_locations`, which wakes the writers of the Machine's
  connections: turned off, a writer writes nothing more, and an answer to a
  write sent before is recorded as one from a Machine at no Location would
  be; turned back on, it asks the plugin for the tablet's reports afresh.
- **Turned back on**, the Machine joins its Location (Joining a Location,
  below): `machines.sharing_since` keeps when, by PostgreSQL's clock, and
  each of its tablet's reports records it, so the first since is part of
  joining. A writer compares where its tablet's reports were taken in, a
  Location and when sharing was last turned back on there (`standing` in
  `join-plan.ts`), with where its Machine takes part now, so a Machine
  turned off and on again while its tablet reported nothing still has the
  tablet report afresh, and join again.

A mismatched connection, whose tablet is not its token's Machine's, takes
no part either, and neither does a Pending Machine (ADR-0004). Unidentified
Machines, and connections whose machine has not reported its hardware yet,
take part as their token's Machine.

## What a Location offers

A tablet holds only what its Machine's Location offers (ADR-0008):

- a **Bean Batch** while it is at the Location: from when it was added there
  until it is finished there, unless it or its Bean is Archived;
- a **Bean** while one of its batches is there, and, while none of its
  batches is there yet, where a tablet created it, linked a bean of its own
  to it, or un-archived its record, unless it is Archived. This document and
  the code call each such Location one of the Bean's origins (`bean_origins`,
  below); it is a name for how the server keeps this, not a glossary term;
- a **Grinder** that belongs to it, unless it is Archived: a Grinder belongs
  to the Location of the tablet that created it (Taking in a tablet's
  grinders, below);
- a **Profile** while it is shown there, unless it is Archived. A Profile is
  shown only where a tablet created it, or held it visible when nothing had
  decided it there yet, until it is hidden there or shown elsewhere; Decaid's
  bundled Profiles too (Taking in a tablet's profiles, below);
- a **Basket** or **Tool** while it is shown there, unless it is Archived:
  shown where a tablet created it, or entered one of its name, until it is
  hidden there or shown elsewhere (Taking in a tablet's baskets and tools,
  below);
- a **Recipe** of its own, in one of its Recipe Slots or none, unless it is
  Archived (Taking in a tablet's recipes, below).

So a Bean with batches is offered only where they are: once its last batch
at a Location is finished, it is no longer offered there. Archived items are
offered nowhere. Only the management interface Archives a Bean, Bean
Batch, Profile, Basket or Tool; a Grinder is Archived there too, or
by archiving or deleting it on a tablet at its Location. What the Location offers is written
to each of its tablets, with each batch's remaining weight there and each
Profile visible, and what it does not offer is archived or hidden on them,
never deleted, so their Shots still find it (Writing to tablets, below);
but a Basket or Tool it does not show is removed from DYE2's list, which
can hide nothing (Taking in a tablet's baskets and tools, below).

### A Profile reaches only the Machines that can run it

A DE1 and a Bengle run a profile's numbers in different ranges
(`MODEL_LIMITS` in `protocol/src/profile.ts`, #588): a DE1 takes a step's
target, exit and limiter in sixteenths up to 15.9, and a value above wraps to
another (20 ml/s runs as 4), so its ranges are Streamline's; a Bengle's are
the same, but its flow targets, flow limits and flow exits go to 20 ml/s, its
pump's rating. A value is judged as authored, never as either model's
resolution would send it, and nothing rounds or holds a Profile's values.
A Machine's model is its bound hardware's (`machineModelOf`): a DE1 for any
other name, and for a Machine whose hardware isn't known yet, as one not yet
bound, which a refusal says. So a Profile reaches only the
Machines that can run it (`server/src/library/profile-reach.ts`):

- Showing it at a Location where any Machine can't run it, capture-only ones
  too, is refused (409), naming the Location, those Machines, their model
  and the values, through the REST API, the MCP endpoint and a Conflict's
  value alike (`refuseUnrunnableAt`); hiding it never is. So is creating,
  copying or editing a Recipe there to name it (`setUses` in
  `recipe-edits.service.ts`), shown there already or not, since a Recipe
  shows its Profile at its Location, which may have gained such a Machine
  since; an edit that leaves the Recipe's Profile as it is is not. A
  Profile can still come to be shown where a Machine can't run it: a
  tablet's own Profiles join the Library at its Location as before
  (ADR-0018), restoring an Archived Profile or Recipe shows it again
  wherever it was shown, and a Machine moved to a Location meets what is
  shown there. The
  writes below keep it from such a Machine.
- The server writes no Profile to a Machine whose model can't run it, nor a
  Recipe's record carrying it (its `profileSnapshot`, and the Workflow DYE2
  derives), nor a Loaded Recipe's Profile into its Workflow, as when such a
  Machine moved to a Location that shows it (`markUnrunnable`, as
  `changesDue` plans each tablet's writes). Each such write is marked with
  why (`notWritten`), and the tablet's writer records it as refused rather
  than writing it, so its Machine's sharing status lists it (Sharing status,
  below). A Recipe's record is judged on the Library's Profile it names, as
  authored, not on its Workflow's copy moved to its brew temperature
  (`recipeWorkflow`). A Profile's record the tablet holds visible already
  is written as before, as is an edit of a Recipe's record that carries no
  Profile, or one the Machine can run; one whose Workflow carries a Profile
  it can't run is refused like the rest. This guard takes back nothing a
  tablet holds already: a tablet that held such a Profile visible on a
  Bengle, then set up on a DE1 at a Location that shows it, keeps it, as
  the server plans no write of a record that is as it should be. Where the
  Location hides it, Joining hides it on the tablet as any other.

Advice in a Profile's checks (`checkProfile`) follows the models the account
has Machines of (`accountModels`): a value is held to the widest of their
ranges, as a Draft is, and a value one of them can't run, or a flow one of
them can't keep up with (a DE1's pump about 8 ml/s, a 250 V/15 A Bengle's
heater about 15), is advice naming that model. An account with DE1s only
sees a DE1's ranges, as before.

These hold in an account with DE1s only too: a Profile with a value outside
a DE1's ranges, as a flow limit over 8 ml/s, which a de1app or Visualizer
profile may hold, is refused at any Location with a Machine, and written to
no DE1. Every Profile Decaid bundles is in a DE1's ranges (rounding noise
of 1e-9 at a range's end aside, `RANGE_SLACK`).

## Storage

`server/src/library/`, in PostgreSQL:

- `beans`: each Bean, by its global id (ADR-0006), with its content, Decaid's
  record fields as the tablet that created it sent them, those the server
  does not know included, but the record's id, times, `archived` and
  `extras`, which belong to each tablet's record, as edited since (Edits,
  below). Also its match key (below), kept to its roaster and name as edited,
  whether it is Archived, the Location of the tablet that created it, when it
  joined the Library, by PostgreSQL's clock, and the latest edit of each of
  its fields (`field_edits`, below).
- `bean_origins`: the Locations offering a Bean that has no batch there yet:
  where a tablet created it, linked a bean of its own to it, or un-archived
  its record, while none of its batches was there. A batch of it added there
  ends its origin there, and so does archiving or deleting it on a tablet
  there. Origins change only under the Location's lock (`location-state.ts`),
  which keeps them to Beans with no batch at the Location. They follow the
  order edits arrive in, not ADR-0020's edit times: a Bean archived offline
  and un-archived elsewhere since is offered as the later report has it.
- `bean_batches`: each Bean Batch, by its global id, with its Bean, its
  content, Decaid's record fields as the tablet that created it sent them,
  but its id, its bean's id there, its times and `extras`, which are that
  record's, and `archived` and `weightRemaining`, which are each
  Location's, as edited since. Also whether it is Archived, the Location of
  the tablet that created it, when it joined the Library, and its fields'
  latest edits.
- `batch_locations`: each batch's state at a Location, each part a field of
  its own (ADR-0020): when it was last added there and when it was finished
  there since, if it was, and the remaining weight entered there last, in
  grams, with that edit's time, never earlier than the one before. A batch is at a Location while it was added
  there and not finished since. Whether it is there is a field whose latest
  edit wins (ADR-0020), with when that was last decided by PostgreSQL's clock.
  An edit from a tablet whose record of the batch had seen that decision
  (`seen_at`, below), or, archiving or deleting its Bean, whose record of the
  Bean had, applies, if that was at this Location. Otherwise, as from a tablet
  that was offline, adding it there loses to a finish timed later, and
  finishing it there to an add timed later; the Location's state is then
  written back to that tablet, and the edit kept as a Conflict. One that
  applies over another tablet's decision it had not seen, which it changes,
  keeps that decision as a Conflict instead, as neither saw the other
  (ADR-0020). Each that applies is a history entry (`item_versions`,
  below), whose id the field keeps (`presence_version_id`,
  `remaining_weight_version_id`), so a Conflict it becomes knows where it
  came from. One that applies is the
  field's latest edit
  even when it leaves the batch where it was: it is added or finished there
  again, so an earlier edit that arrives later cannot undo it. It is never
  finished before it was added, nor added again before it was finished,
  whatever the clock that timed the edit. Times are each edit's: a tablet's by
  the record's `updatedAt` in UTC; a delete, which Decaid does not time, by
  PostgreSQL's clock, but never earlier than the record the tablet was last
  known to have.
- `grinders`: each Grinder, by its global id, with its content, Decaid's
  record fields as the tablet that created it sent them, but the record's id,
  times, `archived` and `extras`, which belong to each tablet's record, as
  edited since, and from `extras` the feed rate note and the range and
  defaults DYE2 keeps there (`grinderContent`). Also whether it is Archived, a field of its own merged with
  its content's, the Location it belongs to, which is that of the tablet that
  created it, when it joined the Library, and its fields' latest edits. Its
  Location and whether it is Archived change only under that Location's lock
  (`location-state.ts`).
- `profiles`: each Profile, by Decaid's id (ADR-0006), with its content,
  Decaid's record fields as the tablet that created it sent them, but its id,
  times and `visibility`, which are that record's or each Location's. Also
  whether it is one of Decaid's bundled Profiles (`isDefault`), whether it is
  Archived, the Location of the tablet that created it, when it joined the
  Library, and the latest edits of its title, author and notes, which are its
  only fields edited (Edits, below).
- `profile_locations`: whether each Profile is shown at a Location, a field of
  its own (ADR-0020), with the time of the edit that decided it, never earlier
  than the one before: a tablet's by its record's `updatedAt` in UTC; a
  delete, which Decaid does not time, by PostgreSQL's clock, but never earlier
  than the record the tablet was last known to have. And when it was decided,
  by PostgreSQL's clock, as again by an edit that applied but left it shown or
  hidden as it was, the tablet whose edit decided it, and that edit's history
  entry (`version_id`). A Location with no row for a Profile has decided
  nothing of it, and does not show it.
- `tablet_beans`, `tablet_bean_batches`, `tablet_grinders` and
  `tablet_profiles`: the map, per tablet id (ticket #79): each item's local
  id on that tablet, which is a Profile's own, and the record as the tablet
  last had it, as it reported it or as Decaid returned the plugin's write,
  with that record's `updatedAt` placed in UTC by the plugin. All but
  `tablet_grinders` keep the Location's latest decision that the record has
  seen (`seen_at`, its time by PostgreSQL's clock) of the batch's
  presence, of the Profile's showing, or of the presence of any of the Bean's
  batches, with that decision's Location, as it says nothing of another's: the
  one the server's write it answers carried, which Decaid answered after, if
  the tablet's Machine is still at that Location, or one its own edit made,
  whichever is later, as a write planned before the tablet's own decision may
  be answered after it. A Bean's own archiving does not count, as it may leave
  batches added since in place. A report shows nothing of what the tablet saw
  of other tablets' decisions, as the plugin may have read it before them and
  sent it after, as across a reconnect; nor does an answer to a write no
  longer awaited, whose write is not known. Either keeps the decision known
  seen before. Every map also keeps the latest edit of the item's content
  that the record has seen (`content_seen_at`, by PostgreSQL's clock): the
  latest decided as the server's write it answers was planned, whichever is
  later, if the record holds that content: no change of the content its
  answer shows, which the write did not set, lost, as a field the plugin left
  as the tablet had changed it may (one that won is the tablet's own latest
  edit of the field); or, for a record the map did not hold, as a create's,
  its content is the item's (`holdsWrittenContent`). A write carries that time (`contentDecidedAt`), and its answer
  repeats it, so an answer that comes after its write stopped being awaited,
  as across a reconnect, says what its record has seen of the content too. A
  reset tablet has a new tablet id, so it starts with nothing here.
- `baskets` and `tools`: each Basket and Tool, by its global id, with its
  content, DYE2's record fields as the tablet that created it sent them, but
  the record's id, `createdAt` and global id, which belong to each tablet's
  record, as edited since, or as the management interface created it; its
  name as they are matched (`match_key`, kept to its name as edited); whether
  it is Archived; the Location it was created at, by a tablet there or in the
  management interface; when it joined the Library; and its fields' latest
  edits.
- `basket_locations` and `tool_locations`: whether each is shown at a
  Location, a field of its own kept as `profile_locations` keeps a
  Profile's.
- `recipes`: each Recipe, by its global id, with the Location it belongs to;
  its record id (`record_id`), the id of its record in DYE2's recipes on
  every tablet at that Location, which never changes, unique among the
  Location's Recipes not Archived (a partial unique index); its Recipe Slot
  there or none, 1 to 9 (a check constraint, `recipes_slot_check`), unique among the Location's
  Recipes; its content in the Library's terms (Taking in a tablet's recipes,
  below); whether it is Archived, when it has no slot; when it joined the
  Library; and its fields' latest edits.
- `tablet_baskets` and `tablet_tools`: each tablet's map of its records in
  DYE2's lists, by DYE2's id, with the record as the tablet last had it, when
  the plugin first read it (`record_updated_at`), the latest decision of its
  showing and the latest edit of its content it has seen, as
  `tablet_profiles` keeps them; what the record held for each field just
  before the server's latest write to that field, while the tablet has not
  set the field to a value of its own since (`before_write`); and
  whether a report has listed it since the server's write created it
  (`listed`).
- `tablet_recipes`: each tablet's map of its records in DYE2's recipes, by
  DYE2's id, its Recipe's record id for a Recipe of the tablet's Location,
  kept as `tablet_baskets` keeps a Basket's, its fields named by their paths
  in the record, but for the showing it has seen, as a Recipe is no
  Location's to show, and for `before_write`, as recipe records keep no
  stale-save rule.
- `tablet_unrecognised_lists`: each of DYE2's lists a tablet holds in a shape
  that is not recognised, which nothing is written to or taken in from, and
  since when.
- `field_edits` on `beans`, `bean_batches`, `grinders`, `profiles`, `baskets`,
  `tools` and `recipes`: the
  latest edit of each field of the item's content, `{ at, decidedAt,
  tabletId, versionId }`: when it was made, never earlier than the edit
  before it; when it was decided, by PostgreSQL's clock, after every edit of
  the item decided before it; the tablet that made it, if one did; and its
  history entry.
- `item_versions`: each accepted edit of an item (ADR-0020), with the fields
  it set and their values, the Machine and tablet or the account it came
  from, when it was made (`edited_at`, timed as the edit was) and when the
  server took it in (`received_at`, by PostgreSQL's clock). An edit of the
  item's content has no Location; one of a Location's state of it names that
  Location, and only those fields: `atLocation` and `remainingWeight` for a
  batch, `shown` for a Profile. Joining the Library is an item's first
  history entry. Each names its item by kind and id (`kind`, `item_id`), and
  goes with it. History entries taken in together keep the order they were
  taken in (`seq`), and so do Conflicts.
- `versioned_items`: every item that keeps a history and Conflicts, each
  Library item, by kind and id, which history entries
  and Conflicts reference, so a new kind needs no column of its own in them.
  Triggers on each kind's table keep it, as its migration created them
  (`versioned_item_added`, `versioned_item_renamed`,
  `versioned_item_removed` and `versioned_items_truncated`, each given the
  kind): a row is added as an item is, follows a change of its id, and is
  deleted as the item is, or with every row of the kind as its table is
  truncated, taking its history entries and Conflicts with it, as a
  foreign key to the item would.
- `deleted_items` and `tablet_deletions`: the global id of each item an
  Admin hard-deleted, and each tablet's records of it still to be deleted
  there, by their ids there, a Profile's by Decaid's id, with its steps,
  and never in `deleted_items` (Hard deletes, below).
- `tablet_reports`, `workflow_clears` and `tablet_left_out`: where each
  of a tablet's reports was last taken in, and when its Machine's sharing
  had last been turned back on then, the Workflow grinder, batch and
  Basket still to be cleared on a joining tablet, and each record a joining tablet held
  that the Library leaves out, by kind and its id there, with whether it
  is archived or hidden there yet (Joining a Location, below).
- `machines.sharing` and `machines.sharing_since`: whether a Machine takes
  part in the Library at its Location, on unless an Admin turned it off,
  and when it was last turned back on (Who takes part, above).
- `tablet_refusals` and `tablet_last_applied`: each change a tablet
  refused, with Decaid's status and answer, until one of the same item or
  record is carried out there, and the last change it applied, timed by
  PostgreSQL's clock (Sharing status, below).
- `conflicts`: each edit of a field that lost to another made without seeing
  it (ADR-0020): the item, the field, the losing value (null where it cleared
  the field), where it came from and when it was made, as a history entry
  keeps them, its Location for a Location's state, when it became a
  Conflict, and whether it is open, its value used or dismissed (Resolving
  Conflicts, below).

## Edits

An edit of a Library item's content on any tablet reaches every tablet that
holds the item, at every Location, merged per field with the latest edit
winning (ADR-0020; `content-edits.ts`, with the pure merge in `merge.ts`). An
item's content is a Bean's, a Bean Batch's or a Grinder's record fields, but
those of the tablet's record (its ids, times and `extras`, but for a
Grinder's feed rate note and its range and defaults, below) and of each
Location's (a batch's `archived` and `weightRemaining`; a Bean's `archived`,
which takes it away from the tablet's Location), whether a Grinder is
Archived, and a Profile's title, author and notes, which are outside its id
(ADR-0006), read as Decaid reads them (`profileTextOf` in
`protocol/src/profile.ts`), each empty where it has none. Decaid refuses to
change a bundled Profile's, so a bundled Profile's are never edits, and never
written, and the management interface refuses to edit them too.

- **What an edit is.** A record the tablet's map holds that it reports anew,
  or that Decaid returned for one of the server's writes, is compared with
  the record known, the record as that tablet last had it: each field of its
  content that differs, a field the record leaves out being null, as Decaid
  leaves out a field it holds no value for, was edited on the tablet. The edit
  is timed by the record's `updatedAt`, placed in UTC by the plugin. The
  answer to every write the server makes is recorded as the record known,
  even one that comes after its write stopped being awaited, so a record
  that holds only what the server wrote it holds no edit (ADR-0003). The
  exception is an answer lost with the plugin's outbox, when the plugin
  reloads between Decaid carrying out a write and the answer being sent: the
  tablet's next report then shows what the server wrote as an edit of that
  tablet's, timed when the plugin wrote it. Its value is the one the server
  wrote, so it changes nothing unless another tablet's edit, made before the
  write but taken in after it was planned, set the field since; that edit is
  then kept as a Conflict.
- **Merging.** Each field the edit changed is decided against the field's
  latest edit (`field_edits`). An edit decides a field nobody has edited
  yet, and one whose latest edit its tablet had seen: its own, or one
  decided by when its record last held what the server wrote it
  (`content_seen_at`). Otherwise edit times decide: one made no earlier than the field's latest
  edit decides it, and the value it replaces, if another, is kept as a
  Conflict from where and when that edit came, as neither saw the other; one
  made earlier loses, and its value, if another, is kept as a Conflict, and
  the Library's value is written back to its tablet. An edit that decides a
  field is its latest edit even when it leaves it as it was, so an earlier
  edit that arrives later cannot undo it. A Recipe's Bean and Bean Batch
  are one pick, decided as one by an edit holding both: losing either, it
  loses both, each kept as a Conflict where it differs, so a Recipe never
  names one edit's Bean beside another's batch, as when a batch of another
  Bean picked on one Machine reaches the server after the Bean's next bag
  picked on another (ADR-0020; `together` in `kinds.ts`, #570). Each edit that decides a field is
  kept in the item's history, with the fields it decided. A Bean whose
  roaster or name is edited keeps its match key to them, so another Bean of
  the same roaster and name lists it as a likely duplicate; they are not
  merged (ADR-0018).
- **Linking.** A record linked to a Library item, a new bean by its roaster
  and name, or a user's Profile the tablet holds by Decaid's id, takes the
  item's content: each field where the record held another value is kept as
  a Conflict, timed by the record (ADR-0018). A field the record holds no
  value for loses nothing. A record carrying a Bean's, batch's or Grinder's
  global id that the map did not hold, as after a lost answer, takes the
  item's content with no Conflict, as its own content came from the server.
- **Locks.** An item's edits are decided under its row lock, on any
  instance (ADR-0016), taken after the reporting tablet's and its Location's
  locks; a report locks every item it edits at once, in id order, so two
  reports editing the same items never wait on each other in turn.
- **Per-Location state.** Whether a batch is at a Location, its remaining
  weight there and whether a Profile is shown there are each a field of
  their own, merged as `batch_locations` and `profile_locations` describe,
  with history entries and Conflicts as content's are.

Times decide only between edits made without seeing each other, so a tablet
whose clock runs behind another's can lose such an edit, a tablet clock error
ADR-0003 accepts. Of two edits of one field made without seeing each other
and timed in the same millisecond, the precision the plugin reads times to,
the one taken in last wins.

### Resolving Conflicts

An open Conflict is resolved once, by an Admin, or by Staff where they can
edit the item (`mayResolve` in `conflict-access.ts`): the Library's shared
content anywhere, a Grinder's Archived state included, as Staff Archive and
restore items anywhere; but a Location's state of an item (a batch at a
Location, its remaining weight there, a Profile shown there) and a
Grinder's other content only at their own Locations, as a Grinder belongs to one (`conflicts.service.ts`). Each is decided under the Conflict's row lock, on
any instance, so it is used or dismissed once; a tablet's report never locks
a Conflict, so neither waits on the other in turn.

- **Using its value** makes it the field's latest edit, a history entry
  from the account, timed by PostgreSQL's clock (ADR-0016), as its
  `received_at` is. The request names the history entry that set the
  field's value now as the Conflict showed it (`seen`), and the value is
  used only while that entry still set it, read under the locks below: an
  edit decided since, as by a tablet that had seen the value now, which
  then made no Conflict, is
  refused with 409 rather than replaced unseen (ADR-0020), and the account
  looks again. So the account chose it over the field's value now, and the
  edit decides the field whatever the times of the edits before it, and
  keeps nothing it replaces as a Conflict: it is no edit made without seeing
  another. An edit of the item's content is merged under the item's
  row lock, after its Location's lock for a Grinder, whose Archived state
  changes only under it, as a tablet's is (`editContent`, with `seenAt`
  `everything`); one of a Location's state, under the Location's lock, as
  having seen every decision made there before it (`addBatchAt`,
  `finishBatchAt`, `enterRemainingWeight`, `showProfileAt`). A Recipe's value
  is used as an edit of it in the management interface is made
  (`recipeEditValues`, Editing in the management interface, below): a batch
  used sets its Bean too, a Bean used alone takes the Recipe's batch of it or
  that Bean's batch most recently added at its Location, or none, keeping the
  Bean, which is then offered there while it has no batch there
  (`offerBeanAt`), a ratio used sets the yield to the dose times it, as picking a ratio
  in DYE2's editor does, refused with 409 while the Recipe has no dose, the ratio and the Tools' attributes follow, and what it newly uses is offered at its
  Location, or refused with 409 where it is Archived, and Tools' attributes
  used keep those of the Tools it still uses. It commits with a
  `NOTIFY` on `library_changes`, so every tablet that holds the item, at every
  Location, is written it; a tablet's edit made before it that arrives later,
  as from one that was offline, loses to it and is kept as a Conflict.
- **Dismissing it** closes it with nothing else changed: no history entry,
  and nothing written.

## Editing in the management interface

Admins and Staff create and edit Beans, Bean Batches, Grinders, Baskets,
Tools and Recipes in the management interface, edit a Profile's title,
author and notes, Archive and restore them and Profiles, add and finish
batches at Locations, setting their remaining weight at each, show and hide
Profiles, Baskets and Tools at Locations (`library-edits.service.ts`), and
move Recipes between Recipe Slots and copy them to Locations
(`recipe-edits.service.ts`). Each change is an edit by the account, timed by
PostgreSQL's clock (ADR-0016), and made over the item as it stands, as using
a Conflict's value is (Resolving Conflicts, above): it decides each field it
sets whatever the times of the edits before it, and keeps nothing it
replaces as a Conflict, while a tablet's edit made before it that arrives
later loses to it, and is kept as one. Each is an edit in the item's
history from the account, and commits with a `NOTIFY` on `library_changes`,
so every tablet that holds the item, or whose Location offers it now, is
written it (Writing to tablets, below).

An assistant makes the same changes through the MCP endpoint (ADR-0026):
creating and editing Beans, Bean Batches, Grinders, Baskets and Tools,
editing a Profile's title, author and notes (`edit_profile`, #576),
listing, reading, starting, changing, simulating, publishing and
discarding Drafts (`list_drafts`, `get_draft`, `create_draft`, `edit_draft`,
`simulate_draft`, `publish_draft` and `discard_draft`,
`server/src/mcp/drafts.tools.ts`, #579, #580), returning a Profile to an
earlier version (`return_to_profile_version`, #580), and having a Machine
follow a Draft and stopping it (`follow_draft`, `stop_following_draft`,
#581), `get_draft` saying whether one does and listing the Draft's Trial
Shots, and `edit_location` marking a Location for trying Drafts,
Archiving and restoring any item, showing and hiding Profiles, Baskets and
Tools and adding and finishing batches at Locations, and using and
dismissing Conflicts' values (`server/src/mcp/library-changes.tools.ts`,
#411, #412); and creating and editing Recipes, moving them between Recipe
Slots and copying them to Locations (`server/src/mcp/recipe-changes.tools.ts`,
#412), a Recipe's edit reaching the Workflow of every Machine that has it
loaded as the management interface's does (ADR-0022). Each calls the
service its REST route calls, so it is timed, merged, written to tablets,
limited for Staff and refused exactly as that route's, with the same
message. Each tool takes a kind's fields at the top level, by the names the
REST API's `content` takes, and reads them again with the REST API's readers
(`item-input.ts`), so its schema gives each field's type and what it takes
in words (`contentFields`), and a value those readers refuse is refused with
their message. It is an edit in the item's history from the account
through its Connected App (`Editor` in `history.ts`), as is a Conflict
keeping a value of it that a later edit replaced; dismissing a Conflict records no one, in the
management interface either. A lapsed Connected App that a history entry or
Conflict names is kept, still refused, so history goes on naming it
(`server/src/connected-apps/cleanup.ts`).

- **Content.** A Bean's, a batch's or a Grinder's fields are Decaid's, each of
  the type Decaid takes, so no tablet refuses a write of them
  (`item-input.ts`): an empty value clears a field, but a Bean's roaster and
  name, a Grinder's model and a Bean's `decaf` and a batch's `frozen` flags,
  which Decaid refuses to clear. A Grinder also holds DYE2's feed rate
  note, `feedRate`, text such as "manual FF/MF/SF" saying which feed rates
  it takes (DYE2 v0.1.34, `1358750`). DYE2 keeps it in the record's
  `extras`, as Decaid drops a top-level `feedRate`, so the server reads it
  from `extras.feedRate` (`grinderContent` in `grinder-intake.ts`, null
  where DYE2's grinders page cleared it), and the plugin writes it there,
  beside the record's other `extras` keys and its global id, never at the
  top (`Route.inExtras` in `plugin/src/library-writes.ts`), as DYE2's
  grinders page spreads the grinder's own `extras` under it
  (`buildGrinderBody`). The previous release's plugin, which runs beside
  this one until Decaid updates it (ADR-0025), writes the note at the top,
  which Decaid drops, and writes no Recipe's feed rate into a Workflow, so
  such a write is listed among that tablet's refusals ("Written, but its
  record still differs as it did") until the item changes or the tablet
  connects with this release's plugin, which writes it. The previous
  release's server takes in no feed rate or note, so where a tablet's
  record holds one its Recipe or Grinder holds none of, and none was ever
  edited, as one saved in DYE2 while that server served the tablet, the
  next report outside the tablet joining its Location takes it in
  (`takeInUnseen` in `content-edits.ts`), rather than writing the record
  back without it. Where tablets hold different ones for one item, the
  first to report gives the item its value, which is written over the
  others' with no Conflict kept: no edit tells a value never taken in from
  a record still to be written, so a Conflict would be kept for each such
  record too.

  A Grinder holds its range and defaults the same way (#551, DYE2 v0.1.37,
  `d992296`; GRINDER_RANGE_FIELDS in `protocol/`): `settingMin`,
  `settingMax` and `settingDefault`, and `rpmMin`, `rpmMax` and
  `rpmDefault`, each a number of any sign, blank for none, where 0 is a
  value: a Recipe's dose, grind setting and RPM are none at 0, and these are
  not. A tablet's steppers stop at the range, and a Machine takes the
  default, or the middle of the range, as a barista picks the Grinder on it
  (ADR-0022, What DYE2 and Streamline do). DYE2 keeps them in the record's
  `extras` beside the note, so the server reads them from there and the
  plugin writes them there (GRINDER_EXTRAS_FIELDS), a change of one on a
  tablet an edit, with Conflicts per field as its other fields have. A null
  there is none, as DYE2's edit writes one for each left blank. Their rules
  are DYE2's (`grinder-range.ts`), kept where a Grinder is created or edited
  here or through the MCP endpoint, and judged over what the Grinder holds,
  under its row lock:
  - a lowest above a highest is refused, for the setting and for the RPM;
  - a Grinder with named positions (`settingType` other than `numeric`)
    holds no range or default for its setting: one sent for it is refused,
    and an edit that leaves it with named positions clears those it holds,
    as DYE2's edit writes the three null. Its RPM's stay;
  - a default outside the range is accepted, as DYE2 saves one as typed and
    holds it within the range as it is used;
  - a Recipe's grind setting or RPM outside its Grinder's range is accepted,
    as DYE2's recipe editor accepts one.

  What tablets' edits merge to is taken as it comes: two edits made out of
  each other's sight, or a Conflict's value used, can leave a lowest above
  a highest, which Streamline ignores, and which an edit here of either end
  must put right, an edit of anything else being taken. The same way, a
  Conflict's value used, or a tablet's record, can give a Grinder with
  named positions a range for its setting, which the next edit here clears.
  The previous release's plugin writes them at the record's top,
  which Decaid drops (`dye2-v0.1.40/grinder-form.json`, `topLevel`), so its
  tablet holds none until Decaid updates the plugin, the write listed among
  its refusals as a Grinder's note was; its record's `extras` are kept
  whole, so it is never taken to have cleared one. The previous release's
  server takes none in, so one a tablet's record holds that its Grinder
  never had is taken in at its next report, as a note is (`heldInExtras` in
  `grinders.ts`).

  A Basket's fields are those DYE2's baskets
  page saves, its name, `size` (one of the sizes the page offers),
  `diameterMm` and `notes`, and a Tool's those of its equipment page, its
  name and its attributes, `custom`, a list of `{ key, value }`, each trimmed,
  one with no name left out, as the page leaves it; neither's name may be
  cleared, and a field cleared is left out of every tablet's record. A date is entered as a day and kept as
  Decaid returns one sent so, such as `2026-10-01T00:00:00.000`, and a new
  item holds what Decaid makes a record hold where it is not sent a value (a
  Bean not decaf, a batch not frozen, a Grinder's numbered dial), so what
  every tablet then holds is the item's content, and is not written again.
  An edit is merged under the item's row lock, after its Location's lock for
  a Grinder (`editContent`).
- **Beans.** A Bean created here belongs to no Location, and is offered
  nowhere until one of its batches is added somewhere. One whose roaster and
  name, ignoring case and white space at either end, are a Library Bean's,
  Archived or not, is refused, naming that Bean: a Bean is identified by its
  roaster and name. It is decided under the lock new beans are matched under
  (`lockBeanMatching`), so two are never created at once, through any
  instance, nor one beside a tablet's new bean. An edit that gives a Bean
  another's roaster and name is not refused: it is a likely duplicate, as a
  tablet's rename makes one (ADR-0018).
- **Bean Batches.** A batch is created of a Bean, not Archived, at the
  Locations chosen, each with its remaining weight there if one is entered,
  as edits of each Location's state of it (`addBatchAt`,
  `enterRemainingWeight`), under those Locations' locks, taken in id order.
  Adding it at a Location, finishing it there and setting its remaining
  weight there are each such an edit; a remaining weight is set only where
  the batch is, or is added. Its details are its content.
- **Grinders.** A Grinder is created belonging to a Location, which never
  changes; its Archived state and its content are edited under that
  Location's lock, as a tablet's are. Its form and page have its range and
  defaults beside its steps (Lowest setting, Highest setting, Default
  setting, Lowest RPM, Highest RPM, Default RPM), and a Conflict about one
  is labelled so.
- **Profiles.** A Profile is shown or hidden at each Location, as an edit of
  that Location's state of it (`showProfileAt`), under the Location's lock,
  as having seen every decision made there before it, which is how a lab
  Profile reaches a cafe: showing it there writes it to the cafe's tablets,
  visible, and hiding it there hides it on them, and on no other Location's.
  Its title, author and notes are edited here too (#576), as a Bean's content
  is, by Staff anywhere: they are outside the id Decaid computes from what
  the machine executes (`profileId` in `protocol/src/profile.ts`, ADR-0032),
  so it stays the same Profile, under its row lock, merged per field
  (ADR-0020) and written to every tablet that holds it as a tablet's edit of
  them is, in its `profile` through Decaid's `PUT /profiles/{id}`, which the
  plugin sends the profile whole, as Decaid reads it, with the three
  replaced (`updateProfile` in `plugin/src/library-writes.ts`). A profile
  JSON would carry to Decaid changed, so that Decaid would hash it to
  another id and replace the record with it, as a tank temperature of -0.0
  that JSON writes as 0, is refused instead, shown in the Machine's sharing
  status. A tablet's Workflow is left as it is: one that has the Profile
  loaded keeps its old title until a profile or Recipe is loaded again, and
  until then Streamline, which finds the Workflow's profile by title, saves
  its dose, yield, grind and temperature changes to no Profile, or to
  another holding the old title. Its title is
  never cleared, as Decaid refuses a profile with none, nor made another
  Profile's, Archived ones too, whose records tablets keep hidden (409),
  under an advisory lock taken after the Profile's row lock: Streamline
  finds a tablet's record of the Workflow's profile, and of the one it
  loads at wake, by title, so would take one for the other. That is
  checked only for an edit made here: a tablet's rename is taken in as it
  is, and so is a Conflict's title used; and a title the Profile has
  already, up to case and the spaces around it, sent with other fields, is
  not refused for one that is another's already. An
  author or notes cleared is kept empty, as Decaid holds none (`decaidText` in
  `item-input.ts`), so a tablet's record never differs from it for that
  alone. A bundled Profile's are refused (409), as Decaid refuses to change
  them. Its steps change only on tablets so far: a Profile with other steps
  is another Profile, which joins the Library from the tablet that saved it.
  A Draft changes them here, published as a new Profile (Drafts and
  Publishing, below, #580).
- **Baskets and Tools** are shown or hidden at each Location as a Profile is
  (`showEquipment`), which is how a lab's Basket reaches a cafe: showing one
  there writes it to the cafe's tablets, and hiding it there removes it from
  their lists, and from no other Location's. One created here is shown at
  the Location chosen only, as one entered on a tablet there is (ADR-0008),
  which records it as created there. One whose name, ignoring case and white
  space at either end, is that of an item of its kind the Library has is
  refused, naming that item and whether it is Archived, as a Bean is: one not
  Archived, the oldest, is the item a tablet's record of that name would be
  (ADR-0018), to be shown at the Location instead, and is named before any
  Archived one; one Archived, named only where none of the name is current,
  is to be restored rather than duplicated, though a tablet's new record of that name, which is never
  linked to an Archived item, joins the Library as a new one. It is decided under the lock the kind's new records are
  matched under (`lockMatching` in `equipment.ts`), so two are never created
  at once, through any instance, nor one beside a tablet's new record. An
  edit that gives one another's name is not refused, as for a Bean. A new
  Tool holds no attributes unless given some, as DYE2's page saves one. Hard
  deletes come with the Shots that name them.
- **Recipes.** A Recipe is created at a Location, which never changes, with
  every field DYE2's recipe editor saves but the barista, the drinker and
  its steam and hot water modes (`RECIPE_FIELDS` in `kinds.ts`): its name,
  beverage, Bean Batch, Profile, dose, yield, Grinder, grind setting, RPM,
  feed rate, brew temperature, Basket, Tools with each Tool's attributes for it
  (`toolAttributes`, by the Tool's global id, as DYE2's `equipmentCustom`
  holds them by its own), and its eleven steam, hot water and flush settings
  (Steam, hot water and flush settings, below). Its grind setting is a
  number where it reads as one and otherwise the text as typed, such as a
  three-dial grinder's `1.1.0`, as DYE2 v0.1.32 keeps one (`grindSettingOf`
  in `protocol/`), shown and edited as kept. Its dose, grind setting and RPM
  are above 0 or none: a 0 for one is refused with 400, and clearing the
  field says none, as DYE2 from v0.1.37 applies a recipe holding 0 for one
  as naming none (`RECIPE_NONE_AT_ZERO` in `protocol/`, ADR-0022, #550); its
  yield may be 0, which is stop-at-weight off. A stored 0, as 1.10.0 may
  take one in, is read as none, its page showing none. A Recipe is the whole
  Shot: a Machine that loads it is left with none of the dose, grind
  setting, RPM, feed rate, Grinder, Basket and Bean Batch it holds none of,
  and a field cleared here is cleared in the Workflow of every Machine that
  has it loaded (`WORKFLOW-AND-STATE.md`, The Loaded Recipe). Its page shows each setting,
  one it holds none of as "Machine's own", and its editor sets or clears
  any of them. Each is checked against
  the range DYE2's editor offers, a whole number where Decaid's field is an
  int (`NumberRange` in `item-input.ts`), and refused with 400 otherwise:
  a steam temperature from 135 to 170 °C, with no "Off"; a milk stop of 0
  (off) or from 30 to 80 °C; a hot water time from 5 to 120 s; a hot water
  flow from 0.5 to 8 ml/s; a flush temperature from 5 to 95 °C; a flush flow
  from 1 to 8 ml/s; a steam time from 1 to 255 s, as one of 0 is steam
  off (Steam, hot water and flush settings, below) and the DE1 holds no
  longer one; and a steam flow, hot water volume, hot water temperature or
  flush time of 0 or more. Its steam and hot water
  modes, only which value DYE2's stepper shows, stay as a tablet saved them,
  a new one's by flow and by volume, as DYE2's editor makes one, and are
  not set here (400). A new one holds no steam, hot water or flush setting,
  so a Machine loading it keeps its own. A Recipe is on Streamline's strip
  exactly while it is in a slot (DYE2 v0.1.32), so it has no switch of its
  own for that, and its content no field: the REST API refuses
  `showOnDashboard` (400), which releases up to 1.6.0 kept there. The
  release that dropped it fixed what 1.6.0 left once, in its migration
  (`20261029000000_recipes_shown_by_slot`), an exception to migrations
  changing the schema only that the owner approved on 2026-10-29: a Recipe
  in a slot whose `showOnDashboard` was false left its slot, a history
  entry from the server, the field left every Recipe's content and latest
  edits, and each open Conflict over it was dismissed; past history entries
  keep it as made.
  While 1.6.0 still served beside it during the deploy, a hide 1.6.0 took
  in, or its page's switch, was undone, as this release writes a record
  shown exactly while its Recipe is in a slot, and a `showOnDashboard` 1.6.0
  wrote then stays in the content, unread. What it newly uses is checked against its Location as it is set, under each item's row lock, but not what it uses already, so a Tool
  Archived since stays beside a new one: its Grinder is one of the
  Location's, not Archived, and a Bean Batch, of a Bean not Archived,
  Profile, Basket or Tool is not Archived; a
  batch not at the Location is added there (`addBatchAt`), and a Profile,
  Basket or Tool not shown there is shown there (`showAt`), each the
  account's edit of the Location's state of it, so the Recipe can be loaded
  there. Its Bean is its batch's, and clearing its batch clears it. Its
  ratio is kept only while its yield is its dose times it, to a tenth of a
  gram, as DYE2's editor keeps it, and cleared by an edit that breaks that;
  a Tool's attributes go with the Tool when an edit drops it, or clears the
  Tools. A Recipe
  created there gets a new record id, a UUID, as a copy does. Its slot is
  its Location's state, not its content: one of the Location's nine
  (`RECIPE_SLOTS` in `protocol/`), any of which a request may name (ticket
  [#502](https://github.com/loganfuller/decent-sync/issues/502)).
  Streamline's DYE strip shows slots 1 to 5 only, so a Recipe in 6 to 9 is a
  button on a Skin that shows nine, and is listed by DYE2; the server does
  not work out which Skin a Location's tablets run, so `next` gives the
  lowest free of the nine wherever it is asked. It is
  created in a slot chosen, the lowest one free (`next`), no Recipe's, its
  own included, or none, as for `next` where every slot holds a Recipe; and
  moved to another, or taken out of its slot, each a history entry of its own
  setting `slot` at the Location, as a tablet's move is. A Recipe in the
  slot chosen takes the moved one's old slot, or none for a new one or one
  that had none; moving one to `next` where every slot holds a Recipe is
  refused (409). Slots are decided under the Location's lock, as a tablet's
  report decides them, so two never take one slot, through any instance.
  Archiving one takes it out of its slot first, and removes it from every
  tablet's list; a restored one is kept at its Location in no slot, and
  written to every tablet there again, under its record id, or a new one
  where another Recipe there has taken that id since, as one a tablet saved
  under a slot's number. An Archived one is not put in a slot (409). Each
  change locks the Location, then the Recipe's row, as a tablet's report
  does, and commits with a `NOTIFY` naming the Location, so each tablet
  there is written the move: only the records' `stripSlot` and whether
  they are shown change, together, the Recipe's and that of the Recipe that
  held its new slot, each keeping its record id and history (`recipeWrites`
  in `holdings.ts`), so a Machine with it loaded keeps it loaded. An Admin hard-deletes one no Shot was
  pulled with (Hard deletes, below).
- **Copying a Recipe.** A Recipe is copied to another Location than its own
  (never its own, where the slot chosen could be the Recipe's, which the copy
  would take from it, 400) as a new Recipe there (`POST /api/recipes/:id/copies`), a starting point
  for that Location's dial. The copy takes the Recipe's content as it stands,
  read without its lock, and changes nothing of it, but for its Grinder, the
  one chosen from that Location's Grinders or none, its grind setting kept
  as a starting point, since calibrations differ; and its Bean Batch, kept
  unless another, or none, is chosen. What it uses is checked and offered at
  that Location as an edit's is (`recipeEditValues`): a batch not there is
  added there, and a Profile, Basket or Tool not shown there is shown there,
  so it can be loaded at once, and one Archived is refused. A Bean it names
  with no batch takes that Bean's batch most recently added there, or none,
  keeping the Bean, offered there, as a Bean set alone does. An item a hard
  delete left the Recipe naming is left out of the copy (`withoutDeleted`),
  as tablets are written none. Its steam, hot water and flush settings are
  the Recipe's. It gets a new record id, and goes in the slot chosen, the
  Recipe there taken out of it and kept there, or the lowest free one, or
  none, as where every slot there holds a Recipe, under that Location's
  lock, as a new Recipe does. Its history starts with the copy: its first
  history entry names the Recipe it was copied from and that Recipe's
  Location then (`copied_from_id` and `copied_from_location_id` on
  `item_versions`), the Recipe by its id alone, so the note outlives its
  hard delete. It starts with the Recipe's Reference Shot, a history entry
  of its own, and chooses its own from then on.
- **A Recipe's Reference Shot** (#472, ADR-0029). The one Shot chosen to
  show how a Recipe's Shots should go: any Shot the Shots list lists when it
  is chosen, from any Machine, Location or Profile, pulled with the Recipe
  or not (`PUT /api/recipes/:id/reference-shot`, `set_reference_shot`).
  It is held on the Recipe beside its slot (`reference_shot_id`), by the
  Shot's id with no foreign key, as Shots are never deleted, and is not its
  content: it is no part of DYE2's recipe record, and makes no Conflict.
  It reaches tablets as a copy of the Shot, below, so choosing or clearing
  one announces the Recipe's Location (`library_changes`). Each change of it is a history entry of its own, `referenceShotId`
  set to the Shot's id or null, with no Location, as Archiving is, timed
  and attributed as every edit is. It stays through edits to the Recipe's
  content and slot until someone chooses another or clears it, so a
  Reference Shot may be on another Profile than the Recipe's names now,
  which its read says (`profileDiffers`). An Archived Recipe keeps it and
  may have it cleared, but is given none until restored (409), as it is put
  in no slot. A Shot hidden after it was chosen, because its Pending
  Machine was dismissed, leaves the Recipe reading as having none until that
  hardware is adopted, when it reads it again; it is kept stored. Choosing
  one locks the Location and then the Recipe's row, as a slot change does.
  The Recipe's other Shots are read against it in a Shot Summary grouped by
  Recipe, in the Overview's cells and on a Shot's page (`SHOTS.md`, Shot
  Summaries and Management interface; #473).
- **A tablet may choose a Recipe's Reference Shot, and may not clear it**
  (#511, ADR-0030, amending ADR-0029, which left choosing to the management
  interface and the MCP endpoint). A Skin sends the plugin's `reference`
  endpoint a PUT naming the Recipe by its DYE2 record on the tablet and a
  Shot's id (`PLUGIN.md`, Choosing a Recipe's Reference Shot), which the
  plugin asks the server for as a request (`chooseReference`,
  `AI_PROTOCOL_NOTES.md`, Requests for a Skin).
  - **One service, the same locks.** `SkinRequestsService` finds the
    connection's Machine served at a Location and has
    `RecipeEditsService.chooseReferenceShotOnTablet` make the choice in the
    same transaction: the Location's lock and then the Recipe's row, the
    update, the history entry and the `library_changes` announcement are
    those of `setReferenceShot`, which the REST route and
    `set_reference_shot` call.
    The transaction holds the Machine's row first, as a tablet's report
    does (`lockHeldMachine`), which a hello, a move and a sharing switch
    take too: a choice is made only by the connection holding a Machine
    that is served at the Recipe's Location as it commits.
    So the other tablets' copies are replaced and their Skins pushed, and
    the Recipe's REST read, `get_library_item` and the management interface
    show it at once.
  - **No person.** The history entry names the Machine and the tablet and no
    account, as a dial-in change saved from a tablet does (`tabletSource`),
    timed by PostgreSQL's clock. The Recipe's history shows the Machine.
  - **Which Recipe.** One of the Location the Machine is served at. Another
    Location's is refused as `notAtThisLocation`, one the Library doesn't
    hold as `noSuchRecipe`, and an Archived one as `archived`, as the REST
    route refuses it (409).
  - **Which Shot.** One the tablet may read whole (`readableWhole` in
    `server/src/shots/location-references.ts`): a Shot the Shots list lists
    for its Location, or the Reference Shot of one of its Location's
    Recipes, which may be another Location's. Any other is refused as
    `noSuchShot`. The management interface and an assistant may still
    choose any listed Shot.
  - **Never clears.** A request names a Shot: the wire has no way to ask
    for none, and the plugin refuses a body without a `shotId`.
  - **Never queued.** The plugin refuses at once while it isn't connected,
    and keeps nothing to send later; the request follows the tablet's
    reports, so a Shot pulled seconds ago is chosen once the server has
    stored it. A request the plugin sent and has no answer to, as its
    connection closed or 10 s passed, is answered to the Skin as
    unreachable too, though the server may have made the choice, or make
    it once its transaction has its locks, within that transaction's 60 s:
    a request carries no deadline, and a choice that has taken its
    Machine's row is finished whether or not its connection still stands.
    One whose connection was released first, as when it closed while the
    request waited its turn, is not made.
  - **Releases (ADR-0025).** The request came with requests' wire revision,
    3, which every release a plugin works with now has, so it has no check
    left.
  - `server/test/skin-reference-choices.test.ts` covers it through the
    built plugin in simulated tablets, with two instances on one database
    and with raw frames, `server/test/latest-release/mixed-versions.test.ts`
    a tablet the latest release's instance holds, and
    `e2e/reference-shots.spec.ts` the Recipe's history.
- **A Recipe's Reference Shot on its Location's tablets** (#510, ADR-0030,
  amending ADR-0029). Each served tablet keeps a copy of the Reference Shot
  of each Recipe in a slot at its Location, whole, with its measurements,
  whichever Machine or Location pulled it, in any of the nine slots, so a
  Skin draws it through the plugin's `reference` endpoint while the server
  can't be reached (`PLUGIN.md`, A Recipe's Reference Shot). It is a copy in
  the plugin's own storage, not a field of DYE2's recipe record or a Shot in
  Decaid.
  - **Kept current.** A tablet's copy is sent again, or the slot emptied,
    when the Recipe's Reference Shot is chosen, replaced or cleared; when
    that Shot's record is stored anew, as its rating or note changes; when
    the Recipe enters or leaves a slot, or is Archived, which takes it out
    of its slot; and when the Shot is hidden with its Pending Machine, or
    shown again as that hardware is adopted. Each of those announces the
    Location (`library_changes`), and every instance then reads what its
    tablets are due.
  - **Worked out from the database,** as a tablet's writes are, on each
    connection and at each announcement: the plugin says which copies it
    holds, by a version for each slot, and the server sends those that
    differ. Nothing is stored of what a tablet holds. So a tablet that was
    off catches up when it reconnects, on any instance, and a tablet whose
    Machine is made Capture-only, or moved, has its copies emptied or
    replaced (`AI_PROTOCOL_NOTES.md`, Reference Shot copies).
  - **A copy is what the tablet would be answered:** the Recipe as that
    tablet names it, the Shot with its rating and note, the Recipe it was
    pulled with, the Location's Recipes it is the reference of, and whether
    its Profile differs from the Recipe's, as the Recipe's REST read says
    (`referenceProfileDiffers` in `server/src/shots/links.ts`). A Recipe with
    no Reference Shot, or one the Shots list doesn't list, is kept as having
    none.
  - **Too large to keep.** A copy whose JSON passes 1 MiB is not sent: the
    tablet keeps only that the Recipe has one, and reads it from the server
    each time. A long Shot's record passes that.
  - **A tablet reads the Reference Shot of any Recipe of its Location,** in
    a slot or not, from the server, a Shot pulled at another Location
    included. A Recipe of another Location is refused as no such Recipe to
    a read, where a choice is told it is not at this Location, above.
  - `server/test/skin-references.test.ts` covers them through the built
    plugin in simulated tablets, with two instances on one database, and
    `server/test/latest-release/mixed-versions.test.ts` with the latest
    release's plugin, which is sent none.
- **Archive and restore.** An Archived Bean or batch is offered nowhere, with
  the Bean's batches, and is archived on every tablet that holds it, but kept,
  with each Location's state of it, so restoring it offers it again where it
  was. A Bean is Archived or restored under the lock new beans are matched
  under, so a tablet never links a new bean to a Bean Archived at once. Each
  is a history entry of the item (`archived`). A Grinder's Archived state
  is a field of its content, merged as a tablet's archiving is. An Archived
  Profile is
  shown nowhere and hidden on every tablet that holds it, but keeps each
  Location's state of it, which can still be changed, so restoring it shows
  it again where it is shown. An Archived Basket or Tool is the same, but
  removed from every tablet's list, as DYE2 cannot hide one, and written again
  where it is shown once restored; it is Archived or restored under the lock
  its kind is matched under, as a Bean is, since a tablet's new record is
  never linked to one Archived.
- **Who.** An Admin does everything. Staff edit the Library's shared content
  anywhere (a Bean, a batch's details, a Basket, a Tool) and Archive and
  restore items, but add and finish batches, set their remaining weight,
  create and edit Grinders, create Baskets and Tools, show and hide
  Profiles, Baskets and Tools, and create, edit, slot, Archive and restore
  Recipes and choose and clear their Reference Shots, and copy a Recipe
  from anywhere to a Location, only at the
  Locations they work at, as a Grinder and a Recipe belong to one
  (ADR-0008), and never hard-delete. A Recipe's Conflicts are
  resolved where it may be edited.

### Hard deletes

An Admin hard-deletes a Bean, Bean Batch, Grinder, Profile, Basket, Tool or
Recipe no Shot names (ADR-0003, `hard-deletes.ts`), and a Basket or Tool
only where no Recipe names it either (ticket #147): it is gone from the
Library at once, with its history, Conflicts and each Location's state of
it, and from every tablet that holds it, the one thing the server deletes
from tablets. A Bean goes with its batches, as Decaid refuses to delete a
bean that has any. Decaid's bundled Profiles are never deleted (409): every
tablet has them, and Decaid refuses to delete one; they are hidden at
Locations or Archived instead. A Recipe goes from every tablet's DYE2
recipes at its Location, and from each Machine's Loaded Recipe history; a
Workflow still naming it has its `recipeId` cleared, as for a Recipe
Archived (`WORKFLOW-AND-STATE.md`, Following the Recipe).

- **Named by a Shot.** A Shot names its batch and Grinder by their ids on the
  tablet that pulled it (`shots.bean_batch_id` and `shots.grinder_id`, from
  its Workflow's context). An item whose record has such an id on any
  tablet's map is named, and so is one a Shot is linked to (`SHOTS.md`,
  Links to the Library), and a Bean is named when one of its batches is: its
  delete is refused, and it can be Archived instead. A record a tablet
  deleted itself has left its map, so a Shot naming only that record counts
  only if it was linked to the item before. A Shot names a Profile whose
  steps its Workflow's `profile` has, compared as JSON so a whole double
  Decaid writes as `92.0` equals 92, with each step's temperature left out
  and a step's limiter of value 0 as none, as a skin overrides or sends them
  (`SHOTS.md`, Links to the Library), or by
  the profile id a skin recorded in its Workflow (`shots.profile_id`);
  Decaid itself records none. A Shot names a Basket as it names a batch, by
  the id DYE2 recorded (`shots.basket_id`) or its link, and a Tool the same
  way, by its id on the tablet among the Tools DYE2 recorded
  (`shots.tool_ids`) or its link (`shots.library_tool_ids`), so one
  Archived or hidden, whose record has left every tablet, stays named. A Recipe is named only by a Shot linked to it, one
  pulled while its Machine had it loaded (`SHOTS.md`, Links to the
  Library): a Capture-only Machine's Shots name one by its global id that
  was never their Machine's Loaded Recipe, and leave it deletable. Storing
  a Shot holds the row of the Recipe it names for key share, so a delete
  waits for it and then finds it linked, or deletes the Recipe first, the
  Shot then linked to none. Only the steps are compared, not the rest of
  what Decaid hashes for a Profile's id: a skin sets the Workflow's
  profile's target weight to the Shot's yield, so a Shot pulled with a
  Profile can hold other targets, and refusing a delete is the safe side.
  A Shot the server takes in after the delete, as one an offline
  tablet pulled, that names a record still to be deleted keeps that record
  on its tablet, out of the Library, and so does the record of that batch's
  Bean there, which the plugin would delete with its batches. The plugin
  also refuses to delete a record a Shot it queued since it loaded, or has
  yet to read and send, names (by that Shot's latest record, by its edit
  time, so an edit naming another record releases the first, and a record
  read before the edit but noted after it changes nothing), as the server may have planned the delete
  before it had that Shot; the server keeps the record once it has it. It
  reads at most 20 Shots still to be read for this, and refuses any delete
  while more are, as during a backfill (`SHOTS_STILL_TO_READ`): the
  writer then leaves that delete out for two heartbeat intervals and asks
  again on the same connection, until the Shots have been sent. A
  Shot the plugin finds only later, from its index once it has reloaded, can
  come too late to keep it. Baskets and Tools are kept on tablets the same
  way, by the ids a Shot recorded; a Recipe's record is not, as a Shot
  names a Recipe only by being linked to it, which the server judges.
- **Named by a Recipe.** A Basket a Recipe names (`basketId`), or a Tool
  among its `toolIds`, Archived Recipes included, is not deleted (409): take
  it out of the Recipe, or Archive it, instead. Recipes are read under the
  items' row locks, which a Recipe's edit naming one takes, and the locks
  of the tablets that hold them, which a tablet's report of its recipes
  takes as it names one by its record there. Other kinds a Recipe names
  are deleted, and the Recipe left naming one the Library no longer has, as
  before.
- **Tablets.** Each tablet's record of the item, read from its map, is kept
  as a delete due there (`tablet_deletions`), and the item's global id is
  kept (`deleted_items`). Each tablet's writer deletes its records, a bean's
  batches before the bean, ahead of any write but the clearing of a joining
  tablet's Workflow (Joining a Location, below), now or once the tablet
  connects again. Its next report no longer lists the
  record, or the plugin answers that it deleted it or found it gone, and the
  delete is no longer due. A record a tablet reports carrying a deleted
  item's global id that its map does not hold, as from one that was offline,
  written the item by a write whose answer was lost, or restored from a
  Decaid backup, is not taken in as new: it is deleted there too. A record
  the map held that carries no global id, as one whose global id was still
  to be written, is deleted too; one that now carries another item's is not
  the deleted item's, and is taken in again from the tablet's next report.
  A Profile's records carry no global id, its id being Decaid's, the same on
  every tablet: so its global id is not kept, and a record of it a tablet
  reports later, but for one due to be deleted there, joins the Library
  anew, shown where it was reported, as when a barista saves the same
  profile again. That includes one restored from a Decaid backup after its
  delete was carried out. A Profile written to a tablet whose answer comes
  only after the delete is not recorded: that record is due to be deleted
  there too. A delete of a Profile's
  record is due only while the Library lacks the Profile: once it joins
  again, the record still due to be deleted, as one a Shot kept, is that
  Profile's, and the tablet's next report takes it in. A purge carried out
  once the Profile joined again, planned before, also removes the record
  from the tablet's map, so its next report does not read the record gone
  as the tablet's delete, and the writer writes it again where its Location
  shows it. The plugin deletes a bean's batches with it, those the Library never knew
  included, such as one a barista made of it offline; such a batch's Shots,
  which the server could not see when the Bean was deleted, then name a
  batch the tablet no longer holds.
- **Locks.** It takes the item's open Conflicts' row locks, then the row
  locks of the tablets that hold it, then the locks of the Locations whose
  state of it changes (for a Profile, each that decided whether it shows
  it), then the items' rows, the order every other change
  takes them in, and decides whether a Shot names it under them. A tablet or
  Location that came to hold the item while those were taken is found once
  the items' rows are locked, as nothing else can come to hold them then,
  and the delete starts again, at most three times. A batch created of the
  Bean, or a batch placed at a Location, meanwhile waits for the items'
  locks and then finds them gone (404), as does showing a Profile at a
  Location; a tablet's report mapping one fails on its foreign key, and is
  taken in when the plugin sends it again.

## Taking in a tablet's beans

The plugin reports its beans as milestone 1's `beans` collection, now with
each record's `updatedAt` placed in UTC beside the list (`COLLECTIONS.md`).
When the collection is stored for a Machine that takes part, the same
transaction takes the beans into the Library (`takeInBeans` in `beans.ts`),
holding the Machine's row lock, which Location History changes take, then the
tablet's row lock, which every change to its map takes, then, if any record
is new to the map, one advisory lock under which new beans are matched, so two
tablets entering the same coffee at once make one Bean, then the Location's
advisory lock, under which its state changes. It runs with a 60 s limit: a
tablet reporting 1,000 beans new to the Library took 0.75 s on the development
database.

A record without what every supported Decaid sends (its id, roaster, name and
an `updatedAt` the plugin could place) is ignored. Each other record, in the
order reported (`planIntake` in `bean-intake.ts`):

1. A record the tablet's map holds by its local id stays that Bean, whatever
   global id it carries, so a global id another plugin wiped is written back
   rather than the record taken for a new Bean. Its record replaces the one
   known if its time is later; one as old or older changes nothing, unless, as
   old, it was archived or un-archived since: the plugin reads times to the
   millisecond, within which it was changed. But a record that no longer
   carries the Bean's global id, while the one known does, replaces it
   whatever its time, as after the tablet's clock went back, so the id is
   written back. A record replacing one that was not archived, now archived,
   takes the Bean away from the tablet's Location (ADR-0019): its batches
   there are finished, as a bean is deleted only with its batches (DYE2
   deletes them first, since Decaid refuses to delete a bean that has any),
   and its origin there ends, so the Bean is no longer offered there. A batch
   added there later than the archiving stays, unless the tablet's record of
   the Bean had seen that: it answered a write to the Bean after it
   (`seen_at`, above). What its records of the batches have seen does not
   count, as the plugin may read the Bean archived after it answered a write
   to a batch, though the barista archived it before (ADR-0020). Un-archived,
   the Bean is offered there again, as an origin, while none of its batches is
   there. Each field of its content that differs from the record known is an
   edit (Edits, above); one as old as the record known that differs so was
   changed within the millisecond too.
2. Otherwise a record carrying a Library Bean's global id is that Bean, as on
   a tablet whose answer to a write was lost, or one restored from a Decaid
   backup, unless another record the tablet reports is that Bean already: it
   is then matched as a new record. Such a record changes nothing at the
   Location or in the Bean; the Location's state and the Bean's content are
   written to it, over any change the
   tablet made to it before it was mapped, as when the plugin reloaded
   between a write whose answer was lost and a barista's edit, so no outbox
   held the answer any more.

Records whose Bean these settle come first, so a record matched by roaster
and name, though listed before them, cannot take their Bean. Then, in the
order reported:

3. Any other record is new. It is linked to the oldest Library Bean, not
   Archived, whose roaster and name match its own, ignoring case and white
   space at either end (`beanMatchKey`), unless one of the tablet's other
   records already is that Bean: it then takes the Bean's content, each field
   it held otherwise kept as a Conflict (ADR-0018). Otherwise it joins the
   Library, created at the tablet's Location, its content its first
   history entry. Either way, unless it is archived on the tablet, the Bean
   is offered at the tablet's Location, as an origin, while none of its
   batches is there.

Last:

4. A record the map holds whose id the list no longer holds, readable or
   not, was deleted on the tablet, unless another record it reports is that
   Bean now. The Bean is taken away from the tablet's Location as for one
   archived, and the map holds the record no more. A new or reset tablet's
   map holds nothing, so its report deletes nothing (ADR-0019).

A record carrying a global id the Library does not know is new, and gets the
new Bean's id, unless an Admin hard-deleted that Bean: it is then deleted
from the tablet (Hard deletes, above). So, for each kind, a record the tablet
is due to delete is not taken in at all. Beans are matched only when a tablet first reports them
(ADR-0018), so two Beans with the same roaster and name, as when one tablet
holds two such records, stay apart, and each lists the other as a likely
duplicate.

When a report changes what the Location offers, or the tablet's map, or
leaves a record there without its global id, it commits with a `NOTIFY` on
the `library_changes` channel naming the Location (ADR-0016;
`server/src/notifications.ts`, the one listening connection each instance
holds, shared with `machine_access`).

## Taking in a tablet's bean batches

The plugin reports its bean batches as the `beanBatches` collection, after its
beans, and taken in the same way, under the same locks (`takeInBatches` in
`bean-batches.ts`, planned by the pure `planBatchIntake` in
`batch-intake.ts`), as its Location's state:

- A record without what every supported Decaid sends (its id, its bean's id
  and an `updatedAt` the plugin could place) is ignored.
- A record the map holds stays that batch, its record replacing the one known
  as a bean's does, and also when, as old, it differs at the Location. What changed since the record known is what the tablet did
  at its Location (ADR-0008): un-archived, the batch is added there;
  archived, it is finished there; a changed `weightRemaining`, cleared
  included, is its remaining weight there. Adding or finishing it there is an
  edit timed by the record, which loses to a later one the tablet had not
  seen (`batch_locations`, above; ADR-0020). A remaining weight replaces the
  one known when the tablet had that value, none was ever entered there, or
  it was entered later than the value known, which the tablet had not seen;
  otherwise it is kept as a Conflict, and so is a value replaced that the
  tablet had not had, entered by another tablet. Any other field changed is
  an edit of the batch's content (Edits, above).
- A record carrying a Library batch's global id is that batch, changing
  nothing at the Location, as a bean's, and so written the Location's state
  over any change the tablet made to it before it was mapped.
- Any other record is new: Bean Batches are never matched (ADR-0018). It
  joins the Library as a batch of the Bean that the tablet's map holds its
  bean's record as. Unless it is archived on the tablet, it is at the
  tablet's Location from then, with the remaining weight its record has, and
  its Bean's origin there ends. One whose bean the map does not hold yet waits
  for a report taken in once it does: the plugin sends the batches in full
  after every report of its beans (`COLLECTIONS.md`).
- A record the map holds whose id the list no longer holds was deleted on the
  tablet, unless another record it reports is that batch now: if the tablet
  held it there, not archived, it is finished there, and the map holds the
  record no more.

## Taking in a tablet's grinders

A Grinder is equipment, and belongs to one Location (glossary, ADR-0008): the
Location of the tablet that created it. Only that Location's tablets hold it
unarchived. The plugin reports its grinders, archived ones included, as the
`grinders` collection, and they are taken in as beans are, under the same
locks but for the matching lock, as Grinders are never matched (ADR-0018)
(`takeInGrinders` in `grinders.ts`, planned by the pure `planGrinderIntake`
in `grinder-intake.ts`). Two grinders of one model, at one Location or two,
are two Grinders.

- A record without what every supported Decaid sends (its id, its `model`
  and an `updatedAt` the plugin could place) is ignored.
- A record the map holds stays that Grinder, its record replacing the one
  known as a bean's does. Archived since, the Grinder is Archived; un-archived
  since, it is restored (ADR-0019). Either only if it belongs to the tablet's
  Location: a tablet whose Machine moved still holds its old Location's
  Grinders, archived, and un-archiving or archiving one there changes nothing
  but what is written to it. Whether it is Archived is a field merged with
  its content's (Edits, above), so an archiving made offline loses to a
  restore made later that its tablet had not seen, and is kept as a Conflict.
- A record carrying a Library Grinder's global id is that Grinder, as a
  bean's is, changing nothing: the Library's state is written to it.
- Any other record is new, and joins the Library belonging to the tablet's
  Location, Archived if it is archived on the tablet.
- A record the map holds whose id the list no longer holds was deleted on the
  tablet (Decaid's delete removes the record), unless another record it
  reports is that Grinder now: if the tablet held it unarchived, and it
  belongs to the tablet's Location, it is Archived, timed when the server
  learns of it but no earlier than the record known, and the map holds the
  record no more. Only a Grinder the tablet held can be Archived this way: a
  new or reset tablet's map holds nothing, so it Archives nothing.

So archiving or deleting a Grinder on a tablet Archives it, and it is archived
on its Location's other tablets, never deleted; un-archiving it on a tablet
there restores it, and it is written to them again.

## Taking in a tablet's profiles

A Profile keeps Decaid's id, `profile:` and the start of a hash of what the
machine executes (its steps, targets and tank temperature, not its title,
author or notes), so a record's id is its Profile's on every tablet, and its
records carry no global id (ADR-0006). An identical Profile created on two
tablets is one Profile, and changing a Profile's steps makes a new one:
Decaid's `PUT /profiles/{id}` with new steps replaces the record under the
new id, and Streamline saves the changed profile as a new record, with the old
one as its parent, and hides the old one.

The plugin reports its profiles, hidden and deleted ones included, as the
`profiles` collection, and they are taken in as beans are, under the same
locks (`takeInProfiles` in `profiles.ts`, planned by the pure
`planProfileIntake` in `profile-intake.ts`); a report with profiles new to the
tablet's map takes one advisory lock, so two tablets reporting the same new
Profile at once make one. On a tablet, a Profile's `visibility` says whether it
is shown at the tablet's Location: `visible`, or `hidden` or `deleted`, which
Decaid's delete marks a user's Profile with, and hides a bundled one.

- A record without what every supported Decaid sends (its id, its `profile`,
  its `visibility` and an `updatedAt` the plugin could place) is ignored, and
  so is one of a Profile an Admin hard-deleted that is due to be deleted
  there, while the Library lacks that Profile (Hard deletes, above).
- A record the map holds replaces the one known when it is newer, or as old
  but of another visibility. Made visible since, the Profile is shown at the
  tablet's Location; hidden or deleted since, it is hidden there (ADR-0019),
  as is one the tablet had hidden and deleted since, since another tablet may
  have shown it there meanwhile. Only a Profile the tablet held can be hidden
  this way. Each is an edit timed by the record. One from a tablet whose
  record had seen the Location's last decision of the Profile (`seen_at`,
  above) applies. Otherwise, as from a tablet that was offline, one timed
  before the edit that decided the Location's state loses to it (ADR-0020),
  and the Location's state is written back to that tablet. One that applies
  decides it again even when it leaves it shown or hidden as it was, so an
  earlier edit that arrives later cannot undo it. One that loses is kept as a
  Conflict, and so is a decision replaced that the tablet had not seen, made
  by another tablet. A changed title, author or notes of a user's Profile is
  an edit of its content (Edits, above), so a rename reaches every tablet that
  holds it, under the same id. A Profile the tablet purged and
  re-created, or deleted and made visible again, between two reports shows no
  change in them, so it is no edit: where the Location hid it meanwhile, it
  stays hidden there.
- Any other record is one the map does not hold yet: the tablet created it,
  held it before it joined the Location, or was written it by a write whose
  answer was lost. If the Library has its id, it is that Profile, and a
  user's Profile takes its title, author and notes, each the record held
  otherwise kept as a Conflict (ADR-0018); otherwise it joins the Library,
  created at the tablet's Location. Where the Location has
  decided nothing of the Profile yet, the record's visibility decides it, so a
  Profile new to the Library is shown where it was created only, and an
  identical Profile created at two Locations is shown at both. Otherwise the
  Location's state stands, and is written to the tablet: a new tablet's
  bundled Profiles do not show those its Location hid. But a user's Profile
  the tablet made visible after both it joined the Location and the Location
  last decided the Profile, by their times, is an edit made there, and so,
  whatever its clock, is one it reports after its own edit decided the Profile
  there last, as when it deleted or replaced the Profile there, as a tablet
  reports in order. Either shows it, as when a barista changes a Profile's
  steps back, which Decaid's `PUT` makes a record under the old id again, or
  re-creates one purged. Shown there already, it is the Profile's latest edit
  there still, so an earlier hide that arrives later cannot undo it
  (ADR-0020). A tablet joined its Location at the later of when its Machine
  arrived there, by its Location History, and when the tablet first connected
  as that Machine. Decaid's bundled Profiles join the Library like any other,
  so whether each is shown is per Location.
- A bundled Profile the map holds that the tablet's Location has decided
  nothing of, as after its Machine moved there, is decided by its record, as
  on a first report there. A user's Profile the map holds stays as the
  Location has it: hidden there, as it belonged to the Location the tablet
  held it at (ADR-0008), until it is shown there.
- A record the map holds whose id the list no longer holds, as when Decaid
  replaced it or a purge removed it, is gone: it is hidden at its Location, as
  deleting it there does, whether the tablet held it visible or not, and the
  map holds it no more. A new or reset tablet's map holds nothing, so it hides
  nothing.

So hiding, deleting or replacing a Profile on a tablet hides it at that
tablet's Location only, and a Profile whose steps changed is a new Profile,
shown where it was changed only, while the old one is hidden there and still
shown wherever else it was.

## Taking in a tablet's baskets and tools

Decaid has no resource for baskets or tools, so DYE2 keeps them whole in a
list under one key of Decaid's store each, `baskets` and `equipment` under
`dye2.reaplugin`, and every save reads the list and posts it back (ADR-0005).
The plugin reports them as the `dye2Baskets` and `dye2Equipment` collections,
a key never written as an empty list, and each record beside when it first
read the record's current content, as they carry no edit time
(`COLLECTIONS.md`). They are taken in as beans are, under the same locks,
each kind under a matching lock of its own (`takeInEquipment` in
`equipment.ts`, planned by the pure `planEquipmentIntake` in
`equipment-intake.ts`). A Basket is a model of basket, at every Location, and
a Tool any other gear DYE2 lists; each is in the Library, and each Location
shows or hides it, as a Profile (ADR-0008). Grinders stay per Location.

- **Unrecognised shapes.** A list that is not an array of records each with an
  id no other holds (`dye2Records` in `protocol/`) takes nothing in, and the
  tablet's map stays as it was, so nothing in it reads as deleted. It is kept
  for the tablet (`tablet_unrecognised_lists`), and the tablet's writer
  writes nothing to that list, nor removes from it, until a report holds it
  in a shape that is recognised. Its other lists keep syncing. The plugin
  finds the same as it writes (`listUnrecognised`).
- A record without what DYE2 always saves (its id and name) or a time is
  ignored.
- **Content and ids.** A record's content is its fields but its id,
  `createdAt` and global id, which DYE2 keeps in a top-level field of the
  record's own (`decentSyncId`, ADR-0006) and keeps when it saves. A record
  the map holds by DYE2's id stays that item whatever global id it carries,
  so one that lost it, as from another app's save or a backup taken before
  it was written, has it written back. One the map does not hold carrying an
  item's global id is that item, changing nothing at the Location, as a
  bean's.
- **Edits.** A record the map holds that differs from the record known is an
  edit of each field of its content it changed, timed by when the plugin
  first read it, merged per field (Edits, above). But a field the report
  sets back to the value the tablet held just before the server's latest
  write to that field (`before_write`), is taken as
  unchanged: DYE2's pages save every field as they loaded it, and another
  app rewriting the list at the same moment as the plugin's write puts the
  record back as it was (ADR-0005). The item's value is then written again.
  A write's answer showing such a field, as the plugin read the list before
  another write to the record, is taken the same way; if the record holds the
  item's content all the same, as when that write was undone, the tablet has
  seen it (`content_seen_at`), and nothing is written. A field an answer
  shows holding the item's value is no edit of the tablet's, and keeps its
  value before the server's write: the plugin left out a write of a value
  the tablet held already, the record known behind it after an answer was
  lost. A field whose value before the server's write both the record and
  the item hold again, on the tablet's next report or answer, keeps it no
  longer, so a later write of the field guards against a stale save of it.
  A barista who deliberately sets a field back to exactly that value has to
  set it again: the write that puts the item's value back over it does not
  keep that value as the tablet's before it, so setting it once more is an
  edit. So is setting it back once the tablet has reported the field with
  any other value. The cost: a second stale save of the field in a row, or
  the rewrite lost again at once, counts as the tablet's edit; so does a save
  from a page opened before two of the server's writes of the field, setting
  it back to its value before the first; and a stale save of a field whose
  value before the server's write the item took again, by another tablet's
  edit, before the tablet reported it, once the server writes the field
  next.
- **New records** are matched by name, ignoring case and white space at
  either end (`equipmentMatchKey`), to the oldest of the kind not Archived,
  as DYE2 itself refuses a second tool of one name (ADR-0018): linked, the
  record takes the item's content, each field it held otherwise kept as a
  Conflict, and the item is shown at the tablet's Location. Otherwise it
  joins the Library, shown at the tablet's Location only.
- **Gone from the list.** A record the map holds that a report listed before
  was deleted on the tablet: the item is hidden at the tablet's Location
  only (ADR-0019), as a deleted Profile is, timed when the server learns of
  it, and the map holds it no more. DYE2 deletes Tools; it cannot delete a
  Basket, but one gone is taken the same way. A record the server's write
  created that no report listed before it went was lost to another app
  rewriting the list as the plugin wrote it: the map forgets it, and the
  writer writes it again where its Location shows it.
- **Joining.** A report that is part of joining takes nothing of the
  tablet's in, as for any kind (Joining a Location, below): its records of
  items the Library has are those items, written the Location's state, and
  the rest are left out, removed from the list by the writer, as DYE2 can
  neither archive nor hide one, and not kept (ADR-0005). A Location that
  shows none of the kind yet takes the joining tablet's own. A record left
  out that is listed again after its removal, as another app rewrote the list
  at the same moment, is removed again. A tablet that took part at its
  Location before Baskets and Tools were shared is not joining as it first
  reports them: the migration that added them records those lists as taken
  in where its profiles were, so its baskets and tools join the Library.

So a Basket or Tool created in DYE2 on one tablet is written to the other
tablets at its Location, and to another Location's once shown there; an edit
on any tablet reaches every tablet that holds it; and deleting a Tool hides it
at that Location only. Hiding one at a Location removes it from that
Location's tablets' lists.

## Taking in a tablet's recipes

DYE2 keeps its recipes whole in one list under one key of Decaid's store,
`recipes` under `dye2.reaplugin`, each under an opaque id, and its Recipe
Slot in its `stripSlot`, 1 to 9 or null (ADR-0005). DYE2 keeps any number
of recipes, its Select Recipe page listing and applying them all, up to
five of them on Streamline's DYE strip, those in slots 1 to 5. Its editor gives a new recipe a
UUID, and its `save-recipe`, which Streamline's strip calls from its
long-press menu, an id `recipe-…`; a recipe saved before DYE2 v0.1.25 has
its slot's number. The plugin reports them as the `dye2Recipes`
collection, as it reports baskets and tools (Taking in a tablet's baskets
and tools, above), after them, as a recipe names them, and they are taken
in under the same locks, the Location's lock, under which its record ids
and slots are decided, taken for every report (`takeInRecipes` in
`recipes.ts`, planned by the pure `planRecipeIntake` and mapped by the
pure module `recipe-intake.ts`). A Recipe belongs to one Location, has one
record id there (`recipes.record_id`), the id of its record on every
tablet there, which never changes, and has a slot there, or none. Recipes
are never matched (ADR-0018).

- **Unrecognised shapes.** A list whose records are not each an object with
  an id (`isRecordId` in `protocol/`) no other record holds is in a shape
  that is not recognised, and is treated as such a list of baskets or tools
  is.
- **Content.** A Recipe's content is in the Library's terms: `name`,
  `beverage`, `beanId`, `beanBatchId`, `profileId` (Decaid's id),
  `grinderId`, `basketId`, `toolIds` and `toolAttributes` (DYE2's
  `equipmentCustom`, by each Tool's global id), `dose`, `yield`, `ratio`,
  `grindSetting` (a number, or text as typed), `rpm`, `feedRate` (text
  as typed, as DYE2 v0.1.34 keeps one in `dashboardVariables.feedRate` and
  its embedded Workflow's `context.extras.feedRate`), `brewTemperature`,
  the eleven steam, hot water and flush settings (`steamTemperature`, `steamDuration`,
  `steamFlow`, `steamStopTemperature`, `hotWaterTemperature`,
  `hotWaterDuration`, `hotWaterVolume`, `hotWaterFlow`, `flushTemperature`,
  `flushDuration` and `flushFlow`; Steam, hot water and flush settings,
  below), and DYE2's `steamMode` and `hotWaterMode`, a field it holds no
  value for left out. A record names what it uses by the tablet's
  own ids, read through the tablet's map: one the map does not hold, as one
  of the tablet's own, names nothing. A record is compared and written by
  its fields' paths (`recipeView`), a field of its `dashboardVariables` as
  `dashboardVariables.dose`. A record's dose, grind setting or RPM of 0 is
  read as none (`noneAtZero`), as DYE2's editor saves an RPM left blank as 0
  and DYE2 applies it as none: a 0 a tablet saves is taken in as none, and a
  record holding one is neither an edit nor written again for it, while a
  write that does change the field expects the 0 the record holds
  (`recordValueAt`, `heldValue` in `holdings.ts`). A yield of 0 is a value,
  stop-at-weight off.
- **What is no edit.** The fields DYE2 derives, `title`, `subtitle`, the
  embedded `workflow`, `capturedAt`, and the names it copies (`beanName`,
  `beanRoaster`, `profileTitle`, `grinderModel`, `basketName`,
  `equipmentNames`), are
  written but never taken in, and so is `profileSnapshot`, but that a
  record naming no `profileId`, as DYE2 saves a Profile read from the
  Workflow, names the Library Profile its `profileSnapshot` is, found as a
  Shot's Profile is (`profileOfSql` in `shots/links.ts`); a snapshot that is
  none of the Library's changes none, and is written over with the Recipe's.
  So does a `profileId` that is none of the Library's Profiles, as one made
  on the tablet that the plugin has not reported yet (`refusedPaths`,
  #570). A barista or
  drinker typed into a recipe is not shared: it is no field of a Recipe, and
  is written back blank.
- **Steam, hot water and flush.** Each setting is taken in from DYE2's
  field of it in `dashboardVariables`, as `steamTempC`, one the record holds
  none of holding none (`RECIPE_SETTINGS` in `protocol/`). A steam
  temperature below 135 °C (`STEAM_ON_FROM`), as DYE2's editor saves "Off"
  as 0, is no edit, and the Recipe's is written back over it
  (`steamOffPaths`): steam on and off is each Machine's own, and DYE2 saves
  no steam temperature or steam time from a Workflow whose steam is off
  (`WORKFLOW-AND-STATE.md`, The Loaded Recipe). A steam time of 0 is a
  value. The steam
  and hot water modes (`steamMode`, `hotWaterMode`) are DYE2's display
  choice, which value its stepper shows: fields of the content, taken in as
  any is and written to every tablet, but applied to nothing, as a DE1
  always uses both a steam time and a steam flow, and all four hot water
  values.
- **Its Bean Batch** is DYE2's `beanBatchId`, beside the Bean
  (decentespresso/dye2#27). A batch picked with its Bean in DYE2's editor is
  the Recipe's. A Bean picked with no batch, or with one of another Bean,
  keeps the Recipe's batch if it is of that Bean; otherwise the Recipe takes
  that Bean's batch most recently added at the Location, still there, or no
  batch where the Bean has none there. `beanId` wins: a `beanBatchId`
  changed under the Bean the record names already is taken where the batch
  is of that Bean, with that Bean where the Recipe names another since, as
  one pick (Merging, above), and otherwise changes nothing. A record naming an
  Archived Bean, or holding with its Bean a batch that is Archived, of an
  Archived Bean or not at the Recipe's Location (never added there, or
  finished there), changes neither: the Recipe keeps its Bean and batch, which are written
  back over the record's, and nothing is offered or added at the Location
  (`refusedPaths`, #570). DYE2 never saves a batch picked on a Machine into
  the recipe, so Decent Sync records it: a batch picked on a Machine with
  the Recipe loaded becomes the Recipe's, with its Bean where it is another
  Bean's, on any Skin (#570), but not one the Library retired (above), which
  stays that Machine's own, the Recipe still loaded; nothing is taken on the load,
  which leaves a Recipe naming no Bean none, as it means no bean as DYE2
  v0.1.32 applies it (ADR-0022, `WORKFLOW-AND-STATE.md`).
- **A saved 0 is a value**, as a milk stop of 0 is off. DYE2 saves a blank
  field as `null` (decentespresso/dye2#29), which holds none.
- **Its Grinder** is one of its Location's: a record naming another, or one
  Archived, changes none. **Its Tools** the tablet holds no record of, which
  were never written to it, stay the Recipe's whatever the tablet's record
  names, each where it was, and so does its Basket while the tablet's record
  names none.
- **Edits.** Records are decided by their ids, as a recipe's id is the same
  on every tablet at its Recipe's Location (`planRecipeIntake`). A record
  the map holds stays that Recipe's: one that differs from the record known
  is an edit of each field of its content it changed, timed when the plugin
  first read it, merged per field (Edits, above), with no stale-save rule
  for recipe records (`before_write`), which Baskets and Tools keep, as
  DYE2's editor saves only the fields changed over a fresh read
  (decentespresso/dye2#28) and its dashboard only its own edits over a
  fresh read of the Workflow (decentespresso/dye2#31). What DYE2 saved from
  the Workflow of a Machine with the Recipe loaded that is no edit is
  written back over (`recordedByDye2`, `WORKFLOW-AND-STATE.md`, Following
  the Recipe). One carrying another item's global id, as a backup restored,
  or of another Location's Recipe, as before the writer removes it after a
  move, is written over, no edit of it; so is a write's answer of one. A
  record the map does not hold under the record id of one of the
  Location's Recipes not Archived is that Recipe's: carrying its global id,
  it is its record, as after a lost answer; otherwise it was saved under
  that id on the tablet before it held the Recipe, as a slot-number id
  saved there before DYE2 v0.1.25, and each field of its content that
  differs from the Recipe's is an edit of it, merged with Conflicts as an
  edit made without seeing the Recipe's. Any other record is a new Recipe
  at the Location, under its own id as its record id, as one DYE2's editor
  or `save-recipe` made.
- **Slots.** A record's `stripSlot` is its Recipe's slot at its Location, not
  its content (`recipeSlotOf` in `protocol/`: a whole number from 1 to 9,
  `RECIPE_SLOTS`, as DYE2 holds, shows and keeps a `stripSlot` of 6 to 9
  though it places a recipe only in 1 to 5 itself and Streamline's strip
  shows only those, ticket
  [#506](https://github.com/loganfuller/decent-sync/issues/506);
  any other value none, and none for a record hidden from the strip,
  `showOnStreamlineDashboard` false, as a recipe is on the strip exactly
  while it is in a slot, DYE2 v0.1.32's `stripTargetOf`). A record the map
  holds whose slot so read differs from the record known's moves its Recipe
  there, or out of its slot for none, as DYE2's editor moves a recipe on the
  strip or takes it off, DYE2's Select Recipe assigns one to a button for
  Streamline's "Replace <name>" or "Select recipe", taking the one there off
  it, and hiding it does, as Streamline's "Clear button" does keeping its
  `stripSlot` and DYE2's editor switching "Show on Streamline Dashboard"
  off; a new Recipe from a tablet takes its
  record's slot the same way (`slotMove` in `recipe-intake.ts`, `moveSlots`
  in `recipes.ts`). The Recipe that held that slot at the Location leaves
  it, kept in none, as DYE2's `takeSlot` does
  (`dye2:dye2-plugin/src/utils/dev-api.ts`). A move is made only where the
  Recipe is still in the slot the record known was in, so one made on a
  tablet that had not seen a move made elsewhere, as in the management
  interface, is not, and the Recipe's slot is written back. Each slot a
  move changes is a history entry of its own, from the tablet, timed as the
  record moved, and slots left are emptied first, so no two Recipes are
  ever in one.
- **A recipe named before its record arrives.** Once the tablet's map holds
  a record under an id it held none of, the Shots that tablet reported
  naming that id are linked to its Recipe (`linkRecipeShots` in
  `shots/links.ts`), and a Workflow of the tablet's naming it loads it
  (`recipeMapped`), as for a recipe `save-recipe` made and named at once,
  whose record reaches the server after the Workflow naming it
  (`WORKFLOW-AND-STATE.md`, The Loaded Recipe).
- **Gone from the list.** A record the map holds that a report listed before
  was removed on the tablet, which neither DYE2 nor Streamline does today:
  its Recipe is taken out of the slot the record known was in, at the
  tablet's Location, if it is still in it there, and kept (ADR-0019), a
  history entry of its own, `{ slot: null }` at that Location, timed when the
  server learns of it. A record the server's write created that no report
  listed before it went was lost to another app's rewrite, and is written
  again.
- **Joining.** A report that is part of joining takes nothing of the
  tablet's in, as for any kind (Joining a Location, below): a record of a
  Recipe the map holds is written over, or removed if it is not one of the
  Location's; the rest are left out, removed from the list, and not kept. A
  Location with no Recipes but Archived ones takes the joining tablet's in,
  with their ids and slots. The Workflow's Loaded Recipe of another
  Location is unloaded as the tablet joins, its `recipeId` cleared (Joining
  a Location, below).

**Writing.** Each sharing tablet holds every Recipe of its Location that is
not Archived, in a slot or not, each under its record id, with its slot in
`stripSlot`, null for none, so one in no slot is still found and applied
from DYE2's Select Recipe page (`recipeWrites` in `holdings.ts`); a record
of a Recipe Archived, or of another Location's, is removed first, so its id
is free. The list keeps the order the tablet holds it in, each new record
added at its end. Each record
written (`recipeRecord` in `recipe-intake.ts`) holds:

- the Recipe's content, naming its Bean, Bean Batch, Grinder, Basket and
  Tools by the tablet's own ids, each left out where the tablet holds no
  record of it, and its Profile by Decaid's id;
- its Recipe Slot in `stripSlot`, null for none, as Streamline places
  recipes on its strip by it as soon as any record holds the key
  (`recipeStripCells` in `streamline-js:src/modules/dye-selection.js`), and
  `showOnStreamlineDashboard` true exactly while it is in one, as DYE2
  v0.1.32 holds a recipe hidden in none;
- each steam, hot water and flush setting it holds in DYE2's field of it in
  `dashboardVariables`, blank where it holds none, so applying the record
  leaves the Machine's own, and its steam and hot water modes, a hot water
  mode of volume where it names none, as the management interface shows
  it;
- the names DYE2 copies, the Bean's roaster among them, and `title`,
  `subtitle` and the embedded `workflow`, built as DYE2's
  `buildRecipeWorkflow` builds them at v0.1.40 (`recipeWorkflow`), with the Bean's name, roaster and batch
  together, null where it holds none, and all three null for a Recipe naming
  no Bean, so applying it from Streamline's strip leaves no bean batch, as
  from DYE2's dashboard; a record that lacks them, as one the server wrote
  before DYE2 v0.1.32 did, is written them once (`lacksBeanNulls`), which the
  plugin posts though comparing records takes a null for none; a null for
  each of its dose, grind setting, RPM, feed rate, Grinder, Basket, barista
  and drinker it holds none of, and a yield of 0 where it holds neither a
  yield nor a dose and ratio, as a recipe is the whole shot from DYE2 v0.1.37
  (ADR-0022), though no record is written again for those alone: one whose
  embedded Workflow differs only in how it holds none, a 0 for a null or no
  yield for a yield of 0, as one saved before v0.1.37 does, is left as it
  is (`withoutZeros`), as Streamline's strip clears whatever it holds and
  the plugin's load write covers any other Skin; the full Profile, the tablet's
  grinder id, and each steam, hot water and flush setting it holds in
  partial `steamSettings`, `hotWaterData` and `rinseData`, none where it
  holds none of them, so DYE2 and Streamline apply it the same way, once
  Streamline's strip applies those settings
  (decentespresso/streamline-js#154), and so the settings DYE2 copies there
  as it saves are the ones the server writes; with the field flags
  (`extras.dye`) DYE2's editor saves into the tablet's record of it there,
  which the server does not derive (`withHeldFieldFlags`); and no
  `recipeId`, which the app applying the record sets to its id in the
  Workflow (ADR-0022);
- the full Profile in `profileSnapshot`, as the Library holds it, so it
  applies where the Profile is hidden, or the tablet lacks it, and in the
  embedded `workflow` at the Recipe's brew temperature, its first step at it
  and every other step moved by the same amount, as Streamline's Brew tile
  sets one (`profileAtBrewTemperature` in `protocol/`): DYE2's dashboard
  moves the snapshot so as it applies it, and Streamline's strip applies the
  embedded one as it is (decentespresso/dye2#26);
- its brew temperature in `dashboardVariables.brewC`, its Profile's first
  step's where the Recipe holds none, as DYE2 saves a brew temperature only
  into a record holding one;
- a blank barista and drinker;
- its global id in its own field (`decentSyncId`), as a Basket's.

A record is written where any of that differs from what it holds, as when an
item it names is created on the tablet, renamed, or its Profile edited, or
a save left its embedded Workflow behind its dial.

So a recipe saved in DYE2 on one tablet is written under its id, in its
slot, to every tablet at its Location, and to no other Location's; an edit
on any tablet, in DYE2's editor or saved by DYE2 from the Workflow, reaches
every tablet there; a recipe moved to another slot on one moves on the
others, and a recipe gone from a tablet's list leaves its slot on the
others, still on them. Every change of the Workflow of a Machine with a
Recipe loaded is saved into it (ADR-0022): the plugin has DYE2 save it
(`record`), which writes the dose, yield, grind setting, RPM, feed rate,
Basket, brew temperature and steam, hot water and flush settings into the
record, each where the record holds one, and a Basket or steam, hot water or flush
setting it holds none of once it moves off its value at the apply, which
reaches the server as the tablet's change of the record, the Machine's edit
of its Loaded Recipe; and the server records itself, from the Workflow, a
grinder, a batch, with its Bean where it is another Bean's, and a dose,
yield, grind setting, RPM or feed rate the Recipe holds none of, which DYE2
never saves (#389, #570), and nothing on the load (#550). What DYE2 saves that is no edit, as the Workflow left
behind a write of the server's still to land, is written back
(`recordedByDye2`, `WORKFLOW-AND-STATE.md`, Following the Recipe). A field of a record that
sets the Recipe's value its tablet's own latest edit set already is no edit
(`withoutOwnEdits`), so the same edit reaching the server twice is one. Recipes are read through the REST API (below), and managed in the
management interface (Editing in the management interface, above).

## Writing to tablets

Each welcomed connection that is not mismatched has a writer
(`server/src/sync/tablet-writer.ts`), on the instance holding it. It looks for
the next write due (`tabletDue` in `tablet-due.ts`), reading in one snapshot
what the Machine's Location offers and what the tablet's map holds, and
planning the writes with the pure `plannedWrites` (`holdings.ts`), in order,
each update also writing the item's content where the record differs from it
(below):

1. Each Bean the Location offers that the tablet lacks, which is created
   with the Bean's content; or that it holds archived, which is un-archived;
   or whose record lacks its global id, which is written.
2. Each batch the Location offers that the tablet lacks, created under the
   tablet's record of its Bean, with the Location's remaining weight if one
   was entered there, once the tablet holds that record; each it holds
   archived, un-archived; each whose `weightRemaining` is not the
   Location's, where one was entered there, set to it; then each batch the
   tablet holds that the Location does not offer, archived.
3. Each Bean the tablet holds that the Location does not offer, archived.
4. Each Grinder the Location offers that the tablet lacks, created with the
   Grinder's content; or that it holds archived, un-archived; or whose record
   lacks its global id, which is written. Then each Grinder the tablet holds
   that the Location does not offer, as an Archived Grinder or one of another
   Location, archived.
5. Each Profile the Location shows that the tablet lacks, created, unless it
   is one of Decaid's bundled Profiles, which a tablet has already or lacks
   for its Decaid's version; or that it holds hidden or deleted, made visible.
   Then each Profile the tablet holds visible that the Location does not
   show, hidden, never deleted.
6. Each Basket, then each Tool, the Location shows that the tablet lacks,
   created in DYE2's list, or whose record lacks its global id, which is
   written; then each the tablet holds that the Location does not show, as
   one hidden there or Archived, removed from the list (`remove`), as DYE2
   can neither archive nor hide one (ADR-0005). These lists are written to
   every sharing tablet, whether or not DYE2 is installed there, so
   installing DYE2 later finds them ready, but never one the tablet holds in
   a shape that is not recognised.
7. Each record of a Recipe the tablet holds that is not of one of the
   Location's Recipes not Archived under its record id, as one Archived or
   another Location's, removed from DYE2's recipes (`remove`); then each
   Recipe of the Location not Archived, in slot order, then the rest as they
   joined, the order the writes are planned in, that the tablet lacks,
   created under its record id, or whose record differs from what it is to
   hold, its slot included, written (Taking in a tablet's recipes, above).
   Recipes come last, as they name the items above by the tablet's ids.
8. Its Workflow's Loaded Recipe (`loadedRecipeDue`, `WORKFLOW-AND-STATE.md`,
   Following the Recipe): each of the Recipe's parts that changed since its
   Workflow last took it and that the Workflow holds otherwise, as an edit
   made anywhere, once the Recipe's record and the Basket and batch it
   names are written, and, where it names no batch, its Bean's coffee name
   and roaster, or none, once its Bean is another than the Workflow last
   took, over any typed on the Machine (#572); or the Workflow's `recipeId` cleared, where the
   Recipe it names is not the Machine's Loaded Recipe, as one Archived or of
   a Location the Machine left. Either expects the Workflow still to name
   the tablet's record id of the Recipe. The clear of the Recipe a Machine
   had loaded as it was made capture-only is written to it too, which is
   written nothing else; one loaded while it is capture-only stays.

Every record the tablet holds whose content differs from its item's, offered
at the Location or not, is written the item's content, in the same update as
anything else due to it: so an edit reaches every tablet that holds the item,
at every Location (ADR-0020), a Profile's title, author and notes included,
but never a bundled Profile's. A field the item holds no value for is
cleared. Beans are written before their batches, and batches are archived
before their Beans. Within each, items that joined the Library first are
written first. Every update sets only the fields that differ, and writes the
global id with them to a record that lost it; a Profile's record carries
none. Each update names the value the record held for each field it sets,
as the tablet last reported it (`expected`), and the plugin sets a field only
while the record still holds that, so a barista's edit the tablet has not
reported yet is kept, and reaches the server in the answer.
Nothing is deleted from a tablet; an Admin's hard delete, which deletes an
item no Shot names from every tablet that holds it, is the one exception
(Hard deletes, above): its deletes are due before the writes above, after
the clearing of a joining tablet's Workflow grinder, batch and Basket
(Joining a Location, below). After them, before the writes above, each
record a joining tablet held that the Library leaves out and that is not set aside
there yet is archived or hidden (`leaveOut`; Joining a Location, below),
batches first, then beans, grinders and profiles, and last baskets and
tools, which are removed from DYE2's list instead (Taking in a tablet's
baskets and tools, above).

It writes nothing until that connection's reports of the tablet's beans, bean
batches, grinders, profiles, baskets, tools and recipes, which the plugin sends on
every welcome, have been taken in, nor between a report of its beans and the report of its batches the plugin
sends after it, so a change the tablet made to both, such as deleting a bean
with its batches, is taken in whole first. It then writes only while the
connection still holds the Machine and the Machine takes part where the
latest reports were all taken in: at their Location, with its sharing not
turned off and on again since (`standing` in `join-plan.ts`). Its latest
Workflow, once it has sent one, must have been taken in there too: one taken
in elsewhere, as when the Machine joined a Location between the Workflow
and the lists the plugin sends after it, has the plugin asked for them
afresh, so a joining tablet's Workflow is judged there before anything is
written. One set aside as it cannot be stored is waited for no more. So a bean the tablet holds
already, entered there or before it joined, is linked to the Library's Bean
before anything is written, rather than written to it again. A tablet that
was offline catches up once its reports on reconnecting are taken in. The
writer also looks whenever any Library change is notified, on any instance,
and when the instance listens for notifications again after losing its
connection.

When the writer finds the Machine taking part elsewhere than where its
tablet's latest reports were taken in, as once it has moved or had its
sharing turned off and on again, it sends the plugin `requestCollections`,
once for each place it finds it taking part, and the
plugin sends its latest Workflow again, then reads every collection again
and sends each in full, as on a welcome. Once those reports are taken in at
the new Location, the tablet is written what that Location offers, and what
only the old one offered is archived or hidden on it (Joining a Location,
below). A change to a Machine's Location History that changes the Location it is
at now (a move, or correcting or removing its latest entry) commits with a
`NOTIFY` on `machine_locations` naming the Machine, which wakes the writers of
its connections, on any instance; so does entering an Unidentified Machine's
hardware, as its model decides which Profiles it is written (A Profile
reaches only the Machines that can run it, above). A move an instance missed while not
listening is found when it listens again, as every writer then looks.

One write is outstanding per connection, and only the connection holding a
Machine writes, so a tablet is written one item at a time. The server sends a
`write`, in chunks the plugin confirms unless it is small
(`AI_PROTOCOL_NOTES.md`, Chunked messages),
and the plugin answers it with `written`, the record Decaid returned, or
`writeRefused`, Decaid's refusal. The server records a written record as the
tablet's record of the item, whatever the time of the record known, since
Decaid has just returned it (a local time in the hour the clocks go back can
read as older), then acknowledges the answer with `ack` and goes on. The
plugin reads a record before it updates it, and Decaid keeps the fields it is
not sent, so a change the tablet made at its Location since its last report,
such as archiving a batch just before the server wrote its global id, comes
back in the answer, and the next report, holding the record as answered, shows
none. So the answer names the fields the write set (`writtenFields`), and its
`archived` and `weightRemaining`, or a Profile's `visibility`, where the write
did not set them and they differ from the record known, are taken in as a
report's would be (`editsInAnswer`, `archivingInAnswer`,
`visibilityInAnswer`), under the Machine's, the tablet's and
the Location's locks, rather than written back over; and so are the fields of
its content the write did not set that differ from the record known, merged
as edits under the item's row lock (Edits, above), judged by what the record
had seen before the write. The record has then seen the content the write
carried (`content_seen_at`, above), if its write was awaited. An answer the
plugin marks `linked`, to a create it carried out by writing the global id to
a bean of the same roaster and name entered there before the tablet reported
it, links that record: it takes the Bean's content, each field it held
otherwise kept as a Conflict (ADR-0018). Such a change is timed by
the answered record, which Decaid stamped when the plugin wrote, up to a poll
interval after the barista made it, so it can win by its time over another
tablet's change made in between. An answer is recorded
only while its connection holds the Machine, decided under the Machine's row
lock, which a newer connection's hello takes too, so one an instance records
late, after another connection has taken the Machine, never lands after that
connection's reports. A record that does not carry the item's global id, or
whose local id the map holds as another item, is not recorded.

A refusal, an answer that cannot be recorded, no answer within 300 s, or an
item due again with the same fields it was last written, expecting the record
to hold the same values, found due at every
look since and with its record not gone from the tablet meanwhile, removed
or found to be another item's, as a Recipe Archived and restored
is, and, for a write creating its record, no report of the tablet's lists
taken in since, which would show the tablet lacks it, as when another app
rewriting a DYE2 list lost it, which writing again would not
change, skips that item while the
same is due to it: the fields, the values expected, and the decisions of the
Location's state and of the item's content the write carries
(`changeSignature` in `sharing-status.ts`). The other writes go on. Once
anything of that changes, as when the item is edited, the Location changes
it or the tablet's record changes, or it stops being due, the item is
written again on the same connection; and the tablet's next connection
tries it again whatever changed. A refusal of a write, delete or leave-out
the connection awaits is kept in the tablet's sharing status, with Decaid's
answer (Sharing status, below). An update Decaid answers with 404 found the record
gone, deleted on the tablet just as the server wrote it, as when a barista
deletes a bean with its batches and a report of the batches, read after the
delete, comes before one of the beans: it is skipped the same way, but not
taken for a refusal, as the tablet's next report shows the delete, after
which the item is due otherwise. An item due
again with other fields, as when the second request of a batch's create
failed or the Location changed the item meanwhile, or expecting other values,
as when the plugin left a field the tablet had changed as it was and that
change lost, is written again. An
answer to no write its connection awaits, such as one arriving after its
write timed out, or one the plugin's outbox held across a reconnect, is
recorded too, so the server's own write is not read back from the next report
as the tablet's change: its record is the tablet's latest, since the outbox
sends one delivery at a time and every report read after the write waits
behind its answer. Which decision its write carried is not known, so it
says nothing new of what the tablet had seen of its Location's state
(`seen_at`, above).

### How the plugin writes

The plugin (`plugin/src/library-writes.ts`) carries writes out through
Decaid's API, one at a time, between its reads of the lists it writes to (the
beans, bean batches, grinders and profiles, and DYE2's baskets,
equipment and recipes), never during one
(`LibraryAccess`), and
queues each answer in its outbox, behind
every report read before the write. It carries out none while its Machine
pulls a Shot, from the machine state `espresso` until Decaid stores the
Shot (ticket #217, ADR-0022, `WORKFLOW-AND-STATE.md`, During a Shot), as a
write into the Workflow, or a post of DYE2's recipes that clears it first,
would reach the Shot: it holds the write, delete, removal or leave-out the
server asked for until then, or at most two minutes, well within the
server's five, and answers it with `PULLING_SHOT` (a `writeRefused`, or a
`leftOut` refused, of status null), one whose turn comes during a Shot at
once. The server records nothing for it, and plans what the tablet is due
afresh at once, so what it then writes holds what changed meanwhile: a
Recipe edited twice during the Shot is written once, with its latest
values. So the server takes in each report read
before a write before that write's answer, and never reads a record the
plugin wrote as deleted from a report that predates it. A read of the list
begun before a write could otherwise reach the server after the write's
answer, without the record: `server/test/library-batches.test.ts` slows the
tablet's list of batches to show it does not.

- To create an item, it first reads the tablet's list of that kind, archived
  ones included. A record already carrying the global id was made by a write
  whose answer was lost: it answers with that record, and writes nothing. An
  unarchived bean without a global id whose roaster and name match the Bean's
  (`beanMatchKey`, shared with the server through `protocol/`) is a bean a
  barista entered before the tablet reported it, as when two tablets at a
  Location enter the same coffee within a poll interval: it becomes the Bean,
  and only the global id is written to it, as to a record the server links.
  Bean Batches and Grinders are never the same item. Otherwise it creates
  the record (`POST /beans`, `POST /grinders`, or `POST
  /beans/{beanId}/batches` under the tablet's record of the batch's Bean,
  which the write's `beanId` names) with the item's content and the global
  id in `extras`. Decaid assigns the record its
  id. A batch's create takes neither `archived` nor `weightRemaining`, which
  it sets to `weight`, so where the Location's remaining weight differs, the
  plugin writes it in a second request (`PUT /bean-batches/{id}`); should
  that fail or go unanswered, it answers with the record as created, and the
  server writes the weight again on the same connection. Each create reads the whole list once, which a tablet joining
  a Location with many items does once per item.
- To update a record, it reads the record and updates it (`PUT /beans/{id}`,
  `PUT /bean-batches/{id}` or `PUT /grinders/{id}`) with the fields the
  server sent that the record still holds as the server expects
  (`expected`), and `extras` holding its other keys beside the global id,
  since Decaid replaces `extras` whole. A field the tablet changed since it
  last reported the record is left as the tablet has it, and left out of the
  answer's `writtenFields`.

- To create a Profile, it reads the tablet's record of it (`GET
  /profiles/{id}`), hidden or deleted as it may be. Unless the tablet holds
  one already, as when the answer to an earlier write was lost, it posts the
  profile (`POST /profiles`) with its metadata, and with its parent if the
  tablet holds that Profile, since Decaid refuses a parent it lacks; the
  server writes a parent to be created before its child. Decaid derives the
  record's id from the profile, and answers a post of a profile it holds,
  hidden or deleted as it may be, with that record, unchanged. So the plugin
  then sets the record's visibility where it differs (`PUT
  /profiles/{id}/visibility`); should that fail, it answers with the record as
  it was, and the server writes the visibility again. A record Decaid made
  under another id, as a Decaid hashing profiles otherwise would, is not the
  Profile: the server does not record it as one, and skips the write for the
  connection, and the tablet's next report adds the record to the Library as
  a Profile of its own.
- To update a Profile, it reads the tablet's record of it, then sets its
  title, author and notes where the write holds them, in the record's
  `profile`, which Decaid's `PUT /profiles/{id}` takes whole: they are
  outside the hash, so the record keeps its id
  (`server/test/fixtures/decaid/profile-writes-v0.8.7/`). Then it shows or
  hides it (`PUT /profiles/{id}/visibility`), where the write holds a
  visibility. Each only while the record holds what the server expects;
  should the visibility fail once the rest is written, the record as it then
  is is the answer, and the server writes the visibility again. Decaid
  refuses to change a bundled Profile's content, which the server never
  writes.

- To delete a record of a hard-deleted item (`delete`), it reads the record,
  and deletes it (`DELETE /beans/{id}`, `/bean-batches/{id}` or
  `/grinders/{id}`) unless it carries another item's global id, which it
  refuses (`ANOTHER_ITEMS_RECORD`), or a Shot it queued since it loaded, or
  has yet to read and send, names it, or, for a bean, one of its batches; a
  bean's
  batches, archived ones included, first (`GET /beans/{id}/batches`), as DYE2
  does, since Decaid refuses to delete a bean that has any. A Profile's
  record it purges (`DELETE /profiles/{id}/purge`), as Decaid's `DELETE`
  only marks a user's profile deleted, unless a Shot it queued since it
  loaded, or has yet to read and send, had the same steps, or a skin
  recorded its id there; it takes Decaid's 400 for a profile it no longer
  holds as the record gone. A record already
  gone is deleted. It answers `deleted`, or `writeRefused`, through its
  outbox as it answers a write.

- To write a Basket or Tool (`dye2Writer`), it reads its list from Decaid's
  store, a key never written being an empty list, and answers
  `listUnrecognised`, writing nothing, if the list is not in a shape it
  recognises. To create one, a record carrying the global id, made by a
  write whose answer was lost, is the answer; a record without a global id
  of the item's name, entered before the tablet reported it, becomes the
  item, only the global id written to it (`linked`); otherwise it adds a
  record with the item's content, a new random UUID as its id, as DYE2 gives
  one, and `createdAt`. To update one, it sets the fields the record still
  holds as the server expects, a cleared one left out of the record. Either
  way the global id goes in the record's own field, and the list is posted
  back whole (`POST /store/dye2.reaplugin/{key}`), only where it changed. To
  remove one (`remove`), it leaves the record out of the list and posts it
  back, unless it carries another item's global id, or differs from the
  record the server's map holds of it, which the removal carries
  (`expected`), as one a barista changed since the plugin last read the list
  (`RECORD_CHANGED`), and answers `removed`, as it does for one already
  gone. Refused as changed, the server asks the plugin for its lists again
  (`requestCollections`) and writes nothing more to the tablet until a
  report of that list arrives, taken in, or unavailable or set aside, which
  ends the wait all the same, so the change is kept, as an edit of the
  Recipe Archived or of the Basket or Tool hidden, before the removal is
  asked again with the record as changed: an edit saved on a tablet just
  before Staff Archive a Recipe, or hide a Basket or Tool there, is not lost
  with the record. Such a refusal is not kept
  with the tablet's refusals: the removal shows as waiting meanwhile. A record of one an Admin hard-deleted is
  removed the same way, but a basket or tool a Shot it queued since it
  loaded, or has yet to read and send, names, which it keeps as it keeps a
  batch; and one the Library leaves out too, answered as set aside. Each is timed by the plugin's clock, as DYE2's records carry none.
  Its next read of the list it wrote is reported whatever it holds, so a
  write another app's rewrite of the list lost at the same moment shows up
  there (ADR-0005); the server then writes it again.
- To write a Recipe, it reads DYE2's recipes as it reads baskets and tools,
  which must be in a shape it recognises. A write names the record's fields
  by their paths, a field of its `dashboardVariables` as
  `dashboardVariables.dose`. To create one under the record id its
  `fields.id` names (`writeRecipe` in `plugin/src/library-writes.ts`), a
  record of that id carrying the global id, made by a write whose answer
  was lost, is the answer; one without a global id, saved under that id
  before the tablet reported it, becomes the Recipe's, only the global id
  written to it (`linked`), and the server takes each field it holds
  otherwise as an edit of the Recipe, merged with Conflicts; one carrying
  another item's global id is left, and the write refused (409), as the
  server removes it first; otherwise it adds a record with the write's
  fields and `capturedAt` at the end of the list, a recipe in no slot
  holding `stripSlot` null rather than none, as Streamline places recipes by
  their ids while no record holds the key. To update one, it sets each path
  the record still holds as the server expects; whether it is shown
  (`showOnStreamlineDashboard`), which follows its slot, only while its
  `stripSlot` is still as expected too, which a write of it names whether
  it sets the slot or not, so a recipe a barista put in another slot since
  stays shown there and the move reaches the server in the answer. A write
  putting a record in a Recipe Slot clears `stripSlot` on any other record
  in that slot in the same post, as DYE2's `takeSlot` does (`dye2:dye2-plugin/src/utils/dev-api.ts`),
  so one record holds each slot on every tablet: DYE2 de-duplicates slots
  only once, as it loads, and Streamline places the first record it finds
  for a slot. That record, left shown in no slot, is written hidden next.
  It posts the list back in the order the tablet holds it.
  Before it posts a list that removes the record the Workflow's `recipeId`
  names, or gives its id to another item's record, it clears that field in
  the Workflow first (`vacatedIds` in `plugin/src/loaded-recipe-rules.ts`,
  `LoadedRecipeWrites.beforePost`), and posts nothing if Decaid does not
  clear it, so the Workflow never names another Recipe than it applied.
  Once Decaid has
  taken a post of DYE2's recipes, whether a write, a removal, a set-aside or
  a delete made it, the plugin pushes `{"what":"workflow"}` on its `changed`
  endpoint, so Streamline's dashboard re-reads them (ticket #168,
  `plugin/src/skins.ts`, `AI_RUNTIME_NOTES.md`, Skins), as it does once
  Decaid has taken a write into the Workflow that changed it (ticket #207).
  A write that posts nothing pushes nothing, and a push Decaid refuses is
  only logged.
- To set aside a record the Library leaves out (`leaveOut`), it reads the
  record, and archives a bean, bean batch or grinder (`PUT /beans/{id}`,
  `/bean-batches/{id}` or `/grinders/{id}` with `archived`, its `extras`
  as read), or hides a profile (`PUT /profiles/{id}/visibility`), unless it
  is so already. A bean, batch or grinder carrying a global id is a Library
  item's record now, as one a write linked, and is left as it is (`taken`).
  It answers `leftOut`, with `setAside`, `gone` for a record already gone,
  `taken`, or `refused` with Decaid's status and answer, through its outbox
  as it answers a write. The server records a record set aside as such,
  so a barista un-archiving or showing it later takes it up, and forgets
  one `gone` or `taken`; a refusal changes nothing.

The plugin's next report then holds the record as written, which changes
nothing (ADR-0003). If the connection drops before the answer arrives, the
tablet's next report shows the record carrying its global id, which maps it.

Decaid refuses (500, `DeviceNotConnectedException`) to change the steam,
hot water and flush settings while no machine is connected to the tablet,
as the change goes to the machine (`MACHINE_SETTING_PARTS` in `protocol/`),
so a load and a Loaded Recipe's write are then written without them, and a
Loaded Recipe's write of only them is refused,
and skipped until what is due changes or the tablet reconnects, as any
refused write is (`WORKFLOW-AND-STATE.md`, Following the Recipe). A tablet
often connects before its machine, and its plugin reconnects once the
machine reports its hardware. One whose machine goes away, as when it is
powered off for the night while its tablet stays connected, is seen gone by
the plugin's next read of its hardware, or by such a refusal; once the same
machine is back, the plugin reconnects too, and the tablet is written then.

Decaid v0.9.0 refuses to delete a bean that still has batches, archived ones
included, failing SQLite's foreign key with 500 and deleting nothing
(`server/test/fixtures/decaid/bean-batch-writes-v0.8.7/`, unchanged in
v0.9.0). A barista deletes
one through DYE2, which deletes its batches first, then the bean
(`dye2:dye2-plugin/src/utils/bean-delete.ts`); the server reads the batches
and the bean gone from the tablet's next reports.

### Sharing status

Each Machine's sharing status (`server/src/library/sharing-status.ts`) is
read for the tablet of the connection holding it, which its writer writes
to, unless that connection is mismatched; otherwise, as while it is
offline, for the tablet its latest connection came from, which may be a
mismatched connection's that reported its hardware:

- **Changes waiting:** what that tablet is due where its Machine takes part
  now, planned as its writer plans it (`changesDue` in `tablet-due.ts`),
  from what the tablet last reported, so changes queued while it is offline
  count, with each batch to be created once its Bean's record is
  (`batchesAwaitingBeans` in `holdings.ts`). A change it refused counts as
  refused rather than waiting while the same is due, and so does a batch
  waiting for a Bean whose create it refused. None is counted while the
  Machine is capture-only, or no tablet has connected.
- **The last change applied:** the last write the server recorded the
  tablet's answer to, delete it answered `deleted`, or record it set aside,
  and when, by PostgreSQL's clock (`tablet_last_applied`), whether or not
  its connection still awaited the answer.
- **DYE2 lists not written:** each of DYE2's lists the tablet holds in a shape
  that is not recognised, as it last reported it or the plugin last found it
  as it wrote, which nothing is written to or taken in from until it reports
  it in a shape that is (`tablet_unrecognised_lists`).
- **The changes refused:** each write, delete, removal or leave-out the tablet
  refused while its connection awaited the answer, with Decaid's HTTP
  status and what it answered, the latest refusal of each item or record
  kept (`tablet_refusals`). The status is null where there is none: Decaid
  did not answer, or the plugin did not ask it, as for a delete a Shot it
  has yet to send names. A write the writer skips for another reason is
  kept the same way, with no status and why, so nothing waits unexplained:
  one answered with a record that is not the item's or that the server
  cannot store, one still due as it was once written, which writing
  again would not change, and one carrying a profile its Machine's model
  can't run (A Profile reaches only the Machines that can run it, above).
  A write the plugin does not answer within 300 s is skipped too, but not
  kept, and counts as waiting. One is forgotten
  once a change of the same item or record is carried out there, and as
  the tablet's writer finds it no longer due (`pruneRefusals`), as when the
  item stopped being offered; until then, one no longer due is not shown.

Everything is in PostgreSQL, so every instance reads the same, whichever
holds the tablet's connection.

## Steam, hot water and flush settings

A Recipe holds any of eleven steam, hot water and flush settings, as DYE2's
recipe does (decentespresso/dye2#23), and a Machine follows those it holds
while the Recipe is loaded (`WORKFLOW-AND-STATE.md`, The Loaded Recipe;
ADR-0022). Each is optional: one the Recipe holds none of is the Machine's
own, which a load leaves alone. 0 is a value, and a milk stop of 0 is off.
Each has a field of the Recipe's content, DYE2's field of it in a record's
`dashboardVariables`, and the Workflow field holding it (`RECIPE_SETTINGS` in
`protocol/`):

| Setting | Content field | DYE2 field | Workflow field |
|---|---|---|---|
| steam temperature | `steamTemperature` | `steamTempC` | `steamSettings.targetTemperature` |
| steam time | `steamDuration` | `steamTimeS` | `steamSettings.duration` |
| steam flow | `steamFlow` | `steamFlowMls` | `steamSettings.flow` |
| milk stop | `steamStopTemperature` | `steamStopAtTempC` | `steamSettings.stopAtTemperature` |
| hot water temperature | `hotWaterTemperature` | `hotWaterTempC` | `hotWaterData.targetTemperature` |
| hot water time | `hotWaterDuration` | `hotWaterTimeS` | `hotWaterData.duration` |
| hot water volume | `hotWaterVolume` | `hotWaterMl` | `hotWaterData.volume` |
| hot water flow | `hotWaterFlow` | `hotWaterFlowMls` | `hotWaterData.flow` |
| flush temperature | `flushTemperature` | `flushTempC` | `rinseData.targetTemperature` |
| flush time | `flushDuration` | `flushS` | `rinseData.duration` |
| flush flow | `flushFlow` | `flushFlowMls` | `rinseData.flow` |

Decaid calls the flush settings `rinseData`; Decent Sync calls them flush
everywhere else. Ticket #86 shared steam, hot water and rinse settings
between a Location's Machines, ticket #137 had hot water follow the Loaded
Recipe instead, and ticket #190 took the rest out (ADR-0014, superseded),
each Machine's own until #173.

The settings are written into, and taken in from, DYE2's fields of a
recipe record, and each held one into the record's embedded Workflow
(Taking in a tablet's recipes, above). A change of one on a Machine with a
Recipe loaded, which the plugin has DYE2 save into the Recipe's record, is
an edit of the Loaded Recipe, but for one DYE2 saved that is no edit
(`recordedByDye2`), and reaches every Machine with it loaded through the
Loaded Recipe write. A change with no Recipe loaded is stored with the
Workflow as any change is, but is no edit and reaches no other Machine, and
a Machine joining a Location keeps its own until it loads a Recipe.

Steam on and off stays each Machine's own: a Workflow's steam temperature
below 135 °C (`STEAM_ON_FROM`) is its steam turned off, as Decaid judges it,
which never changes a Recipe, as DYE2 saves no steam temperature or steam
time from a Workflow whose steam is off, though from v0.1.35 it saves its
steam flow and milk stop then (`5561549`), and the plugin writes no steam temperature or
steam time into a Workflow whose steam is off, only its steam flow and
milk stop (ADR-0022, Steam on and off). From Streamline v0.2.22 a steam time
of 0 is steam off too: Streamline writes it with a steam temperature of 0
as it turns steam off, and shows it as "Off". So a Recipe's steam time is 1
to 255 s (`STEAM_TIME_FROM`, `STEAM_TIME_TO`) or none, a tablet's change of
its record to 0, as DYE2's editor saves one, is no edit, and the Recipe's,
or none, is written back over it (`steamOffPaths`); a stored 0, as 1.6.2
may take one in, is read as none, and a time above 255 s, which DYE2's
editor no longer saves from v0.1.35 but another writer might, as 255 s,
which is written back (`steamTimeOf`). From v0.1.35 DYE2's editor shows a
steam time of 0 as "Off" and saves a steam temperature of "Off" with a
steam time of 0, and its apply writes a record's steam time of 0, or steam
temperature below 135 °C, as steam off whole, both 0 (`recipeMachineSettings`,
decentespresso/dye2#46): so such a save turns that Machine's steam off,
its own, while the Recipe's are written back into the record. A steam edit made on one
Machine reaches another whose steam is off without turning it on, its
temperature and time held in the record, which steam comes back on with.
Turning steam back on takes the Loaded Recipe's steam temperature and steam
time, whatever it came back with: the plugin writes the ones the tablet's
record of the Recipe holds into the Workflow before it has DYE2 save the
change, so those steam came back with reach no Recipe, while the change's
other values are saved as any are (#374, #394). It reads that record afresh
first, as DYE2's editor saves a recipe and then applies it again, which may
turn steam back on with the temperature or time just saved, which are the
Recipe's edit (#395). A steam temperature or time
changed once steam is on is the Recipe's edit. A Recipe holding no steam
time takes the one steam comes back with, as DYE2 saves it once it moves
off the one the Workflow held as the recipe was applied: an accepted gap.

Streamline, a skin, remembers what the barista last set for some of the
steam, hot water and flush settings in Decaid's store, under
`streamline-app`. The builds Decent Sync supports adopt a value the
Workflow holds that differs from the one remembered, rather than pushing
theirs back (ADR-0021, ADR-0017; the evidence is in `AI_RUNTIME_NOTES.md`,
Skins), and, with Streamline's own DYE2 switch on, their heater switch
turns steam back on at the steam temperature and time of the recipe the
Workflow names, which the tablet's record holds as the Recipe's. So the
plugin sets none of the values Streamline remembers. That heater switch
with Streamline's DYE2 switch off (its default), which takes the
temperature and time Streamline remembers, Streamline's Settings ›
Calibration › Steam switch, and Auto Steam choosing a pitcher with the
heater off turn steam on with another temperature or time, which the
plugin replaces with the Recipe's, as above.

`server/test/recipe-settings.test.ts` covers this through Seam 1, with the
built plugin running the simulated DYE2, whose tablet writes a Workflow's
flush settings to `/machine/settings` as Decaid writes them to the machine,
where DYE2 reads its flush temperature and flow;
`server/test/steam-back-on.test.ts` steam turned back on by each way of
Streamline's that does not take the Recipe's;
`server/test/recipe-steam-time-off-migration.test.ts` a stored steam time
of 0, read as none and made none by the migration; and
`server/test/joining.test.ts` a joining Machine keeping its own.

## Joining a Location

A Machine joins a Location when it is adopted there, as a machine entry
created at the Location or an unassigned Machine given its first, or moved
there: when the Location of its Location History's latest entry changes,
or has its sharing turned back on there (ADR-0008). Its tablet joins with it,
and so does a new tablet on a Machine there already, as one whose Decaid
data was reset. Correcting when a past move happened credits records again
as milestone 1 does, but changes nothing on the tablet, as the Location it
is at now is the same, and so does removing a move away and back made by
mistake, after which the Machine never left; correcting the latest entry's
Location, or removing the latest entry, changes it, and is a move.

Each of a tablet's reports, of its beans, bean batches, grinders and
profiles and of its Workflow, records the Location History entry it was
taken in under, that entry's Location, and when its Machine's sharing was
last turned back on (`tablet_reports`, in the transaction taking it in,
under the Machine's and the tablet's row locks; `joining.ts`). The tablet's
first report of each kind, its first at another Location, its first since
sharing was turned back on, and its first under a newer entry than the one
it was last taken in under, as after a move away and back, is part of
joining (`joins` in the pure `join-plan.ts`). A report of its bean batches
stays part of joining until its beans have been taken in under the entry,
as a batch whose bean the tablet's map does not hold waits for it: so while
a tablet's beans cannot be read, each batch it held as it joined is judged
as such once its bean is known. A Machine left at no Location forgets where its
tablets' reports were taken in, but for a tablet that has moved to another
Machine since, so given a Location again, even the one it was at, it joins
it.

- **The Location's state wins.** The writer finds the Machine at another
  Location than its tablet's latest reports, and asks the plugin for them
  afresh, its Workflow first (Writing to tablets, above). Once they are
  taken in there, the tablet is written what the Location offers, its shown
  Profiles, Baskets and Tools, the batches at it and their Beans, its
  Grinders, and its Recipes, in their slots or none, and what it does not
  offer is archived or hidden on the tablet, never deleted, but for a
  Basket, Tool or recipe, removed from DYE2's list: so another Location's
  Recipes leave its list (Taking in a tablet's recipes, above). Its
  Workflow's steam, hot water and flush settings stay its own until it
  loads a Recipe (Steam, hot water and flush settings, above).
- **Its Workflow's grinder, batch and Basket.** The Workflow taken in as
  the tablet joins is judged against the tablet's map, which still holds
  what the tablet held before (`takeInWorkflowContext`, which `takeInWorkflow`
  in `joining.ts` calls in the transaction storing the Workflow), under the
  Location's lock: the Grinder its `context.grinderId` names there is
  cleared if the Location does not offer it, as one belonging to another
  Location or Archived, the batch its `context.beanBatchId` names if it is
  not at the Location, or is Archived, or its Bean is, and the Basket its
  `context.extras.basketId` names if the Location does not show it, or it
  is Archived. Cleared are the grinder's `grinderId`, `grinderModel` and
  `grinderBurrs`, and the batch's `beanBatchId`, `coffeeName` and
  `coffeeRoaster`, as Decaid's `clearGrinder` and `clearBeanBatch` clear
  them (v0.9.0 added the burrs), and `extras.basketId` and
  `extras.basketName`, as DYE2 writes them (`WORKFLOW_GRINDER`, `WORKFLOW_BATCH`, `WORKFLOW_BASKET` in
  `protocol/`); the profile, dose, yield, grinder setting, RPM and steam,
  hot water and flush settings stay. A grinder, batch or Basket the map does not hold, one of the
  tablet's own, is cleared if the Library leaves it out, or will, as the
  Location offers Grinders, or batches or Beans, or shows Baskets, already
  (What it holds of its own, below); otherwise it joins the Library at the
  Location with its reports there, and stays. But a Basket the map does not
  hold whose name is a Library Basket's, ignoring case and white space at
  either end, which the tablet's record of it is linked to as it joins, is
  that Basket: kept where the Location shows it, the Workflow's
  `basketName` read for its record's, as DYE2 copies it, and one another
  of the tablet's records is already passed over, as the intake passes it
  over. That is foreseen, as the Workflow is taken in before the tablet's
  lists: once its report of its baskets is taken in as it joins, the
  Basket is judged again from the map and what the Library left out
  (`judgeWorkflowBasket`), so a basket renamed in DYE2 since the Workflow
  named it, a record carrying a Library Basket's global id, or one left out
  as another Machine joining at once brought the Location its first
  Baskets, is cleared or kept as the writer then holds it. The Workflow is
  judged before the lists are taken in, so a batch whose bean is then
  linked to one of the Location's, and that joins the Library as the
  Location offers no batch yet, is cleared all the same. The clear is kept
  (`workflow_clears`) and written as a `write` of the `workflow` kind,
  before anything else: the plugin clears the grinder, the batch and the
  Basket, each whole, only while the Workflow still names it by the id the
  tablet reported, so one a skin relabelled is still cleared, and a
  Workflow naming another since, reported or in the write's answer, drops
  that part of the clear (`clearStillDue`), which otherwise expects what
  the Workflow holds now. Once Decaid takes a clear that cleared
  something, the plugin pushes `{"what":"workflow"}` on its `changed`
  endpoint, so a skin reads the Workflow again (ticket #207,
  `AI_RUNTIME_NOTES.md`, Skins). It is due only as the tablet joins: a batch
  finished at the Location later leaves the Workflow as it is (ADR-0008).
  A clear the plugin is carrying out as its Machine moves back, within one
  write, to a Location that offers the grinder, batch or Basket is not
  called back: the Workflow's next join there finds it cleared already.
- **Its Loaded Recipe.** A Workflow naming a Recipe that is not one of the
  Location's, as one of the Location the Machine left, is not its Loaded
  Recipe there, and the server has the plugin clear its `recipeId`, while
  the Workflow still names it (`WORKFLOW-AND-STATE.md`, Unloads the server
  decides). A Workflow naming a Recipe the tablet's map held already never
  loads another Recipe the map gives that id later, as the new Location's
  may have the same slot-number ids. And before the plugin posts a list
  that removes the record the Workflow names, or gives its id to another
  Recipe's record, as the writer removes a joining tablet's own recipes or
  another Location's Recipes and writes the Location's, it clears the
  Workflow's `recipeId` first (`vacatedIds`, ADR-0022), so the Workflow
  never names a Recipe it did not apply. A Machine turned back to sharing at
  the Location it was capture-only at has the recipe its Workflow names
  loaded, where it is one of the Location's Recipes, as the Location
  offers it.
- **Its recipes, baskets and tools** are judged as any record the tablet
  holds (below, and Taking in a tablet's baskets and tools, and Taking in
  a tablet's recipes, above), what joining does with each decided by the
  pure `joiningRecord` in `join-plan.ts`: its records of another
  Location's Recipes, and of Baskets and Tools the Library has, by their
  global ids or matched by name, are those items, written the Location's
  state, and removed if it does not offer them; its own are removed from
  DYE2's lists and not kept, as DYE2 can neither archive nor hide one,
  unless the Location has none of the kind yet (below).
- **What it holds of its own** (ADR-0018). A report that is part of
  joining takes nothing of the tablet's into the Library: the Location's
  state wins. Its records of items the Library has are those items: one
  its map holds, one carrying an item's global id, a Bean matched by
  roaster and name, and a user's Profile by its id, each linked with no
  Conflict kept, and each written the item's content and what the
  Location offers. What the tablet changed of them before it joined, as
  while capture-only, an edit, an archiving or un-archiving, a Profile
  shown or hidden, or a delete, is written over, not taken in; one it
  deleted is written again if the Location offers it. A user's Profile
  the Library has that the Location has not decided is hidden there.
  Every other record is left out (`tablet_left_out`, `left-out.ts`): it
  stays out of the Library, and the writer sets it aside on the tablet, a
  bean, bean batch or grinder archived, a profile hidden, never deleted,
  so the tablet's Shots still find it; so is a batch of a bean left out.
  Decaid's bundled Profiles, which every tablet has, are never left out,
  and one the Location has not decided is shown there or not as the
  joining tablet holds it, as on any tablet's first report there.
  - **A Location that offers none of a kind yet**, as a cafe's first
    Machine joins it, takes the joining tablet's own items of that kind:
    its Beans if it offers no Bean, its batches if no batch, its Grinders if no
    Grinder, its Profiles if it shows no user's Profile, its Baskets if it
    shows no Basket, its Tools if no Tool, and its recipes, with their ids
    and slots, if it has no Recipe but Archived ones, each a new Recipe
    there, loaded where the Workflow names it; a Basket or
    Tool matched by name to one the Library has is shown there. They join
    the Library there as any new record does (Taking in a tablet's beans,
    and those after it). Those archived or hidden on the tablet are left
    out as above, so a record left out at one Location does not reach the
    Library at the next. It is decided per report, under the Location's
    lock, so of two Machines joining at once only the first brings its
    own.
  - **Taken up again.** A record left out stays out of the Library while
    the tablet holds it. Once it is set aside, as the plugin answers or a
    report shows it archived or hidden, a barista who un-archives or shows
    it there takes it up: the next report takes it in as a new record, as
    if entered then; a batch whose bean is still left out waits for it. A
    later join judges it afresh, so one the Library has come to hold, as a
    Bean of its roaster and name, is linked then. One the tablet deletes is
    forgotten, and so is one a write made a Library item's record.
  - What the tablet held at its old Location its map holds, so it stays
    offered only there, and is archived or hidden on it. Its old
    Location's Grinders stay there, archived on it.
- **Leaving.** A Machine at no Location, as when its only Location History
  entry is removed, or with its sharing turned off, is capture-only (Who
  takes part, above): nothing more is written to its tablet, which keeps
  what it has, and its reports are captured but not taken in. Given a
  Location again, or its sharing turned back on, it joins it: what its
  tablet changed or added meanwhile is written over or left out, as above,
  so an Admin can turn sharing off to experiment on a Machine without
  changing its Location's Library.

A change made on the tablet just before a move, which a report brings
after it, is written over in the same way, as the report is the first at
the Machine's new Location; one an answer to a write brings means what it
would at the Machine's new Location, as the server reads it where the
Machine is when it is taken in.

## Simulating a Profile

A Library Profile can be simulated on a puck (#577, ADR-0032), so a person
or an assistant can see what it does before pulling a Shot. One pure module,
`protocol/src/simulation.ts`, runs it, for the management interface in the
browser and for the server's REST route and MCP tool alike. Everything it
returns is simulated, and says so, but the recorded Shot's figures beside a
fit.

- **The run.** `simulateProfile` takes a profile, a puck, a dose, a stop-at
  weight and a Machine model, and returns the run: a sample each 0.1 s from
  the start of the profile, in the shape of a Shot's samples
  (`record-samples.ts`), with pressure, the pump's flow, the weight in the
  cup and its rate, and the plan's targets, each step's start, end and why
  it ended, the stop and why, the time to first drip and the peaks. It
  starts with the pump at rest and no pressure, with no Preheat, and assumes
  a scale under the cup. Temperature is not simulated: a sample's temperature target is
  its step's, and it has no temperature of its own.
- **Steps.** A step ends at its maximum time, its exit, the water it may pump
  or its weight in the cup, judged a second ahead at its rate as Decaid
  judges it, whichever comes first; a step under 0.05 s, which
  Decaid sends as none, is passed through at once, whatever its exit. A
  step runs the time Decaid sends the machine (`stepSeconds`): rounded to a
  tenth of a second below 12.75 s and to a whole second from there, up to
  127 s, as the machine's wire format holds no more, and pumps the water
  Decaid sends, in whole ml, cut down; its target, exit and limiter are
  Decaid's too, in sixteenths of a unit to a DE1 and tenths to a Bengle
  (`sentStep`). Each sample names the
  step the run is in from that moment, so `stepSpans` reads the run's steps
  as it reads a Shot's. The
  Shot stops when the weight in the cup, judged a second ahead at its rate,
  reaches the stop-at weight, as Decaid stops one, so the cup holds a few
  grams less at the stop (what lands after it isn't modelled), or when its
  last step ends. A Bengle stops itself at that weight, by its firmware's
  judgement, which Decaid's sources don't show; it is modelled the same
  way. A step that gets to its target over the whole step ramps from what
  the run measured as it began, not from the step before's target, as
  recorded Shots show and Decaid's simulated machine does not. A limiter
  caps the quantity the pump doesn't control, eased over its range as Decaid's
  simulated machine eases it, the pump easing at once as it takes over. An
  exit of 0 or less is none, as there.
- **The machine.** The pump follows what a step asks within its model's
  figures, held in one place (`MODEL_FIGURES` in
  `protocol/src/machine-models.ts`), one typical machine of each model
  fitted to the corpus of recorded Shots (#601). A DE1 gives about 8 ml/s
  on a step whose pump controls flow, and on one whose pump controls
  pressure about 6.5 ml/s below 2 bar, falling to about 3 from 6 bar, so a
  ramp to 9 bar on a coarse puck stalls short of it, as recorded Shots do; a
  Bengle keeps up with about 15 on either, its 250 V/15 A heater's figure
  (#588), its Shots showing no step giving it less. A DE1's flow comes up
  over about 0.7 s and it brings pressure to a target over about 1.5 s; a
  Bengle's flow follows within about 0.1 s and its pressure over about
  0.7 s. Wherever a pressure sets the flow, a step's own, its limiter's or
  the most the machine reaches, 12 bar, the pump follows within a tick.
  Pressure builds in the group as the pump gives more than passes the puck
  and falls as it drains, over seconds. Each figure stays only where it
  brings more of the corpus within the margin; what was tried and left
  out, a DE1's flow on a flow step falling as pressure builds, the pump
  already running as a Shot begins and a limiter eased further over its
  range, is in #601's pull request.
- **The puck** is its resistance through the Shot, the pressure a flow
  through it takes, against the water pumped, and the water it takes before
  the first drip. The standard puck (`standardPuck`) is a fixed curve for
  18 g, scaled by a grind from -1, the finest, four times the resistance, to
  1, the coarsest, a quarter of it. A Shot's puck (`shotPuck`) is worked out
  from its samples after its Preheat: its resistance from its pressure and
  the flow through the puck at each sample where the pump was running and
  pressure had built, the water it took before its first drip, and the
  grams that reached the cup for each ml through it after, past a cup's
  weight read before Decaid's tare at the profile's start landed; none
  where no sample shows its resistance. Another dose
  scales a puck's resistance in proportion and the water its coffee soaks
  up.
- **The fit.** On a Shot's puck, the Shot's own steps, its Workflow's
  profile, are run on that puck on its own Machine's model, ended as it
  ended (`shotFitStop`): with its steps run out where a DE1 ran its last
  step for its time, within a second; otherwise at the weight its scale
  last read, 1 g or more, as reached, or with its last step, whichever comes
  first, however it stopped, as Decaid records a stop on the Machine's own
  button as it does a profile's end; with no scale, with its steps run out
  only where a DE1 ran its last step out.
  A Shot with no scale runs with no step's weight, as Decaid checks none
  without one; and
  the answer gives the Shot's duration, time to first drip, peak pressure
  and each step's end beside the run's (`fitToShot`), to say how far to
  trust the simulation on that puck. A Shot has no fit where its record
  names no Machine model, as Decaid's before v0.9.2 and one whose capture of
  the Machine failed (`provenanceStatus` `unavailable`) don't, or where it
  ran under manual control (`underManualControl`, #599), as under a Bengle's
  lever and group-head modes: for more than half its time after Preheat, its
  Machine reported a target for what its step's pump controls more than
  1 bar or ml/s, or a quarter of what the step asks, from what the step
  asks, a smooth step asking for a ramp over its time from where its pump's
  quantity began, and a lower target counting as asked while the step's
  limiter holds the other quantity within 1 bar or ml/s, or a quarter, of
  its value, however wide the limiter's range. A pressure step's sample
  reporting a pressure target of 0 strays from it too; a flow step's
  reporting a flow target of 0 counts as following it, as a Bengle reports
  a flow step's target as a pressure.
  The margin a run is held to is its duration within 5% of the Shot's or
  1 s, whichever is more, and its peak pressure within 0.5 bar. On the
  corpus of real Shots in `scripts/simulation/corpus/` (#599), its share
  within that margin is held by a test at the level recorded in
  `corpus/levels.json`: 80 of 113 DE1 coffee Shots and 15 of 23 Bengle
  Shots with the machine fitted to it (#601), from 55 and 12 when it was
  committed. `npm run simulation-scorecard` prints how close
  it comes, by model and kind of Profile ([DEVELOPMENT.md](DEVELOPMENT.md#the-simulations-scorecard)).

`GET /api/profiles/:id/simulation` (REST API, below) and the
`simulate_profile` tool (`server/src/mcp/simulation.tools.ts`) simulate a
Library Profile through `ProfileSimulationService`
(`server/src/library/profile-simulation.service.ts`), with its checks
(`checkProfile`), against the models the account has Machines of, and with
those of the run: advice of each step whose pressure or flow never comes
within half a unit, or 10% of a target above 5, of its target while it runs
out its time or until the Shot stops (`targetNotReached`, #579), as when its
limit holds it back, a decline is cut short or the puck can't build it. A
step that ended at its exit, its water or its weight did what it was asked,
and gets none; nor does one that ran 3 s or less, which is over before the
pump catches up and is usually carried on by the next, as a lever's forced
rise is, or one asking for a flow the pump of the model simulated can't
give, which `pumpTooSlow` says already. On the standard puck it is advice for 28 of Decaid's 73
bundled Profiles on a medium grind, each stopping at its own stop-at weight, most of them declines the Shot stops
before they end, and pour-over pulses the puck holds back. Anyone
who reads Profiles may, a Viewer too. The tool
answers within the size budget (ADR-0028): the headline figures, each
step's end and why, never cut, the checks and the fit, and the run's curves
thinned as a Shot's are.

Asked for no model, the route and the tool simulate a Profile as the model
it is shown for (`ProfileView.machineModel`): a Bengle where every Machine
at the Locations showing it is one, by each Machine's latest Location
History entry, and there is at least one; otherwise, shown nowhere, at no
Location with a Machine, or with a DE1 among them, a DE1 (#578, #588).

A Shot's puck is read the same way on both sides: `simulationShotOf` takes
the Shot's full record and measurements, as the server stores them and as
`GET /api/shots/:id` and `/measurements` give them, and `simulateOnShot`
runs a profile on its puck and fits the Shot's own steps to it.

## The Profile page

A Profile's page in the management interface (#578) opens on its graph, a
simulation run in the browser with the shared module, and replaces the
title and steps table it had:

- **How it runs.** On the standard puck by default, 18 g in, stopping at its
  stop-at weight, as the model it is shown for; the dose, the stop-at weight,
  a finer to coarser control, the Machine model and a Recipe's dose and
  yield, of the Recipes naming it, on request. Or on a Shot's puck, chosen
  from the Shots on it and its earlier versions first, then any Shot, with
  the Shot's dose, the weight it stopped at and its Machine's model; the
  Shot is drawn over the run, and a table gives how close its fit comes.
  On the standard puck any Shot can be laid over the run. The headline
  figures are the run's time, time to first drip, peak pressure and flow at
  the stop, and on a Shot's puck how far each is from the Shot's.
- **The graph** (`web/src/components/profile-graph.tsx`) puts pressure, flow
  and temperature each in a lane on one time axis, drawn in the Shot page's
  colours: blue for the run, orange for a Shot or version compared with
  it, dashed grey for the plan. Each step that took time is a band named at
  the top, with how long it ran and why it ended; a step's exit is a dotted
  threshold in the lane it watches, and its limiter a band in the lane it
  caps, from its value up over its range. The stop is a line, with the plan
  the run never reached faint beyond it; a bar marks preinfusion, and a row
  under the lanes the first drip and each 10 g in the cup. Temperature is
  the plan's. Pointing at a moment, or the arrow keys with the graph
  focused, reads the run's values there, against the plan, and the compared
  record's.
- **Steps** in plain words (`web/src/lib/profile-words.ts`): what the Machine
  does, a later step's temperature against the first's, when it moves on,
  and what the simulation on the standard puck did with it; then its brew
  temperature, stop-at weight, where preinfusion ends and its water tank,
  each with what a Recipe replaces.
- **Versions**: its Profile Versions, the latest saved first, each with
  when and by whom it was saved, the Profile it was saved from, where it is
  shown and its Shots. A version is named "Version n" in the order the
  chain's versions were saved, but one of Decaid's bundled Profiles, by its
  title; a chain of one Profile names it by nothing. Any other version opens
  a comparison (`/library/profiles/:id/compare/:other`): the rows where their
  steps' words differ, and both simulated on the same standard puck, in one
  graph.
- Beside them: the Locations showing it, the Recipes on it with the Machines
  that have each loaded, the Shots on it and on its earlier versions, its
  title, author and notes, and its history. Export gives its record's
  profile as Decaid's profile JSON, in a file named by its title.
- **Edit** and **Duplicate** start a Draft of it (Drafts, below), but for a
  Viewer; one of Decaid's bundled Profiles offers Duplicate alone. Each
  version it was saved from offers **Return to it** (Publishing, below).
- **Refused on tablets**: the Machines whose tablets refused its write,
  each with why, the latest first (`ProfileView.refusedOn`, from
  `tablet_refusals`): among them a Decaid answering under another id, which
  computes the Profile's id otherwise than this server's copy (ADR-0032):
  the tablet keeps the record its Decaid made, which its next report adds
  to the Library as a separate Profile, named in the refusal; and a Machine
  whose model can't run it (#588).

An assistant reads the same (ADR-0026): `get_profile_versions`
(`server/src/mcp/library.tools.ts`) gives the versions and the Recipes on a
Profile as the two routes below do, `get_library_item` a version's steps and
its profile, what Export gives, and `simulate_profile` its simulation.

## Drafts

A Draft (ADR-0032, #579) is a profile being written or changed in the
management interface: a row of its own (`drafts`,
`server/src/library/drafts.service.ts`), which no tablet is ever written.
It is not Library content: it is shown at no Location, makes no Conflict
and keeps no history but who saved it last and when. Admins and Staff may
read, change and discard any Draft, Staff anywhere, as no Location holds
one; a Viewer sees none (403 "A Viewer sees no Drafts", the one thing a
Viewer can't read that Staff can). Publishing one makes it a Profile
(Publishing, below).

- **Started** from a Library Profile, by Edit, its profile copied as it is,
  publishing as a new version of it, or by Duplicate, with " copy" after its
  title, publishing as a separate Profile; from one of six starting shapes
  (`STARTING_SHAPES`, `protocol/src/starting-shapes.ts`, there rather than in
  the web's source so an assistant can start one too), each a title, a line
  on what it is for and plain steps with nothing to stop or advise of on a
  medium puck; or from a profile file, Decaid's profile JSON, a bare profile
  or a whole record holding it under `profile` (`readProfileFile`), its
  values held to the widest ranges of the account's models (`holdToLimits`),
  and what was held said. Edit of a bundled Profile is refused (409). A
  Draft keeps a file's steps beyond the 20 a machine takes, up to 100
  (`MAX_DRAFT_STEPS`), which stop it publishing and simulating.
- **Saved** whole, its profile read as Decaid reads one and refused (400)
  with a value outside the widest ranges of the account's models. A save
  names the count of saves it started from (`saves`): it is taken either
  way, under the row's lock, the later save winning, and answers how many
  saves came between and the latest of them, which the page shows. What it
  publishes as can be changed too, a new version only for one started from
  a Profile, and not one of Decaid's bundled ones (409).
- **Checked** as any profile is (`checkProfile`), against the widest ranges
  of the account's models and the Library's Profiles, so one whose steps a
  Library Profile has, as a Draft of Edit unchanged, is refused publishing;
  a simulation adds the run's checks.
- **Simulated** as a Library Profile is, as the model of the Profile it
  started from, or else a Bengle where every Machine of the account is one,
  and otherwise a DE1 (`DraftView.machineModel`).

Its page (`/library/drafts/:id`, `web/src/pages/DraftPage.tsx`) is the
Profile page with a Draft loaded. The graph simulates again in the browser
on every change, with the version it started from, or its starting shape,
simulated on the same puck and drawn faint behind it, stopping at its own
stop-at weight unless one was chosen for both, and the headline figures
said against that one's. The selected step has handles on the graph
(`web/src/components/profile-graph.tsx`): its target in its pump's lane,
at the band's middle, or at its maximum time for a ramp; its exit in the
lane it watches; and its maximum time, a bracket of its own from its start,
past the band's end where the step ends sooner. Each is dragged, holding
the axes still while it is, or moved as a slider with the arrow keys, ten
times as far with Shift. The inspector beside it
(`web/src/components/profile-editor.tsx`) edits the step and the whole
profile, a later step's temperature against the first's and the brew
temperature, the first step's, moving all of them from where they were as
it began to be typed, each number held to the ranges as it is
typed and kept as typed, not at a model's resolution. Steps are added,
duplicated, deleted and moved up or down, where preinfusion ends staying on
the step it ends after (`web/src/lib/profile-edits.ts`). Every change can be
undone and redone through the session, changes of one field within a
second being one (`web/src/lib/edit-history.ts`). It is saved half a second
after the last change, and as the page is left or the tab closed. A save
refused waits for the next change; one lost to the connection or a server
error is tried again, ever more slowly; and a Draft discarded or published
meanwhile is said to be gone. New Profile (`/library/profiles/new`) starts one from
a starting shape, drawn as it runs on a medium puck, a duplicate or a file,
and the Library's Profiles tab lists the Drafts above the Profiles, the one
saved last first, each with what it will become and who saved it last.

## Publishing

Publishing a Draft (#580, `server/src/library/publishing.service.ts`) makes
it a Library Profile under the id Decaid computes (`profileId`), and needs no
tablet online. In one transaction it inserts the Profile, its content a
record as Decaid creates one (`{ profile, parentId, isDefault: false,
metadata: null }`), with no Location it was created at; records it joining
the Library as the account's edit; shows it at the Locations chosen, at
least one; and deletes the Draft. From there the Library writes it to those
Locations' tablets as any Profile, parents first.

- **As a new version**, its `parentId` is the Profile the Draft started
  from, which it takes the place of at each Location chosen: the Recipes
  chosen, each naming that Profile at one of those Locations, move to it,
  each an edit of the Recipe by the account (`recipeEditValues`, as any
  edit), which keeps its Reference Shot and reaches the Machines that have
  it loaded; and the old version is hidden there, but where a Recipe not
  moved, not Archived, still names it, which keeps it shown. A Location not
  chosen is left as it is. Where the Library no longer has the Profile it
  started from, deleted since, it is saved from none and replaces nothing.
- **As a separate Profile**, its `parentId` is the Profile it started from
  too, as Streamline sets a Duplicate's, so it is listed among that
  Profile's versions as a tablet's Duplicate is; but it takes that
  Profile's place nowhere: it moves no Recipes and hides nothing. As a
  tablet's Duplicate does, it then counts as a newer version in the fork
  warning of a Draft of that Profile begun before it, and its page offers
  Return to it on that Profile.
- **Refused** (409, with the checks) for what its checks stop
  (`checkProfile`): among them steps a Library Profile has, naming it, and a
  title a Profile shown at one of the Locations chosen has, compared as
  Streamline compares titles, but those of the versions a new version
  replaces: the Profile it started from, those that was saved from, and
  the rest of the chain titled as one of these, so a fork keeps its title
  and a separate Profile retitled, or a bundled Profile the chain was saved
  from, does not; at a
  Location where a Machine can't run it (`refuseUnrunnableAt`, #588); and
  when the Draft was saved since the person read it, as they would publish
  what they have not seen (`saves`, the count of saves read).
- **A fork.** A Draft's read lists `newer`, the versions saved down the chain
  from the Profile it started from that the Library gained after it began,
  from a tablet or another Draft. Publishing it then saves it from the
  version it started from all the same, forking the chain, and says so
  (`forked`); the dialog, reading the Draft again as it opens, warns first,
  with how each differs from the Draft.
- **Returning to an earlier version** (`returnTo`) is the same change
  between two Profiles the Library has: the earlier version, one of the
  later one's versions and not Archived, shown at the Locations chosen, the
  Recipes chosen moved to it, and the later one hidden there but where a
  Recipe not moved names it. Nothing is created.
- Staff publish to, return at and move Recipes at their own Locations only
  (403); a Viewer neither.
- Locks are taken in the order a tablet's report of new profiles takes
  them: `PROFILE_JOINING_LOCK`, so no tablet adds the same Profile
  meanwhile; each Location's, in order of id; `PROFILE_TITLE_LOCK`, as a
  title edit takes it; the source Profile's row, `FOR KEY SHARE`; then the
  Recipes' rows.

The dialog (`web/src/components/publish-profile.tsx`), opened from a
Draft's page and from Return to it on a version, lists what changed
(`differences`) from the Profile it replaces, or, for a separate Profile,
from the one it started from, the Locations, those that showed the Profile it replaces
chosen to begin with, and, under each Location chosen, the Recipes there
naming that Profile, each chosen to begin with, with the Machines that have
it loaded now; and says for each whether the Profile replaced is hidden
there or stays shown, naming the Recipes that keep it. The page then opened
says what was done.

A tablet whose Decaid answers a Profile's create under another id is
recorded as refusing it, with that id
(`Answered with a record under another id, ...`), which the Profile's page
shows (Refused on tablets, above). The record its Decaid made stays on the
tablet and joins the Library from its next report as a separate Profile, as
the plugin's `writeProfile` says.

## Following a Draft, and Trial Shots

A Draft can be tried on a Machine before it is published (#581, ADR-0032;
`server/src/library/draft-following.ts` and `draft-following.service.ts`).

- **Where.** A Location has a setting, off by default, that an Admin turns
  on: Drafts may be tried here (`locations.tries_drafts`, `triesDrafts` on
  the Locations routes and `edit_location`). Only a Machine taking part at
  such a Location is offered, so a Draft never reaches a cafe's Machine
  unless an Admin marked the cafe. Staff choose only Machines at their
  Locations.
- **Following** is the server's record that a Machine should hold a Draft's
  steps (`draft_followings`, one row for a Draft, and one Draft at a time
  for a Machine, by a partial unique index). While it does, the Machine's
  tablet is due a `write` of the kind `draft` whenever the profile it was
  last written since following began differs from the Draft's
  (`followedDraftDue`), in place of its Loaded Recipe's fields (those are
  still written until the Draft first is, where it can't be: refused by
  the tablet, or not runnable on the model), through the
  same writer as every write (Writing to tablets, above): planned again on
  each `library_changes` notification, which starting to follow and each
  save of the Draft's profile send, one at a time, held while a Shot runs,
  and refused, with why, for a profile the Machine's model can't run
  (`markUnrunnable`). The profile goes under a title of its own, the
  Draft's with "(Draft)" after it (`followedDraftTitle`), as Streamline
  finds a tablet's record of the Workflow's profile by its title.
- **The plugin** sets it whole as the Workflow's profile through one `PUT
  /workflow`, clearing the recipe the Workflow names with it, as DYE2 does
  on a change of profile, so the Machine's Loaded Recipe ends; its dose,
  yield, Bean Batch, Grinder and Basket stay. It never makes a record in
  the tablet's profile list. Its answer carries the profile it wrote, which
  the server keeps (`draft_trials`), timed by the tablet's clock.
- **It ends** when the tablet reports a Workflow whose profile is no longer
  the Draft's steps, compared as a Shot's are with a Profile's (below),
  whatever changed it, a barista, a Recipe or Streamline's wake profile
  (`followedWorkflowReported`, in the transaction storing the Workflow);
  when a person stops it, or has the Draft follow another Machine; when its
  Location stops trying Drafts or the Machine moves to any other Location
  (its latest Location entry is another than when following began, a
  correction of that entry's time, or the removal of a move recorded by
  mistake, aside), leaves or becomes capture-only
  (`endStrandedFollowings`); and, its row
  gone with the Draft's, when the Draft is published or discarded. A
  Workflow reported before the Machine was first written the Draft ends
  nothing, and one holding the steps it was last written doesn't either,
  as a report made before a save's write landed holds those; one holding
  steps it was written earlier, as the Profile the Draft started from,
  does, and so does one naming a recipe, whatever its steps, as DYE2 names
  the one a barista applies and the Draft's write clears it. Once ended, the server writes the Machine nothing of
  the Draft until a person follows again, which replaces what it has
  loaded. The row stays, so the Draft's page says when it ended, why, and
  what the Machine's Workflow holds now.
- **Which plugin.** The write came in wire revision 4
  (`AI_PROTOCOL_NOTES.md`, Wire revision). The server records the revision
  each accepted hello gave (`machines.wire_revision`), so any instance
  lists a Machine whose plugin is behind it as needing its plugin updated,
  and refuses to start following on it; one whose tablet has not connected
  since the server recorded revisions can't be judged, and is refused too.
- **A Trial Shot** is a Shot credited to a Machine the Draft was written
  to, pulled, by the tablet's clock, from when it was written a profile
  whose steps the Shot's Workflow's profile holds: the same steps as the
  Library compares a Shot's with a Profile's (`sameStepsSql`, as
  `shotPulledWithSql`), without each step's temperature and without the
  target weight, so it still matches after the brew temperature or the
  yield was changed on the tablet, and pulled before following on that
  Machine ended (`draft_trials.followed_until`, by PostgreSQL's clock), and
  whose Workflow names no recipe, as one does on a barista's Recipe. It
  is tied to the latest such profile written before it was pulled, and is
  on the current steps where that profile is the Draft's as saved now, as
  the Machine is written it, title aside, else on earlier ones. Nothing is
  stored for the tie: it is read from `draft_trials` and the Shots
  (`trialShotsSql`), through the Shots' index on their Machine and time or
  the one on their steps, so the ties go with the Draft,
  and a Shot on the published steps is then the new Profile's by the
  Library's ordinary rule.
- **The Draft's page** (`web/src/components/draft-trying.tsx`) asks how it
  is tried every five seconds. A card has the switch, the Machine, and
  whether it has these steps and since when, or is waiting for them;
  turning it on first says that the Machine's Loaded Recipe ends. Ended, it
  says what the Machine has, with one control to follow again. The Trial
  Shots are listed, the latest first; the latest on the current steps is
  laid over the graph as it arrives, with the simulation moved to its puck
  and the two sets of figures side by side, as for any Shot's puck (The
  Profile page, above), and an earlier one opens against the steps it ran.

## REST API

Every endpoint requires the account session; Staff read them as Admins do.

- `GET /api/beans` returns `{ beans }`, each `{ id, roaster, name, archived,
  offeredAt, createdAt, createdLocation, likelyDuplicates }`, by name, then
  roaster, ignoring case. `offeredAt` lists the Locations offering it, by
  name, none while it is Archived. `likelyDuplicates` lists the other Beans
  with the same roaster and name, each `{ id, roaster, name }`.
- `GET /api/beans/:id` returns `{ bean }`, the same with its `content` and its
  `batches`, as the Bean Batches list shows them, the latest roasted first;
  or 404.
- `GET /api/bean-batches` returns `{ batches }`, each `{ id, bean: { id,
  roaster, name }, roastDate, archived, locations, createdAt, createdLocation
  }`, by their Bean's name and roaster, ignoring case, then the latest roast
  date first. `roastDate` is the content's, as Decaid recorded it. `locations`
  lists the Locations it is at, by name, each `{ location, remainingWeight,
  since }`: the remaining weight entered there last, in grams, or null if none
  was or it was cleared, and when it was last added there, which a tablet
  adding it again while it is there moves.
- `GET /api/bean-batches/:id` returns `{ batch }`, the same with its
  `content` and `finished`, the Locations it was at and has been finished at
  since, each `{ location, remainingWeight, finishedAt }`; or 404.
- `GET /api/grinders` returns `{ grinders }`, each `{ id, model, burrs,
  burrType, archived, location, createdAt }`, by model, ignoring case, then
  by their Location's name. `model`, `burrs` and `burrType` are its
  content's. `location` is the Location it belongs to, the only one offering
  it unless it is Archived, or null if that Location no longer exists.
- `GET /api/grinders/:id` returns `{ grinder }`, the same with its `content`;
  or 404.
- `GET /api/profiles` returns `{ profiles }`, each `{ id, title, author,
  beverageType, bundled, archived, shownAt, createdAt, createdLocation }`, by
  title, ignoring case. `id` is Decaid's, such as
  `profile:bf1ca48b9c7389c7d146`; `title`, `author` and `beverageType` are its
  content's. `shownAt` lists the Locations showing it, by name, each `{
  location, since }`, when the Location last decided to show it, by
  PostgreSQL's clock, as when a tablet there showed it again while it was
  shown. None while it is Archived.
- `GET /api/profiles/:id` returns `{ profile }`, the same with its `content`;
  its `profile`, as Decaid reads it (`readProfile` in
  `protocol/src/profile.ts`), each field Decaid reads and writes for a
  profile and a step, or null where Decaid would not read it; `parent`, `{ id, title }` of the Profile it was saved from if the
  Library has it, or null; and `locations`, each Location that has decided
  whether it shows it, by name, `{ location, shown, since }`, kept while it
  is Archived; and `machineModel`, the model it is simulated as unless asked
  (Simulating a Profile, above); and `refusedOn`, the Machines whose tablets
  refused its write, each `{ machine: { id, name }, error, refusedAt }`, the
  latest first; or 404. A Location not listed does not show
  it. The id goes in the path as it is or percent-encoded.
- `GET /api/profiles/:id/versions` returns `{ versions }`, its Profile
  Versions: every Profile in the chain of `parentId` links through it, up to
  the first, whose link names no Profile in the Library or one of Decaid's
  bundled Profiles, and down through each saved from one in the chain, so
  both branches of a fork, at most 200, the latest saved first. A bundled
  Profile the first was saved from is listed, but not walked down through,
  so Profiles saved from it apart, as at two Locations, are not each other's
  versions; a bundled Profile's own versions are itself alone. Each is
  `{ id, title, bundled, archived, parentId, savedAt, savedBy, shownAt,
  shots }`: `parentId` the Profile it was saved from where that is listed,
  else null;
  `savedAt` its history's first entry's time, the record its first tablet
  sent, else when it joined the Library; `savedBy` that entry's source, as
  a history's (a Machine, or an account named to Admins only), or null;
  `shots`, how many Shots the Shots list's `profileId` filter counts. 404
  for no such Profile.
- `GET /api/profiles/:id/recipes` returns `{ recipes }`, the Recipes not
  Archived whose content names it, each `{ recipe, loadedOn }`: the Recipe
  as `GET /api/recipes/:id` gives it, and the Machines whose Loaded Recipe it
  is now, `{ id, name }`; by Location name, slot and name. 404 for no such
  Profile.
- `GET /api/profiles/:id/simulation` returns `{ simulation }`, the Profile
  simulated (Simulating a Profile, above): `{ profile, model, puck, dose,
  stopAt, run, checks, fit }`. It runs on the standard puck at `grind`, from
  -1 to 1, 0 where left out, or on the puck of the Shot `shotId`, with
  `dose` in grams, above 0 and up to 50, else the Shot's, as weighed or else
  as set, or 18; stopping at `stopAt` grams, 0 to run until the last step
  ends, else the Profile's stop-at weight; on a Machine of `model`, `DE1` or
  `Bengle`, else the model it is simulated as (`machineModel`). `puck` is `{ kind: "standard", grind }` or
  `{ kind: "shot", shotId, model }`, the model of the Machine the Shot
  recorded, which its fit runs on, null where its record names none; `run` is `simulateProfile`'s, every
  sample; `checks` are the Profile's (`checkProfile`); `fit` is
  `{ shot, simulated }` on a Shot's puck, each `{ duration,
  timeToFirstDrip, peakPressure, steps }`, and null on the standard puck or
  where Decaid would not read the Shot's own profile or it has more than 20
  steps, where its record names no Machine model, where it ran under manual
  control (`underManualControl`), or where the run can't end as the Shot did (`shotFitStop`): a DE1
  that ran its last step for its time runs its steps out, and otherwise the
  fit stops at a weight of 1 g or more read within a second of the stop; so
  none with no such weight, as with no scale, a stop before anything reached
  the cup or a scale that dropped out, unless a DE1 ran its last step out,
  and none where its scale dropped out and a step has a weight, as Decaid
  checks no step's weight once the scale is lost. The two lists of
  steps leave out steps of no length; match them by `index`. 400 for a value out of range, or both `grind` and `shotId`; 404 for
  no such Profile or Shot; 409 for a Profile whose profile Decaid would not
  read or that has more than 20 steps, the most a machine takes, or a Shot
  whose samples show nothing of its puck's resistance: no pressure and flow
  together.
- `GET /api/drafts` returns `{ drafts }`, every Draft, the one saved last
  first, each `{ id, title, startedFrom, shape, publishesAs, savedBy,
  savedAt, saves, createdAt }`: `startedFrom` the Library Profile it was
  started from, `{ id, title, bundled }`, its title and bundled null where
  the Library no longer has it, or null; `shape` the starting shape, `{ key,
  title }`, or null; `publishesAs` `version` or `separate`; and `savedBy` a
  source as an item's history gives one. `GET /api/drafts/:id` returns `{
  draft }`, the same with its `profile`, the `profileId` Decaid would give
  it, the `models` the account has Machines of, its `machineModel` and its
  `checks`, and `newer`, for a new version, the versions of the Profile it
  started from the Library gained since it began, each `{ id, title,
  savedAt }`, the latest first. 403 for a Viewer, 404 for no such Draft.
- `POST /api/drafts` starts one and returns `{ draft, held }` with 201, from
  `{ profileId, as }`, `as` `version` (Edit) or `separate` (Duplicate); `{
  shape }`, a starting shape's key; or `{ file }`, a profile file's content.
  `held` lists each value of a file held to the ranges, `{ step, path, from,
  to }`. 400 for none or more than one of them, an unknown shape or a file
  Decaid would not read; 404 for no such Profile; 409 for Edit of a bundled
  one.
- `PUT /api/drafts/:id`, with `{ profile?, publishesAs?, saves }`, saves it
  and returns `{ draft, between }`, `between` null or `{ saves, savedBy,
  savedAt }`, the saves made since the count `saves` names and the latest of
  them. 400 for a profile Decaid would not read, one of more than 100 steps,
  a value outside the widest ranges of the account's models, or `version`
  for one started from no Profile; 409 for `version` for one started from a
  bundled Profile. `DELETE /api/drafts/:id` discards it,
  204. `GET /api/drafts/:id/simulation` simulates it, taking the query a
  Profile's simulation does, and returns `{ simulation }` with `draft: { id,
  title }` in place of `profile`; 409 for more than 20 steps or none.
- `POST /api/drafts/:id/publish`, with `{ locations, recipes?, saves }`,
  publishes it (Publishing, above) and returns `{ published }`: `{ profile:
  { id, title }, replaced, shownAt, hiddenAt, keptAt, moved, forked }`,
  `replaced` the Profile it took the place of or null, each place `{ id,
  name }`, `keptAt` each `{ location, recipes }`, each Recipe `{ id, name,
  location }`, and `forked` the newer versions it forks beside. 400 for no
  Location, a Location or Recipe named twice, no such Recipe, a Recipe at
  none of the Locations, or any Recipe for a separate Profile; 403 for a
  Viewer or Staff elsewhere; 404 for no such Draft or Location; 409 for what
  its checks stop, with `checks`, a Draft saved since `saves`, a Recipe not
  naming the Profile replaced or Archived, or a Location where a Machine
  can't run it.
- `GET /api/drafts/:id/trying` returns `{ trying }`, how the Draft is tried
  (Following a Draft, and Trial Shots, above): `following`, null where it
  never was followed, else `{ machine: { id, name, location }, startedAt,
  state, since, waitingFor, ended, has, titleOnTablet }`, `state` one of
  `current`, the Machine has the Draft's steps as saved, since `since`,
  `waiting`, with `waitingFor` why where the server knows, as its tablet's
  refusal, and `ended`, with `ended: { at, why }`, `why` one of `workflow`,
  `stopped` and `location`, and `has` the title of the profile the
  Machine's Workflow holds now; `machines`, those taking part at a Location
  that tries Drafts, each `{ id, name, location, needsPluginUpdate,
  canFollow, follows }`, `follows` another Draft it follows now; and
  `trialShots`, the latest fifty, each `{ shot, trialId, steps }`, `shot`
  as the Shots list gives one and `steps` `current` or `earlier`. 403 for a
  Viewer, 404 for no such Draft.
- `PUT /api/drafts/:id/following`, with `{ machineId }`, has that Machine
  follow it, and `DELETE /api/drafts/:id/following` stops it; each returns
  `{ trying }`. Following is refused with 403 for Staff working elsewhere
  than at the Machine's Location; 404 for no such Draft or Machine; 409 for
  a Capture-only Machine, a Location that doesn't try Drafts, a Machine
  following another Draft, one that needs its plugin updated or whose
  tablet has not connected yet, and a Draft with no steps or more than a
  machine takes. Stopping is refused with 409 where no Machine follows it.
- `GET /api/drafts/:id/trials/:trialId` returns `{ trial }`, a profile the
  Draft was written to a following Machine with, which a Trial Shot ran:
  `{ id, machine, writtenAt, profile }`, the profile under the Draft's own
  title. 404 for none such.
- `GET /api/locations` gives each Location's `triesDrafts`, and `PATCH
  /api/locations/:id` takes it, Admins only. Turning it off ends the
  following of each of the Location's Machines.
- `POST /api/profiles/:id/return`, with `{ from, locations, recipes? }`,
  returns to the Profile, an earlier version of `from`, and returns `{
  published }` as publishing does, `forked` empty. 400 for returning to
  `from` itself, no Location, a Location or Recipe named twice, no such
  Recipe, or a Recipe at none of the Locations; 403 for a Viewer or Staff
  elsewhere; 404 for no such Profile or Location; 409 for one not among
  `from`'s versions, one Archived, a Recipe not naming `from` or Archived,
  or a Location where a Machine can't run it.
- `POST /api/beans`, with `{ content }`, creates a Bean, its roaster and name
  required, and returns `{ bean }` with 201; 409 with `{ existing: { id,
  roaster, name } }` if the Library has a Bean of that roaster and name.
  `PATCH /api/beans/:id`, with `{ content }`, each field to change, null to
  clear it, edits one; `PUT /api/beans/:id/archived`, with `{ archived }`,
  Archives or restores one; each returns `{ bean }`. 400 for a field that is
  not Decaid's or a value Decaid would refuse.
- `POST /api/bean-batches`, with `{ beanId, content, locations }`, each
  Location `{ locationId, remainingWeight }`, the weight optional, creates a
  batch at them, and returns `{ batch }` with 201; 409 if its Bean is
  Archived. `PATCH /api/bean-batches/:id` and `PUT
  /api/bean-batches/:id/archived` edit its details and Archive or restore it.
  `PUT /api/bean-batches/:id/locations/:locationId`, with `{ atLocation,
  remainingWeight }`, either or both, adds it at the Location (true) or
  finishes it there (false), and sets its remaining weight there, null to
  clear it; 409 for a weight where it is not and is not added. Each returns
  `{ batch }`. 403 for Staff at a Location they do not work at.
- `POST /api/grinders`, with `{ locationId, content }`, its model required,
  creates a Grinder belonging to that Location, and returns `{ grinder }`
  with 201. `PATCH /api/grinders/:id` and `PUT /api/grinders/:id/archived` edit
  it and Archive or restore it, each returning `{ grinder }`. 403 for Staff
  creating or editing one at a Location they do not work at; they Archive
  and restore any.
- `PATCH /api/profiles/:id`, with `{ content }`, any of `title`, `author`
  and `notes`, edits a Profile's title, author and notes, and returns `{
  profile }`: anywhere, Staff too. A title can't be cleared, and an author
  or notes sent null or empty is cleared, kept empty. 400 for another field
  or a value that isn't text, 404 for no such Profile, and 409 for one of
  Decaid's bundled Profiles, whose Decaid refuses to change, or for a title
  another Profile has, Archived or not, whatever its case and the spaces
  around it, as Streamline finds a tablet's record of a profile by its
  title.
- `PUT /api/profiles/:id/locations/:locationId`, with `{ shown }`, shows the
  Profile at the Location or hides it there; `PUT /api/profiles/:id/archived`,
  with `{ archived }`, Archives or restores it. Each returns `{ profile }`;
  400 without a boolean, 404 for no such Profile or Location, 403 for
  Staff showing or hiding one at a Location they do not work at, and 409
  for showing one where a Machine can't run it, naming them and the values.
  They Archive and restore any.
- `DELETE /api/beans/:id`, `DELETE /api/bean-batches/:id`, `DELETE
  /api/grinders/:id`, `DELETE /api/profiles/:id`, `DELETE /api/baskets/:id`,
  `DELETE /api/tools/:id` and `DELETE /api/recipes/:id` hard-delete one, a
  Bean with its batches, and answer 204: Admins only. 409 if a Shot names
  it, or one of a Bean's batches, or a Recipe names a Basket or Tool, or it
  is one of Decaid's bundled Profiles.
- `GET /api/baskets` and `GET /api/tools` return `{ baskets }` and
  `{ tools }`, each `{ id, name, archived, shownAt, createdAt,
  createdLocation, content }`, by name, ignoring case; `shownAt` as a
  Profile's, and `content` DYE2's record fields but its id, `createdAt` and
  global id, which are few, so the lists show them. `createdLocation` is the
  Location it was created at, by a tablet there or here. `GET
  /api/baskets/:id` and `GET /api/tools/:id` return `{ basket }` or `{ tool
  }`, the same with `locations`, each Location that has decided whether it
  shows it, as a Profile's; or 404. `PUT
  /api/baskets/:id/locations/:locationId` and `PUT
  /api/tools/:id/locations/:locationId`, with `{ shown }`, show it at the
  Location or hide it there, as for a Profile: shown, it is written to the
  Location's tablets; hidden, it is removed from their lists. 403 for Staff
  at a Location they do not work at. Their `history` and `conflicts` are an
  item's (below).
- `POST /api/baskets` and `POST /api/tools`, with `{ locationId, content }`,
  its name required, create one shown at that Location, and return `{ basket
  }` or `{ tool }` with 201; 409 with `{ existing: { id, name, archived } }` if
  the Library has one of its kind of that name, Archived or not; 404 for no such
  Location; 403 for Staff at a Location they do not work at. `PATCH
  /api/baskets/:id` and `PATCH /api/tools/:id`, with `{ content }`, each
  field to change, null to clear it, edit one, and `PUT
  /api/baskets/:id/archived` and `PUT /api/tools/:id/archived`, with `{
  archived }`, Archive or restore one, Staff anywhere; each returns `{ basket
  }` or `{ tool }`. 400 for a field that is not DYE2's or a value its page
  would not save.
- `GET /api/locations/:id/recipes` returns `{ recipes }`, the Location's
  Recipes: those in its slots, in slot order, then the rest, by name,
  ignoring case, each `{ id, name, location, slot, archived, createdAt,
  content, uses, batchFinished, referenceShot }`: `slot` its Recipe Slot, null for none,
  `content` its content in the Library's terms (Taking in a tablet's
  recipes, above), `uses` the items it names, `{ bean, beanBatch, profile,
  grinder, basket, tools }`, each with what names it (a Bean's roaster and
  name, a batch's `roastDate` and whether it is at the Recipe's Location
  now, `atLocation`, a Profile's title, a Grinder's model, a Basket's or
  Tool's name), null where it names none, and one the Library no longer has
  named by its id alone; and `batchFinished` whether it is in a slot and
  names a batch not at its Location now, finished there or Archived. 404
  for no such Location. `referenceShot` is its Reference Shot, `{ id,
  pulledAt, machine, location, profileTitle, profile, targetDose,
  actualDose, targetYield, actualYield, duration, enjoyment,
  grinderSetting, profileDiffers }`, as the Shots list gives those of the
  Shot, and `profileDiffers` whether the Recipe names a Profile and the
  Shot's is another or none in the Library; null for none, or for one the
  Shots list no longer lists. A Location's list gives it from the release
  after 1.10.1 (#547), with its `enjoyment` and `grinderSetting`, for the
  lists of Recipes that show its duration; before, only a Recipe's own
  read did. `GET /api/recipes/:id` returns `{ recipe }`, the same; or 404. Each route changing a Recipe
  returns it so. `GET /api/recipes/:id/history` and `GET
  /api/recipes/:id/conflicts` are an item's (below); a history entry that
  moved it sets `slot` at its Location, null out of any, and one that chose
  or cleared its Reference Shot sets `referenceShotId`, with no Location.
  Staff read them as Admins do.
- `POST /api/recipes`, with `{ locationId, slot, content }`, creates a
  Recipe at the Location under a new record id, in `slot`, a whole number
  from 1 to 9 (`RECIPE_SLOTS`), `next` for the lowest free of them, or none where
  every slot holds a Recipe, or null (the default) for none, and returns `{
  recipe }` with 201. `PATCH /api/recipes/:id`, with `{ content }`, each
  field to change, null to clear it, edits one. `PUT /api/recipes/:id/slot`,
  with `{ slot }` as for a new one, moves it, the Recipe in that slot taking
  its old one, or takes it out of its slot (null); `next` where every slot
  holds a Recipe is refused (409). `PUT /api/recipes/:id/reference-shot`,
  with `{ shotId }`, a Shot's id or null, makes that Shot its Reference
  Shot or clears it: 400 for a Shot the Shots list does not list ("No such
  Shot"), 409 for choosing one for an Archived Recipe. `PUT
  /api/recipes/:id/archived`, with `{
  archived }`, Archives it, out of its slot, or restores it, in none, under
  a new record id where another Recipe there has taken its own. Each
  returns `{ recipe }`. 400 for a field that is not one a Recipe takes, as
  its steam and hot water modes, a value DYE2 would not save, as a steam,
  hot water or flush setting out of its editor's range, an item the Library does not have, or
  `toolAttributes` naming a Tool the Recipe does not use; 409 for another
  Location's Grinder, an Archived item, a Profile a Machine at the Location
  can't run (and so for such a copy), putting an Archived Recipe in a
  slot, moving one to `next` with no slot free, or a Recipe whose Location
  no longer exists; 404 for no such Recipe
  or Location; 403 for Staff at a Location they do not work at.
- `GET /api/beans/:id/history`, `GET /api/bean-batches/:id/history`,
  `GET /api/grinders/:id/history` and `GET /api/profiles/:id/history` return
  `{ versions }`, the item's history entries (ADR-0020), the latest taken
  in first, each `{ id, fields, location, source, editedAt, receivedAt }`:
  the fields it set, with their values, of the item's content, or of its
  state at
  `location` (`atLocation`, `remainingWeight`, `shown`), null for its
  content; where it came from, `source`, `{ machine, tabletId, account,
  connectedApp }`, the Machine `{ id, name }` whose tablet made it, if one
  did and it still exists, that tablet's id, the account `{ id, name }` that
  made it in the management interface or through an assistant, its name null
  to Staff, as other accounts' names are personal information Staff do not
  see, and the Connected App `{ id, name, host }` it made it through (#411,
  ADR-0026), by the name its app gave and its client id's host as it was
  approved, null for the management interface, as for every edit the
  previous release takes in; when it was made, a tablet's by its
  record's `updatedAt` in UTC, a delete on a tablet when the server learned
  of it; and when the server took it in, by PostgreSQL's clock. The first is
  the item joining the Library. `?field=` names a field, of its content or
  of a Location's state of it, to list only the history entries that set
  it, to a value or cleared, the first among them where it set it (#442);
  400 for one given twice, empty or over 200 characters. 404 if the Library
  does not have the item.
- Each item's Shots are the Shots list's, filtered by it: `GET
  /api/shots?beanId=`, `beanBatchId=`, `grinderId=`, `profileId=`,
  `recipeId=` or `basketId=` (`SHOTS.md`). A Tool lists none, as Shots are
  not linked to their Tools.
- `GET /api/conflicts` returns `{ conflicts }`, the open Conflicts, the
  latest first, each `{ id, item, field, value, location, source, editedAt,
  createdAt, state, current, resolvable }`: the item `{ kind, id, name }`,
  `kind` being `bean`, `beanBatch`, `grinder`, `profile`, `basket`, `tool`
  or `recipe`, and `name` a Bean's roaster and name, a batch's Bean and the
  day it was roasted, as `Guji, roasted 2026-10-01`, a Grinder's model, a
  Profile's title or a Basket's, Tool's or Recipe's name, null where its
  content has none; the field and the
  losing value, null where the edit cleared it; the Location whose state the
  field is, null for content; where and when the losing edit was made, as a
  history entry's; when it became a Conflict; `open`, `used` or `dismissed`; the
  field's value now, `{ value, source, editedAt, versionId }`, with where
  and when the edit that set it was made, and its history entry, each null
  if that is not known, as for a field
  nothing set; a batch never added at the Location is not there, and a
  Profile its Location never decided not shown; and whether the signed-in
  account may use its value or dismiss it (Resolving Conflicts, above).
- `GET /api/beans/:id/conflicts`, `GET /api/bean-batches/:id/conflicts`,
  `GET /api/grinders/:id/conflicts` and `GET /api/profiles/:id/conflicts`
  return `{ conflicts }`, the item's open Conflicts, as the list shows them;
  or 404.
- `POST /api/conflicts/:id/use`, with `{ seen }`, the `current.versionId`
  the Conflict was shown with, uses an open Conflict's value, and `POST
  /api/conflicts/:id/dismiss` dismisses it (Resolving Conflicts, above). Each
  returns `{ conflict }`, closed, with the field's value now; 400 if `seen`
  is not a history entry's id or null, 404 if there is no such Conflict,
  403 if the account may not resolve it, and 409 if it was used or
  dismissed already, or the field was decided since the history entry
  `seen`.
- `PUT /api/machines/:id/sharing`, with `{ sharing }`, turns the Machine's
  sharing on or off, off making it a Capture-only Machine, and returns the
  same: Admins only. 400 without a boolean, 404 for no such Machine.
  `GET /api/machines/:id` and `GET /api/machines` give each Machine's
  `sharing`, and `captureOnly`, why it is a Capture-only Machine:
  `noLocation`, `sharingOff` or both, none while it takes part.
- `GET /api/machines/:id/sharing-status` returns `{ status }`, the
  Machine's sharing status (above): `{ tabletId, waiting, lastApplied,
  refused, unrecognisedLists }`. `tabletId` is the tablet it is read for, or null if none has
  connected. `waiting` is how many changes that tablet is
  due and has not refused, or null while it is written nothing, as the
  Machine is capture-only or no tablet has connected. `lastApplied` is the
  last change it applied, or null, and `refused` the changes it refused that
  are still due, the latest refused first (Sharing status, above), each `{ change, kind, item,
  localId }`: `change` is `write`, `delete`, `remove` or `leaveOut`; `kind` a Library
  kind or `workflow`; `item` the item, `{ kind, id, name }`,
  named as a Conflict's is, or for the Workflow "Grinder, batch and Basket", null
  for a record set aside, which is none of the Library's, or an item
  deleted since; and `localId` Decaid's id for the record, null for a
  create and the Workflow. `lastApplied` adds `appliedAt`,
  and each refusal `status`, Decaid's HTTP status or null if it gave none,
  `error`, what it answered or why, and `refusedAt`. `unrecognisedLists` are DYE2's lists not written, each
  `{ list, since }`, by the collection's name, such as `dye2Baskets`. 404
  for no such Machine.

The management interface's Library section lists the Beans and where each is
offered, the Bean Batches, the Locations each is at and its remaining weight
at each, the Grinders and the Location each belongs to, and the Profiles and
where each is shown. Each Bean's page shows its content, where it is
offered, its batches and its likely duplicates, each batch's page its roast,
the Locations it is at with its remaining weight at each, and where it was
finished, each Grinder's page its Location and what it is, and each
Profile's page where it is shown, its steps and the Profile it was saved
from. It opens on its Recipes (`/library/recipes`,
`web/src/pages/RecipesPage.tsx`, #547), the first of its lists: every
Location's, a table for each Location (`RecipesTable` in
`web/src/components/recipes.tsx`, which a Location's Recipes card shares),
in Recipe Slot order with those in no slot after, each with its Bean Batch,
Profile, dose and yield, Grinder and setting, its Reference Shot's
duration, linked to that Shot, or "No reference", linked to its rated
Shots, and what needs attention; Archived Recipes show once Show archived
is ticked, which the address keeps as `archived`. It reads each Location's
list, and no route was added for it. Its New Recipe (`NewRecipeDialog` in
`web/src/components/recipes.tsx`) asks for the Location first, of those the
account may change, choosing it when there is only one, then opens the
Recipe form a Location's Recipes card creates one with.
Each item's page notes its open Conflicts, if it has any, and shows how
many Shots it has, with a link that opens them in the Shots list
(`web/src/components/item-shots.tsx`), and its history, and the
Library's Conflicts page lists every open Conflict, the latest first, with
the losing value and the value now, and where and when each came from. A
Conflict is used or dismissed from either, by an account that may
(`web/src/components/conflicts.tsx`). Each Location's page
(`/locations/:id`) lists its Machines, a capture-only one flagged. A
Machine's page says whether it shares the Library at its Location or is capture-only, and why, with a
switch an Admin turns its sharing off and on with, once they confirm, and
its sharing status, loaded as often as its own status: the changes waiting
for its tablet, the last it applied, and those it refused, with Decaid's
answer (`web/src/components/machine-sharing.tsx`). The Beans, Bean Batches,
Grinders, Baskets and Tools lists create them, and each item's page edits it, Archives or
restores it, and, for an Admin, deletes it; a batch's page adds it at each
Location and finishes it there, and sets its remaining weight there
(`web/src/components/library-forms.tsx`). A Bean refused as one the Library
has links to that Bean. Each Profile's page lists every Location, each with
a switch that shows or hides the Profile there, for an Admin or Staff
working there (`ProfileLocationsCard` in `web/src/components/profiles.tsx`),
and Archives or restores it, and, for an Admin, deletes one not bundled
with Decaid.

## Adding a Library kind

Each kind of Library item is described once on each side, and what treats
every kind alike reads that description: its history and Conflicts, edits
of its content, what a tablet is due and holds, the writer's waits and the
gateway's answers, joining, hard deletes and sharing status on the server;
the lists the plugin reports and how it writes, deletes and sets aside
records; and history, Conflicts and sharing status in the management
interface. A new kind, as milestone 3's Baskets, Tools and Recipes were, needs:

1. **The protocol** (`protocol/src/index.ts`): an entry in
   `LIBRARY_ITEM_KINDS`, in the order its list is read and written, after
   the kind its records are made under, if any, whose own records are made
   under none, as records nest one deep: the
   tablet's list its records are reported in, one of `COLLECTION_NAMES`;
   what its ids are (`ItemIdRule`), `GLOBAL_ITEM_ID` for a global id or a
   rule of its own for ids that are not UUIDs, which every message naming
   one of its items is checked against (`itemIdRule`); and the kind its
   records are made under on a tablet, if any (`under`), whose list is then
   reported before its own and taken in first, and whose records are
   deleted after its own (`REMOVAL_ORDER`). `LIBRARY_KINDS`,
   `LIBRARY_LISTS` and `isDeletedKind` follow from it.
2. **The plugin** (`plugin/src/library-writes.ts`): an entry in `WRITERS`:
   where Decaid's API lists its records, which `CollectionCapture` reads and
   reports, and how a write, a delete and setting aside a record are carried
   out, through a route for records Decaid keeps as it keeps beans
   (`ROUTES`, `recordWriter`), or by functions of its own. If a Shot names
   its records, its route sets `namedByShots`, and `LibraryWrites.noteShot`
   notes the ids a Shot's Workflow names, so a record a Shot not yet sent
   names is not deleted.
3. **The schema and its migration**: its table, with `content`, `archived`
   and `field_edits` as the other kinds have them; each tablet's map of its
   records; a Location's state of it, if it has one; and its table's four
   triggers keeping `versioned_items` (Storage, above), without which its
   items can have no history or Conflicts.
4. **The server** (`server/src/library/kinds.ts`): an entry in `KINDS`
   (`LibraryKindDescription`): its name, table, id type and map; its content
   as edits merge it, from the Library's content and from a tablet's
   record; what the management interface may set of it; its part of what a
   Location offers and a tablet holds (`holdings`), and the writes that
   bring a tablet's records to it (`plan`, in `holdings.ts`); whether a
   Location offers any, as a joining tablet's are judged; what its hard
   delete reads and keeps; a Location's state of it, if any, as Conflicts
   about it read and use it; and its own modules' intake of a report
   (`takeIn`) and record of a write's answer (`recordWritten`).
5. **Its own modules**: taking in a report of its list and recording an
   answer, as `beans.ts` does, with a pure planning module and its module
   tests, as `bean-intake.ts` has; the changes of a Location's state of it,
   if any (`location-state.ts`); its REST API, with each new route named in
   `server/test/access.test.ts`; its reads through an assistant, in
   `server/src/mcp/library.tools.ts`, whose kinds `KIND_NAMES` lists, and
   its changes, in `server/src/mcp/library-changes.tools.ts`, both of whose
   switches over kinds then fail to compile until they read it, as do the
   latter's notes on each kind's fields (`FIELD_NOTES`) until they have the
   kind's, and its schemas of each type of field (`fieldSchema`) until they
   have any new type's; and,
   if a Shot names it, its columns on a
   Shot (`shotLink`) and how a Shot's metadata names it
   (`server/src/shots/links.ts`).
6. **The management interface** (`web/src/lib/library-kinds.ts`): an entry
   in `LIBRARY_KINDS`, its name, pages, REST API and Shots filter, which
   history, Conflicts and sharing status read; and its pages.
7. **Tests**: the simulated tablet carrying out the writes of its records
   as Decaid, or DYE2, does (`server/test/support/simulated-tablet.ts`),
   Seam 1 tests of it through the built plugin, and Seam 2 specs of its
   pages.

## Not yet

Decaid hides a bundled Profile a release no longer bundles, or bundles anew
under another id (`_retireStaleDefaults` in
`decaid:lib/src/controllers/profile_controller.dart`). So once tablets at one
Location run Decaid releases that bundle different Profiles, the first to
upgrade hides the old one at the Location, on the others too, which lack the
new one: bundled Profiles are never written. v0.8.7, v0.8.8 and v0.9.0 bundle
the same Profiles.

`server/test/library-beans.test.ts`, `server/test/library-batches.test.ts`,
`server/test/library-grinders.test.ts`,
`server/test/library-profiles.test.ts`,
`server/test/library-edits.test.ts`,
`server/test/library-conflicts.test.ts`,
`server/test/library-management.test.ts`,
`server/test/library-profile-management.test.ts`,
`server/test/library-profile-text.test.ts`,
`server/test/profile-simulation.test.ts`,
`server/test/drafts.test.ts`,
`server/test/publishing.test.ts`,
`server/test/draft-following.test.ts`,
`server/test/joining.test.ts` and
`server/test/capture-only.test.ts`, `server/test/sharing-status.test.ts`,
`server/test/library-equipment.test.ts`,
`server/test/library-equipment-management.test.ts`,
`server/test/library-recipes.test.ts` and
`server/test/library-recipe-management.test.ts` cover this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL;
`server/test/bean-intake.test.ts`, `server/test/batch-intake.test.ts`,
`server/test/grinder-intake.test.ts`, `server/test/profile-intake.test.ts`,
`server/test/equipment-intake.test.ts`, `server/test/recipe-intake.test.ts`, `server/test/holdings.test.ts`, `server/test/merge.test.ts`,
`server/test/join-plan.test.ts`, `protocol/test/simulation.test.ts`,
`protocol/test/profile.test.ts` and `web/test/profile-edits.test.ts`
the pure modules;
`server/test/simulated-bean-writes.test.ts`,
`server/test/simulated-batch-writes.test.ts`,
`server/test/simulated-grinder-writes.test.ts`,
`server/test/simulated-profile-writes.test.ts` and
`server/test/simulated-workflow-writes.test.ts` the simulated tablet's writes
against those recorded on Decaid's Linux release
(`server/test/fixtures/decaid/bean-writes-v0.8.7/`,
`bean-batch-writes-v0.8.7/`, `grinder-writes-v0.8.7/`,
`profile-writes-v0.8.7/`, `workflow-writes-v0.8.7/` and
`workflow-writes-v0.9.0/`); and
`e2e/library.spec.ts`, `e2e/library-management.spec.ts`,
`e2e/profile-management.spec.ts`, `e2e/profile-editor.spec.ts`, `e2e/profile-publishing.spec.ts`, `e2e/draft-following.spec.ts`, `e2e/conflicts.spec.ts`,
`e2e/capture-only.spec.ts`,
`e2e/sharing-status.spec.ts`, `e2e/equipment-management.spec.ts` and
`e2e/recipe-management.spec.ts` the management interface.
