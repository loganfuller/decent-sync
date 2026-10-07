# The Library

Ticket [#80](https://github.com/loganfuller/decent-sync/issues/80) starts
milestone 2's Library ([#77](https://github.com/loganfuller/decent-sync/issues/77))
with Beans: a Bean entered on a tablet joins the Library and is written to the
other tablets at that tablet's Location. It follows ADR-0003, ADR-0006,
ADR-0008, ADR-0016 and ADR-0018. Bean Batches, Grinders, Profiles, edits,
deletes and joining a Location build on it in later tickets (Not yet, below).

## Who takes part

A Machine takes part while it is at a Location: the Location of the latest
entry of its Location History. A Machine with no Location is capture-only: its
tablet's beans are captured as a collection (`COLLECTIONS.md`), but not taken
into the Library, and nothing is written to it. A mismatched connection, whose
tablet is not its token's Machine's, takes no part either, and neither does a
Pending Machine (ADR-0004). Unidentified Machines, and connections whose
machine has not reported its hardware yet, take part as their token's Machine.

## Storage

`server/src/library/beans.ts` and its pure module `bean-intake.ts`, in
PostgreSQL:

- `beans`: each Bean, by its global id (ADR-0006), with its content, Decaid's
  record fields as the tablet that created it sent them, those the server does
  not know included, but the record's id, times, `archived` and `extras`,
  which belong to each tablet's record. Also its match key (below), whether
  it is Archived, the Location of the tablet that created it, and when it
  joined the Library, by PostgreSQL's clock.
- `bean_origins`: the Locations where a tablet created the Bean or linked a
  bean of its own to it. While a Bean has no batches, it is offered at each,
  unless it is Archived (ADR-0008).
- `tablet_beans`: the map, per tablet id (ticket #79): each Bean's local id
  on that tablet and the record as the tablet last had it, as it reported it
  or as Decaid returned the plugin's write, with that record's `updatedAt`
  placed in UTC by the plugin. A reset tablet has a new tablet id, so it starts
  with nothing here.

## Taking in a tablet's beans

The plugin reports its beans as milestone 1's `beans` collection, now with
each record's `updatedAt` placed in UTC beside the list (`COLLECTIONS.md`).
When the collection is stored for a Machine that takes part, the same
transaction takes the beans into the Library (`takeInBeans`), holding the
Machine's row lock, which Location History changes take, then the tablet's
row lock, which every change to its map takes, then, if any record is new to
the map, one advisory lock under which new beans are matched, so two tablets
entering the same coffee at once make one Bean. It runs with a 60 s limit: a
tablet reporting 1,000 beans new to the Library took 0.75 s on the development
database.

A record without what every supported Decaid sends (its id, roaster, name and
an `updatedAt` the plugin could place) is ignored. Each other record, in the
order reported (`planIntake`):

1. A record the tablet's map holds by its local id stays that Bean, whatever
   global id it carries, so a global id another plugin wiped is written back
   rather than the record taken for a new Bean. Its record replaces the one
   known if its time is later; one as old or older, such as a report read
   before the plugin's own write, changes nothing.
2. Otherwise a record carrying a Library Bean's global id in `extras` is that
   Bean, as on a tablet whose answer to a write was lost, or one restored from
   a Decaid backup.
3. Otherwise the record is new. One archived on the tablet is left out until
   archiving has its meaning at a Location (ticket #81). Another is linked to
   the oldest Library Bean, not Archived, whose roaster and name match its own,
   ignoring case and white space at either end (`beanMatchKey`), unless one of
   the tablet's other records already is that Bean; the Bean is then offered at
   the tablet's Location too. Otherwise it joins the Library, created at the
   tablet's Location.

A record carrying a global id the Library does not know is new, and gets the
new Bean's id. Beans are matched only when a tablet first reports them
(ADR-0018), so two Beans with the same roaster and name, as when one tablet
holds two such records, stay apart, and each lists the other as a likely
duplicate.

When a report makes a Bean newly offered at the Location, or leaves a record
there without its Bean's global id, it commits with a `NOTIFY` on the
`library_changes` channel naming the Location (ADR-0016;
`server/src/notifications.ts`, the one listening connection each instance
holds, shared with `machine_access`).

## Writing to tablets

Each welcomed connection that is not mismatched has a writer
(`server/src/sync/tablet-writer.ts`), on the instance holding it. It looks for
the next write due (`nextBeanWrite`): a Bean the Machine's Location offers that
the tablet's map lacks, which is created with the Bean's content, or one whose
recorded record lacks its global id, which only that id is written to. Beans
that joined the Library first are written first. It writes nothing while its
connection no longer holds the Machine, or the Machine is at no Location. It
looks when the connection is welcomed, which catches up a tablet that was
offline, whenever any Library change is notified, on any instance, and when
the instance listens for notifications again after losing its connection.

One write is outstanding per connection, and only the connection holding a
Machine writes, so a tablet is written one item at a time. The server sends a
`write`, in chunks if it is too large for one frame (`AI_PROTOCOL_NOTES.md`),
and the plugin answers it on the same connection with `written`, the record
Decaid returned, or `writeRefused`, Decaid's refusal. The server records a
written record as the tablet's record of the Bean, unless the record known is
newer, then acknowledges the answer with `ack` and goes on. A record that does
not carry the Bean's global id, or whose local id the map holds as another
Bean's, is not recorded. A refusal, an answer that cannot be recorded, or no
answer within 120 s skips that Bean for the rest of the connection; the other
writes go on, and the tablet's next connection tries it again.

The plugin (`plugin/src/library-writes.ts`) carries writes out through
Decaid's API, one at a time:

- To create a Bean, it first reads the tablet's beans, archived ones included.
  A record already carrying the global id was made by a write whose answer was
  lost: it answers with that record, and writes nothing. Otherwise it creates
  the record (`POST /beans`) with the Bean's content and the global id in
  `extras`. Decaid assigns the record its id.
- To write the global id into a record, it reads the record and updates it
  (`PUT /beans/{id}`) with `extras` holding its other keys beside the global
  id, since Decaid replaces `extras` whole.

The plugin's next report then holds the record as written, which changes
nothing (ADR-0003). If the connection drops before the answer arrives, the
tablet's next report shows the record carrying its global id, which maps it.

## REST API

Every endpoint requires the account session; Staff read them as Admins do.

- `GET /api/beans` returns `{ beans }`, each `{ id, roaster, name, archived,
  offeredAt, createdAt, createdLocation, likelyDuplicates }`, by name, then
  roaster, ignoring case. `offeredAt` lists the Locations offering it, by
  name, none while it is Archived. `likelyDuplicates` lists the other Beans
  with the same roaster and name, each `{ id, roaster, name }`.
- `GET /api/beans/:id` returns `{ bean }`, the same with its `content`, or
  404.

The management interface's Library section lists the Beans and where each is
offered, and each Bean's page shows its content, where it is offered and its
likely duplicates.

## Not yet

- Bean Batches, and offering a Bean where its batches are: ticket #81.
- Archiving or deleting on a tablet, and Archive in the management interface:
  tickets #81 and #87. A record archived on its tablet is not taken in yet.
- Edits, merged per field with Conflicts (ADR-0020): ticket #84. Until then a
  linked record keeps its own content, and only its global id is written;
  linking will then write the Library's content to it, keeping each field it
  differed in as a Conflict (ADR-0018).
- Joining a Location, including what a moved Machine brings and the hiding of
  what its old Location offered: ticket #89. A move notifies nothing yet: a
  moved Machine's tablet is written its new Location's Beans at its next
  welcome or Library change.
- The capture-only switch: ticket #90. Recording refused writes, and each
  Machine's sharing status: ticket #91.

`server/test/library-beans.test.ts` covers this through Seam 1, with the
built plugin and raw frames on two instances sharing PostgreSQL;
`server/test/bean-intake.test.ts` the pure module;
`server/test/simulated-bean-writes.test.ts` the simulated tablet's bean
writes against those recorded on Decaid's Linux release
(`server/test/fixtures/decaid/bean-writes-v0.8.7/`); and `e2e/library.spec.ts`
the management interface.
