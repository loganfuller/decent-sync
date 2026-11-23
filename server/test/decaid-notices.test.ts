import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NotificationCenter } from "./support/decaid-notices.js";

// The simulated tablet's notification center (support/decaid-notices.ts) against what Decaid v0.9.3 was recorded
// doing (fixtures/decaid/notices-v0.9.3): each recorded call is made of it in order, and it must answer as Decaid did
// and hold what Decaid saved after each step. A step of requests to Decaid's API stands for what the center was
// told by them: saving the probe's settings reloaded it, disabling it removed its notices, and Decaid started again
// between the two files.

const PROBE = "notice-probe.reaplugin";
const PROBE_NAME = "Notice probe";

type Call = { op: "notify"; notice: unknown } | { op: "dismiss"; id?: string };
interface Step {
  calls?: Call[];
  answer?: { status: number; body: { calls: unknown[]; events: { name: string; payload: Record<string, unknown> }[] } };
  exchanges?: { request: { method: string; path: string } }[];
  center: { key: string | null; value?: { version: number; notices: ({ namespace: string } & Record<string, unknown>)[] } };
}

const recording = (file: string) =>
  Object.entries(JSON.parse(readFileSync(new URL(`./fixtures/decaid/notices-v0.9.3/${file}`, import.meta.url), "utf8")) as Record<string, Step>);

function replay(center: NotificationCenter, name: string, step: Step): void {
  if (step.calls) {
    const results = step.answer!.body.events.filter((event) => event.name === "notificationResult").map((event) => event.payload);
    let next = 0;
    for (const call of step.calls) {
      if (call.op === "dismiss") {
        center.dismiss(PROBE, call.id);
        continue;
      }
      const { requestId: _requestId, ...recorded } = results[next++]!;
      expect(center.publish(PROBE, PROBE_NAME, call.notice), `${name}: ${JSON.stringify(call.notice).slice(0, 80)}`).toEqual(recorded);
    }
    expect(next, `${name}: a result for each notice asked for`).toBe(results.length);
  }
  for (const exchange of step.exchanges ?? []) {
    if (exchange.request.path.endsWith("/disable")) center.removeSource(PROBE);
  }
  const saved = (step.center.value?.notices ?? []).map(({ namespace, ...notice }) => {
    expect(namespace).toBe("plugin");
    return notice;
  });
  expect(center.shown(), `${name}: what the center holds`).toEqual(saved);
}

describe("The simulated tablet's notification center", () => {
  it("answers each notice as Decaid v0.9.3 did, and holds what it saved, across a reload, a disable and a restart", () => {
    const center = new NotificationCenter();
    for (const [name, step] of recording("notices.json")) replay(center, name, step);
    center.restarted();
    for (const [name, step] of recording("restarted.json")) replay(center, name, step);
  });

  it("refuses a notice with `storage` while its saves fail, changing nothing", () => {
    const center = new NotificationCenter();
    expect(center.publish(PROBE, PROBE_NAME, { id: "sync", message: "Held." })).toEqual({ id: "sync", status: "accepted" });
    center.failNextSaves(1);
    expect(center.publish(PROBE, PROBE_NAME, { id: "sync", message: "Changed." })).toEqual({ id: "sync", status: "rejected", reason: "storage" });
    expect(center.shown(PROBE)).toMatchObject([{ id: "sync", message: "Held.", revision: 1 }]);
    expect(center.publish(PROBE, PROBE_NAME, { id: "sync", message: "Changed." })).toEqual({ id: "sync", status: "accepted" });
  });
});
