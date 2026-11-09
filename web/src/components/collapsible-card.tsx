import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CardTitleWithInfo } from "@/components/info-tip";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/**
 * A card for what most who read a page do not need: shown closed, but for
 * its title and what explains it in a tooltip, until it is opened. What it
 * holds is mounted only while it is open, so it loads nothing while closed,
 * and starts over each time it is opened.
 */
export function CollapsibleCard({ title, info, children }: { title: string; info: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <Card role="region" aria-label={title}>
        <CardHeader>
          <CardTitleWithInfo title={title}>{info}</CardTitleWithInfo>
          <CardAction>
            <CollapsibleTrigger asChild>
              {/* As wide for "Hide" as for "Show", so it stays put as it is pressed. */}
              <Button variant="outline" size="sm" className="min-w-18">
                {open ? "Hide" : "Show"}
                <span className="sr-only"> {title}</span>
                <ChevronDownIcon data-icon="inline-end" className={open ? "rotate-180 transition-transform" : "transition-transform"} />
              </Button>
            </CollapsibleTrigger>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
