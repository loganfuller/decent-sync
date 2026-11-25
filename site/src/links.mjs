// Links from a component to a page of the site. Markdown pages link to each
// other with relative paths; a component is told the path the site is served
// at, which differs between the latest build and a minor release's own.
const base = import.meta.env.BASE_URL.replace(/\/$/, "");

/** The address of the page at `path`, such as `guide/shots`. */
export const page = (path) => `${base}/${path}/`;

export const repository = "https://github.com/loganfuller/decent-sync";
