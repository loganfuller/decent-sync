import { randomUUID } from "node:crypto";
import { SHOT_EDITS_WIRE_REVISION, WIRE_REVISION } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #512 (milestone 8, ADR-0031): a Shot's rating and note
// edited through the REST API, applied to the Shot the server holds at once
// and written into the Shot on the tablet that holds it. Through the built
// plugin in simulated tablets against a real server: one at Belmont and one
// at the Lab, each pulling Shots derived from a Shot Decaid recorded,
// changing only its id, time and recorded hardware. The simulated tablet
// carries out Decaid's own Shot update as its source has it at v0.9.1 and
// v0.9.2 (support/decaid-shots.ts). Then the write itself, with raw frames.
// Serials are made up, from 51201.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "1" };

const BELMONT_SERIAL = "51201";
const LAB_SERIAL = "51202";
const THIRD_SERIAL = "51203";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "51209";

interface Edit {
  id: string;
  fields: { rating?: number; note?: string };
  account: { id: string; name: string | null } | null;
  connectedApp: unknown;
  madeAt: string;
  state: "awaitingTablet" | "written";
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

/** The Shot as the tablet's own Decaid holds it, or null where it holds none. */
async function onTablet(tablet: SimulatedTablet, id: string): Promise<Record_ | null> {
  const { status, body } = await tablet.callApi("GET", `/shots/${id}`);
  return status === 200 ? (body as Record_) : null;
}

const annotationsOf = async (tablet: SimulatedTablet, id: string) => ((await onTablet(tablet, id))?.annotations ?? null) as Record_ | null;
const framesOf = (frames: readonly unknown[], type: string) => (frames as Record_[]).filter((frame) => frame.type === type);
const editsSent = (tablet: SimulatedTablet) => framesOf(tablet.received, "shotEdit");
const answersSent = (tablet: SimulatedTablet) => framesOf(tablet.sent, "shotEdited");

describe("A Shot's rating and note edited through the server", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let belmont: LocationView;
  let lab: LocationView;
  let belmontMachine: CreatedMachine;
  let labMachine: CreatedMachine;
  let belmontTablet: SimulatedTablet;
  let labTablet: SimulatedTablet;
  let adminId: string;

  runAsSteps();

  const read = async (id: string, as: AdminApi = api) => (await as.get<{ shot: ShotView }>(`/shots/${id}`)).shot;
  const edit = async (id: string, fields: Record_, as: AdminApi = api) => (await as.send<{ shot: ShotView }>("PATCH", `/shots/${id}`, fields)).shot;
  /** The states of the Shot's edits, newest first. */
  const states = async (id: string) => (await read(id)).edits.map((made) => made.state);
  /** Resolves once the server lists the Shots: polled by hand, as a hook can't call expect.poll. */
  async function stored(...ids: string[]): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!(await Promise.all(ids.map((id) => api.call("GET", `/shots/${id}`)))).every((response) => response.status === 200)) {
      if (Date.now() > deadline) throw new Error(`The server did not store ${ids.join(", ")} in time`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  /** The deliveries of the Shot the tablet has sent the server since it loaded, by type. */
  const reportsOf = (tablet: SimulatedTablet, id: string) => (tablet.sent as Record_[]).filter((frame) => frame.shotId === id).map((frame) => frame.type);

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    adminId = (await api.accounts()).find((account) => account.email === admin.email)!.id;
    belmont = await api.createLocation("Belmont", "America/Chicago");
    lab = await api.createLocation("Lab", "America/Denver");
    belmontMachine = await api.createMachine("Belmont 1");
    labMachine = await api.createMachine("Lab 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[belmontMachine, belmont], [labMachine, lab]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    belmontTablet = tablets.syncing(belmontMachine, server, { api: emptyLibrary(BELMONT_SERIAL) });
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(belmontMachine, labMachine);
    belmontTablet.pullShot(shotOf("edit-belmont-rated", "2026-11-10T09:00:00.000Z", BELMONT_SERIAL, { enjoyment: 4, espressoNotes: "Sour at first" }));
    belmontTablet.pullShot(shotOf("edit-belmont-plain", "2026-11-10T09:05:00.000Z", BELMONT_SERIAL));
    // Recorded on hardware no Machine has: a Pending Machine's, at no Location, held by Belmont's tablet.
    belmontTablet.pullShot(shotOf("edit-pending", "2026-11-10T09:10:00.000Z", UNKNOWN_SERIAL));
    labTablet.pullShot(shotOf("edit-lab", "2026-11-10T10:00:00.000Z", LAB_SERIAL, { enjoyment: 6 }));
    await stored("edit-belmont-rated", "edit-belmont-plain", "edit-pending", "edit-lab");
  });

  it("applies a rating at once: the Shot's read, the list's row and a Shot Summary show it", async () => {
    const before = await read("edit-belmont-rated");
    expect(before).toMatchObject({ enjoyment: 4, notes: "Sour at first", edits: [] });

    const edited = await edit("edit-belmont-rated", { rating: 8 });
    // The answer is the Shot as it now reads, with the edit: nothing waited for the tablet.
    expect(edited).toMatchObject({ id: "edit-belmont-rated", enjoyment: 8, notes: "Sour at first" });
    expect(edited.edits).toHaveLength(1);
    expect(edited.edits[0]).toMatchObject({ fields: { rating: 8 }, account: { id: adminId, name: admin.name }, connectedApp: null });
    expect(edited.edits[0]!.fields).not.toHaveProperty("note");
    expect(Math.abs(Date.parse(edited.edits[0]!.madeAt) - Date.now())).toBeLessThan(60_000);

    const { shots } = await api.get<{ shots: { id: string; enjoyment: number | null; notes: string | null }[] }>(`/shots?machineId=${belmontMachine.machine.id}`);
    expect(shots.find((shot) => shot.id === "edit-belmont-rated")).toMatchObject({ enjoyment: 8, notes: "Sour at first" });
    // Belmont's other Shot recorded no rating, so the summary's is this one's.
    const { groups } = await api.get<{ groups: { numbers: { rating: { median: number | null } } }[] }>(`/shots/summary?machineId=${belmontMachine.machine.id}&numbers=rating`);
    expect(groups[0]!.numbers.rating.median).toBe(8);
  });

  it("writes the rating into the tablet's own Shot, leaving its note alone, and marks the edit written", async () => {
    await expect.poll(() => states("edit-belmont-rated")).toEqual(["written"]);
    const [made] = (await read("edit-belmont-rated")).edits;
    expect(Date.parse(made!.writtenAt!)).toBeGreaterThanOrEqual(Date.parse(made!.madeAt) - 1000);
    // Through Decaid's own Shot update, with the rating alone.
    expect(belmontTablet.writes.filter((write) => write.startsWith("PUT /shots/"))).toEqual(["PUT /shots/edit-belmont-rated"]);
    expect(editsSent(belmontTablet)).toEqual([{ type: "shotEdit", id: made!.id, shotId: "edit-belmont-rated", rating: 8 }]);
    expect(answersSent(belmontTablet)).toEqual([{ type: "shotEdited", id: made!.id, outcome: "written" }]);
    expect(await annotationsOf(belmontTablet, "edit-belmont-rated")).toMatchObject({ enjoyment: 8, espressoNotes: "Sour at first", actualDoseWeight: 18, actualYield: 35.9 });
  });

  it("takes the tablet's report of that write as any edit made on it: nothing changes, and no second edit is made", async () => {
    // Decaid told the plugin of the update, which sent it on as any edit of the Shot.
    await expect.poll(() => reportsOf(belmontTablet, "edit-belmont-rated")).toEqual(["shot", "shotUpdated"]);
    await expect.poll(() => belmontTablet.acknowledgedSome((frame: Record_) => frame.type === "shotUpdated" && frame.shotId === "edit-belmont-rated")).toBe(true);
    const after = await read("edit-belmont-rated");
    expect(after).toMatchObject({ enjoyment: 8, notes: "Sour at first" });
    expect(after.edits.map((made) => [made.fields, made.state])).toEqual([[{ rating: 8 }, "written"]]);
    // The tablet was sent the edit once.
    expect(editsSent(belmontTablet)).toHaveLength(1);
  });

  it("writes a note alone, leaving the rating alone, and both together", async () => {
    expect(await edit("edit-lab", { note: "Sweeter than yesterday's" })).toMatchObject({ enjoyment: 6, notes: "Sweeter than yesterday's" });
    await expect.poll(() => states("edit-lab")).toEqual(["written"]);
    expect(await annotationsOf(labTablet, "edit-lab")).toMatchObject({ enjoyment: 6, espressoNotes: "Sweeter than yesterday's" });
    // Decaid keeps its older name for the note equal to it.
    expect((await onTablet(labTablet, "edit-lab"))!.shotNotes).toBe("Sweeter than yesterday's");

    // Both, on a Shot that recorded neither; half ratings are Decaid's too.
    expect(await edit("edit-belmont-plain", { rating: 7.5, note: "Syrupy" })).toMatchObject({ enjoyment: 7.5, notes: "Syrupy" });
    await expect.poll(() => states("edit-belmont-plain")).toEqual(["written"]);
    expect(await annotationsOf(belmontTablet, "edit-belmont-plain")).toMatchObject({ enjoyment: 7.5, espressoNotes: "Syrupy", actualYield: 35.9 });

    // Unrated is 0 and no note is empty text: the Shot then reads as having neither.
    expect(await edit("edit-belmont-plain", { rating: 0, note: "" })).toMatchObject({ enjoyment: 0, notes: null });
    await expect.poll(() => states("edit-belmont-plain")).toEqual(["written", "written"]);
    expect(await annotationsOf(belmontTablet, "edit-belmont-plain")).toMatchObject({ enjoyment: 0, espressoNotes: "" });
    // Once the tablet's reports of both writes are in, the Shot reads the same.
    await expect.poll(() => reportsOf(belmontTablet, "edit-belmont-plain")).toEqual(["shot", "shotUpdated", "shotUpdated"]);
    await expect.poll(() => belmontTablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated")).toBe(true);
    expect(await read("edit-belmont-plain")).toMatchObject({ enjoyment: 0, notes: null });
    expect((await read("edit-belmont-plain")).edits.map((made) => made.fields)).toEqual([{ rating: 0, note: "" }, { rating: 7.5, note: "Syrupy" }]);
  });

  it("applies edits of one Shot made at once one at a time, and writes them to its tablet in that order", async () => {
    const ratings = [1, 2, 3, 4, 5, 6];
    await Promise.all(ratings.map((rating) => edit("edit-belmont-plain", { rating })));
    const made = (await read("edit-belmont-plain")).edits.slice(0, ratings.length).map((edit) => edit.fields.rating!);
    expect([...made].sort()).toEqual(ratings);
    // The tablet is sent them in the order they were applied, so it ends with the last of them.
    await expect.poll(async () => (await states("edit-belmont-plain")).slice(0, ratings.length)).toEqual(ratings.map(() => "written"));
    expect(editsSent(belmontTablet).slice(-ratings.length).map((sent) => sent.rating)).toEqual([...made].reverse());
    expect(await annotationsOf(belmontTablet, "edit-belmont-plain")).toMatchObject({ enjoyment: made[0] });
    // And so does the server, once the tablet's reports of the writes are in: until then it may read as an earlier one (#513).
    await expect.poll(() => reportsOf(belmontTablet, "edit-belmont-plain").length).toBe(3 + ratings.length);
    await expect.poll(() => belmontTablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated")).toBe(true);
    expect((await read("edit-belmont-plain")).enjoyment).toBe(made[0]);
  });

  it("keeps an edit made while the tablet is off awaiting it, and writes it when the tablet reconnects", async () => {
    // Belmont pulls a Recipe against the Lab's Shot, so its tablet keeps a copy of that Shot (#510).
    const { recipe } = await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: belmont.id, slot: 1, content: { name: "Against the Lab's" } }, 201);
    await api.send("PUT", `/recipes/${recipe.id}/reference-shot`, { shotId: "edit-lab" });
    /** The rating and note of the Reference Shot Belmont's tablet keeps for slot 1. */
    const copied = () => {
      const [, reference] = String(belmontTablet.storage.read("reference.1")).split("\n");
      const { rating, note } = (reference === undefined ? {} : JSON.parse(reference)) as { rating?: number | null; note?: string | null };
      return { rating, note };
    };
    await expect.poll(copied).toEqual({ rating: 6, note: "Sweeter than yesterday's" });

    labTablet.loseNetwork();
    await api.waitForMachine("Lab 1", (machine) => !machine.online);
    const sent = editsSent(labTablet).length;

    // Applied at once all the same, and two edits of the Shot wait in the order they were made.
    expect(await edit("edit-lab", { rating: 9 })).toMatchObject({ enjoyment: 9, notes: "Sweeter than yesterday's" });
    expect(await edit("edit-lab", { rating: 3, note: "Went flat as it cooled" })).toMatchObject({ enjoyment: 3, notes: "Went flat as it cooled" });
    expect(await states("edit-lab")).toEqual(["awaitingTablet", "awaitingTablet", "written"]);
    expect((await read("edit-lab")).edits[0]).toMatchObject({ state: "awaitingTablet", writtenAt: null });
    expect(await annotationsOf(labTablet, "edit-lab")).toMatchObject({ enjoyment: 6, espressoNotes: "Sweeter than yesterday's" });
    // The copy on Belmont's tablet follows the edit, without waiting for the Lab's tablet.
    await expect.poll(copied).toEqual({ rating: 3, note: "Went flat as it cooled" });

    labTablet.restoreNetwork();
    await expect.poll(() => states("edit-lab"), { timeout: 30_000 }).toEqual(["written", "written", "written"]);
    // One at a time, oldest first, so the tablet ends with the later.
    expect(editsSent(labTablet).slice(sent).map(({ rating, note }) => ({ rating, note }))).toEqual([{ rating: 9 }, { rating: 3, note: "Went flat as it cooled" }]);
    expect(await annotationsOf(labTablet, "edit-lab")).toMatchObject({ enjoyment: 3, espressoNotes: "Went flat as it cooled" });
    // Once the tablet's reports of both writes are in, the Shot reads as the later edit left it.
    await expect.poll(() => reportsOf(labTablet, "edit-lab")).toEqual(["shot", "shotUpdated", "shotUpdated", "shotUpdated"]);
    await expect.poll(() => labTablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated")).toBe(true);
    expect(await read("edit-lab")).toMatchObject({ enjoyment: 3, notes: "Went flat as it cooled" });
  });

  it("leaves an edit Decaid refuses awaiting its tablet, with the Shot's later edits behind it, and tries again after a while", async () => {
    // Decaid busy for a moment, as when its API is over its limit.
    labTablet.refuseWrites = ({ method, route }) => (method === "PUT" && route === "/shots/edit-lab" ? { status: 503, body: { error: "Service unavailable" } } : undefined);
    const answered = answersSent(labTablet).length;
    await edit("edit-lab", { rating: 7 });
    await expect.poll(() => answersSent(labTablet).slice(answered)).toEqual([{ type: "shotEdited", id: expect.any(String), outcome: "refused", status: 503, error: '{"error":"Service unavailable"}' }]);
    // Applied on the server all the same, and the Shot's next edit waits behind it.
    await edit("edit-lab", { note: "After the refusal" });
    expect(await read("edit-lab")).toMatchObject({ enjoyment: 7, notes: "After the refusal" });
    expect((await states("edit-lab")).slice(0, 2)).toEqual(["awaitingTablet", "awaitingTablet"]);
    expect(answersSent(labTablet).slice(answered)).toHaveLength(1);
    expect(await annotationsOf(labTablet, "edit-lab")).toMatchObject({ enjoyment: 3, espressoNotes: "Went flat as it cooled" });

    // Tried again ten heartbeat intervals later, 10 s here, oldest first, with the connection still open.
    labTablet.refuseWrites = undefined;
    await expect.poll(async () => (await states("edit-lab")).slice(0, 2), { timeout: 30_000 }).toEqual(["written", "written"]);
    expect(answersSent(labTablet).slice(answered).map((answer) => answer.outcome)).toEqual(["refused", "written", "written"]);
    expect(await annotationsOf(labTablet, "edit-lab")).toMatchObject({ enjoyment: 7, espressoNotes: "After the refusal" });
    await expect.poll(() => reportsOf(labTablet, "edit-lab").length).toBe(6);
    await expect.poll(() => labTablet.acknowledgedEvery((frame: Record_) => frame.type === "shotUpdated")).toBe(true);
    expect(await read("edit-lab")).toMatchObject({ enjoyment: 7, notes: "After the refusal" });
  });

  it("reaches a tablet held by another instance", async () => {
    const machine = await api.createMachine("Belmont 2");
    await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: belmont.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    const instance = await startTestServer({ env, sharing: server });
    const third = tablets.syncing(machine, instance, { api: emptyLibrary(THIRD_SERIAL) });
    await api.waitForOnline(machine);
    third.pullShot(shotOf("edit-third", "2026-11-10T11:00:00.000Z", THIRD_SERIAL));
    await stored("edit-third");

    // Made through the first instance, sent by the one holding the tablet, and read through either.
    expect(await edit("edit-third", { rating: 5 })).toMatchObject({ enjoyment: 5 });
    await expect.poll(() => states("edit-third")).toEqual(["written"]);
    expect(await annotationsOf(third, "edit-third")).toMatchObject({ enjoyment: 5 });
    expect((await read("edit-third", api.at(instance.url))).edits).toMatchObject([{ fields: { rating: 5 }, state: "written", account: { id: adminId } }]);

    // And made through the instance holding it.
    await edit("edit-third", { note: "From the other instance" }, api.at(instance.url));
    await expect.poll(() => states("edit-third")).toEqual(["written", "written"]);
    expect(await annotationsOf(third, "edit-third")).toMatchObject({ enjoyment: 5, espressoNotes: "From the other instance" });
    await third.unload();
    await instance.stop();
  });

  it("lets an Admin edit any listed Shot, Staff those at their Locations, and a Viewer none", async () => {
    const staff = await api.staffAt("staff-belmont@example.com", belmont);
    const { link } = await api.invite("viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Vera Viewer", password: "viewer password 1" }));
    const staffId = (await api.accounts()).find((account) => account.email === "staff-belmont@example.com")!.id;

    // Staff at Belmont edit Belmont's Shots.
    expect(await edit("edit-belmont-rated", { note: "Better once rested" }, staff)).toMatchObject({ enjoyment: 8, notes: "Better once rested" });
    // Not the Lab's, nor a Shot at no Location, which is an Admin's alone.
    for (const id of ["edit-lab", "edit-pending"]) {
      const refused = await staff.call("PATCH", `/shots/${id}`, { rating: 1 });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ message: "You can edit only the Shots at a Location you work at" });
    }
    const refused = await viewer.call("PATCH", "/shots/edit-belmont-rated", { rating: 1 });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ message: "A Viewer can't change anything" });
    expect(await edit("edit-pending", { rating: 2 })).toMatchObject({ enjoyment: 2 });
    // What Staff were refused changed nothing.
    expect(await read("edit-lab")).toMatchObject({ enjoyment: 7 });

    // Each edit names who made it, newest first: by name to an Admin, and by id alone to Staff and Viewers.
    const listed = (await read("edit-belmont-rated")).edits;
    expect(listed.map((made) => [made.fields, made.account])).toEqual([
      [{ note: "Better once rested" }, { id: staffId, name: "Staff" }],
      [{ rating: 8 }, { id: adminId, name: admin.name }],
    ]);
    for (const reader of [staff, viewer]) {
      expect((await read("edit-belmont-rated", reader)).edits.map((made) => [made.fields, made.account, made.state])).toEqual([
        [{ note: "Better once rested" }, { id: staffId, name: null }, expect.stringMatching(/^(awaitingTablet|written)$/)],
        [{ rating: 8 }, { id: adminId, name: null }, "written"],
      ]);
    }
    // The Pending Machine's Shot is held by Belmont's tablet, which is written it too.
    await expect.poll(() => states("edit-pending")).toEqual(["written"]);
    await expect.poll(() => states("edit-belmont-rated")).toEqual(["written", "written"]);
    expect(await annotationsOf(belmontTablet, "edit-pending")).toMatchObject({ enjoyment: 2 });
  });

  it("refuses anything but a rating from 0 to 10 and a note of text, changing nothing", async () => {
    const before = await read("edit-belmont-rated");
    const refusals: [Record_ | unknown[] | null, string][] = [
      [{ rating: 10.5 }, "rating must be a number from 0 to 10"],
      [{ rating: -1 }, "rating must be a number from 0 to 10"],
      [{ rating: "8" }, "rating must be a number from 0 to 10"],
      [{ rating: null }, "rating must be a number from 0 to 10"],
      [{ note: 5 }, "note must be text"],
      [{ note: null }, "note must be text"],
      [{ note: "nul \u0000" }, "note must be text"],
      [{ note: "half \ud83d" }, "note must be text"],
      [{ rating: 5, actualYield: 40 }, "actualYield is not a field this can set"],
      [{ enjoyment: 5 }, "enjoyment is not a field this can set"],
      [{}, "Send the Shot's rating, its note or both"],
      [[], "Send the Shot's rating, its note or both"],
    ];
    for (const [body, message] of refusals) {
      const refused = await api.call("PATCH", "/shots/edit-belmont-rated", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(((await refused.json()) as { message: unknown }).message), JSON.stringify(body)).toContain(message);
    }
    // A note longer than a request's body may be is refused before it is read.
    expect((await api.call("PATCH", "/shots/edit-belmont-rated", { note: "n".repeat(200_000) })).status).toBe(413);
    // The ends of the scale are taken.
    expect(await edit("edit-belmont-rated", { rating: 10 })).toMatchObject({ enjoyment: 10 });
    await expect.poll(() => states("edit-belmont-rated")).toEqual(["written", "written", "written"]);
    expect((await read("edit-belmont-rated")).edits.slice(1)).toEqual(before.edits);
  });

  it("refuses a Shot the Shots list doesn't list", async () => {
    for (const id of ["no-such-shot", "x".repeat(200), encodeURIComponent("nul \u0000")]) {
      expect((await api.call("PATCH", `/shots/${id}`, { rating: 5 })).status, id).toBe(404);
    }
    // A dismissed Pending Machine's Shot is hidden, and edited no more.
    const [pending] = (await api.pendingMachines()).filter((machine) => machine.serial === UNKNOWN_SERIAL);
    await api.send("POST", `/pending-machines/${pending!.id}/dismiss`);
    const refused = await api.call("PATCH", "/shots/edit-pending", { rating: 5 });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ message: "Shot not found" });
  });

  describe("the write, with raw frames", () => {
    /** A welcomed raw connection holding the Machine, as the tablet of that id reporting that hardware. */
    const connect = (machine: CreatedMachine, serial: string, tabletId: string, wireRevision = WIRE_REVISION) =>
      RawConnection.welcomed(machine.serverUrl, helloWith(machine.token, { machine: { model: "DE1Pro", serial }, tabletId, wireRevision }));

    /** Sends the Shot as the connection's tablet's, and waits for its acknowledgment. */
    const report = (raw: RawConnection, shot: Record_) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot });

    /** The connection's first message that matches, once it has arrived. */
    async function next(raw: RawConnection, matches: (message: Record_) => boolean): Promise<Record_> {
      let found: Record_ | undefined;
      await expect.poll(() => (found = (raw.messages as Record_[]).find(matches)), { timeout: 15_000 }).toBeDefined();
      return found!;
    }

    /** Resolves once the server has handled everything the connection sent before this. */
    const handled = (raw: RawConnection) => raw.deliver({ type: "shotIndex", id: randomUUID(), shots: [] });
    const editsTo = (raw: RawConnection) => (raw.messages as Record_[]).filter((message) => message.type === "shotEdit");

    it("sends an edit again on the tablet's next connection until it is answered as written, and holds back the Shot's later edits after a refusal", async () => {
      const machine = await api.createMachine("Raw 1", belmont.id);
      const tabletId = randomUUID();
      const raw = await connect(machine, "51204", tabletId);
      await report(raw, shotOf("edit-raw", "2026-11-11T09:00:00.000Z", "51204"));
      await report(raw, shotOf("edit-raw-other", "2026-11-11T09:05:00.000Z", "51204"));

      await edit("edit-raw", { rating: 1 });
      const first = await next(raw, (message) => message.type === "shotEdit");
      expect(first).toEqual({ type: "shotEdit", id: expect.any(String), shotId: "edit-raw", rating: 1 });
      // The next waits for the first's answer.
      await edit("edit-raw", { note: "Second" });
      await edit("edit-raw-other", { rating: 4 });
      // An answer naming an edit this connection has not been sent marks nothing.
      const unsent = (await read("edit-raw")).edits[0]!.id;
      raw.send({ type: "shotEdited", id: unsent, outcome: "written" });
      await handled(raw);
      expect(await states("edit-raw")).toEqual(["awaitingTablet", "awaitingTablet"]);
      // Refused, as when Decaid no longer holds the Shot: the edit stays to be written, the Shot's next is held back on
      // this connection, and the other Shot's goes on.
      raw.send({ type: "shotEdited", id: first.id, outcome: "refused", status: 404, error: '{"error":"Shot not found"}' });
      const other = await next(raw, (message) => message.type === "shotEdit" && message.id !== first.id);
      expect(other).toMatchObject({ shotId: "edit-raw-other", rating: 4 });
      raw.send({ type: "shotEdited", id: other.id, outcome: "written" });
      await expect.poll(() => states("edit-raw-other")).toEqual(["written"]);
      expect(await states("edit-raw")).toEqual(["awaitingTablet", "awaitingTablet"]);
      expect(editsTo(raw)).toHaveLength(2);
      await raw.close();

      // Its next connection is sent them again, in the order they were made.
      const again = await connect(machine, "51204", tabletId);
      const retried = await next(again, (message) => message.type === "shotEdit");
      expect(retried).toEqual(first);
      // An answer that names no edit awaited, or repeats one, changes nothing.
      again.send({ type: "shotEdited", id: randomUUID(), outcome: "written" });
      again.send({ type: "shotEdited", id: other.id, outcome: "written" });
      await handled(again);
      expect(await states("edit-raw")).toEqual(["awaitingTablet", "awaitingTablet"]);
      again.send({ type: "shotEdited", id: retried.id, outcome: "written" });
      const second = await next(again, (message) => message.type === "shotEdit" && message.id !== first.id);
      expect(second).toEqual({ type: "shotEdit", id: expect.any(String), shotId: "edit-raw", note: "Second" });
      expect(await states("edit-raw")).toEqual(["awaitingTablet", "written"]);
      again.send({ type: "shotEdited", id: second.id, outcome: "written" });
      await expect.poll(() => states("edit-raw")).toEqual(["written", "written"]);
      await again.close();
    });

    it("sends the tablet that last reported a Shot its edits, and no other", async () => {
      const machine = await api.createMachine("Raw 2", belmont.id);
      const other = await api.createMachine("Raw 3", belmont.id);
      const holder = await connect(machine, "51205", randomUUID());
      const bystander = await connect(other, "51206", randomUUID());
      await report(holder, shotOf("edit-raw-held", "2026-11-11T10:00:00.000Z", "51205"));
      await edit("edit-raw-held", { rating: 6 });
      const sent = await next(holder, (message) => message.type === "shotEdit");
      expect(sent).toMatchObject({ shotId: "edit-raw-held", rating: 6 });
      // An answer from a tablet that does not hold the Shot marks nothing.
      bystander.send({ type: "shotEdited", id: sent.id, outcome: "written" });
      await handled(bystander);
      expect(await states("edit-raw-held")).toEqual(["awaitingTablet"]);
      expect(editsTo(bystander)).toEqual([]);

      // The Shot reported by another tablet, as one restored from the first's backup, is that tablet's from then on.
      await report(bystander, { ...shotOf("edit-raw-held", "2026-11-11T10:00:00.000Z", "51205"), updatedAt: "2026-11-11T10:30:00.000000Z" });
      expect(await next(bystander, (message) => message.type === "shotEdit")).toEqual(sent);
      bystander.send({ type: "shotEdited", id: sent.id, outcome: "written" });
      await expect.poll(() => states("edit-raw-held")).toEqual(["written"]);
      await holder.close();
      await bystander.close();
    });

    it("writes a Capture-only Machine's tablet its Shots' edits, and a mismatched connection's tablet nothing", async () => {
      // At no Location, so Capture-only: its Shots are an Admin's alone to edit, and its tablet is written them.
      const machine = await api.createMachine("Raw 5");
      const tabletId = randomUUID();
      const raw = await connect(machine, "51208", tabletId);
      await report(raw, shotOf("edit-raw-capture", "2026-11-11T12:00:00.000Z", "51208"));
      await edit("edit-raw-capture", { rating: 4 });
      const sent = await next(raw, (message) => message.type === "shotEdit");
      expect(sent).toMatchObject({ shotId: "edit-raw-capture", rating: 4 });
      raw.send({ type: "shotEdited", id: sent.id, outcome: "written" });
      await expect.poll(() => states("edit-raw-capture")).toEqual(["written"]);
      await raw.close();

      // The same tablet, now reporting other hardware than its token's Machine's: nothing is written to it (ADR-0004).
      await edit("edit-raw-capture", { note: "While mismatched" });
      const mismatched = await connect(machine, "51210", tabletId);
      await handled(mismatched);
      expect(editsTo(mismatched)).toEqual([]);
      // Nor does an answer from it count.
      const waiting = (await read("edit-raw-capture")).edits[0]!.id;
      mismatched.send({ type: "shotEdited", id: waiting, outcome: "written" });
      await handled(mismatched);
      expect(await states("edit-raw-capture")).toEqual(["awaitingTablet", "written"]);
      await mismatched.close();

      // Connected as its Machine again, it is written the edit.
      const again = await connect(machine, "51208", tabletId);
      expect(await next(again, (message) => message.type === "shotEdit")).toMatchObject({ id: waiting, shotId: "edit-raw-capture", note: "While mismatched" });
      await again.close();
    });

    it("sends an edit of a Shot no tablet was known to hold once a tablet's index lists it", async () => {
      const machine = await api.createMachine("Raw 6", belmont.id);
      const raw = await connect(machine, "51211", randomUUID());
      const shot = shotOf("edit-raw-unheld", "2026-11-11T13:00:00.000Z", "51211");
      await report(raw, shot);
      // As a Shot stored before Shots kept the tablet reporting them.
      const database = await server.connectDatabase();
      try {
        await database.query("UPDATE shots SET tablet_id = NULL WHERE id = $1", [shot.id]);
      } finally {
        await database.end();
      }
      await edit("edit-raw-unheld", { rating: 3 });
      await handled(raw);
      expect(editsTo(raw)).toEqual([]);
      // The tablet's index lists the Shot, so it holds it: the edit is its to write.
      await raw.deliver({ type: "shotIndex", id: randomUUID(), shots: [{ id: shot.id, updatedAt: shot.updatedAt }] });
      const sent = await next(raw, (message) => message.type === "shotEdit");
      expect(sent).toMatchObject({ shotId: "edit-raw-unheld", rating: 3 });
      raw.send({ type: "shotEdited", id: sent.id, outcome: "written" });
      await expect.poll(() => states("edit-raw-unheld")).toEqual(["written"]);
      await raw.close();
    });

    it("refuses an answer it can't read, and one from a plugin behind the edits' wire revision, which is sent none", async () => {
      const machine = await api.createMachine("Raw 4", belmont.id);
      const tabletId = randomUUID();
      const behind = await connect(machine, "51207", tabletId, SHOT_EDITS_WIRE_REVISION - 1);
      await report(behind, shotOf("edit-raw-behind", "2026-11-11T11:00:00.000Z", "51207"));
      await edit("edit-raw-behind", { rating: 2 });
      // Nothing is sent it: the edit waits for a plugin at the revision.
      await handled(behind);
      expect(editsTo(behind)).toEqual([]);
      expect(await states("edit-raw-behind")).toEqual(["awaitingTablet"]);
      behind.send({ type: "shotEdited", id: randomUUID(), outcome: "written" });
      expect(await next(behind, (message) => message.type === "error")).toMatchObject({ code: "protocol_error", message: expect.stringContaining("shotEdited needs a plugin at wire revision") });

      const current = await connect(machine, "51207", tabletId);
      const sent = await next(current, (message) => message.type === "shotEdit");
      expect(sent).toMatchObject({ shotId: "edit-raw-behind", rating: 2 });
      for (const answer of [
        { type: "shotEdited", id: "not-a-uuid", outcome: "written" },
        { type: "shotEdited", id: sent.id, outcome: "maybe" },
        { type: "shotEdited", id: sent.id, outcome: "refused" },
        { type: "shotEdited", id: sent.id, outcome: "written", error: "none" },
      ]) {
        const raw = await connect(machine, "51207", tabletId);
        raw.send(answer);
        expect(await next(raw, (message) => message.type === "error"), JSON.stringify(answer)).toMatchObject({ code: "protocol_error", message: expect.stringContaining("shotEdited.") });
      }
      expect(await states("edit-raw-behind")).toEqual(["awaitingTablet"]);
    });
  });
});
