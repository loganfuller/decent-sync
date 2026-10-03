---
status: accepted (supersedes ADR-0010)
---

# One repo, laid out the way Decent lays out its own plugins

Everything open source lives in `decent-sync`, an npm workspace (plain npm, no pnpm or monorepo tooling) with `plugin/` (TypeScript source), `decent-sync.reaplugin/` (the committed build), `server/` (Nest), `web/` (Vite) and `protocol/` (shared wire types, an internal package that is never published). `decent-sync-plugin` is archived with a pointer here.

This follows Decent's own repos, so Decent can adopt the project without restructuring it. DYE2 builds `dye2-plugin/` into a committed `dye2.reaplugin/`. shot-upload, dcamp and streamline-settings ship a committed `*.reaplugin/` folder released as a ZIP. None of them publish npm packages or use monorepo tooling. One repo also means one pull request changes both sides of the wire contract.

## Consequences

- Machines install and update through Decaid's release install, using just the repo name (`POST /api/v1/plugins/install/github-release` with `{"repo": "loganfuller/decent-sync"}`). Each release attaches exactly one `.zip`, holding `decent-sync.reaplugin/`.
- Branch installs no longer work, because the GitHub archive's wrapper folder plus `decent-sync.reaplugin/` puts the manifest two folders deep. Decent's own plugins don't rely on branch installs. For development, the plugin is uploaded directly over the tablet's API.
