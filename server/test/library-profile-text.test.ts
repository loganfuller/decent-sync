import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, acceptInvite } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type SimulatedTablet, type SimulatedTabletOptions, de1ProOnDecaid092, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The REST API for ticket #576: a Profile's title, author and notes edited
// in the management interface, merged per field with tablets' edits
// (ADR-0020), listed in its history with who made the edit, and written to
// every tablet that holds it, through the built plugin in simulated tablets,
// on two server instances sharing PostgreSQL. A bundled Profile's are
// refused. A tablet's answer to a write that reaches the server only after a
// reconnect is judged against the Profile as it stood when the write's content
// was decided (#629). Serials are made up, from 57601.

type Record_ = Record<string, unknown>;

interface ProfileView {
  id: string;
  title: string | null;
  author: string | null;
  bundled: boolean;
  profile: { title: string; author: string; notes: string; steps: unknown[] } | null;
}

interface VersionView {
  fields: Record_;
  source: { machine: { id: string } | null; tabletId: string | null; account: { id: string; name: string } | null };
}

interface ConflictView {
  item: { kind: string; id: string };
  field: string;
  value: unknown;
  current: { value: unknown };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Profile's title, author and notes edited in the management interface", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let otherApi: AdminApi;
  let adminId: string;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    otherApi = api.at(other.url);
    adminId = (await api.get<{ account: { id: string } }>("/session")).account.id;
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** How a cafe's tablet is loaded: its Decaid's clock, and frames of the plugin's held back from the server. */
  type CafeOptions = Pick<SimulatedTabletOptions, "decaidClockOffsetMs" | "stallUpload">;

  /** The built plugin on a tablet of the Machine, its Decaid's Library empty, or with Decaid's bundled Profiles. */
  function load(machine: CreatedMachine, serial: string, instance: TestServer, options: { bundled?: boolean } & CafeOptions = {}): SimulatedTablet {
    const { bundled, ...rest } = options;
    const profiles = bundled ? (de1ProOnDecaid092()["/profiles"] as Record_[]).filter((record) => record.isDefault === true) : [];
    return syncingTablet(machine, instance, { api: { ...emptyLibrary(serial), "/profiles": profiles }, ...rest });
  }

  /** A lab and a cafe, each with a Machine whose tablet is online, the lab's on one instance and the cafe's on the other. */
  async function labAndCafe(name: string, serial: number, options: { bundled?: boolean; cafe?: CafeOptions } = {}) {
    const lab = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafe = await api.createLocation(`${name} cafe`, "America/Chicago");
    const labMachine = await api.createMachine(`${name} lab 1`, lab.id);
    const cafeMachine = await api.createMachine(`${name} cafe 1`, cafe.id);
    const labTablet = load(labMachine, String(serial), server, { bundled: options.bundled });
    const cafeTablet = load(cafeMachine, String(serial + 1), other, { bundled: options.bundled, ...options.cafe });
    await api.waitForOnline(labMachine, cafeMachine);
    return { lab, cafe, cafeMachine, labTablet, cafeTablet };
  }

  const profilePath = (id: string) => `/profiles/${encodeURIComponent(id)}`;
  const viewProfile = async (id: string) => (await api.get<{ profile: ProfileView }>(profilePath(id))).profile;
  const edit = (id: string, content: Record_, as: AdminApi = api) => as.call("PATCH", profilePath(id), { content });
  const history = async (id: string) => (await api.get<{ versions: VersionView[] }>(`${profilePath(id)}/history`)).versions;
  const conflictsOf = async (id: string) => (await api.get<{ conflicts: ConflictView[] }>("/conflicts")).conflicts.filter((conflict) => conflict.item.id === id);
  const show = (id: string, location: LocationView) => api.send("PUT", `${profilePath(id)}/locations/${location.id}`, { shown: true });

  /** The tablet's record of the Profile's `profile`, or undefined if it holds none. */
  const heldOn = (tablet: SimulatedTablet, id: unknown) => tablet.profiles().find((record) => record.id === id)?.profile as Record_ | undefined;
  const textOn = (tablet: SimulatedTablet, id: unknown) => {
    const held = heldOn(tablet, id);
    return held && { title: held.title, author: held.author, notes: held.notes };
  };

  /** Saves a Profile on the lab's tablet, as a barista does, shows it at the cafe, and resolves once the cafe's tablet holds it. */
  async function sharedProfile(labTablet: SimulatedTablet, cafeTablet: SimulatedTablet, cafe: LocationView, title: string, pressure: number): Promise<string> {
    const record = await labTablet.addProfile({ ...derivedProfile(title, pressure), author: "Lab", notes: "First notes" });
    const id = String(record.id);
    await expect.poll(async () => (await api.call("GET", profilePath(id))).status).toBe(200);
    await show(id, cafe);
    await expect.poll(() => textOn(cafeTablet, id)).toEqual({ title, author: "Lab", notes: "First notes" });
    return id;
  }

  /**
   * Resolves once the server has stored the tablet's answer to the Profile's write, which its Machine's sharing status
   * shows: the gateway records a write applied only after storing its answer.
   */
  async function answerStored(machine: CreatedMachine, id: string): Promise<void> {
    const status = async () =>
      (await api.get<{ status: { waiting: number | null; lastApplied: Record_ | null } }>(`/machines/${machine.machine.id}/sharing-status`)).status;
    await expect.poll(status, { timeout: 15_000 }).toMatchObject({ waiting: 0, lastApplied: { change: "write", kind: "profile", item: { id } } });
  }

  it("writes the edit to every tablet that holds the Profile, at every Location, keeping its id, as one edit in its history from the account", async () => {
    const { cafe, labTablet, cafeTablet } = await labAndCafe("Text", 57601);
    const id = await sharedProfile(labTablet, cafeTablet, cafe, "Text Bloom", 6.25);
    const steps = heldOn(labTablet, id)!.steps;

    const response = await edit(id, { title: "Text Bloom v2", author: "Coffee lead", notes: "Longer bloom, then 6 bar." });
    expect(response.status, await response.clone().text()).toBe(200);
    const view = ((await response.json()) as { profile: ProfileView }).profile;
    expect(view).toMatchObject({ id, title: "Text Bloom v2", author: "Coffee lead", profile: { title: "Text Bloom v2", author: "Coffee lead", notes: "Longer bloom, then 6 bar." } });
    expect(view.profile!.steps).toEqual(steps);

    const edited = { title: "Text Bloom v2", author: "Coffee lead", notes: "Longer bloom, then 6 bar." };
    for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id), { timeout: 15_000 }).toEqual(edited);
    // Still one Profile under the same id, its steps as they were, on every tablet.
    for (const tablet of [labTablet, cafeTablet]) {
      expect(tablet.profiles().filter((record) => (record.profile as Record_).title === "Text Bloom v2").map((record) => record.id)).toEqual([id]);
      expect(heldOn(tablet, id)!.steps).toEqual(steps);
    }
    // Read through the other instance as through the first.
    expect((await otherApi.get<{ profile: ProfileView }>(profilePath(id))).profile).toMatchObject({ title: "Text Bloom v2", profile: edited });

    const [latest] = await history(id);
    expect(latest!.fields).toEqual(edited);
    expect(latest!.source).toMatchObject({ machine: null, tabletId: null, account: { id: adminId } });
    expect(await conflictsOf(id)).toEqual([]);
  });

  it("merges it per field with a tablet's own edit, and keeps a tablet's earlier edit of the same field that arrives later as a Conflict", async () => {
    const { cafe, cafeMachine, labTablet, cafeTablet } = await labAndCafe("Merge", 57611);
    const id = await sharedProfile(labTablet, cafeTablet, cafe, "Merge Bloom", 7.25);
    await answerStored(cafeMachine, id);

    // The cafe, offline, changes the notes on its tablet while the title is edited here, its report reaching the server
    // after the edit: each field keeps its own edit.
    cafeTablet.loseNetwork();
    await cafeTablet.editProfile(id, { ...heldOn(cafeTablet, id)!, notes: "Cafe notes" });
    await delay(1000);
    expect((await edit(id, { title: "Merge Bloom v2" })).status).toBe(200);
    cafeTablet.restoreNetwork();
    const merged = { title: "Merge Bloom v2", author: "Lab", notes: "Cafe notes" };
    for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id), { timeout: 15_000 }).toEqual(merged);

    // The lab, offline, retitles it before the edit here, which reaches the server first: the lab's earlier title loses,
    // is kept as a Conflict, and the lab is written the Library's.
    labTablet.loseNetwork();
    await labTablet.editProfile(id, { ...heldOn(labTablet, id)!, title: "Lab title" });
    // Well before the edit here: the tablet's clock and PostgreSQL's may differ by tens of milliseconds (AI_BUILD_NOTES.md).
    await delay(1000);
    expect((await edit(id, { title: "Merge Bloom v3" })).status).toBe(200);
    labTablet.restoreNetwork();
    await expect.poll(async () => (await conflictsOf(id)).map(({ field, value }) => ({ field, value })), { timeout: 15_000 }).toEqual([{ field: "title", value: "Lab title" }]);
    for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id)?.title, { timeout: 15_000 }).toBe("Merge Bloom v3");
    expect((await viewProfile(id)).profile).toMatchObject({ title: "Merge Bloom v3", author: "Lab", notes: "Cafe notes" });
  });

  for (const { clock, offsetMs, serial, pressure } of [
    { clock: "", offsetMs: 0, serial: 57651, pressure: 6.75 },
    { clock: ", and applies its next edit timed before an edit it had seen", offsetMs: -10 * 60_000, serial: 57661, pressure: 6.5 },
  ]) {
    it(`counts a tablet's answer that reached the server only after a reconnect as having seen what its write carried, though a field was edited since${clock}`, async () => {
      // The cafe's answers to writes wait in its outbox while held, until it reconnects: answers to no write awaited
      // then. With its Decaid's clock slow, its edits are timed before the lab's.
      let holding = true;
      const stallUpload = (frame: unknown) => holding && (frame as { type?: unknown }).type === "written";
      const { cafe, labTablet, cafeTablet } = await labAndCafe(`Late ${serial}`, serial, { cafe: { stallUpload, decaidClockOffsetMs: offsetMs } });
      const id = await sharedProfile(labTablet, cafeTablet, cafe, `Late Bloom ${serial}`, pressure);

      // Its Wi-Fi drops before its answer to the Profile's write is sent; the title is edited here meanwhile, then its
      // barista changes the notes it was written.
      cafeTablet.loseNetwork();
      holding = false;
      expect((await edit(id, { title: `Late Bloom ${serial} v2` })).status).toBe(200);
      await delay(1000);
      await cafeTablet.editProfile(id, { ...heldOn(cafeTablet, id)!, notes: "Cafe notes" });
      cafeTablet.restoreNetwork();
      const merged = { title: `Late Bloom ${serial} v2`, author: "Lab", notes: "Cafe notes" };
      for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id), { timeout: 15_000 }).toEqual(merged);
      expect((await viewProfile(id)).profile).toMatchObject(merged);
      expect((await conflictsOf(id)).map(({ field, value }) => ({ field, value }))).toEqual([]);
    });
  }

  it("clears an author or notes as Decaid holds none, empty, and refuses a title cleared or another Profile's, a field it does not set, and a bundled Profile's", async () => {
    const { cafe, labTablet, cafeTablet } = await labAndCafe("Refusals", 57621, { bundled: true });
    const id = await sharedProfile(labTablet, cafeTablet, cafe, "Refused Bloom", 5.25);

    expect((await edit(id, { author: null, notes: "" })).status).toBe(200);
    for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id), { timeout: 15_000 }).toEqual({ title: "Refused Bloom", author: "", notes: "" });
    expect((await viewProfile(id)).profile).toMatchObject({ author: "", notes: "" });

    const refusal = async (content: Record_, status: number) => {
      const response = await edit(id, content);
      expect(response.status).toBe(status);
      return ((await response.json()) as { message: unknown }).message;
    };
    expect(await refusal({ title: "" }, 400)).toEqual(["title cannot be empty"]);
    expect(await refusal({ title: "  " }, 400)).toEqual(["title must be text"]);
    expect(await refusal({ steps: [] }, 400)).toEqual(["steps is not a field this can set"]);
    expect(await refusal({ notes: 4 }, 400)).toEqual(["notes must be text"]);
    expect(await refusal({}, 400)).toBe("Send the fields to change as content, each by Decaid's name for it");

    const bundled = (de1ProOnDecaid092()["/profiles"] as Record_[]).find((record) => record.isDefault === true)!;
    const bundledId = String(bundled.id);
    await expect.poll(async () => (await api.call("GET", profilePath(bundledId))).status).toBe(200);
    // Another Profile's title, whatever its case and spaces, as Streamline finds a tablet's record by title; its own, recased, is fine.
    const bundledTitle = String((bundled.profile as Record_).title);
    expect(await refusal({ title: `\t${bundledTitle.toUpperCase()} ` }, 409)).toBe(`A Profile in the Library is titled "${bundledTitle}" already`);
    // An Archived Profile's too, which tablets keep hidden.
    const archivedId = String((await labTablet.addProfile(derivedProfile("Retired Bloom", 5.75))).id);
    await expect.poll(async () => (await api.call("GET", profilePath(archivedId))).status).toBe(200);
    await api.send("PUT", `${profilePath(archivedId)}/archived`, { archived: true });
    expect(await refusal({ title: "retired bloom" }, 409)).toBe('A Profile in the Library is titled "Retired Bloom" already');
    expect((await edit(id, { title: "REFUSED BLOOM" })).status).toBe(200);
    await expect.poll(() => textOn(labTablet, id)?.title, { timeout: 15_000 }).toBe("REFUSED BLOOM");
    expect((await edit(id, { title: "Refused Bloom" })).status).toBe(200);
    await expect.poll(() => textOn(labTablet, id)?.title, { timeout: 15_000 }).toBe("Refused Bloom");
    const versions = (await history(bundledId)).length;
    const response = await edit(bundledId, { title: "Renamed" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toBe("Decaid's bundled Profiles keep the title, author and notes Decaid gives them");
    expect((await viewProfile(bundledId)).title).toBe((bundled.profile as Record_).title);
    expect((await history(bundledId)).length).toBe(versions);
    expect((await edit("profile:00000000000000000000", { title: "None" })).status).toBe(404);
    expect(textOn(labTablet, id)).toEqual({ title: "Refused Bloom", author: "", notes: "" });

    // Retitled on the tablet as a bundled Profile is, which the Library takes in as it is: the title sent again as it is,
    // with other fields, as an assistant may send it, is no reason to refuse them.
    await labTablet.editProfile(id, { ...heldOn(labTablet, id)!, title: bundledTitle });
    await expect.poll(async () => (await viewProfile(id)).title, { timeout: 15_000 }).toBe(bundledTitle);
    expect((await edit(id, { title: bundledTitle, notes: "Kept" })).status).toBe(200);
    expect((await viewProfile(id)).profile).toMatchObject({ title: bundledTitle, notes: "Kept" });
  });

  it("leaves a tablet's record as it is, refused, where the profile sent would hash to another id, which Decaid would replace it with", async () => {
    const lab = await api.createLocation("Negative zero lab", "America/Chicago");
    const machine = await api.createMachine("Negative zero lab 1", lab.id);
    const tablet = load(machine, "57641", server);
    await api.waitForOnline(machine);
    // A tank temperature of -0.0, which Decaid hashes as written and JSON carries to it as 0: written as text, so it stays -0.0.
    const text = JSON.stringify({ profile: { ...derivedProfile("Zero Bloom", 3.25), tank_temperature: 1234.5, notes: "First notes" } }).replace("1234.5", "-0.0");
    const { status, body } = await tablet.callApiWithText("POST", "/profiles", text);
    expect(status).toBe(201);
    const id = String((body as Record_).id);
    await expect.poll(async () => (await api.call("GET", profilePath(id))).status).toBe(200);

    expect((await edit(id, { notes: "Zero notes" })).status).toBe(200);
    const refusals = async () =>
      (await api.get<{ status: { refused: { item: { id: string } | null; error: string }[] } }>(`/machines/${machine.machine.id}/sharing-status`)).status.refused.filter(
        (refused) => refused.item?.id === id,
      );
    await expect.poll(async () => (await refusals()).map((refused) => refused.error), { timeout: 15_000 }).toEqual(["The profile as sent would hash to another id, which Decaid would replace this Profile with"]);
    // The tablet still holds the Profile under its id, and nothing under another.
    expect(tablet.profiles().map((record) => record.id)).toEqual([id]);
    expect(heldOn(tablet, id)).toMatchObject({ title: "Zero Bloom", notes: "First notes" });
  });

  it("lets Staff edit any Profile's, wherever it is shown, and refuses a Viewer", async () => {
    const { cafe, labTablet, cafeTablet } = await labAndCafe("Staff text", 57631);
    const id = await sharedProfile(labTablet, cafeTablet, cafe, "Staff Bloom", 4.25);
    const elsewhere = await api.createLocation("Staff text elsewhere", "America/Chicago");
    const staff = await api.staffAt("staff-576@example.com", elsewhere);
    expect((await edit(id, { notes: "Staff notes" }, staff)).status).toBe(200);
    for (const tablet of [labTablet, cafeTablet]) await expect.poll(() => textOn(tablet, id)?.notes, { timeout: 15_000 }).toBe("Staff notes");
    expect((await history(id))[0]!.source.account).toMatchObject({ name: "Staff" });

    const { link } = await api.invite("viewer-576@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Viewer", password: "viewer password 1" }));
    expect((await edit(id, { notes: "Viewer notes" }, viewer)).status).toBe(403);
    expect((await viewProfile(id)).profile?.notes).toBe("Staff notes");
  });
});
