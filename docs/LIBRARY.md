# The Library

Ticket [#80](https://github.com/loganfuller/decent-sync/issues/80) starts
milestone 2's Library ([#77](https://github.com/loganfuller/decent-sync/issues/77))
with Beans: a Bean entered on a tablet joins the Library and is written to the
other tablets at that tablet's Location. Ticket
[#81](https://github.com/loganfuller/decent-sync/issues/81) adds Bean Batches,
each at the Locations it was added to and not yet finished at, with its
remaining weight at each, and offers each Bean where its batches are. Ticket
[#82](https://github.com/loganfuller/decent-sync/issues/82) adds Profiles,
each shown or hidden at each Location. It follows ADR-0003, ADR-0006,
ADR-0008, ADR-0016, ADR-0018, ADR-0019 and ADR-0020. Grinders, edits,
joining a Location and the management interface's changes build on it in
later tickets (Not yet, below).

## Who takes part

A Machine takes part while it is at a Location: the Location of the latest
entry of its Location History. A Machine with no Location is capture-only: its
tablet's beans, bean batches and profiles are captured as collections
(`COLLECTIONS.md`), but not taken into the Library, and nothing is written to
it. A mismatched connection, whose tablet is not its token's Machine's, takes
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
- a **Profile** while it is shown there, unless it is Archived. A Profile is
  shown only where a tablet created it, or held it visible when nothing had
  decided it there yet, until it is hidden there or shown elsewhere; Decaid's
  bundled Profiles too (Taking in a tablet's profiles, below).

So a Bean with batches is offered only where they are: once its last batch
at a Location is finished, it is no longer offered there. Archived items,
which only the management interface will Archive (tickets #87 and #88), are offered
nowhere. What the Location offers is written to each of its tablets, with each
batch's remaining weight there and each Profile visible, and what it does not
offer is archived or hidden on them, never deleted, so their Shots still find
it (Writing to tablets, below).

## Storage

`server/src/library/`, in PostgreSQL:

- `beans`: each Bean, by its global id (ADR-0006), with its content, Decaid's
  record fields as the tablet that created it sent them, those the server
  does not know included, but the record's id, times, `archived` and
  `extras`, which belong to each tablet's record. Also its match key (below),
  whether it is Archived, the Location of the tablet that created it, and
  when it joined the Library, by PostgreSQL's clock.
- `bean_origins`: the Locations offering a Bean that has no batch there yet:
  where a tablet created it, linked a bean of its own to it, or un-archived
  its record, while none of its batches was there. A batch of it added there
  ends its origin there, and so does archiving or deleting it on a tablet
  there. Origins change only under the Location's lock (`location-state.ts`),
  which keeps them to Beans with no batch at the Location.
- `bean_batches`: each Bean Batch, by its global id, with its Bean, its
  content, Decaid's record fields as the tablet that created it sent them,
  but its id, its bean's id there, its times and `extras`, which are that
  record's, and `archived` and `weightRemaining`, which are each
  Location's. Also whether it is Archived, the Location of the tablet that
  created it, and when it joined the Library.
- `batch_locations`: each batch's state at a Location, each part a field of
  its own (ADR-0020): when it was last added there and when it was finished
  there since, if it was, and the remaining weight entered there last, in
  grams, with that edit's time. A batch is at a Location while it was added
  there and not finished since. Whether it is there is a field whose latest
  edit wins (ADR-0020), with when that was last decided by PostgreSQL's clock.
  An edit from a tablet whose record of the batch had seen that decision
  (`seen_at`, below), or, archiving or deleting its Bean, whose record of the
  Bean had, applies, if that was at this Location. Otherwise, as from a tablet
  that was offline, adding it there loses to a finish timed later, and
  finishing it there to an add timed later; the Location's state is then
  written back to that tablet. One that applies is the field's latest edit
  even when it leaves the batch where it was: it is added or finished there
  again, so an earlier edit that arrives later cannot undo it. It is never
  finished before it was added, nor added again before it was finished,
  whatever the clock that timed the edit. Times are each edit's: a tablet's by
  the record's `updatedAt` in UTC; a delete, which Decaid does not time, by
  PostgreSQL's clock, but never earlier than the record the tablet was last
  known to have.
- `profiles`: each Profile, by Decaid's id (ADR-0006), with its content,
  Decaid's record fields as the tablet that created it sent them, but its id,
  times and `visibility`, which are that record's or each Location's. Also
  whether it is one of Decaid's bundled Profiles (`isDefault`), whether it is
  Archived, the Location of the tablet that created it, and when it joined
  the Library.
- `profile_locations`: whether each Profile is shown at a Location, a field of
  its own (ADR-0020), with the time of the edit that decided it, never earlier
  than the one before: a tablet's by its record's `updatedAt` in UTC; a
  delete, which Decaid does not time, by PostgreSQL's clock, but never earlier
  than the record the tablet was last known to have. And when it was decided,
  by PostgreSQL's clock, as again by an edit that applied but left it shown or
  hidden as it was. A Location with no row for a Profile has decided nothing
  of it, and does not show it.
- `tablet_beans`, `tablet_bean_batches` and `tablet_profiles`: the map, per
  tablet id (ticket #79): each item's local id on that tablet, which is a
  Profile's own, and the record as the tablet last had it, as it reported it
  or as Decaid returned the plugin's write, with that record's `updatedAt`
  placed in UTC by the plugin, and the Location's latest decision that the
  record has seen (`seen_at`, its time by PostgreSQL's clock) of the batch's
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
  seen before. A reset tablet has a new tablet id, so it starts with nothing
  here.

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
   there.
2. Otherwise a record carrying a Library Bean's global id is that Bean, as on
   a tablet whose answer to a write was lost, or one restored from a Decaid
   backup, unless another record the tablet reports is that Bean already: it
   is then matched as a new record. Such a record changes nothing at the
   Location; the Location's state is written to it, over any change the
   tablet made to it before it was mapped, as when the plugin reloaded
   between a write whose answer was lost and a barista's edit, so no outbox
   held the answer any more.

Records whose Bean these settle come first, so a record matched by roaster
and name, though listed before them, cannot take their Bean. Then, in the
order reported:

3. Any other record is new. It is linked to the oldest Library Bean, not
   Archived, whose roaster and name match its own, ignoring case and white
   space at either end (`beanMatchKey`), unless one of the tablet's other
   records already is that Bean. Otherwise it joins the Library, created at
   the tablet's Location. Either way, unless it is archived on the tablet, the
   Bean is offered at the tablet's Location, as an origin, while none of its
   batches is there.

Last:

4. A record the map holds whose id the list no longer holds, readable or
   not, was deleted on the tablet, unless another record it reports is that
   Bean now. The Bean is taken away from the tablet's Location as for one
   archived, and the map holds the record no more. A new or reset tablet's
   map holds nothing, so its report deletes nothing (ADR-0019).

A record carrying a global id the Library does not know is new, and gets the
new Bean's id. Beans are matched only when a tablet first reports them
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
  Conflicts come with ticket #84.
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
  its `visibility` and an `updatedAt` the plugin could place) is ignored.
- A record the map holds replaces the one known when it is newer, or as old
  but of another visibility. Made visible since, the Profile is shown at the
  tablet's Location; hidden or deleted since, it is hidden there (ADR-0019).
  Only a Profile the tablet held can be hidden this way. Each is an edit timed
  by the record. One from a tablet whose record had seen the Location's last
  decision of the Profile (`seen_at`, above) applies. Otherwise, as from a
  tablet that was offline, one timed before the edit that decided the
  Location's state loses to it (ADR-0020), and the Location's state is written
  back to that tablet. One that applies decides it again even when it leaves
  it shown or hidden as it was, so an earlier edit that arrives later cannot
  undo it. Conflicts, which will keep the losing edit, come with ticket #84.
- Any other record is one the map does not hold yet: the tablet created it,
  held it before it joined the Location, or was written it by a write whose
  answer was lost. If the Library has its id, it is that Profile; otherwise it
  joins the Library, created at the tablet's Location. Where the Location has
  decided nothing of the Profile yet, the record's visibility decides it, so a
  Profile new to the Library is shown where it was created only, and an
  identical Profile created at two Locations is shown at both. Otherwise the
  Location's state stands, and is written to the tablet: a new tablet's
  bundled Profiles do not show those its Location hid. But a user's Profile
  the tablet made visible after both it joined the Location and the Location
  last decided the Profile, by their times, is an edit made there, and shows
  it, as when a
  barista changes a Profile's steps back, which Decaid's `PUT` makes a record
  under the old id again, or re-creates one purged. A tablet joined its
  Location at the later of when its Machine arrived there, by its Location
  History, and when the tablet first connected as that Machine. Decaid's
  bundled Profiles join the Library like any other, so whether each is shown
  is per Location.
- A bundled Profile the map holds that the tablet's Location has decided
  nothing of, as after its Machine moved there, is decided by its record, as
  on a first report there. A user's Profile the map holds stays as the
  Location has it: hidden there, as it belonged to the Location the tablet
  held it at (ADR-0008), until it is shown there.
- A record the map holds whose id the list no longer holds, as when Decaid
  replaced it or a purge removed it, is gone: if the tablet held it visible,
  it is hidden at its Location, and the map holds it no more. A new or reset
  tablet's map holds nothing, so it hides nothing.

So hiding, deleting or replacing a Profile on a tablet hides it at that
tablet's Location only, and a Profile whose steps changed is a new Profile,
shown where it was changed only, while the old one is hidden there and still
shown wherever else it was.

## Writing to tablets

Each welcomed connection that is not mismatched has a writer
(`server/src/sync/tablet-writer.ts`), on the instance holding it. It looks for
the next write due (`tabletDue` in `tablet-due.ts`), reading in one snapshot
what the Machine's Location offers and what the tablet's map holds, and
planning the writes with the pure `plannedWrites` (`holdings.ts`), in order:

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
4. Each Profile the Location shows that the tablet lacks, created, unless it
   is one of Decaid's bundled Profiles, which a tablet has already or lacks
   for its Decaid's version; or that it holds hidden or deleted, made visible.
   Then each Profile the tablet holds visible that the Location does not
   show, hidden, never deleted.

Beans are written before their batches, and batches are archived before
their Beans. Within each, items that joined the Library first are written
first. Every update sets only the fields that differ, and writes the global
id with them to a record that lost it; a Profile's record carries none.
Nothing is deleted from a tablet; an Admin's hard delete, which will delete
an item no Shot names from every tablet that holds it (ticket #87), is the
one exception.

It writes nothing until that connection's reports of the tablet's beans, bean
batches and profiles, which the plugin sends on every welcome, have been taken
in, nor between a report of its beans and the report of its batches the plugin
sends after it, so a change the tablet made to both, such as deleting a bean
with its batches, is taken in whole first. It then writes only while the
connection still holds the Machine and the Machine is at the Location the
latest reports were all taken in at. So a bean the tablet holds
already, entered there or before it joined, is linked to the Library's Bean
before anything is written, rather than written to it again. A tablet that
was offline catches up once its reports on reconnecting are taken in. The
writer also looks whenever any Library change is notified, on any instance,
and when the instance listens for notifications again after losing its
connection.

When the writer finds the Machine at another Location than the one its
tablet's latest reports were taken in at, as once it has moved, it sends the
plugin `requestCollections`, once for each Location it finds it at, and the
plugin reads every collection again and sends each in full, as on a welcome.
Once those reports are taken in at the new Location, the tablet is written
what that Location offers, and what only the old one offered is archived on
it. A change to a Machine's Location History that changes the Location it is
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
back in the answer, and the next report, holding the record as answered,
shows none. So the answer names the fields the write set (`writtenFields`),
and its `archived` and `weightRemaining`, where the write did not set them and
they differ from the record known, are taken in as a report's would be
(`editsInAnswer`, `archivingInAnswer`), under the Machine's, the tablet's and
the Location's locks, rather than written back over. An answer is recorded
only while its connection holds the Machine, decided under the Machine's row
lock, which a newer connection's hello takes too, so one an instance records
late, after another connection has taken the Machine, never lands after that
connection's reports. A record that does not carry the item's global id, or
whose local id the map holds as another item, is not recorded.

A refusal, an answer that cannot be recorded, no answer within 300 s, or an
item due again with the same fields it was last written, found due at every
look since, which writing again would not change, skips that item for the
rest of the connection; the other writes go on, and the tablet's next
connection tries it again. An update Decaid answers with 404 found the record
gone, deleted on the tablet just as the server wrote it, as when a barista
deletes a bean with its batches and a report of the batches, read after the
delete, comes before one of the beans: it is skipped the same way, but not
taken for a refusal, as the tablet's next report shows the delete. An item due
again with other fields, as when the second request of a batch's create
failed or the Location changed the item meanwhile, is written again. An
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
beans, bean batches and profiles), never during one (`LibraryAccess`), and
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
  Bean Batches are never the same item. Otherwise it creates the record
  (`POST /beans`, or `POST /beans/{beanId}/batches` under the tablet's
  record of the batch's Bean, which the write's `beanId` names) with the
  item's content and the global id in `extras`. Decaid assigns the record its
  id. A batch's create takes neither `archived` nor `weightRemaining`, which
  it sets to `weight`, so where the Location's remaining weight differs, the
  plugin writes it in a second request (`PUT /bean-batches/{id}`); should
  that fail or go unanswered, it answers with the record as created, and the
  server writes the weight again on the same connection. Each create reads the whole list once, which a tablet joining
  a Location with many items does once per item.
- To update a record, it reads the record and updates it (`PUT /beans/{id}`
  or `PUT /bean-batches/{id}`) with the fields the server sent and `extras`
  holding its other keys beside the global id, since Decaid replaces `extras`
  whole.

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
- To show or hide a Profile, it sets the record's visibility alone.

The plugin's next report then holds the record as written, which changes
nothing (ADR-0003). If the connection drops before the answer arrives, the
tablet's next report shows the record carrying its global id, which maps it.

Decaid v0.8.7 refuses to delete a bean that still has batches, archived ones
included, failing SQLite's foreign key with 500 and deleting nothing
(`server/test/fixtures/decaid/bean-batch-writes-v0.8.7/`). A barista deletes
one through DYE2, which deletes its batches first, then the bean
(`dye2:dye2-plugin/src/utils/bean-delete.ts`); the server reads the batches
and the bean gone from the tablet's next reports.

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
- `GET /api/profiles` returns `{ profiles }`, each `{ id, title, author,
  beverageType, bundled, archived, shownAt, createdAt, createdLocation }`, by
  title, ignoring case. `id` is Decaid's, such as
  `profile:bf1ca48b9c7389c7d146`; `title`, `author` and `beverageType` are its
  content's. `shownAt` lists the Locations showing it, by name, each `{
  location, since }`, when the Location last decided to show it, by
  PostgreSQL's clock, as when a tablet there showed it again while it was
  shown. None while it is Archived.
- `GET /api/profiles/:id` returns `{ profile }`, the same with its `content`
  and `parent`, `{ id, title }` of the Profile it was saved from if the
  Library has it, or null; or 404. The id goes in the path as it is or
  percent-encoded.

The management interface's Library section lists the Beans and where each is
offered, the Bean Batches, the Locations each is at and its remaining weight
at each, and the Profiles and where each is shown. Each Bean's page shows its
content, where it is offered, its batches and its likely duplicates, each
batch's page its roast, the Locations it is at with its remaining weight at
each, and where it was finished, and each Profile's page where it is shown,
its steps and the Profile it was saved from.

## Not yet

- Edits, merged per field with Conflicts (ADR-0020), Profiles' titles,
  authors and notes included: ticket #84. Until then a
  record's content stays as the tablet that created or linked it sent it, and
  only per-Location state is taken from tablets: a linked bean keeps its own
  content, and only its global id is written; linking will then write the
  Library's content to it, keeping each field it differed in as a Conflict
  (ADR-0018). Two remaining weights entered without seeing each other keep
  the later; the other will be kept as a Conflict.
- Archive, restore, creating and editing items, and adding and finishing
  batches at Locations in the management interface: ticket #87; showing and
  hiding Profiles at Locations there, and Archiving them: ticket #88.
- Joining a Location, including what a moved Machine brings and clearing its
  Workflow's batch: ticket #89. Until then a moved Machine's tablet is written
  its new Location's items once its fresh reports are taken in there, and has
  what only its old one offered archived or hidden, its old Location's user
  Profiles included; its bundled Profiles keep their visibility where the new
  Location has decided nothing of them. Those reports link or add only the
  items the tablet's map does not hold yet, such as those of a Machine given
  its first Location: what it held at its old Location stays offered only
  there, though a batch un-archived on it is added at its new one. A change
  made on the tablet just before a move, which a report or an answer brings
  after it, means what it would at the Machine's new Location, as the
  server reads it where the Machine is when it is taken in.
- Grinders, each belonging to one Location: ticket #83. Each Location's
  steam, hot water and rinse settings: ticket #86. Conflicts and each item's
  history in the management interface: ticket #85.
- The capture-only switch: ticket #90. Recording refused writes, and each
  Machine's sharing status: ticket #91.
- Linking Shots to the Library's batches: ticket #92.

Decaid hides a bundled Profile a release no longer bundles, or bundles anew
under another id (`_retireStaleDefaults` in
`decaid:lib/src/controllers/profile_controller.dart`). So once tablets at one
Location run Decaid releases that bundle different Profiles, the first to
upgrade hides the old one at the Location, on the others too, which lack the
new one: bundled Profiles are never written. v0.8.7 and v0.8.8 bundle the same
Profiles.

`server/test/library-beans.test.ts`, `server/test/library-batches.test.ts`
and `server/test/library-profiles.test.ts` cover this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL;
`server/test/bean-intake.test.ts`, `server/test/batch-intake.test.ts`,
`server/test/profile-intake.test.ts` and `server/test/holdings.test.ts` the
pure modules; `server/test/simulated-bean-writes.test.ts`,
`server/test/simulated-batch-writes.test.ts` and
`server/test/simulated-profile-writes.test.ts` the simulated tablet's writes
against those recorded on Decaid's Linux release
(`server/test/fixtures/decaid/bean-writes-v0.8.7/`,
`bean-batch-writes-v0.8.7/` and `profile-writes-v0.8.7/`); and
`e2e/library.spec.ts` the management interface.
