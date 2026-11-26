---
status: accepted (started on 2026-11-26, for ticket #706, with the first of the decisions #702 gives it: the weight is held per Location and worked out from the Shots pulled there. Moving weight between Locations, #704, adds the rest)
---

# A Bean Batch's Remaining Weight is held per Location and worked out from the Shots pulled there

Each Location could already hold a remaining weight for a batch (ADR-0008), but someone had to type it in and no Shot ever lowered it, so nobody did. #702 makes the number keep itself: a batch's **Remaining Weight** at a Location is the weight last entered there, less the dose of each Shot linked to the batch that was pulled at that Location after the entry. It is worked out when it is read (`usedSince` and `remainingAfter` in `server/src/library/bean-batches.service.ts`) and never kept as a running total.

- **One number is stored, and it is the one a person entered.** `batch_locations` keeps what it kept: the weight last entered at the Location, when, and the version of the batch's history that entered it. Nothing is written as a Shot is stored. So a Shot whose dose is corrected later, that is linked to another batch, that is deleted, or that reaches the server late from a tablet that was offline, changes the weight with no further code: the next read counts the Shots as they then are. A running total would need each of those to find and correct it, on any instance, under the Location's lock.
- **Per Location.** A batch can be at several Locations (ADR-0008), and each has its own weight and its own count. A Shot counts at the Location it was pulled at, which is the Location recorded on the Shot, and nowhere else. A Shot pulled where the batch has no weight subtracts nothing anywhere: at a Location the batch is not at or is untracked at, or on a Machine with no Location.
- **A Shot's dose** is its measured dose where it recorded one, otherwise the dose its Workflow was set to, otherwise nothing. Every Shot linked to the batch counts, Unfinished Shots and Trial Shots included: the coffee was ground.
- **Since the entry.** A Shot counts when it was pulled after the weight was entered, each by its own time: a Shot's by its tablet's clock, an entry on a tablet by that tablet's, and an entry in the management interface or through an assistant by PostgreSQL's (ADR-0016). Entering a weight starts the count again.
- **Untracked is not zero.** A batch with no weight entered at a Location has no Remaining Weight there: it reads null, says "Not tracked", and loses nothing to Shots. Clearing the weight, which is entering none, returns it to that. Batches that had no weight when this shipped stay untracked, and a weight already entered now falls with the Shots pulled since it was entered.
- **Never below zero, and zero through Shots finishes nothing.** Doses are estimates and a weight may be entered too low, so the worked-out weight stops at zero with the batch still at its Location, on its tablets and not Archived.
- **Entering zero finishes.** A weight of zero entered for a Location says the bucket is empty, so it finishes the batch there, as **Finish here** does: in the management interface, over REST, through an assistant, and from a tablet whose barista sets `weightRemaining` to zero. It is one entry of the batch's history, a finish made by a weight of zero (`{ remainingWeight: 0, atLocation: false }`), fields the previous release already reads. A zero that arrives in the same change that adds the batch at the Location, as a record created or un-archived on a tablet holding zero, is kept as that tablet has it and finishes nothing. A create or an add that gives a remaining weight of zero through the server is refused as a bad request.
- **A new batch is created at exactly one Location**, so that its roasted weight is counted once, and with a roasted `weight` and no remaining weight its count starts at that weight there, as Decaid's own create does on a tablet. It reaches another Location by being added there.
- **Reads.** `remainingWeight` keeps its name and is now the worked-out weight. Beside it each Location reads with the weight entered, when and by whom (`entered`), and the number of Shots since and the coffee they used (`used`), and the batch with its total over the Locations that track it (`totalRemainingWeight`). A list of batches reads the Shots of all of them in one query, not one per batch.

## Beside the previous release (ADR-0025)

No table, column or wire message changes. The previous release goes on entering weights and adding batches at Locations, each stored as before, and this release works the weight out from them. Its pages read the routes they read, whose fields keep their names: they show `remainingWeight`, which this release's server now answers worked out and the previous release's still answers as entered, so the two may show different numbers for a batch for as long as a deploy lasts. The previous release's New Batch dialog can ask for a batch at no Location or at several; through this release's server that is refused with a message saying why, and through its own it is created as before, which this release reads as it reads any batch at several Locations.

## What a tablet holds

A tablet's record of a batch holds the weight last entered at its Location, as before. It does not fall on the tablet as Shots are pulled: writing the worked-out weight to tablets, and telling such a write from a weight a barista entered, is #705.

## Considered options

- **A running total, lowered as each Shot is stored.** Every correction to a Shot, and every late one, would have to find and repair it, and two instances storing Shots at once would have to take the Location's lock to do so.
- **A ledger of Stock Movements**, which the glossary once planned: deliveries, transfers, counts and each Shot's coffee as rows, summed since the last count. The Shots are already rows, and nothing asks for the rest as history, so it is withdrawn. The amounts of moves between Locations are kept by #704, as a Location's weight is worked out from them.
- **One weight for the batch, wherever it is.** The owner keeps a sample of a roast at the lab and sends the bucket to a cafe: two places, two weights.
- **Finishing a batch when Shots take it to zero.** A batch a barista is still pulling from would vanish from the tablets because doses are estimates.

## Consequences

- The number is only as good as the doses and the last weighing. Coffee used outside a Shot, as when purging a grinder, is corrected by weighing the bucket and entering the weight.
- A Shot timed by a tablet whose clock is wrong may fall on the wrong side of an entry.
- Reads do more work than before: one grouped query over the Shots linked to the batches being read, by the index on a Shot's batch.
