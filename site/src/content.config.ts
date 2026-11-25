import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

import { withRootPages } from "./root-pages.mjs";

export const collections = {
    // The pages in content/docs/, and the Glossary and the Upgrade notes
    // from their files at the repository's root (root-pages.mjs).
    docs: defineCollection({ loader: withRootPages(docsLoader()), schema: docsSchema() }),
};
