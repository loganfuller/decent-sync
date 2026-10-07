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
 * Waits for the page to be refused with 401 at its next poll of `path`, a
 * REST API path such as `/api/machines/<id>`. Call it just before ending the
 * page's session and await it after: it fails unless the refusal comes
 * within one poll interval, with a little to spare for the requests.
 */
export function nextRefusedPoll(page: Page, path: string): Promise<Response> {
  return page.waitForResponse((response) => new URL(response.url()).pathname === path && response.status() === 401, {
    timeout: POLL_MS + 2_000,
  });
}

/**
 * Moves the page's clock on by `DETAILS_POLL_MS` until `check` passes, so
 * what the page loads that often shows up without waiting for it. Each move
 * starts one load; `check` should give up within a few seconds, so another
 * move follows if the server did not have the change yet. The page must have
 * opened with its clock installed (`page.clock.install()`).
 */
export async function afterDetailsPolls(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.clock.fastForward(DETAILS_POLL_MS);
    await check();
  }).toPass({ timeout: 15_000 });
}
