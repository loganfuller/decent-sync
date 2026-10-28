import { InfoIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A small info icon whose tooltip holds what explains the value beside it,
 * kept out of the page until asked for. It opens on hover, on keyboard focus
 * and on a tap or click: Radix opens a tooltip on neither a tap nor a click,
 * and closes it on a click, which would leave a touchscreen no way to read
 * it. A tap elsewhere, Escape or moving away closes it. The icon is a button,
 * and `label` names it for screen readers.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex align-middle text-muted-foreground hover:text-foreground"
          // Each prevented, so Radix's own handler, which closes the tooltip, is skipped.
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <InfoIcon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid gap-1">{children}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/** A card's title, with what explains the card, if anything, in a tooltip beside it. */
export function CardTitleWithInfo({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-1.5">
      <h2>{title}</h2>
      {children && <InfoTip label={`About ${title}`}>{children}</InfoTip>}
    </CardTitle>
  );
}

/** A page's title, with what explains the page in a tooltip beside it. */
export function PageTitleWithInfo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <InfoTip label={`About ${title}`}>{children}</InfoTip>
    </div>
  );
}
