---
status: accepted (amended in place on 2026-10-15, for ticket #146: the plugin keeps DYE2's selected recipe in step with the Loaded Recipe; amended in place again on 2026-10-15, for ticket #177: the Loaded Recipe is the recipe DYE2 has selected, no longer one worked out by matching the Workflow, and DYE2 records the changes on the Machine that it records; DYE2 v0.1.20 and Streamline v0.2.14 brought both)
---

# A Machine's Loaded Recipe is the recipe DYE2 has selected, recorded in the Workflow, and followed both ways

A Recipe is the day's dial for one roast, which baristas keep current through the day. When a barista on one Machine moves the Brazil's grind from 2.4 to 2.5, every other Machine with the Brazil loaded has to take that at once: the grinder is physically at 2.5, and their next Shots would otherwise record 2.4. The owner also counts which Recipe a Machine has loaded as part of its state, for analytics.

DYE2 keeps one selected recipe or favourite on each tablet, the one the barista last applied (`dye2:dye2-plugin/src/utils/workflow-record.ts`, from v0.1.20). DYE2's dashboard and Streamline's DYE strip (from v0.2.14) both select what they apply, by writing the Workflow and then posting the item to DYE2 (`POST /api/v1/plugins/dye2.reaplugin/selection`). DYE2 keeps the selection in its store under `selection`. It clears it when the Workflow's profile changes, a recent favourite is applied or the recipe is deleted. While a recipe is selected, DYE2 records the dial-in changes made on the Machine into that recipe's record in `recipes`.

When a tablet's DYE2 selection names a recipe in a slot that holds one of its Location's Recipes, that Recipe is the Machine's Loaded Recipe. A favourite selected, or nothing, loads none. The plugin reads the selection on each push from DYE2's `changed` socket, and on its poll. It then writes into the Workflow what applying a DYE2 recipe leaves out, or a stale copy got wrong: the Recipe's current values, its Bean Batch, all its hot water settings (ADR-0014), and the Recipe's id in the Workflow's context (`decentSyncRecipeId`), so Decaid copies it onto every Shot pulled with it.

While a Recipe is loaded, the Machine follows it both ways.

- **From the Machine.** DYE2 records a change of the dose, yield, grind setting or hot water into the recipe's record, and the plugin takes that change in as the tablet's edit of the Recipe, as it takes in any change of a recipe record (ADR-0005, ADR-0020). DYE2 records the steam and flush values too, which stay the Location's settings (ADR-0014). For these, DYE2 is the only recorder. The plugin reads the Workflow itself only for what DYE2 does not record: the RPM, the Basket, the hot water setting outside the recipe's active hot water mode, and another batch of the Recipe's Bean, as DYE2's recipes name a Bean but no batch. The RPM and Basket move to DYE2 once it records them (decentespresso/dye2#21).
- **To other Machines.** An edit of the Recipe from anywhere is written into its record on each tablet at its Location, then into the Workflow of every Machine that has it loaded. DYE2 there finds its record already holding the values, and records nothing.
- **Unloading.** A Recipe stays loaded as long as DYE2's selection names it. The server's own unloads clear DYE2's selection where it names the Recipe, with `POST /api/v1/plugins/dye2.reaplugin/selection {}` (the call Streamline makes when its DYE strip is turned off), and clear `decentSyncRecipeId`. Those are taking the Recipe out of its slot, Archiving it, the Machine joining another Location and its becoming a Capture-only Machine. Moving the Recipe to another slot keeps it loaded: the plugin selects its new slot in DYE2, as the slot's id is what DYE2 selects. A slot taking another Recipe while selected clears the selection, so DYE2 never records onto the new one.

A skin built for a Decent Sync deployment applies a recipe as Streamline does: it writes the Workflow, then selects the recipe in DYE2.

Gaps in DYE2's selection are fixed upstream, not worked around. Until they are:

- A yield changed in Streamline unloads the Recipe, as DYE2 takes it for a profile change (decentespresso/dye2#18).
- A Bean or grinder change leaves the Recipe loaded (decentespresso/dye2#19).
- The plugin writes `decentSyncRecipeId` itself, until DYE2 records its selection in the Workflow (decentespresso/dye2#20).

We first worked the Loaded Recipe out by matching the Workflow against the Location's Recipes, on profile, dose, yield, grinder and grind setting, and read every Workflow change while one was loaded as an edit of it. We rejected keeping that once DYE2 selected and recorded recipes itself. The two would be separate models of the same thing that disagree. DYE2 would keep recording onto a recipe the plugin had unloaded, or onto another than the one the plugin matched, and the server would send that recipe's changes to every Machine. Recording the fields DYE2 records ourselves too would make two writers decide one change, which DYE2's KV contract reserves to DYE2. We follow the apps' own model and ask upstream for what it lacks.

We rejected sharing only the stored recipes, picked up the next time a barista loads one, because Shots would record a dial the Machine no longer has. We rejected leaving the Recipe off the Workflow until DYE2 records it there, because Shots pulled while the tablet is offline would then reach the server without their Recipe.

## Consequences

- **Every tweak is the Recipe's.** A change to the dial on a Machine with a Recipe loaded changes it on every Machine at the Location. That is the intent: a dose is never changed for one customer.
- **Only an applied recipe is loaded.** Dialling in a Recipe's values by hand loads nothing. Applying a favourite while a Recipe is loaded unloads it, as DYE2 then selects the favourite.
- **DYE2 is required.** A Machine without DYE2 v0.1.20 or later has no Loaded Recipe (ADR-0017). Nothing falls back to matching.
- **A change DYE2 skips is not the Recipe's.** DYE2 records only fields the recipe already holds, so a change to one a Recipe leaves blank stays on that Machine.
- **The plugin writes more of the tablet.** Beyond milestone 2's shared settings and the clearing on joining (ADR-0008), it writes a Loaded Recipe's values into the Workflow and DYE2's selection. A skin that remembers the hot water settings takes them as its own (ADR-0021).
- **Shots name their Recipe.** Each Shot is linked to the Recipe loaded when it was pulled, so milestone 5 needs no inferred recipes.
