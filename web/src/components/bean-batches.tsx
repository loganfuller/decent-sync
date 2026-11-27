import { NavLink } from "react-router";
import { Badge } from "@/components/ui/badge";
import type { BeanBatchSummary } from "@/lib/api";

/** The Library's lists, as links between them: Recipes first (#547), as the list most come for. */
export function LibraryNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? "font-medium" : "text-muted-foreground hover:text-foreground");
  return (
    <nav aria-label="Library" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {/* `end`, so a Recipe's own page, which is reached from many places, marks no list. */}
      <NavLink to="/library/recipes" end className={linkClass}>
        Recipes
      </NavLink>
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
      <NavLink to="/library/baskets" className={linkClass}>
        Baskets
      </NavLink>
      <NavLink to="/library/tools" className={linkClass}>
        Tools
      </NavLink>
    </nav>
  );
}

export { atText, totalText, weightText } from "@/lib/remaining-weight";

/** What may need someone's attention about a batch. */
export function BatchBadges({ batch }: { batch: BeanBatchSummary }) {
  return <div className="flex flex-wrap gap-1">{batch.archived && <Badge variant="secondary">Archived</Badge>}</div>;
}
