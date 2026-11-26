---
status: accepted (interim, until Decaid's bean batch record has a field for the roaster's own identifier, asked for in decentespresso/decaid#1263)
---

# Interim: a Bean Batch's Batch Code is kept in its record's `extras`

A Bean Batch holds a **Batch Code**: the roaster's own identifier for the roast, as on the bucket's label (#703, in #702). It is free text with no format, held once for the batch, the same at every Location, and unique among the batches that are not Archived. A Skin on a tablet shows it beside the batch, and reads a tablet's batches from Decaid, so the code has to be on Decaid's record of the batch.

Decaid's `BeanBatch` has no field for it. Its create and update keep a fixed set of fields and drop any other sent at a record's top (`decaid:lib/src/models/data/bean.dart`, v0.9.3), so a top-level field of our own would never be stored. The field is asked for upstream in decentespresso/decaid#1263. `AGENTS.md` asks that a workaround in the meantime be recorded as interim, naming the ask it waits on. This is that record.

Until Decaid has the field, the plugin writes the Batch Code into the record's `extras`, under a key of Decent Sync's own, `decentSyncBatchCode` (`BATCH_CODE_KEY` in `protocol/`), beside the record's global id, `decentSyncId` (ADR-0006). `extras` is Decaid's own place for what another app keeps on a record, and where DYE2 keeps a Grinder's feed rate note, range and defaults, which the plugin already writes there.

- **The server names the code as the batch's content does, and the plugin places it.** A write of a batch carries it as `batchCode`, with its other content. The plugin writes that one field under its key in `extras` rather than at the record's top (`Route.inExtras` in `plugin/src/library-writes.ts`), keeping the record's other keys there, as Decaid replaces `extras` whole. Clearing the code writes null under the key. So the wire has no new message, field or value, and its revision does not rise.
- **A tablet is not a source of Batch Code edits.** The server reads the key only to see whether a record holds the batch's code (`batchRecordValues` in `server/src/library/batch-intake.ts`), never as an edit: a value changed on a tablet, by another plugin, a Skin or a restored backup, changes nothing in the Library, leaves no entry or Lost Edit in the batch's history, and is written over with the batch's code, or with none. Nothing on a tablet edits the key today: DYE2's batch form has no field for it. An edit there would also have to be refused where another batch holds the code, and a tablet has no way to be told that.
- **Uniqueness is the server's and the database's.** The code lives in the batch's content (`batchCode`), and a unique index on its lower-cased, trimmed text over the batches that are not Archived decides it (`bean_batches_batch_code_key`), whatever instance or release writes. The management interface, the REST API and the assistant tools refuse a code another such batch holds as a conflict naming that batch, on a create, an edit and a restore. Two tablets' records never decide it.
- **A Skin reads `extras.decentSyncBatchCode`**, text, absent or null where the batch has none. The Skin authors' page says so, and that the key moves once Decaid has the field.
- **Beside the previous release (ADR-0025).** The previous release's plugin writes `batchCode` at the record's top, where Decaid drops it, so its tablet holds no code until Decaid updates the plugin, and that write is listed among the tablet's refusals ("Written, but its record still differs as it did") meanwhile, as a Grinder's range was. The previous release's server knows no code: it keeps a record's `extras` whole through its own writes, takes none in, and may list the same refusal for a batch that holds one while both releases serve.

## Considered options

- **A field at the record's top.** Decaid drops it. It would only work on a Decaid that has the field, which is what the ask is for.
- **Putting the code in the batch's `notes`, or the Bean's name.** That is what the owner does by hand today, and what the Batch Code replaces: neither can be unique, and a Skin could not tell the code from the note.
- **Serving it to a Skin through the plugin instead**, as the plugin serves what the server holds (ADR-0030). A Skin's batch rows then need the server, and show nothing while it can't be reached. The record is read from Decaid, so the code is there offline too.
- **Taking a tablet's change of the key as an edit.** Deferred with the field itself: once Decaid holds it and DYE2's form edits it, a later release moves the code to Decaid's field and takes a tablet's edit of it, with a way to refuse one another batch holds.

## Consequences

- When decentespresso/decaid#1263 is released, and the supported floor reaches that Decaid (ADR-0017), a later release writes Decaid's field instead, reads both places while tablets hold either, and then stops writing the key. A Skin reading the key must move with it, and the Skin authors' page will say when.
- Another app that rewrites a batch's `extras` without keeping its keys removes the code from that tablet's record, as it would the global id. The server writes both back.
- A tablet running the previous release's plugin shows no Batch Code until its plugin updates.
