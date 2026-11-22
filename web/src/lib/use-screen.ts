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
