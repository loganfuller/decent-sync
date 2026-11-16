import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * A segmented control: a few choices in one row, of which at most one is
 * chosen, as a record list's date presets and what a Shot's curves are
 * compared with. Pressing the one chosen gives `onValueChange` an empty
 * value, as none is then chosen: a control that always has a choice ignores
 * it. `label` names it for screen readers.
 */
export function Segmented({
  label,
  value,
  onValueChange,
  className,
  children,
}: {
  label: string;
  value: string;
  onValueChange(value: string): void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ToggleGroup type="single" aria-label={label} value={value} onValueChange={onValueChange} spacing={0} className={`h-8 gap-0.5 rounded-lg bg-muted p-[3px] ${className ?? ""}`}>
      {children}
    </ToggleGroup>
  );
}

/** One of a segmented control's choices. */
export function SegmentedItem({ value, className, children }: { value: string; className?: string; children: ReactNode }) {
  return (
    <ToggleGroupItem
      value={value}
      className={`h-full min-w-0 rounded-md! px-2.5 text-foreground/60 hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-input/30 ${className ?? ""}`}
    >
      {children}
    </ToggleGroupItem>
  );
}
