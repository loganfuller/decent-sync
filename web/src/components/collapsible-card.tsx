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
 * and starts over each time it is opened. It keeps whether it is open
 * itself, unless given `open` and `onOpenChange`, as by a page that keeps
 * it in its address. Its button is small, unless given `buttonSize`, as on a
 * phone by a page whose buttons are the default size there.
 */
export function CollapsibleCard({
  title,
  info,
  open: given,
  onOpenChange,
  buttonSize = "sm",
  children,
}: {
  title: string;
  info: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  buttonSize?: "sm" | "default";
  children: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <Card role="region" aria-label={title}>
        <CardHeader>
          <CardTitleWithInfo title={title}>{info}</CardTitleWithInfo>
          <CardAction>
            <CollapsibleTrigger asChild>
              {/* As wide for "Hide" as for "Show", so it stays put as it is pressed. */}
              <Button variant="outline" size={buttonSize} className="min-w-18">
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
