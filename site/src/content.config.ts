import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

import { withAssistantTools } from "./assistant-tools.mjs";
import { withRootPages } from "./root-pages.mjs";

export const collections = {
    // The pages in content/docs/, the Glossary and the Upgrade notes from
    // their files at the repository's root (root-pages.mjs), and the
    // Assistant tools page from the server's own tool definitions
    // (assistant-tools.mjs).
    docs: defineCollection({ loader: withAssistantTools(withRootPages(docsLoader())), schema: docsSchema() }),
};
