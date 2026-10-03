# Steam, hot water and rinse settings are shared per location; steam on/off is not

A machine's Workflow stays its own (profile, dose, yield, batch, grinder), except for its steam, hot water and rinse settings. Those are shared by machines of the same model at a location, the way every steam wand on one commercial machine runs the same settings. A change on any tablet or in the management interface applies to the location's other machines of that model, last-writer-wins. Settings are shared only within a model because a Bengle and a DE1 can read the same values differently.

The plugin picks up changes from Decaid's `workflowUpdated` event and counts only differences in these three parts as edits. Applying a DYE2 recipe doesn't touch them, because `PUT /workflow` deep-merges and recipes carry no steam settings.

## Consequences

- Decaid has no steam on/off flag: a target temperature below 135 °C means off. Turning steam off on one machine (an espresso-only machine, descaling) is therefore not shared. While a machine's steam is off, shared values don't turn it back on. When it is turned on again, it takes the location's current values.
