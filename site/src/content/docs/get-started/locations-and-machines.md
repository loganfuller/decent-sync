---
title: Locations and Machines
description: Adding Locations and Machines, why a Machine needs a Location, and what its Token is for.
---

A Location is a physical site where Machines are used, such as a cafe or a
roastery lab, with its own time zone. A Machine is a Decent espresso machine:
its hardware, identified by model and serial number, whatever tablet is
attached to it.

## Add a Location

Under **Locations**, add one for each site.

## Add a Machine

Machines are adopted by hand. An Admin adds each Machine under **Machines**,
at its Location. Adding it shows the server URL and the Machine's Token once,
with copy buttons. Both go into the plugin's settings on the Machine's tablet
([Install the plugin](../../get-started/install-the-plugin/)).

## What the Token is for

The Token is the secret a Machine's plugin connects with. It belongs to one
Machine, and is bound to the hardware that Machine first reports.

A lost Token can't be shown again. Issue a new one from the Machine's page.
This disconnects any tablet still using the old one.

## Why a Machine needs a Location

A Machine shares the Library and Recipes only while it is at a Location. The
Machines at one Location work like the groups of one commercial machine: they
share its Grinders, Recipes and Recipe Slots
([What Decent Sync is](../../get-started/what-decent-sync-is/#its-parts)).

A Machine with no Location only captures: the server still collects its
records, and nothing is shared with it
([Capture-only Machines](../../reference/tablet-plugin/#capture-only-machines)). A Machine is at one
Location at a time, and takes on a Location's Library as it is added or moved
there ([When a Machine joins a Location](../../reference/tablet-plugin/#when-a-machine-joins-a-location)).
An Admin moves any Machine, and Staff move Machines at their own Locations.

## Pending Machines

Each Shot is credited by the hardware that recorded it, so it goes to the
Machine that pulled it even if the tablet has since moved to another machine.
Hardware the server has seen but no Machine covers waits as a Pending Machine:
a tablet connected with another Machine's Token while reporting different
hardware, or a Shot recorded on hardware the server doesn't know. An Admin
either creates a Machine for it or dismisses it.
