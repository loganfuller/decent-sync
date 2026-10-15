---
status: accepted (interim in what DYE2 and Streamline do not do yet, below; amended in place on 2026-10-15, for ticket #146: the plugin keeps DYE2's selected recipe in step with the Loaded Recipe; and on 2026-10-15, for ticket #177: the Loaded Recipe is the recipe DYE2 has selected, no longer one worked out by matching the Workflow, DYE2 records the changes on the Machine that it records, and the Recipe's brew temperature, batch, grinder, Basket and RPM follow it too; DYE2 v0.1.20 and Streamline v0.2.14 brought the selection)
---

# A Machine's Loaded Recipe is the recipe DYE2 has selected, recorded in the Workflow, and followed both ways

A Recipe is the day's dial for one roast, which baristas keep current through the day. When a barista on one Machine moves the Brazil's grind from 2.4 to 2.5, every other Machine with the Brazil loaded has to take that at once: the grinder is physically at 2.5, and their next Shots would otherwise record 2.4. The owner also counts which Recipe a Machine has loaded as part of its state, for analytics.

## DYE2's selection

From v0.1.20, DYE2 keeps one selected recipe or favourite on each tablet (`dye2:dye2-plugin/src/utils/workflow-record.ts`). DYE2's dashboard and Streamline's DYE strip (from v0.2.14) select what they apply: they write the Workflow, then post the item to `POST /api/v1/plugins/dye2.reaplugin/selection`, which DYE2 answers from memory at `GET` on the same path. DYE2 clears the selection on a change of the Workflow's profile (by its own fingerprint, which counts the yield Streamline writes into the profile), on a recent favourite applied, and on `POST /selection {}`. It doesn't clear it when the selected recipe is removed from its list. It keeps the selection in its plugin storage, and restores it as it loads; a cleared one is stored as `null`, which Decaid's store doesn't keep, so the selection cleared comes back. It pushes `{"what":"workflow"}` on its `changed` socket when it selects an item and after it records, but not when the selection clears.

While a recipe is selected, DYE2 records into its record in `recipes`, on every change of the Workflow, whatever made it, the Workflow's value of each field the record holds that differs: the dose, yield, grind setting and brew temperature, and the steam, hot water and flush values of the recipe's active modes. It ignores its own apply's echo.

## The Loaded Recipe

When a tablet's DYE2 selection names a recipe in a slot that holds one of its Location's Recipes, and was made on the profile the Workflow holds, that Recipe is the Machine's Loaded Recipe. The plugin compares the selection's `profileFingerprint` with DYE2's fingerprint of the Workflow's profile, DYE2's own test of a profile change. A selection made on another profile, as one DYE2 restored after the profile changed, loads nothing, and DYE2 clears it at the Workflow's next change. A favourite selected, or nothing, loads none. The plugin reads the selection from DYE2's endpoint (a 404, as when DYE2 is not loaded, is no selection) on each push from DYE2's `changed` socket, about 2 s after each change of the Workflow (past DYE2's 1.5 s wait before it records), to catch the clears DYE2 does not push, and on its poll.

On a load, the plugin writes into the Workflow what applying a DYE2 recipe leaves out, or a stale copy got wrong: the Recipe's current dial, its brew temperature, its Bean Batch, grinder, Basket and RPM, all its hot water settings (ADR-0014), and the Recipe's id in the Workflow's context (`decentSyncRecipeId`), so Decaid copies it onto every Shot pulled with it. A brew temperature is written as Streamline's Brew tile writes one (`profileAtBrewTemp` in `streamline-js:src/modules/brew-temp.js`): the profile's first step goes to it, and every other step moves by the same amount. The plugin also keeps `decentSyncRecipeId` in the Workflow embedded in each recipe record, so a recipe applied from Streamline's strip carries it at once.

## Following the Recipe both ways

While a Recipe is loaded, the Machine follows it both ways.

- **From the Machine.** DYE2 records a change of the dose, yield, grind setting, brew temperature, or the hot water value of the recipe's active mode into the recipe's record, and the plugin takes it in as the tablet's edit of the Recipe, as it takes in any change of a recipe record (ADR-0005, ADR-0020). For these, DYE2 is the only recorder. As DYE2 records only a field the record holds, the plugin makes every Recipe's record hold a brew temperature, taken from its profile's first step where the Recipe has none. The plugin reads the Workflow itself only for what DYE2 does not record: the RPM, the Basket, every hot water setting but the one of the active mode, and another batch of the Recipe's Bean, as DYE2's recipes name a Bean but no batch (decentespresso/dye2#27). DYE2 records the steam and flush values too, which stay the Location's settings, taken from the Workflow as ADR-0014 says.
- **What DYE2 records stale.** As DYE2 records what the Workflow holds on any change of it, it can record a stale value: a DYE2 page's Done sending back the Workflow it read, or a Workflow behind its record, as when Decaid refused the plugin's hot water write while no machine was connected. Such a value is a stale save (ADR-0005), and the Recipe's value is written back. DYE2's pages applying and saving a recipe as they read it is asked upstream (decentespresso/dye2#28).
- **To other Machines.** An edit of the Recipe from anywhere is written into its record on each tablet at its Location, then into the Workflow of every Machine that has it loaded, the brew temperature as on a load. DYE2 there finds its record holding the values, and records nothing.
- **Kept in the Workflow.** Streamline clears the batch, coffee, grinder, Basket and RPM after each Shot (`clearDyeWorkflowContext` in `streamline-js:src/modules/dyeStrip.js`), so they do not label the next one. That is neither an edit nor an unload. While the Recipe is loaded, the plugin writes them back once, so every Shot pulled with it records them: a Recipe made for a particular Basket is pulled with it on every Machine.
- **Unloading.** When DYE2's selection clears or names something else, the Recipe is unloaded, and the plugin clears `decentSyncRecipeId`. The plugin clears DYE2's selection (`POST /selection {}`, the call Streamline makes when its DYE strip is turned off) when the selection names a slot whose Recipe has left it: taken out of its slot, Archived, or of a Location the Machine left. A Machine made capture-only keeps its selection, as nothing there is shared, but its Workflow names no Recipe. Moving the Recipe to another slot keeps it loaded: the plugin clears the selection before rewriting the list, and selects the new slot after, so DYE2 never records into a recipe put in the old slot meanwhile.

A skin built for a Decent Sync deployment applies a recipe as Streamline does: it writes the Workflow, then selects the recipe in DYE2.

## Interim: workarounds and accepted gaps

Each workaround here does on DYE2's or Streamline's behalf what an upstream ask would have them do, and goes when they do (AGENTS.md):

- **A change of grinder or Bean.** DYE2 keeps the selection through one, and would record the other grinder's or Bean's grind into the Recipe, which would reach every Machine with it loaded. So the plugin unloads the Recipe and clears DYE2's selection itself (decentespresso/dye2#19). A grinder or batch cleared is no such change.
- **The Recipe's id in the Workflow.** The plugin writes `decentSyncRecipeId` until DYE2 records its selection there (decentespresso/dye2#20). Until then, a Shot started between a recipe applied from DYE2's dashboard and the plugin's write carries the Recipe loaded before it, or none.
- **The RPM, Basket and batch** are read from the Workflow until DYE2 records them (decentespresso/dye2#21, and decentespresso/dye2#27 for the batch).
- **The brew temperature on a load** is written by the plugin until DYE2 and Streamline apply a recipe's own (decentespresso/dye2#26).
- **The batch, grinder, Basket and RPM after a Shot** are written back until Streamline leaves the selected recipe's in place (decentespresso/streamline-js#149).
- **Reading after each Workflow change** stands in for DYE2 pushing a cleared selection (decentespresso/dye2#24).
- **A cleared selection kept cleared.** When the plugin sees DYE2's selection clear, or clears it itself, it writes `{}` to DYE2's store key `selection` (`POST /api/v1/store/dye2.reaplugin/selection`), which DYE2 restores as no selection, while DYE2's endpoint still answers none. Otherwise DYE2 would restore the cleared selection as it next loads, and the plugin would load the Recipe again, writing its batch and grinder back over a Bean switch (decentespresso/dye2#22).

And these gaps are accepted until fixed upstream:

- A yield set in Streamline clears DYE2's selection, and so unloads the Recipe (decentespresso/dye2#18).
- A selection cleared while the plugin was not running comes back when DYE2 reloads, and loads the Recipe again if the Workflow still holds its profile (decentespresso/dye2#22).
- When Streamline fails to post its selection, DYE2 records the applied recipe's dial into the one selected before, and Streamline saves later changes into the applied one itself (decentespresso/streamline-js#148).

## Rejected

We first worked the Loaded Recipe out by matching the Workflow against the Location's Recipes, on profile, dose, yield, grinder and grind setting, and read every Workflow change while one was loaded as an edit of it. We rejected keeping that once DYE2 selected and recorded recipes itself. The two would be separate models of the same thing, which disagree: DYE2 would keep recording into a recipe the plugin had unloaded, or into another than the one it matched, and the server would send that recipe's changes to every Machine. And recording ourselves the fields DYE2 records would make two recorders of one change, which count it twice or disagree about it. We follow the apps' own model and ask upstream for what it lacks.

We rejected sharing only the stored recipes, picked up the next time a barista loads one, because Shots would record a dial the Machine no longer has. We rejected leaving the Recipe off the Workflow until DYE2 records it there, because Shots pulled while the tablet is offline would then reach the server without their Recipe.

## Consequences

- **Every tweak is the Recipe's.** A change on a Machine with a Recipe loaded to its dose, yield, grind setting, brew temperature, RPM, Basket, hot water, or batch of the Recipe's Bean changes it on every Machine at the Location. That is the intent: a dose is never changed for one customer.
- **Only an applied recipe is loaded.** Dialling in a Recipe's values by hand loads nothing. Applying a favourite while a Recipe is loaded unloads it, as DYE2 then selects the favourite.
- **DYE2 is required.** A Machine without DYE2 v0.1.20 or later has no Loaded Recipe (ADR-0017). Nothing falls back to matching. The plugin still writes the recipe lists to every sharing tablet (ADR-0005).
- **A change DYE2 skips is not the Recipe's.** DYE2 records only fields the recipe holds, so a change to one a Recipe leaves blank, but the brew temperature, stays on that Machine.
- **The plugin writes more of the tablet.** Beyond milestone 2's shared settings and the clearing on joining (ADR-0008), it writes a Loaded Recipe's values into the Workflow, and DYE2's selection. A skin that remembers the hot water settings takes them as its own (ADR-0021).
- **Shots name their Recipe, and its Basket.** Each Shot is linked to the Recipe loaded when it was pulled, so milestone 5 needs no inferred recipes, and records the Recipe's batch, grinder, Basket and RPM.
