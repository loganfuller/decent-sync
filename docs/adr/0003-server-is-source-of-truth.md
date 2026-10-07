---
status: accepted (amended by ADR-0016, ADR-0019 and ADR-0020)
---

# The server is the source of truth, and tablets can still edit

Shared data (beans, batches, equipment, profiles, recipes) is owned by the server, and each tablet holds a replica. Tablets stay editable, because baristas will keep adding batches and dialling in recipes in Decaid and DYE2. A tablet's edit is sent to the server and then out to the other machines that share it. Conflicting edits to the same record are resolved last-writer-wins, and the management interface shows each conflict rather than overwriting silently. Profiles rarely conflict, because Decaid content-hashes them: an edited profile is a new profile.

We rejected management-interface-only editing, because it would force baristas off the tablet for routine work.

## Consequences

- **Last-writer-wins uses the time of the original edit.** Decaid sets `updatedAt` to now on every update, including the plugin's own sync writes. The server therefore keeps its own edited-at for each shared item: the tablet's `updatedAt` for a tablet edit, the server clock for a management-interface edit. The plugin hashes each record it writes (ignoring `updatedAt` and `extras`) so it doesn't report its own write back as a new edit.
- **Sync never hard-deletes.** A delete on any tablet archives the item for its whole scope (everywhere for beans and profiles, the location for equipment and recipes), so past shots still resolve. Only an admin can hard-delete, in the management interface, and only an item no shot refers to.
