---
status: accepted
---

# An edit that loses is kept in the item's history, not settled as a Conflict

ADR-0020 keeps each edit that loses, and each value replaced by an edit that had not seen it, as a Conflict. ADR-0018 does the same for a joining tablet's values that differ from the Library's. Each Conflict waits on the Conflicts page, or on the item's page, until someone uses its value or dismisses it. In practice nobody needed this. In its first month at Roux, from 2026-10-24, prod made 2 Conflicts beside about 1,535 tablet edits and 130 from the management interface. Both were dismissed and neither was used. Both look like values the replacing tablet had itself been written, which the server could not show it had seen (#629). Keeping the page, the actions and their access rules correct cost more than it gave.

So an edit that loses is now a **Lost Edit**: an entry in the item's history, in the management interface and through the MCP endpoint, giving its value, who or which Machine made it and when, and the edit it lost to. It has no list of its own and no actions. To bring a value back, someone edits the item. Who wins is unchanged: ADR-0020's rule decides each field, and edit times decide between edits made out of each other's sight.

A value the editing tablet's last known record held is never a Lost Edit, even where the server cannot show that the tablet saw the edit that set it. The tablet replaced what it had, so keeping that value would tell nobody anything. Holding a value never changes who wins, though: an earlier edit from a tablet that held the current value still loses to a later one.

This amends ADR-0020 and ADR-0018. A Shot's rating and note (ADR-0031) already kept nothing of a losing edit, for the same reason.

## Considered options

- **Keeping Conflicts and fixing only the stale ones.** That would leave a page and two MCP tools in place for something used nowhere.
- **Dropping losing edits entirely.** A losing offline edit would then leave no trace, which is the loss ADR-0020 was written to prevent.

## Consequences

- Lost Edits are stored where Conflicts were, so a release keeping them runs beside the previous one (ADR-0025). Conflicts already dismissed are not shown.
