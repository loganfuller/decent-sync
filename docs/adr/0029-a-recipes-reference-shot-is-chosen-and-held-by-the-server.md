---
status: accepted
---

# A Recipe's Reference Shot is chosen, and held by the server alone

Milestone 7 compares a Recipe's Shots with one Shot that shows how they should go, its Reference Shot, as a roaster compares each roast with a reference roast. A person chooses it: whoever may edit the Recipe picks any Shot the server holds, pulled on any Machine at any Location, with the Recipe's Profile or another, and it stays the Recipe's until someone chooses another or clears it. The server holds the choice on the Recipe beside its Recipe Slot, outside the content it writes into DYE2's recipes on tablets. It is set from the management interface and through the MCP endpoint (ADR-0026), and the Recipe's history says who chose it.

A chosen reference lets a Location pull against a Shot dialled somewhere else, such as the roastery's lab, and a deliberate choice lasts until someone makes another. Holding it on the server follows ADR-0003, and keeps Decent Sync from adding a field of its own to DYE2's storage, which ADR-0005 already writes only as an interim measure.

## Considered Options

- **Working it out as the Recipe's highest-rated Shot, the newest winning a tie,** as the first design of Roux's skin did. It stores nothing and needs no way to choose. But it moves every time anyone gives a Shot top marks, so a lead's choice lasts only until the next one. It can never be a Shot from another Location, since a copied Recipe has no Shots of its own. And an old Shot rated highest stays the reference after the Recipe's Profile changes, unless a second rule narrows which Shots count. Rejected.
- **A highest-rated default that a person can pin.** Two rules to explain, and the interface would have to say which one gave the Shot it shows. Rejected.
- **A field of DYE2's recipe record,** which would reach every tablet with the Recipe. DYE2 has no such field, so it would be Decent Sync's own addition to another app's storage. Rejected: a tablet gets the Reference Shot from the plugin instead, once the plugin serves a skin what the server holds.

## Consequences

- **Tablets neither show nor set it yet.** A skin needs the Reference Shot's curves on a tablet that didn't pull it, which waits for the plugin to serve a skin the server's Shots: a later milestone. Until then a skin can only compare with its own tablet's Shots.
- **A rating never moves it.** Ratings still come only from the tablet that pulled a Shot, and rating a Shot changes no Recipe.
- **It may not match the Recipe.** A Reference Shot can be on another Profile, Machine, Grinder or Location than the Recipe's, by choice or because the Recipe changed since. Nothing clears it; the management interface says where its Profile differs from the Recipe's.
- **A copy of a Recipe starts with the same Reference Shot,** and chooses its own from then on.
- **Only a person clears it.** The server never deletes a Shot, so a Recipe keeps its Reference Shot until someone chooses another or clears it. A Shot hidden after it was chosen, because its Pending Machine was dismissed, leaves the Recipe reading as having none until that hardware is adopted.
- **It is not a content edit.** It is set through a route and a tool of its own, as a Recipe Slot is, so it makes no Conflict (ADR-0020) and nothing is sent to tablets.
