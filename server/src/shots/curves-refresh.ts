import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { CURVES_REVISION, extractCurves } from "./extraction.js";

/** How often each server instance looks for Shots whose curves' values an earlier revision computed. */
export const CURVES_REFRESH_INTERVAL_MS = 60 * 60_000;
/** The most Shots one transaction computes again: each brings its measurements, which a long Shot has megabytes of. */
export const CURVES_REFRESH_BATCH = 20;

/** Long enough for a batch of long Shots' measurements to be read and written back; waiting for a connection is limited as for any other transaction. */
const REFRESH_TRANSACTION = { maxWait: 2_000, timeout: 60_000 } as const;

/**
 * Computes again, from its measurements, the Preheat, duration and peaks of
 * every Shot stored with an earlier revision of `extractCurves`
 * (CURVES_REVISION), as the server starts and then every hour, on every
 * instance, in the background, as `DeliveryIdCleanup` deletes. The hourly
 * runs take the Shots the previous release stores while it still serves
 * beside this one. A run that fails is logged, and the next tries again.
 */
@Injectable()
export class CurvesRefresh implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("CurvesRefresh");
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
        if (!this.stopped) this.schedule(CURVES_REFRESH_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    let refreshed = 0;
    try {
      // Until a batch finds fewer than it may take, or the server shuts down.
      while (!this.stopped) {
        const count = await this.refreshBatch();
        refreshed += count;
        if (count < CURVES_REFRESH_BATCH) break;
      }
    } catch (error) {
      this.logger.error(`Could not compute Shots' curves again; trying again in an hour: ${String(error)}`);
    }
    if (refreshed > 0) this.logger.log(`Computed the Preheat, duration and peaks of ${refreshed} stored ${refreshed === 1 ? "Shot" : "Shots"} again`);
  }

  /**
   * Computes a batch again, with the Shots' rows locked, skipping those
   * another transaction has locked, such as a delivery storing one, so it
   * waits for no one, and runs on other instances take other Shots. A
   * delivery of a Shot's full record stores its values at this revision, and
   * an edit leaves them as they are, so neither is undone by a batch that
   * read the Shot before it.
   */
  private refreshBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const shots = await tx.$queryRaw<{ id: string; record: unknown; measurements: unknown }[]>`
        SELECT s.id, s.record, m.data AS measurements FROM shots AS s JOIN shot_measurements AS m ON m.shot_id = s.id
        WHERE s.curves_revision < ${CURVES_REVISION}::integer
        ORDER BY s.id LIMIT ${CURVES_REFRESH_BATCH}::integer
        FOR UPDATE OF s SKIP LOCKED`;
      for (const shot of shots) {
        const { preheat, duration, peakPressure, peakFlow } = extractCurves(shot.record, shot.measurements);
        await tx.$executeRaw`
          UPDATE shots SET preheat = ${preheat}, duration = ${duration}, peak_pressure = ${peakPressure}, peak_flow = ${peakFlow},
            curves_revision = ${CURVES_REVISION}::integer
          WHERE id = ${shot.id}`;
      }
      return shots.length;
    }, REFRESH_TRANSACTION);
  }
}
