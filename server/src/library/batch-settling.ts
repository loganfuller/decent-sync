import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { editTime } from "./library-edits.service.js";
import { LocationBusy, lockPlaces, settleBatch } from "./location-state.js";

/** How often each server instance looks for Bean Batches at several Locations. */
export const BATCH_SETTLING_INTERVAL_MS = 10 * 60_000;

/**
 * Settles every Bean Batch that is at several Locations at the one it was
 * added at last (ADR-0037, `settleBatch`), as the server starts and then
 * every ten minutes, on every instance, in the background. This release
 * never leaves a batch at two: adding it at one finishes it at the others
 * (`addBatchAt`). The previous release, serving beside this one while a
 * deploy lasts (ADR-0025), adds a batch at a second Location and leaves it
 * at both, after the upgrade's migration settled those it found, and reads
 * of such a batch name the Location it was added at last first until a run
 * settles it. A run that fails, or finds a Location busy, is logged, and the
 * next tries again. Removed once no release that leaves a batch at two can
 * serve beside this one (#712).
 */
@Injectable()
export class BatchSettling implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("BatchSettling");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(BATCH_SETTLING_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    try {
      const settled = await this.settle();
      if (settled > 0) this.logger.log(`Settled ${settled} Bean ${settled === 1 ? "Batch" : "Batches"} that ${settled === 1 ? "was" : "were"} at several Locations at the one each was added at last`);
    } catch (error) {
      const why = error instanceof LocationBusy ? "a Location's state was changing" : String(error);
      this.logger.error(`Could not settle the Bean Batches at several Locations; trying again in ten minutes: ${why}`);
    }
  }

  /**
   * Settles each batch at several Locations, in one transaction, under the
   * locks of every Location they are at and then their own, in the order
   * every change takes them (`lockPlaces`), and tells the tablets, as those
   * at each Location left archive their record. Says how many it settled.
   */
  settle(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const several = await tx.$queryRaw<{ id: string }[]>`
        SELECT batch_id::text AS id FROM batch_locations WHERE added_at IS NOT NULL AND finished_at IS NULL
        GROUP BY batch_id HAVING count(*) > 1 ORDER BY batch_id`;
      if (several.length === 0) return 0;
      const ids = several.map((batch) => batch.id);
      await lockPlaces(tx, [], ids);
      const at = await editTime(tx);
      let settled = 0;
      for (const id of ids) {
        if (!(await settleBatch(tx, id, at))) continue;
        settled += 1;
        await notify(tx, "library_changes", id);
      }
      return settled;
    }, INTAKE_TRANSACTION);
  }
}
