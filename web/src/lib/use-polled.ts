import { useCallback, useEffect, useRef, useState } from "react";

/** How often pages showing Machine status ask the server again. */
export const STATUS_POLL_MS = 5_000;

interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  /** Loads again now, for example after a change this page made. */
  reload(): Promise<void>;
}

/**
 * Loads data, then loads it again every `intervalMs` while the page is
 * visible, so status shown for a Machine follows its tablet. `load` must be
 * stable, as from useCallback; a new one starts over.
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
    const tick = async () => {
      if (!document.hidden) await reload();
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      // Whatever is still loading belongs to a page no longer shown.
      latest.current++;
    };
  }, [reload, intervalMs]);

  return { data, error, reload };
}
