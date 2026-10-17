---
status: superseded on 2026-10-16, for ticket #190: steam and rinse settings are each machine's own, and from ticket #173 the Recipe's, as hot water follows the Loaded Recipe, ADR-0022 (accepted until then, amended by ADR-0008, which clears a joining machine's Workflow grinder and batch, ADR-0020, under which each setting is a field of its own, and ADR-0021, under which a skin takes a change made elsewhere as the new value, and the plugin sets the steam temperature Streamline remembers; amended in place on 2026-10-09, while building milestone 2: every machine at a location shares them, whatever its model, and a machine's sharing of them can be turned off; and on 2026-10-12, while scoping milestone 3: hot water settings follow each machine's Loaded Recipe instead, ADR-0022, and the steam and flush values in DYE2's recipes are written as the location's)
---

# Steam and rinse settings are shared per location; steam on/off and hot water are not

Superseded on 2026-10-16, for ticket #190. A location no longer shares steam and rinse settings: each machine kept its own, and nothing synced them, until #173 made them the Recipe's, as hot water already followed the machine's Loaded Recipe (ADR-0022). The owner accepted that interim before v1. Keeping the steam and flush values inside DYE2's recipes at the location's went wrong in practice: with a recipe selected in DYE2, a flush time set from 10 to 5 s on the machine was taken for a stale copy of the recipe applied, and the location's 10 was written back. What follows is kept as the decision that stood until then.

A machine's Workflow stays its own (profile, dose, yield, batch, grinder, basket and hot water settings), except for its steam and rinse settings. Those are shared by every machine at a location, whatever its model, the way every steam wand on one commercial machine runs the same settings. A change on any tablet or in the management interface applies to the location's other machines, last-writer-wins.

We rejected sharing them only among machines of one model, or keeping the DE1s' apart from the Bengles'. A cafe wants every wand on the same settings, and an owner who wants a machine to differ turns off its sharing instead.

Hot water was shared too until milestone 3. A recipe is the day's dial for one roast, and the hot water it gives is part of what it puts in the cup, so hot water volume, temperature, duration and flow follow the Recipe a machine has loaded (ADR-0022): a machine on the Brazil keeps the Brazil's hot water when another loads the Ethiopian. A machine with no Loaded Recipe keeps its own.

The plugin picks up changes from Decaid's `workflowUpdated` event and counts only differences in the shared settings as edits. DYE2's recipes carry steam and flush values, though, and applying one, in DYE2 or in Streamline's DYE strip, merges them into the Workflow, which would make every recipe applied on one machine change its location's settings. So the plugin writes the location's current values into every recipe there (ADR-0005), or a machine's own into its tablet's recipes while its sharing of them is off. Applying a recipe then leaves them as they are, and changing them inside a recipe on a tablet changes the location's settings, as changing them on the machine does.

## Consequences

- Decaid has no steam on/off flag: a target temperature below 135 °C means off. Turning steam off on one machine (an espresso-only machine, descaling) is therefore not shared. While a machine's steam is off, shared values don't turn it back on. When it is turned on again, it takes the location's current values.
- **A machine's sharing of them can be turned off** in the management interface, by an Admin or by Staff at its location. Its tablet then keeps its own settings, and none of its changes are shared. With sharing turned back on, it takes the location's current values, as when its steam is turned back on.
