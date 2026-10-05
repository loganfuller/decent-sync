import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { type Fingerprint, type Reading, contentHash, decide, ifNoneMatch, pairedDevices } from "../src/change-detection.js";

// Module tests for the plugin's change detection, with collections Decaid
// v0.8.7 sent (server/test/fixtures/decaid/), or derived from them by the
// named changes.

function fixture(path: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../../server/test/fixtures/decaid/${path}`, import.meta.url), "utf8"));
}

const value = (value: unknown, etag: string | null = null): Reading => ({ kind: "value", value, etag });
const unavailable: Reading = { kind: "unavailable" };
const notModified: Reading = { kind: "notModified" };

/** The fingerprint after reading these in turn, and whether each was sent. */
function readInTurn(readings: Reading[], full = false): { sent: boolean[]; last: Fingerprint | undefined } {
  let last: Fingerprint | undefined;
  const sent = readings.map((reading) => {
    const decision = decide(last, reading, full);
    last = decision.next;
    return decision.send;
  });
  return { sent, last };
}

describe("collections compared by content", () => {
  const settings = fixture("de1pro-v0.8.7/machine-settings.json") as Record<string, unknown>;

  it("sends a collection the first time, then only when its content changes", () => {
    const recalibrated = { ...settings, steamFlow: 1.5 };
    expect(readInTurn([value(settings), value(settings), value({ ...settings }), value(recalibrated), value(recalibrated)]).sent).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it("sends every reading on a full read, as on every welcome, changed or not", () => {
    expect(readInTurn([value(settings), value(settings)], true).sent).toEqual([true, true]);
  });

  it("sends that a collection became unavailable once, and its value again once it is back, even unchanged", () => {
    // The machine is switched off, then on again.
    expect(readInTurn([value(settings), unavailable, unavailable, value(settings), value(settings)]).sent).toEqual([true, true, false, true, false]);
  });

  it("sends a collection unavailable from the start, such as a DYE2 key never written", () => {
    expect(readInTurn([unavailable, unavailable]).sent).toEqual([true, false]);
    expect(readInTurn([unavailable, unavailable], true).sent).toEqual([true, true]);
  });

  it("tells contents apart, including their order and their lengths, and sends no If-None-Match for them", () => {
    const recipes = JSON.stringify(fixture("de1pro-v0.8.7/dye2-recipes.json"));
    expect(contentHash(recipes)).toBe(contentHash(`${recipes}`));
    expect(contentHash(recipes)).not.toBe(contentHash(recipes.replace("Sep 26th Eth", "Sep 27th Eth")));
    expect(contentHash('{"a":1,"b":2}')).not.toBe(contentHash('{"b":2,"a":1}'));
    expect(contentHash("")).not.toBe(contentHash("\u0000"));
    expect(ifNoneMatch(readInTurn([value(settings)]).last)).toBeNull();
  });
});

describe("collections Decaid sends ETags for", () => {
  const beans = fixture("de1pro-v0.8.7/beans.json");

  it("sends the last ETag as If-None-Match, sends nothing on a 304, and sends a new ETag's value", () => {
    const first = decide(undefined, value(beans, '"38116c6bafbf1509"'), false);
    expect(first.send).toBe(true);
    expect(ifNoneMatch(first.next)).toBe('"38116c6bafbf1509"');

    const unchanged = decide(first.next, notModified, false);
    expect(unchanged).toEqual({ send: false, next: first.next });

    const edited = decide(unchanged.next, value(beans, '"0f3a5d0c6e1b2a49"'), false);
    expect(edited.send).toBe(true);
    expect(ifNoneMatch(edited.next)).toBe('"0f3a5d0c6e1b2a49"');
  });

  it("compares by ETag alone, and sends a full read whatever its ETag", () => {
    const first = decide(undefined, value(beans, '"38116c6bafbf1509"'), false);
    expect(decide(first.next, value(beans, '"38116c6bafbf1509"'), false).send).toBe(false);
    expect(decide(first.next, value(beans, '"38116c6bafbf1509"'), true).send).toBe(true);
  });

  it("sends no If-None-Match while unavailable, so a collection back from failing reads arrives whole", () => {
    const first = decide(undefined, value(beans, '"38116c6bafbf1509"'), false);
    const failed = decide(first.next, unavailable, false);
    expect(failed.send).toBe(true);
    expect(ifNoneMatch(failed.next)).toBeNull();
    expect(decide(failed.next, value(beans, '"38116c6bafbf1509"'), false).send).toBe(true);
  });
});

describe("paired devices", () => {
  const simulated = fixture("simulated-devices-v0.8.7/devices.json") as { id: string; state: string }[];

  it("keeps connected and remembered devices, as sent, and leaves out those only discovered nearby", () => {
    const paired = pairedDevices(simulated) as { id: string }[];
    expect(paired.map((device) => device.id)).toEqual(["MockScale", "MockDe1", "mockDebugPort", "mockSensorBasket"]);
    expect(paired[0]).toEqual(simulated[0]);
    // The test tablet's scale is off: Decaid remembers it as disconnected and not available.
    const tablet = fixture("de1pro-v0.8.7/devices.json");
    expect(pairedDevices(tablet)).toEqual(tablet);
    expect(pairedDevices(fixture("simulated-devices-v0.8.7/devices-disconnected.json"))).toHaveLength(4);
  });

  it("is not changed by devices coming into range or leaving it", () => {
    const withoutBengle = simulated.filter((device) => device.id !== "MockBengle");
    // Derived: the same inventory with another nearby machine discovered, and one with none.
    const anotherNearby = [...simulated, { ...simulated.find((device) => device.id === "MockBengle")!, id: "MockBengle2", name: "MockBengle2" }];
    const readings = [simulated, withoutBengle, anotherNearby].map((inventory) => value(pairedDevices(inventory)));
    expect(readInTurn(readings).sent).toEqual([true, false, false]);
  });

  it("changes when a paired device connects or disconnects", () => {
    const readings = [simulated, fixture("simulated-devices-v0.8.7/devices-disconnected.json")].map((inventory) => value(pairedDevices(inventory)));
    expect(readInTurn(readings).sent).toEqual([true, true]);
  });

  it("is nothing to report unless Decaid answers with a list", () => {
    for (const inventory of [null, {}, "devices"]) expect(pairedDevices(inventory)).toBeNull();
    expect(pairedDevices([])).toEqual([]);
  });
});
