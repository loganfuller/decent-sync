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
    hardware_dismissed: 4004
  };
  function sameHardware(a, b) {
    if (a === null || b === null) return a === b;
    return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
  }
  function encode(message) {
    return JSON.stringify(message);
  }
  function decodeServerMessage(frame) {
    const object2 = parseObject(frame);
    if (typeof object2 === "string") return invalid(object2);
    switch (object2.type) {
      case "welcome":
        return check(object2, "welcome", (fields) => {
          fields.integer("protocolVersion");
          fields.integer("heartbeatIntervalMs", { positive: true });
        });
      case "ack":
        return check(object2, "ack", (fields) => fields.string("id", { nonEmpty: true }));
      case "requestShots":
        return check(object2, "requestShots", (fields) => {
          fields.array("shotIds", (value) => typeof value === "string" && value !== "", 100);
        });
      case "heartbeat":
        return check(object2, "heartbeat", () => {
        });
      case "error":
        return check(object2, "error", (fields) => {
          fields.string("code");
          fields.string("message");
        });
      default:
        return invalid("Unknown message type");
    }
  }
  var FieldChecker = class _FieldChecker {
    constructor(object2, path, problems) {
      __publicField(this, "object", object2);
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
    }
    objectField(key) {
      if (!isObject(this.object[key])) this.problem(key, "must be an object");
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
  function check(object2, type, checkFields) {
    const fields = new FieldChecker(object2, type, []);
    checkFields(fields);
    if (fields.problems.length > 0) return invalid(fields.problems.join("; "));
    return { ok: true, message: object2 };
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
      const body = await response.json();
      return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }
  function stringField(object2, key) {
    const value = object2?.[key];
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

  // src/shots.ts
  var PAGE_SIZE = 100;
  var SHORT_OUTBOX = 4;
  var ShotCapture = class {
    constructor(log) {
      __publicField(this, "log", log);
      __publicField(this, "outbox", /* @__PURE__ */ new Map());
      __publicField(this, "requested", /* @__PURE__ */ new Set());
      __publicField(this, "ids", /* @__PURE__ */ new Set());
      __publicField(this, "runtimeId", `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      __publicField(this, "sequence", 0);
      __publicField(this, "sendFrame");
      __publicField(this, "generation", 0);
      __publicField(this, "sent");
      __publicField(this, "working", false);
      __publicField(this, "scanning", false);
      __publicField(this, "scanned", false);
      __publicField(this, "welcomed", false);
      __publicField(this, "stopped", false);
      __publicField(this, "timer");
      __publicField(this, "retryTimer");
      __publicField(this, "events", Promise.resolve());
    }
    welcome(send) {
      this.sendFrame = send;
      this.generation++;
      this.sent = void 0;
      if (this.welcomed) void this.indexKnownIds();
      this.welcomed = true;
      if (!this.scanned && !this.scanning && this.timer === void 0) void this.scan();
      this.pump();
    }
    disconnected() {
      this.sendFrame = void 0;
      this.generation++;
      this.sent = void 0;
    }
    stop() {
      this.stopped = true;
      this.disconnected();
      if (this.timer !== void 0) clearTimeout(this.timer);
      if (this.retryTimer !== void 0) clearTimeout(this.retryTimer);
    }
    acknowledge(id) {
      this.outbox.delete(id);
      if (this.sent === id) this.sent = void 0;
      this.pump();
    }
    request(ids) {
      for (const id of ids) this.requested.add(id);
      this.pump();
    }
    event(type, payload) {
      const event = object(payload);
      if (typeof event?.id !== "string" || event.id === "" || isLegacyImport(event.id)) return;
      const id = event.id;
      this.events = this.events.then(async () => {
        if (type === "shotUpdated") {
          const shot2 = object(event.shot);
          if (shot2 && !this.stopped) this.capture(type, id, shot2);
          return;
        }
        let shot;
        try {
          shot = await readShot(id);
        } catch {
          this.requested.add(id);
          this.retry();
          return;
        }
        if (this.stopped) return;
        if (shot) return this.capture(type, id, shot);
        this.requested.add(id);
        this.log("Could not read a Shot from Decaid; it will be retried.");
        this.pump();
      }).catch(() => this.log("Could not capture a Shot event; reconciliation will recover it."));
    }
    capture(type, id, shot) {
      this.ids.add(id);
      this.enqueue({ type, id: this.nextId(), shotId: id, shot });
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
            const summary = object(item);
            if (typeof summary?.id !== "string" || summary.id === "" || isLegacyImport(summary.id) || typeof summary.updatedAt !== "string") return [];
            this.ids.add(summary.id);
            return [{ id: summary.id, updatedAt: summary.updatedAt }];
          });
          this.enqueue({ type: "shotIndex", id: this.nextId(), shots });
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
      const generation = this.generation;
      const ids = [...this.ids];
      for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
        await this.waitForRoom();
        if (this.stopped || generation !== this.generation) return;
        this.enqueue({ type: "shotIndex", id: this.nextId(), shots: ids.slice(offset, offset + PAGE_SIZE).map((id) => ({ id })) });
      }
    }
    async waitForRoom() {
      while (!this.stopped && this.outbox.size >= SHORT_OUTBOX) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    enqueue(message) {
      this.outbox.set(message.id, message);
      this.pump();
    }
    /** One logical message awaits ack at a time, leaving Decaid's pending transport room for heartbeats. */
    pump() {
      if (this.retryTimer !== void 0 || this.working || this.stopped || !this.sendFrame || this.sent !== void 0 || this.outbox.size === 0 && this.requested.size === 0) return;
      this.working = true;
      void this.work().catch(() => {
        this.log("Shot delivery interrupted; unacknowledged data remains queued.");
        this.retry();
      }).finally(() => {
        this.working = false;
        if (!this.stopped && this.sendFrame && this.sent === void 0) this.pump();
      });
    }
    async work() {
      const generation = this.generation;
      if (this.outbox.size === 0 && this.requested.size > 0) {
        const id2 = this.requested.values().next().value;
        let shot;
        try {
          shot = await readShot(id2);
        } catch (error) {
          this.requested.delete(id2);
          this.requested.add(id2);
          throw error;
        }
        if (this.stopped) return;
        this.requested.delete(id2);
        if (shot) {
          const envelopeId = this.nextId();
          this.outbox.set(envelopeId, { type: "shot", id: envelopeId, shotId: id2, shot });
        }
      }
      if (generation !== this.generation || !this.sendFrame) return;
      const next = this.outbox.entries().next().value;
      if (!next) return;
      const [id, message] = next;
      this.sent = id;
      await this.sendFrame(message);
    }
    retry() {
      if (this.stopped || this.retryTimer !== void 0) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = void 0;
        this.pump();
      }, 5e3);
    }
    nextId() {
      return `${this.runtimeId}-${++this.sequence}`;
    }
  };
  function isLegacyImport(id) {
    return id.startsWith("de1app-");
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
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
    [CLOSE_CODES.replaced, "Another tablet connected with this Machine's token, so this one stopped. Reload the plugin to take over again."]
  ]);
  var SyncConnection = class {
    constructor(host, settings, log) {
      __publicField(this, "host", host);
      __publicField(this, "settings", settings);
      __publicField(this, "log", log);
      /** The open handle, or undefined while disconnected. */
      __publicField(this, "handle");
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
      __publicField(this, "shots");
      __publicField(this, "checkingHardware", false);
      __publicField(this, "hardwareCooldown", false);
      this.shots = new ShotCapture(log);
    }
    /** Connects from a timer, so the caller (onLoad) returns at once. */
    start() {
      this.setTimer("reconnect", 0, () => void this.connect());
      this.scheduleHardwarePoll();
    }
    /** A machine state update: the machine is connected, and may have just reported its hardware. */
    machineActive() {
      if (this.stopped || this.hardwareCooldown) return;
      this.hardwareCooldown = true;
      this.setTimer("hardwareCooldown", HARDWARE_CHECK_COOLDOWN_MS, () => {
        this.hardwareCooldown = false;
      });
      void this.checkHardware();
    }
    shotEvent(type, payload) {
      this.shots.event(type, payload);
    }
    stop() {
      this.stopped = true;
      this.shots.stop();
      for (const id of this.timers.values()) clearTimeout(id);
      this.timers.clear();
      this.closeHandle();
    }
    async connect() {
      if (this.stopped || this.connecting || this.handle !== void 0) return;
      this.connecting = true;
      const attempt = ++this.attempt;
      try {
        const identity = await readTabletIdentity();
        if (this.stopped || attempt !== this.attempt) return;
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
          this.shots.welcome(async (frame) => {
            try {
              await this.send(handle, frame);
            } catch (error) {
              if (handle === this.handle) this.drop("could not send a Shot delivery");
              throw error;
            }
          });
          break;
        case "ack":
          this.shots.acknowledge(message.id);
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
    send(handle, message) {
      return this.host.transport.send(handle, { type: "text", data: encode(message) });
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
        if (event?.name === "stateUpdate") connection?.machineActive();
      }
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
