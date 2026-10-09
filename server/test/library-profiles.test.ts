import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { RawConnection, SimulatedTablet, de1ProOnDecaid087, derivedDe1Pro, derivedProfile, helloWith, settingsFor } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #82: Profiles shown per Location. A Profile keeps
// Decaid's id, a hash of what the machine executes, so it is the same
// Profile on every tablet (ADR-0006). One created on a tablet joins the
// Library shown at that tablet's Location only, and is written to the
// Location's other tablets; hiding, deleting or replacing one on a tablet
// hides it at that tablet's Location only, and hidden there it is hidden on
// the Location's tablets, never deleted (ADR-0008, ADR-0019). Through the
// built plugin in simulated tablets, and raw frames where a test sets when a
// tablet's edits are reported, on two server instances sharing one
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
const BUNDLED_HIDDEN = "profile:729d284747718d27c93a";

describe("Profiles shown per Location", { timeout: 60_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  const tablets: SimulatedTablet[] = [];
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
  }, 60_000);
  afterAll(async () => {
    await Promise.all(tablets.map((tablet) => tablet.unload()));
    await Promise.all(raws.map((raw) => raw.terminate()));
    await other?.stop();
    await server?.stop();
  });

  /**
   * The built plugin on a tablet of the Machine, connected to an instance,
   * polling every 5 s (0.1 s here) unless given otherwise, its Decaid holding
   * its bundled Profiles and no others, as on a fresh install.
   */
  function load(
    machine: CreatedMachine,
    serial: string,
    options: { instance?: TestServer; pollSeconds?: number; decaidClockOffsetMs?: number; stallUpload?: (frame: unknown) => boolean } = {},
  ): SimulatedTablet {
    const tablet = SimulatedTablet.load({
      decaidClockOffsetMs: options.decaidClockOffsetMs,
      stallUpload: options.stallUpload,
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: options.pollSeconds ?? 5 },
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
    const two = load(machines[1], String(serials + 1), { instance: other });
    const cafe = load(machines[2], String(serials + 2));
    const cafeTwo = load(machines[3], String(serials + 3), { instance: other });
    await online(...machines);
    // Each Location shows Decaid's bundled Profiles, as its first tablet reported them.
    await expect.poll(() => shownAt(name, BUNDLED), { timeout: 10_000 }).toEqual([`${name} cafe`, `${name} lab`]);
    return { labLocation, cafeLocation, machines, one, two, cafe, cafeTwo };
  }

  /**
   * A tablet of the Machine sending raw frames, which reports its profiles
   * only as a test gives them: a record of the Profile with that id, shown,
   * hidden or deleted as of each time given, or none once it is gone. It
   * reports no beans, so nothing is written to it.
   */
  async function rawTablet(machine: CreatedMachine, serial: string, instance = server) {
    const raw = await RawConnection.welcomed(instance.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial } }));
    raws.push(raw);
    return {
      report: (id: string, state: boolean | "deleted" | "gone", at: Date) => {
        const visibility = state === "deleted" ? "deleted" : state ? "visible" : "hidden";
        const held = state === "gone" ? [] : [{ id, profile: derivedProfile("Raw Bloom", 2.75), visibility, isDefault: false, updatedAt: at.toISOString() }];
        return raw.deliver({ type: "collection", id: randomUUID(), name: "profiles", available: true, value: held, updatedAt: held.map(() => at.toISOString()) });
      },
    };
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
    const slow = load(second, "17062", { pollSeconds: 3600 });
    await online(first, second);
    await expect.poll(() => slow.sent.some((frame) => (frame as { name?: unknown }).name === "profiles"), { timeout: 10_000 }).toBe(true);
    const entered = await slow.addProfile(derivedProfile("Held Bloom", 9.25));
    await slow.setProfileVisibility(entered.id, "hidden");

    await save("Held", one, derivedProfile("Held Bloom", 9.25), ["lab"]);
    await holds(slow, entered.id, "visible");
    expect(profileWrites(slow)).toEqual([`PUT /profiles/${encodeURIComponent(String(entered.id))}/visibility`]);
  });

  it("shows a Profile again at the lab once a tablet there gets it back by changing its steps back, as an edit made after the lab hid it", async () => {
    const { one, two } = await lab("Reverted", 17071);
    const first = await save("Reverted", one, derivedProfile("Reverted Bloom", 3), ["lab"]);
    // Decaid's PUT with new steps replaces the record, then puts the old steps back under their old id.
    const changed = await one.editProfile(first.id, derivedProfile("Reverted Bloom", 3.25));
    await expect.poll(() => shownAt("Reverted", first.id), { timeout: 10_000 }).toEqual([]);
    await expect.poll(() => shownAt("Reverted", changed.id), { timeout: 10_000 }).toEqual(["Reverted lab"]);
    await holds(two, first.id, "hidden");

    const back = await one.editProfile(changed.id, derivedProfile("Reverted Bloom", 3));
    expect(back.id).toBe(first.id);
    await expect.poll(() => shownAt("Reverted", first.id), { timeout: 10_000 }).toEqual(["Reverted lab"]);
    await expect.poll(() => shownAt("Reverted", changed.id), { timeout: 10_000 }).toEqual([]);
    await holds(two, first.id, "visible");
    await holds(two, changed.id, "hidden");
    expect(visibilityOn(one, first.id)).toBe("visible");
  });

  it("keeps a lab Profile shown when a tablet that hid it while offline reconnects after another lab tablet showed it again", async () => {
    const { one, two } = await lab("Offline", 17081);
    const record = await save("Offline", one, derivedProfile("Offline Bloom", 3.5), ["lab"]);
    await holds(two, record.id, "visible");

    two.loseNetwork();
    await two.setProfileVisibility(record.id, "hidden");
    // Later, the lab's other tablet hides it and shows it again.
    await one.setProfileVisibility(record.id, "hidden");
    await expect.poll(() => shownAt("Offline", record.id), { timeout: 10_000 }).toEqual([]);
    await one.setProfileVisibility(record.id, "visible");
    await expect.poll(() => shownAt("Offline", record.id), { timeout: 10_000 }).toEqual(["Offline lab"]);

    // The earlier hide, made without seeing those, loses to them (ADR-0020), and the lab's state is written back.
    two.restoreNetwork();
    await holds(two, record.id, "visible");
    expect(await shownAt("Offline", record.id)).toEqual(["Offline lab"]);
    expect(visibilityOn(one, record.id)).toBe("visible");
  });

  it("applies a lab tablet's edits made after it was written a fast-clocked lab tablet's: showing a Profile that one hid, then replacing it", async () => {
    const location = await api.createLocation("Fast lab", "America/Chicago");
    const first = await api.createMachine("Fast 1", location.id);
    const second = await api.createMachine("Fast 2", location.id);
    // Its Decaid's clock runs 5 minutes fast, so every edit it makes is timed after the other tablet's.
    const fast = load(first, "17101", { decaidClockOffsetMs: 5 * 60_000 });
    const steady = load(second, "17102", { instance: other });
    await online(first, second);
    const record = await save("Fast", fast, derivedProfile("Fast Bloom", 2.5), ["lab"]);
    await holds(steady, record.id, "visible");
    await fast.setProfileVisibility(record.id, "hidden");
    await expect.poll(() => shownAt("Fast", record.id), { timeout: 10_000 }).toEqual([]);
    await holds(steady, record.id, "hidden");

    // Written the hide, the other tablet's barista shows it again: an edit made after seeing that one, timed earlier.
    await steady.setProfileVisibility(record.id, "visible");
    await expect.poll(() => shownAt("Fast", record.id), { timeout: 10_000 }).toEqual(["Fast lab"]);
    await holds(fast, record.id, "visible");
    expect(visibilityOn(steady, record.id)).toBe("visible");

    // Its steps changed there, it is hidden at the lab, and not written back to the tablet that replaced it.
    const replacement = await steady.editProfile(record.id, derivedProfile("Fast Bloom", 2.75));
    await expect.poll(() => shownAt("Fast", record.id), { timeout: 10_000 }).toEqual([]);
    await expect.poll(() => shownAt("Fast", replacement.id), { timeout: 10_000 }).toEqual(["Fast lab"]);
    await holds(fast, record.id, "hidden");
    await holds(fast, replacement.id, "visible");
    expect(visibilityOn(steady, record.id)).toBeUndefined();
    expect(profileWrites(steady).filter((write) => write.startsWith("POST"))).toEqual(["POST /profiles"]);
  });

  it("keeps a Profile hidden at the lab when a tablet's report from before it went offline arrives after another lab tablet hid it, as does the tablet's earlier change", async () => {
    const location = await api.createLocation("Resent lab", "America/Chicago");
    const first = await api.createMachine("Resent 1", location.id);
    const second = await api.createMachine("Resent 2", location.id);
    // Its reports of its profiles wait unsent while this holds them, as on a network that stalls before it drops.
    let holdingReports = false;
    const resent = load(first, "17111", {
      stallUpload: (frame) => holdingReports && (frame as { type?: unknown; name?: unknown }).type === "collection" && (frame as { name?: unknown }).name === "profiles",
    });
    // Its clock runs a second ahead, so its hide is timed after the other tablet's show, which come within a millisecond here.
    const lab2 = load(second, "17112", { instance: other, decaidClockOffsetMs: 1000 });
    await online(first, second);
    const record = await save("Resent", resent, derivedProfile("Resent Bloom", 2.25), ["lab"]);
    await holds(lab2, record.id, "visible");

    // The tablet hides it; its report is handed to the connection, which drops before it is written.
    holdingReports = true;
    const reportsBefore = resent.sent.length;
    await resent.setProfileVisibility(record.id, "hidden");
    await expect
      .poll(() => resent.sent.slice(reportsBefore).some((frame) => (frame as { name?: unknown }).name === "profiles"), { timeout: 10_000 })
      .toBe(true);
    resent.loseNetwork();
    holdingReports = false;
    // Offline, its barista shows it again; later the lab's other tablet hides it.
    await resent.setProfileVisibility(record.id, "visible");
    await lab2.setProfileVisibility(record.id, "hidden");
    await expect.poll(() => shownAt("Resent", record.id), { timeout: 10_000 }).toEqual([]);

    // Back online, the held report arrives first, then the tablet's earlier show: neither saw the later hide (ADR-0020).
    resent.restoreNetwork();
    await holds(resent, record.id, "hidden");
    expect(await shownAt("Resent", record.id)).toEqual([]);
    expect(visibilityOn(lab2, record.id)).toBe("hidden");
  });

  it("keeps a Profile hidden at the lab when a lab tablet hid it after another's hide there, though that one's earlier show arrives after", async () => {
    const location = await api.createLocation("Again lab", "America/Chicago");
    const first = await api.createMachine("Again lab 1", location.id);
    const second = await api.createMachine("Again lab 2", location.id);
    const one = await rawTablet(first, "17131");
    const two = await rawTablet(second, "17132", other);
    const id = "profile:a9a1000000000000017c";
    const start = Date.now() - 60_000;
    const at = (seconds: number) => new Date(start + seconds * 1000);
    await one.report(id, true, at(0));
    await two.report(id, true, at(0));
    expect(await shownAt("Again", id)).toEqual(["Again lab"]);

    // One hides it, which the lab takes in, then, offline, shows it again; the other, not yet written the hide, hides it later.
    await one.report(id, false, at(1));
    expect(await shownAt("Again", id)).toEqual([]);
    await two.report(id, false, at(3));
    // The earlier show, arriving last, loses to that hide, the field's latest edit, though it left the lab's state as it was (ADR-0020).
    await one.report(id, true, at(2));
    expect(await shownAt("Again", id)).toEqual([]);
  });

  it("keeps a Profile shown at the lab that a lab tablet created there after another lab tablet hid it, though the hide arrives after", async () => {
    const location = await api.createLocation("Recreated lab", "America/Chicago");
    const first = await api.createMachine("Recreated lab 1", location.id);
    const second = await api.createMachine("Recreated lab 2", location.id);
    const one = await rawTablet(first, "17151");
    const two = await rawTablet(second, "17152", other);
    const id = "profile:a9a1000000000000017e";
    // After both tablets joined the lab.
    const start = Date.now() + 1000;
    const at = (seconds: number) => new Date(start + seconds * 1000);
    await one.report(id, true, at(0));
    expect(await shownAt("Recreated", id)).toEqual(["Recreated lab"]);

    // One hides it, its report late; the other creates the same Profile later, which its map did not hold.
    await two.report(id, true, at(2));
    // The earlier hide, arriving last, loses to that, the field's latest edit, though it left the lab showing it (ADR-0020).
    await one.report(id, false, at(1));
    expect(await shownAt("Recreated", id)).toEqual(["Recreated lab"]);
  });

  for (const [how, removed, serial, id] of [
    ["deletes", "deleted", 17161, "profile:a9a1000000000000017f"],
    ["purges", "gone", 17163, "profile:a9a10000000000000180"],
  ] as const) {
    it(`hides a Profile at the lab when a lab tablet that had hidden it ${how} it after another showed it there again`, async () => {
      const location = await api.createLocation(`Removed ${how} lab`, "America/Chicago");
      const first = await api.createMachine(`Removed ${how} lab 1`, location.id);
      const second = await api.createMachine(`Removed ${how} lab 2`, location.id);
      const one = await rawTablet(first, String(serial));
      const two = await rawTablet(second, String(serial + 1), other);
      const start = Date.now() - 60_000;
      const at = (seconds: number) => new Date(start + seconds * 1000);
      await one.report(id, true, at(0));
      await two.report(id, true, at(0));
      await one.report(id, false, at(1));
      await two.report(id, false, at(2));
      await two.report(id, true, at(3));
      expect(await shownAt(`Removed ${how}`, id)).toEqual([`Removed ${how} lab`]);

      // The first, not yet written that, removes its hidden copy later: as deleting it does, that hides it there (ADR-0019).
      await one.report(id, removed, at(4));
      expect(await shownAt(`Removed ${how}`, id)).toEqual([]);
    });
  }

  for (const [how, scenario, serial, id, replacement] of [
    ["purges and re-creates", "Behind purge", 17171, "profile:a9a10000000000000181", null],
    ["replaces with new steps and changes back", "Behind revert", 17172, "profile:a9a10000000000000182", "profile:a9a10000000000000183"],
  ] as const) {
    it(`keeps showing a Profile at the lab that a lab tablet whose clock runs behind ${how}`, async () => {
      const location = await api.createLocation(`${scenario} lab`, "America/Chicago");
      const machine = await api.createMachine(`${scenario} lab group`, location.id);
      const one = await rawTablet(machine, String(serial));
      // Its clock runs 3 s behind PostgreSQL's, which times what is gone from its list.
      const behind = () => new Date(Date.now() - 3000);
      await one.report(id, true, behind());
      expect(await shownAt(scenario, id)).toEqual([`${scenario} lab`]);

      // Gone from its list, purged or replaced under new steps, it is hidden there, as deleting it does.
      if (replacement === null) await one.report(id, "gone", behind());
      else await one.report(replacement, true, behind());
      expect(await shownAt(scenario, id)).toEqual([]);
      // Re-created, or changed back, it is made there after that, whatever its time says (ADR-0020).
      await one.report(id, true, behind());
      expect(await shownAt(scenario, id)).toEqual([`${scenario} lab`]);
      if (replacement !== null) expect(await shownAt(scenario, replacement)).toEqual([]);
    });
  }

  it("judges a moved tablet's late show at its new Location by its time, whatever it had seen at its old one", async () => {
    const lab = await api.createLocation("Carried lab", "America/Chicago");
    const cafe = await api.createLocation("Carried cafe", "America/Chicago");
    const moving = await api.createMachine("Carried lab group", lab.id);
    const staying = await api.createMachine("Carried cafe group", cafe.id);
    const one = await rawTablet(moving, "17141");
    const two = await rawTablet(staying, "17142", other);
    const id = "profile:a9a1000000000000017d";
    const start = Date.now() - 60_000;
    const at = (seconds: number) => new Date(start + seconds * 1000);
    await one.report(id, true, at(0));
    await two.report(id, true, at(0));
    expect(await shownAt("Carried", id)).toEqual(["Carried cafe", "Carried lab"]);

    // The cafe's tablet hides it there; the lab's hid it at the lab earlier, and showed it again, its reports late.
    await two.report(id, false, at(3));
    await one.report(id, false, at(1));
    expect(await shownAt("Carried", id)).toEqual([]);
    // Its Machine moves to the cafe before the show arrives: what it had seen at the lab says nothing of the cafe's later hide.
    expect((await api.call("POST", `/machines/${moving.machine.id}/location-history`, { locationId: cafe.id })).status).toBe(201);
    await one.report(id, true, at(2));
    expect(await shownAt("Carried", id)).toEqual([]);
  });

  it("keeps Decaid's bundled Profiles as a moved tablet had them at a Location that has decided nothing of them, and hides the Profiles of its old Location there", async () => {
    const { machines, one } = await lab("Moved", 17091);
    const user = await save("Moved", one, derivedProfile("Moved Bloom", 3.75), ["lab"]);
    await one.setProfileVisibility(BUNDLED_HIDDEN, "hidden");
    await expect.poll(() => shownAt("Moved", BUNDLED_HIDDEN), { timeout: 10_000 }).toEqual(["Moved cafe"]);

    const elsewhere = await api.createLocation("Moved elsewhere", "America/Chicago");
    expect((await api.call("POST", `/machines/${machines[0].machine.id}/location-history`, { locationId: elsewhere.id })).status).toBe(201);
    await expect.poll(() => shownAt("Moved", BUNDLED), { timeout: 10_000 }).toEqual(["Moved cafe", "Moved elsewhere", "Moved lab"]);
    await holds(one, user.id, "hidden");
    expect(await shownAt("Moved", user.id)).toEqual(["Moved lab"]);
    expect(await shownAt("Moved", BUNDLED_HIDDEN)).toEqual(["Moved cafe"]);
    expect(visibilityOn(one, BUNDLED)).toBe("visible");
    expect(visibilityOn(one, BUNDLED_HIDDEN)).toBe("hidden");
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
