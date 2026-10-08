import { Badge } from "@/components/ui/badge";
import type { BeanSummary } from "@/lib/api";

/** A Bean's name as lists show it. */
export function beanName(bean: Pick<BeanSummary, "name">): string {
  return bean.name ?? "Unnamed Bean";
}

/** Where a Bean is offered, by Location name. */
export function offeredAtText(bean: BeanSummary): string {
  if (bean.archived) return "Nowhere: Archived";
  return bean.offeredAt.length === 0 ? "Nowhere" : bean.offeredAt.map((location) => location.name).join(", ");
}

/** What may need someone's attention about a Bean. */
export function BeanBadges({ bean }: { bean: BeanSummary }) {
  return (
    <div className="flex flex-wrap gap-1">
      {bean.archived && <Badge variant="secondary">Archived</Badge>}
      {bean.likelyDuplicates.length > 0 && <Badge variant="outline">Likely duplicate</Badge>}
    </div>
  );
}
