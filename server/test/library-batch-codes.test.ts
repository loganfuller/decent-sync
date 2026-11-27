import { BATCH_CODE_KEY, GLOBAL_ID_KEY, globalIdOf } from "@decent-sync/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type CreatedMachine, type LocationView } from "./support/admin-api.js";
import { emptyLibrary, syncingTablet } from "./support/loaded-tablets.js";
import { waitForLockWaits } from "./support/lock-waits.js";
import type { SimulatedTablet } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 and the REST API for ticket #703: a Bean Batch's Batch Code, the
// roaster's own identifier for it. It is set as a batch is created, changed
// and cleared, each an entry in the batch's history; no two batches that are
// not Archived hold one, ignoring case and the spaces around it, which the
// database decides between two requests made at once; the list of batches is
// asked for by it; and every tablet at the batch's Location holds it on its
// Decaid record, in `extras` (ADR-0036), through the built plugin in
// simulated tablets, on two server instances sharing PostgreSQL. A code
// changed on a tablet is written over, and changes nothing in the Library.
// Serials are made up, from 70301.

type Record_ = Record<string, unknown>;

interface BatchView {
  id: string;
  batchCode: string | null;
  archived: boolean;
  content: Record_;
}

interface Refusal {
  message: string;
  existing?: { id: string; name: string; batchCode: string; bean: { name: string | null }; roastDate: string | null };
}

const env = { SYNC_HELLO_TIMEOUT_SECONDS: "2", SYNC_HEARTBEAT_SECONDS: "1" };

describe("A Bean Batch's Batch Code", () => {
  let server: TestServer;
  let other: TestServer;
  let api: AdminApi;
  let home: LocationView;
  let serial = 70_301;

  beforeAll(async () => {
    server = await startTestServer({ env });
    other = await startTestServer({ env, sharing: server });
    api = await AdminApi.setUp(server.url);
    home = await api.createLocation("Coded home", "America/Chicago");
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** A Location with one Machine, its tablet online through the instance given, its Decaid's Library empty. */
  async function locationWithTablet(name: string, instance: TestServer = server): Promise<{ location: LocationView; machine: CreatedMachine; tablet: SimulatedTablet }> {
    const location = await api.createLocation(name, "America/Chicago");
    const machine = await api.createMachine(`${name} 1`, location.id);
    const tablet = syncingTablet(machine, instance, { api: emptyLibrary(String(serial++)) });
    await api.waitForOnline(machine);
    return { location, machine, tablet };
  }

  const createBean = async (name: string) => (await api.send<{ bean: { id: string } }>("POST", "/beans", { content: { roaster: "Roux", name } }, 201)).bean.id;
  /** Where a batch is created unless a test names a Location: one with no tablet. */
  const atHome = () => [{ locationId: home.id }];
  const newBatch = (beanId: string, content: Record_, locations: { locationId: string }[] = atHome(), as: AdminApi = api) => as.call("POST", "/bean-batches", { beanId, content, locations });
  const createBatch = async (beanId: string, content: Record_, locations: { locationId: string }[] = atHome()) =>
    (await api.send<{ batch: BatchView }>("POST", "/bean-batches", { beanId, content, locations }, 201)).batch;
  const edit = (id: string, content: Record_, as: AdminApi = api) => as.call("PATCH", `/bean-batches/${id}`, { content });
  const setArchived = (id: string, archived: boolean) => api.call("PUT", `/bean-batches/${id}/archived`, { archived });
  const read = async (id: string) => (await api.get<{ batch: BatchView }>(`/bean-batches/${id}`)).batch;
  const history = async (id: string) => api.get<{ versions: { fields: Record_ }[]; lostEdits: unknown[] }>(`/bean-batches/${id}/history`);
  const heldBatch = (tablet: SimulatedTablet, id: string) => tablet.batches().find((record) => globalIdOf(record) === id);
  const heldCode = (tablet: SimulatedTablet, id: string) => (heldBatch(tablet, id)?.extras as Record_ | undefined)?.[BATCH_CODE_KEY] ?? null;

  /** A request's refusal as a conflict, which it must be. */
  async function conflict(response: Response): Promise<Refusal> {
    expect(response.status).toBe(409);
    return (await response.json()) as Refusal;
  }

  it("is set as a batch is created, changed and cleared, each in the batch's history, and the Location's tablet holds each on its record", async () => {
    const { location, tablet } = await locationWithTablet("Codes Uptown", other);
    const bean = await createBean("Coded Guji");
    // Kept without the spaces around it.
    const batch = await createBatch(bean, { batchCode: "  PR-0470 ", roastDate: "2026-11-18" }, [{ locationId: location.id }]);
    expect(batch).toMatchObject({ batchCode: "PR-0470", content: { batchCode: "PR-0470", roastDate: "2026-11-18T00:00:00.000" } });
    // Beside its global id in the record's `extras`, and nowhere at the record's top.
    await expect.poll(() => heldBatch(tablet, batch.id)?.extras).toEqual({ [GLOBAL_ID_KEY]: batch.id, [BATCH_CODE_KEY]: "PR-0470" });
    expect(heldBatch(tablet, batch.id)).not.toHaveProperty("batchCode");

    const changed = (await (await edit(batch.id, { batchCode: "PR-0471" })).json()) as { batch: BatchView };
    expect(changed.batch).toMatchObject({ batchCode: "PR-0471", content: { batchCode: "PR-0471" } });
    await expect.poll(() => heldCode(tablet, batch.id)).toBe("PR-0471");

    // Cleared by null, or by nothing but spaces.
    const cleared = (await (await edit(batch.id, { batchCode: "   " })).json()) as { batch: BatchView };
    expect(cleared.batch.batchCode).toBeNull();
    expect(cleared.batch.content).not.toHaveProperty("batchCode");
    await expect.poll(() => heldCode(tablet, batch.id)).toBeNull();
    expect(globalIdOf(heldBatch(tablet, batch.id))).toBe(batch.id);

    const { versions } = await history(batch.id);
    expect(versions.map((version) => version.fields).filter((fields) => "batchCode" in fields)).toEqual([
      { batchCode: null },
      { batchCode: "PR-0471" },
      expect.objectContaining({ batchCode: "PR-0470", roastDate: "2026-11-18T00:00:00.000" }),
    ]);
    // The list gives it too.
    const listed = (await api.get<{ batches: BatchView[] }>("/bean-batches")).batches.find((one) => one.id === batch.id);
    expect(listed?.batchCode).toBeNull();
  });

  it("refuses a code another batch that is not Archived holds, ignoring case and the spaces around it, naming that batch, as one is created or edited", async () => {
    const bean = await createBean("Refused Huila");
    const holder = await createBatch(bean, { batchCode: "LR-0412", roastDate: "2026-11-12" });
    // With its Bean's name and roast date, which the management interface names it by (#732).
    const named = { id: holder.id, name: "Refused Huila, roasted 2026-11-12", batchCode: "LR-0412", bean: { name: "Refused Huila" }, roastDate: "2026-11-12T00:00:00.000" };

    const created = await conflict(await newBatch(bean, { batchCode: " lr-0412  " }));
    expect(created.existing).toEqual(named);
    expect(created.message).toBe(`Another Bean Batch that is not Archived holds the Batch Code LR-0412: Refused Huila, roasted 2026-11-12 (id ${holder.id})`);

    const second = await createBatch(bean, { batchCode: "LR-0413" });
    expect((await conflict(await edit(second.id, { batchCode: "Lr-0412", notes: "Relabelled" }))).existing).toEqual(named);
    // Refused whole: its other field is not saved either.
    expect(await read(second.id)).toMatchObject({ batchCode: "LR-0413" });
    expect((await read(second.id)).content).not.toHaveProperty("notes");

    // A batch keeps its own code through an edit that gives it again, in another case too, and may hold none beside others holding none.
    expect((await edit(holder.id, { batchCode: "lr-0412" })).status).toBe(200);
    expect((await read(holder.id)).batchCode).toBe("lr-0412");
    const none = await createBatch(bean, {});
    expect((await edit(second.id, { batchCode: null })).status).toBe(200);
    expect([(await read(none.id)).batchCode, (await read(second.id)).batchCode]).toEqual([null, null]);

    // What is no code is refused as a bad request: something other than text, and one longer than a code may be.
    expect((await newBatch(bean, { batchCode: 412 })).status).toBe(400);
    const tooLong = await edit(second.id, { batchCode: "x".repeat(101) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { message: string[] }).message).toEqual(["batchCode must be at most 100 characters"]);
    expect((await edit(second.id, { batchCode: "x".repeat(100) })).status).toBe(200);
  });

  it("frees an Archived batch's code for another batch, and refuses to restore it once another has taken the code, naming that batch", async () => {
    const bean = await createBean("Retired Cerrado");
    const retired = await createBatch(bean, { batchCode: "BR-0001", roastDate: "2026-10-01" });
    expect((await setArchived(retired.id, true)).status).toBe(200);
    // Archived, it keeps its code, which another batch may now be given, as it is created or edited.
    expect((await read(retired.id)).batchCode).toBe("BR-0001");
    const taker = await createBatch(bean, { batchCode: "br-0001", roastDate: "2026-11-01" });
    expect(taker.batchCode).toBe("br-0001");

    const refused = await conflict(await setArchived(retired.id, false));
    expect(refused.existing).toEqual({ id: taker.id, name: "Retired Cerrado, roasted 2026-11-01", batchCode: "br-0001", bean: { name: "Retired Cerrado" }, roastDate: "2026-11-01T00:00:00.000" });
    expect((await read(retired.id)).archived).toBe(true);

    // An Archived batch may be given a code another holds, and is restored once its own is free: changed, or the other's Archived.
    expect((await edit(retired.id, { batchCode: "BR-0001" })).status).toBe(200);
    expect((await conflict(await setArchived(retired.id, false))).existing?.id).toBe(taker.id);
    expect((await setArchived(taker.id, true)).status).toBe(200);
    expect((await setArchived(retired.id, false)).status).toBe(200);
    expect(await read(retired.id)).toMatchObject({ archived: false, batchCode: "BR-0001" });
    expect((await conflict(await setArchived(taker.id, false))).existing?.id).toBe(retired.id);
  });

  it("leaves one batch holding a code two requests race for, through two instances, the other refused naming it", async () => {
    const bean = await createBean("Raced Yirgacheffe");
    // At once, through either instance: nothing but the database decides between them.
    const answers = await Promise.all([newBatch(bean, { batchCode: "RACE-1" }), newBatch(bean, { batchCode: "race-1" }, undefined, api.at(other.url))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    const winner = ((await answers.find((answer) => answer.status === 201)!.json()) as { batch: BatchView }).batch;
    const loser = (await answers.find((answer) => answer.status === 409)!.json()) as Refusal;
    expect(loser.existing).toMatchObject({ id: winner.id, batchCode: winner.batchCode });
    const holding = async (code: string) => (await api.get<{ batches: BatchView[] }>(`/bean-batches?batchCode=${code}`)).batches.map((batch) => batch.id);
    expect(await holding("RACE-1")).toEqual([winner.id]);

    // And where the check before a write sees no holder yet: another transaction holds the code, uncommitted. A create, an
    // edit and a restore each wait for it on the index, and are refused once it commits, naming the batch it made.
    const spare = await createBatch(bean, { batchCode: "SPARE-1" });
    const retired = await createBatch(bean, { batchCode: "rAce-2" });
    expect((await setArchived(retired.id, true)).status).toBe(200);
    const database = await server.connectDatabase();
    try {
      await database.query("BEGIN");
      const { rows } = await database.query<{ id: string }>(
        `INSERT INTO bean_batches (id, bean_id, content) VALUES (gen_random_uuid(), $1, '{"batchCode": "Race-2", "roastDate": "2026-11-20T00:00:00.000"}') RETURNING id::text AS id`,
        [bean],
      );
      const creating = newBatch(bean, { batchCode: "RACE-2" }, undefined, api.at(other.url));
      const editing = edit(spare.id, { batchCode: "race-2" });
      const restoring = setArchived(retired.id, false);
      await waitForLockWaits(server, { count: 3 });
      await database.query("COMMIT");
      const named = { id: rows[0]!.id, name: "Raced Yirgacheffe, roasted 2026-11-20", batchCode: "Race-2", bean: { name: "Raced Yirgacheffe" }, roastDate: "2026-11-20T00:00:00.000" };
      expect((await conflict(await creating)).existing).toEqual(named);
      expect((await conflict(await editing)).existing).toEqual(named);
      expect((await conflict(await restoring)).existing).toEqual(named);
      expect((await read(retired.id)).archived).toBe(true);
      // The one Archived holds it still, and comes with the holder.
      expect((await holding("race-2")).sort()).toEqual([rows[0]!.id, retired.id].sort());
      expect((await read(spare.id)).batchCode).toBe("SPARE-1");
    } finally {
      await database.end();
    }
  });

  it("lists the batches holding exactly a Batch Code, ignoring case and the spaces around it", async () => {
    const bean = await createBean("Listed Sidamo");
    const old = await createBatch(bean, { batchCode: "LIST-7", roastDate: "2026-09-01" });
    await api.send("PUT", `/bean-batches/${old.id}/archived`, { archived: true });
    const current = await createBatch(bean, { batchCode: "list-7", roastDate: "2026-11-01" });
    await createBatch(bean, { batchCode: "LIST-70" });
    const listed = async (query: string) => (await api.get<{ batches: BatchView[] }>(`/bean-batches?${query}`)).batches.map((batch) => batch.id);
    // The one that holds it now, and the Archived one that held it, the latest roasted first; none for part of a code.
    expect(await listed(`batchCode=${encodeURIComponent(" List-7 ")}`)).toEqual([current.id, old.id]);
    expect(await listed("batchCode=LIST")).toEqual([]);
    expect((await listed("batchCode=")).length).toBeGreaterThan(2);
    expect((await api.call("GET", "/bean-batches?batchCode=a&batchCode=b")).status).toBe(400);
  });

  it("writes over a Batch Code changed on a tablet's record with the batch's, and changes nothing in the Library", async () => {
    const { location, tablet } = await locationWithTablet("Codes Downtown");
    const bean = await createBean("Tablet Kenya");
    const coded = await createBatch(bean, { batchCode: "TK-1", roastDate: "2026-11-02" }, [{ locationId: location.id }]);
    const plain = await createBatch(bean, { roastDate: "2026-11-03" }, [{ locationId: location.id }]);
    await expect.poll(() => heldCode(tablet, coded.id)).toBe("TK-1");
    await expect.poll(() => heldBatch(tablet, plain.id)).toBeDefined();
    const before = { coded: await history(coded.id), plain: await history(plain.id) };

    // Changed, and given to a batch that has none, as another plugin or a Skin might write `extras`; and cleared.
    const extrasOf = (id: string) => heldBatch(tablet, id)!.extras as Record_;
    await tablet.editBatch(heldBatch(tablet, coded.id)!.id, { extras: { ...extrasOf(coded.id), [BATCH_CODE_KEY]: "TABLET-9" } });
    await tablet.editBatch(heldBatch(tablet, plain.id)!.id, { extras: { ...extrasOf(plain.id), [BATCH_CODE_KEY]: "TK-1", other: "kept" } });
    await expect.poll(() => heldCode(tablet, coded.id)).toBe("TK-1");
    await expect.poll(() => heldCode(tablet, plain.id)).toBeNull();
    // The record's other keys are kept as the code is written over.
    expect(extrasOf(plain.id)).toMatchObject({ [GLOBAL_ID_KEY]: plain.id, other: "kept" });
    const { [BATCH_CODE_KEY]: dropped, ...withoutCode } = extrasOf(coded.id);
    await tablet.editBatch(heldBatch(tablet, coded.id)!.id, { extras: withoutCode });
    await expect.poll(() => heldCode(tablet, coded.id)).toBe("TK-1");

    // A change of another field made on the tablet with it is still the tablet's edit.
    await tablet.editBatch(heldBatch(tablet, coded.id)!.id, { roastLevel: "Light", extras: { ...extrasOf(coded.id), [BATCH_CODE_KEY]: "TABLET-10" } });
    await expect.poll(async () => (await read(coded.id)).content.roastLevel).toBe("Light");
    await expect.poll(() => heldCode(tablet, coded.id)).toBe("TK-1");

    expect(await read(coded.id)).toMatchObject({ batchCode: "TK-1" });
    expect((await read(plain.id)).batchCode).toBeNull();
    const after = { coded: await history(coded.id), plain: await history(plain.id) };
    expect(after.plain).toEqual(before.plain);
    expect(after.coded.lostEdits).toEqual([]);
    expect(after.coded.versions.map((version) => version.fields)).toEqual([{ roastLevel: "Light" }, ...before.coded.versions.map((version) => version.fields)]);
  });
});
