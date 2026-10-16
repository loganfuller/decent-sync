# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. Before version 1.0, run the server
and the plugin of the same release
([ADR-0017](docs/adr/0017-supported-versions.md)).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see the README's Releasing
section).

## Unreleased

### Update Decaid to v0.9.0 on every tablet

The server now refuses a tablet running a Decaid older than v0.9.0, with
`decaid_too_old`, and its Machine's page says why; the plugin stops until
Decaid is updated. Update Decaid on every tablet before upgrading the
server. Decaid v0.9.0 tells the plugin of every Shot it stores or changes,
those a backup import adds or overwrites included, and copies the burrs of a
Shot's grinder onto each Shot it pulls, which the server now keeps with each
Shot. Shots stored before the upgrade keep no burrs until they are stored
again.

### Run DYE2 and Streamline from `main` on every tablet

A Machine that follows Recipes now needs DYE2 built from `main` at
[`2cf631c`](https://github.com/decentespresso/dye2/commit/2cf631c) or later,
and, where Streamline is its skin, streamline-js from `main` at
[`c006dac`](https://github.com/decentespresso/streamline-js/commit/c006dac)
or later. These untagged builds are the minimums until tagged releases
contain them ([ADR-0017](docs/adr/0017-supported-versions.md)). With DYE2
v0.1.20, no Recipe loads where its profile has a target weight.

With them, a yield set on Streamline's Drink tile keeps the Recipe loaded and
becomes the Recipe's, a Shot no longer clears the Recipe's batch, grinder,
Basket and RPM from the Workflow, and, with Streamline's DYE2 switch on, a
wake onto the Loaded Recipe's profile leaves its dial alone, so a wake
profile no longer needs to be left unset. With that switch off, waking onto
it still sends the dose, yield, grind and brew temperature Streamline saved
for the profile, which become the Recipe's: set no wake profile there. So
does a wake onto a profile with a step limiter of 0, such as Adaptive v3,
applied from Streamline's strip
([decentespresso/streamline-js#158](https://github.com/decentespresso/streamline-js/issues/158)). On
a profile with a step limiter of 0, such as Adaptive v3, applied from DYE2's
dashboard, a yield or dose set on Streamline's tiles still unloads the Recipe
([decentespresso/dye2#32](https://github.com/decentespresso/dye2/issues/32)).

DYE2 now holds each Recipe's batch, and applies it with the Recipe's brew
temperature. A batch picked in DYE2's recipe editor becomes the Recipe's,
but picking another batch on a Machine, of the Recipe's Bean or not, unloads
the Recipe there rather than moving it to that batch: a Recipe is the
dial-in for one roast. An RPM or Basket changed on a Machine becomes the
Recipe's only where the Recipe holds one already; give a Recipe one in DYE2's
editor or the management interface first.

DYE2 now names the recipe it has selected in the Workflow, and Decaid copies
that onto each Shot, so the server reads each Machine's Loaded Recipe, and
each Shot's Recipe, from it: the plugin no longer writes a Recipe id of its
own into the Workflow. A change DYE2 records into a Recipe on a Machine now
reaches the other Machines within seconds, not at the plugin's next poll.

### Approve the plugin update on every tablet

The plugin now tells Streamline when it has written a tablet's DYE2
recipes, so a dashboard left open shows a Recipe added, edited, moved or
taken out of its slot at once, in its DYE strip, without the barista
leaving and returning to it. That needs Decaid's `emit` permission. Decaid
installs a plugin update by itself only when the update asks for no new
permissions, so on each tablet this one waits under Decaid's Settings,
Plugins, saying it needs approval and adds `emit`, until someone at that
tablet presses **Review**, then **Approve and update**. From a computer on
the same network, this does the same:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/update/approve
```

Until a tablet's update is approved, it runs the plugin it has, from an
earlier release, which this release does not support
([ADR-0017](docs/adr/0017-supported-versions.md)).

Streamline's builds with live plugin notifications
([decentespresso/streamline-js#120](https://github.com/decentespresso/streamline-js/pull/120)
and [#127](https://github.com/decentespresso/streamline-js/pull/127)) take
the plugin's notice, as the build from `main` above does. A dashboard that
was hidden when the recipes changed, and any other skin, show the
change once the dashboard is opened again, regains focus or becomes visible,
as before.

### Run a Streamline build that keeps changes made elsewhere

Streamline remembers what a barista last set for steam, hot water and flush.
Up to v0.2.13 it pushed those values back over any change made elsewhere,
so this plugin used to set Streamline's remembered values before writing a
Location's settings. Streamline's builds since
[decentespresso/streamline-js#109](https://github.com/decentespresso/streamline-js/pull/109)
keep a change made elsewhere instead, so this release sets none of them.
Run such a build on every tablet that uses Streamline, as the build from
`main` above is.

### Hot water settings are no longer shared

Each Machine's hot water volume, temperature, time and flow are its own, and
a Recipe it loads sets them. The upgrade drops the hot water settings each
Location had, with their history and Conflicts, and leaves each Machine's
Workflow holding the hot water it has now, so set any Machine's hot water you
want otherwise on its tablet.

### Steam and rinse settings are no longer shared

A Location's Machines no longer share their steam and rinse settings. Each
Machine keeps its own, and nothing syncs them until a later release makes
them the Recipe's ([#173](https://github.com/loganfuller/decent-sync/issues/173)):
a change on one tablet stays on that Machine, and a Machine joining a
Location keeps its own. Each Location's page no longer shows or changes them,
nor has a switch for each Machine's sharing of them, and the upgrade deletes
them, with their history and Conflicts, leaving each Machine's Workflow
holding the steam and rinse settings it has now. Applying a recipe, in DYE2
or in Streamline's DYE strip, still sets the steam and flush values that
tablet's copy of it holds, so one saved there with a blank steam or flush
field can set it to 0 on that Machine. Set each Machine's steam and rinse as
you want them on its tablet.

### Baskets and Tools are shared through DYE2's lists

The plugin now writes DYE2's baskets and tools (DYE2's equipment) on every
tablet that shares a Location's Library, whether or not DYE2 is installed
there, and the server keeps them in the Library: each is shown at the
Location where it was entered, and one of the same name entered at another
Location is the same Basket or Tool. As each sharing Machine's tablet reports
them after the upgrade, its baskets and tools join the Library, shown at its
Location, and those of the same name become one, so every tablet at a
Location then holds all of them. A Machine that joins a Location later
brings none of its own unless the Location has none yet, as for beans and
profiles. Turn sharing off for a Machine first if its tablet's DYE2 baskets
and tools are to stay as they are.

### Recipes are shared through DYE2's recipes

The plugin now writes DYE2's recipes on every tablet that shares a Location's
Library, and the server keeps each as a Recipe of that Location, in its
Recipe Slot, DYE2's recipe number. Every tablet at a Location then holds the
Location's Recipes in the same slots, each naming that tablet's own beans,
grinder, basket and tools, with a blank barista and drinker. As each sharing
Machine's tablet reports its recipes after the upgrade, a recipe in a slot no
other tablet there has reported yet becomes a new Recipe in that slot, and
one in a slot another tablet's recipe already took is an edit of that
Recipe, its fields merged with the latest read winning, and the others kept
as Conflicts. So make sure each Location's tablets hold the same recipe in
each slot before upgrading, or turn sharing off for a Machine whose recipes
are to stay as they are. A recipe removed from a tablet's list is taken out
of its slot and kept.

## 0.3.0

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

### Machines at a Location now share steam, hot water and rinse settings

Once a tablet's Machine is at a Location, its Workflow's steam, hot water and
rinse settings are shared with the Location's other Machines, DE1s and
Bengles alike. The first Machine at a Location to connect after the upgrade
sets that Location's settings, and every other Machine there is written them
as it connects, replacing its own. Check each Location's page in the
management interface afterwards, and change them there or on any of its
tablets. To keep a Machine on its own settings, turn off its sharing on
its Location's page before its tablet connects. A Machine whose steam is
turned off keeps it off, and takes the Location's steam settings once it is
turned on again. Note each machine's settings before upgrading if you may
want them back.

### The management interface now edits the Library

Admins and Staff can create and edit Beans, Bean Batches and Grinders in the
management interface, Archive and restore them, and add a batch at a
Location or finish it there, with its remaining weight at each. They can show
or hide each Profile at each Location, Staff only at their own, and Archive
and restore Profiles, which hides an Archived one on every tablet. Every
tablet that should hold the change is written it. An Admin can delete a
Bean, Bean Batch, Grinder or Profile no Shot names, which also deletes it
from every tablet that holds it, a Bean with its batches, once each tablet
connects; Decaid's bundled Profiles are never deleted. Nothing else is ever
deleted from a tablet.

### Reload the plugin after restoring the server's database

The plugin now tells the server which Shots and Steam Records its tablet
holds once each time it loads, rather than on every reconnect. A server
whose database is wiped, or restored from an older backup, learns which
records it lacks only when each tablet's plugin loads again. After such a
restore, reload the plugin on every tablet: restart Decaid, or turn the
plugin off and on again.
