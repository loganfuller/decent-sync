---
title: What Decent Sync is
description: What Decent Sync does, who it is for, and what it needs.
---

Decent Sync connects every Decent espresso machine you run, at home or across
several cafes, to one server you host yourself. Enter a bag of beans once and
every machine has it. Dial in on one machine, and the others with that Recipe
follow. Every Shot from every machine lands in one place, linked to the beans,
grinder and profile that made it. And you can watch, adjust and ask about any
machine from your phone.

It is free and open source, under the MIT license, and because you host it,
your data stays yours.

## Why

A Decent tablet keeps everything to itself: its shots, its beans, its
profiles and its settings. With two machines, you enter every bag of beans
twice, dial in twice, and compare shots by walking between tablets. With
several cafes, nobody can see across them at all.

Decent Sync makes them one system. Baristas keep using Decaid, DYE2 and
Streamline exactly as before. The plugin keeps the tablets in step and sends
everything they record to your server.

## Who it is for

Each server has one owner: a household, or a business with all of its sites.

- **A home with two machines.** One bean shelf, shared. A bag entered on
  either tablet appears on both, with one remaining weight, and every shot
  from both machines is in one history.
- **A cafe.** Several DE1s work like the groups of one commercial machine: the
  same Recipes on the same buttons, one remaining weight for each batch, and a
  dial-in change on one group reaching every group with that Recipe loaded.
- **A roastery with cafes.** Develop Profiles and Recipes in the lab, then roll
  them out: show a Profile at a cafe, or copy a Recipe there. Trace every shot
  at every site back to the roast batch it used. Give each person the access
  they need: Admin, Staff at their own cafe, or a Viewer who only looks.

## What it needs

- **A Decent espresso machine**: any DE1 model or a Bengle, running
  [Decaid](https://github.com/decentespresso/decaid).
  [Install the plugin](../../get-started/install-the-plugin/#requirements)
  has the versions of Decaid, DYE2 and Streamline it needs.
- **A computer that runs Docker**, which your machines' tablets can reach.
  [Quick start](../../get-started/quick-start/) takes it from there.

## Its parts

```
Tablets (Decaid + plugin) ── WebSocket ──┐
Management interface ─────── REST API ───┼──▶  Server  ──▶  PostgreSQL
AI assistants ────────────── MCP ────────┘
```

The plugin runs inside Decaid on each machine's tablet. It sends the server
everything the tablet records, and writes the shared Library and Recipes back
to it. The server can run as several instances on one database. People use
the management interface, which the server serves, in a browser.

| What | Shared with |
|---|---|
| Beans, Bean Batches, Profiles, Baskets and Tools | Every Location. Each Location offers its own part: the Profiles, Baskets and Tools shown there, the batches there with their Beans, and its own stock of each batch. |
| Grinders, Recipes and Recipe Slots | The Machines at one Location. |
| What a Machine is using: its profile, dose, yield, batch, grinder, basket, and steam, hot water and flush settings | Nothing. Each Machine has its own, which loading a Recipe sets, steam turned on or off as the Recipe holds it. Turning steam off at the Machine never changes the Recipe. |

A few rules shape the rest:

- **A Machine is its hardware**, identified by model and serial number.
  Replacing its tablet doesn't make it a new Machine.
- **Machines are adopted by hand.** An Admin adds each Machine in the
  management interface, which issues a Token for its plugin.
- **The server is the source of truth, but tablets can still edit.** A tablet
  holds only what its Location offers. What a tablet creates starts at its
  Location only.
- **Machines don't depend on the server.** If the network or the server goes
  down, the machines keep working on their own, and the plugin catches up
  when the server is back.

The [Glossary](../../reference/glossary/) defines the terms these pages use,
and [Architecture](../../technical/architecture/) says how the parts talk.
