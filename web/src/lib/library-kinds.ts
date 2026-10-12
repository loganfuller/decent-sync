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
  /** The Shots list's filter by an item of the kind. */
  shotsFilter: string;
  /** Whether the Shots list offers that filter, as it does for Bean Batches and Grinders, so an item's page links to it. */
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
} as const satisfies Readonly<Record<string, LibraryKindView>>;

/** The kinds of Library item. */
export type LibraryKind = keyof typeof LIBRARY_KINDS;
