import { dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { dye2List } from "./support/simulated-dye2.js";
import { RawConnection, type SimulatedTablet, helloWith } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #511 (milestone 8, ADR-0030, amending ADR-0029):
// choosing a Recipe's Reference Shot from a tablet. A Skin sends the
// plugin's `reference` endpoint a PUT naming the Recipe by the id of its
// DYE2 record on the tablet, with the Shot's id; the plugin asks the server,
// which makes the choice through the service the management interface
// chooses one through, as a version naming the Machine and tablet and no
// account, and announces it to the Location's tablets. Through the built
// plugin in simulated tablets against a real server: two at Belmont and one
// at the Lab, whose Recipes are made through the REST API and written to
// them. Each Shot is derived from a Shot Decaid recorded, changing its id,
// time and recorded hardware. Serials are made up, from 52001.

type Record_ = Record<string, unknown>;

// Heartbeats every 30 s, the default: while a call to the plugin's endpoint awaits its answer the tablet runs at real
// time, its heartbeats with it, so a server expecting one a second would drop a call that took three.
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };

const LEFT_SERIAL = "52001";
const RIGHT_SERIAL = "52002";
const LAB_SERIAL = "52003";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "52009";
const RECIPES = "/store/dye2.reaplugin/recipes";

interface Recipe {
  id: string;
  name: string | null;
  recordId: string | null;
}

interface Version {
  fields: Record_;
  location: LocationView | null;
  source: { machine: { id: string; name: string } | null; tabletId: string | null; account: { id: string } | null; connectedApp: { id: string } | null };
}

interface Answer {
  status: number;
  body: Record_;
}

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

const recipeRecords = (tablet: SimulatedTablet): Record_[] => {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]) : [];
};
/** The tablet's DYE2 record of the Recipe. */
const recordOf = (tablet: SimulatedTablet, recipeId: string) => recipeRecords(tablet).find((record) => dye2GlobalIdOf(record) === recipeId)!;
const recordIdOf = (tablet: SimulatedTablet, recipeId: string) => String(recordOf(tablet, recipeId).id);
const pushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "reference");
const connectionPushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "connection").map((push) => push.connected);
/** The choices the plugin asked the server to make. */
const choicesSent = (tablet: SimulatedTablet) => (tablet.sent as Record_[]).filter((frame) => frame.type === "request" && frame.ask === "chooseReference");
/** The id of the Reference Shot the tablet keeps a copy of for a Recipe Slot: null where it keeps that the Recipe has none. */
const kept = (tablet: SimulatedTablet, slot: number): string | null | undefined => {
  const value = tablet.storage.read(`reference.${slot}`);
  if (typeof value !== "string" || value === "{}") return undefined;
  const reference = value.split("\n")[1];
  return reference === undefined ? undefined : ((JSON.parse(reference) as { shot: { id: string } } | null)?.shot.id ?? null);
};

async function answered(calling: ReturnType<SimulatedTablet["callEndpoint"]>): Promise<Answer> {
  const answer = await calling;
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** Sends the tablet's `reference` endpoint a PUT as a Skin does, naming the Recipe by a record's id, with the body given. */
const put = (tablet: SimulatedTablet, record: string, body: unknown) => answered(tablet.callEndpoint("reference", { method: "PUT", query: { recipe: record }, body }));

/** A Shot pulled at a UTC time on the hardware of that serial, derived from the fixture. */
function shotOf(id: string, pulledAt: string, serial: string): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return { ...fixture, id, timestamp: pulledAt, workflow: { ...workflow, machine: { ...(workflow.machine as Record_), model: "DE1Pro", serialNumber: serial } } };
}

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Choosing a Recipe's Reference Shot from a tablet", { timeout: 180_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let belmont: LocationView;
  let lab: LocationView;
  let leftMachine: CreatedMachine;
  let rightMachine: CreatedMachine;
  let left: SimulatedTablet;
  let right: SimulatedTablet;
  let labTablet: SimulatedTablet;
  /** Belmont's Recipes: its espresso in slot 1, its decaf in slot 2 and its spare in no slot; and the Lab's espresso. */
  let espresso: string;
  let decaf: string;
  let spare: string;
  let labEspresso: string;

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    belmont = await api.createLocation("Belmont", "America/Chicago");
    lab = await api.createLocation("Lab", "America/Denver");
    leftMachine = await api.createMachine("Belmont Left");
    rightMachine = await api.createMachine("Belmont Right");
    const labMachine = await api.createMachine("Lab 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[leftMachine, belmont], [rightMachine, belmont], [labMachine, lab]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    left = tablets.syncing(leftMachine, server, { api: emptyLibrary(LEFT_SERIAL) });
    right = tablets.syncing(rightMachine, server, { api: emptyLibrary(RIGHT_SERIAL) });
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(leftMachine, rightMachine, labMachine);

    left.pullShot(shotOf("choice-left", "2026-03-10T15:00:00Z", LEFT_SERIAL));
    right.pullShot(shotOf("choice-right", "2026-03-10T16:00:00Z", RIGHT_SERIAL));
    // Pulled at another Location: one that comes to be a Belmont Recipe's reference, and one that never does.
    labTablet.pullShot(shotOf("choice-lab", "2026-03-10T17:00:00Z", LAB_SERIAL));
    labTablet.pullShot(shotOf("choice-lab-other", "2026-03-10T18:00:00Z", LAB_SERIAL));
    // On hardware no Machine has: a Pending Machine holds it, at no Location.
    right.pullShot(shotOf("choice-pending", "2026-03-10T19:00:00Z", UNKNOWN_SERIAL));
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === 5);

    const create = async (location: LocationView, content: Record_, slot: "next" | null) =>
      (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: location.id, slot, content }, 201)).recipe.id;
    espresso = await create(belmont, { name: "Belmont espresso", dose: 18, yield: 36 }, "next");
    decaf = await create(belmont, { name: "Belmont decaf", dose: 18, yield: 40 }, "next");
    spare = await create(belmont, { name: "Belmont spare", dose: 18, yield: 36 }, null);
    labEspresso = await create(lab, { name: "Lab espresso", dose: 18, yield: 36 }, "next");
    // Each tablet holds its Location's Recipes in DYE2's list, each record carrying its Recipe's id.
    await until(() => [left, right].every((tablet) => recipeRecords(tablet).filter((record) => dye2GlobalIdOf(record) !== null).length === 3));
    await until(() => recipeRecords(labTablet).some((record) => dye2GlobalIdOf(record) === labEspresso));
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  const named = (tablet: SimulatedTablet, recipeId: string, name: string): Recipe => ({ id: recipeId, name, recordId: recordIdOf(tablet, recipeId) });
  /** Chooses the Shot for the Recipe on the tablet, as a Skin there does. */
  const choose = (tablet: SimulatedTablet, recipeId: string, shotId: string) => put(tablet, recordIdOf(tablet, recipeId), { shotId });
  /** The Recipe's reference as the tablet's `reference` endpoint reads it. */
  const reference = (tablet: SimulatedTablet, recipeId: string) => answered(tablet.callEndpoint("reference", { query: { recipe: recordIdOf(tablet, recipeId) } }));
  /** The id of the Recipe's Reference Shot, as its REST read gives it. */
  const chosen = async (recipeId: string) => (await api.get<{ recipe: { referenceShot: { id: string } | null } }>(`/recipes/${recipeId}`)).recipe.referenceShot?.id ?? null;
  /** The versions of the Recipe's history that chose or cleared its Reference Shot, the latest first. */
  const choices = async (recipeId: string) =>
    (await api.get<{ versions: Version[] }>(`/recipes/${recipeId}/history`)).versions.filter((version) => Object.hasOwn(version.fields, "referenceShotId"));
  /** A choice made on the tablet, as a Recipe's history names it. */
  const madeOn = (machine: CreatedMachine, name: string, tablet: SimulatedTablet) => ({
    machine: { id: machine.machine.id, name },
    tabletId: tablet.storage.read("tabletId"),
    account: null,
    connectedApp: null,
  });

  it("makes a Shot its tablet pulled the Recipe's Reference Shot, answered as a read is, with a version naming the Machine and tablet and no account", async () => {
    const before = pushes(right).length;
    const answer = await choose(left, espresso, "choice-left");
    expect(answer).toMatchObject({
      status: 200,
      body: { recipe: named(left, espresso, "Belmont espresso"), reference: { shot: { id: "choice-left" }, referenceOf: [named(left, espresso, "Belmont espresso")] }, source: "server" },
    });
    // The Recipe's Reference Shot as it now is: what a read gives, whole.
    expect(await reference(left, espresso)).toEqual(answer);
    expect(((answer.body.reference as { shot: { measurements: unknown[] } }).shot.measurements as unknown[]).length).toBe((shotFixture().measurements as unknown[]).length);
    // The plugin asked with the Recipe's own id, which its record carries.
    expect(choicesSent(left)).toEqual([{ type: "request", id: expect.any(String), ask: "chooseReference", recipeId: espresso, shotId: "choice-left" }]);

    // The Recipe's REST read has it, and its history names the Machine and tablet it was chosen on.
    expect(await chosen(espresso)).toBe("choice-left");
    expect(await choices(espresso)).toEqual([expect.objectContaining({ fields: { referenceShotId: "choice-left" }, location: null, source: madeOn(leftMachine, "Belmont Left", left) })]);

    // The other tablet's copy is replaced, and its Skin pushed; the choosing tablet's too.
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("choice-left");
    expect(pushes(right).slice(before)).toContainEqual({ what: "reference", recipe: named(right, espresso, "Belmont espresso") });
    expect((await reference(right, espresso)).body).toMatchObject({ reference: { shot: { id: "choice-left" } }, source: "server" });
  });

  it("chooses a Shot the other Machine pulled, and for a Recipe in no slot, and adds no version when the Recipe has the Shot already", async () => {
    expect(await choose(left, espresso, "choice-right")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-right" } } } });
    expect(await chosen(espresso)).toBe("choice-right");
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("choice-right");
    // From the tablet beside it, which names the Recipe by its own record.
    expect(await choose(right, spare, "choice-right")).toMatchObject({ status: 200, body: { recipe: named(right, spare, "Belmont spare"), reference: { shot: { id: "choice-right" } } } });
    expect((await choices(spare)).map((version) => version.source)).toEqual([madeOn(rightMachine, "Belmont Right", right)]);

    // Chosen again, it is answered the same and nothing is recorded.
    expect(await choose(right, espresso, "choice-right")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-right" } }, source: "server" } });
    expect((await choices(espresso)).map((version) => [version.fields.referenceShotId, version.source.machine?.name])).toEqual([
      ["choice-right", "Belmont Left"],
      ["choice-left", "Belmont Left"],
    ]);
  });

  it("chooses a Shot pulled a moment ago in one call, asking once the server has stored it", async () => {
    // Decaid is slow to read the Shot, so its delivery is still to come as the Skin chooses it.
    const release = left.holdShotReads();
    left.pullShot(shotOf("choice-just-pulled", new Date().toISOString(), LEFT_SERIAL));
    await expect.poll(() => left.inFlightRequests.map((request) => request.route)).toContain("/shots/choice-just-pulled");
    const asked = choicesSent(left).length;
    const choosing = choose(left, decaf, "choice-just-pulled");
    // The request doesn't go out ahead of the Shot, which the server doesn't hold yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(choicesSent(left)).toHaveLength(asked);
    expect((await api.call("GET", "/shots/choice-just-pulled")).status).toBe(404);

    release();
    expect(await choosing).toMatchObject({ status: 200, body: { recipe: named(left, decaf, "Belmont decaf"), reference: { shot: { id: "choice-just-pulled" } }, source: "server" } });
    expect(await chosen(decaf)).toBe("choice-just-pulled");
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 2)).toBe("choice-just-pulled");
  });

  it("chooses only a Shot the tablet may read whole: another Location's only as the Reference Shot of one of its Location's Recipes", async () => {
    const noSuchShot = { status: 404, body: { code: "noSuchShot", message: expect.stringContaining("No Shot") } };
    // Another Location's Shot and an id that names none are refused alike.
    expect(await choose(left, espresso, "choice-lab")).toEqual(noSuchShot);
    expect(await choose(left, espresso, "no-such-shot")).toEqual(noSuchShot);
    // A Pending Machine's Shot, at no Location, made a Belmont Recipe's Reference Shot in the management interface and
    // then hidden as its Pending Machine is dismissed: the Shots list no longer lists it, so no tablet may choose it,
    // though a Belmont Recipe still names it.
    await api.send("PUT", `/recipes/${spare}/reference-shot`, { shotId: "choice-pending" });
    const { pendingMachines } = await api.get<{ pendingMachines: { id: string; serial: string }[] }>("/pending-machines");
    expect((await api.call("POST", `/pending-machines/${pendingMachines.find((each) => each.serial === UNKNOWN_SERIAL)!.id}/dismiss`)).status).toBe(200);
    expect(await choose(left, espresso, "choice-pending")).toEqual(noSuchShot);
    expect(await chosen(espresso)).toBe("choice-right");

    // Made a Belmont Recipe's Reference Shot in the management interface, the Lab's Shot is one Belmont's tablets read whole.
    await api.send("PUT", `/recipes/${spare}/reference-shot`, { shotId: "choice-lab" });
    expect(await choose(left, espresso, "choice-lab")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-lab" } } } });
    expect(await chosen(espresso)).toBe("choice-lab");
    // The Lab's other Shot is still none of theirs.
    expect(await choose(left, espresso, "choice-lab-other")).toEqual(noSuchShot);
    // The Lab's own tablet chooses it, for the Lab's Recipe.
    expect(await choose(labTablet, labEspresso, "choice-lab-other")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-lab-other" } } } });
    expect(await chosen(labEspresso)).toBe("choice-lab-other");
  });

  it("never clears a Reference Shot, and refuses a request it can't read and a record that is no Recipe without asking the server", async () => {
    const asked = choicesSent(left).length;
    const record = recordIdOf(left, espresso);
    const invalid = (what: string) => ({ status: 400, body: { code: "invalidRequest", message: expect.stringContaining(what) } });
    // A request names a Shot: none, null and an empty id are no request to clear it.
    for (const body of [undefined, null, {}, { shotId: null }, { shotId: "" }, { shotId: 7 }, { shotId: "x".repeat(2049) }, ["choice-left"]]) {
      expect(await put(left, record, body)).toEqual(invalid("shotId"));
    }
    expect(await put(left, record, { shotId: null })).toMatchObject({ body: { message: expect.stringContaining("can't clear") } });
    expect(await answered(left.callEndpoint("reference", { method: "PUT", body: { shotId: "choice-left" } }))).toEqual(invalid("recipe"));
    const noSuchRecipe = { status: 404, body: { code: "noSuchRecipe", message: expect.stringContaining("Recipe") } };
    expect(await put(left, "no-such-record", { shotId: "choice-left" })).toEqual(noSuchRecipe);
    // The tablet's own Recipes are named by their records' ids, never by the Library's.
    expect(await put(left, espresso, { shotId: "choice-left" })).toEqual(noSuchRecipe);
    expect(choicesSent(left)).toHaveLength(asked);
    expect(await chosen(espresso)).toBe("choice-lab");

    for (const method of ["POST", "PATCH", "DELETE"]) {
      const answer = await left.callEndpoint("reference", { method, query: { recipe: record }, body: { shotId: "choice-left" } });
      expect([answer.status, answer.headers.Allow, JSON.parse(answer.body)]).toEqual([405, "GET, PUT", { error: "Only GET and PUT are answered" }]);
    }
    expect(await chosen(espresso)).toBe("choice-lab");
  });

  describe("choices, with raw frames", () => {
    const answers = (raw: RawConnection) => (raw.messages as Record_[]).filter((message) => message.type === "answer");
    const refused = (id: string, why: string) => ({ type: "answer", id, ask: "chooseReference", refused: why });

    it("refuses a Recipe of another Location as not at this Location, one of none as no such Recipe, an Archived one as Archived, and a Capture-only connection as not served", async () => {
      const archived = (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: belmont.id, slot: null, content: { name: "Belmont retired" } }, 201)).recipe.id;
      await api.send("PUT", `/recipes/${archived}/reference-shot`, { shotId: "choice-left" });
      await api.send("PUT", `/recipes/${archived}/archived`, { archived: true });

      const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Belmont raw", belmont.id)).token));
      const ask = (id: string, recipeId: string, shotId: string) => raw.send({ type: "request", id, ask: "chooseReference", recipeId, shotId });
      ask("theirs", labEspresso, "choice-right");
      await expect.poll(() => answers(raw)).toEqual([refused("theirs", "notAtThisLocation")]);
      ask("none", "00000000-0000-4000-8000-000000000000", "choice-right");
      await expect.poll(() => answers(raw).at(-1)).toEqual(refused("none", "noSuchRecipe"));
      // Archived, it is refused whichever Shot is named, as in the management interface.
      ask("retired", archived, "choice-right");
      await expect.poll(() => answers(raw).at(-1)).toEqual(refused("retired", "archived"));
      ask("retired, no Shot", archived, "no-such-shot");
      await expect.poll(() => answers(raw).at(-1)).toEqual(refused("retired, no Shot", "archived"));
      // A Recipe is looked for before its Shot.
      ask("theirs, no Shot", labEspresso, "no-such-shot");
      await expect.poll(() => answers(raw).at(-1)).toEqual(refused("theirs, no Shot", "notAtThisLocation"));
      ask("no Shot", espresso, "no-such-shot");
      await expect.poll(() => answers(raw).at(-1)).toEqual(refused("no Shot", "noSuchShot"));
      expect([await chosen(labEspresso), await chosen(archived), await chosen(espresso)]).toEqual(["choice-lab-other", "choice-left", "choice-lab"]);
      expect(await choices(archived)).toHaveLength(1);

      // A request that names no Shot, or no Recipe by its id, is no plugin's: the connection ends.
      raw.send({ type: "request", id: "clearing", ask: "chooseReference", recipeId: espresso, shotId: null });
      expect((await raw.closed).code).toBe(4000);
      expect(raw.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining("request.shotId") });
      expect(await chosen(espresso)).toBe("choice-lab");

      const sharingOff = await api.createMachine("Belmont raw, sharing off", belmont.id);
      await api.send("PUT", `/machines/${sharingOff.machine.id}/sharing`, { sharing: false });
      const captureOnly = await RawConnection.welcomed(server.url, helloWith(sharingOff.token));
      captureOnly.send({ type: "request", id: "capture-only", ask: "chooseReference", recipeId: espresso, shotId: "choice-right" });
      await expect.poll(() => answers(captureOnly)).toEqual([refused("capture-only", "captureOnly")]);
      await captureOnly.close();
      expect(await chosen(espresso)).toBe("choice-lab");
    });
  });

  it("tells a Skin that a Recipe is Archived, or another Location's, while the tablet still holds a record of it", async () => {
    const machine = await api.createMachine("Belmont Third", belmont.id);
    const third = tablets.syncing(machine, server, { api: emptyLibrary(52_004) });
    await until(() => recipeRecords(third).filter((record) => dye2GlobalIdOf(record) !== null).length === 3);
    const records = { espresso: recordIdOf(third, espresso), decaf: recordIdOf(third, decaf) };
    // Decaid is slow to take the plugin's writes of DYE2's recipes, so the tablet's records stay as they were, as they
    // do for a moment after a Recipe is Archived and after the tablet's Machine moves.
    const writes = third.holdRequests("POST", RECIPES);
    try {
      await api.send("PUT", `/recipes/${decaf}/archived`, { archived: true });
      await expect.poll(() => writes.arrived).toBeGreaterThan(0);
      expect(await put(third, records.decaf, { shotId: "choice-right" })).toEqual({ status: 409, body: { code: "archived", message: expect.stringContaining("Archived") } });

      // Moved to the Lab, the tablet's record of Belmont's espresso is of another Location's Recipe.
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: lab.id }, 201);
      await until(async () => ((await answered(third.callEndpoint("status"))).body.location as { id: string } | null)?.id === lab.id);
      expect(await put(third, records.espresso, { shotId: "choice-right" })).toEqual({
        status: 403,
        body: { code: "notAtThisLocation", message: expect.stringContaining("another Location") },
      });
      expect([await chosen(decaf), await chosen(espresso)]).toEqual(["choice-just-pulled", "choice-lab"]);
    } finally {
      writes.release();
      await third.unload();
    }
  });

  it("refuses a choice while the server is stopped, asking nothing, and nothing has changed once it is back; a choice through one instance reaches a tablet another holds", async () => {
    const machine = await api.createMachine("Belmont Fourth", belmont.id);
    // An instance of its own, to stop and to start again at the same address.
    const instance = await startTestServer({ env, sharing: server });
    const fourth = tablets.syncing(machine, instance, { api: emptyLibrary(52_005) });
    await until(() => recipeRecords(fourth).filter((record) => dye2GlobalIdOf(record) === espresso || dye2GlobalIdOf(record) === spare).length === 2);

    // Chosen through this instance, it reaches the tablets the first one holds.
    expect(await choose(fourth, espresso, "choice-left")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-left" } } } });
    for (const tablet of [left, right, fourth]) await expect.poll(() => kept(tablet, 1)).toBe("choice-left");
    expect((await choices(espresso))[0]!.source).toEqual(madeOn(machine, "Belmont Fourth", fourth));

    const before = { versions: (await choices(espresso)).length, asked: choicesSent(fourth).length };
    await instance.stop();
    await expect.poll(() => connectionPushes(fourth).at(-1)).toBe(false);
    const unreachable = { status: 503, body: { code: "unreachable", message: expect.stringContaining("can't be reached") } };
    // A Recipe in a slot, whose copy the tablet keeps, is refused as one in none is: a copy is no answer to a choice.
    expect(await choose(fourth, espresso, "choice-right")).toEqual(unreachable);
    expect(await choose(fourth, spare, "choice-left")).toEqual(unreachable);
    expect(choicesSent(fourth)).toHaveLength(before.asked);

    // The server back at its address: the plugin reconnects, and what it was refused is not made now.
    const back = await startTestServer({ env, sharing: server, port: Number(new URL(instance.url).port) });
    try {
      await expect.poll(() => connectionPushes(fourth).at(-1)).toBe(true);
      // A read, which follows whatever the tablet had still to send, finds the Recipe as it was.
      await until(async () => (await reference(fourth, espresso)).status === 200);
      expect((await reference(fourth, espresso)).body).toMatchObject({ reference: { shot: { id: "choice-left" } }, source: "server" });
      expect(choicesSent(fourth)).toHaveLength(before.asked);
      expect([await chosen(espresso), await chosen(spare)]).toEqual(["choice-left", "choice-lab"]);
      expect(await choices(espresso)).toHaveLength(before.versions);
      // Asked again, it is made.
      expect(await choose(fourth, espresso, "choice-right")).toMatchObject({ status: 200, body: { reference: { shot: { id: "choice-right" } } } });
      for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("choice-right");
    } finally {
      await fourth.unload();
      await back.stop();
    }
  });
});
