import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #227: Settings Edits of a Machine's advanced heater
// settings, its refill kit and its flow multiplier, an Admin's to change,
// made through the REST API and carried out by the built plugin in a
// simulated tablet, which writes them to the machine's registers as Decaid
// v0.9.0 does, scaled, truncated and one field at a time (decaid-settings.ts).
// Assertions are made through the REST API and what the tablet's Decaid
// holds. Serials are made up.

interface SettingsEditView {
  id: string;
  collection: string;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  adjusted: { field: string; holds?: unknown }[];
  refusal: { reason: string; status?: number | null; message?: string | null; changed?: string[] } | null;
  readBack: Record<string, unknown> | null;
}

/** The advanced settings and flow multiplier the tablets' machines start with (de1pro-v0.8.7's machine-settings-advanced.json). */
const ADVANCED = { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, heaterPh2Timeout: 1, heaterVoltage: 120, refillKitSetting: 2 };
const FLOW_MULTIPLIER = 1.1;

describe("Settings Edits of the advanced settings and flow multiplier", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 22_700;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Advanced settings cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine at the cafe whose tablet is connected, with a Library of its own that is empty. */
  async function connected(name: string): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, cafe.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary(serial++) });
    await api.waitForOnline(machine);
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, body: unknown) => (await api.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), body, 201)).settingsEdit;
  async function refused(machine: CreatedMachine, body: unknown, status: number, as = api): Promise<string> {
    const response = await as.call("POST", path(machine), body);
    const text = await response.text();
    expect(response.status, text).toBe(status);
    return text;
  }
  async function answered(machine: CreatedMachine, id: string): Promise<SettingsEditView> {
    const read = async () => (await api.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
    return read();
  }
  const reported = async (machine: CreatedMachine, name: string) =>
    (await api.get<{ collection: { value: Record<string, unknown> } | null }>(`/machines/${machine.machine.id}/collections/${name}`)).collection?.value;
  /** What the tablet's Decaid answers for a route, read as another app on the tablet would. */
  async function held(tablet: SimulatedTablet, route: string): Promise<Record<string, unknown>> {
    const { status, body } = await tablet.callApi("GET", route);
    expect(status).toBe(200);
    return body as Record<string, unknown>;
  }
  const writes = (tablet: SimulatedTablet) => tablet.writes.filter((write) => write.startsWith("POST /machine/"));

  it("applies an Admin's edit of each advanced setting, and of the flow multiplier", async () => {
    const { machine, tablet } = await connected("Advanced settings applied");
    await expect.poll(() => reported(machine, "advancedSettings")).toEqual(ADVANCED);
    await expect.poll(() => reported(machine, "machineCalibration")).toEqual({ flowMultiplier: FLOW_MULTIPLIER });

    const changed = { heaterPh1Flow: 2.3, heaterPh2Flow: 4.5, heaterIdleTemp: 96, heaterPh2Timeout: 6, heaterVoltage: 230, refillKitSetting: 1 };
    const advanced = await make(machine, { collection: "advancedSettings", fields: changed, expected: ADVANCED });
    const edit = await answered(machine, advanced.id);
    expect(edit).toMatchObject({ outcome: "applied", adjusted: [], refusal: null });
    // The Machine reads a heater flow back as tenths, as Decaid scales its register: within half a step of what was sent.
    expect(edit.readBack!.heaterPh1Flow).toBeCloseTo(2.3, 9);
    expect(await held(tablet, "/machine/settings/advanced")).toMatchObject({ heaterIdleTemp: 96, heaterPh2Timeout: 6, heaterVoltage: 230, refillKitSetting: 1 });

    const calibration = await make(machine, { collection: "machineCalibration", fields: { flowMultiplier: 1.2 }, expected: { flowMultiplier: FLOW_MULTIPLIER } });
    expect(await answered(machine, calibration.id)).toMatchObject({ outcome: "applied", adjusted: [], readBack: { flowMultiplier: 1.2 } });
    expect((await held(tablet, "/machine/calibration")).flowMultiplier).toBe(1.2);
    expect(writes(tablet)).toEqual(["POST /machine/settings/advanced", "POST /machine/calibration"]);
    await expect.poll(() => reported(machine, "machineCalibration")).toEqual({ flowMultiplier: 1.2 });
  });

  it("refuses Staff at the Machine's Location with 403, and a heater voltage other than the two offered with 400", async () => {
    const { machine, tablet } = await connected("Advanced settings refused");
    const staff = await api.staffAt("advanced-settings@example.com", cafe);
    const asStaff: [collection: string, fields: Record<string, unknown>, problem: RegExp][] = [
      ["advancedSettings", { heaterPh1Flow: 3 }, /Only an Admin can change Heater warmup flow/],
      ["advancedSettings", { refillKitSetting: 1 }, /Only an Admin can change Refill kit/],
      ["machineCalibration", { flowMultiplier: 1.2 }, /Only an Admin can change Flow multiplier/],
    ];
    for (const [collection, fields, problem] of asStaff) {
      const expected = Object.fromEntries(Object.keys(fields).map((field) => [field, null]));
      expect(await refused(machine, { collection, fields, expected }, 403, staff)).toMatch(problem);
    }
    // Decaid would write 200 as 230, and 300 as -1 (`De1HeaterVoltage.fromInt`).
    for (const heaterVoltage of [200, 300, -1, "230"]) {
      expect(await refused(machine, { collection: "advancedSettings", fields: { heaterVoltage }, expected: { heaterVoltage: 120 } }, 400)).toMatch(/Heater voltage must be 110 V or 220 V/);
    }
    expect(await refused(machine, { collection: "advancedSettings", fields: { refillKitSetting: 3 }, expected: { refillKitSetting: 2 } }, 400)).toMatch(/Refill kit must be/);
    expect(await refused(machine, { collection: "machineCalibration", fields: { flowMultiplier: 2.5 }, expected: { flowMultiplier: 1.1 } }, 400)).toMatch(/Flow multiplier must be from 0.13 to 2/);
    expect(await refused(machine, { collection: "machineCalibration", fields: { flowMultiplier: 1.0005 }, expected: { flowMultiplier: 1.1 } }, 400)).toMatch(/multiple of 0.001/);
    expect(writes(tablet)).toEqual([]);
  });

  it("reads a flow multiplier Decaid stores 0.001 lower as adjusted, naming what the Machine holds, and one stored exactly as applied", async () => {
    const { machine, tablet } = await connected("Flow multiplier adjusted");
    await expect.poll(() => reported(machine, "machineCalibration")).toEqual({ flowMultiplier: FLOW_MULTIPLIER });
    // 1.001 times 1000 is 1000.9999999999999 in floating point, which Decaid truncates to 1000.
    const lower = await make(machine, { collection: "machineCalibration", fields: { flowMultiplier: 1.001 }, expected: { flowMultiplier: FLOW_MULTIPLIER } });
    expect(await answered(machine, lower.id)).toMatchObject({ outcome: "adjusted", adjusted: [{ field: "flowMultiplier", holds: 1 }], readBack: { flowMultiplier: 1 } });
    expect((await held(tablet, "/machine/calibration")).flowMultiplier).toBe(1);

    const exact = await make(machine, { collection: "machineCalibration", fields: { flowMultiplier: 1.002 }, expected: { flowMultiplier: 1 } });
    const edit = await answered(machine, exact.id);
    expect(edit).toMatchObject({ outcome: "applied", adjusted: [] });
    expect(edit.readBack!.flowMultiplier).toBeCloseTo(1.002, 9);
  });

  it("refuses an advanced settings write Decaid refuses part-way with its status and message, naming the fields changed before it", async () => {
    const { machine, tablet } = await connected("Advanced settings refused part-way");
    await expect.poll(() => reported(machine, "advancedSettings")).toEqual(ADVANCED);
    // The machine does not take the idle temperature's register write in time, after both heater flows' (Decaid's order).
    tablet.failSettingWrites = ({ route, field }) =>
      route === "/machine/settings/advanced" && field === "heaterIdleTemp" ? { status: 500, body: { error: "TimeoutException: the machine did not answer" } } : undefined;
    const made = await make(machine, {
      collection: "advancedSettings",
      fields: { heaterPh1Flow: 3, heaterPh2Flow: 5, heaterIdleTemp: 95, refillKitSetting: 0 },
      expected: { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, refillKitSetting: 2 },
    });
    expect(await answered(machine, made.id)).toMatchObject({
      outcome: "refused",
      refusal: { reason: "decaid", status: 500, message: "TimeoutException: the machine did not answer", changed: ["heaterPh1Flow", "heaterPh2Flow"] },
      readBack: { heaterPh1Flow: 3, heaterPh2Flow: 5, heaterIdleTemp: 99, refillKitSetting: 2 },
    });
    await expect.poll(() => reported(machine, "advancedSettings")).toMatchObject({ heaterPh1Flow: 3, heaterPh2Flow: 5, heaterIdleTemp: 99, refillKitSetting: 2 });
  });
});
