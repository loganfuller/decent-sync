import { expect } from "vitest";
import type { AdminApi, CreatedMachine } from "./admin-api.js";
import type { SimulatedStreamline } from "./simulated-streamline.js";
import type { InFlightRequest, SimulatedTablet } from "./simulated-tablet.js";

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
 * show nothing left to do between them: two samples in a row pass, with a
 * finished read of `/sensors`, which each of the plugin's polls makes last,
 * on every tablet between them, so a change a poll would find has been
 * read and reported. Each sample checks that the server has acknowledged
 * every frame each plugin sent with an id (heartbeats and `hello` carry
 * none), that no plugin write to Decaid is under way, nor a read that was
 * under way as the sample before it ended, as one held or slowed is, that
 * every DYE2 and Streamline is settled, and that no Machine's sharing status
 * shows anything waiting, the Loaded Recipe's write included. A read begun
 * since passes: at 50x a tablet polls every 100 ms of real time, so on a
 * busy machine one of its polls' reads is nearly always under way, and
 * waiting for none at all could outlast the timeout. One sample of each is not
 * enough: the plugin holds a Workflow report back while its own writes and
 * DYE2's saves run, so DYE2 can be settled before the server's write
 * arrives, and every frame acknowledged while a report is held back.
 *
 * It sees only those checks. A delivery waiting for Decaid's plugin storage
 * to answer (as while `holdStorageAnswers` holds it), one waiting out the
 * plugin's retry after a failed send or read, a frame the server sent that
 * has not yet arrived, and work the plugin began with a read since the
 * sample before, as a save into the Loaded Recipe does, all pass unseen, so
 * don't call it while a test holds storage answers or has just made a send
 * or read fail.
 *
 * Before a check that something does not happen, it shows only that nothing
 * is under way, not that nothing would follow: a timer of the plugin's, or
 * work it cannot see, may bring a change later. Such a site waits on an
 * event of its own, or a span of the tablet's clock, and each site that
 * uses it so is shown to fail with the rule it guards broken (#297).
 * Bounded by expect.poll's timeout, its failure names the check that failed
 * last, and its tablet or Machine.
 */
export async function quiesced(api: AdminApi, { tablets, machines = {}, streamlines = {} }: QuietScope): Promise<void> {
  /** Each tablet's count of `/sensors` reads as the first of the passing samples ended. */
  let first: Map<string, number> | undefined;
  /** Each tablet's requests to Decaid under way as the latest sample that read them ended. */
  const underWay = new Map<string, ReadonlySet<InFlightRequest>>();
  await expect
    .poll(async () => {
      // A sample that throws ends the run of quiet samples, as a failed check does.
      const sampled = await sample(api, tablets, machines, streamlines, underWay).catch((error: unknown) => {
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
  underWay: Map<string, ReadonlySet<InFlightRequest>>,
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
  const requests = new Map(Object.entries(tablets).map(([name, tablet]) => [name, tablet.inFlightRequests]));
  const before = new Map(underWay);
  for (const [name, now] of requests) underWay.set(name, new Set(now));
  for (const [name, tablet] of Object.entries(tablets)) {
    if (!tablet.acknowledgedEvery((frame: { id?: unknown }) => typeof frame.id === "string")) return `tablet ${name} has a frame unacknowledged`;
    const now = requests.get(name)!;
    const writes = now.filter((request) => request.method !== "GET").length;
    if (writes > 0) return `tablet ${name} has ${writes} Decaid writes in flight`;
    const lasting = now.filter((request) => before.get(name)?.has(request)).length;
    if (lasting > 0) return `tablet ${name} has ${lasting} Decaid reads in flight since the sample before`;
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
