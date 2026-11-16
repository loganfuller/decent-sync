import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import type { LoadedRecipe } from "@/lib/api";

/** A Recipe a Machine loaded, linked to its page, with its slot now, or that it is in none or Archived. */
export function LoadedRecipeLink({ loaded }: { loaded: LoadedRecipe }) {
  const { recipe } = loaded;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link to={`/library/recipes/${encodeURIComponent(recipe.id)}`} className="underline underline-offset-4">
        {recipe.name ?? "Unnamed Recipe"}
      </Link>
      {recipe.archived ? (
        <Badge variant="secondary">Archived</Badge>
      ) : recipe.slot === null ? (
        <Badge variant="outline">No slot</Badge>
      ) : (
        <Badge variant="outline">Slot {recipe.slot}</Badge>
      )}
    </span>
  );
}
