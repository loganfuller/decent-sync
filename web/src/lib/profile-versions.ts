import type { ProfileVersion } from "@/lib/api";

// A Profile's Profile Versions as its page names them (#578, #735).

/**
 * What the page calls each version: "Version n", by the number the server
 * gave it as it joined the Profile (ADR-0038), which is never given again;
 * but one of Decaid's bundled Profiles, which is Decaid's own and never a
 * version anyone saved, by its title. A Profile of one version names it by
 * nothing. Where the server, of the release before, gives no numbers, they
 * are numbered here from the first saved.
 */
export function versionNames(versions: readonly ProfileVersion[]): Map<string, string> {
  const names = new Map<string, string>();
  const saved = versions.filter((version) => !version.bundled).sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.id.localeCompare(b.id));
  if (versions.length > 1) saved.forEach((version, index) => names.set(version.id, `Version ${version.number ?? index + 1}`));
  for (const version of versions) if (!names.has(version.id)) names.set(version.id, version.title?.trim() || version.id);
  return names;
}

/**
 * The Profile's other versions than `id`, as the server lists them: the ones
 * a version can be returned to or compared with, and whose Shots are the
 * Profile's too. From a server of the release before, which lists a chain
 * of `parentId` links, the versions `id` was saved from, the nearest first,
 * up to a bundled Profile, which is Decaid's and no version anyone saved.
 */
export function otherVersions(versions: readonly ProfileVersion[], id: string): ProfileVersion[] {
  if (versions.some((version) => version.current !== undefined)) return versions.filter((version) => version.id !== id && !version.bundled);
  const byId = new Map(versions.map((version) => [version.id, version]));
  const earlier: ProfileVersion[] = [];
  const seen = new Set([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent || parent.bundled) break;
    earlier.push(parent);
    seen.add(parentId);
    parentId = parent.parentId;
  }
  return earlier;
}
