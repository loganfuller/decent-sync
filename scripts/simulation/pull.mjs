// Pulls a spread of Shots from a Decent Sync instance, read-only, into a
// folder outside this repo, so anyone can score their own Shots
// (score.mjs) or scrub some into the corpus (scrub.mjs). It signs in, makes
// only GET requests, saves each Shot as `{ shot, measurements }` from
// `GET /api/shots/:id` and `/api/shots/:id/measurements`, and signs out,
// leaving no session behind, also when stopped or when a request fails.
//
// Usage: DECENT_SYNC_URL=<server URL> DECENT_SYNC_EMAIL=<email> DECENT_SYNC_PASSWORD=<password> \
//          node scripts/simulation/pull.mjs <folder> [--per <n>] [--tea <n>] [--since <date>]
//   <folder>   where to save them, outside the repo: they hold everything the instance keeps of each Shot.
//   --per      the most Shots of each Machine and profile, spread evenly over the time they were pulled; 30 by default.
//   --tea      the same for a profile whose title says tea; 3 by default.
//   --since    only Shots pulled on or after this date, as 2026-08-25.
// A Shot already in the folder is not fetched again.

import fs from "node:fs";
import path from "node:path";
import { isTea } from "./scorecard.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** Up to `per` of each Machine's Shots of each profile title, `tea` of a tea profile's, spread evenly from its first to its last. */
export function spreadOut(listed, per, tea) {
  const groups = new Map();
  for (const shot of listed) {
    const key = `${shot.machine?.id ?? shot.pendingMachine?.id ?? "?"}|${shot.profileTitle ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shot);
  }
  const chosen = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.pulledAt.localeCompare(b.pulledAt));
    const count = Math.min(isTea(group[0].profileTitle) ? tea : per, group.length);
    for (let n = 0; n < count; n++) chosen.push(group[count === 1 ? 0 : Math.round((n * (group.length - 1)) / (count - 1))]);
  }
  return chosen;
}

/** Signs in to `base`, saves a spread of its Shots (`spreadOut`) into `out`, and signs out; returns how many it listed, chose and fetched. */
export async function pull({ base, email, password, out, per = 30, tea = 3, since = null }) {
  const resolved = path.resolve(out);
  if (resolved === REPO || resolved.startsWith(`${REPO}${path.sep}`)) throw new Error(`${out} is inside the repo; pulled Shots hold everything the instance keeps of them, so save them outside it`);
  let cookie = "";
  const api = async (method, route, body) => {
    const response = await fetch(new URL(route, base), {
      method,
      headers: { origin: new URL(base).origin, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length > 0) cookie = set.map((c) => c.split(";")[0]).join("; ");
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await api("POST", "/api/session", { email, password });
  const signOut = () => api("DELETE", "/api/session");
  const onSignal = () => signOut().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  try {
    const listed = [];
    for (;;) {
      const page = await api("GET", `/api/shots?limit=100&offset=${listed.length}`);
      listed.push(...page.shots);
      if (page.shots.length === 0 || listed.length >= page.total) break;
    }
    const after = since === null ? listed : listed.filter((shot) => shot.pulledAt >= new Date(since).toISOString());
    const chosen = spreadOut(after, per, tea);
    fs.mkdirSync(resolved, { recursive: true });
    let fetched = 0;
    for (const { id } of chosen) {
      const file = path.join(resolved, `${id}.json`);
      if (fs.existsSync(file)) continue;
      const { shot } = await api("GET", `/api/shots/${encodeURIComponent(id)}`);
      const { measurements } = await api("GET", `/api/shots/${encodeURIComponent(id)}/measurements`);
      fs.writeFileSync(file, JSON.stringify({ shot, measurements }));
      fetched++;
    }
    return { listed: listed.length, chosen: chosen.length, fetched };
  } finally {
    process.off("SIGINT", onSignal);
    await signOut();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at < 0 ? fallback : args[at + 1];
  };
  const out = args.find((arg, n) => !arg.startsWith("--") && !["--per", "--tea", "--since"].includes(args[n - 1]));
  const { DECENT_SYNC_URL: base, DECENT_SYNC_EMAIL: email, DECENT_SYNC_PASSWORD: password } = process.env;
  const missing = [["DECENT_SYNC_URL", base], ["DECENT_SYNC_EMAIL", email], ["DECENT_SYNC_PASSWORD", password], ["the folder", out]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(", ")}.`);
    console.error("Usage: DECENT_SYNC_URL=<server URL> DECENT_SYNC_EMAIL=<email> DECENT_SYNC_PASSWORD=<password> node scripts/simulation/pull.mjs <folder> [--per <n>] [--tea <n>] [--since <date>]");
    process.exit(1);
  }
  const result = await pull({ base, email, password, out, per: Number(option("--per", 30)), tea: Number(option("--tea", 3)), since: option("--since", null) });
  console.log(`listed ${result.listed} Shots, chose ${result.chosen}, fetched ${result.fetched} new into ${out}; signed out`);
}
