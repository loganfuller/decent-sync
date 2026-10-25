import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #226: the log of a Machine's Settings Edits, listed
// newest first, a page at a time, with who made each as the account reading
// it may see them. The edits are made through the REST API and carried out by
// the built plugin in a simulated tablet at real time, as in
// settings-edit-deadline.test.ts, whose Decaid a test slows by holding its
// requests. Assertions are made through the REST API. Serials are made up.

interface SettingsEditView {
  id: string;
  collection: string;
  fields: Record<string, unknown>;
  expected: Record<string, unknown>;
  account: { id: string; name: string | null } | null;
  madeAt: string;
  sentAt: string | null;
  answeredAt: string | null;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  late: boolean;
  refusal: { reason: string; current?: Record<string, unknown> | null } | null;
}
interface SettingsEditPage {
  settingsEdits: SettingsEditView[];
  total: number;
  limit: number;
  offset: number;
}

describe("The log of Settings Edits", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Log cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, body: unknown, as = api) => (await as.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), body, 201)).settingsEdit;
  const read = async (machine: CreatedMachine, id: string) => (await api.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
  const list = (machine: CreatedMachine, query = "", as = api) => as.get<SettingsEditPage>(`${path(machine)}${query}`);
  /** Resolves once the plugin's answer to the edit has been recorded, whatever came of it. */
  async function answered(machine: CreatedMachine, id: string): Promise<void> {
    await expect.poll(async () => (await read(machine, id)).answeredAt, { timeout: 15_000 }).not.toBeNull();
  }
  const outcomeOf = async (machine: CreatedMachine, id: string) => (await read(machine, id)).outcome;
  const accountId = async (as: AdminApi) => (await as.get<{ account: { id: string } }>("/session")).account.id;

  it("lists a Machine's edits newest first, paged, each with its times, fields before and after and outcome, and who made it as the reader may see", async () => {
    const machine = await api.createMachine("Log bar", cafe.id);
    const tablet: SimulatedTablet = syncingTablet(machine, server, { api: emptyLibrary(22_601), timeScale: 1 });
    await api.waitForOnline(machine);
    await expect
      .poll(async () => (await api.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/machineSettings`)).collection?.value)
      .toMatchObject({ fan: 50, steamPurgeMode: 0 });
    const sam = await api.staffAt("log-sam@example.com", cafe);
    const kim = await api.staffAt("log-kim@example.com", cafe);

    // Applied, by an Admin.
    const applied = await make(machine, { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } });
    await answered(machine, applied.id);
    // Refused as changed since, by Sam, who expected a steam purge mode the Machine no longer holds.
    const refused = await make(machine, { collection: "machineSettings", fields: { steamPurgeMode: 0 }, expected: { steamPurgeMode: 1 } }, sam);
    await answered(machine, refused.id);
    // Kim's write is under way as the connection drops: not confirmed, then applied by a late answer on the next one.
    const write = tablet.holdRequests("POST", "/machine/settings");
    const late = await make(machine, { collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 40 } }, kim);
    await expect.poll(() => write.arrived).toBe(1);
    // Unanswered, it is listed as it reads alone: pending, then not confirmed once its connection has dropped.
    expect((await list(machine)).settingsEdits[0]).toEqual({ ...(await read(machine, late.id)), outcome: null, answeredAt: null });
    tablet.dropConnections();
    await expect.poll(() => outcomeOf(machine, late.id)).toBe("notConfirmed");
    expect((await list(machine)).settingsEdits[0]).toEqual({ ...(await read(machine, late.id)), outcome: "notConfirmed", answeredAt: null });
    await api.waitForOnline(machine);
    write.release();
    await answered(machine, late.id);
    // An Admin's edit whose connection drops before its write stays not confirmed.
    const state = tablet.holdRequests("GET", "/machine/state");
    const notConfirmed = await make(machine, { collection: "machineSettings", fields: { fan: 35 }, expected: { fan: 30 } });
    await expect.poll(() => state.arrived).toBe(1);
    tablet.dropConnections();
    await expect.poll(() => outcomeOf(machine, notConfirmed.id)).toBe("notConfirmed");
    await api.waitForOnline(machine);
    state.release();
    await answered(machine, notConfirmed.id);

    const all = await list(machine);
    expect(all).toMatchObject({ total: 4, limit: 20, offset: 0 });
    expect(all.settingsEdits.map((edit) => edit.id)).toEqual([notConfirmed.id, late.id, refused.id, applied.id]);
    expect(all.settingsEdits).toMatchObject([
      { collection: "machineSettings", fields: { fan: 35 }, expected: { fan: 30 }, outcome: "notConfirmed", late: false, account: { name: "Ada Admin" } },
      { collection: "machineSettings", fields: { fan: 30 }, expected: { fan: 40 }, outcome: "applied", late: true, account: { name: "Staff" } },
      {
        collection: "machineSettings",
        fields: { steamPurgeMode: 0 },
        expected: { steamPurgeMode: 1 },
        outcome: "refused",
        late: false,
        refusal: { reason: "changedSince", current: { steamPurgeMode: 0 } },
        account: { name: "Staff" },
      },
      { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 }, outcome: "applied", late: false, account: { name: "Ada Admin" } },
    ]);
    for (const edit of all.settingsEdits) {
      expect(Date.parse(edit.sentAt!)).toBeGreaterThanOrEqual(Date.parse(edit.madeAt));
      expect(Date.parse(edit.answeredAt!)).toBeGreaterThanOrEqual(Date.parse(edit.sentAt!));
    }
    const madeAt = all.settingsEdits.map((edit) => Date.parse(edit.madeAt));
    expect(madeAt).toEqual([...madeAt].sort((a, b) => b - a));
    // Each is listed as it is read alone.
    for (const edit of all.settingsEdits) expect(edit).toEqual(await read(machine, edit.id));

    const page = await list(machine, "?limit=2&offset=1");
    expect(page).toMatchObject({ total: 4, limit: 2, offset: 1 });
    expect(page.settingsEdits.map((edit) => edit.id)).toEqual([late.id, refused.id]);

    // Staff see every account by its id only: Sam's own edit by Sam's id, and Kim's and the Admin's by theirs.
    const asSam = await list(machine, "", sam);
    expect(asSam.settingsEdits.map((edit) => edit.account)).toEqual([
      { id: await accountId(api), name: null },
      { id: await accountId(kim), name: null },
      { id: await accountId(sam), name: null },
      { id: await accountId(api), name: null },
    ]);
    expect(asSam.settingsEdits.map((edit) => edit.outcome)).toEqual(["notConfirmed", "applied", "refused", "applied"]);

    // A Machine with no edits lists none, and one that doesn't exist is not found.
    const quiet = await api.createMachine("Log quiet", cafe.id);
    expect(await list(quiet)).toEqual({ settingsEdits: [], total: 0, limit: 20, offset: 0 });
    expect((await api.call("GET", `/machines/${crypto.randomUUID()}/settings-edits`)).status).toBe(404);
  });
});
