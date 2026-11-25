// Which file the site shows for one of the generator's images (scripts/images/stills.ts). The images the deploy
// generates, in site/generated/, come first. A build without them, such as a pull request's or `npm run dev`, shows
// the README's committed copy in docs/images/ where there is one, and an image with none is left out. The deploy
// builds with SITE_IMAGES=generated, so an image the generator did not make fails it.

/** A glob's modules by their file names. */
export function byFile(modules) {
    return Object.fromEntries(Object.entries(modules).map(([file, image]) => [file.split("/").at(-1), image]));
}

/** The image to show for `file`, or undefined when there is none to show. */
export function pickStill(file, { generated, committed, required }) {
    if (generated[file]) return generated[file];
    if (required) {
        throw new Error(`${file} is not among the generated images in site/generated/: run \`npm run site-images\` first, or build without SITE_IMAGES=generated`);
    }
    return committed[file];
}
