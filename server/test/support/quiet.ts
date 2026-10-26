import { isDeepStrictEqual } from "node:util";
import { CHUNK_LIMITS, type Chunk, Reassembly } from "@decent-sync/protocol";
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
 * read and reported, and with every read the plugin had under way as the
 * first of them ended finished, as one held or slowed is not.
 *
 * Each sample checks that every DYE2 and Streamline is settled, that no
 * Machine's sharing status shows anything waiting, the Loaded Recipe's write
 * included, and on each tablet that the server has acknowledged every frame
 * the plugin sent with an id (heartbeats and `hello` carry none), that no
 * plugin write to Decaid is under way, nor a read of the Workflow, which the
 * plugin makes only to write into it or to save it into the Loaded Recipe,
 * and that the plugin's latest Workflow delivery holds the tablet's
 * Workflow as it is now, as one held back while the plugin writes or saves
 * does not. Other reads begun since the first sample pass: at 50x a tablet
 * polls every 100 ms of real time, so on a busy machine one of its polls'
 * reads is nearly always under way, and waiting for none could outlast the
 * timeout. One sample is not enough: DYE2 can be settled before the
 * server's write arrives, and every frame acknowledged before the next is
 * sent.
 *
 * It sees only those checks. A delivery waiting for Decaid's plugin storage
 * to answer (as while `holdStorageAnswers` holds it), one waiting out the
 * plugin's retry after a failed send or read, a frame the server sent that
 * has not yet arrived, and a change a read begun since the first sample
 * finds all pass unseen, so don't call it while a test holds storage
 * answers or has just made a send or read fail.
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
  /** Each tablet's count of `/sensors` reads, and its reads under way, as the first of the passing samples ended. */
  let first: Map<string, Sampled> | undefined;
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
      const unread = Object.keys(tablets).filter((name) => sampled.get(name)!.sensors <= first!.get(name)!.sensors);
      if (unread.length > 0) return `quiet, but no /sensors read finished since the first quiet sample on tablet ${unread.join(", ")}`;
      const reading = Object.keys(tablets).filter((name) => sampled.get(name)!.reads.some((read) => first!.get(name)!.reads.includes(read)));
      return reading.length === 0 ? QUIET : `quiet, but a read under way at the first quiet sample is still under way on tablet ${reading.join(", ")}`;
    })
    .toBe(QUIET);
}

/** What a passing sample found on a tablet: its count of `/sensors` reads, and its reads to Decaid under way, as the sample ended. */
interface Sampled {
  sensors: number;
  reads: readonly InFlightRequest[];
}

/** One sample: what failed, or, if every check passed, what it found on each tablet. */
async function sample(
  api: AdminApi,
  tablets: Record<string, SimulatedTablet>,
  machines: Record<string, CreatedMachine>,
  streamlines: Record<string, SimulatedStreamline>,
): Promise<string | Map<string, Sampled>> {
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
  // Read together, with no await between them, so what each returns marks the end of this sample.
  const found = new Map<string, Sampled>();
  for (const [name, tablet] of Object.entries(tablets)) {
    if (!tablet.acknowledgedEvery((frame: { id?: unknown }) => typeof frame.id === "string")) return `tablet ${name} has a frame unacknowledged`;
    const requests = tablet.inFlightRequests;
    const writes = requests.filter((request) => request.method !== "GET").length;
    if (writes > 0) return `tablet ${name} has ${writes} Decaid writes in flight`;
    if (requests.some((request) => request.route === "/workflow")) return `tablet ${name} has a read of the Workflow in flight`;
    if (!holdsWorkflow(tablet)) return `tablet ${name}'s Workflow is not the one its plugin last delivered`;
    found.set(name, { sensors: tablet.requests.filter((route) => route === "/sensors").length, reads: requests });
  }
  return found;
}

/** Whether the plugin's latest Workflow delivery holds the tablet's Workflow as it is now, as it does where the tablet has none. */
function holdsWorkflow(tablet: SimulatedTablet): boolean {
  const now = tablet.workflow();
  if (now === undefined) return true;
  const delivered = latestWorkflowDelivery(tablet);
  return delivered !== undefined && isDeepStrictEqual(delivered, now);
}

/** The Workflow of the plugin's latest Workflow delivery, a message sent in chunks put back together, or undefined for none. */
function latestWorkflowDelivery(tablet: SimulatedTablet): unknown {
  const chunks = new Reassembly();
  let latest: unknown;
  for (const frame of tablet.sent as { type?: unknown; workflow?: unknown }[]) {
    let message: { type?: unknown; workflow?: unknown } | undefined = frame;
    if (frame.type === "chunk") {
      const added = chunks.add(frame as unknown as Chunk, CHUNK_LIMITS);
      message = added.status === "complete" ? (JSON.parse(added.text) as typeof message) : undefined;
    }
    if (message?.type === "workflow") latest = message.workflow;
  }
  return latest;
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
