import type { Prisma } from "../generated/prisma/client.js";
import type { Hardware } from "../sync/identity.js";

/**
 * Gives the Machine the collections held for its hardware, even by a
 * dismissed Pending Machine. Where both have one, the later report says
 * whether it is available now, and the later value received is kept. The
 * Machine's row lock must be held, or the Machine created in this
 * transaction, as transferPendingRecords requires.
 */
export async function transferPendingCollections(
  tx: Prisma.TransactionClient,
  hardware: Hardware,
  machineId: string,
): Promise<void> {
  // Every expression reads the Machine's row as it was, so value, items and received_at come from the same report.
  await tx.$executeRaw`
    UPDATE reported_collections AS mine SET
      available = CASE WHEN held.reported_at > mine.reported_at THEN held.available ELSE mine.available END,
      reported_at = GREATEST(mine.reported_at, held.reported_at),
      value = CASE WHEN mine.received_at IS NULL OR held.received_at > mine.received_at THEN held.value ELSE mine.value END,
      items = CASE WHEN mine.received_at IS NULL OR held.received_at > mine.received_at THEN held.items ELSE mine.items END,
      received_at = GREATEST(mine.received_at, held.received_at)
    FROM reported_collections AS held
    JOIN pending_machines AS pending ON pending.id = held.pending_machine_id
    WHERE mine.machine_id = ${machineId}::uuid AND held.name = mine.name
      AND pending.model = ${hardware.model} AND pending.serial = ${hardware.serial}`;
  await tx.$executeRaw`
    DELETE FROM reported_collections AS held
    USING pending_machines AS pending
    WHERE pending.id = held.pending_machine_id AND pending.model = ${hardware.model} AND pending.serial = ${hardware.serial}
      AND EXISTS (SELECT 1 FROM reported_collections AS mine WHERE mine.machine_id = ${machineId}::uuid AND mine.name = held.name)`;
  await tx.reportedCollection.updateMany({ where: { pendingMachine: hardware }, data: { machineId, pendingMachineId: null } });
}
