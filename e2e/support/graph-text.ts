import type { Locator } from "@playwright/test";

// What a Profile's graph draws over what (#621), measured on the page.

/**
 * Each pair on the graph in `scope` where one thing is drawn over another,
 * in words, none where all is clear: a piece of its text over another, or a
 * Draft's handle, its tag or its bracket over a piece of text. Text is
 * measured a little inside its line's height, which is taller than its
 * letters, so two rows that only touch are not a pair.
 */
export async function graphClashes(scope: Locator): Promise<string[]> {
  return scope.locator("figure").first().evaluate((figure) => {
    const svg = figure.querySelector("svg[data-graph-end]");
    if (!svg) return ["no graph drawn"];
    type Piece = { what: string; text: boolean; left: number; right: number; top: number; bottom: number };
    const piece = (element: Element, what: string, text: boolean): Piece => {
      const box = element.getBoundingClientRect();
      const inset = text ? 2 : 0;
      return { what, text, left: box.left, right: box.right, top: box.top + inset, bottom: box.bottom - inset };
    };
    const words = (element: Element) => [...element.childNodes].flatMap((node) => (node.nodeType === Node.TEXT_NODE ? [node.textContent ?? ""] : [])).join("");
    const pieces = [
      ...[...svg.querySelectorAll("text")].filter((text) => words(text).trim() !== "").map((text) => piece(text, `"${words(text)}"`, true)),
      ...[...figure.querySelectorAll("[data-handle]")].map((handle) => piece(handle, `the ${handle.getAttribute("data-handle")} handle`, false)),
      ...[...figure.querySelectorAll("[data-handle-tag]")].map((tag) => piece(tag, `the ${tag.getAttribute("data-handle-tag")} handle's tag`, false)),
    ].filter((each) => each.right > each.left && each.bottom > each.top);
    const clashes: string[] = [];
    pieces.forEach((one, index) => {
      for (const other of pieces.slice(index + 1)) {
        if (!one.text && !other.text) continue;
        if (one.left < other.right && other.left < one.right && one.top < other.bottom && other.top < one.bottom) clashes.push(`${one.what} and ${other.what}`);
      }
    });
    return clashes;
  });
}
