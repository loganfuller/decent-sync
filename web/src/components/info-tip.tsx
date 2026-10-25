import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A small info icon whose tooltip holds what explains the value beside it,
 * kept out of the page until asked for. The icon is a button, so the tooltip
 * opens on keyboard focus too, and `label` names it for screen readers.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} className="inline-flex align-middle text-muted-foreground hover:text-foreground">
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid gap-1">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}
