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

/** The builds that reloaded this tab for a chunk that failed to load, kept through the reload. */
const CHUNK_RELOADS = "decent-sync:chunk-reloads";

/**
 * Reloads the page once a chunk of it fails to load (Vite's
 * `vite:preloadError`, as when the server answers a chunk it lacks with
 * index.html), so it loads the build the server serves. A build reloads a tab
 * so once: a chunk failing again after the reload brought the same build is
 * left to fail, so this never loops.
 */
export function reloadForFailedChunk(): void {
  if (!pageBuild) return;
  try {
    const reloaded = JSON.parse(sessionStorage.getItem(CHUNK_RELOADS) ?? "[]") as string[];
    if (reloaded.includes(pageBuild)) {
      console.warn("A chunk of this page failed to load again after it reloaded for one, so it does not reload again.");
      return;
    }
    sessionStorage.setItem(CHUNK_RELOADS, JSON.stringify([...reloaded, pageBuild]));
  } catch {
    // Without the tab's storage it cannot tell whether it reloaded already, so it does not.
    return;
  }
  window.location.reload();
}
