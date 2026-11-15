import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { Refusal, type SimulatedTablet } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #514 (milestone 8, ADR-0031, ADR-0026): a Shot's rating
// and note edited through an assistant, by a test app on the MCP SDK's
// client connected as a Connected App, against the built server. The edit
// is the account's, through that Connected App, as the REST API then lists
// it, and reaches the Shot on a simulated tablet running the built plugin.
// get_shot says where the Shot's edits stand with that tablet, and lists
// them when asked. What the REST API refuses is refused with its message,
// and a Connected App that may only read, or a Viewer's, with 403
// insufficient_scope. Shots are derived from a Shot Decaid recorded,
// changing only their id, time, recorded hardware and annotations. Serials
// are made up, from 51401.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "1" };

const BELMONT_SERIAL = "51401";
const LAB_SERIAL = "51402";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "51409";

/** What ends text a response cut (`CUT_MARK` in server/src/mcp/budget.ts). */
const CUT_MARK = "…[cut]";

/** An edit as get_shot lists it. */
interface ListedEdit {
  madeAt: string;
  account: { id: string; name: string | null } | null;
  connectedApp: { id: string; name: string; host: string } | null;
  rating?: number;
  note?: string;
  state: string;
  dropped: string[];
}

/** A Shot as get_shot and edit_shot give it, of what these tests read. */
interface ShotResult {
  id: string;
  enjoyment: number | null;
  notes: string | null;
  editStanding: "awaitingTablet" | "noTablet" | null;
  edits?: { total: number; offset: number; more: boolean; entries: ListedEdit[] };
  curves?: unknown;
  cut?: string;
}

/** A Shot's edits as the REST API lists them, of what these tests read. */
interface RestShot {
  enjoyment: number | null;
  notes: string | null;
  editStanding: "awaitingTablet" | "noTablet" | null;
  edits: { fields: Record_; account: { id: string; name: string | null } | null; connectedApp: { id: string; name: string; host: string } | null; madeAt: string; state: string; dropped: string[] }[];
}

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

describe("A Shot's rating and note edited through an assistant", { timeout: 120_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  /** The Admin's assistant, which may read and change, and another of theirs, which may only read. */
  let assistant: Assistant;
  let reader: Assistant;
  let belmont: LocationView;
  let lab: LocationView;
  let belmontMachine: CreatedMachine;
  let labMachine: CreatedMachine;
  let belmontTablet: SimulatedTablet;
  let adminId: string;
  /** The Admin's assistant as the REST API names it, to anyone. */
  let throughApp: { id: string; name: string; host: string };
  const tablets = new LoadedTablets();
  const opened: Assistant[] = [];

  runAsSteps();

  const rest = async (id: string, as: AdminApi = api) => (await as.get<{ shot: RestShot }>(`/shots/${id}`)).shot;
  /** What the tablet's own Decaid holds of the Shot's rating and note. */
  const onTablet = async (tablet: SimulatedTablet, id: string) => {
    const { body } = await tablet.callApi("GET", `/shots/${id}`);
    const { enjoyment, espressoNotes } = ((body as Record_).annotations ?? {}) as Record_;
    return { enjoyment, espressoNotes };
  };
  /** A tool's error, which the call must answer with. */
  async function toolError(by: Assistant, name: string, args: Record_): Promise<string> {
    const result = await by.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }
  /** The REST API's refusal of an edit, which must be refused with the status, as its message. */
  async function restRefusal(as: AdminApi, id: string, body: unknown, status: number): Promise<string> {
    const response = await as.call("PATCH", `/shots/${id}`, body);
    expect(response.status, id).toBe(status);
    const { message } = (await response.json()) as { message: string | string[] };
    return Array.isArray(message) ? message.join("; ") : message;
  }
  /** A Staff member or Viewer, with an assistant connected as them that asks to read and change, and their REST API. */
  async function person(email: string, role: "staff" | "viewer", locations: LocationView[]): Promise<{ assistant: Assistant; api: AdminApi; id: string }> {
    const { link } = await api.invite(email, role, locations.map((location) => location.id));
    const cookie = await acceptInvite(server.url, link, { name: email, password: "a password for apps" });
    const theirs = await Assistant.connect(server.url, app, cookie, { allowed: role === "viewer" ? ["read"] : ["read", "change"] });
    opened.push(theirs);
    const theirApi = AdminApi.signedInAs(server.url, cookie);
    return { assistant: theirs, api: theirApi, id: (await theirApi.get<{ account: { id: string } }>("/session")).account.id };
  }

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    const cookie = await signIn(server.url, admin);
    assistant = await Assistant.connect(server.url, app, cookie);
    reader = await Assistant.connect(server.url, app, cookie, { allowed: ["read"] });
    opened.push(assistant, reader);
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
    const labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(belmontMachine, labMachine);
    belmontTablet.pullShot(shotOf("app-belmont", "2026-11-10T09:00:00.000Z", BELMONT_SERIAL, { enjoyment: 4, espressoNotes: "Sour at first" }));
    belmontTablet.pullShot(shotOf("app-belmont-gone", "2026-11-10T09:05:00.000Z", BELMONT_SERIAL));
    belmontTablet.pullShot(shotOf("app-belmont-long", "2026-11-10T09:07:00.000Z", BELMONT_SERIAL));
    // Recorded on hardware no Machine has: a Pending Machine's, at no Location, held by Belmont's tablet.
    belmontTablet.pullShot(shotOf("app-pending", "2026-11-10T09:10:00.000Z", UNKNOWN_SERIAL));
    labTablet.pullShot(shotOf("app-lab", "2026-11-10T10:00:00.000Z", LAB_SERIAL, { enjoyment: 6 }));
    const ids = ["app-belmont", "app-belmont-gone", "app-belmont-long", "app-pending", "app-lab"];
    const deadline = Date.now() + 30_000;
    while (!(await Promise.all(ids.map((id) => api.call("GET", `/shots/${id}`)))).every((response) => response.status === 200)) {
      if (Date.now() > deadline) throw new Error("The server did not store the Shots in time");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  afterAll(async () => {
    for (const each of opened) await each.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  it("edits a rating alone, a note alone and both, each as the REST API then reads the Shot, recorded as the Admin's through the Connected App, and written to its tablet", async () => {
    expect(await assistant.call<ShotResult>("get_shot", { id: "app-belmont" })).toMatchObject({ enjoyment: 4, notes: "Sour at first", editStanding: null });

    // The answer is the Shot as get_shot reads it, without curves or its edits: applied at once.
    const rated = await assistant.callWithinBudget<ShotResult>("edit_shot", { id: "app-belmont", rating: 8 });
    expect(rated.result).toMatchObject({ id: "app-belmont", enjoyment: 8, notes: "Sour at first" });
    expect(rated.result).not.toHaveProperty("curves");
    expect(rated.result).not.toHaveProperty("edits");
    const read = await assistant.call<ShotResult>("get_shot", { id: "app-belmont" });
    expect({ ...rated.result, editStanding: read.editStanding }).toEqual(read);

    // The REST API lists the edit as the Admin's, through their assistant.
    const [edit] = (await rest("app-belmont")).edits;
    expect(edit).toMatchObject({ fields: { rating: 8 }, account: { id: adminId, name: admin.name }, connectedApp: { name: "Test Assistant", host: expect.any(String) } });
    expect(edit!.fields).not.toHaveProperty("note");
    throughApp = edit!.connectedApp!;
    const { connectedApps } = await api.get<{ connectedApps: { id: string; name: string }[] }>("/connected-apps");
    expect(connectedApps.map((connected) => connected.id)).toContain(throughApp.id);

    // Its tablet's own Shot follows, its note left alone.
    await expect.poll(() => onTablet(belmontTablet, "app-belmont")).toEqual({ enjoyment: 8, espressoNotes: "Sour at first" });
    await expect.poll(async () => (await assistant.call<ShotResult>("get_shot", { id: "app-belmont" })).editStanding).toBeNull();

    expect(await assistant.call<ShotResult>("edit_shot", { id: "app-belmont", note: "Sweeter as it cooled" })).toMatchObject({ enjoyment: 8, notes: "Sweeter as it cooled" });
    expect(await assistant.call<ShotResult>("edit_shot", { id: "app-belmont", rating: 0, note: "" })).toMatchObject({ enjoyment: 0, notes: null });
    await expect.poll(() => onTablet(belmontTablet, "app-belmont")).toEqual({ enjoyment: 0, espressoNotes: "" });
    expect((await rest("app-belmont")).edits.map((made) => [made.fields, made.connectedApp?.id])).toEqual([
      [{ rating: 0, note: "" }, throughApp.id],
      [{ note: "Sweeter as it cooled" }, throughApp.id],
      [{ rating: 8 }, throughApp.id],
    ]);
    // A Shot Summary counts it unrated again.
    const { groups } = await assistant.call<{ groups: { numbers: { rating: { rated: number | null } } }[] }>("summarise_shots", { machineId: belmontMachine.machine.id, numbers: ["rating"] });
    expect(groups[0]!.numbers.rating.rated).toBe(0);
    // Each is recorded as written before the next step takes the tablet off.
    await expect.poll(async () => (await rest("app-belmont")).edits.map((made) => made.state)).toEqual(["written", "written", "written"]);
  });

  it("says in get_shot that an edit awaits its tablet, lists the edits with who made each when asked, and says nothing once the tablet has them", async () => {
    belmontTablet.loseNetwork();
    await api.waitForMachine("Belmont 1", (machine) => !machine.online);

    // One in the management interface, as the REST API makes it, and one through the assistant.
    await api.send("PATCH", "/shots/app-belmont", { note: "Rested a week" });
    const edited = await assistant.call<ShotResult>("edit_shot", { id: "app-belmont", rating: 7 });
    expect(edited).toMatchObject({ enjoyment: 7, notes: "Rested a week", editStanding: "awaitingTablet" });
    expect(await onTablet(belmontTablet, "app-belmont")).toEqual({ enjoyment: 0, espressoNotes: "" });

    // Without its edits unless asked, as the REST API reads where they stand.
    const plain = await reader.call<ShotResult>("get_shot", { id: "app-belmont" });
    expect(plain.editStanding).toBe("awaitingTablet");
    expect(plain).not.toHaveProperty("edits");
    expect((await rest("app-belmont")).editStanding).toBe("awaitingTablet");

    const { result, text } = await reader.callWithinBudget<ShotResult>("get_shot", { id: "app-belmont", edits: true });
    // A page, its paging fields before its entries, newest first: each as the REST API lists it, its time on Belmont's clock.
    expect(text).toMatch(/"edits":\{"total":5,"offset":0,"more":false,"entries":\[/);
    const listed = (await rest("app-belmont")).edits;
    expect(result.edits!.entries).toEqual(
      listed.map((made) => ({ madeAt: expect.stringMatching(/-0[56]:00$/), account: made.account, connectedApp: made.connectedApp, ...made.fields, state: made.state, dropped: made.dropped })),
    );
    expect(result.edits!.entries.map((made) => Date.parse(made.madeAt))).toEqual(listed.map((made) => Date.parse(made.madeAt)));
    expect(result.edits!.entries.slice(0, 2)).toEqual([
      { madeAt: expect.any(String), account: { id: adminId, name: admin.name }, connectedApp: throughApp, rating: 7, state: "awaitingTablet", dropped: [] },
      { madeAt: expect.any(String), account: { id: adminId, name: admin.name }, connectedApp: null, note: "Rested a week", state: "awaitingTablet", dropped: [] },
    ]);
    expect(result.edits!.entries.slice(2).map((made) => made.state)).toEqual(["written", "written", "written"]);

    belmontTablet.restoreNetwork();
    await expect.poll(async () => (await reader.call<ShotResult>("get_shot", { id: "app-belmont" })).editStanding, { timeout: 30_000 }).toBeNull();
    expect(await onTablet(belmontTablet, "app-belmont")).toEqual({ enjoyment: 7, espressoNotes: "Rested a week" });
    const after = await reader.call<ShotResult>("get_shot", { id: "app-belmont", edits: true });
    expect(after.edits!.entries.map((made) => made.state)).toEqual(["written", "written", "written", "written", "written"]);
  });

  it("says in get_shot that an edit has no tablet to reach, where its tablet no longer holds the Shot", async () => {
    // The Shot was deleted on the tablet: Decaid there no longer holds it.
    belmontTablet.refuseFor("/shots/app-belmont-gone", new Refusal(404, { error: "Shot not found" }));
    expect(await assistant.call<ShotResult>("edit_shot", { id: "app-belmont-gone", rating: 5 })).toMatchObject({ enjoyment: 5 });
    await expect.poll(async () => (await assistant.call<ShotResult>("get_shot", { id: "app-belmont-gone" })).editStanding).toBe("noTablet");
    const { edits, enjoyment } = await assistant.call<ShotResult>("get_shot", { id: "app-belmont-gone", edits: true });
    // The edit stays in Decent Sync, as the Shot reads.
    expect(enjoyment).toBe(5);
    expect(edits!.entries).toEqual([{ madeAt: expect.any(String), account: { id: adminId, name: admin.name }, connectedApp: throughApp, rating: 5, state: "noTablet", dropped: [] }]);
    expect((await rest("app-belmont-gone")).editStanding).toBe("noTablet");
  });

  it("lets Staff edit the Shots at their Locations and no others, as the REST API does, naming other accounts to an Admin alone", async () => {
    const staff = await person("staff-belmont@example.com", "staff", [belmont]);
    expect(await staff.assistant.call<ShotResult>("edit_shot", { id: "app-belmont", note: "Checked by Staff" })).toMatchObject({ enjoyment: 7, notes: "Checked by Staff" });

    // Not the Lab's, nor a Shot at no Location, which is an Admin's alone: each with the REST API's message, changing nothing.
    for (const id of ["app-lab", "app-pending"]) {
      const message = await restRefusal(staff.api, id, { rating: 1 }, 403);
      expect(message).toBe("You can edit only the Shots at a Location you work at");
      expect(await toolError(staff.assistant, "edit_shot", { id, rating: 1 })).toContain(message);
      expect((await rest(id)).edits).toEqual([]);
    }
    expect(await rest("app-lab")).toMatchObject({ enjoyment: 6 });
    // An Admin's assistant edits both.
    expect(await assistant.call<ShotResult>("edit_shot", { id: "app-lab", rating: 9 })).toMatchObject({ enjoyment: 9 });
    expect(await assistant.call<ShotResult>("edit_shot", { id: "app-pending", rating: 2 })).toMatchObject({ enjoyment: 2 });

    // Staff read who made each edit by its id alone, as the REST API gives it to them; an Admin by name.
    const [theirs, admins] = (await staff.assistant.call<ShotResult>("get_shot", { id: "app-belmont", edits: true })).edits!.entries;
    expect(theirs).toMatchObject({ account: { id: staff.id, name: null }, connectedApp: { name: "Test Assistant" }, note: "Checked by Staff" });
    expect(theirs!.connectedApp!.id).not.toBe(throughApp.id);
    expect(admins).toMatchObject({ account: { id: adminId, name: null }, rating: 7 });
    const [asAdmin] = (await assistant.call<ShotResult>("get_shot", { id: "app-belmont", edits: true })).edits!.entries;
    expect(asAdmin).toMatchObject({ account: { id: staff.id, name: "staff-belmont@example.com" } });
  });

  it("refuses what the REST API refuses, with its message, and input its schema refuses, changing nothing", async () => {
    const before = await rest("app-lab");
    const nothing = await restRefusal(api, "app-lab", {}, 400);
    expect(nothing).toBe("Send the Shot's rating, its note or both");
    expect(await toolError(assistant, "edit_shot", { id: "app-lab" })).toContain(nothing);
    const missing = await restRefusal(api, "no-such-shot", { rating: 1 }, 404);
    expect(await toolError(assistant, "edit_shot", { id: "no-such-shot", rating: 1 })).toContain(missing);
    const unpaired = await restRefusal(api, "app-lab", { note: "\ud83d" }, 400);
    expect(await toolError(assistant, "edit_shot", { id: "app-lab", note: "\ud83d" })).toContain(unpaired);

    // Its schema refuses a rating out of range or not a number, and any field but the two.
    for (const args of [{ rating: 11 }, { rating: -1 }, { rating: "8" }, { note: 4 }, { rating: 5, dose: 18 }, { rating: 5, enjoyment: 5 }]) {
      const result = await assistant.client.callTool({ name: "edit_shot", arguments: { id: "app-lab", ...args } }).then(
        (answered) => answered.isError === true,
        () => true,
      );
      expect(result, JSON.stringify(args)).toBe(true);
    }
    // Text a response cut is never saved over the whole.
    expect(await toolError(assistant, "edit_shot", { id: "app-lab", note: `Bright, then${CUT_MARK}` })).toContain(CUT_MARK);
    expect(await rest("app-lab")).toEqual(before);
  });

  it("refuses the tool from a Connected App that may only read, and from a Viewer's, with 403 insufficient_scope naming read and change, changing nothing", async () => {
    const viewer = await person("viewer@example.com", "viewer", []);
    const before = await rest("app-lab");
    for (const refusedApp of [reader, viewer.assistant]) {
      const refused = await Assistant.rawCall(server.url, refusedApp.tokens.access_token, "tools/call", { name: "edit_shot", arguments: { id: "app-lab", rating: 1 } });
      expect(refused.status).toBe(403);
      const challenge = refused.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="read change"');
    }
    expect(await rest("app-lab")).toEqual(before);
    // A Viewer reads the Shot, where its edits stand and who made them, by id alone.
    const read = await viewer.assistant.call<ShotResult>("get_shot", { id: "app-lab", edits: true });
    expect(read).toMatchObject({ enjoyment: 9 });
    expect(read.edits!.entries).toEqual([expect.objectContaining({ account: { id: adminId, name: null }, connectedApp: throughApp, rating: 9 })]);
  });

  it("keeps edit_shot's answer within the budget, a long note cut and marked there and saved whole", async () => {
    // A note far longer than any typed, of text that grows as it is serialized.
    const long = 'Quote " backslash \\ newline \n tab \t emoji \u{1F375} '.repeat(1_200);
    const { result } = await assistant.callWithinBudget<ShotResult>("edit_shot", { id: "app-belmont-long", note: long });
    // Its note is cut in get_shot's answer too, so the note says where it reads whole.
    expect(result.cut).toContain("The management interface shows it whole.");
    expect(result.notes!.endsWith(CUT_MARK)).toBe(true);
    expect((await rest("app-belmont-long")).notes).toBe(long);
    // And on its tablet.
    await expect.poll(async () => (await onTablet(belmontTablet, "app-belmont-long")).espressoNotes).toBe(long);
  });
});
