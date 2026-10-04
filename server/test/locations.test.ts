import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Creating, listing and editing Locations through the REST API of a real
// server on a fresh database. The tests share one server and run in order.

const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

interface LocationView {
  id: string;
  name: string;
  timeZone: string;
}

describe("Locations", () => {
  let server: TestServer;
  let cookie: string;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { Cookie: cookie }) =>
    fetch(`${server.url}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const problems = async (response: Response) => ((await response.json()) as { message: string | string[] }).message;

  beforeAll(async () => {
    server = await startTestServer();
    const setup = await call("POST", "/setup", admin, {});
    cookie = setup.headers.getSetCookie()[0]!.split(";")[0]!;
  }, 60_000);
  afterAll(() => server?.stop());

  it("requires a session", async () => {
    expect((await call("GET", "/locations", undefined, {})).status).toBe(401);
    expect((await call("POST", "/locations", { name: "Lab", timeZone: "UTC" }, {})).status).toBe(401);
    expect((await call("GET", "/time-zones", undefined, {})).status).toBe(401);
  });

  it("starts with no Locations", async () => {
    expect(await (await call("GET", "/locations")).json()).toEqual({ locations: [] });
  });

  let uptown: LocationView;

  it("creates a Location with a name and time zone", async () => {
    const response = await call("POST", "/locations", { name: "  Uptown ", timeZone: "America/Chicago" });

    expect(response.status).toBe(201);
    ({ location: uptown } = (await response.json()) as { location: LocationView });
    expect(uptown).toEqual({ id: expect.any(String), name: "Uptown", timeZone: "America/Chicago" });
  });

  it("refuses a time zone that is not an IANA time zone, naming each problem", async () => {
    for (const timeZone of ["Mars/Olympus", "+05:00", "", "posixrules", 360, undefined]) {
      const response = await call("POST", "/locations", { name: "Belmont", timeZone });
      expect(response.status, String(timeZone)).toBe(400);
      expect(await problems(response)).toEqual(["Choose a time zone from the list, such as Europe/London"]);
    }

    const both = await call("POST", "/locations", { name: " ", timeZone: "Nowhere" });
    expect(await problems(both)).toEqual(["Enter a name", "Choose a time zone from the list, such as Europe/London"]);
    const long = await call("POST", "/locations", { name: "x".repeat(101), timeZone: "UTC" });
    expect(await problems(long)).toEqual(["Use a name of at most 100 characters"]);
  });

  it("stores time zones as PostgreSQL spells them, whatever their case", async () => {
    const response = await call("POST", "/locations", { name: "Lab", timeZone: " europe/london " });
    expect(((await response.json()) as { location: LocationView }).location.timeZone).toBe("Europe/London");
  });

  it("stores an older name a browser reports under its IANA name", async () => {
    // Chrome in India reports Asia/Calcutta, which PostgreSQL may not know.
    const response = await call("POST", "/locations", { name: "Kolkata", timeZone: "Asia/Calcutta" });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { location: LocationView }).location.timeZone).toBe("Asia/Kolkata");
  });

  it("refuses a second Location with the same name", async () => {
    const response = await call("POST", "/locations", { name: "Uptown", timeZone: "UTC" });
    expect(response.status).toBe(409);
    expect(await problems(response)).toBe("A Location named Uptown already exists");
  });

  it("lists Locations by name", async () => {
    const { locations } = (await (await call("GET", "/locations")).json()) as { locations: LocationView[] };
    expect(locations.map(({ name, timeZone }) => [name, timeZone])).toEqual([
      ["Kolkata", "Asia/Kolkata"],
      ["Lab", "Europe/London"],
      ["Uptown", "America/Chicago"],
    ]);
  });

  it("accepts IANA aliases PostgreSQL may not know, stored under a name it does", async () => {
    // From tzdata's "backward" file, which PostgreSQL's time zone data may lack.
    const aliases = { "US/Eastern": "America/New_York", EST5EDT: "America/New_York", "Canada/Eastern": "America/Toronto", Japan: "Asia/Tokyo" };
    for (const [alias, stored] of Object.entries(aliases)) {
      const response = await call("POST", "/locations", { name: `Alias ${alias}`, timeZone: alias });
      expect(response.status, alias).toBe(201);
      expect(((await response.json()) as { location: LocationView }).location.timeZone, alias).toBe(stored);
    }
  });

  it("renames a Location and changes its time zone", async () => {
    const renamed = await call("PATCH", `/locations/${uptown.id}`, { name: "Belmont" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ location: { ...uptown, name: "Belmont" } });

    const moved = await call("PATCH", `/locations/${uptown.id}`, { timeZone: "America/New_York" });
    expect(await moved.json()).toEqual({ location: { ...uptown, name: "Belmont", timeZone: "America/New_York" } });

    const both = await call("PATCH", `/locations/${uptown.id}`, { name: "Uptown", timeZone: "America/Chicago" });
    expect(await both.json()).toEqual({ location: uptown });
  });

  it("stores renamed Ukrainian time zones under the name PostgreSQL knows", async () => {
    for (const timeZone of ["Europe/Kiev", "Europe/Zaporozhye"]) {
      const response = await call("POST", "/locations", { name: `Alias ${timeZone}`, timeZone });
      expect(response.status, timeZone).toBe(201);
      expect(((await response.json()) as { location: LocationView }).location.timeZone, timeZone).toBe("Europe/Kyiv");
    }
  });

  it("refuses PostgreSQL-only names and numeric offsets", async () => {
    for (const timeZone of ["Factory", "localtime", "+00:00", "-05:00", "+0530"]) {
      const response = await call("POST", "/locations", { name: `Invalid ${timeZone}`, timeZone });
      expect(response.status, timeZone).toBe(400);
      expect(await problems(response)).toEqual(["Choose a time zone from the list, such as Europe/London"]);
    }
  });

  it("refuses edits that are empty, invalid or clash with another name", async () => {
    const empty = await call("PATCH", `/locations/${uptown.id}`, {});
    expect(empty.status).toBe(400);
    expect(await problems(empty)).toBe("Send a new name or time zone");

    const invalid = await call("PATCH", `/locations/${uptown.id}`, { name: "", timeZone: "UTC+1" });
    expect(invalid.status).toBe(400);
    expect(await problems(invalid)).toEqual(["Enter a name", "Choose a time zone from the list, such as Europe/London"]);

    const clash = await call("PATCH", `/locations/${uptown.id}`, { name: "Lab" });
    expect(clash.status).toBe(409);

    // None of them changed it.
    const { locations } = (await (await call("GET", "/locations")).json()) as { locations: LocationView[] };
    expect(locations.find(({ id }) => id === uptown.id)).toEqual(uptown);
  });

  it("answers 404 for a Location that does not exist", async () => {
    expect((await call("PATCH", "/locations/0192d6a0-0000-7000-8000-000000000000", { name: "Gone" })).status).toBe(404);
    expect((await call("PATCH", "/locations/not-an-id", { name: "Gone" })).status).toBe(404);
  });

  it("lists the time zones a Location may use, under the names it stores", async () => {
    const { timeZones } = (await (await call("GET", "/time-zones")).json()) as { timeZones: string[] };

    expect(timeZones).toEqual([...timeZones].sort());
    expect(timeZones).toEqual(expect.arrayContaining(["UTC", "America/Chicago", "Asia/Kolkata", "Europe/Kyiv"]));
    expect(timeZones).not.toContain("Asia/Calcutta");
    for (const timeZone of timeZones) {
      const response = await call("POST", "/locations", { name: `Zone ${timeZone}`, timeZone });
      expect(((await response.json()) as { location: LocationView }).location.timeZone).toBe(timeZone);
    }
  });
});
