// The DYE2 and Streamline on a Machine's tablet, from the collections its
// tablet reports: `plugins` (Decaid's plugin list) and `skins` (its Skins,
// its default Skin and what its WebUI server serves). Decaid's payloads are
// opaque, so every field is optional here, and one of another type is left
// out. Nothing here is enforced: it is only shown (ticket #236).

import { DYE2_NAMESPACE } from "@decent-sync/protocol";
import type { Report } from "./paired-devices.js";

/** Streamline's Skin ids: a release, and a build of `main` (its `dist` branch). */
const STREAMLINE_BUILDS: Readonly<Record<string, StreamlineBuild>> = { "streamline.js": "release", "streamline.js-dist": "main" };

export type StreamlineBuild = "release" | "main";

/** DYE2, as Decaid's plugin list names it, by its id. */
export type Dye2View =
  | { status: "notReported" }
  | { status: "notInstalled" }
  | {
      status: "installed";
      /** Its manifest's version. */
      version: string | null;
      /** Whether Decaid has it loaded: not when disabled, or when it failed to load. */
      loaded: boolean;
      /** The branch it was installed from, for a branch install; null for any other. */
      branch: string | null;
    };

/** Streamline, if it is the Skin Decaid is serving. */
export type StreamlineView =
  | { status: "notReported" }
  | { status: "notInstalled" }
  | {
      status: "notActive";
      /** The Skin that is, or null if none is. */
      activeSkin: { name: string | null; version: string | null } | null;
    }
  | { status: "active"; version: string | null; build: StreamlineBuild };

export interface TabletVersionsView {
  dye2: Dye2View;
  streamline: StreamlineView;
}

type Record_ = Record<string, unknown>;

export function tabletVersionsView(reports: { plugins: Report | null; skins: Report | null }): TabletVersionsView {
  return { dye2: dye2View(latestValue(reports.plugins)), streamline: streamlineView(latestValue(reports.skins)) };
}

/** DYE2's entry in the plugin list, as last reported. */
export function dye2View(plugins: unknown): Dye2View {
  if (!Array.isArray(plugins)) return { status: "notReported" };
  const entry = plugins.find((plugin): plugin is Record_ => isRecord(plugin) && plugin.id === DYE2_NAMESPACE);
  if (!entry) return { status: "notInstalled" };
  const source = isRecord(entry.source) ? entry.source : null;
  return {
    status: "installed",
    version: text(entry.version),
    loaded: entry.loaded === true,
    branch: source?.kind === "github_branch" ? text(source.branch) : null,
  };
}

/**
 * Streamline, from the Skins as last reported. The active Skin is the one
 * Decaid is serving, whose `path` is the WebUI server's, or else, as when it
 * serves none or a folder no Skin holds, its default Skin. Quick Settings can
 * serve a Skin other than the default. Only the active Streamline counts,
 * even if both builds are installed.
 */
export function streamlineView(skins: unknown): StreamlineView {
  if (!isRecord(skins) || !Array.isArray(skins.skins)) return { status: "notReported" };
  const installed = skins.skins.filter(isRecord);
  if (!installed.some((skin) => streamlineBuild(skin.id) !== undefined)) return { status: "notInstalled" };
  const servedPath = isRecord(skins.server) ? text(skins.server.path) : null;
  const served = servedPath === null ? undefined : installed.find((skin) => skin.path === servedPath);
  const active = served ?? (isRecord(skins.default) ? skins.default : null);
  if (active === null) return { status: "notActive", activeSkin: null };
  const build = streamlineBuild(active.id);
  if (build === undefined) return { status: "notActive", activeSkin: { name: text(active.name), version: text(active.version) } };
  return { status: "active", version: text(active.version), build };
}

/** Which Streamline a Skin of that id is, if it is one. */
function streamlineBuild(id: unknown): StreamlineBuild | undefined {
  return typeof id === "string" && Object.hasOwn(STREAMLINE_BUILDS, id) ? STREAMLINE_BUILDS[id] : undefined;
}

/** The latest value its tablet reported, kept while a later read was unavailable; undefined if it never reported one. */
function latestValue(report: Report | null): unknown {
  return report !== null && report.receivedAt !== null ? report.value : undefined;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
