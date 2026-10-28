import { expect, type Page, type Response } from "@playwright/test";

/** How often pages showing Machine status poll the server: `STATUS_POLL_MS` in `web/src/lib/use-polled.ts`. */
export const POLL_MS = 5_000;

/**
 * How often a Machine's page loads what changes less often than its status,
 * such as what its tablet reported: `DETAILS_POLL_MS` in
 * `web/src/lib/use-polled.ts`.
 */
export const DETAILS_POLL_MS = 30_000;

/**
 * How long a check passed to `afterStatusPolls` or `afterDetailsPolls` waits
 * before giving up, so the clock moves on again: given the config's 15 s, the
 * first check would use up the whole wait and the clock would move only once.
 */
export const CHECK_MS = 2_000;

/**
 * Starts watching for the page to be refused with 401 at a poll of `path`, a
 * REST API path such as `/api/machines/<id>`, or of a path under it, such as
 * the Machine's details, whose refusal sends the page to sign-in too. Call it
 * just before ending the page's session, and once it has ended, await the
 * function it returns: it moves the page's clock on by `POLL_MS` until the
 * refusal has arrived, and resolves with it. It moves the clock again until
 * then because a load under way as the session ended is answered 200, and
 * leaves no poll due at that move. The page must have opened with its clock
 * installed (`page.clock.install()`).
 */
export function nextRefusedPoll(page: Page, path: string): () => Promise<Response> {
  let refused: Response | undefined;
  const watch = (response: Response) => {
    const { pathname } = new URL(response.url());
    if ((pathname === path || pathname.startsWith(`${path}/`)) && response.status() === 401) refused ??= response;
  };
  page.on("response", watch);
  return async () => {
    try {
      await expect(async () => {
        // Once refused, the clock stays: a later poll would read the session again.
        if (!refused) await page.clock.fastForward(POLL_MS);
        await expect.poll(() => refused !== undefined, { timeout: CHECK_MS }).toBe(true);
      }).toPass({ timeout: 15_000 });
      return refused!;
    } finally {
      page.off("response", watch);
    }
  };
}

/**
 * Moves the page's clock on by `POLL_MS` until `check` passes, so what the
 * page loads that often, such as a Machine's status, shows up without waiting
 * for it. Each move starts at most one load: a load is due again only once
 * the last was answered, so a move made while one is under way starts none.
 * `check` should give up within `CHECK_MS`, so another move follows if the
 * server did not have the change yet. The page must have opened with its
 * clock installed (`page.clock.install()`).
 */
export async function afterStatusPolls(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.clock.fastForward(POLL_MS);
    await check();
  }).toPass({ timeout: 15_000 });
}

/**
 * Moves the page's clock on by `DETAILS_POLL_MS` until `check` passes, so
 * what the page loads that often shows up without waiting for it. Each move
 * starts at most one load; `check` should give up within `CHECK_MS`, so
 * another move follows if the server did not have the change yet. The page
 * must have opened with its clock installed (`page.clock.install()`).
 */
export async function afterDetailsPolls(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.clock.fastForward(DETAILS_POLL_MS);
    await check();
  }).toPass({ timeout: 15_000 });
}

/**
 * Hides the page's tab, or shows it again, as switching to another tab and
 * back does: the page's visibility as it reads it, and the event telling it.
 */
export async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
