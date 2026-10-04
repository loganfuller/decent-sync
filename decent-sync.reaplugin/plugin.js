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
  var CLOSE_CODES = {
    /** A frame that is not a valid message here, including no `hello` in time. */
    protocol_error: 4e3,
    /** The token is unknown or has been revoked. */
    bad_token: 4001,
    /** The plugin speaks a protocol version older than the server supports. */
    plugin_too_old: 4002,
    /** A newer connection with the same token took over. */
    replaced: 4003
  };
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
  function invalid(problem) {
    return { ok: false, error: "protocol_error", problem };
  }

  // src/decaid.ts
  var API = "http://localhost:8080/api/v1";
  async function readTabletIdentity() {
    const [info, settings, machine] = await Promise.all([getObject("/info"), getObject("/settings"), getObject("/machine/info")]);
    return {
      decaidVersion: stringField(info, "fullVersion"),
      // Decaid keeps the preferred machine's id, so it is known before the machine connects.
      connectionId: stringField(settings, "preferredMachineId"),
      machine: readHardware(machine)
    };
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
  function stringField(object, key) {
    const value = object?.[key];
    return typeof value === "string" && value !== "" ? value : null;
  }

  // src/connection.ts
  var MIN_RECONNECT_MS = 1e3;
  var MAX_RECONNECT_MS = 6e4;
  var CONNECT_TIMEOUT_MS = 15e3;
  var MAX_TRANSPORTS = 8;
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
      __publicField(this, "reconnectDelayMs", MIN_RECONNECT_MS);
      /** Transports opening, open or closing, as Decaid counts them against MAX_TRANSPORTS. */
      __publicField(this, "transportsInUse", 0);
      __publicField(this, "timers", /* @__PURE__ */ new Map());
    }
    /** Connects from a timer, so the caller (onLoad) returns at once. */
    start() {
      this.setTimer("reconnect", 0, () => void this.connect());
    }
    stop() {
      this.stopped = true;
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
        this.host.transport.onEvent(handle, (event) => this.onTransportEvent(handle, event));
        await this.send(handle, {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: this.settings.token,
          pluginVersion: "0.1.0",
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
          break;
        case "error":
          this.drop(`connection error (${event.code}): ${event.message}`);
          break;
        case "close": {
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
          this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
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
    send(handle, message) {
      return this.host.transport.send(handle, { type: "text", data: encode(message) });
    }
    /** Abandons the current connection or attempt, if any, and tries again after the backoff delay. */
    drop(reason) {
      this.attempt++;
      this.connecting = false;
      this.closeHandle();
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
      this.clearTimer("heartbeat");
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
  function readSettings(settings) {
    const problems = [];
    const serverUrl = typeof settings.ServerUrl === "string" ? settings.ServerUrl.trim() : "";
    const syncUrl = serverUrl ? syncUrlFor(serverUrl) : void 0;
    if (!serverUrl) problems.push("Server URL is not set");
    else if (!syncUrl) problems.push("Server URL must be the server's http:// or https:// address");
    const token = typeof settings.Token === "string" ? settings.Token.trim() : "";
    if (!token) problems.push("Token is not set");
    const poll = Number(settings.PollSeconds);
    const pollSeconds = settings.PollSeconds !== void 0 && Number.isFinite(poll) && poll > 0 ? poll : DEFAULT_POLL_SECONDS;
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
      version: "0.1.0",
      onLoad(settings) {
        host.log(`Decent Sync ${"0.1.0"} loaded (protocol ${PROTOCOL_VERSION})`);
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
      onEvent() {
      }
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
