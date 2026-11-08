import { randomUUID } from "node:crypto";
import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi } from "./support/admin-api.js";
import { syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { quiesced } from "./support/quiet.js";
import { SimulatedDye2, dye2List, recordedDye2MainTablet } from "./support/simulated-dye2.js";
import { RawConnection } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #452: a Workflow delivery from a Machine at a Location takes
// the Location's lock before it stores the change, whose link to the Recipe
// the Workflow names holds that Recipe's row for key share. A move of the
// Recipe's slot takes the lock first too, then its row, then changes its
// slot, part of a unique index, which waits for any key share held on the
// row: so neither waits for the other in turn. The recorded tablet
// (fixtures/decaid/dye2-v0.1.26/) brings its recipes into the Library
// through the built plugin in a simulated tablet; once the tablet's map
// holds them, the delivery is sent from that tablet in raw frames, so that
// nothing else waits for a lock meanwhile. One server instance, with
// assertions through the REST API. The serial is made up, 53001.

type Record_ = Record<string, unknown>;

/** The recording's tablet's record id of the Brazil's recipe, in Recipe Slot 2. */
const BRAZIL = "2";

describe("A Workflow delivery naming a Recipe whose slot is moving", { timeout: 60_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer();
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("is stored and taken in once a slot move holding the Recipe's Location's lock is done, deadlocking with neither", async () => {
    const here = await api.createLocation("Slot moving lab", "America/Chicago");
    const machine = await api.createMachine("Slot moving lab A", here.id);
    const tablet = syncingTablet(machine, server, { api: recordedDye2MainTablet("53001", "Slot moving"), dye2: new SimulatedDye2() });
    await api.waitForOnline(machine);
    const record = () => (dye2List(tablet, "recipes") as Record_[] | undefined)?.find((entry) => entry.id === BRAZIL);
    await expect.poll(() => dye2GlobalIdOf(record()), { timeout: 15_000 }).toEqual(expect.any(String));
    const brazil = dye2GlobalIdOf(record())!;
    await quiesced(api, { tablets: { tablet }, machines: { machine } });

    // The tablet, offline, then again in raw frames under its hello, its Workflow naming the Brazil's recipe.
    const hello = [...tablet.sent].reverse().find((frame) => (frame as Record_).type === "hello") as Record_;
    const workflow = structuredClone(tablet.workflow());
    const context = (workflow.context ?? {}) as Record_;
    const extras = (context.extras ?? {}) as Record_;
    workflow.context = { ...context, extras: { ...extras, dye: { ...((extras.dye ?? {}) as Record_), recipeId: BRAZIL } } };
    await tablet.unload();
    await api.waitForMachine(machine.machine.name, (viewed) => !viewed.online, 15_000);
    const raw = await RawConnection.welcomed(server.url, hello);
    const delivery = { type: "workflow", id: randomUUID(), observedAt: new Date().toISOString(), workflow, cause: "other" };
    const stored = async () => (await api.get<{ workflow: { workflow: Record_ } | null }>(`/machines/${machine.machine.id}/workflow`)).workflow?.workflow;
    // A change, so the delivery stores it, its link holding the Recipe's row: one the same as the latest is not stored.
    expect(await stored()).not.toEqual(workflow);

    const database = await server.connectDatabase();
    let moved: Promise<Response>;
    try {
      // Holds the Recipe's row, as the move's edit locks it once it holds the Location's lock (`RecipeEditsService.change`),
      // so the move waits there holding that lock.
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM recipes WHERE id = $1 FOR NO KEY UPDATE", [brazil]);
      moved = api.call("PUT", `/recipes/${brazil}/slot`, { slot: 5 });
      await waitForLockWaits(server);
      raw.send(delivery);
      // The delivery waits for the Location's lock, having recorded its id.
      await waitForLockWaits(server, { count: 1, writing: "machine_event_deliveries" });
      await database.query("COMMIT");
    } finally {
      await database.end();
    }

    expect((await moved).status).toBe(200);
    await raw.acknowledged(delivery.id);
    expect((await api.get<{ recipe: { slot: number | null } }>(`/recipes/${brazil}`)).recipe.slot).toBe(5);
    expect(await stored()).toEqual(workflow);
    const viewed = await api.get<{ machine: { loadedRecipe: { recipe: { id: string } } | null } }>(`/machines/${machine.machine.id}`);
    expect(viewed.machine.loadedRecipe?.recipe.id).toBe(brazil);
    await raw.close();
  });
});
