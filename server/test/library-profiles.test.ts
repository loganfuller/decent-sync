import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { SimulatedTablet, de1ProOnDecaid087, derivedDe1Pro, derivedProfile, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #82: Profiles shown per Location. A Profile keeps
// Decaid's id, a hash of what the machine executes, so it is the same
// Profile on every tablet (ADR-0006). One created on a tablet joins the
// Library shown at that tablet's Location only, and is written to the
// Location's other tablets; hiding, deleting or replacing one on a tablet
// hides it at that tablet's Location only, and hidden there it is hidden on
// the Location's tablets, never deleted (ADR-0008, ADR-0019). Through the
// built plugin in simulated tablets, on two server instances sharing one
// database, with assertions through the REST API and what each simulated
// tablet's Decaid holds. Serials are made up, from 17001.

interface ProfileSummary {
  id: string;
  title: string | null;
  bundled: boolean;
  archived: boolean;
  shownAt: { location: LocationView; since: string }[];
  createdLocation: LocationView | null;
}

interface ProfileView extends ProfileSummary {
  content: Record<string, unknown>;
  parent: { id: string; title: string | null } | null;
}

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** Decaid's bundled Profiles on the test tablet: every tablet on Decaid v0.8.7 has them. */
const bundled = () => (de1ProOnDecaid087()["/profiles"] as Record_[]).filter((record) => record.isDefault === true);
const BUNDLED = "profile:990c28a4ecac8e5bf6ba";

describe("Profiles shown per Location", { timeout: 60_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await other?.stop();
    await server?.stop();
  });

  /**
   * The built plugin on a tablet of the Machine, connected to an instance,
   * polling every 5 s (0.1 s here) unless given otherwise, its Decaid holding
   * its bundled Profiles and no others, as on a fresh install.
   */
  function load(machine: CreatedMachine, serial: string, instance: TestServer = server, pollSeconds = 5): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: instance.url }), PollSeconds: pollSeconds },
      api: { ...derivedDe1Pro({ serial }), "/beans": [], "/bean-batches": [], "/profiles": bundled() },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const libraryProfiles = async () => ((await (await api.call("GET", "/profiles")).json()) as { profiles: ProfileSummary[] }).profiles;
  const viewProfile = async (id: string) => ((await (await api.call("GET", `/profiles/${encodeURIComponent(id)}`)).json()) as { profile: ProfileView }).profile;
  /**
   * The Locations of a scenario showing the Profile, by name, once the
   * Library has it. Decaid's bundled Profiles are the same Library Profiles
   * in every scenario, so each looks only at its own Locations.
   */
  const shownAt = async (scenario: string, id: unknown) =>
    (await libraryProfiles())
      .find((profile) => profile.id === id)
      ?.shownAt.map((here) => here.location.name)
      .filter((name) => name.startsWith(`${scenario} `));

  /** The tablet's record of the Profile's visibility, or undefined if it holds none. */
  const visibilityOn = (tablet: SimulatedTablet, id: unknown) => tablet.profiles().find((record) => record.id === id)?.visibility;
  /** Resolves once the tablet holds the Profile with that visibility, or none if undefined. */
  async function holds(tablet: SimulatedTablet, id: unknown, visibility: string | undefined): Promise<void> {
    await expect.poll(() => visibilityOn(tablet, id), { timeout: 10_000 }).toBe(visibility);
  }
  const profileWrites = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write.includes("/profiles"));

  /** A lab with two tablets, the second on the other instance, and a cafe with two. */
  async function lab(name: string, serials: number) {
    const labLocation = await api.createLocation(`${name} lab`, "America/Chicago");
    const cafeLocation = await api.createLocation(`${name} cafe`, "America/Chicago");
    const machines = [
      await api.createMachine(`${name} lab 1`, labLocation.id),
      await api.createMachine(`${name} lab 2`, labLocation.id),
      await api.createMachine(`${name} cafe 1`, cafeLocation.id),
      await api.createMachine(`${name} cafe 2`, cafeLocation.id),
    ] as const;
    const one = load(machines[0], String(serials));
    const two = load(machines[1], String(serials + 1), other);
    const cafe = load(machines[2], String(serials + 2));
    const cafeTwo = load(machines[3], String(serials + 3), other);
    await online(...machines);
    // Each Location shows Decaid's bundled Profiles, as its first tablet reported them.
    await expect.poll(() => shownAt(name, BUNDLED), { timeout: 10_000 }).toEqual([`${name} cafe`, `${name} lab`]);
    return { labLocation, cafeLocation, machines, one, two, cafe, cafeTwo };
  }

  /** Saves a profile on the tablet, as a barista does, and resolves with its record once the Library shows it at the scenario's Locations named. */
  async function save(scenario: string, tablet: SimulatedTablet, profile: Record_, at: string[]): Promise<Record_> {
    const record = await tablet.addProfile(profile);
    await expect.poll(() => shownAt(scenario, record.id), { timeout: 10_000 }).toEqual(at.map((location) => `${scenario} ${location}`));
    return record;
  }

  it("writes a Profile created on a lab tablet to the lab's other tablet, through another instance, and to no cafe tablet", async () => {
    const { labLocation, one, two, cafe, cafeTwo } = await lab("Created", 17001);
    const record = await save("Created", one, derivedProfile("Lab Bloom", 8.5), ["lab"]);
    expect(await viewProfile(String(record.id))).toMatchObject({ title: "Lab Bloom", bundled: false, archived: false, createdLocation: labLocation, parent: null });

    await holds(two, record.id, "visible");
    expect(two.profiles().find((held) => held.id === record.id)).toMatchObject({ profile: record.profile, parentId: null, isDefault: false });
    expect(profileWrites(two)).toEqual(["POST /profiles"]);
    // The tablet that created it is written nothing: a Profile's records carry no global id.
    expect(profileWrites(one)).toEqual([]);
    // No cafe tablet holds it.
    expect(visibilityOn(cafe, record.id)).toBeUndefined();
    expect(visibilityOn(cafeTwo, record.id)).toBeUndefined();
    expect(profileWrites(cafe)).toEqual([]);
  });

  it("makes an identical Profile created on tablets at two Locations one Library Profile, shown at both", async () => {
    const { one, cafe, two, cafeTwo } = await lab("Identical", 17011);
    const atLab = await save("Identical", one, derivedProfile("House Bloom", 7.5), ["lab"]);
    // The cafe names it otherwise: a title is outside what Decaid hashes.
    const atCafe = await save("Identical", cafe, derivedProfile("Cafe House Bloom", 7.5), ["cafe", "lab"]);
    expect(atCafe.id).toBe(atLab.id);
    expect((await libraryProfiles()).filter((profile) => profile.id === atLab.id)).toHaveLength(1);
    await holds(two, atLab.id, "visible");
    await holds(cafeTwo, atLab.id, "visible");
  });

  it("makes a Profile whose steps change on a lab tablet a new Profile shown at the lab only, and hides the old one there while the cafe still shows it", async () => {
    const { one, two, cafe, cafeTwo } = await lab("Changed", 17021);
    const old = await save("Changed", one, derivedProfile("Dial In", 6), ["lab"]);
    await save("Changed", cafe, derivedProfile("Dial In", 6), ["cafe", "lab"]);
    await holds(two, old.id, "visible");

    // Streamline saves a profile whose steps changed as a new one, with the old as its parent, and hides the old.
    const changed = await one.addProfile(derivedProfile("Dial In", 6.25), { parentId: old.id });
    expect(changed.id).not.toBe(old.id);
    await expect.poll(() => shownAt("Changed", changed.id), { timeout: 10_000 }).toEqual(["Changed lab"]);
    await expect.poll(() => shownAt("Changed", old.id), { timeout: 10_000 }).toEqual(["Changed cafe"]);
    expect((await viewProfile(String(changed.id))).parent).toEqual({ id: old.id, title: "Dial In" });

    // The lab's other tablet holds the new one, under its parent, and the old one hidden, not deleted.
    await holds(two, changed.id, "visible");
    await holds(two, old.id, "hidden");
    expect(two.profiles().find((held) => held.id === changed.id)!.parentId).toBe(old.id);
    // The cafe's tablets keep the old one, and lack the new one.
    expect(visibilityOn(cafe, old.id)).toBe("visible");
    expect(visibilityOn(cafeTwo, old.id)).toBe("visible");
    expect(visibilityOn(cafeTwo, changed.id)).toBeUndefined();
    expect(two.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
  });

  it("hides a Profile hidden, deleted, replaced or purged on a cafe tablet at that cafe only, hiding it on the cafe's other tablet, never deleting it there", async () => {
    const { one, two, cafe, cafeTwo } = await lab("Removed", 17031);
    const pressures = { hidden: 5, deleted: 5.25, replaced: 5.5, purged: 5.75 } as const;
    const ids: Record<keyof typeof pressures, unknown> = { hidden: "", deleted: "", replaced: "", purged: "" };
    for (const [how, pressure] of Object.entries(pressures) as [keyof typeof pressures, number][]) {
      ids[how] = (await save("Removed", one, derivedProfile(`Removed ${how}`, pressure), ["lab"])).id;
      await save("Removed", cafe, derivedProfile(`Removed ${how}`, pressure), ["cafe", "lab"]);
      await holds(cafeTwo, ids[how], "visible");
    }

    await cafe.setProfileVisibility(ids.hidden, "hidden");
    // Decaid's delete marks a user's Profile deleted; its PUT with new steps replaces the record under another id; a purge removes it.
    expect((await cafe.callApi("DELETE", `/profiles/${encodeURIComponent(String(ids.deleted))}`)).status).toBe(200);
    const replacement = await cafe.editProfile(ids.replaced, derivedProfile("Removed replaced", 4.5));
    expect((await cafe.callApi("DELETE", `/profiles/${encodeURIComponent(String(ids.purged))}/purge`)).status).toBe(200);

    for (const id of Object.values(ids)) {
      await expect.poll(() => shownAt("Removed", id), { timeout: 10_000 }).toEqual(["Removed lab"]);
      await holds(cafeTwo, id, "hidden");
      expect(visibilityOn(one, id)).toBe("visible");
      expect(visibilityOn(two, id)).toBe("visible");
    }
    // The replacement is a new Profile, shown at the cafe only.
    await expect.poll(() => shownAt("Removed", replacement.id), { timeout: 10_000 }).toEqual(["Removed cafe"]);
    await holds(cafeTwo, replacement.id, "visible");
    // The tablet that removed them is not written them again, and nothing is deleted from the other.
    expect(visibilityOn(cafe, ids.deleted)).toBe("deleted");
    expect(visibilityOn(cafe, ids.purged)).toBeUndefined();
    expect(profileWrites(cafe).filter((write) => write.startsWith("POST"))).toEqual([]);
    expect(cafeTwo.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
  });

  it("hides a bundled Profile hidden on one tablet on the Location's other tablets only, and shows it there again once made visible", async () => {
    const { one, two, cafe, cafeTwo } = await lab("Bundled", 17041);
    await one.setProfileVisibility(BUNDLED, "hidden");
    await expect.poll(() => shownAt("Bundled", BUNDLED), { timeout: 10_000 }).toEqual(["Bundled cafe"]);
    await holds(two, BUNDLED, "hidden");
    expect(visibilityOn(cafe, BUNDLED)).toBe("visible");
    expect(visibilityOn(cafeTwo, BUNDLED)).toBe("visible");
    expect((await libraryProfiles()).find((profile) => profile.id === BUNDLED)).toMatchObject({ bundled: true, archived: false });

    // Made visible on another tablet, it is shown again; deleted on one, Decaid hides a bundled one.
    await two.setProfileVisibility(BUNDLED, "visible");
    await expect.poll(() => shownAt("Bundled", BUNDLED), { timeout: 10_000 }).toEqual(["Bundled cafe", "Bundled lab"]);
    await holds(one, BUNDLED, "visible");
    expect((await cafe.callApi("DELETE", `/profiles/${encodeURIComponent(BUNDLED)}`)).status).toBe(200);
    await holds(cafeTwo, BUNDLED, "hidden");
    await expect.poll(() => shownAt("Bundled", BUNDLED), { timeout: 10_000 }).toEqual(["Bundled lab"]);
  });

  it("shows a Profile its Location shows that a tablet holds hidden but has not reported, setting its visibility rather than creating it", async () => {
    const location = await api.createLocation("Held lab", "America/Chicago");
    const first = await api.createMachine("Held 1", location.id);
    const second = await api.createMachine("Held 2", location.id);
    const one = load(first, "17061");
    // Polls once an hour (every 72 s here), so what is entered on it is not reported within the test.
    const slow = load(second, "17062", server, 3600);
    await online(first, second);
    await expect.poll(() => slow.sent.some((frame) => (frame as { name?: unknown }).name === "profiles"), { timeout: 10_000 }).toBe(true);
    const entered = await slow.addProfile(derivedProfile("Held Bloom", 9.25));
    await slow.setProfileVisibility(entered.id, "hidden");

    await save("Held", one, derivedProfile("Held Bloom", 9.25), ["lab"]);
    await holds(slow, entered.id, "visible");
    expect(profileWrites(slow)).toEqual([`PUT /profiles/${encodeURIComponent(String(entered.id))}/visibility`]);
  });

  it("writes a new tablet at the lab what the lab shows, keeping hidden there what the lab hid, without a parent the tablet lacks", async () => {
    const { labLocation, one, two } = await lab("Joined", 17051);
    await one.setProfileVisibility(BUNDLED, "hidden");
    const old = await save("Joined", one, derivedProfile("Joined Bloom", 8), ["lab"]);
    const changed = await one.addProfile(derivedProfile("Joined Bloom", 8.25), { parentId: old.id });
    await expect.poll(() => shownAt("Joined", old.id), { timeout: 10_000 }).toEqual([]);
    await holds(two, changed.id, "visible");

    // A third tablet joins the lab with Decaid's bundled Profiles, all visible.
    const third = await api.createMachine("Joined lab 3", labLocation.id);
    const three = load(third, "17055");
    await online(third);
    await holds(three, BUNDLED, "hidden");
    await holds(three, changed.id, "visible");
    // It lacks the Profile the new one was saved from, which the lab hides, so Decaid is not asked for that parent.
    expect(visibilityOn(three, old.id)).toBeUndefined();
    expect(three.profiles().find((held) => held.id === changed.id)!.parentId).toBeNull();
    expect(await shownAt("Joined", BUNDLED)).toEqual(["Joined cafe"]);
    expect(await shownAt("Joined", changed.id)).toEqual(["Joined lab"]);
  });
});
