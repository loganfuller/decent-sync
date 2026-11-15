import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, Refusal, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #513 (milestone 8, ADR-0031): an edit of a Shot's rating
// or note made through the server, and a change made on the tablet that
// holds the Shot, neither having seen the other; and a tablet that no longer
// holds the Shot. The later edit of a field wins, and an edit awaiting its
// tablet never undoes a later change made there. Through the built plugin in
// a simulated tablet against a real server, the tablet carrying out Decaid's
// own Shot update as its source has it (support/decaid-shots.ts), each case
// with the tablet's report reaching the server before the server's write
// reaches the tablet, and after it. Then the decision itself, with raw
// frames. Shots are derived from one Decaid recorded, changing only its id,
// time, recorded hardware and annotations. Serials are made up, from 51301.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "1" };

const SERIAL = "51301";
/** The server's advisory lock class for one Shot id (`SHOT_LOCK` in shots.service.ts). */
const SHOT_LOCK = 4_000_003;

interface Edit {
  id: string;
  fields: { rating?: number; note?: string };
  state: "awaitingTablet" | "written" | "dropped" | "noTablet";
  dropped: ("rating" | "note")[];
  writtenAt: string | null;
}

interface ShotView {
  id: string;
  enjoyment: number | null;
  notes: string | null;
  edits: Edit[];
}

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

/** A Shot pulled at a UTC time on the hardware of that serial, derived from the fixture with the annotations given beside its own. */
function shotOf(id: string, pulledAt: string, serial: string, annotations: Record_ = {}): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    workflow: { ...workflow, machine: { ...(workflow.machine as Record_), model: "DE1Pro", serialNumber: serial } },
    annotations: { ...(fixture.annotations as Record_), ...annotations },
  };
}

/** The Shot as the tablet's own Decaid holds it. */
async function onTablet(tablet: SimulatedTablet, id: string): Promise<Record_> {
  const { status, body } = await tablet.callApi("GET", `/shots/${id}`);
  expect(status).toBe(200);
  return body as Record_;
}

const framesOf = (frames: readonly unknown[], type: string) => (frames as Record_[]).filter((frame) => frame.type === type);
/** The server's writes of the Shot the tablet has been sent, and the plugin's answers to them, by the edits' ids. */
const editsSent = (tablet: SimulatedTablet, id: string) => framesOf(tablet.received, "shotEdit").filter((frame) => frame.shotId === id);
const answersSent = (tablet: SimulatedTablet, id: string) => {
  const ids = new Set(editsSent(tablet, id).map((frame) => frame.id));
  return framesOf(tablet.sent, "shotEdited").filter((frame) => ids.has(frame.id));
};

/**
 * Lets a second pass between two events timed by different clocks, the
 * tablet's Decaid's and PostgreSQL's, so that the later is the later by
 * both (docs/AI_BUILD_NOTES.md).
 */
const aSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

describe("Two edits of one Shot's rating or note", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let belmont: LocationView;
  let machine: CreatedMachine;
  let tablet: SimulatedTablet;
  /** What a test holds until its tablet is back, released after it whether or not it passed. */
  const held: (() => unknown)[] = [];

  const read = async (id: string) => (await api.get<{ shot: ShotView }>(`/shots/${id}`)).shot;
  const edit = async (id: string, fields: Record_) => (await api.send<{ shot: ShotView }>("PATCH", `/shots/${id}`, fields)).shot;
  /** The Shot's rating and note as the server reads them, and each of its edits, newest first: its fields, where it stands and the fields of it dropped. */
  const view = async (id: string) => {
    const { enjoyment, notes, edits } = await read(id);
    return { enjoyment, notes, edits: edits.map((made) => [made.fields, made.state, made.dropped]) };
  };
  const states = async (id: string) => (await read(id)).edits.map((made) => made.state);

  /** Resolves once the server lists the Shot. */
  async function stored(id: string): Promise<void> {
    await expect.poll(async () => (await api.call("GET", `/shots/${id}`)).status, { timeout: 30_000 }).toBe(200);
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    belmont = await api.createLocation("Belmont", "America/Chicago");
    machine = await api.createMachine("Belmont 1");
    await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: belmont.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    tablet = tablets.syncing(machine, server, { api: emptyLibrary(SERIAL) });
    await api.waitForOnline(machine);
  });

  afterEach(async () => {
    for (const release of held.splice(0)) await release();
    tablet.refuseWrites = undefined;
    tablet.restoreNetwork();
  });

  /** Pulls a Shot on the tablet, rated 4 with a note, and resolves once the server lists it. */
  async function pulled(id: string): Promise<void> {
    tablet.pullShot(shotOf(id, "2026-11-12T09:00:00.000Z", SERIAL, { enjoyment: 4, espressoNotes: "As pulled" }));
    await stored(id);
  }

  /** Takes the tablet off the network, as one switched off, and resolves once the server sees it gone. */
  async function offline(): Promise<void> {
    tablet.loseNetwork();
    await api.waitForMachine("Belmont 1", (viewed) => !viewed.online);
  }

  /**
   * Changes the Shot on the tablet, as a barista does in its Skin or in
   * DYE2: through Decaid's own Shot update, which tells the plugin. Resolves
   * with the version Decaid gave the Shot.
   */
  async function changeOnTablet(id: string, annotations: Record_): Promise<string> {
    const { status, body } = await tablet.callApi("PUT", `/shots/${id}`, { annotations });
    expect(status).toBe(200);
    return String((body as Record_).updatedAt);
  }

  const ORDERS = ["the tablet's report reaching the server first", "the server's write reaching the tablet first"] as const;

  /**
   * Brings the tablet back, with its report of the Shot and the server's
   * write of it in the order given, each side's turn decided by something
   * the test holds rather than by timing:
   *
   * - **The report first.** The plugin reads a Shot before it writes it, so
   *   its reads are held until the server has stored the tablet's report.
   * - **The write first.** The server stores a report under the Shot's
   *   lock, so the lock is held until the plugin has answered the write the
   *   server sent it on its welcome.
   */
  async function reconnect(order: (typeof ORDERS)[number], id: string): Promise<void> {
    if (order === ORDERS[0]) {
      held.push(tablet.holdShotReads());
      tablet.restoreNetwork();
      await expect.poll(() => tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === id), { timeout: 30_000 }).toBe(true);
    } else {
      const answered = answersSent(tablet, id).length;
      const database = await server.connectDatabase();
      held.push(async () => {
        await database.query("SELECT pg_advisory_unlock($1::int, hashtext($2::text))", [SHOT_LOCK, id]);
        await database.end();
      });
      await database.query("SELECT pg_advisory_lock($1::int, hashtext($2::text))", [SHOT_LOCK, id]);
      tablet.restoreNetwork();
      // The report waits for the lock, and the write goes out meanwhile: the plugin answers it before the server has the report.
      await waitForLockWaits(server, { advisory: true });
      await expect.poll(() => answersSent(tablet, id).length, { timeout: 30_000 }).toBeGreaterThan(answered);
      expect(tablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === id)).toBe(false);
    }
    for (const release of held.splice(0)) await release();
  }

  /** Resolves once the plugin has answered every write of the Shot it was sent, and the server has every report of it. */
  async function settled(id: string): Promise<void> {
    await expect.poll(() => answersSent(tablet, id).length).toBe(editsSent(tablet, id).length);
    await expect.poll(() => tablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === id)).toBe(true);
  }

  /** The plugin's writes of the Shot into Decaid, as Decaid's own Shot update. */
  const writesOf = (id: string) => tablet.writes.filter((write) => write === `PUT /shots/${id}`);

  describe.each(ORDERS)("with %s", (order) => {
    const slug = order === ORDERS[0] ? "report-first" : "write-first";

    it("keeps the tablet's later change of the rating on both sides, and marks the edit dropped", async () => {
      const id = `conflict-rating-${slug}`;
      await pulled(id);
      await offline();
      expect(await edit(id, { rating: 8 })).toMatchObject({ enjoyment: 8, notes: "As pulled" });
      await aSecond();
      await changeOnTablet(id, { enjoyment: 6 });

      await reconnect(order, id);
      // The tablet's rating stands on the server, and the edit is still listed, as not written.
      await expect.poll(() => view(id)).toEqual({ enjoyment: 6, notes: "As pulled", edits: [[{ rating: 8 }, "dropped", ["rating"]]] });
      expect((await read(id)).edits[0]).toMatchObject({ writtenAt: null });
      await settled(id);
      // And on the tablet: the plugin wrote nothing, whichever came first.
      expect(writesOf(id)).toEqual([]);
      expect(answersSent(tablet, id).map((answer) => answer.outcome)).toEqual(editsSent(tablet, id).map(() => "changed"));
      expect((await onTablet(tablet, id)).annotations).toMatchObject({ enjoyment: 6, espressoNotes: "As pulled" });
      expect(await view(id)).toMatchObject({ enjoyment: 6, notes: "As pulled" });
    });

    it("writes the server's rating where the tablet changed only the note, and keeps the tablet's note", async () => {
      const id = `conflict-note-${slug}`;
      await pulled(id);
      await offline();
      const [made] = (await edit(id, { rating: 8 })).edits;
      await aSecond();
      const version = await changeOnTablet(id, { espressoNotes: "Thin, said at the tablet" });

      await reconnect(order, id);
      await expect.poll(() => view(id)).toEqual({ enjoyment: 8, notes: "Thin, said at the tablet", edits: [[{ rating: 8 }, "written", []]] });
      await settled(id);
      // Written once, for the version the tablet had made, with the rating alone.
      expect(writesOf(id)).toHaveLength(1);
      expect(editsSent(tablet, id).at(-1)).toEqual({ type: "shotEdit", id: made!.id, shotId: id, version, rating: 8 });
      expect((await onTablet(tablet, id)).annotations).toMatchObject({ enjoyment: 8, espressoNotes: "Thin, said at the tablet" });
      // The tablet's report of that write changes nothing.
      expect(await view(id)).toMatchObject({ enjoyment: 8, notes: "Thin, said at the tablet" });
    });

    it("writes the server's edit where the tablet's change of the same field was made before it", async () => {
      const id = `conflict-earlier-${slug}`;
      await pulled(id);
      await offline();
      await changeOnTablet(id, { enjoyment: 6 });
      await aSecond();
      expect(await edit(id, { rating: 8 })).toMatchObject({ enjoyment: 8 });

      await reconnect(order, id);
      await expect.poll(() => view(id)).toEqual({ enjoyment: 8, notes: "As pulled", edits: [[{ rating: 8 }, "written", []]] });
      await settled(id);
      expect(writesOf(id)).toHaveLength(1);
      expect((await onTablet(tablet, id)).annotations).toMatchObject({ enjoyment: 8, espressoNotes: "As pulled" });
      expect(await view(id)).toMatchObject({ enjoyment: 8, notes: "As pulled" });
    });

    it("ends the tablet with the later of two edits of one field made through the server, both awaiting it", async () => {
      const id = `conflict-two-${slug}`;
      await pulled(id);
      await offline();
      expect(await edit(id, { rating: 2 })).toMatchObject({ enjoyment: 2 });
      expect(await edit(id, { rating: 9 })).toMatchObject({ enjoyment: 9 });
      await aSecond();
      // The tablet changes the other field meanwhile, so it has a report to make.
      await changeOnTablet(id, { espressoNotes: "Said at the tablet" });

      await reconnect(order, id);
      await expect.poll(() => view(id)).toEqual({
        enjoyment: 9,
        notes: "Said at the tablet",
        edits: [[{ rating: 9 }, "written", []], [{ rating: 2 }, "written", []]],
      });
      await settled(id);
      // One write, of the later: the earlier was never written by itself.
      expect(writesOf(id)).toHaveLength(1);
      expect(editsSent(tablet, id).map((write) => write.rating)).toEqual(editsSent(tablet, id).map(() => 9));
      expect((await onTablet(tablet, id)).annotations).toMatchObject({ enjoyment: 9, espressoNotes: "Said at the tablet" });
      expect(await view(id)).toMatchObject({ enjoyment: 9, notes: "Said at the tablet" });
    });
  });

  it("keeps an edit whose tablet no longer holds the Shot, marks it as having no tablet to reach, and sends it no more", async () => {
    const [id, other, deleted] = ["conflict-gone", "conflict-kept", "conflict-deleted"];
    await pulled(id);
    await pulled(other);
    await pulled(deleted);
    await offline();
    // The tablet was reset: Decaid there no longer holds the Shot.
    tablet.refuseFor(`/shots/${id}`, new Refusal(404, { error: "Shot not found" }));
    expect(await edit(id, { rating: 7 })).toMatchObject({ enjoyment: 7 });
    expect(await states(id)).toEqual(["awaitingTablet"]);

    tablet.restoreNetwork();
    await expect.poll(() => states(id), { timeout: 30_000 }).toEqual(["noTablet"]);
    expect(answersSent(tablet, id)).toEqual([{ type: "shotEdited", id: expect.any(String), outcome: "notHeld" }]);
    // The edit stays on the server, as the Shot reads.
    expect(await view(id)).toEqual({ enjoyment: 7, notes: "As pulled", edits: [[{ rating: 7 }, "noTablet", []]] });
    expect((await read(id)).edits[0]).toMatchObject({ writtenAt: null });

    // On its next connection the tablet is written what its other Shots are due, the longest waiting first, and that edit not again.
    await offline();
    await edit(other, { rating: 3 });
    tablet.restoreNetwork();
    await expect.poll(() => states(other), { timeout: 30_000 }).toEqual(["written"]);
    expect(editsSent(tablet, id)).toHaveLength(1);

    // A later edit of the Shot is kept the same way: sent once, and marked in turn.
    expect(await edit(id, { note: "Still on the server" })).toMatchObject({ enjoyment: 7, notes: "Still on the server" });
    await expect.poll(() => states(id)).toEqual(["noTablet", "noTablet"]);
    expect(editsSent(tablet, id)).toHaveLength(2);
    expect(writesOf(id)).toEqual([]);

    // A Shot deleted on the tablet between the plugin's read of it and its write: Decaid refuses the update the same way.
    tablet.refuseWrites = ({ method, route }) => (method === "PUT" && route === `/shots/${deleted}` ? { status: 404, body: { error: "Shot not found" } } : undefined);
    await edit(deleted, { rating: 1 });
    await expect.poll(() => states(deleted)).toEqual(["noTablet"]);
    expect(answersSent(tablet, deleted)).toEqual([{ type: "shotEdited", id: expect.any(String), outcome: "notHeld" }]);
  });

  describe("the decision, with raw frames", () => {
    /** A welcomed raw connection holding the Machine, as the tablet of that id reporting that hardware. */
    const connect = (held: CreatedMachine, serial: string, tabletId: string) =>
      RawConnection.welcomed(held.serverUrl, helloWith(held.token, { machine: { model: "DE1Pro", serial }, tabletId }));

    /** Sends the Shot whole as the connection's tablet's, and waits for its acknowledgment. */
    const report = (raw: RawConnection, shot: Record_) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot });

    /** Sends a later version of the Shot as Decaid reports an update of it, its metadata alone, with these annotations beside its own, and waits for its acknowledgment. */
    async function reportUpdate(raw: RawConnection, shot: Record_, updatedAt: string, annotations: Record_): Promise<void> {
      const { measurements: _measurements, ...metadata } = shot;
      const merged = { ...(shot.annotations as Record_), ...annotations };
      await raw.deliver({ type: "shotUpdated", id: randomUUID(), shotId: shot.id, shot: { ...metadata, updatedAt, annotations: merged, shotNotes: merged.espressoNotes } });
    }

    /** The connection's first message that matches, once it has arrived. */
    async function next(raw: RawConnection, matches: (message: Record_) => boolean): Promise<Record_> {
      let found: Record_ | undefined;
      await expect.poll(() => (found = (raw.messages as Record_[]).find(matches)), { timeout: 15_000 }).toBeDefined();
      return found!;
    }

    /** Resolves once the server has handled everything the connection sent before this. */
    const handled = (raw: RawConnection) => raw.deliver({ type: "shotIndex", id: randomUUID(), shots: [] });
    const editsTo = (raw: RawConnection) => (raw.messages as Record_[]).filter((message) => message.type === "shotEdit");
    /** A time by a tablet's clock that many seconds from now, as Decaid writes one: later than any edit made so far, where its clock runs ahead. */
    const tabletTime = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

    it("decides each field by itself once the tablet's report follows its answer: the tablet's later note stands, and the server's rating is still written", async () => {
      const held = await api.createMachine("Raw conflicts 1", belmont.id);
      const raw = await connect(held, "51311", randomUUID());
      const shot = shotOf("conflict-raw-fields", "2026-11-12T10:00:00.000Z", "51311", { enjoyment: 4, espressoNotes: "As pulled" });
      await report(raw, shot);

      await edit("conflict-raw-fields", { rating: 8, note: "Said at the office" });
      const first = await next(raw, (message) => message.type === "shotEdit");
      expect(first).toEqual({ type: "shotEdit", id: expect.any(String), shotId: "conflict-raw-fields", version: shot.updatedAt, rating: 8, note: "Said at the office" });
      // The tablet holds a later version, so the plugin wrote nothing: the edit waits for the tablet's report of it.
      raw.send({ type: "shotEdited", id: first.id, outcome: "changed" });
      await handled(raw);
      expect(await view("conflict-raw-fields")).toEqual({ enjoyment: 8, notes: "Said at the office", edits: [[{ rating: 8, note: "Said at the office" }, "awaitingTablet", []]] });
      expect(editsTo(raw)).toHaveLength(1);

      // The report: the tablet changed the note, later than the edit, and left the rating as it was.
      const later = tabletTime(60);
      await reportUpdate(raw, shot, later, { espressoNotes: "Said at the tablet" });
      expect(await view("conflict-raw-fields")).toEqual({ enjoyment: 8, notes: "Said at the tablet", edits: [[{ rating: 8, note: "Said at the office" }, "awaitingTablet", ["note"]]] });
      // What still stands goes for the version reported: the rating alone.
      const second = await next(raw, (message) => message.type === "shotEdit" && message.version === later);
      expect(second).toEqual({ type: "shotEdit", id: first.id, shotId: "conflict-raw-fields", version: later, rating: 8 });
      raw.send({ type: "shotEdited", id: second.id, outcome: "written" });
      await expect.poll(() => view("conflict-raw-fields")).toEqual({ enjoyment: 8, notes: "Said at the tablet", edits: [[{ rating: 8, note: "Said at the office" }, "written", ["note"]]] });

      // An edit of both fields, both of which the tablet changed later, is dropped whole.
      await edit("conflict-raw-fields", { rating: 1, note: "Office again" });
      const third = await next(raw, (message) => message.type === "shotEdit" && message.rating === 1);
      raw.send({ type: "shotEdited", id: third.id, outcome: "changed" });
      await reportUpdate(raw, shot, tabletTime(120), { enjoyment: 9, espressoNotes: "Tablet again" });
      expect(await view("conflict-raw-fields")).toMatchObject({ enjoyment: 9, notes: "Tablet again", edits: [[{ rating: 1, note: "Office again" }, "dropped", ["rating", "note"]], [expect.anything(), "written", ["note"]]] });
      await handled(raw);
      expect(editsTo(raw)).toHaveLength(3);
      await raw.close();
    });

    it("takes the tablet's report of a write under way as that write, not a change of the tablet's, so an edit made meanwhile stands", async () => {
      const held = await api.createMachine("Raw conflicts 2", belmont.id);
      const raw = await connect(held, "51312", randomUUID());
      const shot = shotOf("conflict-raw-under-way", "2026-11-12T11:00:00.000Z", "51312", { enjoyment: 4 });
      await report(raw, shot);

      await edit("conflict-raw-under-way", { rating: 1 });
      const first = await next(raw, (message) => message.type === "shotEdit");
      // Made while the first write is under way.
      await edit("conflict-raw-under-way", { rating: 2 });
      const second = (await read("conflict-raw-under-way")).edits[0]!.id;
      // Decaid reports the Shot as the plugin writes it, which reaches the server before the plugin's answer: a version
      // later than both edits by the tablet's clock, reading as the first set it.
      const written = tabletTime(60);
      await reportUpdate(raw, shot, written, { enjoyment: 1 });
      expect(await view("conflict-raw-under-way")).toEqual({ enjoyment: 2, notes: null, edits: [[{ rating: 2 }, "awaitingTablet", []], [{ rating: 1 }, "awaitingTablet", []]] });
      raw.send({ type: "shotEdited", id: first.id, outcome: "written" });
      // The later edit goes next, for the version the write made.
      expect(await next(raw, (message) => message.type === "shotEdit" && message.id === second)).toEqual({ type: "shotEdit", id: second, shotId: "conflict-raw-under-way", version: written, rating: 2 });
      expect(await states("conflict-raw-under-way")).toEqual(["awaitingTablet", "written"]);

      // A version reading as neither what the tablet held nor anything the server wrote is the tablet's own change:
      // later than the edit, it stands, and the plugin's answer that it had written the edit before it changes nothing.
      await reportUpdate(raw, shot, tabletTime(120), { enjoyment: 7 });
      expect(await view("conflict-raw-under-way")).toMatchObject({ enjoyment: 7, edits: [[{ rating: 2 }, "dropped", ["rating"]], [{ rating: 1 }, "written", []]] });
      raw.send({ type: "shotEdited", id: second, outcome: "written" });
      await handled(raw);
      expect(await view("conflict-raw-under-way")).toMatchObject({ enjoyment: 7, edits: [[{ rating: 2 }, "dropped", ["rating"]], [{ rating: 1 }, "written", []]] });
      await raw.close();
    });

    it("leaves an edit made while a write was under way standing, where the plugin's answer comes before the tablet's report of that write", async () => {
      const held = await api.createMachine("Raw conflicts 5", belmont.id);
      const raw = await connect(held, "51315", randomUUID());
      const shot = shotOf("conflict-raw-answered", "2026-11-12T14:00:00.000Z", "51315", { enjoyment: 4 });
      await report(raw, shot);
      await edit("conflict-raw-answered", { rating: 1 });
      const first = await next(raw, (message) => message.type === "shotEdit");
      await edit("conflict-raw-answered", { rating: 2 });
      const second = (await read("conflict-raw-answered")).edits[0]!.id;
      // The answer first: the tablet then holds what the write carried. The second edit goes out for the version before.
      raw.send({ type: "shotEdited", id: first.id, outcome: "written" });
      expect(await next(raw, (message) => message.type === "shotEdit" && message.id === second)).toMatchObject({ version: shot.updatedAt, rating: 2 });
      // Then Decaid's report of the first write, later than the second edit by the tablet's clock: it reads as the
      // tablet holds it, so it is no change of the tablet's, and the second edit stands.
      const written = tabletTime(60);
      await reportUpdate(raw, shot, written, { enjoyment: 1 });
      expect(await view("conflict-raw-answered")).toEqual({ enjoyment: 2, notes: null, edits: [[{ rating: 2 }, "awaitingTablet", []], [{ rating: 1 }, "written", []]] });
      // The plugin found the Shot later than the second write was sent for: it goes again, for the version reported.
      raw.send({ type: "shotEdited", id: second, outcome: "changed" });
      expect(await next(raw, (message) => message.type === "shotEdit" && message.version === written)).toEqual({ type: "shotEdit", id: second, shotId: "conflict-raw-answered", version: written, rating: 2 });
      raw.send({ type: "shotEdited", id: second, outcome: "written" });
      await expect.poll(() => states("conflict-raw-answered")).toEqual(["written", "written"]);
      await raw.close();
    });

    it("reads each report against what the tablet held after the one before: a rating the tablet changed before the edit is not a change in its next report", async () => {
      const held = await api.createMachine("Raw conflicts 6", belmont.id);
      const tabletId = randomUUID();
      const raw = await connect(held, "51316", tabletId);
      const shot = shotOf("conflict-raw-twice", "2026-11-12T15:00:00.000Z", "51316", { enjoyment: 4 });
      await report(raw, shot);
      await raw.close();
      await api.waitForMachine("Raw conflicts 6", (viewed) => !viewed.online);
      // The tablet, off, changed the rating a minute before the edit made through the server, and its note a minute after.
      const [before, after] = [tabletTime(-60), tabletTime(60)];
      await edit("conflict-raw-twice", { rating: 8 });

      const again = await connect(held, "51316", tabletId);
      const first = await next(again, (message) => message.type === "shotEdit");
      again.send({ type: "shotEdited", id: first.id, outcome: "changed" });
      // Its earlier change of the rating loses to the edit, which stands.
      await reportUpdate(again, shot, before, { enjoyment: 6 });
      expect(await view("conflict-raw-twice")).toEqual({ enjoyment: 8, notes: null, edits: [[{ rating: 8 }, "awaitingTablet", []]] });
      // It goes out again for that version, which the tablet has since moved past.
      const second = await next(again, (message) => message.type === "shotEdit" && message.version === before);
      // Its later report repeats that rating, with the note changed: the rating is no change since, so the edit still stands.
      await reportUpdate(again, shot, after, { enjoyment: 6, espressoNotes: "Said at the tablet" });
      expect(await view("conflict-raw-twice")).toEqual({ enjoyment: 8, notes: "Said at the tablet", edits: [[{ rating: 8 }, "awaitingTablet", []]] });
      again.send({ type: "shotEdited", id: second.id, outcome: "changed" });
      const last = await next(again, (message) => message.type === "shotEdit" && message.version === after);
      expect(last).toEqual({ type: "shotEdit", id: first.id, shotId: "conflict-raw-twice", version: after, rating: 8 });
      again.send({ type: "shotEdited", id: last.id, outcome: "written" });
      await expect.poll(() => states("conflict-raw-twice")).toEqual(["written"]);
      await again.close();
    });

    it("writes again an edit whose answer was lost with its connection, though the tablet's report of the write came in first", async () => {
      const held = await api.createMachine("Raw conflicts 3", belmont.id);
      const tabletId = randomUUID();
      const raw = await connect(held, "51313", tabletId);
      const shot = shotOf("conflict-raw-lost", "2026-11-12T12:00:00.000Z", "51313", { enjoyment: 4 });
      await report(raw, shot);
      await edit("conflict-raw-lost", { rating: 5 });
      const first = await next(raw, (message) => message.type === "shotEdit");
      // The plugin wrote it, and its answer went with the connection.
      await raw.close();
      await api.waitForMachine("Raw conflicts 3", (viewed) => !viewed.online);

      const again = await connect(held, "51313", tabletId);
      expect(await next(again, (message) => message.type === "shotEdit")).toEqual(first);
      // The tablet's report of the write, from its outbox: it reads as the edit set it, so nothing is dropped.
      const written = tabletTime(60);
      await reportUpdate(again, shot, written, { enjoyment: 5 });
      expect(await view("conflict-raw-lost")).toEqual({ enjoyment: 5, notes: null, edits: [[{ rating: 5 }, "awaitingTablet", []]] });
      // The write sent on the welcome was for the version before: answered as changed, it is sent again at once, as the
      // report came in since, and the plugin's write of what the Shot holds marks it written.
      again.send({ type: "shotEdited", id: first.id, outcome: "changed" });
      const resent = await next(again, (message) => message.type === "shotEdit" && message.version === written);
      expect(resent).toEqual({ ...first, version: written });
      again.send({ type: "shotEdited", id: resent.id, outcome: "written" });
      await expect.poll(() => states("conflict-raw-lost")).toEqual(["written"]);
      await again.close();
    });

    it("keeps an edit made at the very time of the tablet's version, and marks nothing for a tablet that is no longer the one holding the Shot", async () => {
      const [first, other] = [await api.createMachine("Raw conflicts 7", belmont.id), await api.createMachine("Raw conflicts 8", belmont.id)];
      const holder = await connect(first, "51317", randomUUID());
      const shot = shotOf("conflict-raw-tie", "2026-11-12T16:00:00.000Z", "51317", { enjoyment: 4 });
      await report(holder, shot);
      await edit("conflict-raw-tie", { rating: 8 });
      const sent = await next(holder, (message) => message.type === "shotEdit");
      // The edit's own time, to the microsecond, as a tablet would write it.
      const database = await server.connectDatabase();
      const { rows } = await database.query(`SELECT to_char(made_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "madeAt" FROM shot_edits WHERE id = $1`, [sent.id]);
      await database.end();
      const madeAt = (rows[0] as { madeAt: string }).madeAt;
      // A version of that very time in which the tablet changed the rating is not the later: the edit stands.
      holder.send({ type: "shotEdited", id: sent.id, outcome: "changed" });
      await reportUpdate(holder, shot, madeAt, { enjoyment: 6 });
      expect(await view("conflict-raw-tie")).toEqual({ enjoyment: 8, notes: null, edits: [[{ rating: 8 }, "awaitingTablet", []]] });
      const again = await next(holder, (message) => message.type === "shotEdit" && message.version === madeAt);

      // Another tablet reports the Shot, as one restored from the first's backup, and holds it from then on: the
      // first's answer that it no longer holds the Shot marks nothing.
      const bystander = await connect(other, "51318", randomUUID());
      await reportUpdate(bystander, shot, tabletTime(60), { enjoyment: 6 });
      holder.send({ type: "shotEdited", id: again.id, outcome: "notHeld" });
      await handled(holder);
      expect(await states("conflict-raw-tie")).toEqual(["awaitingTablet"]);
      await holder.close();
      await bystander.close();
    });

    it("marks every edit awaiting a tablet that no longer holds the Shot, one made since the write was sent too, and takes a later version of the Shot whole", async () => {
      const held = await api.createMachine("Raw conflicts 4", belmont.id);
      const tabletId = randomUUID();
      const raw = await connect(held, "51314", tabletId);
      const shot = shotOf("conflict-raw-gone", "2026-11-12T13:00:00.000Z", "51314", { enjoyment: 4 });
      await report(raw, shot);
      await edit("conflict-raw-gone", { rating: 5 });
      const first = await next(raw, (message) => message.type === "shotEdit");
      await edit("conflict-raw-gone", { note: "Made since" });
      raw.send({ type: "shotEdited", id: first.id, outcome: "notHeld" });
      await expect.poll(() => states("conflict-raw-gone")).toEqual(["noTablet", "noTablet"]);
      await handled(raw);
      expect(editsTo(raw)).toHaveLength(1);
      await raw.close();
      await api.waitForMachine("Raw conflicts 4", (viewed) => !viewed.online);

      // Nothing is sent on its next connection.
      const again = await connect(held, "51314", tabletId);
      await handled(again);
      expect(editsTo(again)).toEqual([]);
      // The Shot back on a tablet, as one restored from a backup made before the edits, at a later version: with no
      // edit awaiting it, the version is stored whole, as any tablet's is.
      await reportUpdate(again, shot, tabletTime(60), { enjoyment: 4 });
      expect(await view("conflict-raw-gone")).toMatchObject({ enjoyment: 4, notes: null, edits: [[{ note: "Made since" }, "noTablet", []], [{ rating: 5 }, "noTablet", []]] });
      await again.close();
    });
  });
});
