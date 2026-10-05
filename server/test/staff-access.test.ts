import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView, acceptInvite } from "./support/admin-api.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { derivedSteam } from "./support/steam-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// What Staff see and do through the REST API. Machine information is not
// private: Staff read every Machine as an Admin does. They are listed the
// Locations they work at, and change only one thing: moving a Machine from
// one of those Locations to another. Shots and Steam Records stay Admin-only
// until #17 and #18. Data is seeded with raw connections; the Shot and Steam
// Record are derived from scrubbed real records, changing only their ids,
// times and recorded hardware. Hardware ids are made up.

interface Sent {
  type: string;
  id?: string;
}

describe("Staff access", () => {
  let server: TestServer;
  let api: AdminApi;
  /** Sam, Staff at Uptown and Belmont. */
  let staff: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let belmont: LocationView;
  let lab1: CreatedMachine;
  let uptown1: CreatedMachine;
  let belmont1: CreatedMachine;
  let spare: CreatedMachine;
  const raws: RawConnection[] = [];
  const timers: NodeJS.Timeout[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    uptown = await api.createLocation("Uptown", "America/Chicago");
    belmont = await api.createLocation("Belmont", "America/Chicago");
    lab1 = await api.createMachine("Lab 1", lab.id);
    uptown1 = await api.createMachine("Uptown 1", uptown.id);
    belmont1 = await api.createMachine("Belmont 1", belmont.id);
    spare = await api.createMachine("Spare");
    const { link } = await api.invite("sam@example.com", "staff", [uptown.id, belmont.id]);
    staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Sam Staff", password: "staff password 1" }));
  }, 60_000);
  afterEach(async () => {
    timers.splice(0).forEach(clearInterval);
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(() => server?.stop());

  const names = (machines: MachineView[]) => machines.map((machine) => machine.name);
  /** A GET's status and body, without the times a connection's heartbeats keep changing. */
  async function read(as: AdminApi, path: string): Promise<[number, unknown]> {
    const response = await as.call("GET", path);
    return [response.status, JSON.parse(await response.text(), (key, value) => (key === "lastSeenAt" || key === "online" ? undefined : value))];
  }
  async function machine(as: AdminApi, created: CreatedMachine): Promise<MachineView> {
    const response = await as.call("GET", `/machines/${created.machine.id}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { machine: MachineView }).machine;
  }
  async function refused(response: Response, status: number, message: string) {
    expect(response.status).toBe(status);
    expect(((await response.json()) as { message: unknown }).message).toBe(message);
  }
  function move(as: AdminApi, created: CreatedMachine, body: Record<string, unknown>) {
    return as.call("POST", `/machines/${created.machine.id}/location-history`, body);
  }
  async function connect(created: CreatedMachine, hardware: { model: string; serial: string }) {
    const raw = await RawConnection.open(server.url);
    raws.push(raw);
    raw.send(helloWith(created.token, { machine: hardware }));
    expect(await raw.message(0)).toMatchObject({ type: "welcome" });
    timers.push(setInterval(() => raw.send({ type: "heartbeat" }), 300));
    return raw;
  }
  async function acknowledged(raw: RawConnection, id: string) {
    await expect.poll(() => raw.messages.some((message) => (message as Sent).type === "ack" && (message as Sent).id === id)).toBe(true);
  }

  it("lists Staff only the Locations they work at", async () => {
    expect(await (await staff.call("GET", "/locations")).json()).toEqual({ locations: [belmont, uptown] });
  });

  it("refuses Staff every Admin-only endpoint, even for their own Locations' Machines", async () => {
    const id = uptown1.machine.id;
    const entry = uptown1.machine.locationHistory[0]!.id;
    const pendingId = randomUUID();
    const adminOnly: [string, string, unknown?][] = [
      ["POST", "/invites", { email: "friend@example.com", role: "staff", locationIds: [uptown.id] }],
      ["POST", "/locations", { name: "Elsewhere", timeZone: "America/Chicago" }],
      ["PATCH", `/locations/${uptown.id}`, { name: "Downtown" }],
      ["GET", "/time-zones"],
      ["POST", "/machines", { name: "Uptown 2", locationId: uptown.id }],
      ["POST", `/machines/${id}/token`],
      ["PUT", `/machines/${id}/hardware`, { model: "DE1Pro", serial: "10099" }],
      ["PATCH", `/machines/${id}/location-history/${entry}`, { effectiveFrom: "2026-01-01T00:00:00Z" }],
      ["DELETE", `/machines/${id}/location-history/${entry}`],
      ["POST", `/pending-machines/${pendingId}/machine`, { name: "Adopted" }],
      ["POST", `/pending-machines/${pendingId}/dismiss`],
    ];
    for (const [method, path, body] of adminOnly) {
      await refused(await staff.call(method, path, body), 403, "Only an Admin can do this");
    }

    // None of them changed anything.
    expect(((await (await api.call("GET", "/locations")).json()) as { locations: LocationView[] }).locations).toEqual([belmont, lab, uptown]);
    expect(names(await api.machines())).toEqual(["Belmont 1", "Lab 1", "Spare", "Uptown 1"]);
    expect((await machine(api, uptown1)).locationHistory).toEqual(uptown1.machine.locationHistory);
    expect((await connect(uptown1, { model: "DE1Pro", serial: "10001" })).messages[0]).toMatchObject({ type: "welcome" });
  });

  it("refuses Staff Shots and Steam Records, even at their Locations", async () => {
    // Uptown 1's tablet sends a Shot recorded on its hardware and a Steam Record.
    const raw = await connect(uptown1, { model: "DE1Pro", serial: "10001" });
    const { machine: recorded, ...workflow } = shotFixture().workflow as Record<string, unknown>;
    const shot = derivedShot("staff-shot", {
      timestamp: "2026-03-15T12:00:00Z",
      workflow: { ...workflow, machine: { ...(recorded as object), model: "DE1Pro", serialNumber: "10001" } },
    });
    const steam = derivedSteam("staff-steam");
    const shotDelivery = randomUUID();
    raw.send({ type: "shot", id: shotDelivery, shotId: shot.id, shot });
    await acknowledged(raw, shotDelivery);
    const steamDelivery = randomUUID();
    raw.send({ type: "steam", id: steamDelivery, steamId: steam.id, steamedAt: "2026-03-15T12:05:00.000Z", steam });
    await acknowledged(raw, steamDelivery);

    // Credited to Uptown, where Sam works.
    const entry = uptown1.machine.locationHistory[0]!.id;
    const corrected = await api.call("PATCH", `/machines/${uptown1.machine.id}/location-history/${entry}`, { effectiveFrom: "2026-01-01T00:00:00Z" });
    expect(corrected.status).toBe(200);
    const credited = await api.call("GET", "/shots/staff-shot");
    expect(((await credited.json()) as { shot: { location: LocationView | null } }).shot.location).toEqual(uptown);

    for (const path of [
      "/shots",
      `/shots?machineId=${uptown1.machine.id}`,
      "/shots/staff-shot",
      "/shots/staff-shot/measurements",
      "/steam-records",
      `/steam-records?machineId=${uptown1.machine.id}`,
      "/steam-records/staff-steam",
      "/steam-records/staff-steam/measurements",
    ]) {
      await refused(await staff.call("GET", path), 403, "Only an Admin can do this");
    }
  });

  it("shows Staff every Machine and everything about it, as an Admin sees it", async () => {
    // Belmont 1 moves to the Lab, where Sam does not work, and Uptown 1's token reports hardware no Machine has.
    expect((await move(api, belmont1, { locationId: lab.id })).status).toBe(201);
    const unknown = { model: "Bengle", serial: "10004" };
    await connect(uptown1, unknown);
    const mismatched = await api.waitForMachine("Uptown 1", (seen) => seen.mismatch?.serial === unknown.serial);
    expect(mismatched.mismatch?.pendingMachineId).toEqual(expect.any(String));
    expect(mismatched.lastShot).toMatchObject({ id: "staff-shot" });

    expect(names(await staff.machines())).toEqual(["Belmont 1", "Lab 1", "Spare", "Uptown 1"]);
    const paths = [
      "/machines",
      "/machines/models",
      "/pending-machines",
      ...[lab1, uptown1, belmont1, spare].flatMap(({ machine: { id } }) => [
        `/machines/${id}`,
        `/machines/${id}/workflow`,
        `/machines/${id}/workflow-events`,
        `/machines/${id}/machine-state-events`,
        `/machines/${id}/collections`,
        `/machines/${id}/collections/appSettings`,
        `/machines/${id}/paired-devices`,
      ]),
    ];
    for (const path of paths) {
      const [status, body] = await read(staff, path);
      expect(status, path).toBe(200);
      expect(body, path).toEqual((await read(api, path))[1]);
    }
    expect((await machine(staff, belmont1)).locationHistory.map((entry) => entry.location.name)).toEqual(["Belmont", "Lab"]);
  });

  it("lets Staff move a Machine from a Location they work at to another, and nothing else", async () => {
    const moved = await move(staff, uptown1, { locationId: belmont.id });
    expect(moved.status).toBe(201);
    expect(((await moved.json()) as { machine: MachineView }).machine.location).toEqual(belmont);

    // Not away from their Locations,
    await refused(await move(staff, uptown1, { locationId: lab.id }), 403, "You can move a Machine only to a Location you work at");
    // nor from elsewhere, or from no Location, to theirs,
    for (const elsewhere of [lab1, belmont1, spare]) {
      await refused(await move(staff, elsewhere, { locationId: uptown.id }), 403, "You can move a Machine only from a Location you work at");
    }
    // nor from an earlier time, which corrects when it moved.
    const effectiveFrom = new Date(Date.now() - 60_000).toISOString();
    await refused(
      await move(staff, uptown1, { locationId: uptown.id, effectiveFrom }),
      403,
      "Only an Admin can record a move at an earlier time",
    );

    expect((await machine(api, uptown1)).locationHistory.map((entry) => entry.location.name)).toEqual(["Uptown", "Belmont"]);
    expect((await machine(api, lab1)).locationHistory.map((entry) => entry.location.name)).toEqual(["Lab"]);
    expect((await machine(api, belmont1)).locationHistory.map((entry) => entry.location.name)).toEqual(["Belmont", "Lab"]);
    expect((await machine(api, spare)).locationHistory).toEqual([]);
  });
});
