import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: filtering the Shots list through the REST API. Shots are derived
// from a scrubbed real record, changing only their id, time, recorded
// hardware, Bean, Barista and profile title, and are sent as raw frames by
// each Machine's connection. Baristas, Beans and hardware ids are made up.

interface ShotView {
  id: string;
  machineId: string | null;
  pendingMachineId: string | null;
  machineInferred: boolean;
  locationId: string | null;
  location: LocationView | null;
  locationInferred: boolean;
  pulledAt: string | null;
  previousShot?: { id: string; pulledAt: string } | null;
}

interface Recorded {
  hardware?: { model: string; serial: string };
  roaster?: string | null;
  bean?: string | null;
  barista?: string | null;
  profile?: string;
}

describe("Shots lists", () => {
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
    lab1: { model: "DE1Pro", serial: "10011" },
    uptown1: { model: "DE1Pro", serial: "10012" },
    harbor1: { model: "DE1XL", serial: "10013" },
    roaming: { model: "DE1Pro", serial: "10014" },
    unknown: { model: "Bengle", serial: "10019" },
  };
  const ethiopia = { roaster: "Roux Bakehouse", bean: "Ethiopia Guji" };

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
    // Each was at its Location long before its Shots were pulled; Roaming has never been at one.
    for (const [machine, location] of [[lab1, lab], [uptown1, uptown], [harbor1, harbor]] as const) {
      const moved = await api.call("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" });
      expect(moved.status).toBe(201);
    }

    await deliver(lab1, hardware.lab1, [
      shotAt("lab-feb-morning", "2026-02-10T13:30:00Z", { hardware: hardware.lab1, ...ethiopia, barista: "Ann", profile: "Londonium" }),
      shotAt("lab-feb-dawn", "2026-02-10T12:40:00Z", { hardware: hardware.lab1, roaster: "Roux Bakehouse", bean: "Kenya Nyeri", barista: "Ben", profile: "Blooming" }),
      shotAt("lab-blank", "2026-02-09T15:00:00Z", { hardware: hardware.lab1, roaster: null, bean: null, barista: null, profile: "Londonium" }),
      // Recorded on hardware no Machine has, which a Pending Machine holds.
      shotAt("pending-shot", "2026-02-12T15:00:00Z", { hardware: hardware.unknown, ...ethiopia, barista: "Dee", profile: "Londonium" }),
      shotAt("pending-earlier", "2026-02-11T15:00:00Z", { hardware: hardware.unknown, ...ethiopia, barista: "Dee", profile: "Londonium" }),
    ]);
    await deliver(uptown1, hardware.uptown1, [
      shotAt("uptown-feb-morning", "2026-02-10T12:30:00Z", { hardware: hardware.uptown1, ...ethiopia, barista: "Ann", profile: "Blooming" }),
      shotAt("uptown-feb-noon", "2026-02-10T18:30:00Z", { hardware: hardware.uptown1, roaster: "Other Roaster", bean: "Ethiopia Guji", barista: "Cat", profile: "Londonium" }),
      // Records no hardware, so it is credited to Uptown 1, whose tablet reported it, as inferred.
      shotAt("uptown-inferred", "2026-02-11T15:00:00Z", { ...ethiopia, barista: "Ann", profile: "Londonium" }),
    ]);
    await deliver(harbor1, hardware.harbor1, [
      // New York's clocks went from 2:00 EST to 3:00 EDT at 07:00 UTC on 2026-03-08.
      shotAt("spring-eve", "2026-03-08T04:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-midnight", "2026-03-08T05:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-before", "2026-03-08T06:45:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-after", "2026-03-08T07:15:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-later", "2026-03-08T07:45:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-night", "2026-03-09T03:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("spring-next", "2026-03-09T04:30:00Z", { hardware: hardware.harbor1 }),
      // And back from 2:00 EDT to 1:00 EST at 06:00 UTC on 2025-11-02.
      shotAt("fall-eve", "2025-11-02T03:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("fall-first", "2025-11-02T05:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("fall-second", "2025-11-02T06:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("fall-after", "2025-11-02T07:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("fall-night", "2025-11-03T04:30:00Z", { hardware: hardware.harbor1 }),
      shotAt("fall-next", "2025-11-03T05:30:00Z", { hardware: hardware.harbor1 }),
    ]);
    await deliver(roaming, hardware.roaming, [
      shotAt("roaming-dawn", "2026-02-10T06:30:00Z", { hardware: hardware.roaming, ...ethiopia, barista: "Ann" }),
      shotAt("roaming-noon", "2026-02-10T12:20:00Z", { hardware: hardware.roaming }),
    ]);
    pendingMachineId = (await api.pendingMachines()).find((pending) => pending.serial === hardware.unknown.serial)!.id;
  }, 60_000);
  afterAll(async () => {
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await server?.stop();
  });

  /** A Shot pulled at a UTC time, recording the hardware, Bean, Barista and profile given; a null removes what the record had. */
  function shotAt(id: string, pulledAt: string, recorded: Recorded = {}) {
    const { machine, context, profile, ...workflow } = shotFixture().workflow as Record<string, Record<string, unknown>>;
    const changed: Record<string, unknown> = { ...context };
    for (const [field, value] of [["coffeeRoaster", recorded.roaster], ["coffeeName", recorded.bean], ["baristaName", recorded.barista]] as const) {
      if (value === null) delete changed[field];
      else if (value !== undefined) changed[field] = value;
    }
    return derivedShot(id, {
      timestamp: pulledAt,
      workflow: {
        ...workflow,
        context: changed,
        profile: recorded.profile ? { ...profile, title: recorded.profile } : profile,
        ...(recorded.hardware ? { machine: { ...machine, model: recorded.hardware.model, serialNumber: recorded.hardware.serial } } : {}),
      },
    });
  }

  /** Sends the Shots through a connection with the Machine's token reporting its hardware, and waits for each to be stored. */
  async function deliver(machine: CreatedMachine, reported: { model: string; serial: string }, shots: Record<string, unknown>[]) {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: reported }));
    raws.push(raw);
    await Promise.all(shots.map((shot) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot })));
  }

  async function list(query: Record<string, string> = {}, at = api): Promise<{ shots: ShotView[]; total: number }> {
    const response = await at.call("GET", `/shots?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { shots: ShotView[]; total: number };
  }
  /** The ids of the Shots listed, newest first. */
  async function ids(query: Record<string, string> = {}): Promise<string[]> {
    const listed = await list(query);
    expect(listed.total).toBe(listed.shots.length);
    return listed.shots.map((shot) => shot.id);
  }
  async function detail(id: string): Promise<ShotView> {
    const response = await api.call("GET", `/shots/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { shot: ShotView }).shot;
  }
  async function problem(query: string) {
    const response = await api.call("GET", `/shots?${query}`);
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  }

  const february = ["pending-shot", "pending-earlier", "uptown-inferred", "uptown-feb-noon", "lab-feb-morning", "lab-feb-dawn", "uptown-feb-morning", "roaming-noon", "roaming-dawn", "lab-blank"];

  it("lists every Shot newest first, with each one's Machine or Pending Machine, Location and inferred credit", async () => {
    const all = await list();
    expect(all.total).toBe(23);
    expect(all.shots.slice(0, 10).map((shot) => shot.id)).toEqual([
      "spring-next", "spring-night", "spring-later", "spring-after", "spring-before", "spring-midnight", "spring-eve",
      ...february.slice(0, 3),
    ]);
    const byId = new Map(all.shots.map((shot) => [shot.id, shot]));
    expect(byId.get("lab-feb-morning")).toMatchObject({ machineId: lab1.machine.id, location: lab, machineInferred: false, locationInferred: false });
    expect(byId.get("uptown-inferred")).toMatchObject({ machineId: uptown1.machine.id, location: uptown, machineInferred: true, locationInferred: true });
    // A Pending Machine's Shots, and those of a Machine that has never been at a Location, have none.
    expect(byId.get("pending-shot")).toMatchObject({ machineId: null, pendingMachineId, location: null, locationInferred: false });
    expect(byId.get("roaming-dawn")).toMatchObject({ machineId: roaming.machine.id, location: null, locationInferred: false });

    // Pages of a filtered list count the whole of it.
    const page = await list({ limit: "3", offset: "3", machineId: harbor1.machine.id });
    expect(page.total).toBe(13);
    expect(page.shots.map((shot) => shot.id)).toEqual(["spring-after", "spring-before", "spring-midnight"]);
  });

  it("narrows by Machine, Pending Machine and Location, including Shots with no Location", async () => {
    expect(await ids({ machineId: uptown1.machine.id })).toEqual(["uptown-inferred", "uptown-feb-noon", "uptown-feb-morning"]);
    expect(await ids({ pendingMachineId })).toEqual(["pending-shot", "pending-earlier"]);
    expect(await ids({ locationId: lab.id })).toEqual(["lab-feb-morning", "lab-feb-dawn", "lab-blank"]);
    expect(await ids({ locationId: "none" })).toEqual(["pending-shot", "pending-earlier", "roaming-noon", "roaming-dawn"]);
    expect(await ids({ machineId: randomUUID() })).toEqual([]);
  });

  it("narrows by Bean, roaster and name together, across Machines and Pending Machines", async () => {
    expect(await ids({ coffeeRoaster: ethiopia.roaster, coffeeName: ethiopia.bean })).toEqual([
      "pending-shot", "pending-earlier", "uptown-inferred", "lab-feb-morning", "uptown-feb-morning", "roaming-dawn",
    ]);
    // The same name from another roaster is another Bean.
    expect(await ids({ coffeeRoaster: "Other Roaster", coffeeName: ethiopia.bean })).toEqual(["uptown-feb-noon"]);
    expect(await ids({ coffeeName: ethiopia.bean })).toHaveLength(7);
    expect(await ids({ coffeeRoaster: ethiopia.roaster, coffeeName: "kenya nyeri" })).toEqual([]);
    // An empty value finds the Shots that recorded none.
    expect(await ids({ coffeeRoaster: "", coffeeName: "" })).toEqual(["lab-blank"]);
  });

  it("narrows by Barista and profile, and by every filter combined", async () => {
    expect(await ids({ barista: "Ann" })).toEqual(["uptown-inferred", "lab-feb-morning", "uptown-feb-morning", "roaming-dawn"]);
    expect(await ids({ barista: "Dee" })).toEqual(["pending-shot", "pending-earlier"]);
    expect(await ids({ profileTitle: "Blooming" })).toEqual(["lab-feb-dawn", "uptown-feb-morning"]);
    expect(await ids({ barista: "" })).toEqual(["lab-blank"]);

    expect(await ids({ barista: "Ann", profileTitle: "Londonium" })).toEqual(["uptown-inferred", "lab-feb-morning", "roaming-dawn"]);
    expect(await ids({ barista: "Ann", profileTitle: "Londonium", locationId: uptown.id })).toEqual(["uptown-inferred"]);
    expect(await ids({ barista: "Ann", coffeeRoaster: ethiopia.roaster, coffeeName: ethiopia.bean, from: "2026-02-10", to: "2026-02-10" })).toEqual([
      "lab-feb-morning", "uptown-feb-morning", "roaming-dawn",
    ]);
    expect(await ids({ machineId: lab1.machine.id, pendingMachineId })).toEqual([]);
  });

  it("reads times in each Shot's own Location's time zone, and UTC for Shots with none", async () => {
    // 06:00 to noon on February 10 is 13:00 to 19:00 UTC at the Lab, 12:00 to 18:00 at Uptown, and 06:00 to 12:00 without a Location.
    expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00" })).toEqual(["lab-feb-morning", "uptown-feb-morning", "roaming-dawn"]);
    expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00", locationId: uptown.id })).toEqual(["uptown-feb-morning"]);
    // A date alone is the whole of that day; either end may be left open.
    expect(await ids({ from: "2026-02-10", to: "2026-02-10" })).toEqual(["uptown-feb-noon", "lab-feb-morning", "lab-feb-dawn", "uptown-feb-morning", "roaming-noon", "roaming-dawn"]);
    expect(await ids({ from: "2026-02-11", to: "2026-02-28" })).toEqual(["pending-shot", "pending-earlier", "uptown-inferred"]);
    expect(await ids({ to: "2026-02-09" })).toEqual(["lab-blank", "fall-next", "fall-night", "fall-after", "fall-second", "fall-first", "fall-eve"]);
    expect((await ids({ from: "2026-03-08T03:00:00" })).at(-1)).toBe("spring-after");

    // Moving the Lab's arrival later leaves its Shots without a Location, so they are read in UTC.
    const [entry] = (await api.machineNamed("Lab 1"))!.locationHistory;
    expect((await api.call("PATCH", `/machines/${lab1.machine.id}/location-history/${entry!.id}`, { effectiveFrom: "2026-02-10T14:00:00Z" })).status).toBe(200);
    try {
      expect(await ids({ from: "2026-02-10T06:00", to: "2026-02-10T12:00" })).toEqual(["uptown-feb-morning", "roaming-dawn"]);
      expect(await ids({ from: "2026-02-10T12:00", to: "2026-02-10T14:00", locationId: "none" })).toEqual(["lab-feb-morning", "lab-feb-dawn", "roaming-noon"]);
    } finally {
      expect((await api.call("PATCH", `/machines/${lab1.machine.id}/location-history/${entry!.id}`, { effectiveFrom: "2025-01-01T00:00:00Z" })).status).toBe(200);
    }
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
    expect(await problem("barista=Ann&barista=Ben")).toEqual({ status: 400, message: ["Give barista once"] });
    expect(await problem("limit=5&limit=6")).toMatchObject({ status: 400 });
    expect(await problem("machineId=lab-1")).toMatchObject({ status: 404, message: "No such Machine" });
    expect(await problem("pendingMachineId=7")).toMatchObject({ status: 404, message: "No such Pending Machine" });
    expect(await problem("locationId=elsewhere")).toMatchObject({ status: 404, message: "No such Location" });
    for (const path of ["/shots?barista=Ann", "/shots/filters"]) expect((await api.call("GET", path, undefined, {})).status).toBe(401);
  });

  it("offers the Beans, Baristas and profiles listed Shots recorded, and the Library items they are linked to, as filters", async () => {
    const response = await api.call("GET", "/shots/filters");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      beans: [
        { coffeeRoaster: "Other Roaster", coffeeName: "Ethiopia Guji" },
        { coffeeRoaster: "Roux Bakehouse", coffeeName: "Ethiopia Generic 100g Sample" },
        { coffeeRoaster: "Roux Bakehouse", coffeeName: "Ethiopia Guji" },
        { coffeeRoaster: "Roux Bakehouse", coffeeName: "Kenya Nyeri" },
        { coffeeRoaster: null, coffeeName: null },
      ],
      baristas: ["Ann", "Ben", "Cat", "Dee", "Fixture Barista", null],
      profiles: ["Blooming", "Londonium"],
      // These Shots' tablets hold no Library batch or Grinder.
      beanBatches: [null],
      grinders: [null],
    });
  });

  it("names the previous Shot on the same Machine, or held by the same Pending Machine", async () => {
    expect((await detail("uptown-feb-noon")).previousShot).toEqual({ id: "uptown-feb-morning", pulledAt: "2026-02-10T12:30:00.000Z" });
    // Inferred credit is still the Machine's.
    expect((await detail("uptown-inferred")).previousShot).toEqual({ id: "uptown-feb-noon", pulledAt: "2026-02-10T18:30:00.000Z" });
    expect((await detail("uptown-feb-morning")).previousShot).toBeNull();
    expect((await detail("pending-shot")).previousShot).toEqual({ id: "pending-earlier", pulledAt: "2026-02-11T15:00:00.000Z" });
    // Not one pulled between them on another Machine.
    expect((await detail("lab-feb-dawn")).previousShot).toEqual({ id: "lab-blank", pulledAt: "2026-02-09T15:00:00.000Z" });
  });

  it("leaves a dismissed Pending Machine's Shots out of lists and filter choices", async () => {
    expect((await api.call("POST", `/pending-machines/${pendingMachineId}/dismiss`)).status).toBe(200);
    expect(await ids({ pendingMachineId })).toEqual([]);
    expect(await ids({ barista: "Dee" })).toEqual([]);
    expect((await list()).total).toBe(21);
    const { baristas } = (await (await api.call("GET", "/shots/filters")).json()) as { baristas: (string | null)[] };
    expect(baristas).not.toContain("Dee");
  });
});
