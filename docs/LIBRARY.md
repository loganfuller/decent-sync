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
field with the latest edit winning, keeping each accepted edit as a version
and each that lost as a Conflict (Edits, below), and ticket
[#85](https://github.com/loganfuller/decent-sync/issues/85) shows the
Conflicts and each item's history in the management interface, where a
Conflict's value is used or the Conflict dismissed (Resolving Conflicts,
below). Ticket [#86](https://github.com/loganfuller/decent-sync/issues/86)
shares each Location's steam, hot water and rinse settings between its
Machines (Steam, hot water and rinse settings, below). Ticket
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
instead. It follows ADR-0003, ADR-0006, ADR-0008, ADR-0014, ADR-0016,
ADR-0018, ADR-0019 and ADR-0020.

## Who takes part

A Machine takes part while it is at a Location, the Location of the latest
entry of its Location History, with its sharing on. A Machine with no
Location is a Capture-only Machine, and so is one an Admin turned sharing
off for (`machines.sharing`, on by default): its tablet's beans, bean
batches, grinders and profiles, and its Workflow, are captured as in
milestone 1 (`COLLECTIONS.md`, `WORKFLOW-AND-STATE.md`), but not taken into
the Library or the Location's settings, and nothing is written to it, not
even a hard delete's. Its page says it is capture-only, and why.

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
  bundled Profiles too (Taking in a tablet's profiles, below).

So a Bean with batches is offered only where they are: once its last batch
at a Location is finished, it is no longer offered there. Archived items are
offered nowhere. Only the management interface Archives a Bean, Bean
Batch or Profile; a Grinder is Archived there too, or
by archiving or deleting it on a tablet at its Location. What the Location offers is written
to each of its tablets, with each batch's remaining weight there and each
Profile visible, and what it does not offer is archived or hidden on them,
never deleted, so their Shots still find it (Writing to tablets, below).

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
  (ADR-0020). Each that applies is a version (`item_versions`, below), whose
  id the field keeps (`presence_version_id`, `remaining_weight_version_id`),
  so a Conflict it becomes knows where it came from. One that applies is the
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
  edited since. Also whether it is Archived, a field of its own merged with
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
  hidden as it was, the tablet whose edit decided it, and that edit's version
  (`version_id`). A Location with no row for a Profile has decided nothing of
  it, and does not show it.
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
- `field_edits` on `beans`, `bean_batches`, `grinders` and `profiles`: the
  latest edit of each field of the item's content, `{ at, decidedAt,
  tabletId, versionId }`: when it was made, never earlier than the edit
  before it; when it was decided, by PostgreSQL's clock, after every edit of
  the item decided before it; the tablet that made it, if one did; and its
  version.
- `item_versions`: each accepted edit of an item (ADR-0020), with the fields
  it set and their values, the Machine and tablet or the account it came
  from, when it was made (`edited_at`, timed as the edit was) and when the
  server took it in (`received_at`, by PostgreSQL's clock). An edit of the
  item's content has no Location; one of a Location's state of it names that
  Location, and only those fields: `atLocation` and `remainingWeight` for a
  batch, `shown` for a Profile. Joining the Library is an item's first
  version. Each names exactly one item, and goes with it. Versions taken in
  together keep the order they were taken in (`seq`), and so do Conflicts.
- `location_settings` and `tablet_settings`: each Location's steam, hot water
  and rinse settings, and each tablet's as it last had them
  (Steam, hot water and rinse settings, below).
- `deleted_items` and `tablet_deletions`: the global id of each item an
  Admin hard-deleted, and each tablet's records of it still to be deleted
  there, by their ids there, a Profile's by Decaid's id, with its steps,
  and never in `deleted_items` (Hard deletes, below).
- `tablet_reports`, `workflow_clears` and `tablet_left_out`: where each
  of a tablet's reports was last taken in, and when its Machine's sharing
  had last been turned back on then, the Workflow grinder and batch still
  to be cleared on a joining tablet, and each record a joining tablet held
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
  the field), where it came from and when it was made, as a version keeps
  them, its Location for a Location's state, when it became a Conflict, and
  whether it is open, its value used or dismissed (Resolving Conflicts,
  below).

## Edits

An edit of a Library item's content on any tablet reaches every tablet that
holds the item, at every Location, merged per field with the latest edit
winning (ADR-0020; `content-edits.ts`, with the pure merge in `merge.ts`). An
item's content is a Bean's, a Bean Batch's or a Grinder's record fields, but
those of the tablet's record (its ids, times and `extras`) and of each
Location's (a batch's `archived` and `weightRemaining`; a Bean's `archived`,
which takes it away from the tablet's Location), whether a Grinder is
Archived, and a Profile's title, author and notes, which are outside its id
(ADR-0006). Decaid refuses to change a bundled Profile's, so a bundled
Profile's are never edits, and never written.

- **What an edit is.** A record the tablet's map holds that it reports anew,
  or that Decaid returned for one of the server's writes, is compared with
  the record known, the version that tablet last had: each field of its
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
  edit that arrives later cannot undo it. Each edit that decides a field is
  kept as a version, with the fields it decided. A Bean whose roaster or name
  is edited keeps its match key to them, so another Bean of the same roaster
  and name lists it as a likely duplicate; they are not merged (ADR-0018).
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
  with versions and Conflicts as content's are.

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
Location, its remaining weight there, a Profile shown there), its steam, hot
water and rinse settings, and a Grinder's other content only at their own
Locations, as a Grinder belongs to one (`conflicts.service.ts`). Each is decided under the Conflict's row lock, on
any instance, so it is used or dismissed once; a tablet's report never locks
a Conflict, so neither waits on the other in turn.

- **Using its value** makes it the field's latest edit, a version from the
  account, timed by PostgreSQL's clock (ADR-0016), as its `received_at` is.
  The request names the version that set the field's value now as the
  Conflict showed it (`seen`), and the value is used only while that version
  still set it, read under the locks below: an edit decided since, as by a
  tablet that had seen the value now, which then made no Conflict, is
  refused with 409 rather than replaced unseen (ADR-0020), and the account
  looks again. So the account chose it over the field's value now, and the
  edit decides the field whatever the times of the edits before it, and
  keeps nothing it replaces as a Conflict: it is no edit made without seeing
  another. An edit of the item's content is merged under the item's
  row lock, after its Location's lock for a Grinder, whose Archived state
  changes only under it, as a tablet's is (`editContent`, with `seenAt`
  `everything`); one of a Location's state, under the Location's lock, as
  having seen every decision made there before it (`addBatchAt`,
  `finishBatchAt`, `enterRemainingWeight`, `showProfileAt`). It commits with a
  `NOTIFY` on `library_changes`, so every tablet that holds the item, at every
  Location, is written it; a tablet's edit made before it that arrives later,
  as from one that was offline, loses to it and is kept as a Conflict. A
  setting's is merged under the settings' row lock (`editSettings`).
- **Dismissing it** closes it with nothing else changed: no version, and
  nothing written.

## Editing in the management interface

Admins and Staff create and edit Beans, Bean Batches and Grinders in the
management interface, Archive and restore them and Profiles, add and finish
batches at Locations, setting their remaining weight at each, and show and
hide Profiles at Locations (`library-edits.service.ts`). Each change is an edit by the account, timed by
PostgreSQL's clock (ADR-0016), and made over the item as it stands, as using
a Conflict's value is (Resolving Conflicts, above): it decides each field it
sets whatever the times of the edits before it, and keeps nothing it
replaces as a Conflict, while a tablet's edit made before it that arrives
later loses to it, and is kept as one. Each is a version from the account,
and commits with a `NOTIFY` on `library_changes`, so every tablet that holds
the item, or whose Location offers it now, is written it (Writing to
tablets, below).

- **Content.** A Bean's, a batch's or a Grinder's fields are Decaid's, each of
  the type Decaid takes, so no tablet refuses a write of them
  (`item-input.ts`): an empty value clears a field, but a Bean's roaster and
  name, a Grinder's model and a Bean's `decaf` and a batch's `frozen` flags,
  which Decaid refuses to clear. A date is entered as a day and kept as
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
  Location's lock, as a tablet's are.
- **Profiles.** A Profile is shown or hidden at each Location, as an edit of
  that Location's state of it (`showProfileAt`), under the Location's lock,
  as having seen every decision made there before it, which is how a lab
  Profile reaches a cafe: showing it there writes it to the cafe's tablets,
  visible, and hiding it there hides it on them, and on no other Location's.
  A Profile is never created or edited here: Decaid computes its id from what
  the machine executes, so Profiles join the Library from tablets, and their
  title, author and notes are edited there.
- **Archive and restore.** An Archived Bean or batch is offered nowhere, with
  the Bean's batches, and is archived on every tablet that holds it, but kept,
  with each Location's state of it, so restoring it offers it again where it
  was. A Bean is Archived or restored under the lock new beans are matched
  under, so a tablet never links a new bean to a Bean Archived at once. Each
  is a version of the item (`archived`). A Grinder's Archived state is a field
  of its content, merged as a tablet's archiving is. An Archived Profile is
  shown nowhere and hidden on every tablet that holds it, but keeps each
  Location's state of it, which can still be changed, so restoring it shows
  it again where it is shown.
- **Who.** An Admin does everything. Staff edit the Library's shared content
  anywhere (a Bean, a batch's details) and Archive and restore items, but add
  and finish batches, set their remaining weight, create and edit Grinders,
  and show and hide Profiles only at the Locations they work at, as a Grinder
  belongs to one (ADR-0008), and never hard-delete.

### Hard deletes

An Admin hard-deletes a Bean, Bean Batch, Grinder or Profile no Shot names
(ADR-0003, `hard-deletes.ts`): it is gone from the Library at once, with its
versions, Conflicts and each Location's state of it, and from every tablet
that holds it, the one thing the server deletes from tablets. A Bean goes
with its batches, as Decaid refuses to delete a bean that has any. Decaid's
bundled Profiles are never deleted (409): every tablet has them, and Decaid
refuses to delete one; they are hidden at Locations or Archived instead.

- **Named by a Shot.** A Shot names its batch and Grinder by their ids on the
  tablet that pulled it (`shots.bean_batch_id` and `shots.grinder_id`, from
  its Workflow's context). An item whose record has such an id on any
  tablet's map is named, and a Bean is named when one of its batches is: its
  delete is refused, and it can be Archived instead. A record a tablet
  deleted itself has left its map, so a Shot naming only that record does not
  count. A Shot names a Profile whose steps its Workflow's `profile` has,
  compared as JSON so a whole double Decaid writes as `92.0` equals 92, or
  by the profile id a skin recorded in its Workflow (`shots.profile_id`);
  Decaid itself records none. Only the steps are compared, not the rest of
  what Decaid hashes for a Profile's id: a skin sets the Workflow's
  profile's target weight to the Shot's yield, so a Shot pulled with a
  Profile can hold other targets, and refusing a delete is the safe side.
  A Shot the server takes in after the delete, as one an offline
  tablet pulled, that names a record still to be deleted keeps that record
  on its tablet, out of the Library, and so does the record of that batch's
  Bean there, which the plugin would delete with its batches. The plugin
  also refuses to delete a record a Shot it queued since it loaded, or has
  yet to read and send, names, as the server may have planned the delete
  before it had that Shot; the server keeps the record once it has it. It
  reads at most 20 Shots still to be read for this, and refuses any delete
  while more are, as during a backfill (`SHOTS_STILL_TO_READ`): the
  writer then leaves that delete out for two heartbeat intervals and asks
  again on the same connection, until the Shots have been sent. A
  Shot the plugin finds only later, from its index once it has reloaded, can
  come too late to keep it.
- **Tablets.** Each tablet's record of the item, read from its map, is kept
  as a delete due there (`tablet_deletions`), and the item's global id is
  kept (`deleted_items`). Each tablet's writer deletes its records, a bean's
  batches before the bean, ahead of any write but the shared settings, now
  or once the tablet connects again. Its next report no longer lists the
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
   Library, created at the tablet's Location, its content its first version.
   Either way, unless it is archived on the tablet, the Bean is offered at the
   tablet's Location, as an origin, while none of its batches is there.

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
the shared settings. After them, before the writes above, each record a
joining tablet held that the Library leaves out and that is not set aside
there yet is archived or hidden (`leaveOut`; Joining a Location, below),
batches first, then beans, grinders and profiles.

It writes nothing until that connection's reports of the tablet's beans, bean
batches, grinders and profiles, which the plugin sends on every welcome, have
been taken in, nor between a report of its beans and the report of its batches the plugin
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
its connections, on any instance. A move an instance missed while not
listening is found when it listens again, as every writer then looks.

One write is outstanding per connection, and only the connection holding a
Machine writes, so a tablet is written one item at a time. The server sends a
`write`, in chunks if it is too large for one frame (`AI_PROTOCOL_NOTES.md`),
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
look since, which writing again would not change, skips that item while the
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
beans, bean batches, grinders and profiles), never during one
(`LibraryAccess`), and
queues each answer in its outbox, behind
every report read before the write. So the server takes in each report read
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

Decaid v0.8.7 refuses to delete a bean that still has batches, archived ones
included, failing SQLite's foreign key with 500 and deleting nothing
(`server/test/fixtures/decaid/bean-batch-writes-v0.8.7/`). A barista deletes
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
- **The changes refused:** each write, delete or leave-out the tablet
  refused while its connection awaited the answer, with Decaid's HTTP
  status and what it answered, the latest refusal of each item or record
  kept (`tablet_refusals`). The status is null where there is none: Decaid
  did not answer, or the plugin did not ask it, as for a delete a Shot it
  has yet to send names. A write the writer skips for another reason is
  kept the same way, with no status and why, so nothing waits unexplained:
  one answered with a record that is not the item's or that the server
  cannot store, and one still due as it was once written, which writing
  again would not change. A write the plugin does not answer within 300 s
  is skipped too, but not kept, and counts as waiting. One is forgotten
  once a change of the same item or record is carried out there, and as
  the tablet's writer finds it no longer due (`pruneRefusals`), as when the
  item stopped being offered; until then, one no longer due is not shown.

Everything is in PostgreSQL, so every instance reads the same, whichever
holds the tablet's connection.

## Steam, hot water and rinse settings

A Machine's Workflow stays its own, but for its steam, hot water and rinse
settings, which the Machines at a Location share whatever their model, DE1s
and Bengles alike, the way every steam wand on one commercial machine runs
the same settings (ADR-0014; `location-settings.ts`, with the pure
`settings-intake.ts`). Who takes part is as for the Library (Who takes part,
above), but for a Machine whose sharing of them is turned off (below).

The settings are the eleven fields `SHARED_SETTINGS` names (`protocol/`), each
by its part of the Workflow and Decaid's name for it there, such as
`steamSettings.flow`: steam's target temperature, time, flow and the milk
temperature it stops at, hot water's target temperature, time, volume and
flow, and rinse's target temperature, time and flow. Each is a field of its
own, merged as a Library item's content is (Edits, above; ADR-0020), with
versions and Conflicts at the Location. A field Decaid may add to a part
later is not shared.

- `location_settings`: each Location's settings, each set by its name, and each setting's latest edit (`field_edits`), as an item's
  content keeps them. The settings' row lock decides their edits, on any
  instance, taken after the reporting Machine's and its tablet's.
- `tablet_settings`: each tablet's settings as it last had them, reported in
  its Workflow or as Decaid returned the plugin's write of them, of its
  Machine's Location's settings then, with the latest edit of them they have
  seen (`content_seen_at`), as `content_seen_at` keeps an item's. A tablet
  joining a Location, as when its Machine moved there, or it moved to a
  Machine there, has had none of its settings yet, whatever it had there
  before (Joining a Location, below).
- `machines.shares_settings`: whether a Machine's tablet shares its
  Location's settings, on unless an account switched it off, and
  `shares_settings_since`, when one last switched it on.

Tablets' edits arrive in the Workflow the plugin sends on every change and on
every welcome (`WORKFLOW-AND-STATE.md`), which the server takes in in the
transaction storing it (`takeInWorkflow`), timed by when the plugin observed
it:

- **The first Machine** at a Location to report its Workflow sets the
  Location's settings: a setting nobody has set is set by the first report
  holding it. So a Machine joining a Location with no settings yet brings
  its own. A tablet new to the settings, as a new tablet, or one joining the
  Location, sets only those; the Location's state wins (ADR-0008), and is
  written to it.
- **Edits.** Otherwise each setting that differs from what the tablet last
  had is its edit, merged per field: so a change on any tablet reaches the
  Location's other Machines, and only those.
- **Steam off.** Decaid has no steam on/off flag: a steam target temperature
  below 135 °C means off (`STEAM_ON_FROM`). Turning steam off on one Machine,
  for espresso only or descaling, is not shared, and while it is off none of
  its steam settings are, either way: its changes to them are not edits, and
  the Location's are not written to it, so they never turn its steam back
  on. Its hot water and rinse settings are still shared. Once its steam is
  turned on again, at whatever temperature, it takes the Location's steam
  settings rather than giving its own, which are then written to it, but for
  any the Location has not set yet, which it sets. A Machine whose steam was
  off when it set its Location's settings set none of the steam ones, which
  the first Machine there with steam on sets.
- **Sharing turned off.** A Machine whose sharing of them is turned off in
  the management interface keeps its own settings: none of its changes are
  edits, and none are written to it. Its tablet's settings are still kept as
  it reports them, so once its sharing is turned back on, its changes count
  from then on, and it takes the Location's settings, which are written to
  it, as when its steam is turned back on. A change its tablet observed
  before its sharing was turned back on, by PostgreSQL's clock
  (`shares_settings_since`), stays its own though delivered after, as from a
  tablet that was offline meanwhile or whose outbox held it, and the tablet
  is then written the Location's settings. Turning sharing on or off, under
  the Machine's row lock, which taking in its Workflow holds too, commits
  with a `NOTIFY` on `library_changes`.
- **The plugin's own writes** are not edits (ADR-0003): the answer to a
  write is recorded as the tablet's settings, and the plugin sends the
  Workflow change its write causes only after the answer (below).

Each welcomed connection's writer (Writing to tablets, above) writes the
tablet its Machine's Location's settings where its Workflow holds others,
before any Library item: each setting the Location has set, but its steam
settings while its steam is off. None is written before the tablet has
reported its Workflow there, as the server does not know what it holds, nor
to a Machine whose sharing of them is turned off. The write is a `write` of
the `settings` kind, named by the settings' id, its fields and the values it
expects the Workflow to hold named as `SHARED_SETTINGS` names them.

The plugin reads the tablet's Workflow (`GET /workflow`), then sets the
settings it still holds as the server expects through `PUT /workflow`,
which Decaid deep-merges into the Workflow and writes to the machine, the
steam settings only while the Workflow keeps steam on: a barista may have
turned it off since the tablet last reported, and the server, not knowing
yet, sent them. Its
answer, `written`, is the Workflow's steam, hot water and rinse parts as
Decaid returned them, timed by the plugin's clock, as a Workflow carries no
time. Decaid sends the plugin the Workflow its write changed
(`workflowUpdated`) as it sets it, before it answers the write, so the
plugin holds that change back until the answer is queued in its outbox, then
sends the latest Workflow (`MachineEvents.hold` and `release`): the server
records the answer first, and finds nothing changed in the Workflow after
it. A barista's change made meanwhile is in that Workflow, and is the
tablet's edit. The answer is recorded as an item's is, under the Machine's,
the tablet's and the settings' locks: a setting the write did not set that
differs from what the tablet last had is the tablet's edit, timed by the
answer, and the settings have seen the edits the write carried unless such
an edit lost (`recordSettingsWritten`).

Decaid refuses (500, `DeviceNotConnectedException`) to change steam, hot
water or rinse settings while no machine is connected to the tablet, as the
change goes to the machine: the write is refused, and skipped until what is
due changes or the tablet reconnects, as any refused write is. A tablet often connects before
its machine, and its plugin reconnects once the machine reports its
hardware. One whose machine goes away, as when it is powered off for the
night while its tablet stays connected, is seen gone by the plugin's next
read of its hardware, or by such a refusal; once the same machine is back,
the plugin reconnects too. Either way the tablet is written the settings
then. Decaid answers a change of `stopAtTemperature` alone without a
machine, as it is not written to it.

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
  Profiles, the batches at it and their Beans, and its Grinders, and what it
  does not offer is archived or hidden on the tablet, never deleted. The
  Workflow taken in as the tablet joins has had none of the Location's
  steam, hot water and rinse settings, so it sets only those the Location
  has not set yet, and is written the others, unless the Machine's sharing
  of them is turned off (Steam, hot water and rinse settings, below).
- **Its Workflow's grinder and batch.** The Workflow taken in as the tablet
  joins is judged against the tablet's map, which still holds what the
  tablet held before (`takeInWorkflowContext`), under the Location's lock:
  the Grinder its `context.grinderId` names there is cleared if the
  Location does not offer it, as one belonging to another Location or
  Archived, and so is the batch its `context.beanBatchId` names if it is not
  at the Location, or is Archived, or its Bean is. Cleared are
  `grinderId` and `grinderModel`, and `beanBatchId`, `coffeeName` and
  `coffeeRoaster`, as Decaid's `clearGrinder` and `clearBeanBatch` clear
  them (`WORKFLOW_GRINDER`, `WORKFLOW_BATCH` in `protocol/`); the profile,
  dose, yield and grinder setting stay. A grinder or batch the map does not
  hold, one of the tablet's own, is cleared if the Library leaves it out,
  or will, as the Location offers Grinders, or batches or Beans, already
  (What it holds of its own, below); otherwise it joins the Library at
  the Location with its reports there, and stays. The Workflow is judged
  before the lists are taken in, so a batch whose bean is then linked to
  one of the Location's, and that joins the Library as the Location offers
  no batch yet, is cleared all the same. The clear is kept (`workflow_clears`) and
  written whether or not the Machine shares the settings, as a `write` of
  the `workflow` kind, after the settings and before anything else: the
  plugin clears the grinder, and the batch, each whole, only while the
  Workflow still names it by the id the tablet reported, so one a skin
  relabelled is still cleared, and a Workflow naming another since,
  reported or in the write's answer, drops that part of the clear
  (`clearStillDue`), which otherwise expects what the Workflow holds now.
  It is due only as the tablet joins: a batch finished at the Location
  later leaves the Workflow as it is (ADR-0014). A clear the plugin is
  carrying out as its Machine moves back, within one write, to a Location
  that offers the grinder or batch is not called back: the Workflow's next
  join there finds it cleared already.
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
    Machine joins it, takes the joining tablet's own items of that kind,
    as a Location with no settings yet takes its settings: its Beans if
    it offers no Bean, its batches if no batch, its Grinders if no
    Grinder, and its Profiles if it shows no user's Profile. They join
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
  `parent`, `{ id, title }` of the Profile it was saved from if the
  Library has it, or null; and `locations`, each Location that has decided
  whether it shows it, by name, `{ location, shown, since }`, kept while it
  is Archived; or 404. A Location not listed does not show it. The id goes in
  the path as it is or percent-encoded.
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
- `PUT /api/profiles/:id/locations/:locationId`, with `{ shown }`, shows the
  Profile at the Location or hides it there; `PUT /api/profiles/:id/archived`,
  with `{ archived }`, Archives or restores it. Each returns `{ profile }`;
  400 without a boolean, 404 for no such Profile or Location, and 403 for
  Staff showing or hiding one at a Location they do not work at. They
  Archive and restore any.
- `DELETE /api/beans/:id`, `DELETE /api/bean-batches/:id`, `DELETE
  /api/grinders/:id` and `DELETE /api/profiles/:id` hard-delete one, a Bean
  with its batches, and answer 204: Admins only. 409 if a Shot names it, or
  one of a Bean's batches, or it is one of Decaid's bundled Profiles.
- `GET /api/beans/:id/history`, `GET /api/bean-batches/:id/history`,
  `GET /api/grinders/:id/history` and `GET /api/profiles/:id/history` return
  `{ versions }`, the item's versions (ADR-0020), the latest taken in first,
  each `{ id, fields, location, source, editedAt, receivedAt }`: the fields
  it set, with their values, of the item's content, or of its state at
  `location` (`atLocation`, `remainingWeight`, `shown`), null for its
  content; where it came from, `source`, `{ machine, tabletId, account }`,
  the Machine `{ id, name }` whose tablet made it, if one did and it still
  exists, that tablet's id, and the account `{ id, name }` that made it in
  the management interface, its name null to Staff, as other accounts' names
  are personal information Staff do not see; when it was made, a tablet's by its
  record's `updatedAt` in UTC, a delete on a tablet when the server learned
  of it; and when the server took it in, by PostgreSQL's clock. The first is
  the item joining the Library. 404 if the Library does not have the item.
- `GET /api/conflicts` returns `{ conflicts }`, the open Conflicts, the
  latest first, each `{ id, item, field, value, location, source, editedAt,
  createdAt, state, current, resolvable }`: the item `{ kind, id, name }`,
  `kind` being `bean`, `beanBatch`, `grinder` or `profile`, and `name` a
  Bean's roaster and name, a batch's Bean and the day it was roasted, as
  `Guji, roasted 2026-10-01`, a Grinder's model or
  a Profile's title, null where its content has none; or, of `kind`
  `settings`, a Location's steam, hot water and rinse settings, named
  `Steam, hot water and rinse`, whose Location `location` names; the field and the
  losing value, null where the edit cleared it; the Location whose state the
  field is, null for content; where and when the losing edit was made, as a
  version's; when it became a Conflict; `open`, `used` or `dismissed`; the
  field's value now, `{ value, source, editedAt, versionId }`, with where
  and when the edit that set it was made, and its version, each null if that
  is not known, as for a field
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
  is not a version's id or null, 404 if there is no such Conflict, 403 if the
  account may not resolve it, and 409 if it was used or dismissed already, or
  the field was decided since the version `seen`.
- `GET /api/locations/:id/settings` returns `{ settings }`, the Location's
  steam, hot water and rinse settings, `{ id, values, machines, editable }`:
  their id, null while no Machine there sharing them has reported its
  Workflow, so none is set; each
  setting by its name, such as `steamSettings.flow`, null while unset; the
  Location's Machines now, each `{ id, name, model, sharesSettings, sharing
  }`, by name, `model` its hardware's, or an Unidentified Machine's reported
  one, null while neither is known, and `sharing` false while it is
  capture-only, when it shares no settings whatever `sharesSettings` says; and whether the signed-in account may change
  them and switch its Machines, an Admin, or Staff working there. 404 for no
  such Location.
- `PATCH /api/location-settings/:id`, with `{ values }`, some of the
  settings by name, changes them, an edit by the account timed by
  PostgreSQL's clock and made over the settings as they stand, written to
  the Location's Machines that share them; returns `{ settings }`. Each value is
  a number of 0 or more, a whole one where Decaid keeps a whole number (each
  target temperature, time and the hot water volume), and a steam target
  temperature of 135 °C or more, as turning steam off is each Machine's own:
  400 otherwise. 404 if there are no such settings, 403 for Staff at another
  Location.
- `GET /api/location-settings/:id/history` and `GET
  /api/location-settings/:id/conflicts` return their `{ versions }` and open
  `{ conflicts }`, as an item's do, each version naming their Location; the
  first is the first Machine there setting them.
- `PUT /api/machines/:id/sharing`, with `{ sharing }`, turns the Machine's
  sharing on or off, off making it a Capture-only Machine, and returns the
  same: Admins only. 400 without a boolean, 404 for no such Machine.
  `GET /api/machines/:id` and `GET /api/machines` give each Machine's
  `sharing`, and `captureOnly`, why it is a Capture-only Machine:
  `noLocation`, `sharingOff` or both, none while it takes part.
- `GET /api/machines/:id/sharing-status` returns `{ status }`, the
  Machine's sharing status (above): `{ tabletId, waiting, lastApplied,
  refused }`. `tabletId` is the tablet it is read for, or null if none has
  connected. `waiting` is how many changes that tablet is
  due and has not refused, or null while it is written nothing, as the
  Machine is capture-only or no tablet has connected. `lastApplied` is the
  last change it applied, or null, and `refused` the changes it refused that
  are still due, the latest refused first (Sharing status, above), each `{ change, kind, item,
  localId }`: `change` is `write`, `delete` or `leaveOut`; `kind` a Library
  kind, `settings` or `workflow`; `item` the item, `{ kind, id, name }`,
  named as a Conflict's is, or for the Workflow "Grinder and batch", null
  for a record set aside, which is none of the Library's, or an item
  deleted since; and `localId` Decaid's id for the record, null for a
  create, the settings and the Workflow. `lastApplied` adds `appliedAt`,
  and each refusal `status`, Decaid's HTTP status or null if it gave none,
  `error`, what it answered or why, and `refusedAt`. 404 for no such
  Machine.
- `PUT /api/machines/:id/settings-sharing`, with `{ sharesSettings }`,
  switches whether the Machine shares its Location's settings, and returns
  the same. 400 without a boolean, 404 for no such Machine, 403 for Staff
  unless it is at one of their Locations.

The management interface's Library section lists the Beans and where each is
offered, the Bean Batches, the Locations each is at and its remaining weight
at each, the Grinders and the Location each belongs to, and the Profiles and
where each is shown. Each Bean's page shows its content, where it is
offered, its batches and its likely duplicates, each batch's page its roast,
the Locations it is at with its remaining weight at each, and where it was
finished, each Grinder's page its Location and what it is, and each
Profile's page where it is shown, its steps and the Profile it was saved
from. Each item's page notes its open Conflicts, if it has any, and shows its
history, and the Library's Conflicts page lists every open Conflict, the
latest first, with the losing value and the value now, and where and when
each came from. A Conflict is used or dismissed from either, by an account
that may (`web/src/components/conflicts.tsx`). Each Location's page
(`/locations/:id`) shows its steam, hot water and rinse settings, which an
Admin, or Staff working there, changes, with their Conflicts and history,
and its Machines, each with a switch for sharing them, a capture-only one
flagged (`web/src/components/location-settings.tsx`). A Machine's page says whether
it shares the Library at its Location or is capture-only, and why, with a
switch an Admin turns its sharing off and on with, once they confirm, and
its sharing status, loaded as often as its own status: the changes waiting
for its tablet, the last it applied, and those it refused, with Decaid's
answer (`web/src/components/machine-sharing.tsx`). The Beans, Bean Batches and
Grinders lists create them, and each item's page edits it, Archives or
restores it, and, for an Admin, deletes it; a batch's page adds it at each
Location and finishes it there, and sets its remaining weight there
(`web/src/components/library-forms.tsx`). A Bean refused as one the Library
has links to that Bean. Each Profile's page lists every Location, each with
a switch that shows or hides the Profile there, for an Admin or Staff
working there (`ProfileLocationsCard` in `web/src/components/profiles.tsx`),
and Archives or restores it, and, for an Admin, deletes one not bundled
with Decaid.

## Not yet

- Linking Shots to the Library's batches and Grinders: ticket #92.

Decaid hides a bundled Profile a release no longer bundles, or bundles anew
under another id (`_retireStaleDefaults` in
`decaid:lib/src/controllers/profile_controller.dart`). So once tablets at one
Location run Decaid releases that bundle different Profiles, the first to
upgrade hides the old one at the Location, on the others too, which lack the
new one: bundled Profiles are never written. v0.8.7 and v0.8.8 bundle the same
Profiles.

`server/test/library-beans.test.ts`, `server/test/library-batches.test.ts`,
`server/test/library-grinders.test.ts`,
`server/test/library-profiles.test.ts`,
`server/test/library-edits.test.ts`,
`server/test/library-conflicts.test.ts`,
`server/test/library-management.test.ts`,
`server/test/library-profile-management.test.ts`,
`server/test/location-settings.test.ts`, `server/test/joining.test.ts` and
`server/test/capture-only.test.ts` and `server/test/sharing-status.test.ts`
cover this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL;
`server/test/bean-intake.test.ts`, `server/test/batch-intake.test.ts`,
`server/test/grinder-intake.test.ts`, `server/test/profile-intake.test.ts`,
`server/test/holdings.test.ts`, `server/test/merge.test.ts`,
`server/test/settings-intake.test.ts` and `server/test/join-plan.test.ts`
the pure modules;
`server/test/simulated-bean-writes.test.ts`,
`server/test/simulated-batch-writes.test.ts`,
`server/test/simulated-grinder-writes.test.ts`,
`server/test/simulated-profile-writes.test.ts` and
`server/test/simulated-workflow-writes.test.ts` the simulated tablet's writes
against those recorded on Decaid's Linux release
(`server/test/fixtures/decaid/bean-writes-v0.8.7/`,
`bean-batch-writes-v0.8.7/`, `grinder-writes-v0.8.7/`,
`profile-writes-v0.8.7/` and `workflow-writes-v0.8.7/`); and
`e2e/library.spec.ts`, `e2e/library-management.spec.ts`,
`e2e/profile-management.spec.ts`, `e2e/conflicts.spec.ts`,
`e2e/location-settings.spec.ts`, `e2e/capture-only.spec.ts` and
`e2e/sharing-status.spec.ts` the management interface.
