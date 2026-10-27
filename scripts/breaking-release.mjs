// Whether CI's checks against the latest release skip, as they do while a
// release that breaks ADR-0025's rule is on its way: from the merge of a pull
// request labelled `breaking-release` until the next release is tagged, and
// on a pull request carrying the label itself. Those checks are the latest
// release's suite on the change's schema (scripts/latest-release-suite.mjs)
// and the Seam 1 tests that run it beside the change, the mixed-versions
// suite among them. The jobs running them take this as a step, and their
// later steps skip on its `skip` output, so each check still reports.
//
// The pull requests are found through GitHub's API: those labelled and merged
// into main whose merge commit is among the commits from the latest release's
// tag to the commit under test (main's, or a pull request's merge with main),
// and on a pull request, its own labels. They are read directly, not through
// GitHub's search, which can miss a pull request for a while after its merge:
// just when the push run of its merge commit asks. It needs main's history
// and the tags (actions/checkout with `fetch-depth: 0`), GH_TOKEN with
// `pull-requests: read`, GITHUB_REPOSITORY and GITHUB_OUTPUT, and on a pull
// request PULL_REQUEST, its number. Only the owner applies the label (AGENTS.md).
//
// Usage: node scripts/breaking-release.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { repoDir } from "../server/test/support/build-table.mjs";
import { latestReleaseTag } from "../server/test/support/latest-release.mjs";

const LABEL = "breaking-release";

const run = (command, ...args) => execFileSync(command, args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const repo = process.env.GITHUB_REPOSITORY;
const pullRequest = process.env.PULL_REQUEST;

const tag = latestReleaseTag();
const since = new Set(run("git", "rev-list", `${tag}..HEAD`).split("\n").filter(Boolean));
// The most recently updated first: a pull request merged since the tag is among them.
const query = `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(labels: [$label], states: MERGED, baseRefName: "main", first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number mergeCommit { oid } }
    }
  }
}`;
const [owner, name] = repo.split("/");
const labelled = JSON.parse(
  run("gh", "api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `label=${LABEL}`, "--jq", ".data.repository.pullRequests.nodes"),
);
const merged = labelled.filter((pr) => since.has(pr.mergeCommit?.oid)).map((pr) => `#${pr.number}`);
const own = pullRequest
  ? JSON.parse(run("gh", "pr", "view", pullRequest, "--repo", repo, "--json", "labels")).labels.some((label) => label.name === LABEL)
  : false;

const reasons = [
  ...(own ? [`this pull request is labelled ${LABEL}`] : []),
  ...(merged.length > 0 ? [`${merged.join(", ")}, labelled ${LABEL}, ${merged.length === 1 ? "was" : "were"} merged into main after ${tag}`] : []),
];
if (reasons.length === 0) {
  console.log(`No pull request labelled ${LABEL} is merged into main after ${tag}${pullRequest ? `, nor is this one labelled` : ""}, so the checks against ${tag} run.`);
} else {
  // A notice shows on the run's summary page, where a skipped check would otherwise look like a pass.
  console.log(
    `::notice title=Checks against ${tag} skipped::Skipped: ${reasons.join("; ")}. A breaking release doesn't run beside ${tag}, ` +
      "so the checks against it skip until the next release is tagged (ADR-0025).",
  );
  fs.appendFileSync(process.env.GITHUB_OUTPUT, "skip=true\n");
}
