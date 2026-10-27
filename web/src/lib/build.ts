import { type ComponentType, type LazyExoticComponent, createElement, lazy, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

// A page follows the build of the management interface the server serves
// (ADR-0025). After a deploy it loads the new build at its next navigation,
// and a lazily loaded page whose chunk fails to load, as a server of another
// build no longer has it, reloads once it is shown. A page without a build,
// as under `npm run dev:web`, never reloads.

/** The header naming the build the server serves, on every response (`server/src/management-interface.ts`). */
const BUILD_HEADER = "Decent-Sync-Build";

/** This page's build, which `nameBuild` in `web/vite.config.ts` names in its index.html. */
const pageBuild = document.querySelector<HTMLMetaElement>('meta[name="decent-sync-build"]')?.content || undefined;

/** The build the server's latest response named, or null if it named none. */
let serverBuild: string | null = null;

/**
 * Whether this page has asked to reload, at a navigation or for a chunk: what
 * happens in it after that, a chunk failing or loading of a navigation it
 * left, changes nothing the reloaded page reads.
 */
let reloading = false;

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
    if (pageBuild && serverBuild && serverBuild !== pageBuild) {
      reloading = true;
      window.location.reload();
    }
  }, [pathname]);
}

/**
 * A page loaded only when opened, as React's `lazy` loads it. Should its
 * chunk fail to load (Vite's `vite:preloadError`, as when the server answers
 * a chunk it lacks with index.html), what stands in for it reloads the page
 * as it is shown, to load the build the server serves. Only then: a failure
 * after someone moved on to another page leaves that page as it is, a form
 * they are filling in included, until they open this one. A navigation from
 * one lazily loaded page to another waits for its chunk, so that is how it
 * finds a deploy.
 */
export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    try {
      const page = await load();
      forgetChunkReload();
      return { default: page };
    } catch (error) {
      return { default: () => createElement(FailedChunk, { error }) };
    }
  });
}

/** Stands in for a page whose chunk failed to load: reloads the page, or fails as the page would have. */
function FailedChunk({ error }: { error: unknown }): null {
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    if (!reloadForFailedChunk()) setFailed(true);
  }, []);
  if (failed) throw error;
  return null;
}

/** Set once this tab reloads for a chunk that failed to load, until one loads; kept through the reload. */
const RELOADED_FOR_CHUNK = "decent-sync:reloaded-for-chunk";

/**
 * Reloads the page for a chunk that failed to load, and says whether it did.
 * A chunk failing again before one has loaded since the reload is left to
 * fail, so this never loops. It reloads whatever the server names, none
 * included, as the page is broken until it does.
 */
function reloadForFailedChunk(): boolean {
  if (!pageBuild) return false;
  if (reloading) return true;
  try {
    if (sessionStorage.getItem(RELOADED_FOR_CHUNK) !== null) {
      console.warn("A chunk of this page failed to load again after it reloaded for one, so it does not reload again.");
      return false;
    }
    sessionStorage.setItem(RELOADED_FOR_CHUNK, "1");
    reloading = true;
  } catch {
    // Without the tab's storage it cannot tell whether it reloaded already, so it does not.
    return false;
  }
  window.location.reload();
  return true;
}

/** A chunk loaded, so one failing after it reloads the page again. */
function forgetChunkReload(): void {
  if (reloading) return;
  try {
    sessionStorage.removeItem(RELOADED_FOR_CHUNK);
  } catch {
    // Without the tab's storage no reload was kept to forget.
  }
}
