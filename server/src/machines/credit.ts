import type { Prisma } from "../generated/prisma/client.js";
import type { Hardware, Reporter } from "../sync/identity.js";
import { lockHardware, lockMachine } from "./machines.service.js";

// Which Machine, or Pending Machine, a record is credited to (ADR-0015). Each
// takes the locks that keep its credit consistent: the hardware's before any
// Machine row, as everything that gives hardware to a Machine does, and the
// credited Machine's row, which changes to its Location History hold too.

/** A record's credit: a Machine, or the Pending Machine holding what is credited to hardware no Machine has. */
export interface Credit {
  machineId: string | null;
  pendingMachineId: string | null;
}

/** Credits the hardware: to the Machine that has it, its row locked, otherwise to its Pending Machine, created if need be. */
export async function creditHardware(tx: Prisma.TransactionClient, hardware: Hardware): Promise<Credit> {
  await lockHardware(tx, hardware);
  // Machine rows before the Pending Machine, matching hello and dismissal. Locked as lockMachine locks it.
  const [owner] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM machines WHERE model = ${hardware.model} AND serial = ${hardware.serial} FOR NO KEY UPDATE`;
  if (owner) return { machineId: owner.id, pendingMachineId: null };
  const pending = await tx.pendingMachine.upsert({ where: { model_serial: hardware }, create: hardware, update: {} });
  return { machineId: null, pendingMachineId: pending.id };
}

/**
 * Credits a record that names no hardware of its own to whoever reported it:
 * the reporting Machine, its row locked, or, from a mismatched connection,
 * the hardware that connection reported.
 */
export async function creditReporter(tx: Prisma.TransactionClient, reporter: Reporter): Promise<Credit> {
  if (reporter.identity.kind === "mismatch") return creditHardware(tx, reporter.identity.hardware);
  await lockMachine(tx, reporter.machineId);
  return { machineId: reporter.machineId, pendingMachineId: null };
}

/**
 * Records that the session's token delivered this id, and says whether it is
 * the first time, for deliveries handled once however often they arrive:
 * Workflow and machine state events, and collections. A delivery's ids are
 * its token's Machine's own, since a resend always comes through the same
 * plugin and token. Recorded before the credit is locked, as by every
 * delivery, so a resend arriving meanwhile waits for this one to commit and
 * then finds it. Ids are kept for DELIVERY_ID_RETENTION_DAYS
 * (`delivery-id-cleanup.ts`); a resend after that counts as a first delivery.
 */
export async function firstDelivery(tx: Prisma.TransactionClient, reporter: Reporter, deliveryId: string): Promise<boolean> {
  const recorded = await tx.$executeRaw`
    INSERT INTO machine_event_deliveries (machine_id, delivery_id)
    VALUES (${reporter.machineId}::uuid, ${deliveryId})
    ON CONFLICT DO NOTHING`;
  return recorded > 0;
}
