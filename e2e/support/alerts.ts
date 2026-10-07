import type { Page } from "@playwright/test";

/**
 * Records the text of every alert the page shows from now on, however
 * briefly, until it loads another document; moving between the interface's
 * pages keeps recording. Returns a function that reads them, in the order
 * they were first shown.
 */
export async function recordAlerts(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const shown: string[] = [];
    const record = () => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        const text = alert.textContent ?? "";
        if (!shown.includes(text)) shown.push(text);
      }
    };
    record();
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
    Object.assign(window, { shownAlerts: shown });
  });
  return () => page.evaluate(() => (window as unknown as { shownAlerts: string[] }).shownAlerts);
}
