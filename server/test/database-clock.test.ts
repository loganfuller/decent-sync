import { CLOSE_CODES } from "@decent-sync/protocol";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1: the times the server stores come from PostgreSQL's clock, which
// every instance shares, never from the instance's own (ADR-0016). The server
// here runs two days ahead of real time, so a time taken from its clock would
// be two days after the database's. Hardware ids are made up: serials from
// 10001, connection ids from 00:00:5E:00:53:xx.

const DAY_MS = 24 * 60 * 60_000;
const de1Pro = (serial: string) => ({ model: "DE1Pro", serial, firmware: "1333" });

/**
 * Columns that hold no time the server takes: Prisma's `@updatedAt` fills
 * `updated_at` from the instance's clock, expiry is set in the future, and
 * the rest are the tablet's clock or a time an Admin entered.
 */
const NOT_SERVER_TIMES = ["updated_at", "expires_at", "observed_at", "pulled_at", "steamed_at", "version_at", "effective_from"];

describe("times stored by an instance whose clock is two days ahead", { timeout: 30_000 }, () => {
  runAsSteps();

  let server: TestServer;
  let api: AdminApi;
  let database: pg.Client;
  const connections: RawConnection[] = [];

  /** Opens a raw connection and sends a hello, resolving with the connection once the server answers. */
  const connect = async (hello: Record<string, unknown>) => {
    const raw = await RawConnection.open(server.url);
    connections.push(raw);
    raw.send(hello);
    await raw.message(0);
    return raw;
  };

  const expectRefused = async (raw: RawConnection, code: keyof typeof CLOSE_CODES) => {
    expect(await raw.closed).toEqual({ code: CLOSE_CODES[code], reason: code });
  };

  /**
   * Expects each time the query selects as `at` to have been stored within
   * the last minute by the database's clock. A time from the server's would
   * be two days ahead of it.
   */
  const expectJustStored = async (query: string, values: unknown[]) => {
    const { rows } = await database.query<{ seconds: string }>(`SELECT extract(epoch FROM now() - at) AS seconds FROM (${query}) AS stored`, values);
    expect(rows.length, query).toBeGreaterThan(0);
    for (const { seconds } of rows) {
      // Stored to the millisecond, which may round up past the database's now.
      expect(Number(seconds), query).toBeGreaterThan(-0.001);
      expect(Number(seconds), query).toBeLessThan(60);
    }
  };

  const refusalOf = (machine: CreatedMachine) =>
    expectJustStored("SELECT refused_at AS at FROM machines WHERE id = $1 AND refused_at IS NOT NULL", [machine.machine.id]);

  beforeAll(async () => {
    server = await startTestServer({ clockOffsetMs: 2 * DAY_MS });
    api = await AdminApi.setUp(server.url);
    database = await server.connectDatabase();
    // The offset reaches the server's code.
    expect(await api.instanceClockOffsetMs(database)).toBeGreaterThan(2 * DAY_MS - 60_000);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await database?.end();
    await server?.stop();
  });

  let lab: CreatedMachine;

  it("creates a Machine, its token and its first Location History entry at the database's time", async () => {
    const harbor = await api.createLocation("Harbor", "America/New_York");
    lab = await api.createMachine("Lab", harbor.id);
    await expectJustStored("SELECT created_at AS at FROM machines WHERE id = $1", [lab.machine.id]);
    await expectJustStored("SELECT created_at AS at FROM machine_tokens WHERE machine_id = $1", [lab.machine.id]);
    await expectJustStored("SELECT created_at AS at FROM location_assignments WHERE machine_id = $1", [lab.machine.id]);
    await expectJustStored("SELECT created_at AS at FROM locations WHERE id = $1", [harbor.id]);
  });

  it("records a refusal for a Decaid too old at the database's time", async () => {
    await expectRefused(await connect(helloWith(lab.token, { machine: de1Pro("10001"), decaidVersion: "0.8.6+2800" })), "decaid_too_old");
    await refusalOf(lab);
  });

  it("binds the hardware, remembering the connection id, at the database's time", async () => {
    const raw = await connect(helloWith(lab.token, { machine: de1Pro("10001"), connectionId: "00:00:5E:00:53:10" }));
    expect(raw.messages[0]).toMatchObject({ type: "welcome" });
    await raw.close();
    await expectJustStored("SELECT created_at AS at FROM machine_aliases WHERE machine_id = $1", [lab.machine.id]);
  });

  it("holds a mismatch's hardware as a Pending Machine created at the database's time", async () => {
    const raw = await connect(helloWith(lab.token, { machine: de1Pro("10002"), connectionId: "00:00:5E:00:53:11" }));
    expect(raw.messages[0]).toMatchObject({ type: "welcome" });
    await raw.close();
    await expectJustStored("SELECT created_at AS at FROM pending_machines WHERE model = 'DE1Pro' AND serial = '10002'", []);
  });

  it("dismisses the Pending Machine, refusing its hardware to the mismatched Machine, at the database's time", async () => {
    const [pending] = await api.pendingMachines();
    expect((await api.call("POST", `/pending-machines/${pending!.id}/dismiss`)).status).toBe(200);
    await expectJustStored("SELECT dismissed_at AS at FROM pending_machines WHERE id = $1", [pending!.id]);
    await expectJustStored("SELECT created_at AS at FROM dismissed_hardware WHERE machine_id = $1", [lab.machine.id]);
    await refusalOf(lab);
  });

  it("records a refusal for dismissed hardware at the database's time", async () => {
    await database.query("UPDATE machines SET refused_at = NULL WHERE id = $1", [lab.machine.id]);
    await expectRefused(await connect(helloWith(lab.token, { machine: de1Pro("10002") })), "hardware_dismissed");
    await refusalOf(lab);
  });

  it("revokes a reissued token, and records a refusal for it, at the database's time", async () => {
    const reissued = await api.call("POST", `/machines/${lab.machine.id}/token`);
    expect(reissued.status).toBe(201);
    await api.issued(reissued);
    await expectJustStored("SELECT revoked_at AS at FROM machine_tokens WHERE machine_id = $1 AND revoked_at IS NOT NULL", [lab.machine.id]);

    await database.query("UPDATE machines SET refused_at = NULL WHERE id = $1", [lab.machine.id]);
    await expectRefused(await connect(helloWith(lab.token, { machine: de1Pro("10001") })), "bad_token");
    await refusalOf(lab);
  });

  it("stores no time ahead of the database's clock", async () => {
    await api.invite("bea@example.com", "admin");
    const { rows: columns } = await database.query<{ table: string; column: string }>(
      `SELECT table_name AS table, column_name AS column FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'timestamp with time zone' AND NOT column_name = ANY($1)
       ORDER BY table_name, column_name`,
      [NOT_SERVER_TIMES],
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const { table, column } of columns) {
      const { rows } = await database.query<{ ahead: boolean }>(`SELECT bool_or("${column}" > now() + interval '1 minute') AS ahead FROM "${table}"`);
      expect(rows[0]!.ahead, `${table}.${column}`).not.toBe(true);
    }
  });
});
