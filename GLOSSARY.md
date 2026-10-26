# Decent Sync

Decent Sync keeps the coffee data of several Decent espresso machines, across one or more physical sites, in one place. It shares a library of beans, bean batches, profiles, equipment and recipes between those machines and collects every shot they pull.

## Hardware and places

**Machine**:
A piece of Decent espresso hardware: any DE1 model (DE1, DE1+, DE1Pro, DE1XL, DE1Cafe, DE1XXL, DE1XXXL) or a Bengle. Identity follows the hardware, so replacing its tablet does not make it a new machine.
_Avoid_: Device, DE1 (when any model is meant), station

**Unidentified Machine**:
A machine that has connected without reporting a real serial number, and that nobody has yet linked to a known machine.

**Pending Machine**:
Hardware the server has seen but no machine entry covers: a tablet connected with another machine's token while reporting different hardware (a mismatch), or a shot recorded on hardware the server doesn't know. An Admin either creates a machine entry for it or dismisses it.
_Avoid_: Unknown machine, orphan

**Capture-only Machine**:
A machine whose records the server collects but that takes no part in the library: it has no location, or an Admin has turned sharing off for it.
_Avoid_: Read-only machine, unsynced machine

**Token**:
The secret a machine's plugin connects with. It belongs to one machine and is bound to the hardware that machine first reports.
_Avoid_: Key, password, API key

**Tablet**:
The Android device running Decaid that is attached to a machine, together with its Decaid data: resetting that data makes a new tablet, and restoring a backup onto another device brings back the tablet it came from. A tablet can be swapped or moved to another machine without changing the machine's identity. Its **tablet id** is a random id the plugin keeps in that data to tell tablets apart, such as two connecting with one machine's token; it is not the machine's identity.
_Avoid_: Machine, client, install

**Skin**:
The app baristas use on a tablet in place of Decaid's own screens, such as Streamline. It reads and changes the machine's workflow through Decaid's API, as the plugin does.
_Avoid_: Theme, front end

**Machine Settings**:
What a machine's firmware is set to apart from what its workflow sets, such as its fan threshold, heater settings and sensor calibration. Not DYE2's "machine settings" of a recipe, which are its steam, hot water and flush settings.
_Avoid_: Machine config, DE1 settings

**Tablet Settings**:
Decaid's own settings on a tablet, such as how it uses its scale and charges, and when it puts the machine to sleep and wakes it. They go with the tablet when it moves to another machine.
_Avoid_: App settings, preferences, config

**Settings Edit**:
A change to a machine's or tablet's settings made through the server, as in the management interface, kept with who made it and when, and what came of it.
_Avoid_: Settings change, command

**Machine State**:
What a machine is doing at a moment, such as pulling a shot, steaming, purging after steaming, flushing, pouring hot water, idling or sleeping. Purging is the steam wand's purge after steaming, not a flush of the group head or draining the machine for transport.
_Avoid_: Status (a machine's status is whether it is online), mode, purge (for a flush)

**Live View**:
The management interface's real-time picture of what one machine is doing and measuring, shown while someone has its page open. Nothing in it is kept.
_Avoid_: Live mode, dashboard, monitor

**Connection Id**:
The id Decaid uses to reach a machine: a Bluetooth address or a USB id. The server remembers a machine's connection ids as aliases, but they are not its identity.
_Avoid_: Machine id, MAC (when a USB id is possible)

**Location**:
A physical site where machines are used, such as a roastery lab or a cafe, with its own time zone. A machine can be unassigned; once assigned, it is at one location at a time. The machines at one location work like the groups of a single commercial espresso machine: they share equipment and recipes.
_Avoid_: Site, store, shop, venue

**Location History**:
The record of which location a machine was at from which time. It decides the location each shot and steam record is credited to, and correcting it re-credits them.

**Equipment**:
Gear used alongside a machine that can be shared between machines without changing what the machine is: grinders, baskets and tools. A grinder belongs to one location; baskets and tools are in the library, and each location shows or hides them.
_Avoid_: Gear, accessories. A tablet is not equipment.

**Grinder**:
One physical grinder, with its own burrs and calibration, that grinds coffee at a numbered or named setting.

**Basket**:
A model of filter basket, such as a 20 g high-flow basket. One basket stands for every copy of that model, at every location.

**Tool**:
A kind of equipment other than a grinder or basket that a recipe or shot can name, such as a tamper, WDT tool, puck screen, portafilter or dripper.
_Avoid_: Accessory, gear

**Scale**:
A weighing device paired with a machine's tablet that weighs the shot as it is pulled.

**Auxiliary Scale**:
A second scale used for something other than weighing the shot, such as weighing ground coffee into a portafilter.
_Avoid_: Dosing scale, second scale

## People

**Admin**:
A person who can change everything on the server, including machines, tokens and hard deletes.

**Barista**:
The person who pulled a shot, as named on the tablet. A barista doesn't need an account.

**Staff**:
A person who works at one or more locations. They can edit the library's shared content anywhere, and move machines, edit machines' settings, change what their locations offer, manage recipes and record stock there.
_Avoid_: User (when the role matters), barista (a barista may not have an account)

## Coffee

**Bean**:
A coffee as sold by a roaster, identified by roaster and name. It is offered at each location where one of its batches is, and, until one of its batches is added there, where a tablet there created, linked or un-archived it.
_Avoid_: Coffee (when the product is meant), blend

**Bean Batch**:
One roast of a bean that baristas pick: a single roaster run if you roast, or one roast date from your supplier if you buy. A batch is at a location from when it's added there until it's finished there, and can be at several locations at once.
_Avoid_: Roast (as a record), run, bag, bucket, lot

**Stock**:
How much of a bean batch is held at one location, when it is tracked.
_Avoid_: Inventory (for one batch at one place), remaining weight

**Stock Movement**:
One recorded change to a batch's stock at a location: a delivery, a transfer between locations, a count, or the coffee used by a shot. A location's stock is the sum of its movements since the last count.
_Avoid_: Adjustment, transaction

**Profile**:
A program the machine follows while pulling a shot, such as a pressure or flow curve. Each location shows or hides each profile.
_Avoid_: Recipe (a recipe is more than a profile)

**Recipe**:
A named, saved dial-in for a coffee, such as the day's recipe for one roast: its bean batch, profile, dose, yield, grinder and grind setting, basket and tools, and any steam, hot water and flush settings it holds (a machine loading it keeps its own for the rest). It belongs to one location, where any machine can load it, and baristas keep it current as they adjust the dial through the day.
_Avoid_: Stored workflow, preset, favourite

**Recipe Slot**:
One of a location's five numbered positions for a recipe, 1 to 5, each a button of Streamline's DYE strip, shared by every machine at that location, like a programmed button on one group of a commercial machine. A recipe is in at most one slot, and keeps its identity when moved to another; one in no slot is kept at its location, where any machine can still load it, until someone puts it in one or archives it.
_Avoid_: Recipe number, index

**Loaded Recipe**:
The recipe a barista last applied on a machine, while they are still dialling it in, until they apply another recipe or a favourite, or change the profile. It belongs to the machine, as its workflow does: a change made on that machine is saved into the recipe, and a change to the recipe reaches that machine's workflow at once.
_Avoid_: Active recipe, current recipe

**Workflow**:
What a machine is set up to do next: its current profile, dose, yield, bean batch, grinder and setting, and basket, plus its steam, hot water and flush settings, which loading a recipe sets, so machines at one location with different recipes loaded steam differently. Turning steam off never changes a recipe.
_Avoid_: Recipe (a recipe is saved; a workflow is current); rinse settings (Decaid's name for the flush settings)

**Shot**:
One extraction recorded on a machine: its measurements over time, what was used, and how it turned out.
_Avoid_: Pull, brew, extraction (as a noun for the record)

**Preheat**:
The part of a Shot's recording before its profile starts, while the Machine heats its water. Preheat is shown with the Shot but isn't counted in its duration or peaks.
_Avoid_: Warmup, heater test

**Steam Record**:
One recorded use of a machine's steam wand: its measurements over time and the milk temperature reached.
_Avoid_: Steam shot, steaming session

## Library

**Library**:
The beans, bean batches, profiles, equipment and recipes that the server keeps and shares with machines, some everywhere and some per location.
_Avoid_: Collection, catalogue

**Archived**:
A library item retired everywhere: kept so that past shots still name it, but offered nowhere.
_Avoid_: Deleted, hidden (a profile is hidden at one location)

**Conflict**:
An edit to a field of a library item that lost to another edit of the same field made without seeing it, kept until someone uses its value or dismisses it.
_Avoid_: Clash, collision
