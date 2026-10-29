import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { dye2List, dye2RecipeIdOf } from "./simulated-dye2.js";
import { type DecaidApi, NO_DYE2_LISTS, SimulatedTablet, type SimulatedTabletOptions, derivedDe1Pro, settingsFor } from "./simulated-tablet.js";

// Simulated tablets as most Seam 1 tests load them: `syncingTablet()` sets
// one up with a Machine's token and a server instance's URL, polling every
// 5 s, its timers 50 times faster, so every 0.1 s. Vitest's setup unloads a
// tablet once the test that loaded it has run (test-scope.ts); a file whose
// beforeAll or runAsSteps() steps load tablets, which stay for its later
// tests, loads them through a LoadedTablets and unloads them with
// `unloadAll()` in its afterAll.

/**
 * Loads the built plugin on a tablet set up for the Machine with the server
 * instance given, polling every `pollSeconds` (5 by default), with
 * `timeScale` 50 by default. Its Decaid answers `api`, de1ProOnDecaid091() by
 * default.
 */
export function syncingTablet(
  machine: { token: string },
  instance: { url: string },
  options: Omit<SimulatedTabletOptions, "settings"> & { pollSeconds?: number } = {},
): SimulatedTablet {
  const { pollSeconds = 5, timeScale = 50, ...rest } = options;
  return SimulatedTablet.load({ settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: pollSeconds }, timeScale, ...rest });
}

/** The tablets a file loads to keep beyond the test that loads them. */
export class LoadedTablets {
  private readonly loaded: SimulatedTablet[] = [];

  /** Loads the built plugin on a simulated tablet, as SimulatedTablet.load does. */
  load(options: SimulatedTabletOptions): SimulatedTablet {
    const tablet = SimulatedTablet.load(options);
    this.loaded.push(tablet);
    return tablet;
  }

  /** Loads a tablet as syncingTablet() does. */
  syncing(...args: Parameters<typeof syncingTablet>): SimulatedTablet {
    const tablet = syncingTablet(...args);
    this.loaded.push(tablet);
    return tablet;
  }

  /** Unloads every tablet loaded since the last call, and resolves with them. */
  async unloadAll(): Promise<SimulatedTablet[]> {
    const loaded = this.loaded.splice(0);
    await Promise.all(loaded.map((tablet) => tablet.unload()));
    return loaded;
  }
}

/**
 * Derived from derivedDe1Pro(): the tablet with this serial, its Decaid
 * holding no beans, bean batches, grinders or profiles, and none of DYE2's
 * recipes, baskets or tools, so that its Library is only what the test puts
 * there.
 */
export function emptyLibrary(serial: string | number): DecaidApi {
  return { ...derivedDe1Pro({ serial: String(serial) }), "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [], ...NO_DYE2_LISTS };
}

/**
 * A time Decaid wrote in the tablet's local time without an offset, to the
 * millisecond the plugin reads, as a UTC instant: the simulated tablet's time
 * zone is the test process's.
 */
export function localTime(written: unknown): number {
  return new Date(String(written).slice(0, 23)).getTime();
}

/** The record id of the recipe the tablet's Workflow names as the one being dialled in (`context.extras.dye.recipeId`, as DYE2's `recipeIdOf` reads it), null for none. */
export function recipeIdInWorkflow(tablet: SimulatedTablet): string | null {
  return dye2RecipeIdOf(tablet.workflow());
}

/**
 * The Recipe the tablet's Workflow names by its `recipeId`, through the
 * tablet's DYE2 recipes: the global id of the record with that id, or null
 * for none, a record not on the tablet, or one carrying no global id.
 */
export function recipeNamedInWorkflow(tablet: SimulatedTablet): string | null {
  const id = recipeIdInWorkflow(tablet);
  const records = dye2List(tablet, "recipes");
  const record: unknown = id === null || !Array.isArray(records) ? undefined : records.find((entry: unknown) => (entry as { id?: unknown } | null)?.id === id);
  return record === undefined ? null : dye2GlobalIdOf(record);
}
