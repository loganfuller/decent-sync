import { MAX_REFERENCE_COPY_BYTES, dye2GlobalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { longShot, shotFixture } from "./support/shot-fixtures.js";
import { dye2List } from "./support/simulated-dye2.js";
import { RawConnection, type SimulatedTablet, derivedProfile, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #510 (milestone 8, ADR-0030, amending ADR-0029): a
// Recipe's Reference Shot on every tablet at its Location. A Skin calls the
// plugin's `reference` endpoint, naming the Recipe by the id of its DYE2
// record on the tablet; the plugin asks the server, and answers from the
// tablet's copy while the server can't be reached. The server sends each
// served tablet a copy of the Reference Shot of each Recipe in a slot at its
// Location, and keeps it current. Through the built plugin in simulated
// tablets against a real server: two at Belmont and one at the Lab, whose
// Recipes are made through the REST API and written to them. Each Shot is
// derived from a Shot Decaid recorded, changing its id, time, recorded
// hardware, the profile its Workflow holds and its rating and note. Serials
// are made up, from 51001.

type Record_ = Record<string, unknown>;

// Heartbeats every 30 s, the default: while a call to the plugin's endpoint awaits its answer the tablet runs at real
// time, its heartbeats with it, so a server expecting one a second would drop a call that took three.
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "10", SYNC_HEARTBEAT_SECONDS: "30" };

const LEFT_SERIAL = "51001";
const RIGHT_SERIAL = "51002";
const LAB_SERIAL = "51003";
/** Hardware no Machine has, whose Shots a Pending Machine holds. */
const UNKNOWN_SERIAL = "51009";

interface Recipe {
  id: string;
  name: string | null;
  recordId: string | null;
}

interface ReferenceShot {
  shot: Record_ & { id: string; measurements: unknown[] };
  recipe: Recipe | null;
  referenceOf: Recipe[];
  rating: number | null;
  note: string | null;
  profileDiffers: boolean;
}

/** What a slot's key in the plugin's storage holds: what names its copy, and the Reference Shot kept, or null for none. */
interface Copy {
  version: string;
  recipe: Recipe;
  tooLarge?: boolean;
  reference?: ReferenceShot | null;
}

const tablets = new LoadedTablets();
afterAll(() => tablets.unloadAll());

/** Calls one of the plugin's endpoints as a Skin does: the HTTP status and the JSON answered. */
async function call(tablet: SimulatedTablet, endpoint: string, query: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: Record_ }> {
  const answer = await tablet.callEndpoint(endpoint, { query, method });
  expect(answer.headers["Content-Type"]).toBe("application/json");
  return { status: answer.status, body: JSON.parse(answer.body) as Record_ };
}

/** What the tablet keeps for a Recipe Slot, as the plugin wrote it to its storage: null for nothing. */
function copy(tablet: SimulatedTablet, slot: number): Copy | null {
  const value = tablet.storage.read(`reference.${slot}`);
  if (typeof value !== "string" || value === "{}") return null;
  const [head, reference] = value.split("\n");
  return { ...(JSON.parse(head!) as Copy), ...(reference !== undefined && { reference: JSON.parse(reference) as ReferenceShot | null }) };
}

/** The id of the Reference Shot the tablet keeps for a slot: null where it keeps that the Recipe has none, undefined where it keeps nothing. */
const kept = (tablet: SimulatedTablet, slot: number) => {
  const held = copy(tablet, slot);
  return held === null ? undefined : (held.reference?.shot.id ?? null);
};

const recipeRecords = (tablet: SimulatedTablet): Record_[] => {
  const list = dye2List(tablet, "recipes");
  return Array.isArray(list) ? (list as Record_[]) : [];
};
/** The id of the tablet's DYE2 record of the Recipe. */
const recordIdOf = (tablet: SimulatedTablet, recipeId: string) => String(recipeRecords(tablet).find((record) => dye2GlobalIdOf(record) === recipeId)!.id);
const pushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "reference");
const sentOf = (tablet: SimulatedTablet, type: string) => (tablet.sent as Record_[]).filter((frame) => frame.type === type);
const receivedOf = (tablet: SimulatedTablet, type: string) => (tablet.received as Record_[]).filter((frame) => frame.type === type);
const connectionPushes = (tablet: SimulatedTablet) => (tablet.pushes("changes") as Record_[]).filter((push) => push.what === "connection").map((push) => push.connected);

/** A Shot pulled at a UTC time on the hardware of that serial, derived from the fixture, its Workflow holding the profile given, if any, with the changes given. */
function shotOf(id: string, pulledAt: string, serial: string, profile?: Record_, changes: Record_ = {}): Record_ {
  const fixture = shotFixture();
  const workflow = fixture.workflow as Record_;
  return {
    ...fixture,
    id,
    timestamp: pulledAt,
    workflow: { ...workflow, ...(profile && { profile }), machine: { ...(workflow.machine as Record_), model: "DE1Pro", serialNumber: serial } },
    ...changes,
  };
}

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("A Recipe's Reference Shot on the tablets at its Location", { timeout: 180_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let belmont: LocationView;
  let lab: LocationView;
  let leftMachine: CreatedMachine;
  let rightMachine: CreatedMachine;
  let labMachine: CreatedMachine;
  let left: SimulatedTablet;
  let right: SimulatedTablet;
  let labTablet: SimulatedTablet;
  /** The Library's ids of the two Profiles the Lab's tablet saved. */
  let bloom: string;
  let other: string;
  /** The first of them, as a Shot's Workflow holds it. */
  let bloomProfile: Record_;
  /** Belmont's Recipes: its espresso on the bloom Profile in slot 1, its decaf naming none in slot 2, and its spare in no slot. */
  let espresso: string;
  let decaf: string;
  let spare: string;

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    belmont = await api.createLocation("Belmont", "America/Chicago");
    lab = await api.createLocation("Lab", "America/Denver");
    leftMachine = await api.createMachine("Belmont Left");
    rightMachine = await api.createMachine("Belmont Right");
    labMachine = await api.createMachine("Lab 1");
    // Each was at its Location long before its Shots were pulled.
    for (const [machine, location] of [[leftMachine, belmont], [rightMachine, belmont], [labMachine, lab]] as const) {
      await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    }
    left = tablets.syncing(leftMachine, server, { api: emptyLibrary(LEFT_SERIAL) });
    right = tablets.syncing(rightMachine, server, { api: emptyLibrary(RIGHT_SERIAL) });
    labTablet = tablets.syncing(labMachine, server, { api: emptyLibrary(LAB_SERIAL) });
    await api.waitForOnline(leftMachine, rightMachine, labMachine);

    // Two Profiles a Lab barista saved join the Library; a Shot's Workflow holds one as Decaid holds it.
    bloomProfile = (await labTablet.addProfile(derivedProfile("Reference bloom", 7.5))).profile as Record_;
    await labTablet.addProfile(derivedProfile("Other bloom", 8.5));
    const profileId = async (title: string) => (await api.get<{ profiles: { id: string; title: string }[] }>("/profiles")).profiles.find((p) => p.title === title)?.id;
    await until(async () => (await profileId("Reference bloom")) !== undefined && (await profileId("Other bloom")) !== undefined);
    bloom = (await profileId("Reference bloom"))!;
    other = (await profileId("Other bloom"))!;

    const fixture = shotFixture();
    // On the bloom Profile, rated and noted.
    left.pullShot(shotOf("ref-left-bloom", "2026-02-10T15:00:00Z", LEFT_SERIAL, bloomProfile, { annotations: { ...(fixture.annotations as Record_), enjoyment: 8, espressoNotes: "Sweet, a little thin" } }));
    // The fixture's own profile, which no tablet saved: it matches none in the Library.
    left.pullShot(shotOf("ref-left-unsaved", "2026-02-10T16:00:00Z", LEFT_SERIAL));
    // Larger than 1 MiB.
    right.pullShot(longShot("ref-right-long", { timestamp: "2026-02-10T17:00:00Z", workflow: shotOf("", "", RIGHT_SERIAL).workflow }));
    // Pulled at another Location.
    labTablet.pullShot(shotOf("ref-lab", "2026-02-10T18:00:00Z", LAB_SERIAL, bloomProfile));
    // On hardware no Machine has: a Pending Machine holds it.
    right.pullShot(shotOf("ref-pending", "2026-02-10T19:00:00Z", UNKNOWN_SERIAL));
    await until(async () => (await api.get<{ total: number }>("/shots?limit=1")).total === 5);

    const create = async (content: Record_, slot: "next" | null) =>
      (await api.send<{ recipe: { id: string } }>("POST", "/recipes", { locationId: belmont.id, slot, content }, 201)).recipe.id;
    espresso = await create({ name: "Belmont espresso", profileId: bloom, dose: 18, yield: 36 }, "next");
    decaf = await create({ name: "Belmont decaf", dose: 18, yield: 40 }, "next");
    spare = await create({ name: "Belmont spare", dose: 18, yield: 36 }, null);
    // Each of Belmont's tablets holds its Recipes in DYE2's list, each record carrying its Recipe's id.
    await until(() => [left, right].every((tablet) => recipeRecords(tablet).filter((record) => dye2GlobalIdOf(record) !== null).length === 3));
  });
  afterAll(async () => {
    await tablets.unloadAll();
    await server?.stop();
  });

  const choose = (recipeId: string, shotId: string | null) => api.send("PUT", `/recipes/${recipeId}/reference-shot`, { shotId });
  const place = (recipeId: string, slot: number | null) => api.send("PUT", `/recipes/${recipeId}/slot`, { slot });
  /** A Recipe as an answer names it for the tablet. */
  const named = (tablet: SimulatedTablet, recipeId: string, name: string): Recipe => ({ id: recipeId, name, recordId: recordIdOf(tablet, recipeId) });
  /** The Recipe's reference as the tablet's `reference` endpoint answers a Skin naming it by its record there. */
  const reference = (tablet: SimulatedTablet, recipeId: string) => call(tablet, "reference", { recipe: recordIdOf(tablet, recipeId) });

  it("answers that a Recipe has none before one is chosen, from the server, and keeps that for each Recipe in a slot", async () => {
    for (const tablet of [left, right]) {
      expect(await reference(tablet, espresso)).toEqual({ status: 200, body: { recipe: named(tablet, espresso, "Belmont espresso"), reference: null, source: "server" } });
      await expect.poll(() => [1, 2, 3].map((slot) => kept(tablet, slot))).toEqual([null, null, undefined]);
      expect(copy(tablet, 1)).toEqual({ version: expect.any(String), recipe: named(tablet, espresso, "Belmont espresso"), reference: null });
      expect(copy(tablet, 2)).toMatchObject({ recipe: named(tablet, decaf, "Belmont decaf") });
    }
    // Each plugin said what it held as it connected, nothing, and asks with the Recipe's own id, which its record carries.
    expect(sentOf(left, "referencesHeld")).toEqual([{ type: "referencesHeld", held: {} }]);
    expect(sentOf(left, "request").at(-1)).toEqual({ type: "request", id: expect.any(String), ask: "reference", recipeId: espresso });
    // The Lab has no Recipe in a slot: its tablet keeps nothing.
    expect([1, 2].map((slot) => kept(labTablet, slot))).toEqual([undefined, undefined]);
  });

  it("sends every tablet a copy of a reference chosen through REST, whole, replaces it when another is chosen and keeps none once it is cleared, pushing each change", async () => {
    const before = { changed: [left, right].map((tablet) => tablet.pushes("changed").length), pushes: pushes(right).length };
    await choose(espresso, "ref-left-bloom");
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("ref-left-bloom");

    // Whole, as the tablet's `shot` endpoint gives one of its Location's Shots, with its rating and note.
    const whole = await call(right, "shot", { id: "ref-left-bloom" });
    const answered = await reference(right, espresso);
    expect(answered).toEqual({
      status: 200,
      body: {
        recipe: named(right, espresso, "Belmont espresso"),
        reference: { shot: whole.body.shot, recipe: null, referenceOf: [named(right, espresso, "Belmont espresso")], rating: 8, note: "Sweet, a little thin", profileDiffers: false },
        source: "server",
      },
    });
    expect(((answered.body.reference as ReferenceShot).shot.measurements as unknown[]).length).toBe((shotFixture().measurements as unknown[]).length);
    // The tablet's copy is that answer, on the tablet that pulled it and on the one beside it.
    expect(copy(right, 1)).toEqual({ version: expect.any(String), recipe: answered.body.recipe, reference: answered.body.reference });
    expect(copy(left, 1)!.reference).toEqual({ ...(answered.body.reference as ReferenceShot), referenceOf: [named(left, espresso, "Belmont espresso")] });
    expect(pushes(right).slice(before.pushes)).toEqual([{ what: "reference", recipe: named(right, espresso, "Belmont espresso") }]);

    // Replaced by a Shot whose profile matches none in the Library: another than the Recipe's.
    await choose(espresso, "ref-left-unsaved");
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("ref-left-unsaved");
    expect(copy(right, 1)!.reference).toMatchObject({ rating: null, note: null, profileDiffers: true });
    expect((await reference(left, espresso)).body).toMatchObject({ reference: { shot: { id: "ref-left-unsaved" }, profileDiffers: true }, source: "server" });

    // Cleared: each tablet keeps that it has none.
    await choose(espresso, null);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBeNull();
    expect((await reference(right, espresso)).body).toMatchObject({ reference: null, source: "server" });
    expect(pushes(right).slice(before.pushes)).toEqual(Array.from({ length: 3 }, () => ({ what: "reference", recipe: named(right, espresso, "Belmont espresso") })));
    // Each change was announced once: three copies, of the slot that changed alone.
    expect(receivedOf(right, "referenceCopy").slice(-3).map((message) => message.slot)).toEqual([1, 1, 1]);
    // Nothing of it is on the endpoint Streamline listens on, which reads any push there as a change of the Workflow.
    expect([left, right].map((tablet) => tablet.pushes("changed").length)).toEqual(before.changed);
    // Nor in DYE2's recipe record.
    expect(recipeRecords(left).find((record) => dye2GlobalIdOf(record) === espresso)).not.toHaveProperty("referenceShotId");
  });

  it("sends the copy again when the Shot's rating and note change on its own tablet", async () => {
    await choose(espresso, "ref-left-bloom");
    await expect.poll(() => kept(right, 1)).toBe("ref-left-bloom");
    const version = copy(right, 1)!.version;
    // Edited on the tablet that pulled it, as Decaid reports an edit: its metadata without its curves.
    const { measurements: _, ...metadata } = shotOf("ref-left-bloom", "2026-02-10T15:00:00Z", LEFT_SERIAL, bloomProfile);
    left.fire("shotUpdated", {
      id: "ref-left-bloom",
      shot: { ...metadata, updatedAt: new Date().toISOString(), annotations: { ...(metadata.annotations as Record_), enjoyment: 9, espressoNotes: "Better than I thought" } },
    });
    for (const tablet of [left, right]) await expect.poll(() => copy(tablet, 1)!.reference).toMatchObject({ rating: 9, note: "Better than I thought" });
    expect(copy(right, 1)!.version).not.toBe(version);
    expect(copy(right, 1)!.reference!.shot).toMatchObject({ id: "ref-left-bloom", annotations: { enjoyment: 9, espressoNotes: "Better than I thought" } });
    expect((copy(right, 1)!.reference!.shot.measurements as unknown[]).length).toBe((shotFixture().measurements as unknown[]).length);
    expect((await reference(left, espresso)).body).toMatchObject({ reference: { rating: 9, note: "Better than I thought" }, source: "server" });
  });

  it("says whether the Reference Shot's Profile is the Recipe's, as the Recipe's REST read does, as the Recipe changes its Profile", async () => {
    const rest = async () => (await api.get<{ recipe: { referenceShot: { profileDiffers: boolean } } }>(`/recipes/${espresso}`)).recipe.referenceShot.profileDiffers;
    expect([await rest(), copy(left, 1)!.reference!.profileDiffers]).toEqual([false, false]);
    await api.send("PATCH", `/recipes/${espresso}`, { content: { profileId: other } });
    for (const tablet of [left, right]) await expect.poll(() => copy(tablet, 1)!.reference!.profileDiffers).toBe(true);
    expect([await rest(), (await reference(right, espresso)).body.reference]).toMatchObject([true, { profileDiffers: true }]);
    await api.send("PATCH", `/recipes/${espresso}`, { content: { profileId: bloom } });
    for (const tablet of [left, right]) await expect.poll(() => copy(tablet, 1)!.reference!.profileDiffers).toBe(false);
  });

  it("answers a Recipe in no slot from the server, keeps its copy once it enters a slot, in slot 7 too, and no longer once it leaves", async () => {
    // A Shot pulled at the Lab, the reference of a Belmont Recipe in no slot.
    await choose(spare, "ref-lab");
    const answered = await reference(left, spare);
    expect(answered.body).toMatchObject({ recipe: named(left, spare, "Belmont spare"), reference: { shot: { id: "ref-lab" }, referenceOf: [named(left, spare, "Belmont spare")] }, source: "server" });
    // A tablet reads whole a Shot of another Location as its Recipe's reference, and not otherwise.
    expect(((answered.body.reference as ReferenceShot).shot.measurements as unknown[]).length).toBe((shotFixture().measurements as unknown[]).length);
    expect(await call(left, "shot", { id: "ref-lab" })).toMatchObject({ status: 404, body: { code: "noSuchShot" } });

    await place(spare, 7);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 7)).toBe("ref-lab");
    expect(copy(right, 7)).toEqual({ version: expect.any(String), recipe: named(right, spare, "Belmont spare"), reference: { ...(answered.body.reference as ReferenceShot), referenceOf: [named(right, spare, "Belmont spare")] } });
    // The Lab's tablet, whose Location pulled the Shot, is sent nothing: the Recipe is Belmont's.
    expect(receivedOf(labTablet, "referenceCopy")).toEqual([]);

    // Moved to another slot, its copy moves with it.
    await place(spare, 3);
    for (const tablet of [left, right]) await expect.poll(() => [kept(tablet, 3), kept(tablet, 7)]).toEqual(["ref-lab", undefined]);
    await place(spare, null);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 3)).toBeUndefined();
    expect((await reference(right, spare)).body).toMatchObject({ reference: { shot: { id: "ref-lab" } }, source: "server" });
    // The slots the other Recipes are in were left as they were.
    expect([kept(right, 1), kept(right, 2)]).toEqual(["ref-left-bloom", null]);
  });

  it("keeps no copy of a Reference Shot too large for Decaid's store to take as one value, and reads it from the server", async () => {
    await choose(decaf, "ref-right-long");
    for (const tablet of [left, right]) await expect.poll(() => copy(tablet, 2)?.tooLarge).toBe(true);
    expect(copy(left, 2)).toEqual({ version: expect.any(String), recipe: named(left, decaf, "Belmont decaf"), tooLarge: true });
    // The Shot itself never crossed to the tablet as a copy.
    const sent = receivedOf(left, "referenceCopy").at(-1)!;
    expect(sent).toEqual({ type: "referenceCopy", id: expect.any(String), slot: 2, copy: copy(left, 2) });
    const answered = await reference(left, decaf);
    expect(answered).toMatchObject({ status: 200, body: { reference: { shot: { id: "ref-right-long" }, profileDiffers: false }, source: "server" } });
    expect(Buffer.byteLength(JSON.stringify(answered.body))).toBeGreaterThan(MAX_REFERENCE_COPY_BYTES);
    expect(pushes(left).at(-1)).toEqual({ what: "reference", recipe: named(left, decaf, "Belmont decaf") });
  });

  it("answers from the tablet's copy while the server can't be reached, saying so, and catches up when it reconnects", async () => {
    const live = await reference(right, espresso);
    right.loseNetwork();
    await expect.poll(() => connectionPushes(right).at(-1)).toBe(false);
    expect(await reference(right, espresso)).toEqual({ status: 200, body: { ...live.body, source: "tablet" } });
    // A Recipe in no slot, and one whose Reference Shot is too large to keep, can't be read.
    expect(await reference(right, spare)).toMatchObject({ status: 503, body: { code: "unreachable" } });
    expect(await reference(right, decaf)).toMatchObject({ status: 503, body: { code: "unreachable" } });

    // Chosen, and a Recipe put in a slot, while the tablet is off.
    await choose(espresso, "ref-left-unsaved");
    await place(spare, 4);
    await expect.poll(() => kept(left, 4)).toBe("ref-lab");
    expect([kept(right, 1), kept(right, 4)]).toEqual(["ref-left-bloom", undefined]);
    const held = Object.fromEntries([1, 2].map((slot) => [String(slot), copy(right, slot)!.version]));
    const copies = receivedOf(right, "referenceCopy").length;

    right.restoreNetwork();
    await expect.poll(() => [kept(right, 1), kept(right, 4)]).toEqual(["ref-left-unsaved", "ref-lab"]);
    // It said what it held as it reconnected, and was sent only what differed.
    expect(sentOf(right, "referencesHeld").at(-1)).toEqual({ type: "referencesHeld", held });
    expect(receivedOf(right, "referenceCopy").slice(copies).map((message) => message.slot).sort()).toEqual([1, 4]);
    expect((await reference(right, espresso)).body).toMatchObject({ reference: { shot: { id: "ref-left-unsaved" } }, source: "server" });
    await place(spare, null);
    await choose(espresso, "ref-left-bloom");
    for (const tablet of [left, right]) await expect.poll(() => [kept(tablet, 1), kept(tablet, 4)]).toEqual(["ref-left-bloom", undefined]);
  });

  it("reaches a tablet held by another instance, which answers from its copy once that instance has stopped", async () => {
    const machine = await api.createMachine("Belmont Third", belmont.id);
    const instance = await startTestServer({ env, sharing: server });
    const third = tablets.syncing(machine, instance, { api: emptyLibrary(51_004) });
    // Connecting, it is written Belmont's Recipes and sent its copies.
    await until(() => recipeRecords(third).filter((record) => dye2GlobalIdOf(record) !== null).length === 3);
    await expect.poll(() => [kept(third, 1), copy(third, 2)?.tooLarge]).toEqual(["ref-left-bloom", true]);

    // Chosen through the first instance.
    await choose(espresso, "ref-lab");
    await expect.poll(() => kept(third, 1)).toBe("ref-lab");
    const live = await reference(third, espresso);
    expect(live.body).toMatchObject({ recipe: named(third, espresso, "Belmont espresso"), reference: { shot: { id: "ref-lab" } }, source: "server" });

    await instance.stop();
    await expect.poll(() => connectionPushes(third).at(-1)).toBe(false);
    expect(await reference(third, espresso)).toEqual({ status: 200, body: { ...live.body, source: "tablet" } });
    expect(await reference(third, spare)).toMatchObject({ status: 503, body: { code: "unreachable", message: expect.stringContaining("can't be reached") } });
    await third.unload();
    await choose(espresso, "ref-left-bloom");
  });

  it("keeps none for a Reference Shot hidden with its Pending Machine, keeps it again once that hardware is adopted, and keeps nothing for a Recipe once Archived", async () => {
    // A Pending Machine's Shot is listed, and may be chosen, until it is dismissed.
    await choose(decaf, "ref-pending");
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 2)).toBe("ref-pending");
    const { pendingMachines } = await api.get<{ pendingMachines: { id: string; serial: string }[] }>("/pending-machines");
    const pending = pendingMachines.find((each) => each.serial === UNKNOWN_SERIAL)!;
    expect((await api.call("POST", `/pending-machines/${pending.id}/dismiss`)).status).toBe(200);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 2)).toBeNull();
    expect((await reference(left, decaf)).body).toMatchObject({ reference: null, source: "server" });
    // A machine entry made for the hardware takes its Shots, which are listed again: the Recipe reads its Reference Shot again.
    await api.send("POST", `/pending-machines/${pending.id}/machine`, { name: "Belmont adopted" }, 201);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 2)).toBe("ref-pending");
    expect((await reference(left, decaf)).body).toMatchObject({ reference: { shot: { id: "ref-pending" } }, source: "server" });
    await choose(decaf, null);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 2)).toBeNull();

    // Archived, a Recipe is in no slot: its copy goes, and comes back with it once restored and put in one.
    await api.send("PUT", `/recipes/${espresso}/archived`, { archived: true });
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBeUndefined();
    await api.send("PUT", `/recipes/${espresso}/archived`, { archived: false });
    await place(espresso, 1);
    for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("ref-left-bloom");
  });

  it("empties the copies of a tablet whose Machine is made Capture-only, which is refused as one, and sends them again once it takes part", async () => {
    await api.send("PUT", `/machines/${rightMachine.machine.id}/sharing`, { sharing: false });
    await expect.poll(() => [kept(right, 1), kept(right, 2)]).toEqual([undefined, undefined]);
    expect(await reference(right, espresso)).toMatchObject({ status: 409, body: { code: "captureOnly" } });
    expect(kept(left, 1)).toBe("ref-left-bloom");
    await api.send("PUT", `/machines/${rightMachine.machine.id}/sharing`, { sharing: true });
    await expect.poll(() => [kept(right, 1), kept(right, 2)]).toEqual(["ref-left-bloom", null]);
    await until(async () => (await reference(right, espresso)).status === 200);
  });

  it("refuses a record that is no Recipe of the Library's as no such Recipe, a request it can't read, and a method it doesn't take", async () => {
    const noSuchRecipe = { status: 404, body: { code: "noSuchRecipe", message: expect.stringContaining("Recipe") } };
    const asked = sentOf(left, "request").length;
    expect(await call(left, "reference", { recipe: "no-such-record" })).toEqual(noSuchRecipe);
    // A recipe a barista just saved in DYE2, which carries no Recipe's id yet. The tablet's own Recipes are named by their records' ids, never by the Library's.
    expect(await call(left, "reference", { recipe: espresso })).toEqual(noSuchRecipe);
    expect(await call(left, "reference")).toEqual({ status: 400, body: { code: "invalidRequest", message: expect.stringContaining("recipe") } });
    expect(await call(left, "reference", { recipe: "" })).toMatchObject({ status: 400, body: { code: "invalidRequest" } });
    // None of them was asked of the server.
    expect(sentOf(left, "request")).toHaveLength(asked);
    // A PUT chooses the Recipe's Reference Shot (#511, skin-reference-choices.test.ts).
    const post = await left.callEndpoint("reference", { method: "POST", query: { recipe: recordIdOf(left, espresso) } });
    expect([post.status, post.headers.Allow]).toEqual([405, "GET, PUT"]);
    // The Lab's tablet holds no record of a Belmont Recipe.
    expect(recipeRecords(labTablet).some((record) => dye2GlobalIdOf(record) === espresso)).toBe(false);
  });

  describe("requests and copies, with raw frames", () => {
    const of = (raw: RawConnection, type: string) => (raw.messages as Record_[]).filter((message) => message.type === type);

    it("refuses a Recipe of another Location, or of none, as no such Recipe, and a Capture-only connection as not served", async () => {
      const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Lab raw", lab.id)).token));
      raw.send({ type: "request", id: "theirs", ask: "reference", recipeId: espresso });
      await expect.poll(() => of(raw, "answer")).toEqual([{ type: "answer", id: "theirs", ask: "reference", refused: "noSuchRecipe" }]);
      // A Recipe the Library never held.
      raw.send({ type: "request", id: "none", ask: "reference", recipeId: "00000000-0000-4000-8000-000000000000" });
      await expect.poll(() => of(raw, "answer").at(-1)).toEqual({ type: "answer", id: "none", ask: "reference", refused: "noSuchRecipe" });
      await raw.close();

      const sharingOff = await api.createMachine("Belmont raw, sharing off", belmont.id);
      await api.send("PUT", `/machines/${sharingOff.machine.id}/sharing`, { sharing: false });
      const captureOnly = await RawConnection.welcomed(server.url, helloWith(sharingOff.token));
      captureOnly.send({ type: "request", id: "capture-only", ask: "reference", recipeId: espresso });
      await expect.poll(() => of(captureOnly, "answer")).toEqual([{ type: "answer", id: "capture-only", ask: "reference", refused: "captureOnly" }]);
      await captureOnly.close();
    });

    it("sends no copy before the plugin has said what it holds, then every slot that differs, and nothing for a slot held as it is", async () => {
      const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine("Belmont raw", belmont.id)).token));
      // A change is announced, and still nothing is sent.
      await choose(espresso, "ref-left-unsaved");
      await expect.poll(() => kept(left, 1)).toBe("ref-left-unsaved");
      expect(of(raw, "referenceCopy")).toEqual([]);

      // Holding slots 1 and 2 at versions that are not theirs, and slot 9, which has no Recipe.
      raw.send({ type: "referencesHeld", held: { "1": copy(left, 1)!.version.replace(/./g, "0"), "2": "stale", "9": "stale" } });
      await expect.poll(() => of(raw, "referenceCopy").length).toBe(3);
      const copies = Object.fromEntries(of(raw, "referenceCopy").map((message) => [message.slot, message.copy as Copy | null]));
      // This tablet holds no record of the Recipes, so they are named by none there, and its copies differ in that from the left one's.
      expect(copies).toEqual({
        1: { version: expect.any(String), recipe: { id: espresso, name: "Belmont espresso", recordId: null }, reference: expect.objectContaining({ shot: expect.objectContaining({ id: "ref-left-unsaved" }) }) },
        2: { version: expect.any(String), recipe: { id: decaf, name: "Belmont decaf", recordId: null }, reference: null },
        9: null,
      });
      // Said again with what it was sent, it is sent nothing more, nor is it for a change of another Location's Library.
      raw.send({ type: "referencesHeld", held: { "1": copies[1]!.version, "2": copies[2]!.version } });
      await api.send("POST", "/recipes", { locationId: lab.id, slot: "next", content: { name: "Lab espresso" } }, 201);
      await choose(espresso, "ref-left-bloom");
      await expect.poll(() => of(raw, "referenceCopy").length).toBe(4);
      expect(of(raw, "referenceCopy").at(-1)).toMatchObject({ slot: 1, copy: { reference: { shot: { id: "ref-left-bloom" } } } });
      // And nothing after it: the tablets beside it have their copies of the same change, so every look it woke has run.
      for (const tablet of [left, right]) await expect.poll(() => kept(tablet, 1)).toBe("ref-left-bloom");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(of(raw, "referenceCopy")).toHaveLength(4);
      await raw.close();
    });

    it("ends a connection whose statement names no slot, or a version that is none", async () => {
      for (const held of [{ "0": "version" }, { "10": "version" }, { "1": "" }, { "1": 5 }, { one: "version" }, []]) {
        const raw = await RawConnection.welcomed(server.url, helloWith((await api.createMachine(`Belmont raw ${JSON.stringify(held)}`, belmont.id)).token));
        raw.send({ type: "referencesHeld", held });
        expect((await raw.closed).code).toBe(4000);
        expect(raw.messages.at(-1)).toMatchObject({ type: "error", code: "protocol_error", message: expect.stringContaining("referencesHeld.held") });
      }
    });
  });

});
