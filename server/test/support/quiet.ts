import { expect } from "vitest";
import type { AdminApi, CreatedMachine } from "./admin-api.js";
import type { SimulatedStreamline } from "./simulated-streamline.js";
import type { SimulatedTablet } from "./simulated-tablet.js";

/** What `quiesced` waits on, each by the name a failure gives it, such as `{ a, c }`. */
export interface QuietScope {
  /** The tablets, and the DYE2 each runs. Each must poll: one with a long `pollSeconds` reads no sensors, and never passes. */
  tablets: Record<string, SimulatedTablet>;
  /** The Machines whose sharing status must show nothing waiting. */
  machines?: Record<string, CreatedMachine>;
  /** The Streamlines running on the tablets, which the tablets do not keep track of. */
  streamlines?: Record<string, SimulatedStreamline>;
}

const QUIET = "quiet";

/**
 * Resolves once the tablets, their DYE2s, the Streamlines and the server
 * have nothing left to do between them: two samples in a row pass, with a
 * finished read of `/sensors`, which each of the plugin's polls makes last,
 * on every tablet between them, so a change a poll would find has been
 * read and reported. Each sample checks that the server has acknowledged
 * every frame each plugin sent with an id (heartbeats and `hello` carry
 * none), that no plugin request to Decaid is under way, that every DYE2 and
 * Streamline is settled, and that no Machine's sharing status shows anything
 * waiting, the Loaded Recipe's write included. One sample of each is not
 * enough: the plugin holds a Workflow report back while its own writes and
 * DYE2's saves run, so DYE2 can be settled before the server's write
 * arrives, and every frame acknowledged while a report is held back.
 *
 * It is for setup and for ordering steps, not in place of a settle before a
 * check that something does not happen: it shows that nothing is under way,
 * not that nothing would follow. Bounded by expect.poll's timeout, its
 * failure names the check that failed last, and its tablet or Machine.
 */
export async function quiesced(api: AdminApi, { tablets, machines = {}, streamlines = {} }: QuietScope): Promise<void> {
  /** Each tablet's count of `/sensors` reads as the first of the passing samples ended. */
  let first: Map<string, number> | undefined;
  await expect
    .poll(async () => {
      // A sample that throws ends the run of quiet samples, as a failed check does.
      const sampled = await sample(api, tablets, machines, streamlines).catch((error: unknown) => {
        first = undefined;
        throw error;
      });
      if (typeof sampled === "string") {
        first = undefined;
        return sampled;
      }
      if (!first) {
        first = sampled;
        return "quiet once, waiting for a /sensors read on every tablet";
      }
      const unread = Object.keys(tablets).filter((name) => sampled.get(name)! <= first!.get(name)!);
      return unread.length === 0 ? QUIET : `quiet, but no /sensors read finished since the first quiet sample on tablet ${unread.join(", ")}`;
    })
    .toBe(QUIET);
}

/** One sample: what failed, or, if every check passed, each tablet's count of `/sensors` reads as it ended. */
async function sample(
  api: AdminApi,
  tablets: Record<string, SimulatedTablet>,
  machines: Record<string, CreatedMachine>,
  streamlines: Record<string, SimulatedStreamline>,
): Promise<string | Map<string, number>> {
  for (const [name, tablet] of Object.entries(tablets)) {
    if (tablet.dye2 && !(await settledNow(tablet.dye2))) return `DYE2 on tablet ${name} is not settled`;
  }
  for (const [name, streamline] of Object.entries(streamlines)) {
    if (!(await settledNow(streamline))) return `Streamline ${name} is not settled`;
  }
  for (const [name, { machine }] of Object.entries(machines)) {
    let waiting: number | null;
    try {
      ({ waiting } = (await api.get<{ status: { waiting: number | null } }>(`/machines/${machine.id}/sharing-status`)).status);
    } catch (error) {
      return `Machine ${name}'s sharing status could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (waiting !== null && waiting !== 0) return `Machine ${name} has ${waiting} waiting`;
  }
  // Read together, with no await between them, so the counts mark the end of this sample.
  for (const [name, tablet] of Object.entries(tablets)) {
    if (!tablet.acknowledgedEvery((frame: { id?: unknown }) => typeof frame.id === "string")) return `tablet ${name} has a frame unacknowledged`;
    if (tablet.requestsInFlight > 0) return `tablet ${name} has ${tablet.requestsInFlight} Decaid requests in flight`;
  }
  return new Map(Object.entries(tablets).map(([name, tablet]) => [name, tablet.requests.filter((route) => route === "/sensors").length]));
}

/** Whether its `settled()` resolves before anything else is due to run, rather than waiting for what it is still doing. */
async function settledNow(app: { settled(): Promise<void> }): Promise<boolean> {
  let settled = false;
  const settling = app.settled().then(() => {
    settled = true;
  });
  await Promise.race([settling, new Promise((resolve) => setTimeout(resolve, 0))]);
  return settled;
}
