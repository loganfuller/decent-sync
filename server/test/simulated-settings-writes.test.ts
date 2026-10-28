import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type DecaidApi, de1ProOnDecaid090, Refusal, SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's settings writes against those recorded on Decaid
// v0.9.0's Linux release (fixtures/decaid/settings-writes-v0.9.0/): a tablet
// serving what Decaid answered as it started is sent each step's requests,
// and must answer them, and the reads after them, as Decaid did, field for
// field. Decaid's simulated machine stores what it is sent, unscaled, so the
// recording wrote only values a DE1's registers hold as they are; the
// registers' scales, truncation and bounds, and a write failing part-way, are
// checked here from Decaid's source, as the README says, and the flow
// multiplier and pressure calibration against the test DE1Pro's reads
// (fixtures/decaid/de1pro-v0.9.0/calibration-writes.json).

type Method = "GET" | "POST" | "PUT" | "DELETE";
interface Exchange {
  request: { method: Method; path: string; body?: unknown; rawBody?: string };
  response: { status: number; body: unknown };
}
interface Step {
  exchanges: Exchange[];
  reads: Record<string, { status: number; body?: unknown; unchanged?: true }>;
}

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid");
const readFixture = (file: string, folder = "de1pro-v0.9.0") => JSON.parse(fs.readFileSync(path.join(fixtures, folder, file), "utf8")) as unknown;
const recorded = readFixture("settings-writes.json", "settings-writes-v0.9.0") as Record<string, Step>;
/** The test DE1Pro's calibration writes in #232's supervised run, each with what Decaid read back after it. */
const calibrationWrites = readFixture("calibration-writes.json") as Record<string, { wanted: number; route: string; sent?: unknown; read: unknown }[]>;

/** A tablet with no plugin connection, serving the settings Decaid answered as it started, and the machine state it recorded. */
function startedTablet(): SimulatedTablet {
  const api: DecaidApi = Object.fromEntries(Object.entries(recorded.started!.reads).map(([route, read]) => [route, read.body]));
  api["/machine/state"] = recorded.machineState!.exchanges[0]!.response.body;
  // No settings: the plugin does not connect, and only Decaid's API is used.
  return SimulatedTablet.load({ settings: {}, api });
}

/** Every string in `value` with each key of `ids` replaced by its value, as the ids Decaid gave the recorded wake schedules stand for the simulated tablet's. */
function renamed(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return [...ids].reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map((item) => renamed(item, ids));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renamed(item, ids)]));
  return value;
}

describe("The simulated tablet's settings writes", () => {
  it("answer each recorded step's requests, and the reads after them, as Decaid v0.9.0 did", async () => {
    const tablet = startedTablet();
    /** The recorded schedules' ids, by the simulated tablet's for them, and the other way round. */
    const toSimulated = new Map<string, string>();
    const toRecorded = new Map<string, string>();
    const reads = new Map<string, unknown>();
    for (const [step, { exchanges, reads: recordedReads }] of Object.entries(recorded)) {
      const answers: Exchange["response"][] = [];
      for (const { request, response } of exchanges) {
        // Disconnecting Decaid's simulated machine (`PUT /devices/disconnect`) is the tablet's machine going.
        if (request.path === "/devices/disconnect") {
          tablet.machineConnected = false;
          answers.push(response);
          continue;
        }
        const sent = renamed(request.path, toSimulated) as string;
        const text = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(renamed(request.body, toSimulated)));
        const answer = await tablet.callApiWithText(request.method, sent, text);
        const id = (answer.body as { id?: unknown } | null)?.id;
        if (answer.status === 201 && typeof id === "string") {
          const recordedId = (response.body as { id: string }).id;
          toSimulated.set(recordedId, id);
          toRecorded.set(id, recordedId);
        }
        answers.push(renamed(answer, toRecorded) as Exchange["response"]);
      }
      expect(answers, step).toEqual(exchanges.map((exchange) => exchange.response));
      const expected: Record<string, unknown> = {};
      const actual: Record<string, unknown> = {};
      for (const [route, read] of Object.entries(recordedReads)) {
        if (!read.unchanged) reads.set(route, { status: read.status, body: read.body });
        expected[route] = reads.get(route);
        actual[route] = renamed(await tablet.callApi("GET", route), toRecorded);
      }
      expect(actual, `the reads after ${step}`).toEqual(expected);
    }
  });

  it("hold each flow multiplier and pressure calibration the test DE1Pro was written in #232's run as it held it", async () => {
    // The calibrations start as the test DE1Pro's were before the run; each pressure write's correction is from it.
    const api = { ...de1ProOnDecaid090(), "/machine/calibration": readFixture("machine-calibration.json"), "/machine/calibration/pressure": readFixture("machine-calibration-pressure.json") };
    const tablet = SimulatedTablet.load({ settings: {}, api });
    for (const [target, writes] of Object.entries(calibrationWrites)) {
      for (const { wanted, route, sent, read } of writes) {
        const [method, url] = route.split(" ") as [Method, string];
        const written = url.replace(/^\/api\/v1/, "");
        expect((await tablet.callApi(method, written, sent ?? { flowMultiplier: wanted })).status, `${target} ${wanted}`).toBe(202);
        expect((await tablet.callApi("GET", written)).body, `${target} ${wanted}`).toEqual(read);
      }
    }
  });

  it("store a flow multiplier as a DE1 holds it, every tenth exactly, and one outside 0.13 to 2.0 at its bound", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    /** The flow multiplier `GET /machine/calibration` answers once Decaid is sent this one. */
    const stored = async (flowMultiplier: number) => {
      expect((await tablet.callApi("POST", "/machine/calibration", { flowMultiplier })).status).toBe(202);
      return ((await tablet.callApi("GET", "/machine/calibration")).body as { flowMultiplier: number }).flowMultiplier;
    };
    // Decaid writes the value times 1000, truncated (`_writeMMRScaled`), which writes 12 of the thousandths from 0.13
    // to 2.0 a thousandth lower; the DE1's firmware holds eight more a thousandth lower, and three of Decaid's 12 two
    // lower. Decaid reads the register times 0.001, which gives 0.7000000000000001 for 700: compared in thousandths.
    const lowered: Record<number, number[]> = { 1: [], 2: [] };
    for (let thousandths = 130; thousandths <= 2000; thousandths++) {
      const held = Math.round((await stored(thousandths / 1000)) * 1000);
      if (held !== thousandths) lowered[thousandths - held]!.push(thousandths / 1000);
    }
    expect(lowered).toEqual({
      1: [0.251, 0.253, 0.502, 0.506, 0.511, 1.001, 1.003, 1.004, 1.007, 1.009, 1.011, 1.012, 1.015, 1.017, 1.019, 1.021, 1.022],
      2: [1.005, 1.013, 1.023],
    });
    for (let tenths = 2; tenths <= 20; tenths++) expect(Math.round((await stored(tenths / 10)) * 1000)).toBe(tenths * 100);
    expect(await stored(0.7)).toBe(0.7000000000000001);
    expect(await stored(0.1)).toBe(0.13);
    expect(await stored(2.5)).toBe(2);
  });

  it("store a heater voltage outside 90 to 150 and 180 to 260 as -1, and one within them as Decaid's setting", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    const stored = async (heaterVoltage: number) => {
      expect((await tablet.callApi("POST", "/machine/settings/advanced", { heaterVoltage })).status).toBe(202);
      return ((await tablet.callApi("GET", "/machine/settings/advanced")).body as { heaterVoltage: number }).heaterVoltage;
    };
    const voltages = [0, 89, 90, 120, 150, 151, 179, 180, 230, 260, 261, 1120, 1230, 1300];
    const held: number[] = [];
    for (const voltage of voltages) held.push(await stored(voltage));
    expect(held).toEqual([-1, -1, 120, 120, 120, -1, -1, 230, 230, 230, -1, 120, 230, -1]);
  });

  it("hold each machine setting as its register does: truncated to its step, the fan threshold to 0 to 50", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 65, steamFlow: 1.237, hotWaterFlow: 8.79, flushFlow: 6.05, tankTemp: 30 })).status).toBe(202);
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 50, steamFlow: 1.23, hotWaterFlow: 8.700000000000001, flushFlow: 6, tankTemp: 30 });
    expect((await tablet.callApi("POST", "/machine/settings", { fan: -4 })).status).toBe(202);
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 0 });
    expect((await tablet.callApi("POST", "/machine/settings/advanced", { heaterPh1Flow: 2.25, heaterIdleTemp: 96.55, heaterPh2Timeout: 6.99 })).status).toBe(202);
    expect((await tablet.callApi("GET", "/machine/settings/advanced")).body).toMatchObject({ heaterPh1Flow: 2.2, heaterIdleTemp: 96.5, heaterPh2Timeout: 6.9 });
    // Numbers sent as text are read as Dart's `int.parse` and `double.tryParse` read them.
    expect((await tablet.callApi("POST", "/machine/settings", { fan: "0x2a", steamPurgeMode: " 1 " })).status).toBe(202);
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 42, steamPurgeMode: 1 });
    expect((await tablet.callApi("POST", "/machine/calibration", { flowMultiplier: " 1.25 " })).status).toBe(202);
    expect((await tablet.callApi("GET", "/machine/calibration")).body).toEqual({ flowMultiplier: 1.25 });
    // A Workflow's settings Decaid writes to the machine are held the same way.
    await tablet.changeSettings({ hotWaterData: { flow: 2.55 }, steamSettings: { flow: 1.237 } });
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ hotWaterFlow: 2.5, steamFlow: 1.23 });
    // A route served as a refusal holds nothing to write to.
    const release = tablet.refuseFor("/machine/settings", new Refusal(504, { error: "BleTimeoutException: MMR read timed out" }));
    await expect(tablet.callApi("POST", "/machine/settings", { fan: 40 })).rejects.toThrow("holds no settings");
    await tablet.changeSettings({ hotWaterData: { flow: 3 } });
    expect((await tablet.callApi("GET", "/machine/settings")).status).toBe(504);
    release();
  });

  it("leave the fields before one whose write fails applied, the machine's and Decaid's own", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    const before = (await tablet.callApi("GET", "/machine/settings")).body as Record<string, unknown>;
    const timedOut = { status: 504, body: { error: "BleTimeoutException: MMR write timed out" } };
    tablet.failSettingWrites = ({ route, field }) => (route === "/machine/settings" && field === "steamFlow" ? timedOut : undefined);
    // Decaid writes usb, fan, the flush settings, hot water flow, steam flow, the tank temperature and the purge mode, in that order.
    expect(await tablet.callApi("POST", "/machine/settings", { steamPurgeMode: 1, steamFlow: 1.2, hotWaterFlow: 9, fan: 40 })).toEqual(timedOut);
    expect((await tablet.callApi("GET", "/machine/settings")).body).toEqual({ ...before, fan: 40, hotWaterFlow: 9 });

    tablet.failSettingWrites = ({ route, field }) => (route === "/machine/settings/advanced" && field === "heaterVoltage" ? timedOut : undefined);
    const advanced = (await tablet.callApi("GET", "/machine/settings/advanced")).body as Record<string, unknown>;
    expect(await tablet.callApi("POST", "/machine/settings/advanced", { refillKitSetting: 0, heaterVoltage: 230, heaterPh2Flow: 4.5 })).toEqual(timedOut);
    expect((await tablet.callApi("GET", "/machine/settings/advanced")).body).toEqual({ ...advanced, heaterPh2Flow: 4.5 });

    tablet.failSettingWrites = ({ route, field }) => (route === "/settings" && field === "nightModeEnabled" ? { status: 500, body: { error: "settings not saved" } } : undefined);
    const app = (await tablet.callApi("GET", "/settings")).body as Record<string, unknown>;
    expect((await tablet.callApi("POST", "/settings", { nightModeEnabled: true, chargingMode: "balanced", themeMode: "dark" })).status).toBe(500);
    expect((await tablet.callApi("GET", "/settings")).body).toEqual({ ...app, chargingMode: "balanced" });

    // A value Decaid refuses part-way through, as recorded, leaves the earlier fields applied too.
    tablet.failSettingWrites = undefined;
    expect(await tablet.callApi("POST", "/settings", { keepAwake: false, nightModeSleepTime: 1440, stopHotWaterAtWeight: false })).toEqual({
      status: 400,
      body: { message: "nightModeSleepTime must be an integer 0-1439" },
    });
    expect((await tablet.callApi("GET", "/settings")).body).toEqual({ ...app, chargingMode: "balanced", stopHotWaterAtWeight: false });
  });

  it("answer the machine routes 500 while no machine is connected, and Decaid's own and its presence settings all the same", async () => {
    const tablet = SimulatedTablet.load({ settings: {}, machineConnected: false });
    const notConnected = { status: 500, body: { error: "DeviceNotConnectedException: machine not connected" } };
    for (const route of ["/machine/state", "/machine/settings", "/machine/settings/advanced", "/machine/calibration", "/machine/calibration/flow"]) {
      expect(await tablet.callApi("GET", route), route).toEqual(notConnected);
    }
    expect(await tablet.callApi("POST", "/machine/settings", { fan: 40 })).toEqual(notConnected);
    expect(await tablet.callApi("POST", "/machine/settings/advanced", { heaterIdleTemp: 97 })).toEqual(notConnected);
    expect(await tablet.callApi("POST", "/machine/calibration", { flowMultiplier: 1.1 })).toEqual(notConnected);
    expect(await tablet.callApi("PUT", "/machine/calibration/pressure", { de1ReportedValue: 1, measuredValue: 1.01 })).toEqual(notConnected);
    expect(await tablet.callApi("POST", "/settings", { chargingMode: "balanced" })).toEqual({ status: 200, body: null });
    expect(await tablet.callApi("POST", "/presence/settings", { sleepTimeoutMinutes: 45 })).toEqual({ status: 200, body: { userPresenceEnabled: true, sleepTimeoutMinutes: 45 } });
    expect((await tablet.callApi("POST", "/presence/schedules", { time: "06:30" })).status).toBe(201);
    expect((await tablet.callApi("GET", "/presence/settings")).body).toMatchObject({ sleepTimeoutMinutes: 45, keepAwakeUntil: null, schedules: [{ time: "06:30" }] });

    tablet.connectMachine();
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 40 })).status).toBe(202);
  });

  it("correct a sensor's calibration by the write, as the machine folds it in", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    const held = async (target: string) => ((await tablet.callApi("GET", `/machine/calibration/${target}`)).body as { measuredValue: number }).measuredValue;
    // A ratio is multiplied by measured over reported, held in signed Q16.16; Streamline sets it with the current value as reported.
    const pressure = await held("pressure");
    expect((await tablet.callApi("PUT", "/machine/calibration/pressure", { de1ReportedValue: pressure, measuredValue: 1.05 })).status).toBe(202);
    expect(await held("pressure")).toBe(Math.round(1.05 * 65536) / 65536);
    expect((await tablet.callApi("PUT", "/machine/calibration/pressure", { de1ReportedValue: 1, measuredValue: 2 })).status).toBe(202);
    expect(await held("pressure")).toBe((Math.round(1.05 * 65536) / 65536) * 2);
    // An offset has the difference added.
    expect((await tablet.callApi("PUT", "/machine/calibration/temperature", { de1ReportedValue: 0, measuredValue: -1.25 })).status).toBe(202);
    expect((await tablet.callApi("PUT", "/machine/calibration/temperature", { de1ReportedValue: 93, measuredValue: 93.5 })).status).toBe(202);
    expect(await held("temperature")).toBe(-0.75);
    // Each value is sent in Q16.16 rounded as Dart rounds, a half away from zero.
    const half = 1 / 131072;
    expect((await tablet.callApi("PUT", "/machine/calibration/temperature", { de1ReportedValue: 0, measuredValue: -half })).status).toBe(202);
    expect(await held("temperature")).toBe(-0.75 - 2 * half);
    expect((await tablet.callApi("PUT", "/machine/calibration/flow", { de1ReportedValue: -half, measuredValue: -half })).status).toBe(202);
  });

  it("answer a deleted wake schedule's change and deletion 404", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    const { status, body } = await tablet.callApi("POST", "/presence/schedules", { time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], keepAwakeFor: 90 });
    expect(status).toBe(201);
    const id = (body as { id: string }).id;
    expect(await tablet.callApi("DELETE", `/presence/schedules/${id}`)).toEqual({ status: 200, body: { deleted: id } });
    const gone = { status: 404, body: { error: "Schedule not found", id } };
    expect(await tablet.callApi("PUT", `/presence/schedules/${id}`, { enabled: false })).toEqual(gone);
    expect(await tablet.callApi("DELETE", `/presence/schedules/${id}`)).toEqual(gone);
    expect((await tablet.callApi("GET", "/presence/settings")).body).toMatchObject({ schedules: [] });
  });

  it("reset the fan threshold to 50 and the refill kit to auto as the machine reconnects", async () => {
    const tablet = SimulatedTablet.load({ settings: {} });
    expect((await tablet.callApi("POST", "/machine/settings", { fan: 30 })).status).toBe(202);
    expect((await tablet.callApi("POST", "/machine/settings/advanced", { refillKitSetting: 0, heaterIdleTemp: 96 })).status).toBe(202);
    tablet.machineConnected = false;
    tablet.connectMachine();
    expect((await tablet.callApi("GET", "/machine/settings")).body).toMatchObject({ fan: 50 });
    expect((await tablet.callApi("GET", "/machine/settings/advanced")).body).toMatchObject({ refillKitSetting: 2, heaterIdleTemp: 96 });
  });
});
