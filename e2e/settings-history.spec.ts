import { randomUUID } from "node:crypto";
import { expect, type Locator, test } from "@playwright/test";
import { RawConnection, helloWith } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { createMachine, signInAsAdmin } from "./support/seed.js";
import { rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// A Machine's Settings History on its page (#433). A raw connection reports
// its collections, shaped as Decaid reports them (COLLECTIONS.md), and
// answers a Settings Edit as the plugin does; when the server received each
// is then set in PostgreSQL, so the page shows set times. Serials are made up.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });
test.use({ timezoneId: "America/New_York" });

test.beforeEach(({ page }) => signInAsAdmin(page));

const ADVANCED = { heaterPh1Flow: 2, heaterPh2Flow: 4, heaterIdleTemp: 99, heaterPh2Timeout: 1, heaterVoltage: 120, refillKitSetting: 0 };
const PRESENCE = { userPresenceEnabled: true, sleepTimeoutMinutes: 30, schedules: [] as unknown[] };
const SCALE = { name: "Mock Scale", id: "MockScale", state: "connected", type: "scale", available: true, connectionRole: "primary" };
const PLUGIN = { id: "visualizer.reaplugin", name: "Visualizer", version: "1.5.11", loaded: true, source: null };

test("the Machine page lists each change of what its Tablet reported, newest first, with what made it, and brief changes only on asking", async ({ page }) => {
  const { machine: { id }, token } = await createMachine(page, "Bar 6");
  const raw = await RawConnection.welcomed(server.url(), helloWith(token, { machine: { model: "DE1Pro", serial: "43301" }, tabletId: randomUUID() }));
  const report = (name: string, value: unknown, extra: Record<string, unknown> = {}) => raw.deliver({ type: "collection", id: randomUUID(), name, available: true, value, ...extra });
  for (const [name, value] of [
    ["advancedSettings", ADVANCED],
    ["presenceSettings", PRESENCE],
    ["pairedDevices", [SCALE]],
    ["plugins", [PLUGIN]],
  ] as const) {
    await report(name, value);
  }
  // A Settings Edit, its read-back naming it.
  const made = await page.request.post(`/api/machines/${id}/settings-edits`, { data: { collection: "advancedSettings", fields: { heaterPh1Flow: 3 }, expected: { heaterPh1Flow: 2 } } });
  expect(made.status()).toBe(201);
  const { settingsEdit } = (await made.json()) as { settingsEdit: { id: string } };
  await expect.poll(() => raw.messages.some((message) => (message as { type: string; id?: string }).type === "settingsEdit")).toBe(true);
  await report("advancedSettings", { ...ADVANCED, heaterPh1Flow: 3 }, { settingsEditId: settingsEdit.id });
  await raw.deliver({ type: "settingsEdited", id: settingsEdit.id, outcome: "written", values: { heaterPh1Flow: 3 } });
  // Changes on the Tablet: a wake schedule added, the refill kit on automatic as the machine reconnects and back, the
  // scale left out while it connects and back, and a plugin updated.
  await report("presenceSettings", { ...PRESENCE, schedules: [{ id: "sched-morning", time: "06:30", daysOfWeek: [1, 2, 3, 4, 5], enabled: true }] });
  await report("advancedSettings", { ...ADVANCED, heaterPh1Flow: 3, refillKitSetting: 2 });
  await report("advancedSettings", { ...ADVANCED, heaterPh1Flow: 3 });
  await report("pairedDevices", []);
  await report("pairedDevices", [{ ...SCALE, state: "connecting", available: false }]);
  await report("plugins", [{ ...PLUGIN, version: "1.6.0" }]);
  await raw.close();
  // Received from 09:00 to 09:40 UTC on 8 November 2026, the brief changes changed back within moments.
  const database = await server.connectDatabase();
  try {
    await database.query(
      `UPDATE settings_history SET received_at = '2026-11-08T09:00:00Z'::timestamptz + timeline.at * interval '1 minute'
       FROM (SELECT id, (ARRAY[0, 0, 0, 0, 10, 20, 30, 30.5, 35, 35.25, 40])[row_number() OVER (ORDER BY id)] AS at FROM settings_history WHERE machine_id = $1) AS timeline
       WHERE settings_history.id = timeline.id`,
      [id],
    );
  } finally {
    await database.end();
  }

  await page.goto(`/machines/${id}`);
  const history = page.getByRole("region", { name: "Settings History" });
  await expectTip(history, "Settings History", /^Each change of what the Machine's Tablet reported.+tied to no person\.A change is received about 30 to 60 seconds after/);
  await expect(history.getByRole("columnheader")).toHaveText(["Received", "Section", "Field", "Change", "Made by"]);
  await expectRows(history, [
    ["Nov 8, 2026, 4:40:00 AM", "Plugins", "Visualizer", "version: 1.5.11 to 1.6.0", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:20:00 AM", "Tablet Settings: Presence", "Wake schedule at 06:30", "Added: Time: 06:30; Days: Mon, Tue, Wed, Thu, Fri; On: On; Keeps awake for: None", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:10:00 AM", "Machine Settings: Advanced", "Heater warmup flow", "2 ml/s to 3 ml/s", "Settings Edit by You"],
  ]);

  await history.getByLabel("Show brief changes").check();
  await expectRows(history, [
    ["Nov 8, 2026, 4:40:00 AM", "Plugins", "Visualizer", "version: 1.5.11 to 1.6.0", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:35:00 AM", "Paired devices", "Mock Scale", "Briefly removed, back at Nov 8, 2026, 4:35:15 AM", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:30:00 AM", "Machine Settings: Advanced", "Refill kit", "Briefly Force Off to Auto-Detect, back at Nov 8, 2026, 4:30:30 AM", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:20:00 AM", "Tablet Settings: Presence", "Wake schedule at 06:30", "Added: Time: 06:30; Days: Mon, Tue, Wed, Thu, Fri; On: On; Keeps awake for: None", "Outside Decent Sync"],
    ["Nov 8, 2026, 4:10:00 AM", "Machine Settings: Advanced", "Heater warmup flow", "2 ml/s to 3 ml/s", "Settings Edit by You"],
  ]);
});

async function expectRows(region: Locator, expected: string[][]): Promise<void> {
  await expect(rows(region.getByRole("table", { name: "Settings History" }))).toHaveText(expected.map((cells) => cells.join("")));
}
