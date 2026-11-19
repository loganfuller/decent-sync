import type { ProfileVersion } from "@/lib/api";

// A Profile's Profile Versions as its page names them (#578).

/**
 * What the page calls each version: "Version n", numbered from the first
 * saved, each branch of a fork in the order its versions were saved; but one
 * of Decaid's bundled Profiles, which is Decaid's own and never a version
 * anyone saved, by its title. A chain of one Profile names it by nothing.
 */
export function versionNames(versions: readonly ProfileVersion[]): Map<string, string> {
  const names = new Map<string, string>();
  const saved = versions.filter((version) => !version.bundled).sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id));
  if (versions.length > 1) saved.forEach((version, index) => names.set(version.id, `Version ${index + 1}`));
  for (const version of versions) if (!names.has(version.id)) names.set(version.id, version.title?.trim() || version.id);
  return names;
}

/** The versions a Profile was saved from, the nearest first, through each one's `parentId`. */
export function earlierVersions(versions: readonly ProfileVersion[], id: string): ProfileVersion[] {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const earlier: ProfileVersion[] = [];
  const seen = new Set([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    earlier.push(parent);
    seen.add(parentId);
    parentId = parent.parentId;
  }
  return earlier;
}
