---
title: Releases
description: Where to find each release of Decent Sync, and what each added.
---

Every release is on
[GitHub](https://github.com/loganfuller/decent-sync/releases), newest first.
One version covers the server, the management interface and the plugin.

## What a release holds

- **Its notes.** They start with anything the release needs beyond its new
  image, which is also in the [Upgrade notes](../../reference/upgrade-notes/),
  followed by the changes merged since the release before.
- **The server image**, `ghcr.io/loganfuller/decent-sync`, tagged with the
  version, such as `1.13.1`, with its minor, `1.13`, and as `latest`.
  [Upgrading](../../self-hosting/upgrading/) says how to move to it.
- **The plugin**, as a ZIP attached to the release. Decaid installs each new
  one on a tablet that installed the plugin from a GitHub release, unless the
  update asks for a new permission or the tablet's update checks are off
  ([The tablet plugin](../../reference/tablet-plugin/#updates)).

## What each release added

The releases that finished a piece of work, each with the spec it was built
from. The releases between them fixed and refined what these added.

| Released | What it added | Spec |
|---|---|---|
| [v1.0.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.0.0) | Adopting Machines, Locations and accounts. Captures Shots, Steam Records, Workflow changes, machine state, the library, settings and paired devices. | [#1](https://github.com/loganfuller/decent-sync/issues/1) |
| [v1.0.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.0.0) | Beans, Bean Batches, Grinders and Profiles shared across Locations, with history and Lost Edits (Conflicts, until [#632](https://github.com/loganfuller/decent-sync/issues/632)). Shots linked to what they used. | [#77](https://github.com/loganfuller/decent-sync/issues/77) |
| [v1.0.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.0.0) | DYE2 Recipes, Baskets and Tools, Recipe Slots, and each Machine's Loaded Recipe. | [#134](https://github.com/loganfuller/decent-sync/issues/134) |
| [v1.2.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.2.0), [v1.5.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.5.0) | Settings Edits from the management interface, then each Machine's Live View. No remote commands such as sleep and wake. | [#220](https://github.com/loganfuller/decent-sync/issues/220), [#258](https://github.com/loganfuller/decent-sync/issues/258) |
| [v1.4.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.4.0) | Each release runs beside the previous one. | [#277](https://github.com/loganfuller/decent-sync/issues/277) |
| [v1.7.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.7.0), [v1.8.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.8.0) | AI assistants through an MCP endpoint, each approved as a Connected App, then answers sized for them, with more of each Machine and Shot. | [#405](https://github.com/loganfuller/decent-sync/issues/405) |
| [v1.9.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.9.0) | Shot Summaries by Recipe, Machine, Barista and more, with trends; an Overview of each Location; a Reference Shot for each Recipe; and each Machine's activity. | [#465](https://github.com/loganfuller/decent-sync/issues/465) |
| [v1.10.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.10.0) | A Location's Shots and each Recipe's Reference Shot on its tablets, for any Skin to show; a Reference Shot chosen on a tablet; a Shot's rating and note edited from another tablet, the management interface or an assistant; and nine Recipe Slots. | [#503](https://github.com/loganfuller/decent-sync/issues/503) |
| [v1.12.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.12.0) | Each Profile read on a graph of how it runs, simulated on a standard puck with any Shot laid over it; Drafts written on the graph, published as a new Profile Version or a separate Profile, and tried on a Machine at a Location marked for it, its Shots Trial Shots; and each Profile held to what its Machines' models can run. | [#574](https://github.com/loganfuller/decent-sync/issues/574) |
| [v1.13.0](https://github.com/loganfuller/decent-sync/releases/tag/v1.13.0) | Each Tablet's plugins, Skins and Decaid seen from the management interface, and its plugins and Skins managed there, on a Machine's Software tab; its Skin reloaded from anywhere and Decaid's own update started; and a notice on the Tablet saying why its plugin stopped syncing. | [#657](https://github.com/loganfuller/decent-sync/issues/657) |
| [v1.13.1](https://github.com/loganfuller/decent-sync/releases/tag/v1.13.1) | How an installed plugin or Skin updates changed from its row on a Machine's Software tab: following releases or a branch, pinned where it is now or to a commit, or a Skin from a URL; and a Skin from a release download shown as Pinned at its tag. | [#676](https://github.com/loganfuller/decent-sync/issues/676) |

[Roadmap](../../project/roadmap/) has what is planned next.
