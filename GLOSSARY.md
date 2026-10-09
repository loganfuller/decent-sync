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

**Connection Id**:
The id Decaid uses to reach a machine: a Bluetooth address or a USB id. The server remembers a machine's connection ids as aliases, but they are not its identity.
_Avoid_: Machine id, MAC (when a USB id is possible)

**Location**:
A physical site where machines are used, such as a roastery lab or a cafe, with its own time zone. A machine can be unassigned; once assigned, it is at one location at a time. The machines at one location work like the groups of a single commercial espresso machine: they share equipment and recipes.
_Avoid_: Site, store, shop, venue

**Location History**:
The record of which location a machine was at from which time. It decides the location each shot and steam record is credited to, and correcting it re-credits them.

**Equipment**:
Gear used alongside a machine that can be shared between machines without changing what the machine is: grinders, baskets, portafilters, drippers. Equipment belongs to a location.
_Avoid_: Gear, accessories. A tablet is not equipment.

**Grinder**:
A kind of equipment that grinds coffee at a numbered or named setting.

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
A person who works at one or more locations. They can edit the library's shared content anywhere, and move machines, change what their locations offer, manage recipes and record stock there.
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
A named, saved choice of profile, dose, yield, grinder and grind setting that a barista dialled in, which any machine at the same location can load.
_Avoid_: Stored workflow, preset, favourite

**Recipe Slot**:
A numbered position for a recipe, shared by every machine at a location, like a programmed button on one group of a commercial machine.
_Avoid_: Recipe number, index

**Workflow**:
What a machine is set up to do next: its current profile, dose, yield, bean batch, grinder and setting, plus its steam, hot water and rinse settings. Each machine has its own profile, dose, yield, batch and grinder, even when machines share recipes. Steam, hot water and rinse settings are shared by the machines at a location, whatever their model, but a machine switched out of sharing them.
_Avoid_: Recipe (a recipe is saved; a workflow is current)

**Shot**:
One extraction recorded on a machine: its measurements over time, what was used, and how it turned out.
_Avoid_: Pull, brew, extraction (as a noun for the record)

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
