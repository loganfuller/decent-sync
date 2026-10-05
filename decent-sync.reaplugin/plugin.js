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

  // ../protocol/src/index.ts
  var PROTOCOL_VERSION = 1;
  var SYNC_PATH = "/sync";
  var MISSED_HEARTBEATS = 3;
  var CLOSE_CODES = {
    /** A frame that is not a valid message here, including no `hello` in time. */
    protocol_error: 4e3,
    /** The token is unknown or has been revoked. */
    bad_token: 4001,
    /** The plugin speaks a protocol version older than the server supports. */
    plugin_too_old: 4002,
    /** A newer connection with the same token took over. */
    replaced: 4003,
    /**
     * An Admin dismissed the hardware this tablet reports for this token: its
     * machine is not the one the token was issued for.
     */
    hardware_dismissed: 4004,
    /** The tablet runs a Decaid older than the server supports. */
    decaid_too_old: 4005
  };
  function sameHardware(a, b) {
    if (a === null || b === null) return a === b;
    return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
  }
  function encode(message) {
    return JSON.stringify(message);
  }
  function decodeServerMessage(frame) {
    const object = parseObject(frame);
    if (typeof object === "string") return invalid(object);
    switch (object.type) {
      case "welcome":
        return check(object, "welcome", (fields) => {
          fields.integer("protocolVersion");
          fields.integer("heartbeatIntervalMs", { positive: true });
        });
      case "ack":
        return check(object, "ack", (fields) => fields.string("id", { nonEmpty: true }));
      case "chunkReceived":
        return check(object, "chunkReceived", (fields) => {
          fields.string("id", { nonEmpty: true });
          fields.integer("index", { nonNegative: true });
        });
      case "requestShots":
        return check(object, "requestShots", (fields) => {
          fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "heartbeat":
        return check(object, "heartbeat", () => {
        });
      case "error":
        return check(object, "error", (fields) => {
          fields.string("code");
          fields.string("message");
        });
      default:
        return invalid("Unknown message type");
    }
  }
  var FieldChecker = class _FieldChecker {
    constructor(object, path, problems) {
      __publicField(this, "object", object);
      __publicField(this, "path", path);
      __publicField(this, "problems", problems);
    }
    string(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "string") this.problem(key, "must be a string");
      else if (options.nonEmpty && value === "") this.problem(key, "must not be empty");
    }
    optionalString(key) {
      const value = this.object[key];
      if (value !== void 0 && value !== null && typeof value !== "string") this.problem(key, "must be a string or null");
    }
    integer(key, options = {}) {
      const value = this.object[key];
      if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key, "must be a whole number");
      else if (options.positive && value <= 0) this.problem(key, "must be positive");
      else if (options.nonNegative && value < 0) this.problem(key, "must not be negative");
    }
    objectField(key) {
      if (!isObject(this.object[key])) this.problem(key, "must be an object");
    }
    /** A time in UTC, as `Date.prototype.toISOString` writes one: 2026-10-05T14:05:43.648Z. */
    utcTime(key) {
      const value = this.object[key];
      if (typeof value !== "string" || !isUtcTime(value)) this.problem(key, "must be a UTC time, such as 2026-10-05T14:05:43.648Z");
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
  function check(object, type, checkFields) {
    const fields = new FieldChecker(object, type, []);
    checkFields(fields);
    if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
    return { ok: true, message: object };
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
  function isUtcTime(text) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(text)) return false;
    const time = new Date(text);
    return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 19) === text.slice(0, 19);
  }
  function invalid(problem) {
    return { ok: false, error: "protocol_error", problem };
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
      return asObject(await response.json()) ?? null;
    } catch {
      return null;
    }
  }
  function asObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  }
  function stringField(object, key) {
    const value = object?.[key];
    return typeof value === "string" && value !== "" ? value : null;
  }
  async function readShotPage(limit, offset) {
    const page = await getObject(`/shots?limit=${limit}&offset=${offset}&order=desc`);
    return Array.isArray(page?.items) ? { items: page.items } : null;
  }
  async function readShot(id) {
    const response = await fetch(`${API}/shots/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Shot unavailable");
    const body = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Shot response unavailable");
    return body;
  }

  // src/machine-events.ts
  var MachineEvents = class {
    constructor(outbox) {
      __publicField(this, "outbox", outbox);
      /** The latest Workflow Decaid reported, as last queued. */
      __publicField(this, "workflow");
      /** The state and substate last queued, so repeated state updates send nothing. */
      __publicField(this, "state");
    }
    /** Decaid's `workflowUpdated`: the whole Workflow, sent on every load and every change. */
    workflowUpdated(payload) {
      const workflow = asObject(payload);
      if (!workflow) return;
      this.queueWorkflow(workflow);
    }
    /**
     * Decaid's `stateUpdate`, which arrives several times a second while a
     * machine is connected: only a change of state or substate is sent.
     */
    stateUpdate(payload) {
      const reported = asObject(asObject(payload)?.state);
      const state = reported?.state;
      const substate = reported?.substate;
      if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return;
      if (this.state?.state === state && this.state.substate === substate) return;
      this.state = { state, substate };
      this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
    }
    /**
     * On every welcome, the latest Workflow, unless its delivery is still
     * queued and so is sent anyway. The connection may stand for other
     * hardware than the last one did, after the tablet moved to another
     * machine, so the Workflow is observed again now, and the next state
     * update is sent whatever it is.
     */
    welcome() {
      this.state = void 0;
      if (this.workflow && !this.outbox.has(this.workflow.id)) this.queueWorkflow(this.workflow.workflow);
    }
    queueWorkflow(workflow) {
      this.workflow = { type: "workflow", id: this.outbox.nextId(), observedAt: now(), workflow };
      this.outbox.enqueue(this.workflow);
    }
  };
  function now() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }

  // src/outbox.ts
  var RETRY_MS = 5e3;
  var Outbox = class {
    constructor(log) {
      __publicField(this, "log", log);
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      __publicField(this, "runtimeId", `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      __publicField(this, "sequence", 0);
      __publicField(this, "sendMessage");
      __publicField(this, "generation", 0);
      __publicField(this, "sent");
      __publicField(this, "working", false);
      __publicField(this, "stopped", false);
      __publicField(this, "retryTimer");
      __publicField(this, "backlog");
    }
    /** An id for a new delivery, unique to this runtime. */
    nextId() {
      return `${this.runtimeId}-${++this.sequence}`;
    }
    /** How many deliveries await acknowledgment. */
    get size() {
      return this.queued.size;
    }
    /** Whether the delivery awaits acknowledgment. */
    has(id) {
      return this.queued.has(id);
    }
    /** Draws on the backlog whenever nothing is queued. */
    drawOn(backlog) {
      this.backlog = backlog;
    }
    enqueue(message) {
      this.queued.set(message.id, message);
      this.pump();
    }
    /** A connection was welcomed: sends through it, starting with what the last one left unacknowledged. */
    welcome(send) {
      this.sendMessage = send;
      this.generation++;
      this.sent = void 0;
      this.pump();
    }
    disconnected() {
      this.sendMessage = void 0;
      this.generation++;
      this.sent = void 0;
    }
    stop() {
      this.stopped = true;
      this.disconnected();
      if (this.retryTimer !== void 0) clearTimeout(this.retryTimer);
    }
    acknowledge(id) {
      this.queued.delete(id);
      if (this.sent === id) this.sent = void 0;
      this.pump();
    }
    /** One logical message awaits acknowledgment at a time. */
    pump() {
      if (this.retryTimer !== void 0 || this.working || this.stopped || !this.sendMessage || this.sent !== void 0) return;
      if (this.queued.size === 0 && !this.backlog?.hasMore()) return;
      this.working = true;
      void this.work().catch(() => {
        this.log("Delivery interrupted; unacknowledged data remains queued.");
        this.retry();
      }).finally(() => {
        this.working = false;
        if (!this.stopped && this.sendMessage && this.sent === void 0) this.pump();
      });
    }
    /** Tries again after a while, as after a failure that may pass. */
    retry() {
      if (this.stopped || this.retryTimer !== void 0) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        this.pump();
      }, RETRY_MS);
    }
    async work() {
      const generation = this.generation;
      if (this.queued.size === 0 && this.backlog?.hasMore()) {
        const produced = await this.backlog.next();
        if (this.stopped) return;
        if (produced) this.queued.set(produced.id, produced);
      }
      if (generation !== this.generation || !this.sendMessage) return;
      const next = this.queued.entries().next().value;
      if (!next) return;
      const [id, message] = next;
      this.sent = id;
      await this.sendMessage(message);
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
  var SHORT_OUTBOX = 4;
  var ShotCapture = class {
    constructor(log, outbox) {
      __publicField(this, "log", log);
      __publicField(this, "outbox", outbox);
      __publicField(this, "requested", /* @__PURE__ */ new Set());
      __publicField(this, "ids", /* @__PURE__ */ new Set());
      /** Bumped by every welcome and disconnection, so an index of a past connection stops. */
      __publicField(this, "connection", 0);
      __publicField(this, "scanning", false);
      __publicField(this, "scanned", false);
      __publicField(this, "welcomed", false);
      __publicField(this, "stopped", false);
      __publicField(this, "timer");
      __publicField(this, "events", Promise.resolve());
      outbox.drawOn(this);
    }
    /** The first welcome scans the tablet's history; later ones index the Shots already known. */
    welcome() {
      this.connection++;
      if (this.welcomed) void this.indexKnownIds();
      this.welcomed = true;
      if (!this.scanned && !this.scanning && this.timer === void 0) void this.scan();
    }
    disconnected() {
      this.connection++;
    }
    stop() {
      this.stopped = true;
      this.connection++;
      if (this.timer !== void 0) clearTimeout(this.timer);
    }
    request(ids) {
      for (const id of ids) this.requested.add(id);
      this.outbox.pump();
    }
    event(type, payload) {
      const event = asObject(payload);
      if (typeof event?.id !== "string" || event.id === "" || isLegacyImport(event.id)) return;
      const id = event.id;
      this.events = this.events.then(async () => {
        if (type === "shotUpdated") {
          const shot2 = asObject(event.shot);
          if (shot2 && !this.stopped) this.capture(type, id, shot2);
          return;
        }
        let shot;
        try {
          shot = await readShot(id);
        } catch {
          this.requested.add(id);
          this.outbox.retry();
          return;
        }
        if (shot && !this.stopped) this.capture(type, id, shot);
      }).catch(() => this.log("Could not capture a Shot event; reconciliation will recover it."));
    }
    hasMore() {
      return this.requested.size > 0;
    }
    /** The next requested Shot, fetched in full. */
    async next() {
      const id = this.requested.values().next().value;
      if (id === void 0) return null;
      let shot;
      try {
        shot = await readShot(id);
      } catch (error) {
        this.requested.delete(id);
        this.requested.add(id);
        throw error;
      }
      if (this.stopped) return null;
      this.requested.delete(id);
      return shot ? { type: "shot", id: this.outbox.nextId(), shotId: id, shot } : null;
    }
    capture(type, id, shot) {
      this.ids.add(id);
      this.outbox.enqueue({ type, id: this.outbox.nextId(), shotId: id, shot });
    }
    /** Read bounded summaries once per load; never use the unbounded ids endpoint. */
    async scan() {
      this.scanning = true;
      try {
        for (let offset = 0; !this.stopped; offset += PAGE_SIZE) {
          await this.waitForRoom();
          if (this.stopped) return;
          const page = await readShotPage(PAGE_SIZE, offset);
          if (!page) throw new Error("Shot summaries unavailable");
          const shots = page.items.flatMap((item) => {
            const summary = asObject(item);
            if (typeof summary?.id !== "string" || summary.id === "" || isLegacyImport(summary.id) || typeof summary.updatedAt !== "string") return [];
            this.ids.add(summary.id);
            return [{ id: summary.id, updatedAt: summary.updatedAt }];
          });
          this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots });
          if (page.items.length < PAGE_SIZE) break;
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
    async indexKnownIds() {
      const connection = this.connection;
      const ids = [...this.ids];
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
        await this.waitForRoom();
        if (this.stopped || connection !== this.connection) return;
        this.outbox.enqueue({ type: "shotIndex", id: this.outbox.nextId(), shots: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
      }
    }
    async waitForRoom() {
      while (!this.stopped && this.outbox.size >= SHORT_OUTBOX) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  function isLegacyImport(id) {
    return id.startsWith("de1app-");
  }

  // src/connection.ts
  var MIN_RECONNECT_MS = 1e3;
  var MAX_RECONNECT_MS = 6e4;
  var CONNECT_TIMEOUT_MS = 15e3;
  var MAX_TRANSPORTS = 8;
  var HARDWARE_CHECK_COOLDOWN_MS = 5e3;
  var FINAL_CLOSES = /* @__PURE__ */ new Map([
    [CLOSE_CODES.bad_token, "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one."],
    [CLOSE_CODES.plugin_too_old, "The server needs a newer version of this plugin. Update the plugin."],
    [CLOSE_CODES.decaid_too_old, "The server needs a newer version of Decaid. Update Decaid on this tablet."],
    [CLOSE_CODES.replaced, "Another tablet connected with this Machine's token, so this one stopped. Reload the plugin to take over again."]
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
      /** Hardware the server dismissed for this token; while set, the plugin does not connect. */
      __publicField(this, "dismissedHardware", null);
      /** Everything the server acknowledges goes through it, across connections. */
      __publicField(this, "outbox");
      __publicField(this, "shots");
      __publicField(this, "machineEvents");
      __publicField(this, "checkingHardware", false);
      __publicField(this, "hardwareCooldown", false);
      this.outbox = new Outbox(log);
      this.shots = new ShotCapture(log, this.outbox);
      this.machineEvents = new MachineEvents(this.outbox);
    }
    /** Connects from a timer, so the caller (onLoad) returns at once. */
    start() {
      this.setTimer("reconnect", 0, () => void this.connect());
      this.scheduleHardwarePoll();
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
    stop() {
      this.stopped = true;
      this.outbox.stop();
      this.shots.stop();
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
        this.welcomed = false;
        this.sentHardware = identity.machine;
        this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
        await this.send(handle, {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: this.settings.token,
          pluginVersion: "0.1.1",
          decaidVersion: identity.decaidVersion,
          connectionId: identity.connectionId,
          machine: identity.machine
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
          if (final) {
            this.log(final);
            this.stop();
          } else {
            this.drop(`the server closed the connection${event.code === void 0 ? "" : ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`}`);
          }
          break;
        }
      }
    }
    onFrame(handle, frame) {
      const decoded = decodeServerMessage(frame);
      if (!decoded.ok) {
        this.log(`Ignoring a message from the server: ${decoded.problem}`);
        return;
      }
      this.onMessage(handle, decoded.message);
    }
    onMessage(handle, message) {
      switch (message.type) {
        case "welcome":
          if (this.welcomed) return;
          this.welcomed = true;
          this.reconnectDelayMs = MIN_RECONNECT_MS;
          this.clearTimer("connect");
          this.log(`Connected to ${this.settings.syncUrl}`);
          this.silenceMs = message.heartbeatIntervalMs * MISSED_HEARTBEATS;
          this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
          this.outbox.welcome(async (delivery) => {
            try {
              await this.send(handle, delivery);
            } catch (error) {
              if (handle === this.handle) this.drop("could not send a delivery");
              throw error;
            }
          });
          this.machineEvents.welcome();
          this.shots.welcome();
          break;
        case "ack":
          this.sender?.acknowledged(message.id);
          this.outbox.acknowledge(message.id);
          break;
        case "chunkReceived":
          this.sender?.received(message.id, message.index);
          break;
        case "requestShots":
          this.shots.request(message.shotIds);
          break;
        case "heartbeat":
          break;
        case "error":
          this.log(`The server reported ${describeError(message.code)}: ${message.message}`);
          break;
      }
    }
    scheduleHeartbeat(handle, intervalMs) {
      this.setTimer("heartbeat", intervalMs, () => {
        if (handle !== this.handle) return;
        this.send(handle, { type: "heartbeat" }).then(
          () => this.scheduleHeartbeat(handle, intervalMs),
          (error) => {
            if (handle === this.handle) this.drop(`could not send a heartbeat: ${describe(error)}`);
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
        if (this.stopped || hardware === null) return;
        if (this.dismissedHardware) {
          if (sameHardware(hardware, this.dismissedHardware)) return;
          this.dismissedHardware = null;
          this.log("The machine reports other hardware than the server refused. Connecting.");
          this.reconnectNow();
          return;
        }
        if (!this.welcomed || sameHardware(hardware, this.sentHardware)) return;
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
      this.shots.disconnected();
      this.clearTimer("heartbeat");
      this.clearTimer("silence");
      this.clearTimer("connect");
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
      version: "0.1.1",
      onLoad(settings) {
        host.log(`Decent Sync ${"0.1.1"} loaded (protocol ${PROTOCOL_VERSION})`);
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
      }
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
