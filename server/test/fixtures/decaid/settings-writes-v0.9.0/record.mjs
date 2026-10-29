// Records Decaid's answers to the settings writes (README.md beside this script): each step's requests, then the
// reads of every settings route, one the same as that route's previous read kept as `"unchanged": true`.
//
//   node server/test/fixtures/decaid/settings-writes-v0.9.0/record.mjs <output file>
//
// It reads DECAID from the environment for another address than http://localhost:8080. Every request goes to a
// throwaway Decaid with its simulated machine connected: it changes the machine's and the app's settings, and
// disconnects the machine.
import { writeFileSync } from "node:fs";

const API = `${process.env.DECAID ?? "http://localhost:8080"}/api/v1`;
const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: record.mjs <output file>");

/**
 * Sends a request; `raw` sends its text as the body as it is, for a body that is not JSON. Each waits 10 ms first:
 * Decaid answers 429 to more than 256 requests a second from one client (`AdmissionGate` in
 * decaid:lib/src/services/webserver/admission_control.dart), which the script passes on a fast host without it.
 */
async function send(method, path, body, raw) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const response = await fetch(API + path, {
    method,
    ...(text === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: text }),
  });
  const answered = await response.text();
  let parsed;
  try {
    parsed = answered === "" ? null : JSON.parse(answered);
  } catch {
    parsed = answered;
  }
  const request = { method, path, ...(raw !== undefined ? { rawBody: raw } : body === undefined ? {} : { body }) };
  return { request, response: { status: response.status, body: parsed } };
}

/** The settings routes, read after each step, one after another. */
const READS = [
  "/machine/settings",
  "/machine/settings/advanced",
  "/machine/calibration",
  "/machine/calibration/flow",
  "/machine/calibration/pressure",
  "/machine/calibration/temperature",
  "/settings",
  "/presence/settings",
];

async function reads() {
  const answers = {};
  for (const path of READS) answers[path] = (await send("GET", path)).response;
  return answers;
}

/** The ids of the wake schedules Decaid added, by the step's name, for later steps' paths. */
const added = {};
const schedule = (step) => {
  const id = added[step];
  if (!id) throw new Error(`No schedule was added in ${step}`);
  return `/presence/schedules/${encodeURIComponent(id)}`;
};

// Each step's requests, as [method, path, body] or [method, path, undefined, raw text]; a function of nothing for a
// path that names a schedule added earlier.
const steps = [
  ["started", []],
  ["machineState", [["GET", "/machine/state"]]],
  ["machineSettings", [["POST", "/machine/settings", { fan: 45, steamPurgeMode: 1 }]]],
  ["machineSettingsFlows", [["POST", "/machine/settings", { usb: "enable", steamFlow: 1.5, hotWaterFlow: 8.5, flushFlow: 7.5 }]]],
  ["machineSettingsLenient", [["POST", "/machine/settings", { fan: 42.9, usb: true, steamFlow: "1.25" }]]],
  [
    "machineSettingsRefused",
    [
      ["POST", "/machine/settings", [45]],
      ["POST", "/machine/settings", undefined, "fan=45"],
      ["POST", "/machine/settings", { fan: "warm" }],
    ],
  ],
  [
    "advancedSettings",
    [["POST", "/machine/settings/advanced", { heaterPh1Flow: 2, heaterPh2Flow: 4.5, heaterIdleTemp: 96, heaterPh2Timeout: 6, heaterVoltage: 230, refillKitSetting: 1 }]],
  ],
  ["heaterVoltage200", [["POST", "/machine/settings/advanced", { heaterVoltage: 200 }]]],
  ["heaterVoltage1120", [["POST", "/machine/settings/advanced", { heaterVoltage: 1120 }]]],
  ["heaterVoltage300", [["POST", "/machine/settings/advanced", { heaterVoltage: 300 }]]],
  [
    "advancedSettingsRefused",
    [
      ["POST", "/machine/settings/advanced", { refillKitSetting: 3 }],
      ["POST", "/machine/settings/advanced", { heaterPh1Flow: 3, refillKitSetting: 7 }],
      ["POST", "/machine/settings/advanced", [1]],
    ],
  ],
  ["calibration", [["POST", "/machine/calibration", { flowMultiplier: 1.2 }]]],
  ["calibrationRefused", [["POST", "/machine/calibration", [1.2]]]],
  ["sensorFlow", [["PUT", "/machine/calibration/flow", { de1ReportedValue: 1, measuredValue: 1.0625 }]]],
  ["sensorPressure", [["PUT", "/machine/calibration/pressure", { de1ReportedValue: 8, measuredValue: 9 }]]],
  ["sensorTemperature", [["PUT", "/machine/calibration/temperature", { de1ReportedValue: 92, measuredValue: 92.5 }]]],
  [
    "sensorRefused",
    [
      ["PUT", "/machine/calibration/flow", { de1ReportedValue: 0, measuredValue: 1 }],
      ["PUT", "/machine/calibration/humidity", { de1ReportedValue: 1, measuredValue: 1 }],
      ["PUT", "/machine/calibration/flow", { de1ReportedValue: "1", measuredValue: 1 }],
      ["PUT", "/machine/calibration/flow", { de1ReportedValue: 1, measuredValue: 40000 }],
      ["PUT", "/machine/calibration/flow", [1, 1]],
    ],
  ],
  [
    "appSettings",
    [
      [
        "POST",
        "/settings",
        {
          automaticUpdateCheck: false,
          gatewayMode: "tracking",
          logLevel: "FINE",
          weightFlowMultiplier: 1.5,
          volumeFlowMultiplier: 0.35,
          hotWaterFlowMultiplier: 0.25,
          scalePowerMode: "displayOff",
          blockOnNoScale: true,
          blockTareDuringShot: true,
          stopHotWaterAtWeight: false,
          chargingMode: "longevity",
          nightModeEnabled: true,
          nightModeSleepTime: 1380,
          nightModeMorningTime: 360,
          lowBatteryBrightnessLimit: false,
          keepAwake: false,
          themeMode: "dark",
        },
      ],
    ],
  ],
  ["appSettingsPartChargingMode", [["POST", "/settings", { scalePowerMode: "disconnect", chargingMode: "fast" }]]],
  ["appSettingsPartMorningTime", [["POST", "/settings", { nightModeEnabled: false, nightModeMorningTime: 1440 }]]],
  [
    "appSettingsRefused",
    [
      ["POST", "/settings", { blockOnNoScale: "yes" }],
      ["POST", "/settings", { weightFlowMultiplier: "1" }],
      ["POST", "/settings", { gatewayMode: "remote" }],
      ["POST", "/settings", { themeMode: "sepia" }],
      ["POST", "/settings", [true]],
      ["POST", "/settings", undefined, "themeMode=dark"],
    ],
  ],
  ["appSettingsLenient", [["POST", "/settings", { scalePowerMode: "DISPLAY_OFF", logLevel: "LOUD" }]]],
  ["presenceSettings", [["POST", "/presence/settings", { userPresenceEnabled: true, sleepTimeoutMinutes: 30 }]]],
  ["presenceClampedHigh", [["POST", "/presence/settings", { sleepTimeoutMinutes: 300 }]]],
  ["presenceClampedLow", [["POST", "/presence/settings", { sleepTimeoutMinutes: -5 }]]],
  [
    "presenceRefused",
    [
      ["POST", "/presence/settings", { sleepTimeoutMinutes: 12.5 }],
      ["POST", "/presence/settings", { userPresenceEnabled: "yes", sleepTimeoutMinutes: 20 }],
      ["POST", "/presence/settings", [true]],
      ["POST", "/presence/settings", undefined, "sleep=20"],
    ],
  ],
  ["scheduleAdded", [["POST", "/presence/schedules", { time: "06:30", daysOfWeek: [5, 1, 3, 1], enabled: true, keepAwakeFor: 120 }]]],
  ["scheduleAddedEveryDay", [["POST", "/presence/schedules", { hour: 7, minute: 5 }]]],
  ["scheduleAddedOff", [["POST", "/presence/schedules", { time: "21:15", daysOfWeek: [6, 7], enabled: false, keepAwakeFor: 0 }]]],
  [
    "scheduleRefused",
    [
      ["POST", "/presence/schedules", { time: "06:30", keepAwakeFor: 721 }],
      ["POST", "/presence/schedules", { hour: 24, minute: 0 }],
      ["POST", "/presence/schedules", { time: "06:30", daysOfWeek: [0] }],
    ],
  ],
  ["scheduleChanged", [["PUT", () => schedule("scheduleAdded"), { enabled: false, keepAwakeFor: 0 }]]],
  ["scheduleChangedTime", [["PUT", () => schedule("scheduleAdded"), { time: "05:45", minute: 50, daysOfWeek: [4, 2], keepAwakeFor: 60 }]]],
  [
    "scheduleChangeRefused",
    [
      ["PUT", () => schedule("scheduleAdded"), { hour: 25 }],
      ["PUT", () => schedule("scheduleAdded"), { daysOfWeek: [8] }],
      ["PUT", () => schedule("scheduleAdded"), { keepAwakeFor: 721 }],
      ["PUT", "/presence/schedules/00000000-0000-4000-8000-000000000000", { enabled: true }],
    ],
  ],
  ["schedulesListed", [["GET", "/presence/schedules"]]],
  ["scheduleDeleted", [["DELETE", () => schedule("scheduleAddedEveryDay")]]],
  [
    "scheduleGone",
    [
      ["DELETE", () => schedule("scheduleAddedEveryDay")],
      ["PUT", () => schedule("scheduleAddedEveryDay"), { enabled: false }],
    ],
  ],
  ["machineDisconnected", [["PUT", "/devices/disconnect", { deviceId: "MockDe1" }]]],
  [
    "withoutMachine",
    [
      ["GET", "/machine/state"],
      ["POST", "/machine/settings", { fan: 40 }],
      ["POST", "/machine/settings", [40]],
      ["POST", "/machine/settings/advanced", { heaterIdleTemp: 97 }],
      ["POST", "/machine/settings/advanced", { refillKitSetting: 9 }],
      ["POST", "/machine/calibration", { flowMultiplier: 1.1 }],
      ["PUT", "/machine/calibration/flow", { de1ReportedValue: 1, measuredValue: 1 }],
      ["PUT", "/machine/calibration/flow", { de1ReportedValue: 0, measuredValue: 1 }],
      ["POST", "/settings", { themeMode: "light" }],
      ["POST", "/presence/settings", { sleepTimeoutMinutes: 45 }],
    ],
  ],
  ["scheduleAddedWithoutMachine", [["POST", "/presence/schedules", { time: "08:00", daysOfWeek: [1] }]]],
  ["scheduleDeletedWithoutMachine", [["DELETE", () => schedule("scheduleAddedWithoutMachine")]]],
];

// Decaid answers before its simulated machine has connected, and writes its defaults to the machine just after
// (`_setDe1DefaultsFor` in decaid:lib/src/controllers/de1_controller.defaults.dart): wait for the machine, then a
// moment more.
for (let waited = 0; ; waited += 1000) {
  if ((await send("GET", "/machine/settings")).response.status === 200) break;
  if (waited > 120_000) throw new Error("Decaid's simulated machine did not connect");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await new Promise((resolve) => setTimeout(resolve, 5000));

const recorded = {};
/** Each route's last answer, so one read again unchanged is kept as `"unchanged": true` in place of its body. */
const lastRead = new Map();
for (const [name, requests] of steps) {
  const exchanges = [];
  for (const [method, path, body, raw] of requests) {
    const exchange = await send(method, typeof path === "function" ? path() : path, body, raw);
    if (method === "POST" && exchange.request.path === "/presence/schedules" && exchange.response.status === 201) added[name] = exchange.response.body.id;
    exchanges.push(exchange);
  }
  // Disconnecting the machine is answered before Decaid has let it go; a moment more lets it settle.
  if (name === "machineDisconnected") await new Promise((resolve) => setTimeout(resolve, 3000));
  const answers = await reads();
  for (const [path, answer] of Object.entries(answers)) {
    const text = JSON.stringify(answer);
    if (lastRead.get(path) === text) answers[path] = { status: answer.status, unchanged: true };
    lastRead.set(path, text);
  }
  recorded[name] = { exchanges, reads: answers };
  process.stdout.write(`${name}: ${exchanges.map((exchange) => exchange.response.status).join(", ") || "-"}\n`);
}
writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
