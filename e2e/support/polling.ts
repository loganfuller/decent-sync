import type { Page, Response } from "@playwright/test";

/** How often pages showing Machine status poll the server: `STATUS_POLL_MS` in `web/src/lib/use-polled.ts`. */
export const POLL_MS = 5_000;

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
