// Decent Sync plugin for Decaid. Generated from plugin/ by `npm run build -w plugin`; do not edit.
"use strict";
var __decentSync = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    createPlugin: () => createPlugin
  });

  // ../protocol/src/chunking.ts
  var MAX_FRAME_BYTES = 256 * 1024;
  var MAX_CHUNKED_LENGTH = 16 * 1024 * 1024;
  var MAX_CHUNKS = 1024;
  var ASCII_RUN = /[\x00-\x7f]*/y;
  var ASCII_STEPS = 32;
  function utf8Length(text) {
    const length = text.length;
    let bytes = length;
    for (let at = 0; at < length; ) {
      ASCII_RUN.lastIndex = at;
      ASCII_RUN.test(text);
      at = ASCII_RUN.lastIndex;
      for (let ascii = 0; at < length && ascii < ASCII_STEPS; at++) {
        const unit = text.charCodeAt(at);
        if (unit < 128) ascii++;
        else {
          ascii = 0;
          if (unit < 2048) bytes += 1;
          else {
            bytes += 2;
            if (unit >= 55296 && unit <= 56319) {
              const next = text.charCodeAt(at + 1);
              if (next >= 56320 && next <= 57343) at++;
            }
          }
        }
      }
    }
    return bytes;
  }
  function frames(text, id, maxFrameBytes = MAX_FRAME_BYTES) {
    if (text.length <= maxFrameBytes) {
      const bytes = utf8Length(text);
      if (bytes <= maxFrameBytes) return [{ text, bytes }];
    }
    const room = maxFrameBytes - utf8Length(chunkFrame(id, text.length, text.length, ""));
    if (room < 8) throw new Error("The frame size leaves no room for a chunk's data");
    const pieces = [];
    const aim = room * 0.99;
    let ratio = 1;
    for (let start = 0; start < text.length; ) {
      let length = Math.min(text.length - start, Math.max(1, Math.floor(aim / ratio)));
      for (; ; ) {
        length = withoutSplitPair(text, start, length);
        const piece = JSON.stringify(text.slice(start, start + length));
        const bytes = utf8Length(piece);
        if (bytes <= room) {
          pieces.push({ text: piece, bytes });
          ratio = bytes / length;
          start += length;
          break;
        }
        length = Math.max(1, length - (bytes - room), Math.floor(length * aim / bytes));
      }
    }
    return pieces.map((piece, index) => {
      const envelope = chunkFrame(id, index, pieces.length, "");
      return { text: chunkFrame(id, index, pieces.length, piece.text), bytes: utf8Length(envelope) + piece.bytes };
    });
  }
  function chunkFrame(id, index, count, encodedData) {
    return `{"type":"chunk","id":${JSON.stringify(id)},"index":${index},"count":${count},"data":${encodedData}}`;
  }
  function withoutSplitPair(text, start, length) {
    const end = start + length;
    const splitsPair = end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end));
    if (!splitsPair) return length;
    return length > 1 ? length - 1 : 2;
  }
  function isHighSurrogate(unit) {
    return unit >= 55296 && unit <= 56319;
  }
  function isLowSurrogate(unit) {
    return unit >= 56320 && unit <= 57343;
  }
  var CHUNK_LIMITS = { maxLength: MAX_CHUNKED_LENGTH, maxChunks: MAX_CHUNKS };
  var Reassembly = class {
    constructor() {
      __publicField(this, "messages", /* @__PURE__ */ new Map());
      /** Code units held: the messages' ids and their chunks' data. */
      __publicField(this, "heldLength", 0);
      /** Chunks the messages have between them, counting those yet to arrive. */
      __publicField(this, "heldChunks", 0);
      __publicField(this, "problem");
    }
    add(chunk, limits) {
      if (this.problem === void 0) this.problem = this.problemWith(chunk, limits);
      if (this.problem !== void 0) {
        this.messages.clear();
        this.heldLength = 0;
        this.heldChunks = 0;
        return { status: "invalid", problem: this.problem };
      }
      let message = this.messages.get(chunk.id);
      if (message?.parts[chunk.index] !== void 0) return { status: "incomplete" };
      if (!message) {
        message = { count: chunk.count, parts: new Array(chunk.count), received: 0, length: chunk.id.length };
        this.messages.set(chunk.id, message);
        this.heldLength += chunk.id.length;
        this.heldChunks += chunk.count;
      }
      message.parts[chunk.index] = chunk.data;
      message.received++;
      message.length += chunk.data.length;
      this.heldLength += chunk.data.length;
      if (message.received < message.count) return { status: "incomplete" };
      this.messages.delete(chunk.id);
      this.heldLength -= message.length;
      this.heldChunks -= message.count;
      return { status: "complete", text: message.parts.join("") };
    }
    /** Why the chunk cannot be added, by field and never by value, or undefined if it can. */
    problemWith(chunk, limits) {
      const { index, count, data } = chunk;
      if (!Number.isInteger(count) || count < 1 || count > limits.maxChunks) {
        return `chunk.count must be a whole number from 1 to ${limits.maxChunks}`;
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) return "chunk.index must be a whole number below chunk.count";
      const message = this.messages.get(chunk.id);
      if (message && message.count !== count) return "chunk.count differs from an earlier chunk of the same message";
      const held = message?.parts[index];
      if (held !== void 0) return held === data ? void 0 : "chunk.data differs from an earlier copy of the same chunk";
      const length = data.length + (message ? 0 : chunk.id.length);
      const chunks = message ? 0 : count;
      if (this.heldLength + length > limits.maxLength || this.heldChunks + chunks > limits.maxChunks) {
        return `Chunked messages still incomplete may hold at most ${limits.maxLength} characters, ids included, and ${limits.maxChunks} chunks between them`;
      }
      return void 0;
    }
  };

  // ../protocol/src/index.ts
  var PROTOCOL_VERSION = 1;
  var SYNC_PATH = "/sync";
  var MISSED_HEARTBEATS = 3;
  var MAX_ID_LENGTH = 128;
  var MAX_RECORD_ID_LENGTH = 128;
  function isRecordId(value) {
    return typeof value === "string" && value !== "" && value.length <= MAX_RECORD_ID_LENGTH && !value.includes("\0");
  }
  var CLOSE_CODES = {
    /** A frame that is not a valid message here, including no `hello` in time. */
    protocol_error: 4e3,
    /** The token is unknown or has been revoked. */
    bad_token: 4001,
    /** The plugin speaks a protocol version older than the server supports. */
    plugin_too_old: 4002,
    /**
     * A connection from another tablet took over with the same token. The
     * plugin waits, then connects only with a `yielding` hello.
     */
    replaced: 4003,
    /**
     * An Admin dismissed the hardware this tablet reports for this token: its
     * machine is not the one the token was issued for.
     */
    hardware_dismissed: 4004,
    /** The tablet runs a Decaid older than the server supports. */
    decaid_too_old: 4005,
    /**
     * A `yielding` hello was refused because a live connection from another
     * tablet holds the Machine. The plugin waits, then tries again the same way.
     */
    machine_held: 4006,
    /**
     * This connection no longer holds its Machine, but no other tablet's does:
     * another connection from this tablet does, as when it reconnected while
     * the server still held this one, or none does. The plugin reconnects.
     */
    superseded: 4007
  };
  function sameHardware(a, b) {
    if (a === null || b === null) return a === b;
    return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
  }
  function isUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }
  function isTabletId(value) {
    return isUuid(value);
  }
  function isGlobalId(value) {
    return isUuid(value);
  }
  var GLOBAL_ID_KEY = "decentSyncId";
  function beanMatchKey(roaster, name) {
    return JSON.stringify([roaster.trim().toLowerCase(), name.trim().toLowerCase()]);
  }
  function sameValue(a, b) {
    if (a === void 0) a = null;
    if (b === void 0) b = null;
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
    }
    if (!isObject(a) || !isObject(b)) return false;
    const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  function globalIdOf(record) {
    const extras = isObject(record) ? record.extras : void 0;
    const id = isObject(extras) ? extras[GLOBAL_ID_KEY] : void 0;
    return isGlobalId(id) ? id.toLowerCase() : null;
  }
  var DYE2_NAMESPACE = "dye2.reaplugin";
  var DYE2_LISTS = { dye2Recipes: "recipes", dye2Equipment: "equipment", dye2Baskets: "baskets" };
  function isDye2List(name) {
    return Object.prototype.hasOwnProperty.call(DYE2_LISTS, name);
  }
  function dye2Records(value) {
    if (!Array.isArray(value)) return null;
    const ids = /* @__PURE__ */ new Set();
    for (const record of value) {
      if (!isObject(record) || !isRecordId(record.id) || ids.has(record.id)) return null;
      ids.add(record.id);
    }
    return value;
  }
  var RECIPE_SLOTS = 5;
  function isRecipeSlot(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= RECIPE_SLOTS;
  }
  var RECIPE_SLOT_FIELD = "stripSlot";
  var RECIPE_SETTINGS = {
    steamTemperature: { dye2: "steamTempC", workflow: "steamSettings.targetTemperature", whole: true },
    steamDuration: { dye2: "steamTimeS", workflow: "steamSettings.duration", whole: true },
    steamFlow: { dye2: "steamFlowMls", workflow: "steamSettings.flow", whole: false },
    steamStopTemperature: { dye2: "steamStopAtTempC", workflow: "steamSettings.stopAtTemperature", whole: false },
    hotWaterTemperature: { dye2: "hotWaterTempC", workflow: "hotWaterData.targetTemperature", whole: true },
    hotWaterDuration: { dye2: "hotWaterTimeS", workflow: "hotWaterData.duration", whole: true },
    hotWaterVolume: { dye2: "hotWaterMl", workflow: "hotWaterData.volume", whole: true },
    hotWaterFlow: { dye2: "hotWaterFlowMls", workflow: "hotWaterData.flow", whole: false },
    flushTemperature: { dye2: "flushTempC", workflow: "rinseData.targetTemperature", whole: true },
    flushDuration: { dye2: "flushS", workflow: "rinseData.duration", whole: true },
    flushFlow: { dye2: "flushFlowMls", workflow: "rinseData.flow", whole: false }
  };
  var RECIPE_SETTING_NAMES = Object.keys(RECIPE_SETTINGS);
  var MACHINE_SETTING_PARTS = ["steamSettings", "hotWaterData", "rinseData"];
  function steamOff(workflow) {
    const temperature = workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow);
    return typeof temperature === "number" && temperature < STEAM_ON_FROM;
  }
  function dye2GlobalIdOf(record) {
    const id = isObject(record) ? record[GLOBAL_ID_KEY] : void 0;
    return isGlobalId(id) ? id.toLowerCase() : null;
  }
  function equipmentMatchKey(name) {
    return name.trim().toLowerCase();
  }
  var GLOBAL_ITEM_ID = { test: isGlobalId, problem: "must be a UUID" };
  var LIBRARY_ITEM_KINDS = {
    bean: { list: "beans", id: GLOBAL_ITEM_ID },
    beanBatch: { list: "beanBatches", id: GLOBAL_ITEM_ID, under: "bean" },
    grinder: { list: "grinders", id: GLOBAL_ITEM_ID },
    profile: { list: "profiles", id: { test: isRecordId, problem: `must be a Profile's id of 1 to ${MAX_RECORD_ID_LENGTH} characters without NUL` } },
    basket: { list: "dye2Baskets", id: GLOBAL_ITEM_ID, dye2Key: "baskets" },
    tool: { list: "dye2Equipment", id: GLOBAL_ITEM_ID, dye2Key: "equipment" },
    recipe: { list: "dye2Recipes", id: GLOBAL_ITEM_ID, dye2Key: "recipes" }
  };
  var LIBRARY_KINDS = Object.keys(LIBRARY_ITEM_KINDS);
  function isLibraryKind(kind) {
    return Object.prototype.hasOwnProperty.call(LIBRARY_ITEM_KINDS, kind);
  }
  var LIBRARY_LISTS = LIBRARY_KINDS.map((kind) => LIBRARY_ITEM_KINDS[kind].list);
  function isLibraryList(name) {
    return LIBRARY_LISTS.includes(name);
  }
  function dye2Key(kind) {
    const description = LIBRARY_ITEM_KINDS[kind];
    return description.dye2Key;
  }
  function listKind(list) {
    return LIBRARY_KINDS.find((kind) => LIBRARY_ITEM_KINDS[kind].list === list);
  }
  function parentKind(kind) {
    const { under } = LIBRARY_ITEM_KINDS[kind];
    if (under === void 0) return void 0;
    const parent = isLibraryKind(under) ? LIBRARY_ITEM_KINDS[under] : void 0;
    if (!isLibraryKind(under) || LIBRARY_KINDS.indexOf(under) >= LIBRARY_KINDS.indexOf(kind) || parent?.under !== void 0) {
      throw new Error(`A ${kind}'s records are made under ${under}, which is no kind listed before it whose records are made under none`);
    }
    return under;
  }
  function childKinds(kind) {
    return LIBRARY_KINDS.filter((child) => parentKind(child) === kind);
  }
  function parentList(list) {
    const parent = parentKind(listKind(list));
    return parent === void 0 ? void 0 : LIBRARY_ITEM_KINDS[parent].list;
  }
  var REMOVAL_ORDER = LIBRARY_KINDS.filter((kind) => parentKind(kind) === void 0).flatMap((kind) => [...childKinds(kind), kind]);
  var WORKFLOW_KIND = "workflow";
  var WORKFLOW_GRINDER = ["context.grinderId", "context.grinderModel", "context.grinderBurrs"];
  var WORKFLOW_BATCH = ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"];
  var WORKFLOW_BASKET = ["context.extras.basketId", "context.extras.basketName"];
  var WORKFLOW_CLEARED = [WORKFLOW_GRINDER, WORKFLOW_BATCH, WORKFLOW_BASKET];
  var DYE2_RECIPE_FIELD = "context.extras.dye.recipeId";
  function dye2RecipeIdOf(workflow) {
    const id = workflowValueAt(workflow, DYE2_RECIPE_FIELD);
    if (typeof id === "number") return Number.isFinite(id) ? String(id) : null;
    return typeof id === "string" && id !== "" ? id : null;
  }
  function dye2Fingerprint(profile) {
    if (!isObject(profile)) return null;
    const steps = Array.isArray(profile.steps) ? profile.steps.map((step) => {
      if (!isObject(step)) return step;
      const { temperature: _, limiter, ...rest } = step;
      return { ...rest, limiter: Boolean(limiter) && Number(isObject(limiter) ? limiter.value : void 0) !== 0 ? limiter : null };
    }) : profile.steps;
    return JSON.stringify({ title: profile.title, tank_temperature: profile.tank_temperature, steps });
  }
  var LOADED_RECIPE_KIND = "loadedRecipe";
  var BREW_TEMPERATURE_FIELD = "profile.steps.0.temperature";
  function profileAtBrewTemperature(profile, temperature) {
    if (!isObject(profile) || !Array.isArray(profile.steps)) return null;
    const steps = profile.steps;
    const temperatures = shiftedTemperatures(steps.map((step) => isObject(step) ? step.temperature : void 0), temperature);
    if (temperatures === null) return null;
    return { ...profile, steps: steps.map((step, index) => isObject(step) ? { ...step, temperature: temperatures[index] } : step) };
  }
  function shiftedTemperatures(base, first) {
    const origin = base[0];
    if (base.length === 0 || !Number.isFinite(first) || typeof origin !== "number" || !Number.isFinite(origin)) return null;
    const shift = first - origin;
    const round = (value) => Math.round(value * 100) / 100;
    return base.map((value) => typeof value === "number" && Number.isFinite(value) ? round(value + shift) : round(first));
  }
  var LOADED_RECIPE_PARTS = {
    profile: ["profile"],
    grinder: ["context.grinderId", "context.grinderModel"],
    dose: ["context.targetDoseWeight"],
    yield: ["context.targetYield"],
    grind: ["context.grinderSetting"],
    rpm: ["context.extras.rpm"],
    basket: ["context.extras.basketId", "context.extras.basketName"],
    batch: ["context.beanBatchId", "context.coffeeName", "context.coffeeRoaster"],
    brewTemperature: [BREW_TEMPERATURE_FIELD],
    steamTemperature: [RECIPE_SETTINGS.steamTemperature.workflow],
    steamDuration: [RECIPE_SETTINGS.steamDuration.workflow],
    steamFlow: [RECIPE_SETTINGS.steamFlow.workflow],
    steamStopTemperature: [RECIPE_SETTINGS.steamStopTemperature.workflow],
    hotWaterTemperature: [RECIPE_SETTINGS.hotWaterTemperature.workflow],
    hotWaterDuration: [RECIPE_SETTINGS.hotWaterDuration.workflow],
    hotWaterVolume: [RECIPE_SETTINGS.hotWaterVolume.workflow],
    hotWaterFlow: [RECIPE_SETTINGS.hotWaterFlow.workflow],
    flushTemperature: [RECIPE_SETTINGS.flushTemperature.workflow],
    flushDuration: [RECIPE_SETTINGS.flushDuration.workflow],
    flushFlow: [RECIPE_SETTINGS.flushFlow.workflow]
  };
  function workflowValueAt(workflow, path) {
    let value = workflow;
    for (const name of path.split(".")) value = isObject(value) ? value[name] : Array.isArray(value) && /^\d+$/.test(name) ? value[Number(name)] : void 0;
    return value;
  }
  function workflowPatch(fields) {
    const patch = {};
    for (const [path, value] of Object.entries(fields)) {
      const names = path.split(".");
      let target = patch;
      for (const name of names.slice(0, -1)) {
        if (!isObject(target[name])) target[name] = {};
        target = target[name];
      }
      target[names[names.length - 1]] = value;
    }
    return patch;
  }
  function itemIdRule(kind) {
    return isLibraryKind(kind) ? LIBRARY_ITEM_KINDS[kind].id : GLOBAL_ITEM_ID;
  }
  var STEAM_ON_FROM = 135;
  var ANOTHER_ITEMS_RECORD = "The record carries another item's global id";
  var RECORD_CHANGED = "The record changed since the plugin last read the list";
  var SHOTS_STILL_TO_READ = "More Shots are still to be sent than a delete reads; ask again once they are";
  var MAX_REFUSAL_LENGTH = 1e3;
  function encode(message) {
    return JSON.stringify(message);
  }
  function decodeMachineEvent(text) {
    const object3 = parseObject(text);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type !== "workflow" && object3.type !== "machineState") return invalid("Not a Workflow or machine state delivery");
    return checkMachineEvent(object3);
  }
  function checkMachineEvent(object3) {
    if (object3.type === "workflow") {
      return check(object3, "workflow", (fields) => {
        fields.id();
        fields.instant("observedAt");
        fields.objectField("workflow");
        fields.optionalBoolean("dye2Absent");
      });
    }
    return check(object3, "machineState", (fields) => {
      fields.id();
      fields.instant("observedAt");
      fields.string("state", { nonEmpty: true });
      fields.string("substate", { nonEmpty: true });
    });
  }
  function decodeServerFrame(frame) {
    const object3 = parseObject(frame);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type !== "chunk") return decodeServerObject(object3);
    return check(object3, "chunk", (fields) => {
      fields.id();
      fields.integer("index", { nonNegative: true });
      fields.integer("count", { positive: true });
      fields.string("data");
    });
  }
  function decodeServerMessage(text) {
    const object3 = parseObject(text);
    if (typeof object3 === "string") return invalid(object3);
    if (object3.type === "chunk") return invalid("A chunked message must not be a chunk itself");
    return decodeServerObject(object3);
  }
  function decodeServerObject(object3) {
    switch (object3.type) {
      case "welcome":
        return check(object3, "welcome", (fields) => {
          fields.integer("protocolVersion");
          fields.integer("heartbeatIntervalMs", { positive: true });
        });
      case "ack":
        return check(object3, "ack", (fields) => fields.string("id", { nonEmpty: true }));
      case "chunkReceived":
        return check(object3, "chunkReceived", (fields) => {
          fields.string("id", { nonEmpty: true });
          fields.integer("index", { nonNegative: true });
        });
      case "requestShots":
        return check(object3, "requestShots", (fields) => {
          fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "requestSteams":
        return check(object3, "requestSteams", (fields) => {
          fields.array("steamIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "requestCollections":
        return check(object3, "requestCollections", () => {
        });
      case "captureOnly":
        return check(object3, "captureOnly", (fields) => fields.boolean("captureOnly"));
      case "heartbeat":
        return check(object3, "heartbeat", () => {
        });
      case "error":
        return check(object3, "error", (fields) => {
          fields.string("code");
          fields.string("message");
        });
      case "write":
        return check(object3, "write", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.itemId("globalId", object3.kind);
          if (object3.localId !== null) fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
          fields.objectField("fields");
          if (object3.expected !== void 0) fields.objectField("expected");
          if (object3.contentDecidedAt !== void 0) fields.instant("contentDecidedAt");
        });
      case "delete":
        return check(object3, "delete", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.itemId("globalId", object3.kind);
          fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        });
      case "remove":
        return check(object3, "remove", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.itemId("globalId", object3.kind);
          fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
          if (object3.expected !== void 0) fields.objectField("expected");
        });
      case "leaveOut":
        return check(object3, "leaveOut", (fields) => {
          fields.id();
          fields.string("kind", { nonEmpty: true });
          fields.string("localId", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
        });
      default:
        return invalid("Unknown message type");
    }
  }
  var FieldChecker = class _FieldChecker {
    constructor(object3, path, problems) {
      __publicField(this, "object", object3);
      __publicField(this, "path", path);
      __publicField(this, "problems", problems);
    }
    string(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "string") this.problem(key, "must be a string");
      else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key, `must be at most ${options.maxLength} characters`);
      }
    }
    /** The id of a delivery or a chunk. */
    id() {
      this.string("id", { nonEmpty: true, maxLength: MAX_ID_LENGTH });
    }
    /** A UUID, in either case, as a tablet id is. */
    uuid(key) {
      if (!isTabletId(this.object[key])) this.problem(key, "must be a UUID");
    }
    /** The id of an item of the kind given, as that kind declares its ids (`itemIdRule`). */
    itemId(key, kind) {
      const rule = itemIdRule(String(kind));
      if (!rule.test(this.object[key])) this.problem(key, rule.problem);
    }
    optionalString(key, options = {}) {
      const value = this.object[key];
      if (value === void 0 || value === null) return;
      if (typeof value !== "string") this.problem(key, "must be a string or null");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key, `must be at most ${options.maxLength} characters`);
      }
    }
    integer(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
      else if (options.positive && value <= 0) this.problem(key, "must be positive");
      else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
    }
    /** One of `values`. */
    oneOf(key, values) {
      if (!values.includes(this.object[key])) this.problem(key, `must be one of ${values.join(", ")}`);
    }
    boolean(key) {
      if (typeof this.object[key] !== "boolean") this.problem(key, "must be true or false");
    }
    optionalBoolean(key) {
      const value = this.object[key];
      if (value !== void 0 && typeof value !== "boolean") this.problem(key, "must be true or false");
    }
    objectField(key) {
      if (!isObject(this.object[key])) this.problem(key, "must be an object");
    }
    /** Any JSON value but null. */
    present(key) {
      const value = this.object[key];
      if (value === void 0 || value === null) this.problem(key, "must be present and not null");
    }
    absent(key) {
      if (this.object[key] !== void 0) this.problem(key, "must be absent");
    }
    /** A UTC instant as `Date.prototype.toISOString` writes it. Read back, it must be written the same, so times that do not exist, which Date rolls over, are refused. */
    instant(key) {
      if (!isInstant(this.object[key])) this.problem(key, "must be a UTC time such as 2026-10-05T14:07:03.341Z");
    }
    /**
     * An array of `length` UTC instants, as `instant` reads one, or nulls. A
     * `length` below zero says there is nothing for it to go beside.
     */
    instants(key, length) {
      const value = this.object[key];
      if (length < 0) this.problem(key, "must be absent unless value is a list");
      else if (!Array.isArray(value) || value.length !== length || !value.every((entry) => entry === null || isInstant(entry))) {
        this.problem(key, "must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls");
      }
    }
    array(key, valid, max) {
      const value = this.object[key];
      if (!Array.isArray(value) || value.length > max || !value.every(valid)) {
        this.problem(key, `must be an array of at most ${max} valid entries`);
      }
    }
    optionalObject(key, checkFields) {
      const value = this.object[key];
      if (value === void 0 || value === null) return;
      if (!isObject(value)) {
        this.problem(key, "must be an object or null");
        return;
      }
      checkFields(new _FieldChecker(value, `${this.path}.${key}`, this.problems));
    }
    problem(key, what) {
      this.problems.push(`${this.path}.${key} ${what}`);
    }
  };
  function check(object3, type, checkFields) {
    const fields = new FieldChecker(object3, type, []);
    checkFields(fields);
    if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
    return { ok: true, message: object3 };
  }
  function parseObject(frame) {
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      return "The frame is not JSON";
    }
    if (!isObject(value)) return "A message must be a JSON object";
    if (typeof value.type !== "string") return "A message must have a string type";
    return value;
  }
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isInstant(value) {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
  }
  function invalid(problem) {
    return { ok: false, error: "protocol_error", problem };
  }

  // src/change-detection.ts
  function ifNoneMatch(last) {
    return last?.available ? last.etag : null;
  }
  function decide(last, reading, full) {
    switch (reading.kind) {
      case "notModified":
        return { send: false, next: last };
      case "unavailable":
        return { send: full || last?.available !== false, next: { available: false } };
      case "value": {
        const next = reading.etag !== null ? { available: true, etag: reading.etag, hash: null } : { available: true, etag: null, hash: contentHash(JSON.stringify(reading.value)) };
        return { send: full || !sameFingerprint(last, next), next };
      }
    }
  }
  function pairedDevices(inventory) {
    if (!Array.isArray(inventory)) return null;
    return inventory.filter((device) => !(typeof device === "object" && device !== null && device.state === "discovered"));
  }
  var FirstReads = class {
    constructor() {
      __publicField(this, "known", /* @__PURE__ */ new Map());
    }
    /** Each record's time, in the order of the list read at `now`, a UTC time: null for one without a string id. */
    times(records, now2) {
      const next = /* @__PURE__ */ new Map();
      const times = records.map((record) => {
        const id = typeof record === "object" && record !== null && !Array.isArray(record) ? record.id : void 0;
        if (typeof id !== "string") return null;
        const hash = contentHash(JSON.stringify(record));
        const before = this.known.get(id);
        const at = before?.hash === hash ? before.at : now2;
        next.set(id, { hash, at });
        return at;
      });
      this.known = next;
      return times;
    }
  };
  function contentHash(text) {
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return `${text.length}:${hex(h2)}${hex(h1)}`;
  }
  function sameFingerprint(a, b) {
    if (!a?.available || !b.available) return a?.available === b.available;
    return a.etag === b.etag && a.hash === b.hash;
  }
  function hex(half) {
    return (half >>> 0).toString(16).padStart(8, "0");
  }

  // src/decaid.ts
  var API = "http://localhost:8080/api/v1";
  async function readTabletIdentity() {
    const [info, settings, machine] = await Promise.all([getObject("/info"), getObject("/settings"), readMachineHardware()]);
    return {
      decaidVersion: stringField(info, "fullVersion"),
      // Decaid keeps the preferred machine's id, so it is known before the machine connects.
      connectionId: stringField(settings, "preferredMachineId"),
      machine
    };
  }
  async function readMachineHardware() {
    return readHardware(await getObject("/machine/info"));
  }
  function readHardware(info) {
    const model = info?.model;
    const serial = info?.serialNumber;
    if (typeof model !== "string" || typeof serial !== "string") return null;
    return { model, serial, firmware: stringField(info, "version") };
  }
  async function getObject(path) {
    try {
      const response = await fetch(API + path);
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  function stringField(object3, key) {
    const value = object3?.[key];
    return typeof value === "string" && value !== "" ? value : null;
  }
  async function readShotPage(limit, offset) {
    const page = await getObject(`/shots?limit=${limit}&offset=${offset}&order=desc`);
    return Array.isArray(page?.items) && typeof page.total === "number" ? { items: page.items, total: page.total } : null;
  }
  function readShot(id) {
    return readRecord("shots", id);
  }
  function readSteam(id) {
    return readRecord("steams", id);
  }
  async function readSteamIds() {
    const response = await fetch(`${API}/steams/ids`);
    if (!response.ok) throw new Error(`Decaid answered ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Decaid's answer is not a list");
    return body.filter(isRecordId);
  }
  async function readLatestSteamId() {
    const response = await fetch(`${API}/steams/latest`);
    if (!response.ok) throw new Error(`Decaid answered ${response.status}`);
    const body = await response.json();
    if (body === null) return null;
    if (typeof body !== "object" || Array.isArray(body)) throw new Error("Decaid's answer is not a Steam Record");
    const id = body.id;
    return isRecordId(id) ? id : null;
  }
  async function readRecord(collection, id) {
    const response = await fetch(`${API}/${collection}/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Record unavailable");
    const body = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Record response unavailable");
    return body;
  }
  async function keepStorageInBackups() {
    try {
      return (await fetch(`${API}/store/${encodeURIComponent("decent-sync.reaplugin")}`)).ok;
    } catch {
      return false;
    }
  }
  async function readCollection(path, etag, emptyWhenNull = false) {
    try {
      const response = await fetch(API + path, etag === null ? void 0 : { headers: { "If-None-Match": etag } });
      if (response.status === 304) return { kind: "notModified" };
      if (!response.ok) return { kind: "unavailable" };
      const value = await response.json();
      if (value === null) return emptyWhenNull ? { kind: "value", value: [], etag: null } : { kind: "unavailable" };
      return { kind: "value", value, etag: response.headers.get("etag") };
    } catch {
      return { kind: "unavailable" };
    }
  }
  async function request(method, path, body) {
    const response = await fetch(
      API + path,
      body === void 0 ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    return { status: response.status, ok: response.ok, text: await response.text() };
  }

  // src/local-time.ts
  var ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/;
  function utcTime(timestamp) {
    const match = typeof timestamp === "string" ? ISO_TIME.exec(timestamp) : null;
    if (!match) return null;
    const parts = match.slice(1, 7).map(Number);
    const [year, month, day, hour, minute, second] = parts;
    const ms = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
    const offset = match[8];
    if (offset === void 0) {
      const local = new Date(year, month - 1, day, hour, minute, second, ms);
      const readBack2 = [local.getFullYear(), local.getMonth() + 1, local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds()];
      return readBack2.every((part, index) => part === parts[index]) ? local.toISOString() : null;
    }
    const minutes = offsetMinutes(offset);
    const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
    const readBack = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds()];
    if (minutes === null || !readBack.every((part, index) => part === parts[index])) return null;
    return new Date(utc.getTime() - minutes * 6e4).toISOString();
  }
  function offsetMinutes(offset) {
    if (offset === "Z") return 0;
    const hours = Number(offset.slice(1, 3));
    const minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    return (offset.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
  }

  // src/loaded-recipe-rules.ts
  function profileKey(profile) {
    const steps = isObject2(profile) ? stepsKey(profile.steps) : null;
    if (steps === null || !isObject2(profile)) return null;
    const hashed = Object.fromEntries(HASHED.map((field) => [field, profile[field] ?? null]));
    return stableJson({ ...hashed, steps: JSON.parse(steps) });
  }
  var HASHED = ["version", "beverage_type", "tank_temperature", "target_volume", "target_volume_count_start"];
  function stepsKey(steps) {
    if (!Array.isArray(steps)) return null;
    return stableJson(
      steps.map((step) => {
        if (!isObject2(step)) return step;
        const { temperature: _, ...rest } = step;
        return isObject2(rest.limiter) && rest.limiter.value === 0 ? { ...rest, limiter: null } : rest;
      })
    );
  }
  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isObject2(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value ?? null);
  }
  function changesProfile(workflow, write) {
    return isObject2(write.profile) && dye2Fingerprint(write.profile) !== dye2Fingerprint(workflow.profile);
  }
  function withRecipe(write, recordId) {
    const named = workflowPatch({ [DYE2_RECIPE_FIELD]: recordId });
    return merged(write, named);
  }
  function clearRecipe() {
    return workflowPatch({ [DYE2_RECIPE_FIELD]: null });
  }
  function merged(earlier, later) {
    const result = { ...earlier };
    for (const [key, value] of Object.entries(later)) {
      const kept = result[key];
      result[key] = isObject2(kept) && isObject2(value) && key !== "profile" ? merged(kept, value) : value;
    }
    return result;
  }
  function loadable(records) {
    return new Map(
      records.flatMap((record) => {
        const globalId = dye2GlobalIdOf(record);
        return globalId !== null && typeof record.id === "string" ? [[record.id, { globalId, record }]] : [];
      })
    );
  }
  function vacatedIds(before, after) {
    const now2 = new Map(after.flatMap((record) => typeof record.id === "string" ? [[record.id, record]] : []));
    return before.flatMap((record) => {
      if (typeof record.id !== "string") return [];
      const was = dye2GlobalIdOf(record);
      const is = now2.get(record.id);
      return is === void 0 || was !== null && dye2GlobalIdOf(is) !== was ? [record.id] : [];
    });
  }
  function loadWrite(workflow, record, load, omit = /* @__PURE__ */ new Set()) {
    const context = isObject2(workflow.context) ? workflow.context : {};
    const extras = isObject2(context.extras) ? context.extras : {};
    const variables = isObject2(record.dashboardVariables) ? record.dashboardVariables : {};
    const contextWrite = {};
    const extrasWrite = {};
    const dose = numberOf(variables.dose);
    if (dose !== null && !sameNumber(dose, numberOf(context.targetDoseWeight)) && !omit.has("dose")) contextWrite.targetDoseWeight = dose;
    const ratio = numberOf(variables.ratio);
    const yieldValue = numberOf(variables.drink) ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : null);
    if (yieldValue !== null && !sameNumber(yieldValue, numberOf(context.targetYield)) && !omit.has("yield")) contextWrite.targetYield = yieldValue;
    const grind = grindOf(variables.grind);
    if (grind !== null && !sameGrind(grind, grindOf(context.grinderSetting)) && !omit.has("grind")) contextWrite.grinderSetting = grind;
    const grinder = textOf(variables.grinderId);
    if (grinder !== null && grinder !== textOf(context.grinderId) && !omit.has("grinder")) {
      contextWrite.grinderId = grinder;
      if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
    }
    const rpm = numberOf(variables.rpm);
    if (rpm !== null && !sameNumber(rpm, numberOf(extras.rpm)) && !omit.has("rpm")) extrasWrite.rpm = rpm;
    const basket = textOf(variables.basketId);
    if (basket !== null && basket !== textOf(extras.basketId) && !omit.has("basket")) {
      extrasWrite.basketId = basket;
      if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
    }
    const batch = textOf(record.beanBatchId);
    if (batch !== null && batch !== textOf(context.beanBatchId) && !omit.has("batch")) {
      contextWrite.beanBatchId = batch;
      if (textOf(record.beanName) !== null) contextWrite.coffeeName = record.beanName;
      if (textOf(record.beanRoaster) !== null) contextWrite.coffeeRoaster = record.beanRoaster;
    }
    if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;
    const write = {};
    if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
    const key = profileKey(load.profile);
    if (!omit.has("profile") && key !== null && key !== profileKey(workflow.profile)) write.profile = load.profile;
    const settings = RECIPE_SETTING_NAMES.flatMap((setting) => {
      const { dye2, workflow: path } = RECIPE_SETTINGS[setting];
      const value = numberOf(variables[dye2]);
      if (value === null || sameNumber(value, numberOf(workflowValueAt(workflow, path)))) return [];
      if (setting === "steamTemperature" && steamOff(workflow)) return [];
      return omit.has(setting) ? [] : [[path, value]];
    });
    Object.assign(write, workflowPatch(Object.fromEntries(settings)));
    return Object.keys(write).length > 0 ? write : null;
  }
  function numberOf(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
    return null;
  }
  function grindOf(value) {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
    return typeof value === "string" && value.trim() !== "" ? value : null;
  }
  function textOf(value) {
    return typeof value === "string" && value !== "" ? value : null;
  }
  function sameNumber(a, b) {
    return a === null || b === null ? a === b : Math.abs(a - b) < 1e-9;
  }
  function sameGrind(a, b) {
    if (a === null || b === null) return a === b;
    const [x, y] = [numberOf(a), numberOf(b)];
    return x !== null && y !== null ? sameNumber(x, y) : a.trim() === b.trim();
  }
  function isObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/dye2.ts
  var CHANGED_SOCKET = `ws://localhost:8080/ws/v1/plugins/${DYE2_NAMESPACE}/changed`;
  var RECORD = `/plugins/${DYE2_NAMESPACE}/record`;
  async function recordIntoRecipe() {
    const answer = await request("POST", RECORD, {});
    if (answer.status === 404) return "unavailable";
    const value = answer.ok ? parsed(answer.text) : void 0;
    if (!isObject3(value)) throw new Error(`Decaid answered ${answer.status} asking DYE2 to save into its recipe: ${answer.text.slice(0, 200)}`);
    return value.saved === true ? "saved" : "unchanged";
  }
  async function readDye2State() {
    const answer = await request("GET", "/plugins");
    const value = answer.ok ? parsed(answer.text) : void 0;
    if (!Array.isArray(value)) throw new Error(`Decaid answered ${answer.status} listing its plugins`);
    const dye2 = value.find((plugin) => isObject3(plugin) && plugin.id === DYE2_NAMESPACE);
    if (!dye2) return "absent";
    if (dye2.loaded === true) return "loaded";
    return dye2.autoLoad === false ? "disabled" : "notLoaded";
  }
  var Dye2Pushes = class {
    constructor(transports, pushed) {
      __publicField(this, "transports", transports);
      __publicField(this, "pushed", pushed);
      __publicField(this, "handle");
      __publicField(this, "opening", false);
      __publicField(this, "stopped", false);
    }
    /** Opens the socket unless it is open or opening. */
    keepOpen() {
      if (this.handle !== void 0 || this.opening || this.stopped) return;
      this.opening = true;
      this.transports.open(CHANGED_SOCKET).then(
        (handle) => {
          this.opening = false;
          if (this.stopped) {
            this.transports.close(handle);
            return;
          }
          this.handle = handle;
          this.transports.onEvent(handle, (event) => {
            if (handle !== this.handle) return;
            if (event.type === "data") this.pushed();
            else this.closed(handle);
          });
        },
        () => {
          this.opening = false;
        }
      );
    }
    stop() {
      this.stopped = true;
      if (this.handle !== void 0) this.closed(this.handle);
    }
    closed(handle) {
      this.handle = void 0;
      this.transports.close(handle);
    }
  };
  function parsed(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/streamline.ts
  var PATH = "/store/streamline-app/last-steam-temp";
  async function keepStreamlineSteamTemperature(temperature, log) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < STEAM_ON_FROM) return;
    try {
      const held = await request("GET", PATH);
      if (!held.ok) {
        log(`Could not read Streamline's last-steam-temp: Decaid answered ${held.status}. Streamline may set the steam temperature back.`);
        return;
      }
      const stored = parsed2(held.text);
      if (stored === null || stored === temperature) return;
      if (typeof stored !== "number" || !Number.isFinite(stored)) {
        log("Streamline's last-steam-temp holds something other than a number, so it is left as it is.");
        return;
      }
      const set = await request("POST", PATH, temperature);
      if (!set.ok) log(`Could not set Streamline's last-steam-temp: Decaid answered ${set.status}. Streamline may set the steam temperature back.`);
    } catch (error) {
      log(`Could not set Streamline's last-steam-temp: Decaid did not answer (${error instanceof Error ? error.message : String(error)}). Streamline may set the steam temperature back.`);
    }
  }
  function parsed2(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }

  // src/loaded-recipes.ts
  var RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;
  var LoadedRecipes = class {
    constructor(changes, library, log, transports, pollMs, pushed = () => {
    }, reportRecipes = async () => {
    }, workflowWritten = () => {
    }) {
      __publicField(this, "changes", changes);
      __publicField(this, "library", library);
      __publicField(this, "log", log);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "pushed", pushed);
      __publicField(this, "reportRecipes", reportRecipes);
      __publicField(this, "workflowWritten", workflowWritten);
      /** The latest Workflow Decaid reported, or answered a write of the plugin's with. */
      __publicField(this, "latest");
      /**
       * The Loaded Recipe, by its global id, as the plugin last decided on the
       * Workflow, null for none; undefined until it first decides, which takes
       * the Recipe the Workflow names as the one the server has loaded already,
       * writing nothing for it.
       */
      __publicField(this, "loaded");
      /** The tablet's records that can be a Loaded Recipe, by their ids there, as last read; null until first read. */
      __publicField(this, "records", null);
      __publicField(this, "dye2", "unknown");
      /** When DYE2 was first seen not loaded, since it was last loaded. */
      __publicField(this, "notLoadedSince", null);
      __publicField(this, "captureOnly", false);
      /** How many writes of the plugin's into the Workflow are under way (`ownWrite`). */
      __publicField(this, "writing", 0);
      /**
       * During the writes under way: whether Decaid reported a change of the
       * Workflow, the latest Workflow it answered them with, the Workflow the
       * plugin last knew before them, and the fields they set.
       */
      __publicField(this, "duringWrite", {
        reported: false,
        answered: void 0,
        before: void 0,
        written: /* @__PURE__ */ new Set()
      });
      /** How many loads the plugin has decided on, so a save asked for before one is not made after it. */
      __publicField(this, "loads", 0);
      /**
       * The save into the Loaded Recipe waiting its turn, with the Recipe, load
       * and profile of the change that asked for it: one more change of the same
       * needs none of its own, as DYE2 saves the Workflow as it is then.
       */
      __publicField(this, "queuedSave", null);
      __publicField(this, "chain", Promise.resolve());
      __publicField(this, "pollTimer");
      __publicField(this, "stopped", false);
      __publicField(this, "failing", false);
      __publicField(this, "pushes");
      this.pushes = new Dye2Pushes(transports, () => pushed());
    }
    start() {
      this.poll();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
      this.pushes.stop();
    }
    /** Whether the server says the Machine is capture-only: nothing is written into its Workflow, nor saved into its recipes, while it is. */
    setCaptureOnly(captureOnly) {
      this.captureOnly = captureOnly;
    }
    /**
     * Decaid's `workflowUpdated`, before the Workflow is queued, so it may be
     * held back. A change during a write of the plugin's is that write's echo,
     * which the write decides on once done (`ownWrite`).
     */
    observe(workflow) {
      if (this.stopped) return;
      const previous = this.latest;
      this.latest = workflow;
      if (this.writing > 0) {
        this.duringWrite.reported = true;
        return;
      }
      this.decide(previous, true);
    }
    /** DYE2's recipes as a read of them found them, whoever read them. A list in a shape not recognised changes nothing. */
    sawRecipes(value) {
      const records = value === null ? [] : dye2Records(value);
      if (records === null) return;
      this.records = loadable(records);
      if (this.writing === 0) this.decide(this.latest, false);
    }
    async ownWrite(work) {
      if (this.writing === 0) this.duringWrite = { reported: false, answered: void 0, before: this.latest, written: /* @__PURE__ */ new Set() };
      this.writing++;
      this.changes.hold();
      try {
        return await work((workflow, body) => {
          this.duringWrite.answered = workflow;
          for (const path of fieldPaths(body)) this.duringWrite.written.add(path);
        });
      } finally {
        this.writing--;
        if (this.writing === 0) this.wrote();
        this.changes.release();
      }
    }
    /**
     * Once the plugin's writes into the Workflow are done: a change made
     * around them that they did not make is decided on as any other, so a
     * barista's is saved into the Loaded Recipe. Decaid reports a write's
     * change ahead of answering it, so one reported after the answer, the
     * Workflow holding other than it, is another's; and Decaid merges each
     * write into the Workflow as it holds it then, so a part of the Recipe's
     * the writes did not set that differs from the Workflow the plugin knew
     * before them was changed meanwhile. A change of profile is judged from
     * that Workflow too, but where the writes set the profile themselves.
     */
    wrote() {
      const { reported, answered, before, written: written2 } = this.duringWrite;
      if (!reported && answered !== void 0) this.latest = answered;
      const latest = this.latest;
      const after = latest !== void 0 && answered !== void 0 && !sameValue(latest, answered);
      const around = latest !== void 0 && before !== void 0 && changedBesides(before, latest, written2);
      this.decide(written2.has("profile") ? answered ?? before : before, reported && after || around);
    }
    async beforePost(before, after) {
      const vacated = new Set(vacatedIds(before, after));
      if (vacated.size === 0) return;
      await this.ownWrite(async (answered) => {
        const workflow = await workflowNow();
        const named = dye2RecipeIdOf(workflow);
        if (named === null || !vacated.has(named)) return;
        const body = clearRecipe();
        const answer = await request("PUT", "/workflow", body);
        const updated = answer.ok ? parsed3(answer.text) : void 0;
        if (!isObject4(updated)) throw new Error(`Decaid answered ${answer.status} clearing the Workflow's recipe before its record is replaced: ${answer.text.slice(0, 200)}`);
        answered(updated, body);
        this.workflowWritten(workflow, updated);
      });
    }
    posted(records) {
      this.sawRecipes(records);
    }
    /**
     * Decides on the latest Workflow, once the recipes are read: one naming a
     * Recipe the plugin has not loaded loads it (`loadRecipe`), but on the
     * plugin's first decision, which takes it as loaded; a change of it
     * (`changed`) naming the Loaded Recipe is saved into it (`saveSoon`), but
     * for one changing the profile from `previous`, as DYE2 fingerprints one,
     * which DYE2 clears the recipe on. A read of the recipes (`changed` false)
     * saves nothing.
     */
    decide(previous, changed) {
      const workflow = this.latest;
      if (workflow === void 0 || this.records === null || this.stopped) return;
      const recordId = dye2RecipeIdOf(workflow);
      const globalId = (recordId === null ? void 0 : this.records.get(recordId))?.globalId ?? null;
      if (globalId !== this.loaded) {
        const first = this.loaded === void 0;
        this.loaded = globalId;
        this.loads++;
        if (globalId !== null && !first && this.sharing()) {
          void this.library.run(() => this.loadRecipe(globalId)).catch((error) => this.failed(error));
        }
        return;
      }
      if (!changed || globalId === null || !this.sharing()) return;
      if (previous !== void 0 && dye2Fingerprint(previous.profile) !== dye2Fingerprint(workflow.profile)) return;
      this.saveSoon({ globalId, load: this.loads, fingerprint: dye2Fingerprint(workflow.profile) });
    }
    /** Whether the Machine shares and DYE2 is there, so the plugin writes into the Workflow and saves into its recipes. */
    sharing() {
      return !this.captureOnly && !this.unavailable();
    }
    /**
     * Saves the Workflow into the Loaded Recipe the change asking for it was
     * made on (`save`), in `library`'s turn, holding the Workflow's changes
     * back until DYE2 has, and its recipes are reported where it wrote. One
     * save waiting its turn covers the changes of the same Recipe, load and
     * profile after it. As DYE2 saves into the recipe the live Workflow names,
     * the save is made only while that Workflow, read just before, still
     * names that Recipe on that profile, and no load was decided on since,
     * judged again once Decaid answered that read: a recipe applied
     * meanwhile, whose load write is still to come, or a change of profile,
     * which DYE2 clears the recipe on, is not saved into it. A save that
     * fails is tried again at the next change.
     */
    saveSoon(save) {
      const queued = this.queuedSave;
      if (queued !== null && queued.globalId === save.globalId && queued.load === save.load && queued.fingerprint === save.fingerprint) return;
      this.queuedSave = save;
      this.changes.hold();
      void this.library.run(async () => {
        if (this.queuedSave === save) this.queuedSave = null;
        const current = () => !this.stopped && this.loaded === save.globalId && this.loads === save.load && this.sharing();
        if (!current()) return;
        const workflow = await workflowNow();
        const recordId = dye2RecipeIdOf(workflow);
        const named = recordId === null ? void 0 : this.records?.get(recordId)?.globalId;
        if (named !== save.globalId || dye2Fingerprint(workflow.profile) !== save.fingerprint || !current()) return;
        if (await recordIntoRecipe() === "saved") await this.reportRecipes();
        this.failing = false;
      }).catch((error) => this.failed(error)).finally(() => this.changes.release());
    }
    /** Logs a failure once until a later step succeeds. */
    failed(error) {
      if (!this.failing) this.log(`The Loaded Recipe could not be followed: ${error instanceof Error ? error.message : String(error)}`);
      this.failing = true;
    }
    /** Runs each check in turn. */
    enqueue(work) {
      this.chain = this.chain.then(() => this.stopped ? void 0 : work()).then(() => {
        this.failing = false;
      }).catch((error) => this.failed(error));
    }
    /** On its poll, reads whether DYE2 is loaded, then its recipes. */
    poll() {
      if (this.stopped) return;
      this.enqueue(() => this.check());
      this.pollTimer = setTimeout(() => this.poll(), this.pollMs);
    }
    async check() {
      this.dye2 = await readDye2State();
      if (this.dye2 === "loaded") {
        this.notLoadedSince = null;
        this.pushes.keepOpen();
      } else this.notLoadedSince ?? (this.notLoadedSince = Date.now());
      this.changes.dye2Absent(this.unavailable());
      this.sawRecipes(await this.readRecipes());
    }
    /** Whether DYE2 is not there: absent, disabled, or not loaded for longer than twice the poll interval. */
    unavailable() {
      if (this.dye2 === "absent" || this.dye2 === "disabled") return true;
      return this.dye2 === "notLoaded" && this.notLoadedSince !== null && Date.now() - this.notLoadedSince > 2 * this.pollMs;
    }
    /**
     * Loads the Recipe the Workflow names, while it still names it: writes
     * into the Workflow what applying a DYE2 recipe leaves out, or a stale
     * copy got wrong (`loadWrite`), as one write, or two where it changes the
     * profile (`putNamingRecipe`). Decaid refuses to change the steam, hot
     * water and flush settings while no machine is connected, so the rest is
     * then written without them. A write Decaid takes is told of
     * (`workflowWritten`). A steam temperature the recipe holds is kept as the
     * one Streamline turns steam back on at (`keepStreamlineSteamTemperature`),
     * written into the Workflow or not, as one into a Workflow whose steam is
     * off is not (interim, until decentespresso/streamline-js#156).
     */
    async loadRecipe(globalId) {
      if (this.stopped || !this.sharing()) return;
      const record = await this.ownWrite(async (answered) => {
        const workflow = await workflowNow();
        const recordId = dye2RecipeIdOf(workflow);
        const recipe = recordId === null ? void 0 : this.records?.get(recordId);
        if (recordId === null || recipe === void 0 || recipe.globalId !== globalId) return null;
        const context = await this.loadContext(recipe.record);
        let write = loadWrite(workflow, recipe.record, context);
        if (write === null) return recipe.record;
        let answer = await putNamingRecipe(workflow, write, recordId, answered);
        if (!answer.ok && MACHINE_SETTING_PARTS.some((part) => part in write) && machineMissing(answer)) {
          write = loadWrite(workflow, recipe.record, context, new Set(RECIPE_SETTING_NAMES));
          answer = write === null ? void 0 : await putNamingRecipe(workflow, write, recordId, answered);
        }
        if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} loading the recipe ${recordId}: ${answer.text.slice(0, 200)}`);
        const after = answer ? parsed3(answer.text) : void 0;
        if (isObject4(after)) this.workflowWritten(workflow, after);
        return recipe.record;
      });
      if (record === null) return;
      const variables = isObject4(record.dashboardVariables) ? record.dashboardVariables : {};
      await keepStreamlineSteamTemperature(variables[RECIPE_SETTINGS.steamTemperature.dye2], this.log);
    }
    /** The tablet's recipes, read now. Throws if Decaid does not answer with them. */
    async readRecipes() {
      const answer = await request("GET", RECIPES);
      const value = answer.ok ? parsed3(answer.text) : void 0;
      if (value === void 0) throw new Error(`Decaid answered ${answer.status} reading DYE2's recipes`);
      return value;
    }
    /** The record at that path of Decaid's API, or null if it holds none (404). Throws if Decaid answers otherwise. */
    async readRecord(path) {
      const answer = await request("GET", path);
      if (answer.status === 404) return null;
      const record = answer.ok ? parsed3(answer.text) : void 0;
      if (record === void 0) throw new Error(`Decaid answered ${answer.status} reading ${path}`);
      return record;
    }
    /**
     * What a load of the recipe writes besides its record: its full Profile at
     * its brew temperature, as the Workflow DYE2 embeds in the record holds it
     * (decentespresso/dye2#26), or else as its snapshot or the tablet's record
     * of that Profile does.
     */
    async loadContext(record) {
      const steps = (profile) => isObject4(profile) && Array.isArray(profile.steps) ? profile : null;
      const embedded = steps(isObject4(record.workflow) ? record.workflow.profile : null) ?? steps(record.profileSnapshot);
      if (embedded !== null) return { profile: embedded };
      const stored = typeof record.profileId === "string" && record.profileId !== "" ? await this.readRecord(`/profiles/${encodeURIComponent(record.profileId)}`) : null;
      return { profile: isObject4(stored) ? steps(stored.profile) : null };
    }
  };
  async function putNamingRecipe(workflow, write, recordId, answered) {
    const put = async (body) => {
      const answer2 = await request("PUT", "/workflow", body);
      const updated = answer2.ok ? parsed3(answer2.text) : void 0;
      if (isObject4(updated)) answered(updated, body);
      return answer2;
    };
    if (!changesProfile(workflow, write)) return put(write);
    const cleared = await put(clearRecipe());
    if (!cleared.ok) return cleared;
    const answer = await put(withRecipe(write, recordId));
    if (!answer.ok) await put(withRecipe({}, recordId));
    return answer;
  }
  function fieldPaths(body, prefix = "") {
    return Object.entries(body).flatMap(([key, value]) => {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      return isObject4(value) && path !== "profile" ? fieldPaths(value, path) : [path];
    });
  }
  var PART_FIELDS = Object.values(LOADED_RECIPE_PARTS).flat();
  function changedBesides(before, after, written2) {
    const set = (field) => [...written2].some((path) => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`));
    return PART_FIELDS.some((field) => field !== "profile" && !set(field) && !sameValue(workflowValueAt(before, field), workflowValueAt(after, field)));
  }
  async function workflowNow() {
    const answer = await request("GET", "/workflow");
    const workflow = answer.ok ? parsed3(answer.text) : void 0;
    if (!isObject4(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
    return workflow;
  }
  function machineMissing(answer) {
    return answer.status === 500 && answer.text.includes("DeviceNotConnectedException");
  }
  function parsed3(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/tablet-id.ts
  var KEY = "tabletId";
  var BACKUP_RETRY_MS = 3e4;
  var TabletId = class {
    constructor(storage, log) {
      __publicField(this, "storage", storage);
      __publicField(this, "log", log);
      /** Known once read or made, for as long as this load lasts. */
      __publicField(this, "id");
      /** The read of the id under way, shared by callers meanwhile. */
      __publicField(this, "reading");
      /** The next attempt to have Decaid's backups include the id, while one is due. */
      __publicField(this, "backupRetry");
      __publicField(this, "stopped", false);
    }
    /**
     * The tablet's id: the one in plugin storage, or, if that key was never
     * written, a new one, once Decaid has written it there, or, while Decaid
     * leaves writes unanswered (storage.ts), once it is sent: a Decaid that
     * cannot write it gives the tablet a new id each load. Rejects, saying why,
     * if Decaid refuses or does not answer in time; reading again later
     * retries.
     */
    read() {
      if (this.id !== void 0) return Promise.resolve(this.id);
      this.reading ?? (this.reading = this.readOrMake().finally(() => {
        this.reading = void 0;
      }));
      return this.reading;
    }
    stop() {
      this.stopped = true;
      if (this.backupRetry !== void 0) clearTimeout(this.backupRetry);
    }
    async readOrMake() {
      const stored = await this.storage.read(KEY, "a read of this tablet's id");
      if (isTabletId(stored)) return this.known(stored);
      const made = randomUuid();
      await this.storage.write(KEY, made, "the write of this tablet's new id");
      this.log(
        stored === null ? `This tablet had no id in Decaid's plugin storage, so it was given one: ${made}.` : `This tablet's id in Decaid's plugin storage was not a UUID, so it was given a new one: ${made}.`
      );
      return this.known(made);
    }
    /** Keeps the id, once read or written, for this load, and has Decaid's backups include it. */
    known(id) {
      this.id = id;
      void this.keepInBackups();
      return id;
    }
    /** Has Decaid's store API read the plugin's storage, so backups hold the id, asking again until it answers. */
    async keepInBackups() {
      if (await keepStorageInBackups() || this.stopped) return;
      this.backupRetry = setTimeout(() => {
        this.backupRetry = void 0;
        void this.keepInBackups();
      }, BACKUP_RETRY_MS);
    }
  };
  function randomUuid() {
    const hex2 = (digits) => {
      let text = "";
      for (let digit = 0; digit < digits; digit++) text += Math.floor(Math.random() * 16).toString(16);
      return text;
    };
    const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
    return `${hex2(8)}-${hex2(4)}-4${hex2(3)}-${variant}${hex2(3)}-${hex2(12)}`;
  }

  // src/library-writes.ts
  var ROUTES = {
    bean: {
      list: "/beans?includeArchived=true",
      records: "/beans",
      create: () => "/beans",
      deferred: ["archived"],
      sameItem: (record, fields) => typeof record.roaster === "string" && typeof record.name === "string" && typeof fields.roaster === "string" && typeof fields.name === "string" && beanMatchKey(record.roaster, record.name) === beanMatchKey(fields.roaster, fields.name),
      namedByShots: false
    },
    beanBatch: {
      list: "/bean-batches?includeArchived=true",
      records: "/bean-batches",
      // Under the tablet's record of its bean, which `beanId` names; the path decides it, and Decaid ignores the field.
      create: (fields) => typeof fields.beanId === "string" && fields.beanId !== "" ? `/beans/${encodeURIComponent(fields.beanId)}/batches` : null,
      deferred: ["archived", "weightRemaining"],
      sameItem: () => false,
      namedByShots: true,
      listUnder: (parentPath) => `${parentPath}/batches?includeArchived=true`
    },
    grinder: {
      list: "/grinders?includeArchived=true",
      records: "/grinders",
      create: () => "/grinders",
      deferred: ["archived"],
      sameItem: () => false,
      namedByShots: true
    }
  };
  var WRITERS = {
    bean: recordWriter("bean", ROUTES.bean),
    beanBatch: recordWriter("beanBatch", ROUTES.beanBatch),
    grinder: recordWriter("grinder", ROUTES.grinder),
    profile: {
      list: "/profiles?includeHidden=true",
      write: writeProfile,
      remove: purgeProfile,
      setAside: (leave) => readThen("/profiles", leave, hideProfile)
    },
    basket: dye2Writer("baskets"),
    tool: dye2Writer("equipment"),
    recipe: dye2Writer("recipes"),
    [WORKFLOW_KIND]: { write: clearWorkflow, changesWorkflow: true },
    [LOADED_RECIPE_KIND]: { write: writeLoadedRecipe, changesWorkflow: true }
  };
  function writerOf(kind) {
    return Object.prototype.hasOwnProperty.call(WRITERS, kind) ? WRITERS[kind] : void 0;
  }
  function libraryWriterOf(kind) {
    return isLibraryKind(kind) ? WRITERS[kind] : void 0;
  }
  function routeOf(kind) {
    return Object.prototype.hasOwnProperty.call(ROUTES, kind) ? ROUTES[kind] : void 0;
  }
  function libraryListPath(kind) {
    return WRITERS[kind].list;
  }
  function recordWriter(kind, route) {
    return {
      list: route.list,
      write: async (write) => {
        if (write.localId === null) return await create(route, write);
        const updated = await update(route, write, write.localId);
        return answerTo(write, updated.answer, updated.written);
      },
      remove: (remove, namedByShot) => deleteRecord(kind, route, remove, namedByShot),
      setAside: (leave) => readThen(route.records, leave, archiveRecord)
    };
  }
  var LibraryAccess = class {
    constructor() {
      __publicField(this, "queue", Promise.resolve());
      __publicField(this, "listeners", []);
    }
    /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
    run(work) {
      const done = this.queue.then(work);
      this.queue = done.catch(() => {
      });
      return done;
    }
    /** Tells `listener` of each list the plugin wrote, as it is written (`wrote`). */
    onWrite(listener) {
      this.listeners.push(listener);
    }
    /**
     * The plugin wrote one of DYE2's lists, whose reports are compared by
     * content: its next read is reported whatever it holds, so one another app
     * rewrote at the same moment, losing the write, is reported though it reads
     * as it was last reported (ADR-0005).
     */
    wrote(list) {
      for (const listener of this.listeners) listener(list);
    }
  };
  var LibraryWrites = class {
    constructor(library, outbox, loaded, machineMissing2, log, skins) {
      __publicField(this, "library", library);
      __publicField(this, "outbox", outbox);
      __publicField(this, "loaded", loaded);
      __publicField(this, "machineMissing", machineMissing2);
      __publicField(this, "log", log);
      /** Told of each post of one of DYE2's lists and each write into the Workflow Decaid took, carrying the Loaded Recipe's part in them. */
      __publicField(this, "posted");
      /**
       * The batch, Grinder, profile, basket and tool records each Shot this
       * plugin queued since it loaded names, by its id, as `kind:id`, as its
       * latest record names them, with that record's edit time (`editOrder`):
       * a few per Shot. A profile is named by its steps (`stepsKey`), as a skin
       * sets the Workflow's profile's targets for the Shot, and by the id a skin
       * recorded, if one did.
       */
      __publicField(this, "shotsName", /* @__PURE__ */ new Map());
      /** The Shots still to be sent that `namedByShot` read. */
      __publicField(this, "shotsRead", /* @__PURE__ */ new Set());
      this.posted = Object.assign((key) => skins.listPosted(key), { loaded, workflowWritten: skins.workflowWritten });
      outbox.watch((delivery) => {
        if (delivery.type === "shot" || delivery.type === "shotUpdated") this.noteShot(delivery.shotId, delivery.shot);
      });
    }
    /** Deletes a record of a hard-deleted item once the reads and writes before it are done, and queues its answer. It never rejects. */
    remove(remove) {
      return this.library.run(async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutDelete(remove, (kind, ids) => this.namedByShot(kind, ids), this.posted))));
    }
    /**
     * Whether a Shot this plugin queued since it loaded, or has yet to read and
     * send, names one of the records, as one pulled while the tablet was
     * offline: the server may have planned the delete before it had the Shot,
     * and so could not keep the record for it. A Shot still to be read, as the
     * outbox reads a new Shot only as it sends it, is read here once.
     */
    async namedByShot(kind, ids) {
      const unread = this.outbox.requestedIds("shot").filter((id) => !this.shotsRead.has(id));
      if (unread.length > MAX_SHOTS_READ) return "tooMany";
      for (const id of unread) {
        const shot = await readShot(id);
        this.shotsRead.add(id);
        if (shot) this.noteShot(id, shot);
      }
      const named = [...ids].map((id) => `${kind}:${id}`);
      return [...this.shotsName.values()].some(({ names }) => named.some((name) => names.has(name)));
    }
    /**
     * Notes the batch, Grinder, profile, basket and tool records a Shot names,
     * in place of what an older record of it named, as the server keeps a
     * Shot's latest metadata by its edit time: so an edit naming another
     * basket, say, no longer keeps the one it named before, and a record read
     * before that edit but noted after it, as one whose read was slow, changes
     * nothing. A record of the same edit time adds what it names, as keeping
     * more records is the safe side.
     */
    noteShot(id, shot) {
      const version = editOrder(shot.updatedAt);
      const noted = this.shotsName.get(id);
      if (noted && version < noted.version) return;
      const names = noted && version === noted.version ? noted.names : /* @__PURE__ */ new Set();
      this.shotsName.set(id, { version, names });
      const workflow = isObject5(shot.workflow) ? shot.workflow : {};
      const steps = stepsKey(isObject5(workflow.profile) ? workflow.profile.steps : void 0);
      if (steps !== null) names.add(`profile:${steps}`);
      const context = isObject5(workflow.context) ? workflow.context : {};
      const extras = isObject5(context.extras) ? context.extras : {};
      if (typeof context.beanBatchId === "string") names.add(`beanBatch:${context.beanBatchId}`);
      if (typeof context.grinderId === "string") names.add(`grinder:${context.grinderId}`);
      if (isObject5(extras.workflowSkin) && typeof extras.workflowSkin.selectedProfileId === "string") names.add(`profile:${extras.workflowSkin.selectedProfileId}`);
      const edited = isObject5(shot.annotations) && isObject5(shot.annotations.extras) ? shot.annotations.extras : {};
      const basket = edited.basketId != null || edited.basketName != null ? edited.basketId : extras.basketId;
      if (typeof basket === "string") names.add(`basket:${basket}`);
      for (const recorded of [edited, extras]) {
        const tools = Array.isArray(recorded.equipmentIds) ? recorded.equipmentIds : [recorded.equipmentId];
        for (const id2 of tools) if (typeof id2 === "string") names.add(`tool:${id2}`);
      }
    }
    /** Removes a record from one of DYE2's lists once the reads and writes before it are done, and queues its answer. It never rejects. */
    drop(remove) {
      return this.library.run(async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutRemove(remove, this.posted))));
    }
    /** Has the next read of the kind's list reported whatever it holds, if it is one of DYE2's, which the plugin may just have written; returns the answer. */
    wrote(kind, answer) {
      if (isLibraryKind(kind) && dye2Key(kind) !== void 0) this.library.wrote(LIBRARY_ITEM_KINDS[kind].list);
      return answer;
    }
    /** Sets aside a record the Library leaves out once the reads and writes before it are done, and queues its answer. It never rejects. */
    leaveOut(leave) {
      return this.library.run(async () => this.outbox.enqueue(this.wrote(leave.kind, await setAside(leave, this.posted))));
    }
    /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
    apply(write) {
      if (!writerOf(write.kind)?.changesWorkflow) {
        return this.library.run(async () => this.outbox.enqueue(this.wrote(write.kind, await carryOut(write, this.log, this.posted))));
      }
      return this.library.run(
        () => this.loaded.ownWrite(async (answered) => {
          const answer = await carryOut(write, this.log, Object.assign((key) => this.posted(key), this.posted, { answered }));
          if (answer.type === "writeRefused" && answer.status === 500 && answer.error.includes("DeviceNotConnectedException")) this.machineMissing();
          this.outbox.enqueue(answer);
        })
      );
    }
  };
  async function carryOutRemove(remove, posted) {
    const drop = libraryWriterOf(remove.kind)?.drop;
    if (!drop) return refused(remove, null, `This plugin cannot remove a ${remove.kind}`);
    try {
      return await drop(remove, posted);
    } catch (error) {
      return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function carryOutDelete(remove, namedByShot, posted) {
    const writer = libraryWriterOf(remove.kind);
    if (!writer) return refused(remove, null, `This plugin cannot delete a ${remove.kind}`);
    try {
      return await writer.remove(remove, namedByShot, posted);
    } catch (error) {
      return refused(remove, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function deleteRecord(kind, route, remove, namedByShot) {
    const path = `${route.records}/${encodeURIComponent(remove.localId)}`;
    const current = await request("GET", path);
    if (current.status === 404) return deleted(remove);
    const record = current.ok ? parsed4(current.text) : void 0;
    if (!isObject5(record)) return refused(remove, current.status, current.text);
    const carried = globalIdOf(record);
    if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
    if (route.namedByShots) {
      const named = await namedByShot(kind, /* @__PURE__ */ new Set([remove.localId]));
      if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
    }
    for (const child of childKinds(kind)) {
      const under = routeOf(child)?.listUnder;
      if (!under) return refused(remove, null, `This plugin cannot delete the ${child} records under a ${kind}`);
      const listed = await request("GET", under(path));
      const children = listed.ok ? parsed4(listed.text) : void 0;
      if (!Array.isArray(children)) return refused(remove, listed.status, listed.text);
      const ids = new Set(children.filter(isObject5).flatMap((record2) => typeof record2.id === "string" ? [record2.id] : []));
      const named = await namedByShot(child, ids);
      if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
      for (const id of ids) {
        const gone = await request("DELETE", `${routeOf(child).records}/${encodeURIComponent(id)}`);
        if (!gone.ok && gone.status !== 404) return refused(remove, gone.status, gone.text);
      }
    }
    const answer = await request("DELETE", path);
    return answer.ok || answer.status === 404 ? deleted(remove) : refused(remove, answer.status, answer.text);
  }
  async function purgeProfile(remove, namedByShot) {
    const path = `/profiles/${encodeURIComponent(remove.localId)}`;
    const current = await request("GET", path);
    if (current.status === 404) return deleted(remove);
    const record = current.ok ? parsed4(current.text) : void 0;
    if (!isObject5(record)) return refused(remove, current.status, current.text);
    const steps = stepsKey(isObject5(record.profile) ? record.profile.steps : void 0);
    const named = await namedByShot("profile", new Set(steps === null ? [remove.localId] : [remove.localId, steps]));
    if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
    const answer = await request("DELETE", `${path}/purge`);
    return answer.ok || answer.status === 400 && answer.text.includes("Profile not found") ? deleted(remove) : refused(remove, answer.status, answer.text);
  }
  function editOrder(updatedAt) {
    const parts = typeof updatedAt === "string" ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(updatedAt) : null;
    return parts ? `${parts[1]}.${(parts[2] ?? "").padEnd(12, "0")}` : "";
  }
  var SHOT_NOT_SENT = "A Shot this plugin has queued or has yet to send names the record or one of its batches";
  var MAX_SHOTS_READ = 20;
  async function setAside(leave, posted) {
    const answer = (outcome, status, error) => ({
      type: "leftOut",
      id: leave.id,
      kind: leave.kind,
      localId: leave.localId,
      outcome,
      ...outcome === "refused" ? { status: status ?? null, error: (error ?? "").slice(0, MAX_REFUSAL_LENGTH) } : {}
    });
    const writer = libraryWriterOf(leave.kind);
    if (!writer) return answer("refused", null, `This plugin cannot set aside a ${leave.kind}`);
    try {
      const outcome = await writer.setAside(leave, posted);
      if (outcome === "unrecognised") return unrecognised(leave);
      return typeof outcome === "string" ? answer(outcome) : answer("refused", outcome.status, outcome.text);
    } catch (error) {
      return answer("refused", null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function readThen(records, leave, setAsideRecord) {
    const path = `${records}/${encodeURIComponent(leave.localId)}`;
    const current = await request("GET", path);
    if (current.status === 404) return "gone";
    const record = current.ok ? parsed4(current.text) : void 0;
    if (!isObject5(record)) return current;
    return setAsideRecord(leave, record, path);
  }
  async function archiveRecord(_leave, record, path) {
    if (globalIdOf(record) !== null) return "taken";
    if (record.archived === true) return "setAside";
    const archived = await request("PUT", path, { archived: true, extras: isObject5(record.extras) ? record.extras : {} });
    const updated = archived.ok ? parsed4(archived.text) : void 0;
    return isObject5(updated) && updated.archived === true ? "setAside" : archived;
  }
  async function hideProfile(leave, record) {
    if (record.visibility !== "visible") return "setAside";
    const hidden = await setVisibility(leave.localId, "hidden");
    const updated = hidden.ok ? parsed4(hidden.text) : void 0;
    return isObject5(updated) && updated.visibility !== "visible" ? "setAside" : hidden;
  }
  function deleted(remove) {
    return { type: "deleted", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
  }
  async function carryOut(write, log, posted) {
    const writer = writerOf(write.kind);
    if (!writer) return refused(write, null, `This plugin cannot write a ${write.kind}`);
    try {
      return await writer.write(write, log, posted);
    } catch (error) {
      return refused(write, null, `Decaid did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function writeProfile(write) {
    const visibility = write.fields.visibility;
    if (write.localId !== null) return await updateProfile(write, write.localId);
    const held = await heldProfile(write.globalId);
    if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
    let record = held.record;
    const writtenFields = [];
    if (!record) {
      const { parentId, metadata } = write.fields;
      const parent = typeof parentId === "string" ? await heldProfile(parentId) : void 0;
      if (parent && "refused" in parent) return refused(write, parent.refused.status, parent.refused.text);
      const body = { profile: write.fields.profile, ...parent?.record ? { parentId } : {}, ...isObject5(metadata) ? { metadata } : {} };
      const made = await request("POST", "/profiles", body);
      const created = made.ok ? parsed4(made.text) : void 0;
      if (!isObject5(created) || typeof created.id !== "string") return refused(write, made.status, made.text);
      record = created;
      writtenFields.push(...Object.keys(body));
    }
    if (record.id !== write.globalId || typeof visibility !== "string" || record.visibility === visibility) return written(write, record, writtenFields);
    const again = await setVisibility(write.globalId, visibility).catch(() => void 0);
    const updated = again?.ok ? parsed4(again.text) : void 0;
    if (!isObject5(updated) || updated.id !== write.globalId) return written(write, record, writtenFields);
    return written(write, updated, [...writtenFields, "visibility"]);
  }
  async function clearWorkflow(write, _log, posted) {
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed4(current.text) : void 0;
    if (!isObject5(workflow)) return refused(write, current.status, current.text);
    const fields = Object.fromEntries(
      WORKFLOW_CLEARED.flatMap((group) => {
        const [id] = group;
        const named = group.filter((field) => field in write.fields);
        const expected = write.expected?.[id];
        const holds = named.includes(id) && expected !== void 0 && expected !== null && sameValue(workflowValueAt(workflow, id), expected);
        return holds ? named.map((field) => [field, null]) : [];
      })
    );
    if (Object.keys(fields).length === 0) return written(write, workflowContext(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
    const body = workflowPatch(fields);
    const answer = await request("PUT", "/workflow", body);
    const updated = answer.ok ? parsed4(answer.text) : void 0;
    if (!isObject5(updated)) return refused(write, answer.status, answer.text);
    posted.answered?.(updated, body);
    posted.workflowWritten(workflow, updated);
    return written(write, workflowContext(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
  }
  async function writeLoadedRecipe(write, log, posted) {
    const expected = write.expected?.[DYE2_RECIPE_FIELD];
    const recordId = typeof expected === "string" ? expected : null;
    if (DYE2_RECIPE_FIELD in write.fields) {
      const current = await request("GET", "/workflow");
      const workflow = current.ok ? parsed4(current.text) : void 0;
      if (!isObject5(workflow)) return refused(write, current.status, current.text);
      if (recordId === null || dye2RecipeIdOf(workflow) !== recordId) return written(write, loadedRecipeParts(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
      const body = clearRecipe();
      const answer = await request("PUT", "/workflow", body);
      const updated = answer.ok ? parsed4(answer.text) : void 0;
      if (!isObject5(updated)) return refused(write, answer.status, answer.text);
      posted.answered?.(updated, body);
      posted.workflowWritten(workflow, updated);
      return written(write, loadedRecipeParts(updated), [DYE2_RECIPE_FIELD], (/* @__PURE__ */ new Date()).toISOString());
    }
    if (recordId === null) return refused(write, null, "A write of the Loaded Recipe must name the recipe the Workflow is to name");
    let machineSettings = true;
    for (; ; ) {
      const current = await request("GET", "/workflow");
      const workflow = current.ok ? parsed4(current.text) : void 0;
      if (!isObject5(workflow)) return refused(write, current.status, current.text);
      if (dye2RecipeIdOf(workflow) !== recordId) return refused(write, null, ANOTHER_RECIPE);
      const fields = loadedRecipeFields(write, workflow, machineSettings);
      const steam = STEAM_TEMPERATURE in fields || STEAM_TEMPERATURE in write.fields && steamOff(workflow) ? write.fields[STEAM_TEMPERATURE] : void 0;
      if (Object.keys(fields).length === 0) {
        await keepStreamlineSteamTemperature(steam, log);
        return written(write, loadedRecipeParts(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
      }
      let updated;
      const answer = await putNamingRecipe(workflow, loadedRecipePatch(fields, workflow), recordId, (workflow2, body) => {
        updated = workflow2;
        posted.answered?.(workflow2, body);
      });
      if (answer.ok && updated !== void 0) {
        posted.workflowWritten(workflow, updated);
        await keepStreamlineSteamTemperature(steam, log);
        return written(write, loadedRecipeParts(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
      }
      const ofMachine = Object.keys(fields).filter(isMachineSetting);
      if (ofMachine.length === 0 || ofMachine.length === Object.keys(fields).length || !machineMissing(answer)) return refused(write, answer.status, answer.text);
      machineSettings = false;
    }
  }
  var STEAM_TEMPERATURE = RECIPE_SETTINGS.steamTemperature.workflow;
  function isMachineSetting(field) {
    return MACHINE_SETTING_PARTS.some((part) => field.startsWith(`${part}.`));
  }
  var ANOTHER_RECIPE = "The Workflow names another recipe now, which the plugin reports first";
  function loadedRecipePatch(fields, workflow) {
    const { [BREW_TEMPERATURE_FIELD]: temperature, ...rest } = fields;
    const patch = workflowPatch(rest);
    if (typeof temperature === "number") {
      const shifted = profileAtBrewTemperature(isObject5(patch.profile) ? patch.profile : workflow.profile, temperature);
      if (shifted !== null) patch.profile = shifted;
    }
    return patch;
  }
  function loadedRecipeFields(write, workflow, machineSettings) {
    return Object.fromEntries(
      Object.values(LOADED_RECIPE_PARTS).flatMap((part) => {
        const [first] = part;
        if (!(first in write.fields) || !machineSettings && isMachineSetting(first)) return [];
        if (first === STEAM_TEMPERATURE && steamOff(workflow)) return [];
        const held = workflowValueAt(workflow, first);
        const expected = write.expected?.[first];
        if (expected !== void 0 && !sameValue(held, expected) && !sameValue(held, write.fields[first])) return [];
        return part.filter((field) => field in write.fields).map((field) => [field, write.fields[field]]);
      })
    );
  }
  function loadedRecipeParts(workflow) {
    return {
      context: isObject5(workflow.context) ? workflow.context : {},
      ...Object.fromEntries(MACHINE_SETTING_PARTS.map((part) => [part, isObject5(workflow[part]) ? workflow[part] : {}])),
      ...isObject5(workflow.profile) ? { profile: workflow.profile } : {}
    };
  }
  function workflowContext(workflow) {
    return { context: isObject5(workflow.context) ? workflow.context : {} };
  }
  var PROFILE_TEXT = ["title", "author", "notes"];
  async function updateProfile(write, id) {
    const held = await heldProfile(id);
    if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
    if (!held.record) return refused(write, 404, "Profile not found");
    let record = held.record;
    const fields = settable(write, (field) => field === "visibility" ? record.visibility : isObject5(record.profile) ? record.profile[field] : void 0);
    const writtenFields = [];
    const text = PROFILE_TEXT.filter((field) => field in fields);
    if (text.length > 0) {
      const profile = { ...isObject5(record.profile) ? record.profile : {} };
      for (const field of text) {
        if (fields[field] === null) delete profile[field];
        else profile[field] = fields[field];
      }
      const answer = await request("PUT", `/profiles/${encodeURIComponent(id)}`, { profile });
      const updated = answer.ok ? parsed4(answer.text) : void 0;
      if (!isObject5(updated) || typeof updated.id !== "string") return refused(write, answer.status, answer.text);
      if (updated.id !== id) return written(write, updated, text);
      record = updated;
      writtenFields.push(...text);
    }
    if ("visibility" in fields) {
      if (record.visibility !== fields.visibility) {
        const answer = await setVisibility(id, fields.visibility).catch((error) => {
          if (writtenFields.length === 0) throw error;
          return void 0;
        });
        const updated = answer?.ok ? parsed4(answer.text) : void 0;
        if (!isObject5(updated) || updated.id !== id) {
          return writtenFields.length === 0 ? refused(write, answer?.status ?? null, answer?.text ?? "") : written(write, record, writtenFields);
        }
        record = updated;
      }
      writtenFields.push("visibility");
    }
    return written(write, record, writtenFields);
  }
  function settable(write, current) {
    const expected = write.expected;
    return Object.fromEntries(
      Object.entries(write.fields).filter(([field]) => !expected || !(field in expected) || sameValue(current(field), expected[field]))
    );
  }
  async function heldProfile(id) {
    const answer = await request("GET", `/profiles/${encodeURIComponent(id)}`);
    if (answer.status === 404) return { record: void 0 };
    const record = answer.ok ? parsed4(answer.text) : void 0;
    return isObject5(record) && record.id === id ? { record } : { refused: answer };
  }
  function setVisibility(id, visibility) {
    return request("PUT", `/profiles/${encodeURIComponent(id)}/visibility`, { visibility });
  }
  async function create(route, write) {
    const listed = await request("GET", route.list);
    if (!listed.ok) return refused(write, listed.status, listed.text);
    const parsedList = parsed4(listed.text);
    const records = Array.isArray(parsedList) ? parsedList.filter(isObject5) : [];
    const held = records.find((record2) => globalIdOf(record2) === write.globalId.toLowerCase());
    if (held) return written(write, held, []);
    const same = records.find((record2) => globalIdOf(record2) === null && record2.archived !== true && route.sameItem(record2, write.fields));
    if (same && typeof same.id === "string") {
      const answer = answerTo(write, (await update(route, { ...write, fields: {} }, same.id)).answer, []);
      return answer.type === "written" ? { ...answer, linked: true } : answer;
    }
    const path = route.create(write.fields);
    if (path === null) return refused(write, null, `A ${write.kind} to create must name what it belongs to`);
    const body = { ...write.fields, extras: { [GLOBAL_ID_KEY]: write.globalId } };
    for (const field of route.deferred) delete body[field];
    const made = await request("POST", path, body);
    const record = made.ok ? parsed4(made.text) : void 0;
    if (!isObject5(record) || typeof record.id !== "string") return refused(write, made.status, made.text);
    const later = Object.fromEntries(route.deferred.flatMap((field) => field in write.fields && write.fields[field] !== (record[field] ?? null) ? [[field, write.fields[field]]] : []));
    const writtenFields = Object.keys(write.fields);
    if (Object.keys(later).length === 0) return written(write, record, writtenFields);
    const again = await request("PUT", `${route.records}/${encodeURIComponent(record.id)}`, later).catch(() => void 0);
    const updated = again?.ok ? parsed4(again.text) : void 0;
    return written(write, isObject5(updated) && typeof updated.id === "string" ? updated : record, writtenFields);
  }
  async function update(route, write, localId) {
    const path = `${route.records}/${encodeURIComponent(localId)}`;
    const current = await request("GET", path);
    if (!current.ok) return { answer: current, written: [] };
    const parsedRecord = parsed4(current.text);
    const record = isObject5(parsedRecord) ? parsedRecord : {};
    const extras = isObject5(record.extras) ? record.extras : {};
    const fields = settable(write, (field) => record[field]);
    return { answer: await request("PUT", path, { ...fields, extras: { ...extras, [GLOBAL_ID_KEY]: write.globalId } }), written: Object.keys(fields) };
  }
  function answerTo(write, answer, writtenFields) {
    const record = answer.ok ? parsed4(answer.text) : void 0;
    if (isObject5(record) && typeof record.id === "string") return written(write, record, writtenFields);
    return refused(write, answer.status, answer.text);
  }
  function written(write, record, writtenFields, at) {
    return {
      type: "written",
      id: write.id,
      kind: write.kind,
      globalId: write.globalId,
      record,
      updatedAt: at ?? utcTime(record.updatedAt),
      writtenFields,
      ...write.contentDecidedAt === void 0 ? {} : { contentDecidedAt: write.contentDecidedAt }
    };
  }
  function unrecognised(request2) {
    return { type: "listUnrecognised", id: request2.id, kind: request2.kind };
  }
  function refused(write, status, error) {
    return { type: "writeRefused", id: write.id, kind: write.kind, globalId: write.globalId, status, error: error.slice(0, MAX_REFUSAL_LENGTH) };
  }
  function parsed4(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject5(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function dye2Writer(key) {
    const path = `/store/${DYE2_NAMESPACE}/${key}`;
    const list = (posted) => ({ path, key, posted });
    return {
      list: path,
      write: (write, _log, posted) => key === "recipes" ? writeRecipe(list(posted), write) : writeInList(list(posted), write),
      // A hard-deleted item's record is removed as one its Location no longer shows is. A Shot names a basket or tool by its
      // id here, so one a Shot this plugin has yet to send names is kept, as a batch is (`deleteRecord`); a Recipe is named
      // only by a Shot linked to it, which the server judges (hard-deletes.ts).
      remove: async (remove, namedByShot, posted) => {
        if (key !== "recipes") {
          const named = await namedByShot(key === "baskets" ? "basket" : "tool", /* @__PURE__ */ new Set([remove.localId]));
          if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
        }
        const answer = await removeFromList(list(posted), remove);
        return answer.type === "removed" ? { ...answer, type: "deleted" } : answer;
      },
      drop: (remove, posted) => removeFromList(list(posted), remove),
      setAside: (leave, posted) => leaveOutOfList(list(posted), leave)
    };
  }
  async function readList({ path, key }) {
    const answer = await request("GET", path);
    const value = answer.ok ? parsed4(answer.text) : void 0;
    if (value === void 0) return { refused: answer };
    if (value === null) return { records: [] };
    const records = dye2Records(value);
    return records === null ? { unrecognised: true } : { records: [...records] };
  }
  async function postList({ path, key, posted }, records, before) {
    if (key === "recipes") await posted.loaded?.beforePost(before, records);
    const answer = await request("POST", path, records);
    if (answer.ok) {
      posted(key);
      if (key === "recipes") posted.loaded?.posted(records);
    }
    return answer;
  }
  async function writeInList(path, write) {
    const list = await readList(path);
    if ("refused" in list) return refused(write, list.refused.status, list.refused.text);
    if ("unrecognised" in list) return unrecognised(write);
    const { records } = list;
    const globalId = write.globalId.toLowerCase();
    const now2 = (/* @__PURE__ */ new Date()).toISOString();
    let index;
    let record;
    let writtenFields;
    let linked = false;
    if (write.localId === null) {
      const held = records.find((candidate) => dye2GlobalIdOf(candidate) === globalId);
      if (held) return written(write, held, [], now2);
      const name = write.fields.name;
      index = records.findIndex(
        (candidate) => dye2GlobalIdOf(candidate) === null && typeof candidate.name === "string" && typeof name === "string" && equipmentMatchKey(candidate.name) === equipmentMatchKey(name)
      );
      if (index !== -1) {
        record = { ...records[index], [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = [];
        linked = true;
      } else {
        index = records.length;
        record = { ...withValues(write.fields), id: randomUuid(), createdAt: now2, [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = Object.keys(write.fields);
      }
    } else {
      index = records.findIndex((candidate) => candidate.id === write.localId);
      if (index === -1) return refused(write, 404, "Record not found");
      const current = records[index];
      const fields = settable(write, (field) => current[field]);
      record = { ...current, ...withValues(fields), [GLOBAL_ID_KEY]: write.globalId };
      for (const [field, value] of Object.entries(fields)) if (value === null) delete record[field];
      writtenFields = Object.keys(fields);
      if (sameValue(record, current)) return written(write, current, writtenFields, now2);
    }
    const before = [...records];
    records[index] = record;
    const posted = await postList(path, records, before);
    if (!posted.ok) return refused(write, posted.status, posted.text);
    const answer = written(write, record, writtenFields, now2);
    return linked ? { ...answer, linked } : answer;
  }
  async function removeFromList(path, remove) {
    const removed = { type: "removed", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
    const list = await readList(path);
    if ("refused" in list) return refused(remove, list.refused.status, list.refused.text);
    if ("unrecognised" in list) return unrecognised(remove);
    const index = list.records.findIndex((record) => record.id === remove.localId);
    if (index === -1) return removed;
    const carried = dye2GlobalIdOf(list.records[index]);
    if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
    if (remove.type === "remove" && remove.expected !== void 0 && !sameValue(list.records[index], remove.expected)) return refused(remove, null, RECORD_CHANGED);
    const posted = await postList(path, list.records.filter((_, at) => at !== index), list.records);
    return posted.ok ? removed : refused(remove, posted.status, posted.text);
  }
  async function leaveOutOfList(path, leave) {
    const list = await readList(path);
    if ("refused" in list) return list.refused;
    if ("unrecognised" in list) return "unrecognised";
    const index = list.records.findIndex((record) => record.id === leave.localId);
    if (index === -1) return "gone";
    if (dye2GlobalIdOf(list.records[index]) !== null) return "taken";
    const posted = await postList(path, list.records.filter((_, at) => at !== index), list.records);
    return posted.ok ? "setAside" : posted;
  }
  async function writeRecipe(path, write) {
    const list = await readList(path);
    if ("refused" in list) return refused(write, list.refused.status, list.refused.text);
    if ("unrecognised" in list) return unrecognised(write);
    const { records } = list;
    const globalId = write.globalId.toLowerCase();
    const now2 = (/* @__PURE__ */ new Date()).toISOString();
    const { id: recordId, ...fields } = write.fields;
    let index;
    let record;
    let writtenFields;
    let linked = false;
    if (write.localId === null) {
      if (!isRecordId(recordId)) return refused(write, null, "A Recipe to create must name its record id");
      index = records.findIndex((candidate) => candidate.id === recordId);
      if (index !== -1) {
        const held = records[index];
        const carried = dye2GlobalIdOf(held);
        if (carried === globalId) return written(write, held, [], now2);
        if (carried !== null) return refused(write, 409, `The record ${recordId} is another item's`);
        record = { ...held, [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = [];
        linked = true;
      } else {
        index = records.length;
        record = { ...atPaths({}, withValues(fields)), id: recordId, capturedAt: now2, [GLOBAL_ID_KEY]: write.globalId };
        if (RECIPE_SLOT_FIELD in fields) record[RECIPE_SLOT_FIELD] = fields[RECIPE_SLOT_FIELD] ?? null;
        writtenFields = Object.keys(fields);
      }
    } else {
      index = records.findIndex((candidate) => candidate.id === write.localId);
      if (index === -1) return refused(write, 404, "Record not found");
      const current = records[index];
      const settled = settable(write, (field) => valueAt(current, field));
      record = atPaths({ ...current, [GLOBAL_ID_KEY]: write.globalId }, settled);
      writtenFields = Object.keys(settled);
      if (sameValue(record, current)) return written(write, current, writtenFields, now2);
    }
    const before = [...records];
    records[index] = record;
    const slot = record[RECIPE_SLOT_FIELD];
    if (isRecipeSlot(slot)) {
      for (const [at, other] of records.entries()) if (at !== index && other[RECIPE_SLOT_FIELD] === slot) records[at] = { ...other, [RECIPE_SLOT_FIELD]: null };
    }
    const posted = await postList(path, records, before);
    if (!posted.ok) return refused(write, posted.status, posted.text);
    const answer = written(write, record, writtenFields, now2);
    return linked ? { ...answer, linked } : answer;
  }
  var DASHBOARD = "dashboardVariables";
  function valueAt(record, path) {
    if (!path.startsWith(`${DASHBOARD}.`)) return record[path];
    const variables = record[DASHBOARD];
    return isObject5(variables) ? variables[path.slice(DASHBOARD.length + 1)] : void 0;
  }
  function atPaths(record, values) {
    const result = { ...record };
    let variables;
    for (const [path, value] of Object.entries(values)) {
      let target = result;
      let field = path;
      if (path.startsWith(`${DASHBOARD}.`)) {
        variables ?? (variables = { ...isObject5(result[DASHBOARD]) ? result[DASHBOARD] : {} });
        target = variables;
        field = path.slice(DASHBOARD.length + 1);
      }
      if (value === null && path !== RECIPE_SLOT_FIELD) delete target[field];
      else target[field] = value;
    }
    if (variables) result[DASHBOARD] = variables;
    return result;
  }
  function withValues(fields) {
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  }

  // src/collections.ts
  var SOURCES = [
    ...LIBRARY_KINDS.map((kind) => ({ name: LIBRARY_ITEM_KINDS[kind].list, path: libraryListPath(kind) })),
    { name: "appSettings", path: "/settings" },
    { name: "machineSettings", path: "/machine/settings" },
    { name: "advancedSettings", path: "/machine/settings/advanced" },
    { name: "machineCalibration", path: "/machine/calibration" },
    { name: "sensorCalibration", read: readSensorCalibration },
    { name: "pairedDevices", path: "/devices", select: pairedDevices },
    { name: "scaleInfo", path: "/scale/info" },
    { name: "sensors", path: "/sensors" }
  ];
  var RECIPES2 = SOURCES.find((source) => source.name === "dye2Recipes");
  var WRITTEN_LISTS = new Set(LIBRARY_LISTS);
  var MACHINE_SETTINGS = /* @__PURE__ */ new Set(["machineSettings", "advancedSettings", "machineCalibration"]);
  var MACHINE_SETTINGS_MS = 6e4;
  var FULL_READS_ONLY = /* @__PURE__ */ new Set(["sensorCalibration"]);
  var CollectionCapture = class {
    constructor(outbox, library, pollMs, sawRecipes = () => {
    }) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "library", library);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "sawRecipes", sawRecipes);
      /** What was last queued for each collection. */
      __publicField(this, "last", /* @__PURE__ */ new Map());
      /** When each record of each of DYE2's lists that is a Library list was first read in its current content. */
      __publicField(this, "firstReads", /* @__PURE__ */ new Map());
      /** For each collection, the latest delivery queued, and the latest queued with a value. */
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      __publicField(this, "wanted");
      /** Whether DYE2's recipes alone are to be read, as after DYE2 pushes (`readRecipes`). */
      __publicField(this, "recipesWanted", false);
      /** Whether the machine's own settings are to be read, on their interval or after the Workflow wrote them (`readMachineSettings`). */
      __publicField(this, "machineSettingsWanted", false);
      __publicField(this, "reading", false);
      __publicField(this, "stopped", false);
      __publicField(this, "pollTimer");
      __publicField(this, "machineSettingsTimer");
      /** How often the machine's own settings are read while connected. */
      __publicField(this, "machineSettingsMs");
      library.onWrite((list) => this.last.delete(list));
      this.machineSettingsMs = Math.max(MACHINE_SETTINGS_MS, pollMs);
    }
    start() {
      this.schedulePoll();
      this.scheduleMachineSettings();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
      if (this.machineSettingsTimer !== void 0) clearTimeout(this.machineSettingsTimer);
    }
    /** Every collection, read again and sent in full, as on every welcome and whenever the server asks. */
    sendAll() {
      this.read("full");
    }
    /**
     * DYE2's recipes, read again and sent if they changed, while connected: on
     * each push from DYE2, which pushes after it saves into a recipe, so a save
     * made other than through the plugin, as Streamline's Save changes,
     * reaches the server then, not only on the poll (ADR-0022).
     */
    readRecipes() {
      if (this.stopped || !this.outbox.connected) return;
      this.recipesWanted = true;
      void this.run();
    }
    /**
     * DYE2's recipes, read now and queued if they changed, connected or not,
     * resolving once queued: as DYE2 saved into the Loaded Recipe a change of
     * the Workflow the plugin holds back until then, so the server takes in
     * the edit before the Workflow that brought it (ADR-0022). Made within the
     * reads and writes of the tablet's lists (`LibraryAccess.run`), as every
     * read of a list the server writes to is.
     */
    async recipesNow() {
      if (this.stopped) return;
      await this.capture(RECIPES2, false);
    }
    /**
     * The machine's own settings, read again and sent if they changed, while
     * connected: after a Workflow change of its steam, hot water or flush
     * settings, which Decaid writes to the machine before it reports the
     * Workflow (`MachineEvents`), so the change reaches the server then, not
     * only on their interval.
     */
    readMachineSettings() {
      if (this.stopped || !this.outbox.connected) return;
      this.machineSettingsWanted = true;
      void this.run();
    }
    schedulePoll() {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = void 0;
        if (this.outbox.connected) this.read("changes");
        if (!this.stopped) this.schedulePoll();
      }, this.pollMs);
    }
    /** Reads the machine's own settings once their interval has passed since the end of their latest read. */
    scheduleMachineSettings() {
      if (this.machineSettingsTimer !== void 0) clearTimeout(this.machineSettingsTimer);
      this.machineSettingsTimer = setTimeout(() => {
        this.machineSettingsTimer = void 0;
        if (this.outbox.connected) this.readMachineSettings();
        else if (!this.stopped) this.scheduleMachineSettings();
      }, this.machineSettingsMs);
    }
    read(kind) {
      if (this.stopped) return;
      if (kind === "full" || this.wanted === void 0) this.wanted = kind;
      void this.run();
    }
    async run() {
      if (this.reading) return;
      this.reading = true;
      try {
        while ((this.wanted !== void 0 || this.recipesWanted || this.machineSettingsWanted) && !this.stopped) {
          const full = this.wanted === "full";
          const polled = this.wanted !== void 0;
          const recipes = polled || this.recipesWanted;
          this.wanted = void 0;
          this.recipesWanted = false;
          let machineSettings = false;
          const sentLists = /* @__PURE__ */ new Set();
          for (const source of SOURCES) {
            if (this.stopped) return;
            if (MACHINE_SETTINGS.has(source.name)) {
              if (!machineSettings && (full || this.machineSettingsWanted)) {
                machineSettings = true;
                this.machineSettingsWanted = false;
                if (this.machineSettingsTimer !== void 0) clearTimeout(this.machineSettingsTimer);
                this.machineSettingsTimer = void 0;
              }
              if (!machineSettings) continue;
            } else if (FULL_READS_ONLY.has(source.name)) {
              if (!full) continue;
            } else if (!(source.name === "dye2Recipes" ? recipes : polled)) continue;
            const parent = isLibraryList(source.name) ? parentList(source.name) : void 0;
            const sent = await (WRITTEN_LISTS.has(source.name) ? this.library.run(() => this.capture(source, full || parent !== void 0 && sentLists.has(parent))) : this.capture(source, full));
            if (sent) sentLists.add(source.name);
            if (MACHINE_SETTINGS.has(source.name) && !this.stopped) this.scheduleMachineSettings();
          }
        }
      } finally {
        this.reading = false;
      }
    }
    /** Reads a collection, and queues it if it is to be sent. Says whether a value was queued. */
    async capture(source, full) {
      const last = this.last.get(source.name);
      const reading = selected(
        source,
        await ("read" in source ? source.read() : readCollection(source.path, full ? null : ifNoneMatch(last), isDye2List(source.name)))
      );
      if (this.stopped) return false;
      if (source.name === "dye2Recipes" && reading.kind === "value") this.sawRecipes(reading.value);
      const decision = decide(last, reading, full);
      if (decision.next) this.last.set(source.name, decision.next);
      if (!decision.send || reading.kind === "notModified") return false;
      const id = this.outbox.nextId();
      const delivery = reading.kind === "value" ? { type: "collection", id, name: source.name, available: true, value: reading.value, ...this.placedInTime(source.name, reading.value) } : { type: "collection", id, name: source.name, available: false };
      const earlier = this.queued.get(source.name);
      if (earlier) {
        if (delivery.available || earlier.latest !== earlier.value) this.outbox.supersede(earlier.latest);
        if (delivery.available && earlier.value !== void 0 && earlier.value !== earlier.latest) this.outbox.supersede(earlier.value);
      }
      this.queued.set(source.name, { latest: id, value: delivery.available ? id : earlier?.value });
      this.outbox.enqueue(delivery);
      return delivery.available;
    }
    /**
     * For a Library list, each record's `updatedAt` placed in UTC, beside the
     * list: Decaid writes it in the tablet's local time without an offset,
     * which only the plugin, running in the tablet's time zone, can place.
     * DYE2's records carry no edit time, so for a list of a kind DYE2 keeps,
     * when the plugin first read each record's current content
     * (`FirstReads`, ADR-0005).
     */
    placedInTime(name, value) {
      if (!isLibraryList(name) || !Array.isArray(value)) return {};
      if (dye2Key(listKind(name)) !== void 0) {
        let reads = this.firstReads.get(name);
        if (!reads) this.firstReads.set(name, reads = new FirstReads());
        return { updatedAt: reads.times(value, (/* @__PURE__ */ new Date()).toISOString()) };
      }
      return { updatedAt: value.map((record) => utcTime(record?.updatedAt)) };
    }
  };
  var SENSOR_CALIBRATION_TARGETS = ["flow", "pressure", "temperature"];
  var SENSOR_CALIBRATION_SOURCES = ["current", "factory"];
  async function readSensorCalibration() {
    const value = {};
    for (const target of SENSOR_CALIBRATION_TARGETS) {
      const calibrations = {};
      for (const source of SENSOR_CALIBRATION_SOURCES) {
        const reading = await readCollection(`/machine/calibration/${target}?source=${source}`, null);
        if (reading.kind !== "value") return { kind: "unavailable" };
        calibrations[source] = reading.value;
      }
      value[target] = calibrations;
    }
    return { kind: "value", value, etag: null };
  }
  function selected(source, reading) {
    if (reading.kind !== "value" || !source.select) return reading;
    const value = source.select(reading.value);
    return value === null ? { kind: "unavailable" } : { ...reading, value };
  }

  // src/kept-deliveries.ts
  var MAX_KEPT = 2e3;
  var MAX_KEPT_CHARACTERS = 2 * 1024 * 1024;
  var SEQUENCE_KEY = "outbox";
  function isKept(delivery) {
    return delivery.type === "workflow" || delivery.type === "machineState";
  }
  var KeptDeliveries = class {
    constructor(storage, log, token) {
      __publicField(this, "storage", storage);
      __publicField(this, "log", log);
      /** The lowest sequence number kept, or `next` if none is. */
      __publicField(this, "first", 0);
      /** The sequence number the next delivery kept is given. */
      __publicField(this, "next", 0);
      /** The deliveries kept, by sequence number: their ids and the length of their JSON. */
      __publicField(this, "kept", /* @__PURE__ */ new Map());
      /** Their sequence numbers, by delivery id. */
      __publicField(this, "numbers", /* @__PURE__ */ new Map());
      __publicField(this, "characters", 0);
      __publicField(this, "stopped", false);
      /** The hash of the token this load connects with, never the token itself. */
      __publicField(this, "token");
      this.token = tokenHash(token);
    }
    /**
     * The deliveries kept, oldest first. Rejects, saying why, if Decaid
     * refuses or does not answer any read in time, so a read that failed is
     * never taken for nothing kept; loading again retries.
     */
    async load() {
      this.kept.clear();
      this.numbers.clear();
      this.characters = 0;
      const sequence = parseSequence(await this.storage.read(SEQUENCE_KEY, "a read of the deliveries kept"));
      if (sequence.token !== void 0 && sequence.token !== this.token && sequence.first < sequence.next) {
        this.log(`Not sending the Workflow and machine state events kept from before the plugin last unloaded, at most ${sequence.next - sequence.first}: they were made under another token.`);
        for (let seq = sequence.first; seq < sequence.next; seq++) this.writeRemoved(seq);
        this.first = this.next = sequence.next;
        this.writeSequence().catch((error) => this.failed("record the deliveries kept", error));
        return [];
      }
      const deliveries = [];
      for (let seq = sequence.first; seq < sequence.next; seq++) {
        const text = await this.storage.read(slotKey(seq), "a read of a delivery kept");
        const delivery = parseSlot(text, seq);
        if (!delivery) continue;
        this.add(seq, delivery.id, text.length);
        deliveries.push(delivery);
      }
      this.first = sequence.first;
      this.next = sequence.next;
      this.skipRemoved();
      return deliveries;
    }
    /**
     * Keeps a delivery, after those `load` found, dropping the oldest kept if
     * that takes them past either limit. Returns the ids of those dropped,
     * and a promise that settles once Decaid has answered the writes, or
     * failed to: the delivery is then sent either way.
     */
    keep(delivery) {
      const seq = this.next++;
      const text = JSON.stringify({ seq, delivery });
      this.add(seq, delivery.id, text.length);
      const dropped = [];
      while (this.first < seq && (this.next - this.first > MAX_KEPT || this.characters > MAX_KEPT_CHARACTERS)) {
        const oldest = this.kept.get(this.first);
        if (oldest) {
          this.delete(this.first, oldest);
          dropped.push(oldest.id);
          if (slotKey(this.first) !== slotKey(seq)) this.writeRemoved(this.first);
        }
        this.first++;
      }
      this.skipRemoved();
      const written2 = Promise.all([
        this.storage.write(slotKey(seq), text, "the write of a delivery to keep"),
        this.writeSequence()
      ]).then(
        () => void 0,
        (error) => this.failed("keep a delivery, so it is sent without being kept", error)
      );
      return { written: written2, dropped };
    }
    /** Stops keeping a delivery, once acknowledged or no longer to be sent. Does nothing for one not kept. */
    remove(id) {
      const seq = this.numbers.get(id);
      if (seq === void 0) return;
      this.delete(seq, this.kept.get(seq));
      this.writeRemoved(seq);
      if (seq !== this.first) return;
      this.skipRemoved();
      this.writeSequence().catch((error) => this.failed("record a delivery acknowledged", error));
    }
    stop() {
      this.stopped = true;
    }
    add(seq, id, characters) {
      this.kept.set(seq, { id, characters });
      this.numbers.set(id, seq);
      this.characters += characters;
    }
    delete(seq, entry) {
      this.kept.delete(seq);
      this.numbers.delete(entry.id);
      this.characters -= entry.characters;
    }
    /** Moves `first` past the sequence numbers no longer kept. */
    skipRemoved() {
      while (this.first < this.next && !this.kept.has(this.first)) this.first++;
    }
    /** Overwrites the key of a delivery no longer kept with its number alone, so storage no longer holds it. */
    writeRemoved(seq) {
      this.storage.write(slotKey(seq), JSON.stringify({ seq }), "the write of a delivery no longer kept").catch((error) => this.failed("record a delivery no longer kept", error));
    }
    writeSequence() {
      return this.storage.write(SEQUENCE_KEY, JSON.stringify({ first: this.first, next: this.next, token: this.token }), "the write of the deliveries kept");
    }
    failed(what, error) {
      if (!this.stopped) this.log(`Could not ${what} in Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };
  function slotKey(seq) {
    return `${SEQUENCE_KEY}.${seq % MAX_KEPT}`;
  }
  function parseSequence(value) {
    const parsed5 = parse(value);
    const first = parsed5?.first;
    const next = parsed5?.next;
    if (!isCount(first) || !isCount(next) || first > next || next - first > MAX_KEPT) return { first: 0, next: 0 };
    return { first, next, token: typeof parsed5?.token === "string" ? parsed5.token : "" };
  }
  function tokenHash(token) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index++) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  function parseSlot(value, seq) {
    const parsed5 = parse(value);
    if (parsed5?.seq !== seq || parsed5.delivery === void 0) return void 0;
    const decoded = decodeMachineEvent(JSON.stringify(parsed5.delivery));
    return decoded.ok ? decoded.message : void 0;
  }
  function parse(value) {
    if (typeof value !== "string") return void 0;
    try {
      const parsed5 = JSON.parse(value);
      return typeof parsed5 === "object" && parsed5 !== null && !Array.isArray(parsed5) ? parsed5 : void 0;
    } catch {
      return void 0;
    }
  }
  function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  // src/machine-events.ts
  var MachineEvents = class {
    constructor(outbox, observe = () => {
    }, machineSettingsChanged = () => {
    }) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "observe", observe);
      __publicField(this, "machineSettingsChanged", machineSettingsChanged);
      /** The latest Workflow Decaid reported, and when. */
      __publicField(this, "workflow");
      __publicField(this, "reportedAt", now());
      /**
       * How many of the plugin's writes into the Workflow, and saves of its
       * changes into the Loaded Recipe, are under way: the server's writes
       * (`LibraryWrites`), whose answers the server reads first, a Loaded
       * Recipe's (`LoadedRecipes`), whose echo is no change of the tablet's, and
       * a save, whose recipes the server reads first. A change Decaid reports
       * meanwhile is sent once none is.
       */
      __publicField(this, "holds", 0);
      /**
       * Set once a resend was asked for while held (`resend`), and no change was
       * reported while held: the Workflow `release` sends is then that resend
       * alone, which the next welcome's replaces unless it was ever sent. One
       * that holds a change too is no resend: replacing it would lose the change.
       */
      __publicField(this, "heldResend", false);
      /** Set once a change was reported while held. */
      __publicField(this, "heldReport", false);
      /** A change reported while held, which `release` sends. */
      __publicField(this, "heldChange", false);
      /** The delivery that sent it again on the latest welcome, which the next welcome's replaces unless it was ever sent. */
      __publicField(this, "resent");
      /** The state and substate last queued, so repeated state updates send nothing. */
      __publicField(this, "state");
      /** Whether DYE2 is not there, as every Workflow delivery says (`dye2Absent`). */
      __publicField(this, "absent", false);
    }
    /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
    workflowUpdated(payload) {
      const workflow = object(payload);
      if (!workflow) return;
      const previous = this.workflow;
      this.workflow = workflow;
      this.reportedAt = now();
      this.observe(workflow);
      if (this.holds > 0) {
        this.heldChange = true;
        this.heldReport = true;
      } else this.queueWorkflow(workflow);
      if (previous && machineSettingsDiffer(previous, workflow)) this.machineSettingsChanged();
    }
    /** Holds back the Workflow's changes, as one of the plugin's writes into it begins. */
    hold() {
      this.holds++;
    }
    /**
     * Once no write is under way, sends the latest Workflow, observed when
     * Decaid reported it, or now for a resend alone, if it changed while held:
     * that holds the plugin's own writes, and any change a barista made
     * meanwhile.
     */
    release() {
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds > 0) return;
      if (this.heldChange && this.workflow) {
        this.heldChange = false;
        const resend = this.heldResend && !this.heldReport;
        const id = this.queueWorkflow(this.workflow, resend ? now() : this.reportedAt);
        if (resend) this.resent = id;
        this.heldResend = false;
        this.heldReport = false;
      }
    }
    dye2Absent(absent) {
      if (this.absent === absent) return;
      this.absent = absent;
      if (this.workflow && dye2RecipeIdOf(this.workflow) !== null) this.resend();
    }
    /**
     * Decaid's `stateUpdate`, which arrives several times a second while a
     * machine is connected: only a change of state or substate is sent.
     */
    stateUpdate(payload) {
      const reported = object(object(payload)?.state);
      const state = reported?.state;
      const substate = reported?.substate;
      if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return;
      if (this.state?.state === state && this.state.substate === substate) return;
      this.state = { state, substate };
      this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
    }
    /**
     * On every welcome, before the outbox sends, the latest Workflow again,
     * observed now, behind whatever the last connection left unacknowledged.
     * The connection may stand for other hardware than the last one did,
     * after the tablet moved to another machine, and the server changes nothing
     * for a delivery it has handled, even one handled for the last hardware but
     * not acknowledged, so it is always a new delivery; the server records
     * nothing if it is unchanged. It replaces the one the last welcome queued,
     * unless that was ever sent: one sent on the last connection may still be
     * being stored by the instance that received it, so it is sent again, under
     * its id, ahead of this one, and can never be stored after it. The next
     * state update is sent whatever it is, for the same reason.
     */
    welcome() {
      this.state = void 0;
      this.resend();
    }
    /**
     * Sends the latest Workflow again, observed now, as on a welcome: the
     * server asks for it with every collection when the Machine's Location
     * changes (`requestCollections`), so the tablet takes the new Location's
     * settings, or sets them, and its Workflow's grinder, batch and Basket are
     * judged there (ADR-0008).
     */
    resend() {
      if (!this.workflow) return;
      if (this.resent !== void 0) this.outbox.supersede(this.resent);
      this.resent = void 0;
      if (this.holds > 0) {
        this.heldChange = true;
        this.heldResend = true;
      } else this.resent = this.queueWorkflow(this.workflow);
    }
    /** Queues the Workflow as observed now, returning its delivery's id. */
    queueWorkflow(workflow, observedAt = now()) {
      const delivery = { type: "workflow", id: this.outbox.nextId(), observedAt, workflow, ...this.absent ? { dye2Absent: true } : {} };
      this.outbox.enqueue(delivery);
      return delivery.id;
    }
  };
  function machineSettingsDiffer(earlier, later) {
    return MACHINE_SETTING_PARTS.some((part) => !sameValue(earlier[part], later[part]));
  }
  function now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }

  // src/outbox.ts
  var RECORD_NAMES = { shot: "Shot", steam: "Steam Record" };
  var SHORT_OUTBOX = 4;
  var RESTORE_RETRY_MS = 5e3;
  var RESTORE_RETRY_MAX_MS = 5 * 6e4;
  var Outbox = class {
    constructor(log, readers, kept) {
      __publicField(this, "log", log);
      __publicField(this, "readers", readers);
      __publicField(this, "kept", kept);
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      __publicField(this, "watchers", []);
      __publicField(this, "requested", /* @__PURE__ */ new Map());
      __publicField(this, "runtimeId", `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      __publicField(this, "sequence", 0);
      __publicField(this, "sendMessage");
      /** Bumped by every welcome and disconnect, so a send prepared for one connection is not made on the next. */
      __publicField(this, "connections", 0);
      /** The delivery awaiting acknowledgment. */
      __publicField(this, "sent");
      /** Deliveries handed to a connection at least once and not yet acknowledged. */
      __publicField(this, "handed", /* @__PURE__ */ new Set());
      __publicField(this, "working", false);
      __publicField(this, "stopped", false);
      __publicField(this, "retryTimer");
      /** Set until the deliveries kept by earlier loads are read back, and nothing is sent meanwhile. */
      __publicField(this, "restoring", true);
      __publicField(this, "restoreTimer");
      __publicField(this, "restoreDelayMs", RESTORE_RETRY_MS);
      /** The Workflow and machine state deliveries queued while restoring, oldest first, with the length of their JSON. */
      __publicField(this, "whileRestoring", /* @__PURE__ */ new Map());
      __publicField(this, "whileRestoringCharacters", 0);
      /** Deliveries kept whose writes to Decaid's plugin storage are not yet answered; each waits for them before it is sent. */
      __publicField(this, "unwritten", /* @__PURE__ */ new Set());
      /** Whether dropping the oldest deliveries kept was logged since the last welcome. */
      __publicField(this, "droppedLogged", false);
    }
    /**
     * Reads back the deliveries earlier loads kept, and queues them ahead of
     * everything queued since, which is kept after them. It sends nothing
     * meanwhile, so none is sent after a newer one, trying again, with
     * backoff, until Decaid answers. Decaid reads the plugin's storage from
     * memory, so its reads fail all together, and one that cannot read it as
     * the plugin loads cannot read the tablet's id either, without which the
     * plugin does not connect. The Workflow and
     * machine state deliveries queued meanwhile are held to the limits on
     * those kept (`holdWhileRestoring`).
     */
    async restore() {
      let restored;
      try {
        restored = await this.kept.load();
      } catch (error) {
        if (this.stopped) return;
        const delay = this.restoreDelayMs;
        this.restoreDelayMs = Math.min(delay * 2, RESTORE_RETRY_MAX_MS);
        this.log(`Could not read the deliveries kept in Decaid's plugin storage, trying again in ${delay / 1e3} s: ${error instanceof Error ? error.message : String(error)}.`);
        this.restoreTimer = setTimeout(() => {
          this.restoreTimer = void 0;
          void this.restore();
        }, delay);
        return;
      }
      if (this.stopped) return;
      this.whileRestoring.clear();
      this.whileRestoringCharacters = 0;
      const since = [...this.queued.values()];
      this.queued.clear();
      for (const delivery of [...restored, ...since]) this.queued.set(delivery.id, delivery);
      this.restoring = false;
      for (const delivery of since) if (isKept(delivery)) this.keep(delivery);
      const sending = restored.filter((delivery) => this.queued.has(delivery.id)).length;
      if (sending > 0) this.log(`Sending ${sending} Workflow and machine state ${sending === 1 ? "event" : "events"} kept from before the plugin last unloaded.`);
      this.pump();
    }
    /** Whether a welcomed connection is sending. */
    get connected() {
      return this.sendMessage !== void 0;
    }
    welcome(send) {
      this.sendMessage = send;
      this.connections++;
      this.sent = void 0;
      this.droppedLogged = false;
      this.pump();
    }
    disconnected() {
      this.sendMessage = void 0;
      this.connections++;
      this.sent = void 0;
    }
    stop() {
      this.stopped = true;
      this.disconnected();
      this.kept.stop();
      if (this.retryTimer !== void 0) clearTimeout(this.retryTimer);
      if (this.restoreTimer !== void 0) clearTimeout(this.restoreTimer);
    }
    enqueue(delivery) {
      this.queued.set(delivery.id, delivery);
      for (const watcher of this.watchers) watcher(delivery);
      if (isKept(delivery)) {
        if (this.restoring) this.holdWhileRestoring(delivery);
        else this.keep(delivery);
      }
      this.pump();
    }
    acknowledge(id) {
      this.forget(id);
      if (this.sent === id) this.sent = void 0;
      this.pump();
    }
    /** The ids of the records of that kind still to be read and sent. */
    requestedIds(kind) {
      return [...this.requested.values()].filter((record) => record.kind === kind).map((record) => record.id);
    }
    /** Calls `watcher` with every delivery queued from now on, those read for the server's requests included. */
    watch(watcher) {
      this.watchers.push(watcher);
    }
    /**
     * Drops a queued delivery that a newer one makes unnecessary, unless it
     * was ever handed to a connection. One sent before a reconnect may still
     * be being stored by the server instance that received it; sent again,
     * ahead of the newer one, it is found already handled, or waited for, so
     * it can never be stored after the newer one.
     */
    supersede(id) {
      if (this.handed.has(id)) return false;
      this.forget(id);
      return true;
    }
    /**
     * Records to read and send: requested by the server, after those already
     * requested, where a record requested again keeps its place, or, with
     * `first`, ahead of them all, as for records new on the tablet.
     */
    request(kind, ids, options = {}) {
      const records = ids.map((id) => [`${kind}:${id}`, { kind, id }]);
      if (options.first) {
        const keys = new Set(records.map(([key]) => key));
        const others = [...this.requested].filter(([key]) => !keys.has(key));
        this.requested.clear();
        for (const [key, record] of [...records, ...others]) this.requested.set(key, record);
      } else {
        for (const [key, record] of records) this.requested.set(key, record);
      }
      this.pump();
    }
    /** Resolves once few enough deliveries are queued for an index to add a page. */
    async waitForRoom() {
      while (!this.stopped && this.queued.size >= SHORT_OUTBOX) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    nextId() {
      return `${this.runtimeId}-${++this.sequence}`;
    }
    pump() {
      if (this.restoring || this.retryTimer !== void 0 || this.working || this.stopped || !this.sendMessage || this.sent !== void 0 || this.queued.size === 0 && this.requested.size === 0) return;
      const next = this.queued.keys().next();
      if (!next.done && this.unwritten.has(next.value)) return;
      this.working = true;
      void this.work().catch(() => {
        this.log("Delivery interrupted; unacknowledged data remains queued.");
        this.retry();
      }).finally(() => {
        this.working = false;
        if (!this.stopped && this.sendMessage && this.sent === void 0) this.pump();
      });
    }
    async work() {
      const generation = this.connections;
      if (this.queued.size === 0 && this.requested.size > 0) {
        const [key, record] = this.requested.entries().next().value;
        let delivery;
        try {
          delivery = await this.readers[record.kind](record.id, this.nextId());
        } catch {
          this.requested.delete(key);
          this.requested.set(key, record);
          this.log(`Could not read ${RECORD_NAMES[record.kind]} ${record.id} from Decaid; retrying it after the other requested records.`);
          this.retry();
          return;
        }
        if (this.stopped) return;
        this.requested.delete(key);
        if (delivery) {
          this.queued.set(delivery.id, delivery);
          for (const watcher of this.watchers) watcher(delivery);
        }
      }
      if (generation !== this.connections || !this.sendMessage) return;
      const next = this.queued.entries().next().value;
      if (!next) return;
      const [id, message] = next;
      if (this.unwritten.has(id)) return;
      this.sent = id;
      this.handed.add(id);
      await this.sendMessage(message);
    }
    /**
     * Keeps a Workflow or machine state delivery in Decaid's plugin storage,
     * sending it once written there, and drops the oldest kept, unless handed
     * to a connection already, if that takes them past the limits.
     */
    keep(delivery) {
      this.unwritten.add(delivery.id);
      const { written: written2, dropped } = this.kept.keep(delivery);
      for (const id of dropped) {
        if (this.handed.has(id)) continue;
        this.queued.delete(id);
        this.unwritten.delete(id);
      }
      if (dropped.length > 0) this.logDropping();
      void written2.then(() => {
        this.unwritten.delete(delivery.id);
        this.pump();
      });
    }
    /**
     * Holds a Workflow or machine state delivery queued while restoring, to be
     * kept once those kept earlier are read back, dropping the oldest held if
     * that takes them past the limits on those kept.
     */
    holdWhileRestoring(delivery) {
      const characters = JSON.stringify(delivery).length;
      this.whileRestoring.set(delivery.id, characters);
      this.whileRestoringCharacters += characters;
      while (this.whileRestoring.size > 1 && (this.whileRestoring.size > MAX_KEPT || this.whileRestoringCharacters > MAX_KEPT_CHARACTERS)) {
        const [oldest, size] = this.whileRestoring.entries().next().value;
        this.whileRestoring.delete(oldest);
        this.whileRestoringCharacters -= size;
        this.queued.delete(oldest);
        this.logDropping();
      }
    }
    logDropping() {
      if (this.droppedLogged) return;
      this.droppedLogged = true;
      this.log(`Dropping the oldest Workflow and machine state events not yet sent: at most ${MAX_KEPT} are kept, of at most ${MAX_KEPT_CHARACTERS / (1024 * 1024)} Mi characters.`);
    }
    /** Forgets a delivery, in memory and in Decaid's plugin storage. */
    forget(id) {
      const held = this.whileRestoring.get(id);
      if (held !== void 0) {
        this.whileRestoring.delete(id);
        this.whileRestoringCharacters -= held;
      }
      this.queued.delete(id);
      this.handed.delete(id);
      this.unwritten.delete(id);
      this.kept.remove(id);
    }
    retry() {
      if (this.stopped || this.retryTimer !== void 0) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        this.pump();
      }, 5e3);
    }
  };

  // src/sender.ts
  var MAX_UNCONFIRMED_BYTES = 512 * 1024;
  var Sender = class {
    constructor(sendFrame) {
      __publicField(this, "sendFrame", sendFrame);
      __publicField(this, "queue", []);
      __publicField(this, "unconfirmed", []);
      __publicField(this, "unconfirmedBytes", 0);
      __publicField(this, "sending", false);
      /** Set once the transport closed or refused a frame; nothing more is sent. */
      __publicField(this, "failure");
      /** Names chunked messages that have no id of their own. */
      __publicField(this, "unnamed", 0);
    }
    /** Resolves once every frame of the message has been handed to Decaid; rejects if the transport fails first. */
    async send(message) {
      if (this.failure) throw this.failure;
      const id = "id" in message ? message.id : void 0;
      const name = id ?? `message-${++this.unnamed}`;
      const encoded = frames(encode(message), name);
      if (encoded.length === 1 && id === void 0) return this.sendFrame(encoded[0].text);
      return new Promise((resolve, reject) => {
        this.queue.push({ id: name, frames: encoded, sent: 0, resolve, reject });
        void this.pump();
      });
    }
    /** The server received a chunk. */
    received(id, index) {
      this.confirm(id, index);
    }
    /** The server stored a delivery. */
    acknowledged(id) {
      this.confirm(id, void 0);
    }
    /** Fails every message not yet handed to Decaid in full, as the transport has closed. */
    close(error = new Error("The connection closed")) {
      if (this.failure) return;
      this.failure = error;
      for (const queued of this.queue.splice(0)) queued.reject(error);
      this.unconfirmed.length = 0;
      this.unconfirmedBytes = 0;
    }
    confirm(id, index) {
      const at = this.unconfirmed.findIndex((frame) => frame.id === id && frame.index === index);
      if (at < 0) return;
      for (const frame of this.unconfirmed.splice(0, at + 1)) this.unconfirmedBytes -= frame.bytes;
      void this.pump();
    }
    async pump() {
      if (this.sending) return;
      this.sending = true;
      try {
        while (!this.failure && this.queue.length > 0) {
          const next = this.queue[0];
          const frame = next.frames[next.sent];
          if (this.unconfirmedBytes + frame.bytes > MAX_UNCONFIRMED_BYTES) return;
          this.unconfirmed.push({ id: next.id, index: next.frames.length > 1 ? next.sent : void 0, bytes: frame.bytes });
          this.unconfirmedBytes += frame.bytes;
          next.sent++;
          await this.sendFrame(frame.text);
          if (this.failure) return;
          if (next.sent === next.frames.length) {
            this.queue.shift();
            next.resolve();
          }
        }
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.sending = false;
      }
    }
  };

  // src/shots.ts
  var PAGE_SIZE = 100;
  var OVERLAP = 10;
  var MAX_PASSES = 3;
  var ShotCapture = class {
    constructor(outbox, log) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "log", log);
      __publicField(this, "scanning", false);
      __publicField(this, "scanned", false);
      __publicField(this, "stopped", false);
      __publicField(this, "timer");
    }
    welcome() {
      if (!this.scanned && !this.scanning && this.timer === void 0) void this.scan();
    }
    stop() {
      this.stopped = true;
      if (this.timer !== void 0) clearTimeout(this.timer);
    }
    event(type, payload) {
      const event = object2(payload);
      if (this.stopped || !event || !isCaptured(event.id)) return;
      const id = event.id;
      if (type === "shot") {
        this.outbox.request("shot", [id], { first: true });
        return;
      }
      const shot = object2(event.shot);
      if (!shot) return;
      this.outbox.enqueue({ type, id: this.outbox.nextId(), shotId: id, shot });
    }
    /** A Shot new on the tablet or requested by the server, as a delivery, or null if the tablet no longer has it. */
    async read(id, deliveryId) {
      const shot = await readShot(id);
      return shot && { type: "shot", id: deliveryId, shotId: id, shot };
    }
    /** Read bounded summaries once per load; never use the unbounded ids endpoint. */
    async scan() {
      this.scanning = true;
      try {
        for (let pass = 1; !await this.scanPass(); pass++) {
          if (pass === MAX_PASSES) {
            this.log("Shot history kept changing during reconciliation; the next load will reconcile the rest.");
            break;
          }
        }
        this.scanned = !this.stopped;
      } catch {
        this.log("Could not reconcile Shot history; retrying the summary scan.");
        if (!this.stopped) this.timer = setTimeout(() => {
          this.timer = void 0;
          void this.scan();
        }, 5e3);
      } finally {
        this.scanning = false;
      }
    }
    /**
     * Pages through every summary once, newest first. Offsets count positions
     * in the list as it is when each page is read, so a deletion moves later
     * Shots up and an addition moves them down. Each page after the first
     * therefore starts OVERLAP Shots before the previous page ended and
     * resumes after the last Shot this pass has read and that has the edit
     * time it was read with: every unedited Shot older than that one sorts
     * after it, so none that existed throughout the pass is missed. Every
     * Decaid edit gives a Shot a new edit time, and an edit to its time can
     * move it anywhere, but one moved from the part of the list not yet read
     * into the part already read needs no reading: Decaid v0.9.0 and later
     * report every Shot they store or edit, imports included, in `shotStored`
     * or `shotUpdated`, which reach the server on their own. Returns true once
     * the pass reaches the end, or the capture stops, and false if no Shot
     * read with its current edit time reappears, as when more than the
     * overlap were deleted between two pages, or if the list grows past what
     * the first page's total allows: the pass may have missed Shots, so it is
     * repeated.
     */
    async scanPass() {
      const read = /* @__PURE__ */ new Map();
      let remaining = 1;
      for (let offset = 0; remaining > 0; remaining--) {
        await this.outbox.waitForRoom();
        if (this.stopped) return true;
        const page = await readShotPage(PAGE_SIZE, offset);
        if (!page) throw new Error("Shot summaries unavailable");
        const items = page.items.map(object2);
        let resume = 0;
        if (offset === 0) remaining = Math.ceil(page.total / (PAGE_SIZE - OVERLAP)) + 2;
        else {
          for (let index = items.length - 1; index >= 0 && resume === 0; index--) {
            const summary = items[index];
            if (typeof summary?.id === "string" && read.has(summary.id) && read.get(summary.id) === summary.updatedAt) resume = index + 1;
          }
          if (resume === 0) return false;
        }
        const shots = items.slice(resume).flatMap((summary) => {
          if (typeof summary?.id !== "string" || summary.id === "") return [];
          read.set(summary.id, summary.updatedAt);
          if (!isCaptured(summary.id) || typeof summary.updatedAt !== "string") return [];
          return [{ id: summary.id, updatedAt: summary.updatedAt }];
        });
        if (shots.length > 0) this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots });
        if (page.items.length < PAGE_SIZE) return true;
        offset += page.items.length - OVERLAP;
      }
      return false;
    }
  };
  function isCaptured(id) {
    return isRecordId(id) && !id.startsWith("de1app-");
  }
  function object2(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }

  // src/skins.ts
  var SKIN_ENDPOINT = "skin";
  var CHANGED_ENDPOINT = "changed";
  var SKIN_ANSWER = { version: 1, surfaces: [], live: { endpoint: CHANGED_ENDPOINT } };
  var WORKFLOW_CHANGED = { what: "workflow" };
  function answerHttp(request2) {
    if (request2.endpoint !== SKIN_ENDPOINT) return json(404, { error: "Not found" });
    if (request2.method !== "GET") return { ...json(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
    return json(200, SKIN_ANSWER);
  }
  function json(status, body) {
    return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }
  function tellSkins(host, log) {
    const push = (what) => {
      try {
        host.emit(CHANGED_ENDPOINT, WORKFLOW_CHANGED);
      } catch (error) {
        log(`Could not tell skins that ${what} changed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    return {
      listPosted: (key) => {
        if (key === "recipes") push("DYE2's recipes");
      },
      workflowWritten: (before, after) => {
        if (!sameValue(before, after)) push("the Workflow");
      }
    };
  }

  // src/steams.ts
  var PAGE_SIZE2 = 100;
  var FULL_READ_INTERVALS = 10;
  var MAX_RETRY_INTERVALS = 64;
  var SteamCapture = class {
    constructor(outbox, pollMs, log) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "log", log);
      /** Every id this load has seen, in reads of every id and of the newest. */
      __publicField(this, "known", /* @__PURE__ */ new Set());
      /** Whether every id has been read for the index. */
      __publicField(this, "indexed", false);
      /** Whole poll intervals since the last read of every id began, or failed; one begun or failed between intervals counts from the next. */
      __publicField(this, "intervalsSinceFullRead", 0);
      /** Intervals that must begin after a read of every id before the next; none before the first. */
      __publicField(this, "fullReadWait", 0);
      /** Reads of every id that have failed in a row. */
      __publicField(this, "failures", 0);
      __publicField(this, "failureLogged", false);
      __publicField(this, "readingAll", false);
      __publicField(this, "readingLatest", false);
      __publicField(this, "stopped", false);
      __publicField(this, "pollTimer");
    }
    start() {
      this.schedulePoll();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
    }
    /**
     * Polls at once, between intervals, which go on as they were: the poll
     * finds what was recorded while disconnected, and starts the load's index.
     */
    welcome() {
      this.poll(false);
    }
    /** A Steam Record, as a delivery placed in time, or null if the tablet no longer has it or its time cannot be read. */
    async read(id, deliveryId) {
      const steam = await readSteam(id);
      if (!steam) return null;
      const steamedAt = utcTime(steam.timestamp);
      if (steamedAt === null) {
        this.log(`Not sending Steam Record ${id}: its time is not one Decaid writes.`);
        return null;
      }
      return { type: "steam", id: deliveryId, steamId: id, steamedAt, steam };
    }
    schedulePoll() {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = void 0;
        this.intervalsSinceFullRead++;
        this.poll(true);
        if (!this.stopped) this.schedulePoll();
      }, this.pollMs);
    }
    /**
     * Requests the Steam Records new since the last poll, ahead of those the
     * server requested: the newest, and, when they are due, any that every id
     * shows. Each read is skipped while its last one still runs.
     */
    poll(atInterval) {
      if (this.stopped || !this.outbox.connected) return;
      if (!this.readingAll && this.intervalsSinceFullRead >= this.fullReadWait) void this.readAll(atInterval);
      if (!this.readingLatest) void this.readLatest();
    }
    async readLatest() {
      this.readingLatest = true;
      try {
        const latest = await readLatestSteamId();
        if (latest !== null && !this.stopped) this.request([latest]);
      } catch {
      } finally {
        this.readingLatest = false;
      }
    }
    /** Reads every id: the first time, to send them as the index; after that, to request those not seen. */
    async readAll(atInterval) {
      this.readingAll = true;
      this.intervalsSinceFullRead = atInterval ? 0 : -1;
      let ids;
      try {
        ids = await readSteamIds();
      } catch (error) {
        this.intervalsSinceFullRead = -1;
        this.fullReadWait = Math.min((this.indexed ? FULL_READ_INTERVALS : 1) * 2 ** this.failures, MAX_RETRY_INTERVALS);
        this.failures++;
        if (!this.failureLogged) {
          this.failureLogged = true;
          this.log(
            `Could not read the Steam Record ids: ${error instanceof Error ? error.message : String(error)}. New Steam Records are still sent; reading every id is tried again less and less often until it succeeds.`
          );
        }
        return;
      } finally {
        this.readingAll = false;
      }
      this.fullReadWait = FULL_READ_INTERVALS;
      this.failures = 0;
      if (this.stopped) return;
      if (this.indexed) {
        this.request(ids);
        return;
      }
      this.indexed = true;
      for (const id of ids) this.known.add(id);
      void this.sendIndex(ids);
    }
    /** Requests the Steam Records among these not seen before, ahead of those the server requested. */
    request(ids) {
      const fresh = ids.filter((id) => !this.known.has(id));
      for (const id of fresh) this.known.add(id);
      if (fresh.length > 0) this.outbox.request("steam", fresh, { first: true });
    }
    /**
     * Queues the index in pages, each once few deliveries are queued. While
     * disconnected the outbox sends nothing, so the pages wait, and the next
     * welcome sends those left, after any it had sent and not had acknowledged.
     */
    async sendIndex(ids) {
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE2) {
        await this.outbox.waitForRoom();
        if (this.stopped) return;
        this.outbox.enqueue({ type: "steamIndex", id: this.outbox.nextId(), steams: ids.slice(offset, offset + PAGE_SIZE2).map((id) => ({ id })) });
      }
    }
  };

  // src/storage.ts
  var STORAGE_TIMEOUT_MS = 1e4;
  var PluginStorage = class {
    constructor(host) {
      __publicField(this, "host", host);
      /** Commands waiting their turn, in order. */
      __publicField(this, "queue", []);
      /** The writes among them, by key. */
      __publicField(this, "queuedWrites", /* @__PURE__ */ new Map());
      /** The command sent and awaiting Decaid's answer. */
      __publicField(this, "waiting");
      /**
       * Set once Decaid leaves a write unanswered, until it answers anything:
       * meanwhile writes are sent without waiting for answers, as with a Decaid
       * failing every write each would otherwise hold up what waits on it for
       * STORAGE_TIMEOUT_MS.
       */
      __publicField(this, "unanswered", false);
      __publicField(this, "stopped", false);
    }
    /** The value at `key`, null if it was never written. Rejects, saying why, if Decaid refuses or does not answer in time. */
    async read(key, what) {
      const answer = await this.run({ type: "read", key }, what, "storageRead", (payload) => {
        return typeof payload === "object" && payload !== null && payload.key === key;
      });
      return answer.value ?? null;
    }
    /**
     * Writes `data` at `key`, or a later write's data to the same key, made
     * while this one waited its turn. Rejects, saying why, if Decaid refuses or
     * does not answer in time; it may still have written it. While Decaid
     * leaves writes unanswered, it resolves once the write is sent.
     */
    async write(key, data, what) {
      const queued = this.queuedWrites.get(key);
      if (!queued || this.stopped) {
        await this.run({ type: "write", key, data }, what, "storageWrite", (payload) => payload === data);
        return;
      }
      queued.command = { type: "write", key, data };
      queued.what = what;
      queued.answers = (payload) => payload === data;
      await new Promise((resolve, reject) => queued.waiting.push({ resolve, reject }));
    }
    /** A Decaid event, which may answer the command awaiting one. */
    answered(name, payload) {
      this.unanswered = false;
      const waiting = this.waiting;
      if (!waiting || name !== waiting.command.event || !waiting.command.answers(payload)) return;
      this.settle();
      for (const waiter of waiting.command.waiting) waiter.resolve(payload);
      this.next();
    }
    /**
     * Sends the writes still waiting their turn, without waiting for Decaid's
     * answers, which it no longer sends once the plugin has unloaded, and
     * gives up on the reads. The write awaiting an answer is sent again first:
     * Decaid drops one it received just before the unload if it handles the
     * unload first, and writing the same data twice changes nothing.
     */
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      const unloading = new Error("the plugin is unloading");
      const sent = this.settle();
      const unsent = [...sent ? [sent.command] : [], ...this.queue.splice(0)];
      this.queuedWrites.clear();
      for (const command of unsent) {
        if (command.command.type === "write") {
          try {
            this.host.storage(command.command);
          } catch {
          }
        }
        fail(command, unloading);
      }
    }
    run(command, what, event, answers) {
      if (this.stopped) return Promise.reject(new Error("the plugin is unloading"));
      return new Promise((resolve, reject) => {
        const queued = { command, what, event, answers, waiting: [{ resolve, reject }] };
        this.queue.push(queued);
        if (command.type === "write") this.queuedWrites.set(command.key, queued);
        if (!this.waiting) this.next();
      });
    }
    /** Sends the commands waiting their turn: the next one, or, while Decaid leaves writes unanswered, every write up to a read. */
    next() {
      for (; ; ) {
        const command = this.queue.shift();
        if (!command) return;
        if (command.command.type === "write") this.queuedWrites.delete(command.command.key);
        if (this.unanswered && command.command.type === "write") {
          try {
            this.host.storage(command.command);
            for (const waiter of command.waiting) waiter.resolve(void 0);
          } catch (error) {
            fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
          }
          continue;
        }
        const timer = setTimeout(() => {
          this.settle();
          if (command.command.type === "write") this.unanswered = true;
          fail(command, new Error(`Decaid's plugin storage did not answer ${command.what} within ${STORAGE_TIMEOUT_MS / 1e3} s`));
          this.next();
        }, STORAGE_TIMEOUT_MS);
        this.waiting = { command, timer };
        try {
          this.host.storage(command.command);
          return;
        } catch (error) {
          this.settle();
          fail(command, new Error(`Decaid refused ${command.what}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }
    /** Stops waiting for the answer to the command sent, returning what waited. */
    settle() {
      const waiting = this.waiting;
      if (waiting) clearTimeout(waiting.timer);
      this.waiting = void 0;
      return waiting;
    }
  };
  function fail(command, error) {
    for (const waiter of command.waiting) waiter.reject(error);
  }

  // src/connection.ts
  var MIN_RECONNECT_MS = 1e3;
  var MAX_RECONNECT_MS = 6e4;
  var CONNECT_TIMEOUT_MS = 15e3;
  var MAX_TRANSPORTS = 8;
  var HARDWARE_CHECK_COOLDOWN_MS = 5e3;
  var YIELD_MS = 5 * 6e4;
  var SEND_FAILURE_GRACE_MS = 2e3;
  var FINAL_CLOSES = /* @__PURE__ */ new Map([
    [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
    [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
    [CLOSE_CODES.decaid_too_old, "The server needs a newer version of Decaid. Update Decaid on this tablet."]
  ]);
  var YIELDING_CLOSES = /* @__PURE__ */ new Map([
    [
      CLOSE_CODES.replaced,
      `Another tablet connected with this Machine's token and took over. Connecting again in ${YIELD_MS / 1e3} s, unless that tablet is still connected then.`
    ],
    [CLOSE_CODES.machine_held, `Another tablet is still connected with this Machine's token. Trying again in ${YIELD_MS / 1e3} s.`]
  ]);
  var SyncConnection = class {
    constructor(host, settings, log) {
      __publicField(this, "host", host);
      __publicField(this, "settings", settings);
      __publicField(this, "log", log);
      /** The open handle, or undefined while disconnected. */
      __publicField(this, "handle");
      /** Sends every message on the open handle. */
      __publicField(this, "sender");
      /** Puts the open handle's chunked messages from the server back together. */
      __publicField(this, "chunks", new Reassembly());
      /** Bumped by every attempt and drop, so late results of an older one are ignored. */
      __publicField(this, "attempt", 0);
      __publicField(this, "connecting", false);
      __publicField(this, "stopped", false);
      __publicField(this, "welcomed", false);
      /** How long a welcomed connection may go without hearing from the server, from its `welcome`. */
      __publicField(this, "silenceMs", 0);
      __publicField(this, "reconnectDelayMs", MIN_RECONNECT_MS);
      /** Transports opening, open or closing, as Decaid counts them against MAX_TRANSPORTS. */
      __publicField(this, "transportsInUse", 0);
      __publicField(this, "timers", /* @__PURE__ */ new Map());
      /** The hardware the latest `hello` reported, null while no machine was connected. */
      __publicField(this, "sentHardware", null);
      /**
       * Set once the machine this connection's `hello` reported is seen gone:
       * no hardware read, or Decaid refusing a Loaded Recipe's hot water as no
       * machine is connected. Decaid refuses those while it is gone, and the
       * server skips such a write until it changes or the tablet reconnects, so
       * once the same machine is back the plugin reconnects, and is written it
       * again.
       */
      __publicField(this, "machineAway", false);
      /** Hardware the server dismissed for this token; while set, the plugin does not connect. */
      __publicField(this, "dismissedHardware", null);
      /** Set once another tablet replaced this one, until a `yielding` hello is welcomed. */
      __publicField(this, "yielding", false);
      /** Decaid's plugin storage, where the tablet's id and the outbox's Workflow and machine state events are kept. */
      __publicField(this, "storage");
      /** Everything awaiting the server's acknowledgment, kept across reconnects, and its Workflow and machine state events across unloads. */
      __publicField(this, "outbox");
      __publicField(this, "shots");
      __publicField(this, "steams");
      __publicField(this, "machineEvents");
      /** Follows the recipe the Workflow names as the Machine's Loaded Recipe, and saves the Workflow's changes into it. */
      __publicField(this, "loadedRecipes");
      __publicField(this, "collections");
      /** Carries out the Library writes the server asks for, one at a time, between reads of the lists it writes to. */
      __publicField(this, "writes");
      /** This tablet's id, read from Decaid's plugin storage before the first connection and sent in every `hello`. */
      __publicField(this, "tabletId");
      __publicField(this, "checkingHardware", false);
      __publicField(this, "hardwareCooldown", false);
      this.storage = new PluginStorage(host);
      this.outbox = new Outbox(
        log,
        {
          shot: (id, deliveryId) => this.shots.read(id, deliveryId),
          steam: (id, deliveryId) => this.steams.read(id, deliveryId)
        },
        new KeptDeliveries(this.storage, log, settings.token)
      );
      this.shots = new ShotCapture(this.outbox, log);
      this.steams = new SteamCapture(this.outbox, settings.pollSeconds * 1e3, log);
      const skins = tellSkins(host, log);
      const library = new LibraryAccess();
      this.loadedRecipes = new LoadedRecipes(
        {
          hold: () => this.machineEvents.hold(),
          release: () => this.machineEvents.release(),
          dye2Absent: (absent) => this.machineEvents.dye2Absent(absent)
        },
        library,
        log,
        {
          // DYE2's socket leaves one transport for a connection to the server.
          open: async (url) => {
            if (this.transportsInUse >= MAX_TRANSPORTS - 1) throw new Error("Decaid allows no more transports");
            this.transportsInUse++;
            try {
              return (await this.host.transport.open({ kind: "websocket", url })).handle;
            } catch (error) {
              this.transportsInUse--;
              throw error;
            }
          },
          onEvent: (handle, listener) => this.host.transport.onEvent(handle, listener),
          close: (handle) => this.closeTransport(handle)
        },
        settings.pollSeconds * 1e3,
        () => this.collections.readRecipes(),
        () => this.collections.recipesNow(),
        skins.workflowWritten
      );
      this.machineEvents = new MachineEvents(
        this.outbox,
        (workflow) => this.loadedRecipes.observe(workflow),
        () => this.collections.readMachineSettings()
      );
      this.collections = new CollectionCapture(this.outbox, library, settings.pollSeconds * 1e3, (value) => this.loadedRecipes.sawRecipes(value));
      this.writes = new LibraryWrites(
        library,
        this.outbox,
        this.loadedRecipes,
        () => {
          if (this.sentHardware !== null) this.machineAway = true;
        },
        log,
        skins
      );
      this.tabletId = new TabletId(this.storage, log);
    }
    /**
     * Reads back the outbox's deliveries kept by earlier loads, and connects,
     * from timers, so the caller (onLoad) returns at once.
     */
    start() {
      this.setTimer("restore", 0, () => void this.outbox.restore());
      this.setTimer("reconnect", 0, () => void this.connect());
      this.scheduleHardwarePoll();
      this.steams.start();
      this.collections.start();
      this.loadedRecipes.start();
    }
    /**
     * A machine state update, sent only while a machine is connected: a change
     * of state is recorded, and the machine may have just reported its hardware.
     */
    stateUpdate(payload) {
      if (this.stopped) return;
      this.machineEvents.stateUpdate(payload);
      this.checkHardwareSoon();
    }
    workflowUpdated(payload) {
      if (!this.stopped) this.machineEvents.workflowUpdated(payload);
    }
    shotEvent(type, payload) {
      this.shots.event(type, payload);
    }
    /** Decaid's answer to a command to its plugin storage. */
    storageEvent(name, payload) {
      this.storage.answered(name, payload);
    }
    stop() {
      this.stopped = true;
      this.outbox.stop();
      this.shots.stop();
      this.steams.stop();
      this.collections.stop();
      this.loadedRecipes.stop();
      this.tabletId.stop();
      this.storage.stop();
      for (const id of this.timers.values()) clearTimeout(id);
      this.timers.clear();
      this.closeHandle();
    }
    /** Checks the machine's hardware, unless a check started within the cooldown. */
    checkHardwareSoon() {
      if (this.hardwareCooldown) return;
      this.hardwareCooldown = true;
      this.setTimer("hardwareCooldown", HARDWARE_CHECK_COOLDOWN_MS, () => {
        this.hardwareCooldown = false;
      });
      void this.checkHardware();
    }
    async connect() {
      if (this.stopped || this.connecting || this.handle !== void 0) return;
      this.connecting = true;
      const attempt = ++this.attempt;
      try {
        let tabletId;
        try {
          tabletId = await this.tabletId.read();
        } catch (error) {
          if (attempt === this.attempt) this.drop(describe(error));
          return;
        }
        if (this.stopped || attempt !== this.attempt) return;
        const identity = await readTabletIdentity();
        if (this.stopped || attempt !== this.attempt) return;
        if (identity.decaidVersion === null) {
          this.drop("could not read Decaid's version from its API");
          return;
        }
        if (this.transportsInUse >= MAX_TRANSPORTS) {
          this.drop(
            `${this.transportsInUse} earlier connection attempts are still waiting for the server to answer, and Decaid allows no more until one ends. Reloading the plugin releases them`
          );
          return;
        }
        this.setTimer(
          "connect",
          CONNECT_TIMEOUT_MS,
          () => this.drop(`the server did not answer within ${CONNECT_TIMEOUT_MS / 1e3} s`)
        );
        const handle = await this.openTransport();
        if (this.stopped || attempt !== this.attempt) {
          this.closeTransport(handle);
          return;
        }
        this.handle = handle;
        this.sender = new Sender((frame) => this.host.transport.send(handle, { type: "text", data: frame }));
        this.chunks = new Reassembly();
        this.welcomed = false;
        this.sentHardware = identity.machine;
        this.machineAway = false;
        this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
        await this.send(handle, {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: this.settings.token,
          pluginVersion: "1.0.2",
          decaidVersion: identity.decaidVersion,
          tabletId,
          connectionId: identity.connectionId,
          machine: identity.machine,
          ...this.yielding ? { yielding: true } : {}
        });
      } catch (error) {
        if (attempt === this.attempt) this.drop(`could not connect to ${this.settings.syncUrl}: ${describe(error)}`);
      } finally {
        if (attempt === this.attempt) this.connecting = false;
      }
    }
    onTransportEvent(handle, event) {
      if (handle !== this.handle) return;
      switch (event.type) {
        case "data":
          if (event.dataType === "text") this.onFrame(handle, event.data);
          if (handle === this.handle && this.welcomed) this.awaitServer(handle);
          break;
        case "error":
          this.drop(`connection error (${event.code}): ${event.message}`);
          break;
        case "close": {
          if (event.code === CLOSE_CODES.hardware_dismissed && this.sentHardware) {
            this.dismissedHardware = this.sentHardware;
            this.abandon();
            this.log(
              "The server refused this machine's hardware for this Machine's token. Not connecting until the machine reports other hardware, or another token is entered."
            );
            break;
          }
          const final = event.code === void 0 ? void 0 : FINAL_CLOSES.get(event.code);
          const yielding = event.code === void 0 ? void 0 : YIELDING_CLOSES.get(event.code);
          if (final) {
            this.log(final);
            this.stop();
          } else if (yielding) {
            this.yieldToAnotherTablet(yielding);
          } else {
            this.drop(`the server closed the connection${event.code === void 0 ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`}`);
          }
          break;
        }
      }
    }
    onFrame(handle, frame) {
      const decoded = decodeServerFrame(frame);
      if (!decoded.ok) {
        this.log(`Ignoring a message from the server: ${decoded.problem}`);
        return;
      }
      if (decoded.message.type !== "chunk") return this.onMessage(handle, decoded.message);
      const added = this.chunks.add(decoded.message, CHUNK_LIMITS);
      if (added.status === "invalid") return this.drop(`the server sent chunks that do not fit together: ${added.problem}`);
      if (added.status === "incomplete") return;
      const whole = decodeServerMessage(added.text);
      if (!whole.ok) return this.log(`Ignoring a message from the server: ${whole.problem}`);
      this.onMessage(handle, whole.message);
    }
    onMessage(handle, message) {
      switch (message.type) {
        case "welcome":
          if (this.welcomed) return;
          this.welcomed = true;
          this.yielding = false;
          this.reconnectDelayMs = MIN_RECONNECT_MS;
          this.clearTimer("connect");
          this.log(`Connected to ${this.settings.syncUrl}`);
          this.silenceMs = message.heartbeatIntervalMs * MISSED_HEARTBEATS;
          this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
          this.machineEvents.welcome();
          this.outbox.welcome(async (delivery) => {
            try {
              await this.send(handle, delivery);
            } catch (error) {
              this.sendFailed(handle, "could not send a delivery");
              throw error;
            }
          });
          this.collections.sendAll();
          this.shots.welcome();
          this.steams.welcome();
          break;
        case "ack":
          this.sender?.acknowledged(message.id);
          this.outbox.acknowledge(message.id);
          break;
        case "chunkReceived":
          this.sender?.received(message.id, message.index);
          break;
        case "requestShots":
          this.outbox.request("shot", message.shotIds);
          break;
        case "requestSteams":
          this.outbox.request("steam", message.steamIds);
          break;
        case "captureOnly":
          this.loadedRecipes.setCaptureOnly(message.captureOnly);
          break;
        case "requestCollections":
          this.machineEvents.resend();
          this.collections.sendAll();
          break;
        case "write":
          void this.writes.apply(message);
          break;
        case "delete":
          void this.writes.remove(message);
          break;
        case "remove":
          void this.writes.drop(message);
          break;
        case "leaveOut":
          void this.writes.leaveOut(message);
          break;
        case "heartbeat":
          break;
        case "error": {
          this.log(`The server reported ${describeError(message.code)}: ${message.message}`);
          const yielding = YIELDING_CLOSES.get(CLOSE_CODES[message.code]);
          if (yielding) this.yieldToAnotherTablet(yielding);
          break;
        }
      }
    }
    scheduleHeartbeat(handle, intervalMs) {
      this.setTimer("heartbeat", intervalMs, () => {
        if (handle !== this.handle) return;
        this.send(handle, { type: "heartbeat" }).then(
          () => this.scheduleHeartbeat(handle, intervalMs),
          (error) => {
            this.sendFailed(handle, `could not send a heartbeat: ${describe(error)}`);
          }
        );
      });
    }
    /** Restarts the wait for the server's next message, dropping the connection if none comes in time. */
    awaitServer(handle) {
      this.setTimer("silence", this.silenceMs, () => {
        if (handle === this.handle) this.drop(`heard nothing from the server for ${this.silenceMs / 1e3} s`);
      });
    }
    /**
     * A send on the handle failed. Its transport's events, the server's last
     * messages among them, are handled first, and decide what happens next; if
     * none ends the connection in time, it is dropped for `reason`.
     */
    sendFailed(handle, reason) {
      if (handle !== this.handle) return;
      this.setTimer("sendFailed", SEND_FAILURE_GRACE_MS, () => {
        if (handle === this.handle) this.drop(reason);
      });
    }
    /** Sends on the handle, in chunks if the message is too large for a frame, unless the handle was dropped. */
    send(handle, message) {
      if (handle !== this.handle || !this.sender) return Promise.reject(new Error("The connection closed"));
      return this.sender.send(message);
    }
    /**
     * Reads the machine's hardware and reconnects if the current connection
     * reported other hardware, or none, or if it differs from hardware the
     * server dismissed.
     */
    async checkHardware() {
      if (this.stopped || this.checkingHardware) return;
      this.checkingHardware = true;
      try {
        const hardware = await readMachineHardware();
        if (this.stopped) return;
        if (hardware === null) {
          if (this.welcomed && this.sentHardware !== null) this.machineAway = true;
          return;
        }
        if (this.dismissedHardware) {
          if (sameHardware(hardware, this.dismissedHardware)) return;
          this.dismissedHardware = null;
          this.log("The machine reports other hardware than the server refused. Connecting.");
          this.reconnectNow();
          return;
        }
        if (!this.welcomed) return;
        if (sameHardware(hardware, this.sentHardware)) {
          if (!this.machineAway) return;
          this.log("The machine is connected again. Reconnecting, so the server writes what Decaid refused while it was away.");
          this.reconnectNow();
          return;
        }
        this.log(
          this.sentHardware === null ? "The machine reports its hardware now. Reconnecting to tell the server." : "The machine reports different hardware. Reconnecting to tell the server."
        );
        this.reconnectNow();
      } finally {
        this.checkingHardware = false;
      }
    }
    scheduleHardwarePoll() {
      this.setTimer("hardwarePoll", this.settings.pollSeconds * 1e3, () => {
        void this.checkHardware().finally(() => {
          if (!this.stopped) this.scheduleHardwarePoll();
        });
      });
    }
    /**
     * Gives way to another tablet with this Machine's token: drops the
     * connection, keeps capturing, and after YIELD_MS connects with a
     * `yielding` hello.
     */
    yieldToAnotherTablet(notice) {
      this.yielding = true;
      this.abandon();
      this.log(notice);
      this.setTimer("reconnect", YIELD_MS, () => void this.connect());
    }
    /** Replaces the current connection, or ends a wait, with a new attempt at once. */
    reconnectNow() {
      this.abandon();
      this.reconnectDelayMs = MIN_RECONNECT_MS;
      this.setTimer("reconnect", 0, () => void this.connect());
    }
    /** Abandons the current connection or attempt, if any, without trying again. */
    abandon() {
      this.attempt++;
      this.connecting = false;
      this.clearTimer("reconnect");
      this.closeHandle();
    }
    /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
    drop(reason) {
      this.abandon();
      if (this.stopped) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
      this.log(`Disconnected: ${reason}. Reconnecting in ${Math.round(delay / 1e3)} s.`);
      this.setTimer("reconnect", delay, () => void this.connect());
    }
    closeHandle() {
      const handle = this.handle;
      this.handle = void 0;
      this.welcomed = false;
      this.sender?.close();
      this.sender = void 0;
      this.outbox.disconnected();
      this.clearTimer("heartbeat");
      this.clearTimer("silence");
      this.clearTimer("connect");
      this.clearTimer("sendFailed");
      if (handle !== void 0) this.closeTransport(handle);
    }
    async openTransport() {
      this.transportsInUse++;
      try {
        return (await this.host.transport.open({ kind: "websocket", url: this.settings.syncUrl })).handle;
      } catch (error) {
        this.transportsInUse--;
        throw error;
      }
    }
    /** Closes a transport, which counts against the limit until Decaid has closed it. */
    closeTransport(handle) {
      const release = () => {
        this.transportsInUse--;
      };
      this.host.transport.close(handle).then(release, release);
    }
    setTimer(name, delay, callback) {
      this.clearTimer(name);
      this.timers.set(
        name,
        setTimeout(() => {
          this.timers.delete(name);
          callback();
        }, delay)
      );
    }
    clearTimer(name) {
      const id = this.timers.get(name);
      if (id !== void 0) clearTimeout(id);
      this.timers.delete(name);
    }
  };
  function describeError(code) {
    return code.replace(/_/g, " ");
  }
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/settings.ts
  var DEFAULT_POLL_SECONDS = 30;
  var MIN_POLL_SECONDS = 5;
  function readSettings(settings) {
    const problems = [];
    const serverUrl = typeof settings.ServerUrl === "string" ? settings.ServerUrl.trim() : "";
    const syncUrl = serverUrl ? syncUrlFor(serverUrl) : void 0;
    if (!serverUrl) problems.push("Server URL is not set");
    else if (!syncUrl) problems.push("Server URL must be the server's http:// or https:// address");
    const token = typeof settings.Token === "string" ? settings.Token.trim() : "";
    if (!token) problems.push("Token is not set");
    const poll = Number(settings.PollSeconds);
    const pollSeconds = settings.PollSeconds !== void 0 && Number.isFinite(poll) && poll > 0 ? Math.max(poll, MIN_POLL_SECONDS) : DEFAULT_POLL_SECONDS;
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, settings: { syncUrl, token, pollSeconds } };
  }
  function syncUrlFor(serverUrl) {
    const match = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]\S*)?$/i.exec(serverUrl);
    if (!match) return void 0;
    const scheme = match[1].toLowerCase() === "https" ? "wss" : "ws";
    return `${scheme}://${match[2]}${SYNC_PATH}`;
  }

  // src/index.ts
  function createPlugin(host) {
    let connection;
    return {
      id: "decent-sync.reaplugin",
      version: "1.0.2",
      onLoad(settings) {
        host.log(`Decent Sync ${"1.0.2"} loaded (protocol ${PROTOCOL_VERSION})`);
        const read = readSettings(settings ?? {});
        if (!read.ok) {
          host.log(`Not connecting: ${read.problems.join("; ")}. Enter them in this plugin's settings.`);
          return;
        }
        connection = new SyncConnection(host, read.settings, (message) => host.log(message));
        connection.start();
      },
      onUnload() {
        connection?.stop();
        connection = void 0;
      },
      onEvent(event) {
        if (event?.name === "shotStored") connection?.shotEvent("shot", event.payload);
        if (event?.name === "shotUpdated") connection?.shotEvent("shotUpdated", event.payload);
        if (event?.name === "workflowUpdated") connection?.workflowUpdated(event.payload);
        if (event?.name === "stateUpdate") connection?.stateUpdate(event.payload);
        if (event?.name === "storageRead" || event?.name === "storageWrite") connection?.storageEvent(event.name, event.payload);
      },
      // Answered whether or not the plugin connects: a skin asks every loaded plugin.
      __httpRequestHandler: answerHttp
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
