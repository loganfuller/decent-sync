import { setTimeout as delay } from "node:timers/promises";
import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1, the REST API and the assistant tools for ticket #704 (ADR-0037): a
// Bean Batch is at one Location at a time. Adding it at a Location, over
// REST, through an assistant tool, by un-archiving its record on a tablet
// there, or by a Recipe there naming it, moves it there: it is finished
// wherever else it is, the weight entered for it goes with it, the tablets
// at the Location left archive their record and those at the Location joined
// hold it un-archived, and its history keeps one entry naming both
// Locations. Through the built plugin in simulated tablets, on two server
// instances sharing PostgreSQL. Serials are made up, from 70401.

type Record_ = Record<string, unknown>;

interface BatchView {
  id: string;
  locations: { location: LocationView; remainingWeight: number | null; since: string }[];
  finished: { location: LocationView }[];
  movedFrom: LocationView[];
}

interface Version {
  id: string;
  fields: Record_;
  location: LocationView | null;
  movedFrom: LocationView[];
  settled: boolean;
  source: { machine: { id: string } | null; account: { id: string } | null; connectedApp: { id: string } | null };
}

interface History {
  versions: Version[];
  lostEdits: { field: string; value: unknown; location: LocationView | null; source: { machine: { id: string } | null }; lostTo: { versionId: string; value: unknown } | null }[];
}

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Bean Batch at one Location at a time", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  const opened: Assistant[] = [];
  let serial = 70_401;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    opened.push(assistant);
  });
  afterAll(async () => {
    for (const each of opened) await each.close();
    await app?.close();
    await server?.stop();
  });

  /** A Location with a Machine for each instance named, its tablet online there with its Decaid's Library empty. */
  async function locationWith(name: string, instances: TestServer[]): Promise<{ location: LocationView; machines: CreatedMachine[]; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const machines: CreatedMachine[] = [];
    const tablets: SimulatedTablet[] = [];
    for (const [index, instance] of instances.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      tablets.push(syncingTablet(machine, instance, { api: emptyLibrary(String(serial++)) }));
      await api.waitForOnline(machine);
      machines.push(machine);
    }
    return { location, machines, tablets };
  }

  /** A batch of a new Bean, created at the Location. */
  async function batchAt(name: string, location: LocationView, remainingWeight?: number): Promise<BatchView> {
    const { bean } = await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, 201);
    return (await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId: bean.id, content: { roastDate: "2026-11-18" }, locations: [{ locationId: location.id, ...(remainingWeight === undefined ? {} : { remainingWeight }) }] }, 201)).batch;
  }

  const batch = async (id: string, as = api) => (await as.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const at = async (id: string) => (await batch(id)).locations.map((here) => here.location.name);
  const history = (id: string, as = api) => as.get<History>(`/bean-batches/${id}/history`);
  const place = (id: string, location: LocationView, body: Record_, as = api) => as.call("PUT", `/bean-batches/${id}/locations/${location.id}`, body);
  const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);

  /** The weight entered for the batch at each Location by name, and when, as stored. */
  async function entered(id: string): Promise<Record<string, { weight: number | null; at: string | null }>> {
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query<{ name: string; weight: number | null; at: Date | null }>(
        `SELECT location.name, here.remaining_weight AS weight, here.remaining_weight_at AS at
         FROM batch_locations AS here JOIN locations AS location ON location.id = here.location_id WHERE here.batch_id = $1`,
        [id],
      );
      return Object.fromEntries(rows.map((row) => [row.name, { weight: row.weight, at: row.at?.toISOString() ?? null }]));
    } finally {
      await database.end();
    }
  }

  /** A Staff member working at the Locations, with their REST API and an assistant connected as them. */
  async function staff(email: string, ...locations: LocationView[]): Promise<{ api: AdminApi; assistant: Assistant }> {
    const { link } = await api.invite(email, "staff", locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: "Staff", password: "a password for staff" });
    const theirs = await Assistant.connect(server.url, app, cookie);
    opened.push(theirs);
    return { api: AdminApi.signedInAs(server.url, cookie), assistant: theirs };
  }

  async function toolError(by: Assistant, name: string, args: Record_): Promise<string> {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  async function restRefusal(as: AdminApi, method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await as.call(method, path, body);
    expect(response.status, path).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }

  it("moves a batch added at a second Location over REST, with its weight, to that Location's tablets and off those it left, as one history entry", async () => {
    const lab = await locationWith("Moves lab", [server]);
    const cafe = await locationWith("Moves cafe", [server, other]);
    const created = await batchAt("Moved Guji", lab.location, 900);
    await expect.poll(() => held(lab.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 900 });
    const before = await history(created.id);
    const weighed = (await entered(created.id))["Moves lab"]!;
    expect(weighed.weight).toBe(900);

    const moved = await place(created.id, cafe.location, { atLocation: true });
    expect(moved.status).toBe(200);
    const view = ((await moved.json()) as { batch: BatchView }).batch;
    expect(view.locations).toMatchObject([{ location: { id: cafe.location.id }, remainingWeight: 900 }]);
    expect(view.finished.map((here) => here.location.name)).toEqual(["Moves lab"]);
    expect(view.movedFrom.map((left) => left.name)).toEqual(["Moves lab"]);
    // The weight is the one entered before the move, when it was entered.
    expect((await entered(created.id))["Moves cafe"]).toEqual(weighed);

    for (const tablet of cafe.tablets) await expect.poll(() => held(tablet, created.id)).toMatchObject({ archived: false, weightRemaining: 900 });
    await expect.poll(() => held(lab.tablets[0]!, created.id)?.archived).toBe(true);

    // One entry, of the Location joined, naming the one left.
    const after = await history(created.id);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions[0]).toMatchObject({ fields: { atLocation: true }, location: { id: cafe.location.id }, movedFrom: [{ id: lab.location.id }], settled: false });
    expect(after.versions[0]!.source.account).not.toBeNull();
    expect(after.lostEdits).toEqual([]);

    // A move that gives a weight enters it, later, over the one that came with the batch.
    const back = await place(created.id, lab.location, { atLocation: true, remainingWeight: 640 });
    expect(((await back.json()) as { batch: BatchView }).batch.locations).toMatchObject([{ location: { id: lab.location.id }, remainingWeight: 640 }]);
    const reweighed = (await entered(created.id))["Moves lab"]!;
    expect(reweighed.weight).toBe(640);
    expect(Date.parse(reweighed.at!)).toBeGreaterThan(Date.parse(weighed.at!));
    await expect.poll(() => held(lab.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 640 });
    for (const tablet of cafe.tablets) await expect.poll(() => held(tablet, created.id)?.archived).toBe(true);

    // Finished there and then added at the cafe, it is no move, and takes the weight it had where it was last: the lab,
    // where it arrived last, even where the cafe's finish is timed later, as by a tablet whose clock runs ahead, and is
    // finished again after the lab's, as by a tablet's archive delivered late.
    const database = await server.connectDatabase();
    try {
      await database.query(`UPDATE batch_locations SET finished_at = now() + interval '1 hour' WHERE batch_id = $1 AND location_id = $2`, [created.id, cafe.location.id]);
    } finally {
      await database.end();
    }
    expect((await place(created.id, lab.location, { atLocation: false })).status).toBe(200);
    expect((await place(created.id, cafe.location, { atLocation: false })).status).toBe(200);
    expect(await at(created.id)).toEqual([]);
    expect((await place(created.id, cafe.location, { atLocation: true })).status).toBe(200);
    expect(await batch(created.id)).toMatchObject({ locations: [{ location: { id: cafe.location.id }, remainingWeight: 640 }], movedFrom: [] });
    expect((await entered(created.id))["Moves cafe"]).toEqual(reweighed);
    expect((await place(created.id, lab.location, { atLocation: true })).status).toBe(200);

    // Added again where it is, it moves nowhere.
    expect((await place(created.id, lab.location, { atLocation: true })).status).toBe(200);
    expect(await at(created.id)).toEqual(["Moves lab"]);
    expect((await history(created.id)).versions[0]).toMatchObject({ fields: { atLocation: true }, location: { id: lab.location.id }, movedFrom: [] });
  });

  it("moves a batch through an assistant's tool, and one a Recipe at another Location is set to use", async () => {
    const lab = await locationWith("Tool lab", [server]);
    const cafe = await locationWith("Tool cafe", [other]);
    const created = await batchAt("Tool Guji", lab.location, 500);
    await expect.poll(() => held(lab.tablets[0]!, created.id)?.archived).toBe(false);

    const moved = await assistant.call<{ beanBatch: { locations: { location: { id: string }; remainingWeight: number | null }[]; movedFrom: { id: string }[] } }>("set_location_offering", {
      kind: "beanBatch",
      id: created.id,
      locationId: cafe.location.id,
      offered: true,
    });
    expect(moved.beanBatch.locations).toMatchObject([{ location: { id: cafe.location.id }, remainingWeight: 500 }]);
    expect(moved.beanBatch.movedFrom).toMatchObject([{ id: lab.location.id }]);
    expect(await at(created.id)).toEqual(["Tool cafe"]);
    await expect.poll(() => held(cafe.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 500 });
    await expect.poll(() => held(lab.tablets[0]!, created.id)?.archived).toBe(true);
    // The assistant reads the move as the management interface does: one entry, through the Connected App.
    const read = await assistant.call<{ history: { entries: { fields: Record_; location: { id: string } | null; movedFrom: { id: string }[]; settled: boolean; source: { connectedApp: unknown } }[] } }>("get_library_item", {
      kind: "beanBatch",
      id: created.id,
      history: true,
    });
    expect(read.history.entries[0]).toMatchObject({ fields: { atLocation: true }, location: { id: cafe.location.id }, movedFrom: [{ id: lab.location.id }], settled: false });
    expect(read.history.entries[0]!.source.connectedApp).not.toBeNull();

    // A Recipe at the lab set to use it adds it there, which is a move as any other.
    await api.send("POST", "/recipes", { locationId: lab.location.id, slot: null, content: { name: "Tool Espresso", beanBatchId: created.id } }, 201);
    expect(await at(created.id)).toEqual(["Tool lab"]);
    expect((await history(created.id)).versions[0]).toMatchObject({ fields: { atLocation: true }, location: { id: lab.location.id }, movedFrom: [{ id: cafe.location.id }] });
    await expect.poll(() => held(cafe.tablets[0]!, created.id)?.archived).toBe(true);
    await expect.poll(() => held(lab.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 500 });
  });

  it("moves a batch to the Location of a tablet that un-archives its record, naming the Machine, and keeps an un-archive that loses on time as a Lost Edit", async () => {
    const lab = await locationWith("Tablet lab", [server]);
    const cafe = await locationWith("Tablet cafe", [other, server]);
    const created = await batchAt("Tablet Guji", lab.location, 820);
    await expect.poll(() => held(lab.tablets[0]!, created.id)?.archived).toBe(false);
    expect((await place(created.id, cafe.location, { atLocation: true })).status).toBe(200);
    await expect.poll(() => held(lab.tablets[0]!, created.id)?.archived).toBe(true);
    for (const tablet of cafe.tablets) await expect.poll(() => held(tablet, created.id)?.archived).toBe(false);

    // A barista at the lab un-archives it there.
    await lab.tablets[0]!.editBatch(held(lab.tablets[0]!, created.id)!.id, { archived: false });
    await expect.poll(() => at(created.id)).toEqual(["Tablet lab"]);
    for (const tablet of cafe.tablets) await expect.poll(() => held(tablet, created.id)?.archived).toBe(true);
    await expect.poll(() => held(lab.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 820 });
    const moved = (await history(created.id)).versions[0]!;
    expect(moved).toMatchObject({ fields: { atLocation: true }, location: { id: lab.location.id }, movedFrom: [{ id: cafe.location.id }], source: { machine: { id: lab.machines[0]!.machine.id }, account: null } });
    expect((await batch(created.id)).locations[0]!.remainingWeight).toBe(820);

    // A cafe tablet, offline, un-archives it; later, an Admin moves it to the cafe and back to the lab, which that
    // tablet's record has not seen. Its un-archive, timed before the move that took the batch from the cafe, loses.
    const [late, seeing] = cafe.tablets as [SimulatedTablet, SimulatedTablet];
    late.loseNetwork();
    await late.editBatch(held(late, created.id)!.id, { archived: false });
    await delay(20);
    expect((await place(created.id, cafe.location, { atLocation: true })).status).toBe(200);
    expect((await place(created.id, lab.location, { atLocation: true })).status).toBe(200);
    await expect.poll(() => held(seeing, created.id)?.archived).toBe(true);
    const backAtLab = (await history(created.id)).versions[0]!;
    late.restoreNetwork();
    await expect.poll(async () => (await history(created.id)).lostEdits).toMatchObject([
      { field: "atLocation", value: true, location: { id: cafe.location.id }, source: { machine: { id: cafe.machines[0]!.machine.id } }, lostTo: { versionId: backAtLab.id, value: false } },
    ]);
    expect(await at(created.id)).toEqual(["Tablet lab"]);
    await expect.poll(() => held(late, created.id)?.archived).toBe(true);
    expect(held(lab.tablets[0]!, created.id)?.archived).toBe(false);
  });

  it("lets Staff move a batch to a Location they work at from one they do not, and refuses them moving one away to another's or finishing one there, over REST and through a tool", async () => {
    const theirs = await api.createLocation("Scope home", "America/Chicago");
    const elsewhere = await api.createLocation("Scope elsewhere", "America/Chicago");
    const person = await staff("staff-704@example.com", theirs);
    const moved = await batchAt("Scope Guji", elsewhere, 300);
    const stays = await batchAt("Scope Sidamo", elsewhere);

    // To theirs, from outside their scope: over REST, and through their assistant.
    expect((await place(moved.id, theirs, { atLocation: true }, person.api)).status).toBe(200);
    expect(await at(moved.id)).toEqual(["Scope home"]);
    expect((await batch(moved.id)).locations[0]!.remainingWeight).toBe(300);
    await person.assistant.call("set_location_offering", { kind: "beanBatch", id: stays.id, locationId: theirs.id, offered: true });
    expect(await at(stays.id)).toEqual(["Scope home"]);
    // And they finish one where they work.
    expect((await place(stays.id, theirs, { atLocation: false }, person.api)).status).toBe(200);
    expect(await at(stays.id)).toEqual([]);

    // Not to a Location outside it, from theirs or from nowhere.
    for (const id of [moved.id, stays.id]) {
      expect(await toolError(person.assistant, "set_location_offering", { kind: "beanBatch", id, locationId: elsewhere.id, offered: true })).toBe(
        await restRefusal(person.api, "PUT", `/bean-batches/${id}/locations/${elsewhere.id}`, { atLocation: true }, 403),
      );
    }
    expect(await at(moved.id)).toEqual(["Scope home"]);
    // Nor finishing one where they do not work, which is no move.
    expect((await place(moved.id, elsewhere, { atLocation: true })).status).toBe(200);
    expect(await toolError(person.assistant, "set_location_offering", { kind: "beanBatch", id: moved.id, locationId: elsewhere.id, offered: false })).toBe(
      await restRefusal(person.api, "PUT", `/bean-batches/${moved.id}/locations/${elsewhere.id}`, { atLocation: false }, 403),
    );
    expect(await at(moved.id)).toEqual(["Scope elsewhere"]);
    // An Admin does either anywhere.
    expect((await place(moved.id, elsewhere, { atLocation: false })).status).toBe(200);
    expect(await at(moved.id)).toEqual([]);
  });

  it("refuses creating a batch at two Locations, or at none, as a bad request, over REST and through the tool", async () => {
    const one = await api.createLocation("Create one", "America/Chicago");
    const two = await api.createLocation("Create two", "America/Chicago");
    const { bean } = await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Created Once" } }, 201);
    for (const locations of [[{ locationId: one.id }, { locationId: two.id }], [{ locationId: one.id }, { locationId: one.id }], []]) {
      const refusal = await restRefusal(api, "POST", "/bean-batches", { beanId: bean.id, locations }, 400);
      expect(refusal).toContain("exactly one Location");
      expect(await toolError(assistant, "create_bean_batch", { beanId: bean.id, locations })).toBe(refusal);
    }
    expect(await restRefusal(api, "POST", "/bean-batches", { beanId: bean.id }, 400)).toContain("exactly one Location");
    expect((await api.get<{ batches: { bean: { id: string } }[] }>("/bean-batches")).batches.filter((listed) => listed.bean.id === bean.id)).toEqual([]);
    const made = await assistant.call<{ beanBatch: { locations: { location: { id: string } }[] } }>("create_bean_batch", { beanId: bean.id, locations: [{ locationId: two.id }] });
    expect(made.beanBatch.locations).toMatchObject([{ location: { id: two.id } }]);
  });

  it("leaves a batch moved to two Locations at once, through two instances, at exactly one", async () => {
    const places = [await api.createLocation("Race A", "America/Chicago"), await api.createLocation("Race B", "America/Chicago"), await api.createLocation("Race C", "America/Chicago")] as const;
    const created = await batchAt("Raced Guji", places[0], 410);
    const elsewhere = api.at(other.url);
    for (let round = 0; round < 6; round += 1) {
      // From one Location on even rounds; from none on odd ones, where no Location's lock is shared.
      if (round % 2 === 1) for (const here of (await batch(created.id)).locations) expect((await place(created.id, here.location, { atLocation: false })).status).toBe(200);
      const [first, second] = [places[(round + 1) % 3]!, places[(round + 2) % 3]!];
      const answers = await Promise.all([place(created.id, first, { atLocation: true }), place(created.id, second, { atLocation: true }, elsewhere)]);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
      const now = await batch(created.id);
      expect(now.locations, `round ${round}`).toHaveLength(1);
      expect([first.id, second.id]).toContain(now.locations[0]!.location.id);
    }
  });

  it("moves a batch again where it finds it reached a Location after its locks were taken, whose lock is held, once that Location is free", async () => {
    const [from, to, reached] = [await api.createLocation("Busy from", "America/Chicago"), await api.createLocation("Busy to", "America/Chicago"), await api.createLocation("Busy reached", "America/Chicago")];
    const created = await batchAt("Busy Guji", from, 520);
    const before = await history(created.id);
    const [holder, reachedHolder, watcher] = [await server.connectDatabase(), await server.connectDatabase(), await server.connectDatabase()];
    /** Whether a change waits for an advisory lock in the namespace, in this test's database. */
    const waitingOn = async (namespace: number) =>
      (
        await watcher.query<{ waiting: number }>(
          `SELECT count(*)::integer AS waiting FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted AND classid = $1 AND objsubid = 2 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
          [namespace],
        )
      ).rows[0]!.waiting > 0;
    try {
      // The batch's lock held, the move waits for it with the Locations' it read taken; the reached Location's held too.
      await holder.query(`SELECT pg_advisory_lock(4000012, hashtext(lower($1::text)))`, [created.id]);
      await reachedHolder.query(`SELECT pg_advisory_lock(4000007, hashtext($1::text))`, [reached.id]);
      const moving = place(created.id, to, { atLocation: true });
      await expect.poll(() => waitingOn(4_000_012)).toBe(true);
      // Meanwhile it is added at another Location, as the previous release adds one, taking no batch's lock.
      await holder.query(`INSERT INTO batch_locations (batch_id, location_id, added_at, presence_decided_at) VALUES ($1, $2, now(), clock_timestamp())`, [created.id, reached.id]);
      await holder.query(`SELECT pg_advisory_unlock(4000012, hashtext(lower($1::text)))`, [created.id]);
      // The move finds it there, busy, and is made again, which waits for that Location's lock in order.
      await expect.poll(() => waitingOn(4_000_007)).toBe(true);
      await reachedHolder.query(`SELECT pg_advisory_unlock(4000007, hashtext($1::text))`, [reached.id]);
      expect((await moving).status).toBe(200);
    } finally {
      for (const client of [holder, reachedHolder, watcher]) await client.end();
    }
    const after = await batch(created.id);
    // From two, it comes with the weight of the one it was added at last, where none was entered.
    expect(after.locations).toMatchObject([{ location: { id: to.id }, remainingWeight: null }]);
    expect(after.finished.map((here) => here.location.name).sort()).toEqual(["Busy from", "Busy reached"]);
    // One entry, of the move made again; the first try left nothing.
    const moved = await history(created.id);
    expect(moved.versions).toHaveLength(before.versions.length + 1);
    expect(moved.versions[0]).toMatchObject({ location: { id: to.id }, movedFrom: [{ id: reached.id }, { id: from.id }] });
  });

  it("moves a batch the previous release left at two Locations, added at both at once, with the weight of the one reads name first", async () => {
    const [first, second, third] = [await api.createLocation("Tied first", "America/Chicago"), await api.createLocation("Tied second", "America/Chicago"), await api.createLocation("Tied third", "America/Chicago")];
    const created = await batchAt("Tied Guji", first, 100);
    expect((await place(created.id, second, { atLocation: true, remainingWeight: 200 })).status).toBe(200);
    const database = await server.connectDatabase();
    try {
      await database.query(`UPDATE batch_locations SET finished_at = NULL, added_at = '2026-11-25T12:00:00Z' WHERE batch_id = $1`, [created.id]);
    } finally {
      await database.end();
    }
    const [named] = (await batch(created.id)).locations;
    expect((await place(created.id, third, { atLocation: true })).status).toBe(200);
    expect((await batch(created.id)).locations).toMatchObject([{ location: { id: third.id }, remainingWeight: named!.remainingWeight }]);
  });

  it("settles a batch found at several Locations at the one it was added at last, as an instance starts, without a request failing meanwhile", async () => {
    const first = await locationWith("Settle first", [server]);
    const last = await locationWith("Settle last", [other]);
    const created = await batchAt("Settled Guji", first.location, 730);
    await expect.poll(() => held(first.tablets[0]!, created.id)?.archived).toBe(false);
    expect((await place(created.id, last.location, { atLocation: true, remainingWeight: 210 })).status).toBe(200);
    await expect.poll(() => held(first.tablets[0]!, created.id)?.archived).toBe(true);
    await expect.poll(() => held(last.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 210 });
    const before = await history(created.id);

    // As the previous release leaves a batch it adds at a second Location: at both.
    const database = await server.connectDatabase();
    try {
      await database.query(`UPDATE batch_locations SET finished_at = NULL WHERE batch_id = $1`, [created.id]);
      await database.query(`NOTIFY library_changes, '${first.location.id}'`);
    } finally {
      await database.end();
    }
    // Read meanwhile, it is at both, the one it was added at last first, and every route answers.
    expect(await at(created.id)).toEqual(["Settle last", "Settle first"]);
    expect((await api.call("GET", "/bean-batches")).status).toBe(200);
    expect((await api.call("GET", `/bean-batches/${created.id}/history`)).status).toBe(200);
    await assistant.call("get_library_item", { kind: "beanBatch", id: created.id });
    await expect.poll(() => held(first.tablets[0]!, created.id)?.archived).toBe(false);

    const starting = await startTestServer({ env, sharing: server });
    await expect.poll(() => at(created.id), { timeout: 15_000 }).toEqual(["Settle last"]);
    await starting.stop();
    const after = await history(created.id);
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions[0]).toMatchObject({
      fields: { atLocation: true },
      location: { id: last.location.id },
      movedFrom: [{ id: first.location.id }],
      settled: true,
      source: { machine: null, account: null, connectedApp: null },
    });
    // It keeps the weight entered where it stays.
    expect(await batch(created.id)).toMatchObject({ locations: [{ remainingWeight: 210 }] });
    await expect.poll(() => held(first.tablets[0]!, created.id)?.archived).toBe(true);
    expect(held(last.tablets[0]!, created.id)).toMatchObject({ archived: false, weightRemaining: 210 });
  });
});
