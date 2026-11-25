// Every image the generator makes, each in light and dark, by name. The spec captures each (images.spec.ts), and the
// documentation site shows one by its name (site/src/components/Still.astro), so a page can show only an image named
// here. `readme` marks the images README.md shows, which are committed in docs/images/; the site's are built when it
// is deployed and never committed (README.md beside this file).

export const STILLS = {
  "live-view": { readme: true, file: "gif", about: "A Machine's Live View during a shot, as a GIF" },
  overview: { readme: true, file: "png", about: "The Overview, down to Downtown's block" },
  location: { readme: true, file: "png", about: "Downtown's page: its Overview block and Recipes card" },
  "bean-batches": { readme: true, file: "png", about: "The Library's Bean Batches" },
  shots: { readme: false, file: "png", about: "The Shots list" },
  shot: { readme: true, file: "png", about: "A Shot's page: How it went and its Curves" },
  profile: { readme: true, file: "png", about: "A Profile's page: How it runs and its Steps" },
  phone: { readme: true, file: "png", about: "A Machine's Live View on a phone, mid-pour" },
} as const;

export type StillName = keyof typeof STILLS;
export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

/** The file an image is encoded to, in docs/images/ and in the site's generated images. */
export function stillFile(name: StillName, theme: Theme): string {
  return `${name}-${theme}.${STILLS[name].file}`;
}
