import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * What marks something out of spec (#543; GLOSSARY.md): a number, or a
 * status, beyond its margin. It never rests on colour alone: a triangle
 * stands before it, its text is semibold, and a screen reader hears "Out of
 * spec" first, or `label`, or nothing more where its own words say what is
 * wrong, as "Offline" does. Its colours (`--spec-mark` on `--spec-mark-ground`,
 * index.css) meet 4.5:1 in both themes. What is within spec, or not judged,
 * is plain muted text with no icon.
 */
export function SpecMark({ children, label = "Out of spec", className }: { children: ReactNode; label?: string | null; className?: string }) {
  return (
    <span data-slot="spec-mark" className={cn("inline-flex w-fit items-start gap-1 rounded-md bg-spec-mark-ground px-1.5 py-px font-semibold text-spec-mark", className)}>
      {/* Level with the first line's text, however far the rest wraps. */}
      <TriangleAlertIcon aria-hidden="true" strokeWidth={2.5} className="mt-[0.25em] size-3 shrink-0" />
      <span>
        {label !== null && <span className="sr-only">{label}: </span>}
        {children}
      </span>
    </span>
  );
}
