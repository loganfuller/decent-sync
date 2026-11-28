import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type LocationView } from "./support/admin-api.js";
import { derivedProfile } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 2 for #735: the conversion of the Profiles an upgrade finds into
// Profiles with their Profile Versions under them (ADR-0038), against
// PostgreSQL, by a real server, in the background. The rows are built here in
// the shapes real chains take, never copied from a cafe, with no Profile, as
// the release before left them: a chain replaced everywhere, a version
// published at some Locations, a fork, a Duplicate, a chain shown nowhere,
// one of Decaid's bundled Profiles, and Recipes on them. After it every
// Location shows the steps it showed, and every Recipe not Archived holds the
// steps it held. A row added later with no Profile, as the release before
// adds one during an upgrade, is placed by the same rules.

interface Row {
  id: string;
  parent?: string;
  /** The Locations showing it. */
  shown?: LocationView[];
  bundled?: boolean;
  archived?: boolean;
}

interface Read {
  id: string;
  profileId: string | null;
  version: number | null;
  versions: number;
  current: { id: string; version: number | null };
  startedFrom: { profileId: string; id: string } | null;
  shownAt: { location: { id: string } }[];
}

describe("Converting the Profiles an upgrade finds", () => {
  let server: TestServer;
  let api: AdminApi;
  let one: LocationView;
  let two: LocationView;
  let minute = 0;
  const id = (name: string) => `profile:conversion-${name}`;
  const path = (name: string, rest = "") => `/profiles/${encodeURIComponent(/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(name) ? name : id(name))}${rest}`;
  const read = async (name: string) => (await api.get<{ profile: Read }>(path(name))).profile;
  const versionsOf = async (name: string) =>
    (await api.get<{ versions: { id: string; number: number | null; current: boolean }[] }>(path(name, "/versions"))).versions.map((version) => [version.id, version.number, version.current]);

  /** Runs the statements in one transaction, then says the Library changed, as whatever adds a row does. */
  async function inDatabase(run: (query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<void>): Promise<void> {
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      await run((text, values) => database.query(text, values));
      await database.query("SELECT pg_notify('library_changes', $1)", [one.id]);
      await database.query("COMMIT");
    } finally {
      await database.end();
    }
  }

  /** Adds the rows as the release before left them: with no Profile, each a minute after the last. */
  async function add(query: Parameters<Parameters<typeof inDatabase>[0]>[0], rows: Row[]): Promise<void> {
    for (const row of rows) {
      const content = { profile: derivedProfile(`Conversion ${row.id}`, 4 + minute / 10), parentId: row.parent === undefined ? null : id(row.parent), isDefault: row.bundled === true, metadata: null };
      await query(
        `INSERT INTO profiles (id, content, bundled, archived, created_at) VALUES ($1, $2::jsonb, $3, $4, timestamptz '2026-11-01 00:00:00+00' + make_interval(mins => $5))`,
        [id(row.id), JSON.stringify(content), row.bundled === true, row.archived === true, minute++],
      );
      for (const place of row.shown ?? []) {
        await query("INSERT INTO profile_locations (profile_id, location_id, shown, changed_at) VALUES ($1, $2::uuid, true, now())", [id(row.id), place.id]);
      }
    }
  }

  const recipe = (query: Parameters<Parameters<typeof inDatabase>[0]>[0], name: string, on: string, archived = false) =>
    query(
      `INSERT INTO recipes (id, location_id, record_id, content, archived) VALUES (gen_random_uuid(), $1::uuid, $2, $3::jsonb, $4)`,
      [one.id, `recipe:conversion-${name}`, JSON.stringify({ name: `Conversion ${name}`, profileId: id(on) }), archived],
    );

  /** What each Location shows and each Recipe holds, as the database has it. */
  async function held(): Promise<{ shown: string[]; recipes: Record<string, string> }> {
    const database = await server.connectDatabase();
    try {
      const shown = await database.query<{ at: string }>(
        "SELECT l.profile_id || ' at ' || l.location_id AS at FROM profile_locations l JOIN profiles p ON p.id = l.profile_id WHERE l.shown AND NOT p.archived AND p.id LIKE 'profile:conversion-%' ORDER BY 1",
      );
      const recipes = await database.query<{ name: string; profile: string; archived: boolean }>(
        "SELECT content ->> 'name' AS name, content ->> 'profileId' AS profile, archived FROM recipes WHERE record_id LIKE 'recipe:conversion-%'",
      );
      return { shown: shown.rows.map((row) => row.at), recipes: Object.fromEntries(recipes.rows.filter((row) => !row.archived).map((row) => [row.name, row.profile])) };
    } finally {
      await database.end();
    }
  }

  const unplaced = async () => (await api.get<{ profiles: { id: string; profileId: string | null }[] }>("/profiles")).profiles.filter((profile) => profile.id.startsWith("profile:conversion-") && profile.profileId === null);

  let before: Awaited<ReturnType<typeof held>>;

  beforeAll(async () => {
    server = await startTestServer();
    api = await AdminApi.setUp(server.url);
    one = await api.createLocation("Conversion one", "America/Chicago");
    two = await api.createLocation("Conversion two", "America/Chicago");
    await inDatabase(async (query) => {
      await add(query, [
        // A chain replaced everywhere.
        { id: "chain-1" },
        { id: "chain-2", parent: "chain-1" },
        { id: "chain-3", parent: "chain-2", shown: [one, two] },
        // A version published at one Location, the one it was saved from still shown at the other.
        { id: "partial-1", shown: [two] },
        { id: "partial-2", parent: "partial-1", shown: [one] },
        // A fork: two saved from one, both shown.
        { id: "fork-1" },
        { id: "fork-early", parent: "fork-1", shown: [one] },
        { id: "fork-late", parent: "fork-1", shown: [two] },
        // A Duplicate, the Profile it was made from still shown beside it.
        { id: "original", shown: [one] },
        { id: "duplicate", parent: "original", shown: [one] },
        // A chain shown nowhere, its last Archived with its Location's state kept.
        { id: "nowhere-1" },
        { id: "nowhere-2", parent: "nowhere-1", shown: [one], archived: true },
        // One of Decaid's bundled Profiles, and one saved from it and since hidden, with one saved from that.
        { id: "bundled", bundled: true, shown: [one, two] },
        { id: "mine-1", parent: "bundled" },
        { id: "mine-2", parent: "mine-1", shown: [two] },
        // A Profile hidden everywhere that a Recipe still names, and one saved from it.
        { id: "named-1" },
        { id: "named-2", parent: "named-1", shown: [one] },
      ]);
      await recipe(query, "on the chain", "chain-3");
      await recipe(query, "on a hidden Profile", "named-1");
      await recipe(query, "retired on an earlier version", "chain-1", true);
    });
    before = await held();
    // Converted in the background, once the server is told the Library changed: waited for here, where expect.poll can't be.
    for (let waited = 0; (await unplaced()).length > 0; waited += 100) {
      if (waited > 30_000) throw new Error("The rows were never placed in Profiles");
      await delay(100);
    }
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("leaves every Location showing the steps it showed, and every Recipe not Archived holding the steps it held", async () => {
    expect(await held()).toEqual(before);
    expect(before.shown.length).toBe(12);
    expect(before.recipes).toEqual({ "Conversion on the chain": id("chain-3"), "Conversion on a hidden Profile": id("named-1") });
  });

  it("makes a chain replaced everywhere one Profile, its versions numbered as they joined, the one shown current", async () => {
    const chain = await read("chain-3");
    expect(chain).toMatchObject({ version: 3, versions: 3, current: { id: id("chain-3"), version: 3 }, startedFrom: null });
    expect(chain.shownAt.map((at) => at.location.id).sort()).toEqual([one.id, two.id].sort());
    expect(await versionsOf("chain-1")).toEqual([
      [id("chain-3"), 3, true],
      [id("chain-2"), 2, false],
      [id("chain-1"), 1, false],
    ]);
    expect((await read("chain-1")).profileId).toBe(chain.profileId);
    expect((await read(chain.profileId!)).id).toBe(id("chain-3"));
  });

  it("makes a version published at some Locations, and a Duplicate, each a Profile of its own started from the one still shown", async () => {
    for (const [made, from] of [
      ["partial-2", "partial-1"],
      ["duplicate", "original"],
    ] as const) {
      const [apart, source] = [await read(made), await read(from)];
      expect(apart).toMatchObject({ version: 1, versions: 1, startedFrom: { profileId: source.profileId, id: id(from) } });
      expect(source).toMatchObject({ version: 1, versions: 1, startedFrom: null });
      expect(apart.profileId).not.toBe(source.profileId);
    }
  });

  it("keeps the later saved of a fork's two shown versions as current, and makes the other a Profile of its own", async () => {
    expect(await versionsOf("fork-1")).toEqual([
      [id("fork-late"), 2, true],
      [id("fork-1"), 1, false],
    ]);
    const [late, early] = [await read("fork-late"), await read("fork-early")];
    expect(early).toMatchObject({ version: 1, versions: 1, startedFrom: { profileId: late.profileId } });
    expect(early.shownAt.map((at) => at.location.id)).toEqual([one.id]);
    expect(late.shownAt.map((at) => at.location.id)).toEqual([two.id]);
  });

  it("makes the latest saved current where none is shown, the Profile shown nowhere", async () => {
    expect(await versionsOf("nowhere-1")).toEqual([
      [id("nowhere-2"), 2, true],
      [id("nowhere-1"), 1, false],
    ]);
    expect((await read((await read("nowhere-1")).profileId!)).shownAt).toEqual([]);
  });

  it("gives one of Decaid's bundled Profiles one version, and what was saved from it a Profile started from it", async () => {
    const bundled = await read("bundled");
    expect(bundled).toMatchObject({ version: 1, versions: 1, startedFrom: null });
    expect(await versionsOf("mine-1")).toEqual([
      [id("mine-2"), 2, true],
      [id("mine-1"), 1, false],
    ]);
    expect(await read("mine-2")).toMatchObject({ startedFrom: { profileId: bundled.profileId, id: id("bundled") } });
  });

  it("keeps apart a Profile a Recipe still names though no Location shows it, and moves an Archived Recipe from an earlier version to the current one", async () => {
    const [named, saved] = [await read("named-1"), await read("named-2")];
    expect(named).toMatchObject({ versions: 1, current: { id: id("named-1") } });
    expect(saved).toMatchObject({ versions: 1, startedFrom: { profileId: named.profileId } });
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query("SELECT content ->> 'profileId' AS profile FROM recipes WHERE record_id = 'recipe:conversion-retired on an earlier version'");
      expect(rows).toEqual([{ profile: id("chain-3") }]);
      // It followed, with no entry in its history.
      const versions = await database.query("SELECT 1 FROM item_versions v JOIN recipes r ON r.id::text = v.item_id WHERE v.kind = 'recipe' AND r.record_id LIKE 'recipe:conversion-%'");
      expect(versions.rows).toEqual([]);
    } finally {
      await database.end();
    }
  });

  it("lists one row for each Profile", async () => {
    const listed = (await api.get<{ profiles: { id: string }[] }>("/profiles")).profiles.map((profile) => profile.id).filter((listedId) => listedId.startsWith("profile:conversion-"));
    expect(listed.sort()).toEqual(["chain-3", "partial-1", "partial-2", "fork-late", "fork-early", "original", "duplicate", "nowhere-2", "bundled", "mine-2", "named-1", "named-2"].map(id).sort());
  });

  it("places a row added later with no Profile, as the release before adds one, by the same rules, and renumbers nothing", async () => {
    const chain = (await read("chain-3")).profileId!;
    await inDatabase(async (query) => {
      // The chain's current version replaced everywhere, as the release before publishes a new version; and one saved from a Profile still shown.
      await query("UPDATE profile_locations SET shown = false WHERE profile_id = $1", [id("chain-3")]);
      await query("UPDATE recipes SET content = jsonb_set(content, '{profileId}', to_jsonb($2::text)) WHERE content ->> 'profileId' = $1 AND NOT archived", [id("chain-3"), id("chain-4")]);
      await add(query, [
        { id: "chain-4", parent: "chain-3", shown: [one, two] },
        { id: "original-again", parent: "original", shown: [two] },
      ]);
    });
    await expect.poll(async () => (await unplaced()).length, { timeout: 30_000 }).toBe(0);
    await expect.poll(() => versionsOf(chain)).toEqual([
      [id("chain-4"), 4, true],
      [id("chain-3"), 3, false],
      [id("chain-2"), 2, false],
      [id("chain-1"), 1, false],
    ]);
    expect(await read("original-again")).toMatchObject({ versions: 1, startedFrom: { id: id("original") } });
    // The chain's page keeps its address.
    expect((await read(chain)).id).toBe(id("chain-4"));
  });

  it("makes an earlier version current again where it alone is shown, as the release before returns to one, with no new number", async () => {
    const chain = (await read("chain-1")).profileId!;
    await inDatabase(async (query) => {
      await query("UPDATE profile_locations SET shown = false WHERE profile_id = $1", [id("chain-4")]);
      await query("UPDATE profile_locations SET shown = true WHERE profile_id = $1", [id("chain-3")]);
      await query("UPDATE recipes SET content = jsonb_set(content, '{profileId}', to_jsonb($2::text)) WHERE content ->> 'profileId' = $1 AND NOT archived", [id("chain-4"), id("chain-3")]);
    });
    await expect.poll(() => versionsOf(chain), { timeout: 30_000 }).toEqual([
      [id("chain-4"), 4, false],
      [id("chain-3"), 3, true],
      [id("chain-2"), 2, false],
      [id("chain-1"), 1, false],
    ]);
  });

  it("never gives a number again once the version that had it has left the Profile", async () => {
    const chain = (await read("chain-1")).profileId!;
    // Version 4 shown again beside Version 3, current, so leaves for a Profile of its own; then Version 3 replaced everywhere.
    await inDatabase(async (query) => {
      await query("UPDATE profile_locations SET shown = true WHERE profile_id = $1 AND location_id = $2::uuid", [id("chain-4"), two.id]);
    });
    await expect.poll(async () => (await read("chain-4")).profileId, { timeout: 30_000 }).not.toBe(chain);
    await inDatabase(async (query) => {
      await query("UPDATE profile_locations SET shown = false WHERE profile_id = $1", [id("chain-3")]);
      await query("UPDATE recipes SET content = jsonb_set(content, '{profileId}', to_jsonb($2::text)) WHERE content ->> 'profileId' = $1 AND NOT archived", [id("chain-3"), id("chain-5")]);
      await add(query, [{ id: "chain-5", parent: "chain-3", shown: [one] }]);
    });
    await expect.poll(() => versionsOf(chain), { timeout: 30_000 }).toEqual([
      [id("chain-5"), 5, true],
      [id("chain-3"), 3, false],
      [id("chain-2"), 2, false],
      [id("chain-1"), 1, false],
    ]);
  });

  it("refuses a title a Profile not placed yet has, while placing waits", async () => {
    const holder = await server.connectDatabase();
    try {
      // Placing waits for this lock, PROFILE_JOINING_LOCK, so both rows stay unplaced through the edit.
      await holder.query("SELECT pg_advisory_lock(4000008)");
      await inDatabase((query) => add(query, [{ id: "untitled-a" }, { id: "untitled-b" }]));
      expect((await read("untitled-a")).profileId).toBeNull();
      const refused = await api.call("PATCH", path("untitled-a"), { content: { title: "conversion UNTITLED-B" } });
      expect(refused.status).toBe(409);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(4000008)");
      await holder.end();
    }
    await expect.poll(async () => (await unplaced()).length, { timeout: 30_000 }).toBe(0);
  });

  it("takes an Archived Recipe's row before the versions' rows, as an edit of it does, so the two never deadlock", async () => {
    const holder = await server.connectDatabase();
    const editing = await server.connectDatabase();
    try {
      await holder.query("SELECT pg_advisory_lock(4000008)");
      await inDatabase(async (query) => {
        await add(query, [{ id: "locked-1" }, { id: "locked-2", parent: "locked-1", shown: [one] }]);
        await recipe(query, "archived while edited", "locked-1", true);
      });
      // An edit of the Recipe holds its row, as recipe-edits.service.ts takes it, then reads the Profile it names FOR SHARE.
      await editing.query("BEGIN");
      await editing.query("SELECT 1 FROM recipes WHERE record_id = 'recipe:conversion-archived while edited' FOR UPDATE");
      await holder.query("SELECT pg_advisory_unlock(4000008)");
      // Placing then waits for the Recipe's row.
      const waiting = async () =>
        (await holder.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple') AND pid <> $1", [(editing as unknown as { processID: number }).processID])).rows[0]!.n;
      await expect.poll(waiting, { timeout: 30_000 }).toBeGreaterThan(0);
      // Before any version's row, so the edit's read is not held up: shorter than the second PostgreSQL waits before it looks for a deadlock.
      await editing.query("SET LOCAL lock_timeout = '300ms'");
      expect((await editing.query("SELECT id FROM profiles WHERE id = $1 FOR SHARE", [id("locked-2")])).rows).toEqual([{ id: id("locked-2") }]);
      await editing.query("COMMIT");
    } finally {
      await editing.query("ROLLBACK").catch(() => undefined);
      await editing.end();
      await holder.query("SELECT pg_advisory_unlock_all()");
      await holder.end();
    }
    await expect.poll(async () => (await unplaced()).length, { timeout: 30_000 }).toBe(0);
    const database = await server.connectDatabase();
    try {
      const { rows } = await database.query("SELECT content ->> 'profileId' AS profile FROM recipes WHERE record_id = 'recipe:conversion-archived while edited'");
      expect(rows).toEqual([{ profile: id("locked-2") }]);
    } finally {
      await database.end();
    }
  });
});
