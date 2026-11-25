// The minor releases whose documentation is deployed, and the address of a
// page in each, for the header's version selector and the notice on a page of
// an older minor (VersionSelect.astro, Banner.astro). The deploy writes the
// list to versions.json at the site's root (scripts/deploy-site.mjs), so
// nothing here is edited at a release, and a build of one minor learns of the
// minors deployed after it.

const MINOR = /^v(\d+)\.(\d+)$/;

/** The minor release a version belongs to, as the deploy names its path: `v1.13` for `1.13.2`. */
export function minorOf(version) {
    const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
    if (!match) throw new Error(`"${version}" is not a version X.Y.Z`);
    return `v${match[1]}.${match[2]}`;
}

/** Orders minors newest first. */
export function newestFirst(a, b) {
    const [, majorA, minorA] = MINOR.exec(a);
    const [, majorB, minorB] = MINOR.exec(b);
    return Number(majorB) - Number(majorA) || Number(minorB) - Number(minorA);
}

/**
 * The minors to list, newest first, and the latest, from what versions.json
 * holds. The minor being read is always listed, so a build that was never
 * deployed, such as a local one, still shows its own. Anything versions.json
 * holds that is not a minor is left out; when it names no latest, the minor
 * being read is taken as the latest, so no notice is shown.
 *
 * @param {unknown} manifest versions.json's contents, or null when there is none
 * @param {string} current the minor being read, such as `v1.13`
 * @returns {{ latest: string, versions: string[] }}
 */
export function listed(manifest, current) {
    const deployed = Array.isArray(manifest?.versions) ? manifest.versions.filter((v) => typeof v === "string" && MINOR.test(v)) : [];
    const versions = [...new Set([current, ...deployed])].sort(newestFirst);
    const latest = typeof manifest?.latest === "string" && MINOR.test(manifest.latest) ? manifest.latest : current;
    return { latest, versions };
}

/**
 * A page's path within the build served at `base`: `guide/shots/` for
 * `/decent-sync/v1.13/guide/shots/` under `/decent-sync/v1.13`. Empty, the
 * home page, for an address outside it, such as GitHub Pages' page for an
 * address that names nothing.
 */
export function pathIn(pathname, base) {
    if (pathname === base || pathname === `${base}/`) return "";
    return pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : "";
}

/**
 * The address of the page at `path` in `minor`'s documentation: the latest
 * minor's at the root, every other at its own path.
 *
 * @param {string} minor such as `v1.13`
 * @param {string} latest the latest deployed minor
 * @param {string} rootBase such as `/decent-sync`
 * @param {string} path such as `guide/shots/`, or empty for the home page
 */
export function addressIn(minor, latest, rootBase, path) {
    return `${rootBase}${minor === latest ? "" : `/${minor}`}/${path}`;
}
