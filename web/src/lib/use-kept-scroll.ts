import { useCallback, useEffect, useRef } from "react";

/**
 * Keeps the page from shrinking out from under the reader when part of it is
 * replaced, as a Machine page's tab is (#641). Call what it returns just
 * before the change, such as in the click that opens another tab: the page
 * then stays at least tall enough to reach the bottom of the window as it is
 * now, so the browser doesn't pull the scroll position up while what
 * replaced it is shorter, as it is while loading. The space held is given
 * back as the reader scrolls up past it or the window is made shorter, and
 * all of it once they are at the top, the next change is held from scratch,
 * or the component unmounts. It
 * is held on the document's root, as it is the window that scrolls.
 */
export function useKeptScroll(): () => void {
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
    // A window made shorter moves its bottom up without a scroll.
    window.addEventListener("resize", scrolled, { passive: true });
    return () => {
      window.removeEventListener("scroll", scrolled);
      window.removeEventListener("resize", scrolled);
      held.current = undefined;
      root.style.minHeight = "";
    };
  }, []);

  return useCallback(() => {
    if (window.scrollY <= 0) return;
    const bottom = window.scrollY + window.innerHeight;
    held.current = bottom;
    document.documentElement.style.minHeight = `${bottom}px`;
  }, []);
}
