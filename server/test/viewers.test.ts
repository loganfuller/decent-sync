import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, type ManagedAccountView, acceptInvite, secretOf, signIn } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { shotFixture } from "./support/shot-fixtures.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Viewers (#376) through the REST API of two server instances on one database:
// an Admin invites one, who reads what Staff read and changes nothing, and
// changes a Viewer's role in any direction, each change applying to their
// next request on either instance. Which routes a Viewer may use is
// server/test/access.test.ts's; the Live View's stream is
// server/test/live-view.test.ts's, and a Conflict's server/test/library-conflicts.test.ts's.

type Record_ = Record<string, unknown>;

interface Person {
  id: string;
  email: string;
  password: string;
  /** The session the invite's acceptance started. */
  cookie: string;
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };
const session = (server: TestServer, cookie: string) => fetch(`${server.url}/api/session`, { headers: { Cookie: cookie } });
const accountOf = async (response: Response) => ((await response.json()) as { account: ManagedAccountView }).account;
/** The refusal's message, after checking its status. */
const refusal = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  return ((await response.json()) as { message: unknown }).message;
};

describe("Viewers", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let lab: LocationView;
  let uptown: LocationView;
  const tablets: SimulatedTablet[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    lab = await api.createLocation("Lab", "America/Chicago");
    uptown = await api.createLocation("Uptown", "America/Chicago");
  });
  afterAll(async () => {
    for (const tablet of tablets) await tablet.unload();
    await server?.stop();
  });

  /** Invites someone, as the role given, and accepts it as them, so they have an account and a session. */
  async function invitePerson(name: string, role: "staff" | "viewer", locationIds: string[] = []): Promise<Person> {
    const email = `${name.toLowerCase()}@example.com`;
    const password = `${name}'s password`;
    const { link } = await api.invite(email, role, locationIds);
    const cookie = await acceptInvite(server.url, link, { name, password });
    const { account } = (await (await session(server, cookie)).json()) as { account: { id: string } };
    return { id: account.id, email, password, cookie };
  }

  it("are invited by an Admin, with no Locations, and sign in as a Viewer", async () => {
    // Like an Admin, a Viewer works at no Location: those sent are not read.
    const created = await api.invite("val@example.com", "viewer", [lab.id]);
    expect(created.invite).toMatchObject({ email: "val@example.com", role: "viewer", locations: [] });
    expect(await api.at(other.url).invites()).toContainEqual(created.invite);
    const opened = await fetch(`${other.url}/api/invite-links/${secretOf(created.link)}`);
    expect(await opened.json()).toMatchObject({ invite: { email: "val@example.com", role: "viewer", locations: [] } });

    const cookie = await acceptInvite(other.url, created.link, { name: "Val Viewer", password: "Val's password" });
    const signedIn = (await (await session(server, cookie)).json()) as { account: Record_ };
    expect(signedIn.account).toEqual({ id: expect.any(String), email: "val@example.com", name: "Val Viewer", role: "viewer", locations: [] });
    expect(await api.at(other.url).accounts()).toContainEqual({ ...signedIn.account, deactivatedAt: null });
    expect(await api.invites()).not.toContainEqual(created.invite);

    // Signing out is the one change a Viewer makes.
    const val = AdminApi.signedInAs(other.url, cookie);
    expect((await val.call("DELETE", "/session")).status).toBe(204);
    expect((await session(server, cookie)).status).toBe(401);
  });

  it("read a Shot and its measurements, and an item's history naming who edited it, as Staff do, but no accounts or invites", async () => {
    const staff = AdminApi.signedInAs(other.url, (await invitePerson("Sam", "staff", [lab.id])).cookie);
    const viewer = AdminApi.signedInAs(other.url, (await invitePerson("Vic", "viewer")).cookie);
    const staffId = (await staff.get<{ account: { id: string } }>("/session")).account.id;

    const machine = await api.createMachine("Viewers' lab 1", lab.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(37_601) });
    tablets.push(tablet);
    await api.waitForOnline(machine);
    const fixture = shotFixture();
    const workflow = fixture.workflow as Record_;
    const shot = { ...fixture, id: "viewers-shot", workflow: { ...workflow, machine: { ...(workflow.machine as Record_), serialNumber: "37601" } } };
    tablet.pullShot(shot);
    await expect.poll(async () => (await api.call("GET", `/shots/${shot.id}`)).status).toBe(200);

    // A Bean an Admin created and Staff then edited.
    const { bean } = await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name: "Viewers' Guji" } }, 201);
    await staff.send("PATCH", `/beans/${bean.id}`, { content: { notes: "Peach" } });

    for (const path of [`/shots?machineId=${machine.machine.id}`, `/shots/${shot.id}`, `/shots/${shot.id}/measurements`, `/beans/${bean.id}`]) {
      expect(await viewer.get(path), path).toEqual(await staff.get(path));
    }
    const { shots } = await viewer.get<{ shots: { id: string }[] }>(`/shots?machineId=${machine.machine.id}`);
    expect(shots.map(({ id }) => id)).toEqual([shot.id]);
    // The edit names its account, by id alone, as other accounts' names are personal information Staff don't see.
    const { versions } = await viewer.get<{ versions: { fields: Record_; source: Record_ }[] }>(`/beans/${bean.id}/history`);
    expect(versions[0]).toMatchObject({ fields: { notes: "Peach" }, source: { machine: null, account: { id: staffId, name: null } } });
    expect(versions).toEqual((await staff.get<{ versions: unknown[] }>(`/beans/${bean.id}/history`)).versions);

    expect(await refusal(await viewer.call("GET", "/accounts"), 403)).toBe("Only an Admin can do this");
    expect(await refusal(await viewer.call("GET", "/invites"), 403)).toBe("Only an Admin can do this");
    // Nor do they change what they read.
    expect(await refusal(await viewer.call("PATCH", `/beans/${bean.id}`, { content: { notes: "Plum" } }), 403)).toBe("A Viewer can't change anything");
    expect((await viewer.get<{ bean: { content: Record_ } }>(`/beans/${bean.id}`)).bean.content).toMatchObject({ notes: "Peach" });
  });

  it("become Staff again with Locations chosen anew, after Staff became a Viewer and lost theirs, from their next request on the other instance", async () => {
    const kim = await invitePerson("Kim", "staff", [lab.id]);
    const kimElsewhere = AdminApi.signedInAs(other.url, kim.cookie);
    const createBean = (name: string) => kimElsewhere.call("POST", "/beans", { content: { roaster: "Roux", name: `Kim's ${name}` } });
    expect((await createBean("first")).status).toBe(201);

    const toViewer = await api.call("PUT", `/accounts/${kim.id}/access`, { role: "viewer", locationIds: [lab.id] });
    expect(await accountOf(toViewer)).toMatchObject({ id: kim.id, role: "viewer", locations: [], deactivatedAt: null });
    expect((await kimElsewhere.get<{ account: Record_ }>("/session")).account).toMatchObject({ role: "viewer", locations: [] });
    expect(await refusal(await createBean("second"), 403)).toBe("A Viewer can't change anything");
    expect((await kimElsewhere.call("GET", "/beans")).status).toBe(200);

    // Staff work at one or more Locations, so their old ones aren't brought back.
    expect(await refusal(await api.call("PUT", `/accounts/${kim.id}/access`, { role: "staff" }), 400)).toEqual(["Choose the Locations a Staff member works at"]);
    const toStaff = await api.call("PUT", `/accounts/${kim.id}/access`, { role: "staff", locationIds: [uptown.id] });
    expect(await accountOf(toStaff)).toMatchObject({ id: kim.id, role: "staff", locations: [uptown] });
    expect((await kimElsewhere.get<{ account: Record_ }>("/session")).account).toMatchObject({ role: "staff", locations: [uptown] });
    expect((await createBean("third")).status).toBe(201);
  });

  it("are deactivated, reactivated, issued a password reset link and made an Admin, each from their next request on the other instance", async () => {
    const lee = await invitePerson("Lee", "viewer");
    expect((await session(other, lee.cookie)).status).toBe(200);

    expect(await accountOf(await api.call("POST", `/accounts/${lee.id}/deactivate`))).toMatchObject({ role: "viewer", deactivatedAt: expect.any(String) });
    expect((await session(other, lee.cookie)).status).toBe(401);
    const refused = await fetch(`${other.url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: lee.email, password: lee.password }),
    });
    expect(refused.status).toBe(403);

    expect(await accountOf(await api.call("POST", `/accounts/${lee.id}/reactivate`))).toMatchObject({ role: "viewer", deactivatedAt: null });
    const signedIn = AdminApi.signedInAs(other.url, await signIn(other.url, lee));
    expect((await signedIn.get<{ account: Record_ }>("/session")).account).toMatchObject({ id: lee.id, role: "viewer" });

    const { link } = await api.send<{ link: string }>("POST", `/accounts/${lee.id}/password-reset`, undefined, 201);
    const redeemed = await fetch(`${other.url}/api/password-reset-links/${secretOf(link)}/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Lee's new password" }),
    });
    expect(redeemed.status).toBe(200);
    expect(await accountOf(redeemed)).toMatchObject({ id: lee.id, role: "viewer", locations: [] });
    const reset = AdminApi.signedInAs(other.url, redeemed.headers.getSetCookie()[0]!.split(";")[0]!);
    expect((await signedIn.call("GET", "/session")).status).toBe(401);
    expect((await reset.call("GET", "/accounts")).status).toBe(403);

    expect(await accountOf(await api.call("PUT", `/accounts/${lee.id}/access`, { role: "admin" }))).toMatchObject({ role: "admin", locations: [] });
    expect((await reset.call("GET", "/accounts")).status).toBe(200);
    expect((await reset.call("POST", "/locations", { name: "Lee's annex", timeZone: "America/Chicago" })).status).toBe(201);
  });
});
