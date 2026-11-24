import { type ComponentProps, type FocusEvent, useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertAction } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** How long a message that something was done stays, while neither the pointer nor focus is on it. */
export const PASSING_MS = 8_000;

/**
 * How long a status message stays:
 * - `pending`: until an answer replaces it, with no way to close it.
 * - `passing`: a success, gone by itself after `PASSING_MS`, or when dismissed.
 * - `staying`: what went wrong, or may have, kept until it is dismissed.
 */
export type Lasting = "pending" | "passing" | "staying";

/**
 * A status message of what came of something asked of a Machine, such as a
 * Software Action or a Settings Edit, in place where it was asked. An answered
 * one has a Dismiss button; a passing one also goes by itself, held while the
 * pointer is over it or focus is inside it, as a toast is, and its time
 * starts again once they leave. `shows` is what it says, its title and
 * text: once it has gone, it stays hidden until it says something else, as
 * when an answer arrives late for one dismissed as not confirmed. Hiding it
 * only hides it: what it is about goes on, read until answered, and stays in
 * its log.
 */
export function StatusAlert({
  lasting,
  shows,
  children,
  className,
  ...props
}: ComponentProps<typeof Alert> & { lasting: Lasting; shows: string }) {
  // What it showed when it went, by itself or dismissed.
  const [gone, setGone] = useState<string>();
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = pointer || focused;

  useEffect(() => {
    if (lasting !== "passing" || held || gone === shows) return;
    const timer = setTimeout(() => setGone(shows), PASSING_MS);
    return () => clearTimeout(timer);
  }, [lasting, held, gone, shows]);

  if (gone === shows) return null;
  const dismissible = lasting !== "pending";
  return (
    <Alert
      role="status"
      className={cn(dismissible && "has-data-[slot=alert-action]:pr-10", className)}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      {...props}
    >
      {children}
      {dismissible && (
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            onClick={() => {
              // Gone with the pointer and focus on it, so neither holds whatever it shows next.
              setPointer(false);
              setFocused(false);
              setGone(shows);
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
