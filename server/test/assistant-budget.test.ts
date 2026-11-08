import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView, admin, signIn } from "./support/admin-api.js";
import { ASSISTANT_ENV, Assistant, RESPONSE_BUDGET, type TestApp, serveTestApp } from "./support/assistants.js";
import { LoadedTablets, emptyLibrary } from "./support/loaded-tablets.js";
import { preheatShotFixture, shotFixture } from "./support/shot-fixtures.js";
import { RawConnection, type SimulatedTablet, de1ProOnDecaid091, derivedProfile, derivedWorkflow, helloWith, manyProfiles } from "./support/simulated-tablet.js";
import { derivedSteam, liveSteamFixture, milkProbeSteamFixture } from "./support/steam-fixtures.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for #431 (ADR-0028): every read tool, called as a client calls it,
// keeps its response within the budget: its text block, the one compact
// JSON copy the budget counts, at most 45,000 characters
// (`Assistant.callWithinBudget`). Each runs at its largest options on
// realistic data, derived from what Decaid, DYE2 and the management interface
// record, in the numbers a busy cafe makes, and on hostile data: names and
// notes far longer than any typed, and strings heavy with what JSON escapes.
// Records are sent as raw frames, but for a simulated tablet's Machine, whose
// Workflow, settings and Profiles its plugin reports; Library items are made
// through the REST API; Settings Edits and Conflicts, which a tablet makes one
// at a time, are copied in PostgreSQL from ones made the usual way. Serials
// are made up, from 43101.

type Fields = Record<string, unknown>;

interface Page {
  total: number;
  offset: number;
  more: boolean;
}

/** What ends text the budget cut. */
const CUT_MARK = "…[cut]";

/** Text heavy with what JSON escapes, emoji included, about `length` characters long. */
function hostile(length: number): string {
  const piece = 'Quote " backslash \\ newline \n tab \t bell \u0007 emoji \u{1F600}\u{1F375} ';
  return piece.repeat(Math.ceil(length / piece.length));
}

/** That a page's `total`, `offset` and `more` come before its list in the text sent, so a client that cuts the end of it keeps them. */
function pagingFirst(text: string, list: string): void {
  const at = text.indexOf(`"${list}":`);
  expect(at, list).toBeGreaterThan(-1);
  for (const field of ["total", "offset", "more"]) expect(text.indexOf(`"${field}":`), field).toBeLessThan(at);
}

const cut = (value: unknown) => typeof value === "string" && value.endsWith(CUT_MARK);

/** The serial the bar's tablet reports, which the Shots it pulls record (de1ProOnDecaid091). */
const BAR_SERIAL = "10001";

/** Resolves once `holds` does, as expect.poll, which a hook can't call, waits. */
async function until(holds: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("every read tool's response within the budget", { timeout: 240_000 }, () => {
  let server: TestServer;
  let api: AdminApi;
  let app: TestApp;
  let assistant: Assistant;
  let lab: LocationView;
  let harbor: LocationView;
  const tablets = new LoadedTablets();
  const raws: RawConnection[] = [];

  beforeAll(async () => {
    server = await startTestServer({ env: { ...ASSISTANT_ENV, SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" } });
    api = await AdminApi.setUp(server.url);
    app = await serveTestApp();
    assistant = await Assistant.connect(server.url, app, await signIn(server.url, admin), { allowed: ["read"] });
    lab = await api.createLocation("Lab", "America/Chicago");
    harbor = await api.createLocation("Harbor", "Asia/Tokyo");
  });
  afterAll(async () => {
    await assistant?.close();
    await Promise.all(raws.splice(0).map((raw) => raw.terminate()));
    await tablets.unloadAll();
    await app?.close();
    await server?.stop();
  });

  /** A Machine at a Location since 2025, so that the records it took then, as those these tests send, are at that Location. */
  async function machineAt(name: string, location: LocationView): Promise<CreatedMachine> {
    const machine = await api.createMachine(name);
    await api.send("POST", `/machines/${machine.machine.id}/location-history`, { locationId: location.id, effectiveFrom: "2025-01-01T00:00:00Z" }, 201);
    return machine;
  }

  /** A connection with the Machine's token reporting its hardware, kept open until the file ends. */
  async function connectionOf(machine: CreatedMachine, serial: string): Promise<RawConnection> {
    const raw = await RawConnection.welcomed(server.url, helloWith(machine.token, { machine: { model: "DE1Pro", serial } }));
    raws.push(raw);
    return raw;
  }

  /** A Shot pulled `minutes` after 06:00 UTC on 2 November 2026, derived from `fixture`, with the changes given to its Workflow's context, profile and annotations. */
  function shotAt(id: string, minutes: number, serial: string, changes: { context?: Fields; profile?: Fields; annotations?: Fields } = {}, fixture = shotFixture()): Fields {
    const workflow = fixture.workflow as Record<string, Fields>;
    return {
      ...fixture,
      id,
      timestamp: new Date(Date.UTC(2026, 10, 2, 6, minutes)).toISOString(),
      workflow: {
        ...workflow,
        context: { ...workflow.context, ...changes.context },
        profile: { ...workflow.profile, ...changes.profile },
        machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial },
      },
      annotations: { ...(fixture.annotations as Fields), ...changes.annotations },
    };
  }

  async function deliverShots(raw: RawConnection, shots: Fields[]): Promise<void> {
    await Promise.all(shots.map((shot) => raw.deliver({ type: "shot", id: randomUUID(), shotId: shot.id, shot })));
  }

  /** The ids of a list's entries, through the REST API, in its order: up to 100, two pages of 50. */
  async function restIds(path: string, list: string, query: Record<string, string>): Promise<string[]> {
    const pages = await Promise.all(["0", "50"].map((offset) => api.get<Record<string, { id: string }[]>>(`${path}?${new URLSearchParams({ ...query, limit: "50", offset })}`)));
    return pages.flatMap((page) => page[list]!.map((entry) => entry.id));
  }

  /**
   * Each page of a tool's list from the first, `limit` 50 a page, each
   * within the budget with its paging fields first, as the next page's
   * offset is the last's plus its length: the ids of every entry, and each
   * page's length.
   */
  async function everyPage(tool: string, list: string, args: Fields): Promise<{ ids: string[]; lengths: number[] }> {
    const ids: string[] = [];
    const lengths: number[] = [];
    for (let offset = 0; ; ) {
      const { result, text } = await assistant.callWithinBudget<Page & Record<string, { id: string }[]>>(tool, { ...args, limit: 50, offset });
      pagingFirst(text, list);
      expect(result.offset).toBe(offset);
      const entries = result[list]!;
      expect(entries.length, `${tool} at ${offset}`).toBeGreaterThan(0);
      ids.push(...entries.map((entry) => entry.id));
      lengths.push(entries.length);
      offset += entries.length;
      expect(result.more).toBe(offset < result.total);
      if (!result.more) return { ids, lengths };
    }
  }

  describe("on realistic data, at each tool's largest options", () => {
    let bar: CreatedMachine;
    let tablet: SimulatedTablet;
    let roastery: CreatedMachine;
    let raw: RawConnection;

    beforeAll(async () => {
      // The Lab's bar: a tablet with the test tablet's Decaid, its Workflow, settings and DYE2's recipes and baskets, and
      // 55 Profiles, its own five eleven times over, each copy with ids of its own, which join the Library at the Lab.
      bar = await machineAt("Lab bar", lab);
      const five = JSON.stringify(manyProfiles(1).slice(0, 5)).length;
      tablet = tablets.syncing(bar, server, { api: { ...de1ProOnDecaid091(), "/profiles": manyProfiles(10 * five) } });
      await api.waitForOnline(bar);
      roastery = await machineAt("Lab roastery", lab);
      raw = await connectionOf(roastery, "43101");
    });

    it("finds Shots a page at a time, each page that 50 would overrun ending sooner, and every Shot on some page once", async () => {
      // 60 Shots the bar's tablet pulls one morning, each linked to its Library's Bean Batch, Grinder, Basket and
      // Profile, as the real one it is derived from is, by four Baristas, recording three Beans.
      const baristas = ["Ann", "Ben", "Cat", "Dee"];
      const beans = [
        ["Roux Bakehouse", "Ethiopia Guji Hambela"],
        ["Monogram", "Colombia El Paraiso Lychee"],
        ["Pilot", "Kenya Nyeri Gatomboya AA"],
      ];
      for (let n = 0; n < 60; n++) {
        const [roaster, name] = beans[n % 3]!;
        tablet.pullShot(shotAt(`morning-${String(n).padStart(2, "0")}`, n, BAR_SERIAL, { context: { baristaName: baristas[n % 4], coffeeRoaster: roaster, coffeeName: name } }));
      }
      await expect.poll(async () => (await api.get<{ total: number }>(`/shots?machineId=${bar.machine.id}`)).total).toBe(60);
      const { ids, lengths } = await everyPage("find_shots", "shots", { machineId: bar.machine.id });
      expect(ids).toEqual(await restIds("/shots", "shots", { machineId: bar.machine.id }));
      expect(lengths[0]).toBeLessThan(50);
      const { shots } = await assistant.call<{ shots: Fields[] }>("find_shots", { machineId: bar.machine.id, limit: 1 });
      expect(shots[0]).toMatchObject({ location: { id: lab.id }, beanBatch: { id: expect.any(String) }, grinder: { id: expect.any(String) }, basket: { id: expect.any(String) } });
    });

    it("reads a Shot with its curves", async () => {
      const fixture = preheatShotFixture();
      await deliverShots(raw, [shotAt("preheat", 90, "43101", { annotations: { espressoNotes: "Sweet, a little sharp at the end; try a finer grind." } }, fixture)]);
      const { result } = await assistant.callWithinBudget<Fields>("get_shot", { id: "preheat", curves: true });
      expect(result).not.toHaveProperty("cut");
      expect(Object.keys(result.curves as Fields)).toEqual(["shaded", "pressure", "flow", "weight", "temperature"]);
    });

    it("finds Steam Records a page at a time, and reads one with its curves", async () => {
      await Promise.all(
        Array.from({ length: 55 }, (_, n) => {
          const steamId = `steam-${String(n).padStart(2, "0")}`;
          return raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: new Date(Date.UTC(2026, 10, 2, 7, n)).toISOString(), steam: derivedSteam(steamId, {}) });
        }),
      );
      const { ids } = await everyPage("find_steam_records", "steamRecords", { machineId: roastery.machine.id });
      expect(ids).toEqual(await restIds("/steam-records", "steamRecords", { machineId: roastery.machine.id }));
      const steamId = "steam-timed-stop";
      await raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: "2026-11-02T08:00:00.000Z", steam: derivedSteam(steamId, {}, liveSteamFixture("steam-record-timed-stop")) });
      const { result } = await assistant.callWithinBudget<Fields>("get_steam_record", { id: steamId, curves: true });
      expect(result).not.toHaveProperty("cut");
    });

    it("lists the Locations and Machines", async () => {
      await assistant.callWithinBudget("list_locations");
      await assistant.callWithinBudget("list_machines");
    });

    it("gives a Machine with its Workflow, Machine Settings and Tablet Settings as its tablet reported them", async () => {
      await expect.poll(async () => (await assistant.call<{ workflow: unknown; machineSettings: Record<string, unknown> }>("get_machine", { machineId: bar.machine.id })).machineSettings.machineSettings).not.toBeNull();
      const { result } = await assistant.callWithinBudget<Fields>("get_machine", { machineId: bar.machine.id });
      expect(result).not.toHaveProperty("cut");
      expect(result.workflow).not.toBeNull();
    });

    it("gives a Machine's activity a page at a time, 55 Workflow changes and Machine States of each", async () => {
      const states = [
        ["espresso", "pouring"],
        ["idle", "idle"],
        ["steam", "steaming"],
        ["sleeping", "noState"],
        ["idle", "idle"],
      ] as const;
      for (let n = 0; n < 55; n++) {
        const observedAt = new Date(Date.UTC(2026, 10, 3, 6, n)).toISOString();
        const [state, substate] = states[n % states.length]!;
        await raw.deliver({ type: "machineState", id: randomUUID(), observedAt, state, substate });
        await raw.deliver({
          type: "workflow",
          id: randomUUID(),
          observedAt,
          workflow: derivedWorkflow({ targetDoseWeight: 18 + (n % 5) / 10, grinderSetting: String(2 + (n % 7) / 10), coffeeName: "Ethiopia Guji Hambela", baristaName: "Ann" }),
        });
      }
      const range = { machineId: roastery.machine.id, from: "2026-11-03", to: "2026-11-03" };
      const { result, text } = await assistant.callWithinBudget<Record<string, Page & { entries: unknown[] }>>("get_machine_activity", { ...range, limit: 50 });
      for (const kind of ["workflowChanges", "machineStates"]) {
        expect(result[kind]!.total, kind).toBeGreaterThanOrEqual(55);
        expect(result[kind]!.more, kind).toBe(true);
      }
      for (const list of text.matchAll(/"(workflowChanges|loadedRecipes|machineStates)":\{(.*?)"entries"/g)) {
        expect(list[2], list[1]).toMatch(/^"total":\d+,"offset":\d+,"more":(true|false),$/);
      }
      for (const kind of ["workflowChanges", "machineStates"] as const) {
        const { count, lengths } = await everyKind(kind, range);
        expect(count).toBe(result[kind]!.total);
        expect(lengths.every((length) => length > 0)).toBe(true);
      }
    });

    /** Each page of one kind of a Machine's activity, as everyPage reads a list: how many entries in all, and each page's length. */
    async function everyKind(kind: string, args: Fields): Promise<{ count: number; lengths: number[] }> {
      const lengths: number[] = [];
      for (let offset = 0; ; ) {
        const { result } = await assistant.callWithinBudget<Record<string, Page & { entries: unknown[] }>>("get_machine_activity", { ...args, kinds: [kind], limit: 50, offset });
        const page = result[kind]!;
        lengths.push(page.entries.length);
        offset += page.entries.length;
        expect(page.more).toBe(offset < page.total);
        if (!page.more) return { count: offset, lengths };
      }
    }

    it("lists a Machine's Settings Edits a page at a time", async () => {
      // Two made the usual way and answered by the bar's tablet, one applied and one refused as changed since, each
      // then copied in PostgreSQL 27 times, a minute apart.
      const path = `/machines/${bar.machine.id}/settings-edits`;
      for (const body of [
        { collection: "machineSettings", fields: { fan: 40 }, expected: { fan: 50 } },
        { collection: "machineSettings", fields: { fan: 45 }, expected: { fan: 50 } },
      ]) {
        const { id } = (await api.send<{ settingsEdit: { id: string } }>("POST", path, body, 201)).settingsEdit;
        await expect.poll(async () => (await api.get<{ settingsEdit: { answeredAt: string | null } }>(`${path}/${id}`)).settingsEdit.answeredAt).not.toBeNull();
      }
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_edits (id, machine_id, session_id, tablet_id, account_id, connected_app_id, collection, schedule_action, schedule_id, fields, expected,
             made_at, sent_at, answered_at, outcome, late, refusal, machine_state, decaid_status, decaid_message, read_back)
           SELECT gen_random_uuid(), machine_id, session_id, tablet_id, account_id, connected_app_id, collection, schedule_action, schedule_id, fields, expected,
             made_at - n * interval '1 minute', sent_at - n * interval '1 minute', answered_at - n * interval '1 minute', outcome, late, refusal,
             machine_state, decaid_status, decaid_message, read_back
           FROM settings_edits, generate_series(1, 27) AS n WHERE machine_id = $1`,
          [bar.machine.id],
        );
      } finally {
        await database.end();
      }
      const { ids } = await everyPage("list_settings_edits", "settingsEdits", { machineId: bar.machine.id });
      expect(ids).toHaveLength(56);
    });

    it("lists a Machine's Settings History a page at a time, 54 updates of a plugin list as large as a cafe's, and gives its settings as last received by a time", async () => {
      // Eight plugins shaped as DYE2's listing (fixtures/decaid/dye2-v0.1.26/plugins.json), about 16 KB as Belmont's
      // tablets list theirs, one updated each minute from 06:00 on 5 November, 55 lists in all, as copied in PostgreSQL.
      const listing = (JSON.parse(fs.readFileSync(new URL("./fixtures/decaid/dye2-v0.1.26/plugins.json", import.meta.url), "utf8")) as { listed: Fields[] }).listed[0]!;
      const versions = Array.from({ length: 8 }, () => "1.0.0");
      const lists = Array.from({ length: 55 }, (_, n) => {
        versions[n % 8] = `1.${n}.0`;
        return versions.map((version, plugin) => ({ ...listing, id: `plugin-${plugin}.reaplugin`, version }));
      });
      expect(JSON.stringify(lists[0]).length).toBeGreaterThan(14_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at)
           SELECT $1, 'plugins', value, '2026-11-05T06:00:00Z'::timestamptz + (n - 1) * interval '1 minute'
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS listed(value, n)`,
          [roastery.machine.id, JSON.stringify(lists)],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_history", "changes", { machineId: roastery.machine.id });
      expect(ids).toHaveLength(54);
      expect(lengths[0]).toBeLessThan(50);
      const { result } = await assistant.callWithinBudget<Fields>("get_machine", { machineId: bar.machine.id, at: new Date().toISOString() });
      expect(result).not.toHaveProperty("cut");
      expect((result.machineSettings as Fields).machineSettings).not.toBeNull();
    });

    describe("the Library", () => {
      /** Each kind's ids, by its find_library_items list. */
      const made: Record<string, string[]> = {};
      let recipe: string;
      let tool: string;

      beforeAll(async () => {
        // At Harbor, which has no tablets to write to, 55 of each kind the management interface makes.
        const send = async (path: string, body: Fields) => Object.values(await api.send<Record<string, { id: string }>>("POST", path, body, 201))[0]!.id;
        const at = (n: number) => String(n).padStart(2, "0");
        const sequential = async <T>(count: number, make: (n: number) => Promise<T>) => {
          const all: T[] = [];
          for (let n = 0; n < count; n++) all.push(await make(n));
          return all;
        };
        made.beans = await sequential(55, (n) =>
          send("/beans", {
            content: { roaster: "Roux Bakehouse", name: `Ethiopia Guji Hambela lot ${at(n)}`, country: "Ethiopia", region: "Guji", processing: "Washed", variety: ["Heirloom"], notes: "Peach, jasmine and bergamot; a long, sweet finish." },
          }),
        );
        made.beanBatches = await sequential(55, (n) =>
          send("/bean-batches", { beanId: made.beans![n]!, content: { roastDate: "2026-10-28", roastLevel: "Light", weight: 1000, notes: "Rested a week." }, locations: [{ locationId: harbor.id, remainingWeight: 750 }] }),
        );
        made.grinders = await sequential(55, (n) => send("/grinders", { locationId: harbor.id, content: { model: `Mahlkönig EK43 S ${at(n)}`, burrs: "SSP Ultra Low Fines", burrType: "flat" } }));
        made.baskets = await sequential(55, (n) => send("/baskets", { locationId: harbor.id, content: { name: `VST 18g ${at(n)}` } }));
        made.tools = await sequential(55, (n) => send("/tools", { locationId: harbor.id, content: { name: `WDT ${at(n)}`, custom: [{ key: "Needles", value: "8" }] } }));
        tool = made.tools[0]!;
        // Recipes of the bar's Profiles, five of them shown at Harbor.
        await until(async () => (await api.get<{ profiles: unknown[] }>("/profiles")).profiles.length >= 55);
        const profiles = (await api.get<{ profiles: { id: string }[] }>("/profiles")).profiles.slice(0, 5);
        for (const profile of profiles) await api.send("PUT", `/profiles/${encodeURIComponent(profile.id)}/locations/${harbor.id}`, { shown: true });
        made.recipes = await sequential(55, (n) =>
          send("/recipes", {
            locationId: harbor.id,
            slot: n < 5 ? n + 1 : null,
            content: {
              name: `Harbor espresso ${at(n)}`,
              beanBatchId: made.beanBatches![n]!,
              profileId: profiles[n % profiles.length]!.id,
              dose: 18,
              yield: 40,
              grinderId: made.grinders![n]!,
              grindSetting: 2.5,
              basketId: made.baskets![n]!,
              toolIds: [tool],
              brewTemperature: 93,
              steamTemperature: 160,
              steamDuration: 30,
              hotWaterTemperature: 90,
              hotWaterVolume: 120,
            },
          }),
        );
        recipe = made.recipes[0]!;
        // A Recipe dialled in through the day: 55 edits of its dose and grind.
        for (let n = 0; n < 55; n++) await api.send("PATCH", `/recipes/${recipe}`, { content: { dose: 18 + (n % 5) / 10, grindSetting: 2 + (n % 7) / 10 } });
      });

      it("finds 55 items of each kind a page at a time", async () => {
        for (const [kind, list] of [
          ["bean", "beans"],
          ["beanBatch", "beanBatches"],
          ["profile", "profiles"],
          ["grinder", "grinders"],
          ["basket", "baskets"],
          ["tool", "tools"],
          ["recipe", "recipes"],
        ] as const) {
          const { ids } = await everyPage("find_library_items", list, { kind });
          expect(ids.length, kind).toBeGreaterThanOrEqual(55);
          if (made[list]) expect(ids, kind).toEqual(expect.arrayContaining(made[list]!));
        }
      });

      it("reads a Recipe with its history, a Profile, and a Bean with its batches", async () => {
        const { result } = await assistant.callWithinBudget<{ history: Page & { entries: unknown[] } }>("get_library_item", { kind: "recipe", id: recipe, history: true, conflicts: true, limit: 50 });
        expect(result.history.total).toBeGreaterThanOrEqual(56);
        const { profiles } = await api.get<{ profiles: { id: string; title: string }[] }>("/profiles");
        const adaptive = profiles.find((profile) => profile.title === "Adaptive v3")!;
        const profile = await assistant.callWithinBudget<Fields>("get_library_item", { kind: "profile", id: adaptive.id, history: true, conflicts: true, limit: 50 });
        expect(profile.result).not.toHaveProperty("cut");
        await assistant.callWithinBudget("get_library_item", { kind: "bean", id: made.beans![0]!, history: true, conflicts: true, limit: 50 });
      });

      it("lists 55 open Conflicts a page at a time", async () => {
        // A Bean's notes edited offline on a tablet, each losing to the management interface's: as list_conflicts finds
        // them, copied in PostgreSQL, one for each Bean.
        const database = await server.connectDatabase();
        try {
          await database.query(
            `INSERT INTO conflicts (id, kind, item_id, field, value, account_id, edited_at)
             SELECT gen_random_uuid(), 'bean', id::text, 'notes', to_jsonb('Peach and jasmine, a little brighter than last week.'::text),
               (SELECT id FROM accounts WHERE email = $2), transaction_timestamp() - interval '1 hour'
             FROM beans WHERE id = ANY($1::uuid[])`,
            [made.beans, admin.email],
          );
        } finally {
          await database.end();
        }
        const { ids } = await everyPage("list_conflicts", "conflicts", {});
        expect(ids.length).toBeGreaterThanOrEqual(55);
      });
    });
  });

  describe("on hostile data", () => {
    let haunted: CreatedMachine;
    let raw: RawConnection;

    beforeAll(async () => {
      haunted = await machineAt("Haunted", lab);
      raw = await connectionOf(haunted, "43102");
    });

    it("finds Shots whose names run far longer than any typed, each cut and marked, their ids whole, a page at a time", async () => {
      await deliverShots(
        raw,
        Array.from({ length: 55 }, (_, n) =>
          shotAt(`haunted-${String(n).padStart(2, "0")}`, 200 + n, "43102", {
            context: { baristaName: hostile(3_000), coffeeRoaster: hostile(3_000), coffeeName: hostile(3_000) },
            profile: { title: hostile(3_000) },
            annotations: { espressoNotes: hostile(60_000) },
          }),
        ),
      );
      const first = await assistant.callWithinBudget<Page & { cut?: string; shots: Fields[] }>("find_shots", { machineId: haunted.machine.id, limit: 50 });
      expect(Object.keys(first.result)[0]).toBe("cut");
      expect(first.result.cut).toContain("get_shot");
      expect(first.result.shots.map((shot) => shot.id)).toEqual(Array.from({ length: first.result.shots.length }, (_, n) => `haunted-${String(54 - n).padStart(2, "0")}`));
      for (const shot of first.result.shots) {
        expect([shot.barista, shot.profileTitle, (shot.bean as Fields).roaster, (shot.bean as Fields).name].every(cut), shot.id as string).toBe(true);
      }
      const { ids } = await everyPage("find_shots", "shots", { machineId: haunted.machine.id });
      expect(ids).toEqual(await restIds("/shots", "shots", { machineId: haunted.machine.id }));
    });

    it("reads a Shot with its notes cut and marked, and its curves whole", async () => {
      const { result } = await assistant.callWithinBudget<Fields & { cut: string }>("get_shot", { id: "haunted-00", curves: true });
      expect(result.cut).toContain("without curves");
      expect(cut(result.notes)).toBe(true);
      // Its curves are those of a Shot with the same measurements and none of its text.
      await deliverShots(raw, [shotAt("plain", 300, "43102")]);
      const plain = await assistant.call<Fields>("get_shot", { id: "plain", curves: true });
      expect(result.curves).toEqual(plain.curves);
    });

    it("gives a Machine whose Workflow's text runs long with that text cut, its Profile's steps and its settings whole", async () => {
      const workflow = derivedWorkflow({ coffeeName: hostile(20_000), baristaName: hostile(5_000) });
      const profile: Fields = { ...(workflow.profile as Fields), notes: hostile(60_000), title: hostile(5_000) };
      await raw.deliver({ type: "workflow", id: randomUUID(), observedAt: "2026-11-04T06:00:00.000Z", workflow: { ...workflow, profile, description: hostile(10_000) } });
      // A long string in its Tablet Settings, which are structured, and never cut.
      const appSettings = { ...(de1ProOnDecaid091()["/settings"] as Fields), webUiPath: hostile(15_000) };
      await raw.deliver({ type: "collection", id: randomUUID(), name: "appSettings", available: true, value: appSettings, utcOffsetMinutes: -360 });
      await expect.poll(async () => (await assistant.call<{ tabletSettings: { appSettings: unknown } }>("get_machine", { machineId: haunted.machine.id })).tabletSettings.appSettings).toBeTruthy();
      const { result } = await assistant.callWithinBudget<{ cut: string; workflow: { workflow: Fields }; tabletSettings: { appSettings: { value: unknown } } }>("get_machine", { machineId: haunted.machine.id });
      expect(result.cut).toContain("management interface");
      const read = result.workflow.workflow;
      expect([(read.profile as Fields).notes, (read.profile as Fields).title, (read.context as Fields).coffeeName, read.description].every(cut)).toBe(true);
      expect((read.profile as Fields).steps).toEqual(profile.steps);
      expect(result.tabletSettings.appSettings.value).toEqual(appSettings);
    });

    it("gives a Machine's activity whose Workflows' text runs long with that text cut", async () => {
      for (const minute of [1, 2]) {
        await raw.deliver({
          type: "workflow",
          id: randomUUID(),
          observedAt: `2026-11-04T06:0${minute}:00.000Z`,
          // Each a change, by its dose.
          workflow: derivedWorkflow({ targetDoseWeight: 18 + minute, coffeeName: hostile(20_000), coffeeRoaster: hostile(5_000), baristaName: hostile(5_000) }),
        });
      }
      const { result } = await assistant.callWithinBudget<{ cut: string; workflowChanges: Page & { entries: { workflow: Fields }[] } }>("get_machine_activity", {
        machineId: haunted.machine.id,
        from: "2026-11-04",
        to: "2026-11-04",
        limit: 50,
      });
      expect(result.cut).toContain("fewer at a time");
      expect(result.workflowChanges.total).toBe(3);
      expect(result.workflowChanges.entries.every((entry) => cut(entry.workflow.bean) && cut(entry.workflow.barista))).toBe(true);
    });

    it("lists Settings Edits whose Decaid message runs long with it cut, each value they set whole, a page at a time", async () => {
      // Refused by Decaid with a long answer, each setting a long value, as copied in PostgreSQL.
      const value = hostile(2_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_edits (id, machine_id, session_id, tablet_id, collection, fields, expected, made_at, sent_at, answered_at, outcome, refusal, decaid_status, decaid_message)
           SELECT gen_random_uuid(), $1, gen_random_uuid(), gen_random_uuid(), 'appSettings', jsonb_build_object('webUiPath', $2::text), jsonb_build_object('webUiPath', 'streamline.js'),
             transaction_timestamp() - n * interval '1 minute', transaction_timestamp() - n * interval '1 minute', transaction_timestamp() - n * interval '1 minute',
             'REFUSED', 'DECAID', 400, $3
           FROM generate_series(1, 30) AS n`,
          [haunted.machine.id, value, hostile(5_000)],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_edits", "settingsEdits", { machineId: haunted.machine.id });
      expect(ids).toHaveLength(30);
      expect(lengths[0]).toBeLessThan(30);
      const { result } = await assistant.callWithinBudget<{ cut: string; settingsEdits: { fields: Fields; refusal: { message: unknown } }[] }>("list_settings_edits", { machineId: haunted.machine.id, limit: 50 });
      expect(result.cut).toBeDefined();
      for (const edit of result.settingsEdits) {
        expect(edit.fields).toEqual({ webUiPath: value });
        expect(cut(edit.refusal.message)).toBe(true);
      }
    });

    it("lists Settings History changes whose values run long a page at a time, each value and field whole, and gives settings as last received with theirs whole", async () => {
      // A Tablet Setting set to a long value, a different one each minute, and a plugin whose id runs long, as copied in PostgreSQL before the
      // Tablet Settings this Machine's tablet reported.
      const values = Array.from({ length: 31 }, (_, n) => ({ webUiPath: `${n} ${hostile(2_000)}` }));
      const id = hostile(1_000);
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at)
           SELECT $1, 'appSettings', value, '2026-11-01T06:00:00Z'::timestamptz + (n - 1) * interval '1 minute'
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS listed(value, n)`,
          [haunted.machine.id, JSON.stringify(values)],
        );
        await database.query(
          `INSERT INTO settings_history (machine_id, name, value, received_at) VALUES ($1, 'plugins', '[]', '2026-11-01T06:00:00Z'), ($1, 'plugins', $2::jsonb, '2026-11-01T06:01:00Z')`,
          [haunted.machine.id, JSON.stringify([{ id, version: "1.0.0" }])],
        );
      } finally {
        await database.end();
      }
      const { ids, lengths } = await everyPage("list_settings_history", "changes", { machineId: haunted.machine.id, collections: ["appSettings"] });
      // The 30 copied, and the change to the Tablet Settings its tablet reported.
      expect(ids).toHaveLength(31);
      expect(lengths[0]).toBeLessThan(31);
      type Changes = { changes: { fields: { field: string; before: unknown; after: unknown }[] }[] };
      const { result } = await assistant.callWithinBudget<Changes>("list_settings_history", { machineId: haunted.machine.id, collections: ["appSettings"], from: "2026-11-01", to: "2026-11-01", limit: 50 });
      // Newest first, the latest copied first.
      expect(result.changes.map(({ fields }) => fields)).toEqual(
        result.changes.map((_, n) => [{ field: "webUiPath", change: "changed", before: values[29 - n]!.webUiPath, after: values[30 - n]!.webUiPath, backAt: null }]),
      );
      const plugin = await assistant.callWithinBudget<Changes>("list_settings_history", { machineId: haunted.machine.id, collections: ["plugins"] });
      expect(plugin.result.changes[0]!.fields[0]!.field).toBe(id);
      const asOf = await assistant.callWithinBudget<{ tabletSettings: { appSettings: { value: unknown } } }>("get_machine", { machineId: haunted.machine.id, at: "2026-11-01T06:30:00Z" });
      expect(asOf.result.tabletSettings.appSettings.value).toEqual(values[30]);
    });

    it("finds Steam Records whose Barista runs long a page at a time, and reads one with its curves whole", async () => {
      const fixture = milkProbeSteamFixture();
      const workflow = fixture.workflow as Record<string, Fields>;
      const steam = (steamId: string) => derivedSteam(steamId, { workflow: { ...workflow, context: { ...workflow.context, baristaName: hostile(5_000) } } }, fixture);
      await Promise.all(
        Array.from({ length: 50 }, (_, n) => {
          const steamId = `haunted-steam-${String(n).padStart(2, "0")}`;
          return raw.deliver({ type: "steam", id: randomUUID(), steamId, steamedAt: new Date(Date.UTC(2026, 10, 4, 7, n)).toISOString(), steam: steam(steamId) });
        }),
      );
      const { ids, lengths } = await everyPage("find_steam_records", "steamRecords", { machineId: haunted.machine.id });
      expect(ids).toEqual(await restIds("/steam-records", "steamRecords", { machineId: haunted.machine.id }));
      expect(lengths[0]).toBe(50);
      const { result } = await assistant.callWithinBudget<{ cut: string; steamRecords: Fields[] }>("find_steam_records", { machineId: haunted.machine.id, limit: 50 });
      expect(result.cut).toContain("get_steam_record");
      expect(result.steamRecords.every((record) => cut(record.barista))).toBe(true);
      const read = await assistant.callWithinBudget<Fields>("get_steam_record", { id: "haunted-steam-00", curves: true });
      await raw.deliver({ type: "steam", id: randomUUID(), steamId: "plain-steam", steamedAt: "2026-11-04T09:00:00.000Z", steam: derivedSteam("plain-steam", {}, fixture) });
      expect(read.result.curves).toEqual((await assistant.call<Fields>("get_steam_record", { id: "plain-steam", curves: true })).curves);
    });

    it("lists Locations and Machines whose names are as long as they may be, and heavy with what JSON escapes", async () => {
      // A name has at most 100 characters (locations/input.ts, machines/input.ts).
      const longest = (prefix: string) => {
        const piece = Array.from(`${prefix} "quoted" \\ \u{1F600} `);
        let name = "";
        for (let n = 0; (name + piece[n % piece.length]!).length <= 100; n++) name += piece[n % piece.length]!;
        return name.trim();
      };
      const place = await api.createLocation(longest("Location"), "Europe/Lisbon");
      await api.createMachine(longest("Machine"), place.id);
      await assistant.callWithinBudget("list_locations");
      await assistant.callWithinBudget("list_machines");
    });

    it("lists Conflicts whose values run long with each value cut, and reads their Bean with them", async () => {
      const bean = (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: hostile(2_000), name: hostile(2_000), notes: hostile(30_000) } }, 201)).bean.id;
      const database = await server.connectDatabase();
      try {
        await database.query(
          `INSERT INTO conflicts (id, kind, item_id, field, value, edited_at)
           SELECT gen_random_uuid(), 'bean', $1, 'notes', to_jsonb($2::text), transaction_timestamp() - n * interval '1 minute' FROM generate_series(1, 50) AS n`,
          [bean, hostile(5_000)],
        );
      } finally {
        await database.end();
      }
      const listed = await assistant.callWithinBudget<Page & { cut: string; conflicts: { value: unknown; item: { name: unknown } }[] }>("list_conflicts", { limit: 50 });
      expect(listed.result.cut).toBeDefined();
      const theirs = listed.result.conflicts.filter((conflict) => cut(conflict.value));
      expect(theirs.length).toBeGreaterThan(0);
      const read = await assistant.callWithinBudget<{ bean: { content: Fields; roaster: unknown }; conflicts: { entries: { value: unknown }[] } }>("get_library_item", {
        kind: "bean",
        id: bean,
        history: true,
        conflicts: true,
        limit: 50,
      });
      expect([read.result.bean.content.notes, read.result.bean.roaster].every(cut)).toBe(true);
      expect(read.result.conflicts.entries.length).toBeGreaterThan(0);

      // An assistant that edits the notes it read cut, adding to them, is refused, and the notes are kept whole.
      const changer = await Assistant.connect(server.url, app, await signIn(server.url, admin));
      try {
        const refused = await changer.client.callTool({ name: "edit_bean", arguments: { id: bean, notes: `${read.result.bean.content.notes as string} Nutty.` } });
        expect(refused.isError).toBe(true);
        expect((refused.content as { text: string }[])[0]!.text).toContain(`A value holds ${CUT_MARK}`);
      } finally {
        await changer.close();
      }
      expect((await api.get<{ bean: { content: Fields } }>(`/beans/${bean}`)).bean.content.notes).toBe(hostile(30_000));
    });

    it("finds Beans whose names run long a page at a time, each name cut and marked", async () => {
      for (let n = 0; n < 20; n++) await api.send("POST", "/beans", { content: { roaster: hostile(2_000), name: `${hostile(2_000)} ${n}` } }, 201);
      const { ids } = await everyPage("find_library_items", "beans", { kind: "bean", name: "Quote backslash emoji" });
      expect(ids.length).toBeGreaterThanOrEqual(21);
      const { result } = await assistant.callWithinBudget<{ cut: string; beans: Fields[] }>("find_library_items", { kind: "bean", name: "Quote backslash emoji", limit: 50 });
      expect(result.cut).toContain("get_library_item");
      expect(result.beans.every((found) => cut(found.roaster) && cut(found.name))).toBe(true);
    });

    it("reads a Profile whose notes run long with them cut, its steps whole, and returns one too large to fit even so as it is, and logs it", async () => {
      // On a bench at a Location of its own, with no Library to take in first.
      const bench = await api.createMachine("Bench", (await api.createLocation("Bench", "UTC")).id);
      const tablet = tablets.syncing(bench, server, { api: emptyLibrary("43103") });
      await api.waitForOnline(bench);
      const idOf = async (title: string) => (await api.get<{ profiles: { id: string; title: string }[] }>("/profiles")).profiles.find((profile) => profile.title === title)?.id;
      const read = async (title: string) => {
        await expect.poll(() => idOf(title)).toBeTruthy();
        return assistant.client.callTool({ name: "get_library_item", arguments: { kind: "profile", id: await idOf(title), history: true } });
      };
      type ReadProfile = { cut?: string; profile: { content: { profile: { notes: unknown; steps: Fields[] } } }; history: { entries: { fields: { notes?: unknown } }[] } };
      const base = derivedProfile("Long notes", 8.5);

      // Its notes, inside its content as Decaid keeps them, and in its first version, the Profile joining the Library.
      await tablet.addProfile({ ...base, notes: hostile(60_000) });
      const noted = await read("Long notes");
      expect((noted.content as { text: string }[])[0]!.text.length).toBeLessThanOrEqual(RESPONSE_BUDGET);
      const { cut: note, profile, history } = noted.structuredContent as ReadProfile;
      expect(note).toContain("without its history");
      expect(cut(profile.content.profile.notes)).toBe(true);
      expect(cut(history.entries.at(-1)!.fields.notes)).toBe(true);
      const rest = (await api.get<{ profile: { content: { profile: { steps: Fields[] } } } }>(`/profiles/${encodeURIComponent((await idOf("Long notes"))!)}`)).profile;
      expect(profile.content.profile.steps).toEqual(rest.content.profile.steps);

      // Its steps alone, which are never cut, run past the budget.
      const steps = Array.from({ length: 300 }, (_, n) => ({ ...(base.steps as Fields[])[n % (base.steps as Fields[]).length], name: `step ${n}` }));
      await tablet.addProfile({ ...derivedProfile("Endless steps", 7.5), steps });
      const endless = await read("Endless steps");
      expect((endless.content as { text: string }[])[0]!.text.length).toBeGreaterThan(RESPONSE_BUDGET);
      expect((endless.structuredContent as ReadProfile).profile.content.profile.steps.map((step) => step.name)).toEqual(steps.map((step) => step.name));
      await expect.poll(() => server.output()).toContain("get_library_item's response is");
    });
  });
});
