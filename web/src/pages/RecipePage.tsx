import { useParams } from "react-router";
import { RecipeDetails } from "@/components/recipes";

/** One Recipe: where it is, its fields, its Conflicts and its history, changed by an Admin or Staff working at its Location. */
export function RecipePage() {
  const { id = "" } = useParams();
  return <RecipeDetails key={id} id={id} />;
}
