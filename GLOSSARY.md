# Decent Sync

Decent Sync keeps the coffee data of several Decent espresso machines, across one or more physical sites, in one place. It shares a library of beans, profiles and equipment between those machines and collects every shot they pull.

## Hardware and places

**Machine**:
A piece of Decent espresso hardware: a DE1Pro, DE1XL, DE1XXL or Bengle. Identity follows the hardware, so replacing its tablet does not make it a new machine.
_Avoid_: Device, DE1 (when any model is meant), station

**Unidentified Machine**:
A machine that has connected without reporting a real serial number, and that nobody has yet linked to a known machine.

**Tablet**:
The Android device running Decaid that is attached to a machine. It can be swapped or moved to another machine without changing the machine's identity.
_Avoid_: Machine, client, install

**Location**:
A physical site where machines are used, such as a roastery lab or a cafe, with its own time zone. A machine can be unassigned; once assigned, it is at one location at a time. The machines at one location work like the groups of a single commercial espresso machine: they share equipment and recipes.
_Avoid_: Site, store, shop, venue

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
A person who works at one or more locations and can move machines, manage recipes and record stock there.
_Avoid_: User (when the role matters), barista (a barista may not have an account)

## Coffee

**Bean**:
A coffee as sold by a roaster, identified by roaster and name.
_Avoid_: Coffee (when the product is meant), blend

**Bean Batch**:
One roast of a bean that baristas pick and that stock is tracked for: a single roaster run if you roast, or one roast date from your supplier if you buy. One batch can be at several locations at once.
_Avoid_: Roast (as a record), run, bag, bucket, lot

**Stock**:
How much of a bean batch is held at one location. A batch is at a location while it has stock there.
_Avoid_: Inventory (for one batch at one place), remaining weight

**Stock Movement**:
One recorded change to a batch's stock at a location: a delivery, a transfer between locations, a count, or the coffee used by a shot. A location's stock is the sum of its movements since the last count.
_Avoid_: Adjustment, transaction

**Profile**:
A program the machine follows while pulling a shot, such as a pressure or flow curve.
_Avoid_: Recipe (a recipe is more than a profile)

**Recipe**:
A named, saved choice of profile, dose, yield, grinder and grind setting that a barista dialled in, which any machine at the same location can load.
_Avoid_: Stored workflow, preset, favourite

**Recipe Slot**:
A numbered position for a recipe, shared by every machine at a location, like a programmed button on one group of a commercial machine.
_Avoid_: Recipe number, index

**Workflow**:
What a machine is set up to do next: its current profile, dose, yield, bean batch, grinder and setting, plus its steam, hot water and rinse settings. Each machine has its own profile, dose, yield, batch and grinder, even when machines share recipes. Steam, hot water and rinse settings are shared by machines of the same model at a location.
_Avoid_: Recipe (a recipe is saved; a workflow is current)

**Shot**:
One extraction recorded on a machine: its measurements over time, what was used, and how it turned out.
_Avoid_: Pull, brew, extraction (as a noun for the record)

**Steam Record**:
One recorded use of a machine's steam wand: its measurements over time and the milk temperature reached.
_Avoid_: Steam shot, steaming session
