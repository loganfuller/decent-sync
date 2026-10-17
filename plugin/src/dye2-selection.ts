import { DYE2_NAMESPACE } from "@decent-sync/protocol";
import { request } from "./decaid.js";
import type { TransportEvent } from "./host.js";
import type { ArmedOn } from "./loaded-recipe-rules.js";

// DYE2's selected recipe (ADR-0022). DYE2 keeps one selected
// recipe or favourite on each tablet, which its dashboard and Streamline's
// DYE strip select as they apply one, through DYE2's `selection` endpoint,
// and records into it each change of the Workflow it sees, whichever app
// made it, but for its own applies (`workflow-record.ts` in
// dye2:dye2-plugin/src/utils at 2cf631c). The Machine's Loaded Recipe is the
// recipe it selects (loaded-recipes.ts). This module is how the plugin reads
// and makes that selection, tells whether DYE2 is there at all, and hears
// DYE2's pushes. DYE2 keeps its selection in its own storage, a cleared one
// as `{}` (decentespresso/dye2#22), which the plugin never writes.

const SELECTION = `/plugins/${DYE2_NAMESPACE}/selection`;

/** DYE2's WebSocket endpoint, on which it pushes `{"what":"workflow"}` as it selects, records and refreshes its recent favourites. */
export const CHANGED_SOCKET = `ws://localhost:8080/ws/v1/plugins/${DYE2_NAMESPACE}/changed`;

/** DYE2's selection as its endpoint answers it. */
export type SelectionAnswer =
  /** 404: DYE2 is not loaded, as while it reloads or updates. */
  | { kind: "unavailable" }
  | { kind: "none" }
  /** A recipe, by its slot (null for an id that names none), with what the Workflow held as it was selected (`ArmedOn`). */
  | ({ kind: "recipe"; slot: number | null } & ArmedOn)
  | { kind: "favourite" };

/** DYE2's selection now. Throws if Decaid answers otherwise than with it or 404, or does not answer. */
export async function readSelection(): Promise<SelectionAnswer> {
  const answer = await request("GET", SELECTION);
  if (answer.status === 404) return { kind: "unavailable" };
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (value === undefined) throw new Error(`Decaid answered ${answer.status} reading DYE2's selection`);
  if (!isObject(value) || typeof value.kind !== "string") return { kind: "none" };
  if (value.kind === "recipe") {
    const id = String(value.id);
    return {
      kind: "recipe",
      slot: /^[1-9]\d*$/.test(id) ? Number(id) : null,
      fingerprint: textOf(value.profileFingerprint),
      batch: textOf(value.armedBeanBatchId),
      grinder: textOf(value.armedGrinderId),
    };
  }
  return { kind: "favourite" };
}

/**
 * The name of the recipe or favourite DYE2 has selected now, as Streamline's
 * DYE strip labels it (`recipeLabel` and `favLabel` in
 * streamline-js:src/modules/dyeStrip.js), from DYE2's list of them; null
 * where it has none selected, or answers 404. Throws if Decaid answers
 * otherwise, or does not answer.
 */
export async function readSelectedName(): Promise<string | null> {
  const answer = await request("GET", SELECTION);
  if (answer.status === 404) return null;
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (value === undefined) throw new Error(`Decaid answered ${answer.status} reading DYE2's selection`);
  if (!isObject(value) || (value.kind !== "recipe" && value.kind !== "favourite")) return null;
  const list = await request("GET", `/store/${DYE2_NAMESPACE}/${value.kind === "recipe" ? "recipes" : "autoFavourites"}`);
  const items = list.ok ? parsed(list.text) : undefined;
  const item = Array.isArray(items) ? items.find((candidate: unknown) => isObject(candidate) && String(candidate.id) === String(value.id)) : undefined;
  const named = isObject(item) ? item : {};
  if (value.kind === "recipe") return textOf(named.title) ?? textOf(named.name) ?? "Recipe";
  const snapshot = isObject(named.snapshot) ? named.snapshot : {};
  return textOf(named.title) ?? textOf(named.subtitle) ?? textOf(snapshot.coffeeName) ?? "Favourite";
}

/**
 * Has DYE2 select the recipe in that slot, as its dashboard does as it
 * applies one, or clear its selection (null), as Streamline does as its
 * strip is switched off: "done", or "unavailable" where DYE2 answers 404.
 * Throws if Decaid refuses it, or does not answer.
 */
export async function postSelection(slot: number | null): Promise<"done" | "unavailable"> {
  const answer = await request("POST", SELECTION, slot === null ? {} : { kind: "recipe", id: String(slot) });
  if (answer.status === 404) return "unavailable";
  if (!answer.ok) throw new Error(`Decaid answered ${answer.status} setting DYE2's selection`);
  return "done";
}

/**
 * DYE2 as Decaid's plugins list shows it (`GET /api/v1/plugins`,
 * `plugins_handler.dart`): loaded; not loaded but to load at startup, as
 * while it reloads, updates or fails to load; disabled, neither loaded nor
 * to load (`loaded` and `autoLoad` both false); or absent from the list.
 */
export type Dye2State = "loaded" | "notLoaded" | "disabled" | "absent";

/** DYE2's state now. Throws if Decaid does not answer with its plugins. */
export async function readDye2State(): Promise<Dye2State> {
  const answer = await request("GET", "/plugins");
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (!Array.isArray(value)) throw new Error(`Decaid answered ${answer.status} listing its plugins`);
  const dye2 = value.find((plugin: unknown) => isObject(plugin) && plugin.id === DYE2_NAMESPACE) as Record<string, unknown> | undefined;
  if (!dye2) return "absent";
  if (dye2.loaded === true) return "loaded";
  return dye2.autoLoad === false ? "disabled" : "notLoaded";
}

/** The transports the plugin opens, counted against Decaid's limit per plugin generation with its connections to the server. */
export interface Transports {
  /** Opens one, or rejects where Decaid allows no more, or the open fails. */
  open(url: string): Promise<string>;
  onEvent(handle: string, listener: (event: TransportEvent) => void): void;
  /** Closes one, which counts against the limit until Decaid has closed it. */
  close(handle: string): void;
}

/**
 * DYE2's `changed` socket, kept open while DYE2 is loaded: each push tells
 * `pushed`. Opened again at the next `keepOpen` after it closes, as when
 * DYE2 unloads. A push arriving while it is opening is lost, which the
 * plugin's reads after each Workflow change and on its poll make up for.
 */
export class Dye2Pushes {
  private handle: string | undefined;
  private opening = false;
  private stopped = false;

  constructor(
    private readonly transports: Transports,
    private readonly pushed: () => void,
  ) {}

  /** Opens the socket unless it is open or opening. */
  keepOpen(): void {
    if (this.handle !== undefined || this.opening || this.stopped) return;
    this.opening = true;
    this.transports.open(CHANGED_SOCKET).then(
      (handle) => {
        this.opening = false;
        if (this.stopped) {
          this.transports.close(handle);
          return;
        }
        this.handle = handle;
        this.transports.onEvent(handle, (event) => {
          if (handle !== this.handle) return;
          if (event.type === "data") this.pushed();
          else this.closed(handle);
        });
      },
      () => {
        this.opening = false;
      },
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) this.closed(this.handle);
  }

  private closed(handle: string): void {
    this.handle = undefined;
    this.transports.close(handle);
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
