---
title: Install the plugin
description: "The steps at a tablet: installing the plugin in Decaid and connecting it to the server."
---

The plugin runs inside Decaid on each machine's tablet. These are the steps at
the tablet. [The tablet plugin](../../reference/tablet-plugin/) says what it
does once it is there.

## Requirements

| App | Minimum | Needed for |
|---|---|---|
| Decaid | v0.9.3 | Everything |
| DYE2 | v0.1.42 | Following Recipes |
| Streamline | v0.2.31 | Following Recipes, where Streamline is the skin |

The server refuses a tablet running an older Decaid, and the Machine's page
says why ([ADR-0017](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0017-supported-versions.md)).

## Installing

Decaid installs the plugin from this repository's GitHub releases. On the
tablet:

1. Open Decaid's **Settings**, then **Plugins**.
2. Open the menu at the top of the page and choose **Install plugin**, then
   **GitHub Release**.
3. Enter `loganfuller/decent-sync` as the repository.
4. Decaid asks whether to allow Decent Sync to manage plugins and skins, as
   the plugin asks for `manage.extensions`
   ([Permissions](../../reference/tablet-plugin/#permissions)). Choose
   **Allow and install**. **Cancel** installs nothing.

Or, from a computer on the same network, with a
[token for managing plugins](../../reference/tablet-plugin/#a-token-for-managing-plugins):

```bash
curl -X POST http://<tablet>:8080/api/v1/plugins/install/github-release \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"repo": "loganfuller/decent-sync"}'
```

Installed that way, Decaid asks nothing. Either way, it installs a plugin
without starting it. Connecting it to the server, below, ends by loading it.

## Connecting to the server

1. In the management interface, an Admin adds the Machine under **Machines**,
   at its Location. A Machine with no Location only captures (see
   [Capture-only Machines](../../reference/tablet-plugin/#capture-only-machines)). Adding it shows the server
   URL and the Machine's token once, with copy buttons.
2. On the tablet, under **Plugins**, open the menu beside Decent Sync, choose
   **Settings**, and enter both.
3. In the same menu choose **Load**, then turn on the **Auto-load on startup**
   switch on Decent Sync's card. A newly installed plugin is neither: it runs only once loaded, and
   without auto-load it stays stopped the next time Decaid starts. From a
   computer, this request does both, with the same token as the install:

   ```bash
   curl -X POST http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/enable \
     -H "Authorization: Bearer $TOKEN"
   ```

The plugin connects to `ws://<server host>/sync`, or `wss://` for an
`https://` server URL, and the Machine shows as online.

A lost Token can't be shown again
([What the Token is for](../../get-started/locations-and-machines/#what-the-token-is-for)).
If the Machine doesn't come online, the tablet says why in a notice under
Decaid's bell ([When the plugin stops syncing](../../reference/tablet-plugin/#when-the-plugin-stops-syncing)).

Decaid keeps the plugin up to date from then on ([Updates](../../reference/tablet-plugin/#updates)).
