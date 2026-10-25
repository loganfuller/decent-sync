import { describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  COLLECTION_NAMES,
  type ErrorMessage,
  GLOBAL_ID_KEY,
  GLOBAL_ITEM_ID,
  type Hello,
  type ItemDeleted,
  type ItemLeftOut,
  type ItemRemoved,
  type ItemWritten,
  LEFT_OUT_OUTCOMES,
  LIBRARY_ITEM_KINDS,
  LIBRARY_KINDS,
  LIBRARY_LISTS,
  type LeaveOut,
  type LibraryDelete,
  type LibraryRemove,
  type LibraryWrite,
  type ListUnrecognised,
  DYE2_LISTS,
  MAX_HARDWARE_LENGTH,
  MAX_ID_LENGTH,
  MAX_RECORD_ID_LENGTH,
  RECIPE_SLOTS,
  RECIPE_SLOT_FIELD,
  SETTINGS_EDITED_REFUSALS,
  type SettingsEdit,
  type SettingsEdited,
  DYE2_RECIPE_FIELD,
  dye2Fingerprint,
  dye2RecipeIdOf,
  recipeSlotOf,
  RECIPE_SETTINGS,
  LOADED_RECIPE_PARTS,
  steamOff,
  MAX_REFUSAL_LENGTH,
  MAX_WRITTEN_FIELDS,
  PROTOCOL_VERSION,
  REMOVAL_ORDER,
  type WriteRefused,
  childKinds,
  childLists,
  decodePluginMessage,
  decodeServerFrame,
  decodeServerMessage,
  dye2GlobalIdOf,
  dye2Key,
  dye2Records,
  encode,
  equipmentMatchKey,
  frames,
  globalIdOf,
  isCollectionName,
  isDeletedKind,
  isGlobalId,
  isLibraryKind,
  isDye2List,
  isLibraryList,
  isRecordId,
  isRecipeSlot,
  recordGlobalId,
  itemIdRule,
  listKind,
  parentKind,
  parentList,
  sameValue,
} from "@decent-sync/protocol";

const token = "8cTqXr0b2m6Yw1zH4kLpQeNvSa7uJdFg9oIiBhC3E5s";
const tabletId = "0f8e5d34-6c1b-4f0a-9d2e-7b3c4a5f6e81";

const hello: Hello = {
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  token,
  pluginVersion: "0.1.0",
  decaidVersion: "0.9.0+2977",
  tabletId,
  connectionId: "00:00:5E:00:53:01",
  machine: { model: "DE1Pro", serial: "10001", firmware: "1333" },
};

const frame = (value: unknown) => JSON.stringify(value);

describe("protocol", () => {
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
    const bare = { type: "hello", protocolVersion: PROTOCOL_VERSION, token, pluginVersion: "0.1.0", decaidVersion: "0.9.0+2977", tabletId };
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
      frame({ type: "hello", protocolVersion: PROTOCOL_VERSION, token: "", pluginVersion: 1, connectionId: 7, machine: { model: "DE1" } }),
    );
    expect(result).toEqual({
      ok: false,
      error: "protocol_error",
      problem:
        "hello.token must not be empty; hello.pluginVersion must be a string; hello.decaidVersion must be a string; hello.tabletId must be a UUID; hello.connectionId must be a string or null; hello.machine.serial must be a string",
    });
    expect(decodePluginMessage(frame({ ...hello, token: undefined }))).toMatchObject({ problem: "hello.token must be a string" });
    expect(decodePluginMessage(frame({ ...hello, decaidVersion: null }))).toMatchObject({ problem: "hello.decaidVersion must be a string" });
    expect(decodePluginMessage(frame({ ...hello, decaidVersion: "" }))).toMatchObject({ problem: "hello.decaidVersion must not be empty" });
    expect(decodePluginMessage(frame({ ...hello, machine: "DE1Pro" }))).toMatchObject({
      problem: "hello.machine must be an object or null",
    });
  });

  it("needs the tablet's id, a UUID in either case", () => {
    expect(decodePluginMessage(frame({ ...hello, tabletId: tabletId.toUpperCase() }))).toMatchObject({ ok: true });
    for (const bad of [undefined, null, "", 7, "0f8e5d346c1b4f0a9d2e7b3c4a5f6e81", `${tabletId}0`, `{${tabletId}}`, { tabletId }]) {
      expect(decodePluginMessage(frame({ ...hello, tabletId: bad }))).toEqual({ ok: false, error: "protocol_error", problem: "hello.tabletId must be a UUID" });
    }
  });

  it("reads whether a hello yields to a live connection from another tablet, which it need not say", () => {
    for (const yielding of [true, false]) {
      expect(decodePluginMessage(frame({ ...hello, yielding }))).toEqual({ ok: true, message: { ...hello, yielding } });
    }
    for (const bad of [null, "true", 1]) {
      expect(decodePluginMessage(frame({ ...hello, yielding: bad }))).toEqual({
        ok: false,
        error: "protocol_error",
        problem: "hello.yielding must be true or false",
      });
    }
  });

  it("refuses a hello whose machine model, serial or connection id is longer than the server can index", () => {
    const longest = "1".repeat(MAX_HARDWARE_LENGTH);
    const atLimit = { ...hello, connectionId: longest, machine: { model: longest, serial: longest, firmware: "1333" } };
    expect(decodePluginMessage(frame(atLimit))).toEqual({ ok: true, message: atLimit });

    const tooLong = "2".repeat(MAX_HARDWARE_LENGTH + 1);
    for (const [bad, field] of [
      [{ ...hello, machine: { ...hello.machine, model: tooLong } }, "hello.machine.model"],
      [{ ...hello, machine: { ...hello.machine, serial: tooLong } }, "hello.machine.serial"],
      [{ ...hello, connectionId: tooLong }, "hello.connectionId"],
    ] as const) {
      const result = decodePluginMessage(frame(bad));
      expect(result).toEqual({ ok: false, error: "protocol_error", problem: `${field} must be at most ${MAX_HARDWARE_LENGTH} characters` });
      expect(JSON.stringify(result)).not.toContain(tooLong);
    }
    // No index holds the firmware, so it may be any length.
    expect(decodePluginMessage(frame({ ...hello, machine: { ...hello.machine, firmware: tooLong } })).ok).toBe(true);
  });

  it("never repeats a field's value in a problem", () => {
    for (const bad of [
      { ...hello, pluginVersion: { token } },
      { ...hello, protocolVersion: token },
      { ...hello, machine: { model: token, serial: [token] } },
      { ...hello, tabletId: token },
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

  it("accepts Decaid 0.9.0 and later releases, and pre-releases of later ones", () => {
    for (const decaidVersion of ["0.9.0+2977", "0.9.0", "0.9.1-beta.1+2990", "0.9.10+3200", "0.10.0+3300", "1.0.0-rc.1+4000"]) {
      expect(decodePluginMessage(frame({ ...hello, decaidVersion }))).toEqual({ ok: true, message: { ...hello, decaidVersion } });
    }
  });

  it("tells a tablet on an older Decaid to update it, keeping the token so its Machine can say why", () => {
    const refusals: [string, string][] = [
      ["0.8.8+2900", "This tablet runs Decaid 0.8.8"],
      ["0.8.10+2950", "This tablet runs Decaid 0.8.10"],
      ["0.9.0-beta.2+2970", "This tablet runs a pre-release of Decaid 0.9.0"],
      // Decaid built without its tags.
      ["0.0.0-dev+0", "This tablet runs a pre-release of Decaid 0.0.0"],
      ["v0.9.0+2977", "This tablet's Decaid reports no release version"],
      ["unknown", "This tablet's Decaid reports no release version"],
    ];
    for (const [decaidVersion, runs] of refusals) {
      expect(decodePluginMessage(frame({ ...hello, decaidVersion }))).toEqual({
        ok: false,
        error: "decaid_too_old",
        problem: `${runs}, but this server needs 0.9.0 or newer: update Decaid`,
        token,
      });
    }
    // Only the release numbers are repeated.
    for (const decaidVersion of [token, `0.8.8-${token}`, `0.8.8+${token}`]) {
      const result = decodePluginMessage(frame({ ...hello, decaidVersion }));
      expect(result).toMatchObject({ ok: false, error: "decaid_too_old" });
      expect(result.ok || result.problem).not.toContain(token);
    }
  });

  it("refuses a protocol version that is newer than the server's, or not a version", () => {
    expect(decodePluginMessage(frame({ ...hello, protocolVersion: PROTOCOL_VERSION + 1 }))).toMatchObject({
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
    expect(decodePluginMessage(frame({ type: "welcome", protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: 1 }))).toMatchObject({
      ok: false,
      error: "protocol_error",
      problem: "Unknown message type",
    });
  });
});

describe("decodeServerMessage", () => {
  it("reads a welcome, a heartbeat and an error, accepting fields it does not know", () => {
    const welcome = { type: "welcome", protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs: 30_000, machineName: "Uptown left" };
    expect(decodeServerMessage(frame(welcome))).toEqual({ ok: true, message: welcome });
    expect(decodeServerMessage(encode({ type: "heartbeat" }))).toEqual({ ok: true, message: { type: "heartbeat" } });
    const error: ErrorMessage = { type: "error", code: "bad_token", message: "No Machine has this token" };
    expect(decodeServerMessage(encode(error))).toEqual({ ok: true, message: error });
  });

  it("refuses a welcome without a usable heartbeat interval", () => {
    for (const heartbeatIntervalMs of [undefined, 0, "30000"]) {
      expect(decodeServerMessage(frame({ type: "welcome", protocolVersion: PROTOCOL_VERSION, heartbeatIntervalMs })).ok).toBe(false);
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

  it("reads when a Workflow held back first named its recipe, where it says, in UTC", () => {
    const recipeNamedAt = "2026-10-05T14:05:42.101Z";
    expect(decodePluginMessage(frame({ ...workflow, recipeNamedAt }))).toEqual({ ok: true, message: { ...workflow, recipeNamedAt } });
    expect(decodePluginMessage(frame({ ...workflow, recipeNamedAt: "2026-10-05T10:05:42.101" }))).toMatchObject({
      ok: false,
      problem: "workflow.recipeNamedAt must be a UTC time such as 2026-10-05T14:07:03.341Z",
    });
  });
});

describe("Collection envelopes", () => {
  const beans = { type: "collection", id: "delivery-1", name: "beans", available: true, value: [{ id: "bean-1", roaster: "Fixture Roaster", future: true }] };
  const noScale = { type: "collection", id: "delivery-2", name: "scaleInfo", available: false };

  it("names every collection the plugin reports", () => {
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

  it("carries each Library record's time in UTC beside a list, as long as it, or nothing", () => {
    for (const name of LIBRARY_LISTS) expect(isLibraryList(name)).toBe(true);
    expect(isLibraryList("pairedDevices")).toBe(false);
    for (const updatedAt of [["2026-10-05T19:03:13.044Z"], [null]]) {
      const message = { ...beans, updatedAt };
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    const problem = "collection.updatedAt must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls";
    for (const updatedAt of [[], ["2026-10-05T19:03:13.044Z", null], ["2026-10-05T14:03:13.044376"], ["2026-02-30T00:00:00.000Z"], "2026-10-05T19:03:13.044Z"]) {
      expect(decodePluginMessage(frame({ ...beans, updatedAt }))).toMatchObject({ ok: false, problem });
    }
    expect(decodePluginMessage(frame({ ...beans, value: {}, updatedAt: [] }))).toMatchObject({
      ok: false,
      problem: "collection.updatedAt must be absent unless value is a list",
    });
  });

  it("carries the tablet's UTC offset beside a value, in whole minutes within 18 hours of UTC", () => {
    const presence = { type: "collection", id: "delivery-presence", name: "presenceSettings", available: true, value: { userPresenceEnabled: true } };
    for (const utcOffsetMinutes of [-240, 0, 330, 840, -1080, 1080]) {
      const message = { ...presence, utcOffsetMinutes };
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    for (const utcOffsetMinutes of [-1081, 1081, 5.5, "-240", null]) {
      expect(decodePluginMessage(frame({ ...presence, utcOffsetMinutes })).ok).toBe(false);
    }
    expect(decodePluginMessage(frame({ ...presence, utcOffsetMinutes: 1500 }))).toMatchObject({
      ok: false,
      problem: "collection.utcOffsetMinutes must be from -1080 to 1080",
    });
    expect(decodePluginMessage(frame({ ...noScale, utcOffsetMinutes: -240 }))).toMatchObject({ ok: false, problem: "collection.utcOffsetMinutes must be absent" });
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

describe("Library writes", () => {
  const globalId = "6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d";
  const create: LibraryWrite = { type: "write", id: "write-1", kind: "bean", globalId, localId: null, fields: { roaster: "Fixture Roaster", name: "Fixture Bean" } };
  const update: LibraryWrite = { ...create, localId: "8ac511b9-81a6-4066-9a5e-5b67da092efc", fields: {} };
  const written: ItemWritten = {
    type: "written",
    id: "write-1",
    kind: "bean",
    globalId,
    record: { id: "8ac511b9-81a6-4066-9a5e-5b67da092efc", name: "Fixture Bean", extras: { [GLOBAL_ID_KEY]: globalId } },
    updatedAt: "2026-10-08T03:16:48.842Z",
    writtenFields: ["archived"],
  };
  const refused: WriteRefused = { type: "writeRefused", id: "write-1", kind: "bean", globalId, status: 404, error: '{"error":"Bean not found"}' };

  it("reads a request for every collection afresh", () => {
    expect(decodeServerMessage(frame({ type: "requestCollections" }))).toEqual({ ok: true, message: { type: "requestCollections" } });
  });

  it("reads a write, creating or updating a record, accepting fields and kinds it does not know", () => {
    const expecting = { ...update, fields: { notes: "Jasmine" }, expected: { notes: null }, contentDecidedAt: "2026-10-08T12:00:00.000Z" };
    for (const message of [create, update, expecting, { ...create, kind: "recipe", priority: 1 }]) {
      expect(decodeServerMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodeServerMessage(frame({ ...expecting, expected: ["notes"] }))).toMatchObject({ ok: false, problem: "write.expected must be an object" });
    expect(decodeServerMessage(frame({ ...expecting, contentDecidedAt: "yesterday" })).ok).toBe(false);
  });

  it("refuses a write without a global id, a usable local id or fields", () => {
    expect(decodeServerMessage(frame({ ...create, globalId: "bean-1" }))).toMatchObject({ ok: false, problem: "write.globalId must be a UUID" });
    for (const localId of [undefined, "", 7, "a".repeat(MAX_RECORD_ID_LENGTH + 1)]) {
      expect(decodeServerMessage(frame({ ...create, localId })).ok).toBe(false);
    }
    expect(decodeServerMessage(frame({ ...create, fields: [] }))).toMatchObject({ ok: false, problem: "write.fields must be an object" });
    expect(decodeServerMessage(frame({ ...create, kind: "" }))).toMatchObject({ ok: false, problem: "write.kind must not be empty" });
  });

  it("reads a write too large for one frame from its chunks, and no chunk as a whole message", () => {
    const large = { ...create, fields: { ...create.fields, notes: "Stone fruit and jasmine. ".repeat(20_000) } };
    const pieces = frames(encode(large), large.id);
    expect(pieces.length).toBeGreaterThan(1);
    const chunks = pieces.map((piece) => decodeServerFrame(piece.text));
    expect(chunks.every((chunk) => chunk.ok && chunk.message.type === "chunk")).toBe(true);
    const text = chunks.map((chunk) => (chunk.ok && chunk.message.type === "chunk" ? chunk.message.data : "")).join("");
    expect(decodeServerMessage(text)).toEqual({ ok: true, message: large });
    expect(decodeServerMessage(pieces[0]!.text)).toMatchObject({ ok: false, problem: "A chunked message must not be a chunk itself" });
    expect(decodeServerFrame(frame({ type: "chunk", id: "write-1", index: -1, count: 2, data: "" }))).toMatchObject({ ok: false });
  });

  it("reads the answers to a write: the record Decaid returned, or its refusal", () => {
    for (const message of [
      written,
      { ...written, updatedAt: null },
      { ...written, writtenFields: [], linked: true, contentDecidedAt: "2026-10-08T12:00:00.000Z" },
      refused,
      { ...refused, status: null, error: "Decaid did not answer: Fetch timed out" },
    ]) {
      expect(decodePluginMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodePluginMessage(frame({ ...written, linked: "yes" }))).toMatchObject({ ok: false, problem: "written.linked must be true or false" });
    expect(decodePluginMessage(frame({ ...written, contentDecidedAt: 7 })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...written, updatedAt: undefined }))).toMatchObject({ ok: false, problem: "written.updatedAt must be a UTC time such as 2026-10-05T14:07:03.341Z" });
    expect(decodePluginMessage(frame({ ...written, record: "record" }))).toMatchObject({ ok: false, problem: "written.record must be an object" });
    for (const writtenFields of [undefined, "archived", [7], Array.from({ length: MAX_WRITTEN_FIELDS + 1 }, () => "notes")]) {
      expect(decodePluginMessage(frame({ ...written, writtenFields }))).toMatchObject({ ok: false, problem: `written.writtenFields must be an array of at most ${MAX_WRITTEN_FIELDS} valid entries` });
    }
    expect(decodePluginMessage(frame({ ...refused, status: undefined }))).toMatchObject({ ok: false, problem: "writeRefused.status must be a whole number" });
    expect(decodePluginMessage(frame({ ...refused, error: "e".repeat(MAX_REFUSAL_LENGTH) })).ok).toBe(true);
    expect(decodePluginMessage(frame({ ...refused, error: "e".repeat(MAX_REFUSAL_LENGTH + 1) }))).toMatchObject({
      ok: false,
      problem: `writeRefused.error must be at most ${MAX_REFUSAL_LENGTH} characters`,
    });
  });

  it("reads a delete of a record of a hard-deleted item, and its answer", () => {
    const remove: LibraryDelete = { type: "delete", id: "delete-1", kind: "beanBatch", globalId, localId: "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca" };
    const deleted: ItemDeleted = { type: "deleted", id: "delete-1", kind: "beanBatch", globalId, localId: remove.localId };
    expect(decodeServerMessage(frame(remove))).toEqual({ ok: true, message: remove });
    expect(decodePluginMessage(frame(deleted))).toEqual({ ok: true, message: deleted });
    expect(decodePluginMessage(frame({ ...refused, id: "delete-1", kind: "beanBatch" }))).toMatchObject({ ok: true });
    expect(decodeServerMessage(frame({ ...remove, globalId: "batch-1" }))).toMatchObject({ ok: false, problem: "delete.globalId must be a UUID" });
    for (const localId of [undefined, null, "", "a".repeat(MAX_RECORD_ID_LENGTH + 1)]) {
      expect(decodeServerMessage(frame({ ...remove, localId })).ok).toBe(false);
      expect(decodePluginMessage(frame({ ...deleted, localId })).ok).toBe(false);
    }
    expect(LIBRARY_KINDS.filter(isDeletedKind)).toEqual(["bean", "beanBatch", "grinder", "profile", "basket", "tool", "recipe"]);
    for (const kind of ["workflow", "settings", "shot", ""]) expect(isDeletedKind(kind)).toBe(false);
    // A Profile's record is named by Decaid's id, which is its global id too.
    const profileId = "profile:bf1ca48b9c7389c7d146";
    const profile: LibraryDelete = { type: "delete", id: "delete-2", kind: "profile", globalId: profileId, localId: profileId };
    expect(decodeServerMessage(frame(profile))).toEqual({ ok: true, message: profile });
    expect(decodePluginMessage(frame({ ...deleted, id: "delete-2", kind: "profile", globalId: profileId, localId: profileId }))).toMatchObject({ ok: true });
    expect(decodeServerMessage(frame({ ...profile, globalId: "profile:\u0000" })).ok).toBe(false);
  });

  it("reads a leave-out of a record the Library leaves out, and its answer", () => {
    const leave: LeaveOut = { type: "leaveOut", id: "leave-1", kind: "grinder", localId: "eee958b7-d2cf-49a8-9d0b-3ec5ec4cabca" };
    const setAside: ItemLeftOut = { type: "leftOut", id: "leave-1", kind: "grinder", localId: leave.localId, outcome: "setAside" };
    const refusedOne: ItemLeftOut = { ...setAside, outcome: "refused", status: 500, error: "Decaid failed" };
    expect(decodeServerMessage(frame(leave))).toEqual({ ok: true, message: leave });
    expect(decodePluginMessage(frame(setAside))).toEqual({ ok: true, message: setAside });
    expect(decodePluginMessage(frame(refusedOne))).toEqual({ ok: true, message: refusedOne });
    expect(decodePluginMessage(frame({ ...refusedOne, status: null }))).toMatchObject({ ok: true });
    expect(LEFT_OUT_OUTCOMES).toEqual(["setAside", "gone", "taken", "refused"]);
    expect(decodePluginMessage(frame({ ...setAside, outcome: "archived" }))).toMatchObject({
      ok: false,
      problem: "leftOut.outcome must be one of setAside, gone, taken, refused",
    });
    expect(decodePluginMessage(frame({ ...refusedOne, error: "a".repeat(MAX_REFUSAL_LENGTH + 1) })).ok).toBe(false);
    for (const localId of [undefined, null, "", "a".repeat(MAX_RECORD_ID_LENGTH + 1)]) {
      expect(decodeServerMessage(frame({ ...leave, localId })).ok).toBe(false);
      expect(decodePluginMessage(frame({ ...setAside, localId })).ok).toBe(false);
    }
    // A Profile's record is named by Decaid's id.
    const profile: LeaveOut = { type: "leaveOut", id: "leave-2", kind: "profile", localId: "profile:bf1ca48b9c7389c7d146" };
    expect(decodeServerMessage(frame(profile))).toEqual({ ok: true, message: profile });
  });

  it("names a Profile by Decaid's id, which is the same on every tablet, and every other kind by a global id", () => {
    const profileId = "profile:bf1ca48b9c7389c7d146";
    const profile: LibraryWrite = { type: "write", id: "write-2", kind: "profile", globalId: profileId, localId: profileId, fields: { visibility: "hidden" } };
    expect(decodeServerMessage(frame(profile))).toEqual({ ok: true, message: profile });
    expect(decodePluginMessage(frame({ ...written, kind: "profile", globalId: profileId, record: { id: profileId } }))).toMatchObject({ ok: true });
    expect(decodePluginMessage(frame({ ...refused, kind: "profile", globalId: profileId }))).toMatchObject({ ok: true });
    for (const globalId of ["", "p".repeat(MAX_RECORD_ID_LENGTH + 1), "profile:\u0000", 7]) {
      expect(decodeServerMessage(frame({ ...profile, globalId }))).toMatchObject({
        ok: false,
        problem: `write.globalId must be a Profile's id of 1 to ${MAX_RECORD_ID_LENGTH} characters without NUL`,
      });
    }
    // Another kind's is a global id, whatever a Profile's may be.
    expect(decodeServerMessage(frame({ ...create, globalId: profileId }))).toMatchObject({ ok: false, problem: "write.globalId must be a UUID" });
    expect(itemIdRule("profile").test(profileId)).toBe(true);
    expect(itemIdRule("bean").test(profileId)).toBe(false);
    expect(itemIdRule("beanBatch").test(globalId)).toBe(true);
    expect(itemIdRule("grinder").test(globalId)).toBe(true);
    expect(itemIdRule("grinder").test(profileId)).toBe(false);
    expect(LIBRARY_KINDS.every(isLibraryKind)).toBe(true);
    expect(isLibraryKind("favourite")).toBe(false);
  });

  it("checks each kind's ids as the kind declares them, which need not be UUIDs", () => {
    // A DYE2 id and a recipe slot number, which are no UUIDs.
    const ids = ["bskt-1790543325397", "3"];
    for (const kind of LIBRARY_KINDS) {
      const rule = itemIdRule(kind);
      expect(rule).toBe(LIBRARY_ITEM_KINDS[kind].id);
      for (const id of [globalId, ...ids]) {
        const message = { ...create, kind, globalId: id };
        expect(decodeServerMessage(frame(message))).toEqual(rule.test(id) ? { ok: true, message } : { ok: false, error: "protocol_error", problem: `write.globalId ${rule.problem}` });
      }
    }
    // A Profile declares Decaid's ids, which any record id is; a bean declares global ids.
    for (const id of ids) {
      expect(itemIdRule("profile").test(id)).toBe(true);
      expect(decodePluginMessage(frame({ ...written, kind: "profile", globalId: id }))).toMatchObject({ ok: true });
      expect(decodePluginMessage(frame({ ...refused, kind: "profile", globalId: id }))).toMatchObject({ ok: true });
      expect(decodePluginMessage(frame({ ...refused, globalId: id }))).toMatchObject({ ok: false, problem: "writeRefused.globalId must be a UUID" });
    }
    // The shared settings, a Workflow and a kind this side does not know are named by UUIDs.
    for (const kind of ["settings", "workflow", "favourite"]) {
      expect(itemIdRule(kind)).toBe(GLOBAL_ITEM_ID);
      expect(itemIdRule(kind).test(ids[0])).toBe(false);
    }
  });

  it("derives the Library's lists and their order from each kind's description", () => {
    expect(LIBRARY_LISTS).toEqual(LIBRARY_KINDS.map((kind) => LIBRARY_ITEM_KINDS[kind].list));
    for (const kind of LIBRARY_KINDS) expect(listKind(LIBRARY_ITEM_KINDS[kind].list)).toBe(kind);
    // A Bean Batch's records are made under its bean's, so they go first.
    expect(parentKind("beanBatch")).toBe("bean");
    expect(parentKind("bean")).toBeUndefined();
    expect(childKinds("bean")).toEqual(["beanBatch"]);
    expect(parentList("beanBatches")).toBe("beans");
    expect(parentList("grinders")).toBeUndefined();
    expect(childLists("beans")).toEqual(["beanBatches"]);
    expect(childLists("profiles")).toEqual([]);
    expect(REMOVAL_ORDER).toEqual(["beanBatch", "bean", "grinder", "profile", "basket", "tool", "recipe"]);
    // Every kind's records are made under a kind listed before it, or none.
    for (const kind of LIBRARY_KINDS) {
      const parent = parentKind(kind);
      if (parent !== undefined) expect(LIBRARY_KINDS.indexOf(parent)).toBeLessThan(LIBRARY_KINDS.indexOf(kind));
    }
  });

  it("finds the global id a record carries in its extras, in lower case", () => {
    expect(isGlobalId(globalId)).toBe(true);
    expect(isGlobalId("bean-1")).toBe(false);
    expect(globalIdOf(written.record)).toBe(globalId);
    expect(globalIdOf({ extras: { bcUuid: "x", [GLOBAL_ID_KEY]: globalId.toUpperCase() } })).toBe(globalId);
    for (const record of [{}, { extras: null }, { extras: { [GLOBAL_ID_KEY]: "bean-1" } }, { extras: [globalId] }, null, "record"]) {
      expect(globalIdOf(record)).toBeNull();
    }
  });

  it("reads Baskets and Tools from DYE2's lists, whose records carry their global id in a field of their own", () => {
    expect(dye2Key("basket")).toBe("baskets");
    expect(dye2Key("tool")).toBe("equipment");
    expect(dye2Key("bean")).toBeUndefined();
    expect(LIBRARY_ITEM_KINDS.basket.list).toBe("dye2Baskets");
    expect(LIBRARY_ITEM_KINDS.tool.list).toBe("dye2Equipment");
    for (const list of ["dye2Recipes", "dye2Equipment", "dye2Baskets"]) expect(isDye2List(list)).toBe(true);
    expect(isDye2List("beans")).toBe(false);
    expect(Object.values(DYE2_LISTS)).toEqual(["recipes", "equipment", "baskets"]);
    const record = { id: "5a792f42-b6ff-44e0-a58c-ed165741b789", name: "Basket", [GLOBAL_ID_KEY]: globalId.toUpperCase() };
    expect(dye2GlobalIdOf(record)).toBe(globalId);
    expect(recordGlobalId("basket", record)).toBe(globalId);
    // A bean's is in its extras, not a field of its own.
    expect(recordGlobalId("bean", record)).toBeNull();
    expect(recordGlobalId("bean", written.record)).toBe(globalId);
    for (const other of [{}, { [GLOBAL_ID_KEY]: "basket-1" }, { extras: { [GLOBAL_ID_KEY]: globalId } }, null]) expect(dye2GlobalIdOf(other)).toBeNull();
  });

  it("recognises a DYE2 list only as an array of records each with an id of its own", () => {
    const list = [{ id: "1", name: "a" }, { id: "2", name: "b", extra: [1] }];
    expect(dye2Records(list)).toBe(list);
    expect(dye2Records([])).toEqual([]);
    for (const value of [
      null,
      {},
      { "1": { id: "1" } },
      "[]",
      [{ id: "1" }, "2"],
      [{ id: "1" }, null],
      [{ id: "1" }, [{ id: "2" }]],
      [{ name: "no id" }],
      [{ id: 1 }],
      [{ id: "" }],
      [{ id: "a".repeat(MAX_RECORD_ID_LENGTH + 1) }],
      [{ id: "1" }, { id: "1" }],
    ]) {
      expect(dye2Records(value)).toBeNull();
    }
  });

  it("recognises DYE2's recipes under any record id, each in a Recipe Slot from 1 to 5 by its stripSlot, or none", () => {
    expect(dye2Key("recipe")).toBe("recipes");
    expect(LIBRARY_ITEM_KINDS.recipe.list).toBe("dye2Recipes");
    // Recipes are written last, as they name the other kinds by the tablet's ids.
    expect(LIBRARY_KINDS.at(-1)).toBe("recipe");
    // A UUID from DYE2's editor, `recipe-…` from its save-recipe, and a slot's number from before DYE2 v0.1.25.
    const recipes = [{ id: "3f2b8c1e-5d7a-4e9b-8c2d-1a6f0e4b7c93", stripSlot: 1 }, { id: "recipe-mh2k9x1abc", stripSlot: null }, { id: "4" }];
    expect(dye2Records(recipes)).toBe(recipes);
    expect(recipes.map(recipeSlotOf)).toEqual([1, null, null]);
    for (const slot of [0, 6, 1.5, "2", -1, null, undefined]) expect(recipeSlotOf({ id: "a", stripSlot: slot })).toBeNull();
    for (const slot of [1, 2, 3, 4, 5]) expect(isRecipeSlot(slot)).toBe(true);
    expect(RECIPE_SLOTS).toBe(5);
    expect(RECIPE_SLOT_FIELD).toBe("stripSlot");
  });

  it("reads the recipe a Workflow names by its record id, as DYE2 does, and fingerprints a profile as DYE2 v0.1.26 does", () => {
    expect(DYE2_RECIPE_FIELD).toBe("context.extras.dye.recipeId");
    expect(dye2RecipeIdOf({ context: { extras: { dye: { v: 1, recipeId: "recipe-mh2k9x1abc" } } } })).toBe("recipe-mh2k9x1abc");
    expect(dye2RecipeIdOf({ context: { extras: { dye: { recipeId: 3 } } } })).toBe("3");
    for (const id of [null, "", undefined]) expect(dye2RecipeIdOf({ context: { extras: { dye: { recipeId: id } } } })).toBeNull();
    expect(dye2RecipeIdOf({ context: { extras: { dye: { selection: { kind: "recipe", id: "1" } } } } })).toBeNull();
    const profile = { title: "Adaptive", tank_temperature: 0, steps: [{ name: "fill", temperature: 93, limiter: { value: 0, range: 0.6 } }, { name: "pour", temperature: 90, limiter: { value: 9, range: 0.6 } }] };
    const sentByStreamline = { ...profile, steps: [{ ...profile.steps[0], temperature: 92, limiter: null }, { ...profile.steps[1], temperature: 89 }] };
    expect(dye2Fingerprint(sentByStreamline)).toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint({ ...profile, target_weight: 40 })).toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint({ ...profile, title: "Other" })).not.toBe(dye2Fingerprint(profile));
    expect(dye2Fingerprint(null)).toBeNull();
  });

  it("names each steam, hot water and flush setting a Recipe may hold by DYE2's name and the Workflow's, a Loaded Recipe part of its own", () => {
    expect(Object.keys(RECIPE_SETTINGS)).toHaveLength(11);
    expect(RECIPE_SETTINGS.flushDuration).toEqual({ dye2: "flushS", workflow: "rinseData.duration", whole: true });
    expect(RECIPE_SETTINGS.steamStopTemperature).toEqual({ dye2: "steamStopAtTempC", workflow: "steamSettings.stopAtTemperature", whole: false });
    for (const [setting, { workflow }] of Object.entries(RECIPE_SETTINGS)) expect(LOADED_RECIPE_PARTS[setting as keyof typeof LOADED_RECIPE_PARTS]).toEqual([workflow]);
    // Steam is off below 135 °C, as Decaid judges it; a Workflow saying nothing of it has it on.
    expect(steamOff({ steamSettings: { targetTemperature: 0 } })).toBe(true);
    expect(steamOff({ steamSettings: { targetTemperature: 134 } })).toBe(true);
    expect(steamOff({ steamSettings: { targetTemperature: 135 } })).toBe(false);
    expect(steamOff({})).toBe(false);
  });

  it("matches Baskets and Tools by name, ignoring case and white space at either end", () => {
    expect(equipmentMatchKey("  20g High-flow ")).toBe(equipmentMatchKey("20G HIGH-FLOW"));
    expect(equipmentMatchKey("20g High flow")).not.toBe(equipmentMatchKey("20g High-flow"));
  });

  it("reads a remove of a record from one of DYE2's lists, and its answers", () => {
    const localId = "f204e0d6-cfa8-4fd9-9316-de2e6f0ae8e6";
    const remove: LibraryRemove = { type: "remove", id: "remove-1", kind: "tool", globalId, localId };
    expect(decodeServerMessage(frame(remove))).toEqual({ ok: true, message: remove });
    expect(decodeServerMessage(frame({ ...remove, globalId: "tool-1" }))).toMatchObject({ ok: false, problem: "remove.globalId must be a UUID" });
    for (const bad of [undefined, null, "", "a".repeat(MAX_RECORD_ID_LENGTH + 1)]) expect(decodeServerMessage(frame({ ...remove, localId: bad })).ok).toBe(false);
    const removed: ItemRemoved = { type: "removed", id: "remove-1", kind: "tool", globalId, localId };
    expect(decodePluginMessage(frame(removed))).toEqual({ ok: true, message: removed });
    expect(decodePluginMessage(frame({ ...removed, localId: "" })).ok).toBe(false);
    const unrecognised: ListUnrecognised = { type: "listUnrecognised", id: "remove-1", kind: "tool" };
    expect(decodePluginMessage(frame(unrecognised))).toEqual({ ok: true, message: unrecognised });
    expect(decodePluginMessage(frame({ ...unrecognised, kind: "" })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...unrecognised, id: undefined })).ok).toBe(false);
  });

  it("compares the values records hold as JSON, a field left out being the same as null", () => {
    expect(sameValue({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, gone: null }, { a: 1 })).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });
});

describe("Settings Edits", () => {
  const edit: SettingsEdit = {
    type: "settingsEdit",
    id: "0193a6f2-5c1e-7d3a-9b4f-1e2d3c4b5a69",
    collection: "machineSettings",
    fields: { fan: 40 },
    expected: { fan: 50 },
    timeLeftMs: 59_870,
  };
  const written: SettingsEdited = { type: "settingsEdited", id: edit.id, outcome: "written", values: { fan: 40 } };

  it("reads an edit, accepting fields it does not know, and refuses one without an id, its fields, what they are expected to hold or the time it has left", () => {
    expect(decodeServerMessage(frame(edit))).toEqual({ ok: true, message: edit });
    expect(decodeServerMessage(frame({ ...edit, target: "flow" }))).toMatchObject({ ok: true });
    expect(decodeServerMessage(frame({ ...edit, id: "edit-1" }))).toMatchObject({ ok: false, problem: "settingsEdit.id must be a UUID" });
    expect(decodeServerMessage(frame({ ...edit, collection: "" }))).toMatchObject({ ok: false, problem: "settingsEdit.collection must not be empty" });
    expect(decodeServerMessage(frame({ ...edit, fields: [40] }))).toMatchObject({ ok: false, problem: "settingsEdit.fields must be an object" });
    expect(decodeServerMessage(frame({ ...edit, expected: undefined }))).toMatchObject({ ok: false, problem: "settingsEdit.expected must be an object" });
    for (const timeLeftMs of [undefined, -1, 1.5]) expect(decodeServerMessage(frame({ ...edit, timeLeftMs })).ok).toBe(false);
  });

  it("reads a wake schedule's edit: an add without an id, and a change or delete naming its schedule", () => {
    const presence = { ...edit, collection: "presenceSettings", expected: {} };
    const added: SettingsEdit = { ...presence, schedule: { action: "add" }, fields: { time: "06:30", daysOfWeek: [], enabled: true, keepAwakeFor: null } };
    const deleted: SettingsEdit = { ...presence, schedule: { action: "delete", id: "a2c4e6f8" }, fields: {}, expected: { id: "a2c4e6f8", time: "06:30", daysOfWeek: [], enabled: true } };
    for (const message of [added, deleted, { ...deleted, schedule: { action: "change", id: "a2c4e6f8" } }]) {
      expect(decodeServerMessage(frame(message))).toEqual({ ok: true, message });
    }
    expect(decodeServerMessage(frame({ ...added, schedule: { action: "move" } }))).toMatchObject({ ok: false, problem: expect.stringContaining("settingsEdit.schedule.action must be one of add, change, delete") });
    expect(decodeServerMessage(frame({ ...added, schedule: { action: "add", id: "a2c4e6f8" } }))).toMatchObject({ ok: false, problem: "settingsEdit.schedule.id must be absent" });
    expect(decodeServerMessage(frame({ ...deleted, schedule: { action: "delete" } }))).toMatchObject({ ok: false, problem: "settingsEdit.schedule.id must be a string" });
    expect(decodeServerMessage(frame({ ...deleted, schedule: { action: "delete", id: "" } })).ok).toBe(false);
    expect(decodeServerMessage(frame({ ...deleted, schedule: "delete" })).ok).toBe(false);
  });

  it("reads its answer: written, with the values read back where they could be, or refused, with why", () => {
    const refusals: SettingsEdited[] = [
      { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "machineBusy", state: "espresso" },
      { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "changedSince", values: { fan: 30 } },
      { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "expired" },
      { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "decaid", status: 500, message: "DeviceNotConnectedException: machine not connected" },
      { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "decaid", status: null, message: "Decaid did not answer", values: { fan: 50 } },
    ];
    expect(SETTINGS_EDITED_REFUSALS).toEqual(["machineBusy", "changedSince", "expired", "decaid"]);
    for (const answer of [written, { ...written, values: undefined }, ...refusals]) {
      expect(decodePluginMessage(frame(answer))).toEqual({ ok: true, message: JSON.parse(frame(answer)) });
    }
    expect(decodePluginMessage(frame({ ...written, outcome: "applied" }))).toMatchObject({ ok: false, problem: "settingsEdited.outcome must be one of written, refused" });
    expect(decodePluginMessage(frame({ ...written, reason: "expired" }))).toMatchObject({ ok: false, problem: "settingsEdited.reason must be absent" });
    expect(decodePluginMessage(frame({ ...written, values: [40] }))).toMatchObject({ ok: false, problem: "settingsEdited.values must be an object" });
    expect(decodePluginMessage(frame({ ...refusals[0], reason: "busy" })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...refusals[0], state: "" })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...refusals[3], status: undefined })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...refusals[3], message: "a".repeat(MAX_REFUSAL_LENGTH + 1) })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...written, id: "edit-1" }))).toMatchObject({ ok: false, problem: "settingsEdited.id must be a UUID" });
  });

  it("reads the id Decaid gave a wake schedule an edit added", () => {
    const added: SettingsEdited = { ...written, values: { id: "a2c4e6f8", time: "06:30", daysOfWeek: [], enabled: true, keepAwakeFor: null }, scheduleId: "a2c4e6f8" };
    expect(decodePluginMessage(frame(added))).toEqual({ ok: true, message: added });
    expect(decodePluginMessage(frame({ ...added, scheduleId: "" })).ok).toBe(false);
    expect(decodePluginMessage(frame({ ...added, scheduleId: 7 })).ok).toBe(false);
  });
});

describe("Delivery ids", () => {
  const observedAt = "2026-10-05T14:07:03.341Z";
  const deliveries = [
    { type: "shot", shotId: "shot-1", shot: {} },
    { type: "shotUpdated", shotId: "shot-1", shot: {} },
    { type: "shotIndex", shots: [] },
    { type: "steam", steamId: "steam-1", steamedAt: observedAt, steam: {} },
    { type: "steamIndex", steams: [] },
    { type: "workflow", observedAt, workflow: {} },
    { type: "machineState", observedAt, state: "idle", substate: "idle" },
    { type: "collection", name: "scaleInfo", available: false },
    { type: "written", kind: "bean", globalId: "6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", record: {}, updatedAt: null, writtenFields: [] },
    { type: "writeRefused", kind: "bean", globalId: "6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", status: 400, error: "" },
    { type: "deleted", kind: "bean", globalId: "6a1c3d2e-4b5f-4a7e-9c8d-0e1f2a3b4c5d", localId: "8ac511b9-81a6-4066-9a5e-5b67da092efc" },
    { type: "leftOut", kind: "bean", localId: "8ac511b9-81a6-4066-9a5e-5b67da092efc", outcome: "gone" },
  ];

  it("are at most MAX_ID_LENGTH characters on every delivery, and a longer one is refused without being repeated", () => {
    const longest = "a".repeat(MAX_ID_LENGTH);
    const longer = "b".repeat(MAX_ID_LENGTH + 1);
    for (const delivery of deliveries) {
      expect(decodePluginMessage(frame({ ...delivery, id: longest }))).toEqual({ ok: true, message: { ...delivery, id: longest } });
      expect(decodePluginMessage(frame({ ...delivery, id: longer }))).toEqual({
        ok: false,
        error: "protocol_error",
        problem: `${delivery.type}.id must be at most ${MAX_ID_LENGTH} characters`,
      });
    }
  });

  it("are counted in UTF-16 code units, as JavaScript counts a string's length", () => {
    const pairs = "\u{1D11E}".repeat(MAX_ID_LENGTH / 2);
    expect(decodePluginMessage(frame({ ...deliveries[0], id: pairs })).ok).toBe(true);
    expect(decodePluginMessage(frame({ ...deliveries[0], id: `${pairs}a` })).ok).toBe(false);
  });
});

describe("Record ids", () => {
  it("are the Shot and Steam Record ids the server stores: 1 to MAX_RECORD_ID_LENGTH code units, without NUL", () => {
    expect(isRecordId("5f0c9f0e-7d0e-4a8b-9a51-2f3b4c5d6e7f")).toBe(true);
    expect(isRecordId("a".repeat(MAX_RECORD_ID_LENGTH))).toBe(true);
    expect(isRecordId("\u{1D11E}".repeat(MAX_RECORD_ID_LENGTH / 2))).toBe(true);
    for (const value of ["", "a".repeat(MAX_RECORD_ID_LENGTH + 1), "shot\u0000", 1, null, undefined]) expect(isRecordId(value)).toBe(false);
  });
});

