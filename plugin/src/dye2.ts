import { DYE2_NAMESPACE } from "@decent-sync/protocol";
import { request } from "./decaid.js";
import type { TransportEvent } from "./host.js";

// DYE2 on the tablet (ADR-0022). The recipe a Machine is dialled in to is the
// one its Workflow names (DYE2_RECIPE_FIELD), which DYE2's dashboard, its
// Select Recipe page and Streamline's DYE strip set as they apply one, and
// DYE2 clears on a change of profile (`workflowChanged` in
// dye2:dye2-plugin/src/plugin.ts at v0.1.26). DYE2 stores no selection of its
// own, and writes a change of the Workflow into that recipe only when asked
// (`record`), as Streamline's Save changes does. This module is how the
// plugin asks it to, tells whether DYE2 is there at all, and hears DYE2's
// pushes.

/** DYE2's WebSocket endpoint, on which it pushes `{"what":"workflow"}` as the recipe the Workflow names changes, after it records into one, and after it refreshes its recent favourites. */
export const CHANGED_SOCKET = `ws://localhost:8080/ws/v1/plugins/${DYE2_NAMESPACE}/changed`;

/** DYE2's route writing the Workflow's changes into the recipe it names (`handleRecord` in dye2:dye2-plugin/src/plugin.ts at v0.1.26). */
const RECORD = `/plugins/${DYE2_NAMESPACE}/record`;

/**
 * Has DYE2 write into the recipe the Workflow names each value of it the
 * Workflow holds otherwise (`recordWorkflow` in
 * dye2:dye2-plugin/src/utils/workflow-record.ts at v0.1.26), as Streamline's
 * Save changes does: "saved" where it wrote, "unchanged" where it had
 * nothing to write or no recipe to write into, and "unavailable" where DYE2
 * answers 404, as while it is not loaded. Throws if Decaid answers otherwise,
 * as when DYE2 fails to write, or does not answer.
 */
export async function recordIntoRecipe(): Promise<"saved" | "unchanged" | "unavailable"> {
  const answer = await request("POST", RECORD, {});
  if (answer.status === 404) return "unavailable";
  const value = answer.ok ? parsed(answer.text) : undefined;
  if (!isObject(value)) throw new Error(`Decaid answered ${answer.status} asking DYE2 to save into its recipe: ${answer.text.slice(0, 200)}`);
  return value.saved === true ? "saved" : "unchanged";
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
 * plugin's poll of the tablet's lists makes up for.
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
