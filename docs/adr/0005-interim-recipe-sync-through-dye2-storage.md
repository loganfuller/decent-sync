---
status: accepted (interim, until Decaid has native Recipes and Equipment resources)
---

# Interim: sync recipes and equipment by writing DYE2's storage

Decaid has no Recipes resource. Recipes exist only in DYE2's plugin storage (`dye2.reaplugin/recipes`), and DYE2's KV contract says DYE2 is the only writer. Until Decaid has a native resource (proposed upstream), the Decent Sync plugin reads and writes that key itself, without needing DYE2 to change. That knowingly goes beyond the convention. It's safe enough because DYE2 re-reads the array and replaces one item each time it saves, so items written by someone else survive DYE2's edits.

DYE2's recipe ids are slot numbers, so a slot number is shared by every machine at a location ("Uptown slot 3"). The plugin merges slot by slot, last-writer-wins on `capturedAt`, and translates the profile, grinder and batch ids inside each recipe into the tablet's own ids. If the plugin reads a recipe shape it doesn't recognise, it stops writing and reports it, rather than risk corrupting DYE2's data. When a machine first joins a location, the location's slots win, as all its per-location state does (ADR-0008). The tablet's conflicting recipes are kept on the server for someone to re-slot.

The same approach covers the equipment DYE2 keeps in its storage (`baskets`, `equipment`: baskets, portafilters, drippers), because Decaid has no Equipment resource (decaid#727 was closed unmerged). Those items merge per item by id and are shared per location. Grinders sync through Decaid's own grinders API instead.

We rejected waiting for DYE2's maintainer to accept a sync-aware contract, and running a DYE2 fork, because either would tie this project's progress to someone else's release schedule.

Milestone 1 captures these keys read-only. This write strategy applies when Location sharing is implemented in milestone 3. The plugin is built in this repo under ADR-0012; the old `decent-sync-plugin` repo is archived.
