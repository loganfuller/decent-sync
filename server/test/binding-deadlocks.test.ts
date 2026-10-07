import { randomUUID } from "node:crypto";
import { CLOSE_CODES } from "@decent-sync/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { RawConnection, de1ProOnDecaid087, helloWith, workflowFixture } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for #65 (with #101, combined into it): a Workflow, machine state or
// collection delivery takes its Machine's row lock before it records its
// delivery id, which references the Machine, so it never deadlocks with what
// binds the Machine's hardware under that lock: a hello, or an Admin entering
// an Unidentified Machine's model and serial. Raw frames against two real
// servers sharing one PostgreSQL database, with assertions through the REST
// API. Each race is decided, in both orders, by the Machine's row, which the
// test holds. The Workflow and settings are the test tablet's (see the
// fixtures' README); serials are made up.

const OBSERVED_AT = "2026-10-07T12:00:00.000Z";
// Longer than any test. A heartbeat records its Machine as seen, so while the test holds that Machine's row it
// would wait there, ahead of the deliveries sent after it. The server drops a connection silent for 3 s, so a test
// starts heartbeats once it lets the row go.
const SILENT = 60_000;

describe("Deliveries while a Machine's hardware is bound", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  async function get<T>(path: string): Promise<T> {
    const response = await api.call("GET", path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  /** Welcomed on the first instance, sending heartbeats every `heartbeatMs`. */
  async function connect(machine: CreatedMachine, hello: Record<string, unknown>, heartbeatMs?: number) {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, hello), heartbeatMs);
    raws.push(raw);
    return raw;
  }
  /**
   * Decides the steps in the order given: holds the Machine's row as
   * `lockMachine` does, starts each step once those before it wait for the
   * row, then lets it go. Steps waiting for the row are granted it in the
   * order they asked for it.
   */
  async function inOrder(machine: CreatedMachine, steps: (() => void)[]): Promise<void> {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("SELECT 1 FROM machines WHERE id = $1 FOR NO KEY UPDATE", [machine.machine.id]);
      for (const [index, step] of steps.entries()) {
        step();
        await waitForLockWaits(server, { count: index + 1 });
      }
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
  }

  const settings = de1ProOnDecaid087()["/machine/settings"];
  /** Each kind of delivery handled once by its id, and what the Machine shows it stored. */
  const KINDS = [
    {
      kind: "Workflow",
      delivery: () => ({ type: "workflow", id: randomUUID(), observedAt: OBSERVED_AT, workflow: workflowFixture() }),
      stored: async (machine: CreatedMachine) =>
        (await get<{ events: { workflow: unknown }[] }>(`/machines/${machine.machine.id}/workflow-events`)).events.map((event) => event.workflow),
      expected: [workflowFixture()] as unknown[],
    },
    {
      kind: "machine state",
      delivery: () => ({ type: "machineState", id: randomUUID(), observedAt: OBSERVED_AT, state: "idle", substate: "idle" }),
      stored: async (machine: CreatedMachine) =>
        (await get<{ events: { state: string; substate: string }[] }>(`/machines/${machine.machine.id}/machine-state-events`)).events.map(
          (event) => [event.state, event.substate],
        ),
      expected: [["idle", "idle"]] as unknown[],
    },
    {
      kind: "collection",
      delivery: () => ({ type: "collection", id: randomUUID(), name: "machineSettings", available: true, value: settings }),
      stored: async (machine: CreatedMachine) => {
        const { collection } = await get<{ collection: { value: unknown } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`);
        return collection ? [collection.value] : [];
      },
      expected: [settings] as unknown[],
    },
  ];

  it.each(KINDS.map((kind, index) => ({ ...kind, serial: String(40001 + index) })))(
    "stores a $kind delivery waiting for its Machine while that Machine's hardware is bound under its lock, deadlocking with neither",
    async ({ kind, delivery, stored, expected, serial }) => {
      const name = `Bound during a ${kind} delivery`;
      const machine = await api.createMachine(name);
      // Its tablet's machine is off, so the Machine has no hardware yet.
      const raw = await connect(machine, { machine: null }, SILENT);
      const sent = delivery();
      const database = await server.connectDatabase();
      try {
        // Holds the Machine's row, as a hello binding its hardware, or an Admin entering it, does.
        await database.query("BEGIN");
        await database.query("SELECT 1 FROM machines WHERE id = $1 FOR NO KEY UPDATE", [machine.machine.id]);
        raw.send(sent);
        await waitForLockWaits(server);
        // Then binds it. Changing the model and serial, even from NULL, takes the row FOR UPDATE, which waits for a
        // delivery that has referenced the Machine, as recording its id does.
        await database.query("UPDATE machines SET model = 'DE1Pro', serial = $2 WHERE id = $1", [machine.machine.id, serial]);
        await database.query("COMMIT");
      } finally {
        await database.end();
      }
      raw.keepAlive();
      await raw.acknowledged(sent.id);
      expect(await stored(machine)).toEqual(expected);
      expect(await api.waitForMachine(name, (viewed) => viewed.online)).toMatchObject({ model: "DE1Pro", serial });
    },
  );

  const RACES = (["a hello", "an Admin"] as const)
    .flatMap((binder) => (["delivery", "binding"] as const).flatMap((first) => KINDS.map((kind) => ({ binder, first, ...kind }))))
    .map((race, index) => ({ ...race, serial: String(40101 + index) }));

  it.each(RACES)(
    "binds the hardware and stores a $kind delivery once when $binder binding it races the delivery, the $first decided first",
    async ({ binder, first, kind, delivery, stored, expected, serial }) => {
      const name = `${kind} delivery and ${binder} binding, ${first} first`;
      const machine = await api.createMachine(name);
      const hardware = { model: "DE1Pro", serial };
      const byHello = binder === "a hello";
      const tabletId = randomUUID();
      // The tablet's machine is off, so the hello that binds comes once it is on; or it reports no serial, so an
      // Admin enters it.
      const delivering = await connect(machine, { tabletId, machine: byHello ? null : { model: "DE1Pro", serial: "0" } }, SILENT);
      // The tablet's next connection, through the other instance.
      const binding = byHello ? await RawConnection.open(other.url) : null;
      if (binding) raws.push(binding);
      const sent = delivery();
      let entered: Promise<Response> | undefined;
      const deliver = () => delivering.send(sent);
      const bind = () => {
        if (binding) binding.send(helloWith(machine.token, { tabletId, machine: hardware }));
        else entered = api.at(other.url).call("PUT", `/machines/${machine.machine.id}/hardware`, hardware);
      };
      await inOrder(machine, first === "delivery" ? [deliver, bind] : [bind, deliver]);

      if (binding) {
        expect(await binding.message(0)).toMatchObject({ type: "welcome" });
        binding.keepAlive();
        // Its own tablet's hello replaced it, perhaps before its acknowledgment was sent.
        expect((await delivering.closed).code).toBe(CLOSE_CODES.superseded);
      } else {
        expect((await entered!).status).toBe(200);
        delivering.keepAlive();
        await delivering.acknowledged(sent.id);
      }
      expect(await stored(machine)).toEqual(expected);
      expect(await api.waitForMachine(name, (viewed) => viewed.online)).toMatchObject({ ...hardware, identification: "identified" });
    },
  );
});
