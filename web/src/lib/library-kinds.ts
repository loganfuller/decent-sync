/** How the management interface shows a kind of Library item. */
interface LibraryKindView {
  /** What it is called, such as Bean Batch. */
  name: string;
  /** The tablet's list of its records, as a Machine's collections name it, and what that list is called. */
  list: { name: string; title: string };
  /** Where its items' pages are, each under its id. */
  pages: string;
  /** Where the REST API has its items, each under its id. */
  api: string;
  /** The Shots list's filter by an item of the kind; null for a kind no Shot is linked to, as Tools, whose names Shots show as DYE2 stored them. */
  shotsFilter: string | null;
  /** Whether the Shots list offers that filter, as it does for Bean Batches, Grinders, Recipes and Baskets, so an item's page links to it. */
  filteredInShotsList: boolean;
}

/**
 * Each kind of Library item, described once for the management interface
 * (`LIBRARY.md`, Adding a Library kind), in the server's order.
 */
export const LIBRARY_KINDS = {
  bean: { name: "Bean", list: { name: "beans", title: "Beans" }, pages: "/library/beans", api: "/beans", shotsFilter: "beanId", filteredInShotsList: false },
  beanBatch: { name: "Bean Batch", list: { name: "beanBatches", title: "Bean Batches" }, pages: "/library/bean-batches", api: "/bean-batches", shotsFilter: "beanBatchId", filteredInShotsList: true },
  grinder: { name: "Grinder", list: { name: "grinders", title: "Grinders" }, pages: "/library/grinders", api: "/grinders", shotsFilter: "grinderId", filteredInShotsList: true },
  profile: { name: "Profile", list: { name: "profiles", title: "Profiles" }, pages: "/library/profiles", api: "/profiles", shotsFilter: "profileId", filteredInShotsList: false },
  basket: { name: "Basket", list: { name: "dye2Baskets", title: "Baskets (DYE2)" }, pages: "/library/baskets", api: "/baskets", shotsFilter: "basketId", filteredInShotsList: true },
  tool: { name: "Tool", list: { name: "dye2Equipment", title: "Tools (DYE2's equipment)" }, pages: "/library/tools", api: "/tools", shotsFilter: null, filteredInShotsList: false },
  recipe: { name: "Recipe", list: { name: "dye2Recipes", title: "Recipes (DYE2)" }, pages: "/library/recipes", api: "/recipes", shotsFilter: "recipeId", filteredInShotsList: true },
} as const satisfies Readonly<Record<string, LibraryKindView>>;

/** The kinds of Library item. */
export type LibraryKind = keyof typeof LIBRARY_KINDS;

/** The kinds of Library item the Shots list filters by. */
export type ShotsKind = { [K in LibraryKind]: (typeof LIBRARY_KINDS)[K]["shotsFilter"] extends string ? K : never }[LibraryKind];
