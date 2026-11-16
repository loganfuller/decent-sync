import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp, toolSummary } from "./support/assistants.js";
import { derivedShot, shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { derivedSteam } from "./support/steam-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The Shots list's rating filter and the record lists' periods (#544) at
// Seam 1: through the REST API, and through an assistant, whose tools are
// checked against the REST API's answers. Shots and Steam Records are
// derived from real ones Decaid recorded, changing only their ids, times,
// recorded hardware and rating, and are sent as raw frames by each
// Machine's connection. Hardware ids are made up.

type Fields = Record<string, unknown>;

/**
 * The periods as the server names them, each as how many days back from
 * today it starts and ends.
 */
const PERIODS = { today: [0, 0], yesterday: [1, 1], "7days": [6, 0], "30days": [29, 0] } as const;
type Period = keyof typeof PERIODS;

/** How many days before today, each at its own Location, a record of the periods' tests was recorded. */
const DAYS_BACK = [1, 6, 7, 29, 30] as const;

describe("the rating filter and the periods of record lists", () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let east: LocationView;
  let west: LocationView;
  const raws: RawConnection[] = [];

  // Kiritimati is 14 hours ahead of UTC and Pago Pago 11 behind, neither with daylight saving, so the two are never on
  // the same date: no one date is today at both.
  const sites = {
    east: { name: "East", timeZone: "Pacific/Kiritimati", hardware: { model: "DE1Pro", serial: "54401" } },
    west: { name: "West", timeZone: "Pacific/Pago_Pago", hardware: { model: "DE1XL", serial: "54402" } },
    // Never at a Location, so its days are UTC's.
    roaming: { name: "Roaming", timeZone: "UTC", hardware: { model: "DE1Pro", serial: "54403" } },
  };
  type Site = keyof typeof sites;
  const machines = {} as Record<Site, CreatedMachine>;
  /** Each record of the periods' tests, a Shot and a Steam Record alike: its id, the zone its days are read in, and when it was recorded. */
  const timed: { id: string; timeZone: string; at: string }[] = [];
  /** The Shots of the rating filter's tests, pulled long ago at no Location, by the rating each recorded: none, or Decaid's points from 0 to 10. */
  const rated = { "rated-none": null, "rated-0": 0, "rated-3": 3, "rated-4": 4, "rated-7": 7, "rated-8": 8, "rated-10": 10 } as const;

  beforeAll(async () => {
    server = await startTestServer({ env: ASSISTANT_ENV });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    east = await api.createLocation(sites.east.name, sites.east.timeZone);
    west = await api.createLocation(sites.west.name, sites.west.timeZone);
    for (const site of Object.keys(sites) as Site[]) machines[site] = await api.createMachine(sites[site].name);
    for (const [machine, location] of [[machines.east, east], [machines.west, west]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }

    // At each site, a record now, and one a minute before midnight each of some days back, on that site's own calendar.
    for (const site of Object.keys(sites) as Site[]) {
      const { timeZone } = sites[site];
      const midnight = Temporal.Now.zonedDateTimeISO(timeZone).startOfDay();
      timed.push({ id: `${site}-now`, timeZone, at: new Date().toISOString() });
      for (const days of DAYS_BACK) {
        timed.push({ id: `${site}-${days}-back`, timeZone, at: new Date(midnight.subtract({ days: days - 1, minutes: 1 }).epochMilliseconds).toISOString() });
      }
    }
    await Promise.all(
      (Object.keys(sites) as Site[]).map(async (site) => {
        const raw = await RawConnection.welcomed(server.url, helloWith(machines[site].token, { machine: sites[site].hardware }));
        raws.push(raw);
        const records = timed.filter((record) => record.id.startsWith(`${site}-`));
        await Promise.all([
          ...records.map(({ id, at }) => raw.deliver({ type: "shot", id: randomUUID(), shotId: id, shot: shotAt(id, at, site) })),
          ...records.map(({ id, at }) => raw.deliver({ type: "steam", id: randomUUID(), steamId: `steam-${id}`, steamedAt: at, steam: derivedSteam(`steam-${id}`) })),
          ...(site === "roaming"
            ? Object.entries(rated).map(([id, rating], n) => raw.deliver({ type: "shot", id: randomUUID(), shotId: id, shot: shotAt(id, `2026-02-10T12:0${n}:00Z`, site, rating) }))
            : []),
        ]);
      }),
    );

    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
  });
  afterAll(async () => {
    await assistant?.close();
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await app?.close();
    await server?.stop();
  });

  /** Derived: the real Shot pulled at a UTC time on a site's hardware, recording the rating given, or, for null, none. */
  function shotAt(id: string, pulledAt: string, site: Site, rating?: number | null): Fields {
    const { machine, ...workflow } = shotFixture().workflow as Record<string, Fields>;
    const shot = derivedShot(id, { timestamp: pulledAt, workflow: { ...workflow, machine: { ...machine, ...sites[site].hardware, serialNumber: sites[site].hardware.serial } } });
    return rating == null ? shot : { ...shot, annotations: { ...(shot.annotations as Fields), enjoyment: rating } };
  }

  /** The ids of the Shots the REST API lists for a query, newest first. */
  async function shotIds(query: Record<string, string>): Promise<string[]> {
    const listed = await api.get<{ shots: { id: string }[]; total: number }>(`/shots?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(listed.total).toBe(listed.shots.length);
    return listed.shots.map((shot) => shot.id);
  }

  async function steamIds(query: Record<string, string>): Promise<string[]> {
    const listed = await api.get<{ steamRecords: { id: string }[]; total: number }>(`/steam-records?${new URLSearchParams({ limit: "100", ...query })}`);
    expect(listed.total).toBe(listed.steamRecords.length);
    return listed.steamRecords.map((steam) => steam.id);
  }

  async function problem(path: string) {
    const response = await api.call("GET", path);
    return { status: response.status, message: ((await response.json()) as { message: unknown }).message };
  }

  /** A tool's error, which a call must answer with. */
  async function toolError(name: string, args: Fields): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { type: string; text: string }[]).map((block) => block.text).join("\n");
  }

  /**
   * The timed records a period holds now, newest first, each by the calendar
   * of its own zone, worked out apart from the server: those whose date
   * there is from the period's first day back from today there to its last.
   */
  function inPeriod(period: Period, among: (record: { id: string; timeZone: string }) => boolean = () => true): string[] {
    const [from, to] = PERIODS[period];
    return timed
      .filter((record) => {
        const today = Temporal.Now.plainDateISO(record.timeZone);
        const day = Temporal.Instant.from(record.at).toZonedDateTimeISO(record.timeZone).toPlainDate();
        const back = day.until(today).days;
        return among(record) && back >= to && back <= from;
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
      .map((record) => record.id);
  }

  /**
   * What `read` answers for a period, with what the period holds as it was
   * read: read again where a midnight at one of the sites fell during it,
   * which moves a record from one day to the next.
   */
  async function readInPeriod<T>(period: Period, read: () => Promise<T>, among?: Parameters<typeof inPeriod>[1]): Promise<{ answer: T; expected: string[] }> {
    for (;;) {
      const expected = inPeriod(period, among);
      const answer = await read();
      if (JSON.stringify(inPeriod(period, among)) === JSON.stringify(expected)) return { answer, expected };
    }
  }

  it("narrows Shots by rating: rated, not rated, with 0 as not rated, and at least a number of stars, two points each", async () => {
    const among = { machineId: machines.roaming.machine.id, to: "2026-02-10" };
    expect(await shotIds(among)).toEqual(["rated-10", "rated-8", "rated-7", "rated-4", "rated-3", "rated-0", "rated-none"]);
    expect(await shotIds({ ...among, rating: "rated" })).toEqual(["rated-10", "rated-8", "rated-7", "rated-4", "rated-3"]);
    // A rating of 0 is no rating, as DYE2 writes it for no stars.
    expect(await shotIds({ ...among, rating: "unrated" })).toEqual(["rated-0", "rated-none"]);
    // Two stars are 4 points, so 3 points, a star and a half, are under them.
    expect(await shotIds({ ...among, rating: "2" })).toEqual(["rated-10", "rated-8", "rated-7", "rated-4"]);
    expect(await shotIds({ ...among, rating: "3" })).toEqual(["rated-10", "rated-8", "rated-7"]);
    expect(await shotIds({ ...among, rating: "4" })).toEqual(["rated-10", "rated-8"]);
    expect(await shotIds({ ...among, rating: "5" })).toEqual(["rated-10"]);
    // Beside the list's other filters.
    expect(await shotIds({ rating: "5", locationId: east.id })).toEqual([]);
  });

  it("summarises the Shots a rating filter finds", async () => {
    type Summary = { groups: { counts: { shots: number }; numbers: { rating: { shots: number; median: number | null; rated: number | null } } }[] };
    const summary = async (rating: string) =>
      (await api.get<Summary>(`/shots/summary?${new URLSearchParams({ machineId: machines.roaming.machine.id, to: "2026-02-10", numbers: "rating", rating })}`)).groups[0]!;
    expect(await summary("rated")).toMatchObject({ counts: { shots: 5 }, numbers: { rating: { shots: 5, median: 7, rated: 1 } } });
    expect(await summary("unrated")).toMatchObject({ counts: { shots: 2 }, numbers: { rating: { shots: 0, median: null, rated: 0 } } });
    expect(await summary("4")).toMatchObject({ counts: { shots: 2 }, numbers: { rating: { shots: 2, median: 9, rated: 1 } } });
  });

  it("follows a rating edited through the server at once", async () => {
    const among = { machineId: machines.roaming.machine.id, to: "2026-02-10" };
    await api.send("PATCH", "/shots/rated-none", { rating: 10 });
    expect(await shotIds({ ...among, rating: "5" })).toEqual(["rated-10", "rated-none"]);
    expect(await shotIds({ ...among, rating: "unrated" })).toEqual(["rated-0"]);
    // Cleared, it is not rated again.
    await api.send("PATCH", "/shots/rated-none", { rating: 0 });
    expect(await shotIds({ ...among, rating: "5" })).toEqual(["rated-10"]);
    expect(await shotIds({ ...among, rating: "unrated" })).toEqual(["rated-0", "rated-none"]);
  });

  it("refuses a rating it cannot read", async () => {
    const refused = { status: 400, message: ["Enter rating as rated, unrated, or a least number of stars from 2 to 5"] };
    for (const rating of ["1", "6", "great", ""]) expect(await problem(`/shots?rating=${rating}`), rating).toEqual(refused);
    expect(await problem("/shots/summary?rating=1")).toEqual(refused);
    expect(await problem("/shots?rating=rated&rating=5")).toEqual({ status: 400, message: ["Give rating once"] });
  });

  it("lists the Shots of a period by each Shot's own Location's days, counted back from its own today", async () => {
    for (const period of Object.keys(PERIODS) as Period[]) {
      const { answer, expected } = await readInPeriod(period, () => shotIds({ period }));
      expect(answer, period).toEqual(expected);
    }
    // Today holds the Shot pulled now at each site, though no two of them are on the same date, and not the one pulled
    // a minute before each site's midnight; the 7 days hold each site's sixth day back and not its seventh. A site whose
    // midnight has passed since its Shot was pulled has it in yesterday, which the periods above followed: the sites'
    // midnights are hours apart, so at most one has.
    const { answer: today } = await readInPeriod("today", () => shotIds({ period: "today" }));
    expect(today.filter((id) => id.endsWith("-now")).length).toBeGreaterThanOrEqual(2);
    expect(new Set(["east", "west", "roaming"].map((site) => Temporal.Now.plainDateISO(sites[site as Site].timeZone).toString())).size).toBeGreaterThan(1);

    // Beside the list's other filters, and in a summary.
    const atEast = await readInPeriod("7days", () => shotIds({ period: "7days", locationId: east.id }), (record) => record.id.startsWith("east-"));
    expect(atEast.answer).toEqual(atEast.expected);
    const summarised = await readInPeriod("30days", () => api.get<{ groups: { counts: { shots: number } }[] }>("/shots/summary?period=30days"));
    expect(summarised.answer.groups[0]!.counts.shots).toBe(summarised.expected.length);
  });

  it("lists the Steam Records of a period the same way", async () => {
    for (const period of Object.keys(PERIODS) as Period[]) {
      const { answer, expected } = await readInPeriod(period, () => steamIds({ period }));
      expect(answer, period).toEqual(expected.map((id) => `steam-${id}`));
    }
  });

  it("refuses a period it cannot read, and one given beside a date", async () => {
    for (const path of ["/shots", "/shots/summary", "/steam-records"]) {
      expect(await problem(`${path}?period=tomorrow`), path).toEqual({ status: 400, message: ["Enter period as today, yesterday, 7days or 30days"] });
      for (const dates of ["from=2026-02-10", "to=2026-02-10"]) {
        expect(await problem(`${path}?period=today&${dates}`), path).toEqual({ status: 400, message: ["Give a period, or from and to, not both"] });
      }
      expect(await problem(`${path}?period=today&period=yesterday`), path).toEqual({ status: 400, message: ["Give period once"] });
    }
  });

  it("finds and summarises Shots through an assistant by rating and by period, as the REST API does", async () => {
    type Found = { shots: { id: string }[]; total: number };
    const among = { machineId: machines.roaming.machine.id, to: "2026-02-10" };
    for (const rating of ["rated", "unrated", "2", "3", "4", "5"]) {
      const found = await assistant.call<Found>("find_shots", { ...among, rating });
      expect(found.shots.map((shot) => shot.id), rating).toEqual(await shotIds({ ...among, rating }));
      expect(found.total, rating).toBe(found.shots.length);
      const summarised = await assistant.call("summarise_shots", { ...among, rating, numbers: ["rating"] });
      expect(summarised, rating).toEqual(toolSummary(await api.get(`/shots/summary?${new URLSearchParams({ ...among, rating, numbers: "rating", match: "words" })}`)));
    }
    for (const period of Object.keys(PERIODS) as Period[]) {
      const found = await readInPeriod(period, () => assistant.call<Found>("find_shots", { period, limit: 50 }));
      expect(found.answer.shots.map((shot) => shot.id), period).toEqual(found.expected);
      const summarised = await readInPeriod(period, () => assistant.call<{ groups: { counts: { shots: number } }[] }>("summarise_shots", { period }));
      expect(summarised.answer.groups[0]!.counts.shots, period).toBe(summarised.expected.length);
      const steamed = await readInPeriod(period, () => assistant.call<{ steamRecords: { id: string }[] }>("find_steam_records", { period, limit: 50 }));
      expect(steamed.answer.steamRecords.map((steam) => steam.id), period).toEqual(steamed.expected.map((id) => `steam-${id}`));
    }
    // A period stands in place of a time range, whether that is a date or a moment.
    for (const tool of ["find_shots", "summarise_shots", "find_steam_records"]) {
      expect(await toolError(tool, { period: "today", from: "2026-02-10" }), tool).toContain("Give a period, or from and to, not both");
      expect(await toolError(tool, { period: "today", to: "2026-02-10T12:00:00Z" }), tool).toContain("Give a period, or from and to, not both");
    }
  });
});
