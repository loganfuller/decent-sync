import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #704 (ADR-0037): releases before it left a Bean Batch at
// every Location it was added at. Its migration
// (`20261125000001_batches_at_one_location`) leaves a batch that is at
// several at the one it was added at last, with the weight entered there, and
// finishes it at the others, as one version of the batch attributed to the
// upgrade, changing no batch that is at one Location or none. The
// migration's SQL is run again on a migrated database holding what 1.14.0
// left, through the database, the REST API and simulated tablets. Serials are
// made up, from 70451.

interface BatchView {
  id: string;
  locations: { location: LocationView; remainingWeight: number | null }[];
  finished: { location: LocationView; remainingWeight: number | null }[];
}

interface Version {
  id: string;
  fields: Record<string, unknown>;
  location: LocationView | null;
  movedFrom: LocationView[];
  settled: boolean;
  source: { machine: unknown; tabletId: unknown; account: unknown; connectedApp: unknown };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations/20261125000001_batches_at_one_location/migration.sql");

describe("A Bean Batch at several Locations, from 1.14.0's data", { timeout: 90_000 }, () => {
  let server: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    // From template0, migrated by this release, since later releases' CI runs this suite on a schema of theirs (AI_BUILD_NOTES.md).
    server = await startTestServer({ env, emptyDatabase: true });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const batch = async (id: string) => (await api.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const versions = async (id: string) => (await api.get<{ versions: Version[] }>(`/bean-batches/${id}/history`)).versions;
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);

  it("is left by the migration at the one it was added at last, finished at the others, as one history entry attributed to the upgrade", async () => {
    const places: { location: LocationView; tablet: SimulatedTablet }[] = [];
    for (const [index, name] of ["Upgrade lab", "Upgrade cafe", "Upgrade kiosk"].entries()) {
      const location = await api.createLocation(name, "America/Chicago");
      const machine = await api.createMachine(`${name} 1`, location.id);
      places.push({ location, tablet: syncingTablet(machine, server, { api: emptyLibrary(String(70_451 + index)) }) });
      await api.waitForOnline(machine);
    }
    const [lab, cafe, kiosk] = places as [(typeof places)[number], (typeof places)[number], (typeof places)[number]];
    const { bean } = await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Upgraded Guji" } }, 201);
    const create = async (location: LocationView, remainingWeight?: number) =>
      (await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId: bean.id, locations: [{ locationId: location.id, ...(remainingWeight === undefined ? {} : { remainingWeight }) }] }, 201)).batch;
    const place = (id: string, location: LocationView, body: Record<string, unknown>) => api.send("PUT", `/bean-batches/${id}/locations/${location.id}`, body);

    // One batch that has been at all three, with a weight entered at each, the cafe the one it was added at last; one
    // at the kiosk alone; and one finished everywhere.
    const several = await create(lab.location, 900);
    await place(several.id, kiosk.location, { atLocation: true, remainingWeight: 300 });
    await place(several.id, cafe.location, { atLocation: true, remainingWeight: 600 });
    const single = await create(kiosk.location, 120);
    const nowhere = await create(lab.location);
    await place(nowhere.id, lab.location, { atLocation: false });
    await expect.poll(() => held(cafe.tablet, several.id)).toMatchObject({ archived: false, weightRemaining: 600 });

    const database = await server.connectDatabase();
    try {
      // As 1.14.0 leaves it: at each Location it was added at, with the weight entered there.
      await database.query(`UPDATE batch_locations SET finished_at = NULL WHERE batch_id = $1`, [several.id]);
      await database.query(`NOTIFY library_changes, '${lab.location.id}'`);
      for (const { tablet } of places) await expect.poll(() => held(tablet, several.id)?.archived, { timeout: 15_000 }).toBe(false);
      expect((await batch(several.id)).locations.map((here) => here.location.name)).toEqual(["Upgrade cafe", "Upgrade kiosk", "Upgrade lab"]);
      const before = { several: await versions(several.id), single: await versions(single.id), nowhere: await versions(nowhere.id) };
      const untouched = { single: await batch(single.id), nowhere: await batch(nowhere.id) };

      await database.query(fs.readFileSync(MIGRATION, "utf8"));
      await database.query(`NOTIFY library_changes, '${lab.location.id}'`);

      const after = await batch(several.id);
      expect(after.locations).toMatchObject([{ location: { id: cafe.location.id }, remainingWeight: 600 }]);
      expect(after.finished.map((here) => [here.location.name, here.remainingWeight])).toEqual([
        ["Upgrade kiosk", 300],
        ["Upgrade lab", 900],
      ]);
      const history = await versions(several.id);
      expect(history).toHaveLength(before.several.length + 1);
      expect(history[0]).toMatchObject({
        fields: { atLocation: true },
        location: { id: cafe.location.id },
        // The Locations it was finished at, the one added at later first.
        movedFrom: [{ id: kiosk.location.id }, { id: lab.location.id }],
        settled: true,
        source: { machine: null, tabletId: null, account: null, connectedApp: null },
      });
      // The tablets at the Locations it left archive their record, and the cafe's keeps it.
      for (const tablet of [lab.tablet, kiosk.tablet]) await expect.poll(() => held(tablet, several.id)?.archived, { timeout: 15_000 }).toBe(true);
      expect(held(cafe.tablet, several.id)).toMatchObject({ archived: false, weightRemaining: 600 });
      // A batch at one Location, or at none, is as it was.
      expect(await batch(single.id)).toEqual(untouched.single);
      expect(await batch(nowhere.id)).toEqual(untouched.nowhere);
      expect(await versions(single.id)).toEqual(before.single);
      expect(await versions(nowhere.id)).toEqual(before.nowhere);

      // Run again, it changes nothing.
      await database.query(fs.readFileSync(MIGRATION, "utf8"));
      expect(await batch(several.id)).toEqual(after);
      expect(await versions(several.id)).toEqual(history);

      // A later un-archive at a Location it left is a move as any other, from where the upgrade left it.
      await lab.tablet.editBatch(held(lab.tablet, several.id)!.id, { archived: false });
      await expect.poll(async () => (await batch(several.id)).locations.map((here) => here.location.name)).toEqual(["Upgrade lab"]);
      expect((await versions(several.id))[0]).toMatchObject({ fields: { atLocation: true }, location: { id: lab.location.id }, movedFrom: [{ id: cafe.location.id }], settled: false });
      expect((await batch(several.id)).locations[0]!.remainingWeight).toBe(600);
    } finally {
      await database.end();
    }
  });
});
