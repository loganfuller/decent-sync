// Every image the generator makes, each in light and dark, by name. The spec captures each (images.spec.ts), and the
// documentation site shows one by its name (site/src/components/Still.astro), so a page can show only an image named
// here. `readme` marks the images README.md shows, which are committed in docs/images/; the site's are built when it
// is deployed and never committed (README.md beside this file).

export const STILLS = {
  "live-view": { readme: true, file: "gif", about: "A Machine's Live View during a shot, as a GIF" },
  overview: { readme: true, file: "png", about: "The Overview, down to Downtown's block" },
  location: { readme: false, file: "png", about: "Downtown's page: its Overview block and Recipes card" },
  "bean-batches": { readme: false, file: "png", about: "The Library's Bean Batches" },
  shots: { readme: false, file: "png", about: "The Shots list" },
  shot: { readme: true, file: "png", about: "A Shot's page: How it went and its Curves" },
  profile: { readme: true, file: "png", about: "A Profile's page: How it runs and its Steps" },
  "recipe-details": { readme: false, file: "png", about: "A Recipe's page: its Recipe card, what it holds" },
  "new-profile": { readme: false, file: "png", about: "The New Profile page: the six starting shapes" },
  draft: { readme: false, file: "png", about: "A Draft's page, followed on the Lab's Machine, with a Trial Shot over its graph" },
  phone: { readme: false, file: "png", about: "A Machine's Live View on a phone, mid-pour" },
  recipe: { readme: false, file: "png", about: "A Recipe's page, down to its numbers by Machine" },
  machines: { readme: false, file: "png", about: "The Machines list" },
  "machine-activity": { readme: false, file: "png", about: "A Machine's Activity tab: its Use card and the latest of its day's dial-in trail" },
  "machine-settings": { readme: false, file: "png", about: "A Machine's Settings tab: its Machine Settings" },
  "machine-software": { readme: false, file: "png", about: "A Machine's Software tab: Decaid, its plugins and its Skins" },
} as const;

export type StillName = keyof typeof STILLS;

/**
 * The Live View GIF's size: 800 px wide, and cropped to 482 px tall at that width, which drops the sliver of the
 * Weight chart's legend that the capture's clip leaves at the bottom. Recheck the height when the Live View card's
 * layout changes; the spec fails when the clip is shorter.
 */
export const GIF_WIDTH = 800;
export const GIF_HEIGHT = 482;

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];

/** The file an image is encoded to, in docs/images/ and in the site's generated images. */
export function stillFile(name: StillName, theme: Theme): string {
  return `${name}-${theme}.${STILLS[name].file}`;
}
