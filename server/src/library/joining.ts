import {
  type LibraryList,
  WORKFLOW_BASKET,
  WORKFLOW_BATCH,
  WORKFLOW_GRINDER,
  WORKFLOW_KIND,
  equipmentMatchKey,
  parentList,
  sameValue,
  workflowValueAt,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import type { PrismaService } from "../prisma.service.js";
import type { PlannedWrite } from "./holdings.js";
import { type AnswerRecorded, type AnsweringTablet, INTAKE_TRANSACTION, type ReportingTablet, lockHeldMachine, lockTablet } from "./intake.js";
import { type CurrentEntry, type Offered, type WorkflowOffers, clearStillDue, joins, sameSharing, standing, workflowClear } from "./join-plan.js";
import { offersAny } from "./left-out.js";
import { isObject } from "./listed.js";
import { lockLocation } from "./location-state.js";

// A Machine's tablet joining a Location (ADR-0008, ADR-0018): its Machine
// was adopted there, moved there, or had sharing turned back on, or the
// tablet is new there. Each of the tablet's reports, of its Library lists
// and its Workflow, records the Location History entry it was taken in
// under, and when the Machine's sharing was last turned back on, so the
// first under another entry or since is known as part of joining
// (join-plan.ts). The Location's state wins: such a report takes nothing of
// the tablet's into the Library, but for a kind of item the Location offers
// none of yet, whose items it brings, and what the Library leaves out is
// set aside on the tablet (left-out.ts). The tablet is written what the
// Location offers, and what it does not offer is archived or hidden on it,
// as for any tablet there (holdings.ts); its Workflow's grinder, batch and
// Basket are cleared if the Location does not offer them
// (`workflow_clears`). Under the locks of the report that takes it in: the
// Machine's row, then the tablet's.

/** The reports a tablet's Library is taken in from: its Library lists (LIBRARY_LISTS), and its Workflow. */
export type TakenInReport = LibraryList | "workflow";

/**
 * The Machine's current Location History entry: the latest, with its
 * Location, and when its sharing was last turned back on; null when it is
 * capture-only, at no Location or with sharing turned off.
 */
export async function currentEntry(tx: Prisma.TransactionClient, machineId: string): Promise<CurrentEntry | null> {
  const [entry] = await tx.$queryRaw<CurrentEntry[]>`
    SELECT latest.id, latest.location_id AS "locationId", machines.sharing_since AS "sharingSince"
    FROM machines
    CROSS JOIN LATERAL (
      SELECT id, location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
    ) AS latest
    WHERE machines.id = ${machineId}::uuid AND machines.sharing`;
  return entry ?? null;
}

/**
 * Records that the tablet's report of this kind is taken in under the
 * entry, and says whether it is part of joining the entry's Location
 * (`joins`). A report of a list whose records are made under another's, as
 * its bean batches are under its beans, is recorded only once that list is
 * taken in under the entry, as a batch whose bean the tablet's map does not
 * hold waits for it: until then each of its reports is part of joining, so a
 * batch it held as it joined is judged as such once its bean is mapped or
 * left out. The tablet's row lock must be held.
 */
export async function takenIn(tx: Prisma.TransactionClient, tabletId: string, report: TakenInReport, entry: CurrentEntry): Promise<boolean> {
  const [last] = await tx.$queryRaw<(CurrentEntry & { remains: boolean })[]>`
    SELECT assignment_id AS id, location_id AS "locationId", sharing_since AS "sharingSince",
      EXISTS (SELECT 1 FROM location_assignments WHERE id = assignment_id) AS remains
    FROM tablet_reports WHERE tablet_id = ${tabletId}::uuid AND report = ${report}`;
  const joining = joins(last ?? null, entry, last?.remains ?? false);
  const parent = report === "workflow" ? undefined : parentList(report);
  if (joining && parent !== undefined) {
    const [parentTakenIn] = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM tablet_reports WHERE tablet_id = ${tabletId}::uuid AND report = ${parent} AND assignment_id = ${entry.id}::uuid
        AND location_id = ${entry.locationId}::uuid AND sharing_since IS NOT DISTINCT FROM ${entry.sharingSince}::timestamptz`;
    if (!parentTakenIn) return true;
  }
  // Kept to the current entry, joining or not, so a later move away and back is told from a removed entry.
  if (last?.id !== entry.id || last.locationId !== entry.locationId || !sameSharing(last, entry)) {
    await tx.$executeRaw`
      INSERT INTO tablet_reports (tablet_id, report, assignment_id, location_id, sharing_since)
      VALUES (${tabletId}::uuid, ${report}, ${entry.id}::uuid, ${entry.locationId}::uuid, ${entry.sharingSince})
      ON CONFLICT (tablet_id, report) DO UPDATE SET
        assignment_id = EXCLUDED.assignment_id, location_id = EXCLUDED.location_id, sharing_since = EXCLUDED.sharing_since`;
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
 * Takes in a Workflow the tablet reported, in the transaction storing it,
 * which holds its Machine's row lock: reported as the tablet joins its
 * Machine's Location (`takenIn`), its grinder, batch and Basket are cleared
 * if the Location does not offer them (`takeInWorkflowContext`). Its Loaded
 * Recipe is taken in by `loadedRecipe`, given where the report is taken in
 * and whether it joins there, under the tablet's lock, capture-only
 * included. Returns where it was taken in (`standing`), or null if nowhere,
 * as its Machine is capture-only.
 */
export async function takeInWorkflow(
  tx: Prisma.TransactionClient,
  tablet: ReportingTablet,
  workflow: unknown,
  loadedRecipe: (entry: CurrentEntry | null, joining: boolean) => Promise<void>,
): Promise<string | null> {
  const entry = await currentEntry(tx, tablet.machineId);
  await lockTablet(tx, tablet.tabletId);
  // Capture-only: the writer writes nothing until a Workflow is taken in where its lists were (`TabletWriter`).
  if (entry === null) {
    await loadedRecipe(null, false);
    return null;
  }
  const joining = await takenIn(tx, tablet.tabletId, "workflow", entry);
  // Each may take the Location's lock, which comes before the Loaded Recipe's row.
  await takeInWorkflowContext(tx, tablet, workflow, entry.locationId, joining);
  await loadedRecipe(entry, joining);
  return standing(entry);
}

/**
 * Takes in what a Workflow the tablet reported means for its grinder, batch
 * and Basket, under its Machine's and tablet's row locks: reported as the
 * tablet joins the Location (`joining`), those the Location does not offer
 * are to be cleared (`workflowClear`), judged under the Location's lock
 * against the tablet's map, which holds what it held before joining. One the
 * map does not hold is not offered if the Library leaves it out, or will as
 * the Location offers items of its kind already (left-out.ts), a batch's
 * bean included; otherwise it joins the Library there, and stays. But a
 * Basket the map does not hold whose name is a Library Basket's, as the
 * tablet's record of it is linked to that Basket as it joins (ADR-0018), is
 * offered where that Basket is shown. Otherwise a clear still due keeps only
 * what the Workflow still holds as it was (`clearStillDue`). Tells every
 * instance when one is due.
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
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const grinderId = text(workflowValueAt(workflow, WORKFLOW_GRINDER[0]));
  const batchId = text(workflowValueAt(workflow, WORKFLOW_BATCH[0]));
  const basketId = text(workflowValueAt(workflow, WORKFLOW_BASKET[0]));
  if (grinderId === null && batchId === null && basketId === null) return saveClear(tx, tablet.tabletId, locationId, null);
  await lockLocation(tx, locationId);
  // Unknown to the map, one is left out, or will be, unless the Location offers none of its kind; a batch is with its bean.
  const unknownGrinder: Offered = grinderId !== null && (await offersAny(tx, locationId, "grinder")) ? "notOffered" : "unknown";
  const unknownBatch: Offered =
    batchId !== null && ((await offersAny(tx, locationId, "beanBatch")) || (await offersAny(tx, locationId, "bean"))) ? "notOffered" : "unknown";
  // A Basket is linked by its name to the oldest Basket of that name not Archived that none of the tablet's records is
  // already, as `planEquipmentIntake` links one, so offered where that one is shown.
  const basketName = text(workflowValueAt(workflow, WORKFLOW_BASKET[1]));
  const unknownBasket: Offered = basketId !== null && (await offersAny(tx, locationId, "basket")) ? "notOffered" : "unknown";
  const namedBasket =
    unknownBasket === "notOffered" && basketName !== null
      ? Prisma.sql`(
          SELECT ${basketOfferedSql(locationId)} FROM baskets AS items
          WHERE items.match_key = ${equipmentMatchKey(basketName)} AND NOT items.archived
            AND NOT EXISTS (SELECT 1 FROM tablet_baskets AS mine WHERE mine.tablet_id = ${tablet.tabletId}::uuid AND mine.basket_id = items.id)
          ORDER BY items.created_at, items.id LIMIT 1
        )`
      : Prisma.sql`NULL`;
  const [offer] = await tx.$queryRaw<WorkflowOffers[]>`
    SELECT
      COALESCE((
        SELECT CASE WHEN grinders.location_id = ${locationId}::uuid AND NOT grinders.archived THEN 'offered' ELSE 'notOffered' END
        FROM tablet_grinders AS held JOIN grinders ON grinders.id = held.grinder_id
        WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${grinderId}
      ), ${leftOutSql(tablet.tabletId, "grinder", grinderId)}, ${unknownGrinder}) AS grinder,
      COALESCE((
        SELECT CASE WHEN here.added_at IS NOT NULL AND here.finished_at IS NULL AND NOT batch.archived AND NOT bean.archived
          THEN 'offered' ELSE 'notOffered' END
        FROM tablet_bean_batches AS held
        JOIN bean_batches AS batch ON batch.id = held.batch_id
        JOIN beans AS bean ON bean.id = batch.bean_id
        LEFT JOIN batch_locations AS here ON here.batch_id = batch.id AND here.location_id = ${locationId}::uuid
        WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${batchId}
      ), ${leftOutSql(tablet.tabletId, "beanBatch", batchId)}, ${unknownBatch}) AS batch,
      COALESCE((
        SELECT ${basketOfferedSql(locationId)} FROM tablet_baskets AS held JOIN baskets AS items ON items.id = held.basket_id
        WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${basketId}
      ), ${leftOutSql(tablet.tabletId, "basket", basketId)}, ${namedBasket}, ${unknownBasket}) AS basket`;
  const expected = workflowClear(context, offer!);
  await saveClear(tx, tablet.tabletId, locationId, expected);
  if (expected !== null) await notify(tx, "library_changes", locationId);
}

/**
 * Judges again the Basket the joining tablet's Workflow names, once its
 * report of its baskets is taken in as it joins, in that transaction, under
 * the Location's lock: from the tablet's map and what the Library left out
 * as they are now, not as the Workflow, taken in before the lists, foresaw
 * them, as when its record was linked by a name the Workflow no longer
 * holds, or carries a Library Basket's global id, or another tablet joining
 * at once brought the Location its first Baskets. The Workflow is its
 * Machine's latest. A record the tablet's list does not hold is not offered
 * where the Location shows any Basket. The clear due gains the Basket, or
 * loses it, the grinder and batch kept as they were.
 */
export async function judgeWorkflowBasket(tx: Prisma.TransactionClient, tablet: ReportingTablet, locationId: string): Promise<void> {
  const [latest] = await tx.$queryRaw<{ workflow: unknown }[]>`
    SELECT workflow FROM workflow_events WHERE machine_id = ${tablet.machineId}::uuid ORDER BY id DESC LIMIT 1`;
  const workflow = latest?.workflow;
  const basketId = workflowValueAt(workflow, WORKFLOW_BASKET[0]);
  if (typeof basketId !== "string") return;
  const unknownBasket: Offered = (await offersAny(tx, locationId, "basket")) ? "notOffered" : "unknown";
  const [offer] = await tx.$queryRaw<{ basket: Offered }[]>`
    SELECT COALESCE((
      SELECT ${basketOfferedSql(locationId)} FROM tablet_baskets AS held JOIN baskets AS items ON items.id = held.basket_id
      WHERE held.tablet_id = ${tablet.tabletId}::uuid AND held.local_id = ${basketId}
    ), ${leftOutSql(tablet.tabletId, "basket", basketId)}, ${unknownBasket}) AS basket`;
  const [pending] = await tx.$queryRaw<{ expected: Record<string, unknown> }[]>`
    SELECT expected FROM workflow_clears WHERE tablet_id = ${tablet.tabletId}::uuid AND location_id = ${locationId}::uuid`;
  const others = Object.fromEntries(Object.entries(pending?.expected ?? {}).filter(([field]) => !(WORKFLOW_BASKET as readonly string[]).includes(field)));
  const basket = workflowClear(isObject(workflow) ? workflow.context : undefined, { grinder: "offered", batch: "offered", basket: offer!.basket }) ?? {};
  const expected = { ...others, ...basket };
  const due = Object.keys(expected).length === 0 ? null : expected;
  if (sameValue(due, pending?.expected ?? null)) return;
  await saveClear(tx, tablet.tabletId, locationId, due);
  if (due !== null) await notify(tx, "library_changes", locationId);
}

/** Whether the Location shows the Basket `items` names and it is not Archived, as SQL: 'offered' or 'notOffered'. */
function basketOfferedSql(locationId: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN NOT items.archived AND EXISTS (
    SELECT 1 FROM basket_locations AS here WHERE here.basket_id = items.id AND here.location_id = ${locationId}::uuid AND here.shown
  ) THEN 'offered' ELSE 'notOffered' END`;
}

/** 'notOffered' if the Library leaves out the tablet's record of that kind and id, as SQL; otherwise null. */
function leftOutSql(tabletId: string, kind: "grinder" | "beanBatch" | "basket", localId: string | null): Prisma.Sql {
  return Prisma.sql`(
    SELECT 'notOffered' FROM tablet_left_out WHERE tablet_id = ${tabletId}::uuid AND kind = ${kind} AND local_id = ${localId}
  )`;
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
 * The write that clears the tablet's Workflow's grinder, batch or Basket, if one is
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
 * clearing its grinder, batch or Basket (`record`): what of the clear due the
 * Workflow still holds as it was is still due (`clearStillDue`), which is
 * nothing once the write cleared it or a barista picked another. Recorded
 * only while the answering connection holds its Machine, under the
 * Machine's and the tablet's locks.
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
