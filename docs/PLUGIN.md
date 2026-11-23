# The tablet plugin

The Decent Sync plugin runs inside Decaid on each machine's tablet. It sends
the server everything the tablet records, writes the shared Library and
Recipes back to the tablet, with a rating or note given to one of the
tablet's Shots through the server, and answers a Skin on the tablet about
what the server holds.

- [Requirements](#requirements)
- [Installing](#installing)
- [Connecting to the server](#connecting-to-the-server)
- [Settings](#settings)
- [Permissions](#permissions)
- [Updates](#updates)
- [Managing the tablet's software](#managing-the-tablets-software)
- [What it sends the server](#what-it-sends-the-server)
- [What it writes to the tablet](#what-it-writes-to-the-tablet)
- [Tablet identity and backups](#tablet-identity-and-backups)
- [For a Skin's author](#for-a-skins-author)

## Requirements

| App | Minimum | Needed for |
|---|---|---|
| Decaid | v0.9.3 | Everything |
| DYE2 | v0.1.42 | Following Recipes |
| Streamline | v0.2.31 | Following Recipes, where Streamline is the skin |

The server refuses a tablet running an older Decaid, and the Machine's page
says why ([ADR-0017](adr/0017-supported-versions.md)).

## Installing

Decaid installs the plugin from this repository's GitHub releases. On the
tablet:

1. Open Decaid's **Settings**, then **Plugins**.
2. Choose **Install Plugin**, then **GitHub Release**.
3. Enter `loganfuller/decent-sync` as the repository.

Or, from a computer on the same network, with a
[token for managing plugins](#a-token-for-managing-plugins):

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

### A token for managing plugins

While **Require authorization for extension management** is on in Decaid's
**Security** settings on the tablet, Decaid answers 401 to a request from the
network that installs, updates, approves, enables, disables or removes a
plugin or Skin, or saves a plugin's settings, unless it carries a token made
on the tablet, and 403 to one made without **Manage plugins and skins**
turned on. That setting is off on a new install and after an update from
v0.9.2, and is changed only on the tablet. While it is off, Decaid takes such
a request without a token and ignores an `Authorization` header, so the
`$TOKEN` header in the commands on this page does no harm there. Decaid v0.9.2
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
commands on this page do with `$TOKEN`. Whoever holds it can install code on
the tablet, and it crosses the network unencrypted, so use it only on a
network you trust, and revoke it on the same page when done.

## Connecting to the server

1. In the management interface, an Admin adds the Machine under **Machines**,
   at its Location. A Machine with no Location only captures (see
   [Capture-only Machines](#capture-only-machines)). Adding it shows the server
   URL and the Machine's token once, with copy buttons.
2. Enter both in the plugin's settings on the tablet.

The plugin connects to `ws://<server host>/sync`, or `wss://` for an
`https://` server URL, and the Machine shows as online.

A lost token can't be shown again. Issue a new one from the Machine's page.
This disconnects any tablet still using the old one.

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
Decaid refuses a notice, the plugin logs that, withdraws the notice it would
have replaced, and asks again only once what the notice should say changes.

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
([ADR-0034](adr/0034-the-plugin-manages-its-tablets-software-one-action-at-a-time.md)).
Decaid shows no warning on the tablet for a plugin installed through its API,
even one that asks for `manage.extensions`. Give the Admin role only to
people trusted with every tablet, and keep the server and its accounts as
secure as the tablets themselves.

The release that added `manage.extensions` and `notifications` together
waits for approval on each tablet once, as each adds a permission
([Updates](#updates)). That release's own update can't be approved from the
management interface, as the plugin it replaces takes no Software Actions.

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
([ADR-0023](adr/0023-decaid-and-the-machine-keep-their-settings.md)).

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
plugin release its tablet runs. [UPGRADING.md](../UPGRADING.md) lists what
each release needs.

A plugin works with a server of its own release, or of the release before or
after it ([ADR-0025](adr/0025-each-release-runs-beside-the-previous-one.md)).
So a tablet can take a plugin update before or after its server is upgraded.

## Managing the tablet's software

A Machine's Software tab shows its tablet's Tablet Software: Decaid, with the
update it offers, every plugin, with its version, whether it is enabled, how
it updates and any update that waits, and every Skin. Everyone who reads the
Machine reads it; the values of plugins' settings show to Admins only, and a
secret setting only as set or not set, to anyone.

An Admin acts on it through Software Actions, which the plugin carries out
through Decaid's own plugin routes with `manage.extensions`:

- install a plugin from a GitHub repository's latest release, or from a
  branch or commit, which pins it (Decaid installs by no release tag); a new
  plugin is installed disabled;
- enable or disable a plugin;
- change a plugin's settings, from a form built from what its manifest
  declares, secrets included; saving has Decaid load that plugin again;
- check the plugins for updates, with a result for each, and approve an
  update that waits on new permissions;
- remove a plugin with its settings;
- ask Decaid to check for its own update. Installing it still needs someone
  at the tablet.

Each is made once, only while the tablet is connected and the Machine runs
nothing, as a Settings Edit is, and never kept for later. The plugin carries
out one at a time, refuses one while the Machine is busy, and reads the
plugins back afterwards, so the Machine's Settings History ties what changed
to the action. Whatever it is sent, it never disables or removes itself, and
of its own settings changes only the poll interval: its server address and
Token are set on the tablet. An install from a repository whose plugin is
`decent-sync.reaplugin` replaces this plugin with that build, as Decaid
installs it: like every Software Action, it is an Admin's, trusted with the
tablet. A tablet still running the plugin of the
release before Software Actions is sent none until its plugin updates, and
its Software tab says so. [COLLECTIONS.md](COLLECTIONS.md#software-actions)
has the detail.

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
profiles with that Location's other Machines. [LIBRARY.md](LIBRARY.md) has the
full detail.

### What the plugin writes

- It adds the beans, batches, grinders and profiles entered on another tablet
  at the Location.
- It writes each bean's, batch's and grinder's Library id into the record's
  `extras`, keeping what other plugins store there.
- It sets each batch's remaining weight to the weight at its Location.
- It shows each Profile its Location shows.
- It sets the profile of a Draft its Machine follows as the Workflow's
  profile, where an Admin marked the Machine's Location for trying Drafts
  and someone had the Machine follow one: under the Draft's title with
  "(Draft)" after it, again each time the Draft is saved, and never as one
  of the tablet's Profiles. That ends the Machine's Loaded Recipe; its dose,
  yield, Bean Batch, Grinder and Basket stay. Any profile loaded on the
  tablet afterwards stays loaded: the plugin sets the Draft again only once
  someone has the Machine follow it again.

What the Location no longer offers, such as a batch finished there or a
Profile hidden there, is archived or hidden on the tablet, never deleted.

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
held of its own stays out of the Library, archived or hidden on the tablet,
unless the Location had none of that kind yet.

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
reached ([A Recipe's Reference Shot](#a-recipes-reference-shot)). The server
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
- **Older releases.** A server of 1.9.0 sends no copies, and a 1.9.0 plugin
  is sent none.

### A Shot's rating and note

A Shot's rating and note can be edited through the server, away from the
tablet that holds it
([ADR-0031](adr/0031-a-shots-rating-and-note-are-edited-through-the-server.md)).
The plugin writes such an edit into the Shot on the tablet that holds it, so
that tablet's Skin and DYE2 show what the server shows. It is the only thing
the plugin writes to a tablet's Shots by itself. A Skin may also have it
write the same two fields of the tablet's own Shot
([Editing a Shot's rating and note](#editing-a-shots-rating-and-note)).

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
- **Older releases.** A 1.9.0 plugin is sent no edit: one waits until the
  tablet's plugin is updated. A server of 1.9.0 sends none.

### Refused writes

If the tablet refuses a write, the plugin skips it and tries again once the
item changes or the tablet reconnects. The other writes go on. Each Machine's
page shows its sharing status: the changes waiting for its tablet, the last
change it applied, and the writes it refused, with Decaid's answer.

### Recipes

Recipes are shared through DYE2's storage. A Machine's Loaded Recipe is the
recipe that DYE2 and Streamline name in its Workflow when a barista applies
one. The plugin has DYE2 save each change made on the Machine into that
recipe ([ADR-0022](adr/0022-loaded-recipe-worked-out-from-the-workflow.md)).
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

## For a Skin's author

A Skin runs on the tablet and knows only Decaid's API, so it can show nothing
the server holds. The plugin serves it
([ADR-0030](adr/0030-the-plugin-serves-a-skin-what-the-server-holds.md)): a
Skin calls an HTTP endpoint of the plugin's on the tablet, the plugin asks
the server over its own connection, and the answer comes back in the same
call. So far a Skin reads the [status](#status), [the Shots at its Machine's
Location](#the-locations-shots), [any one of them whole](#a-shot-whole) and
[a Recipe's Reference Shot](#a-recipes-reference-shot),
[chooses a Recipe's Reference Shot](#choosing-a-recipes-reference-shot), and
[edits the rating and note of any Shot at the
Location](#editing-a-shots-rating-and-note). It may also edit a Recipe by
writing its DYE2 record itself ([Writing DYE2's
recipes](#writing-dye2s-recipes)).

### Calling the plugin

Decaid serves a plugin's endpoints beside its own API, each by its name alone:

| | Address |
|---|---|
| HTTP | `http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/<endpoint>` |
| WebSocket | `ws://<tablet>:8080/ws/v1/plugins/decent-sync.reaplugin/<endpoint>` |

- **Every answer is JSON.** A served request answers 200. A refusal answers
  another status, with a `code` and a `message` (see [Refusals](#refusals)).
- **Answers come quickly or not at all.** Decaid gives a plugin 30 seconds to
  answer. The plugin gives the server 10: a request still unanswered then is
  refused as `unreachable`. While the plugin isn't connected it refuses at
  once, without asking. Before it asks the server the plugin may ask Decaid
  first: for DYE2's recipes, to read which Recipe `reference` names, and to
  write [an edit of a Shot](#editing-a-shots-rating-and-note). Decaid's own
  API answers in milliseconds. Were it to take most of the 30 seconds, the
  call could run past them, and Decaid then answers it itself, with an
  `error` and no `code`. Treat that as `unreachable`: a choice or an edit
  may still have been made.
- **Nothing is queued.** A request refused as `unreachable` was not kept, and
  is not sent later. Ask again. That holds for
  [a choice](#choosing-a-recipes-reference-shot) and for
  [an edit of another tablet's Shot](#editing-a-shots-rating-and-note) too:
  one refused while the plugin isn't connected changes nothing, then or
  later.
- **Decaid answers some requests itself.** It answers 404 while the plugin
  isn't loaded, and for an endpoint the installed plugin doesn't have, such
  as `status` on the 1.9.0 plugin or an earlier one.
- **The status is asked at once.** It doesn't wait for what the tablet has
  still to send the server, so it answers while a tablet catches up after an
  outage.
- **Shots are asked once the tablet has caught up.** A request to `shots`,
  `shot` or `reference`, a choice included, goes to the server behind what
  the tablet had still to send as the Skin asked, so a Shot pulled a moment
  ago on this tablet is in the answer, and can be chosen.
  While a tablet catches up after an outage that can take longer than the 10
  seconds, and the request is refused as `unreachable`, whatever else would
  have refused it. For a moment after the plugin loads, while it reads back
  what it kept for the server, they are refused as `unreachable` at once.
  Ask the status, which doesn't wait, to learn whether the Machine is
  served. A `reference` refused so is answered from the tablet's copy where
  it has one.
- **An edit of a Shot is asked at once.** It waits for nothing the tablet
  has still to send, as it is of a Shot another tablet holds, so a Shot can
  be rated while a tablet catches up.

Anything on the tablet's network can call these endpoints, as it can Decaid's
own API but for managing plugins and Skins where Decaid asks a token for it
([A token for managing plugins](#a-token-for-managing-plugins)): Decaid
checks no caller of them.
That network can already change the Workflow and delete Shots through Decaid. The server holds each tablet to its
own Machine's Location, whatever a caller asks for.

### Status

`GET /api/v1/plugins/decent-sync.reaplugin/status` says whether the plugin is
connected to the server, whether its Machine is served, and which Machine and
Location it is. Call it to decide which screens to show.

A Machine is served while it takes part in the Library: at a Location, with
its sharing on, connected as itself. Served, it answers 200:

```json
{
  "connected": true,
  "served": true,
  "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70", "name": "Belmont Left" },
  "location": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a71", "name": "Belmont" }
}
```

Otherwise it answers the refusal every other endpoint would give at that
moment: that HTTP status, with the same fields and the refusal's `code` and
`message`. So `served` alone decides, whatever the status:

```json
{
  "connected": true,
  "served": false,
  "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70", "name": "Belmont Left" },
  "location": null,
  "code": "captureOnly",
  "message": "This Machine is a Capture-only Machine: it is at no Location, or its sharing is off, so it takes no part in the Library."
}
```

| Field | What it is |
|---|---|
| `connected` | Whether the plugin holds a connection the server has welcomed. |
| `served` | Whether the other endpoints answer for this Machine now. |
| `machine` | The Machine's id and name on the server. Null while the server wasn't asked or didn't answer, and for `hardwareMismatch`. |
| `location` | The Location the Machine is at, by id and name, whether or not it shares there. Null where it is at none, and wherever `machine` is null. |
| `code`, `message` | Why it isn't served. Absent while it is. |

Each call asks the server afresh. Nothing is remembered from the last answer.

### The Location's Shots

`GET /api/v1/plugins/decent-sync.reaplugin/shots` lists the Shots at the
Machine's Location, whichever Machine pulled them: the Shots the management
interface's Shots list lists for that Location. Newest first by when they
were pulled, a page at a time, with no filters.

| Query | What it is |
|---|---|
| `limit` | How many Shots the page may hold, from 1 to 50. 50 without it. |
| `cursor` | The `nextCursor` of the page before. Leave it out for the first page. |

```json
{
  "shots": [
    {
      "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e",
      "pulledAt": "2026-11-14T15:02:11.482Z",
      "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a72", "name": "Belmont Right" },
      "onThisTablet": false,
      "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
      "bean": { "roaster": "Roux Bakehouse", "name": "Ethiopia Guji" },
      "dose": 18.2,
      "targetDose": 18,
      "yield": 36.4,
      "targetYield": 36,
      "duration": 27.31,
      "rating": 8,
      "barista": "Sam",
      "hasNote": true,
      "unfinished": false,
      "referenceOf": [{ "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" }]
    }
  ],
  "nextCursor": "WzE3OTQ2Njg1MzE0ODIsIjBmNmMxYzVlLTBmMGEtNGQ2ZS05ZDBiLTZmMWIxYTJjM2Q0ZSJd"
}
```

| Field | What it is |
|---|---|
| `id` | The Shot's id, which is Decaid's. Read it whole with [`shot`](#a-shot-whole). |
| `pulledAt` | When it was pulled, in UTC. |
| `machine` | The Machine that pulled it, by its id and name on the server. Compare its id with the [status](#status)'s to tell this Machine's Shots from the others'. |
| `onThisTablet` | Whether this tablet is the one that last reported the Shot, so Decaid's own API has it unless it was deleted there since. |
| `recipe` | The Recipe it was pulled with, or null: its id and name on the server, and `recordId`, the id of this tablet's DYE2 record of it, which the Workflow names in `context.extras.dye.recipeId`. `recordId` is null where this tablet holds no record of the Recipe, as for another Location's Recipe, which a Shot names once its Machine's Location History is corrected. |
| `bean` | The coffee's `roaster` and `name`, as the Shot recorded them. |
| `dose`, `targetDose` | The dose weighed and the dose aimed for, in grams. |
| `yield`, `targetYield` | The yield weighed and the yield aimed for, in grams. |
| `duration` | How long it ran, in seconds, without its Preheat. |
| `rating` | Its rating on Decaid's scale of 0 to 10, where 0 is unrated. |
| `barista` | The Barista's name, as the tablet recorded it. |
| `hasNote` | Whether it has a note. |
| `unfinished` | Whether it is an Unfinished Shot, in which nothing poured: the Machine never reported pouring and the scale never showed 1 g in the cup, past a cup weighed before the Shot's tare. A cleaning or calibration Shot is never one. |
| `referenceOf` | The Recipes of this Location it is the Reference Shot of, each named as `recipe` is, by name. Empty for most Shots. An Archived Recipe is left out, and so is another Location's. |

A value the Shot didn't record is null. `nextCursor` is null on the last
page; otherwise send it back as `cursor` for the next. A cursor is the
server's to read: treat it as opaque. It stays good while Shots are pulled
or leave the list, so a Shot pulled since the first page isn't in a later
one. Read the first page again to see it.

A Shot leaves the list when an Admin corrects its Machine's Location
History so that it was pulled at another Location, and joins that
Location's.

### A Shot whole

`GET /api/v1/plugins/decent-sync.reaplugin/shot?id=<Shot's id>` gives one of
those Shots with its measurements:

```json
{
  "shot": { "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e", "timestamp": "…", "workflow": { }, "annotations": { }, "measurements": [ ] },
  "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
  "referenceOf": []
}
```

| Field | What it is |
|---|---|
| `shot` | The Shot's record with its `measurements`, as the server stores them, which is as Decaid sent them: what Decaid's `GET /api/v1/shots/<id>` gives on the tablet that holds it. Draw it with the code that draws the tablet's own Shots. |
| `recipe` | The Recipe it was pulled with, as a row names it, or null. |
| `referenceOf` | The Recipes it is the Reference Shot of, as a row names them. |

A tablet reads whole only a Shot its list would list. Any other is refused
as `noSuchShot`, whether or not the server holds it: another Location's, a
Shot that left the list, and an id that names nothing are answered alike.

A long Shot's record passes 1 MiB. It is read whole all the same, and takes
longer to arrive. Answers reach the tablet in turn, so ask for a few Shots
at a time: one still waiting behind the others after 10 seconds is refused
as `unreachable`, and the server leaves requests unanswered while a tablet
is far behind on what it asked for. An answer longer than about 16.7
million characters is never sent, so a Shot or a page that long is refused as
`unreachable` each time: no Shot Decaid records comes near it.

### A Recipe's Reference Shot

`GET /api/v1/plugins/decent-sync.reaplugin/reference?recipe=<record id>`
gives a Recipe's Reference Shot: the one Shot chosen to show how the
Recipe's Shots should go. Every tablet at a Location is given the same one,
whichever Machine or Location pulled it.

Name the Recipe by the id of its DYE2 record on this tablet: the id the
Workflow names in `context.extras.dye.recipeId`, which each of the tablet's
Shots records, and the `recordId` the other endpoints give. The plugin
turns it into the Recipe's own id, which the record carries.

```json
{
  "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
  "reference": {
    "shot": { "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e", "timestamp": "…", "workflow": { }, "annotations": { }, "measurements": [ ] },
    "recipe": null,
    "referenceOf": [{ "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" }],
    "rating": 8,
    "note": "Sweet, a little thin",
    "profileDiffers": false
  },
  "source": "server"
}
```

| Field | What it is |
|---|---|
| `recipe` | The Recipe asked about, named as a row's `recipe` is. |
| `reference` | Its Reference Shot, or null where it has none. |
| `reference.shot`, `.recipe`, `.referenceOf` | The Shot whole, as [`shot`](#a-shot-whole) gives one: its record with its `measurements`, the Recipe it was pulled with, and the Recipes of this Location it is the Reference Shot of. |
| `reference.rating` | Its rating on Decaid's scale of 0 to 10, where 0 is unrated. Null where it recorded none. |
| `reference.note` | Its note, or null. |
| `reference.profileDiffers` | Whether it was pulled on another Profile than the Recipe's: the Recipe names a Profile, and the Shot's is another, or none in the Library. Its curves then describe another program. False for a Recipe that names no Profile. |
| `source` | `"server"` where the server answered just now. `"tablet"` where it couldn't be asked and this is the tablet's copy, which may be older. |

- **The server is asked first.** While it answers, the answer is the
  server's, for a Recipe in a slot or in none.
- **The tablet's copy stands in while the server can't be asked.** The
  plugin keeps a copy for each Recipe in a Recipe Slot at its Location
  ([Reference Shot copies](#reference-shot-copies)). Where the request would
  be refused as `unreachable`, it answers 200 from that
  copy instead, with `source` `"tablet"`. That includes a copy saying the
  Recipe has none.
- **No copy, no answer.** A Recipe in no slot has no copy, and neither has
  one whose Reference Shot is too large to keep (1 MiB). Those are refused as
  `unreachable` while the server can't be asked.
- **A Reference Shot may be another Location's.** A tablet reads it whole
  through this endpoint all the same. Through [`shot`](#a-shot-whole) that
  Shot is still refused as `noSuchShot`.
- **A hidden Shot reads as none.** A Reference Shot whose Pending Machine was
  dismissed is `null` until that hardware is given a machine entry.
- **A record must be a Recipe of the Library's.** A `recipe` no record on the
  tablet has, or whose record carries no Recipe's id, as one a barista saved
  moments ago, is refused as `noSuchRecipe`. So is a Recipe of another
  Location.

Listen on [`changes`](#changes) for the push that says a Recipe's Reference
Shot changed, and read it again then.

### Choosing a Recipe's Reference Shot

`PUT /api/v1/plugins/decent-sync.reaplugin/reference?recipe=<record id>`
makes a Shot the Recipe's Reference Shot, from the tablet where it was
judged. Name the Recipe as a read does, by the id of its DYE2 record on this
tablet, and the Shot in a JSON body:

```json
{ "shotId": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e" }
```

It answers 200 with the Recipe's Reference Shot as it now is: what
[reading it](#a-recipes-reference-shot) gives, whole, with `source`
`"server"`. The server makes the choice as it makes one in the management
interface, and it reaches every tablet at the Location and the management
interface at once.

- **Any Shot the tablet can open.** A Shot in [the Location's
  list](#the-locations-shots), whichever Machine pulled it, or the Reference
  Shot of one of the Location's Recipes, which may be another Location's.
  Any other Shot is refused as `noSuchShot`.
- **Only the Location's Recipes.** A Recipe of another Location, which a
  tablet may still hold a record of for a moment after its Machine moves, is
  refused as `notAtThisLocation`. A record that carries no Recipe's id, or a
  Recipe the server no longer has, is refused as `noSuchRecipe`.
- **Not an Archived Recipe.** It is refused as `archived`, as in the
  management interface, until the Recipe is restored.
- **A tablet can't clear one.** A request names a Shot. One without a
  `shotId` is refused as `invalidRequest`. Clearing a Reference Shot is done
  in the management interface or by an assistant.
- **A Shot pulled a moment ago can be chosen.** The request follows what the
  tablet has still to send, so the server has the Shot by the time it is
  asked.
- **It is made now or not at all.** While the plugin isn't connected the
  request is refused as `unreachable` at once, without
  being sent, and nothing is kept to send later. The tablet's copy is no
  answer to a choice.
- **A choice the plugin sent may have been made, whatever it answers.** The
  plugin also answers `unreachable` when it sent the request and has no
  answer: its connection closed first, or 10 seconds passed. The server may
  have made that choice already, or make it within the next minute if it
  was still waiting its turn. The answer doesn't say which `unreachable` it
  is. So after one, read the reference again once the plugin is connected,
  or wait for the push, before showing the choice as failed.
- **No person is named.** The Recipe's history in the management interface
  names the Machine the Reference Shot was chosen on, and no account. Anyone
  at the tablet may choose.
- **The same Shot again changes nothing.** It answers 200 as the first time
  did, and adds nothing to the Recipe's history.

The tablet's own [copy](#reference-shot-copies) is replaced a moment after
the answer, for a Recipe in a slot, and a [push](#changes) follows it, on
this tablet and on the others at the Location.

### Editing a Shot's rating and note

`PUT /api/v1/plugins/decent-sync.reaplugin/shot?id=<Shot's id>` sets a
Shot's rating, its note or both
([ADR-0031](adr/0031-a-shots-rating-and-note-are-edited-through-the-server.md)).
It is one call for any Shot in [the Location's list](#the-locations-shots),
whichever tablet holds it: a Skin needn't know where a Shot is held. Send
what to set in a JSON body, and leave out what to leave alone:

```json
{ "rating": 8, "note": "Sweet, a little thin" }
```

| Field | What it is |
|---|---|
| `rating` | A number from 0 to 10, whole or not, on Decaid's scale, where 0 is unrated. |
| `note` | Text of at most 40,000 characters, where empty is none. |

It answers 200 with the Shot's rating and note as they now are:

```json
{ "rating": 8, "note": "Sweet, a little thin" }
```

`rating` is null where the Shot has none, and `note` where it has none or
only blanks, as [a Reference Shot's](#a-recipes-reference-shot) are.

- **The tablet's own Shot works without the server.** The plugin sends the
  edit to Decaid's own Shot update (`PUT /api/v1/shots/{id}`) first, with
  only the fields given. Where Decaid holds the Shot it is written at once,
  whether or not the plugin is connected, and whether or not the Machine is
  served: a Capture-only Machine's Skin rates its own Shots this way too.
  The edit reaches the server as any edit made on the tablet does, when the
  plugin is next connected, with no person and nothing added to the Shot's
  list of edits.
- **Any other Shot goes through the server.** Where Decaid answers that the
  tablet doesn't hold the Shot, the plugin asks the server. The server
  applies the edit at once, so the management interface, the Location's
  list and a Shot Summary show it, and writes it into the Shot on the
  tablet that holds it, now if that tablet is connected and otherwise when
  it next connects ([A Shot's rating and note](#a-shots-rating-and-note)).
- **Only the Shots in the Location's list.** Any other is refused as
  `noSuchShot`: another Location's, an id that names nothing, and the
  Reference Shot of one of the Location's Recipes that was pulled
  elsewhere, though the tablet can read that one.
- **Another tablet's Shot is edited now or not at all.** While the plugin
  isn't connected the request is refused as `unreachable` at once, without
  being sent, and nothing is kept to send later.
- **An edit the plugin sent may have been made, whatever it answers.** As
  for [a choice](#choosing-a-recipes-reference-shot), the plugin also
  answers `unreachable` when it sent the request and has no answer. After
  one, read the Shot again once the plugin is connected before showing the
  edit as failed.
- **The later edit of a field wins.** Where the rating or the note was
  changed on the tablet that holds the Shot later than this edit, without
  seeing it, that tablet's stands, and nothing is kept of the other. An
  edit of the rating never undoes a note, or the reverse.
- **The Machine is named, and no person.** The Shot's page in the management
  interface lists an edit made through the server with the Machine it was
  made on, and no account. Anyone at the tablet may edit.
- **Only the rating and the note.** Any other field in the body, a null, a
  rating outside 0 to 10, a note that is too long or holds a NUL or half of
  a surrogate pair, and a body with neither is refused as `invalidRequest`,
  whichever tablet holds the Shot, before Decaid or the server is asked. To
  clear a rating send 0, and to clear a note send empty text.
- **If Decaid refuses its own Shot's edit,** or doesn't answer, the request
  is refused as `shotUnwritten`, and the server is not asked.
- **Nothing is pushed** when a Shot is edited, but for [a Recipe's Reference
  Shot](#changes), whose copy on each tablet follows the edit. Read the
  list again to show an edit made elsewhere.

### Refusals

Every refusal is an HTTP status with a `code` to act on and a `message` to
show. A Skin refused as `unreachable`, `captureOnly` or
`hardwareMismatch` shows its tablet's own Shots.

| Code | Status | When |
|---|---|---|
| `unreachable` | 503 | The plugin isn't connected to the server, its connection closed before the answer came, or the server didn't answer within 10 seconds. |
| `serverTooOld` | 503 | Answered only by the plugins of 1.10.0 to 1.11.1, while connected to a 1.9.0 server during an upgrade; later plugins never answer it, as every server they work with has these endpoints. Treat it as `unreachable`. |
| `captureOnly` | 409 | The Machine is a [Capture-only Machine](#capture-only-machines): at no Location, or with its sharing off. |
| `hardwareMismatch` | 409 | The machine connected to the tablet is not the one the tablet's token was issued for. Its records wait as a Pending Machine's, or go to the Machine that hardware belongs to, until an Admin settles it on the Machines page. |
| `noSuchShot` | 404 | No Shot at the Machine's Location has the id asked for, or to be edited. For a choice: the Shot is none this tablet can open. |
| `noSuchRecipe` | 404 | No DYE2 recipe on the tablet has the record id asked for, or the one that has it is no Recipe of the Machine's Location. For a choice: its record carries no Recipe's id, or the server has no such Recipe. |
| `notAtThisLocation` | 403 | A choice only: the Recipe belongs to another Location than the Machine's. |
| `archived` | 409 | A choice only: the Recipe is Archived. |
| `recipesUnread` | 500 | Decaid didn't give the plugin DYE2's recipes, or gave them in a shape it doesn't recognise, so it couldn't tell which Recipe was asked about. Ask again. |
| `shotUnwritten` | 500 | An edit of the tablet's own Shot only: Decaid refused the update, or didn't answer it. The `message` gives Decaid's status. Ask again. |
| `invalidRequest` | 400 | The request is not one the endpoint can read: a `limit` that is no whole number from 1 to 50, a `cursor` no page gave, or no `id`, `recipe` or, for a choice, `shotId`, or one longer than 2,048 characters, or, for an edit, a body that sets neither a rating nor a note, or sets one to a value it can't take, or sets anything else. The `message` says which. |

The plugin answers some of these itself, at once, without asking the server:
`unreachable` while it isn't connected, `recipesUnread`,
`shotUnwritten`, `noSuchRecipe` for a record that carries no Recipe's id, and
`invalidRequest` for a `limit`, a missing `id`, `recipe` or `shotId`, an
`id`, `recipe`, `shotId` or `cursor` too long to be one, or an edit's body.
The server answers the rest, and tells a Machine that isn't served so
whatever it asked for, but for an edit of the tablet's own Shot, which the
server is never asked.

A request with a method an endpoint doesn't take answers 405, with an `error`
in place of a `code`. Every endpoint takes GET, and `reference` and `shot`
take PUT too.

### Changes

A Skin listens on the WebSocket endpoint `changes` rather than polling. Each
push is a JSON object whose `what` names what changed. So far there are two.

```json
{ "what": "connection", "connected": true }
```

It is sent when the server welcomes the plugin's connection, and when that
connection is lost. Read the status again after it: the Machine may have
moved, or its sharing changed, while the plugin was away.

```json
{ "what": "reference", "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" } }
```

It is sent when the tablet's copy of a Recipe's Reference Shot changes:
another Shot was chosen, on a tablet or anywhere else, or it was cleared,
the Shot's rating or note changed, or the Recipe entered a slot. It names
the Recipe as an answer does, `recordId` being the id of this tablet's DYE2
record of it. Read [`reference`](#a-recipes-reference-shot) again for that
Recipe if it is the one on screen.

- **Only Recipes in a slot are pushed.** A Recipe in no slot has no copy, so
  nothing is pushed when its Reference Shot changes. Read it again when the
  Skin shows it.
- **A tablet that was off is pushed what changed when it reconnects**, once
  the server has sent the copies it missed.
- **A push may repeat.** One is also sent when the Recipe is renamed, so
  compare what `reference` gives with what is drawn.

- Decaid sends a push only to the sockets open at that moment, and keeps none
  for a socket opened later. Read the status once the socket opens.
- A Skin can send nothing on this socket.
- Ignore a `what` you don't know. Later releases add more.

### Streamline's endpoints

The plugin's `skin` endpoint and its `changed` WebSocket are the ones
Streamline reads, and are unchanged. `changed` pushes only
`{"what":"workflow"}`, which Streamline reads as a change to the Workflow or
DYE2's recipes. Nothing above is pushed there.

### Writing DYE2's recipes

A Skin may edit a Recipe by writing its record in DYE2's list of recipes,
`recipes` under `dye2.reaplugin` in Decaid's store, as DYE2's editor does.
The Streamline Cafe Skin does so to change a Loaded Recipe's Profile or
Bean, renaming one still under the name DYE2 generated for it
([ADR-0022](adr/0022-loaded-recipe-worked-out-from-the-workflow.md)). The
server takes the record's change as the Machine's edit of the Recipe and
writes it to every tablet at the Location.

- **What the server reads.** `profileId`, `beanId` with `beanBatchId`,
  `name`, and the dial and settings in `dashboardVariables` that DYE2's
  editor saves. Beside a `profileId` it reads no `profileTitle` or
  `profileSnapshot`, and beside a `beanId` no `beanName` or `beanRoaster`.
  It rewrites `title`, `subtitle`, the names DYE2 copies and the embedded
  `workflow` from the Recipe, so a Skin writes those for DYE2 alone.
- **Write `beanId` and `beanBatchId` together.** `beanId` wins: a
  `beanBatchId` changed under the Bean the record names already is taken
  where the batch is of that Bean, and otherwise changes nothing. A `beanId` with no batch of its own gives the Recipe its batch of
  that Bean, or else that Bean's batch most recently added at the Location,
  or none. A `beanId` this tablet holds no record of is none, and clears the
  Recipe's Bean on every Machine.
- **Write the record before the Workflow.** Write the record, then the
  Workflow: its profile, or its `beanBatchId` with `coffeeName` and
  `coffeeRoaster`. With a new profile, write the record's brew temperature
  (`dashboardVariables.brewC`) too, and put the Workflow's profile at it:
  the other Machines are written the new profile at the Recipe's brew
  temperature, as DYE2 applies one. The plugin reads DYE2's recipes as a Workflow change
  moves the bean or the profile under a Loaded Recipe, and holds that change
  back until it has, so the server takes the record's edit first, and the
  other Machines have it within seconds. A profile changed in the Workflow
  alone unloads the Recipe, as DYE2 clears it, unless the record holds that
  profile already: DYE2 compares the Workflow's profile with the record's
  embedded `workflow.profile`, or else its `profileSnapshot`, so write the
  new profile there too, whole. The server takes the rest of a Workflow
  change that moves the profile, such as a batch picked with it, only where
  the record it has been reported holds the new profile already, as DYE2
  clears the recipe a moment after any other.
- **What is not taken.** An Archived Bean, or a batch held with its Bean
  that is Archived, of an Archived Bean or not at the Recipe's Location
  (never added there, or finished there), changes neither the Recipe's Bean nor its batch. A `profileId`
  that is none of the Library's Profiles changes none. Where a recipe names
  a profile the plugin has not read among the tablet's, it reads and sends
  the tablet's profiles before the recipes, so a profile saved on this
  tablet before the record that names it is the Library's by then. The Recipe's own is written back
  over the record, and nothing is offered or added at the Location. The
  Workflow keeps what was picked: such a batch stays that Machine's own,
  with the Recipe loaded.
- **The server renames nothing.** A Recipe's name changes only as a record
  or an edit sets it, so a rule renaming one under a generated name is the
  Skin's, written in the same record. On a Skin with no such rule, as
  Streamline, a Recipe keeps its generated name as its Bean changes.
- **Gaps.**
  - DYE2, the plugin and a Skin each rewrite DYE2's whole list, and
    Decaid's store takes no conditional write, so a write lost to another
    made at the same moment is never heard of. Read the list just before
    writing it, and change only your record.
  - A record written with no Workflow change, as a name edited on its own,
    reaches the server at the plugin's next poll, 30 s by default.
  - With a Recipe loaded, any bean batch picked that the Recipe's Location
    offers becomes the Recipe's, so a one-off Shot of another coffee can no
    longer be pulled under it without changing it.
