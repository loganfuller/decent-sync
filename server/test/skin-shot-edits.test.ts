import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, Refusal, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #515 (milestone 8, ADR-0031, ADR-0030): a Shot's rating
// and note edited from a tablet, for a Skin. A Skin sends the plugin's
// `shot` endpoint a PUT naming the Shot, with a rating, a note or both, and
// needn't know where the Shot is held. The plugin writes a Shot its tablet
// holds through Decaid's own Shot update, with or without the server, which
// reaches the server as any edit made on that tablet does, with no person
// and no edit kept. For any other it asks the server, which applies the
// edit at once, keeps it with the Machine and tablet it was made on and no
// account, and writes it to the tablet that holds the Shot. Through the
// built plugin in simulated tablets against a real server: three at Belmont
// and one at the Lab. Each Shot is derived from a Shot Decaid recorded,
// changing its id, time, recorded hardware and annotations. Serials are
// made up, from 52101.

type Record_ = Record<string, unknown>;

// Heartbeats every 30 s, the default: while a call to the plugin's endpoint awaits its answer the tablet runs at real
// time, its heartbeats with it, so a server expecting one a second would drop a call that took three.
const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };

const LEFT_SERIAL = "52101";
const RIGHT_SERIAL = "52102";
const THIRD_SERIAL = "52103";
const LAB_SERIAL = "52104";
const FOURTH_SERIAL = "52105";

interface Edit {
  fields: { rating?: number; note?: string };
  account: { id: string; name: string | null } | null;
  connectedApp: unknown;
  machine: { id: string; name: string } | null;
  tabletId: string | null;
  state: "awaitingTablet" | "written" | "dropped" | "noTablet";
}

interface ShotView {
  id: string;
  enjoyment: number | null;
  notes: string | null;
  editStanding: "awaitingTablet" | "noTablet" | null;
  edits: Edit[];
}

interface Answer {
  status: number;
  body: Record_;
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

async function answered(calling: ReturnType<SimulatedTablet["callEndpoint"]>): Promise<Answer> {
  const answer = await calling;
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** Sends the tablet's `shot` endpoint a PUT as a Skin does, naming the Shot, with the body given. */
const put = (tablet: SimulatedTablet, id: string, body: unknown) => answered(tablet.callEndpoint("shot", { method: "PUT", query: { id }, body }));
/** The rating and note of the Shot as the tablet's own Decaid holds it, or null where it holds none. */
async function onTablet(tablet: SimulatedTablet, id: string): Promise<{ enjoyment: unknown; espressoNotes: unknown } | null> {
  const { status, body } = await tablet.callApi("GET", `/shots/${id}`);
  if (status !== 200) return null;
  const { enjoyment, espressoNotes } = ((body as Record_).annotations ?? {}) as Record_;
  return { enjoyment, espressoNotes };
}
/** The edits the plugin asked the server to make. */
const asked = (tablet: SimulatedTablet) => (tablet.sent as Record_[]).filter((frame) => frame.type === "request" && frame.ask === "editShot");
/** The Shot updates the plugin sent the tablet's own Decaid, for a Skin or for the server. */
const decaidUpdates = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write.startsWith("PUT /shots/"));
/** The rating and note of the Reference Shot the tablet keeps a copy of for a Recipe Slot. */
const kept = (tablet: SimulatedTablet, slot: number): { rating: unknown; note: unknown } | undefined => {
  const value = tablet.storage.read(`reference.${slot}`);
  const reference = typeof value === "string" ? value.split("\n")[1] : undefined;
  const copy = reference === undefined ? null : (JSON.parse(reference) as { rating: unknown; note: unknown } | null);
  return copy ? { rating: copy.rating, note: copy.note } : undefined;
};
const connectionPushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "connection").map((push) => push.connected);

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("A Shot's rating and note edited from a tablet", { timeout: 180_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let belmont: LocationView;
  let leftMachine: CreatedMachine;
  let rightMachine: CreatedMachine;
  let left: SimulatedTablet;
  let right: SimulatedTablet;
  let third: SimulatedTablet;
  let labTablet: SimulatedTablet;
  /** Belmont's Recipe in no slot, whose Reference Shot comes to be the Lab's Shot. */
  let spare: string;

  runAsSteps();

  const read = async (id: string) => (await api.get<{ shot: ShotView }>(`/shots/${id}`)).shot;
  /** The states of the Shot's edits, newest first. */
  const states = async (id: string) => (await read(id)).edits.map((made) => made.state);
  /** An edit made on the tablet, as a Shot's read names who made it. */
  const madeOn = (machine: CreatedMachine, name: string, tablet: SimulatedTablet) => ({
    account: null,
    connectedApp: null,
    machine: { id: machine.machine.id, name },
    tabletId: tablet.storage.read("tabletId"),
  });

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    belmont = await api.createLocation("Belmont", "America/Chicago");
    const lab = await api.createLocation("Lab", "America/Denver");
    leftMachine = await api.createMachine("Belmont Left");
    rightMachine = await api.createMachine("Belmont Right");
    const thirdMachine = await api.createMachine("Belmont Third");
    const labMachine = await api.createMachine("Lab 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[leftMachine, belmont], [rightMachine, belmont], [thirdMachine, belmont], [labMachine, lab]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    left = tablets.syncing(leftMachine, server, { api: emptyLibrary(LEFT_SERIAL) });
    right = tablets.syncing(rightMachine, server, { api: emptyLibrary(RIGHT_SERIAL) });
    third = tablets.syncing(thirdMachine, server, { api: emptyLibrary(THIRD_SERIAL) });
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(leftMachine, rightMachine, thirdMachine, labMachine);

    left.pullShot(shotOf("skin-left", "2026-11-10T15:00:00.000Z", LEFT_SERIAL, { enjoyment: 4, espressoNotes: "Sour at first" }));
    right.pullShot(shotOf("skin-right", "2026-11-10T16:00:00.000Z", RIGHT_SERIAL, { enjoyment: 6, espressoNotes: "Bright" }));
    right.pullShot(shotOf("skin-right-plain", "2026-11-10T16:05:00.000Z", RIGHT_SERIAL));
    right.pullShot(shotOf("skin-right-later", "2026-11-10T16:10:00.000Z", RIGHT_SERIAL));
    labTablet.pullShot(shotOf("skin-lab", "2026-11-10T17:00:00.000Z", LAB_SERIAL, { enjoyment: 5 }));
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === 5);

    // Belmont's Recipes in slots 1 and 2, whose Reference Shots each of its tablets keeps a copy of: one the right
    // tablet pulled, and one the left.
    const create = async (name: string, slot: "next" | null) =>
      (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: belmont.id, slot, content: { name, dose: 18, yield: 36 } }, 201)).recipe.id;
    const [espresso, decaf] = [await create("Belmont espresso", "next"), await create("Belmont decaf", "next")];
    spare = await create("Belmont spare", null);
    await api.send("PUT", `/recipes/${espresso}/reference-shot`, { shotId: "skin-right" });
    await api.send("PUT", `/recipes/${decaf}/reference-shot`, { shotId: "skin-left" });
    await until(() => [left, right, third].every((tablet) => kept(tablet, 1)?.rating === 6 && kept(tablet, 2)?.rating === 4));
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  it("edits the rating of a Shot the other tablet holds: the server's read at once, a Shot Summary and the Location's list, and that tablet's own Shot afterwards", async () => {
    const answer = await put(left, "skin-right", { rating: 9 });
    // The Shot's rating and note as they now are.
    expect(answer).toEqual({ status: 200, body: { rating: 9, note: "Bright" } });
    // Decaid said this tablet holds no such Shot, so the plugin asked the server, with the rating alone.
    expect(decaidUpdates(left)).toEqual(["PUT /shots/skin-right"]);
    expect(asked(left)).toEqual([{ type: "request", id: expect.any(String), ask: "editShot", shotId: "skin-right", rating: 9 }]);

    // Applied as the request was answered: the Shot's read, a Shot Summary and the Location's list on a tablet show it.
    expect(await read("skin-right")).toMatchObject({ enjoyment: 9, notes: "Bright" });
    // The right tablet's other Shots recorded no rating, so the summary's is this one's.
    const { groups } = await api.get<{ groups: { numbers: { rating: { median: number | null } } }[] }>(`/shots/summary?machineId=${rightMachine.machine.id}&numbers=rating`);
    expect(groups[0]!.numbers.rating.median).toBe(9);
    const listed = (await answered(third.callEndpoint("shots"))).body.shots as { id: string; rating: number | null }[];
    expect(listed.find((shot) => shot.id === "skin-right")!.rating).toBe(9);

    // Written into the Shot on the tablet that holds it, its note left alone.
    await expect.poll(() => states("skin-right")).toEqual(["written"]);
    expect(await onTablet(right, "skin-right")).toEqual({ enjoyment: 9, espressoNotes: "Bright" });
    expect(await onTablet(left, "skin-right")).toBeNull();
  });

  it("lists the edit as made on this Machine and tablet, with no account, in the Shot's read and through an assistant", async () => {
    const shot = await read("skin-right");
    expect(shot.edits).toEqual([expect.objectContaining({ fields: { rating: 9 }, ...madeOn(leftMachine, "Belmont Left", left), state: "written" })]);
    expect(shot.editStanding).toBeNull();
    const listed = await assistant.call<{ edits: { entries: Record_[] } }>("get_shot", { id: "skin-right", edits: true });
    expect(listed.edits.entries).toEqual([
      expect.objectContaining({ rating: 9, account: null, connectedApp: null, machine: { id: leftMachine.machine.id, name: "Belmont Left" }, state: "written" }),
    ]);
  });

  it("has each tablet's copy of the Shot as a Recipe's Reference Shot follow the edit", async () => {
    for (const tablet of [left, right, third]) await expect.poll(() => kept(tablet, 1)).toEqual({ rating: 9, note: "Bright" });
  });

  it("edits a note leaving the rating alone, both together, and clears both", async () => {
    expect(await put(left, "skin-right", { note: "Sweeter than it smelled" })).toEqual({ status: 200, body: { rating: 9, note: "Sweeter than it smelled" } });
    expect(asked(left).at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "editShot", shotId: "skin-right", note: "Sweeter than it smelled" });
    expect(await read("skin-right")).toMatchObject({ enjoyment: 9, notes: "Sweeter than it smelled" });
    await expect.poll(() => states("skin-right")).toEqual(["written", "written"]);
    expect(await onTablet(right, "skin-right")).toEqual({ enjoyment: 9, espressoNotes: "Sweeter than it smelled" });

    // Both, from the third tablet, on a Shot that recorded neither; half ratings are Decaid's too.
    expect(await put(third, "skin-right-plain", { rating: 7.5, note: "Syrupy" })).toEqual({ status: 200, body: { rating: 7.5, note: "Syrupy" } });
    await expect.poll(() => states("skin-right-plain")).toEqual(["written"]);
    expect(await onTablet(right, "skin-right-plain")).toEqual({ enjoyment: 7.5, espressoNotes: "Syrupy" });

    // Unrated is 0 and no note is empty text: the Shot then has no note.
    expect(await put(third, "skin-right-plain", { rating: 0, note: "" })).toEqual({ status: 200, body: { rating: 0, note: null } });
    await expect.poll(() => states("skin-right-plain")).toEqual(["written", "written"]);
    expect(await onTablet(right, "skin-right-plain")).toEqual({ enjoyment: 0, espressoNotes: "" });
    expect((await read("skin-right-plain")).edits.map((made) => [made.fields, made.machine?.name])).toEqual([
      [{ rating: 0, note: "" }, "Belmont Third"],
      [{ rating: 7.5, note: "Syrupy" }, "Belmont Third"],
    ]);
  });

  it("edits the tablet's own Shot through Decaid, asking the server nothing: it reaches the server as any edit made on that tablet, with no edit kept", async () => {
    const before = { asked: asked(left).length, updates: decaidUpdates(left).length };
    expect(await put(left, "skin-left", { rating: 7 })).toEqual({ status: 200, body: { rating: 7, note: "Sour at first" } });
    // Through Decaid's own Shot update, with the rating alone, which the tablet holds at once.
    expect(decaidUpdates(left).slice(before.updates)).toEqual(["PUT /shots/skin-left"]);
    expect(await onTablet(left, "skin-left")).toEqual({ enjoyment: 7, espressoNotes: "Sour at first" });
    expect(asked(left)).toHaveLength(before.asked);

    // Decaid told the plugin of the update, which sent it on as any edit of the Shot.
    await expect.poll(async () => (await read("skin-left")).enjoyment).toBe(7);
    expect(await read("skin-left")).toMatchObject({ notes: "Sour at first", editStanding: null, edits: [] });
    // Each tablet's copy of it as a Recipe's Reference Shot follows.
    for (const tablet of [left, right, third]) await expect.poll(() => kept(tablet, 2)).toEqual({ rating: 7, note: "Sour at first" });
    // The server sent the tablet nothing to write.
    expect((left.received as Record_[]).filter((frame) => frame.type === "shotEdit")).toEqual([]);
  });

  it("writes an edit made while the tablet that holds the Shot is off once that tablet reconnects", async () => {
    right.loseNetwork();
    await expect.poll(() => connectionPushes(right).at(-1)).toBe(false);
    expect(await put(left, "skin-right-later", { rating: 5, note: "Flat" })).toEqual({ status: 200, body: { rating: 5, note: "Flat" } });
    expect(await read("skin-right-later")).toMatchObject({ enjoyment: 5, notes: "Flat", editStanding: "awaitingTablet" });
    expect(await onTablet(right, "skin-right-later")).toEqual({ enjoyment: undefined, espressoNotes: undefined });

    right.restoreNetwork();
    await expect.poll(() => states("skin-right-later")).toEqual(["written"]);
    expect(await onTablet(right, "skin-right-later")).toEqual({ enjoyment: 5, espressoNotes: "Flat" });
    expect(await read("skin-right-later")).toMatchObject({ enjoyment: 5, notes: "Flat", editStanding: null });
  });

  it("asks the server at once, behind nothing the tablet has still to report", async () => {
    // Decaid is slow to read a Shot just pulled, so its delivery is still to come, as while a tablet catches up.
    const release = left.holdShotReads();
    try {
      left.pullShot(shotOf("skin-left-just-pulled", new Date().toISOString(), LEFT_SERIAL));
      await expect.poll(() => left.inFlightRequests.map((request) => request.route)).toContain("/shots/skin-left-just-pulled");
      expect(await put(left, "skin-right-later", { rating: 6 })).toEqual({ status: 200, body: { rating: 6, note: "Flat" } });
      expect((await api.call("GET", "/shots/skin-left-just-pulled")).status).toBe(404);
    } finally {
      release();
    }
    await expect.poll(async () => (await api.call("GET", "/shots/skin-left-just-pulled")).status).toBe(200);
    await expect.poll(async () => (await onTablet(right, "skin-right-later"))?.enjoyment).toBe(6);
  });

  it("edits only the Shots the tablet's list lists: another Location's is refused as no such Shot, though the tablet may read it whole", async () => {
    const noSuchShot = { status: 404, body: { code: "noSuchShot", message: expect.stringContaining("No Shot") } };
    expect(await put(left, "skin-lab", { rating: 3 })).toEqual(noSuchShot);
    expect(await put(left, "no-such-shot", { rating: 3 })).toEqual(noSuchShot);
    // The Reference Shot of one of Belmont's Recipes, which Belmont's tablets read whole, is still no Shot of their list.
    await api.send("PUT", `/recipes/${spare}/reference-shot`, { shotId: "skin-lab" });
    await until(async () => (await answered(left.callEndpoint("shots"))).status === 200);
    expect(await put(left, "skin-lab", { rating: 3 })).toEqual(noSuchShot);
    expect(await read("skin-lab")).toMatchObject({ enjoyment: 5, edits: [] });
    // The Lab's own tablet holds it, and edits it.
    expect(await put(labTablet, "skin-lab", { rating: 3 })).toEqual({ status: 200, body: { rating: 3, note: null } });
    await expect.poll(async () => (await read("skin-lab")).enjoyment).toBe(3);
    expect((await read("skin-lab")).edits).toEqual([]);
  });

  it("edits a Shot deleted on the tablet the server credits with it through the server, as that tablet's Machine's, with no tablet to reach", async () => {
    left.pullShot(shotOf("skin-left-deleted", "2026-11-10T15:30:00.000Z", LEFT_SERIAL, { enjoyment: 4 }));
    await expect.poll(async () => (await api.call("GET", "/shots/skin-left-deleted")).status).toBe(200);
    // Deleted in the tablet's own Decaid, which the server is never told: it still lists the Shot, as that tablet's.
    const restore = left.refuseFor("/shots/skin-left-deleted", new Refusal(404, { error: "Shot not found" }));
    try {
      expect(await put(left, "skin-left-deleted", { rating: 3 })).toEqual({ status: 200, body: { rating: 3, note: null } });
      expect(asked(left).at(-1)).toMatchObject({ ask: "editShot", shotId: "skin-left-deleted", rating: 3 });
      // Sent to the tablet that asked, which answers that it no longer holds the Shot: the edit stays on the server.
      await expect.poll(() => states("skin-left-deleted")).toEqual(["noTablet"]);
      const shot = await read("skin-left-deleted");
      expect(shot).toMatchObject({ enjoyment: 3, editStanding: "noTablet" });
      expect(shot.edits).toEqual([expect.objectContaining({ fields: { rating: 3 }, ...madeOn(leftMachine, "Belmont Left", left) })]);
    } finally {
      restore();
    }
  });

  it("refuses a request it can't read without asking Decaid or the server, and a method the endpoint doesn't take", async () => {
    const before = { asked: asked(left).length, updates: decaidUpdates(left).length };
    const invalid = (what: string) => ({ status: 400, body: { code: "invalidRequest", message: expect.stringContaining(what) } });
    // Neither a rating nor a note.
    for (const body of [undefined, null, {}, [], "8", 8]) expect(await put(left, "skin-right", body)).toEqual(invalid("its note or both"));
    // Null is no way to clear either: unrated is 0, and no note is empty text.
    for (const rating of [null, "8", 11, -1]) expect(await put(left, "skin-right", { rating })).toEqual(invalid("rating as a number from 0 to 10"));
    // A note PostgreSQL can't store, or one longer than a request to the server carries, whichever tablet holds the Shot.
    for (const note of [null, 5, "a\u0000b", "\ud800", "n".repeat(40_001)]) expect(await put(left, "skin-right", { note })).toEqual(invalid("note as text of at most 40000"));
    expect(await put(left, "skin-left", { note: "n".repeat(40_001) })).toEqual(invalid("note as text of at most 40000"));
    // Only a Shot's rating and note are edited.
    expect(await put(left, "skin-right", { rating: 5, actualYield: 40 })).toEqual(invalid('"actualYield"'));
    expect(await put(left, "skin-right", { annotations: { enjoyment: 5 } })).toEqual(invalid('"annotations"'));
    expect(await answered(left.callEndpoint("shot", { method: "PUT", body: { rating: 5 } }))).toEqual(invalid("id"));
    expect(await put(left, "x".repeat(2049), { rating: 5 })).toEqual(invalid("id"));
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const answer = await left.callEndpoint("shot", { method, query: { id: "skin-right" }, body: { rating: 5 } });
      expect([answer.status, answer.headers.Allow, JSON.parse(answer.body)]).toEqual([405, "GET, PUT", { error: "Only GET and PUT are answered" }]);
    }
    expect([asked(left).length, decaidUpdates(left).length]).toEqual([before.asked, before.updates]);
    expect(await read("skin-right")).toMatchObject({ enjoyment: 9, notes: "Sweeter than it smelled" });

    // The longest note it takes is written.
    const longest = "n".repeat(40_000);
    expect(await put(left, "skin-right-plain", { note: longest })).toEqual({ status: 200, body: { rating: 0, note: longest } });
    await expect.poll(async () => (await onTablet(right, "skin-right-plain"))?.espressoNotes).toBe(longest);
  });

  it("says so when Decaid refuses the edit of the tablet's own Shot, and asks the server nothing", async () => {
    const before = asked(left).length;
    left.refuseWrites = ({ method, route }) => (method === "PUT" && route === "/shots/skin-left" ? { status: 503, body: { error: "Service unavailable" } } : undefined);
    try {
      expect(await put(left, "skin-left", { rating: 2 })).toEqual({ status: 500, body: { code: "shotUnwritten", message: expect.stringContaining("503") } });
    } finally {
      left.refuseWrites = undefined;
    }
    expect(asked(left)).toHaveLength(before);
    expect(await onTablet(left, "skin-left")).toEqual({ enjoyment: 7, espressoNotes: "Sour at first" });
  });

  describe("edits, with raw frames", () => {
    const answers = (raw: RawConnection) => (raw.messages as Record_[]).filter((message) => message.type === "answer");

    it("refuses a Capture-only connection as not served, and ends a connection whose request sets nothing, or a value no plugin sends", async () => {
      const sharingOff = await api.createMachine("Belmont raw, sharing off", belmont.id);
      await api.send("PUT", `/machines/${sharingOff.machine.id}/sharing`, { sharing: false });
      const captureOnly = await RawConnection.welcomed(server.url, helloWith(sharingOff.token));
      captureOnly.send({ type: "request", id: "capture-only", ask: "editShot", shotId: "skin-right", rating: 1 });
      await expect.poll(() => answers(captureOnly)).toEqual([{ type: "answer", id: "capture-only", ask: "editShot", refused: "captureOnly" }]);
      await captureOnly.close();

      const served = await api.createMachine("Belmont raw", belmont.id);
      for (const [fields, problem] of [[{}, "request must have rating or note"], [{ rating: 11 }, "request.rating"], [{ note: null }, "request.note"]] as const) {
        const raw = await RawConnection.welcomed(server.url, helloWith(served.token));
        raw.send({ type: "request", id: "unreadable", ask: "editShot", shotId: "skin-right", ...fields });
        expect((await raw.closed).code).toBe(4000);
        expect(raw.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining(problem) });
      }
      // An edit is answered once, with the Shot as it then is, and made as its Machine's.
      const raw = await RawConnection.welcomed(server.url, helloWith(served.token));
      raw.send({ type: "request", id: "made", ask: "editShot", shotId: "skin-right", rating: 8 });
      await expect.poll(() => answers(raw)).toEqual([{ type: "answer", id: "made", ask: "editShot", result: { rating: 8, note: "Sweeter than it smelled" } }]);
      await raw.close();
      const shot = await read("skin-right");
      expect([shot.enjoyment, shot.edits[0]!.machine?.name, shot.edits[0]!.account]).toEqual([8, "Belmont raw", null]);
      expect(shot.edits).toHaveLength(3);
    });
  });

  it("with the server stopped, edits the tablet's own Shot, which reaches the server once it is back with no edit kept, and refuses another tablet's, which is unchanged then", async () => {
    const machine = await api.createMachine("Belmont Fourth", belmont.id);
    // An instance of its own, to stop and to start again at the same address.
    const instance = await startTestServer({ env, sharing: server });
    const fourth = tablets.syncing(machine, instance, { api: emptyLibrary(FOURTH_SERIAL) });
    await api.waitForOnline(machine);
    fourth.pullShot(shotOf("skin-fourth", new Date().toISOString(), FOURTH_SERIAL, { espressoNotes: "Thin" }));
    await until(async () => (await api.call("GET", "/shots/skin-fourth")).status === 200);

    // Edited through this instance, a Shot held by a tablet of the first one's is written there.
    expect(await put(fourth, "skin-right", { rating: 10 })).toEqual({ status: 200, body: { rating: 10, note: "Sweeter than it smelled" } });
    await expect.poll(async () => (await onTablet(right, "skin-right"))?.enjoyment).toBe(10);
    expect((await read("skin-right")).edits[0]).toMatchObject(madeOn(machine, "Belmont Fourth", fourth));

    const before = { edits: (await read("skin-right")).edits.length, asked: asked(fourth).length };
    await instance.stop();
    await expect.poll(() => connectionPushes(fourth).at(-1)).toBe(false);
    // Its own Shot is written through Decaid as it is while connected.
    expect(await put(fourth, "skin-fourth", { rating: 8 })).toEqual({ status: 200, body: { rating: 8, note: "Thin" } });
    expect(await onTablet(fourth, "skin-fourth")).toEqual({ enjoyment: 8, espressoNotes: "Thin" });
    // Another tablet's is refused at once, and nothing is asked.
    expect(await put(fourth, "skin-right", { rating: 1 })).toEqual({ status: 503, body: { code: "unreachable", message: expect.stringContaining("can't be reached") } });
    expect(asked(fourth)).toHaveLength(before.asked);
    expect(await read("skin-fourth")).toMatchObject({ enjoyment: null, notes: "Thin" });

    // The server back at its address: the plugin reconnects and reports its own Shot's edit, and what it was refused
    // is not made now.
    const back = await startTestServer({ env, sharing: server, port: Number(new URL(instance.url).port) });
    try {
      await expect.poll(() => connectionPushes(fourth).at(-1)).toBe(true);
      await expect.poll(async () => (await read("skin-fourth")).enjoyment).toBe(8);
      expect(await read("skin-fourth")).toMatchObject({ notes: "Thin", editStanding: null, edits: [] });
      // A read, which follows whatever the tablet had still to send, finds the other Shot as it was.
      await until(async () => (await answered(fourth.callEndpoint("shot", { query: { id: "skin-right" } }))).status === 200);
      expect(asked(fourth)).toHaveLength(before.asked);
      const shot = await read("skin-right");
      expect([shot.enjoyment, shot.edits.length]).toEqual([10, before.edits]);
      expect(await onTablet(right, "skin-right")).toMatchObject({ enjoyment: 10 });
      // Asked again, it is made.
      expect(await put(fourth, "skin-right", { rating: 1 })).toEqual({ status: 200, body: { rating: 1, note: "Sweeter than it smelled" } });
      await expect.poll(async () => (await onTablet(right, "skin-right"))?.enjoyment).toBe(1);
    } finally {
      await fourth.unload();
      await back.stop();
    }
  });
});
