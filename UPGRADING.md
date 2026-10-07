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
