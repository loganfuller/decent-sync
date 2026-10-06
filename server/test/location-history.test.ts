import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { derivedShot, shotFixture, withShots } from "./support/shot-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: Machines' Location History, and the Location each Shot is credited
// to by it, through the built plugin, raw connections and the REST API, on
// two server instances sharing one database. Shots are derived from a
// scrubbed real record, changing only their id, time and recorded hardware.
// Hardware ids are made up.

interface ShotView {
  id: string;
  machineId: string | null;
  pendingMachineId: string | null;
  machineInferred: boolean;
  locationId: string | null;
  location: LocationView | null;
  locationInferred: boolean;
  pulledAt: string | null;
  record?: Record<string, unknown>;
}

describe("Location History", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let belmont: LocationView;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    uptown = await api.createLocation("Uptown", "America/Chicago");
    belmont = await api.createLocation("Belmont", "America/Chicago");
  }, 60_000);
  afterEach(async () => {
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /** A Shot pulled at a UTC time, recording no hardware (so credited as inferred) unless given some. */
  function shotAt(id: string, pulledAt: string, hardware?: { model: string; serial: string }) {
    const { machine, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    return derivedShot(id, {
      timestamp: pulledAt,
      workflow: hardware ? { ...workflow, machine: { ...(machine as object), model: hardware.model, serialNumber: hardware.serial } } : workflow,
    });
  }
  /** The hardware a Machine's simulated tablet reports, unique to the Machine. */
  function hardwareOf(machine: CreatedMachine) {
    return { model: "DE1Pro", serial: machine.machine.id.replaceAll("-", "") };
  }
  function load(machine: CreatedMachine, shots: Record<string, unknown>[]) {
    const tablet = SimulatedTablet.load({
      settings: settingsFor(machine),
      api: withShots(derivedDe1Pro({ serial: hardwareOf(machine).serial }), shots),
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }
  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}));
    raws.push(raw);
    return raw;
  }
  function sendShot(raw: RawConnection, record: Record<string, unknown>, id = randomUUID()) {
    raw.send({ type: "shot", id, shotId: String(record.id), shot: record });
    return id;
  }
  async function detail(id: string): Promise<ShotView> {
    const response = await api.call("GET", `/shots/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { shot: ShotView }).shot;
  }
  async function waitShot(id: string): Promise<ShotView> {
    await expect.poll(async () => (await api.call("GET", `/shots/${encodeURIComponent(id)}`)).status, { timeout: 10_000 }).toBe(200);
    return detail(id);
  }
  /** Each Shot's Location by name, null when unknown. */
  async function locations(ids: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await detail(id)).location?.name ?? null])));
  }
  async function machine(id: string, at = api): Promise<MachineView> {
    const response = await at.call("GET", `/machines/${id}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { machine: MachineView }).machine;
  }
  function move(machineId: string, locationId: string, effectiveFrom?: string, at = api) {
    return at.call("POST", `/machines/${machineId}/location-history`, { locationId, effectiveFrom });
  }
  function correct(machineId: string, entryId: string, effectiveFrom: string, at = api) {
    return at.call("PATCH", `/machines/${machineId}/location-history/${entryId}`, { effectiveFrom });
  }
  function remove(machineId: string, entryId: string, at = api) {
    return at.call("DELETE", `/machines/${machineId}/location-history/${entryId}`);
  }
  /** A Machine's Location History as Location names and times. */
  function entries(machine: MachineView) {
    return machine.locationHistory.map((entry) => [entry.location.name, entry.effectiveFrom]);
  }
  async function moved(response: Response): Promise<MachineView> {
    const body = (await response.json()) as { machine: MachineView; message?: unknown };
    expect(response.status, JSON.stringify(body.message)).toBeLessThan(300);
    return body.machine;
  }
  async function problem(response: Response) {
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  }

  it("creates a machine entry at a Location from now, or unassigned, refusing a Location the server lacks", async () => {
    const before = Date.now();
    const created = await api.createMachine("Arrives at the Lab", lab.id);
    expect(created.machine.location).toEqual(lab);
    expect(created.machine.locationHistory).toEqual([{ id: expect.any(String), location: lab, effectiveFrom: expect.any(String) }]);
    const from = Date.parse(created.machine.locationHistory[0]!.effectiveFrom);
    expect(from).toBeGreaterThanOrEqual(before - 2_000);
    expect(from).toBeLessThanOrEqual(Date.now() + 2_000);
    expect((await api.machineNamed("Arrives at the Lab"))!.location).toEqual(lab);

    const unassigned = await api.createMachine("Unassigned");
    expect(unassigned.machine).toMatchObject({ location: null, locationHistory: [] });

    for (const locationId of [randomUUID(), "Lab", 7]) {
      expect(await problem(await api.call("POST", "/machines", { name: `Nowhere ${String(locationId)}`, locationId }))).toEqual({
        status: 400,
        message: ["Choose a Location from the list"],
      });
    }
    expect(await problem(await api.call("POST", "/machines", { name: " ", locationId: "Lab" }))).toEqual({
      status: 400,
      message: ["Enter a name", "Choose a Location from the list"],
    });
    expect((await api.machines()).filter((machine) => machine.name.startsWith("Nowhere"))).toEqual([]);
  });

  it("credits Shots its tablet pulls from a machine entry created at a Location, but not its earlier history", async () => {
    const created = await api.createMachine("Uptown espresso", uptown.id);
    const earlier = shotAt("before-the-entry", "2026-01-10T15:00:00Z");
    const tablet = load(created, [earlier]);
    await tablet.waitForLog(/^Connected to /);
    expect(await waitShot("before-the-entry")).toMatchObject({ location: null, locationInferred: false });

    const live = shotAt("after-the-entry", new Date().toISOString());
    tablet.serve(withShots(derivedDe1Pro({ serial: hardwareOf(created).serial }), [earlier, live]));
    tablet.fire("shotStored", { id: live.id });
    expect(await waitShot("after-the-entry")).toMatchObject({
      machineId: created.machine.id,
      location: uptown,
      locationId: uptown.id,
      locationInferred: true,
    });
  });

  it("credits Shots pulled before and after a move to where the Machine was, and re-credits them when the move's time is corrected", async () => {
    const created = await api.createMachine("Mover", lab.id);
    const id = created.machine.id;
    const first = created.machine.locationHistory[0]!.id;
    await moved(await correct(id, first, "2026-01-01T00:00:00Z"));
    const afterMove = await moved(await move(id, uptown.id, "2026-03-01T00:00:00Z", api.at(other.url)));
    expect(afterMove.location).toEqual(uptown);
    expect(afterMove.locationHistory).toEqual([
      { id: first, location: lab, effectiveFrom: "2026-01-01T00:00:00.000Z" },
      { id: expect.any(String), location: uptown, effectiveFrom: "2026-03-01T00:00:00.000Z" },
    ]);
    const moveEntry = afterMove.locationHistory[1]!.id;

    const shots = [
      shotAt("mover-december", "2025-12-15T12:00:00Z"),
      shotAt("mover-february", "2026-02-15T12:00:00Z"),
      shotAt("mover-at-the-move", "2026-03-01T00:00:00Z"),
      shotAt("mover-march", "2026-03-15T12:00:00Z", hardwareOf(created)),
    ];
    load(created, shots);
    const ids = shots.map((shot) => String(shot.id));
    for (const shot of ids) await waitShot(shot);
    expect(await locations(ids)).toEqual({ "mover-december": null, "mover-february": "Lab", "mover-at-the-move": "Uptown", "mover-march": "Uptown" });
    expect(await detail("mover-february")).toMatchObject({ location: lab, locationInferred: true });
    // Recorded hardware credits the Machine, and so its Location, without inference.
    expect(await detail("mover-march")).toMatchObject({ machineInferred: false, location: uptown, locationInferred: false });
    const records = Object.fromEntries(await Promise.all(ids.map(async (shot) => [shot, (await detail(shot)).record])));

    // It moved earlier than recorded.
    expect((await moved(await correct(id, moveEntry, "2026-02-01T00:00:00Z", api.at(other.url)))).location).toEqual(uptown);
    expect(await locations(ids)).toEqual({ "mover-december": null, "mover-february": "Uptown", "mover-at-the-move": "Uptown", "mover-march": "Uptown" });
    // Later than recorded.
    await moved(await correct(id, moveEntry, "2026-04-01T00:00:00Z"));
    expect(await locations(ids)).toEqual({ "mover-december": null, "mover-february": "Lab", "mover-at-the-move": "Lab", "mover-march": "Lab" });
    // And it was at the Lab earlier than recorded.
    await moved(await correct(id, first, "2025-12-01T00:00:00Z"));
    expect(await locations(ids)).toEqual({ "mover-december": "Lab", "mover-february": "Lab", "mover-at-the-move": "Lab", "mover-march": "Lab" });
    expect(await detail("mover-december")).toMatchObject({ machineInferred: true, location: lab, locationInferred: true });
    expect(await detail("mover-march")).toMatchObject({ machineInferred: false, location: lab, locationInferred: false });

    // Corrections change credit only, never the record as Decaid sent it.
    for (const shot of ids) expect((await detail(shot)).record).toEqual(records[shot]);
    expect((await machine(id)).locationHistory.map((entry) => [entry.location.name, entry.effectiveFrom])).toEqual([
      ["Lab", "2025-12-01T00:00:00.000Z"],
      ["Uptown", "2026-04-01T00:00:00.000Z"],
    ]);
  });

  it("keeps a backfilled Machine's earlier Shots at an unknown Location until its first entry starts earlier", async () => {
    const created = await api.createMachine("Adopted with history", belmont.id);
    const history = [
      shotAt("adopted-january", "2026-01-05T08:00:00Z"),
      shotAt("adopted-february", "2026-02-05T08:00:00Z"),
      shotAt("adopted-march", "2026-03-05T08:00:00Z"),
    ];
    const ids = history.map((shot) => String(shot.id));
    load(created, history);
    for (const shot of ids) await waitShot(shot);
    // Not silently credited to where the Machine is now, even after it moves again.
    expect(await locations(ids)).toEqual({ "adopted-january": null, "adopted-february": null, "adopted-march": null });
    const afterMove = await moved(await move(created.machine.id, lab.id));
    expect(afterMove.location).toEqual(lab);
    expect(await locations(ids)).toEqual({ "adopted-january": null, "adopted-february": null, "adopted-march": null });

    await moved(await correct(created.machine.id, afterMove.locationHistory[0]!.id, "2026-02-01T00:00:00Z", api.at(other.url)));
    expect(await locations(ids)).toEqual({ "adopted-january": null, "adopted-february": "Belmont", "adopted-march": "Belmont" });
    await moved(await correct(created.machine.id, afterMove.locationHistory[0]!.id, "2025-06-01T00:00:00-05:00"));
    expect(await locations(ids)).toEqual({ "adopted-january": "Belmont", "adopted-february": "Belmont", "adopted-march": "Belmont" });
    const listed = ((await (await api.call("GET", `/shots?limit=100&machineId=${created.machine.id}`)).json()) as { shots: ShotView[] }).shots;
    expect(listed.map((shot) => [shot.id, shot.location?.name, shot.locationInferred])).toEqual([
      ["adopted-march", "Belmont", true],
      ["adopted-february", "Belmont", true],
      ["adopted-january", "Belmont", true],
    ]);
  });

  it("gives a Pending Machine's Shots no Location, then credits them by the Location History of the Machine that takes them over", async () => {
    const reporter = await api.createMachine("Reports others' hardware", lab.id);
    await moved(await correct(reporter.machine.id, reporter.machine.locationHistory[0]!.id, "2025-01-01T00:00:00Z"));
    const adoptedHardware = { model: "DE1Pro", serial: "60001" };
    const boundHardware = { model: "DE1Pro", serial: "60002" };
    const raw = await connect(reporter);
    for (const record of [shotAt("pending-adopted", "2026-02-10T09:00:00Z", adoptedHardware), shotAt("pending-bound", "2026-02-10T09:00:00Z", boundHardware)]) {
      await raw.acknowledged(sendShot(raw, record));
    }
    // Held for hardware without a machine entry, whatever the reporting Machine's Location.
    expect(await detail("pending-adopted")).toMatchObject({ machineId: null, pendingMachineId: expect.any(String), location: null, locationInferred: false });
    expect(await detail("pending-bound")).toMatchObject({ machineId: null, location: null });

    // A machine entry created for the hardware, at a Location from now, takes the Shot over.
    const pending = (await detail("pending-adopted")).pendingMachineId!;
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pending}/machine`, { name: "Adopted pending", locationId: uptown.id }));
    expect(adopted.machine).toMatchObject({ location: uptown, locationHistory: [{ location: uptown }] });
    expect(await detail("pending-adopted")).toMatchObject({ machineId: adopted.machine.id, location: null });
    await moved(await correct(adopted.machine.id, adopted.machine.locationHistory[0]!.id, "2026-01-01T00:00:00Z"));
    expect(await detail("pending-adopted")).toMatchObject({ location: uptown, locationInferred: false });

    // A Machine whose first connection binds the hardware takes it over too, credited by its own history.
    const bound = await api.createMachine("Binds pending hardware", belmont.id);
    await moved(await correct(bound.machine.id, bound.machine.locationHistory[0]!.id, "2026-01-01T00:00:00Z", api.at(other.url)));
    await (await connect(bound, other.url, boundHardware)).close();
    expect(await detail("pending-bound")).toMatchObject({ machineId: bound.machine.id, location: belmont, locationInferred: false });
  });

  it("credits a Shot stored during a change to its Machine's Location History, on another instance, by the changed history", async () => {
    const created = await api.createMachine("Concurrent move", lab.id);
    await moved(await correct(created.machine.id, created.machine.locationHistory[0]!.id, "2026-01-01T00:00:00Z"));
    const raw = await connect(created, other.url);
    const database = await server.connectDatabase();
    let moving: Promise<Response> | undefined;
    try {
      await database.query("BEGIN");
      // Holds the Shot's storage, once it has been credited, until the move is under way.
      await database.query("LOCK TABLE shot_measurements IN ACCESS EXCLUSIVE MODE");
      const delivery = sendShot(raw, shotAt("stored-during-a-move", "2026-03-15T12:00:00Z"));
      await waitForLockWaits(server, { relation: "shot_measurements" });
      moving = move(created.machine.id, uptown.id, "2026-03-01T00:00:00Z");
      // The move waits for the Shot's storage, which holds the Machine.
      await waitForLockWaits(server, { count: 2 });
      await database.query("ROLLBACK");
      await raw.acknowledged(delivery);
    } finally {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.end();
    }
    expect((await moved(await moving!)).location).toEqual(uptown);
    expect(await detail("stored-during-a-move")).toMatchObject({ location: uptown });
  });

  it("stores an edit to a Shot while its Machine's Location History changes, on another instance, without either waiting on the other in a cycle", async () => {
    const created = await api.createMachine("Edited during a correction", lab.id);
    const first = created.machine.locationHistory[0]!.id;
    await moved(await correct(created.machine.id, first, "2026-01-01T00:00:00Z"));
    const raw = await connect(created, other.url);
    const record = shotAt("edited-during-a-correction", "2026-02-15T12:00:00Z");
    await raw.acknowledged(sendShot(raw, record));
    expect(await detail(String(record.id))).toMatchObject({ location: lab });
    const database = await server.connectDatabase();
    let correcting: Promise<Response> | undefined;
    let edit: string | undefined;
    try {
      await database.query("BEGIN");
      // Holds the correction after it has locked the Machine, before it credits the Shot again.
      await database.query("LOCK TABLE location_assignments IN ACCESS EXCLUSIVE MODE");
      // Holds the edit before it reads the Shot until the correction holds the Machine, so the edit is
      // under way first: a connection's frames are handled in turn, and a heartbeat handled while the
      // correction holds the Machine waits for it. Rolling back to the savepoint releases this lock alone.
      await database.query("SAVEPOINT edit");
      await database.query("LOCK TABLE shots IN ACCESS EXCLUSIVE MODE");
      const { measurements: omitted, ...summary } = record;
      edit = randomUUID();
      raw.send({ type: "shotUpdated", id: edit, shotId: record.id, shot: { ...summary, updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 64 } } });
      await waitForLockWaits(server, { relation: "shots" });
      correcting = api.call("PATCH", `/machines/${created.machine.id}/location-history/${first}`, { locationId: uptown.id });
      await waitForLockWaits(server, { relation: "location_assignments" });
      await database.query("ROLLBACK TO SAVEPOINT edit");
      // While the correction holds the Machine, the edit writes the Shot twice, checking its Machine's
      // key the second time: it is stored without waiting for the correction, which then waits for it.
      await raw.acknowledged(edit);
      await database.query("ROLLBACK");
    } finally {
      await database.query("ROLLBACK").catch(() => undefined);
      await database.end();
    }
    expect((await moved(await correcting!)).location).toEqual(uptown);
    expect(await detail(String(record.id))).toMatchObject({ enjoyment: 64, location: uptown });
  });

  it("keeps a Shot's pull time, and so its Location, when a newer full record arrives", async () => {
    const created = await api.createMachine("Pulled once", lab.id);
    await moved(await correct(created.machine.id, created.machine.locationHistory[0]!.id, "2026-01-01T00:00:00Z"));
    await moved(await move(created.machine.id, uptown.id, "2026-03-01T00:00:00Z"));
    const raw = await connect(created);
    const record = shotAt("pulled-once", "2026-02-15T12:00:00Z");
    await raw.acknowledged(sendShot(raw, record));
    // Derived: the same Shot, edited, as a full record whose time reads differently.
    await raw.acknowledged(sendShot(raw, { ...record, timestamp: "2026-04-15T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 71 } }));
    expect(await detail("pulled-once")).toMatchObject({ enjoyment: 71, pulledAt: "2026-02-15T12:00:00.000Z", location: lab });
  });

  it("removes a mistaken entry, and the move back too when the Machine never left, re-crediting its Shots", async () => {
    const created = await api.createMachine("Mistaken moves", lab.id);
    const id = created.machine.id;
    await moved(await correct(id, created.machine.locationHistory[0]!.id, "2026-01-01T00:00:00Z"));
    await moved(await move(id, uptown.id, "2026-02-01T00:00:00Z"));
    await moved(await move(id, lab.id, "2026-03-01T00:00:00Z"));
    const recorded = await moved(await move(id, belmont.id, "2026-04-01T00:00:00Z", api.at(other.url)));
    const [first, toUptown, , toBelmont] = recorded.locationHistory.map((entry) => entry.id);
    const raw = await connect(created, other.url);
    const shots = ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"].map((day) => shotAt(`mistaken-${day}`, `${day}T12:00:00Z`));
    for (const shot of shots) await raw.acknowledged(sendShot(raw, shot));
    const ids = shots.map((shot) => String(shot.id));
    expect(Object.values(await locations(ids))).toEqual(["Lab", "Uptown", "Lab", "Belmont"]);

    // It never went to Uptown, so it never came back to the Lab either.
    const withoutUptown = await moved(await remove(id, toUptown!));
    expect(entries(withoutUptown)).toEqual([
      ["Lab", "2026-01-01T00:00:00.000Z"],
      ["Belmont", "2026-04-01T00:00:00.000Z"],
    ]);
    expect(Object.values(await locations(ids))).toEqual(["Lab", "Lab", "Lab", "Belmont"]);

    // Nor to Belmont: it is still at the Lab.
    const withoutBelmont = await moved(await remove(id, toBelmont!, api.at(other.url)));
    expect(withoutBelmont.location).toEqual(lab);
    expect(entries(withoutBelmont)).toEqual([["Lab", "2026-01-01T00:00:00.000Z"]]);
    expect(Object.values(await locations(ids))).toEqual(["Lab", "Lab", "Lab", "Lab"]);

    // And the machine entry was never at the Lab: where it was is unknown.
    const unassigned = await moved(await remove(id, first!));
    expect(unassigned).toMatchObject({ location: null, locationHistory: [] });
    expect(Object.values(await locations(ids))).toEqual([null, null, null, null]);
    expect(await detail(ids[0]!)).toMatchObject({ machineId: id, locationInferred: false });
  });

  it("corrects the Location an entry names, keeping its time unless that is corrected too, and re-credits Shots", async () => {
    const created = await api.createMachine("Wrong Location", lab.id);
    const id = created.machine.id;
    const first = created.machine.locationHistory[0]!.id;
    const raw = await connect(created);
    for (const shot of [shotAt("wrong-january", "2026-01-15T12:00:00Z"), shotAt("wrong-february", "2026-02-15T12:00:00Z")]) {
      await raw.acknowledged(sendShot(raw, shot));
    }
    expect(await locations(["wrong-january", "wrong-february"])).toEqual({ "wrong-january": null, "wrong-february": null });

    // It was created at the wrong Location, and was there earlier than that.
    const corrected = await moved(await api.call("PATCH", `/machines/${id}/location-history/${first}`, { locationId: uptown.id, effectiveFrom: "2026-01-01T00:00:00Z" }));
    expect(entries(corrected)).toEqual([["Uptown", "2026-01-01T00:00:00.000Z"]]);
    expect(await locations(["wrong-january", "wrong-february"])).toEqual({ "wrong-january": "Uptown", "wrong-february": "Uptown" });

    // A move to the wrong Location keeps its time when only the Location is corrected.
    const toBelmont = (await moved(await move(id, belmont.id, "2026-02-01T00:00:00Z"))).locationHistory[1]!.id;
    const toLab = await moved(await api.at(other.url).call("PATCH", `/machines/${id}/location-history/${toBelmont}`, { locationId: lab.id }));
    expect(toLab.location).toEqual(lab);
    expect(entries(toLab)).toEqual([
      ["Uptown", "2026-01-01T00:00:00.000Z"],
      ["Lab", "2026-02-01T00:00:00.000Z"],
    ]);
    expect(await locations(["wrong-january", "wrong-february"])).toEqual({ "wrong-january": "Uptown", "wrong-february": "Lab" });
  });

  it("refuses moves and corrections that would not make a Location History", async () => {
    const created = await api.createMachine("Checked", uptown.id);
    const id = created.machine.id;
    const first = created.machine.locationHistory[0]!.id;
    const unassigned = await api.createMachine("Checked unassigned");

    expect(await problem(await move(id, uptown.id))).toEqual({ status: 409, message: "It is already at Uptown" });
    expect(await problem(await move(id, randomUUID()))).toEqual({ status: 400, message: ["Choose a Location from the list"] });
    expect(await problem(await api.call("POST", `/machines/${id}/location-history`, {}))).toEqual({ status: 400, message: ["Choose a Location from the list"] });
    expect(await problem(await move(id, lab.id, "2026-13-01T00:00:00Z"))).toEqual({
      status: 400,
      message: ["Enter a date and time with its offset, such as 2026-10-04T15:00:00Z"],
    });
    // Times without an offset, and dates and times that do not exist, which Date would roll over.
    for (const time of ["2026-01-01T00:00:00", "2026-02-30T15:00:00Z", "2026-02-29T15:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T12:00:00+24:00"]) {
      expect(await problem(await move(id, lab.id, time)), time).toEqual({
        status: 400,
        message: ["Enter a date and time with its offset, such as 2026-10-04T15:00:00Z"],
      });
    }
    expect(await problem(await move(id, lab.id, new Date(Date.now() + 3_600_000).toISOString()))).toEqual({
      status: 400,
      message: ["Choose a time that is not in the future"],
    });
    expect(await problem(await move(id, lab.id, "2026-01-01T00:00:00Z"))).toEqual({ status: 409, message: "Choose a time after it arrived at Uptown" });
    expect((await problem(await move(randomUUID(), lab.id))).status).toBe(404);
    expect((await problem(await move("not-a-machine", lab.id))).status).toBe(404);

    await moved(await correct(id, first, "2026-01-01T00:00:00Z"));
    const second = (await moved(await move(id, lab.id, "2026-02-01T00:00:00Z"))).locationHistory[1]!.id;
    const third = (await moved(await move(id, belmont.id, "2026-03-01T00:00:00Z"))).locationHistory[2]!.id;
    expect(await problem(await correct(id, second, "2026-01-01T00:00:00Z"))).toEqual({ status: 409, message: "Choose a time after it arrived at Uptown" });
    expect(await problem(await correct(id, second, "2026-03-01T00:00:00Z"))).toEqual({ status: 409, message: "Choose a time before it moved to Belmont" });
    expect(await problem(await correct(id, third, new Date(Date.now() + 3_600_000).toISOString()))).toEqual({
      status: 400,
      message: ["Choose a time that is not in the future"],
    });
    expect(await problem(await correct(id, first, "yesterday"))).toEqual({
      status: 400,
      message: ["Enter a date and time with its offset, such as 2026-10-04T15:00:00Z"],
    });
    const patch = (entry: string, body: unknown) => api.call("PATCH", `/machines/${id}/location-history/${entry}`, body);
    expect(await problem(await patch(second, {}))).toEqual({ status: 400, message: "Send a new Location or time" });
    expect(await problem(await patch(second, { locationId: randomUUID() }))).toEqual({ status: 400, message: ["Choose a Location from the list"] });
    expect(await problem(await patch(second, { locationId: "Lab", effectiveFrom: "soon" }))).toEqual({
      status: 400,
      message: ["Choose a Location from the list", "Enter a date and time with its offset, such as 2026-10-04T15:00:00Z"],
    });
    expect(await problem(await patch(second, { locationId: uptown.id }))).toEqual({
      status: 409,
      message: "It was already at Uptown before this; remove this entry instead",
    });
    expect(await problem(await patch(second, { locationId: belmont.id }))).toEqual({
      status: 409,
      message: "It moved to Belmont after this; choose another Location, or remove that entry",
    });
    // An entry belongs to its own Machine.
    expect((await problem(await correct(unassigned.machine.id, first, "2025-01-01T00:00:00Z"))).status).toBe(404);
    expect((await problem(await remove(unassigned.machine.id, first))).status).toBe(404);
    expect((await problem(await remove(id, randomUUID()))).status).toBe(404);
    expect((await problem(await remove(id, "not-an-entry"))).status).toBe(404);
    expect((await problem(await remove(randomUUID(), first))).status).toBe(404);
    expect((await problem(await correct(id, randomUUID(), "2025-01-01T00:00:00Z"))).status).toBe(404);
    expect((await problem(await correct(id, "not-an-entry", "2025-01-01T00:00:00Z"))).status).toBe(404);

    expect((await machine(id)).locationHistory.map((entry) => [entry.location.name, entry.effectiveFrom])).toEqual([
      ["Uptown", "2026-01-01T00:00:00.000Z"],
      ["Lab", "2026-02-01T00:00:00.000Z"],
      ["Belmont", "2026-03-01T00:00:00.000Z"],
    ]);
  });
});
