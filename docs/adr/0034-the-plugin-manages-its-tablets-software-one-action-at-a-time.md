---
status: accepted
---

# The plugin manages its tablet's software, one action at a time

Each tablet's DYE2 and Skin were held at tested builds by hand: someone on the tablet's network posted to Decaid's install routes, and someone at the tablet reloaded the Skin. The owner wants to do this for a Machine anywhere, with no one at the tablet (#657, first raised as #542). Decaid v0.9.2 gave plugins a way: a manifest permission, `manage.extensions`, whose holder calls Decaid's plugin and Skin management routes in-process through `host.localApi`.

So the plugin holds `manage.extensions` and carries out **Software Actions** the server sends it: installing, updating, enabling, disabling, configuring and removing plugins; installing, choosing and removing Skins; reloading the Skin; and checking for updates. A Software Action is made as a Settings Edit is (ADR-0023): only while the tablet is connected and its Machine idle, never queued, and kept with who asked for it and what came of it. The server holds no build a tablet "should" run. It shows what each tablet reports and acts once when asked.

Four limits come with it:

- **Admins only**, as the permission is full trust: its holder can install any plugin and approve any permission, its own included. Staff may reload the Skin at their own Locations, which installs nothing.
- **Assistants get the reads and the reload only.** ADR-0026 keeps out of the MCP endpoint what grants access, and installing code on a tablet is that.
- **The plugin protects its own connection.** It can't be disabled or removed through a Software Action, and its server address and Token can't be changed by one. It may approve its own waiting update, so a release that adds a permission needs no one at the tablet.
- **How a plugin or Skin updates is shown, not switched.** Decaid has one tablet-wide setting for update checks and nothing per item, so each item is shown as Pinned, following releases, following a branch or not updated, from where it was installed. That setting becomes editable again, which ADR-0023 had put off until the plugin could manage plugins.

The Skin reloads in two ways. A Skin that tells the plugin each time its page loads is asked to reload itself, and the fresh page's report confirms it. Any Skin, a hung one included, is reloaded by stopping and starting Decaid's Skin server, which rebuilds the view. Decaid has no reload route (decentespresso/decaid#1029), and its maintainer has not said the rebuild will stay, so it is checked against each Decaid release.

This raises the Decaid minimum to v0.9.3 (ADR-0017) and amends ADR-0023.

## Considered options

- **The server holding the build each tablet should run, and keeping it there.** It would correct drift by itself, but it needs a policy for every way a tablet can differ, and the owner deploys by hand. It can be built on these actions later.
- **Calling the routes with the plugin's ordinary `fetch`.** Decaid v0.9.3 allows it only while the tablet's "Require authorization for extension management" setting is off, which nothing reports to the plugin.
- **Reloading only through the Skin.** A Skin that has hung, or one that knows nothing of the plugin, could not be reloaded.

## Consequences

- An Admin's account, or the server itself, can now put code on every connected tablet. Before this, the server could change settings and Library items only.
- The release that adds `manage.extensions` waits for approval on each tablet once. `notifications` (#540) is added in the same release, so it is one approval.
- Decaid's own update is shown, can be checked for and started, but not finished from the server: Android's installer asks someone at the tablet to confirm the update and tap Open, and Decaid does not reopen by itself (#659's trial).
- Decaid installs by latest release, branch, commit or URL, not by release tag (decentespresso/decaid#1030), so a Pinned build is named by its commit or URL. A Skin takes no commit as its branch, so a Pinned Skin is installed from its commit's archive URL (#661).
