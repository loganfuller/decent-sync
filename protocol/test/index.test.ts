import { describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  type ErrorMessage,
  type Hello,
  PROTOCOL_VERSION,
  decodePluginMessage,
  decodeServerMessage,
  encode,
} from "@decent-sync/protocol";

const token = "8cTqXr0b2m6Yw1zH4kLpQeNvSa7uJdFg9oIiBhC3E5s";

const hello: Hello = {
  type: "hello",
  protocolVersion: 1,
  token,
  pluginVersion: "0.1.0",
  decaidVersion: "0.8.6+2801",
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

  it("accepts a hello without hardware, versions or connection id", () => {
    const bare = { type: "hello", protocolVersion: 1, token, pluginVersion: "0.1.0" };
    expect(decodePluginMessage(frame(bare))).toEqual({ ok: true, message: bare });
    for (const missing of [{ machine: null }, { decaidVersion: null, connectionId: null }]) {
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
        "hello.token must not be empty; hello.pluginVersion must be a string; hello.connectionId must be a string or null; hello.machine.serial must be a string",
    });
    expect(decodePluginMessage(frame({ ...hello, token: undefined }))).toMatchObject({ problem: "hello.token must be a string" });
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
    for (const message of [{ type: "ack", id: "1" }, { type: "requestShots", shotIds: ["1", "2"] }]) {
      expect(decodeServerMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodeServerMessage(frame({ type: "ack" })).ok).toBe(false);
    expect(decodeServerMessage(frame({ type: "requestShots", shotIds: [1] })).ok).toBe(false);
  });
});
