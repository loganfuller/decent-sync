import { useEffect, useState } from "react";
import { TapTooltip } from "@/components/info-tip";
import { BROWSER_TIME_ZONE, relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { formatInZone } from "@/lib/zoned-time";

/** How often a relative time is worked out again: it reads to the minute. */
const TICK_MS = 30_000;

/** Now, read again every `TICK_MS` while the component is shown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A time as it reads now (#543; `relativeTime`): "14 min ago", "Yesterday,
 * 4:12 PM", or a plain date, by the wall clock of `timeZone`, a Location's,
 * or the browser's where none is given. Its exact time, with the zone, is in
 * a tooltip that opens on hover, focus and tap (`TapTooltip`).
 */
export function RelativeTime({ at, timeZone = BROWSER_TIME_ZONE, className }: { at: string; timeZone?: string; className?: string }) {
  const now = useNow();
  return (
    <TapTooltip className={cn("cursor-default text-left", className)} tip={formatInZone(at, timeZone)}>
      <time dateTime={at}>{relativeTime(Date.parse(at), now, timeZone)}</time>
    </TapTooltip>
  );
}
