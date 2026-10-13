import { LIBRARY_ITEM_KINDS, type LibraryKind, dye2Key, isLibraryKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { PrismaService } from "../prisma.service.js";
import { lockTablet } from "./intake.js";
import { KINDS } from "./kinds.js";

// What every kind DYE2 keeps in a list of Decaid's store shares (ADR-0005):
// its Baskets, Tools and Recipes. A list in a shape neither the plugin nor
// the server recognises (`dye2Records`) is neither taken in nor written to
// on that tablet until it is reported in one they do, and shows in its
// Machine's sharing status (`tablet_unrecognised_lists`); the tablet's other
// lists keep syncing. A record DYE2 can neither archive nor hide is removed
// from its list instead, and the tablet's map forgets it.

/** A kind of Library item DYE2 keeps in one of its lists: Baskets, Tools (its equipment) and Recipes. */
export type Dye2Kind = "basket" | "tool" | "recipe";

/** Whether a kind is one DYE2 keeps in a list of Decaid's store. */
export function isDye2Kind(kind: string): kind is Dye2Kind {
  return isLibraryKind(kind) && dye2Key(kind as LibraryKind) !== undefined;
}

/**
 * Marks the tablet's list of the kind as in a shape that is not recognised,
 * or, false, recognised, under the tablet's row lock, and says whether that
 * changed.
 */
export async function markUnrecognised(tx: Prisma.TransactionClient, tabletId: string, kind: Dye2Kind, unrecognised: boolean): Promise<boolean> {
  const list = LIBRARY_ITEM_KINDS[kind].list;
  const changed = unrecognised
    ? await tx.$executeRaw`INSERT INTO tablet_unrecognised_lists (tablet_id, list) VALUES (${tabletId}::uuid, ${list}) ON CONFLICT DO NOTHING`
    : await tx.$executeRaw`DELETE FROM tablet_unrecognised_lists WHERE tablet_id = ${tabletId}::uuid AND list = ${list}`;
  return changed > 0;
}

/**
 * Records that the plugin found the tablet's list of the kind in a shape it
 * does not recognise as it carried out a write (`ListUnrecognised`), under
 * the tablet's row lock, whether or not its connection still holds the
 * Machine: it says only what the tablet holds. Its writer writes nothing
 * more to that list until the tablet reports it in a shape it recognises.
 */
export async function recordUnrecognised(prisma: PrismaService, tabletId: string, kind: Dye2Kind): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    await markUnrecognised(tx, tabletId, kind, true);
  });
}

/**
 * The plugin removed the tablet's record from the kind's list, as its
 * Location no longer offers the item, or found it gone (`gone`), or found it
 * another item's record: the map holds it no more, so the tablet's next
 * report does not read it as the tablet's delete, and it is written again
 * should its Location offer it once more. A recipe's record gone from its slot is kept
 * (`tablet_removed_recipes`) until a report lists that slot again: DYE2's
 * ids for recipes are their slots, so the next Recipe the server writes
 * there takes it as what the tablet held before (`recordRecipeWritten`).
 * Under the tablet's row lock, whether or not the answering connection
 * still holds its Machine: it says only what the tablet holds.
 */
export async function recordRemoved(prisma: PrismaService, kind: Dye2Kind, tabletId: string, localId: string, gone: boolean): Promise<void> {
  const { map } = KINDS[kind];
  await prisma.$transaction(async (tx) => {
    await lockTablet(tx, tabletId);
    if (kind === "recipe" && gone) {
      await tx.$executeRaw`
        INSERT INTO tablet_removed_recipes (tablet_id, local_id, record)
        SELECT tablet_id, local_id, record FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${localId}
        ON CONFLICT (tablet_id, local_id) DO UPDATE SET record = EXCLUDED.record`;
    }
    await tx.$executeRaw`DELETE FROM ${Prisma.raw(map.table)} WHERE tablet_id = ${tabletId}::uuid AND local_id = ${localId}`;
  });
}
