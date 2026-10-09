import { NavLink } from "react-router";
import { Badge } from "@/components/ui/badge";
import type { BatchAtLocation, BeanBatchSummary } from "@/lib/api";

/** The Library's lists, as links between them. */
export function LibraryNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? "font-medium" : "text-muted-foreground hover:text-foreground");
  return (
    <nav aria-label="Library" className="flex gap-4 text-sm">
      <NavLink to="/library/beans" className={linkClass}>
        Beans
      </NavLink>
      <NavLink to="/library/bean-batches" className={linkClass}>
        Bean Batches
      </NavLink>
      <NavLink to="/library/grinders" className={linkClass}>
        Grinders
      </NavLink>
      <NavLink to="/library/profiles" className={linkClass}>
        Profiles
      </NavLink>
      <NavLink to="/library/conflicts" className={linkClass}>
        Conflicts
      </NavLink>
    </nav>
  );
}

/** A roast date as Decaid recorded it, as its day: the date a barista picked, whatever time zone it was written in. */
export function roastDateText(roastDate: string | null): string | undefined {
  return roastDate !== null && /^\d{4}-\d\d-\d\d/.test(roastDate) ? roastDate.slice(0, 10) : undefined;
}

/** A batch as lists name it: its Bean and the day it was roasted. */
export function batchName(batch: Pick<BeanBatchSummary, "bean" | "roastDate">): string {
  const roasted = roastDateText(batch.roastDate);
  return `${batch.bean.name ?? "Unnamed Bean"}, ${roasted === undefined ? "no roast date" : `roasted ${roasted}`}`;
}

/** A remaining weight in grams, as entered. */
export function weightText(weight: number | null): string {
  return weight === null ? "no weight entered" : `${weight} g`;
}

/** Where a batch is, by Location name, with its remaining weight at each. */
export function atText(locations: BatchAtLocation[]): string {
  return locations.length === 0 ? "Nowhere" : locations.map((here) => `${here.location.name} (${weightText(here.remainingWeight)})`).join(", ");
}

/** What may need someone's attention about a batch. */
export function BatchBadges({ batch }: { batch: BeanBatchSummary }) {
  return <div className="flex flex-wrap gap-1">{batch.archived && <Badge variant="secondary">Archived</Badge>}</div>;
}
