import { ConflictException, Injectable } from "@nestjs/common";
import { type CollectionName, commitArchiveUrl, pluginSourceSeen, releaseAssetOf, skinSourceSeen } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import { GitHub, GitHubUnavailable, bareEtag } from "./github.js";
import { takesSourceChanges } from "./software-actions.service.js";
import { type PinnedSourceView, type PluginSourceView, type SkinSourceView, type TabletSoftwareView, pluginSources, pluginUpdates, skinSources, skinUpdates, tabletSoftwareView } from "./tablet-software.js";

const REPORTS = ["plugins", "pluginSettings", "skins", "skinPage", "decaidUpdate", "appSettings"] as const satisfies readonly CollectionName[];

/** A Machine's Tablet Software, from what its Tablet last reported (ADR-0034). */
@Injectable()
export class TabletSoftwareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHub,
  ) {}

  /**
   * Decaid, the plugins and the Skins on the Machine's Tablet, each with how
   * it updates. Everyone who reads the Machine reads them; the values of the
   * plugins' settings go to Admins alone, as they may name an account on
   * another service.
   */
  async get(machineId: string, scope: Scope): Promise<TabletSoftwareView> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { decaidVersion: true, wireRevision: true } });
    if (!machine) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { machineId, name: { in: [...REPORTS] } },
      select: { name: true, available: true, reportedAt: true, value: true, receivedAt: true },
    });
    const report = (name: (typeof REPORTS)[number]) => rows.find((row) => row.name === name) ?? null;
    return tabletSoftwareView(
      { plugins: report("plugins"), pluginSettings: report("pluginSettings"), skins: report("skins"), skinPage: report("skinPage"), decaidUpdate: report("decaidUpdate"), appSettings: report("appSettings") },
      { decaidVersion: machine.decaidVersion, takesSourceChanges: takesSourceChanges(machine.wireRevision) },
      scope.kind === "everything",
    );
  }

  /**
   * The sources the plugins on the other Machines were installed from,
   * which the install form offers, most used first: an Admin's read, as
   * the form is.
   */
  async sources(machineId: string): Promise<PluginSourceView[]> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { name: "plugins", machineId: { not: machineId }, receivedAt: { not: null } },
      select: { value: true },
    });
    return pluginSources(rows.map((row) => row.value));
  }

  /** The sources the Skins on the other Machines were installed from, which the Skin install form offers, most used first: an Admin's read. */
  async skinSources(machineId: string): Promise<SkinSourceView[]> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const rows = await this.prisma.reportedCollection.findMany({
      where: { name: "skins", machineId: { not: machineId }, receivedAt: { not: null } },
      select: { value: true },
    });
    return skinSources(rows.map((row) => row.value));
  }

  /**
   * Where a plugin or Skin on the Machine's Tablet can be pinned to hold it
   * at the build installed now (`PinnedSourceView`), from what its Tablet
   * last reported and what GitHub says of it: an Admin's read, as the form
   * that offers it is. 409 where the Tablet reports no such item.
   */
  async pinnedSource(machineId: string, item: { pluginId: string } | { skinId: string }): Promise<PinnedSourceView> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const name = "pluginId" in item ? "plugins" : "skins";
    const report = await this.prisma.reportedCollection.findUnique({ where: { machineId_name: { machineId, name } }, select: { value: true, receivedAt: true } });
    const value: unknown = report?.receivedAt ? report.value : undefined;
    const list: unknown = "pluginId" in item ? value : isRecord(value) ? value.skins : undefined;
    const id = "pluginId" in item ? item.pluginId : item.skinId;
    const entry = Array.isArray(list) ? (list as unknown[]).find((each): each is Record<string, unknown> => isRecord(each) && each.id === id) : undefined;
    if (!entry) throw new ConflictException(`The Tablet reports no such ${"pluginId" in item ? "plugin" : "Skin"}: it may have been removed since the page was loaded`);
    const build = "pluginId" in item ? pluginSourceSeen(entry) : skinSourceSeen(entry);
    try {
      return { ...("pluginId" in item ? await this.pinnedPlugin(entry) : await this.pinnedSkin(entry)), build };
    } catch (error) {
      if (error instanceof GitHubUnavailable) return { ...NOWHERE, unavailable: error.message, build };
      throw error;
    }
  }

  private async pinnedPlugin(plugin: Record<string, unknown>): Promise<Pinned> {
    const updates = pluginUpdates(plugin.source);
    const source = isRecord(plugin.source) ? plugin.source : {};
    if (updates.how === "followsBranch" && updates.repo !== null && typeof source.commit === "string" && /^[0-9a-f]{40}$/i.test(source.commit)) {
      return { ...NOWHERE, source: { repo: updates.repo, branch: source.commit }, commit: source.commit };
    }
    if (updates.how === "followsReleases" && updates.repo !== null && typeof source.releaseTag === "string" && source.releaseTag !== "") {
      const commit = await this.github.tagCommit(updates.repo, source.releaseTag);
      return commit === null ? NOWHERE : { ...NOWHERE, source: { repo: updates.repo, branch: commit }, tag: source.releaseTag, commit };
    }
    return NOWHERE;
  }

  private async pinnedSkin(skin: Record<string, unknown>): Promise<Pinned> {
    const updates = skinUpdates(skin);
    const metadata = isRecord(skin.reaMetadata) ? skin.reaMetadata : {};
    if (updates.how === "followsReleases" && updates.repo !== null) {
      const tag = /^github_release:[^@]+@(.+)$/.exec(String(metadata.sourceUrl))?.[1];
      if (tag === undefined) return NOWHERE;
      const url = await this.github.releaseDownload(updates.repo, tag, typeof metadata.releaseAssetName === "string" ? metadata.releaseAssetName : null);
      // Only a download that then shows as Pinned at that tag: one release's, of that repository.
      const asset = releaseAssetOf(url);
      return url !== null && asset !== null && asset.tag === tag && asset.repo.toLowerCase() === updates.repo.toLowerCase() ? { ...NOWHERE, source: { url }, tag } : NOWHERE;
    }
    if (updates.how === "followsBranch" && updates.repo !== null) {
      const etag = bareEtag(typeof metadata.etag === "string" ? metadata.etag : null);
      if (etag === null) return NOWHERE;
      const repo = updates.repo;
      const commits = await this.github.branchCommits(repo, updates.branch);
      const etags = await Promise.all(commits.map((commit) => this.github.archiveEtag(repo, commit)));
      const commit = commits[etags.indexOf(etag)];
      return commit === undefined ? NOWHERE : { ...NOWHERE, source: { url: commitArchiveUrl(repo, commit) }, commit };
    }
    return NOWHERE;
  }
}

/** Where an item can be pinned, before the build it was worked out from is added. */
type Pinned = Omit<PinnedSourceView, "build">;

/** An item that can't be pinned where it is. */
const NOWHERE: Pinned = { source: null, tag: null, commit: null, unavailable: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
