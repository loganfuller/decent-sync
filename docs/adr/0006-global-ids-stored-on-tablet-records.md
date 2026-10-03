# Shared items carry their global id on the tablet's own record

Each tablet assigns its own ids to beans, batches, grinders and so on, so the server gives every shared item a global id. The plugin writes that global id into the record's `extras` field on the tablet, and the server also keeps a `globalId ↔ localId` map per machine. Putting the id on the record means a tablet restored from a backup or export still knows which shared item each record is, and the server can rebuild its map from what tablets report. A map held only on the server would lose those links whenever a tablet's database is restored.

## Consequences

- Decaid's update endpoints merge only top-level fields: a client that sends `extras` replaces the whole object. Another plugin or skin that updates a record with its own `extras` can wipe the global id. The plugin must notice a record losing its global id and restore it from the server's map, rather than treating the record as new.
