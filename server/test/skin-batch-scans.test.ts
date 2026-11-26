import { randomUUID } from "node:crypto";
import { MAX_BATCH_MATCHES, MAX_SCANNED_TEXT_LENGTH, WIRE_REVISION, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { RawConnection, type SimulatedTablet, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { StandInServer } from "./support/stand-in-server.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #708 (ADR-0030 and ADR-0008, amended): a Skin that has
// read a QR code sends the text it held to the plugin's `scan` endpoint, the
// plugin asks the server which Bean Batch it is, and the batch is brought to
// the Machine's Location: moved, all of it, from the one other Location it
// is at, or added with no weight moved. The plugin answers once its tablet's
// Decaid holds the batch un-archived, with the tablet's own ids. Through the
// built plugin in simulated tablets against a real server: one at the cafe,
// where the scans are made, and one at the lab, with an annex that has no
// tablet. Matching is tested here, one case a step and an outcome, since
// nothing else exposes it. Serials are made up, from 70801.

type Record_ = Record<string, unknown>;

interface AtLocation {
  location: LocationView;
  remainingWeight: number | null;
}

interface BatchView {
  id: string;
  locations: AtLocation[];
  finished: { location: LocationView }[];
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: { machine: { id: string; name: string } | null; tabletId: string | null; barista: string | null; account: { id: string } | null; connectedApp: { id: string } | null };
  move: { from: LocationView | null; to: LocationView | null; amount: number | null; all: boolean } | null;
}

interface Match {
  id: string;
  roaster: string | null;
  name: string | null;
  roastDate: string | null;
  batchCode: string | null;
}

interface Answer {
  status: number;
  body: Record_;
}

/** A Machine at a Location, with its tablet. */
interface Bar {
  location: LocationView;
  machine: CreatedMachine;
  name: string;
  tablet: SimulatedTablet;
}

// Heartbeats every 30 s, the default: while a call to the plugin's endpoint awaits its answer the tablet runs at real
// time, its heartbeats with it, so a server expecting one a second would drop a call that took three.
const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };
const WAIT = { timeout: 15_000 };

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

async function answered(calling: ReturnType<SimulatedTablet["callEndpoint"]>): Promise<Answer> {
  const answer = await calling;
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** Sends the tablet's `scan` endpoint a PUT as a Skin does, with the body given. */
const scan = (tablet: SimulatedTablet, body: unknown, options: { atTabletPace?: boolean } = {}) => answered(tablet.callEndpoint("scan", { method: "PUT", body, ...options }));
/** The requests to bring a batch the plugin sent the server. */
const asked = (tablet: SimulatedTablet) => (tablet.sent as Record_[]).filter((frame) => frame.type === "request" && frame.ask === "bringBatch");
const connectionPushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "connection").map((push) => push.connected);
/** The tablet's record of the batch. */
const held = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);
/** Names the barista in the tablet's Workflow, as a barista picks their name on it, or none. */
function nameBarista(tablet: SimulatedTablet, baristaName: string | null): void {
  const workflow = tablet.workflow();
  tablet.setWorkflow({ ...workflow, context: { ...(workflow.context as Record_), baristaName } });
}

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("A Bean Batch brought to the Machine's Location by a scan", { timeout: 240_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let cafe: Bar;
  let lab: Bar;
  let annex: LocationView;
  /** Roux's Guji, with two batches; its Kenya, with one; and a Bean with more batches than an answer lists. */
  let guji: string;
  let kenya: string;
  let many: string;
  let serials = 70800;
  let codes = 0;

  runAsSteps();

  async function barAt(location: LocationView, name: string, instance: TestServer = server): Promise<Bar> {
    const machine = await api.createMachine(name, location.id);
    const tablet = tablets.syncing(machine, instance, { api: emptyLibrary(++serials) });
    await api.waitForOnline(machine);
    return { location, machine, name, tablet };
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    cafe = await barAt(await api.createLocation("Scan cafe", "America/Chicago"), "Scan cafe bar");
    lab = await barAt(await api.createLocation("Scan lab", "America/Chicago"), "Scan lab bench");
    annex = await api.createLocation("Scan annex", "America/Chicago");
    const bean = async (name: string) => (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, 201)).bean.id;
    guji = await bean("Scanned Guji Natural");
    kenya = await bean("Scanned Kenya");
    many = await bean("Scanned Blend");
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  const idOf = (where: Bar | LocationView) => ("location" in where ? where.location.id : where.id);
  const getBatch = async (id: string) => (await api.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  /** The batch's Remaining Weight at each Location it is at, by the Location's name. */
  const where = async (id: string) => Object.fromEntries((await getBatch(id)).locations.map((here) => [here.location.name, here.remainingWeight]));
  const versions = async (id: string) => (await api.get<{ versions: Version[] }>(`/bean-batches/${id}/history`)).versions;
  const place = (id: string, at: Bar | LocationView, body: Record_) => api.send("PUT", `/bean-batches/${id}/locations/${idOf(at)}`, body);
  /** A Batch Code no other batch of this file holds. */
  const nextCode = () => `SC-${String(++codes).padStart(4, "0")}`;

  /** A batch of the Bean created at the Location, with the content and weight given, if any. */
  async function batchAt(at: Bar | LocationView, beanId: string, content: Record_ = {}, remainingWeight?: number): Promise<string> {
    const entry = { locationId: idOf(at), ...(remainingWeight === undefined ? {} : { remainingWeight }) };
    return (await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId, content, locations: [entry] }, 201)).batch.id;
  }

  /** What a scan answers once it has brought the batch: the outcome, with the cafe tablet's own ids for the batch and its bean. */
  function brought(outcome: "moved" | "added" | "alreadyThere", id: string): Answer {
    const record = held(cafe.tablet, id);
    return { status: 200, body: { outcome, batchId: record?.id, beanId: record?.beanId } };
  }

  /** A scan made on the tablet, as a batch's history names who made it. */
  const madeOn = (bar: Bar, barista: string | null) => ({ machine: { id: bar.machine.machine.id, name: bar.name }, tabletId: bar.tablet.storage.read("tabletId"), barista, account: null, connectedApp: null });

  it("says in its status that it can match scanned text", async () => {
    expect(await answered(cafe.tablet.callEndpoint("status"))).toMatchObject({ status: 200, body: { connected: true, served: true, scan: true } });
  });

  it("moves all of a batch that is at one other Location, with its remaining weight, finishing it where it left, and answers once the tablet holds it un-archived, with the tablet's own ids", async () => {
    const code = nextCode();
    const id = await batchAt(lab, guji, { batchCode: code, roastDate: "2026-11-10" }, 2920);
    await expect.poll(() => held(lab.tablet, id)?.archived, WAIT).toBe(false);
    expect(held(cafe.tablet, id)).toBeUndefined();
    nameBarista(cafe.tablet, "Sam");

    const answer = await scan(cafe.tablet, { text: code });
    // As it is answered, the tablet's Decaid holds the batch, not archived, under a bean it holds, not archived.
    const record = held(cafe.tablet, id)!;
    expect(record).toMatchObject({ archived: false });
    expect(cafe.tablet.beans().find((bean) => bean.id === record.beanId)).toMatchObject({ archived: false, roaster: "Roux", name: "Scanned Guji Natural" });
    expect(answer).toEqual(brought("moved", id));
    expect(answer.body.batchId).toEqual(expect.any(String));
    // The plugin sent the text as the Skin read it, with the barista the Workflow named, and no weight.
    expect(asked(cafe.tablet)).toEqual([{ type: "request", id: expect.any(String), ask: "bringBatch", text: code, barista: "Sam" }]);

    // All of it is at the cafe, whose tablet's record comes to hold that weight, and it is finished at the lab, whose tablet holds it archived.
    expect(await where(id)).toEqual({ "Scan cafe": 2920 });
    await expect.poll(() => held(cafe.tablet, id)?.weightRemaining, WAIT).toBe(2920);
    expect((await getBatch(id)).finished.map((left) => left.location.name)).toEqual(["Scan lab"]);
    await expect.poll(() => held(lab.tablet, id)?.archived, WAIT).toBe(true);

    // One history entry: a move of all, naming the Machine, the tablet and the Workflow's barista, and no account.
    const [move, ...earlier] = await versions(id);
    expect(move).toMatchObject({ location: { name: "Scan cafe" }, move: { from: { name: "Scan lab" }, to: { name: "Scan cafe" }, amount: 2920, all: true }, source: madeOn(cafe, "Sam") });
    expect(earlier.every((version) => version.move === null && version.source.account !== null && version.source.barista === null)).toBe(true);
    // An assistant reads the same.
    const history = await assistant.call<{ history: { entries: Record_[] } }>("get_library_item", { kind: "beanBatch", id, history: true });
    expect(history.history.entries[0]).toMatchObject({ move: { amount: 2920, all: true }, source: { machine: { name: "Scan cafe bar" }, barista: "Sam", account: null } });
  });

  it("adds a batch that is at two other Locations at the Machine's Location with no weight, changing neither other Location's weight or presence, crediting the Machine and tablet alone where the Workflow names no barista", async () => {
    const code = nextCode();
    const id = await batchAt(lab, guji, { batchCode: code, roastDate: "2026-11-12" }, 500);
    await place(id, annex, { atLocation: true, remainingWeight: 300 });
    nameBarista(cafe.tablet, null);

    expect(await scan(cafe.tablet, { text: code })).toEqual(brought("added", id));
    expect(held(cafe.tablet, id)).toMatchObject({ archived: false });
    expect(asked(cafe.tablet).at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "bringBatch", text: code });
    // Untracked at the cafe, as nothing says which Location's coffee arrived, and each other Location as it was.
    expect(await where(id)).toEqual({ "Scan cafe": null, "Scan lab": 500, "Scan annex": 300 });
    expect((await getBatch(id)).finished).toEqual([]);
    await expect.poll(() => held(lab.tablet, id)?.archived, WAIT).toBe(false);
    const [add] = await versions(id);
    expect(add).toMatchObject({ fields: { atLocation: true }, location: { name: "Scan cafe" }, move: null, source: madeOn(cafe, null) });
  });

  it("adds a batch that is at no Location at the Machine's Location", async () => {
    const code = nextCode();
    const id = await batchAt(lab, guji, { batchCode: code }, 400);
    await place(id, lab, { atLocation: false });
    expect(await where(id)).toEqual({});
    nameBarista(cafe.tablet, "  Alex  ");

    expect(await scan(cafe.tablet, { text: code })).toEqual(brought("added", id));
    expect(await where(id)).toEqual({ "Scan cafe": null });
    expect((await getBatch(id)).finished.map((left) => left.location.name)).toEqual(["Scan lab"]);
    // The barista's name is trimmed, as the Workflow may hold it typed.
    expect((await versions(id))[0]).toMatchObject({ fields: { atLocation: true }, move: null, source: madeOn(cafe, "Alex") });
  });

  it("adds a batch that was finished at the Machine's Location with a weight back there untracked, as nothing says what arrived", async () => {
    const code = nextCode();
    const id = await batchAt(cafe, guji, { batchCode: code }, 300);
    await expect.poll(() => held(cafe.tablet, id)?.archived, WAIT).toBe(false);
    await place(id, cafe, { atLocation: false });
    await expect.poll(() => held(cafe.tablet, id)?.archived, WAIT).toBe(true);
    expect(await where(id)).toEqual({});

    expect(await scan(cafe.tablet, { text: code })).toEqual(brought("added", id));
    expect(held(cafe.tablet, id)).toMatchObject({ archived: false });
    // The weight its count there was left with is not taken up again.
    expect(await where(id)).toEqual({ "Scan cafe": null });
    const [add, ...earlier] = await versions(id);
    expect(add).toMatchObject({ fields: { atLocation: true, remainingWeight: null }, location: { name: "Scan cafe" }, move: null, source: { machine: { name: "Scan cafe bar" }, account: null } });
    // One entry for the scan.
    expect(earlier.every((version) => version.source.account !== null)).toBe(true);
  });

  it("changes nothing for a batch already at the Machine's Location, and answers the same way, saying it was already there", async () => {
    const code = nextCode();
    const id = await batchAt(cafe, kenya, { batchCode: code, roastDate: "2026-11-18" }, 1000);
    await place(id, lab, { atLocation: true, remainingWeight: 250 });
    await expect.poll(() => held(cafe.tablet, id)?.archived, WAIT).toBe(false);
    const before = await versions(id);

    expect(await scan(cafe.tablet, { text: code })).toEqual(brought("alreadyThere", id));
    expect(await versions(id)).toEqual(before);
    expect(await where(id)).toEqual({ "Scan cafe": 1000, "Scan lab": 250 });
  });

  describe("matching", () => {
    /** A batch at the cafe with a Batch Code, and Roux's Guji with roasts of two days, each at the cafe. */
    let coded: string;
    let code: string;
    let early: string;
    let late: string;

    beforeAll(async () => {
      code = nextCode();
      coded = await batchAt(cafe, kenya, { batchCode: code, roastDate: "2026-11-19" });
      // The Guji's batches so far are at the cafe, the lab or the annex: these two alone were roasted on these days.
      early = await batchAt(cafe, guji, { roastDate: "2026-10-01" });
      late = await batchAt(cafe, guji, { roastDate: "2026-10-20" });
      await until(() => [coded, early, late].every((id) => held(cafe.tablet, id)?.archived === false));
    });

    const matched = async (text: string) => {
      const answer = await scan(cafe.tablet, { text });
      expect(answer.status, text).toBe(200);
      return answer.body.outcome === "several" ? (answer.body.matches as Match[]).map((match) => match.id) : answer.body.outcome === "noMatch" ? [] : [globalIdOf(cafe.tablet.batches().find((record) => record.id === answer.body.batchId))];
    };

    it("matches a bare Batch Code, ignoring case and the white space around it", async () => {
      for (const text of [code, code.toLowerCase(), `  ${code}\n`, `\t${code.toLowerCase()}  `]) expect(await matched(text), JSON.stringify(text)).toEqual([coded]);
      // A code is the whole text: part of one, or one with more beside it, is none.
      for (const text of [code.slice(0, -1), `${code} and more`]) expect(await matched(text), text).toEqual([]);
    });

    it("matches a URL with the code as its last path segment, as a query value and as its fragment", async () => {
      for (const text of [
        `https://roaster.example/batches/${code}`,
        `https://roaster.example/batches/${code.toLowerCase()}/`,
        `https://roaster.example/b?source=label&code=${code}`,
        `https://roaster.example/b#${code}`,
        `roastlog://batch/${encodeURIComponent(` ${code} `)}`,
      ]) {
        expect(await matched(text), text).toEqual([coded]);
      }
      // A path segment that is not the last is not looked at.
      expect(await matched(`https://roaster.example/${code}/label`)).toEqual([]);
    });

    it("matches JSON holding the code as one of its string values, at any depth", async () => {
      for (const text of [JSON.stringify({ roaster: "Roux", batch: { code } }), JSON.stringify([{ id: 470 }, [code.toLowerCase()]]), JSON.stringify(code)]) expect(await matched(text), text).toEqual([coded]);
      // A key is no value.
      expect(await matched(JSON.stringify({ [code]: "label" }))).toEqual([]);
    });

    it("matches a Bean's roaster and name, where no code is found", async () => {
      // Every word of the text is in the Bean's roaster and name, whatever its case and punctuation.
      for (const text of ["Roux Scanned Kenya", "kenya, scanned", "ROUX: Kenya"]) expect(await matched(text), text).toContain(coded);
      // Every word of the Bean's name is in the text, among whatever else a label holds.
      expect(await matched("Roux Coffee Roasters - Scanned Kenya - 250 g - keep cool")).toContain(coded);
      expect(await matched(`https://roaster.example/coffees/scanned-kenya?lot=unknown`)).toContain(coded);
      // A word of neither names nothing.
      expect(await matched("Roux Scanned Colombia")).toEqual([]);
    });

    it("matches a Bean's name with a roast date, which narrows its batches to that day, written year first or with its month by name", async () => {
      const both = await matched("Scanned Guji Natural");
      expect(both).toEqual(expect.arrayContaining([early, late]));
      for (const text of ["Scanned Guji Natural 2026-10-20", "Scanned Guji Natural, roasted 20 Oct 2026", "Roux Scanned Guji Natural October 20, 2026", "scanned guji natural 2026/10/20"]) {
        expect(await matched(text), text).toEqual([late]);
      }
      expect(await matched(JSON.stringify({ coffee: "Scanned Guji Natural", roasted: "2026-10-01" }))).toEqual([early]);
      // A day none of its batches was roasted on leaves none, and a date that would be guessed narrows nothing.
      expect(await matched("Scanned Guji Natural 2026-10-21")).toEqual([]);
      expect(await matched("Scanned Guji Natural 10/20/2026")).toEqual(both);
      expect(await matched("Scanned Guji Natural 2026-13-45")).toEqual(both);
    });
  });

  it("changes nothing for text matching several batches, and lists them newest roast first, capped, saying when more matched; a second request naming one of them brings it", async () => {
    // More batches of one Bean than an answer lists, at the lab, each roasted a day after the last, and one with no roast date.
    const count = MAX_BATCH_MATCHES + 2;
    const day = (index: number) => `2026-09-${String(index + 1).padStart(2, "0")}`;
    const batches: string[] = [];
    for (let index = 0; index < count; index++) batches.push(await batchAt(lab, many, { roastDate: day(index), batchCode: `BLEND-${index}` }, 100));
    const undated = await batchAt(lab, many, {});
    const before = asked(cafe.tablet).length;

    const several = await scan(cafe.tablet, { text: "Scanned Blend" });
    expect(several).toEqual({ status: 200, body: { outcome: "several", matches: expect.any(Array), more: true } });
    const matches = several.body.matches as Match[];
    expect(matches).toHaveLength(MAX_BATCH_MATCHES);
    // Newest roast first: the earliest two, and the one with no date, are those left out.
    expect(matches.map((match) => match.id)).toEqual([...batches].reverse().slice(0, MAX_BATCH_MATCHES));
    expect(matches[0]).toEqual({ id: batches.at(-1), roaster: "Roux", name: "Scanned Blend", roastDate: day(count - 1), batchCode: `BLEND-${count - 1}` });
    // Nothing was brought.
    for (const id of [batches.at(-1)!, undated]) expect(Object.keys(await where(id))).toEqual(["Scan lab"]);

    const chosen = matches[3]!;
    await expect.poll(() => held(lab.tablet, chosen.id)?.archived, WAIT).toBe(false);
    expect(await scan(cafe.tablet, { match: chosen.id })).toEqual(brought("moved", chosen.id));
    expect(asked(cafe.tablet).slice(before).map(({ text, batchId }) => ({ text, batchId }))).toEqual([{ text: "Scanned Blend" }, { batchId: chosen.id }]);
    expect(await where(chosen.id)).toEqual({ "Scan cafe": 100 });
    // The others are where they were.
    expect(Object.keys(await where(batches.at(-1)!))).toEqual(["Scan lab"]);
  });

  it("lists every match where fewer matched than an answer holds, the one with no roast date last", async () => {
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Scanned Trio" } }, 201)).bean.id;
    const undated = await batchAt(lab, bean, {});
    const older = await batchAt(lab, bean, { roastDate: "2026-08-01" });
    const newer = await batchAt(annex, bean, { roastDate: "2026-08-09", batchCode: nextCode() });
    const answer = await scan(cafe.tablet, { text: "Scanned Trio" });
    expect(answer).toMatchObject({ status: 200, body: { outcome: "several", more: false } });
    expect((answer.body.matches as Match[]).map((match) => [match.id, match.roastDate, match.batchCode])).toEqual([
      [newer, "2026-08-09", `SC-${String(codes).padStart(4, "0")}`],
      [older, "2026-08-01", null],
      [undated, null, null],
    ]);
  });

  it("answers a request naming a batch that is Archived, or one of an Archived Bean, or unknown, as no match, and text matching only those or nothing likewise, changing nothing", async () => {
    const noMatch = { status: 200, body: { outcome: "noMatch" } };
    const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Scanned Retired" } }, 201)).bean.id;
    const retiredCode = nextCode();
    const retired = await batchAt(lab, bean, { batchCode: retiredCode });
    const orphanCode = nextCode();
    const orphanBean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Scanned Withdrawn" } }, 201)).bean.id;
    const orphan = await batchAt(lab, orphanBean, { batchCode: orphanCode });
    await api.send("PUT", `/bean-batches/${retired}/archived`, { archived: true });
    await api.send("PUT", `/beans/${orphanBean}/archived`, { archived: true });
    const before = { retired: await versions(retired), orphan: await versions(orphan) };

    // An Archived batch, and a batch of an Archived Bean: by id, by code, and by the Bean's name.
    for (const body of [{ match: retired }, { match: orphan }, { match: randomUUID() }, { text: retiredCode }, { text: orphanCode }, { text: "Scanned Retired" }, { text: "Scanned Withdrawn" }]) {
      expect(await scan(cafe.tablet, body), JSON.stringify(body)).toEqual(noMatch);
    }
    // A label holding the Archived batch's code beside its Bean's name is that batch's, not one for another batch of the Bean.
    const sibling = await batchAt(lab, bean, {});
    for (const text of [`https://roux.example/scanned-retired/${retiredCode}`, JSON.stringify({ bean: "Scanned Retired", code: retiredCode }), `Roux Scanned Retired ${retiredCode}`]) {
      expect(await scan(cafe.tablet, { text }), text).toEqual(noMatch);
    }
    expect(Object.keys(await where(sibling))).not.toContain("Scan cafe");
    // Text that matches nothing, and none at all.
    for (const text of ["no such label", "SC-9999", "https://roaster.example/batches/SC-9999", "{not json", "", "   "]) expect(await scan(cafe.tablet, { text }), text).toEqual(noMatch);
    // Nothing was brought, created or un-archived.
    expect({ retired: await versions(retired), orphan: await versions(orphan) }).toEqual(before);
    for (const id of [retired, orphan]) expect(Object.keys(await where(id))).not.toContain("Scan cafe");
    expect(held(cafe.tablet, retired)).toBeUndefined();

    // An Archived batch's code, taken up since by a live batch, is that batch's.
    const reused = await batchAt(lab, bean, { batchCode: retiredCode });
    expect(await scan(cafe.tablet, { text: `https://roux.example/scanned-retired/${retiredCode}` })).toEqual(brought("moved", reused));
    expect(held(cafe.tablet, retired)).toBeUndefined();
  });

  it("refuses text over the length limit as a bad request, and any request it can't read, without asking the server", async () => {
    const before = asked(cafe.tablet).length;
    const invalid = (what: string) => ({ status: 400, body: { code: "invalidRequest", message: expect.stringContaining(what) } });
    expect(await scan(cafe.tablet, { text: "x".repeat(MAX_SCANNED_TEXT_LENGTH + 1) })).toEqual(invalid(`at most ${MAX_SCANNED_TEXT_LENGTH} characters`));
    for (const text of [470, null, ["SC-0001"], "a\u0000b", "\ud800"]) expect(await scan(cafe.tablet, { text }), JSON.stringify(text)).toEqual(invalid("text"));
    for (const body of [undefined, null, {}, [], "SC-0001"]) expect(await scan(cafe.tablet, body), JSON.stringify(body)).toEqual(invalid("text"));
    for (const match of ["SC-0001", 7, null, ""]) expect(await scan(cafe.tablet, { match }), JSON.stringify(match)).toEqual(invalid("match"));
    expect(await scan(cafe.tablet, { text: "SC-0001", match: randomUUID() })).toEqual(invalid("not both"));
    // The longest text is asked about.
    expect(await scan(cafe.tablet, { text: "x".repeat(MAX_SCANNED_TEXT_LENGTH) })).toEqual({ status: 200, body: { outcome: "noMatch" } });
    expect(asked(cafe.tablet)).toHaveLength(before + 1);

    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      const answer = await cafe.tablet.callEndpoint("scan", { method, body: { text: "SC-0001" } });
      expect([answer.status, answer.headers.Allow, JSON.parse(answer.body)]).toEqual([405, "PUT", { error: "Only PUT is answered" }]);
    }
  });

  it("refuses a Capture-only Machine, bringing nothing", async () => {
    const code = nextCode();
    const id = await batchAt(lab, kenya, { batchCode: code }, 600);
    const idle = await barAt(cafe.location, "Scan cafe idle");
    await api.send("PUT", `/machines/${idle.machine.machine.id}/sharing`, { sharing: false });
    await expect.poll(async () => (await answered(idle.tablet.callEndpoint("status"))).body.code, WAIT).toBe("captureOnly");
    // Its plugin can match scanned text: its Machine is not served.
    expect(await answered(idle.tablet.callEndpoint("status"))).toMatchObject({ status: 409, body: { connected: true, served: false, scan: true } });
    for (const body of [{ text: code }, { match: id }]) {
      expect(await scan(idle.tablet, body)).toEqual({ status: 409, body: { code: "captureOnly", message: expect.stringContaining("Capture-only") } });
    }
    expect(await where(id)).toEqual({ "Scan lab": 600 });
    await idle.tablet.unload();
  });

  describe("with raw frames", () => {
    const answers = (raw: RawConnection) => (raw.messages as Record_[]).filter((message) => message.type === "answer");

    it("answers a Machine at no Location as not served, and ends the connection of a request that is no plugin's, or from a plugin of the release before", async () => {
      const nowhere = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Scan nowhere")).token));
      nowhere.send({ type: "request", id: "nowhere", ask: "bringBatch", text: "SC-0001" });
      await expect.poll(() => answers(nowhere)).toEqual([{ type: "answer", id: "nowhere", ask: "bringBatch", refused: "captureOnly" }]);
      await nowhere.close();

      // Neither text nor a batch, and both: the plugin sends one of the two.
      for (const fields of [{}, { text: "SC-0001", batchId: randomUUID() }, { batchId: "SC-0001" }, { text: "x".repeat(MAX_SCANNED_TEXT_LENGTH + 1) }, { text: "SC-0001", barista: "" }]) {
        const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine(`Scan raw ${randomUUID()}`, cafe.location.id)).token));
        raw.send({ type: "request", id: "invalid", ask: "bringBatch", ...fields });
        expect((await raw.closed).code, JSON.stringify(fields)).toBe(4000);
        expect(raw.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining("request.") });
      }

      // The previous release's plugin sends none, and has no answer to read one by: one from its wire revision is no plugin's.
      const old = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Scan old plugin", cafe.location.id)).token, { wireRevision: WIRE_REVISION - 1 }));
      old.send({ type: "request", id: "old", ask: "bringBatch", text: "SC-0001" });
      expect((await old.closed).code).toBe(4000);
      expect(old.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error" });
      expect(answers(old)).toEqual([]);
    });

    // The scan holds its Machine's row from before it reads where the Machine is served until it commits, as a choice of
    // a Reference Shot does, and takes the Locations' locks after it. A Location of its own, with no tablet, so nothing
    // else waits for a lock there.
    it("brings a batch only while its Machine is served there: a sharing switch waits for a scan under way, and the next scan is refused", async () => {
      const depot = await api.createLocation("Scan depot", "America/Chicago");
      const machine = await api.createMachine("Scan depot raw", depot.id);
      const [first, second] = [nextCode(), nextCode()];
      const [moved, left] = [await batchAt(lab, kenya, { batchCode: first }, 700), await batchAt(lab, kenya, { batchCode: second }, 800)];
      const raw = await RawConnection.welcomed(server.url, helloWith(machine.token));
      const database = await server.connectDatabase();
      let switched = false;
      try {
        // The depot's lock is held, as by a tablet's report of its batches, so the scan waits for it, holding its Machine's row.
        await database.query("BEGIN");
        await database.query("SELECT pg_advisory_xact_lock(4000007, hashtext($1::text))", [depot.id]);
        raw.send({ type: "request", id: "under way", ask: "bringBatch", text: first, barista: "Sam" });
        await waitForLockWaits(server, { advisory: true });
        // An Admin turns the Machine's sharing off meanwhile: the switch waits for the scan.
        const switching = api.send("PUT", `/machines/${machine.machine.id}/sharing`, { sharing: false }).then(() => (switched = true));
        await waitForLockWaits(server, { count: 2 });
        expect([switched, await where(moved)]).toEqual([false, { "Scan lab": 700 }]);
        await database.query("COMMIT");
        await switching;
      } finally {
        await database.end();
      }
      // The scan was made first, by a Machine served at the depot then, and the one after the switch is refused.
      await expect.poll(() => answers(raw)).toEqual([{ type: "answer", id: "under way", ask: "bringBatch", result: { outcome: "moved", batchId: moved } }]);
      expect(await where(moved)).toEqual({ "Scan depot": 700 });
      expect((await versions(moved))[0]!.source).toMatchObject({ machine: { name: "Scan depot raw" }, barista: "Sam", account: null });
      raw.send({ type: "request", id: "after", ask: "bringBatch", text: second });
      await expect.poll(() => answers(raw).at(-1)).toEqual({ type: "answer", id: "after", ask: "bringBatch", refused: "captureOnly" });
      expect(await where(left)).toEqual({ "Scan lab": 800 });
      await raw.close();
    });
  });

  it("refuses a scan as unreachable where the tablet does not hold the batch in time, though the batch was brought", async () => {
    const code = nextCode();
    const id = await batchAt(lab, kenya, { batchCode: code }, 900);
    const slow = await barAt(cafe.location, "Scan cafe slow");
    await expect.poll(() => slow.tablet.beans().some((bean) => bean.name === "Scanned Kenya"), WAIT).toBe(true);
    // Decaid is slow to take the plugin's writes of batches, so the tablet's record is still to come as the request's time runs out.
    const kenyaRecord = slow.tablet.beans().find((bean) => bean.name === "Scanned Kenya")!;
    const writes = slow.tablet.holdRequests("POST", `/beans/${String(kenyaRecord.id)}/batches`);
    try {
      // At real time, so the server's answer comes well inside the request's 10 s and the wait is for the tablet's record alone.
      expect(await scan(slow.tablet, { text: code })).toEqual({ status: 503, body: { code: "unreachable", message: expect.stringContaining("may still arrive") } });
      // The server had brought it: the request refused for time moved the batch.
      expect(await where(id)).toEqual({ "Scan cafe": 900 });
      expect((await versions(id))[0]).toMatchObject({ move: { all: true }, source: { machine: { name: "Scan cafe slow" } } });
    } finally {
      writes.release();
    }
    // The record arrives, and the scan asked again finds the batch already there.
    await expect.poll(() => held(slow.tablet, id)?.archived, WAIT).toBe(false);
    const record = held(slow.tablet, id)!;
    expect(await scan(slow.tablet, { text: code })).toEqual({ status: 200, body: { outcome: "alreadyThere", batchId: record.id, beanId: record.beanId } });
    await slow.tablet.unload();
  });

  it("refuses a scan at once while the server is stopped, asking nothing, and brings nothing once it is back", async () => {
    const code = nextCode();
    const id = await batchAt(lab, kenya, { batchCode: code }, 650);
    const machine = await api.createMachine("Scan cafe second", cafe.location.id);
    // An instance of its own, to stop and to start again at the same address.
    const instance = await startTestServer({ env, sharing: server });
    const tablet = tablets.syncing(machine, instance, { api: emptyLibrary(++serials) });
    await api.waitForOnline(machine);
    await expect.poll(() => connectionPushes(tablet).at(-1)).toBe(true);

    await instance.stop();
    await expect.poll(() => connectionPushes(tablet).at(-1)).toBe(false);
    const started = Date.now();
    expect(await scan(tablet, { text: code })).toEqual({ status: 503, body: { code: "unreachable", message: expect.stringContaining("can't be reached") } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await answered(tablet.callEndpoint("status"))).toMatchObject({ status: 503, body: { connected: false, scan: false } });
    expect(asked(tablet)).toEqual([]);

    // The server back at its address: the plugin reconnects, and what it was refused is not made now.
    const back = await startTestServer({ env, sharing: server, port: Number(new URL(instance.url).port) });
    try {
      await expect.poll(() => connectionPushes(tablet).at(-1)).toBe(true);
      await expect.poll(async () => (await answered(tablet.callEndpoint("status"))).status, WAIT).toBe(200);
      expect(asked(tablet)).toEqual([]);
      expect(await where(id)).toEqual({ "Scan lab": 650 });
      // Asked again, through this instance, it is brought, and reaches the tablet the first instance holds too.
      expect((await scan(tablet, { text: code })).body).toMatchObject({ outcome: "moved" });
      expect(await where(id)).toEqual({ "Scan cafe": 650 });
      await expect.poll(() => held(cafe.tablet, id)?.archived, WAIT).toBe(false);
    } finally {
      await tablet.unload();
      await back.stop();
    }
  });
});

describe("A scan the server does not answer, or can't be asked", () => {
  /** A tablet connected to a stand-in server, which answers no request by itself. */
  async function standIn(token: string, serial: number, options: { wireRevision?: number } = {}): Promise<{ server: StandInServer; tablet: SimulatedTablet }> {
    const server = await StandInServer.start(options);
    const tablet = tablets.load({ settings: settingsFor({ token, serverUrl: server.url }), api: emptyLibrary(serial), timeScale: 50 });
    await expect.poll(() => connectionPushes(tablet)).toEqual([true]);
    return { server, tablet };
  }

  it("is refused as unreachable once its time is up, well inside the time Decaid gives the plugin", async () => {
    const { server, tablet } = await standIn("stand-in token 70891", 70_891);
    try {
      const before = tablet.readClock();
      expect(await scan(tablet, { text: "SC-0001" }, { atTabletPace: true })).toEqual({ status: 503, body: { code: "unreachable", message: expect.stringContaining("can't be reached") } });
      const waited = tablet.readClock() - before;
      expect(waited).toBeGreaterThanOrEqual(10_000);
      expect(waited).toBeLessThan(30_000);
      expect(await server.next("request")).toMatchObject({ ask: "bringBatch", text: "SC-0001" });
    } finally {
      await server.stop();
    }
  });

  it("is never sent to a server of the release before, which the status says can't be asked: it is refused as too old to ask", async () => {
    const { server, tablet } = await standIn("stand-in token 70892", 70_892, { wireRevision: WIRE_REVISION - 1 });
    try {
      const asking = answered(tablet.callEndpoint("status"));
      const request = await server.next("request");
      server.send({ type: "answer", id: String(request.id), ask: "status", result: { served: true, machine: { id: randomUUID(), name: "Stand-in" }, location: { id: randomUUID(), name: "Stand-in" } } });
      expect(await asking).toMatchObject({ status: 200, body: { connected: true, served: true, scan: false } });
      for (const body of [{ text: "SC-0001" }, { match: randomUUID() }]) {
        expect(await scan(tablet, body)).toEqual({ status: 503, body: { code: "serverTooOld", message: expect.stringContaining("too old") } });
      }
      expect(server.received.filter((message) => message.type === "request")).toEqual([request]);
      expect(tablet.logs.filter((line) => line.includes("Ignoring a message from the server"))).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
