import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { shotFixture } from "./support/shot-fixtures.js";
import { syncingTablet, emptyLibrary } from "./support/loaded-tablets.js";
import { type SimulatedTablet, de1ProOnDecaid090, derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #88: Profiles shown and hidden at
// Locations in the management interface, Archived and restored there, and
// hard-deleted by an Admin, reach the tablets that hold them, through the
// built plugin in simulated tablets, on two server instances sharing
// PostgreSQL. Serials are made up, from 22001.

type Record_ = Record<string, unknown>;

interface ProfileView {
  id: string;
  title: string | null;
  bundled: boolean;
  archived: boolean;
  shownAt: { location: LocationView; since: string }[];
  locations: { location: LocationView; shown: boolean; since: string }[];
}

interface VersionView {
  fields: Record_;
  location: LocationView | null;
  source: { machine: unknown; tabletId: string | null; account: { id: string } | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** One of Decaid's bundled Profiles, which every tablet on Decaid v0.8.7 has. */
const BUNDLED = "profile:990c28a4ecac8e5bf6ba";

describe("Profiles in the management interface", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  });
  afterAll(async () => {
    await other?.stop();
    await server?.stop();
  });

  /**
   * The built plugin on a tablet of the Machine, polling every 5 s (0.1 s
   * here), its Decaid's Library empty, or with Decaid's bundled Profiles.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    instance: TestServer = server,
    options: { bundled?: boolean; apiDelayMs?: (method: string, path: string) => number; stallUpload?: (frame: unknown) => boolean } = {},
  ): SimulatedTablet {
    const profiles = options.bundled ? (de1ProOnDecaid090()["/profiles"] as Record_[]).filter((record) => record.isDefault === true) : [];
    return syncingTablet(machine, instance, { api: { ...emptyLibrary(serial), "/profiles": profiles }, apiDelayMs: options.apiDelayMs, stallUpload: options.stallUpload });
  }

  /** A Location with a Machine for each serial, each tablet on one of the two instances in turn, every one online. */
  async function locationWith(name: string, serials: number[], options: { bundled?: boolean } = {}): Promise<{ location: LocationView; tablets: SimulatedTablet[] }> {
    const location = await api.createLocation(name, "America/Chicago");
    const loaded: SimulatedTablet[] = [];
    for (const [index, serial] of serials.entries()) {
      const machine = await api.createMachine(`${name} ${index + 1}`, location.id);
      loaded.push(load(machine, String(serial), index % 2 === 0 ? server : other, options));
      await api.waitForOnline(machine);
    }
    return { location, tablets: loaded };
  }

  const profilePath = (id: string) => `/profiles/${encodeURIComponent(id)}`;
  const viewProfile = async (id: string) => (await api.get<{ profile: ProfileView }>(profilePath(id))).profile;
  const show = (id: string, location: LocationView, shown: boolean, as: AdminApi = api) => as.call("PUT", `${profilePath(id)}/locations/${location.id}`, { shown });
  const archive = (id: string, archived: boolean, as: AdminApi = api) => as.call("PUT", `${profilePath(id)}/archived`, { archived });

  /** The tablet's record of the Profile's visibility, or undefined if it holds none. */
  const visibilityOn = (tablet: SimulatedTablet, id: unknown) => tablet.profiles().find((record) => record.id === id)?.visibility;

  /** Saves a Profile on a lab tablet, as a barista does, and resolves once the Library has it, shown at the lab only. */
  async function labProfile(tablet: SimulatedTablet, title: string, pressure: number): Promise<Record_> {
    const record = await tablet.addProfile(derivedProfile(title, pressure));
    await expect.poll(async () => (await api.call("GET", profilePath(String(record.id)))).status).toBe(200);
    return record;
  }

  /** A Shot pulled on the tablet with that serial, with a profile it executed, and the profile id a skin recorded, if any. */
  function shotWith(id: string, serial: string, profile: unknown, skinProfileId?: string): Record_ {
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const context = workflow.context as Record_;
    const extras = skinProfileId === undefined ? {} : { workflowSkin: { selectedProfileId: skinProfileId } };
    return {
      ...fixture,
      id,
      workflow: { ...workflow, profile, machine: { ...(workflow.machine as Record_), serialNumber: serial }, context: { ...context, extras } },
    };
  }

  it("writes a lab Profile shown at a cafe to the cafe's tablets, shown, and hides it on them alone when it is hidden there", async () => {
    const lab = await locationWith("Lab", [22001]);
    const uptown = await locationWith("Uptown", [22002, 22003]);
    const belmont = await locationWith("Belmont", [22004]);
    const record = await labProfile(lab.tablets[0]!, "Lab Bloom", 8.25);
    const id = String(record.id);
    expect((await viewProfile(id)).shownAt.map((here) => here.location.name)).toEqual(["Lab"]);
    for (const tablet of [...uptown.tablets, ...belmont.tablets]) expect(visibilityOn(tablet, id)).toBeUndefined();

    const shown = await show(id, uptown.location, true);
    expect(shown.status, await shown.clone().text()).toBe(200);
    expect(((await shown.json()) as { profile: ProfileView }).profile.shownAt.map((here) => here.location.name)).toEqual(["Lab", "Uptown"]);
    for (const tablet of uptown.tablets) await expect.poll(() => tablet.profiles().find((held) => held.id === id)).toMatchObject({ visibility: "visible", profile: { title: "Lab Bloom" } });
    await api.send("PUT", `${profilePath(id)}/locations/${belmont.location.id}`, { shown: true });
    await expect.poll(() => visibilityOn(belmont.tablets[0]!, id)).toBe("visible");

    const hidden = await show(id, uptown.location, false);
    expect(hidden.status).toBe(200);
    for (const tablet of uptown.tablets) await expect.poll(() => visibilityOn(tablet, id)).toBe("hidden");
    // Nowhere else: Belmont and the lab still show it.
    expect(visibilityOn(belmont.tablets[0]!, id)).toBe("visible");
    expect(visibilityOn(lab.tablets[0]!, id)).toBe("visible");
    const viewed = await viewProfile(id);
    expect(viewed.shownAt.map((here) => here.location.name)).toEqual(["Belmont", "Lab"]);
    expect(viewed.locations.map((here) => [here.location.name, here.shown])).toEqual([
      ["Belmont", true],
      ["Lab", true],
      ["Uptown", false],
    ]);
    // Each is a version of Uptown's state of it from the account.
    const { versions } = await api.get<{ versions: VersionView[] }>(`${profilePath(id)}/history`);
    const uptownVersions = versions.filter((version) => version.location?.id === uptown.location.id);
    expect(uptownVersions.map((version) => version.fields)).toEqual([{ shown: false }, { shown: true }]);
    expect(uptownVersions.every((version) => version.source.account !== null && version.source.tabletId === null)).toBe(true);
  });

  it("hides an Archived Profile on every tablet, and restoring it brings back each Location's shown state", async () => {
    const lab = await locationWith("Archive lab", [22011]);
    const cafe = await locationWith("Archive cafe", [22012, 22013]);
    const elsewhere = await locationWith("Archive other", [22014]);
    const record = await labProfile(lab.tablets[0]!, "Retired Bloom", 7.75);
    const id = String(record.id);
    expect((await show(id, cafe.location, true)).status).toBe(200);
    expect((await show(id, elsewhere.location, true)).status).toBe(200);
    await expect.poll(() => visibilityOn(elsewhere.tablets[0]!, id)).toBe("visible");
    expect((await show(id, elsewhere.location, false)).status).toBe(200);
    for (const tablet of cafe.tablets) await expect.poll(() => visibilityOn(tablet, id)).toBe("visible");
    await expect.poll(() => visibilityOn(elsewhere.tablets[0]!, id)).toBe("hidden");

    const archived = await archive(id, true);
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(((await archived.json()) as { profile: ProfileView }).profile).toMatchObject({ archived: true, shownAt: [] });
    for (const tablet of [...lab.tablets, ...cafe.tablets, ...elsewhere.tablets]) await expect.poll(() => visibilityOn(tablet, id)).toBe("hidden");
    // Each Location's state of it is kept, and Archiving it again changes nothing.
    expect((await viewProfile(id)).locations.map((here) => [here.location.name, here.shown])).toEqual([
      ["Archive cafe", true],
      ["Archive lab", true],
      ["Archive other", false],
    ]);
    expect((await archive(id, true)).status).toBe(200);

    const restored = await archive(id, false);
    expect(restored.status).toBe(200);
    for (const tablet of [...lab.tablets, ...cafe.tablets]) await expect.poll(() => visibilityOn(tablet, id)).toBe("visible");
    expect(visibilityOn(elsewhere.tablets[0]!, id)).toBe("hidden");
    expect((await viewProfile(id)).shownAt.map((here) => here.location.name)).toEqual(["Archive cafe", "Archive lab"]);
    const { versions } = await api.get<{ versions: VersionView[] }>(`${profilePath(id)}/history`);
    expect(versions.filter((version) => version.location === null && "archived" in version.fields).map((version) => version.fields)).toEqual([
      { archived: false },
      { archived: true },
    ]);
  });

  it("hard-deletes a Profile from every tablet that holds it, an offline one once it reconnects, but not one a Shot used or a bundled one", async () => {
    const lab = await locationWith("Delete lab", [22021], { bundled: true });
    const cafe = await locationWith("Delete cafe", [22022, 22023], { bundled: true });
    const [online, offline] = cafe.tablets as [SimulatedTablet, SimulatedTablet];
    const mistaken = await labProfile(lab.tablets[0]!, "Mistaken Bloom", 3.25);
    const used = await labProfile(lab.tablets[0]!, "Used Bloom", 3.5);
    const [mistakenId, usedId] = [String(mistaken.id), String(used.id)];
    for (const id of [mistakenId, usedId]) expect((await show(id, cafe.location, true)).status).toBe(200);
    for (const tablet of cafe.tablets) await expect.poll(() => visibilityOn(tablet, mistakenId)).toBe("visible");
    // A barista hides it on one tablet there, which hides it at the cafe.
    await online.setProfileVisibility(mistakenId, "deleted");
    await expect.poll(() => visibilityOn(offline, mistakenId)).toBe("hidden");

    // A Shot pulled at the lab with the other names it by its steps, though a skin set its target weight to the Shot's yield.
    const shot = shotWith("shot-used-bloom", "22021", { ...(used.profile as Record_), target_weight: 38 });
    lab.tablets[0]!.pullShot(shot);
    await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
    const refused = await api.call("DELETE", profilePath(usedId));
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/A Shot names this Profile/);
    // A Shot whose skin recorded a Profile's id names it, whatever steps it ran.
    const skinned = await labProfile(lab.tablets[0]!, "Skinned Bloom", 3.75);
    const skinShot = shotWith("shot-skinned-bloom", "22021", derivedProfile("Unsaved Bloom", 9.75), String(skinned.id));
    lab.tablets[0]!.pullShot(skinShot);
    await expect.poll(async () => (await api.call("GET", `/shots/${skinShot.id}`)).status).toBe(200);
    expect((await api.call("DELETE", profilePath(String(skinned.id)))).status).toBe(409);
    const bundled = await api.call("DELETE", profilePath(BUNDLED));
    expect(bundled.status).toBe(409);
    expect(await bundled.text()).toMatch(/bundled/);

    offline.loseNetwork();
    await api.send("DELETE", profilePath(mistakenId), undefined, 204);
    expect((await api.call("GET", profilePath(mistakenId))).status).toBe(404);
    for (const tablet of [lab.tablets[0]!, online]) await expect.poll(() => visibilityOn(tablet, mistakenId)).toBeUndefined();
    expect(online.writes).toContain(`DELETE /profiles/${encodeURIComponent(mistakenId)}/purge`);
    expect(offline.profiles().some((record) => record.id === mistakenId)).toBe(true);
    offline.restoreNetwork();
    await expect.poll(() => visibilityOn(offline, mistakenId)).toBeUndefined();
    // Nothing took it in again meanwhile.
    expect((await api.call("GET", profilePath(mistakenId))).status).toBe(404);
    for (const tablet of [lab.tablets[0]!, ...cafe.tablets]) {
      await expect.poll(() => visibilityOn(tablet, usedId)).toBe("visible");
      await expect.poll(() => visibilityOn(tablet, BUNDLED)).toBe("visible");
    }

    // A barista saving the same profile again later makes it anew, shown where it was saved.
    const again = await lab.tablets[0]!.addProfile(derivedProfile("Mistaken Bloom", 3.25));
    expect(again.id).toBe(mistakenId);
    await expect.poll(async () => (await api.call("GET", profilePath(mistakenId))).status).toBe(200);
    expect((await viewProfile(mistakenId)).shownAt.map((here) => here.location.name)).toEqual(["Delete lab"]);
    expect(visibilityOn(lab.tablets[0]!, mistakenId)).toBe("visible");
  });

  it("keeps on its tablet a Profile's record a Shot pulled offline used, though the server planned its delete first", async () => {
    const location = await api.createLocation("Unsent lab", "America/Chicago");
    const machine = await api.createMachine("Unsent lab 1", location.id);
    // Decaid is slow to read a Shot, so the plugin usually reads it only as it checks the delete.
    const tablet = load(machine, "22031", server, { apiDelayMs: (method, path) => (method === "GET" && path.startsWith("/shots/") ? 3_000 : 0) });
    await api.waitForOnline(machine);
    const record = await labProfile(tablet, "Unsent Bloom", 4.25);
    const id = String(record.id);

    // Pulled while the tablet is offline, the Shot reaches the server only after the delete. Either the plugin refuses the
    // delete, as the Shot is still to be sent, or the server, once it has the Shot, no longer asks for it.
    tablet.loseNetwork();
    const shot = shotWith("shot-with-unsent-bloom", "22031", record.profile);
    tablet.pullShot(shot);
    await api.send("DELETE", profilePath(id), undefined, 204);
    tablet.restoreNetwork();
    await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);
    // Kept on the tablet, out of the Library, as its Shot used it.
    expect(visibilityOn(tablet, id)).toBe("visible");
    expect(tablet.writes.filter((write) => write.startsWith("DELETE "))).toEqual([]);
    expect((await api.call("GET", profilePath(id))).status).toBe(404);

    // Saved again on another tablet there, it joins the Library again, and the record kept is that Profile's once more.
    const second = await api.createMachine("Unsent lab 2", location.id);
    const otherTablet = load(second, "22032", other);
    await api.waitForOnline(second);
    const requested = tablet.requests.length;
    await labProfile(otherTablet, "Unsent Bloom", 4.25);
    // Written the Profile again, which the plugin finds it holds, and which maps its record: until then, a barista's change to
    // the record is not taken as an edit.
    await expect.poll(() => tablet.requests.slice(requested).includes(`/profiles/${encodeURIComponent(id)}`)).toBe(true);
    await tablet.setProfileVisibility(id, "hidden");
    await expect.poll(async () => (await viewProfile(id)).locations.find((here) => here.location.id === location.id)?.shown).toBe(false);
    await expect.poll(() => visibilityOn(otherTablet, id)).toBe("hidden");
    expect(tablet.writes.filter((write) => write.startsWith("DELETE "))).toEqual([]);
  });

  it("deletes a Profile from a tablet whose answer to its write came only after the delete", async () => {
    const lab = await locationWith("Late lab", [22051]);
    const location = await api.createLocation("Late cafe", "America/Chicago");
    const machine = await api.createMachine("Late cafe 1", location.id);
    // Its answer to the write of the Profile waits in its outbox until it reconnects, after the delete.
    let holdingAnswers = true;
    const late = load(machine, "22052", other, {
      stallUpload: (frame) => holdingAnswers && (frame as { type?: unknown; kind?: unknown }).type === "written" && (frame as { kind?: unknown }).kind === "profile",
    });
    await api.waitForOnline(machine);
    const record = await labProfile(lab.tablets[0]!, "Late Bloom", 6.25);
    const id = String(record.id);
    expect((await show(id, location, true)).status).toBe(200);
    await expect.poll(() => visibilityOn(late, id)).toBe("visible");

    late.loseNetwork();
    holdingAnswers = false;
    await api.send("DELETE", profilePath(id), undefined, 204);
    await expect.poll(() => visibilityOn(lab.tablets[0]!, id)).toBeUndefined();
    late.restoreNetwork();
    // The answer is not recorded, as the Library no longer has the Profile, and the record it made is purged.
    await expect.poll(() => visibilityOn(late, id)).toBeUndefined();
    expect(late.writes).toContain(`DELETE /profiles/${encodeURIComponent(id)}/purge`);
    expect((await api.call("GET", profilePath(id))).status).toBe(404);
  });

  it("lets Staff show and hide Profiles only at their own Locations, Archive and restore them anywhere, and never hard-delete", async () => {
    const theirs = await api.createLocation("Profile staff home", "America/Chicago");
    const elsewhere = await locationWith("Profile staff elsewhere", [22041]);
    const staff = await api.staffAt("staff-88@example.com", theirs);
    const record = await labProfile(elsewhere.tablets[0]!, "Staff Bloom", 5.75);
    const id = String(record.id);

    expect((await show(id, theirs, true, staff)).status).toBe(200);
    expect((await show(id, theirs, false, staff)).status).toBe(200);
    expect((await show(id, elsewhere.location, false, staff)).status).toBe(403);
    expect((await show(id, elsewhere.location, true, staff)).status).toBe(403);
    expect(visibilityOn(elsewhere.tablets[0]!, id)).toBe("visible");
    expect((await archive(id, true, staff)).status).toBe(200);
    expect((await archive(id, false, staff)).status).toBe(200);
    expect((await staff.call("DELETE", profilePath(id))).status).toBe(403);
    expect((await viewProfile(id)).shownAt.map((here) => here.location.name)).toEqual(["Profile staff elsewhere"]);

    // Requests the server cannot read, or for what it does not have.
    expect((await api.call("PUT", `${profilePath(id)}/locations/${theirs.id}`, { shown: "yes" })).status).toBe(400);
    expect((await api.call("PUT", `${profilePath(id)}/locations/not-a-location`, { shown: true })).status).toBe(404);
    expect((await api.call("PUT", `${profilePath(id)}/locations/00000000-0000-4000-8000-000000000000`, { shown: true })).status).toBe(404);
    expect((await api.call("PUT", `${profilePath("profile:00000000000000000000")}/archived`, { archived: true })).status).toBe(404);
    expect((await api.call("PUT", `${profilePath("profile:00000000000000000000")}/locations/${theirs.id}`, { shown: true })).status).toBe(404);
    expect((await api.call("DELETE", profilePath("profile:00000000000000000000"))).status).toBe(404);
  });
});
