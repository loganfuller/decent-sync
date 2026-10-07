import type { Page } from "@playwright/test";

/**
 * Records the text of every alert the page shows from now on, until it loads
 * another document; moving between the interface's pages keeps recording.
 * An alert counts when an element with role "alert" is added, gains that
 * role, or has its text changed, even if it is removed again before the
 * observer runs. Returns a function that reads them, in the order first seen.
 */
export async function recordAlerts(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const shown: string[] = [];
    const record = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return;
      for (const alert of [element.closest('[role="alert"]'), ...element.querySelectorAll('[role="alert"]')]) {
        const text = alert?.textContent ?? "";
        if (text && !shown.includes(text)) shown.push(text);
      }
    };
    record(document.body);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        record(mutation.target);
        mutation.addedNodes.forEach(record);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["role"] });
    Object.assign(window, { shownAlerts: shown });
  });
  return () => page.evaluate(() => (window as unknown as { shownAlerts: string[] }).shownAlerts);
}
