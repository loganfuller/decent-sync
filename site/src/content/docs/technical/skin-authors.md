---
title: For a Skin's author
description: What the plugin answers a Skin on its tablet.
---

A Skin runs on the tablet and knows only Decaid's API, so it can show nothing
the server holds. The plugin serves it
([ADR-0030](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0030-the-plugin-serves-a-skin-what-the-server-holds.md)): a
Skin calls an HTTP endpoint of the plugin's on the tablet, the plugin asks
the server over its own connection, and the answer comes back in the same
call. So far a Skin reads the [status](#status), [the Shots at its Machine's
Location](#the-locations-shots), [any one of them whole](#a-shot-whole) and
[a Recipe's Reference Shot](#a-recipes-reference-shot),
[chooses a Recipe's Reference Shot](#choosing-a-recipes-reference-shot),
[edits the rating and note of any Shot at the
Location](#editing-a-shots-rating-and-note), and
[has the Bean Batch of a QR code it scanned brought to its Machine's
Location](#scanning-a-bean-batchs-qr-code). It may [report its page and be
asked to reload](#reporting-the-page-and-reloading). It may also edit a Recipe by
writing its DYE2 record itself ([Writing DYE2's
recipes](#writing-dye2s-recipes)). What a Skin reads from Decaid's own
records, the plugin keeps current there: [a Bean Batch's Batch
Code](#a-bean-batchs-batch-code) is one. A Skin [enters a Bean Batch's weight
and finishes a batch](#entering-a-bean-batchs-weight-and-finishing-it) by
writing Decaid's record of it, with nothing asked of the plugin.

## Calling the plugin

Decaid serves a plugin's endpoints beside its own API, each by its name alone:

| | Address |
|---|---|
| HTTP | `http://<tablet>:8080/api/v1/plugins/decent-sync.reaplugin/<endpoint>` |
| WebSocket | `ws://<tablet>:8080/ws/v1/plugins/decent-sync.reaplugin/<endpoint>` |

- **Every answer is JSON.** A served request answers 200. A refusal answers
  another status, with a `code` and a `message` (see [Refusals](#refusals)).
  The one exception is [`page`](#reporting-the-page-and-reloading), which
  answers 204 with nothing in it.
- **Answers come quickly or not at all.** Decaid gives a plugin 30 seconds to
  answer. The plugin gives the server 10: a request still unanswered then is
  refused as `unreachable`. While the plugin isn't connected it refuses at
  once, without asking. Before it asks the server the plugin may ask Decaid
  first: for DYE2's recipes, to read which Recipe `reference` names, and to
  write [an edit of a Shot](#editing-a-shots-rating-and-note). Decaid's own
  API answers in milliseconds. Were it to take most of the 30 seconds, the
  call could run past them, and Decaid then answers it itself, with an
  `error` and no `code`. Treat that as `unreachable`: a choice, an edit or
  a scan may still have been made.
- **Nothing is queued.** A request refused as `unreachable` was not kept, and
  is not sent later. Ask again. That holds for
  [a choice](#choosing-a-recipes-reference-shot) and for
  [an edit of another tablet's Shot](#editing-a-shots-rating-and-note) and
  for [a scan](#scanning-a-bean-batchs-qr-code) too: one refused while the
  plugin isn't connected changes nothing, then or later.
- **Decaid answers some requests itself.** It answers 404 while the plugin
  isn't loaded, and for an endpoint the installed plugin doesn't have, such
  as `status` on the 1.9.0 plugin or an earlier one.
- **The status is asked at once.** It doesn't wait for what the tablet has
  still to send the server, so it answers while a tablet catches up after an
  outage.
- **Shots are asked once the tablet has caught up.** A request to `shots`,
  `shot` or `reference`, a choice included, goes to the server behind what
  the tablet had still to send as the Skin asked, so a Shot pulled a moment
  ago on this tablet is in the answer, and can be chosen.
  While a tablet catches up after an outage that can take longer than the 10
  seconds, and the request is refused as `unreachable`, whatever else would
  have refused it. For a moment after the plugin loads, while it reads back
  what it kept for the server, they are refused as `unreachable` at once.
  Ask the status, which doesn't wait, to learn whether the Machine is
  served. A `reference` refused so is answered from the tablet's copy where
  it has one.
- **An edit of a Shot is asked at once.** It waits for nothing the tablet
  has still to send, as it is of a Shot another tablet holds, so a Shot can
  be rated while a tablet catches up.
- **A scan is asked at once too.** Where a batch is, is the server's to say,
  so a bucket can be scanned while a tablet catches up.

Anything on the tablet's network can call these endpoints, as it can Decaid's
own API but for managing plugins and Skins where Decaid asks a token for it
([A token for managing plugins](../../reference/tablet-plugin/#a-token-for-managing-plugins)): Decaid
checks no caller of them.
That network can already change the Workflow and delete Shots through Decaid. The server holds each tablet to its
own Machine's Location, whatever a caller asks for.

## Status

`GET /api/v1/plugins/decent-sync.reaplugin/status` says whether the plugin is
connected to the server, whether its Machine is served, which Machine and
Location it is, and whether it can match scanned text. Call it to decide
which screens to show.

A Machine is served while it takes part in the Library: at a Location, with
its sharing on, connected as itself. Served, it answers 200:

```json
{
  "connected": true,
  "served": true,
  "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70", "name": "Bar Left" },
  "location": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a71", "name": "Downtown" },
  "scan": true
}
```

Otherwise it answers the refusal every other endpoint would give at that
moment: that HTTP status, with the same fields and the refusal's `code` and
`message`. So `served` alone decides, whatever the status:

```json
{
  "connected": true,
  "served": false,
  "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a70", "name": "Bar Left" },
  "location": null,
  "scan": true,
  "code": "captureOnly",
  "message": "This Machine is a Capture-only Machine: it is at no Location, or its sharing is off, so it takes no part in the Library."
}
```

| Field | What it is |
|---|---|
| `connected` | Whether the plugin holds a connection the server has welcomed. |
| `served` | Whether the other endpoints answer for this Machine now. |
| `machine` | The Machine's id and name on the server. Null while the server wasn't asked or didn't answer, and for `hardwareMismatch`. |
| `location` | The Location the Machine is at, by id and name, whether or not it shares there. Null where it is at none, and wherever `machine` is null. |
| `scan` | Whether the plugin can [match scanned text](#scanning-a-bean-batchs-qr-code) now: it is connected to a server that can be asked to. False while it isn't connected, and while it is connected to a server of the release before the request, as during an upgrade. Absent on a plugin from before the request, which has no `scan` endpoint: read absent as false. Show a scan control only where `served` and `scan` are both true. |
| `code`, `message` | Why it isn't served. Absent while it is. |

Each call asks the server afresh. Nothing is remembered from the last answer.

## The Location's Shots

`GET /api/v1/plugins/decent-sync.reaplugin/shots` lists the Shots at the
Machine's Location, whichever Machine pulled them: the Shots the management
interface's Shots list lists for that Location. Newest first by when they
were pulled, a page at a time, with no filters.

| Query | What it is |
|---|---|
| `limit` | How many Shots the page may hold, from 1 to 50. 50 without it. |
| `cursor` | The `nextCursor` of the page before. Leave it out for the first page. |

```json
{
  "shots": [
    {
      "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e",
      "pulledAt": "2026-11-14T15:02:11.482Z",
      "machine": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a72", "name": "Bar Right" },
      "onThisTablet": false,
      "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
      "bean": { "roaster": "Lantern Coffee Roasters", "name": "Ethiopia Guji" },
      "dose": 18.2,
      "targetDose": 18,
      "yield": 36.4,
      "targetYield": 36,
      "duration": 27.31,
      "rating": 8,
      "barista": "Sam",
      "hasNote": true,
      "unfinished": false,
      "referenceOf": [{ "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" }]
    }
  ],
  "nextCursor": "WzE3OTQ2Njg1MzE0ODIsIjBmNmMxYzVlLTBmMGEtNGQ2ZS05ZDBiLTZmMWIxYTJjM2Q0ZSJd"
}
```

| Field | What it is |
|---|---|
| `id` | The Shot's id, which is Decaid's. Read it whole with [`shot`](#a-shot-whole). |
| `pulledAt` | When it was pulled, in UTC. |
| `machine` | The Machine that pulled it, by its id and name on the server. Compare its id with the [status](#status)'s to tell this Machine's Shots from the others'. |
| `onThisTablet` | Whether this tablet is the one that last reported the Shot, so Decaid's own API has it unless it was deleted there since. |
| `recipe` | The Recipe it was pulled with, or null: its id and name on the server, and `recordId`, the id of this tablet's DYE2 record of it, which the Workflow names in `context.extras.dye.recipeId`. `recordId` is null where this tablet holds no record of the Recipe, as for another Location's Recipe, which a Shot names once its Machine's Location History is corrected. |
| `bean` | The coffee's `roaster` and `name`, as the Shot recorded them. |
| `dose`, `targetDose` | The dose weighed and the dose aimed for, in grams. |
| `yield`, `targetYield` | The yield weighed and the yield aimed for, in grams. |
| `duration` | How long it ran, in seconds, without its Preheat. |
| `rating` | Its rating on Decaid's scale of 0 to 10, where 0 is unrated. |
| `barista` | The Barista's name, as the tablet recorded it. |
| `hasNote` | Whether it has a note. |
| `unfinished` | Whether it is an Unfinished Shot, in which nothing poured: the Machine never reported pouring and the scale never showed 1 g in the cup, past a cup weighed before the Shot's tare. A cleaning or calibration Shot is never one. |
| `referenceOf` | The Recipes of this Location it is the Reference Shot of, each named as `recipe` is, by name. Empty for most Shots. An Archived Recipe is left out, and so is another Location's. |

A value the Shot didn't record is null. `nextCursor` is null on the last
page; otherwise send it back as `cursor` for the next. A cursor is the
server's to read: treat it as opaque. It stays good while Shots are pulled
or leave the list, so a Shot pulled since the first page isn't in a later
one. Read the first page again to see it.

A Shot leaves the list when an Admin corrects its Machine's Location
History so that it was pulled at another Location, and joins that
Location's.

## A Shot whole

`GET /api/v1/plugins/decent-sync.reaplugin/shot?id=<Shot's id>` gives one of
those Shots with its measurements:

```json
{
  "shot": { "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e", "timestamp": "…", "workflow": { }, "annotations": { }, "measurements": [ ] },
  "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
  "referenceOf": []
}
```

| Field | What it is |
|---|---|
| `shot` | The Shot's record with its `measurements`, as the server stores them, which is as Decaid sent them: what Decaid's `GET /api/v1/shots/<id>` gives on the tablet that holds it. Draw it with the code that draws the tablet's own Shots. |
| `recipe` | The Recipe it was pulled with, as a row names it, or null. |
| `referenceOf` | The Recipes it is the Reference Shot of, as a row names them. |

A tablet reads whole only a Shot its list would list. Any other is refused
as `noSuchShot`, whether or not the server holds it: another Location's, a
Shot that left the list, and an id that names nothing are answered alike.

A long Shot's record passes 1 MiB. It is read whole all the same, and takes
longer to arrive. Answers reach the tablet in turn, so ask for a few Shots
at a time: one still waiting behind the others after 10 seconds is refused
as `unreachable`, and the server leaves requests unanswered while a tablet
is far behind on what it asked for. An answer longer than about 16.7
million characters is never sent, so a Shot or a page that long is refused as
`unreachable` each time: no Shot Decaid records comes near it.

## A Recipe's Reference Shot

`GET /api/v1/plugins/decent-sync.reaplugin/reference?recipe=<record id>`
gives a Recipe's Reference Shot: the one Shot chosen to show how the
Recipe's Shots should go. Every tablet at a Location is given the same one,
whichever Machine or Location pulled it.

Name the Recipe by the id of its DYE2 record on this tablet: the id the
Workflow names in `context.extras.dye.recipeId`, which each of the tablet's
Shots records, and the `recordId` the other endpoints give. The plugin
turns it into the Recipe's own id, which the record carries.

```json
{
  "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" },
  "reference": {
    "shot": { "id": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e", "timestamp": "…", "workflow": { }, "annotations": { }, "measurements": [ ] },
    "recipe": null,
    "referenceOf": [{ "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" }],
    "rating": 8,
    "note": "Sweet, a little thin",
    "profileDiffers": false
  },
  "source": "server"
}
```

| Field | What it is |
|---|---|
| `recipe` | The Recipe asked about, named as a row's `recipe` is. |
| `reference` | Its Reference Shot, or null where it has none. |
| `reference.shot`, `.recipe`, `.referenceOf` | The Shot whole, as [`shot`](#a-shot-whole) gives one: its record with its `measurements`, the Recipe it was pulled with, and the Recipes of this Location it is the Reference Shot of. |
| `reference.rating` | Its rating on Decaid's scale of 0 to 10, where 0 is unrated. Null where it recorded none. |
| `reference.note` | Its note, or null. |
| `reference.profileDiffers` | Whether it was pulled on another Profile than the Recipe's: the Recipe names a Profile, and the Shot's is another, or none in the Library. Its curves then describe another program. False for a Recipe that names no Profile. |
| `source` | `"server"` where the server answered just now. `"tablet"` where it couldn't be asked and this is the tablet's copy, which may be older. |

- **The server is asked first.** While it answers, the answer is the
  server's, for a Recipe in a slot or in none.
- **The tablet's copy stands in while the server can't be asked.** The
  plugin keeps a copy for each Recipe in a Recipe Slot at its Location
  ([Reference Shot copies](../../reference/tablet-plugin/#reference-shot-copies)). Where the request would
  be refused as `unreachable`, it answers 200 from that
  copy instead, with `source` `"tablet"`. That includes a copy saying the
  Recipe has none.
- **No copy, no answer.** A Recipe in no slot has no copy, and neither has
  one whose Reference Shot is too large to keep (1 MiB). Those are refused as
  `unreachable` while the server can't be asked.
- **A Reference Shot may be another Location's.** A tablet reads it whole
  through this endpoint all the same. Through [`shot`](#a-shot-whole) that
  Shot is still refused as `noSuchShot`.
- **A hidden Shot reads as none.** A Reference Shot whose Pending Machine was
  dismissed is `null` until that hardware is given a machine entry.
- **A record must be a Recipe of the Library's.** A `recipe` no record on the
  tablet has, or whose record carries no Recipe's id, as one a barista saved
  moments ago, is refused as `noSuchRecipe`. So is a Recipe of another
  Location.

Listen on [`changes`](#changes) for the push that says a Recipe's Reference
Shot changed, and read it again then.

## Choosing a Recipe's Reference Shot

`PUT /api/v1/plugins/decent-sync.reaplugin/reference?recipe=<record id>`
makes a Shot the Recipe's Reference Shot, from the tablet where it was
judged. Name the Recipe as a read does, by the id of its DYE2 record on this
tablet, and the Shot in a JSON body:

```json
{ "shotId": "0f6c1c5e-0f0a-4d6e-9d0b-6f1b1a2c3d4e" }
```

It answers 200 with the Recipe's Reference Shot as it now is: what
[reading it](#a-recipes-reference-shot) gives, whole, with `source`
`"server"`. The server makes the choice as it makes one in the management
interface, and it reaches every tablet at the Location and the management
interface at once.

- **Any Shot the tablet can open.** A Shot in [the Location's
  list](#the-locations-shots), whichever Machine pulled it, or the Reference
  Shot of one of the Location's Recipes, which may be another Location's.
  Any other Shot is refused as `noSuchShot`.
- **Only the Location's Recipes.** A Recipe of another Location, which a
  tablet may still hold a record of for a moment after its Machine moves, is
  refused as `notAtThisLocation`. A record that carries no Recipe's id, or a
  Recipe the server no longer has, is refused as `noSuchRecipe`.
- **Not an Archived Recipe.** It is refused as `archived`, as in the
  management interface, until the Recipe is restored.
- **A tablet can't clear one.** A request names a Shot. One without a
  `shotId` is refused as `invalidRequest`. Clearing a Reference Shot is done
  in the management interface or by an assistant.
- **A Shot pulled a moment ago can be chosen.** The request follows what the
  tablet has still to send, so the server has the Shot by the time it is
  asked.
- **It is made now or not at all.** While the plugin isn't connected the
  request is refused as `unreachable` at once, without
  being sent, and nothing is kept to send later. The tablet's copy is no
  answer to a choice.
- **A choice the plugin sent may have been made, whatever it answers.** The
  plugin also answers `unreachable` when it sent the request and has no
  answer: its connection closed first, or 10 seconds passed. The server may
  have made that choice already, or make it within the next minute if it
  was still waiting its turn. The answer doesn't say which `unreachable` it
  is. So after one, read the reference again once the plugin is connected,
  or wait for the push, before showing the choice as failed.
- **No person is named.** The Recipe's history in the management interface
  names the Machine the Reference Shot was chosen on, and no account. Anyone
  at the tablet may choose.
- **The same Shot again changes nothing.** It answers 200 as the first time
  did, and adds nothing to the Recipe's history.

The tablet's own [copy](../../reference/tablet-plugin/#reference-shot-copies) is replaced a moment after
the answer, for a Recipe in a slot, and a [push](#changes) follows it, on
this tablet and on the others at the Location.

## Editing a Shot's rating and note

`PUT /api/v1/plugins/decent-sync.reaplugin/shot?id=<Shot's id>` sets a
Shot's rating, its note or both
([ADR-0031](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0031-a-shots-rating-and-note-are-edited-through-the-server.md)).
It is one call for any Shot in [the Location's list](#the-locations-shots),
whichever tablet holds it: a Skin needn't know where a Shot is held. Send
what to set in a JSON body, and leave out what to leave alone:

```json
{ "rating": 8, "note": "Sweet, a little thin" }
```

| Field | What it is |
|---|---|
| `rating` | A number from 0 to 10, whole or not, on Decaid's scale, where 0 is unrated. |
| `note` | Text of at most 40,000 characters, where empty is none. |

It answers 200 with the Shot's rating and note as they now are:

```json
{ "rating": 8, "note": "Sweet, a little thin" }
```

`rating` is null where the Shot has none, and `note` where it has none or
only blanks, as [a Reference Shot's](#a-recipes-reference-shot) are.

- **The tablet's own Shot works without the server.** The plugin sends the
  edit to Decaid's own Shot update (`PUT /api/v1/shots/{id}`) first, with
  only the fields given. Where Decaid holds the Shot it is written at once,
  whether or not the plugin is connected, and whether or not the Machine is
  served: a Capture-only Machine's Skin rates its own Shots this way too.
  The edit reaches the server as any edit made on the tablet does, when the
  plugin is next connected, with no person and nothing added to the Shot's
  list of edits.
- **Any other Shot goes through the server.** Where Decaid answers that the
  tablet doesn't hold the Shot, the plugin asks the server. The server
  applies the edit at once, so the management interface, the Location's
  list and a Shot Summary show it, and writes it into the Shot on the
  tablet that holds it, now if that tablet is connected and otherwise when
  it next connects ([A Shot's rating and note](../../reference/tablet-plugin/#a-shots-rating-and-note)).
- **Only the Shots in the Location's list.** Any other is refused as
  `noSuchShot`: another Location's, an id that names nothing, and the
  Reference Shot of one of the Location's Recipes that was pulled
  elsewhere, though the tablet can read that one.
- **Another tablet's Shot is edited now or not at all.** While the plugin
  isn't connected the request is refused as `unreachable` at once, without
  being sent, and nothing is kept to send later.
- **An edit the plugin sent may have been made, whatever it answers.** As
  for [a choice](#choosing-a-recipes-reference-shot), the plugin also
  answers `unreachable` when it sent the request and has no answer. After
  one, read the Shot again once the plugin is connected before showing the
  edit as failed.
- **The later edit of a field wins.** Where the rating or the note was
  changed on the tablet that holds the Shot later than this edit, without
  seeing it, that tablet's stands, and the Shot's page in the management
  interface lists the other as dropped. An edit of the rating never undoes a
  note, or the reverse.
- **The Machine is named, and no person.** The Shot's page in the management
  interface lists an edit made through the server with the Machine it was
  made on, and no account. Anyone at the tablet may edit.
- **Only the rating and the note.** Any other field in the body, a null, a
  rating outside 0 to 10, a note that is too long or holds a NUL or half of
  a surrogate pair, and a body with neither is refused as `invalidRequest`,
  whichever tablet holds the Shot, before Decaid or the server is asked. To
  clear a rating send 0, and to clear a note send empty text.
- **If Decaid refuses its own Shot's edit,** or doesn't answer, the request
  is refused as `shotUnwritten`, and the server is not asked.
- **Nothing is pushed** when a Shot is edited, but for [a Recipe's Reference
  Shot](#changes), whose copy on each tablet follows the edit. Read the
  list again to show an edit made elsewhere.

## Scanning a Bean Batch's QR code

`PUT /api/v1/plugins/decent-sync.reaplugin/scan` asks which Bean Batch a
scanned QR code is, and brings that batch to the Machine's Location, so a
barista can pick a bucket by its label, one that has just arrived included.
The Skin reads the code: send the text it held, as it was read, in a JSON
body. The plugin and the server decode nothing.

```json
{ "text": "PR-0470" }
```

The server matches the text against the batches that are not Archived, of
Beans that are not, stopping at the first step that finds any:

1. **The whole text is a Batch Code,** ignoring case and the white space
   around it.
2. **The text is a URL or JSON that holds one:** a URL's last path segment,
   one of its query values or its fragment, or one of JSON's string values,
   at any depth. A URL has a scheme and `//`, as
   `https://roaster.example/b/PR-0470` has.
3. **The text names a Bean:** every word of the text is in the Bean's
   roaster and name, or every word of the Bean's name is in the text. That
   matches each of the Bean's batches. A date in the text narrows them to
   the batches roasted that day, where it is written year first
   (`2026-11-20`) or with its month by name (`20 Nov 2026`). A date of
   numbers with the year last is not read, as its day and month would be
   guessed. This step is not taken where the code of an Archived batch, or
   of a batch of an Archived Bean, is the whole text, a value of its URL or
   JSON, or a part of plain text set off by spaces: a label for a retired
   batch matches nothing, though it names the Bean too.

Every answer is 200 with an `outcome`:

| `outcome` | What happened | With |
|---|---|---|
| `moved` | The text matched one batch, which was at exactly one other Location. All of it was moved to the Machine's Location, with its remaining weight, and it is finished at the Location it left. | `batchId`, `beanId` |
| `added` | It matched one batch, which was at several other Locations, or at none. It was added at the Machine's Location and no weight moved, since nothing says which Location's coffee arrived. | `batchId`, `beanId` |
| `alreadyThere` | It matched one batch, which was at the Machine's Location already. Nothing changed. | `batchId`, `beanId` |
| `several` | It matched more than one batch. Nothing changed. | `matches`, `more` |
| `noMatch` | It matched nothing. Nothing changed. | |

For one batch, `batchId` and `beanId` are this tablet's own ids, Decaid's,
for the batch's record and its bean's:

```json
{ "outcome": "moved", "batchId": "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca", "beanId": "1ebec875-1533-46d3-bc5f-9de5c85d9c2b" }
```

The plugin answers only once Decaid lists that batch, not archived, under a
bean that is not, so read Decaid's beans and batches again and select it.
Treat the three outcomes alike unless you have something to say about each.

For several, `matches` lists them, newest roast first, at most 20, and
`more` says whether more matched than it holds. Each has the Bean's
`roaster` and `name`, the batch's `roastDate` as `YYYY-MM-DD` and its
`batchCode`, each null where there is none, and an `id` to choose it by:

```json
{
  "outcome": "several",
  "matches": [
    { "id": "3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c", "roaster": "Roux", "name": "Guji Natural", "roastDate": "2026-11-20", "batchCode": "PR-0470" },
    { "id": "3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2d", "roaster": "Roux", "name": "Guji Natural", "roastDate": "2026-11-12", "batchCode": null }
  ],
  "more": false
}
```

Have the barista choose one, and ask again with its `id` as `match` in
place of the text. That brings the batch as a match of one does:

```json
{ "match": "3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c" }
```

- **A scan takes no weight.** A move is of all the batch had where it was. A
  batch added is untracked at the Machine's Location until someone enters
  its weight there.
- **A scan never creates a batch or brings back an Archived one.** A code
  for an Archived batch, or for a batch of an Archived Bean, is `noMatch`,
  as is a `match` that names one, or names no batch at all.
- **The text is at most 2,048 characters.** Longer text, text with a NUL or
  an unpaired surrogate, a `match` that is no id, both `text` and `match`,
  and neither are refused as `invalidRequest`. Empty text is `noMatch`.
- **Ask the status first.** Show a scan control only while
  [the status](#status) answers `served` and `scan` as true. A plugin from
  before this request has no `scan` endpoint, and Decaid answers 404 for it.
- **It is made now or not at all.** While the plugin isn't connected the
  request is refused as `unreachable` at once, without being sent, and
  nothing is kept to send later. A Capture-only Machine is refused as
  `captureOnly`. While the plugin is connected to a server of the release
  before this request, as during an upgrade, it is refused as
  `serverTooOld`, without being sent.
- **A scan refused for time may still have brought the batch.** The plugin
  gives the request 10 seconds from when the Skin asked: for the server to
  answer, and for the tablet to hold the batch. One refused as
  `unreachable` after it was sent may have moved or added the batch: the
  server's answer was lost or late, or the tablet's record had yet to
  arrive, which it does not while the Machine pulls a Shot. Ask again with
  the same text, which then answers `alreadyThere` once the tablet holds
  the batch.
- **The barista is credited, with the Machine.** The batch's history in the
  management interface names the Machine the scan was made on and the
  barista its Workflow named then (`context.baristaName`), which the plugin
  reads from Decaid, and no account. With no barista named it names the
  Machine alone. Anyone at the tablet may scan.
- **The Workflow is left alone.** A scan brings a batch to the Location. It
  puts nothing in the Workflow: the Skin does that when the barista chooses
  to use the batch, as for any other batch.

## Refusals

Every refusal is an HTTP status with a `code` to act on and a `message` to
show. A Skin refused as `unreachable`, `captureOnly` or
`hardwareMismatch` shows its tablet's own Shots.

| Code | Status | When |
|---|---|---|
| `unreachable` | 503 | The plugin isn't connected to the server, its connection closed before the answer came, or the server didn't answer within 10 seconds. |
| `serverTooOld` | 503 | The plugin is connected to a server of the release before what was asked, as during an upgrade, so the request was not sent. Answered for [a scan](#scanning-a-bean-batchs-qr-code) while the server is from before it, when [the status](#status) says `scan` is false; and by the plugins of 1.10.0 to 1.11.1 for every endpoint, while connected to a 1.9.0 server. Treat it as `unreachable`. |
| `captureOnly` | 409 | The Machine is a [Capture-only Machine](../../reference/tablet-plugin/#capture-only-machines): at no Location, or with its sharing off. |
| `hardwareMismatch` | 409 | The machine connected to the tablet is not the one the tablet's token was issued for. Its records wait as a Pending Machine's, or go to the Machine that hardware belongs to, until an Admin settles it on the Machines page. |
| `noSuchShot` | 404 | No Shot at the Machine's Location has the id asked for, or to be edited. For a choice: the Shot is none this tablet can open. |
| `noSuchRecipe` | 404 | No DYE2 recipe on the tablet has the record id asked for, or the one that has it is no Recipe of the Machine's Location. For a choice: its record carries no Recipe's id, or the server has no such Recipe. |
| `notAtThisLocation` | 403 | A choice only: the Recipe belongs to another Location than the Machine's. |
| `archived` | 409 | A choice only: the Recipe is Archived. |
| `recipesUnread` | 500 | Decaid didn't give the plugin DYE2's recipes, or gave them in a shape it doesn't recognise, so it couldn't tell which Recipe was asked about. Ask again. |
| `shotUnwritten` | 500 | An edit of the tablet's own Shot only: Decaid refused the update, or didn't answer it. The `message` gives Decaid's status. Ask again. |
| `invalidRequest` | 400 | The request is not one the endpoint can read: a `limit` that is no whole number from 1 to 50, a `cursor` no page gave, or no `id`, `recipe` or, for a choice, `shotId`, or one longer than 2,048 characters, or, for an edit, a body that sets neither a rating nor a note, or sets one to a value it can't take, or sets anything else, or, for a scan, a body with no `text` or `match`, with both, with text longer than 2,048 characters or holding a NUL or an unpaired surrogate, or with a `match` that is no id. The `message` says which. |

The plugin answers some of these itself, at once, without asking the server:
`unreachable` while it isn't connected, `serverTooOld`, `recipesUnread`,
`shotUnwritten`, `noSuchRecipe` for a record that carries no Recipe's id, and
`invalidRequest` for a `limit`, a missing `id`, `recipe` or `shotId`, an
`id`, `recipe`, `shotId` or `cursor` too long to be one, an edit's body, or
a scan's.
The server answers the rest, and tells a Machine that isn't served so
whatever it asked for, but for an edit of the tablet's own Shot, which the
server is never asked.

A request with a method an endpoint doesn't take answers 405, with an `error`
in place of a `code`. `status`, `shots`, `shot` and `reference` take
GET, `shot` and `reference` take PUT too, and `scan` and `page` take PUT
alone.

## Changes

A Skin listens on the WebSocket endpoint `changes` rather than polling. Each
push is a JSON object whose `what` names what changed. So far there are
four: the three here, and `reload`, under
[Reporting the page, and reloading](#reporting-the-page-and-reloading).

```json
{ "what": "connection", "connected": true }
```

It is sent when the server welcomes the plugin's connection, and when that
connection is lost. Read the status again after it: the Machine may have
moved, or its sharing changed, while the plugin was away.

```json
{ "what": "reference", "recipe": { "id": "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a80", "name": "House espresso", "recordId": "05fd1e80-61e3-46ef-b202-2cbad5eb7983" } }
```

It is sent when the tablet's copy of a Recipe's Reference Shot changes:
another Shot was chosen, on a tablet or anywhere else, or it was cleared,
the Shot's rating or note changed, or the Recipe entered a slot. It names
the Recipe as an answer does, `recordId` being the id of this tablet's DYE2
record of it. Read [`reference`](#a-recipes-reference-shot) again for that
Recipe if it is the one on screen.

- **Only Recipes in a slot are pushed.** A Recipe in no slot has no copy, so
  nothing is pushed when its Reference Shot changes. Read it again when the
  Skin shows it.
- **A tablet that was off is pushed what changed when it reconnects**, once
  the server has sent the copies it missed.
- **A push may repeat.** One is also sent when the Recipe is renamed, so
  compare what `reference` gives with what is drawn.

```json
{ "what": "batch", "batch": "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca" }
```

It is sent when the plugin archives a Bean Batch's record on the tablet, or
brings it back: the batch was finished at the Machine's Location, archived
in the Library, or moved to another Location, or the Machine joined or
moved to a Location that does not offer it, or it was added back or
restored. `batch` is the id of Decaid's record of it, as the Workflow's
`beanBatchId` names it. The push says nothing of the record: read it again
from Decaid (`GET /api/v1/bean-batches/{id}`) if the batch is on screen, as
you would when the page comes back into view.

- **Only the plugin's own writes are pushed.** A batch archived by hand on
  the tablet, in DYE2, is not, and nothing else changing the record is.
  Keep reading the record when the page loads or comes back.
- **It is interim.** Decaid has no push of its own yet for a batch's record
  changing
  ([decentespresso/decaid#1271](https://github.com/decentespresso/decaid/issues/1271)).
  Once it has, follow Decaid's instead: this one will stop in a later
  release.

- Decaid sends a push only to the sockets open at that moment, and keeps none
  for a socket opened later. Read the status once the socket opens.
- A Skin can send nothing on this socket.
- Ignore a `what` you don't know. Later releases add more.

## Reporting the page, and reloading

A Skin that reports its page lets an Admin, or Staff at its Location,
reload it from anywhere, and the Machine's Software tab show which build it
is showing. A Skin that does neither is unaffected: it is never pushed the
reload, and is reloaded only by restarting the Skin view.

Each time the page loads, and each time its socket on `changes` opens, PUT
its Skin id, its version and when the page loaded to the HTTP endpoint
`page`:

```js
const PLUGIN = `http://${location.hostname}:8080/api/v1/plugins/decent-sync.reaplugin`;
const page = { skinId: "my-skin.js", version: "1.2.0", loadedAt: new Date(performance.timeOrigin).toISOString() };
const report = () => fetch(`${PLUGIN}/page`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(page) }).catch(() => {});
report();
// ...and on each `open` of the WebSocket on `changes`:
socket.addEventListener("open", report);
```

- `skinId` is the Skin's id as Decaid's Skin list names it: the `id` in its
  `skin-manifest.json`. `version` is optional. `loadedAt` is an ISO 8601
  time, the same for every report of one page load, and later for each new
  load: `performance.timeOrigin` gives both. It may be at most a minute
  ahead of the tablet's clock.
- It answers 204, whether or not the plugin is connected to the server. A
  body it can't read answers 400 with `invalidRequest` and a `message`;
  any method but PUT answers 405.
- Only a report from the tablet's own Skin view counts: one whose `Host`
  is `localhost`, `127.0.0.1` or `[::1]`, as Decaid's Skin view loads the
  Skin from `http://localhost:<port>/`. Address Decaid as your page's own
  `location.hostname` does there. A report from another device, as a
  browser on the cafe's network, answers 204 and is not kept, so it never
  sets what the tablet shows or confirms a reload.
- Report again each time your socket on `changes` opens. Decaid keeps it
  open while it loads the plugin again, as after a settings change or an
  update; the plugin then holds no page, and still asks your page to reload
  when asked to, counting the first report of your Skin after its push.

To be reloaded, listen on `changes` for:

```json
{ "what": "reload" }
```

and load the page again (`location.reload()`). The reload is done once your
fresh page reports a later `loadedAt` than the page before (or, where the
plugin holds none, reports at all) within 15 seconds; a page that
reports nothing in that time, or a page of another Skin, leaves it not
confirmed.

## A Bean Batch's Batch Code

A Bean Batch may hold a Batch Code, the roaster's own identifier for the
roast, as on its label. A Skin needs nothing from the plugin to show it: the
plugin writes it onto Decaid's own record of the batch, so a Skin reads it
where it reads the batch, and it is there while the server can't be reached.

Decaid's batch record has no field for it yet
([decentespresso/decaid#1263](https://github.com/decentespresso/decaid/issues/1263)),
so until it has, the code is in the record's `extras`, under
`decentSyncBatchCode`, beside the batch's Library id, `decentSyncId`
([ADR-0036](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0036-interim-a-batch-code-in-the-records-extras.md)):

```json
{
  "id": "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca",
  "beanId": "1ebec875-1533-46d3-bc5f-9de5c85d9c2b",
  "roastDate": "2026-11-18T00:00:00.000",
  "extras": { "decentSyncId": "3f6b2a1c-8d4e-4f5a-9b6c-7d8e9f0a1b2c", "decentSyncBatchCode": "PR-0470" }
}
```

- It is text of at most 100 characters, with no set format. Where the batch
  has none, the key is absent or null: treat both, and anything that is not
  text, as none.
- No two batches that are not Archived hold the same code, compared ignoring
  case and the spaces around it. An archived record may hold a code another
  batch has since been given.
- Read it, and don't write it. A value a Skin, or anything else on the
  tablet, puts under the key is no edit: the plugin writes the Library's
  code, or none, back over it, and nothing in the Library changes. Keep the
  key, with the record's other `extras`, when you update a batch, as Decaid
  replaces `extras` whole.
- A tablet whose plugin is older than this has no key until its plugin
  updates. Decent Sync writes the key from the release after v1.14.0.
- This is interim. Once Decaid's record has the field, a later release
  writes it there instead, and this page will say which release. A Skin that
  reads the field first and falls back to the key will keep working.

## Entering a Bean Batch's weight, and finishing it

A Skin enters what is left of a Bean Batch, and finishes one, by writing
Decaid's own record of it. It asks nothing of the plugin, so both work while
the server can't be reached. The Streamline Cafe Skin does so from its bean
and batch dialog
([ADR-0037](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0037-a-batchs-remaining-weight-is-per-location-and-worked-out-from-shots.md),
What a tablet holds).

To enter a weight, write `weightRemaining` alone, in grams, with Decaid's
`PUT /api/v1/bean-batches/{id}`, which keeps every field it is not given:

```json
{ "weightRemaining": 2890 }
```

To finish the batch, archive the record the same way:

```json
{ "archived": true }
```

The plugin reports the changed record at its next poll, 30 s by default, or
once it reconnects. The server takes a changed `weightRemaining` as a weight
entered at the Machine's Location, which starts the count there again, and an
archived record as the batch finished there. Either is timed by the record,
and the batch's history names the Machine and no account. The server then
writes the Location's other tablets the weight, or archives their records.

- **Never send the whole record.** Its `extras` hold the batch's Library id
  and [Batch Code](#a-bean-batchs-batch-code), and Decaid replaces `extras`
  whole. A record read a moment ago may also hold a weight the server has
  since written over, after a Shot.
- **Finish by archiving, never by writing zero.** A record that already
  reads zero keeps its weight when zero is written to it, so the server
  finds no weight entered. A zero the server wrote there after Shots is no
  weight entered either, and finishes nothing. An archive is a finish whatever the record reads.
- **A weight the record held before may not be taken.** After each Shot and
  each move the server writes the record its Location's current weight, and
  keeps the latest sixteen weights the record has held since the Location's
  count last started, so as not to read its own write back as an entry. A weight
  written by a Skin that equals one of them is not taken as entered, and the
  server writes its own number back: a batch entered at 400 g and written
  382 g after a Shot, then entered at exactly 400 g again, reads 382 g
  again. Nothing tells the Skin. This limit is accepted, and a different
  weight, by as little as a gram, is taken.
- **Read the record again after writing it.** Nothing pushes a Skin a change
  it made itself ([Changes](#changes)). On the Location's other tablets, the
  plugin's archive of the record is pushed as a `batch`.
- **A Capture-only Machine's records are its own.** Nothing written there is
  taken at any Location.
- **A container's weight is the Skin's.** A Skin that takes the weight of the
  container a batch is kept in off what the scale reads holds that weight
  itself, as Streamline Cafe does in a setting on each tablet. Decent Sync
  neither holds nor sets it, and is written only what is left.

## Streamline's endpoints

The plugin's `skin` endpoint and its `changed` WebSocket are the ones
Streamline reads, and are unchanged. `changed` pushes only
`{"what":"workflow"}`, which Streamline reads as a change to the Workflow or
DYE2's recipes. Nothing above is pushed there.

## Writing DYE2's recipes

A Skin may edit a Recipe by writing its record in DYE2's list of recipes,
`recipes` under `dye2.reaplugin` in Decaid's store, as DYE2's editor does.
The Streamline Cafe Skin does so to change a Loaded Recipe's Profile or
Bean, renaming one still under the name DYE2 generated for it
([ADR-0022](https://github.com/loganfuller/decent-sync/blob/main/docs/adr/0022-loaded-recipe-worked-out-from-the-workflow.md)). The
server takes the record's change as the Machine's edit of the Recipe and
writes it to every tablet at the Location.

- **What the server reads.** `profileId`, `beanId` with `beanBatchId`,
  `name`, and the dial and settings in `dashboardVariables` that DYE2's
  editor saves. Beside a `profileId` it reads no `profileTitle` or
  `profileSnapshot`, and beside a `beanId` no `beanName` or `beanRoaster`.
  It rewrites `title`, `subtitle`, the names DYE2 copies and the embedded
  `workflow` from the Recipe, so a Skin writes those for DYE2 alone.
- **Write `beanId` and `beanBatchId` together.** `beanId` wins: a
  `beanBatchId` changed under the Bean the record names already is taken
  where the batch is of that Bean, and otherwise changes nothing. A `beanId` with no batch of its own gives the Recipe its batch of
  that Bean, or else that Bean's batch most recently added at the Location,
  or none. A `beanId` this tablet holds no record of is none, and clears the
  Recipe's Bean on every Machine.
- **Write the record before the Workflow.** Write the record, then the
  Workflow: its profile, or its `beanBatchId` with `coffeeName` and
  `coffeeRoaster`. With a new profile, write the record's brew temperature
  (`dashboardVariables.brewC`) too, and put the Workflow's profile at it:
  the other Machines are written the new profile at the Recipe's brew
  temperature, as DYE2 applies one. The plugin reads DYE2's recipes as a Workflow change
  moves the bean or the profile under a Loaded Recipe, and holds that change
  back until it has, so the server takes the record's edit first, and the
  other Machines have it within seconds. A profile changed in the Workflow
  alone unloads the Recipe, as DYE2 clears it, unless the record holds that
  profile already: DYE2 compares the Workflow's profile with the record's
  embedded `workflow.profile`, or else its `profileSnapshot`, so write the
  new profile there too, whole. The server takes the rest of a Workflow
  change that moves the profile, such as a batch picked with it, only where
  the record it has been reported holds the new profile already, as DYE2
  clears the recipe a moment after any other.
- **What is not taken.** An Archived Bean, or a batch held with its Bean
  that is Archived, of an Archived Bean or not at the Recipe's Location
  (never added there, or finished there), changes neither the Recipe's Bean nor its batch. A `profileId`
  that is none of the Library's Profiles changes none. Where a recipe names
  a profile the plugin has not read among the tablet's, it reads and sends
  the tablet's profiles before the recipes, so a profile saved on this
  tablet before the record that names it is the Library's by then. The Recipe's own is written back
  over the record, and nothing is offered or added at the Location. The
  Workflow keeps what was picked: such a batch stays that Machine's own,
  with the Recipe loaded.
- **The server renames nothing.** A Recipe's name changes only as a record
  or an edit sets it, so a rule renaming one under a generated name is the
  Skin's, written in the same record. On a Skin with no such rule, as
  Streamline, a Recipe keeps its generated name as its Bean changes.
- **Gaps.**
  - DYE2, the plugin and a Skin each rewrite DYE2's whole list, and
    Decaid's store takes no conditional write, so a write lost to another
    made at the same moment is never heard of. Read the list just before
    writing it, and change only your record.
  - A record written with no Workflow change, as a name edited on its own,
    reaches the server at the plugin's next poll, 30 s by default.
  - With a Recipe loaded, any bean batch picked that the Recipe's Location
    offers becomes the Recipe's, so a one-off Shot of another coffee can no
    longer be pulled under it without changing it.
