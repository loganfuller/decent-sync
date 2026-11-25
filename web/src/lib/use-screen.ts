import { useCallback, useSyncExternalStore } from "react";

/** Whether the window matches a media query, such as `(min-width: 640px)`, following it as the window changes. */
export function useScreen(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Below Tailwind's `md` breakpoint: a phone's width, held either way, where the Software tab's tables become lists. */
const NARROW_SCREEN = "(max-width: 767.98px)";

/** Whether the window is narrower than Tailwind's `md` breakpoint, as a phone's is, held either way (#674). */
export function useNarrowScreen(): boolean {
  return useScreen(NARROW_SCREEN);
}
