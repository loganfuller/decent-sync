# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. Before version 1.0, run the server
and the plugin of the same release
([ADR-0017](docs/adr/0017-supported-versions.md)).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## Unreleased

### Approve the plugin update on every tablet

The plugin now gives each tablet an id, which it keeps in Decaid's plugin
storage, so the server can tell a reset or replaced tablet from a known one;
each Machine's page lists the tablets its connections came from. Plugin
storage needs the `pluginStorage` permission. Decaid installs a plugin update
by itself only when the update asks for no new permissions, so on each tablet
this one waits
under Decaid's Settings, Plugins, saying it needs approval and adds
`pluginStorage`, until someone at that tablet presses **Review**, then
**Approve and update**. From a computer on the same network, this does the
same:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/update/approve
```

This release's server refuses the plugin before it, whose `hello` has no
tablet id. Until a tablet's update is approved, that tablet stays
disconnected, and its Machine offline.

### Tablets at a Location now share their beans

The plugin now writes to Decaid. Once a tablet's Machine is at a Location,
every bean on that tablet joins the server's Library, or becomes the Bean
already there with the same roaster and name, and the Location's other
tablets are written those not archived on it. Each tablet's records get their
Library id in `extras`, beside what other plugins keep there. A Machine with
no Location is written nothing, and its beans stay out of the Library; a
switch to keep a Machine at a Location out comes later. Export each tablet's
data before upgrading if you may want to undo this: from a computer on the
same network,

```bash
curl -o tablet-backup.json http://<tablet>:8080/api/v1/data/export
```

### Tablets at a Location now share their bean batches

Once a tablet's Machine is at a Location, its bean batches join the
server's Library too, at that Location, and the Location's other tablets are
written them, with their beans. A batch archived on a tablet is finished at
that tablet's Location and archived on its other tablets; un-archived, it is
added back; and the remaining weight entered on a tablet is that Location's,
written to its other tablets. A bean archived or deleted on a tablet finishes
its batches at that Location, and is archived on the Location's other tablets
once none of its batches is there. A bean archived on a tablet is not offered
at its Location; one that becomes a Bean its Location offers is un-archived
there.
Nothing is deleted from a tablet: what its Location stops offering, such as
the beans and batches of a Location a Machine was moved away from, is archived
on it. Export each tablet's data first if you may want to undo this, as above.

### Tablets at a Location now share their profiles

Once a tablet's Machine is at a Location, its profiles join the server's
Library too, Decaid's bundled ones included, and each is shown or hidden per
Location. A profile created on a tablet is written to the Location's other
tablets, and shown there only. Hiding, deleting or changing a profile's steps
on a tablet hides it at that tablet's Location, on all of its tablets, and
only there; changed steps make a new profile, shown there. The first tablet
at a Location to report a profile decides whether it is shown there, so a
profile hidden or deleted on one tablet of a Location that has several, before
the upgrade, may be shown on all of them, or hidden on all of them, even one
the other tablets use. Show it again on any tablet there. Nothing is deleted
from a tablet: what its Location stops showing is hidden on it.
Export each tablet's data first if you may want to undo this, as above.

### Tablets at a Location now share their grinders

Once a tablet's Machine is at a Location, its grinders join the server's
Library too, each belonging to that Location, and the Location's other
tablets are written them, and no other Location's tablets. A tablet at a
Location with several Machines therefore gets the other tablets' grinders
beside its own, even ones of the same model: grinders are never merged.
Archiving or deleting a grinder on a tablet archives it on every tablet at
that Location, never deleting it, and un-archiving it brings it back. Nothing
is deleted from a tablet: a moved Machine's tablet keeps its old Location's
grinders, archived. Export each tablet's data first if you may want to undo
this, as above.

### Machines of one model at a Location now share steam, hot water and rinse settings

Once a tablet's Machine is at a Location, its Workflow's steam, hot water and
rinse settings are shared with the Location's other Machines of the same
model. The first Machine of each model at a Location to connect after the
upgrade sets that Location's settings for the model, and every other Machine
of that model there is written them as it connects, replacing its own. Check
each Location's page in the management interface afterwards, and change them
there or on any of those tablets. A Machine whose steam is turned off keeps
it off, and takes the Location's steam settings once it is turned on again.
Note each machine's settings before upgrading if you may want them back.

### Reload the plugin after restoring the server's database

The plugin now tells the server which Shots and Steam Records its tablet
holds once each time it loads, rather than on every reconnect. A server
whose database is wiped, or restored from an older backup, learns which
records it lacks only when each tablet's plugin loads again. After such a
restore, reload the plugin on every tablet: restart Decaid, or turn the
plugin off and on again.
