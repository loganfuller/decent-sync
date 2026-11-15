import {
  RECIPE_SLOTS,
  REFERENCE_COPIES_WIRE_REVISION,
  type ReferenceCopy,
  type ReferencesHeld,
  type SkinRecipe,
  type SkinReference,
  type SkinReferenceShot,
  isRecipeSlot,
  peerHasWireRevision,
} from "@decent-sync/protocol";
import type { PluginStorage } from "./storage.js";

// The copies the tablet keeps of the Reference Shots of its Location's
// Recipes in slots (ticket #510, ADR-0030), so a Skin still reads a Recipe's
// reference while the server can't be reached. The server sends them
// (`referenceCopy`), one for each Recipe Slot, and keeps them current: on
// each connection the plugin says which it holds (`referencesHeld`), and the
// server sends those that differ, then and whenever one changes.
//
// They are kept in Decaid's plugin storage, a value for each slot under the
// keys `reference.1` to `reference.9`. Decaid stores no null, so the plugin
// can delete no key it wrote, and it keeps a plugin's whole storage in
// memory: so the keys are the slots', which are few, each written again as
// its slot's Recipe or that Recipe's reference changes, and one whose slot
// holds nothing any more is written `{}`. A value is two lines of JSON: what
// names the copy (`Head`), which is all a load reads of it, then the
// Reference Shot, or null where the Recipe has none. A reference too large
// to keep (MAX_REFERENCE_COPY_BYTES, which the server judges) has only the
// first: the plugin knows the Recipe has one, and that it holds no copy.
//
// The plugin answers no copy. What it holds is what it says on its next
// connection, so a copy whose write failed is sent again then.

/** What names the copy a slot's key holds: its version and its Recipe, as the server gave them, and whether its reference was too large to keep. */
interface Head {
  version: string;
  recipe: SkinRecipe;
  tooLarge?: boolean;
}

/** What a slot's key is written where the slot holds nothing. */
const EMPTY = "{}";

function key(slot: number): string {
  return `reference.${slot}`;
}

export class ReferenceCopies {
  /** What each slot's key holds, for the slots holding a copy. */
  private readonly slots = new Map<number, Head>();
  /** The reading of what the keys hold, begun by the first use. */
  private loading: Promise<void> | undefined;
  /** What each slot is to hold, for the slots whose latest copy from the server is still to be kept. */
  private readonly waiting = new Map<number, ReferenceCopy["copy"]>();
  /** Whether the copies waiting are being kept. */
  private busy = false;
  /** Resolves once the copies that have come are kept. */
  private keeping: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly storage: PluginStorage,
    private readonly log: (message: string) => void,
    /** Tells Skins that the tablet's copy of a Recipe's reference changed. */
    private readonly changed: (recipe: SkinRecipe) => void,
  ) {}

  /** Reads what the keys hold, once. A key that can't be read, or holds no copy, counts as holding none, which the server then sends. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      for (let slot = 1; slot <= RECIPE_SLOTS; slot++) {
        try {
          const head = headOf(await this.storage.read(key(slot), `a read of the Reference Shot copy of Recipe Slot ${slot}`));
          if (head) this.slots.set(slot, head);
        } catch (error) {
          if (!this.stopped) this.log(`Could not read the Reference Shot copy of Recipe Slot ${slot}: ${describe(error)}`);
        }
      }
    })();
    return this.loading;
  }

  /**
   * The server welcomed a connection: it is told what the tablet holds, once
   * that is read and the copies an earlier connection brought are kept,
   * where `current` says the connection is still the one welcomed. A server
   * behind the copies' wire revision is told nothing, and sends none.
   */
  async welcomed(send: (held: ReferencesHeld) => Promise<void>, serverRevision: number, current: () => boolean): Promise<void> {
    if (!peerHasWireRevision(serverRevision, REFERENCE_COPIES_WIRE_REVISION)) return;
    await this.settled();
    if (this.stopped || !current()) return;
    const held: Record<string, string> = {};
    for (const [slot, head] of this.slots) held[String(slot)] = head.version;
    // A send that fails drops the connection, and the next one is told.
    await send({ type: "referencesHeld", held }).catch(() => {});
  }

  /**
   * Keeps a copy the server sent in place of what its slot held, and tells
   * Skins of its Recipe. Copies are kept one at a time. One that arrives
   * while an earlier copy for its slot still waits its turn takes that
   * copy's place, so however slow Decaid's storage is, no more wait than
   * there are slots.
   */
  apply({ slot, copy }: ReferenceCopy): void {
    if (this.stopped || !isRecipeSlot(slot)) return;
    this.waiting.set(slot, copy);
    if (!this.busy) this.keeping = this.keepWaiting();
  }

  /** Keeps the copies waiting, until none is. It never rejects. */
  private async keepWaiting(): Promise<void> {
    this.busy = true;
    try {
      await this.load();
      for (;;) {
        const next = this.waiting.entries().next();
        if (next.done || this.stopped) return;
        const [slot, copy] = next.value;
        this.waiting.delete(slot);
        await this.keep(slot, copy);
      }
    } catch (error) {
      this.log(`Could not keep the Reference Shot copies: ${describe(error)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Writes what a slot is to hold to its key, and tells Skins of its Recipe once it is written. */
  private async keep(slot: number, copy: ReferenceCopy["copy"]): Promise<void> {
    const head: Head | null = copy && { version: copy.version, recipe: copy.recipe, ...(copy.tooLarge === true && { tooLarge: true }) };
    try {
      const data = head === null ? EMPTY : head.tooLarge ? JSON.stringify(head) : `${JSON.stringify(head)}\n${JSON.stringify(copy?.reference ?? null)}`;
      await this.storage.write(key(slot), data, `the Reference Shot copy of Recipe Slot ${slot}`);
    } catch (error) {
      // What the key holds is not known: it counts as none, so the next connection is sent it again.
      this.slots.delete(slot);
      if (!this.stopped) this.log(`Could not keep the Reference Shot copy of Recipe Slot ${slot}: ${describe(error)}`);
      return;
    }
    if (head === null) this.slots.delete(slot);
    else {
      this.slots.set(slot, head);
      this.changed(head.recipe);
    }
  }

  /**
   * The tablet's copy of the Recipe's reference, for a Recipe in a slot whose
   * copy it holds: its Reference Shot, or that it has none. Undefined for
   * any other Recipe, for one whose reference was too large to keep, and
   * where the copy can't be read.
   */
  async read(recipeId: string): Promise<SkinReference | undefined> {
    await this.settled();
    for (const [slot, head] of this.slots) {
      if (head.recipe.id !== recipeId) continue;
      if (head.tooLarge) return undefined;
      try {
        const value = await this.storage.read(key(slot), `a read of the Reference Shot copy of Recipe Slot ${slot}`);
        const [first, second] = typeof value === "string" ? value.split("\n") : [];
        // The key holds what the slot was last written, which a write since may have replaced.
        if (first === undefined || second === undefined || headOf(first)?.version !== head.version) return undefined;
        return { recipe: head.recipe, reference: JSON.parse(second) as SkinReferenceShot | null };
      } catch (error) {
        if (!this.stopped) this.log(`Could not read the Reference Shot copy of Recipe Slot ${slot}: ${describe(error)}`);
        return undefined;
      }
    }
    return undefined;
  }

  /** The plugin unloads: nothing more is kept or told. A write under way still lands (storage.ts). */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves once what the keys hold is read and every copy that has come is kept. */
  private async settled(): Promise<void> {
    await this.load();
    await this.keeping;
  }
}

/** What names the copy a key's value holds, or null where it holds none, as a key never written or one written EMPTY. */
function headOf(value: unknown): Head | null {
  if (typeof value !== "string") return null;
  try {
    const head: unknown = JSON.parse(value.split("\n", 1)[0] ?? "");
    if (typeof head !== "object" || head === null) return null;
    const { version, recipe, tooLarge } = head as { version?: unknown; recipe?: unknown; tooLarge?: unknown };
    if (typeof version !== "string" || version === "" || typeof recipe !== "object" || recipe === null || typeof (recipe as { id?: unknown }).id !== "string") return null;
    return { version, recipe: recipe as SkinRecipe, ...(tooLarge === true && { tooLarge: true }) };
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
