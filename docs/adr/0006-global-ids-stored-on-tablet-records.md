---
status: accepted (amended in place on 2026-10-06, while scoping milestone 2)
---

# Shared items carry their global id on the tablet's own record

Each tablet assigns its own ids to beans, batches, grinders and so on, so the server gives every shared item a global id. The plugin writes that global id into the record's `extras` field on the tablet, and the server also keeps a `globalId ↔ localId` map per tablet. Putting the id on the record means a tablet restored from a backup or export still knows which shared item each record is, and the server can rebuild its map from what tablets report. A map held only on the server would lose those links whenever a tablet's database is restored.

## Consequences

- Decaid's update endpoints merge only top-level fields: a client that sends `extras` replaces the whole object. Another plugin or skin that updates a record with its own `extras` can wipe the global id. The plugin must notice a record losing its global id and restore it from the server's map, rather than treating the record as new.
- **Profiles keep Decaid's id.** A profile's id is a hash of what the machine executes (`profile:<hash>`), the same on every tablet, and profile records have no `extras`, so profiles need no global id. Their title, author and notes are outside the hash: renaming a profile on one tablet edits that same profile, and the new name reaches every tablet, last writer winning (ADR-0003).
- **The map is per tablet, not per machine.** Local ids belong to a tablet's Decaid data, which can be reset or replaced while the machine stays the same. Decaid exposes no installation id, so the plugin makes a tablet id on first run and keeps it in Decaid's plugin storage, which survives plugin updates and comes back with a Decaid backup. A tablet id the server hasn't seen is a new tablet: it joins as ADR-0018 describes, even on a known machine, and nothing missing from it counts as deleted (ADR-0019). Losing the plugin's storage only makes a tablet look new, which can miss a delete but never invent one.
