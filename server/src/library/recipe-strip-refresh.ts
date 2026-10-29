import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type EditSource, recordVersion } from "./history.js";
import { lockLocation, transactionTime } from "./location-state.js";
import { placedIn } from "./recipes.js";

/** How often each server instance looks for Recipes whose `showOnDashboard` is not their slot's. */
export const RECIPE_STRIP_REFRESH_INTERVAL_MS = 60 * 60_000;

/** No account's or tablet's: the server's own change. */
const SERVER: EditSource = { machineId: null, tabletId: null, accountId: null };

/**
 * Brings each Recipe's `showOnDashboard` to its slot's, as the server starts
 * and then every hour, on every instance, in the background, as
 * `CurvesRefresh` computes curves again. A Recipe is on Streamline's strip
 * exactly while it is in a Recipe Slot (DYE2 v0.1.32, #371), and this
 * release writes its records so (`recipeRecord`) and keeps `showOnDashboard`
 * in its content set from its slot (`placedIn`), which the previous release
 * writes its records from (ADR-0025). Before, a Recipe could be in a slot and
 * hidden, as the management interface's switch or Streamline's long-press
 * Clear left one, which Streamline showed as an empty button: it is taken out
 * of its slot, as DYE2 v0.1.32 takes one it saves hidden out of its slot, so
 * the strip shows what it showed, a version of its own from the server, and
 * its Location's tablets are written. Any other Recipe's `showOnDashboard` is
 * set from its slot. The hourly runs take those the previous release leaves
 * so while it still serves beside this one. Each Location's are changed
 * under its lock, as a slot is. A run that fails is logged, and the next
 * tries again.
 */
@Injectable()
export class RecipeStripRefresh implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("RecipeStripRefresh");
  private timer: NodeJS.Timeout | undefined;
  /** The run in progress, which shutdown waits for. */
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  /** Runs before the database disconnects: stops the timer, and lets a run in progress finish its Location. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(RECIPE_STRIP_REFRESH_INTERVAL_MS);
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    let taken = 0;
    try {
      const locations = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT location_id::text AS id FROM recipes
        WHERE location_id IS NOT NULL AND (content -> 'showOnDashboard') IS DISTINCT FROM to_jsonb(slot IS NOT NULL)`;
      for (const { id } of locations) {
        if (this.stopped) break;
        taken += await this.refresh(id);
      }
    } catch (error) {
      this.logger.error(`Could not set Recipes' showOnDashboard from their slots; trying again in an hour: ${String(error)}`);
    }
    if (taken > 0) this.logger.log(`Took ${taken} ${taken === 1 ? "Recipe hidden from the strip" : "Recipes hidden from the strip"} out of ${taken === 1 ? "its slot" : "their slots"}`);
  }

  /** The Location's Recipes brought to their slots, under its lock; how many were taken out of their slots. */
  private refresh(locationId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await lockLocation(tx, locationId);
      const hidden = await tx.$queryRaw<{ id: string }[]>`
        UPDATE recipes SET ${placedIn(null)}
        WHERE location_id = ${locationId}::uuid AND slot IS NOT NULL AND content -> 'showOnDashboard' = 'false'::jsonb
        RETURNING id::text AS id`;
      const at = await transactionTime(tx);
      for (const { id } of hidden) await recordVersion(tx, { kind: "recipe", id }, locationId, { slot: null }, SERVER, at);
      await tx.$executeRaw`
        UPDATE recipes SET content = jsonb_set(content, '{showOnDashboard}', to_jsonb(slot IS NOT NULL))
        WHERE location_id = ${locationId}::uuid AND (content -> 'showOnDashboard') IS DISTINCT FROM to_jsonb(slot IS NOT NULL)`;
      if (hidden.length > 0) await notify(tx, "library_changes", locationId);
      return hidden.length;
    });
  }
}
