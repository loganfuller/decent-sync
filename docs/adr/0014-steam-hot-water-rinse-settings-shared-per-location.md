---
status: accepted (amended by ADR-0008, which clears a joining machine's Workflow grinder and batch, and ADR-0020, under which each setting is a field of its own; amended in place on 2026-10-09, while building milestone 2: every machine at a location shares them, whatever its model, and a machine can be switched out)
---

# Steam, hot water and rinse settings are shared per location; steam on/off is not

A machine's Workflow stays its own (profile, dose, yield, batch, grinder), except for its steam, hot water and rinse settings. Those are shared by every machine at a location, whatever its model, the way every steam wand on one commercial machine runs the same settings. A change on any tablet or in the management interface applies to the location's other machines, last-writer-wins.

We rejected sharing them only among machines of one model, or keeping the DE1s' apart from the Bengles'. A cafe wants every wand on the same settings, and an owner who wants a machine to differ switches it out instead.

The plugin picks up changes from Decaid's `workflowUpdated` event and counts only differences in these three parts as edits. Applying a DYE2 recipe doesn't touch them, because `PUT /workflow` deep-merges and recipes carry no steam settings.

## Consequences

- Decaid has no steam on/off flag: a target temperature below 135 °C means off. Turning steam off on one machine (an espresso-only machine, descaling) is therefore not shared. While a machine's steam is off, shared values don't turn it back on. When it is turned on again, it takes the location's current values.
- **A machine can be switched out of sharing them** in the management interface, by an Admin or by Staff at its location. Its tablet then keeps its own settings, and none of its changes are shared. Switched back in, it takes the location's current values, as when its steam is turned back on.
