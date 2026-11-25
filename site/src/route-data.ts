// A minor release's build is served at a path of its own (ROOT_BASE/vX.Y)
// beside the latest release's at the root. Each of its pages names the root's
// page as its canonical address, so a search engine lists the latest
// documentation and an old link still reads as the same page.
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

import { ROOT_BASE } from "../site.config.mjs";
import { canonicalAtRoot } from "./canonical.mjs";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

export const onRequest = defineRouteMiddleware((context) => {
    if (base === ROOT_BASE) return;
    for (const tag of context.locals.starlightRoute.head) {
        const attrs = tag.attrs;
        if (!attrs) continue;
        if (tag.tag === "link" && attrs.rel === "canonical" && typeof attrs.href === "string") {
            attrs.href = canonicalAtRoot(attrs.href, base, ROOT_BASE);
        }
        if (tag.tag === "meta" && attrs.property === "og:url" && typeof attrs.content === "string") {
            attrs.content = canonicalAtRoot(attrs.content, base, ROOT_BASE);
        }
    }
});
