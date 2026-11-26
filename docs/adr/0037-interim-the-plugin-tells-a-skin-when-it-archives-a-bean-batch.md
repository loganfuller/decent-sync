---
status: accepted (interim, until Decaid tells of a bean's or a batch's record changing, asked for in decentespresso/decaid#1271)
---

# Interim: the plugin tells a Skin when it archives a Bean Batch on the tablet, or brings it back

A Skin may show a tablet's Bean Batches as Decaid holds them, and whether each is archived there: Streamline Cafe draws a Recipe's card, and the batch under Dose, in red once the batch is archived on the tablet (loganfuller/streamline-cafe-js#111). On a tablet, a batch is archived where it is not at the tablet's Location, so the server archives it there when it is finished at the Location, archived in the Library, or moved to another Location, and brings it back when it is added back (#714, in #702). The plugin makes those writes.

A Skin reads Decaid's record of a batch when something on its page asks for it, and learns of nothing in between. Decaid has no channel that says a bean's or a batch's record changed (`websocket_v1.yml`, as of v0.9.2), DYE2's `changed` push says only `{ "what": "workflow" }`, and the plugin's `changes` endpoint said only what ADR-0030 has it say. So a page left open on the counter keeps showing a batch the server has since archived until someone touches it. The proper fix is Decaid's: a channel there would carry every writer's change, DYE2's by hand included. It is asked for in decentespresso/decaid#1271. `AGENTS.md` asks that a workaround in the meantime be recorded as interim, naming the ask it waits on. This is that record.

Until Decaid has it, the plugin says so on its own `changes` endpoint, where a Skin already listens for the plugin's other pushes (ADR-0030):

```json
{ "what": "batch", "batch": "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca" }
```

- **It is said when a write of the plugin's changes the record's `archived`, either way**, once Decaid has answered the write: the record read before it and the one Decaid answered differ there (`archivedChanged` in `plugin/src/library-writes.ts`). That is a Library write that finishes, archives, adds back or restores a batch, and a joining Machine's own batch left out of the Library (ADR-0018). A write that leaves `archived` as it was, such as one of a remaining weight, or of a batch already archived, says nothing. Nor does a create: the server creates only the batches a Location offers, unarchived, and no page could show the record before.
- **It carries no state.** `batch` is Decaid's id of the tablet's record, as the Workflow's `beanBatchId` names it. A Skin showing that batch reads Decaid's record again, as it does when its page comes back into view, so Decaid's record stays the one source.
- **Only the plugin's writes.** A batch archived by hand on the tablet, in DYE2 or anything else, is not said: the plugin does not watch the record, and the server's later writes to it leave `archived` as the barista set it. That waits on decentespresso/decaid#1271.
- **Like the plugin's other pushes**, Decaid sends it only to the sockets open at that moment, and keeps none for a later one. A Skin still reads the record when its page loads or comes back.
- **Beside the previous release (ADR-0025).** The previous release's plugin says nothing, and a Skin ignores a `what` it doesn't know, as the Skin authors' page asks. Nothing on the wire to the server changes, so its revision does not rise.

## Considered options

- **Waiting for Decaid's channel.** The page on the counter stays wrong until then, in the commonest case, the server archiving a batch the cafe finished.
- **Having the Skin poll Decaid's batches.** Each Skin would read them every few seconds to catch a change that comes a few times a day, and would still miss DYE2's edits between polls. The push costs nothing while nothing changes.
- **Saying more in the push**, such as whether the batch is now archived, or the whole record. A Skin would then hold two sources for one record, and the push's copy would go stale with the next edit made elsewhere. Rejected: the push says only which record to read again.
- **Pushing on DYE2's `changed`, or the plugin's own `changed`.** Streamline reads any push there as the Workflow changing (ADR-0030 keeps it as it is), and a batch archived elsewhere changes nothing in the Workflow.

## Consequences

- When decentespresso/decaid#1271 is released, and the supported floor reaches that Decaid (ADR-0017), a Skin follows Decaid's channel instead, and a later release stops this push. The Skin authors' page will say when.
- A Skin that wants every change of a batch, DYE2's by hand included, still reads the record again when its page loads, comes back into view, or takes a choice of the barista's.
