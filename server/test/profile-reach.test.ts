import { LOADED_RECIPE_KIND } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { PlannedChange } from "../src/library/holdings.js";
import { markUnrunnable } from "../src/library/profile-reach.js";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { dye2List } from "./support/simulated-dye2.js";
import { type DecaidApi, type SimulatedTablet, derivedProfile } from "./support/simulated-tablet.js";
import { runAsSteps } from "./support/steps.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1, the REST API and the MCP endpoint for #588: a DE1 and a Bengle run
// a profile's numbers in different ranges, so a Draft is held to the widest
// of the account's models' ranges, and a Profile reaches only the Machines
// that can run it: a Location with a Machine that can't refuses to show it
// or keep a Recipe naming it, and the server writes it, and a Recipe
// carrying it, to no such Machine, listing the write as refused on its page.
// Through the built plugin in simulated tablets, on two server instances
// sharing PostgreSQL. Serials are made up, from 58801.

type Record_ = Record<string, unknown>;

const env = { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

interface Check {
  code: string;
  step: number | null;
  path?: string;
  message: string;
}

interface Refusal {
  change: string;
  kind: string;
  item: { id: string; name: string | null } | null;
  status: number | null;
  error: string;
}

/** A profile whose first step asks for 17.93 ml/s: a Bengle runs it, a DE1 can't, as a DE1 takes a flow up to 15 and wraps one above. */
function fastProfile(title: string): Record_ {
  const profile = derivedProfile(title, 8.5);
  const steps = profile.steps as Record_[];
  return { ...profile, steps: steps.map((step, index) => (index === 0 ? { ...step, flow: 17.93 } : step)) };
}

/** A tablet's Decaid API on a Bengle, its Library and DYE2's lists empty. */
function bengleLibrary(serial: number): DecaidApi {
  const api = emptyLibrary(serial);
  return { ...api, "/machine/info": { ...(api["/machine/info"] as Record_), model: "Bengle" } };
}

describe("A Profile reaches only the Machines that can run it", { timeout: 120_000 }, () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  const tablets = new LoadedTablets();
  /** Cafe, with a DE1; Bengles, with a Bengle; Harbor, with a DE1 to be moved to Bengles; Spare, with no Machine. */
  let cafe: LocationView;
  let bengles: LocationView;
  let harbor: LocationView;
  let spare: LocationView;
  let cafeTablet: SimulatedTablet;
  let bengleTablet: SimulatedTablet;
  let harborMachine: CreatedMachine;
  let harborTablet: SimulatedTablet;
  /** The profile a DE1 can't run, saved on Cafe's tablet. */
  let fast: string;
  /** A Recipe at Bengles naming it. */
  let bengleRecipe: string;

  runAsSteps();

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin));
    cafe = await api.createLocation("Cafe", "America/Chicago");
    bengles = await api.createLocation("Bengles", "America/Chicago");
    harbor = await api.createLocation("Harbor", "America/Chicago");
    spare = await api.createLocation("Spare", "America/Chicago");
  });
  afterAll(async () => {
    await assistant?.close();
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  const profilePath = (id: string) => `/profiles/${encodeURIComponent(id)}`;
  const checks = async (id: string) => (await api.get<{ simulation: { checks: { blocking: Check[]; advice: Check[] } } }>(`${profilePath(id)}/simulation`)).simulation.checks;

  /** The REST API's refusal of a request, which must be refused with the status, as its message. */
  async function restRefusal(method: string, path: string, body: unknown, status: number): Promise<string> {
    const response = await api.call(method, path, body);
    expect(response.status, path).toBe(status);
    return ((await response.json()) as { message: string }).message;
  }

  /** The tool's refusal, as its message. */
  async function toolError(name: string, args: Record_): Promise<string> {
    const result = await assistant.client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBe(true);
    return (result.content as { text: string }[]).map((block) => block.text).join("\n");
  }

  it("holds a Profile to a DE1's ranges while the account has DE1s only", async () => {
    const cafeMachine = await api.createMachine("Cafe 1", cafe.id);
    cafeTablet = tablets.syncing(cafeMachine, server, { api: emptyLibrary(58801) });
    await api.waitForOnline(cafeMachine);
    // A barista can save on a DE1's tablet what it can't run: Decaid checks no numbers.
    fast = String((await cafeTablet.addProfile(fastProfile("Fast Bloom"))).id);
    await expect.poll(async () => (await api.call("GET", profilePath(fast))).status).toBe(200);
    const found = await checks(fast);
    expect(found.blocking).toEqual([{ code: "outOfRange", step: 0, path: "steps.0.flow", message: 'Step 1, "Bloom": its flow is 17.93, outside 0 to 15.' }]);
    expect(found.advice.map((check) => check.code)).toEqual(["pumpTooSlow"]);
  });

  it("holds it to a Bengle's ranges once the account has one, advising that a DE1 can't run it", async () => {
    const bengleMachine = await api.createMachine("Bengles 1", bengles.id);
    bengleTablet = tablets.syncing(bengleMachine, other, { api: bengleLibrary(58802) });
    await api.waitForOnline(bengleMachine);
    await expect.poll(async () => (await checks(fast)).blocking).toEqual([]);
    expect((await checks(fast)).advice).toEqual([
      {
        code: "pumpTooSlow",
        step: 0,
        path: "steps.0.flow",
        message: "Step 1, \"Bloom\" asks for 17.93 ml/s, and a DE1's pump gives about 8 ml/s at most, and a Bengle's heater keeps up with about 15 ml/s at most.",
      },
      { code: "modelCantRun", step: 0, path: "steps.0.flow", message: 'Step 1, "Bloom": its flow is 17.93, which a DE1 can\'t run: a DE1 takes 0 to 15.' },
    ]);
  });

  it("shows it where every Machine runs it, or none is, and writes it there as authored", async () => {
    expect((await api.call("PUT", `${profilePath(fast)}/locations/${bengles.id}`, { shown: true })).status).toBe(200);
    expect((await api.call("PUT", `${profilePath(fast)}/locations/${spare.id}`, { shown: true })).status).toBe(200);
    // No model's resolution is applied: a Bengle is sent tenths, a DE1 sixteenths, and 17.93 is neither.
    await expect.poll(() => bengleTablet.profiles().find((record) => record.id === fast)).toMatchObject({ visibility: "visible", profile: { steps: [{ flow: 17.93 }, {}] } });
    const { profile } = await api.get<{ profile: { profile: { steps: { flow?: number }[] } } }>(profilePath(fast));
    expect(profile.profile.steps[0]!.flow).toBe(17.93);
  });

  it("refuses to show it where a Machine can't run it, naming the Machines and the value, through REST and MCP alike", async () => {
    harborMachine = await api.createMachine("Harbor 1", harbor.id);
    harborTablet = tablets.syncing(harborMachine, server, { api: emptyLibrary(58803) });
    await api.waitForOnline(harborMachine);
    await api.createMachine("Harbor 2", harbor.id);
    const message = await restRefusal("PUT", `${profilePath(fast)}/locations/${harbor.id}`, { shown: true }, 409);
    expect(message).toBe('"Fast Bloom" can\'t reach Harbor: Harbor 1 and Harbor 2 are DE1s, which can\'t run Step 1, "Bloom": its flow is 17.93, outside 0 to 15.');
    expect(await toolError("set_location_offering", { kind: "profile", id: fast, locationId: harbor.id, offered: true })).toBe(message);
    // Hiding it is never refused.
    expect((await api.call("PUT", `${profilePath(fast)}/locations/${harbor.id}`, { shown: false })).status).toBe(200);
    const { profile } = await api.get<{ profile: { shownAt: { location: LocationView }[] } }>(profilePath(fast));
    expect(profile.shownAt.map((here) => here.location.name)).toEqual(["Bengles", "Cafe", "Spare"]);
  });

  it("refuses a Recipe there naming it, created, copied or edited, through REST and MCP alike", async () => {
    const created = await api.call("POST", "/recipes", { locationId: bengles.id, content: { name: "Bengle Bloom", profileId: fast } });
    expect(created.status).toBe(201);
    bengleRecipe = ((await created.json()) as { recipe: { id: string } }).recipe.id;
    const message = await restRefusal("POST", "/recipes", { locationId: harbor.id, content: { name: "Harbor Bloom", profileId: fast } }, 409);
    expect(message).toMatch(/^"Fast Bloom" can't reach Harbor: Harbor 1 and Harbor 2 are DE1s/);
    expect(await toolError("create_recipe", { locationId: harbor.id, name: "Harbor Bloom", profileId: fast })).toBe(message);
    expect(await restRefusal("POST", `/recipes/${bengleRecipe}/copies`, { locationId: harbor.id, grinderId: null }, 409)).toBe(message);
    expect(await toolError("copy_recipe", { id: bengleRecipe, locationId: harbor.id, grinderId: null })).toBe(message);
    const plain = await api.call("POST", "/recipes", { locationId: harbor.id, content: { name: "Harbor Plain" } });
    const plainId = ((await plain.json()) as { recipe: { id: string } }).recipe.id;
    expect(await restRefusal("PATCH", `/recipes/${plainId}`, { content: { profileId: fast } }, 409)).toBe(message);
    expect(await toolError("edit_recipe", { id: plainId, profileId: fast })).toBe(message);
    // Nothing of them was made: the Recipes at Harbor are the plain one alone.
    const { recipes } = await api.get<{ recipes: { name: string | null }[] }>(`/locations/${harbor.id}/recipes`);
    expect(recipes.map((recipe) => recipe.name)).toEqual(["Harbor Plain"]);
  });

  it("writes it, and a Recipe carrying it, to no DE1 moved to where it is shown, listing each as refused on its page", async () => {
    // A Recipe it runs, at Bengles, to see the DE1's tablet written what it can run.
    expect((await api.call("POST", "/recipes", { locationId: bengles.id, content: { name: "Bengle Plain" } })).status).toBe(201);
    await expect.poll(() => (dye2List(bengleTablet, "recipes") as Record_[]).map((record) => record.name).sort()).toEqual(["Bengle Bloom", "Bengle Plain"]);
    expect((await api.call("POST", `/machines/${harborMachine.machine.id}/location-history`, { locationId: bengles.id })).status).toBe(201);

    const statusPath = `/machines/${harborMachine.machine.id}/sharing-status`;
    await expect
      .poll(async () => (await api.get<{ status: { refused: Refusal[]; waiting: number | null } }>(statusPath)).status, { timeout: 30_000 })
      .toMatchObject({ waiting: 0, refused: expect.arrayContaining([expect.objectContaining({ kind: "profile" }), expect.objectContaining({ kind: "recipe" })]) });
    const { refused } = (await api.get<{ status: { refused: Refusal[] } }>(statusPath)).status;
    const value = 'Step 1, "Bloom": its flow is 17.93, outside 0 to 15';
    expect(refused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change: "write", kind: "profile", item: expect.objectContaining({ id: fast }), status: null, error: `Not written: a DE1 can't run this Profile: ${value}` }),
        expect.objectContaining({ change: "write", kind: "recipe", item: expect.objectContaining({ id: bengleRecipe }), status: null, error: `Not written: a DE1 can't run its Profile, "Fast Bloom": ${value}` }),
      ]),
    );
    expect(refused).toHaveLength(2);
    const names = (dye2List(harborTablet, "recipes") as Record_[]).map((record) => record.name);
    expect(names).toEqual(["Bengle Plain"]);
    expect(harborTablet.profiles().find((record) => record.id === fast)).toBeUndefined();
    // The Bengle keeps both.
    expect(bengleTablet.profiles().find((record) => record.id === fast)).toMatchObject({ visibility: "visible" });
    expect((dye2List(bengleTablet, "recipes") as Record_[]).some((record) => record.name === "Bengle Bloom")).toBe(true);
  });
});

describe("The writes a Machine is due", () => {
  const fastRaw = fastProfile("Fast Bloom");
  const slowRaw = derivedProfile("Slow Bloom", 8.5);
  const at = { decidedAt: null, contentDecidedAt: null } as const;

  /** A transaction reading a Machine of the model, and the Library's Profiles by id. */
  function reading(model: string | null, profiles: Record<string, unknown>): Prisma.TransactionClient {
    const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("FROM machines")) return [{ model }];
      if (sql.includes("FROM profiles")) return (values[0] as string[]).filter((id) => id in profiles).map((id) => ({ id, profile: profiles[id] }));
      throw new Error(`Unexpected query: ${sql}`);
    };
    return { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  }

  const notWritten = (changes: PlannedChange[]) => changes.map((change) => ("notWritten" in change ? (change.notWritten ?? null) : null));
  const changes: PlannedChange[] = [
    // A Profile's record created, and one made visible.
    { kind: "profile", globalId: "profile:fast", localId: null, fields: { profile: fastRaw, parentId: null, metadata: null, visibility: "visible" }, ...at },
    { kind: "profile", globalId: "profile:fast", localId: "profile:fast", fields: { visibility: "visible" }, expected: { visibility: "hidden" }, ...at },
    // A visible one's title edited, and one hidden: neither offers it.
    { kind: "profile", globalId: "profile:fast", localId: "profile:fast", fields: { title: "Faster" }, expected: { title: "Fast Bloom" }, ...at },
    { kind: "profile", globalId: "profile:fast", localId: "profile:fast", fields: { visibility: "hidden" }, expected: { visibility: "visible" }, ...at },
    // A Recipe's record carrying it, as its snapshot or in its Workflow alone, and one edited without it.
    { kind: "recipe", globalId: "r1", localId: null, fields: { name: "Bloom", profileId: "profile:fast", profileSnapshot: fastRaw }, ...at },
    { kind: "recipe", globalId: "r1", localId: "r1", fields: { workflow: { profile: fastRaw } }, expected: {}, ...at },
    { kind: "recipe", globalId: "r1", localId: "r1", fields: { "dashboardVariables.dose": 18 }, expected: {}, ...at },
    // A Loaded Recipe's Profile written into the Workflow, and its dose alone.
    { kind: LOADED_RECIPE_KIND, globalId: "r1", localId: null, fields: { profile: fastRaw, "context.targetDoseWeight": 18 }, expected: {}, ...at },
    { kind: LOADED_RECIPE_KIND, globalId: "r1", localId: null, fields: { "context.targetDoseWeight": 18 }, expected: {}, ...at },
    // A Profile it runs.
    { kind: "profile", globalId: "profile:slow", localId: null, fields: { profile: slowRaw, visibility: "visible" }, ...at },
  ];

  it("marks each carrying a profile a DE1 can't run not to be written, with why, on a DE1 or a Machine not yet bound", async () => {
    const why = 'Step 1, "Bloom": its flow is 17.93, outside 0 to 15';
    const expected = [
      `Not written: a DE1 can't run this Profile: ${why}`,
      `Not written: a DE1 can't run this Profile: ${why}`,
      null,
      null,
      `Not written: a DE1 can't run its Profile, "Fast Bloom": ${why}`,
      `Not written: a DE1 can't run its Profile, "Fast Bloom": ${why}`,
      null,
      `Not written: a DE1 can't run its Profile, "Fast Bloom": ${why}`,
      null,
      null,
    ];
    expect(notWritten(await markUnrunnable(reading("DE1Pro", { "profile:fast": fastRaw }), "machine", changes))).toEqual(expected);
    expect(notWritten(await markUnrunnable(reading(null, { "profile:fast": fastRaw }), "machine", changes))).toEqual(expected);
  });

  it("marks none on a Bengle, leaving each as planned", async () => {
    const marked = await markUnrunnable(reading("Bengle", { "profile:fast": fastRaw }), "machine", changes);
    expect(marked).toEqual(changes);
  });
});
