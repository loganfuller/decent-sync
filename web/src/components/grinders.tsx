import { Badge } from "@/components/ui/badge";
import type { GrinderSummary } from "@/lib/api";

/** A Grinder's model as lists show it. */
export function grinderName(grinder: Pick<GrinderSummary, "model">): string {
  return grinder.model ?? "Unnamed Grinder";
}

/** Where a Grinder is offered: the Location it belongs to, unless it is Archived. */
export function grinderLocationText(grinder: GrinderSummary): string {
  return grinder.location?.name ?? "No Location";
}

/** What may need someone's attention about a Grinder. */
export function GrinderBadges({ grinder }: { grinder: GrinderSummary }) {
  return <div className="flex flex-wrap gap-1">{grinder.archived && <Badge variant="secondary">Archived</Badge>}</div>;
}
