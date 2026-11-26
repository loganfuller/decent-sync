---
title: The tablet plugin
description: "What the plugin is and does on a tablet: what it sends, what it writes, its settings and its updates."
---

The Decent Sync plugin runs inside Decaid on each machine's tablet. It sends
the server everything the tablet records, writes the shared Library and
Recipes back to the tablet, with a rating or note given to one of the
tablet's Shots through the server, and answers a Skin on the tablet about
what the server holds.

[Install the plugin](../../get-started/install-the-plugin/) has what the
tablet needs, installing the plugin and connecting it to the server.
[For a Skin's author](../../technical/skin-authors/) has what the plugin
answers a Skin.

## When the plugin stops syncing

While the plugin has stopped syncing, the tablet says why in one notice in
Decaid's notification center, which Decaid shows as a bell over any Skin.
The notice goes by itself once syncing resumes, or once the plugin is
connected again. A plugin with no server URL or token shows none, and a drop
shorter than 10 minutes shows nothing. The Machine's page in the management
interface shows the server's side of a refusal.

| When | What the tablet shows |
|---|---|
| Decaid is older than the server supports. The plugin stops until Decaid is updated, which restarts it. | Shots still save on this tablet and will upload later. Decent Sync stopped syncing because this tablet's Decaid is older than the Decent Sync server supports. Someone who manages Decent Sync can update Decaid on this tablet. |
| The plugin is older than the server supports. The plugin stops until it is updated. | Shots still save on this tablet and will upload later. Decent Sync stopped syncing because this tablet's Decent Sync plugin is older than the server supports. Someone who manages Decent Sync can update the plugin. |
| The server refused the token. The plugin stops until another token is entered. | Shots still save on this tablet and will upload later. Decent Sync stopped syncing because the server refused the token in this plugin's settings. Someone who manages Decent Sync can enter this machine's current token there. |
| An Admin dismissed the machine's hardware for this token. The plugin waits until the machine reports other hardware, checked every poll interval. | Shots still save on this tablet and will upload later. Decent Sync stopped syncing because an Admin dismissed the espresso machine connected to this tablet for the token in this plugin's settings. Someone who manages Decent Sync can give this machine a token of its own. |
| Another tablet is connected with this Machine's token. The plugin tries again every 5 minutes, and the notice goes once that tablet has gone and the plugin is connected. | Shots still save on this tablet and will upload later. Decent Sync stopped syncing because another tablet is connected with this machine's token, and it starts again once that tablet disconnects. Someone who manages Decent Sync can check which tablet should use the token. |
| The server has been out of reach for 10 minutes, with no connection in between. A connection resets the 10 minutes. Once the server is back, the notice goes at the plugin's next attempt, at most a minute later. | Shots still save on this tablet and will upload later. Decent Sync has not reached its server for 10 minutes. Whoever looks after this tablet's network can check that it is online and can reach the server. |

Decaid keeps the notice when the plugin loads again, such as after a settings
change or a restart, and the new load replaces or withdraws it once its first
connection attempt ends. Disabling or removing the plugin removes it. If
Decaid refuses a notice, the plugin logs that, withdraws an earlier notice of
its own that it would have replaced, and asks again only once what the notice
should say changes.

## Settings

| Setting | What it is |
|---|---|
| Server URL | The server's `PUBLIC_URL`, such as `https://sync.example.com`. |
| Token | The Machine's token. Decaid stores it securely. |
| Poll interval | Seconds between checks for changes on the tablet. Default 30, minimum 5. |

Each poll checks the library, Tablet Settings, paired devices, installed
plugins and their settings, Skins, Decaid's own update, scale, sensors and
Steam Records.

The machine's own settings are read every 60 seconds, or every poll interval
if that is longer, and whenever a Workflow change writes them. These reads
happen only while the machine is idle, asleep or out of water. A read that
falls due during a Shot, steaming, hot water, a flush or cleaning waits until
the machine is idle again. The sensors' calibration is read as the plugin
connects and once a day, also only while the machine is idle.

## Permissions

The plugin's manifest asks Decaid for these permissions:

| Permission | What the plugin does with it |
|---|---|
| `log` | Writes to Decaid's log. |
| `api` | Reads and writes Decaid's local API: the records, the Library, settings, devices, plugins and Skins. |
| `emit` | Tells a Skin on the tablet that something changed. |
| `events.machine`, `events.shots`, `events.workflow` | Hears machine state, Shots and Workflow changes as they happen. |
| `network.websocket` | Connects to the server, and to Decaid's own sockets. |
| `pluginStorage` | Keeps the tablet's id, what the server hasn't yet acknowledged, and a Software Action under way while Decaid loads the plugin again. |
| `manage.extensions` | Installs, enables, disables, configures, updates and removes the tablet's plugins, and turns its automatic update checks on or off, when an Admin asks through the management interface ([Managing the tablet's software](#managing-the-tablets-software)). |
| `notifications` | Shows one notice on the tablet while the plugin has stopped syncing, saying why ([When the plugin stops syncing](#when-the-plugin-stops-syncing)). |

`manage.extensions` is full trust. With it, an Admin's account, or the
server itself, can put code on every connected tablet: install any plugin,
change any plugin's settings, and approve any update's new permissions, the
plugin's own included. Before it, the server could change settings and
Library items only
([ADR-0034](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0034-the-plugin-manages-its-tablets-software-one-action-at-a-time.md)).
Decaid shows no warning on the tablet for a plugin installed through its API,
even one that asks for `manage.extensions`. Give the Admin role only to
people trusted with every tablet, and keep the server and its accounts as
secure as the tablets themselves.

The release that added `manage.extensions` and `notifications` together
waits for approval on each tablet once, as each adds a permission
([Updates](#updates)). That release's own update can't be approved from the
management interface, as the plugin it replaces takes no Software Actions.

## A token for managing plugins

While **Require authorization for extension management** is on in Decaid's
**Security** settings on the tablet, Decaid answers 401 to a request from the
network that installs, updates, approves, enables, disables or removes a
plugin or Skin, or saves a plugin's settings, unless it carries a token made
on the tablet, and 403 to one made without **Manage plugins and skins**
turned on. That setting is off on a new install and after an update from
v0.9.2, and is changed only on the tablet. While it is off, Decaid takes such
a request without a token and ignores an `Authorization` header, so the
`$TOKEN` header in the commands on these pages does no harm there. Decaid v0.9.2
asked the token whatever the setting. Decaid's own screens, its own update
checks and the plugin's Software Actions (below) need none, so the plugin
installs, updates and manages the tablet's plugins as this page says without
one.

To make a token, on the tablet:

1. Open Decaid's **Decent Account** page. No Decent Account sign-in is
   needed.
2. Under **API access tokens**, choose **Create**.
3. Name the token and turn on **Manage plugins and skins**.
4. Copy the token. It is shown only once.

Send it with each such request as `Authorization: Bearer <token>`, as the
commands on these pages do with `$TOKEN`. Whoever holds it can install code on
the tablet, and it crosses the network unencrypted, so use it only on a
network you trust, and revoke it on the same page when done.

## Updates

Decaid remembers where the plugin came from. It checks for a new release with
its other update checks, every 12 hours while it runs, or when you press
**Check for updates** under **Plugins**. So does this, with a
[token for managing plugins](#a-token-for-managing-plugins):

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/update \
  -H "Authorization: Bearer $TOKEN"
```

Decaid checks by itself only while its **Automatic update checks** setting is
on. While it is off, nothing on the tablet updates by itself, the plugin
included. A Machine's Software tab shows that setting, and an Admin turns it
on or off there, as a Settings Edit, while the tablet is connected and the
Machine idle. Decaid follows a change made this way when it next starts. It
is changed in Decaid on the tablet too
([ADR-0023](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0023-decaid-and-the-machine-keep-their-settings.md)).

- **An update that asks for no new permissions** installs by itself.
- **An update that adds permissions** waits under **Plugins**, saying it needs
  approval and which permissions it adds. An Admin approves it on the
  Machine's Software tab, where the tablet's plugin already takes Software
  Actions, and the Software Action is answered once the plugin has loaded
  again, with the version then installed. Or someone at the tablet presses
  **Review**, then **Approve and update**. Or send the tablet, with a
  [token for managing plugins](#a-token-for-managing-plugins):

  ```bash
  curl -X POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/update/approve \
    -H "Authorization: Bearer $TOKEN"
  ```

  Each tablet needs its own approval.

Only a new permission needs approval. A release that adds endpoints for a
Skin, as 1.10.0 adds `status`, `changes`, `shots`, `shot` and `reference`, installs by itself: Decaid compares the permissions of the installed plugin and the
update, and nothing else of their manifests (`_addedPermissions` in Decaid's
`plugin_source_service.dart`, read at v0.9.1 and v0.9.2). A tablet on Decaid
v0.9.1 updated from 1.9.0 to 1.10.0 on its update check, with nothing to
approve.

Until a tablet's update is approved, it keeps running the plugin it has, which
a server more than one release newer may refuse. Each Machine's page shows the
plugin release its tablet runs. The [Upgrade notes](../../reference/upgrade-notes/) list what
each release needs.

A plugin works with a server of its own release, or of the release before or
after it ([ADR-0025](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0025-each-release-runs-beside-the-previous-one.md)).
So a tablet can take a plugin update before or after its server is upgraded.

## Managing the tablet's software

A Machine's Software tab shows its tablet's Tablet Software: Decaid, with the
update it offers, every plugin, with its version, whether it is enabled, how
it updates and any update that waits, and every Skin. Everyone who reads the
Machine reads it; the values of plugins' settings show to Admins only, and a
secret setting only as set or not set, to anyone.

An Admin acts on it through Software Actions, which the plugin carries out
through Decaid's own plugin and Skin routes with `manage.extensions`:

- install a plugin from a GitHub repository's latest release, or from a
  branch or commit, which pins it (Decaid installs by no release tag); a new
  plugin is installed disabled;
- enable or disable a plugin;
- change a plugin's settings, from a form built from what its manifest
  declares, secrets included; saving has Decaid load that plugin again, where
  it is loaded;
- check the plugins for updates, with a result for each, and approve an
  update that waits on new permissions;
- remove a plugin with its settings;
- change how an installed plugin or Skin updates, from its row's menu: to
  follow a repository's releases or a branch, or to pin it, where it is now
  or to a commit, or for a Skin to a URL. Decaid records where an item came
  from only as it installs it, so the plugin installs it again from the
  source chosen, which may bring another version: a plugin keeps its
  settings and whether it is enabled, and a Skin stays the default. The
  item chosen is not changed where that source holds another plugin or
  Skin, or a plugin build older than the one installed, which Decaid
  refuses. The plugin removes the other item again, unless it was on the
  tablet already: that one stays, installed from the source. The result
  says which, and says so where a new one could not be removed. A Skin that comes with Decaid is not changed, as
  Decaid restores it from its own repository each time it starts
  ([ADR-0035](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0035-how-an-installed-plugin-or-skin-updates-is-changed-by-installing-it-again.md));
- install a Skin from a GitHub repository's latest release, a branch, or a
  URL serving a zip, such as a commit's archive
  (`https://github.com/<owner>/<name>/archive/<commit>.zip`), which pins it:
  Decaid installs no Skin from a commit given as a branch. The URL of one
  release's download (`…/releases/download/<tag>/<file>`) pins it at that
  tag too, which the form warns of, offering to follow the repository's
  releases instead;
- choose the default Skin, which shows the next time the Skin view
  restarts, and check the Skins for updates;
- remove a Skin that is neither the default, nor the one on screen, nor one that comes with Decaid;
- reload the Skin on screen, or restart the Skin view (below);
- ask Decaid to check for its own update, and start it: Decaid downloads it
  and opens Android's installer, where someone at the tablet must tap
  **Open**, and Decaid does not reopen by itself afterwards. Decaid refuses
  to start it until Android's permission for it to install apps ("Install
  unknown apps") has been granted at the tablet.

Each is made once, only while the tablet is connected and the Machine runs
nothing, as a Settings Edit is, and never kept for later. Only the check for
Decaid's update goes ahead while the Machine is busy. The plugin carries
out one at a time, refuses one while the Machine is busy, and reads the
plugins back afterwards, so the Machine's Settings History ties what changed
to the action. Whatever it is sent, it never disables or removes itself, of
its own settings changes only the poll interval, as its server address and
Token are set on the tablet, changes how it updates itself only to follow
the releases of its own repository or to pin one of its commits (of which
Decaid installs none, the repository's root not being the plugin), and never
removes the default Skin or the one on screen. An install from a repository whose plugin is
`decent-sync.reaplugin` replaces this plugin with that build, as Decaid
installs it: like every Software Action, it is an Admin's, trusted with the
tablet. A tablet still running the plugin of the
release before this is sent no change of how a plugin or Skin updates until
its plugin updates, which the form says; it takes every other Software
Action meanwhile. [COLLECTIONS.md](https://github.com/loganfuller/decent-sync/blob/main/docs/COLLECTIONS.md#software-actions)
has the detail.

### Reloading the Skin

The Skin on a tablet reloads in two ways, and both are open to Admins, to
Staff at the Machine's Location, and to an assistant acting for either
(`reload_skin`). Neither runs while the Machine is pulling a Shot, steaming,
flushing or pouring water.

- **Reload** asks the Skin on screen to load its page again. It is offered
  only for a Skin that reports its page to the plugin ([Reporting the page, and reloading](../../technical/skin-authors/#reporting-the-page-and-reloading)),
  and is done once the fresh page reports in, within 15 seconds; otherwise
  it is not confirmed, and the restart is the next step. The Software tab
  shows which build the tablet is showing and since when, and says when a
  newer build is installed than the one on screen.
- **Restart the Skin view** stops and starts Decaid's Skin server, which
  has Decaid build its Skin view again on the default Skin, a hung Skin or
  one that knows nothing of the plugin included. The screen is blank for a
  moment. The plugin checks the Skin server serves again, starts it once
  more if it does not, and says so plainly if the tablet is left showing no
  Skin. Decaid has no reload route of its own
  ([decentespresso/decaid#1029](https://github.com/decentespresso/decaid/issues/1029)),
  so each new Decaid release is checked for it ([DEVELOPMENT.md](https://github.com/loganfuller/decent-sync/blob/main/docs/DEVELOPMENT.md#steps)).

## What it sends the server

- **Shots and Steam Records.** Each time the plugin loads, it sends the server
  an index of the tablet's records, and the server asks for any it lacks.
  Nothing needs keeping on the tablet.
- **Workflow changes and machine state transitions.** Each Workflow change
  says whether one of the plugin's own writes made it, such as loading a
  Recipe. The plugin keeps those the server hasn't yet acknowledged in
  Decaid's plugin storage. So disabling the plugin, changing its settings or
  restarting Decaid while the server is unreachable loses none of them. The next load sends them first, unless the
  token was changed in the meantime. During a long outage, the plugin keeps
  the newest 2,000, up to 2 Mi characters, and drops the oldest.
- **The library, settings, paired devices, scale, sensors, plugins and
  Skins**, as each poll finds them, with each plugin's settings, a secret one
  only as set or not set, and Decaid's own update state. A setting a Settings
  Edit changed is sent naming the edit, and a plugin list or plugin settings
  a Software Action changed naming the action, for the Machine's Settings
  History.

## What it writes to the tablet

A Machine at a Location shares its tablet's beans, bean batches, grinders and
profiles with that Location's other Machines. [LIBRARY.md](https://github.com/loganfuller/decent-sync/blob/main/docs/LIBRARY.md) has the
full detail.

### What the plugin writes

- It adds the beans, batches, grinders and profiles entered on another tablet
  at the Location.
- It writes each bean's, batch's and grinder's Library id into the record's
  `extras`, keeping what other plugins store there.
- It writes each batch's Batch Code there too, under `decentSyncBatchCode`,
  as Decaid's record has no field for one yet. A code changed on the tablet
  is written over with the Library's.
- It sets each batch's remaining weight to the weight last entered at its
  Location, or to the amount a move brought there where it had none. That
  number does not change on the tablet as Shots are pulled or more is moved:
  the management interface shows the weight worked out from them.
- It shows each Profile its Location shows.
- It sets the profile of a Draft its Machine follows as the Workflow's
  profile, where an Admin marked the Machine's Location for trying Drafts
  and someone had the Machine follow one: under the Draft's title with
  "(Draft)" after it, again each time the Draft is saved, and never as one
  of the tablet's Profiles. That ends the Machine's Loaded Recipe; its dose,
  yield, Bean Batch, Grinder and Basket stay. Any profile loaded on the
  tablet afterwards stays loaded: the plugin sets the Draft again only once
  someone has the Machine follow it again.

What the Location no longer offers of these, such as a batch finished there
or a Profile hidden there, is archived or hidden on the tablet, never deleted.
Recipes, Baskets and Tools differ: one Archived is removed from DYE2's lists,
and stays in the Library
([Library and Recipes](../../guide/library-and-recipes/#what-is-shared-with-which-machines)).

A bean entered on a tablet may turn out to be a Bean already in the Library,
with the same roaster and name. A profile with the same steps as a Library
Profile is that Profile.

### What a barista's actions mean

| On the tablet | In the Library |
|---|---|
| Archive a batch | Finishes the batch at that Location |
| Un-archive a batch | Adds the batch back at that Location |
| Archive or delete a bean | Finishes the bean's batches at that Location |
| Archive or delete a grinder | Archives the Grinder, on every tablet at that Location |
| Hide or delete a profile, or change its steps | Hides the Profile at that Location |

### When a Machine joins a Location

A Machine takes on its Location's Library when it is adopted at the Location,
moved there, or has its sharing turned back on by an Admin. What its tablet
held of its own stays out of the Library, unless the Location had none of that
kind yet. Its own Beans, Bean Batches and Grinders are archived on the tablet
and its own Profiles hidden. Its own Recipes, Baskets and Tools are removed
from DYE2's lists, and not kept.

### Capture-only Machines

A Machine with no Location, or whose sharing an Admin has turned off, is
capture-only. The server still collects its records, but its library stays out
of the Library, and nothing from the Library is written to its tablet.
Settings Edits still reach it, and so does an edit of a
[Shot's rating or note](#a-shots-rating-and-note). The [Reference Shot copies](#reference-shot-copies)
its tablet kept are emptied.

### Reference Shot copies

The plugin keeps a copy of the Reference Shot of each Recipe in a Recipe Slot
at its Machine's Location, so a Skin still draws it while the server can't be
reached ([A Recipe's Reference Shot](../../technical/skin-authors/#a-recipes-reference-shot)). The server
sends the copies and keeps them current. They are the only thing of the
Reference Shot on the tablet: nothing is added to DYE2's recipes or to
Decaid's Shots.

- **Where.** In the plugin's own storage in Decaid, beside the tablet's id:
  nine values, `reference.1` to `reference.9`, one for each Recipe Slot. Each
  holds its slot's Recipe and that Recipe's Reference Shot whole, with its
  measurements, or that the Recipe has none.
- **When.** Each time the plugin connects it tells the server which copies it
  holds, and the server sends those that differ. While it stays connected, a
  copy is sent again within seconds when the Recipe's Reference Shot is
  chosen, replaced or cleared, when that Shot's rating or note changes, when
  the Recipe enters or leaves a slot or is Archived, and when the Shot is
  hidden because its Pending Machine was dismissed.
- **Removed.** A slot with no Recipe in it holds an empty value. Decaid's
  plugin storage can delete nothing, so the nine values stay, and each is
  written over as its slot changes.
- **Size.** A copy is tens of kilobytes. A Reference Shot whose copy would
  pass 1 MiB is not kept: that is the largest value Decaid's store takes
  through its own API (`largeRequestBodyBytes` in Decaid's
  `bounded_request_body.dart`, read at v0.9.1 and v0.9.2), and Decaid holds a
  plugin's whole storage in memory. Such a Shot is read from the server each
  time, and can't be read while the server can't be reached.

### A Shot's rating and note

A Shot's rating and note can be edited through the server, away from the
tablet that holds it
([ADR-0031](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0031-a-shots-rating-and-note-are-edited-through-the-server.md)).
The plugin writes such an edit into the Shot on the tablet that holds it, so
that tablet's Skin and DYE2 show what the server shows. It is the only thing
the plugin writes to a tablet's Shots by itself. A Skin may also have it
write the same two fields of the tablet's own Shot
([Editing a Shot's rating and note](../../technical/skin-authors/#editing-a-shots-rating-and-note)).

- **What.** The rating, on Decaid's scale of 0 to 10, where 0 is unrated,
  the note, where empty is none, or both. The plugin sends Decaid's own Shot
  update (`PUT /api/v1/shots/{id}`) only the fields the edit carries, in the
  Shot's annotations, so an edit of the rating leaves the note alone, and
  the reverse. Nothing else of a Shot is ever written.
- **Which tablet.** The one that holds the Shot: the tablet that last
  reported it to the server.
- **When.** At once while that tablet is connected, and otherwise when it
  next connects. Several edits of one Shot made meanwhile are written as
  one: the latest rating and the latest note among them.
- **Afterwards.** Decaid reports the Shot as updated, and the plugin sends
  that to the server as it sends any edit made on the tablet.
- **Never over a later change.** The plugin reads the Shot before it writes
  it. Where the tablet's Shot was changed since the version the server
  holds, in its Skin or in DYE2, the plugin writes nothing: the server
  takes in the tablet's report of that change, and then decides, field by
  field. A rating or note the tablet changed later than the edit
  stands, and the edit of it is dropped; one the tablet left alone is
  written. Later is judged by the tablet's clock against the server's, so
  a tablet whose clock is wrong can win or lose an edit it shouldn't.
- **A Shot the tablet no longer holds,** as after a reset, is written
  nothing. The edit stays on the server, which sends it no more.
- **Refused.** If Decaid refuses the update, the edit stays waiting on the
  server, and is tried again within a few minutes, with any edit of that
  Shot made since, and when the tablet next connects.
- **Capture-only Machines** are written their Shots' edits too: a Shot's
  rating is no part of the Library.

### Refused writes

If the tablet refuses a write, the plugin skips it and tries again once the
item changes or the tablet reconnects. The other writes go on. Each Machine's
page shows its sharing status: the changes waiting for its tablet, the last
change it applied, and the writes it refused, with Decaid's answer.

### Recipes

Recipes are shared through DYE2's storage. A Machine's Loaded Recipe is the
recipe that DYE2 and Streamline name in its Workflow when a barista applies
one. The plugin has DYE2 save each change made on the Machine into that
recipe ([ADR-0022](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md)).
That is why a Machine that follows Recipes needs DYE2 v0.1.42 or newer, and
Streamline v0.2.31 or newer where Streamline is its skin.

A Recipe is the whole Shot. As a Machine loads one, the plugin brings its
Workflow to the Recipe: it writes what the Recipe names, and clears the dose,
grind setting, RPM, feed rate, Grinder, Basket and Bean Batch it names none
of, with stop-at-weight off (a yield of 0) where it names no yield. DYE2 and
Streamline clear them as they apply a recipe, so the plugin then finds
nothing to write, and a Skin that applies a recipe by naming it in the
Workflow needs no clearing of its own. The steam, hot water and flush
settings the Recipe holds none of are left as the Machine has them.

Loading a Recipe switches the Machine's steam as the Recipe holds it: on at
its steam temperature and time, or off where it holds "Off", the same from
DYE2's dashboard, Streamline's strip and the plugin's own write. A Recipe
holding neither a steam temperature nor a steam time leaves steam as it is.
Steam turned off at the Machine changes no Recipe, and an edit to a Recipe
made elsewhere never turns a Machine's steam on; an edit to "Off" turns it
off on every Machine with the Recipe loaded.

A bean batch picked on a Machine with a Recipe loaded becomes the Recipe's
Bean and batch, of another Bean too, on every Machine that has it loaded.
One Archived, of an Archived Bean, or not at the Recipe's Location (never
added there, or finished there) stays that Machine's own.

## Tablet identity and backups

On its first run, the plugin gives the tablet an id. It keeps the id in
Decaid's plugin storage, where it survives plugin updates. The Machine's page
shows the tablet its latest connection came from, and its earlier ones.

Resetting the tablet's Decaid data, or replacing the tablet, makes a new
tablet on the Machine's page.

Restoring a Decaid backup brings back the original tablet only when both of
these hold:

- **The backup holds the id.** It does once Decaid's store API has read the
  plugin's storage since Decaid started. The plugin asks for that as it loads,
  and again every 30 seconds until Decaid answers.
- **The restore puts the id back.** Restore before installing the plugin, as
  Decaid's onboarding does, or choose to overwrite existing data.

Otherwise the tablet keeps the new id it was given, and shows up as a new
tablet.
