---
status: superseded by ADR-0012
---

# Two repos: the plugin, and the server with its management interface

`decent-sync-plugin` stays a separate repo, because Decaid installs plugins from GitHub only when `manifest.json` and `plugin.js` sit at (or one folder below) the root of the archive. `decent-sync` (renamed from `decent-sync-server`) holds the server and the management interface, which the server builds and serves. Roux-specific work lives in a separate private repo that depends only on the REST API (ADR-0002).
