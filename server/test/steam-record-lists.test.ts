import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { derivedSteam } from "./support/steam-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: filtering the Steam Records list through the REST API. Steam
// Records are derived from a record Decaid produced, changing only their ids,
// and are sent as raw frames by each Machine's connection with the UTC time
// the plugin places them at. Hardware ids are made up.

interface SteamRecordView {
  id: string;
  machineId: string | null;
  pendingMachineId: string | null;
  locationId: string | null;
  location: LocationView | null;
  steamedAt: string;
}

describe("Steam Records lists", () => {
  let server: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  let harbor: LocationView;
  let lab1: CreatedMachine;
  let uptown1: CreatedMachine;
  let harbor1: CreatedMachine;
  let roaming: CreatedMachine;
  let pendingMachineId: string;
  const raws: RawConnection[] = [];

  const hardware = {
    lab1: { model: "DE1Pro", serial: "10031" },
    uptown1: { model: "DE1Pro", serial: "10032" },
    harbor1: { model: "DE1XL", serial: "10033" },
    roaming: { model: "DE1Pro", serial: "10034" },
    unknown: { model: "Bengle", serial: "10039" },
  };

  beforeAll(async () => {
    server = await startTestServer();
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Denver");
    uptown = await api.createLocation("Uptown", "America/Chicago");
    harbor = await api.createLocation("Harbor", "America/New_York");
    lab1 = await api.createMachine("Lab 1");
    uptown1 = await api.createMachine("Uptown 1");
    harbor1 = await api.createMachine("Harbor 1");
    roaming = await api.createMachine("Roaming");
    // Each was at its Location long before its Steam Records were recorded; Roaming has never been at one.
    for (const [machine, location] of [[lab1, lab], [uptown1, uptown], [harbor1, harbor]] as const) {
      const moved = await api.call("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" });
      expect(moved.status).toBe(201);
    }

    await deliver(lab1, hardware.lab1, {
      "lab-feb-morning": "2026-02-10T13:30:00Z",
      "lab-feb-dawn": "2026-02-10T12:40:00Z",
      "lab-feb-9": "2026-02-09T15:00:00Z",
    });
    // Lab 1's token reporting hardware no Machine has: its Pending Machine holds what that connection sends.
    await deliver(lab1, hardware.unknown, {
      "pending-steam": "2026-02-12T15:00:00Z",
      "pending-earlier": "2026-02-11T15:00:00Z",
    });
    await deliver(uptown1, hardware.uptown1, {
      "uptown-feb-morning": "2026-02-10T12:30:00Z",
      "uptown-feb-noon": "2026-02-10T18:30:00Z",
      "uptown-feb-11": "2026-02-11T15:00:00Z",
    });
    await deliver(harbor1, hardware.harbor1, {
      // New York's clocks went from 2:00 EST to 3:00 EDT at 07:00 UTC on 2026-03-08.
      "spring-eve": "2026-03-08T04:30:00Z",
      "spring-midnight": "2026-03-08T05:30:00Z",
      "spring-before": "2026-03-08T06:45:00Z",
      "spring-after": "2026-03-08T07:15:00Z",
      "spring-later": "2026-03-08T07:45:00Z",
      "spring-night": "2026-03-09T03:30:00Z",
      "spring-next": "2026-03-09T04:30:00Z",
      // And back from 2:00 EDT to 1:00 EST at 06:00 UTC on 2025-11-02.
      "fall-eve": "2025-11-02T03:30:00Z",
      "fall-first": "2025-11-02T05:30:00Z",
      "fall-second": "2025-11-02T06:30:00Z",
      "fall-after": "2025-11-02T07:30:00Z",
      "fall-night": "2025-11-03T04:30:00Z",
      "fall-next": "2025-11-03T05:30:00Z",
    });
    await deliver(roaming, hardware.roaming, {
      "roaming-dawn": "2026-02-10T06:30:00Z",
      "roaming-noon": "2026-02-10T12:20:00Z",
    });
    pendingMachineId = (await api.pendingMachines()).find((pending) => pending.serial === hardware.unknown.serial)!.id;
  }, 60_000);
  afterAll(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await server?.stop();
  });

  /**
   * Sends Steam Records, by id with the UTC time each was recorded at, through a connection with the
   * Machine's token reporting the hardware given, and waits for each to be stored.
   */
  async function deliver(machine: CreatedMachine, reported: { model: string; serial: string }, steamedAt: Record<string, string>) {
    const raw = await RawConnection.open(server.url);
    raws.push(raw);
    raw.send(helloWith(machine.token, { machine: reported }));
    expect(await raw.message(0)).toMatchObject({ type: "welcome" });
    const deliveries = Object.entries(steamedAt).map(([steamId, at]) => {
      const id = randomUUID();
      raw.send({ type: "steam", id, steamId, steamedAt: new Date(at).toISOString(), steam: derivedSteam(steamId) });
      return id;
    });
    const acknowledged = () => new Set(raw.messages.flatMap((message) => ((message as { type: string }).type === "ack" ? [(message as { id: string }).id] : [])));
    // Called from beforeAll, where expect.poll is unavailable.
    const deadline = Date.now() + 10_000;
    while (!deliveries.every((id) => acknowledged().has(id))) {
      if (Date.now() > deadline) throw new Error(`Not every Steam Record was acknowledged: ${JSON.stringify(raw.messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function list(query: Record<string, string> = {}): Promise<{ steamRecords: SteamRecordView[]; total: number }> {
    const response = await api.call("GET", `/steam-records?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { steamRecords: SteamRecordView[]; total: number };
  }
  /** The ids of the Steam Records listed, newest first. */
  async function ids(query: Record<string, string> = {}): Promise<string[]> {
    const listed = await list(query);
    expect(listed.total).toBe(listed.steamRecords.length);
    return listed.steamRecords.map((steam) => steam.id);
  }
  async function problem(query: string) {
    const response = await api.call("GET", `/steam-records?${query}`);
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  }

  it("lists every Steam Record newest first, with each one's Machine or Pending Machine and Location", async () => {
    const all = await list();
    expect(all.total).toBe(23);
    expect(all.steamRecords.slice(0, 11).map((steam) => steam.id)).toEqual([
      "spring-next", "spring-night", "spring-later", "spring-after", "spring-before", "spring-midnight", "spring-eve", "pending-steam",
      // Recorded at the same moment, so ordered by id.
      "pending-earlier", "uptown-feb-11",
      "uptown-feb-noon",
    ]);
    const byId = new Map(all.steamRecords.map((steam) => [steam.id, steam]));
    expect(byId.get("lab-feb-morning")).toMatchObject({ machineId: lab1.machine.id, pendingMachineId: null, location: lab, steamedAt: "2026-02-10T13:30:00.000Z" });
    // A Pending Machine's Steam Records, and those of a Machine that has never been at a Location, have none.
    expect(byId.get("pending-steam")).toMatchObject({ machineId: null, pendingMachineId, location: null });
    expect(byId.get("roaming-dawn")).toMatchObject({ machineId: roaming.machine.id, location: null });

    // Pages of a filtered list count the whole of it.
    const page = await list({ limit: "3", offset: "3", machineId: harbor1.machine.id });
    expect(page.total).toBe(13);
    expect(page.steamRecords.map((steam) => steam.id)).toEqual(["spring-after", "spring-before", "spring-midnight"]);
  });

  it("narrows by Machine, Pending Machine and Location, including Steam Records with no Location, alone and combined", async () => {
    expect(await ids({ machineId: uptown1.machine.id })).toEqual(["uptown-feb-11", "uptown-feb-noon", "uptown-feb-morning"]);
    // What Lab 1's token sent reporting other hardware is its Pending Machine's, not Lab 1's.
    expect(await ids({ machineId: lab1.machine.id })).toEqual(["lab-feb-morning", "lab-feb-dawn", "lab-feb-9"]);
    expect(await ids({ pendingMachineId })).toEqual(["pending-steam", "pending-earlier"]);
    expect(await ids({ locationId: lab.id })).toEqual(["lab-feb-morning", "lab-feb-dawn", "lab-feb-9"]);
    expect(await ids({ locationId: "none" })).toEqual(["pending-steam", "pending-earlier", "roaming-noon", "roaming-dawn"]);
    expect(await ids({ machineId: randomUUID() })).toEqual([]);

    expect(await ids({ locationId: "none", machineId: roaming.machine.id })).toEqual(["roaming-noon", "roaming-dawn"]);
    expect(await ids({ locationId: uptown.id, from: "2026-02-10", to: "2026-02-10" })).toEqual(["uptown-feb-noon", "uptown-feb-morning"]);
    expect(await ids({ machineId: harbor1.machine.id, locationId: lab.id })).toEqual([]);
    expect(await ids({ machineId: lab1.machine.id, pendingMachineId })).toEqual([]);
  });

  it("reads times in each Steam Record's own Location's time zone, and UTC for those with none", async () => {
    // 06:00 to noon on February 10 is 13:00 to 19:00 UTC at the Lab, 12:00 to 18:00 at Uptown, and 06:00 to 12:00 without a Location.
    expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00" })).toEqual(["lab-feb-morning", "uptown-feb-morning", "roaming-dawn"]);
    expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00", locationId: uptown.id })).toEqual(["uptown-feb-morning"]);
    // A date alone is the whole of that day; either end may be left open.
    expect(await ids({ from: "2026-02-10", to: "2026-02-10" })).toEqual([
      "uptown-feb-noon", "lab-feb-morning", "lab-feb-dawn", "uptown-feb-morning", "roaming-noon", "roaming-dawn",
    ]);
    expect(await ids({ from: "2026-02-11", to: "2026-02-28" })).toEqual(["pending-steam", "pending-earlier", "uptown-feb-11"]);
    expect(await ids({ to: "2026-02-09" })).toEqual(["lab-feb-9", "fall-next", "fall-night", "fall-after", "fall-second", "fall-first", "fall-eve"]);
    expect((await ids({ from: "2026-03-08T03:00:00" })).at(-1)).toBe("spring-after");

    // Moving the Lab's arrival later leaves its Steam Records without a Location, so they are read in UTC.
    const [entry] = (await api.machineNamed("Lab 1"))!.locationHistory;
    expect((await api.call("PATCH", `/machines/${lab1.machine.id}/location-history/${entry!.id}`, { effectiveFrom: "2026-02-10T14:00:00Z" })).status).toBe(200);
    try {
      expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00" })).toEqual(["uptown-feb-morning", "roaming-dawn"]);
      expect(await ids({ from: "2026-02-10T12:00", to: "2026-02-10T14:00", locationId: "none" })).toEqual(["lab-feb-morning", "lab-feb-dawn", "roaming-noon"]);
    } finally {
      expect((await api.call("PATCH", `/machines/${lab1.machine.id}/location-history/${entry!.id}`, { effectiveFrom: "2025-01-01T00:00:00Z" })).status).toBe(200);
    }
    expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00" })).toEqual(["lab-feb-morning", "uptown-feb-morning", "roaming-dawn"]);
  });

  it("follows a Location's clocks across daylight saving changes", async () => {
    const atHarbor = (from: string, to: string) => ids({ locationId: harbor.id, from, to });
    // The day the clocks go forward is 23 hours long: it starts at 05:00 UTC and ends at 04:00 UTC.
    expect(await atHarbor("2026-03-08", "2026-03-08")).toEqual(["spring-night", "spring-later", "spring-after", "spring-before", "spring-midnight"]);
    // From 1:30 to 3:30 by the Location's clocks is one hour.
    expect(await atHarbor("2026-03-08T01:30", "2026-03-08T03:30")).toEqual(["spring-after", "spring-before"]);
    // The day the clocks go back is 25 hours long, from 04:00 UTC to 05:00 UTC the next day.
    expect(await atHarbor("2025-11-02", "2025-11-02")).toEqual(["fall-night", "fall-after", "fall-second", "fall-first"]);
    // And 1:00 to 2:00 happens twice.
    expect(await atHarbor("2025-11-02T01:00", "2025-11-02T02:00")).toEqual(["fall-second", "fall-first"]);
  });

  it("refuses filters it cannot read", async () => {
    expect(await problem("from=2026-02-30")).toEqual({ status: 400, message: ["Enter from as a date, such as 2026-10-05, or a date and time, such as 2026-10-05T06:00"] });
    expect(await problem("to=2026-02-10T12:00Z")).toMatchObject({ status: 400 });
    expect(await problem("to=2026-02-10T24:00")).toMatchObject({ status: 400 });
    expect(await problem("from=2026-02-10T12:00&to=2026-02-10T12:00")).toEqual({ status: 400, message: ["Choose an end after the start"] });
    expect(await problem(`locationId=${lab.id}&locationId=${uptown.id}`)).toEqual({ status: 400, message: ["Give locationId once"] });
    expect(await problem("offset=1&offset=2")).toMatchObject({ status: 400 });
    expect(await problem("machineId=lab-1")).toMatchObject({ status: 404, message: "No such Machine" });
    expect(await problem("pendingMachineId=7")).toMatchObject({ status: 404, message: "No such Pending Machine" });
    expect(await problem("locationId=elsewhere")).toMatchObject({ status: 404, message: "No such Location" });
    expect((await api.call("GET", `/steam-records?locationId=${lab.id}`, undefined, {})).status).toBe(401);
  });

  it("leaves a dismissed Pending Machine's Steam Records out, and lists them under the machine entry created for its hardware", async () => {
    expect((await api.call("POST", `/pending-machines/${pendingMachineId}/dismiss`)).status).toBe(200);
    expect(await ids({ pendingMachineId })).toEqual([]);
    expect(await ids({ locationId: "none" })).toEqual(["roaming-noon", "roaming-dawn"]);
    expect((await list()).total).toBe(21);

    // Created at Harbor from now, so until its first entry is moved earlier, what it holds has no Location.
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${pendingMachineId}/machine`, { name: "Adopted", locationId: harbor.id }));
    expect(await ids({ machineId: adopted.machine.id })).toEqual(["pending-steam", "pending-earlier"]);
    expect(await ids({ locationId: "none" })).toEqual(["pending-steam", "pending-earlier", "roaming-noon", "roaming-dawn"]);
    const [entry] = adopted.machine.locationHistory;
    expect((await api.call("PATCH", `/machines/${adopted.machine.id}/location-history/${entry!.id}`, { effectiveFrom: "2025-01-01T00:00:00Z" })).status).toBe(200);
    // 15:00 UTC is 10:00 in New York.
    expect(await ids({ locationId: harbor.id, from: "2026-02-11T10:00", to: "2026-02-12T10:00" })).toEqual(["pending-earlier"]);
    expect((await list()).total).toBe(23);
  });
});
