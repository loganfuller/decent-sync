import { useCallback, useEffect, useRef, useState } from "react";

/** How often pages showing Machine status ask the server again. */
export const STATUS_POLL_MS = 5_000;

/**
 * How often pages ask again for what changes less often than a Machine's
 * status, such as what its tablet reported besides it.
 */
export const DETAILS_POLL_MS = 30_000;

interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  /** Loads again now, for example after a change this page made. */
  reload(): Promise<void>;
}

/**
 * Loads data, then loads it again every `intervalMs` while the page is
 * visible, so status shown for a Machine follows its tablet. A load that fell
 * due while the page was hidden runs as soon as it is shown again. `load`
 * must be stable, as from useCallback; a new one starts over.
 */
export function usePolled<T>(load: () => Promise<T>, intervalMs = STATUS_POLL_MS): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  // Answers to earlier loads that arrive after a newer one started are dropped.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    try {
      const loaded = await load();
      if (request !== latest.current) return;
      setData(loaded);
      setError(undefined);
    } catch (caught) {
      if (request !== latest.current) return;
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    }
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    // Whether the latest load due was skipped, the page being hidden then.
    let skipped = false;
    const tick = async () => {
      skipped = document.hidden;
      if (!skipped) await reload();
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    // A skipped tick loaded nothing and scheduled the next at once, so no load is running.
    const shown = () => {
      if (document.hidden || !skipped) return;
      clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", shown);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
      // Whatever is still loading belongs to a page no longer shown.
      latest.current++;
    };
  }, [reload, intervalMs]);

  return { data, error, reload };
}
