---
status: accepted (interim in how a load is detected, until DYE2 and Streamline record the recipe they apply; amended in place on 2026-10-15, for ticket #146: the plugin keeps DYE2's selected recipe in step with the Loaded Recipe)
---

# A Machine's Loaded Recipe is worked out from its Workflow, recorded in it, and followed both ways

A Recipe is the day's dial for one roast, which baristas keep current through the day. When a barista on one Machine moves the Brazil's grind from 2.4 to 2.5, every other Machine with the Brazil loaded has to take that at once: the grinder is physically at 2.5, and their next Shots would otherwise record 2.4. The owner also counts which Recipe a Machine has loaded as part of its state, for analytics. Neither DYE2 nor Streamline records which recipe it applied, in the Workflow or on Shots, so the plugin works it out.

When a Machine's Workflow changes to match one of its Location's slotted Recipes, or an earlier version of one, on profile, dose, yield, grinder and grind setting together, that Recipe is loaded. DYE2 and Streamline both set all five in one write when they apply a recipe. The plugin then writes into the Workflow what applying a DYE2 recipe leaves out, or a stale copy got wrong: the Recipe's current values, its Bean Batch, all its hot water settings (ADR-0014), and the Recipe's id in the Workflow's context, so Decaid copies it onto every Shot pulled with it.

While a Recipe is loaded, the Machine follows it both ways. A change made on that Machine to its dose, yield, grind setting, RPM, basket or hot water, or to another batch of the same Bean, is an edit of the Recipe, whatever app made it, as Streamline's auto-save already treats changes after its strip applies one. An edit of the Recipe from anywhere is written into the Workflow of every Machine that has it loaded. Changing the Machine's profile, grinder or Bean unloads it, as do loading another Recipe, taking the Recipe out of its slot or Archiving it, the Machine joining another Location, and its becoming a Capture-only Machine. Moving the Recipe to another slot keeps it loaded.

This is interim in one respect: once DYE2 and Streamline record the recipe they apply (asked upstream), the plugin reads that instead of matching. A skin built for a Decent Sync deployment records it too.

We rejected sharing only the stored recipes, picked up the next time a barista loads one, because Shots would record a dial the Machine no longer has. We rejected waiting for DYE2 and Streamline, for the reason ADR-0005 gives. We rejected matching without recording the result in the Workflow, because Shots pulled while the tablet is offline would then reach the server without their Recipe.

## Consequences

- **Every tweak is the Recipe's.** A change to the dial on a Machine with a Recipe loaded changes it on every Machine at the Location. That is the intent: a dose is never changed for one customer.
- **Matching can load a recipe nobody tapped.** A barista who dials in exactly a Recipe's profile, dose, yield, grinder and setting by hand loads it, which records what the Machine is doing anyway. Applying a DYE2 favourite while a Recipe is loaded is a change like any other: an edit of the Recipe, unless it changes the profile, grinder or Bean.
- **The plugin writes more of the Workflow.** Beyond milestone 2's shared settings and the clearing on joining (ADR-0008), it writes a Loaded Recipe's values. A skin that remembers the hot water settings takes them as its own (ADR-0021).
- **Shots name their Recipe.** Each Shot is linked to the Recipe loaded when it was pulled, so milestone 5 needs no inferred recipes.
- **DYE2's selection follows the Loaded Recipe.** From v0.1.20, DYE2 records a change of the Workflow's dial, whichever app made it, into the recipe it has selected, which its dashboard and Streamline's strip select as they apply one, and which a change of grinder or Bean leaves selected. So the plugin selects the Loaded Recipe through DYE2's `selection` endpoint, and clears from that selection a recipe it or the server unloads, following DYE2's model rather than working around it. A recipe loaded while the Machine is capture-only, which nothing there shares, is not unloaded, so DYE2 goes on recording into it there. Reading DYE2's selection as the Loaded Recipe, rather than matching, is the long-run aim (#150): it needs DYE2 and Streamline to record it in the Workflow, so Shots carry it, and to keep it through a change of the yield and clear it on a change of grinder or Bean.
