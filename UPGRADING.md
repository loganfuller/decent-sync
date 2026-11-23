# Upgrading

What to do when upgrading to a release, beyond running its server image and
letting Decaid update each tablet's plugin. From 1.4.0, the
plugin and server of adjacent releases work together, upgraded in either
order, and the new server runs beside the old one as it upgrades, so nothing
here stops the server or recreates the database
([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md)).
Earlier releases' notes may still ask that. A server that skipped a release
takes each release in turn (docs/SELF-HOSTING.md, Upgrading).

Where a note has a tablet's plugin updated or approved through Decaid's API
from its network (`POST /api/v1/plugins/update`,
`POST /api/v1/plugins/decent-sync.reaplugin/update/approve`), Decaid v0.9.2
takes the request only with a token, as v0.9.3 and later do while
"Require authorization for extension management" is on in Decaid's Security
settings on the tablet: send it as `Authorization: Bearer <token>`, which does
no harm where none is asked. Make one on the tablet in Decaid, on its
Decent Account page under API access tokens, with "Manage plugins and skins"
turned on. It is shown once, and needs no Decent Account sign-in
(docs/PLUGIN.md, A token for managing plugins).

Each release's notes on GitHub start with its section here. Notes for the next
release wait under Unreleased until it is tagged (see docs/DEVELOPMENT.md,
Releasing).

## Unreleased

### The Conflict routes are gone

The routes 1.12.2 kept for a page of the release before it, `GET
/api/conflicts`, each item's `GET .../:id/conflicts`, and `POST
/api/conflicts/:id/use` and `/dismiss`, are removed, and answer 404. Lost
Edits are read in each item's `GET .../history`, as in 1.12.2.

No step is needed. The upgrade deletes the Conflicts that were dismissed
before 1.12.2, which no release has shown since; every other Lost Edit stays
in its item's History.

### Tablets updated to Decaid v0.9.3

This server needs nothing for Decaid v0.9.3. On a tablet that updates to it:

- Decaid turns its protection of plugin and Skin management off as it
  updates, so anything on the tablet's network can install a plugin there
  until **Require authorization for extension management** is turned on in
  Decaid's Security settings on the tablet. Turned on, the tablet asks a token as
  v0.9.2 did (docs/PLUGIN.md, A token for managing plugins). Either way,
  v0.9.3 refuses a browser page whose address is not the tablet's own
  numeric one or `localhost`, which v0.9.2 did not.
- v0.9.3 bundles 21 more Profiles: Decaid's calibration and leak tests, a
  forward flush, and espresso Profiles such as the E61 ones. The first tablet
  at a Location to update reports them, and they join the Library shown at
  that Location, those for cleaning and calibration included. Hide the
  unwanted ones at the Location, and its tablets are written the same. A
  tablet still on v0.9.2 lacks them: bundled Profiles are never written.
- v0.9.3 bundles DYE2 v0.1.42 and Streamline v0.2.31, the minimums
  [ADR-0017](docs/adr/0017-supported-versions.md) names, so it puts neither
  over a supported one.

## 1.12.2

### Tablets need Streamline v0.2.31

This release follows Streamline v0.2.31
([ADR-0017](docs/adr/0017-supported-versions.md)). Decaid installs the latest
Streamline on each tablet within 12 hours by itself. A tablet whose
Streamline is pinned to an earlier build is moved to v0.2.31 or later by
hand first, and one running a Skin built on Streamline, such as Streamline
Cafe, to a build of it on v0.2.31. Then deploy the server. Nothing refuses
an older Streamline, but nothing is written for what it does: the strip of
v0.2.28 or earlier applies no steam temperature, so on a tablet still
running the previous release's plugin a Recipe loaded from it leaves steam
off where it was off.

From v0.2.29, a hold on Streamline's Sleep button closes Decaid, which
wakes the Machine as it is opened again. It is a setting of Streamline's,
on until turned off ("Hold Sleep to sleep and close the app", under Sleep
button on its settings page). While Decaid is closed its Machine shows
offline in the management interface and nothing reaches its tablet, so turn
it off on tablets that are to stay reachable.

### Tablets need DYE2 v0.1.42

This release follows DYE2 v0.1.42
([ADR-0017](docs/adr/0017-supported-versions.md)). Decaid installs the
latest DYE2 on each tablet by itself; a tablet whose DYE2 is pinned to an
earlier build is moved to v0.1.42 or later by hand first. Then deploy the
server. Nothing refuses an older DYE2, but nothing is written for what it
does: DYE2 v0.1.41 or earlier applies a Recipe's grind setting of 0 as none,
clearing the Machine's, and DYE2 v0.1.40 or earlier, which knows no archived
basket, offers in its pickers every Basket hidden at its Location, as such a
Basket is now archived on its list rather than removed.

### A grind setting of 0 is a Recipe's

A grind setting of 0 is now a dial position, as DYE2 v0.1.42 applies one
([ADR-0022](docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md),
What 0 means). Saved on a tablet, or set in the management interface or
through an assistant, it is the Recipe's: shown, written to the Location's
other tablets, and left in a Machine's Workflow as the Recipe loads. A dose
or RPM of 0 is still none.

Nothing puts back the grind settings of 0 that 1.10.1 removed from Recipes:
no record was kept of which Recipes held one. Where a tablet's recipe still
holds a 0 that its Recipe holds none of, the server writes it none, as the
Recipe holds it; set the 0 again where it was meant.

As DYE2 v0.1.42 loads, it repairs each of its recipes saved at a grind
setting of 0 before it, which then cleared the Machine's grind setting as it
applied. That is no edit of the Recipe and writes nothing to other tablets.

While the previous release still serves beside this one during the deploy,
it takes a grind setting of 0 saved on a tablet it holds as none, as it did,
and shows a Recipe's 0 as none. A Recipe set to 0 through this release
then, from another setting, is written none to the tablets the previous
release holds, and cleared from the Workflow of each of their Machines that
has it loaded, so a Shot pulled there names no grind setting. Each is
written the 0 again as its tablet reconnects to this release.

### A Basket archived in DYE2 is hidden at its Location

From DYE2 v0.1.41 a barista can archive a Basket in DYE2's Basket picker.
Earlier releases took that as part of the Basket itself: it left the picker
on every tablet at every Location, while the management interface still
showed it shown and not Archived. Now archiving a Basket on a tablet hides
it at that tablet's Location only, as deleting it there does, and UNARCHIVE
shows it there again. Hiding a Basket at a Location in the management
interface or through an assistant archives it on that Location's tablets,
where it used to be removed from their lists, so a barista can bring it back
there; showing it again unarchives it. A Basket Archived in the management
interface is still removed from every tablet, and Tools are unchanged.

The release's migration takes the archive earlier releases spread out of
every Basket, and changes no Location's state. A Basket archived that way
before this release therefore reappears on every tablet wherever it is
shown. Where it was meant to go, archive it again in DYE2 on a tablet at
that Location, or hide it there in the management interface. A Basket
removed from a tablet's list under the old rule is not put back.

A Machine joining a Location still has its Workflow's Basket cleared if the
Location does not show it, though DYE2's own archive leaves it named.

While the previous release still serves beside this one during the deploy,
it takes a Basket archived on a tablet it holds as part of the Basket again,
and writes that to the tablets it holds; it removes a Basket hidden at a
Location from those tablets rather than archiving it. This release reads
such a Basket as not archived, so the tablets it holds are written it
unarchived wherever it is shown. Archive it again once the deploy is done.

### Loading a Recipe turns steam on or off

Steam on and off now follows the Recipe, as DYE2 and Streamline v0.2.31
apply one
([ADR-0022](docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md),
Steam on and off). Nothing is needed, but baristas will see:

- **A Recipe holding a steam temperature turns steam on as it loads**, at
  its steam temperature and time, on a Machine whose steam was off. So an
  espresso-only Machine, or one being descaled, has its steam turned on by
  loading such a Recipe. Give the Recipes it loads a steam temperature of
  Off, or none.
- **A Recipe can hold Off.** Off saved in DYE2's recipe editor, or a steam
  temperature of 0 set in the management interface or through an
  assistant, is the Recipe's: loading it turns a Machine's steam off, and
  saving it turns steam off on every Machine that has the Recipe loaded.
  Before, the server wrote the Recipe's earlier steam temperature back over
  it.
- **Steam turned off at a Machine still changes nothing else.** Its heater
  switch, or a steam time of 0 set there, changes no Recipe and no other
  Machine, and steam turned back on there takes the Recipe's steam
  temperature and time.
- **Nothing turns a Machine's steam on from elsewhere.** A Recipe edited
  from Off to a steam temperature reaches a Machine that has it loaded once
  its steam is turned on there, or the Recipe is loaded again. Steam turned
  on at a Machine whose Recipe holds Off makes the Recipe hold the steam
  temperature and time it came on with, and the other Machines stay off.
- **A Recipe holding no steam temperature or time** leaves a Machine's
  steam as it is, as before.

While the previous release still serves beside this one during the deploy,
it writes a Recipe's earlier steam temperature back over Off saved on a
tablet, as it did, and a tablet running its plugin, until Decaid updates
it, leaves a Recipe's steam temperature out of a Workflow whose steam is
off, so only DYE2's or Streamline's own apply turns its steam on.

### Four settings renamed

The Machine's page names four settings as Streamline v0.2.31's settings
page does: "Weight look-ahead", "Volume look-ahead" and "Hot water
look-ahead", which were the three flow multipliers, and "Flow calibration",
which was "Flow multiplier". Their values and what they do are unchanged,
and so are their names in the REST API and for an assistant
(`weightFlowMultiplier`, `volumeFlowMultiplier`, `hotWaterFlowMultiplier`,
`flowMultiplier`).

### Lost Edits replace Conflicts

An edit to a Library item that loses to another made without seeing it is no
longer a Conflict waiting for someone to use its value or dismiss it. It is
a Lost Edit: an entry in the item's History, on its page and for an
assistant, marked "Lost Edit", with its value, who or which Machine made it
and when, and the change it lost to
([ADR-0033](docs/adr/0033-an-edit-that-loses-is-kept-in-the-items-history.md)).
To bring a value back, edit the item. Which edit wins is unchanged. No Lost
Edit is kept for a value that the tablet making the change itself held.

The Conflicts page, its link in the Library's navigation and the Open
Conflicts card on item pages are gone, and so are the assistant's tools
`list_conflicts` and `resolve_conflict`. `get_library_item` no longer takes
`conflicts`: its `history` lists Lost Edits among the item's edits, each
with `lost` and `lostTo`. In the REST API, each item's `GET .../history`
returns `lostEdits` beside `versions`. The routes that listed, used and
dismissed Conflicts stay for this release only, for a page of the previous
one: those that listed them answer an empty list, and using or dismissing
one answers 410 Gone. They are removed in a later release.

No step is needed. Each open Conflict becomes a Lost Edit in its item's
History, as does each whose value was used. One that was dismissed is not
shown. A page of the previous release still open during the upgrade lists
no Conflicts, and asks for a reload if one is used or dismissed from it.

## 1.12.1

### The time to first drip reads earlier

A Shot's time to first drip is now when its coffee first reached the cup, as
nearly as its scale shows it: the first reading of 0.2 g or more in the
scale's rise to 1 g, from its last reading of zero. Until now it was the
scale's first reading of 1 g or more, a median 0.6 s later and 1 s or more
later on a quarter of Shots. Nothing is needed. The REST API's and the MCP
tools' `timeToFirstDrip` keeps its name and now reads earlier, and a Shot
whose scale never read 1 g still has none. Stored Shots are computed again
in the background, 20 at a time, as in 1.9.0, so lists, Shot Summaries and
trends move together; while a deploy runs this release beside the previous
one, a Shot an instance of the previous release stores, with the old time,
is computed again within the hour. A Shot whose cup was put on the scale
during its Preheat, weighed before Decaid's tare landed, now reads its first
drip after the tare, and is an Unfinished Shot where nothing poured. The
simulation on a Profile's page reads a run's first drip by the same rule.

## 1.12.0

### Check every tablet runs the 1.10.0 plugin or later before deploying

This release raises the wire revision, for a Machine following a Draft
([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md),
Deploying). Before deploying, check on each Machine's page that it runs the
plugin of 1.10.0 or later, 1.11.1's among them. A tablet still on the 1.9.0
plugin or earlier is refused as too old until its plugin is updated, at the
tablet or through Decaid's API from its network with
`POST /api/v1/plugins/update`.

### A Machine follows a Draft only once its plugin is this release's

A Location can now be marked as one where Drafts may be tried, by an Admin
on the Locations page, and a Machine there can follow a Draft of a Profile
from the Draft's page. Following needs this release's plugin: a Machine
whose tablet is still on the previous release's is listed on the Draft's
page as needing its plugin updated, and can't be chosen until Decaid updates
it. Nothing else is needed, and nothing changes at a Location that is not
marked.

### A Profile a Machine can't run is no longer written to it

Each Profile is now held to the ranges of the Machine models that run it: a
DE1's are Streamline's (pressure up to 12 bar, flow up to 15 ml/s, a flow
limit up to 8 ml/s, a step up to 127 s, among others), and a Bengle's are
the same but for flow targets, limits and exits up to 20 ml/s. A Profile with a value outside them, such as one
imported from elsewhere with a 9 ml/s flow limit, is no longer written to a
Machine that can't run it, as a DE1 would read some such values as others.
Its write is listed as refused on the Machine's page, with why, and showing
it at that Machine's Location, or naming it in a Recipe there, is refused
(docs/LIBRARY.md). None of Decaid's bundled Profiles is affected. Nothing is
needed beyond looking for such refusals on each Machine's page after the
deploy.

## 1.11.1

### A Shot Summary no longer gives stoppedOnWeight

The REST API's `GET /api/shots/summary` and the MCP endpoint's
`summarise_shots` no longer give `stoppedOnWeight`, the share of Shots their
target weight stopped, which the management interface stopped reading in
1.11.0. A request that names it in `numbers` is refused, as one naming any
number the server doesn't know is. A script or assistant that read it reads
`stoppedAtTarget` instead, which counts a stop at the target volume too and
says how the rest stopped (`GLOSSARY.md`, Stopped at target).

## 1.10.1

### Tablets need Decaid v0.9.2, DYE2 v0.1.40 and Streamline v0.2.27

This release follows Decaid v0.9.2, DYE2 v0.1.40 and Streamline v0.2.27
([ADR-0017](docs/adr/0017-supported-versions.md)). Decaid installs the latest
DYE2 and Streamline on each tablet within 12 hours by itself. A tablet whose
DYE2 or Streamline is pinned to an earlier build is moved by hand, before
deploying, in this order:

1. Move its Streamline to v0.2.27 or later, and its DYE2 to v0.1.40 or later.
   Decaid v0.9.2 bundles DYE2 v0.1.37 and puts it over a lower DYE2 as it
   starts, a pinned one included, and every recipe DYE2 saves from v0.1.37
   holds a feed rate that the strip of Streamline v0.2.24 or earlier refuses
   to apply.
2. Update its Decaid to v0.9.2 or later.

Then deploy the server. It refuses a tablet on Decaid v0.9.1 or older, and
its Machine's page says why, though 1.10.0 still accepts one while it serves
beside this release. Nothing refuses an older DYE2 or Streamline, but nothing
is written for what they do.

### A Recipe is the whole Shot

From DYE2 v0.1.37 and Streamline v0.2.25 a recipe is the whole shot, not an
overlay on the one applied before it, and Decent Sync follows
([ADR-0022](docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md)).
Nothing is needed, but baristas will see:

- **A recipe leaves the Machine with none of what it names none of.** A
  Machine that loads a Recipe naming no Grinder, grind setting, RPM, feed
  rate, Basket, dose or Bean Batch is left with none, and with stop-at-weight
  off where it names no yield. Before, it kept the last recipe's, and the
  Recipe took them as its own as it loaded. A Recipe now gains a value only
  as a barista sets or picks it on a Machine that has it loaded. The steam,
  hot water and flush settings are as before: a Machine keeps its own for
  those the Recipe holds none of. Check that each Recipe names what its Shots
  should record, such as its Grinder and Basket.
- **A part cleared from a Recipe is cleared on the Machines that have it
  loaded,** as any other edit reaches them. Before, they kept it until the
  Recipe was applied again. A Machine still holding one cleared from its
  Loaded Recipe before this release is cleared of it as its tablet next
  connects.
- **A grinder pick moves the grind setting and RPM.** Picking a grinder on a
  tablet, on DYE2's dashboard, its Grinders page or its grinder picker, sets
  the grind setting and RPM to that grinder's defaults, or to none where it
  declares neither. With a Recipe loaded, the Recipe takes the Grinder with
  them, on every Machine that has it loaded. A Grinder changed in the
  management interface, or in DYE2's recipe editor, leaves them as typed.
- **Streamline follows the tablet's theme** wherever a barista never used
  Streamline's own toggle, so the Theme Tablet Setting now changes its look,
  as it next loads.
- **Streamline offers a reload when a newer build is on the tablet:** a
  notice to tap, 30 s after it starts and every 12 hours.
- **SAVE TO RECIPE on a favourite adds a Recipe,** in no slot, at the
  tablet's Location, from DYE2 v0.1.38. Before, it saved a favourite only.
  DYE2 saves it with its profile's title alone, so the Recipe names no
  Profile until one is picked for it.
- **DYE2's profile picker moves the dose and yield.** Its Confirm writes the
  profile's yield and the dose at the ratio the Machine held. On the Loaded
  Recipe's own profile these are the Recipe's edit, with that profile's own
  brew temperature; on another profile the Recipe is unloaded, as before.

A Recipe's dose, grind setting or RPM of 0 is now none, as DYE2 applies one,
and DYE2's editor saves an RPM left blank as 0. The management interface and
the MCP endpoint refuse a 0 for them: clear the field for none. A yield of 0
is stop-at-weight off, which a Recipe may hold, and a Shot pulled with it
shows no target yield. As it starts, this release's server removes a dose,
grind setting or RPM of 0 from every Recipe that holds one, a change of a few
rows per Location kept in each Recipe's history
(docs/AI_STORAGE_NOTES.md); tablets' records are left as they are, where a 0
reads as none.

Until 1.10.0's server is replaced, it may take a tablet's 0 in again, which
this release reads as none, and it still takes what a Recipe holds none of
from a Machine's Workflow as the Recipe loads: with DYE2 v0.1.40 and
Streamline v0.2.27, which clear the Workflow as they apply a recipe, that is
at most a yield of 0. A tablet still on 1.10.0's plugin is cleared of what
its Loaded Recipe names none of by this release's server, where its Skin
clears nothing.

### A Grinder's range and defaults are shared across its Location's Tablets

From DYE2 v0.1.37 a grinder may declare the range of its setting and of its
RPM, and a default for each: a tablet's steppers stop at the range, and
picking the grinder brings its default, or the middle of its range. DYE2
keeps them on the tablet they were typed on. A Grinder now holds them
([ADR-0022](docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md)), so
its Location's other tablets are written them, and a pick brings the same
numbers on every Machine. Nothing is needed.

- **Those typed already are taken in.** A range or default a tablet's record
  holds is taken into its Grinder as the tablet next connects, where the
  Grinder holds none. Where two tablets hold different ones for one Grinder,
  the first to connect gives its value, and the other tablet's is written
  over, so check each Grinder's page after deploying if baristas typed them
  on more than one tablet.
- **The Grinder's page and form** show and edit them beside its steps:
  Lowest setting, Highest setting, Default setting, Lowest RPM, Highest RPM
  and Default RPM. Blank is none, and 0 is a value. `create_grinder` and
  `edit_grinder` take them through the MCP endpoint, and what reads a
  Grinder gives them.
- **The rules are DYE2's.** A lowest above a highest is refused. A Grinder
  with named positions holds no range or default for its setting, and
  giving one named positions clears them. A default outside the range is
  accepted, and so is a Recipe's grind setting or RPM outside its Grinder's
  range: the tablet's steppers do the bounding.

A tablet still on 1.10.0's plugin, until Decaid updates it, cannot write a
Grinder's range or default into its record, so one changed elsewhere is
listed among that tablet's refusals ("Written, but its record still differs
as it did") until the tablet connects with this release's plugin, which
writes it. Its own are kept, and taken in. In the minute or so that 1.10.0
still serves beside this release, it takes none in: one typed in DYE2 then
stays on its tablet, and is taken in once this release serves it.

### Automatic update checks are shown, and changed on the tablet

Decaid v0.9.2 turns its automatic update checks on only for a request
carrying a token that may manage its plugins and Skins, which the plugin has
none of. While they are off, Decaid installs no update of a plugin or Skin by
itself, this plugin's included. So a Machine's Settings card now shows
Automatic update checks without an edit, as managed in Decaid on the Tablet,
and the MCP endpoint's `edit_machine_settings` no longer takes it. Check on
each Machine's page that they are on. Where they are off, turn them on in
Decaid's settings on the tablet: until then its plugin updates only when
someone there presses Check for updates.

Until 1.10.0's server is replaced, its pages still offer the edit, and it is
refused: by Decaid, on a tablet still running 1.10.0's plugin, where it turns
the checks on, and by this release's plugin, which writes nothing. 1.10.0's
page then says the Tablet's plugin must update before it takes the change.
No update brings the edit back: change the setting in Decaid on the tablet.

### A flow multiplier edit lasts, over one set elsewhere

With Decaid v0.9.2 the Tablet keeps a Machine's flow multiplier once it is
written through it, by a Settings Edit or on Streamline's calibration page,
and writes it again each time the Machine connects. Decaid's reset of the
Machine's settings now leaves it, where v0.9.1 set it to 1. So an edit lasts,
and a flow multiplier set from elsewhere afterwards, such as on another
Tablet or in de1app, lasts only until that Tablet next connects to the
Machine. The Settings card says so beside the field. Nothing is needed.

### Managing a tablet's plugins from the network needs a token

Decaid v0.9.2 refuses a request from the network that installs, updates or
approves a plugin, unless it carries a token made on the tablet with "Manage
plugins and skins" turned on (docs/PLUGIN.md, A token for managing plugins).
Nothing is needed where the plugin is installed from Decaid's Plugins screen
and updates by itself, which need none.

## 1.10.0

### Check every tablet runs the 1.9.0 plugin before deploying

This release raises the wire revision, for Recipe Slots 6 to 9
([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md),
Deploying). Before deploying, check on each Machine's page that it runs the
1.9.0 plugin, the previous release's. A tablet still on the 1.4.0 plugin or
earlier is refused as too old until its plugin is updated, at the tablet or
through Decaid's API from its network with `POST /api/v1/plugins/update`.

### The next free Recipe Slot may be one of 6 to 9

A Location has nine Recipe Slots, and the management interface, the REST API
and the MCP endpoint now put a Recipe in any of them. Streamline's strip
shows slots 1 to 5 only: a Recipe in 6 to 9 is a button on a Skin that shows
nine, and is listed by DYE2. Nothing is needed, but the next free slot is now
the lowest free of the nine. Where slots 1 to 5 each hold a Recipe, a Recipe
created, copied or moved to the next free slot goes in the lowest free of 6
to 9, off Streamline's strip. Before, a new one or a copy was kept in no
slot, and a move was refused. Choose no slot to keep a new Recipe or a copy
as before.

This release's server writes a tablet still on the 1.9.0 plugin a Recipe in
slots 6 to 9 in no slot, until Decaid updates its plugin, and the Recipe
keeps its slot meanwhile.

### A tablet's network can read its Location's Shots

The plugin now serves a Skin on its tablet what the server holds: the Shots
at its Machine's Location, each of that Location's Recipes' Reference Shots,
the choice of a Reference Shot, and edits of a Shot's rating and note
(docs/PLUGIN.md, For a Skin's author). Decaid checks no caller, so anything
on a tablet's network can call the same endpoints. The server holds each
tablet to its own Machine's Location. That network can already change the
Workflow and delete the tablet's Shots through Decaid, so nothing is needed
where it is trusted with that. A Capture-only Machine's tablet is served
nothing from the server.

### The plugin's update needs no approval

This release's plugin adds those endpoints and no permission, and Decaid
asks for approval only of a new permission, so each tablet installs it by
itself, as a tablet on Decaid v0.9.1 did on its update check (docs/PLUGIN.md,
Updates).

### A rating reads in stars

The management interface now gives a Shot's rating in stars, up to five, as
DYE2 shows it, where it gave Decaid's number from 0 to 10: on a Shot's page,
in the Shots list, and in the Summary and Trend cards. A star is two points
of that number. Nothing is needed. The REST API and the MCP endpoint give
and take the rating from 0 to 10 as before.

## 1.9.0

### Stored Shots get their new numbers in the background

This release keeps, with each Shot, what its measurements show of how it
went: its time to first drip, the profile step it ended in, whether anything
poured, and its last recorded weight with the flow at the stop. Nothing is
needed. A Shot stored from now on has them at once. The Shots already stored
get theirs in the background, 20 at a time, starting as the server does, so
a large history takes a while. Until a Shot has them, a Shot Summary counts
it as awaiting its numbers and as poured, and its row gives neither its time
to first drip nor the step it ended in. While a deploy runs this release
beside the previous one, a Shot an instance of the previous release stores
gets them within the hour.

### The home page is the Overview

The management interface now opens on the Overview, a block for each
Location. The Shots list, with the summary and trend above its rows, is
under Shots as before. While a deploy runs this release beside the previous
one, a summary or trend read that reaches an instance of the previous
release shows an error, which the next read clears.

### The Barista filter finds every spelling of a name

A Barista is now a name without its case or the blanks around it, so
"jules" and "Jules" are one choice in the Shots list's Barista filter, one
group in a summary and one value for an assistant. Nothing is needed. A
saved address or an assistant's filter naming one spelling finds the Shots
of every spelling, so it may find more Shots than it did.

## 1.8.2

### Streamline v0.2.24 and DYE2 v0.1.36 are the minimums

This release follows Streamline v0.2.24 and DYE2 v0.1.36
([ADR-0017](docs/adr/0017-supported-versions.md)). It changes nothing the
plugin or the server does, so update each tablet whose Streamline or DYE2 is
pinned to an earlier release before or after deploying it. Tablets that
aren't pinned run both already, as Decaid installs each release within 12
hours.

- Streamline v0.2.24's heater switch turns steam back on at the steam time it
  was turned off at, where v0.2.23 turned it back on at 1 s. So once a tablet
  runs v0.2.24, a Recipe holding no steam time no longer takes 1 s from it,
  and 1.6.3's ask to give each Recipe a steam time before updating Tablets
  no longer applies. A tablet left on v0.2.23 still turns steam back on at
  1 s. A Recipe
  holding none still takes the time steam comes back with where that is not
  the time the Machine held as the Recipe was applied, as where it was
  applied while steam was off; giving it a steam time avoids that.
- A profile switch in Streamline v0.2.24 leaves the Workflow's dose and grind
  setting as they were, where Streamline has none saved for the profile. It
  unloads the Recipe as before.
- On DYE2 v0.1.36's Grinders page, a tap on a grinder picks it for the
  Machine at once, with no confirm, and a hold opens its editor, which the
  tap opened before. With a Recipe loaded, the tap changes the Recipe's
  Grinder on every Machine with it loaded, as any change of the Grinder on a
  Machine does. Its grind setting stays as it was.

## 1.8.0

### Settings History starts with this release

The server now keeps each Machine's Settings History: every change its
Tablet reports to its Machine Settings, Tablet Settings, scale, paired
devices, sensors, plugins and Skins, and the Settings Edit that made it.
Nothing is needed. As it starts, it takes each Machine's baseline from the
latest values stored, in the background. While a deploy runs this release
beside the previous one, a change that reaches an instance of the previous
release isn't recorded: the next change this release records is compared
with the value before it. Until a Tablet's plugin updates to this release,
its Settings Edits' changes are recorded as made outside Decent Sync.

### Who made each Workflow change

Each Workflow change recorded from this release says whether Decent Sync
made it, as when it loads a Recipe, or someone else did. Nothing is needed.
Changes recorded before, those a Tablet's plugin of the previous release
sends, and those an instance of the previous release stores during a deploy
say unknown.

## 1.7.0

### Assistants connect through `/api/mcp`, on by default

People can now connect AI assistants, such as Claude and ChatGPT, to the
server by adding its public URL followed by `/api/mcp`, and signing in to
approve them (the README's Connecting an assistant). Nothing is needed to
offer it. To leave it off, set `MCP_ENABLED=false`. A reverse proxy that passes
only some paths to the server passes `/.well-known/oauth-authorization-server`
and `/.well-known/oauth-protected-resource/api/mcp` too. While a deploy moves
traffic over, an app's request reaching an instance of the previous release
fails, once: `/api/mcp` answers 404 there, and the two `/.well-known/`
documents answer with the management interface's page rather than their JSON.

## 1.6.3

### Update Tablets to Streamline v0.2.23 once this release is deployed

This release follows Streamline v0.2.23
([ADR-0017](docs/adr/0017-supported-versions.md)), in which a steam time of 0
is steam off. Deploy it first, then update to v0.2.23 each tablet whose
Streamline is pinned to an earlier release, and its DYE2 to v0.1.35
(below). On Streamline v0.2.22 or later, the plugin of an earlier release
has DYE2 save into the Recipe the steam time Streamline picks as steam comes
back on, which then reaches every Machine with it loaded. Tablets whose
Streamline isn't pinned run v0.2.23 already, as Decaid installs each release
within 12 hours.

- A Recipe's steam time is 1 to 255 s, or none; a longer one, as DYE2's
  editor saved before v0.1.35, is taken as 255 s, the DE1's longest. As it migrates the database,
  this release makes each Recipe holding a steam time of 0 hold none, a
  version of its own in its history, and dismisses each open Conflict
  offering 0. A steam time of 0 saved in DYE2's editor is no edit: the
  Recipe's, or none, is written back over it.
- No steam time is written into a Machine's Workflow while its steam is off,
  as no steam temperature is, since Streamline would show it with the heater
  off. Its steam flow and milk stop still are.
- Turning steam back on takes the Recipe's steam time as well as its steam
  temperature, so the time Streamline comes back with is no edit. Nor is a
  time picked as steam comes back on, which the Recipe's is written over: a
  steam time set on Streamline's main page while the heater is off, or Auto
  Steam choosing a pitcher then, its flow kept. Pick it again once steam is
  on, and it becomes the Recipe's, as before.
- Once this release is deployed, give each Recipe holding no steam time one,
  those whose 0 the migration removed included, before updating pinned
  Tablets to Streamline v0.2.23. Once Streamline v0.2.23 has turned steam off
  itself, its heater switch turns it back on at 1 s where the recipe holds
  no time, as it then remembers the machine's 0 as the last steam time. DYE2
  saves that 1 s into a Recipe holding none, and it reaches every Machine
  with the Recipe loaded. A Recipe holding a steam time is put back to it.
  Tablets already on v0.2.23 are exposed until then, and so is a Recipe left
  without a steam time later.
- A fan threshold or refill kit written by a Settings Edit now lasts: on
  Decaid v0.9.1, Streamline's settings page no longer puts back the value it
  remembers, and the Settings card no longer says it does. A page left open
  from 1.6.2 shows that note until it reloads.

Deploy it as any release, beside 1.6.2. For the minute or so that 1.6.2
still serves beside it, a steam time of 0 it takes in from a tablet is read
as none by this release. A tablet still on 1.6.2's plugin writes a steam
time into a Workflow whose steam is off, and puts back only the steam
temperature as steam comes back on, until Decaid updates its plugin. A tablet
on this release's plugin connected to 1.6.2 leaves the Recipe's steam time out
of a Workflow whose steam is off, which 1.6.2 lists among that tablet's
refusals ("Written, but its record still differs as it did") until the Recipe
changes or the tablet connects to this release.

### Update Tablets to DYE2 v0.1.35 once this release is deployed

This release follows DYE2 v0.1.35
([ADR-0017](docs/adr/0017-supported-versions.md)), which adds a feed rate to
its recipes and grinders, and changes how it saves steam settings and Auto
Favourites. Deploy it first, then update to v0.1.35 each tablet whose DYE2 is
pinned to an earlier release. Tablets whose DYE2 isn't pinned run v0.1.35
already, as Decaid installs each release within 12 hours.

- A Recipe holds a feed rate beside its RPM, text as typed: a manual feed
  such as "MF", or a feeder's RPM. It follows a Machine's Workflow as the
  RPM does. Set in DYE2's recipe editor or the management interface, it
  reaches every Machine at the Location. Changed on a Machine with the
  Recipe loaded, it is saved into the Recipe, and loading a Recipe writes it
  into the Workflow.
- A Grinder holds DYE2's feed rate note, the feed rates it takes, such as
  "manual FF/MF/SF". DYE2 keeps it in the grinder record's `extras`, where
  this release writes it too. The Grinder's page shows and edits it.
- DYE2's Auto Favourites page now saves a favourite rather than a recipe, so
  it adds nothing to the Library. Applying a favourite unloads the Recipe,
  as before.
- DYE2 now saves a steam flow or milk stop changed while steam is off, so it
  becomes the Recipe's edit then rather than once steam is back on.
- DYE2's editor shows a steam time of 0 as "Off", saves a steam temperature
  of "Off" with a steam time of 0, and stops a steam time at 255 s. Saving
  either turns steam off on that Machine, heater included, where a steam
  time of 0 used to leave the heater on. The Recipe keeps its own steam
  temperature and time, as before.
- A steam temperature or time saved in DYE2's editor on a Machine whose
  steam is off turns steam back on, and is now kept as the Recipe's edit.
  Before, the plugin could put the Recipe's previous value back over it.

A tablet still on 1.6.2's plugin, until Decaid updates it, can write neither
a Recipe's feed rate into its Workflow nor a Grinder's note into its record.
So a feed rate changed on a Recipe loaded there, or a Grinder's note changed
elsewhere, is listed among that tablet's refusals ("Written, but its record
still differs as it did") until it changes again or the tablet connects with
this release's plugin, which then writes it. Its recipe records take the
feed rate still, which DYE2 applies. In the minute or so that 1.6.2 still
serves beside this release, it takes in no feed rate, and a Grinder's note
this release stored may be listed so among the refusals of a tablet it
serves. A feed rate or Grinder's note saved in DYE2 then is kept on the
tablet, and taken in once this release serves it, where the Recipe or
Grinder holds none. Where two tablets saved different ones for the same
Recipe or Grinder, the first to connect gives its value, and the other
tablet's is written over.

## 1.6.2

### Tablets need DYE2 v0.1.33 and Streamline v0.2.21

This release follows DYE2 v0.1.33 and Streamline v0.2.21
([ADR-0017](docs/adr/0017-supported-versions.md)), so Streamline's minimum is
a release again, rather than a build of `main`. Decaid installs both on
every tablet within 12 hours of their release. Check that a tablet whose DYE2
or Streamline is pinned runs them or later.

- A Recipe applied again on a Machine after its Profile was edited in the
  management interface stays loaded there.
- A Profile edit, or a load from an out-of-date copy, reaches a Machine with
  its Recipe loaded in one Workflow write, so a Shot pulled at that moment is
  no longer left linked to no Recipe. A tablet still on 1.6.1's plugin writes
  it as two until Decaid updates its plugin.
- An edit of a Machine's steam purge mode or a heater setting lasts: from
  v0.2.20, Streamline's settings page keeps a setting changed elsewhere. It
  still puts back the value it remembers where the Machine reads a fan
  threshold of 50 or a refill kit of Auto-Detect, which the Settings card now
  says beside those two alone. A page left open from 1.6.1 shows the old
  notes until it reloads.

Check each tablet's wake profile. Streamline's "Load Profile on Wake"
(Settings, Wake Lock) works again from v0.2.19: a wake onto a profile other
than the Loaded Recipe's own sends that profile, which unloads the Recipe each
time the Machine wakes. Turn it off on a Machine that follows Recipes.

## 1.6.1

### A Recipe is shown on the strip by its slot alone

A Recipe no longer keeps a "Shown on the dashboard" setting of its own: it is
on Streamline's strip exactly while it is in a Recipe Slot (below). As it
migrates the database, this release takes each Recipe 1.6.0 left in a slot
but hidden out of that slot, so each strip still shows that button empty;
put the Recipe in a slot again to show it. The setting is dropped from every
Recipe, and each open Conflict over it is dismissed. Past versions in a
Recipe's history still show it.

Deploy it as any release, beside 1.6.0. For the minute or so that 1.6.0
still serves beside it:

- A recipe hidden by Streamline's "Clear button" on a tablet connected to
  1.6.0, or with the switch on a 1.6.0 page, is shown again, as this release
  writes a record shown exactly while its Recipe is in a slot. Hide it again
  once the deploy is done.
- A "Shown on the dashboard" value 1.6.0 saves then stays in the Recipe,
  where nothing reads it.
- A tablet still connected to 1.6.0 is written its recipe records without
  whether they are shown, which DYE2 and Streamline read as shown, until it
  connects to this release.
- A page of the management interface left open from 1.6.0 reloads at its
  next navigation. Until then, its Recipe page can't create a Recipe or use
  the switch, which this release refuses.

Let each tablet update its plugin promptly, as Decaid does within 12 hours:
the server writes the records of each Recipe naming no Bean once more, with
DYE2's explicit nulls for one (below), and only this release's plugin makes
that write.

### Tablets need Decaid v0.9.1 and DYE2 v0.1.32

This release follows Decaid v0.9.1 and DYE2 v0.1.32
([ADR-0017](docs/adr/0017-supported-versions.md)). Update Decaid on each
tablet to v0.9.1 or later before deploying: this release's server refuses a
tablet on an older Decaid, and its Machine's page says why, though 1.6.0
still accepts one while it serves beside this release. Decaid installs DYE2 on
every tablet within 12 hours of its release. Check that a tablet whose DYE2 is
pinned runs v0.1.32 or later.

With Decaid v0.9.1, an edit of a Machine's fan threshold or refill kit lasts
past the Machine reconnecting: the Tablet keeps the value and writes it again
each time it connects. So the Settings card no longer says they reset then,
and says instead that a replacement Tablet, or a reset of Decaid's data, puts
Decaid's default back. A page left open from 1.6.0 shows the old note until it
reloads.

Three things change with DYE2 v0.1.32:

- A Recipe naming no Bean means no bean as it is loaded: loading it, from
  DYE2 or Streamline's strip, leaves the Machine with no bean batch, and the
  load no longer gives it the Machine's. A batch picked once it is loaded is
  saved into it, with its Bean, as before. The server writes such a Recipe's
  records once more, with DYE2's explicit nulls for a Bean.
- A Recipe is on Streamline's strip exactly while it is in a Recipe Slot. The
  Recipe page's "Shown on the dashboard" switch is gone, and hiding a recipe
  on a tablet, by Streamline's "Clear button" or DYE2's switch, takes it out
  of its slot at its Location.
- A grind setting is kept as typed, as a three-dial grinder's `1.1.0`, and
  shown and edited so; one that reads as a number stays a number, and `.5`
  and `0.5` are one setting.

## 1.6.0

### Make Viewers once every instance runs this release

This release adds the Viewer, an account that sees everything Staff see and
changes nothing. 1.5.0 can't read an account or invite with that role: while
one exists, its Accounts page fails for Admins, and a Viewer's requests fail
on it. So invite a Viewer, or change an account to one, only once no 1.5.0
instance runs. Before rolling back to 1.5.0, change each Viewer to another
role, deactivated ones included, and revoke any Viewer invite still waiting.
1.5.0 then still fails to open the link of any other Viewer invite, used,
revoked or expired, rather than saying it can no longer be used. A Viewer
invite for an email that has since got an account through another invite
isn't listed to revoke, and keeps 1.5.0's Accounts page failing until it
expires, 7 days after it was made.

## 1.5.0

### Check every tablet runs the 1.4.0 plugin before deploying

This release is the first to raise the wire revision, for the Live View's
messages ([ADR-0025](docs/adr/0025-each-release-runs-beside-the-previous-one.md),
Deploying). Before deploying, check on each Machine's page that it runs the
1.4.0 plugin, the previous release's. Where one doesn't, update it at the
tablet, or through Decaid's API from its network with
`POST /api/v1/plugins/update`, or approve an update that adds a permission
with `POST /api/v1/plugins/decent-sync.reaplugin/update/approve`.

A Machine's Live View shows nothing live while its tablet runs the 1.4.0
plugin, or while an instance of 1.4.0 holds its connection during the deploy.

### Run the server from source on Node.js 26

The server now needs Node.js 26 or newer with Temporal, as nodejs.org's builds
have. It refuses to start without Temporal, which Node 24 lacks, as do some
packaged builds of Node 26, such as Homebrew's. The server image has it, so
Docker Compose and fly.io need nothing. Running from source, start this release
on Node.js 26. 1.4.0 runs on it too, so moving the old instance first is
optional.

## 1.4.0

### Upgrade without going offline from now on

This release runs beside 1.3.1, and each release from now on runs beside the
one before it. Pages opened from 1.3.1 don't reload into the new release by
themselves, as later pages do at their next navigation: reload them once after
upgrading.

On fly.io, set `fly.toml` up as docs/SELF-HOSTING.md's fly.io section now shows: a
blue-green deploy, a `wait_timeout`, a 10 s check interval and a
`kill_timeout` of 150 s. Deploy this release, then run `fly scale count 2`.
That deploy takes nothing offline, though 1.3.1 doesn't drain as it stops, so
a request under way on it then may fail.

A stopping server now still answers requests for 15 s
(`DRAIN_GRACE_SECONDS`), which a single instance has no use for. Set it to 0
there: with Docker Compose, add `DRAIN_GRACE_SECONDS: "0"` to the server's
`environment` in `docker-compose.yml`, as this release's file does. Otherwise
each later restart waits 10 s, until Docker kills the server.

### The health check reports the database in its body

`/api/health` answers 503 only while the server is stopping. While the server
can't reach its database, it answers 200 with `"database": "unreachable"` in
its body, so a proxy routing by it sends the server traffic again as soon as
the database is back, as after a failover. A monitor that took the 503 for the
database being down reads the body instead.

## 1.1.0

### Update DYE2 and Streamline on every tablet

This release follows DYE2 v0.1.26
([ADR-0017](docs/adr/0017-supported-versions.md)). A Machine that follows
Recipes needs DYE2 v0.1.26 or later and, where Streamline is its skin,
streamline-js from `main` at `cec5664` or later, as Streamline v0.2.18, its
latest release, cannot apply a recipe that holds a grinder or Basket. Decaid
installs the latest DYE2 and Streamline releases on every tablet within 12
hours, so DYE2 is likely there already; Streamline needs that build installed
until a release contains `ea04f83`.

### The migration keeps the database

The server's migration (`server/prisma/migrations/20261024000000_recipe_record_ids/migration.sql`)
runs as it starts, and keeps every Recipe, its history and its Shots' links.
Each Recipe takes a record id, the id of its record on every tablet at its
Location from now on: a Recipe in a slot keeps its slot's number, the id its
records have on the tablets now, and one in no slot is given a new one. A
Location has five Recipe Slots now, so a Recipe in slot 6 or higher leaves its
slot and stays at its Location. Every Recipe of a Location that is not
Archived is written to each of its tablets, those in no slot included, which
DYE2's Select Recipe page lists. What the rules this release drops kept is
dropped with them: each Loaded Recipe's record of what its load write replaced,
each tablet's recipe values from before the server's writes, the recipe records
removed from a slot, and whether each Shot's Workflow named a selection.

### Apply each Machine's recipe again

DYE2 v0.1.26 keeps no selection: it clears the field it wrote its selection
into, and names a recipe in the Workflow only as one is applied. The migration
also forgets which recipe each tablet's Workflow last named. So each Machine's
Loaded Recipe unloads at its next Workflow, and it has none until a barista
applies a recipe again, from Streamline's strip or DYE2's dashboard or Select
Recipe page. Shots pulled meanwhile are linked to no Recipe.

## 1.0.0

### Start the server on an empty database

This release's database migrations start again, from one that creates the
whole schema, so it doesn't upgrade a database an earlier release migrated:
the server refuses to start on one, as its migration finds the tables there
already. Drop the database, or give the server a new one, before starting
this release, then create the first Admin, the Locations and the Machines
again. The Library ids an earlier database wrote into each tablet's records
name nothing in the new one, so each tablet's report is taken in as its
first.

Adopting Machines again joins each to its Location, and the Location's
state wins (`docs/LIBRARY.md`, Joining a Location). At each Location, adopt
first the Machine whose tablet holds the beans, profiles, grinders, recipes,
baskets and tools the Location should keep: a kind the Location already has
is not taken from a Machine adopted after it, whose own are archived or
hidden on its tablet, and its DYE2 recipes, baskets and tools removed from
DYE2's lists. Turn sharing off for a Machine whose tablet's should stay as
they are.

### Install the plugin afresh on every tablet

Remove the plugin on each tablet (`DELETE /api/v1/plugins/decent-sync.reaplugin`
on the tablet's API, or under Decaid's Settings, Plugins), then install it
from this release as the README's Installing the plugin says, and give it
its Machine's new token. A fresh install takes its permissions, `emit`
among them, without the approval an update from 0.3.0 would wait on.
The plugin needs Decaid v0.9.0 or newer, and a Machine that follows Recipes
DYE2 built from `main` at `2cf631c` or later and, where Streamline is its
skin, streamline-js from `main` at `c006dac` or later
([ADR-0017](docs/adr/0017-supported-versions.md)).
