# The tablet plugin

The Decent Sync plugin runs inside Decaid on each machine's tablet. It sends
the server everything the tablet records, and writes the shared Library and
Recipes back to the tablet.

- [Requirements](#requirements)
- [Installing](#installing)
- [Connecting to the server](#connecting-to-the-server)
- [Settings](#settings)
- [Updates](#updates)
- [What it sends the server](#what-it-sends-the-server)
- [What it writes to the tablet](#what-it-writes-to-the-tablet)
- [Tablet identity and backups](#tablet-identity-and-backups)

## Requirements

| App | Minimum | Needed for |
|---|---|---|
| Decaid | v0.9.1 | Everything |
| DYE2 | v0.1.35 | Following Recipes |
| Streamline | v0.2.23 | Following Recipes, where Streamline is the skin |

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
   [Capture-only Machines](#capture-only-machines)). This shows the server URL
   and the Machine's token once, with copy buttons.
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
the machine is idle again.

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
- **Workflow changes and machine state transitions.** The plugin keeps those
  the server hasn't yet acknowledged in Decaid's plugin storage. So disabling
  the plugin, changing its settings or restarting Decaid while the server is
  unreachable loses none of them. The next load sends them first, unless the
  token was changed in the meantime. During a long outage, the plugin keeps
  the newest 2,000, up to 2 Mi characters, and drops the oldest.
- **The library, settings, paired devices, scale and sensors**, as each poll
  finds them.

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
That is why a Machine that follows Recipes needs DYE2 v0.1.35 or newer, and
Streamline v0.2.23 or newer where Streamline is its skin.

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
