import { afterEach, describe, expect, it, vi } from "vitest";
import { REFERENCE_COPIES_WIRE_REVISION, type ReferenceCopy, type ReferencesHeld, type SkinRecipe, WIRE_REVISION } from "@decent-sync/protocol";
import type { PluginHost, StorageCommand } from "../src/host.js";
import { ReferenceCopies } from "../src/reference-copies.js";
import { PluginStorage } from "../src/storage.js";

// The copies of Reference Shots the plugin keeps in Decaid's plugin storage
// (ticket #510), on a Decaid that fails as a real one can: a key it can't
// read, a write it leaves unanswered, a value something else wrote. Seam 1
// covers the copies as the server sends them and a Skin reads them
// (server/test/skin-references.test.ts).

const ESPRESSO: SkinRecipe = { id: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a72", name: "Belmont espresso", recordId: "2" };
const DECAF: SkinRecipe = { id: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a73", name: "Belmont decaf", recordId: "3" };
const shot = (id: string) => ({ shot: { id, measurements: [] }, recipe: null, referenceOf: [], rating: null, note: null, profileDiffers: false });
const copyOf = (slot: number, copy: ReferenceCopy["copy"]): ReferenceCopy => ({ type: "referenceCopy", id: `copy-${slot}`, slot, copy });

/** The plugin's copies on a Decaid whose plugin storage holds `values`, answering each command in a later turn unless `unanswered` says it leaves it. */
function loaded(values: Record<string, unknown> = {}, unanswered: (command: StorageCommand) => boolean = () => false) {
  const held = new Map(Object.entries(values));
  const logs: string[] = [];
  const told: SkinRecipe[] = [];
  /** The keys written, in order. */
  const written: string[] = [];
  const host = {
    storage: (command: StorageCommand) => {
      if (unanswered(command)) return;
      if (command.type === "write") {
        held.set(command.key, command.data);
        written.push(command.key);
      }
      queueMicrotask(() =>
        command.type === "read" ? storage.answered("storageRead", { key: command.key, value: held.get(command.key) ?? null }) : storage.answered("storageWrite", command.data),
      );
    },
  } as PluginHost;
  const storage = new PluginStorage(host);
  const copies = new ReferenceCopies(storage, (message) => void logs.push(message), (recipe) => void told.push(recipe));
  /** What the plugin tells a server that welcomes it now. */
  const stated = async (serverRevision = WIRE_REVISION, current = true): Promise<ReferencesHeld | undefined> => {
    let sent: ReferencesHeld | undefined;
    await copies.welcomed(async (message) => void (sent = message), serverRevision, () => current);
    return sent;
  };
  return { copies, held, logs, told, written, stated };
}

afterEach(() => vi.useRealTimers());

describe("the plugin's Reference Shot copies", () => {
  it("says what each slot's key holds as it is welcomed, and nothing of a key never written, emptied, or holding something else", async () => {
    const { stated } = loaded({
      "reference.1": `${JSON.stringify({ version: "one", recipe: ESPRESSO })}\n${JSON.stringify(shot("a"))}`,
      "reference.2": JSON.stringify({ version: "two", recipe: DECAF, tooLarge: true }),
      "reference.3": "{}",
      "reference.4": "not JSON",
      "reference.5": { version: "five", recipe: ESPRESSO },
      "reference.6": JSON.stringify({ version: "", recipe: ESPRESSO }),
      "reference.7": JSON.stringify({ version: "seven" }),
    });
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "one", "2": "two" } });
    // A server of the release before the copies is told nothing, and a connection no longer the one welcomed neither.
    expect(await stated(REFERENCE_COPIES_WIRE_REVISION - 1)).toBeUndefined();
    expect(await stated(WIRE_REVISION, false)).toBeUndefined();
  });

  it("keeps each copy in place of what its slot held, one after another, and tells Skins of its Recipe", async () => {
    const { copies, held, told, written, stated } = loaded();
    copies.apply(copyOf(1, { version: "one", recipe: ESPRESSO, reference: shot("a") }));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "one" } });
    expect(held.get("reference.1")).toBe(`${JSON.stringify({ version: "one", recipe: ESPRESSO })}\n${JSON.stringify(shot("a"))}`);
    copies.apply(copyOf(1, { version: "two", recipe: ESPRESSO, reference: null }));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "two" } });
    copies.apply(copyOf(2, { version: "three", recipe: DECAF, tooLarge: true }));
    copies.apply(copyOf(3, { version: "four", recipe: DECAF, reference: shot("b") }));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "two", "2": "three", "3": "four" } });
    copies.apply(copyOf(3, null));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "two", "2": "three" } });
    expect(held.get("reference.1")).toBe(`${JSON.stringify({ version: "two", recipe: ESPRESSO })}\nnull`);
    expect(held.get("reference.2")).toBe(JSON.stringify({ version: "three", recipe: DECAF, tooLarge: true }));
    expect(held.get("reference.3")).toBe("{}");
    expect(written).toEqual(["reference.1", "reference.1", "reference.2", "reference.3", "reference.3"]);
    // Each copy kept is told of, and a slot emptied is not.
    expect(told).toEqual([ESPRESSO, ESPRESSO, DECAF, DECAF]);
  });

  it("keeps only the latest copy for a slot of those that arrive while its storage is behind, so no more wait than there are slots", async () => {
    const { copies, held, told, written, stated } = loaded();
    // Faster than Decaid stores them: a hundred edits of one Reference Shot, and a slot filled and emptied.
    for (let edit = 1; edit <= 100; edit++) copies.apply(copyOf(1, { version: `edit ${edit}`, recipe: ESPRESSO, reference: shot("a") }));
    copies.apply(copyOf(2, { version: "filled", recipe: DECAF, reference: shot("b") }));
    copies.apply(copyOf(2, null));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "edit 100" } });
    expect(written).toEqual(["reference.1", "reference.2"]);
    expect(held.get("reference.2")).toBe("{}");
    expect(told).toEqual([ESPRESSO]);
    // One that arrives once the others are kept is kept in its turn.
    copies.apply(copyOf(1, { version: "edit 101", recipe: ESPRESSO, reference: null }));
    expect(await stated()).toEqual({ type: "referencesHeld", held: { "1": "edit 101" } });
    expect(written).toEqual(["reference.1", "reference.2", "reference.1"]);
  });

  it("reads the copy of a Recipe in a slot: its Reference Shot or none, and nothing for one too large to keep or for any other Recipe", async () => {
    const { copies } = loaded();
    copies.apply(copyOf(4, { version: "one", recipe: ESPRESSO, reference: shot("a\nb") }));
    copies.apply(copyOf(9, { version: "two", recipe: DECAF, tooLarge: true }));
    expect(await copies.read(ESPRESSO.id)).toEqual({ recipe: ESPRESSO, reference: shot("a\nb") });
    expect(await copies.read(DECAF.id)).toBeUndefined();
    expect(await copies.read("019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a79")).toBeUndefined();
    copies.apply(copyOf(4, { version: "three", recipe: ESPRESSO, reference: null }));
    expect(await copies.read(ESPRESSO.id)).toEqual({ recipe: ESPRESSO, reference: null });
    copies.apply(copyOf(4, null));
    expect(await copies.read(ESPRESSO.id)).toBeUndefined();
  });

  it("counts a copy whose write Decaid leaves unanswered as none, so the server sends it again, and tells no Skin of it", async () => {
    vi.useFakeTimers();
    const { copies, logs, told, stated } = loaded({ "reference.1": `${JSON.stringify({ version: "one", recipe: ESPRESSO })}\nnull` }, (command) => command.type === "write");
    copies.apply(copyOf(1, { version: "two", recipe: ESPRESSO, reference: shot("a") }));
    const said = stated();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await said).toEqual({ type: "referencesHeld", held: {} });
    expect(told).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("Could not keep the Reference Shot copy of Recipe Slot 1")]);
    expect(await copies.read(ESPRESSO.id)).toBeUndefined();
  });

  it("takes a key it can't read for holding none, and a copy another write replaced for none to answer with", async () => {
    vi.useFakeTimers();
    const first = `${JSON.stringify({ version: "one", recipe: ESPRESSO })}\n${JSON.stringify(shot("a"))}`;
    const { copies, held, logs, stated } = loaded({ "reference.1": first, "reference.2": first }, (command) => command.type === "read" && command.key === "reference.2");
    const said = stated();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await said).toEqual({ type: "referencesHeld", held: { "1": "one" } });
    expect(logs).toEqual([expect.stringContaining("Could not read the Reference Shot copy of Recipe Slot 2")]);
    // Something else wrote the key since: what it holds is not the copy the plugin knows.
    held.set("reference.1", `${JSON.stringify({ version: "other", recipe: ESPRESSO })}\nnull`);
    expect(await copies.read(ESPRESSO.id)).toBeUndefined();
  });
});
