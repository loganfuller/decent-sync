import { describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  COLLECTION_NAMES,
  type ErrorMessage,
  type Hello,
  PROTOCOL_VERSION,
  decodePluginMessage,
  decodeServerMessage,
  encode,
  isCollectionName,
} from "@decent-sync/protocol";

const token = "8cTqXr0b2m6Yw1zH4kLpQeNvSa7uJdFg9oIiBhC3E5s";

const hello: Hello = {
  type: "hello",
  protocolVersion: 1,
  token,
  pluginVersion: "0.1.0",
  decaidVersion: "0.8.7+2847",
  connectionId: "00:00:5E:00:53:01",
  machine: { model: "DE1Pro", serial: "10001", firmware: "1333" },
};

const frame = (value: unknown) => JSON.stringify(value);

describe("protocol", () => {
  it("starts at protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("gives each error its own close code in the range for applications", () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBeGreaterThanOrEqual(4000);
  });
});

describe("decodePluginMessage", () => {
  it("reads a hello and a heartbeat", () => {
    expect(decodePluginMessage(encode(hello))).toEqual({ ok: true, message: hello });
    expect(decodePluginMessage(encode({ type: "heartbeat" }))).toEqual({ ok: true, message: { type: "heartbeat" } });
  });

  it("accepts a hello without hardware or connection id", () => {
    const bare = { type: "hello", protocolVersion: 1, token, pluginVersion: "0.1.0", decaidVersion: "0.8.7+2847" };
    expect(decodePluginMessage(frame(bare))).toEqual({ ok: true, message: bare });
    for (const missing of [{ machine: null }, { connectionId: null }]) {
      expect(decodePluginMessage(frame({ ...bare, ...missing })).ok).toBe(true);
    }
  });

  it("accepts fields it does not know, at every level, and keeps them", () => {
    const extended = {
      ...hello,
      bootId: "abc",
      machine: { ...hello.machine, GHC: true, extra: { refillKit: false } },
    };
    expect(decodePluginMessage(frame(extended))).toEqual({ ok: true, message: extended });
    expect(decodePluginMessage(frame({ type: "heartbeat", outbox: 3 })).ok).toBe(true);
  });

  it("refuses a hello with missing or mistyped fields, naming each one", () => {
    const result = decodePluginMessage(
      frame({ type: "hello", protocolVersion: 1, token: "", pluginVersion: 1, connectionId: 7, machine: { model: "DE1" } }),
    );
    expect(result).toEqual({
      ok: false,
      error: "protocol_error",
      problem:
        "hello.token must not be empty; hello.pluginVersion must be a string; hello.decaidVersion must be a string; hello.connectionId must be a string or null; hello.machine.serial must be a string",
    });
    expect(decodePluginMessage(frame({ ...hello, token: undefined }))).toMatchObject({ problem: "hello.token must be a string" });
    expect(decodePluginMessage(frame({ ...hello, decaidVersion: null }))).toMatchObject({ problem: "hello.decaidVersion must be a string" });
    expect(decodePluginMessage(frame({ ...hello, decaidVersion: "" }))).toMatchObject({ problem: "hello.decaidVersion must not be empty" });
    expect(decodePluginMessage(frame({ ...hello, machine: "DE1Pro" }))).toMatchObject({
      problem: "hello.machine must be an object or null",
    });
  });

  it("never repeats a field's value in a problem", () => {
    for (const bad of [
      { ...hello, pluginVersion: { token } },
      { ...hello, protocolVersion: token },
      { ...hello, machine: { model: token, serial: [token] } },
      { ...hello, type: token },
    ]) {
      const result = decodePluginMessage(frame(bad));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it("tells a plugin older than the server supports that it is too old", () => {
    for (const protocolVersion of [0, -1]) {
      // An older hello need not have today's fields.
      const result = decodePluginMessage(frame({ type: "hello", protocolVersion, key: token }));
      expect(result).toEqual({ ok: false, error: "plugin_too_old", problem: expect.stringContaining("update the plugin") });
    }
  });

  it("keeps the token of a hello refused for its version, so the server can tell its Machine why", () => {
    const old = decodePluginMessage(frame({ type: "hello", protocolVersion: 0, token }));
    expect(old).toMatchObject({ ok: false, error: "plugin_too_old", token });
    const newer = decodePluginMessage(frame({ ...hello, protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(newer).toMatchObject({ ok: false, error: "protocol_error", token });
    // Only the token: the problem never repeats it.
    expect(old.ok || old.problem).not.toContain(token);
    for (const notAToken of [7, "", { token }]) {
      expect(decodePluginMessage(frame({ type: "hello", protocolVersion: 0, token: notAToken }))).not.toHaveProperty("token");
    }
  });

  it("accepts Decaid 0.8.7 and later releases, and pre-releases of later ones", () => {
    for (const decaidVersion of ["0.8.7+2847", "0.8.7", "0.8.8-beta.1+2849", "0.8.10+2900", "0.9.0+3000", "1.0.0-rc.1+4000"]) {
      expect(decodePluginMessage(frame({ ...hello, decaidVersion }))).toEqual({ ok: true, message: { ...hello, decaidVersion } });
    }
  });

  it("tells a tablet on an older Decaid to update it, keeping the token so its Machine can say why", () => {
    const refusals: [string, string][] = [
      ["0.8.6+2801", "This tablet runs Decaid 0.8.6"],
      ["0.7.12+2000", "This tablet runs Decaid 0.7.12"],
      ["0.8.7-beta.2+2840", "This tablet runs a pre-release of Decaid 0.8.7"],
      // Decaid built without its tags.
      ["0.0.0-dev+0", "This tablet runs a pre-release of Decaid 0.0.0"],
      ["v0.8.7+2847", "This tablet's Decaid reports no release version"],
      ["unknown", "This tablet's Decaid reports no release version"],
    ];
    for (const [decaidVersion, runs] of refusals) {
      expect(decodePluginMessage(frame({ ...hello, decaidVersion }))).toEqual({
        ok: false,
        error: "decaid_too_old",
        problem: `${runs}, but this server needs 0.8.7 or newer: update Decaid`,
        token,
      });
    }
    // Only the release numbers are repeated.
    for (const decaidVersion of [token, `0.8.6-${token}`, `0.8.6+${token}`]) {
      const result = decodePluginMessage(frame({ ...hello, decaidVersion }));
      expect(result).toMatchObject({ ok: false, error: "decaid_too_old" });
      expect(result.ok || result.problem).not.toContain(token);
    }
  });

  it("refuses a protocol version that is newer than the server's, or not a version", () => {
    expect(decodePluginMessage(frame({ ...hello, protocolVersion: 2 }))).toMatchObject({
      ok: false,
      error: "protocol_error",
      problem: expect.stringContaining("update the server"),
    });
    for (const protocolVersion of [undefined, "1", 1.5]) {
      expect(decodePluginMessage(frame({ ...hello, protocolVersion }))).toEqual({
        ok: false,
        error: "protocol_error",
        problem: "hello.protocolVersion must be a whole number",
      });
    }
  });

  it("refuses frames that are not message objects, and unknown types", () => {
    expect(decodePluginMessage("{not json")).toMatchObject({ ok: false, problem: "The frame is not JSON" });
    for (const value of [null, 1, "hello", [hello]]) {
      expect(decodePluginMessage(frame(value))).toMatchObject({ ok: false, problem: "A message must be a JSON object" });
    }
    expect(decodePluginMessage(frame({ token }))).toMatchObject({ ok: false, problem: "A message must have a string type" });
    expect(decodePluginMessage(frame({ type: "welcome", protocolVersion: 1, heartbeatIntervalMs: 1 }))).toMatchObject({
      ok: false,
      error: "protocol_error",
      problem: "Unknown message type",
    });
  });
});

describe("decodeServerMessage", () => {
  it("reads a welcome, a heartbeat and an error, accepting fields it does not know", () => {
    const welcome = { type: "welcome", protocolVersion: 1, heartbeatIntervalMs: 30_000, machineName: "Uptown left" };
    expect(decodeServerMessage(frame(welcome))).toEqual({ ok: true, message: welcome });
    expect(decodeServerMessage(encode({ type: "heartbeat" }))).toEqual({ ok: true, message: { type: "heartbeat" } });
    const error: ErrorMessage = { type: "error", code: "bad_token", message: "No Machine has this token" };
    expect(decodeServerMessage(encode(error))).toEqual({ ok: true, message: error });
  });

  it("refuses a welcome without a usable heartbeat interval", () => {
    for (const heartbeatIntervalMs of [undefined, 0, "30000"]) {
      expect(decodeServerMessage(frame({ type: "welcome", protocolVersion: 1, heartbeatIntervalMs })).ok).toBe(false);
    }
  });

  it("refuses messages only the plugin sends", () => {
    expect(decodeServerMessage(encode(hello))).toMatchObject({ ok: false, problem: "Unknown message type" });
  });
});

describe("Shot envelopes", () => {
  it("validates delivery without validating Decaid's record contents", () => {
    for (const type of ["shot", "shotUpdated"]) {
      const message = { type, id: "delivery-1", shotId: "shot-1", shot: { unfamiliar: true }, futureField: {} };
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
      expect(decodePluginMessage(frame({ ...message, id: "" })).ok).toBe(false);
      expect(decodePluginMessage(frame({ ...message, shot: [] })).ok).toBe(false);
    }
  });

  it("accepts bounded indices with edit times or ids only, and validates control messages", () => {
    for (const shots of [[{ id: "1", updatedAt: "2026-10-04T12:00:00Z" }], [{ id: "1" }], []]) {
      const message = { type: "shotIndex", id: "index-1", shots };
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodePluginMessage(frame({ type: "shotIndex", id: "index", shots: Array.from({ length: 101 }, () => ({ id: "1" })) })).ok).toBe(false);
    expect(decodePluginMessage(frame({ type: "shotIndex", id: "index", shots: [{ updatedAt: 42 }] })).ok).toBe(false);
    expect(decodePluginMessage(frame({ type: "shotIndex", id: "index", shots: [{ id: "1", updatedAt: null }] })).ok).toBe(false);
    for (const message of [{ type: "ack", id: "1" }, { type: "requestShots", shotIds: ["1", "2"] }]) {
      expect(decodeServerMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodeServerMessage(frame({ type: "ack" })).ok).toBe(false);
    expect(decodeServerMessage(frame({ type: "requestShots", shotIds: [1] })).ok).toBe(false);
  });
});

describe("Steam Record envelopes", () => {
  const steam = { type: "steam", id: "delivery-1", steamId: "steam-1", steamedAt: "2026-10-05T14:07:03.341Z", steam: { unfamiliar: true } };

  it("validates delivery and its UTC time without validating Decaid's record contents", () => {
    const message = { ...steam, futureField: {} };
    expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    expect(decodePluginMessage(frame({ ...steam, id: "" })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...steam, steamId: 7 })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...steam, steam: [] })).ok).toBe(false);
  });

  it("refuses a time that is not a UTC instant, or that does not exist, without repeating it", () => {
    for (const steamedAt of [
      undefined,
      null,
      1791209223341,
      // The record's own local time, without an offset.
      "2026-10-05T09:07:03.341484",
      "2026-10-05T09:07:03.341-05:00",
      "2026-10-05T14:07:03Z",
      "2026-02-30T12:00:00.000Z",
      "2026-10-05T24:00:00.000Z",
      "unfamiliar",
    ]) {
      const result = decodePluginMessage(frame({ ...steam, steamedAt }));
      expect(result).toEqual({ ok: false, error: "protocol_error", problem: "steam.steamedAt must be a UTC time such as 2026-10-05T14:07:03.341Z" });
    }
    expect(JSON.stringify(decodePluginMessage(frame({ ...steam, steamedAt: token })))).not.toContain(token);
  });

  it("accepts bounded indices of ids, and validates their requests", () => {
    for (const steams of [[{ id: "1" }, { id: "2", futureField: true }], []]) {
      const message = { type: "steamIndex", id: "index-1", steams };
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodePluginMessage(frame({ type: "steamIndex", id: "index", steams: Array.from({ length: 101 }, (_, n) => ({ id: `${n}` })) })).ok).toBe(false);
    for (const steams of [["1"], [{ id: "" }], [{}], { id: "1" }]) {
      expect(decodePluginMessage(frame({ type: "steamIndex", id: "index", steams })).ok).toBe(false);
    }
    expect(decodePluginMessage(frame({ type: "steamIndex", steams: [] })).ok).toBe(false);
    const request = { type: "requestSteams", steamIds: ["1", "2"] };
    expect(decodeServerMessage(frame(request))).toEqual({ ok: true, message: request });
    for (const steamIds of [[1], [""], Array.from({ length: 101 }, (_, n) => `${n}`), undefined]) {
      expect(decodeServerMessage(frame({ type: "requestSteams", steamIds })).ok).toBe(false);
    }
  });
});

describe("Workflow and machine state envelopes", () => {
  const workflow = { type: "workflow", id: "delivery-1", observedAt: "2026-10-05T14:05:43.648Z", workflow: { profile: { title: "Londonium" }, future: [1] } };
  const state = { type: "machineState", id: "delivery-2", observedAt: "2026-10-05T14:05:43.648Z", state: "espresso", substate: "preinfusion" };

  it("validates the envelope without validating the Workflow, and keeps fields it does not know", () => {
    for (const message of [workflow, state, { ...workflow, workflow: {} }, { ...state, futureField: { snapshot: true } }]) {
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodePluginMessage(frame({ ...workflow, workflow: [] }))).toMatchObject({ ok: false, problem: "workflow.workflow must be an object" });
    expect(decodePluginMessage(frame({ ...workflow, workflow: null }))).toMatchObject({ ok: false, problem: "workflow.workflow must be an object" });
    for (const message of [workflow, state]) {
      expect(decodePluginMessage(frame({ ...message, id: "" }))).toMatchObject({ ok: false, problem: `${message.type}.id must not be empty` });
    }
  });

  it("requires a state and substate, each a non-empty name", () => {
    expect(decodePluginMessage(frame({ ...state, state: "" }))).toMatchObject({ ok: false, problem: "machineState.state must not be empty" });
    expect(decodePluginMessage(frame({ ...state, substate: undefined }))).toMatchObject({ ok: false, problem: "machineState.substate must be a string" });
    expect(decodePluginMessage(frame({ ...state, state: { state: "idle" } }))).toMatchObject({ ok: false, problem: "machineState.state must be a string" });
  });

  it("requires the time the plugin observed it, in UTC, naming a time that exists", () => {
    for (const observedAt of ["2026-10-05T14:05:43.648Z", "2024-02-29T23:59:59.999Z", "2026-10-05T14:05:43.000Z"]) {
      expect(decodePluginMessage(frame({ ...state, observedAt })).ok).toBe(true);
    }
    for (const observedAt of [
      undefined,
      1_790_000_000_000,
      "",
      // The tablet's local time without an offset, as a stateUpdate's own timestamp is.
      "2026-10-05T10:05:43.648490",
      "2026-10-05T10:05:43.648-04:00",
      "2026-10-05T14:05:43.648490Z",
      // As toISOString writes every time: with its milliseconds.
      "2026-10-05T14:05:43Z",
      "2026-02-30T12:00:00.000Z",
      "2026-10-05T24:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "Mon, 05 Oct 2026 14:05:43 GMT",
    ]) {
      for (const message of [workflow, state]) {
        expect(decodePluginMessage(frame({ ...message, observedAt }))).toEqual({
          ok: false,
          error: "protocol_error",
          problem: `${message.type}.observedAt must be a UTC time such as 2026-10-05T14:07:03.341Z`,
        });
      }
    }
  });
});

describe("Collection envelopes", () => {
  const beans = { type: "collection", id: "delivery-1", name: "beans", available: true, value: [{ id: "bean-1", roaster: "Fixture Roaster", future: true }] };
  const noScale = { type: "collection", id: "delivery-2", name: "scaleInfo", available: false };

  it("names every collection the plugin reports", () => {
    expect(COLLECTION_NAMES).toHaveLength(13);
    for (const name of COLLECTION_NAMES) expect(isCollectionName(name)).toBe(true);
    expect(isCollectionName("recipes")).toBe(false);
  });

  it("validates the envelope without validating Decaid's value, and keeps fields it does not know", () => {
    for (const message of [
      beans,
      noScale,
      { ...beans, value: [] },
      { ...beans, value: {} },
      { ...beans, value: 0 },
      { ...beans, value: false },
      { ...noScale, futureField: { reason: 503 } },
    ]) {
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
  });

  it("accepts a name it does not know, which a server then ignores", () => {
    expect(decodePluginMessage(frame({ ...beans, name: "recipes" })).ok).toBe(true);
    expect(decodePluginMessage(frame({ ...beans, name: "" }))).toMatchObject({ ok: false, problem: "collection.name must not be empty" });
    expect(decodePluginMessage(frame({ ...beans, name: 3 }))).toMatchObject({ ok: false, problem: "collection.name must be a string" });
  });

  it("requires a value, and not null, while available, and none while unavailable", () => {
    for (const value of [undefined, null]) {
      expect(decodePluginMessage(frame({ ...beans, value }))).toMatchObject({ ok: false, problem: "collection.value must be present and not null" });
    }
    expect(decodePluginMessage(frame({ ...noScale, value: {} }))).toMatchObject({ ok: false, problem: "collection.value must be absent" });
    expect(decodePluginMessage(frame({ ...noScale, value: null }))).toMatchObject({ ok: false, problem: "collection.value must be absent" });
    for (const available of [undefined, "true", 1]) {
      expect(decodePluginMessage(frame({ ...beans, available }))).toMatchObject({ ok: false, problem: "collection.available must be true or false" });
    }
    expect(decodePluginMessage(frame({ ...beans, id: "" }))).toMatchObject({ ok: false, problem: "collection.id must not be empty" });
  });
});
