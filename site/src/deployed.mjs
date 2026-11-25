// In the browser: what the deploy's versions.json lists, read once a page,
// and opening the page being read in another minor's documentation.
import { ROOT_BASE } from "../site.config.mjs";
import { addressIn, listed, pathIn } from "./versions.mjs";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

let loaded;

/**
 * The deployed minors, newest first, and the latest. A build with no
 * versions.json beside it, such as a local one, lists only its own.
 *
 * @param {string} current the minor being read
 * @returns {Promise<{ latest: string, versions: string[] }>}
 */
export function deployed(current) {
    loaded ??= fetch(`${ROOT_BASE}/versions.json`, { cache: "no-cache" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((manifest) => listed(manifest, current));
    return loaded;
}

/** The address of the page being read in `minor`'s documentation. */
export function samePageIn(minor, latest) {
    return addressIn(minor, latest, ROOT_BASE, pathIn(window.location.pathname, base));
}

/**
 * Opens the page being read in `minor`'s documentation, or that minor's home
 * page where it has no such page.
 */
export async function openIn(minor, latest) {
    const page = samePageIn(minor, latest);
    let found = false;
    try {
        found = (await fetch(page, { method: "HEAD" })).ok;
    } catch {
        // Unreachable: its home page, which a reader can go on from.
    }
    window.location.assign(found ? page + window.location.hash : addressIn(minor, latest, ROOT_BASE, ""));
}
