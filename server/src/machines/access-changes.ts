import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";

/**
 * Tells every server instance that who may stay connected for a Machine has
 * changed: a hello was accepted (replacing the previous connection), its
 * token was reissued, or hardware was dismissed for it. Delivered only once
 * the transaction making the change commits (ADR-0016); each instance then
 * checks its connections to the Machine.
 */
export async function notifyAccessChanged(tx: Prisma.TransactionClient, machineId: string): Promise<void> {
  await notify(tx, "machine_access", machineId);
}
