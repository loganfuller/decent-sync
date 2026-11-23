import { useCallback, useEffect, useRef } from "react";

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
 * cmd-click. The space held is given back as the reader scrolls up past it,
 * and all of it once they are at the top, the next change is held from
 * scratch, or the component unmounts. A window made shorter keeps it until
 * the reader scrolls, as giving it back then would clamp the page once the
 * window is made taller again. It is held on the document's root, as it is
 * the window that scrolls.
 */
export function useKeptScroll(): (click?: Click) => void {
  // How far down the page is held to reach, in CSS pixels from its top, while it is held.
  const held = useRef<number>(undefined);

  useEffect(() => {
    const root = document.documentElement;
    const scrolled = () => {
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
