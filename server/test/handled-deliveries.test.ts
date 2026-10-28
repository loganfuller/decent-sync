import { MAX_ID_LENGTH } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { HANDLED_DELIVERY_LIMITS, HandledDeliveries } from "../src/sync/handled-deliveries.js";

// A connection's record of the deliveries it handled, through its own
// interface. The gateway's use of it is tested through Seam 1 in
// replayed-deliveries.test.ts.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const requestShots = (shotIds: string[]) => ({ type: "requestShots" as const, shotIds });

describe("HandledDeliveries", () => {
  it("remembers each delivery handled, with the request an index was answered with", () => {
    const handled = new HandledDeliveries();
    const request = requestShots([uuid(1), uuid(2)]);
    handled.add("shot-delivery", null);
    handled.add("shot-index", request);
    handled.add("steam-index", { type: "requestSteams", steamIds: [] });

    expect(handled.has("shot-delivery")).toBe(true);
    expect(handled.get("shot-delivery")).toBeNull();
    expect(handled.get("shot-index")).toEqual(request);
    expect(handled.get("steam-index")).toEqual({ type: "requestSteams", steamIds: [] });
    expect(handled.has("never-sent")).toBe(false);
    expect(handled.get("never-sent")).toBeUndefined();
  });

  it("forgets the oldest delivery once it holds as many as it may", () => {
    const handled = new HandledDeliveries();
    const max = HANDLED_DELIVERY_LIMITS.maxDeliveries;
    for (let n = 0; n < max * 3; n++) handled.add(`delivery-${n}`, null);

    for (let n = 0; n < max * 2; n++) expect(handled.has(`delivery-${n}`)).toBe(false);
    for (let n = max * 2; n < max * 3; n++) expect(handled.has(`delivery-${n}`)).toBe(true);
  });

  it("holds as many answered index pages of Decaid's ids as deliveries, with the longest ids the protocol allows", () => {
    const handled = new HandledDeliveries();
    const max = HANDLED_DELIVERY_LIMITS.maxDeliveries;
    const page = (n: number) => requestShots(Array.from({ length: 100 }, (_, entry) => uuid(n * 100 + entry)));
    const id = (n: number) => String(n).padStart(MAX_ID_LENGTH, "0");
    for (let n = 0; n < max; n++) handled.add(id(n), page(n));
    for (let n = 0; n < max; n++) expect(handled.get(id(n))).toEqual(page(n));
  });

  it("forgets the oldest deliveries until the ids it holds, those of requests included, are within its length", () => {
    const handled = new HandledDeliveries({ maxDeliveries: 10, maxLength: 100 });
    handled.add("a", requestShots(["x".repeat(40)]));
    handled.add("b", requestShots(["y".repeat(40)]));
    handled.add("c", null);
    // 41 + 41 + 1 held; 20 more takes it past 100.
    handled.add("d", requestShots(["z".repeat(19)]));

    expect(handled.has("a")).toBe(false);
    expect(handled.get("b")).toEqual(requestShots(["y".repeat(40)]));
    expect(handled.get("c")).toBeNull();
    expect(handled.get("d")).toEqual(requestShots(["z".repeat(19)]));
  });

  it("does not remember a delivery longer than it may hold at all, and keeps the others", () => {
    const handled = new HandledDeliveries({ maxDeliveries: 10, maxLength: 100 });
    handled.add("a", null);
    handled.add("huge", requestShots(["x".repeat(100)]));

    expect(handled.has("huge")).toBe(false);
    expect(handled.has("a")).toBe(true);
  });

  it("counts a delivery added again once, as the newest", () => {
    const handled = new HandledDeliveries({ maxDeliveries: 2, maxLength: 100 });
    handled.add("a", null);
    handled.add("b", null);
    handled.add("a", requestShots(["x"]));
    handled.add("c", null);

    expect(handled.has("b")).toBe(false);
    expect(handled.get("a")).toEqual(requestShots(["x"]));
    expect(handled.has("c")).toBe(true);
  });
});
