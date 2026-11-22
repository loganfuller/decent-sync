import type { Locator } from "@playwright/test";

// What a Profile's graph draws over what (#621), measured on the page.

/**
 * Each pair on the graph in `scope` where one thing is drawn over another,
 * in words, none where all is clear: a piece of its text over another, a
 * Draft's handle, its tag or its bracket over a piece of text, or a handle's
 * tag over another handle or its tag. A handle over another, as a target
 * standing on the bracket, and a tag over its own handle are not a pair.
 * Text is measured a little inside its line's height, which is taller than
 * its letters, so two rows that only touch are not a pair.
 */
export async function graphClashes(scope: Locator): Promise<string[]> {
  return scope.locator("figure").first().evaluate((figure) => {
    const svg = figure.querySelector("svg[data-graph-end]");
    if (!svg) return ["no graph drawn"];
    type Kind = "text" | "handle" | "tag";
    type Piece = { what: string; kind: Kind; owner: string | null; left: number; right: number; top: number; bottom: number };
    const piece = (element: Element, what: string, kind: Kind, owner: string | null = null): Piece => {
      const box = element.getBoundingClientRect();
      const inset = kind === "text" ? 2 : 0;
      return { what, kind, owner, left: box.left, right: box.right, top: box.top + inset, bottom: box.bottom - inset };
    };
    const words = (element: Element) => [...element.childNodes].flatMap((node) => (node.nodeType === Node.TEXT_NODE ? [node.textContent ?? ""] : [])).join("");
    const pieces = [
      ...[...svg.querySelectorAll("text")].filter((text) => words(text).trim() !== "").map((text) => piece(text, `"${words(text)}"`, "text")),
      ...[...figure.querySelectorAll("[data-handle]")].map((handle) => piece(handle, `the ${handle.getAttribute("data-handle")} handle`, "handle", handle.getAttribute("data-handle"))),
      ...[...figure.querySelectorAll("[data-handle-tag]")].map((tag) => piece(tag, `the ${tag.getAttribute("data-handle-tag")} handle's tag`, "tag", tag.getAttribute("data-handle-tag"))),
    ].filter((each) => each.right > each.left && each.bottom > each.top);
    const clashes: string[] = [];
    pieces.forEach((one, index) => {
      for (const other of pieces.slice(index + 1)) {
        if (one.kind === "handle" && other.kind === "handle") continue;
        if (one.owner !== null && one.owner === other.owner) continue;
        if (one.left < other.right && other.left < one.right && one.top < other.bottom && other.top < one.bottom) clashes.push(`${one.what} and ${other.what}`);
      }
    });
    return clashes;
  });
}
