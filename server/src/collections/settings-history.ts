import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import {
  type HistoryEdit,
  SETTINGS_HISTORY_COLLECTIONS,
  type SettingsHistoryCollection,
  changedSettingsHistoryFields,
  editedSettingsHistoryFields,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { Credit } from "../machines/credit.js";
import { tryLockHardware } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";

// A Machine's Settings History (#432): each value its tablet reported for one
// of SETTINGS_HISTORY_COLLECTIONS that differs from the one before it, as
// `changedSettingsHistoryFields` compares them, kept forever in
// `settings_history`, from when the server received it, whatever changed it.
// The first value of each collection is its baseline: the latest value stored
// before the history was kept, taken as the server starts and hourly
// (`SettingsHistoryBaselines`), or as a report finds none yet; or else the
// first report. A change made through a Settings Edit, whose read-back names
// it (`settingsEditId`), is labelled with that edit for the fields it set;
// every other change was made outside Decent Sync.

/** A report of one of the collections a Settings History keeps, with a value. */
export interface HistoryReport {
  name: SettingsHistoryCollection;
  value: unknown;
  utcOffsetMinutes: number | null;
  /** The tablet whose connection reported it. */
  tabletId: string;
  /** The Settings Edit whose read-back it is, if one. */
  settingsEditId: string | undefined;
}

/**
 * Records a report in its holder's Settings History, if it differs from the
 * latest value there, in the transaction storing it and before the stored
 * latest value is replaced, under the locks of its credit
 * (`creditFirstDelivery`), which every change of the holder's history
 * takes. Where the history holds none of the collection yet, its baseline
 * is first taken from the latest value stored, if any; with none stored
 * either, the report is the baseline.
 */
export async function recordSettingsHistory(tx: Prisma.TransactionClient, credit: Credit, report: HistoryReport): Promise<void> {
  const holder = credit.machineId !== null ? Prisma.sql`machine_id` : Prisma.sql`pending_machine_id`;
  const holderId = credit.machineId ?? credit.pendingMachineId;
  // The latest written, by id: written under the holder's locks, ids are in the order reports were recorded, where
  // received times, each its transaction's start, may not be, as a transaction can wait for the locks.
  const latest = async () =>
    (
      await tx.$queryRaw<{ value: unknown }[]>`
        SELECT value FROM settings_history WHERE ${holder} = ${holderId}::uuid AND name = ${report.name}
        ORDER BY id DESC LIMIT 1`
    )[0];
  let before = await latest();
  if (!before) {
    await takeBaselines(tx, holder, [holderId!], report.name);
    before = await latest();
  }
  const insert = (settingsEditId: string | null, editedFields: string[]) => tx.$executeRaw`
    INSERT INTO settings_history (${holder}, tablet_id, name, value, utc_offset_minutes, settings_edit_id, edited_fields)
    VALUES (
      ${holderId}::uuid, ${report.tabletId}::uuid, ${report.name}, ${JSON.stringify(report.value)}::jsonb, ${report.utcOffsetMinutes}::integer,
      ${settingsEditId}::uuid, ${editedFields}::text[]
    )`;
  if (!before) {
    await insert(null, []);
    return;
  }
  const changed = changedSettingsHistoryFields(report.name, before.value, report.value);
  if (changed.length === 0) return;
  const edit = report.settingsEditId !== undefined && credit.machineId !== null ? await editOf(tx, credit.machineId, report.settingsEditId, report.name) : undefined;
  const edited = edit ? editedSettingsHistoryFields(report.name, edit, before.value, report.value, changed) : [];
  await insert(edited.length > 0 ? report.settingsEditId! : null, edited);
}

/** A wake schedule's edit's action, as `settings_edits` stores it, as an edit names it. */
const SCHEDULE_ACTIONS = { ADD: "add", CHANGE: "change", DELETE: "delete" } as const;

/** The Settings Edit of that id, if it is of the Machine and the collection, as a Settings History labels a change with it. */
async function editOf(tx: Prisma.TransactionClient, machineId: string, id: string, collection: SettingsHistoryCollection): Promise<HistoryEdit | undefined> {
  const [edit] = await tx.$queryRaw<{ fields: Record<string, unknown>; scheduleAction: "ADD" | "CHANGE" | "DELETE" | null; scheduleId: string | null }[]>`
    SELECT fields, schedule_action::text AS "scheduleAction", schedule_id AS "scheduleId"
    FROM settings_edits WHERE id = ${id}::uuid AND machine_id = ${machineId}::uuid AND collection = ${collection}`;
  if (!edit) return undefined;
  const action = edit.scheduleAction === null ? null : SCHEDULE_ACTIONS[edit.scheduleAction];
  return { fields: edit.fields, ...(action === null ? {} : { schedule: { action, id: edit.scheduleId } }) };
}

/**
 * Takes the baseline of each of the holders' collections that a Settings
 * History keeps, or only of `name`, from the latest value stored, as and when
 * it was received, where the history holds none of it yet. Its tablet was not
 * stored, so it has none. The holders' locks must be held, as a report's
 * credit takes them.
 */
async function takeBaselines(tx: Prisma.TransactionClient, holder: Prisma.Sql, holderIds: string[], name?: SettingsHistoryCollection): Promise<number> {
  const names = name === undefined ? [...SETTINGS_HISTORY_COLLECTIONS] : [name];
  return tx.$executeRaw`
    INSERT INTO settings_history (${holder}, name, value, utc_offset_minutes, received_at)
    SELECT stored.${holder}, stored.name, stored.value, stored.utc_offset_minutes, stored.received_at
    FROM reported_collections AS stored
    WHERE stored.${holder} = ANY(${holderIds}::uuid[]) AND stored.name = ANY(${names}::text[]) AND stored.value IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM settings_history AS kept WHERE kept.${holder} = stored.${holder} AND kept.name = stored.name)`;
}

/** How often each server instance looks for collections whose Settings History has no baseline yet. */
export const SETTINGS_HISTORY_BASELINE_INTERVAL_MS = 60 * 60_000;
/** The most Machines, or Pending Machines, one transaction takes baselines for. */
export const SETTINGS_HISTORY_BASELINE_BATCH = 50;

/** Long enough for a batch to copy its values on a slow database; waiting for a connection is limited as for any other transaction. */
const BASELINE_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/**
 * Takes the baseline of every stored collection a Settings History keeps
 * that has none yet, from its latest value, as the server starts and then
 * every hour, on every instance, in the background, in batches, as
 * `CurvesRefresh` computes Shots' curves again. The hourly runs take the
 * values the previous release stores while it still serves beside this one
 * (ADR-0025). Each batch holds the locks a report's credit takes, a
 * Machine's row or the hardware's lock of a Pending Machine, skipping those
 * another transaction holds, such as a delivery, which takes its own
 * baseline if it needs one. A run that fails is logged, and the next tries
 * again.
 */
@Injectable()
export class SettingsHistoryBaselines implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("SettingsHistoryBaselines");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish its batch. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(SETTINGS_HISTORY_BASELINE_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    let taken = 0;
    try {
      while (!this.stopped) {
        const { holders, baselines } = await this.machines();
        taken += baselines;
        if (holders < SETTINGS_HISTORY_BASELINE_BATCH) break;
      }
      let after: string | null = null;
      while (!this.stopped) {
        const batch = await this.pendingMachines(after);
        taken += batch.baselines;
        if (batch.last === null) break;
        after = batch.last;
      }
    } catch (error) {
      this.logger.error(`Could not take the Settings History's baselines; trying again in an hour: ${String(error)}`);
    }
    if (taken > 0) this.logger.log(`Took ${taken} ${taken === 1 ? "baseline" : "baselines"} of the Settings History from the latest values stored`);
  }

  /** A batch of Machines with a stored collection but no baseline of it, their rows locked as a delivery's credit locks them. */
  private machines(): Promise<{ holders: number; baselines: number }> {
    return this.prisma.$transaction(async (tx) => {
      const machines = await tx.$queryRaw<{ id: string }[]>`
        SELECT machines.id FROM machines
        WHERE EXISTS (${missing(Prisma.sql`machine_id`, Prisma.sql`machines.id`)})
        ORDER BY machines.id LIMIT ${SETTINGS_HISTORY_BASELINE_BATCH}::integer
        FOR NO KEY UPDATE SKIP LOCKED`;
      if (machines.length === 0) return { holders: 0, baselines: 0 };
      return { holders: machines.length, baselines: await takeBaselines(tx, Prisma.sql`machine_id`, machines.map((machine) => machine.id)) };
    }, BASELINE_TRANSACTION);
  }

  /**
   * A batch of Pending Machines after `after`, by id, with a stored
   * collection but no baseline of it, each under its hardware's lock, as a
   * delivery's credit takes it, skipping one whose lock another transaction
   * holds. Says the last one looked at, or null where the batch was the last.
   */
  private pendingMachines(after: string | null): Promise<{ last: string | null; baselines: number }> {
    return this.prisma.$transaction(async (tx) => {
      const pending = await tx.$queryRaw<{ id: string; model: string; serial: string }[]>`
        SELECT pending_machines.id, model, serial FROM pending_machines
        WHERE (${after}::uuid IS NULL OR pending_machines.id > ${after}::uuid)
          AND EXISTS (${missing(Prisma.sql`pending_machine_id`, Prisma.sql`pending_machines.id`)})
        ORDER BY pending_machines.id LIMIT ${SETTINGS_HISTORY_BASELINE_BATCH}::integer`;
      const locked: string[] = [];
      for (const { id, model, serial } of pending) if (await tryLockHardware(tx, { model, serial })) locked.push(id);
      const baselines = locked.length === 0 ? 0 : await takeBaselines(tx, Prisma.sql`pending_machine_id`, locked);
      return { last: pending.length < SETTINGS_HISTORY_BASELINE_BATCH ? null : pending.at(-1)!.id, baselines };
    }, BASELINE_TRANSACTION);
  }
}

/** A query finding a collection the holder has stored that its Settings History has no baseline of. */
function missing(holder: Prisma.Sql, holderId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT 1 FROM reported_collections AS stored
    WHERE stored.${holder} = ${holderId} AND stored.name = ANY(${[...SETTINGS_HISTORY_COLLECTIONS]}::text[]) AND stored.value IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM settings_history AS kept WHERE kept.${holder} = stored.${holder} AND kept.name = stored.name)`;
}
