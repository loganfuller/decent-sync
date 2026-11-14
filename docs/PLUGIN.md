# The tablet plugin

The Decent Sync plugin runs inside Decaid on each machine's tablet. It sends
the server everything the tablet records, writes the shared Library and
Recipes back to the tablet, and answers a Skin on the tablet about what the
server holds.

- [Requirements](#requirements)
- [Installing](#installing)
- [Connecting to the server](#connecting-to-the-server)
- [Settings](#settings)
- [Updates](#updates)
- [What it sends the server](#what-it-sends-the-server)
- [What it writes to the tablet](#what-it-writes-to-the-tablet)
- [Tablet identity and backups](#tablet-identity-and-backups)
- [For a Skin's author](#for-a-skins-author)

## Requirements

| App | Minimum | Needed for |
|---|---|---|
| Decaid | v0.9.1 | Everything |
| DYE2 | v0.1.36 | Following Recipes |
| Streamline | v0.2.24 | Following Recipes, where Streamline is the skin |

The server refuses a tablet running an older Decaid, and the Machine's page
says why ([ADR-0017](adr/0017-supported-versions.md)).

## Installing

Decaid installs the plugin from this repository's GitHub releases. On the
tablet:

1. Open Decaid's **Settings**, then **Plugins**.
2. Choose **Install Plugin**, then **GitHub Release**.
3. Enter `loganfuller/decent-sync` as the repository.

Or, from a computer on the same network:

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

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

## Settings

| Setting | What it is |
|---|---|
| Server URL | The server's `PUBLIC_URL`, such as `https://sync.example.com`. |
| Token | The Machine's token. Decaid stores it securely. |
| Poll interval | Seconds between checks for changes on the tablet. Default 30, minimum 5. |

Each poll checks the library, Tablet Settings, paired devices, installed
plugins and Skins, scale, sensors and Steam Records.

The machine's own settings are read every 60 seconds, or every poll interval
if that is longer, and whenever a Workflow change writes them. These reads
happen only while the machine is idle, asleep or out of water. A read that
falls due during a Shot, steaming, hot water, a flush or cleaning waits until
the machine is idle again. The sensors' calibration is read as the plugin
connects and once a day, also only while the machine is idle.

## Updates

Decaid remembers where the plugin came from. It checks for a new release with
its other update checks, every 12 hours while it runs, or when you press
**Check for updates** under **Plugins**. Sending
`POST http://<tablet>:8080/api/v1/plugins/update` does the same.

- **An update that asks for no new permissions** installs by itself.
- **An update that adds permissions** waits under **Plugins**, saying it needs
  approval and which permissions it adds. Someone at the tablet presses
  **Review**, then **Approve and update**. Or send
  `POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/update/approve`
  to the tablet. Each tablet needs its own approval.

Only a new permission needs approval. A release that adds endpoints for a
Skin, as the release after 1.9.0 adds `status` and `changes`, installs by
itself: Decaid compares the permissions of the installed plugin and the
update, and nothing else of their manifests (`_addedPermissions` in Decaid's
`plugin_source_service.dart`, read at v0.9.1 and v0.9.2; not yet seen on a
tablet).

Until a tablet's update is approved, it keeps running the plugin it has, which
a server more than one release newer may refuse. Each Machine's page shows the
plugin release its tablet runs. [UPGRADING.md](../UPGRADING.md) lists what
each release needs.

A plugin works with a server of its own release, or of the release before or
after it ([ADR-0025](adr/0025-each-release-runs-beside-the-previous-one.md)).
So a tablet can take a plugin update before or after its server is upgraded.

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
  Skins**, as each poll finds them. A setting a Settings Edit changed is sent
  naming the edit, for the Machine's Settings History.

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
Settings Edits still reach it.

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
That is why a Machine that follows Recipes needs DYE2 v0.1.36 or newer, and
Streamline v0.2.24 or newer where Streamline is its skin.

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
call. So far there is one, the status. The Location's Shots, Reference Shots
and a Shot's rating and note follow in later releases.

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
  once, without asking.
- **Nothing is queued.** A request refused as `unreachable` was not kept, and
  is not sent later. Ask again.
- **Decaid answers some requests itself.** It answers 404 while the plugin
  isn't loaded, and for an endpoint the installed plugin doesn't have, such
  as `status` on the 1.9.0 plugin or an earlier one.
- **A request follows what the tablet had still to send.** The plugin sends
  it once the server has taken what was waiting when the Skin asked, a Shot
  just pulled included.

Anything on the tablet's network can call these endpoints, as it can Decaid's
own API: Decaid checks no caller. That network can already change the
Workflow and delete Shots through Decaid. The server holds each tablet to its
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

### Refusals

Every refusal is an HTTP status with a `code` to act on and a `message` to
show. A Skin refused with any of these shows its tablet's own Shots.

| Code | Status | When |
|---|---|---|
| `unreachable` | 503 | The plugin isn't connected to the server, its connection closed before the answer came, or the server didn't answer within 10 seconds. |
| `serverTooOld` | 503 | The plugin is connected to a server of the release before these endpoints, as for a moment during an upgrade. Treat it as `unreachable`. |
| `captureOnly` | 409 | The Machine is a [Capture-only Machine](#capture-only-machines): at no Location, or with its sharing off. |
| `hardwareMismatch` | 409 | The machine connected to the tablet is not the one the tablet's token was issued for. Its records wait as a Pending Machine's, or go to the Machine that hardware belongs to, until an Admin settles it on the Machines page. |

A request with a method an endpoint doesn't take answers 405, with an `error`
in place of a `code`.

### Changes

A Skin listens on the WebSocket endpoint `changes` rather than polling. Each
push is a JSON object whose `what` names what changed. So far there is one:

```json
{ "what": "connection", "connected": true }
```

It is sent when the server welcomes the plugin's connection, and when that
connection is lost. Read the status again after it: the Machine may have
moved, or its sharing changed, while the plugin was away.

- Decaid sends a push only to the sockets open at that moment, and keeps none
  for a socket opened later. Read the status once the socket opens.
- A Skin can send nothing on this socket.
- Ignore a `what` you don't know. Later releases add more.

### Streamline's endpoints

The plugin's `skin` endpoint and its `changed` WebSocket are the ones
Streamline reads, and are unchanged. `changed` pushes only
`{"what":"workflow"}`, which Streamline reads as a change to the Workflow or
DYE2's recipes. Nothing above is pushed there.
