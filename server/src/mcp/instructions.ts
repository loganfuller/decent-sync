import { CUT_MARK } from "./budget.js";

// The MCP server's instructions to the model: a short primer from
// GLOSSARY.md, so an assistant uses the words the management interface uses
// and means what a person means by them (ADR-0026), with the units its
// results share and how a response kept within its budget reads (ADR-0028).
// Keep it in step with the glossary. Each tool's description carries its own
// results' units and meanings too, as not every client shows these.

export const INSTRUCTIONS = `Decent Sync keeps the coffee data of Decent espresso machines at one or more sites. Use its words, as the person's management interface does:

- Location: a physical site, such as a cafe, with its own time zone. A Machine is at one Location at a time, or none.
- Machine: a Decent espresso machine (any DE1 model or a Bengle), whatever its tablet.
- Machine State: what a Machine is doing at a moment, such as pulling a Shot, steaming or sleeping. Its status is whether it is online.
- Capture-only Machine: one whose records are kept but which takes no part in the Library, as it has no Location or an Admin turned its sharing off.
- Machine Settings: what a Machine's firmware is set to apart from what its Workflow sets. Tablet Settings: Decaid's own settings on its tablet. A Settings Edit changes either through Decent Sync, kept with who made it and what came of it. Settings History: each change of what a Machine's tablet reported for these, its plugins, Skins, paired devices and sensors, whatever made it; one made outside Decent Sync is tied to no person.
- Recipe: a named, saved dial-in for a coffee, belonging to one Location: its Bean Batch, Profile, dose, yield, Grinder and setting, Basket and Tools, and any steam, hot water and flush settings.
- Workflow: what a Machine is set up to do next. A Recipe is saved; a Workflow is current.
- Loaded Recipe: the Recipe a barista last applied on a Machine. A change on that Machine is saved into it, and a change to it reaches that Machine's Workflow.
- Recipe Slot: one of a Location's five numbered positions, 1 to 5, each a button on its Machines' tablets. A Recipe is in at most one slot.
- Bean: a coffee as a roaster sells it. Bean Batch: one roast of a Bean, at a Location from when it is added there until it is finished there.
- Library: the Beans, Bean Batches, Profiles, Grinders, Baskets, Tools and Recipes Decent Sync keeps and shares with Machines. A Profile is a program a Machine follows while pulling a Shot, such as a pressure or flow curve; each Location shows or hides each Profile, Basket and Tool. A Grinder belongs to one Location.
- Archived: a Library item retired everywhere, kept so past Shots still name it, offered nowhere. Not deleted.
- Conflict: an edit to a field of a Library item that lost to another edit of the same field made without seeing it, kept until someone uses its value or dismisses it.
- Shot: one extraction recorded on a Machine. Its Preheat, the Machine heating its water before the profile starts, is shown with it but not counted in its duration or peaks.
- Steam Record: one recorded use of a Machine's steam wand. Its duration counts only the steaming, not the steam starting up, its pauses, puffs or purge.

A day, such as "yesterday", is each Location's own day in its time zone. Times are ISO 8601 with offsets.

Weights are in grams, volumes in ml, flow in ml/s, pressure in bar, temperatures in °C and durations in seconds, unless a tool says otherwise. Each response is kept small enough to read whole: a page may hold fewer than its limit, its more saying whether more follow, and text ending in ${CUT_MARK} was cut, the response's cut note saying how to have more of it. Never send cut text back in a change: read it whole first.`;
