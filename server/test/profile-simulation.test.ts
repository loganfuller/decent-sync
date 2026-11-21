import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type SimulatedRun, profileOf, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView, acceptInvite, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, asTools, serveTestApp } from "./support/assistants.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #577: a Library Profile simulated on the standard puck or a
// Shot's, through the REST API and the MCP endpoint (simulate_profile), with
// a real server and a simulated tablet whose Decaid holds one of its
// bundled Profiles. The Shot is one Decaid v0.9.2's simulated machine recorded
// (fixtures/decaid/simulated-shots-v0.9.2/). Serials are made up, from 57701.

type Fields = Record<string, unknown>;

interface Figures {
  duration: number;
  timeToFirstDrip: number | null;
  peakPressure: number;
  steps: Array<{ index: number; name: string; end: number }>;
}

interface Simulation {
  profile: { id: string; title: string | null };
  model: string;
  puck: Fields;
  dose: number;
  stopAt: number | null;
  run: SimulatedRun;
  checks: { blocking: unknown[]; advice: Array<{ code: string }> };
  fit: { shot: Figures; simulated: Figures } | null;
}

/** Classic Italian espresso, which Decaid bundles, by the id Decaid gives it. */
const CLASSIC = "profile:39e939592679fb194706";
const SHOT = "simulated-classic";
const FLOWLESS = "simulated-classic-flowless";
/** Classic Italian espresso's steps repeated to 21, one more than a machine takes, under a made-up id; and a Shot recorded on that profile. */
const LONG = "profile:0000000000000005770a";
const LONG_SHOT = "simulated-classic-long-profile";
/** The Shot again, its Machine reporting a pressure target its steps never asked for from its first pressure step on, as under a Bengle's group-head control; and as recorded where Decaid's capture of the Machine failed, naming no model. */
const MANUAL = "simulated-classic-manual";
const NO_MODEL = "simulated-classic-no-model";
/** The Shot again, as recorded on hardware no Machine has, 57709, which an Admin then dismisses. */
const DISMISSED = "simulated-classic-dismissed";

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

/** Waits, in a hook, where expect.poll can't, until the route answers 200: up to 30 s. */
async function answers(api: AdminApi, path: string): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 100) {
    if ((await api.call("GET", path)).status === 200) return;
    await delay(100);
  }
  throw new Error(`${path} never answered 200`);
}

describe("A Library Profile simulated on a puck", () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let tablet: SimulatedTablet;

  beforeAll(async () => {
    server = await startTestServer({ env });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    lab = await api.createLocation("Simulation lab", "America/Chicago");
    const machine = await api.createMachine("Simulation lab 1", lab.id);
    // Decaid v0.9.2's record of Classic Italian espresso, as it bundles it.
    const bundled = (JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/profile-ids-v0.9.2/profile-ids.json", import.meta.url), "utf8")) as { bundled: Fields[] }).bundled;
    const classic = bundled.find((record) => record.id === CLASSIC)!;
    const classicProfile = classic.profile as Fields & { steps: Fields[] };
    const longProfile = { ...classicProfile, title: "Too long", steps: Array.from({ length: 21 }, (_, n) => ({ ...classicProfile.steps[n % classicProfile.steps.length], name: `Step ${n + 1}` })) };
    tablet = syncingTablet(machine, server, { api: { ...emptyLibrary("57701"), "/profiles": [classic, { ...classic, id: LONG, profile: longProfile, isDefault: false }] } });
    await api.waitForOnline(machine);
    await answers(api, `/profiles/${encodeURIComponent(CLASSIC)}`);
    await answers(api, `/profiles/${encodeURIComponent(LONG)}`);
    const recorded = JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/simulated-shots-v0.9.2/classic-italian.json", import.meta.url), "utf8")) as Fields;
    const workflow = recorded.workflow as Fields;
    tablet.pullShot({ ...recorded, id: SHOT, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57701" } } });
    // The same Shot with no flow recorded, from which no puck can be worked out.
    const flowless = (recorded.measurements as Array<{ machine: Fields }>).map(({ machine: { flow: _, ...machine }, ...rest }) => ({ ...rest, machine }));
    tablet.pullShot({ ...recorded, id: FLOWLESS, measurements: flowless, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57701" } } });
    tablet.pullShot({ ...recorded, id: LONG_SHOT, workflow: { ...workflow, profile: longProfile, machine: { ...(workflow.machine as Fields), serialNumber: "57701" } } });
    const steered = (recorded.measurements as Array<{ machine: Fields }>).map((measurement) =>
      (measurement.machine.profileFrame as number) >= 2 ? { ...measurement, machine: { ...measurement.machine, targetPressure: 2.5 } } : measurement,
    );
    tablet.pullShot({ ...recorded, id: MANUAL, measurements: steered, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57701" } } });
    tablet.pullShot({ ...recorded, id: NO_MODEL, workflow: { ...workflow, machine: { provenanceStatus: "unavailable" } } });
    await answers(api, `/shots/${SHOT}`);
    await answers(api, `/shots/${MANUAL}`);
    await answers(api, `/shots/${NO_MODEL}`);
    await answers(api, `/shots/${FLOWLESS}`);
    await answers(api, `/shots/${LONG_SHOT}`);
    tablet.pullShot({ ...recorded, id: DISMISSED, workflow: { ...workflow, machine: { ...(workflow.machine as Fields), serialNumber: "57709" } } });
    await answers(api, `/shots/${DISMISSED}`);
    const pending = (await api.pendingMachines()).find((candidate) => candidate.serial === "57709")!;
    expect((await api.call("POST", `/pending-machines/${pending.id}/dismiss`)).status).toBe(200);
  });
  afterAll(async () => {
    await assistant?.close();
    await app?.close();
    await server?.stop();
  });

  const simulationPath = (query: Record<string, string> = {}, id = CLASSIC) => `/profiles/${encodeURIComponent(id)}/simulation?${new URLSearchParams(query)}`;
  const simulate = async (query: Record<string, string> = {}, as: AdminApi = api) => (await as.get<{ simulation: Simulation }>(simulationPath(query))).simulation;
  const classicProfile = async () => profileOf((await api.get<{ profile: { content: { profile: unknown } } }>(`/profiles/${encodeURIComponent(CLASSIC)}`)).profile.content.profile)!;

  it("runs on the standard puck by default, with 18 g, the Profile's stop-at weight and a DE1, as the shared module runs it", async () => {
    const simulation = await simulate();
    expect(simulation).toMatchObject({
      profile: { id: CLASSIC, title: "Classic Italian espresso" },
      model: "DE1",
      puck: { kind: "standard", grind: 0 },
      dose: 18,
      stopAt: 36,
      fit: null,
      checks: { blocking: [] },
    });
    const expected = simulateProfile({ profile: await classicProfile(), puck: standardPuck(0), dose: 18, stopAt: 36, model: "DE1" });
    expect(simulation.run).toEqual(expected);
    expect(simulation.run.stop.reason).toBe("weight");
    expect(simulation.run.steps.map((step) => step.reason)).toEqual(expect.arrayContaining(["stop"]));
  });

  it("takes the grind, the dose, the stop-at weight and the model", async () => {
    const finer = await simulate({ grind: "-1" });
    const coarser = await simulate({ grind: "1" });
    expect(finer.puck).toEqual({ kind: "standard", grind: -1 });
    expect(finer.run.duration).toBeGreaterThan(coarser.run.duration);
    const runOut = await simulate({ stopAt: "0" });
    expect(runOut.stopAt).toBeNull();
    expect(runOut.run.stop.reason).toBe("lastStep");
    expect((await simulate({ stopAt: "20" })).run.weight).toBeLessThan(21);
    expect((await simulate({ dose: "20" })).dose).toBe(20);
    const bengle = await simulate({ model: "Bengle" });
    expect(bengle.model).toBe("Bengle");
    expect(bengle.run.model).toBe("Bengle");
  });

  it("runs on a Shot's puck, worked out from its samples, and gives the Shot's figures beside its own steps' on that puck", async () => {
    const simulation = await simulate({ shotId: SHOT });
    expect(simulation).toMatchObject({ puck: { kind: "shot", shotId: SHOT, model: "DE1" }, dose: 18, stopAt: 36 });
    const { shot, simulated } = simulation.fit!;
    expect(shot.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
    expect(simulated.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
    // The margins protocol/test/simulation.test.ts states.
    const margin = Math.max(1, 0.05 * shot.duration);
    expect(Math.abs(simulated.duration - shot.duration)).toBeLessThanOrEqual(margin);
    expect(Math.abs(simulated.timeToFirstDrip! - shot.timeToFirstDrip!)).toBeLessThanOrEqual(margin);
    expect(Math.abs(simulated.peakPressure - shot.peakPressure)).toBeLessThanOrEqual(0.5);
    // The Shot's own figures are those the Shot's page gives.
    const read = (await api.get<{ shot: { duration: number; peakPressure: number; timeToFirstDrip: number | null } }>(`/shots/${SHOT}`)).shot;
    expect(shot.duration).toBeCloseTo(read.duration, 2);
    expect(shot.peakPressure).toBeCloseTo(read.peakPressure, 6);
    expect(shot.timeToFirstDrip).toBe(read.timeToFirstDrip);
  });

  it("refuses what it can't simulate", async () => {
    const refused = async (query: Record<string, string>, id = CLASSIC) => {
      const response = await api.call("GET", simulationPath(query, id));
      return { status: response.status, message: ((await response.json()) as { message: string }).message };
    };
    expect(await refused({ grind: "2" })).toEqual({ status: 400, message: "grind must be a number from -1, the finest, to 1, the coarsest" });
    expect(await refused({ grind: "0", shotId: SHOT })).toEqual({ status: 400, message: "Choose a Shot's puck or the standard puck's grind, not both" });
    expect(await refused({ model: "Linea" })).toEqual({ status: 400, message: "model must be one of DE1, Bengle" });
    expect((await refused({ dose: "0" })).status).toBe(400);
    expect((await refused({ stopAt: "501" })).status).toBe(400);
    // Blank is left out, as the Profile's stop-at weight; 0 runs the steps out.
    expect((await simulate({ stopAt: " " })).stopAt).toBe((await simulate()).stopAt);
    expect((await simulate({ stopAt: "0" })).stopAt).toBeNull();
    expect(await refused({}, "profile:00000000000000000000")).toEqual({ status: 404, message: "No such Profile" });
    expect(await refused({ shotId: "no-such-shot" })).toEqual({ status: 404, message: "Shot not found" });
    // A Shot of dismissed hardware, which no Shot read shows.
    expect((await api.call("GET", `/shots/${DISMISSED}`)).status).toBe(404);
    expect(await refused({ shotId: DISMISSED })).toEqual({ status: 404, message: "Shot not found" });
    expect(await refused({ shotId: FLOWLESS })).toEqual({ status: 409, message: `Shot ${FLOWLESS} recorded no pressure and flow to work its puck out from` });
    expect(await refused({}, LONG)).toEqual({ status: 409, message: `Profile ${LONG} has 21 steps, more than the 20 a machine takes, so it can't be simulated` });
  });

  it("runs on the puck of a Shot whose own profile has more steps than a machine takes, with no fit", async () => {
    const simulation = await simulate({ shotId: LONG_SHOT });
    expect(simulation).toMatchObject({ puck: { kind: "shot", shotId: LONG_SHOT }, fit: null });
    expect(simulation.run.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
  });

  it("runs on the puck of a Shot run under manual control, or naming no Machine model, with no fit (#599)", async () => {
    expect(await simulate({ shotId: MANUAL })).toMatchObject({ puck: { kind: "shot", shotId: MANUAL, model: "DE1" }, fit: null });
    const unnamed = await simulate({ shotId: NO_MODEL });
    expect(unnamed).toMatchObject({ model: "DE1", puck: { kind: "shot", shotId: NO_MODEL, model: null }, fit: null });
    expect(unnamed.run).toEqual((await simulate({ shotId: SHOT })).run);
  });

  it("is read by Staff away from the Profile's Locations, and by a Viewer", async () => {
    const away = await api.createLocation("Simulation cafe", "America/Chicago");
    const { link } = await api.invite("sim-staff@example.com", "staff", [away.id]);
    const staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Sim Staff", password: "sim staff password" }));
    const { link: viewerLink } = await api.invite("sim-viewer@example.com", "viewer");
    const viewer = AdminApi.signedInAs(server.url, await acceptInvite(server.url, viewerLink, { name: "Sim Viewer", password: "sim viewer password" }));
    const expected = await simulate({ shotId: SHOT });
    expect(await simulate({ shotId: SHOT }, staff)).toEqual(expected);
    expect(await simulate({ shotId: SHOT }, viewer)).toEqual(expected);
  });

  describe("through an assistant (simulate_profile)", () => {
    interface Simulated extends Fields {
      steps: SimulatedRun["steps"];
      curves?: Record<string, { unit: string; values: Array<[number, number]>; targets: Array<[number, number]> }> & { thinnedTo: number | null };
      fit: Simulation["fit"];
    }

    it("answers as the REST API does, in numbers, with the run's curves thinned as a Shot's are", async () => {
      const rest = await simulate({ grind: "-0.5", stopAt: "40", model: "Bengle" });
      const { result } = await assistant.callWithinBudget<Simulated>("simulate_profile", { profileId: CLASSIC, grind: -0.5, stopAt: 40, model: "Bengle" });
      const { run } = rest;
      expect(result).toMatchObject(
        asTools({
          profile: rest.profile,
          model: "Bengle",
          puck: rest.puck,
          dose: rest.dose,
          stopAt: 40,
          duration: run.duration,
          timeToFirstDrip: run.timeToFirstDrip,
          peakPressure: run.peakPressure,
          peakFlow: run.peakFlow,
          weight: run.weight,
          weightFlowAtStop: run.weightFlowAtStop,
          water: run.water,
          stop: run.stop,
          steps: run.steps,
          checks: rest.checks,
          fit: null,
        }) as Fields,
      );
      expect(result.curves!.thinnedTo).toBe(100);
      for (const curve of ["pressure", "flow", "weight", "weightFlow"]) {
        expect(result.curves![curve]!.values.length).toBeLessThanOrEqual(100);
        expect(result.curves![curve]!.values[0]).toEqual([0, 0]);
      }
      expect(result.curves!.pressure!.values.some(([, value]) => value === asTools(run.peakPressure))).toBe(true);
      expect(result.curves!.pressure!.targets.length).toBeGreaterThan(0);
      expect(result.curves).not.toHaveProperty("temperature");
    });

    it("simulates on a Shot's puck with the fit, the curves asked for or none, and defaults as the REST API's", async () => {
      const rest = await simulate({ shotId: SHOT });
      const { result } = await assistant.callWithinBudget<Simulated>("simulate_profile", { profileId: CLASSIC, shotId: SHOT, curves: ["weight"] });
      expect(result).toMatchObject(asTools({ puck: rest.puck, dose: 18, stopAt: 36, model: "DE1", fit: rest.fit, duration: rest.run.duration }) as Fields);
      expect(Object.keys(result.curves!).sort()).toEqual(["thinnedTo", "weight"]);
      const bare = await assistant.call<Simulated>("simulate_profile", { profileId: CLASSIC, curves: false });
      expect(bare).not.toHaveProperty("curves");
      expect(bare).toMatchObject({ puck: { kind: "standard", grind: 0 }, model: "DE1" });
    });

    it("gives no fit on the puck of a Shot run under manual control, or naming no Machine model, as the REST API does (#599)", async () => {
      const manual = await assistant.call<Simulated>("simulate_profile", { profileId: CLASSIC, shotId: MANUAL, curves: false });
      expect(manual).toMatchObject({ puck: { kind: "shot", shotId: MANUAL, model: "DE1" }, fit: null });
      const unnamed = await assistant.call<Simulated>("simulate_profile", { profileId: CLASSIC, shotId: NO_MODEL, curves: false });
      expect(unnamed).toMatchObject({ puck: { kind: "shot", shotId: NO_MODEL, model: null }, fit: null });
    });

    it("refuses what the REST API refuses", async () => {
      const refusal = async (args: Fields) => {
        const result = await assistant.client.callTool({ name: "simulate_profile", arguments: args });
        expect(result.isError, JSON.stringify(result)).toBe(true);
        return (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");
      };
      expect(await refusal({ profileId: CLASSIC, shotId: SHOT, grind: 0 })).toContain("Choose a Shot's puck or the standard puck's grind, not both");
      expect(await refusal({ profileId: CLASSIC, shotId: "no-such-shot" })).toContain("Shot not found");
      expect(await refusal({ profileId: CLASSIC, shotId: DISMISSED })).toContain("Shot not found");
      expect(await refusal({ profileId: "profile:00000000000000000000" })).toContain("No such Profile");
      expect(await refusal({ profileId: CLASSIC, grind: 3 })).toMatch(/grind/);
    });
  });
});
