import { expect, test } from "@playwright/test";
import { useFreshServer } from "./support/fresh-server.js";
import { batchLeft, batchLocations, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";

// A Bean Batch brought to a Machine's Location by a scan of its QR code on
// the Machine's tablet (ticket #708, ADR-0030): the management interface
// shows it as one line of the batch's history, naming the Machine it was
// scanned on and the barista named on that Machine, and no account. The
// request and its rules are server/test/skin-batch-scans.test.ts's. Heartbeats
// every 30 s, as a call to the plugin's endpoint runs the tablet at real
// time. Serials are made up, from 70851.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "30" } });

/** What the Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

test.beforeEach(({ page }) => signInAsAdmin(page));

test("a batch a scan brought is one line of its history, a move of all naming the Machine it was scanned on and the barista named on it", async ({ page }) => {
  const lab = await createLocation(page, "Roastery Lab");
  const downtown = await createLocation(page, "Downtown");
  const tablet = await tabletAt(page, server, "Bar Left", downtown, "70851", tabletApi);
  const created = async <T>(path: string, data: unknown) => {
    const response = await page.request.post(path, { data });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as T;
  };
  const { bean } = await created<{ bean: { id: string } }>("/api/beans", { content: { roaster: "Lantern Coffee Roasters", name: "Ethiopia Guji Natural" } });
  const { batch } = await created<{ batch: { id: string } }>("/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-11-18", batchCode: "LR-0412" },
    locations: [{ locationId: lab.id, remainingWeight: 2920 }],
  });

  // Sam is the barista named on the Machine as the bucket's label is scanned there.
  const workflow = tablet.workflow();
  tablet.setWorkflow({ ...workflow, context: { ...(workflow.context as Record<string, unknown>), baristaName: "Sam" } });
  const answer = await tablet.callEndpoint("scan", { method: "PUT", body: { text: "https://lantern.example/batches/LR-0412" } });
  expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { outcome: "moved", batchId: expect.any(String), beanId: expect.any(String) }]);

  await page.goto(`/library/bean-batches/${batch.id}`);
  await expect(batchLocations(page).getByRole("listitem")).toHaveText([/^Downtown2920 g/]);
  // The scan moved all of it from the lab, which its line says (#726).
  await expect(batchLeft(page)).toHaveText([/^Roastery LabMoved to Downtown \S/]);
  const history = rows(page.getByRole("table", { name: "History" }));
  // The latest change: made on the Machine, by the barista named there, where the batch's creation names an account.
  await expect(history.first().getByRole("cell").nth(1)).toHaveText("Bar Left, by Sam");
  await expect(history.first().getByRole("link", { name: "Bar Left" })).toHaveAttribute("href", /^\/machines\/[0-9a-f-]{36}$/);
  await expect(history.first()).toContainText("Batch MoveMoved all, 2920 g, from Roastery Lab to Downtown");
  await expect(history.last().getByRole("cell").nth(1)).toHaveText("You, here");
});
