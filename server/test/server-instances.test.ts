import { CLOSE_CODES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, helloWith, settingsFor } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 with more than one server instance on one database, as a
// horizontally scaled deployment runs: a tablet connects to one instance
// while the Admin uses another. Which connection holds a Machine lives in
// the database, and changes reach every instance as notifications.

const HEARTBEAT_SECONDS = 0.5;
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "1", SYNC_HEARTBEAT_SECONDS: String(HEARTBEAT_SECONDS) };
const de1Pro = (serial: string) => ({ model: "DE1Pro", serial, firmware: "1333" });

describe("several server instances", { timeout: 30_000 }, () => {
  let first: TestServer;
  let second: TestServer;
  /** The Admin on the first instance, and on the second. */
  let api: AdminApi;
  let other: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const connections: RawConnection[] = [];

  const connect = async (server: TestServer, hello: Record<string, unknown>) => {
    const raw = await RawConnection.open(server.url);
    connections.push(raw);
    raw.send(hello);
    await raw.message(0);
    return raw;
  };

  beforeAll(async () => {
    first = await startTestServer({ env });
    second = await startTestServer({ env, sharing: first });
    api = await AdminApi.setUp(first.url);
    other = api.at(second.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await second?.stop();
    await first?.stop();
  });

  it("lists a Machine connected to one instance as online on another", async () => {
    const created = await api.createMachine("Uptown");
    const tablet = SimulatedTablet.load({ settings: settingsFor(created), api: derivedDe1Pro({ serial: "12001" }) });
    tablets.push(tablet);
    expect(await other.waitForMachine("Uptown", (machine) => machine.online)).toMatchObject({ identification: "identified", serial: "12001" });

    // Heartbeats on the first instance keep it online on the second.
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 4000));
    expect(await other.machineNamed("Uptown")).toMatchObject({ online: true });
    await tablet.unload();
    await other.waitForMachine("Uptown", (machine) => !machine.online);
  });

  it("replaces a connection to one instance with a newer one to another, and the stale close leaves the Machine online", async () => {
    const { token } = await api.createMachine("Belmont");
    const older = await connect(first, helloWith(token, { machine: de1Pro("12101") }));
    const newer = await connect(second, helloWith(token, { machine: de1Pro("12101") }));
    expect(newer.messages[0]).toMatchObject({ type: "welcome" });

    expect(await older.closed).toEqual({ code: CLOSE_CODES.replaced, reason: "replaced" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await api.machineNamed("Belmont")).toMatchObject({ online: true });
    expect(newer.messages).toHaveLength(1);
  });

  it("closes a connection to one instance when its token is reissued on another", async () => {
    const created = await api.createMachine("Lab");
    const tablet = SimulatedTablet.load({ settings: settingsFor(created), api: derivedDe1Pro({ serial: "12201" }) });
    tablets.push(tablet);
    await api.waitForMachine("Lab", (machine) => machine.online);

    const response = await other.call("POST", `/machines/${created.machine.id}/token`);
    expect(response.status).toBe(201);
    await tablet.waitForLog(/^The server refused the token\./);
    await api.waitForMachine("Lab", (machine) => !machine.online);
  });

  it("closes a mismatched connection to one instance when its hardware is dismissed on another", async () => {
    const { token } = await api.createMachine("Roastery");
    const bind = await connect(first, helloWith(token, { machine: de1Pro("12301") }));
    await bind.close();
    const mismatched = await connect(first, helloWith(token, { machine: de1Pro("12302") }));
    const pending = (await other.pendingMachines()).find((candidate) => candidate.serial === "12302")!;

    expect((await other.call("POST", `/pending-machines/${pending.id}/dismiss`)).status).toBe(200);
    expect(await mismatched.closed).toEqual({ code: CLOSE_CODES.hardware_dismissed, reason: "hardware_dismissed" });
    const again = await connect(first, helloWith(token, { machine: de1Pro("12302") }));
    expect(again.messages[0]).toMatchObject({ type: "error", code: "hardware_dismissed" });
  });

  it("shows a crashed instance's Machines offline once they have gone unheard for three heartbeat intervals", async () => {
    const doomed = await startTestServer({ env, sharing: first });
    try {
      const { token } = await api.createMachine("On a crashing instance");
      await connect(doomed, helloWith(token, { machine: de1Pro("12401") }));
      expect(await api.machineNamed("On a crashing instance")).toMatchObject({ online: true });

      await doomed.kill();
      const killedAt = Date.now();
      await api.waitForMachine("On a crashing instance", (machine) => !machine.online);
      expect(Date.now() - killedAt).toBeLessThan(HEARTBEAT_SECONDS * 3000 + 1_000);
    } finally {
      await doomed.stop();
    }
  });

  it("releases an instance's Machines when it shuts down", async () => {
    const leaving = await startTestServer({ env, sharing: first });
    try {
      const { token } = await api.createMachine("On a stopping instance");
      // Heartbeats keep it online, so going offline comes from the shutdown, not from silence.
      const raw = await connect(leaving, helloWith(token, { machine: de1Pro("12501") }));
      const beat = setInterval(() => raw.send({ type: "heartbeat" }), HEARTBEAT_SECONDS * 500);
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_SECONDS * 4000));
      expect(await api.machineNamed("On a stopping instance")).toMatchObject({ online: true });

      const stopping = leaving.stop();
      // Going away, so the plugin reconnects, never replaced, after which it would stop.
      expect((await raw.closed).code).toBe(1001);
      clearInterval(beat);
      await stopping;
      expect(await api.machineNamed("On a stopping instance")).toMatchObject({ online: false });
    } finally {
      await leaving.stop();
    }
  });

  it("never writes a token to any instance's log", () => {
    const logs = [first.output(), second.output(), ...tablets.flatMap((tablet) => tablet.logs)].join("\n");
    expect(api.tokens.length).toBeGreaterThan(3);
    for (const token of api.tokens) expect(logs).not.toContain(token);
  });
});
