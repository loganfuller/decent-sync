import type { Locator } from "@playwright/test";

// Where elements are on the page, measured against each other (#635).

/** An element's box as Playwright's `boundingBox()` gives it: in CSS pixels, from the viewport's top left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Each element's box, all of them measured in one layout, for checks that
 * compare where one element is with where another is. Each `boundingBox()`
 * is a trip to the browser of its own, and the page may scroll or reflow
 * between two of them: a tab whose content shrinks while it loads pulls the
 * page's scroll position up and back, moving whatever is measured second.
 * Each locator must match one element, and is waited for until it does.
 * As with `boundingBox()`, an element that isn't laid out, as one hidden by
 * `display: none` or no longer on the page, has no box: null.
 */
export async function boxes<T extends Locator[]>(...elements: T): Promise<{ [K in keyof T]: Box | null }> {
  const [first] = elements;
  if (!first) return [] as { [K in keyof T]: Box | null };
  const handles = await Promise.all(elements.map((element) => element.elementHandle()));
  try {
    const measured = await first.page().evaluate(
      (all) =>
        all.map((element) => {
          if (!element.isConnected || element.getClientRects().length === 0) return null;
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      handles,
    );
    return measured as { [K in keyof T]: Box | null };
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
}
