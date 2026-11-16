import { cn } from "@/lib/utils";

/**
 * What says, above a table wider than a narrow screen, that it scrolls
 * sideways within the page (#545), so the columns out of sight are not
 * missed: shown below the width its table fits from, 640 px unless it is
 * `wide`, which fits from 1024 px.
 */
export function ScrollsSideways({ wide = false }: { wide?: boolean }) {
  return <p className={cn("text-xs text-muted-foreground", wide ? "lg:hidden" : "sm:hidden")}>This table scrolls sideways.</p>;
}
