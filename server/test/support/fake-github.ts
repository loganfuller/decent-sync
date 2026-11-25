import http from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for GitHub for tests at Seam 1 and Seam 2 (#678), on a loopback
// address, which a test server asks in place of GitHub's API and its
// archives with TEST_GITHUB_URL set to it: the routes the server reads to
// find the build a plugin or Skin is at (server/src/software-actions/github.ts),
// answered in the shapes GitHub's own were seen to have on 2026-11-25 for
// decentespresso/streamline-js:
//
// - `GET /repos/<repo>/commits/tags/<tag>` with `Accept: application/vnd.github.sha`:
//   the commit's id as text, or 422 for a tag it does not know;
// - `GET /repos/<repo>/releases/tags/<tag>`: `{ tag_name, assets: [{ name, browser_download_url }] }`, or 404;
// - `GET /repos/<repo>/commits?sha=<branch>&per_page=<n>`: `[{ sha }]`, newest first, or 404;
// - `GET /repos/<repo>/contents?ref=<commit>`: the files and folders at the
//   commit's root, `[{ name, type }]`, or 404;
// - `GET /repos/<repo>/contents/<file>?ref=<commit>` with
//   `Accept: application/vnd.github.raw+json`: the file's content, or 404;
// - `HEAD /<repo>/archive/<commit>.zip`: 200 with the archive's `ETag`, which
//   GitHub serves alike for a branch's archive while that commit is its head, or 404.
//
// Apart from Vitest, so Playwright can load it too.

/** The setting a test server needs to ask a fake GitHub in place of GitHub. */
export function githubEnv(github: FakeGitHub): { TEST_GITHUB_URL: string } {
  return { TEST_GITHUB_URL: github.url };
}

export interface FakeGitHub {
  url: string;
  /** Every request it took, as `METHOD path`, oldest first. */
  requests: string[];
  /** Has a repository's tag point at a commit. */
  tag(repo: string, tag: string, commit: string): void;
  /** Has a repository hold a release at a tag, with these assets by name, each downloaded from GitHub's usual URL for it. */
  release(repo: string, tag: string, assets: string[]): void;
  /** Has a repository's branch hold these commits, newest first, each with the ETag its archive is served with. */
  branch(repo: string, branch: string, commits: { commit: string; etag: string }[]): void;
  /** Has a repository's commit hold these files at its root, by name, with their content, and these folders. */
  root(repo: string, commit: string, files: Record<string, string>, folders?: string[]): void;
  /** Answers every request with this status from now on, as past GitHub's rate limit (403), or as usual again (null). */
  answerAll(status: number | null): void;
  close(): Promise<void>;
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const tags = new Map<string, string>();
  const releases = new Map<string, string[]>();
  const branches = new Map<string, { commit: string; etag: string }[]>();
  const roots = new Map<string, { files: Record<string, string>; folders: string[] }>();
  const requests: string[] = [];
  let always: number | null = null;
  const key = (repo: string, name: string) => `${repo.toLowerCase()} ${name}`;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const route = decodeURIComponent(url.pathname);
    requests.push(`${request.method} ${route}${url.search}`);
    const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (always !== null) return void json(always, { message: "API rate limit exceeded" });

    const tagCommit = /^\/repos\/([^/]+\/[^/]+)\/commits\/tags\/(.+)$/.exec(route);
    if (request.method === "GET" && tagCommit) {
      const commit = tags.get(key(tagCommit[1]!, tagCommit[2]!));
      if (commit === undefined) return void json(422, { message: `No commit found for SHA: tags/${tagCommit[2]}` });
      return void response.writeHead(200, { "Content-Type": "application/vnd.github.sha" }).end(commit);
    }
    const release = /^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(route);
    if (request.method === "GET" && release) {
      const [, repo, tag] = release as unknown as [string, string, string];
      const assets = releases.get(key(repo, tag));
      if (assets === undefined) return void json(404, { message: "Not Found" });
      return void json(200, { tag_name: tag, assets: assets.map((name) => ({ name, browser_download_url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}` })) });
    }
    const commits = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(route);
    if (request.method === "GET" && commits) {
      const held = branches.get(key(commits[1]!, url.searchParams.get("sha") ?? ""));
      if (held === undefined) return void json(404, { message: "Not Found" });
      return void json(200, held.slice(0, Number(url.searchParams.get("per_page") ?? 30)).map(({ commit }) => ({ sha: commit })));
    }
    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents(?:\/([^/]+))?$/.exec(route);
    if (request.method === "GET" && contents) {
      const held = roots.get(key(contents[1]!, url.searchParams.get("ref") ?? ""));
      if (held === undefined) return void json(404, { message: "Not Found" });
      if (contents[2] === undefined) return void json(200, [...Object.keys(held.files).map((name) => ({ name, type: "file" })), ...held.folders.map((name) => ({ name, type: "dir" }))]);
      const file = held.files[contents[2]];
      if (file === undefined) return void json(404, { message: "Not Found" });
      return void response.writeHead(200, { "Content-Type": "application/vnd.github.raw+json" }).end(file);
    }
    const archive = /^\/([^/]+\/[^/]+)\/archive\/([0-9a-f]{40})\.zip$/.exec(route);
    if (request.method === "HEAD" && archive) {
      const repo = archive[1]!.toLowerCase();
      const held = [...branches].filter(([name]) => name.startsWith(`${repo} `)).flatMap(([, each]) => each).find(({ commit }) => commit === archive[2]);
      if (held === undefined) return void response.writeHead(404).end();
      return void response.writeHead(200, { ETag: `"${held.etag}"`, "Content-Type": "application/zip" }).end();
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    tag: (repo, tag, commit) => void tags.set(key(repo, tag), commit),
    release: (repo, tag, assets) => void releases.set(key(repo, tag), assets),
    branch: (repo, branch, commits) => void branches.set(key(repo, branch), commits),
    root: (repo, commit, files, folders = []) => void roots.set(key(repo, commit), { files, folders }),
    answerAll: (status) => void (always = status),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
