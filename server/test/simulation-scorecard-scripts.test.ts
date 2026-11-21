import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, admin } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// The simulation's scorecard scripts against a real server (#599): pull.mjs
// saves a spread of an instance's Shots read-only and signs out, scrub.mjs
// turns them into corpus Shots, and score.mjs scores either. The Shots are
// ones Decaid v0.9.2's simulated machine recorded
// (fixtures/decaid/simulated-shots-v0.9.2/). Serials are made up, from 57801.

type Fields = Record<string, unknown>;

const SCRIPTS = new URL("../../scripts/simulation/", import.meta.url).pathname;
const FIXTURES = ["classic-italian", "blooming", "default"];
const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("The scorecard scripts on a real server's Shots", () => {
  let server: TestServer;
  let api: AdminApi;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "decent-sync-scorecard-"));

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    const lab = await api.createLocation("Scorecard lab", "America/Chicago");
    const machine = await api.createMachine("Scorecard lab 1", lab.id);
    const tablet = syncingTablet(machine, server, { api: emptyLibrary("57801") });
    await api.waitForOnline(machine);
    for (const name of FIXTURES) {
      const recorded = JSON.parse(fs.readFileSync(new URL(`./fixtures/decaid/simulated-shots-v0.9.2/${name}.json`, import.meta.url), "utf8")) as Fields & { workflow: Fields };
      tablet.pullShot({ ...recorded, id: `scorecard-${name}`, workflow: { ...recorded.workflow, machine: { ...(recorded.workflow.machine as Fields), serialNumber: "57801" } } });
    }
    for (let waited = 0; (await api.get<{ total: number }>("/shots?limit=1")).total < FIXTURES.length; waited += 100) {
      if (waited > 30_000) throw new Error("The Shots never arrived");
      await delay(100);
    }
  });
  afterAll(async () => {
    await server?.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8", env: { ...process.env, ...extra } });

  it("pulls a spread of Shots with their measurements, leaving no session behind, then scrubs and scores them", async () => {
    const database = await server.connectDatabase();
    try {
      const sessions = async () => Number((await database.query("SELECT count(*) FROM sessions")).rows[0].count);
      const before = await sessions();
      const pulled = path.join(scratch, "pulled");
      const said = run("pull.mjs", [pulled, "--per", "2"], { DECENT_SYNC_URL: server.url, DECENT_SYNC_EMAIL: admin.email, DECENT_SYNC_PASSWORD: admin.password });
      expect(said).toContain("signed out");
      expect(await sessions()).toBe(before);
      // Each of the Machine's three profiles, two at most of each.
      const files = fs.readdirSync(pulled).sort();
      expect(files).toEqual(FIXTURES.map((name) => `scorecard-${name}.json`).sort());
      const saved = JSON.parse(fs.readFileSync(path.join(pulled, files[0]!), "utf8")) as { shot: { id: string; record: Fields }; measurements: unknown[] };
      expect(saved.shot.record.workflow).toBeDefined();
      expect(saved.measurements.length).toBeGreaterThan(50);
      // Pulled again, it fetches only what it lacks.
      expect(run("pull.mjs", [pulled], { DECENT_SYNC_URL: server.url, DECENT_SYNC_EMAIL: admin.email, DECENT_SYNC_PASSWORD: admin.password })).toContain("fetched 0 new");
      expect(await sessions()).toBe(before);

      const corpus = path.join(scratch, "corpus");
      expect(run("scrub.mjs", [pulled, corpus, "--set"])).toContain("wrote 3 corpus Shots");
      expect(fs.readdirSync(corpus).sort()).toEqual(["de1pro-001.json", "de1pro-002.json", "de1pro-003.json"]);
      const scrubbed = fs.readFileSync(path.join(corpus, "de1pro-001.json"), "utf8");
      for (const leaked of ["scorecard-", "57801", "mock-de1", "2026-", "Classic", "Blooming"]) expect(scrubbed).not.toContain(leaked);

      const raw = JSON.parse(run("score.mjs", [pulled, "--json"])) as { models: { DE1: { all: { shots: number; within: number } } } };
      const fromCorpus = JSON.parse(run("score.mjs", [corpus, "--json"])) as { models: { DE1: { all: { shots: number; within: number } } }; sets: { same: { pairs: number }; different: { pairs: number } } };
      expect(raw.models.DE1.all.shots).toBe(3);
      // Rounded to three places, and weights to two, its figures land where the Shot's own do.
      expect(fromCorpus.models.DE1.all).toMatchObject({ shots: raw.models.DE1.all.shots, within: raw.models.DE1.all.within });
      // The three, one set, each Shot's puck run with each other's steps: three profiles, so different steps.
      expect(fromCorpus.sets.different.pairs).toBe(6);
    } finally {
      await database.end();
    }
  });

  it("refuses to save Shots inside the repo, before signing in", () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(SCRIPTS, "pull.mjs"), path.join(SCRIPTS, "pulled")], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, DECENT_SYNC_URL: server.url, DECENT_SYNC_EMAIL: admin.email, DECENT_SYNC_PASSWORD: admin.password },
      }),
    ).toThrow(/inside the repo/);
    expect(fs.existsSync(path.join(SCRIPTS, "pulled"))).toBe(false);
  });
});
