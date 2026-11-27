import { type Locator, type Page, expect } from "@playwright/test";

// Where elements are on the page, measured against each other (#635).

/** An element's box as Playwright's `boundingBox()` gives it for an element in the page's main frame: in CSS pixels, from the viewport's top left corner. */
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
 * between two of them, moving whatever is measured second.
 * Each locator must match one element, and is waited for until it does.
 * Main frame only: inside an iframe, `getBoundingClientRect()` is from that
 * frame's corner, so the box would be off by where the frame is.
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

/** That nothing on the page is wider than the screen, `width` CSS pixels wide, so the page doesn't scroll sideways. */
export async function expectFits(page: Page, width: number) {
  const measured = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(measured, `${new URL(page.url()).pathname} fits the screen`).toEqual({ scrollWidth: width, clientWidth: width });
}

/** The contrast of an element's text against its own ground, by WCAG's formula, as the browser computed both. */
export async function textContrast(element: Locator): Promise<number> {
  return element.evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const luminance = (colour: string, over?: string) => {
      context.clearRect(0, 0, 1, 1);
      for (const each of over === undefined ? [colour] : [over, colour]) {
        context.fillStyle = each;
        context.fillRect(0, 0, 1, 1);
      }
      const [red, green, blue] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
    };
    // Its ground is its own, drawn over the page's, as a chip's may be see-through.
    const page = getComputedStyle(document.body).backgroundColor;
    const [text, ground] = [luminance(getComputedStyle(node).color, page), luminance(getComputedStyle(node).backgroundColor, page)];
    return (Math.max(text, ground) + 0.05) / (Math.min(text, ground) + 0.05);
  });
}
