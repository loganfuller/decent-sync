---
status: accepted (a simplification the owner expects to lift: see Lifting it)
---

# A Bean Batch is at one Location at a time

A roast goes into one bucket, and the bucket is in one place: the roastery lab, then a cafe. Until now a Bean Batch was at every Location it had been added at, until someone finished it at each (ADR-0008). Carrying a bucket to a cafe took two edits, one at each Location, and the one at the Location left was usually forgotten, so the lab went on offering a coffee it no longer had (#702).

**A Bean Batch is at one Location at a time. Adding it at a Location moves it there**: it is finished at every other Location it is at, in the same change, and the weight entered for it goes with it (#704).

- **One rule, in the one place a batch is added.** Every way of adding a batch at a Location obeys it, because each goes through the one function that adds one (`addBatchAt` in `server/src/library/location-state.ts`): the management interface and the REST placement route, the assistant tools, a barista un-archiving the batch's record on a tablet there, and a Recipe at the Location set to use a batch from elsewhere, or copied there with one. Nothing else makes a batch present anywhere.
- **Creating a batch takes exactly one Location.** None, or more than one, is a bad request, over REST and through the assistant tool, and the new batch dialog offers one. A batch finished where it is is at no Location, as before.
- **At the Location left, a move is a finish.** Its tablets archive their record, its Bean stops being offered there if it has no other batch there, and Recipes and Workflows that name the batch are treated exactly as a finish treats them: a Recipe goes on naming it and is marked as naming a batch that is finished there. Nothing new is built for them.
- **The weight is the batch's, wherever it is.** The Location joined takes the remaining weight entered at the Location left, with when it was entered and the entry that entered it, unless the move gives a new weight. Keeping the time keeps what is counted from it right: a weight entered before a move is the same entry after it. A batch with no weight entered where it was has none where it arrives. A batch at no Location, added at one, takes the weight from the Location it was finished at last. One added again where it already is keeps the weight it has there.
- **A move is one entry of the batch's history.** It is the entry of the Location joined, naming the Locations left and who or which Machine made it. The Location left keeps that entry as what decided the batch's presence there, so a later edit there that loses knows what it lost to. Nothing a move replaces at the Location left is kept as a Lost Edit: the move's entry says it. A tablet's un-archive that loses on time moves nothing and is a Lost Edit as before (ADR-0020, ADR-0033).
- **Who may move.** Staff may move a batch to a Location they work at from any Location, theirs or not, so a cafe's staff can receive a bucket without asking the roastery's. Finishing a batch without moving it, and entering its weight, still need the Location it is at. Admins may do either anywhere. So the check is on the Location named by the change, the one joined or the one finished at, as before.
- **Presence stays explicit, and its storage stays as it is.** ADR-0008 still holds: a batch is at a Location from when it is added there until it is finished there, never derived from its weight, and the per-Location state table (`batch_locations`) is unchanged, a row per Location the batch has been at. The rule is in the code that adds, not in the schema, and no constraint enforces it.

## Two moves at once

Several server instances serve one database (ADR-0016). Every change of a Location's state runs under that Location's advisory lock, and a move also changes the state of each Location it leaves, so it takes those locks too. Two adds of one batch at different Locations share no Location's lock when the batch is at none, so each add of a batch also runs under a lock of that batch.

The order is fixed, so no two changes wait on each other: each Location's lock, in id order, then each batch's, in id order, before any item's row (`lockForAdding`). A change learns which Locations a batch is at before it holds any of their locks, so the batch may reach another meanwhile. The move then takes that Location's lock only if it is free, and otherwise is made again from the start, three times before the request is refused as a conflict to try again; a tablet's delivery that meets it is redelivered, as after any failure that would not repeat.

## The upgrade

A batch at several Locations when the migration runs stays at the one it was added at last, with the weight entered there, and is finished at the others. It is one entry of the batch's history, attributed to the upgrade and naming the Locations it was finished at. The owner asked for this in #704, as a migration that changes data needs (`docs/AI_STORAGE_NOTES.md`).

The previous release serves beside this one while a deploy lasts (ADR-0025), and it still adds a batch at a second Location and leaves it at both. This release never fails on such a batch. Reads list each Location it is at, the one it was added at last first, which pages take as where it is. Any move of it finishes it everywhere else. And each instance settles such batches in the background, as it starts and every ten minutes, as the migration does (`BatchSettling`). That sweep is removed once no release that leaves a batch at two can serve beside the current one (#712).

## Lifting it

The owner expects to want a batch at several Locations later: a sample kept at the lab while the bucket goes to a cafe, or a roast split between two cafes. Until then the owner creates a second batch for the part kept back, with its own Batch Code or none.

Lifting the rule changes the rule and not the storage: `batch_locations` already holds a batch at several Locations, each with its own weight, and reads already list them. What changes is `addBatchAt`, which stops finishing the others, the request that creates a batch, which takes several again, and what a weight means once a batch is split, which is a decision of its own.

## Considered options

- **Leaving a batch at every Location it was added at**, and asking people to finish it at the one it left. That is what failed: the list of where a coffee is was wrong whenever someone forgot.
- **A unique index** keeping a batch to one Location in the database. The previous release's writes would break on it during a deploy, which ADR-0025 forbids, and it would have to be dropped again to lift the rule.
- **A single Location column on the batch.** It would make the rule a schema fact, take a two-release migration to bring in and another to lift, and lose each Location's own history of the batch.
- **A separate move operation beside add.** Two ways to make a batch present would be two places for the rule, and a tablet's un-archive, which has no way to say which it means, would need one of them chosen for it anyway.
- **Finishing at the Location left as a second history entry.** A person reading the history wants to know the bucket went from the lab to the cafe, which is one event.
