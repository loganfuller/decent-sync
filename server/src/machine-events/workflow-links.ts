import { DYE2_RECIPE_FIELD, WORKFLOW_BASKET, WORKFLOW_BATCH, WORKFLOW_GRINDER } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";

// Workflow changes linked to the Library (#434), as Shots are
// (shots/links.ts). A Workflow names its Bean Batch, Grinder and Basket, and
// the Recipe it is dialled in to (DYE2_RECIPE_FIELD), by their ids on the
// tablet that reported it, which resolve to the Library's items through that
// tablet's map. Each link is stored on the change once the map holds the id:
// as the change is stored, or as the map gains the id later, so a change
// naming a batch made on the tablet, reported before the batch, is linked
// once the batch joins the Library. A link is never unlinked: the change
// still named that item once its record has left the map. A change whose
// item never resolves has none, its name kept in its Workflow. Its Profile is
// read from its profile, as a Shot's is (`profileOfSql`), not stored.
//
// Each id is read from the stored Workflow as text (`#>>`), as a Shot's recipe
// is, by the same expression the partial indexes of the changes not linked
// yet hold (the migrations from 20261110000001): so a map gaining an id finds
// its changes through them. Storing a change holds its tablet's row lock as
// it resolves the ids, as every change of a tablet's map does, which links
// the changes it can then: so either the map's change commits first, and the
// change's resolution finds it, or the change is stored first, and the map's
// change links it.

/** The kinds a Workflow names by the tablet's ids: the map holding them, and the link a change keeps. */
const NAMED = {
  beanBatch: { field: WORKFLOW_BATCH[0], map: "tablet_bean_batches", item: "batch_id", link: "library_batch_id" },
  grinder: { field: WORKFLOW_GRINDER[0], map: "tablet_grinders", item: "grinder_id", link: "library_grinder_id" },
  basket: { field: WORKFLOW_BASKET[0], map: "tablet_baskets", item: "basket_id", link: "library_basket_id" },
  recipe: { field: DYE2_RECIPE_FIELD, map: "tablet_recipes", item: "recipe_id", link: "recipe_id" },
} as const;

export type WorkflowNamedKind = keyof typeof NAMED;

/** The columns of `workflow_events` holding each kind's link, in NAMED's order. */
export const WORKFLOW_LINK_COLUMNS = Prisma.raw(Object.values(NAMED).map(({ link }) => link).join(", "));

/** The id a Workflow names an item of the kind by, as text, or null: as the partial index of those not linked yet holds it. */
function namedSql(kind: WorkflowNamedKind, workflow: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(${workflow} #>> ${Prisma.raw(`'{${NAMED[kind].field.split(".").join(",")}}'`)})`;
}

/**
 * The Library's items a Workflow names, through the tablet's map, as values
 * for WORKFLOW_LINK_COLUMNS, each null where the map does not hold the id.
 * The tablet's row lock must be held.
 */
export function resolvedLinksSql(tabletId: string, workflow: Prisma.Sql): Prisma.Sql {
  return Prisma.join(
    (Object.keys(NAMED) as WorkflowNamedKind[]).map((kind) => {
      const { map, item } = NAMED[kind];
      return Prisma.sql`(SELECT ${Prisma.raw(item)} FROM ${Prisma.raw(map)} WHERE tablet_id = ${tabletId}::uuid AND local_id = ${namedSql(kind, workflow)})`;
    }),
  );
}

/**
 * Links each Workflow change the tablet reported naming its record by its id
 * there, but not linked to an item of the kind yet, to the item: called as
 * the tablet's map comes to hold the record under that id, with the tablet's
 * row lock held, which storing a change waits for.
 */
export async function linkWorkflowChanges(tx: Prisma.TransactionClient, kind: WorkflowNamedKind, tabletId: string, itemId: string, localId: string): Promise<void> {
  const link = Prisma.raw(NAMED[kind].link);
  await tx.$executeRaw`
    UPDATE workflow_events SET ${link} = ${itemId}::uuid
    WHERE tablet_id = ${tabletId}::uuid AND ${link} IS NULL AND ${namedSql(kind, Prisma.sql`workflow`)} = ${localId}`;
}
