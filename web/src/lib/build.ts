import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router";

// A page follows the build of the management interface the server serves
// (ADR-0025). After a deploy it loads the new build at its next navigation,
// and a chunk of its own that fails to load, as a server of another build no
// longer has it, reloads it once. A page without a build, as under
// `npm run dev:web`, never reloads.

/** The header naming the build the server serves, on every response (`server/src/management-interface.ts`). */
const BUILD_HEADER = "Decent-Sync-Build";

/** This page's build, which `nameBuild` in `web/vite.config.ts` names in its index.html. */
const pageBuild = document.querySelector<HTMLMetaElement>('meta[name="decent-sync-build"]')?.content || undefined;

/** The build the server's latest response named, or null if it named none. */
let serverBuild: string | null = null;

/**
 * Notes the build a response from the server names. A response the browser
 * revalidated from its cache keeps the name it had, unless the server names
 * one, as every server with a build does.
 */
export function noteServerBuild(response: Response): void {
  serverBuild = response.headers.get(BUILD_HEADER);
}

/**
 * Loads the page afresh as it moves to another page once the server's latest
 * response named a build other than its own. Only a change of path counts:
 * the filters and pages of a list, kept in the query, change none, so typing
 * in a filter never reloads, nor does anything but moving to another page.
 */
export function useNewBuildOnNavigation(): void {
  const { pathname } = useLocation();
  const shown = useRef(pathname);
  // A layout effect, so it reloads before the page moved to is painted.
  useLayoutEffect(() => {
    if (pathname === shown.current) return;
    shown.current = pathname;
    if (pageBuild && serverBuild && serverBuild !== pageBuild) window.location.reload();
  }, [pathname]);
}

/** Set once this tab reloads for a chunk that failed to load, until one loads; kept through the reload. */
const RELOADED_FOR_CHUNK = "decent-sync:reloaded-for-chunk";

/**
 * Reloads the page once a chunk of it fails to load (Vite's
 * `vite:preloadError`, as when the server answers a chunk it lacks with
 * index.html), so it loads the build the server serves. A navigation to a
 * lazily loaded page waits for its chunk, so this is how such a navigation
 * finds a deploy. A chunk failing again before one has loaded since the
 * reload is left to fail, so this never loops. It reloads whatever the server
 * names, none included, as such a page is broken until it does.
 */
export function reloadForFailedChunk(): void {
  if (!pageBuild) return;
  try {
    if (sessionStorage.getItem(RELOADED_FOR_CHUNK) !== null) {
      console.warn("A chunk of this page failed to load again after it reloaded for one, so it does not reload again.");
      return;
    }
    sessionStorage.setItem(RELOADED_FOR_CHUNK, "1");
  } catch {
    // Without the tab's storage it cannot tell whether it reloaded already, so it does not.
    return;
  }
  window.location.reload();
}

/** Passes on a lazily loaded module once its chunk has loaded, so a chunk failing after it reloads the page again. */
export function chunkLoaded<T>(module: T): T {
  try {
    sessionStorage.removeItem(RELOADED_FOR_CHUNK);
  } catch {
    // Without the tab's storage no reload was kept to forget.
  }
  return module;
}
