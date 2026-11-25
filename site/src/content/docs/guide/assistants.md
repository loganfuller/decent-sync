---
title: Assistants
description: Connecting Claude, ChatGPT or another app, and what it may do as you.
---

Each person with an account can connect their own AI assistant, Claude, ChatGPT or another MCP app, and ask about their coffee in plain words. The assistant acts as you, within what your account may do, and each approval you give is a Connected App. This page covers what you can ask, connecting an app, what it may do as you, how a change it makes is recorded, and seeing and disconnecting your apps.

The words in capitals, such as Connected App, Settings Edit and Reference Shot, are defined in the [Glossary](../../reference/glossary/).

## What you can ask

Ask as you would ask a colleague who has the whole server in front of them:

- "How many shots did the cafe pull yesterday, and with which beans?"
- "Have shots of the new Kenya batch been running faster than last week's?"
- "What is each machine at the cafe doing right now?"
- "How was the left machine dialed in this morning, and how did its shots run?"
- "Add this week's roast of the house blend at the cafe."
- "Put the new espresso recipe in slot 2."

A day, such as "yesterday", is each Location's own day in its time zone.

An assistant can read:

- Locations, and the Machines at each.
- Machines, with their settings, then or now, and what each is doing now.
- A Machine's activity, each dial-in change included, and how much it was used by day or by hour.
- Each Machine's scale, sensors, paired devices, plugins and Skins, its Settings Edits and its Settings History.
- Shots, with their curves, the Profile steps they ran, their time to first drip and their flow at the stop. It finds them by any of the Shots list's filters, its rating filter and its periods of each Location's own days among them.
- Every sample of a Shot, unrounded, for closer analysis.
- A summary of the Shots any filter finds, with the numbers it asks for: as one group, or grouped by Machine, Recipe, Bean, Bean Batch, Profile, Grinder, Basket, Barista or Location, two at once, such as two Machines on the same Recipe side by side, and by day or by week, each Location's own, to read a trend.
- Steam Records.
- The Library, with each item's history, Lost Edits among it, a Profile's versions and the Recipes on it.
- Drafts, for an Admin or Staff.

It can also simulate a Profile or a Draft: on a standard puck, finer or coarser, or on a Shot's own puck, for a DE1 or a Bengle. For a Shot's puck it says how close its simulation of that Shot's own steps comes to the Shot.

An assistant allowed to change things can:

- Create and edit Beans, Bean Batches, Grinders, Baskets, Tools and Recipes.
- Edit a Profile's title, author and notes.
- Archive and restore Library items.
- Change what a Location offers.
- Put Recipes in Recipe Slots, choose their Reference Shots and copy them to other Locations.
- Start, edit, publish and discard Drafts, have a Machine follow one, and return a Profile to an earlier version.
- Make Settings Edits.
- Move Machines between Locations.
- Rate a Shot or edit its note. It says whether that edit still awaits the Shot's Tablet.
- Reload the Skin on a Machine's Tablet.

[Assistant tools](../../reference/assistant-tools/) lists every tool an assistant has, with what each does.

## Connect an assistant

You add the server's MCP endpoint to the app: the server's address followed by `/api/mcp`, such as `https://sync.example.com/api/mcp`. Whoever runs the server knows its address, which is its `PUBLIC_URL`.

| App | How to add it |
|---|---|
| Claude, on the web, desktop or phone | Add it as a custom connector. |
| ChatGPT | Add it as a custom MCP server, with Client Identifier Metadata Document (CIMD) as its registration method and the Registration URL, client ID and secret left blank. |
| Claude Code | `claude mcp add --transport http decent-sync https://sync.example.com/api/mcp` |
| VS Code | Add it as an HTTP MCP server. |

Then approve it:

1. Add the endpoint in the app, as the table says. The app opens Decent Sync in your browser.
2. Sign in, if you are not signed in already.
3. Read the page that asks whether to connect the app. Above the name the app gives itself is the host it is published at, and below it the account it will act as. Any app can call itself Claude, so check the host.
4. Choose **Read**, or **Read and change**.
5. Choose **Allow**. Your browser goes back to the app, which is now connected. **Deny** sends it back without connecting.

A request to connect waits 10 minutes for your answer. After that, start again from the app.

Claude and ChatGPT connect from their own clouds, so for them the server must be on the internet at an `https://` address. An app on your own computer, such as Claude Code or VS Code, needs the server at an `https://` address it can reach from where it runs, which may be on a local network. Apps that can register only by Dynamic Client Registration, such as Cursor, can't connect. [Assistants](../../self-hosting/internet/#assistants) under On the internet has what the server needs, and how to turn assistants off for the whole server.

## Choose what it may do

The page that asks whether to connect the app offers two choices:

| Choice | What the app may do |
|---|---|
| **Read** | See what you can see in Decent Sync. |
| **Read and change** | Also change what you can change, but never accounts, and never delete anything for good but a Draft. |

- **Read** is chosen until you choose otherwise.
- An app that asked only to read is offered only **Read**.
- A Viewer's app can only read.
- To change the choice later, disconnect the app and connect it again.
- Apps usually ask you before making a change, unless you set them to make changes without asking.

## What an assistant may do as you

A Connected App acts as the account that approved it, so your role limits it exactly as it limits you. [Accounts and roles](../../guide/accounts-and-roles/) has what each role may do.

| Your role | What your assistant may do |
|---|---|
| Admin | Read everything, and make every change on this page, anywhere. Only an Admin's assistant can turn a Machine's sharing on or off, create and edit Locations, and make the Settings Edits marked for Admins. |
| Staff | Read everything an Admin's can, except the name of the account behind each recorded change, and the values of plugins' settings, of which it reads only which are set. Change the Library's shared content anywhere, and start, edit and discard any Draft. At the Locations you work at: manage Recipes and Grinders, add Bean Batches, change what the Location offers, publish Drafts, move Machines between them, have a Machine follow a Draft, make the Settings Edits open to Staff, edit Shots, and reload a Skin. |
| Viewer | Read what a Viewer sees, which leaves out Drafts. Change nothing, whatever the app asked for. |

A change to your role or your Locations applies to your apps from their next request. An app approved to read and change by someone who is then made a Viewer only reads while they are a Viewer.

Whatever your role, no assistant can:

- Grant access: it can't invite anyone, change a role, reset a password, or issue a Machine's Token.
- Delete anything for good. It Archives a Library item, which can be restored. Discarding a Draft is the one exception, as a Draft is unpublished work.
- Install, update, remove, approve or configure a plugin or a Skin on a Tablet, start Decaid's update, or change how any of them updates. An Admin does that on the Machine's **Software** tab, as it can put code on the Tablet. An assistant reads a Machine's Tablet Software and its Software Actions, and makes only one: reloading the Skin.

## See what an assistant changed

These changes an assistant makes are recorded as yours, through the app, and show as "*account*, through *app*":

- a Library change, in the item's history;
- a Settings Edit, in the Machine's Settings Edits;
- an edit of a Shot's rating or note, in the Shot's edits;
- a reload of a Skin, in the Machine's Software Actions;
- a Draft's latest save, beside the Draft as "saved … by *account*, through *app*". Only the latest save is kept, not each one.

Other changes, such as creating or editing a Location or moving a Machine, keep no record of who made them, whether an assistant or a person made them.

A change you make yourself in the management interface shows as "*account*, here" in an item's history, so the two are told apart.

## How much an answer holds

Each answer is kept small enough for Claude and ChatGPT to read whole:

- A long list comes a page at a time, and the assistant asks for the next page when it needs it.
- Very long text, such as a Shot's notes, may be cut. The answer says so, and how to read more of it.
- A Shot's curves are thinned, and every sample of a Shot can be read when an answer needs it.

Codex, Gemini CLI and VS Code take less, and may cut the larger answers or save them to a file.

## See and disconnect your apps

Open the menu under your name, and choose **Connected Apps**. On a phone it is in the menu, above **Sign out**. The page lists each app with its **Access**, when it was **Approved** and when it was **Last used**.

- Each approval is a Connected App of its own, so the same app on two devices is listed twice.
- To stop an app, choose **Disconnect**. It stops at once. To use it again, connect it again from the app.
- An app not used for 30 days stops working by itself, and leaves the list.
- When each was last used is recorded at most once an hour.

An Admin sees and disconnects everyone's apps under **Connected Apps** on the **Accounts** page. Deactivating an account disconnects all of its apps, and they stay disconnected if the account is reactivated.
