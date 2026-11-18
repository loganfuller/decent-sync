# A Bean link on a Shot pulled with no Bean Batch

A Shot is linked to a Library Bean only through its Bean Batch. A Shot
pulled with no Bean Batch is not linked to its Recipe's Bean, and gets no
Bean link of its own.

## Why this is out of scope

A Shot's links to the Library are its Bean Batch (`library_batch_id`,
through its Tablet's map) and its Recipe; its coffee is otherwise the
Workflow's `coffee_name` and `coffee_roaster` as text (`docs/SHOTS.md`,
Links to the Library). The request was to link a Shot pulled with no batch
to the Bean its Recipe named when it was pulled.

What that would take:

- A new column on a Shot, with a migration that works beside the previous
  release (ADR-0025).
- The Recipe's Bean as it was when the Shot was pulled, read from the
  Recipe's history or copied as the Shot is stored.
- A decision on Shots already stored.

What it would give is one thing: the Shots list's `beanId` filter, which
reads `library_batch_id` alone (`server/src/shots/filters.ts`), would find
these Shots. That filter is the Shots link on a Bean's page and `beanId` on
the MCP endpoint's `find_shots` and `summarise_shots`.

It would not change a Shot Summary. A Summary grouped by Bean groups on
the coffee and roaster text each Shot recorded, not on a Library link
(`server/src/shots/summary.ts`), so these Shots are already under their
Bean there, and the text filters find them the same way. #572 keeps that
text right when a Recipe's Bean changes with no batch.

The case is also outside how the Library is meant to be used. A Bean
picked for a Recipe brings its batch at the Location wherever it has one
there (`docs/LIBRARY.md`), so a Recipe naming a Bean and no Bean Batch is
one whose Bean had no batch at its Location when it was picked. Giving the
Recipe a batch is the fix: add the Bean's batch at the Location and pick
it for the Recipe, and its Shots are linked from then on. When this was
decided, no Recipe on the owner's server was in that state.

So the recorded text is how a Shot with no batch names its coffee, and the
batch is how a Shot names a Library Bean.

## Prior requests

- #582: "A Shot pulled with no Bean Batch has no link to a Library Bean"
