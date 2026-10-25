import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #230: Settings Edits of a Tablet's Tablet Settings,
// Decaid's own settings (`appSettings`), Staff's to change but for gateway
// mode, an Admin's, made through the REST API and carried out by the built
// plugin in a simulated tablet, whose Decaid applies `POST /settings` one
// field at a time, with or without a machine, as v0.9.0 does
// (decaid-settings.ts). Assertions are made through the REST API and what
// the tablet's Decaid holds. Serials are made up.

interface SettingsEditView {
  id: string;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  adjusted: { field: string; holds?: unknown }[];
  refusal: { reason: string; state?: string | null; status?: number | null; message?: string | null; changed?: string[] } | null;
  readBack: Record<string, unknown> | null;
}

/** The Tablet Settings the tablets start with, those the tests change (de1pro-v0.9.0's settings.json). */
const AS_REPORTED = {
  gatewayMode: "tracking",
  scalePowerMode: "displayOff",
  chargingMode: "longevity",
  nightModeEnabled: false,
  nightModeSleepTime: 1320,
  nightModeMorningTime: 420,
  themeMode: "system",
};

describe("Settings Edits of the Tablet Settings", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let staff: AdminApi;
  let serial = 23_000;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Tablet settings cafe", "America/Toronto");
    staff = await api.staffAt("tablet-settings@example.com", cafe);
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine at the cafe whose tablet, four hours behind UTC, is connected, with a Library of its own that is empty. */
  async function connected(name: string, options: Parameters<typeof syncingTablet>[2] = {}): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, cafe.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++), utcOffsetMinutes: -240, ...options });
    await api.waitForOnline(machine);
    await expect.poll(() => reported(machine)).toMatchObject({ value: AS_REPORTED });
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, fields: Record<string, unknown>, as = api) =>
    (
      await as.send<{ settingsEdit: SettingsEditView }>(
        "POST",
        path(machine),
        { collection: "appSettings", fields, expected: Object.fromEntries(Object.keys(fields).map((field) => [field, AS_REPORTED[field as keyof typeof AS_REPORTED]])) },
        201,
      )
    ).settingsEdit;
  async function answered(machine: CreatedMachine, id: string): Promise<SettingsEditView> {
    const read = async () => (await api.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
    return read();
  }
  const reported = async (machine: CreatedMachine) =>
    (await api.get<{ collection: { value: Record<string, unknown>; utcOffsetMinutes: number | null } | null }>(`/machines/${machine.machine.id}/collections/appSettings`)).collection;
  /** The Tablet Settings the tablet's Decaid holds, read as another app on the tablet would. */
  async function held(tablet: SimulatedTablet): Promise<Record<string, unknown>> {
    const { status, body } = await tablet.callApi("GET", "/settings");
    expect(status).toBe(200);
    return body as Record<string, unknown>;
  }
  const writes = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write === "POST /settings");

  it("applies Staff's edit of the charging mode and night mode at the Machine's Location, its times as minutes after midnight in the Tablet's time", async () => {
    const { machine, tablet } = await connected("Tablet settings applied");
    const night = { chargingMode: "balanced", nightModeEnabled: true, nightModeSleepTime: 1380, nightModeMorningTime: 360 };
    const made = await make(machine, night, staff);
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", adjusted: [], refusal: null, readBack: night });
    expect(await held(tablet)).toMatchObject(night);
    expect(writes(tablet)).toEqual(["POST /settings"]);
    // The read-back is reported with the Tablet's offset, which its night mode's times are in.
    expect(await reported(machine)).toMatchObject({ value: night, utcOffsetMinutes: -240 });
  });

  it("refuses Staff gateway mode with 403, writing nothing, and applies an Admin's change of it", async () => {
    const { machine, tablet } = await connected("Tablet gateway mode");
    const response = await staff.call("POST", path(machine), { collection: "appSettings", fields: { gatewayMode: "full" }, expected: { gatewayMode: "tracking" } });
    const text = await response.text();
    expect(response.status, text).toBe(403);
    expect(text).toMatch(/Only an Admin can change Gateway mode/);
    expect(writes(tablet)).toEqual([]);

    const made = await make(machine, { gatewayMode: "full" });
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", readBack: { gatewayMode: "full" } });
    expect((await held(tablet)).gatewayMode).toBe("full");
    expect(writes(tablet)).toEqual(["POST /settings"]);
  });

  it("applies an edit while no machine is connected to the Tablet, whose state Decaid can't read then", async () => {
    const { machine, tablet } = await connected("Tablet without a machine", { machineConnected: false });
    expect((await tablet.callApi("GET", "/machine/state")).status).toBe(500);
    const made = await make(machine, { themeMode: "dark" }, staff);
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "applied", readBack: { themeMode: "dark" } });
    expect((await held(tablet)).themeMode).toBe("dark");
  });

  it("refuses an edit while the Machine pulls a Shot, naming its state, and writes nothing", async () => {
    const { machine, tablet } = await connected("Tablet during a Shot");
    tablet.reportState("espresso", "pouring");
    const made = await make(machine, { chargingMode: "balanced" }, staff);
    expect(await answered(machine, made.id)).toMatchObject({ outcome: "refused", refusal: { reason: "machineBusy", state: "espresso" }, readBack: null });
    expect(writes(tablet)).toEqual([]);
    expect((await held(tablet)).chargingMode).toBe("longevity");
  });

  it("records Decaid's 400 with its message, and the fields it applied before refusing", async () => {
    const { machine, tablet } = await connected("Tablet settings refused part-way");
    // Decaid refuses the charging mode after applying the scale power mode before it (settings_handler.dart's order).
    tablet.failSettingWrites = ({ route, field }) =>
      route === "/settings" && field === "chargingMode" ? { status: 400, body: { message: "balanced is not a valid charging mode" } } : undefined;
    const made = await make(machine, { scalePowerMode: "disconnect", chargingMode: "balanced", nightModeEnabled: true }, staff);
    expect(await answered(machine, made.id)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "decaid", status: 400, message: "balanced is not a valid charging mode", changed: ["scalePowerMode"] },
      readBack: { scalePowerMode: "disconnect", chargingMode: "longevity", nightModeEnabled: false },
    });
    await expect.poll(async () => (await reported(machine))?.value).toMatchObject({ scalePowerMode: "disconnect", chargingMode: "longevity", nightModeEnabled: false });
  });
});
