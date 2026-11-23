import { useCallback, useEffect, useInsertionEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

/** The parts of a click that say whether it opens the link here, as React Router reads them. */
type Click = Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/**
 * Keeps the page from shrinking out from under the reader when part of it is
 * replaced, as a Machine page's tab is (#641). Call what it returns just
 * before the change, such as in the click that opens another tab: the page
 * then stays at least tall enough to reach the bottom of the window as it is
 * now, so the browser doesn't pull the scroll position up while what
 * replaced it is shorter, as it is while loading. Given the click, it holds
 * nothing for one that opens the link elsewhere, such as a ctrl- or
 * cmd-click.
 *
 * Back and Forward are held too, with nothing to call (#649). The browser
 * returns a history entry to where it was scrolled, which a part that mounts
 * short would cut off. So the hook notes how far each entry of the component
 * it is in was scrolled, and on the way back to one it holds the page tall
 * enough to reach there, in the render that replaces the part: a `popstate`
 * listener of its own runs only after that render. It does so in an
 * insertion effect, which runs before any layout effect, as one of the new
 * part's that read the page's layout would clamp it first. An entry last at
 * the top holds nothing, and gives back what was held. An entry of the page from
 * before the component mounted, such as one come back to from another page,
 * isn't known, and holds nothing.
 *
 * The space held is given back as the reader scrolls up past it, and all of
 * it once they are at the top, the next change is held from scratch, or the
 * component unmounts. A window made shorter keeps it until the reader
 * scrolls, as giving it back then would clamp the page once the window is
 * made taller again. It is held on the document's root, as it is the window
 * that scrolls.
 */
export function useKeptScroll(): (click?: Click) => void {
  // How far down the page is held to reach, in CSS pixels from its top, while it is held.
  const held = useRef<number>(undefined);
  const { key } = useLocation();
  const cameBack = useNavigationType() === "POP";
  // How far each history entry seen while mounted was last scrolled, by its key, and the entry the page is on.
  const scrolledTo = useRef(new Map<string, number>());
  const entry = useRef<string>(undefined);

  // Before anything lays out what this render replaced, so the page is already held when a short part would clamp it.
  useInsertionEffect(() => {
    const from = entry.current;
    if (from === key) return;
    entry.current = key;
    const known = scrolledTo.current.get(key);
    if (known === undefined) {
      // A new entry opens where the one before it was: read from the note, as reading the window here would lay the
      // page out with its new part. The first one is read once the component has mounted, below.
      if (from !== undefined) scrolledTo.current.set(key, scrolledTo.current.get(from) ?? 0);
    } else if (cameBack) {
      const root = document.documentElement;
      if (known <= 0) {
        held.current = undefined;
        root.style.minHeight = "";
      } else {
        held.current = known + window.innerHeight;
        root.style.minHeight = `${held.current}px`;
      }
    }
  }, [key, cameBack]);

  useEffect(() => {
    const root = document.documentElement;
    if (entry.current !== undefined && !scrolledTo.current.has(entry.current)) scrolledTo.current.set(entry.current, window.scrollY);
    const scrolled = () => {
      if (entry.current !== undefined) scrolledTo.current.set(entry.current, window.scrollY);
      if (held.current === undefined) return;
      const bottom = window.scrollY + window.innerHeight;
      if (window.scrollY <= 0) {
        held.current = undefined;
        root.style.minHeight = "";
      } else if (bottom < held.current) {
        held.current = bottom;
        root.style.minHeight = `${bottom}px`;
      }
    };
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      window.removeEventListener("scroll", scrolled);
      held.current = undefined;
      root.style.minHeight = "";
    };
  }, []);

  return useCallback((click?: Click) => {
    if (click && (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey)) return;
    if (window.scrollY <= 0) return;
    const bottom = window.scrollY + window.innerHeight;
    held.current = bottom;
    document.documentElement.style.minHeight = `${bottom}px`;
  }, []);
}
