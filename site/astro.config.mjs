// The documentation site (docs/DEVELOPMENT.md, The documentation site). It is
// published under the repository's GitHub Pages address: the latest minor
// release at its root, and each minor release at a path of its own, which
// scripts/deploy-site.mjs builds by setting SITE_BASE.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

import { ROOT_BASE, SITE } from "./site.config.mjs";

const repository = "https://github.com/loganfuller/decent-sync";

export default defineConfig({
    site: SITE,
    base: process.env.SITE_BASE || ROOT_BASE,
    trailingSlash: "always",
    integrations: [
        starlight({
            title: "Decent Sync",
            description: "Sync and manage Decent espresso machines across locations, on a server you host yourself.",
            logo: {
                light: "../web/src/assets/decent-sync-logo.svg",
                dark: "../web/src/assets/decent-sync-logo-dark.svg",
                replacesTitle: true,
            },
            favicon: "/favicon.svg",
            social: [{ icon: "github", label: "GitHub", href: repository }],
            customCss: ["./src/styles/theme.css"],
            components: {
                Hero: "./src/components/HomeHero.astro",
                Footer: "./src/components/Footer.astro",
            },
            routeMiddleware: "./src/route-data.ts",
            credits: false,
            // Every section and page of the site, in reading order. A page's
            // address is its path here and is meant to stay: the management
            // interface will link to these.
            sidebar: [
                {
                    label: "Get started",
                    items: [
                        "get-started/what-decent-sync-is",
                        "get-started/quick-start",
                        "get-started/locations-and-machines",
                        "get-started/install-the-plugin",
                        "get-started/invite-people",
                    ],
                },
                {
                    label: "Guide",
                    items: [
                        "guide/library-and-recipes",
                        "guide/profiles-and-drafts",
                        "guide/shots",
                        "guide/machines",
                        "guide/assistants",
                        "guide/accounts-and-roles",
                    ],
                },
                {
                    label: "Self-hosting",
                    items: [
                        "self-hosting/docker-compose",
                        "self-hosting/local-network",
                        "self-hosting/internet",
                        "self-hosting/fly-io",
                        "self-hosting/upgrading",
                        "self-hosting/configuration",
                    ],
                },
                {
                    label: "Reference",
                    items: [
                        "reference/glossary",
                        "reference/tablet-plugin",
                        "reference/assistant-tools",
                        "reference/upgrade-notes",
                    ],
                },
                {
                    label: "Technical",
                    items: [
                        "technical/architecture",
                        "technical/internals",
                        "technical/skin-authors",
                        "technical/development",
                    ],
                },
                {
                    label: "Project",
                    items: ["project/roadmap", "project/releases"],
                },
            ],
        }),
    ],
});
