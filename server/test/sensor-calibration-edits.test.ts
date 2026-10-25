import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type DecaidApi, type SimulatedTablet, sensorCalibration } from "./support/simulated-tablet.js";
import { startTestServer, type TestServer } from "./support/test-server.js";

// Seam 1 for ticket #228: Settings Edits setting a sensor's calibration to a
// value, an Admin's to change, made through the REST API and carried out by
// the built plugin in a simulated tablet, whose Decaid takes
// `PUT /machine/calibration/{target}` as a correction of the value the
// sensor holds, in signed Q16.16, as v0.9.0 does (decaid-settings.ts).
// Assertions are made through the REST API and what the tablet's Decaid
// holds. Serials are made up.

interface SettingsEditView {
  id: string;
  outcome: "applied" | "adjusted" | "refused" | "notConfirmed" | null;
  adjusted: { field: string; holds?: unknown }[];
  refusal: { reason: string; status?: number | null; message?: string | null; current?: Record<string, unknown> | null } | null;
  readBack: Record<string, unknown> | null;
}

/** What each target's calibration starts as (`sensorCalibration`): the pressure sensor's was recalibrated. */
const STARTING = { flow: 1, pressure: 1.0234375, temperature: 0 };

/** A value as the machine holds it, in signed Q16.16. */
const q16 = (value: number) => Math.round(value * 65536) / 65536;

describe("Settings Edits of a sensor's calibration", () => {
  let server: TestServer;
  let api: AdminApi;
  let cafe: LocationView;
  let serial = 22_800;

  beforeAll(async () => {
    server = await startTestServer({ env: { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    cafe = await api.createLocation("Sensor calibration cafe", "America/Toronto");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Machine at the cafe whose tablet is connected, with a Library of its own that is empty, and these routes served besides. */
  async function connected(name: string, served: DecaidApi = {}, before?: (tablet: SimulatedTablet) => void): Promise<{ machine: CreatedMachine; tablet: SimulatedTablet }> {
    const machine = await api.createMachine(name, cafe.id);
    const tablet = syncingTablet(machine, server, { api: { ...emptyLibrary(serial++), ...served } });
    before?.(tablet);
    await api.waitForOnline(machine);
    return { machine, tablet };
  }
  const path = (machine: CreatedMachine) => `/machines/${machine.machine.id}/settings-edits`;
  const make = async (machine: CreatedMachine, fields: Record<string, number>, expected: Record<string, unknown>) =>
    (await api.send<{ settingsEdit: SettingsEditView }>("POST", path(machine), { collection: "sensorCalibration", fields, expected }, 201)).settingsEdit;
  async function answered(machine: CreatedMachine, id: string): Promise<SettingsEditView> {
    const read = async () => (await api.get<{ settingsEdit: SettingsEditView }>(`${path(machine)}/${id}`)).settingsEdit;
    await expect.poll(async () => (await read()).outcome, { timeout: 15_000 }).not.toBeNull();
    return read();
  }
  /** The sensor calibration the server holds, each target's current value by target, or undefined while none is available. */
  async function reported(machine: CreatedMachine): Promise<Record<string, unknown> | undefined> {
    const { collection } = await api.get<{ collection: { available: boolean; value: Record<string, { measuredValue: unknown }> } | null }>(
      `/machines/${machine.machine.id}/collections/sensorCalibration`,
    );
    if (!collection?.available) return undefined;
    return Object.fromEntries(Object.entries(collection.value).map(([target, read]) => [target, read.measuredValue]));
  }
  /** What the tablet's machine holds for a target, read as another app on the tablet would. */
  async function held(tablet: SimulatedTablet, target: string): Promise<unknown> {
    const { status, body } = await tablet.callApi("GET", `/machine/calibration/${target}`);
    expect(status).toBe(200);
    return (body as { measuredValue: unknown }).measuredValue;
  }
  /** The plugin's writes to the sensors' calibration, with what each sent, recorded as Decaid takes them. */
  function calibrationWrites(tablet: SimulatedTablet): { route: string; body: unknown }[] {
    const writes: { route: string; body: unknown }[] = [];
    tablet.refuseWrites = ({ method, route, body }) => {
      if (method === "PUT" && route.startsWith("/machine/calibration/")) writes.push({ route, body });
      return undefined;
    };
    return writes;
  }

  it("sets each sensor's calibration as an Admin asks, from its current value, and reports the collection with it and the other two", async () => {
    const { machine, tablet } = await connected("Sensors set");
    const writes = calibrationWrites(tablet);
    await expect.poll(() => reported(machine)).toEqual(STARTING);

    const flow = await answered(machine, (await make(machine, { flow: 1.05 }, { flow: 1 })).id);
    // The machine holds the nearest value in Q16.16, within half a step of what was sent.
    expect(flow).toMatchObject({ outcome: "applied", adjusted: [], refusal: null, readBack: { flow: q16(1.05) } });
    await expect.poll(() => reported(machine)).toEqual({ ...STARTING, flow: q16(1.05) });

    const pressure = await answered(machine, (await make(machine, { pressure: 0.98 }, { pressure: 1.0234375 })).id);
    expect(pressure).toMatchObject({ outcome: "applied", readBack: { pressure: q16(0.98) } });
    const temperature = await answered(machine, (await make(machine, { temperature: -0.5 }, { temperature: 0 })).id);
    expect(temperature).toMatchObject({ outcome: "applied", readBack: { temperature: -0.5 } });
    await expect.poll(() => reported(machine)).toEqual({ flow: q16(1.05), pressure: q16(0.98), temperature: -0.5 });

    expect([await held(tablet, "flow"), await held(tablet, "pressure"), await held(tablet, "temperature")]).toEqual([q16(1.05), q16(0.98), -0.5]);
    // Each a correction from the value the target held, as Streamline's absolute set makes it.
    expect(writes).toEqual([
      { route: "/machine/calibration/flow", body: { de1ReportedValue: 1, measuredValue: 1.05 } },
      { route: "/machine/calibration/pressure", body: { de1ReportedValue: 1.0234375, measuredValue: 0.98 } },
      { route: "/machine/calibration/temperature", body: { de1ReportedValue: 0, measuredValue: -0.5 } },
    ]);
  });

  it("refuses Staff at the Machine's Location with 403, and an Admin's value out of range, off its step, or for two targets at once with 400", async () => {
    const { machine, tablet } = await connected("Sensors refused");
    const staff = await api.staffAt("sensor-calibration@example.com", cafe);
    const refused = async (fields: Record<string, unknown>, status: number, as = api) => {
      const expected = Object.fromEntries(Object.keys(fields).map((field) => [field, STARTING[field as keyof typeof STARTING]]));
      const response = await as.call("POST", path(machine), { collection: "sensorCalibration", fields, expected });
      const text = await response.text();
      expect(response.status, text).toBe(status);
      return text;
    };
    expect(await refused({ flow: 1.05 }, 403, staff)).toMatch(/Only an Admin can change Flow sensor multiplier/);
    expect(await refused({ temperature: 1 }, 403, staff)).toMatch(/Only an Admin can change Temperature sensor offset/);
    expect(await refused({ pressure: 1.5 }, 400)).toMatch(/Pressure sensor multiplier must be from 0.75 to 1.33/);
    expect(await refused({ temperature: -10.5 }, 400)).toMatch(/Temperature sensor offset must be from -10 to 10/);
    expect(await refused({ flow: 1.00005 }, 400)).toMatch(/multiple of 0.0001/);
    expect(await refused({ flow: 1.05, pressure: 1.1 }, 400)).toMatch(/Set one sensor's calibration at a time/);
    expect(tablet.writes.filter((write) => write.startsWith("PUT /machine/calibration/"))).toEqual([]);
  });

  it("refuses an edit of a target changed on the Tablet since the report, naming its current value, with nothing written", async () => {
    const { machine, tablet } = await connected("Sensor changed since");
    await expect.poll(() => reported(machine)).toEqual(STARTING);
    // Calibrated on the Tablet against a reference instrument: the pressure sensor reads 2% low.
    expect((await tablet.callApi("PUT", "/machine/calibration/pressure", { de1ReportedValue: 1, measuredValue: 1.02 })).status).toBe(202);
    const changed = await held(tablet, "pressure");
    expect(changed).not.toBe(STARTING.pressure);

    const edit = await answered(machine, (await make(machine, { pressure: 1 }, { pressure: STARTING.pressure })).id);
    expect(edit).toMatchObject({ outcome: "refused", refusal: { reason: "changedSince", current: { pressure: changed } } });
    expect(tablet.writes.filter((write) => write.startsWith("PUT /machine/calibration/"))).toEqual([]);
    expect(await held(tablet, "pressure")).toBe(changed);
    // Its read for the check is reported, beside the other targets as last read.
    await expect.poll(() => reported(machine)).toEqual({ ...STARTING, pressure: changed });
  });

  it("refuses a flow or pressure target whose current value is 0, as Decaid would, with nothing written, but sets a temperature offset of 0", async () => {
    const { machine, tablet } = await connected("Sensor at zero", sensorCalibration({ flow: 0, pressure: 0 }));
    await expect.poll(() => reported(machine)).toEqual({ flow: 0, pressure: 0, temperature: 0 });

    for (const target of ["flow", "pressure"]) {
      const edit = await answered(machine, (await make(machine, { [target]: 1 }, { [target]: 0 })).id);
      expect(edit).toMatchObject({
        outcome: "refused",
        refusal: { reason: "decaid", status: null, message: `The ${target} sensor's calibration is 0, which Decaid can't correct from` },
      });
    }
    expect(tablet.writes.filter((write) => write.startsWith("PUT /machine/calibration/"))).toEqual([]);

    const offset = await answered(machine, (await make(machine, { temperature: 0.25 }, { temperature: 0 })).id);
    expect(offset).toMatchObject({ outcome: "applied", readBack: { temperature: 0.25 } });
    expect(tablet.writes.filter((write) => write.startsWith("PUT /machine/calibration/"))).toEqual(["PUT /machine/calibration/temperature"]);
  });

  it("reads every target again after a write where the last report of the sensor calibration was unavailable", async () => {
    // The machine does not answer the temperature calibration's read as the tablet connects.
    const { machine, tablet } = await connected("Sensor read-back", {}, (tablet) => tablet.failNextApiReads("/machine/calibration/temperature", 1));
    await expect
      .poll(async () => (await api.get<{ collection: { available: boolean } | null }>(`/machines/${machine.machine.id}/collections/sensorCalibration`)).collection?.available)
      .toBe(false);

    const edit = await answered(machine, (await make(machine, { flow: 1.1 }, { flow: 1 })).id);
    expect(edit).toMatchObject({ outcome: "applied", readBack: { flow: q16(1.1) } });
    // Read only on a full read otherwise, so only the edit's read-back reads all three again.
    await expect.poll(() => reported(machine)).toEqual({ ...STARTING, flow: q16(1.1) });
    expect(tablet.writes.filter((write) => write.startsWith("PUT /machine/calibration/"))).toEqual(["PUT /machine/calibration/flow"]);
  });
});
