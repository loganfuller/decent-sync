import { Inject, Injectable } from "@nestjs/common";
import { isPluginRepo } from "@decent-sync/protocol";
import { CONFIG } from "../config.module.js";
import type { Config } from "../config.js";

// What the server asks GitHub, to find the build a plugin or Skin is at so
// that it can be pinned there (ADR-0035, #678): the commit a tag points at,
// the plugin package at a commit's root, a release's download, a branch's
// latest commits and the ETag GitHub serves a commit's archive with. Read-only, without credentials, so only of public
// repositories and within GitHub's limit for requests without them, 60 an
// hour from one address. Nothing is kept: each instance asks afresh.

/** How long one request to GitHub may take. */
const REQUEST_TIMEOUT_MS = 5_000;

/** The most of an answer that is read: a release with many assets is a few tens of kilobytes. */
const MAX_ANSWER_BYTES = 512 * 1024;

/** How many of a branch's latest commits are tried for the one a Skin was installed at. */
export const BRANCH_COMMITS_TRIED = 5;

/** GitHub did not answer, or answered that it would not, as past its rate limit: said to the Admin, with no pin offered. */
export class GitHubUnavailable extends Error {
  override name = "GitHubUnavailable";
}

/** A repository's name, or a ref's, as path segments GitHub's URLs take: each encoded, none empty or a dot segment. */
function pathOf(name: string): string | null {
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
}

/** An ETag without its weakness mark and quotes, as two requests for one archive may differ in them. */
export function bareEtag(etag: string | null | undefined): string | null {
  if (typeof etag !== "string") return null;
  const bare = etag.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  return bare === "" ? null : bare;
}

@Injectable()
export class GitHub {
  /** Where GitHub's API and its archives are asked for: GitHub's own, or for tests one stand-in for both (TEST_GITHUB_URL). */
  private readonly api: string;
  private readonly site: string;

  constructor(@Inject(CONFIG) config: Config) {
    this.api = config.testGithubUrl ?? "https://api.github.com";
    this.site = config.testGithubUrl ?? "https://github.com";
  }

  /** The commit a repository's tag points at, in full; null where GitHub knows no such tag or repository. */
  async tagCommit(repo: string, tag: string): Promise<string | null> {
    return this.commit(repo, `tags/${tag}`);
  }

  /**
   * The URL of a release's download as Decaid's install of a Skin picks it
   * (`WebUIStorage.installFromGitHubRelease`): the asset of that name, or
   * the first whose name ends in `.zip`. Null where GitHub knows no such
   * release, or it holds no such asset.
   */
  async releaseDownload(repo: string, tag: string, assetName: string | null): Promise<string | null> {
    const path = this.repoPath(repo, `releases/tags/${tag}`);
    const release = path === null ? null : await this.json(`${this.api}/repos/${path}`);
    const assets = isRecord(release) && Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
    const asset = assets.find((each) => typeof each.name === "string" && (assetName === null ? each.name.endsWith(".zip") : each.name === assetName));
    return typeof asset?.browser_download_url === "string" ? asset.browser_download_url : null;
  }

  /** A branch's latest commits, newest first, at most BRANCH_COMMITS_TRIED; none where GitHub knows no such branch or repository. */
  async branchCommits(repo: string, branch: string): Promise<string[]> {
    const path = this.repoPath(repo, "commits");
    if (path === null) return [];
    const commits = await this.json(`${this.api}/repos/${path}?sha=${encodeURIComponent(branch)}&per_page=${BRANCH_COMMITS_TRIED}`);
    return Array.isArray(commits) ? commits.flatMap((commit) => (isRecord(commit) && typeof commit.sha === "string" && /^[0-9a-f]{40}$/i.test(commit.sha) ? [commit.sha] : [])) : [];
  }

  /**
   * The plugin package at the root of a commit, by its manifest's id and
   * version: what Decaid installs from the commit's archive, whose one
   * folder it looks into for `manifest.json` beside `plugin.js`
   * (`resolvePluginPackage`, Decaid v0.9.3). Null where the root holds no
   * package, as where a repository's releases ship a built one and its
   * source lies in folders below; then no commit of it installs.
   */
  async packageAt(repo: string, commit: string): Promise<{ id: string | null; version: string | null } | null> {
    if (!/^[0-9a-f]{40}$/i.test(commit)) return null;
    const path = this.repoPath(repo, "contents");
    if (path === null) return null;
    const listing = await this.json(`${this.api}/repos/${path}?ref=${commit}`);
    const files = Array.isArray(listing) ? listing.filter(isRecord).filter((entry) => entry.type === "file").map((entry) => entry.name) : [];
    if (!files.includes("manifest.json") || !files.includes("plugin.js")) return null;
    const response = await this.ask(`${this.api}/repos/${path}/manifest.json?ref=${commit}`, { headers: { accept: "application/vnd.github.raw+json" } });
    if (response === null) return null;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await this.text(response));
    } catch (error) {
      if (error instanceof GitHubUnavailable) throw error;
      // Decaid refuses a manifest it can't read as invalid: no package.
      return null;
    }
    if (!isRecord(manifest)) return null;
    return { id: typeof manifest.id === "string" ? manifest.id : null, version: typeof manifest.version === "string" ? manifest.version : null };
  }

  /**
   * The ETag GitHub serves a commit's archive with, bare (`bareEtag`); null
   * where it serves none. GitHub serves a branch's archive with the ETag of
   * the commit at its head, which is how a Skin installed from a branch,
   * whose commit Decaid does not record, is matched to one.
   */
  async archiveEtag(repo: string, commit: string): Promise<string | null> {
    const path = this.repoPath(repo, `archive/${commit}.zip`);
    if (path === null) return null;
    const response = await this.ask(`${this.site}/${path}`, { method: "HEAD" });
    return response === null ? null : bareEtag(response.headers.get("etag"));
  }

  private async commit(repo: string, ref: string): Promise<string | null> {
    const path = this.repoPath(repo, `commits/${ref}`);
    if (path === null) return null;
    const response = await this.ask(`${this.api}/repos/${path}`, { headers: { accept: "application/vnd.github.sha" } });
    const sha = response === null ? "" : (await this.text(response)).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
  }

  /** A repository with what follows it, as a path; null for a repository or a rest no GitHub URL names. */
  private repoPath(repo: string, rest: string): string | null {
    const [named, following] = [isPluginRepo(repo) ? pathOf(repo) : null, pathOf(rest)];
    return named === null || following === null ? null : `${named}/${following}`;
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.ask(url, { headers: { accept: "application/vnd.github+json" } });
    if (response === null) return null;
    try {
      return JSON.parse(await this.text(response));
    } catch {
      throw new GitHubUnavailable("GitHub's answer could not be read");
    }
  }

  /** GitHub's answer; null where it knows nothing by that name, which it says with 404, or 422 for a ref. */
  private async ask(url: string, init: RequestInit): Promise<Response | null> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: { "user-agent": "decent-sync-server", ...init.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new GitHubUnavailable("GitHub did not answer");
    }
    if (response.status === 404 || response.status === 422) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Past its limit for requests without credentials, GitHub answers 403 or 429.
      throw new GitHubUnavailable(response.status === 403 || response.status === 429 ? "GitHub is taking no more requests from this server for now" : `GitHub answered ${response.status}`);
    }
    return response;
  }

  /** An answer's text, read up to MAX_ANSWER_BYTES. */
  private async text(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new GitHubUnavailable("GitHub's answer was too large to read");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof GitHubUnavailable) throw error;
      throw new GitHubUnavailable("GitHub did not answer");
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
