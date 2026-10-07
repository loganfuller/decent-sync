import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine } from "./support/admin-api.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { derivedShot, shotFixture, withShots } from "./support/shot-fixtures.js";
import { RawConnection, SimulatedTablet, derivedDe1Pro, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1: built plugin, real PostgreSQL, and public REST assertions. Every
// history/annotation/hardware variant is derived from a scrubbed real record.
/**
 * The advisory lock class for one Shot id in server/src/shots/shots.service.ts,
 * held here to hold up storing a Shot. Each test waits until storage waits for
 * it, so a test whose lock no longer matches the server's fails.
 */
const SHOT_LOCK = 4_000_003;
interface ShotView {
  id: string; machineId: string | null; pendingMachineId: string | null; machineInferred: boolean;
  pulledAt: string | null; actualDose: number | null; actualYield: number | null; enjoyment: number | null;
  profileTitle: string | null; duration: number | null; peakPressure: number | null;
  record?: Record<string, unknown>;
}
/** A frame the plugin sent or received, as far as these tests read it. */
interface Frame { type?: string; id?: string; shotId?: string; shots?: { id: string }[] }

describe("Shot capture and reconciliation", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(tablets.splice(0).map((tablet) => tablet.unload()));
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => { await other?.stop(); await server?.stop(); });

  function shot(id: string, changes: Record<string, unknown> = {}) {
    const fixture = shotFixture();
    const { machine, ...workflow } = fixture.workflow as Record<string, unknown>;
    return derivedShot(id, { workflow, ...changes });
  }
  function tabletApi(machine: CreatedMachine) { return derivedDe1Pro({ serial: machine.machine.id.replaceAll("-", "") }); }
  function load(machine: CreatedMachine, shots: Record<string, unknown>[], options = {}) {
    const tablet = SimulatedTablet.load({ settings: settingsFor(machine), api: withShots(tabletApi(machine), shots), timeScale: 50, ...options });
    tablets.push(tablet);
    return tablet;
  }
  /** Shots one second apart, oldest first, ids suffixed with their position. */
  function timeline(prefix: string, count: number) {
    return Array.from({ length: count }, (_, n) => shot(`${prefix}-${n}`, { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() }));
  }
  function pages(...offsets: number[]) { return offsets.map((offset) => ({ limit: 100, offset })); }
  /** The ids of the full Shot records the plugin sent, from its `from`th frame on, in order. */
  function fullRecordsSent(tablet: SimulatedTablet, from = 0): string[] {
    return tablet.sent.slice(from).flatMap((frame) => ((frame as Frame).type === "shot" ? [String((frame as Frame).shotId)] : []));
  }
  /**
   * Changes the tablet's Shots as the plugin requests the numbered summary
   * pages (the first is 0), before each is answered: each change is given
   * the Shots served, newest first, and returns those served from then on.
   */
  function changeShotsBeforePages(
    tablet: SimulatedTablet, machine: CreatedMachine, initial: Record<string, unknown>[],
    changes: [page: number, change: (shots: Record<string, unknown>[]) => Record<string, unknown>[]][],
  ) {
    let shots = [...initial].reverse();
    tablet.beforeShotPage = () => {
      const change = changes.find(([page]) => page === tablet.shotPageRequests.length - 1)?.[1];
      if (!change) return;
      shots = change(shots);
      tablet.serve(withShots(tabletApi(machine), shots));
    };
  }
  async function storedIds(machineId: string): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await (await api.call("GET", `/shots?limit=100&offset=${offset}&machineId=${machineId}`)).json()) as { shots: ShotView[] };
      ids.push(...page.shots.map((shot) => shot.id));
      if (page.shots.length < 100) return ids;
    }
  }
  async function list(machineId?: string, at = api): Promise<{ shots: ShotView[]; total: number }> {
    const response = await at.call("GET", `/shots?limit=100${machineId ? `&machineId=${machineId}` : ""}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ shots: ShotView[]; total: number }>;
  }
  async function detail(id: string, at = api): Promise<ShotView> {
    const response = await at.call("GET", `/shots/${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { shot: ShotView }).shot;
  }
  async function measurements(id: string) {
    return ((await (await api.call("GET", `/shots/${encodeURIComponent(id)}/measurements`)).json()) as { measurements: unknown }).measurements;
  }
  async function connect(machine: CreatedMachine, url = server.url, hardware?: { model: string; serial: string }) {
    const raw = await RawConnection.welcomed(url, helloWith(machine.token, hardware ? { machine: hardware } : {}));
    raws.push(raw);
    return raw;
  }
  async function deliver(raw: RawConnection, record: Record<string, unknown>, type = "shot", id = randomUUID()) {
    await raw.deliver({ type, id, shotId: String(record.id), shot: record });
    return id;
  }
  async function waitShot(id: string, matches: (shot: ShotView) => boolean = () => true) {
    await expect.poll(async () => {
      const response = await api.call("GET", `/shots/${encodeURIComponent(id)}`);
      return response.ok && matches(((await response.json()) as { shot: ShotView }).shot);
    }, { timeout: 10_000 }).toBe(true);
    return detail(id);
  }

  it("validates pagination", async () => {
    for (const query of ["limit=0", "limit=101", "offset=-1", "limit=1.2"]) expect((await api.call("GET", `/shots?${query}`)).status).toBe(400);
  });

  it("backfills an adopted tablet's entire history in bounded pages, including after a mid-backfill disconnect", async () => {
    const machine = await api.createMachine("History");
    const history = Array.from({ length: 205 }, (_, n) => shot(`history-${n}`, { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() }));
    const tablet = load(machine, history, { apiDelayMs: 500 });
    await expect.poll(async () => (await list(machine.machine.id)).total, { timeout: 10_000 }).toBeGreaterThan(0);
    expect((await list(machine.machine.id)).total).toBeLessThan(history.length);
    const acknowledged = new Set(tablet.received.flatMap((message) => ((message as Frame).type === "ack" ? [(message as Frame).id] : [])));
    const sentBefore = tablet.sent.length;
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    await expect.poll(async () => (await list(machine.machine.id, api.at(other.url))).total, { timeout: 20_000 }).toBe(205);
    expect(tablet.shotPageRequests).toEqual(pages(0, 90, 180));
    expect(tablet.requests).not.toContain("/shots/ids");
    // The scan's index went once, each Shot in one page under one delivery id: after the reconnect,
    // only a page cut off before its acknowledgment was sent again.
    const indexPages = (frames: unknown[]) => (frames as Frame[]).filter((frame) => frame.type === "shotIndex");
    const indexed = new Map(indexPages(tablet.sent).map((page) => [page.id, page.shots!.map((shot) => shot.id)]));
    expect([...indexed.values()].flat().sort()).toEqual(history.map((shot) => String(shot.id)).sort());
    expect(indexPages(tablet.sent.slice(sentBefore)).filter((page) => acknowledged.has(page.id))).toEqual([]);
    const first = await list(machine.machine.id);
    expect(first.shots[0]!.id).toBe("history-204");
    const lastPage = await (await api.call("GET", `/shots?limit=100&offset=200&machineId=${machine.machine.id}`)).json() as { shots: ShotView[] };
    expect(lastPage.shots).toHaveLength(5);
    expect(new Set([...first.shots, ...lastPage.shots].map((shot) => shot.id)).size).toBe(105);
  }, 30_000);

  it("indexes the oldest Shot when a Shot already read is deleted before the next page", async () => {
    const machine = await api.createMachine("Deleted mid-scan");
    const history = timeline("deleted-mid-scan", 101);
    const tablet = load(machine, history);
    changeShotsBeforePages(tablet, machine, history, [[1, (shots) => shots.filter((shot) => shot.id !== "deleted-mid-scan-50")]]);
    await waitShot("deleted-mid-scan-0");
    expect(tablet.shotPageRequests).toEqual(pages(0, 90));
  });

  it("indexes every Shot that outlasts a scan through deletions on several pages and Shots added meanwhile", async () => {
    const machine = await api.createMachine("Changing mid-scan");
    const history = timeline("changing-mid-scan", 250);
    const deleted = ["changing-mid-scan-240", "changing-mid-scan-200", "changing-mid-scan-120"];
    // Pulled during the scan: Decaid reports each in a shotStored event.
    const added = (id: string) => {
      tablet.fire("shotStored", { id });
      return shot(id, { timestamp: "2026-02-01T00:00:00.000Z" });
    };
    const tablet = load(machine, history);
    changeShotsBeforePages(tablet, machine, history, [
      [1, (shots) => [added("changing-mid-scan-added-1"), ...shots.filter((shot) => shot.id !== deleted[0] && shot.id !== deleted[1])]],
      [2, (shots) => [added("changing-mid-scan-added-2"), ...shots.filter((shot) => shot.id !== deleted[2])]],
    ]);
    const outlasting = history.map((shot) => String(shot.id)).filter((id) => !deleted.includes(id));
    await expect.poll(() => storedIds(machine.machine.id), { timeout: 20_000 }).toEqual(expect.arrayContaining(outlasting));
    expect(tablet.shotPageRequests).toEqual(pages(0, 90, 180));
  }, 30_000);

  it("resumes after a Shot read unchanged, not one whose time was edited to sort among unread Shots", async () => {
    const machine = await api.createMachine("Retimed mid-scan");
    const history = timeline("retimed-mid-scan", 150);
    const tablet = load(machine, history);
    // The newest Shot, read on the first page, edited to sort between the fifth and fourth oldest; Decaid gives it a new edit time.
    const retimed = { timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 4, 500)).toISOString(), updatedAt: "2026-11-01T12:00:00.000000Z" };
    changeShotsBeforePages(tablet, machine, history, [[1, (shots) => shots.map((shot) => (shot.id === "retimed-mid-scan-149" ? { ...shot, ...retimed } : shot))]]);
    await expect.poll(() => storedIds(machine.machine.id), { timeout: 20_000 }).toEqual(expect.arrayContaining(history.map((shot) => String(shot.id))));
    expect(tablet.shotPageRequests).toEqual(pages(0, 90));
  }, 30_000);

  it("rescans when an import moves a Shot not yet read among those already read, reporting nothing", async () => {
    const machine = await api.createMachine("Imported mid-scan");
    const history = timeline("imported-mid-scan", 150);
    const tablet = load(machine, history);
    // The oldest Shot, overwritten by an import with a time newer than every other: Decaid gives it a new edit time and fires no event.
    const imported = { timestamp: "2026-02-01T00:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000000Z" };
    changeShotsBeforePages(tablet, machine, history, [[1, (shots) => shots.map((shot) => (shot.id === "imported-mid-scan-0" ? { ...shot, ...imported } : shot))]]);
    await expect.poll(() => storedIds(machine.machine.id), { timeout: 20_000 }).toEqual(expect.arrayContaining(history.map((shot) => String(shot.id))));
    expect(tablet.shotPageRequests).toEqual(pages(0, 90, 0, 90));
  }, 30_000);

  it("rescans when more Shots than the pages overlap are deleted between two pages", async () => {
    const machine = await api.createMachine("Many deleted mid-scan");
    const history = timeline("many-deleted-mid-scan", 150);
    const tablet = load(machine, history);
    changeShotsBeforePages(tablet, machine, history, [[1, (shots) => shots.slice(20)]]);
    await expect.poll(() => storedIds(machine.machine.id), { timeout: 20_000 }).toEqual(expect.arrayContaining(history.slice(0, -20).map((shot) => String(shot.id))));
    expect(tablet.shotPageRequests).toEqual(pages(0, 90, 0, 90));
    expect(tablet.logs.join("\n")).not.toMatch(/kept changing/);
  }, 30_000);

  it("bounds the scan's requests while Shots keep changing, leaving the rest to the next load", async () => {
    const deleting = await api.createMachine("Deleting throughout");
    const history = timeline("deleting-throughout", 150);
    const tablet = load(deleting, history);
    changeShotsBeforePages(tablet, deleting, history, [1, 3, 5].map((page) => [page, (shots) => shots.slice(20)]));
    await tablet.waitForLog(/kept changing/);
    expect(tablet.shotPageRequests).toEqual(pages(0, 90, 0, 90, 0, 90));

    // Shots added faster than the pages advance exhaust the requests the first page's total allows.
    const adding = await api.createMachine("Adding throughout");
    const older = timeline("adding-throughout", 150);
    const growing = load(adding, older);
    const newer = (page: number) => Array.from({ length: 100 }, (_, n) => shot(`adding-throughout-${page}-${n}`, { timestamp: new Date(Date.UTC(2026, 1, page, 0, 0, n)).toISOString() }));
    changeShotsBeforePages(growing, adding, older, [1, 2, 3].map((page) => [page, (shots) => [...newer(page), ...shots]]));
    const indexed = () => growing.sent.flatMap((frame) => {
      const message = frame as { type?: string; shots?: { id: string }[] };
      return message.type === "shotIndex" ? message.shots!.map((shot) => shot.id) : [];
    });
    await expect.poll(indexed, { timeout: 10_000 }).toEqual(expect.arrayContaining(older.map((shot) => String(shot.id))));
    await expect.poll(() => growing.shotPageRequests.length).toBe(9);
    expect(growing.shotPageRequests).toEqual(pages(0, 90, 180, 270, 0, 90, 180, 270, 360));
    expect(growing.logs.join("\n")).not.toMatch(/kept changing/);
  }, 30_000);

  it("captures shotStored and shotUpdated, keeps curves intact, and adds the last Shot to Machine status", async () => {
    const machine = await api.createMachine("Live Shots");
    const tablet = load(machine, []);
    await tablet.waitForLog(/^Connected to /);
    const record = shot("live-shot", { timestamp: "2026-11-01T12:00:00Z" });
    tablet.serve(withShots(tabletApi(machine), [record]));
    tablet.fire("shotStored", { id: record.id });
    expect(await waitShot(String(record.id))).toMatchObject({ profileTitle: "Londonium", actualDose: 18, actualYield: 35.9, duration: 27.935, peakPressure: expect.any(Number) });
    const curves = await measurements(String(record.id));
    expect(curves).toEqual(record.measurements);
    const { measurements: omitted, ...summary } = record;
    tablet.fire("shotUpdated", { id: record.id, shot: { ...summary, updatedAt: "2026-11-01T12:01:00Z", annotations: { actualDoseWeight: 19, actualYield: 39, enjoyment: 90, espressoNotes: "Fixture edit" } } });
    expect(await waitShot(String(record.id), (shot) => shot.enjoyment === 90)).toMatchObject({ actualDose: 19, actualYield: 39 });
    expect(await measurements(String(record.id))).toEqual(curves);
    tablet.fire("shotUpdated", { id: record.id, shot: { ...summary, updatedAt: "2026-11-01T12:02:00Z", annotations: {} } });
    expect(await waitShot(String(record.id), (shot) => shot.enjoyment === null)).toMatchObject({ actualDose: null, actualYield: null });
    expect((await detail(String(record.id))).record!.annotations).toEqual({});
    expect(await measurements(String(record.id))).toEqual(curves);
    expect((await api.machineNamed("Live Shots"))!.lastShot).toEqual({ id: record.id, pulledAt: "2026-11-01T12:00:00.000Z" });
  });

  it("holds only the ids of Shots stored while the server is unreachable, then sends them ahead of requested backfill", async () => {
    const machine = await api.createMachine("Unreachable");
    const history = timeline("unreachable-history", 3);
    // The first full record sent stays unwritten, so the rest of the history stays requested.
    let stalled = true;
    const tablet = load(machine, history, { stallUpload: (frame: unknown) => stalled && (frame as Frame).type === "shot" });
    await expect.poll(() => fullRecordsSent(tablet).length, { timeout: 10_000 }).toBe(1);
    const [cutOff] = fullRecordsSent(tablet);
    tablet.loseNetwork();
    const pulled = [shot("unreachable-a", { timestamp: "2026-02-01T00:00:00Z" }), shot("unreachable-b", { timestamp: "2026-02-01T00:01:00Z" })];
    tablet.serve(withShots(tabletApi(machine), [...history, ...pulled]));
    for (const record of pulled) tablet.fire("shotStored", { id: record.id });
    await tablet.waitForLogs(/^Disconnected: could not connect/, 2);
    expect(tablet.requests.filter((path) => pulled.some((record) => path === `/shots/${record.id}`))).toEqual([]);

    const sentBefore = tablet.sent.length;
    stalled = false;
    tablet.restoreNetwork();
    for (const record of [...pulled, ...history]) {
      await waitShot(String(record.id));
      expect(await measurements(String(record.id))).toEqual(record.measurements);
    }
    // The record cut off by the drop goes first, then the Shots new on the tablet, newest first, then the rest of the backfill.
    const sent = [...new Set(fullRecordsSent(tablet, sentBefore))];
    expect(sent.slice(0, 3)).toEqual([cutOff, "unreachable-b", "unreachable-a"]);
    expect(sent.slice(3).sort()).toEqual(history.map((record) => String(record.id)).filter((id) => id !== cutOff).sort());
    expect(tablet.shotPageRequests).toHaveLength(1);
  }, 20_000);

  it("skips a Shot deleted on the tablet before the server is reachable again, holding up nothing", async () => {
    const machine = await api.createMachine("Deleted while unreachable");
    const tablet = load(machine, []);
    await tablet.waitForLog(/^Connected to /);
    tablet.loseNetwork();
    const kept = shot("kept-while-unreachable", { timestamp: "2026-02-01T00:00:00Z" });
    const deleted = shot("deleted-while-unreachable", { timestamp: "2026-02-01T00:01:00Z" });
    tablet.serve(withShots(tabletApi(machine), [kept, deleted]));
    // The newer request is read first.
    tablet.fire("shotStored", { id: kept.id });
    tablet.fire("shotStored", { id: deleted.id });
    tablet.serve(withShots(tabletApi(machine), [kept]));
    await tablet.waitForLog(/^Disconnected: could not connect/);
    tablet.restoreNetwork();
    await waitShot(String(kept.id));
    expect(tablet.requests.indexOf(`/shots/${deleted.id}`)).toBeGreaterThanOrEqual(0);
    expect(tablet.requests.indexOf(`/shots/${deleted.id}`)).toBeLessThan(tablet.requests.indexOf(`/shots/${kept.id}`));
    const later = shot("after-deleted-while-unreachable");
    tablet.serve(withShots(tabletApi(machine), [kept, later]));
    tablet.fire("shotStored", { id: later.id });
    await waitShot(String(later.id));
    expect(tablet.sent.some((frame) => (frame as Frame).shotId === deleted.id)).toBe(false);
    expect((await api.call("GET", `/shots/${deleted.id}`)).status).toBe(404);
  });

  it("keeps an edit that reaches the server before its Shot's full record, with the record's curves and its recorded hardware's credit", async () => {
    const owner = await api.createMachine("Edited Shots' machine");
    await (await connect(owner, server.url, { model: "DE1Pro", serial: "60001" })).close();
    const reporter = await api.createMachine("Edited Shots' tablet");
    const tablet = load(reporter, []);
    await tablet.waitForLog(/^Connected to /);
    const workflow = shotFixture().workflow as Record<string, unknown>;
    const recordedOn60001 = (id: string) => derivedShot(id, { workflow: { ...workflow, machine: { ...(workflow.machine as object), serialNumber: "60001" } } });
    const annotations = { enjoyment: 88, espressoNotes: "Edited before it was sent" };
    const served: Record<string, unknown>[] = [];
    /** Stores a Shot, then edits it through Decaid's API, which then serves the edit and reports its metadata. */
    const storeAndEdit = (record: Record<string, unknown>) => {
      served.push(record);
      tablet.serve(withShots(tabletApi(reporter), served));
      tablet.fire("shotStored", { id: record.id });
      const edited: Record<string, unknown> = { ...record, updatedAt: "2026-11-01T12:00:00.000000Z", annotations };
      served[served.length - 1] = edited;
      tablet.serve(withShots(tabletApi(reporter), served));
      const { measurements: omitted, ...metadata } = edited;
      tablet.fire("shotUpdated", { id: record.id, shot: metadata });
    };

    tablet.loseNetwork();
    const unreachable = recordedOn60001("edited-while-unreachable");
    storeAndEdit(unreachable);
    await tablet.waitForLog(/^Disconnected: could not connect/);
    tablet.restoreNetwork();
    await tablet.waitForLogs(/^Connected to /, 2);
    const connected = recordedOn60001("edited-while-connected");
    storeAndEdit(connected);

    for (const record of [unreachable, connected]) {
      const id = String(record.id);
      expect(await waitShot(id, (shot) => shot.enjoyment === 88)).toMatchObject({
        machineId: owner.machine.id, pendingMachineId: null, machineInferred: false, pulledAt: expect.any(String), duration: 27.935,
      });
      expect((await detail(id)).record!.annotations).toEqual(annotations);
      expect(await measurements(id)).toEqual(record.measurements);
      // An edit is queued as it is reported, and the full record only once read, which waits for a connection and
      // nothing else queued, and takes a request to Decaid's API, during which an edit reported meanwhile goes ahead.
      expect([...new Set(tablet.sent.flatMap((frame) => ((frame as Frame).shotId === id ? [(frame as Frame).type] : [])))]).toEqual(["shotUpdated", "shot"]);
    }
  });

  it("recovers edits made while unloaded, but a reconnect in one runtime repeats no summary scan", async () => {
    const machine = await api.createMachine("Reload");
    const record = shot("reload-shot");
    const tablet = load(machine, [record]);
    await waitShot(String(record.id));
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    expect(tablet.shotPageRequests).toEqual([{ limit: 100, offset: 0 }]);
    await tablet.unload();
    const edited = { ...record, updatedAt: "2026-11-01T12:02:00Z", annotations: { enjoyment: 80, actualDoseWeight: 20 } };
    const reload = load(machine, [edited]);
    expect(await waitShot(String(record.id), (shot) => shot.enjoyment === 80)).toMatchObject({ actualDose: 20 });
    expect(reload.shotPageRequests).toEqual([{ limit: 100, offset: 0 }]);
    expect(await measurements(String(record.id))).toEqual(record.measurements);
  });

  it("resends an edit left unacknowledged across reconnect", async () => {
    const machine = await api.createMachine("Outbox");
    const record = shot("outbox-shot");
    const tablet = load(machine, [record]);
    await waitShot(String(record.id));
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query(`SELECT pg_advisory_xact_lock(${SHOT_LOCK}::int, hashtext($1::text))`, [record.id]);
      const { measurements: omitted, ...summary } = record;
      tablet.fire("shotUpdated", { id: record.id, shot: { ...summary, updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 72 } } });
      await waitForLockWaits(server, { advisory: true });
      tablet.dropConnections();
      await database.query("ROLLBACK");
    } finally { await database.end(); }
    await tablet.waitForLogs(/^Connected to /, 2);
    await waitShot(String(record.id), (shot) => shot.enjoyment === 72);
    expect(tablet.shotPageRequests).toHaveLength(1);
  });

  it("retries transient local API failures during backfill and live capture", async () => {
    const machine = await api.createMachine("API retry");
    const record = shot("retry-backfill");
    const tablet = load(machine, [record]);
    tablet.failNextApiReads(`/shots/${record.id}`, 1);
    await waitShot(String(record.id));
    expect(tablet.requests.filter((path) => path === `/shots/${record.id}`)).toHaveLength(2);
    const live = shot("retry-live");
    tablet.serve(withShots(tabletApi(machine), [record, live]));
    tablet.failNextApiReads(`/shots/${live.id}`, 1);
    tablet.fire("shotStored", { id: live.id });
    await waitShot(String(live.id));
    expect(tablet.requests.filter((path) => path === `/shots/${live.id}`)).toHaveLength(2);
    expect(tablet.shotPageRequests).toHaveLength(1);
    // Each failed read says what failed; no delivery was interrupted.
    for (const { id } of [record, live]) expect(tablet.logs).toContain(`Could not read Shot ${String(id)} from Decaid; retrying it after the other requested records.`);
    expect(tablet.logs.join("\n")).not.toMatch(/Delivery interrupted/);
  });

  it("keeps retrying an unreadable Shot behind the other requested Shots", async () => {
    const machine = await api.createMachine("Unreadable");
    // The newest Shot is indexed, and so requested, first.
    const unreadable = shot("unreadable-shot", { timestamp: "2026-03-01T12:00:00Z" });
    const others = [shot("readable-a", { timestamp: "2026-02-01T12:00:00Z" }), shot("readable-b", { timestamp: "2026-01-01T12:00:00Z" })];
    const tablet = load(machine, [unreadable, ...others]);
    tablet.failNextApiReads(`/shots/${unreadable.id}`, 1_000);
    for (const other of others) await waitShot(String(other.id));
    tablet.failNextApiReads(`/shots/${unreadable.id}`, 0);
    await waitShot(String(unreadable.id));
  });

  it("ignores Decaid's imports from the legacy de1app in history and live events", async () => {
    const machine = await api.createMachine("Legacy imports");
    const legacy = shot("de1app-1790428090", { timestamp: "2026-09-26T13:08:10.000Z" });
    const native = shot("native-beside-legacy");
    const tablet = load(machine, [legacy, native]);
    await waitShot(String(native.id));
    const later = shot("native-after-legacy");
    tablet.serve(withShots(tabletApi(machine), [legacy, native, later]));
    tablet.fire("shotStored", { id: legacy.id });
    const { measurements: omitted, ...legacySummary } = legacy;
    tablet.fire("shotUpdated", { id: legacy.id, shot: { ...legacySummary, updatedAt: "2026-11-01T12:00:00Z" } });
    // Events are handled in order, so the legacy ones are done once this arrives.
    tablet.fire("shotStored", { id: later.id });
    await waitShot(String(later.id));
    expect(tablet.requests).not.toContain(`/shots/${legacy.id}`);
    expect(JSON.stringify(tablet.sent)).not.toContain(String(legacy.id));
    expect((await api.call("GET", `/shots/${legacy.id}`)).status).toBe(404);
  });

  it("lists Shots while the measurements table is unavailable, without reading curves", async () => {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query("LOCK TABLE shot_measurements IN ACCESS EXCLUSIVE MODE");
      // Reading curves would wait for the lock until it is released, so any answer at all shows the list read none.
      const response = await Promise.race([
        api.call("GET", "/shots"),
        new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Shots list waited on measurements")), 5_000); timer.unref(); }),
      ]);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { total: number }).total).toBeGreaterThan(0);
    } finally { await database.query("ROLLBACK"); await database.end(); }
  }, 10_000);

  it("keeps Shots deleted on the tablet and never includes measurements or metadata in a list", async () => {
    const machine = await api.createMachine("Deletion");
    const record = shot("deleted-shot");
    const tablet = load(machine, [record]);
    await waitShot(String(record.id));
    tablet.serve(tabletApi(machine));
    await tablet.unload();
    const reload = load(machine, []);
    await reload.waitForLog(/^Connected to /);
    expect((await list(machine.machine.id)).shots).toEqual([expect.objectContaining({ id: record.id })]);
    const listed = (await list(machine.machine.id)).shots[0]!;
    expect(listed).not.toHaveProperty("record");
    expect(listed).not.toHaveProperty("measurements");
    expect((await detail(String(record.id))).record).not.toHaveProperty("measurements");
    expect(await measurements(String(record.id))).toEqual(record.measurements);
  });

  it("de-duplicates envelope ids within a session and keeps the first record at an equal version", async () => {
    const machine = await api.createMachine("Replays");
    const raw = await connect(machine);
    const record = shot("replay-shot");
    const id = await deliver(raw, record);
    raw.send({ type: "shotUpdated", id, shotId: record.id, shot: { ...record, updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 1 } } });
    await expect.poll(() => raw.messages.filter((m) => (m as { type: string; id: string }).type === "ack" && (m as { id: string }).id === id).length).toBe(2);
    expect((await detail(String(record.id))).enjoyment).toBeNull();
    await deliver(raw, { ...record, annotations: { enjoyment: 2 } });
    expect((await detail(String(record.id))).enjoyment).toBeNull();
    await deliver(raw, shot("out-of-order-b", { timestamp: "2026-01-01T12:00:00Z" }));
    await deliver(raw, shot("out-of-order-a", { timestamp: "2026-01-02T12:00:00Z" }));
    expect((await list(machine.machine.id)).total).toBe(3);
  });

  it("persists an edit before its full record across instances, then keeps the edit, including cleared fields, with the older record's curves", async () => {
    const machine = await api.createMachine("Early edit");
    const record = shot("early-edit");
    const { measurements: omitted, ...summary } = record;
    const raw = await connect(machine);
    await deliver(raw, { ...summary, updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 92, actualYield: 40 } }, "shotUpdated");
    expect((await api.call("GET", `/shots/${record.id}`)).status).toBe(404);
    const replacement = await connect(machine, other.url);
    await deliver(replacement, record);
    expect(await detail(String(record.id))).toMatchObject({ enjoyment: 92, actualDose: null, actualYield: 40, profileTitle: "Londonium", duration: 27.935 });
    expect(await measurements(String(record.id))).toEqual(record.measurements);
    expect((await list(machine.machine.id)).total).toBe(1);
  });

  it("acknowledges only after storage completes", async () => {
    const machine = await api.createMachine("Delayed ack");
    const raw = await connect(machine);
    const database = await server.connectDatabase();
    const id = "delayed-envelope";
    try {
      await database.query("BEGIN");
      await database.query(`SELECT pg_advisory_xact_lock(${SHOT_LOCK}::int, hashtext('delayed-shot'))`);
      raw.send({ type: "shot", id, shotId: "delayed-shot", shot: shot("delayed-shot") });
      await waitForLockWaits(server, { advisory: true });
      expect(raw.messages.some((m) => (m as { id?: string }).id === id)).toBe(false);
      expect((await api.call("GET", "/shots/delayed-shot")).status).toBe(404);
      await database.query("COMMIT");
    } finally { await database.end(); }
    await expect.poll(() => raw.messages.some((m) => (m as { id?: string }).id === id)).toBe(true);
    await detail("delayed-shot");
  });

  it("credits known hardware, holds unknown hardware once, and restores dismissed Shots on adoption", async () => {
    const owner = await api.createMachine("Recorded hardware");
    const ownerRaw = await connect(owner, other.url, { model: "DE1Pro", serial: "10001" });
    const reporter = await api.createMachine("Reporting tablet");
    const tablet = load(reporter, [derivedShot("known-hardware")]);
    expect(await waitShot("known-hardware")).toMatchObject({ machineId: owner.machine.id, machineInferred: false });
    const workflow = shotFixture().workflow as Record<string, unknown>;
    const unknown = derivedShot("unknown-hardware", { workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: "30001" } } });
    tablet.serve(withShots(tabletApi(reporter), [unknown]));
    tablet.fire("shotStored", { id: unknown.id });
    const held = await waitShot(String(unknown.id));
    expect(held).toMatchObject({ machineId: null, machineInferred: false, pendingMachineId: expect.any(String) });
    const dismissed = await api.call("POST", `/pending-machines/${held.pendingMachineId}/dismiss`);
    expect(dismissed.status).toBe(200);
    expect((await list()).shots.map((shot) => shot.id)).not.toContain(unknown.id);
    expect((await api.call("GET", `/shots/${unknown.id}/measurements`)).status).toBe(404);
    const adopted = await api.issued(await api.call("POST", `/pending-machines/${held.pendingMachineId}/machine`, { name: "Restored hardware" }));
    expect(await detail(String(unknown.id))).toMatchObject({ machineId: adopted.machine.id, pendingMachineId: null });
    expect(await measurements(String(unknown.id))).toEqual(unknown.measurements);
    expect((await list(adopted.machine.id)).shots).toHaveLength(1);
    await ownerRaw.close();
  });

  it("keeps a Shot's credit when a newer full record arrives through another Machine", async () => {
    const first = await api.createMachine("First reporter");
    const second = await api.createMachine("Second reporter");
    const record = shot("credited-once");
    await deliver(await connect(first), record);
    await deliver(await connect(second, other.url), { ...record, updatedAt: "2026-11-01T12:00:00Z", annotations: { enjoyment: 77 } });
    expect(await detail(String(record.id))).toMatchObject({ machineId: first.machine.id, machineInferred: true, enjoyment: 77 });
  });

  it("uses inferred reporting credit for missing machine, serial zero and unavailable provenance", async () => {
    const machine = await api.createMachine("Inferred");
    const workflow = shotFixture().workflow as Record<string, unknown>;
    const records = [
      shot("inferred-no-hardware"),
      derivedShot("inferred-zero", { workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: "0" } } }),
      derivedShot("inferred-unavailable", { workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: "10001", provenanceStatus: "unavailable" } } }),
    ];
    load(machine, records);
    for (const record of records) expect(await waitShot(String(record.id))).toMatchObject({ machineId: machine.machine.id, machineInferred: true });
  });

  it("captures an identity mismatch against its Pending hardware and preserves it on resolution", async () => {
    const machine = await api.createMachine("Mismatch capture");
    await (await connect(machine, server.url, { model: "DE1Pro", serial: "40001" })).close();
    const record = shot("mismatch-fallback");
    const tablet = load(machine, [record], { api: withShots(derivedDe1Pro({ serial: "40002" }), [record]) });
    const held = await waitShot(String(record.id));
    expect(held).toMatchObject({ machineId: null, pendingMachineId: expect.any(String), machineInferred: true });
    const pending = (await api.pendingMachines()).find((candidate) => candidate.id === held.pendingMachineId)!;
    expect(pending).toMatchObject({ model: "DE1Pro", serial: "40002" });
    const created = await api.issued(await api.call("POST", `/pending-machines/${pending.id}/machine`, { name: "Resolved mismatch" }));
    expect(await detail(String(record.id))).toMatchObject({ machineId: created.machine.id, pendingMachineId: null });
    tablet.dropConnections();
    await tablet.waitForLogs(/^Connected to /, 2);
    expect((await list(created.machine.id)).total).toBe(1);
  });

  it("retains missing and unfamiliar Decaid fields as sent", async () => {
    const machine = await api.createMachine("Unfamiliar fields");
    const raw = await connect(machine);
    const record = { id: "opaque-shot", updatedAt: "2026-01-01T12:00:00Z", future: { custom: [1, null, "new"] }, workflow: { context: { futureDose: 18 } }, measurements: [{ futureSample: true }] };
    await deliver(raw, record);
    const { measurements: expectedCurves, ...metadata } = record;
    expect((await detail(record.id)).record).toEqual(metadata);
    expect(await measurements(record.id)).toEqual(expectedCurves);
  });

  it("acknowledges and ignores records Decaid v0.8.7 and later would not send", async () => {
    const machine = await api.createMachine("Incompatible records");
    const raw = await connect(machine);
    const { updatedAt: omitted, ...unversioned } = shot("unversioned-shot");
    await deliver(raw, unversioned);
    await deliver(raw, shot("local-version-shot", { updatedAt: "2026-01-01T12:00:00" }));
    await deliver(raw, shot("curveless-shot", { measurements: undefined }));
    await deliver(raw, { id: "unversioned-edit", annotations: { enjoyment: 50 } }, "shotUpdated");
    for (const id of ["unversioned-shot", "local-version-shot", "curveless-shot", "unversioned-edit"]) {
      expect((await api.call("GET", `/shots/${id}`)).status).toBe(404);
    }
    raw.send({ type: "shotIndex", id: "incompatible-index", shots: [{ id: "unversioned-edit" }] });
    await expect.poll(() => raw.messages.find((m) => (m as { type: string }).type === "requestShots")).toEqual({ type: "requestShots", shotIds: ["unversioned-edit"] });
  });

  it("makes newer-wins choices across instances and restart", async () => {
    const machine = await api.createMachine("Versions");
    const raw = await connect(machine);
    const record = shot("version-shot", { updatedAt: "2026-01-01T12:00:00Z" });
    await deliver(raw, record);
    const second = await connect(machine, other.url);
    await deliver(second, { ...record, updatedAt: "2026-01-02T12:00:00Z", annotations: { enjoyment: 70 } });
    await second.close();
    await other.stop();
    other = await startTestServer({ env, sharing: server });
    const restarted = await connect(machine, other.url);
    await deliver(restarted, record);
    expect(await detail(String(record.id), api.at(other.url))).toMatchObject({ enjoyment: 70 });
    // Decaid uses microseconds; two edits in the same millisecond still order correctly.
    await deliver(restarted, { ...record, updatedAt: "2026-01-03T12:00:00.000002Z", annotations: { enjoyment: 82 } }, "shotUpdated");
    await deliver(restarted, { ...record, updatedAt: "2026-01-03T12:00:00.000001Z", annotations: { enjoyment: 81 } }, "shotUpdated");
    expect(await detail(String(record.id))).toMatchObject({ enjoyment: 82 });
  }, 20_000);

  it("reconciles edit times and requests early edits' missing full records, accepting ids-only reconnect indices", async () => {
    const machine = await api.createMachine("Indices");
    const raw = await connect(machine);
    const record = shot("indexed-shot", { updatedAt: "2026-01-01T12:00:00Z" });
    await deliver(raw, record);
    await deliver(raw, { id: "indexed-early", updatedAt: "2026-01-01T12:00:00Z" }, "shotUpdated");
    raw.send({ type: "shotIndex", id: "index-newer", shots: [
      { id: record.id, updatedAt: "2026-01-02T12:00:00Z" }, { id: "indexed-early" }, { id: "missing-shot" },
    ] });
    await expect.poll(() => raw.messages.filter((m) => (m as { type: string }).type === "requestShots").length).toBe(1);
    expect(raw.messages.find((m) => (m as { type: string }).type === "requestShots")).toEqual({ type: "requestShots", shotIds: ["indexed-shot", "indexed-early", "missing-shot"] });
    raw.send({ type: "shotIndex", id: "index-reconnect", shots: [{ id: record.id }] });
    await expect.poll(() => raw.messages.filter((m) => (m as { type: string }).type === "requestShots").length).toBe(2);
    expect(raw.messages.filter((m) => (m as { type: string }).type === "requestShots")[1]).toEqual({ type: "requestShots", shotIds: [] });
  });

  it("converges when a delivery through a replaced connection overlaps its replacement on another instance", async () => {
    const machine = await api.createMachine("Concurrent delivery");
    const first = await connect(machine);
    const workflow = shotFixture().workflow as Record<string, unknown>;
    const old = derivedShot("concurrent-shot", { updatedAt: "2026-01-01T12:00:00Z", workflow: { ...workflow, machine: { model: "DE1Pro", serialNumber: "50001" } } });
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await database.query(`SELECT pg_advisory_xact_lock(${SHOT_LOCK}::int, hashtext($1::text))`, [old.id]);
      first.send({ type: "shot", id: "concurrent-old", shotId: old.id, shot: old });
      await waitForLockWaits(server, { advisory: true });
      const second = await connect(machine, other.url);
      second.send({ type: "shot", id: "concurrent-new", shotId: old.id, shot: { ...old, updatedAt: "2026-01-02T12:00:00Z", annotations: { enjoyment: 95 } } });
      await waitForLockWaits(server, { advisory: true, count: 2 });
      await database.query("COMMIT");
      await waitShot(String(old.id), (shot) => shot.enjoyment === 95);
    } finally { await database.end(); }
    expect((await list()).shots.filter((shot) => shot.id === old.id)).toHaveLength(1);
    expect((await api.pendingMachines()).filter((pending) => pending.model === "DE1Pro" && pending.serial === "50001")).toHaveLength(1);
  });
});
