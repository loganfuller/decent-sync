import { globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, type MachineView, acceptInvite } from "./support/admin-api.js";
import { SimulatedTablet, derivedDe1Pro, derivedProfile, settingsFor, workflowFixture } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #90: an Admin turns sharing off for a Machine at a
// Location, making it a Capture-only Machine, and turns it back on. While
// it is off, nothing is written to its tablet, and what its tablet adds or
// changes is captured as in milestone 1 but not taken into the Library.
// Turned back on, the Machine joins its Location (ADR-0008): its tablet is
// written the Location's state, over what it changed meanwhile, and what it
// added meanwhile stays out of the Library, archived on it (ADR-0018), until
// its barista takes it up again. Only Admins switch it.
// Through the built plugin in simulated tablets, on two server instances
// sharing one database, with assertions through the REST API and what each
// simulated tablet's Decaid holds. Serials are made up, from 25001.

type Record_ = Record<string, unknown>;

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** The Library lists a tablet reports, which are taken into the Library. */
const LISTS = ["beans", "beanBatches", "grinders", "profiles"];

/** Decaid's bundled Profiles from the test tablet, as a fresh install holds them. */
function bundledProfiles(): Record_[] {
  return (derivedDe1Pro({})["/profiles"] as Record_[]).filter((profile) => profile.isDefault === true);
}

describe("The capture-only switch", { timeout: 60_000 }, () => {
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
   * The built plugin on a fresh tablet of the Machine, holding only Decaid's
   * bundled Profiles, connected to an instance, polling every 5 s (0.1 s
   * here), its steam, hot water and rinse settings changed as given.
   */
  function load(machine: CreatedMachine, serial: string, options: { instance?: TestServer; parts?: Record<string, Record_> } = {}): SimulatedTablet {
    const workflow = workflowFixture();
    for (const [part, values] of Object.entries(options.parts ?? {})) workflow[part] = { ...(workflow[part] as Record_), ...values };
    const tablet = SimulatedTablet.load({
      settings: { ...settingsFor({ token: machine.token, serverUrl: (options.instance ?? server).url }), PollSeconds: 5 },
      api: {
        ...derivedDe1Pro({ serial }),
        "/beans": [],
        "/bean-batches": [],
        "/grinders": [],
        "/profiles": bundledProfiles(),
        "/workflow": { ...workflow, context: { targetDoseWeight: 18, targetYield: 36 } },
      },
      timeScale: 50,
    });
    tablets.push(tablet);
    return tablet;
  }

  async function online(...machines: CreatedMachine[]): Promise<void> {
    for (const { machine } of machines) await api.waitForMachine(machine.name, (viewed) => viewed.online);
  }

  const read = async <T>(path: string): Promise<T> => (await (await api.call("GET", path)).json()) as T;
  const machineView = async ({ machine }: CreatedMachine) => (await read<{ machine: MachineView }>(`/machines/${machine.id}`)).machine;
  const switchSharing = (created: CreatedMachine, sharing: boolean, as: AdminApi = api) =>
    as.call("PUT", `/machines/${created.machine.id}/sharing`, { sharing });
  /** The Library's Beans named as given, by name. */
  const libraryBeans = async (prefix: string) =>
    (await read<{ beans: { id: string; name: string; offeredAt: LocationView[] }[] }>("/beans")).beans.filter((bean) => bean.name.startsWith(prefix));
  /** The names of the tablet's unarchived beans carrying a Library global id, sorted. */
  const sharedBeans = (tablet: SimulatedTablet) =>
    tablet
      .beans()
      .filter((bean) => bean.archived !== true && globalIdOf(bean) !== null)
      .map((bean) => String(bean.name))
      .sort();
  /** The names of the beans in the Machine's latest report of them, as captured. */
  const capturedBeans = async ({ machine }: CreatedMachine) =>
    (await read<{ collection: { value: Record_[] } | null }>(`/machines/${machine.id}/collections/beans`)).collection?.value.map((bean) => bean.name);
  /** The Machine's latest Workflow, as captured. */
  const capturedWorkflow = async ({ machine }: CreatedMachine) =>
    (await read<{ workflow: { workflow: Record<string, Record_> } | null }>(`/machines/${machine.id}/workflow`)).workflow?.workflow;
  /** The names of the collections the Machine's tablet has reported a value of. */
  const collections = async ({ machine }: CreatedMachine) =>
    (await read<{ collections: { name: string; receivedAt: string | null }[] }>(`/machines/${machine.id}/collections`)).collections
      .filter((collection) => collection.receivedAt !== null)
      .map((collection) => collection.name);
  const requests = (tablet: SimulatedTablet) => tablet.received.filter((frame) => (frame as { type?: unknown }).type === "requestCollections").length;
  /** The value of one of the tablet's settings, by its name, such as `steamSettings.flow`. */
  const setting = (tablet: SimulatedTablet, name: string) => {
    const [part, field] = name.split(".");
    return (tablet.workflow()[part!] as Record_)[field!];
  };

  it("writes nothing to a Machine with sharing off and takes nothing from it, then has it join its Location once sharing is back on", async () => {
    const uptown = await api.createLocation("Switching Uptown", "UTC");
    const switched = await api.createMachine("Switching Uptown 1", uptown.id);
    const sharing = await api.createMachine("Switching Uptown 2", uptown.id);
    const tablet = load(switched, "25001", { instance: other });
    const sharingTablet = load(sharing, "25002");
    await online(switched, sharing);
    await sharingTablet.addBean({ roaster: "Roux", name: "Switching Before" });
    await expect.poll(() => sharedBeans(tablet), { timeout: 10_000 }).toEqual(["Switching Before"]);
    expect((await machineView(switched)).captureOnly).toEqual([]);

    // Turned off on one instance, while its tablet is connected to the other.
    expect(await (await switchSharing(switched, false)).json()).toEqual({ sharing: false });
    const view = await machineView(switched);
    expect(view.sharing).toBe(false);
    expect(view.captureOnly).toEqual(["sharingOff"]);
    // Its Location's settings list it as capture-only.
    const listed = (await read<{ settings: { machines: { id: string; sharing: boolean }[] } }>(`/locations/${uptown.id}/settings`)).settings.machines;
    expect(listed.map(({ id, sharing }) => ({ id, sharing }))).toEqual([
      { id: switched.machine.id, sharing: false },
      { id: sharing.machine.id, sharing: true },
    ]);
    const writes = tablet.writes.length;
    const held = tablet.beans();

    // A Bean created in the management interface, and one entered on the other tablet, are not written to it.
    const created = (await (await api.call("POST", "/beans", { content: { roaster: "Roux", name: "Switching Created" } })).json()) as { bean: { id: string } };
    expect((await api.call("POST", "/bean-batches", { beanId: created.bean.id, content: { roastDate: "2026-10-05" }, locations: [{ locationId: uptown.id }] })).status).toBe(201);
    await sharingTablet.addBean({ roaster: "Roux", name: "Switching Entered" });
    await expect.poll(() => sharedBeans(sharingTablet), { timeout: 10_000 }).toEqual(["Switching Before", "Switching Created", "Switching Entered"]);
    // A Bean entered on its tablet is captured, but does not join the Library.
    await tablet.addBean({ roaster: "Roux", name: "Switching Own" });
    await expect.poll(() => capturedBeans(switched), { timeout: 10_000 }).toEqual(expect.arrayContaining(["Switching Before", "Switching Own"]));
    // Its settings changed on its tablet are its own, and the Location's changed in the management interface are not written to it.
    await tablet.changeSettings({ hotWaterData: { volume: 77 } });
    await expect.poll(async () => (await capturedWorkflow(switched))?.hotWaterData?.volume, { timeout: 10_000 }).toBe(77);
    const { settings } = await read<{ settings: { id: string; values: Record<string, number | null> } }>(`/locations/${uptown.id}/settings`);
    expect((await api.call("PATCH", `/location-settings/${settings.id}`, { values: { "rinseData.flow": 4.5 } })).status).toBe(200);
    await expect.poll(() => setting(sharingTablet, "rinseData.flow"), { timeout: 10_000 }).toBe(4.5);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(tablet.writes.length).toBe(writes);
    expect(tablet.beans().filter((bean) => bean.name !== "Switching Own")).toEqual(held);
    expect((await libraryBeans("Switching")).map((bean) => bean.name)).toEqual(["Switching Before", "Switching Created", "Switching Entered"]);
    expect(setting(sharingTablet, "hotWaterData.volume")).toBe(settings.values["hotWaterData.volume"]);

    // Turned back on, it joins Uptown: it is written Uptown's Beans and settings, and its own Bean is archived on it, out of the Library.
    expect(await (await switchSharing(switched, true)).json()).toEqual({ sharing: true });
    expect((await machineView(switched)).captureOnly).toEqual([]);
    const uptownBeans = ["Switching Before", "Switching Created", "Switching Entered"];
    await expect.poll(() => sharedBeans(tablet), { timeout: 15_000 }).toEqual(uptownBeans);
    await expect.poll(() => setting(tablet, "rinseData.flow"), { timeout: 10_000 }).toBe(4.5);
    await expect.poll(() => setting(tablet, "hotWaterData.volume"), { timeout: 10_000 }).toBe(settings.values["hotWaterData.volume"]);
    const own = () => tablet.beans().find((bean) => bean.name === "Switching Own")!;
    await expect.poll(() => own().archived, { timeout: 10_000 }).toBe(true);
    expect(globalIdOf(own())).toBeNull();
    expect((await libraryBeans("Switching")).map((bean) => bean.name)).toEqual(uptownBeans);
    expect(sharedBeans(sharingTablet)).toEqual(uptownBeans);
    expect(setting(sharingTablet, "hotWaterData.volume")).toBe(settings.values["hotWaterData.volume"]);

    // Its barista takes the coffee up again: un-archived there, it joins the Library at Uptown as one entered then.
    await tablet.editBean(own().id, { archived: false });
    const all = [...uptownBeans, "Switching Own"].sort();
    await expect.poll(() => sharedBeans(sharingTablet), { timeout: 15_000 }).toEqual(all);
    await expect.poll(() => sharedBeans(tablet), { timeout: 10_000 }).toEqual(all);
    expect((await libraryBeans("Switching Own"))[0]!.offeredAt).toEqual([uptown]);
  });

  it("has a Machine join its Location once sharing is back on though its tablet reported nothing meanwhile", async () => {
    const cafe = await api.createLocation("Rejoining cafe", "UTC");
    const switched = await api.createMachine("Rejoining cafe 1", cafe.id);
    const tablet = load(switched, "25011", { instance: other, parts: { steamSettings: { flow: 1.3 } } });
    await online(switched);
    const settingsId = async () => (await read<{ settings: { id: string | null } }>(`/locations/${cafe.id}/settings`)).settings.id;
    await expect.poll(settingsId, { timeout: 10_000 }).not.toBeNull();
    // Its reports of its Library lists are all taken in, as they are stored.
    await expect.poll(async () => (await collections(switched)).filter((name) => LISTS.includes(name)).sort(), { timeout: 10_000 }).toEqual([...LISTS].sort());
    const asked = requests(tablet);

    expect((await switchSharing(switched, false)).status).toBe(200);
    expect((await api.call("PATCH", `/location-settings/${await settingsId()}`, { values: { "steamSettings.flow": 2.2 } })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(setting(tablet, "steamSettings.flow")).toBe(1.3);
    expect((await switchSharing(switched, true)).status).toBe(200);
    // Asked for its Workflow and collections afresh, it joins the cafe again, and takes its settings.
    await expect.poll(() => requests(tablet), { timeout: 10_000 }).toBe(asked + 1);
    await expect.poll(() => setting(tablet, "steamSettings.flow"), { timeout: 10_000 }).toBe(2.2);
  });

  it("writes its Location's state over an edit its tablet made while capture-only once sharing is back on, and deletes a Profile hard-deleted meanwhile", async () => {
    const uptown = await api.createLocation("Offline Uptown", "UTC");
    const switched = await api.createMachine("Offline Uptown 1", uptown.id);
    const tablet = load(switched, "25021", { instance: other });
    await online(switched);
    const bean = await tablet.addBean({ roaster: "Roux", name: "Offline Guji", notes: "Floral" });
    const grinder = await tablet.addGrinder({ model: "Offline EK43" });
    const profile = await tablet.addProfile(derivedProfile("Offline Espresso", 8.4));
    await expect.poll(() => sharedBeans(tablet), { timeout: 10_000 }).toEqual(["Offline Guji"]);
    await expect.poll(() => globalIdOf(tablet.grinders().find((record) => record.id === grinder.id)!), { timeout: 10_000 }).not.toBeNull();
    const beanId = globalIdOf(tablet.beans().find((record) => record.id === bean.id)!)!;
    const profilePath = `/profiles/${encodeURIComponent(String(profile.id))}`;
    await expect.poll(async () => (await api.call("GET", profilePath)).status, { timeout: 10_000 }).toBe(200);
    const notes = async () => (await read<{ bean: { content: Record_ } }>(`/beans/${beanId}`)).bean.content.notes;
    const tabletNotes = () => tablet.beans().find((record) => record.id === bean.id)!.notes;

    expect((await switchSharing(switched, false)).status).toBe(200);
    // Its barista edits the Bean and archives the Grinder, which is captured but not taken in, and an Admin hard-deletes the
    // Profile, which stays on it.
    await tablet.editBean(bean.id, { notes: "Floral, then stone fruit" });
    await tablet.editGrinder(grinder.id, { archived: true });
    await expect
      .poll(async () => (await read<{ collection: { value: Record_[] } | null }>(`/machines/${switched.machine.id}/collections/grinders`)).collection?.value[0]?.archived, {
        timeout: 10_000,
      })
      .toBe(true);
    expect(await notes()).toBe("Floral");
    expect((await api.call("DELETE", profilePath)).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(tablet.profiles().some((record) => record.id === profile.id)).toBe(true);

    // Back on, Uptown's state wins: the Bean's notes and the Grinder are written back as the Library has them, with no
    // Conflict, and the Profile is deleted from it.
    expect((await switchSharing(switched, true)).status).toBe(200);
    await expect.poll(tabletNotes, { timeout: 15_000 }).toBe("Floral");
    await expect.poll(() => tablet.grinders().find((record) => record.id === grinder.id)!.archived, { timeout: 15_000 }).toBe(false);
    await expect.poll(() => tablet.profiles().some((record) => record.id === profile.id), { timeout: 15_000 }).toBe(false);
    expect(await notes()).toBe("Floral");
    expect((await read<{ conflicts: unknown[] }>(`/beans/${beanId}/conflicts`)).conflicts).toEqual([]);
  });

  it("shows why a Machine is capture-only, and lets only Admins switch it", async () => {
    const belmont = await api.createLocation("Capture-only Belmont", "UTC");
    const nowhere = await api.createMachine("Capture-only nowhere");
    const there = await api.createMachine("Capture-only Belmont 1", belmont.id);
    expect((await machineView(nowhere)).captureOnly).toEqual(["noLocation"]);
    expect((await machineView(there)).captureOnly).toEqual([]);
    expect((await switchSharing(nowhere, false)).status).toBe(200);
    expect((await machineView(nowhere)).captureOnly).toEqual(["noLocation", "sharingOff"]);

    // Staff, even at its Location, may not switch it.
    const { link } = await api.invite("capture-only-belmont@example.com", "staff", [belmont.id]);
    const staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Staff", password: "staff password 1" }));
    expect((await switchSharing(there, false, staff)).status).toBe(403);
    expect((await machineView(there)).sharing).toBe(true);
    // Staff read it as Admins do.
    expect(((await (await staff.call("GET", `/machines/${there.machine.id}`)).json()) as { machine: MachineView }).machine.captureOnly).toEqual([]);

    expect((await api.call("PUT", `/machines/${there.machine.id}/sharing`, { sharing: "off" })).status).toBe(400);
    expect((await api.call("PUT", "/machines/0199c0de-0000-7000-8000-0000000000ff/sharing", { sharing: false })).status).toBe(404);
  });
});
