import { type Locator, type Page, expect } from "@playwright/test";
import { type LiveFixtureFrame, openingFrames } from "../../server/test/support/live-fixtures.js";
import { syncingTablet } from "../../server/test/support/loaded-tablets.js";
import { derivedShot, shotFixture } from "../../server/test/support/shot-fixtures.js";
import { type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "../../server/test/support/simulated-tablet.js";

// What the specs of the Live View's curves (e2e/live-curves-*.spec.ts) share.
// They are three files rather than one, as a spec file runs its tests in turn
// on one worker, and together they take over two minutes. Their simulated
// tablets run the built plugin and replay recorded streams SPEED times as fast
// as recorded.

export const SPEED = 5;

/** connectedTablet() on the spec's server. */
export function connectedTabletOn(server: { url(): string }): (token: string, serial: string, api?: DecaidApi) => Promise<SimulatedTablet> {
  /** A Machine's tablet, connected, its scale on, polling every 5 s of its time, which runs 50 times faster here. */
  return async function connectedTablet(token: string, serial: string, api: DecaidApi = derivedDe1Pro({ serial })): Promise<SimulatedTablet> {
    const tablet = syncingTablet({ token }, { url: server.url() }, { api, sockets: { ...openingFrames(), scale: "connected" } });
    await tablet.waitForLog(/^Connected to /);
    return tablet;
  };
}

/** The Machine's page, once its tablet streams to it. */
export async function openMachinePage(page: Page, machineId: string, tablet: SimulatedTablet): Promise<Locator> {
  await page.goto(`/machines/${machineId}`);
  await expect.poll(() => tablet.delivered).toContainEqual({ type: "liveStart" });
  return page.getByRole("region", { name: "Live View" });
}

/** The index of a recording's first machine snapshot in that state and substate, and at a target flow above 0, or of 0, where `flowing` says. */
export function first(frames: LiveFixtureFrame[], state: string, substate: string, flowing?: boolean): number {
  const index = frames.findIndex(({ source, frame }) => {
    const reported = frame.state as { state: string; substate: string } | undefined;
    if (source !== "machine" || reported?.state !== state || reported.substate !== substate) return false;
    return flowing === undefined || (frame.targetFlow as number) > 0 === flowing;
  });
  if (index < 0) throw new Error(`No snapshot in ${state}, ${substate}`);
  return index;
}

/** The times a chart's axis is marked at, as it shows them, such as "10 s". */
export function ticks(curves: Locator, chart: string): Locator {
  return curves.getByRole("figure", { name: chart, exact: true }).locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value");
}

/** A Shot the Machine's tablet stores, pulled at a UTC time, recording the Machine's hardware so it is credited to it. */
export function shotOf(id: string, serial: string, pulledAt: Date): Record<string, unknown> {
  const workflow = shotFixture().workflow as Record<string, Record<string, unknown>>;
  return derivedShot(id, { timestamp: pulledAt.toISOString(), workflow: { ...workflow, machine: { ...workflow.machine, model: "DE1Pro", serialNumber: serial } } });
}
