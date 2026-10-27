import { PROTOCOL_VERSION, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type OutageProxy, startOutageProxy } from "./support/outage-proxy.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #284: a server instance rides through its database going
// away and coming back, as in a failover to the replica, without a restart
// (ADR-0025). It reaches PostgreSQL through a proxy (`outage-proxy.ts`) that
// cuts every connection and refuses new ones, as a database restarting does,
// or stops forwarding without closing anything, as a primary that vanished
// does. A second instance on the same database, connected directly, makes
// changes while the first can't hear of them, and reads what came of the
// outage. The built plugin runs in simulated tablets. Serials are made up,
// from 28401.

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
/** How long a request may take to fail while the database is away: a connection's 5 s timeout, and some slack. */
const FAILS_WITHIN_MS = 7_000;

interface Frame { type: string; id?: string }

/** A real Shot naming no hardware, so it is credited to the Machine whose tablet sends it. */
function shot(id: string) {
  const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
  return derivedShot(id, { workflow });
}

describe("a server whose database goes away", () => {
  let direct: TestServer;
  let behind: TestServer;
  let proxy: OutageProxy;
  let api: AdminApi;
  let behindApi: AdminApi;
  let serial = 28_401;

  beforeAll(async () => {
    proxy = await startOutageProxy();
    direct = await startTestServer({ env });
    behind = await startTestServer({ env, sharing: direct, databaseHost: proxy.host });
    api = await AdminApi.setUp(direct.url);
    behindApi = api.at(behind.url);
  });
  afterAll(async () => {
    await direct?.stop();
    await proxy?.close();
  });

  /**
   * Two Machines at a new Location, their tablets connected to the instance
   * behind the proxy, their Libraries empty: one stays idle through the
   * outage, the other pulls a Shot during it.
   */
  async function locationWithTablets(name: string): Promise<{ location: LocationView; idle: CreatedMachine; idleTablet: SimulatedTablet; pulling: CreatedMachine; pullingTablet: SimulatedTablet }> {
    const location = await api.createLocation(name, "America/Toronto");
    const idle = await api.createMachine(`${name} idle`, location.id);
    const pulling = await api.createMachine(`${name} pulling`, location.id);
    const idleTablet = syncingTablet(idle, behind, { api: emptyLibrary(serial++) });
    const pullingTablet = syncingTablet(pulling, behind, { api: emptyLibrary(serial++) });
    await api.waitForOnline(idle, pulling);
    // A Settings Edit expects the fan threshold the Machine reported.
    await expect.poll(async () => (await machineSettings(idle))?.fan).toBe(50);
    // Nothing under way as the database goes: one that is fails, which closes its connection.
    await expect.poll(() => [idleTablet, pullingTablet].map(settled).every(Boolean), { interval: 250 }).toBe(true);
    return { location, idle, idleTablet, pulling, pullingTablet };
  }
  /** Whether the server has acknowledged everything the tablet sent, which it last did a poll ago or more. */
  const sentAtLastPoll = new Map<SimulatedTablet, number>();
  function settled(tablet: SimulatedTablet): boolean {
    const sent = tablet.sent as Frame[];
    const quiet = sentAtLastPoll.get(tablet) === sent.length;
    sentAtLastPoll.set(tablet, sent.length);
    const acknowledged = new Set((tablet.received as Frame[]).filter((frame) => frame.type === "ack").map((frame) => frame.id));
    return quiet && sent.every((frame) => ["hello", "heartbeat", "chunk"].includes(frame.type) || acknowledged.has(frame.id));
  }
  const machineSettings = async (machine: CreatedMachine) =>
    (await api.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`)).collection?.value;
  const welcomes = (tablet: SimulatedTablet) => (tablet.received as Frame[]).filter((frame) => frame.type === "welcome").length;
  const routingCheck = async () => {
    const response = await fetch(`${behind.url}/api/health`);
    return { status: response.status, body: (await response.json()) as { database?: string } };
  };
  /** Resolves with a request's status, and how long it took to answer. */
  async function timed(request: Promise<Response>): Promise<{ status: number; ms: number }> {
    const started = Date.now();
    const { status } = await request;
    return { status, ms: Date.now() - started };
  }
  const listMachines = () => behindApi.call("GET", "/machines");

  /** A Library change and a Settings Edit made through the other instance, which the instance behind the proxy can't hear of meanwhile. */
  async function changeMeanwhile(location: LocationView, machine: CreatedMachine, beanName: string) {
    // First, as an edit is made only while the Machine was heard from within three heartbeats.
    const { settingsEdit } = await api.send<{ settingsEdit: { id: string } }>(
      "POST",
      `/machines/${machine.machine.id}/settings-edits`,
      { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } },
      201,
    );
    const { bean } = await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: beanName } }, 201);
    await api.send("POST", "/bean-batches", { beanId: bean.id, content: {}, locations: [{ locationId: location.id }] }, 201);
    return { editId: settingsEdit.id, beanId: bean.id };
  }

  /** Once the database is back: requests succeed again at once, after at most one more failure, on a connection lost meanwhile. */
  async function expectServing(): Promise<void> {
    const statuses: number[] = [];
    await expect
      .poll(
        async () => {
          statuses.push((await listMachines()).status);
          return statuses.at(-1);
        },
        { timeout: FAILS_WITHIN_MS, interval: 100 },
      )
      .toBe(200);
    expect(statuses.slice(0, -1)).toEqual(statuses.length > 1 ? [503] : []);
    await expect.poll(async () => (await routingCheck()).body.database, { timeout: 5_000 }).toBe("reachable");
  }

  /** What the outage must not have lost: the idle tablet is written what was changed meanwhile, without reconnecting, and the Shot pulled is stored, nothing set aside. */
  async function expectNothingLost(
    tablets: { idle: CreatedMachine; idleTablet: SimulatedTablet; pulling: CreatedMachine; pullingTablet: SimulatedTablet },
    meanwhile: { editId: string; beanId: string },
    pulledId: string,
  ): Promise<void> {
    const { idle, idleTablet, pulling, pullingTablet } = tablets;
    await expect.poll(() => idleTablet.beans().some((record) => globalIdOf(record) === meanwhile.beanId), { timeout: 15_000 }).toBe(true);
    await expect
      .poll(async () => (await api.get<{ settingsEdit: { outcome: string | null } }>(`/machines/${idle.machine.id}/settings-edits/${meanwhile.editId}`)).settingsEdit.outcome, {
        timeout: 15_000,
      })
      .toBe("applied");
    expect(welcomes(idleTablet)).toBe(1);

    await expect.poll(async () => (await api.call("GET", `/shots/${pulledId}`)).status, { timeout: 15_000 }).toBe(200);
    expect(welcomes(pullingTablet)).toBeGreaterThan(1);
    expect((await api.get<{ total: number }>(`/machines/${pulling.machine.id}/set-aside-deliveries`)).total).toBe(0);
  }

  it("cut off, refusing connections, answers requests with 503 at once and its routing check with 200, then serves again once the database is back, having lost nothing", async () => {
    const tablets = await locationWithTablets("Cut off");
    expect(await timed(listMachines())).toMatchObject({ status: 200 });

    proxy.cut();
    try {
      const failed = await timed(listMachines());
      expect(failed.status).toBe(503);
      expect(failed.ms).toBeLessThan(FAILS_WITHIN_MS);
      expect(await (await listMachines()).json()).toMatchObject({ statusCode: 503, message: "The database can't be reached right now. Try again in a moment." });
      expect(await routingCheck()).toEqual({ status: 200, body: { status: "ok", protocolVersion: PROTOCOL_VERSION, database: "unreachable" } });

      const meanwhile = await changeMeanwhile(tablets.location, tablets.idle, "Cut off Guji");
      const pulled = shot("pulled-while-cut-off");
      tablets.pullingTablet.pullShot(pulled);
      // Its delivery failed, so the connection closed, and the plugin tries again.
      await tablets.pullingTablet.waitForLog(/^Disconnected/, FAILS_WITHIN_MS);

      proxy.restore();
      await expectServing();
      await expectNothingLost(tablets, meanwhile, pulled.id as string);
    } finally {
      proxy.restore();
    }
  });

  it("silenced, closing nothing, answers requests with 503 within a connection's timeout and its routing check with 200, then serves again once the database is back, having lost nothing", async () => {
    const tablets = await locationWithTablets("Silenced");

    proxy.silence();
    try {
      const meanwhile = await changeMeanwhile(tablets.location, tablets.idle, "Silenced Guji");
      const pulled = shot("pulled-while-silenced");
      tablets.pullingTablet.pullShot(pulled);
      // On a connection the pool holds, which waits for an answer that never comes.
      const onHeldConnection = timed(listMachines());
      const check = await timed(fetch(`${behind.url}/api/health`));
      expect(check.status).toBe(200);
      expect(check.ms).toBeLessThan(3_000);
      expect((await routingCheck()).body.database).toBe("unreachable");

      // Standing in for the server giving up on its silent connections in time, rather than waiting out their timeouts.
      proxy.resetConnections();
      expect((await onHeldConnection).status).toBe(503);
      // On a new connection, which is accepted and never answered.
      const onNewConnection = await timed(listMachines());
      expect(onNewConnection.status).toBe(503);
      expect(onNewConnection.ms).toBeLessThan(FAILS_WITHIN_MS);
      await tablets.pullingTablet.waitForLog(/^Disconnected/, FAILS_WITHIN_MS);
      // The notifications listener's connect hung too, and timed out.
      await expect.poll(() => behind.output().includes("Not listening for access changes, Library changes, moves or Settings Edits (timeout expired)"), { timeout: FAILS_WITHIN_MS }).toBe(true);

      proxy.restore();
      await expectServing();
      await expectNothingLost(tablets, meanwhile, pulled.id as string);
    } finally {
      proxy.restore();
    }
  });
});
