import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { SimulatedTablet } from "../server/test/support/simulated-tablet.js";
import { useFreshServer } from "./support/fresh-server.js";
import { tabletAt } from "./support/tablets.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { field, rows } from "./support/locators.js";
import { expectTip } from "./support/tooltips.js";

// Lost Edits in each Library item's history in the management interface
// (ADR-0033). Two simulated tablets running the built plugin at a lab, and
// one at a cafe, hold a Bean; the lab's two edit the same field while
// offline, and the later edit wins everywhere, the earlier kept as a Lost
// Edit, which the Bean's History lists with the change it lost to. Nothing
// uses or dismisses one, and a Viewer reads it as anyone does. What is kept,
// and when, is server/test/library-lost-edits.test.ts's.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What each Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

test.beforeEach(({ page }) => signInAsAdmin(page));

test("an edit that lost, made through two tablets, is listed in its item's History with the change it lost to, and nothing lists, uses or dismisses it", async ({
  page,
  browser,
}) => {
  const { one, two, cafe, beanId } = await sharedBean(page, "Lost", "16101");
  await lostOver(page, beanId, one, two, cafe, { notes: "Peach and jasmine" }, { notes: "Blueberry" });

  // The Library has no page of them.
  await page.goto("/library");
  await expect(page.getByRole("navigation", { name: "Library" }).getByRole("link")).toHaveText(["Recipes", "Beans", "Bean Batches", "Grinders", "Profiles", "Baskets", "Tools"]);

  // Its Bean's page shows its history: joining the Library, each edit that was kept, and the one that lost.
  await page.goto(`/library/beans/${beanId}`);
  await expect(page.getByRole("heading", { name: "Lost Guji", level: 1 })).toBeVisible();
  // The Shots card above it loads on its own; settled first, it can't move the History card from under the pointer.
  await expect(page.getByRole("region", { name: "Shots" })).toContainText("No Shots yet");
  await expectTip(
    page.getByRole("main"),
    "History",
    /^Each change that was kept, the latest first, with the Machine or account it came from\. Its first is the Bean joining the Library\.A Lost Edit is a change that did not apply: .* To bring its value back, edit the Bean\.$/,
  );
  const history = rows(page.getByRole("table", { name: "History" }));
  await expect(history).toHaveCount(4);
  await expect(history.nth(0)).toContainText("Lost lab 2");
  await expect(history.nth(0)).toContainText("NotesBlueberry");
  // The value the later edit replaced, from the first tablet, with what it lost to.
  const lost = history.filter({ hasText: "Lost Edit" });
  await expect(lost).toHaveCount(1);
  await expect(lost.getByRole("cell").nth(1)).toHaveText("Lost lab 1");
  await expect(lost.getByRole("cell").nth(2)).toContainText("NotesPeach and jasmine");
  await expect(lost.getByRole("cell").nth(2)).toContainText("Lost to Blueberry, by Lost lab 2,");
  await expect(history.nth(3)).toContainText("Lost lab 1");
  await expect(history.nth(3)).toContainText("NameLost Guji");
  // It is read, never acted on.
  await expect(page.getByRole("table", { name: "History" }).getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Conflict")).toHaveCount(0);
  await expect(field(page.getByLabel("Coffee", { exact: true }), "Notes")).toHaveText("Blueberry");

  // A Viewer reads it the same.
  const invited = await page.request.post("/api/invites", { data: { email: "val@example.com", role: "viewer" } });
  const { link } = (await invited.json()) as { link: string };
  const valsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    const accepted = await valsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, {
      data: { name: "Val Viewer", password: "viewer password 1" },
    });
    expect(accepted.status()).toBe(201);
    const valsPage = await valsBrowser.newPage();
    await valsPage.goto(`/library/beans/${beanId}`);
    const theirs = rows(valsPage.getByRole("table", { name: "History" })).filter({ hasText: "Lost Edit" });
    await expect(theirs.getByRole("cell").nth(2)).toContainText("Lost to Blueberry, by Lost lab 2,");
  } finally {
    await valsBrowser.close();
  }

  // Editing the Bean brings the value back, as any edit: the Lost Edit stays in its history.
  const edited = await page.request.patch(`/api/beans/${beanId}`, { data: { content: { notes: "Peach and jasmine" } } });
  expect(edited.status()).toBe(200);
  await page.reload();
  await expect(history).toHaveCount(5);
  await expect(history.nth(0)).toContainText("You, here");
  await expect(history.nth(0)).toContainText("NotesPeach and jasmine");
  await expect(lost).toHaveCount(1);
});

/** A lab with two tablets and a cafe with one, each holding the same Bean, entered at both. */
async function sharedBean(page: Page, name: string, serial: string) {
  const lab = await createLocation(page, `${name} lab`);
  const cafeLocation = await createLocation(page, `${name} cafe`);
  const one = await tabletAt(page, server, `${name} lab 1`, lab, serial, tabletApi);
  const two = await tabletAt(page, server, `${name} lab 2`, lab, String(Number(serial) + 1), tabletApi);
  const cafe = await tabletAt(page, server, `${name} cafe 1`, cafeLocation, String(Number(serial) + 2), tabletApi);
  await one.addBean({ roaster: "Roux", name: `${name} Guji` });
  await expect.poll(() => two.beans().find((record) => record.name === `${name} Guji` && globalIdOf(record))).toBeTruthy();
  const beanId = globalIdOf(two.beans().find((record) => record.name === `${name} Guji`)!)!;
  await cafe.addBean({ roaster: "Roux", name: `${name} Guji` });
  // Each tablet's record carries the Bean's global id, the first tablet's by a write of its own, before it is edited by it.
  for (const tablet of [one, cafe]) await expect.poll(() => heldBean(tablet, beanId)).toBeDefined();
  return { one, two, cafe, beanId };
}

/**
 * The lab's two tablets, offline, edit the same field of the Bean, the first one first; its edit is taken in, then
 * the second's, made without seeing it, wins everywhere, and the first is kept as a Lost Edit.
 */
async function lostOver(page: Page, beanId: string, one: SimulatedTablet, two: SimulatedTablet, cafe: SimulatedTablet, earlier: Record<string, unknown>, later: Record<string, unknown>) {
  one.loseNetwork();
  two.loseNetwork();
  await one.editBean(heldBean(one, beanId)!.id, earlier);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await two.editBean(heldBean(two, beanId)!.id, later);
  one.restoreNetwork();
  await expect.poll(() => heldBean(cafe, beanId)).toMatchObject(earlier);
  two.restoreNetwork();
  for (const tablet of [one, two, cafe]) await expect.poll(() => heldBean(tablet, beanId)).toMatchObject(later);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/beans/${beanId}/history`)).json()) as { lostEdits: unknown[] }).lostEdits.length)
    .toBe(1);
}

function heldBean(tablet: SimulatedTablet, id: string): Record<string, unknown> | undefined {
  return tablet.beans().find((record) => globalIdOf(record) === id);
}
