/**
 * The address of the same page in the latest release's build: `href` with the
 * path `base` it was built for replaced by `rootBase`.
 *
 * @param {string} href an absolute URL under `base`
 * @param {string} base such as `/decent-sync/v1.13`
 * @param {string} rootBase such as `/decent-sync`
 */
export function canonicalAtRoot(href, base, rootBase) {
    const url = new URL(href);
    if (url.pathname === base || url.pathname.startsWith(`${base}/`)) {
        url.pathname = rootBase + url.pathname.slice(base.length);
    }
    return url.href;
}
