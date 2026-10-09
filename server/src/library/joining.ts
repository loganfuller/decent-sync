import { WORKFLOW_KIND } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import type { ItemRef } from "./history.js";
import type { PlannedWrite } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet } from "./intake.js";
import { type CurrentEntry, type Offered, clearStillDue, joins, workflowClear } from "./join-plan.js";
import { isObject } from "./listed.js";
import { lockLocation } from "./location-state.js";

// A Machine's tablet joining a Location (ADR-0008, ADR-0018): its Machine
// was adopted there, moved there, or the tablet is new there. Each of the
// tablet's reports, of its Library lists and its Workflow, records the
// Location History entry it was taken in under, so the first under another
// entry is known as part of joining (join-plan.ts). What those reports bring
// that the Library lacks joins it at the Location, and is listed on the
// Machine's page (`brought_items`). The tablet is written what the Location
// offers, and what it does not offer is archived or hidden on it, as for any
// tablet there (holdings.ts); its Workflow's grinder and batch are cleared if
// the Location does not offer them (`workflow_clears`), and its settings
// give way to the Location's (location-settings.ts). Under the locks of the
// report that takes it in: the Machine's row, then the tablet's.

/** The reports a tablet's Library is taken in from: its Library lists, and its Workflow. */
export type TakenInReport = "beans" | "beanBatches" | "grinders" | "profiles" | "workflow";

/** The Machine's current Location History entry: the latest, with its Location; null without one, when it is capture-only. */
export async function currentEntry(tx: Prisma.TransactionClient, machineId: string): Promise<CurrentEntry | null> {
  const latest = await tx.locationAssignment.findFirst({ where: { machineId }, orderBy: { effectiveFrom: "desc" }, select: { id: true, locationId: true } });
  return latest;
}

/**
 * Records that the tablet's report of this kind is taken in under the
 * entry, and says whether it is part of joining the entry's Location
 * (`joins`). A report of its bean batches is recorded only once its beans
 * are taken in under the entry, as a batch whose bean the tablet's map does
 * not hold waits for it: until then each of its reports is part of joining,
 * so a batch it brings is listed once its bean is mapped. The tablet's row
 * lock must be held.
 */
export async function takenIn(tx: Prisma.TransactionClient, tabletId: string, report: TakenInReport, entry: CurrentEntry): Promise<boolean> {
  const [last] = await tx.$queryRaw<{ id: string; locationId: string; remains: boolean }[]>`
    SELECT assignment_id AS id, location_id AS "locationId", EXISTS (SELECT 1 FROM location_assignments WHERE id = assignment_id) AS remains
    FROM tablet_reports WHERE tablet_id = ${tabletId}::uuid AND report = ${report}`;
  const joining = joins(last ?? null, entry, last?.remains ?? false);
  if (joining && report === "beanBatches") {
    const [beans] = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM tablet_reports WHERE tablet_id = ${tabletId}::uuid AND report = 'beans' AND assignment_id = ${entry.id}::uuid AND location_id = ${entry.locationId}::uuid`;
    if (!beans) return true;
  }
  // Kept to the current entry, joining or not, so a later move away and back is told from a removed entry.
  if (last?.id !== entry.id || last.locationId !== entry.locationId) {
    await tx.$executeRaw`
      INSERT INTO tablet_reports (tablet_id, report, assignment_id, location_id)
      VALUES (${tabletId}::uuid, ${report}, ${entry.id}::uuid, ${entry.locationId}::uuid)
      ON CONFLICT (tablet_id, report) DO UPDATE SET assignment_id = EXCLUDED.assignment_id, location_id = EXCLUDED.location_id`;
  }
  return joining;
}

/**
 * Forgets where the reports of the Machine's tablets were taken in, as it
 * is left at no Location: given one again, even the Location it was at, it
 * joins it. Only of tablets whose latest accepted hello was this Machine's:
 * one that moved to another Machine since reports as that one. Under the
 * Machine's row lock, which every report taken in for it holds.
 */
export async function forgetReports(tx: Prisma.TransactionClient, machineId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM tablet_reports WHERE tablet_id IN (
      SELECT mine.tablet_id FROM machine_tablets AS mine
      WHERE mine.machine_id = ${machineId}::uuid AND NOT EXISTS (
        SELECT 1 FROM machine_tablets AS later WHERE later.tablet_id = mine.tablet_id AND later.last_hello > mine.last_hello
      )
    )`;
}

/**
 * Lists the item as one the tablet's Machine brought as it joined the
 * Location (ADR-0018): `matched` to one the Library had, or joining it.
 * Once per Machine and item.
 */
export async function recordBrought(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string, item: ItemRef, matched: boolean): Promise<void> {
  const column = { bean: "bean_id", beanBatch: "batch_id", grinder: "grinder_id", profile: "profile_id" }[item.kind as "bean" | "beanBatch" | "grinder" | "profile"];
  if (column === undefined) return;
  const id = item.kind === "profile" ? item.id : null;
  const uuid = item.kind === "profile" ? null : item.id;
  await tx.$executeRaw`
    INSERT INTO brought_items (id, machine_id, tablet_id, location_id, bean_id, batch_id, grinder_id, profile_id, matched)
    VALUES (gen_random_uuid(), ${tablet.machineId}::uuid, ${tablet.tabletId}::uuid, ${locationId}::uuid,
      ${column === "bean_id" ? uuid : null}::uuid, ${column === "batch_id" ? uuid : null}::uuid, ${column === "grinder_id" ? uuid : null}::uuid,
      ${id}, ${matched})
    ON CONFLICT DO NOTHING`;
}

/**
 * Takes in what a Workflow the tablet reported means for its grinder and
 * batch, under its Machine's and tablet's row locks: reported as the tablet
 * joins the Location (`joining`), those the Location does not offer are to
 * be cleared (`workflowClear`), judged under the Location's lock against
 * the tablet's map, which holds what it held before joining; otherwise a
 * clear still due keeps only what the Workflow still holds as it was
 * (`clearStillDue`). Tells every instance when one is due.
 */
export async function takeInWorkflowContext(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  locationId: string,
  joining: boolean,
): Promise<void> {
  const context = isObject(workflow) ? workflow.context : undefined;
  if (!joining) {
    const [pending] = await tx.$queryRaw<{ expected: Record<string, unknown>; locationId: string }[]>`
      SELECT expected, location_id AS "locationId" FROM workflow_clears WHERE tablet_id = ${tablet.tabletId}::uuid`;
    if (pending) await saveClear(tx, tablet.tabletId, pending.locationId, clearStillDue(pending.expected, context));
    return;
  }
  const ids = isObject(context) ? context : {};
  const grinderId = typeof ids.grinderId === "string" ? ids.grinderId : null;
  const batchId = typeof ids.beanBatchId === "string" ? ids.beanBatchId : null;
  if (grinderId === null && batchId === null) return saveClear(tx, tablet.tabletId, locationId, null);
  await lockLocation(tx, locationId);
  const [offer] = await tx.$queryRaw<{ grinder: Offered; batch: Offered }[]>`
    SELECT
      COALESCE((
        SELECT CASE WHEN grinders.location_id = ${locationId}::uuid AND NOT grinders.archived THEN 'offered' ELSE 'notOffered' END
        FROM tablet_grinders AS held JOIN grinders ON grinders.id = held.grinder_id
        WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${grinderId}
      ), 'unknown') AS grinder,
      COALESCE((
        SELECT CASE WHEN here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived
          THEN 'offered' ELSE 'notOffered' END
        FROM tablet_bean_batches AS held
        JOIN bean_batches AS batch ON batch.id = held.batch_id
        JOIN beans AS bean ON bean.id = batch.bean_id
        LEFT JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
        WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${batchId}
      ), 'unknown') AS batch`;
  const expected = workflowClear(context, offer!.grinder, offer!.batch);
  await saveClear(tx, tablet.tabletId, locationId, expected);
  if (expected !== null) await notify(tx, "library_changes", locationId);
}

/** Keeps the clear due on the tablet at the Location, or, null, none. */
async function saveClear(tx: Prisma.TransactionClient, tabletId: string, locationId: string, expected: Record<string, unknown> | null): Promise<void> {
  if (expected === null) {
    await tx.$executeRaw`DELETE FROM workflow_clears WHERE tablet_id = ${tabletId}::uuid`;
    return;
  }
  await tx.$executeRaw`
    INSERT INTO workflow_clears (tablet_id, location_id, expected) VALUES (${tabletId}::uuid, ${locationId}::uuid, ${JSON.stringify(expected)}::jsonb)
    ON CONFLICT (tablet_id) DO UPDATE SET location_id = EXCLUDED.location_id, expected = EXCLUDED.expected`;
}

/**
 * The write that clears the tablet's Workflow's grinder or batch, if one is
 * due at the Location its Machine is at, read in the snapshot that
 * `tabletDue` reads: each field cleared, expecting the value the Workflow
 * held. Named by the tablet's id.
 */
export async function workflowClearDue(tx: Prisma.TransactionClient, tabletId: string, locationId: string): Promise<PlannedWrite | null> {
  const [row] = await tx.$queryRaw<{ expected: Record<string, unknown> }[]>`
    SELECT expected FROM workflow_clears WHERE tablet_id = ${tabletId}::uuid AND location_id = ${locationId}::uuid`;
  if (!row) return null;
  const fields = Object.fromEntries(Object.keys(row.expected).map((field) => [field, null]));
  return { kind: WORKFLOW_KIND, globalId: tabletId, localId: null, fields, expected: row.expected, decidedAt: null, contentDecidedAt: null };
}

/**
 * Records the Workflow's `context` Decaid returned for the plugin's write
 * clearing its grinder or batch (`record`): what of the clear due the
 * Workflow still holds as it was is still due (`clearStillDue`), which is
 * nothing once the write cleared it or a barista picked another. Recorded
 * only while the answering connection holds its Machine, under the
 * Machine's and the tablet's locks. Its change of the Workflow, which the
 * plugin sends after, is no edit of the settings.
 */
export async function recordWorkflowCleared(
  prisma: PrismaService,
  tablet: AnsweringTablet,
  globalId: string,
  record: Record<string, unknown>,
): Promise<AnswerRecorded> {
  if (globalId.toLowerCase() !== tablet.tabletId.toLowerCase() || !isObject(record.context)) return "notTheItem";
  const context = record.context;
  return prisma.$transaction(async (tx): Promise<AnswerRecorded> => {
    if (!(await lockHeldMachine(tx, tablet))) return "released";
    await lockTablet(tx, tablet.tabletId);
    const [pending] = await tx.$queryRaw<{ expected: Record<string, unknown>; locationId: string }[]>`
      SELECT expected, location_id AS "locationId" FROM workflow_clears WHERE tablet_id = ${tablet.tabletId}::uuid`;
    if (pending) await saveClear(tx, tablet.tabletId, pending.locationId, clearStillDue(pending.expected, context));
    return "recorded";
  }, INTAKE_TRANSACTION);
}
