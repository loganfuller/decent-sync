import { expect, type Page, test } from "@playwright/test";
import { globalIdOf } from "@decent-sync/protocol";
import { useFreshServer } from "./support/fresh-server.js";
import { batchAt, batchLeft, batchLocations, field, rows } from "./support/locators.js";
import { createLocation, signInAsAdmin } from "./support/seed.js";
import { tabletAt } from "./support/tablets.js";
import { roastDay } from "./support/days.js";

// Moving a Bean Batch between Locations in the management interface (ticket
// #704, ADR-0037): each Location in a batch's Where it is has Move to…,
// whose dialog moves all of it or part of its weight to another Location,
// saying first what each Location will hold; the move is one line of the
// batch's history; a batch with no weight moves as all or some of it; Staff
// move a batch from or to a Location they work at; and the page offers no
// other way to put a batch at a second Location. With one Location to move
// to, the dialog opens with it chosen; Part of it, once chosen, takes the
// focus to its weight; and a move of part says the tablets at both Locations
// show the new weights (#726). The rules themselves are
// server/test/library-moves.test.ts's. Serials are made up, from 70451.
const server = useFreshServer({ env: { SYNC_HEARTBEAT_SECONDS: "1" } });

/** What each Machine's tablet holds over derivedDe1Pro()'s: no library. */
const tabletApi = { "/beans": [], "/bean-batches": [], "/grinders": [], "/profiles": [] };

const sam = { name: "Sam Staff", email: "sam@example.com", password: "staff password 1" };

type Location = Awaited<ReturnType<typeof createLocation>>;

test.beforeEach(({ page }) => signInAsAdmin(page));

/** The Locations every test here uses, made once: the first test of the spec creates them. */
async function locations(page: Page): Promise<{ downtown: Location; riverside: Location; belmont: Location }> {
  const { locations: listed } = (await (await page.request.get("/api/locations")).json()) as { locations: Location[] };
  const named = async (name: string) => listed.find((location) => location.name === name) ?? (await createLocation(page, name));
  return { downtown: await named("Downtown"), riverside: await named("Riverside"), belmont: await named("Belmont") };
}

async function post<T>(page: Page, path: string, data: unknown, status = 201): Promise<T> {
  const response = await page.request.post(path, { data });
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

/** A batch of a new Bean of that name, created at the Location with the weight, or untracked with null. */
async function createBatchAt(page: Page, name: string, location: Location, remainingWeight: number | null, content: Record<string, unknown> = {}): Promise<string> {
  const { bean } = await post<{ bean: { id: string } }>(page, "/api/beans", { content: { roaster: "Lantern Coffee Roasters", name } });
  const { batch } = await post<{ batch: { id: string } }>(page, "/api/bean-batches", {
    beanId: bean.id,
    content: { roastDate: "2026-11-18", ...content },
    locations: [{ locationId: location.id, remainingWeight }],
  });
  return batch.id;
}

/** The buttons of a Location's block for an account that may change the batch there, as its text runs between its weight and its line. */
const BUTTONS = "Move to…Enter weightFinish here";

/** Opens the move dialog of the batch's page for the Location, and chooses the Location to move to. */
async function openMove(page: Page, from: string, to: RegExp) {
  await page.getByRole("region", { name: "Where it is" }).getByRole("button", { name: `Move it from ${from}` }).click();
  const dialog = page.getByRole("dialog", { name: "Move this batch" });
  await dialog.getByLabel(`Move from ${from} to`).click();
  await page.getByRole("option", { name: to }).click();
  return dialog;
}

test("an Admin moves part of a batch's weight to another Location, then all of it, each said beforehand and kept as one line of its history, the tablets where it left archiving it", async ({ page }) => {
  const { downtown, riverside } = await locations(page);
  const downtownTablet = await tabletAt(page, server, "Bar Left", downtown, "70451", tabletApi);
  const riversideTablet = await tabletAt(page, server, "Riverside Bar", riverside, "70452", tabletApi);
  const id = await createBatchAt(page, "Ethiopia Guji Natural", downtown, 2920, { batchCode: "LR-0412", weight: 6000 });
  expect((await page.request.put(`/api/bean-batches/${id}/locations/${riverside.id}`, { data: { atLocation: true, remainingWeight: 428 } })).status()).toBe(200);
  // Two Recipes at Downtown name the batch, one of them in a Recipe Slot.
  await post(page, "/api/recipes", { locationId: downtown.id, slot: 2, content: { name: "Guji Espresso", beanBatchId: id } });
  await post(page, "/api/recipes", { locationId: downtown.id, slot: null, content: { name: "Guji Long", beanBatchId: id } });
  const held = (tablet: typeof downtownTablet) => tablet.batches().find((record) => globalIdOf(record) === id);
  await expect.poll(() => held(downtownTablet)?.archived).toBe(false);
  await expect.poll(() => held(riversideTablet)?.archived).toBe(false);

  await page.goto(`/library/bean-batches/${id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  const where = batchLocations(page);
  await expect(field(whereItIs, "Remaining in all")).toHaveText("3348 g");
  // Each Location has Move to… before Enter weight and Finish here, and the page offers no other way to add the batch anywhere.
  await expect(where.getByRole("button")).toHaveText(["Move to…", "Enter weight", "Finish here", "Move to…", "Enter weight", "Finish here"]);
  await expect(page.getByRole("form", { name: "Add it at a Location" })).toHaveCount(0);

  // Part of it: the dialog names the batch and what Downtown has, each Location with what it has, and what each will hold.
  await whereItIs.getByRole("button", { name: "Move it from Downtown" }).click();
  const dialog = page.getByRole("dialog", { name: "Move this batch" });
  await expect(dialog).toContainText(`Ethiopia Guji Natural LR-0412, roasted ${roastDay("2026-11-18")}. Downtown has 2920 g of it.`);
  // With two Locations to move it to, none is chosen for the account.
  await expect(dialog.getByLabel("Move from Downtown to")).toHaveText("Choose a Location");
  await dialog.getByLabel("Move from Downtown to").click();
  await expect(page.getByRole("option")).toHaveText(["Belmont, which has none", "Riverside, which has 428 g"]);
  await page.getByRole("option", { name: /^Riverside/ }).click();
  await expect(dialog.getByRole("radio", { name: "Part of it" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "All of it, 2920 g" })).not.toBeChecked();
  // Part of it, chosen again after All of it, takes the focus to its weight (#726).
  await dialog.getByRole("radio", { name: "All of it, 2920 g" }).check();
  await expect(dialog.getByLabel("Weight to move, in grams")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Part of it" }).check();
  await expect(dialog.getByLabel("Weight to move, in grams")).toBeFocused();
  const outcome = dialog.getByRole("status", { name: "What the move will do" });
  const submit = dialog.getByRole("button", { name: /^Move / });
  await expect(submit).toBeDisabled();
  // An amount equal to what is there is not a part of it.
  await dialog.getByLabel("Weight to move, in grams").fill("2920");
  await expect(outcome).toHaveText("Enter a weight above 0 and below 2920 g. To move everything, choose All of it.");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("Weight to move, in grams").fill("500");
  await expect(outcome.getByRole("listitem")).toHaveText([
    "Downtown will have 2420 g.",
    "Riverside will have 928 g: the 428 g there now and these 500 g.",
    "Tablets at both Locations show the new weights.",
  ]);
  await dialog.getByRole("button", { name: "Move 500 g to Riverside" }).click();
  await expect(dialog).toHaveCount(0);

  // Downtown's weight fell by the amount and Riverside's rose by it, and the total is as it was.
  await expect(where.getByRole("listitem")).toHaveText([
    new RegExp(`^Downtown2420 g${BUTTONS}2920 g entered .+ by you\\. Since: 500 g moved to Riverside\\.$`),
    new RegExp(`^Riverside928 g${BUTTONS}428 g entered .+ by you\\. Since: 500 g moved from Downtown\\.$`),
  ]);
  await expect(field(whereItIs, "Remaining in all")).toHaveText("3348 g");
  const history = page.getByRole("table", { name: "History" });
  await expect(rows(history).first()).toContainText("You, here");
  await expect(rows(history).first()).toContainText("Batch MoveMoved 500 g from Downtown to Riverside");

  // All of it: the dialog says what Riverside will hold, that Downtown stops listing it, and the Recipes there that name it.
  const all = await openMove(page, "Downtown", /^Riverside, which has 928 g/);
  await all.getByRole("radio", { name: "All of it, 2420 g" }).check();
  await expect(all.getByLabel("Weight to move, in grams")).toHaveCount(0);
  await expect(all.getByRole("status", { name: "What the move will do" }).getByRole("listitem")).toHaveText([
    "Riverside will have 3348 g: the 928 g there now and these 2420 g.",
    "Downtown stops listing the batch, and its tablets stop offering it.",
    '2 Recipes at Downtown name it and will go on naming it. The one in a Recipe Slot will read "Batch finished here".',
  ]);
  await all.getByRole("button", { name: "Move all to Riverside" }).click();
  await expect(all).toHaveCount(0);
  await expect(where.getByRole("listitem")).toHaveText([new RegExp(`^Riverside3348 g${BUTTONS}428 g entered .+ by you\\. Since: 2920 g moved from Downtown\\.$`)]);
  await expect(field(whereItIs, "Remaining in all")).toHaveText("3348 g");
  // The Location it left says the move took it, and where to (#726).
  await expect(batchLeft(page)).toHaveText([/^DowntownMoved to Riverside \S/]);
  await expect(batchLeft(page).getByRole("link", { name: "Downtown" })).toHaveAttribute("href", `/locations/${downtown.id}`);
  await expect(rows(history).first()).toContainText("Batch MoveMoved all, 2420 g, from Downtown to Riverside");
  // One line for each move: no finish or weight is listed apart from them.
  await expect(history.getByText("Batch Move", { exact: true })).toHaveCount(2);
  await expect(history.getByText("At Downtown", { exact: true })).toHaveCount(1);

  // Downtown's tablet archives its record, as a finish there does, and Riverside's keeps it.
  await expect.poll(() => held(downtownTablet)?.archived, { timeout: 15_000 }).toBe(true);
  expect(held(riversideTablet)?.archived).toBe(false);
  // The Recipe in a slot at Downtown reads "Batch finished here".
  await page.goto(`/locations/${downtown.id}`);
  await expect(rows(page.getByRole("table", { name: "Recipe Slots" })).filter({ hasText: "Guji Espresso" })).toContainText("Batch finished here");

  // Sent back in part to the Location it was finished at: it is added there again, its count starting from what arrives.
  await page.goto(`/library/bean-batches/${id}`);
  const back = await openMove(page, "Riverside", /^Downtown, which has none/);
  await back.getByLabel("Weight to move, in grams").fill("300");
  await expect(back.getByRole("status", { name: "What the move will do" }).getByRole("listitem")).toHaveText([
    "Riverside will have 3048 g.",
    "Downtown will have 300 g.",
    "Tablets at both Locations show the new weights.",
  ]);
  await back.getByRole("button", { name: "Move 300 g to Downtown" }).click();
  await expect(where.getByRole("listitem")).toHaveText([
    new RegExp(`^Downtown300 g${BUTTONS}300 g arrived from Riverside .+\\. No Shots since\\.$`),
    new RegExp(`^Riverside3048 g${BUTTONS}428 g entered .+ by you\\. Since: 2920 g moved from Downtown, 300 g moved to Downtown\\.$`),
  ]);
  // Back at Downtown, it has left no Location.
  await expect(batchLeft(page)).toHaveCount(0);
  await expect.poll(() => held(downtownTablet)?.archived, { timeout: 15_000 }).toBe(false);
});

test("while the page reads a batch's history again after a move of all, a Location it had left keeps its line and the one just left says nothing of what took it, rather than \"Finished\"", async ({ page }) => {
  const { downtown, riverside, belmont } = await locations(page);
  const id = await createBatchAt(page, "Held Guji", downtown, 800);
  await post(page, `/api/bean-batches/${id}/moves`, { fromLocationId: downtown.id, toLocationId: riverside.id, amount: 300 }, 200);
  const finished = await page.request.put(`/api/bean-batches/${id}/locations/${riverside.id}`, { data: { atLocation: false } });
  expect(finished.status(), await finished.text()).toBe(200);
  await page.goto(`/library/bean-batches/${id}`);
  await expect(batchLeft(page)).toHaveText([/^RiversideFinished \S/]);

  // The history is held back, as a slow answer would be.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === `/api/bean-batches/${id}/history`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  const all = await openMove(page, "Downtown", /^Belmont/);
  await all.getByRole("radio", { name: "All of it, 500 g" }).check();
  await all.getByRole("button", { name: "Move all to Belmont" }).click();
  await expect(all).toHaveCount(0);
  await expect(batchAt(page, "Belmont")).toBeVisible();
  await expect(batchLeft(page)).toHaveText(["Downtown", /^RiversideFinished \S/]);
  // Released, the route lets every later read through, and the line says the move took it.
  release();
  await expect(batchLeft(page)).toHaveText([/^DowntownMoved to Belmont \S/, /^RiversideFinished \S/]);
});

test("a batch with no weight where it is moves as all of it or some of it, with no amount, and not as some to a Location it is at already", async ({ page }) => {
  const { downtown } = await locations(page);
  const id = await createBatchAt(page, "House Espresso", downtown, null, { batchCode: "LR-0405" });

  await page.goto(`/library/bean-batches/${id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  const where = batchLocations(page);
  const dialog = await openMove(page, "Downtown", /^Belmont, which has none/);
  await expect(dialog).toContainText(`House Espresso LR-0405, roasted ${roastDay("2026-11-18")}. It is at Downtown, with no weight entered there.`);
  // All of it or Some of it, and no weight to type.
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(dialog.getByRole("radio", { name: "All of it" })).not.toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Some of it" })).toBeChecked();
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
  const outcome = dialog.getByRole("status", { name: "What the move will do" });
  await expect(outcome.getByRole("listitem")).toHaveText([
    "The batch stays at Downtown and is added at Belmont.",
    'No weight is entered for it at Downtown, so none moves. It reads "Not tracked" at Belmont until a weight is entered there.',
    "To move a known amount, enter its weight at Downtown first.",
  ]);
  await dialog.getByRole("button", { name: "Move some to Belmont" }).click();
  await expect(where.getByRole("listitem")).toHaveText([`BelmontNot tracked${BUTTONS}`, `DowntownNot tracked${BUTTONS}`]);
  await expect(rows(page.getByRole("table", { name: "History" })).first()).toContainText("Batch MoveMoved some from Downtown to Belmont, with no weight entered");

  // Some of it to a Location it is at already would change nothing.
  const again = await openMove(page, "Downtown", /^Belmont, where it is not tracked/);
  await expect(again.getByRole("status", { name: "What the move will do" })).toHaveText("It is at Belmont already. Move all of it, or choose another Location.");
  await expect(again.getByRole("button", { name: "Move some to Belmont" })).toBeDisabled();
  // All of it finishes it at Downtown, moving no weight.
  await again.getByRole("radio", { name: "All of it" }).check();
  await expect(again.getByRole("status", { name: "What the move will do" }).getByRole("listitem")).toHaveText([
    "The batch stays at Belmont, as it is.",
    "Downtown stops listing the batch, and its tablets stop offering it.",
    "No weight is entered for it at Downtown, so none moves.",
  ]);
  await again.getByRole("button", { name: "Move all to Belmont" }).click();
  await expect(where.getByRole("listitem")).toHaveText([`BelmontNot tracked${BUTTONS}`]);
  await expect(field(whereItIs, "Remaining in all")).toHaveText("Not tracked");
  await expect(batchLeft(page)).toHaveText([/^DowntownMoved to Belmont \S/]);
});

test("Staff move a batch from a Location they work at to any other, and from another to their own, and change nothing else at a Location they do not work at", async ({ page, browser }) => {
  const { downtown, riverside } = await locations(page);
  const id = await createBatchAt(page, "Staff Kenya", downtown, 1000);
  expect((await page.request.post(`/api/bean-batches/${id}/moves`, { data: { fromLocationId: downtown.id, toLocationId: riverside.id, amount: 400 } })).status()).toBe(200);

  const { link } = await post<{ link: string }>(page, "/api/invites", { email: sam.email, role: "staff", locationIds: [riverside.id] });
  const samsBrowser = await browser.newContext({ baseURL: server.url() });
  try {
    expect((await samsBrowser.request.post(`/api/invite-links/${new URL(link).pathname.split("/").at(-1)}/accept`, { data: sam })).status()).toBe(201);
    const samsPage = await samsBrowser.newPage();
    await samsPage.goto(`/library/bean-batches/${id}`);
    const where = batchLocations(samsPage);
    // At Downtown, where Sam does not work, only a move, and only to Sam's own Location; at Riverside, everything.
    await expect(batchAt(samsPage, "Downtown").getByRole("button")).toHaveText(["Move to…"]);
    await expect(batchAt(samsPage, "Riverside").getByRole("button")).toHaveText(["Move to…", "Enter weight", "Finish here"]);

    await where.getByRole("button", { name: "Move it from Downtown" }).click();
    const receiving = samsPage.getByRole("dialog", { name: "Move this batch" });
    // The one Location Sam may move it to is chosen as the dialog opens (#726), and is the only one offered.
    await expect(receiving.getByLabel("Move from Downtown to")).toHaveText("Riverside, which has 400 g");
    await receiving.getByLabel("Move from Downtown to").click();
    await expect(samsPage.getByRole("option")).toHaveText(["Riverside, which has 400 g"]);
    await samsPage.keyboard.press("Escape");
    await receiving.getByLabel("Weight to move, in grams").fill("100");
    await receiving.getByRole("button", { name: "Move 100 g to Riverside" }).click();
    await expect(batchAt(samsPage, "Riverside")).toContainText("Riverside500 g");
    await expect(batchAt(samsPage, "Downtown")).toContainText("Downtown500 g");

    // From Sam's own Location, to any other.
    await where.getByRole("button", { name: "Move it from Riverside" }).click();
    const sending = samsPage.getByRole("dialog", { name: "Move this batch" });
    await sending.getByLabel("Move from Riverside to").click();
    await expect(samsPage.getByRole("option")).toHaveText(["Belmont, which has none", "Downtown, which has 500 g"]);
    await samsPage.getByRole("option", { name: /^Belmont/ }).click();
    await sending.getByLabel("Weight to move, in grams").fill("50");
    await sending.getByRole("button", { name: "Move 50 g to Belmont" }).click();
    await expect(batchAt(samsPage, "Belmont")).toContainText("Belmont50 g");
    // Belmont is not Sam's, so the batch there is Sam's to move only to Riverside, and not to weigh or finish.
    await expect(batchAt(samsPage, "Belmont").getByRole("button")).toHaveText(["Move to…"]);
    // The move is Sam's own in its history.
    await expect(rows(samsPage.getByRole("table", { name: "History" })).first()).toContainText("You, here");
    await expect(rows(samsPage.getByRole("table", { name: "History" })).first()).toContainText("Moved 50 g from Riverside to Belmont");
  } finally {
    await samsBrowser.close();
  }
});

test("a batch at no Location is offered a Location to add it at, and one at a Location is not", async ({ page }) => {
  const { downtown } = await locations(page);
  const id = await createBatchAt(page, "Unplaced Sidra", downtown, 250);
  expect((await page.request.put(`/api/bean-batches/${id}/locations/${downtown.id}`, { data: { atLocation: false } })).status()).toBe(200);

  await page.goto(`/library/bean-batches/${id}`);
  const whereItIs = page.getByRole("region", { name: "Where it is" });
  await expect(whereItIs).toContainText("It is at no Location.");
  const adding = page.getByRole("form", { name: "Add it at a Location" });
  await adding.getByLabel("Add it at").click();
  await page.getByRole("option", { name: "Belmont" }).click();
  await adding.getByRole("button", { name: "Add" }).click();
  await expect(batchAt(page, "Belmont")).toHaveText(`BelmontNot tracked${BUTTONS}`);
  // At a Location now, it reaches another only by a move.
  await expect(adding).toHaveCount(0);
  await expect(whereItIs.getByRole("button", { name: "Move it from Belmont" })).toBeVisible();
});
