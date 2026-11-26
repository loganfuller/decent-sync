// Decent Sync plugin for Decaid. Generated from plugin/ by `npm run build -w plugin`; do not edit.
"use strict";
var __decentSync = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key2, value) => key2 in obj ? __defProp(obj, key2, { enumerable: true, configurable: true, writable: true, value }) : obj[key2] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key2 of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key2) && key2 !== except)
          __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key2, value) => __defNormalProp(obj, typeof key2 !== "symbol" ? key2 + "" : key2, value);

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
    return chunks(text, id, maxFrameBytes);
  }
  function chunks(text, id, maxFrameBytes = MAX_FRAME_BYTES) {
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
      const chunks2 = message ? 0 : count;
      if (this.heldLength + length > limits.maxLength || this.heldChunks + chunks2 > limits.maxChunks) {
        return `Chunked messages still incomplete may hold at most ${limits.maxLength} characters, ids included, and ${limits.maxChunks} chunks between them`;
      }
      return void 0;
    }
  };

  // ../protocol/src/settings-fields.ts
  var SETTINGS_COLLECTION_NAMES = [
    "machineSettings",
    "advancedSettings",
    "machineCalibration",
    "sensorCalibration",
    "appSettings",
    "presenceSettings"
  ];
  function isSettingsCollectionName(name) {
    return SETTINGS_COLLECTION_NAMES.includes(name);
  }
  var EDITABLE_SETTINGS_COLLECTIONS = [
    "machineSettings",
    "advancedSettings",
    "machineCalibration",
    "sensorCalibration",
    "appSettings",
    "presenceSettings"
  ];
  function isEditableSettingsCollection(name) {
    return EDITABLE_SETTINGS_COLLECTIONS.includes(name);
  }
  function isEditable(field) {
    return "editableBy" in field;
  }
  var SET_BY_WORKFLOW = "Set by the Workflow";
  var SETTINGS_FIELDS = {
    machineSettings: [
      // The DE1 holds the fan threshold to 0 to 50 (`MMRItem`), as Streamline's page does (`FAN_THRESHOLD_MAX`).
      { path: "fan", label: "Fan threshold", unit: "°C", kind: "wholeNumber", min: 0, max: 50, editableBy: "staff", notes: ["keptByTablet"] },
      {
        path: "steamPurgeMode",
        label: "Steam purge mode",
        kind: "choice",
        choices: [
          { value: 0, label: "Normal" },
          { value: 1, label: "Two Tap Stop" }
        ],
        editableBy: "staff"
      },
      // Decaid writes the Workflow's back to the Machine on every reconnect (`_setDe1DefaultsFor`), and a Loaded Recipe holds them.
      { path: "steamFlow", label: "Steam flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
      { path: "hotWaterFlow", label: "Hot water flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
      { path: "flushFlow", label: "Flush flow", unit: "ml/s", kind: "number", setBy: SET_BY_WORKFLOW },
      { path: "flushTemp", label: "Flush temperature", unit: "°C", kind: "number", setBy: SET_BY_WORKFLOW },
      { path: "flushTimeout", label: "Flush time-out", unit: "s", kind: "number", setBy: SET_BY_WORKFLOW },
      { path: "tankTemp", label: "Tank temperature", unit: "°C", kind: "number", setBy: "Set by each profile" },
      // `BatteryController` switches it as the charging mode asks.
      { path: "usb", label: "USB charger", kind: "onOff", setBy: "Set by the Tablet's charging mode" }
    ],
    advancedSettings: [
      { path: "heaterPh1Flow", label: "Heater warmup flow", unit: "ml/s", kind: "number", min: 0, max: 10, step: 0.1, editableBy: "admin" },
      { path: "heaterPh2Flow", label: "Heater test flow", unit: "ml/s", kind: "number", min: 0, max: 10, step: 0.1, editableBy: "admin" },
      { path: "heaterIdleTemp", label: "Idle temperature", unit: "°C", kind: "wholeNumber", min: 0, max: 99, editableBy: "admin" },
      { path: "heaterPh2Timeout", label: "Heater test time-out", unit: "s", kind: "wholeNumber", min: 0, max: 60, editableBy: "admin" },
      // Only the two values Streamline offers: Decaid writes -1 for one outside 90 to 150 and 180 to 260 (`De1HeaterVoltage.fromInt`).
      // Streamline's restore leaves it alone.
      {
        path: "heaterVoltage",
        label: "Heater voltage",
        kind: "choice",
        choices: [
          { value: 120, label: "110 V" },
          { value: 230, label: "220 V" }
        ],
        editableBy: "admin",
        notes: ["restartAfterChange"]
      },
      {
        path: "refillKitSetting",
        label: "Refill kit",
        kind: "choice",
        choices: [
          { value: 2, label: "Auto-Detect" },
          { value: 1, label: "Force On" },
          { value: 0, label: "Force Off" }
        ],
        editableBy: "admin",
        notes: ["keptByTablet"]
      }
    ],
    machineCalibration: [
      // The range Decaid clamps to (`calFlowEst`), in the thousandths the Machine keeps. "Flow calibration" on Streamline's page
      // from v0.2.29, "Flow multiplier" before; Decaid's field keeps its name.
      { path: "flowMultiplier", label: "Flow calibration", kind: "number", min: 0.13, max: 2, step: 1e-3, editableBy: "admin", notes: ["writtenAgainByTablet"] }
    ],
    sensorCalibration: [
      // The band Streamline accepts for one correction (`SENSOR_CAL_RATIO_MIN` and `SENSOR_CAL_RATIO_MAX` in
      // streamline-js:src/modules/sensor-cal.js). Upstream sets no bound for the temperature offset; this one is chosen here.
      { path: "flow", label: "Flow sensor multiplier", kind: "number", min: 0.75, max: 1.33, step: 1e-4, editableBy: "admin" },
      { path: "pressure", label: "Pressure sensor multiplier", kind: "number", min: 0.75, max: 1.33, step: 1e-4, editableBy: "admin" },
      { path: "temperature", label: "Temperature sensor offset", unit: "°C", kind: "number", min: -10, max: 10, step: 0.01, editableBy: "admin" }
    ],
    appSettings: [
      {
        path: "gatewayMode",
        label: "Gateway mode",
        kind: "choice",
        choices: [
          { value: "disabled", label: "Disabled" },
          { value: "tracking", label: "Tracking" },
          { value: "full", label: "Full" }
        ],
        editableBy: "admin"
      },
      {
        path: "scalePowerMode",
        label: "Scale power mode",
        kind: "choice",
        choices: [
          { value: "disabled", label: "Nothing" },
          { value: "displayOff", label: "Display Off" },
          { value: "disconnect", label: "Disconnect" }
        ],
        editableBy: "staff"
      },
      { path: "blockOnNoScale", label: "Block Shots with no scale", kind: "onOff", editableBy: "staff" },
      { path: "blockTareDuringShot", label: "Block taring during a Shot", kind: "onOff", editableBy: "staff" },
      { path: "stopHotWaterAtWeight", label: "Stop hot water at weight", kind: "onOff", editableBy: "staff" },
      // Each a lead time in seconds: Decaid stops a Shot, or hot water, that long before its target at the flow it is
      // pouring (`ShotSequencer`, `HotWaterSequencer`). Decaid takes any number, and Streamline's page any of 0 or more: its
      // ± buttons' 0.1 and 0.05 are increments, not limits. Upstream sets no step; this one is chosen here, 0.01 s being
      // 0.05 g at 5 g/s (#343). From v0.2.29 Streamline names them look-aheads, on its "Shot control" page, where it named
      // them flow multipliers; Decaid's fields keep their names.
      { path: "weightFlowMultiplier", label: "Weight look-ahead", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
      { path: "volumeFlowMultiplier", label: "Volume look-ahead", unit: "s", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
      { path: "hotWaterFlowMultiplier", label: "Hot water look-ahead", unit: "s", kind: "number", min: 0, step: 0.01, editableBy: "staff" },
      {
        path: "chargingMode",
        label: "Charging mode",
        kind: "choice",
        choices: [
          { value: "disabled", label: "Charge to 100%" },
          { value: "highAvailability", label: "Charge to 95%" },
          { value: "balanced", label: "Charge up to 80%" },
          { value: "longevity", label: "Charge up to 55%" }
        ],
        editableBy: "staff"
      },
      { path: "nightModeEnabled", label: "Night mode", kind: "onOff", editableBy: "staff" },
      { path: "nightModeSleepTime", label: "Night mode sleep time", kind: "timeOfDay", min: 0, max: 1439, editableBy: "staff" },
      { path: "nightModeMorningTime", label: "Night mode morning time", kind: "timeOfDay", min: 0, max: 1439, editableBy: "staff" },
      { path: "lowBatteryBrightnessLimit", label: "Dim the screen on low battery", kind: "onOff", editableBy: "staff" },
      // Decaid's own "Keep screen awake", apart from presence's keep-awake.
      { path: "keepAwake", label: "Keep the Tablet's screen on", kind: "onOff", editableBy: "staff" },
      {
        path: "themeMode",
        label: "Theme",
        kind: "choice",
        choices: [
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" }
        ],
        editableBy: "staff"
      },
      {
        path: "logLevel",
        label: "Log level",
        kind: "choice",
        choices: [
          { value: "ALL", label: "ALL" },
          { value: "FINEST", label: "FINEST" },
          { value: "FINER", label: "FINER" },
          { value: "FINE", label: "FINE" },
          { value: "CONFIG", label: "CONFIG" },
          { value: "INFO", label: "INFO" },
          { value: "WARNING", label: "WARNING" },
          { value: "SEVERE", label: "SEVERE" },
          { value: "SHOUT", label: "SHOUT" },
          { value: "OFF", label: "OFF" }
        ],
        editableBy: "staff"
      },
      // Reported only while Decaid reads the Tablet's battery.
      { path: "chargingState", label: "Charging state", setBy: "A reading of the Tablet's battery" },
      { path: "simulatedDevices", label: "Simulated devices", setBy: "For development" },
      // Turned on, Decaid checks its plugins and Skins for updates every 12 hours and installs what it finds; turned off,
      // nothing on the Tablet updates by itself, this plugin included (`UpdateCheckService`). Decaid asks a token of a
      // plain request that turns it on while its "Require authorization for extension management" setting is on, so the
      // plugin writes it through `host.localApi`, which that setting leaves alone (ADR-0034). Decaid follows a change
      // made over its API when it next starts.
      { path: "automaticUpdateCheck", label: "Automatic update checks", kind: "onOff", editableBy: "admin", withSoftware: true },
      { path: "webUiPath", label: "Web UI path", setBy: "Follows the default skin" },
      { path: "defaultSkinId", label: "Default skin", setBy: "Managed with the Tablet's skins" },
      { path: "preferredMachineId", label: "Preferred machine", setBy: "Managed with the preferred devices" },
      { path: "preferredScaleId", label: "Preferred scale", setBy: "Managed with the preferred devices" },
      { path: "preferredGrinderDeviceId", label: "Preferred grinder", setBy: "Managed with the preferred devices" }
    ],
    // `GET /presence/settings` (presence_handler.dart), labelled as Streamline's presence settings label them.
    presenceSettings: [
      { path: "userPresenceEnabled", label: "Presence detection", kind: "onOff", editableBy: "staff" },
      // Decaid takes 0 to 240 (`normalizeSleepTimeoutPreferenceMinutes`); Streamline's page offers 1 to 120.
      { path: "sleepTimeoutMinutes", label: "Sleep timeout", unit: "min", kind: "wholeNumber", min: 1, max: 120, editableBy: "staff" },
      { path: "schedules", label: "Wake schedules", kind: "wakeSchedules", editableBy: "staff" },
      // The end of the keep-awake window of the wake schedule that last woke the Machine, while it lasts (`PresenceController`).
      // Labelled with the offset as it was read, so a window that ends across a daylight saving change shows its end with
      // the offset before it until the window ends: an accepted gap.
      { path: "keepAwakeUntil", label: "Kept awake until", kind: "localTime", setBy: "Set while a wake schedule keeps the Machine awake" }
    ]
  };
  var WAKE_SCHEDULE_FIELDS = [
    { path: "time", label: "Time", kind: "hoursMinutes", editableBy: "staff" },
    { path: "daysOfWeek", label: "Days", kind: "weekdays", editableBy: "staff" },
    { path: "enabled", label: "On", kind: "onOff", editableBy: "staff" },
    // Decaid takes 1 to 720, and 0 or null for none (`_addScheduleHandler`).
    { path: "keepAwakeFor", label: "Keeps awake for", unit: "min", kind: "wholeNumber", min: 1, max: 720, orNone: true, editableBy: "staff" }
  ];
  function wakeScheduleField(path) {
    return WAKE_SCHEDULE_FIELDS.find((field) => field.path === path);
  }
  var WAKE_SCHEDULE_ACTIONS = ["add", "change", "delete"];
  function settingsField(collection, path) {
    return SETTINGS_FIELDS[collection].find((field) => field.path === path);
  }
  function validateSettingsEdit(edit, role) {
    if (!isSettingsCollectionName(edit.collection)) return [{ reason: "unknownCollection" }];
    const paths = Object.keys(edit.fields);
    if (edit.schedule) return validateScheduleEdit(edit.collection, edit.schedule, edit.fields, role);
    if (paths.length === 0) return [{ reason: "noFields" }];
    if (edit.collection === "sensorCalibration" && paths.length > 1) return [{ reason: "severalTargets" }];
    const refusals = [];
    for (const path of paths) {
      const reason = fieldRefusal(settingsField(edit.collection, path), edit.fields[path], role);
      if (reason) refusals.push({ reason, field: path });
    }
    return refusals;
  }
  function validateScheduleEdit(collection, schedule, fields, role) {
    if (collection !== "presenceSettings") return [{ reason: "notSchedules" }];
    const paths = Object.keys(fields);
    if (schedule.action === "delete") return paths.length === 0 ? [] : [{ reason: "deleteSetsNothing" }];
    if (paths.length === 0) return [{ reason: "noFields" }];
    if (schedule.action === "add" && WAKE_SCHEDULE_FIELDS.some((field) => !(field.path in fields))) return [{ reason: "incompleteSchedule" }];
    const refusals = [];
    for (const path of paths) {
      const reason = fieldRefusal(wakeScheduleField(path), fields[path], role);
      if (reason) refusals.push({ reason, field: path, schedule: true });
    }
    return refusals;
  }
  function settingsRefusalText(collection, refusal2) {
    const field = refusal2.field === void 0 || !isSettingsCollectionName(collection) ? void 0 : refusal2.schedule ? wakeScheduleField(refusal2.field) : settingsField(collection, refusal2.field);
    const name = field?.label ?? refusal2.field ?? "";
    const editable = field && isEditable(field) ? field : void 0;
    switch (refusal2.reason) {
      case "unknownCollection":
        return `There are no settings named ${collection}`;
      case "notSchedules":
        return "Only the presence settings have wake schedules";
      case "noFields":
        return "Change at least one setting";
      case "incompleteSchedule":
        return "Give a new wake schedule its time, its days, whether it is on and how long it keeps the Machine awake";
      case "deleteSetsNothing":
        return "Deleting a wake schedule changes none of its settings";
      case "severalTargets":
        return "Set one sensor's calibration at a time";
      case "unknown":
        return `There is no setting named ${name}`;
      case "readOnly":
        return `${name} can't be changed here${field && !isEditable(field) ? `: ${field.setBy.charAt(0).toLowerCase()}${field.setBy.slice(1)}` : ""}`;
      case "notAllowed":
        return `Only an Admin can change ${name}`;
      case "invalid":
        if (editable?.kind === "wakeSchedules") return `${name} are added, changed and deleted one at a time`;
        if (editable?.kind === "weekdays") return `${name} must be days of the week, 1 (Monday) to 7 (Sunday), each once and in order`;
        return `${name} must be ${kindText(editable)}`;
      case "notOffered":
        return `${name} must be ${(editable?.choices ?? []).map((choice) => choice.label).join(" or ")}`;
      case "outOfRange":
        return `${name} must be ${rangeText(editable)}${editable?.orNone ? ", or none" : ""}`;
      case "offStep":
        return `${name} must be a multiple of ${editable?.step}`;
    }
  }
  var NOT_WRITTEN = "Not written: ";
  function kindText(field) {
    switch (field?.kind) {
      case "onOff":
        return "on or off";
      case "number":
        return "a number";
      case "timeOfDay":
      case "hoursMinutes":
        return "a time of day";
      default:
        return field?.orNone ? "a whole number, or none" : "a whole number";
    }
  }
  function rangeText(field) {
    if (field?.min !== void 0 && field.max !== void 0) return `from ${field.min} to ${field.max}`;
    return field?.min !== void 0 ? `${field.min} or more` : `${field?.max} or less`;
  }
  function fieldRefusal(field, value, role) {
    if (!field) return "unknown";
    if (!isEditable(field)) return "readOnly";
    if (field.editableBy === "admin" && role !== "admin") return "notAllowed";
    if (value === null && field.orNone) return void 0;
    switch (field.kind) {
      case "onOff":
        return typeof value === "boolean" ? void 0 : "invalid";
      case "choice":
        return field.choices?.some((choice) => choice.value === value) ? void 0 : "notOffered";
      case "wholeNumber":
      case "timeOfDay":
        if (typeof value !== "number" || !Number.isInteger(value)) return "invalid";
        return inRange(field, value) ? void 0 : "outOfRange";
      case "hoursMinutes":
        return isHoursMinutes(value) ? void 0 : "invalid";
      case "weekdays":
        return Array.isArray(value) && value.every((day, index) => Number.isInteger(day) && day >= 1 && day <= 7 && (index === 0 || day > value[index - 1])) ? void 0 : "invalid";
      // Only shown, as no editable field is one.
      case "localTime":
      // Added, changed and deleted one at a time, never set as a field.
      case "wakeSchedules":
        return "invalid";
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
        if (!inRange(field, value)) return "outOfRange";
        return field.step === void 0 || onStep(value, field.step) ? void 0 : "offStep";
    }
  }
  function isHoursMinutes(value) {
    const match = typeof value === "string" ? /^(\d\d):(\d\d)$/.exec(value) : null;
    return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
  }
  function inRange(field, value) {
    return (field.min === void 0 || value >= field.min) && (field.max === void 0 || value <= field.max);
  }
  function onStep(value, step) {
    const places = decimalPlaces(step);
    const { digits, exponent } = decimalDigits(value);
    if (exponent < -places) return false;
    const units = Math.round(step * 10 ** places);
    let remainder = 0;
    for (const digit of digits + "0".repeat(exponent + places)) remainder = (remainder * 10 + Number(digit)) % units;
    return remainder === 0;
  }
  function decimalPlaces(value) {
    return Math.max(0, -decimalDigits(value).exponent);
  }
  function decimalDigits(value) {
    const [mantissa = "", exponent = "0"] = String(Math.abs(value)).toLowerCase().split("e");
    const [whole = "", fraction = ""] = mantissa.split(".");
    return { digits: whole + fraction, exponent: Number(exponent) - fraction.length };
  }

  // ../protocol/src/software-actions.ts
  var SOURCE_CHANGES_WIRE_REVISION = 6;
  var DECENT_SYNC_REPO = "loganfuller/decent-sync";
  var OWN_CHANGEABLE_SETTING = "PollSeconds";
  var SOFTWARE_ACTION_KINDS = [
    "installPlugin",
    "enablePlugin",
    "disablePlugin",
    "changePluginSettings",
    "checkPluginUpdates",
    "approvePluginUpdate",
    "removePlugin",
    "changePluginSource",
    "installSkin",
    "chooseDefaultSkin",
    "checkSkinUpdates",
    "removeSkin",
    "changeSkinSource",
    "reloadSkin",
    "restartSkinView",
    "checkDecaidUpdate",
    "startDecaidUpdate"
  ];
  var SOFTWARE_ACTION_START_MARGIN_MS = 15e3;
  var MAX_SOFTWARE_NAME_LENGTH = 200;
  var MAX_PLUGIN_SETTINGS = 200;
  var MAX_SKIN_URL_LENGTH = 2e3;
  function isSkinUrl(value) {
    return typeof value === "string" && value.length <= MAX_SKIN_URL_LENGTH && /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?#]\S*)?$/i.test(value);
  }
  var SKIN_RELOAD_MS = 15e3;
  function isPluginRepo(value) {
    return typeof value === "string" && value.length <= MAX_SOFTWARE_NAME_LENGTH && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value);
  }
  function namesCommit(branch) {
    return /^[0-9a-f]{7,40}$/i.test(branch);
  }
  var seen = (value) => typeof value === "string" && value !== "" ? value : null;
  function pluginSourceSeen(plugin) {
    const entry = isRecord(plugin) ? plugin : {};
    const source = isRecord(entry.source) ? entry.source : {};
    return {
      version: seen(entry.version),
      kind: seen(source.kind),
      repo: seen(source.repo),
      branch: seen(source.branch),
      commit: seen(source.commit),
      releaseTag: seen(source.releaseTag)
    };
  }
  function skinSourceSeen(skin) {
    const entry = isRecord(skin) ? skin : {};
    const metadata = isRecord(entry.reaMetadata) ? entry.reaMetadata : {};
    return { version: seen(entry.version), sourceUrl: seen(metadata.sourceUrl), etag: seen(metadata.etag) };
  }
  function sameSourceSeen(a, b) {
    const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key2) => (a[key2] ?? null) === (b[key2] ?? null));
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // ../protocol/src/machine-models.ts
  var MODEL_FIGURES = {
    DE1: {
      maxFlow: 8,
      pressureStepFlow: [
        [2, 6.5],
        [6, 3]
      ],
      maxPressure: 12,
      startFlow: 4,
      flowLimiterReach: 0.7,
      flowResponse: 0.7,
      pressureResponse: 1.5,
      wireScale: 16
    },
    Bengle: {
      maxFlow: 15,
      pressureStepTargetFlow: [
        [1, 7],
        [6, 15]
      ],
      maxPressure: 12,
      pressureLimiterReach: 0,
      stepWeightLag: 0.4,
      flowResponse: 0.2,
      pressureResponse: 0.7,
      wireScale: 10
    }
  };

  // ../protocol/src/steam-phases.ts
  var STEAM_PHASE_NAMES = {
    preparing: "Preparing",
    steaming: "Steaming",
    paused: "Paused",
    puffing: "Puffing",
    purge: "Purge"
  };
  function steamPhaseOf(snapshot) {
    const machine = record(snapshot);
    const targetFlow = machine.targetFlow;
    const flowing = !(typeof targetFlow === "number" && Number.isFinite(targetFlow) && targetFlow <= 0);
    switch (record(machine.state).substate) {
      case "preparingForShot":
        return "preparing";
      case "pouring":
        return flowing ? "steaming" : "paused";
      case "pouringDone":
        return flowing ? "purge" : "paused";
      case "pausedSteam":
        return "paused";
      case "puffing":
        return "puffing";
      default:
        return null;
    }
  }
  function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  }

  // ../protocol/src/machine-states.ts
  var HEATING_UP = { preparingForShot: "Heating up" };
  var STATES = {
    espresso: { name: "Pulling a shot", details: { preparingForShot: "Preparing", preinfusion: "Preinfusion", pouring: "Pouring", pouringDone: "Ending" } },
    hotWater: { name: "Pouring hot water", details: { ...HEATING_UP, pouring: null } },
    flush: { name: "Flushing", details: { ...HEATING_UP, pouring: null } },
    steamRinse: { name: "Cleaning the steam wand", details: { pouring: null } },
    cleaning: { name: "Cleaning" },
    descaling: { name: "Descaling" },
    idle: { name: "Idle", details: HEATING_UP },
    schedIdle: { name: "Idle", details: HEATING_UP, note: "Woken by a wake schedule" },
    sleeping: { name: "Asleep" },
    needsWater: { name: "Needs water" },
    error: { name: "Error" },
    airPurge: { name: "Draining for transport" },
    booting: { name: "Starting up" },
    busy: { name: "Busy" },
    calibration: { name: "Calibrating" },
    selfTest: { name: "Self test" },
    fwUpgrade: { name: "Updating firmware" },
    heating: { name: "Heating" },
    preheating: { name: "Heating" }
  };
  function nameMachineState(state, substate, snapshot) {
    if (state === "skipStep") return { name: "Pulling a shot", detail: "Next step", note: null };
    if (state === "steam") {
      const phase = steamPhaseOf({ ...record2(snapshot), state: { state, substate } });
      if (phase === "purge") return { name: "Purging", detail: null, note: null };
      const detail2 = phase === null ? substateInWords(substate) : phase === "steaming" ? null : STEAM_PHASE_NAMES[phase];
      return { name: "Steaming", detail: detail2, note: null };
    }
    const row = STATES[state];
    if (!row) return { name: capitalised(decaidNameInWords(state)), detail: substateInWords(substate), note: null };
    const listed = row.details?.[substate];
    const detail = listed !== void 0 ? listed : state === "error" ? errorInWords(substate) : substateInWords(substate);
    return { name: row.name, detail, note: row.note ?? null };
  }
  function machineStateOf(snapshot) {
    const reported = record2(record2(snapshot).state);
    const { state, substate } = reported;
    if (typeof state !== "string" || state === "" || typeof substate !== "string" || substate === "") return null;
    return { state, substate, ...nameMachineState(state, substate, snapshot) };
  }
  function decaidNameInWords(name) {
    const parts = name.match(/NaN|[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [name];
    return parts.map((part) => /^[A-Z][a-z]+$/.test(part) ? part.toLowerCase() : part).join(" ");
  }
  function substateInWords(substate) {
    return substate === "idle" ? null : capitalised(decaidNameInWords(substate));
  }
  function errorInWords(substate) {
    const rest = substate.startsWith("error") && substate.length > "error".length ? substate.slice("error".length) : substate;
    return substateInWords(rest);
  }
  function capitalised(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function record2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  }

  // ../protocol/src/sha256.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function utf8Bytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 56320 && next <= 57343) {
          code = 65536 + (code - 55296 << 10) + (next - 56320);
          i++;
        }
      }
      if (code >= 55296 && code <= 57343) code = 65533;
      if (code < 128) bytes.push(code);
      else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
      else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
    }
    return Uint8Array.from(bytes);
  }
  function sha256Hex(text) {
    const message = utf8Bytes(text);
    const blocks = Math.ceil((message.length + 9) / 64);
    const padded = new Uint8Array(blocks * 64);
    padded.set(message);
    padded[message.length] = 128;
    const bits = message.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
    view.setUint32(padded.length - 4, bits >>> 0);
    const hash = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const w = new Uint32Array(64);
    for (let block = 0; block < blocks; block++) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15];
        const y = w[t - 2];
        const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
        const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
        w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = [hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7]];
      for (let t = 0; t < 64; t++) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = e & f ^ ~e & g;
        const t1 = h + S1 + ch + K[t] + w[t] >>> 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj >>> 0;
        h = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      hash[0] = hash[0] + a >>> 0;
      hash[1] = hash[1] + b >>> 0;
      hash[2] = hash[2] + c >>> 0;
      hash[3] = hash[3] + d >>> 0;
      hash[4] = hash[4] + e >>> 0;
      hash[5] = hash[5] + f >>> 0;
      hash[6] = hash[6] + g >>> 0;
      hash[7] = hash[7] + h >>> 0;
    }
    return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  // ../protocol/src/profile.ts
  var BEVERAGE_TYPES = ["espresso", "pourover", "cleaning", "calibrate", "manual"];
  var STEP_TRANSITIONS = ["fast", "smooth"];
  var STEP_SENSORS = ["coffee", "water"];
  var EXIT_TYPES = ["pressure", "flow"];
  var EXIT_CONDITIONS = ["over", "under"];
  function readProfile(value) {
    if (!isObject(value)) return { problem: "A profile must be an object" };
    const steps = [];
    const rawSteps = Array.isArray(value.steps) ? value.steps : [];
    for (let index = 0; index < rawSteps.length; index++) {
      const step = readStep(rawSteps[index]);
      if (typeof step === "string") return { problem: `Step ${index + 1}: ${step}` };
      steps.push(step);
    }
    const targetVolume = readOptionalDouble(value.target_volume);
    if (targetVolume === void 0) return { problem: "target_volume must be a number" };
    const targetWeight = readOptionalDouble(value.target_weight);
    if (targetWeight === void 0) return { problem: "target_weight must be a number" };
    const countStart = readInt(value.target_volume_count_start ?? 0);
    if (countStart === void 0) return { problem: "target_volume_count_start must be a whole number" };
    const tank = readDouble(value.tank_temperature ?? 0);
    if (tank === void 0) return { problem: "tank_temperature must be a number" };
    return {
      profile: {
        version: readOptionalString(value.version),
        title: readOptionalString(value.title) ?? "",
        notes: readOptionalString(value.notes) ?? "",
        author: readOptionalString(value.author) ?? "",
        beverage_type: readBeverageType(value.beverage_type),
        steps,
        target_volume: targetVolume,
        target_weight: targetWeight,
        target_volume_count_start: countStart,
        tank_temperature: tank
      }
    };
  }
  function profileOf(value) {
    return readProfile(value).profile ?? null;
  }
  function readStep(value) {
    if (!isObject(value)) return "must be an object";
    const pump = value.pump;
    if (pump !== "pressure" && pump !== "flow") return 'pump must be "pressure" or "flow"';
    if (typeof value.name !== "string") return "name must be text";
    const transition = value.transition;
    if (!isOneOf(STEP_TRANSITIONS, transition)) return 'transition must be "fast" or "smooth"';
    const sensor = value.sensor;
    if (!isOneOf(STEP_SENSORS, sensor)) return 'sensor must be "coffee" or "water"';
    let exit = null;
    if (value.exit !== null && value.exit !== void 0) {
      if (!isObject(value.exit)) return "exit must be an object";
      const { type, condition } = value.exit;
      if (!isOneOf(EXIT_TYPES, type)) return 'exit.type must be "pressure" or "flow"';
      if (!isOneOf(EXIT_CONDITIONS, condition)) return 'exit.condition must be "over" or "under"';
      const exitValue = readDouble(value.exit.value);
      if (exitValue === void 0) return "exit.value must be a number";
      exit = { type, condition, value: exitValue };
    }
    let limiter = null;
    if (value.limiter !== null && value.limiter !== void 0) {
      if (!isObject(value.limiter)) return "limiter must be an object";
      const limit = readDouble(value.limiter.value);
      if (limit === void 0) return "limiter.value must be a number";
      const range = readDouble(value.limiter.range);
      if (range === void 0) return "limiter.range must be a number";
      limiter = { value: limit, range };
    }
    const numbers = { volume: 0, seconds: 0, temperature: 0, pressure: 0, flow: 0 };
    for (const field of ["volume", "seconds", "temperature", pump]) {
      const number = readDouble(value[field]);
      if (number === void 0) return `${field} must be a number`;
      numbers[field] = number;
    }
    const weight = readOptionalDouble(value.weight);
    if (weight === void 0) return "weight must be a number";
    const { volume, seconds, temperature } = numbers;
    const name = value.name;
    return pump === "pressure" ? { name, pump, transition, exit, volume, seconds, weight, temperature, sensor, pressure: numbers.pressure, limiter } : { name, pump, transition, exit, volume, seconds, weight, temperature, sensor, flow: numbers.flow, limiter };
  }
  function stepTarget(step) {
    return step.pump === "pressure" ? step.pressure : step.flow;
  }
  function profileId(profile) {
    const data = {
      version: profile.version,
      beverage_type: profile.beverage_type,
      steps: profile.steps.map(stepHashed),
      tank_temperature: double(profile.tank_temperature),
      target_weight: optionalDouble(profile.target_weight),
      target_volume: optionalDouble(profile.target_volume),
      target_volume_count_start: { int: profile.target_volume_count_start }
    };
    return `profile:${sha256Hex(dartJson(data)).slice(0, 20)}`;
  }
  function profileStepsKey(profile) {
    return stableJson({
      version: profile.version,
      beverage_type: profile.beverage_type,
      tank_temperature: profile.tank_temperature,
      target_volume: profile.target_volume,
      target_volume_count_start: profile.target_volume_count_start,
      steps: JSON.parse(stepsKey(profile.steps))
    });
  }
  function stepsKey(steps) {
    return stableJson(
      steps.map((step) => {
        const { temperature: _, ...rest } = step;
        return rest.limiter !== null && rest.limiter.value === 0 ? { ...rest, limiter: null } : rest;
      })
    );
  }
  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map((key2) => `${JSON.stringify(key2)}:${stableJson(value[key2])}`).join(",")}}`;
    return JSON.stringify(value ?? null);
  }
  function double(value) {
    return { double: value };
  }
  function optionalDouble(value) {
    return value === null ? null : { double: value };
  }
  function stepHashed(step) {
    const hashed = {
      name: step.name,
      pump: step.pump,
      transition: step.transition,
      exit: step.exit === null ? null : { type: step.exit.type, condition: step.exit.condition, value: double(step.exit.value) },
      volume: double(step.volume),
      seconds: double(step.seconds),
      weight: optionalDouble(step.weight),
      temperature: double(step.temperature),
      sensor: step.sensor,
      limiter: step.limiter === null ? null : { value: double(step.limiter.value), range: double(step.limiter.range) }
    };
    hashed[step.pump] = double(stepTarget(step));
    return hashed;
  }
  function dartJson(value) {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(dartJson).join(",")}]`;
    if ("double" in value && typeof value.double === "number") return dartDouble(value.double);
    if ("int" in value && typeof value.int === "number") return String(Math.trunc(value.int));
    const object3 = value;
    return `{${Object.keys(object3).sort().map((key2) => `${JSON.stringify(key2)}:${dartJson(object3[key2])}`).join(",")}}`;
  }
  function dartDouble(value) {
    if (Object.is(value, -0)) return "-0.0";
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return `${value}.0`;
    return String(value);
  }
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isOneOf(values, value) {
    return typeof value === "string" && values.includes(value);
  }
  function dartTrim(text) {
    return text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
  }
  var DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  function decimal(text) {
    const trimmed = dartTrim(text);
    if (!DECIMAL.test(trimmed)) return void 0;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : void 0;
  }
  function readDouble(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
    return typeof value === "string" ? decimal(value) : void 0;
  }
  function readOptionalDouble(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
    if (typeof value !== "string") return void 0;
    const number = decimal(value);
    if (number !== void 0) return number;
    const trimmed = dartTrim(value);
    return /^[+-]?(0[xX][0-9a-fA-F]+|NaN|Infinity)$/.test(trimmed) || DECIMAL.test(trimmed) ? void 0 : null;
  }
  function readInt(value) {
    const int = typeof value === "number" ? Number.isFinite(value) ? Math.trunc(value) + 0 : void 0 : typeof value === "string" && /^[+-]?\d+$/.test(dartTrim(value)) ? Number.parseInt(dartTrim(value), 10) + 0 : void 0;
    return int !== void 0 && Number.isSafeInteger(int) ? int : void 0;
  }
  function readOptionalString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }
  function readBeverageType(value) {
    const name = typeof value === "string" ? value.toLowerCase() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    return isOneOf(BEVERAGE_TYPES, name) ? name : "espresso";
  }
  var DE1_LIMITS = {
    pressure: { min: 0, max: 12 },
    flow: { min: 0, max: 15 },
    temperature: { min: 0, max: 105 },
    seconds: { min: 0, max: 127 },
    volume: { min: 0, max: 500 },
    weight: { min: 0, max: 500 },
    /** A flow limit, on a pressure step. */
    flowLimit: { min: 0, max: 8 },
    /** A pressure limit, on a flow step. */
    pressureLimit: { min: 0, max: 12 },
    limiterRange: { min: 0, max: 5 },
    pressureExit: { min: 0, max: 12 },
    flowExit: { min: 0, max: 8 },
    tankTemperature: { min: 0, max: 110 },
    targetWeight: { min: 0, max: 500 },
    targetVolume: { min: 0, max: 500 }
  };
  var MODEL_LIMITS = {
    DE1: DE1_LIMITS,
    Bengle: { ...DE1_LIMITS, flow: { min: 0, max: 20 }, flowLimit: { min: 0, max: 20 }, flowExit: { min: 0, max: 20 } }
  };
  var KEEPS_UP = {
    DE1: `a DE1's pump gives about ${MODEL_FIGURES.DE1.maxFlow} ml/s at most`,
    Bengle: `a Bengle's heater keeps up with about ${MODEL_FIGURES.Bengle.maxFlow} ml/s at most`
  };
  var PROFILE_TEXT_FIELDS = ["title", "author", "notes"];
  function profileTextOf(value) {
    const profile = isObject(value) ? value : {};
    return { title: readOptionalString(profile.title) ?? "", author: readOptionalString(profile.author) ?? "", notes: readOptionalString(profile.notes) ?? "" };
  }

  // ../protocol/src/settings-history.ts
  var BRIEF_CHANGE_MS = 2 * 6e4;

  // ../protocol/src/simulation.ts
  var YIELD_FROM = 1 / 3;

  // ../protocol/src/index.ts
  var PROTOCOL_VERSION = 1;
  var WIRE_REVISION = 6;
  var FIRST_WIRE_REVISION = 1;
  function wireRevisionOf(message) {
    return message.wireRevision ?? FIRST_WIRE_REVISION;
  }
  function acceptsWireRevision(peer, own = WIRE_REVISION) {
    return peer >= own - 1;
  }
  function peerHasWireRevision(peer, revision, own = WIRE_REVISION) {
    if (revision > own) {
      throw new Error(`Asked whether a peer has wire revision ${revision}, but this build speaks ${own}: raise WIRE_REVISION`);
    }
    if (revision <= Math.max(FIRST_WIRE_REVISION, own - 1)) {
      throw new Error(
        `Every peer that wire revision ${own} accepts has revision ${revision}: delete this check, or, if what it sends came after the latest release, ask for revision ${own}`
      );
    }
    return peer >= revision;
  }
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
    /**
     * The plugin speaks a protocol version older than the server supports, or
     * a wire revision more than one behind the server's (ADR-0025). The plugin
     * stops reconnecting, and the Machine's page shows why.
     */
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
  var GRINDER_RANGE_FIELDS = ["settingMin", "settingMax", "settingDefault", "rpmMin", "rpmMax", "rpmDefault"];
  var GRINDER_EXTRAS_FIELDS = ["feedRate", ...GRINDER_RANGE_FIELDS];
  var BATCH_CODE_KEY = "decentSyncBatchCode";
  var BATCH_CODE_FIELD = "batchCode";
  var BATCH_EXTRAS_KEYS = { [BATCH_CODE_FIELD]: BATCH_CODE_KEY };
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
    if (!isObject2(a) || !isObject2(b)) return false;
    const keys = /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key2) => sameValue(a[key2], b[key2]));
  }
  function globalIdOf(record3) {
    const extras = isObject2(record3) ? record3.extras : void 0;
    const id = isObject2(extras) ? extras[GLOBAL_ID_KEY] : void 0;
    return isGlobalId(id) ? id.toLowerCase() : null;
  }
  var WORKFLOW_CAUSES = ["plugin", "other"];
  var PLUGIN_WORKFLOW_WRITES = ["load", "loadedRecipe", "clear", "steamOn", "draft"];
  var UTC_OFFSET_COLLECTIONS = ["appSettings", "presenceSettings"];
  function hasUtcOffset(name) {
    return UTC_OFFSET_COLLECTIONS.includes(name);
  }
  var MAX_UTC_OFFSET_MINUTES = 18 * 60;
  var DYE2_NAMESPACE = "dye2.reaplugin";
  var DYE2_LISTS = { dye2Recipes: "recipes", dye2Equipment: "equipment", dye2Baskets: "baskets" };
  function isDye2List(name) {
    return Object.prototype.hasOwnProperty.call(DYE2_LISTS, name);
  }
  function dye2Records(value) {
    if (!Array.isArray(value)) return null;
    const ids = /* @__PURE__ */ new Set();
    for (const record3 of value) {
      if (!isObject2(record3) || !isRecordId(record3.id) || ids.has(record3.id)) return null;
      ids.add(record3.id);
    }
    return value;
  }
  var RECIPE_SLOTS = 9;
  function isRecipeSlot(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= RECIPE_SLOTS;
  }
  var RECIPE_SHOWN_FIELD = "showOnStreamlineDashboard";
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
  function grindSettingOf(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text === "") return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  function sameGrindSetting(a, b) {
    const [x, y] = [grindSettingOf(a), grindSettingOf(b)];
    return typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 1e-9 : x === y;
  }
  function steamOff(workflow) {
    const temperature = workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow);
    return typeof temperature === "number" && temperature < STEAM_ON_FROM;
  }
  function dye2GlobalIdOf(record3) {
    const id = isObject2(record3) ? record3[GLOBAL_ID_KEY] : void 0;
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
    if (profile === null) return null;
    const steps = profile.steps.map((step) => {
      const { temperature: _, limiter, ...rest } = step;
      return { ...rest, limiter: limiter !== null && limiter.value !== 0 ? limiter : null };
    });
    return JSON.stringify({ title: profile.title, tank_temperature: profile.tank_temperature, steps }, sortedKeys);
  }
  function sortedKeys(_key, value) {
    return isObject2(value) ? Object.fromEntries(Object.keys(value).sort().map((key2) => [key2, value[key2]])) : value;
  }
  var LOADED_RECIPE_KIND = "loadedRecipe";
  var DRAFT_KIND = "draft";
  var BREW_TEMPERATURE_FIELD = "profile.steps.0.temperature";
  function profileAtBrewTemperature(profile, temperature) {
    const temperatures = shiftedTemperatures(
      profile.steps.map((step) => step.temperature),
      temperature
    );
    if (temperatures === null) return null;
    return { ...profile, steps: profile.steps.map((step, index) => ({ ...step, temperature: temperatures[index] })) };
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
    feedRate: ["context.extras.feedRate"],
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
  var WORKFLOW_YIELD_OFF = 0;
  function workflowValueAt(workflow, path) {
    let value = workflow;
    for (const name of path.split(".")) value = isObject2(value) ? value[name] : Array.isArray(value) && /^\d+$/.test(name) ? value[Number(name)] : void 0;
    return value;
  }
  function workflowPatch(fields) {
    const patch = {};
    for (const [path, value] of Object.entries(fields)) {
      const names = path.split(".");
      let target = patch;
      for (const name of names.slice(0, -1)) {
        if (!isObject2(target[name])) target[name] = {};
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
  var STEAM_TIME_FROM = 1;
  var STEAM_TIME_TO = 255;
  function steamTimeOf(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= STEAM_TIME_FROM ? Math.min(value, STEAM_TIME_TO) : null;
  }
  function steamHeldOff(temperature, duration) {
    const below = (value, from) => typeof value === "number" && Number.isFinite(value) && value < from;
    return below(temperature, STEAM_ON_FROM) || below(duration, STEAM_TIME_FROM);
  }
  var STEAM_OFF_VALUE = 0;
  function isZero(value) {
    if (typeof value === "number") return value === 0;
    return typeof value === "string" && value.trim() !== "" && Number(value) === 0;
  }
  function noneAtZero(value) {
    return value === void 0 || isZero(value) ? null : value;
  }
  var ANOTHER_ITEMS_RECORD = "The record carries another item's global id";
  var RECORD_CHANGED = "The record changed since the plugin last read the list";
  var SHOTS_STILL_TO_READ = "More Shots are still to be sent than a delete reads; ask again once they are";
  var SHOT_STATE = "espresso";
  var PULLING_SHOT = "The Machine was pulling a Shot; ask again";
  var SETTINGS_EDIT_WRITE_MARGIN_MS = 15e3;
  var SETTINGS_EDIT_STATES = ["idle", "schedIdle", "sleeping", "needsWater"];
  var MAX_REFUSAL_LENGTH = 1e3;
  function liveSourceOf(live) {
    return live.source === "sensor" ? `sensor ${live.sensorId}` : live.source;
  }
  function isMilkProbe(sensorId) {
    return typeof sensorId === "string" && sensorId.endsWith("-milkprobe") && sensorId.length <= MAX_RECORD_ID_LENGTH;
  }
  var MAX_NOTIFICATION_BYTES = 7999;
  function relayedLiveFrame(machineId, tabletId, live) {
    const relayed = {
      machineId,
      tabletId,
      source: live.source,
      ...live.sensorId !== void 0 ? { sensorId: live.sensorId } : {},
      receivedAt: live.receivedAt,
      ...live.stateSince !== void 0 ? { stateSince: live.stateSince } : {},
      frame: live.frame
    };
    return JSON.stringify(relayed);
  }
  function liveFrameFits(live) {
    const uuid = "00000000-0000-0000-0000-000000000000";
    return utf8Length(relayedLiveFrame(uuid, uuid, live)) <= MAX_NOTIFICATION_BYTES;
  }
  var SKIN_ASKS = ["status", "shots", "shot", "reference", "chooseReference", "editShot"];
  var MAX_SHOTS_PAGE = 50;
  var NOT_SERVED = ["captureOnly", "hardwareMismatch"];
  var SKIN_REFUSALS = [...NOT_SERVED, "noSuchShot", "invalidCursor", "noSuchRecipe", "notAtThisLocation", "archived"];
  var MAX_REFERENCE_COPY_BYTES = 1024 * 1024;
  var MAX_REFERENCE_VERSION_LENGTH = 128;
  var MAX_SHOT_RATING = 10;
  function isShotRating(value) {
    return typeof value === "number" && value >= 0 && value <= MAX_SHOT_RATING;
  }
  function isShotNote(value) {
    if (typeof value !== "string" || value.includes("\0")) return false;
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit < 55296 || unit > 57343) continue;
      const next = value.charCodeAt(index + 1);
      if (unit > 56319 || !(next >= 56320 && next <= 57343)) return false;
      index++;
    }
    return true;
  }
  var MAX_SKIN_NOTE_LENGTH = 4e4;
  function shotRatingAndNote(record3) {
    const annotations = isObject2(record3) && isObject2(record3.annotations) ? record3.annotations : {};
    const { enjoyment, espressoNotes } = annotations;
    return {
      rating: typeof enjoyment === "number" && Number.isFinite(enjoyment) ? enjoyment : null,
      note: typeof espressoNotes === "string" && espressoNotes.trim() !== "" ? espressoNotes : null
    };
  }
  var RECORD_TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/;
  function isRecordTime(value) {
    return typeof value === "string" && RECORD_TIME.test(value);
  }
  function isLaterRecordTime(time, than) {
    const [later, earlier] = [typeof time === "string" ? RECORD_TIME.exec(time) : null, typeof than === "string" ? RECORD_TIME.exec(than) : null];
    if (!later || !earlier) return false;
    if (later[1] !== earlier[1]) return later[1] > earlier[1];
    const [fraction, other] = [later[2] ?? "", earlier[2] ?? ""];
    const digits = Math.max(fraction.length, other.length);
    return fraction.padEnd(digits, "0") > other.padEnd(digits, "0");
  }
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
        if (object3.recipeNamedAt !== void 0) fields.instant("recipeNamedAt");
        if (object3.cause !== void 0) fields.oneOf("cause", WORKFLOW_CAUSES);
        if (object3.cause === "plugin") fields.oneOf("pluginWrite", PLUGIN_WORKFLOW_WRITES);
        else fields.absent("pluginWrite");
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
          if (object3.wireRevision !== void 0) fields.integer("wireRevision", { positive: true });
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
      case "settingsEdit":
        return check(object3, "settingsEdit", (fields) => {
          fields.uuid("id");
          fields.string("collection", { nonEmpty: true });
          fields.objectField("fields");
          fields.objectField("expected");
          fields.integer("timeLeftMs", { nonNegative: true });
          fields.optionalObject("schedule", (schedule) => {
            schedule.oneOf("action", WAKE_SCHEDULE_ACTIONS);
            if (isObject2(object3.schedule) && object3.schedule.action === "add") schedule.absent("id");
            else schedule.string("id", { nonEmpty: true, maxLength: MAX_RECORD_ID_LENGTH });
          });
        });
      case "softwareAction":
        return check(object3, "softwareAction", (fields) => {
          fields.uuid("id");
          fields.oneOf("kind", SOFTWARE_ACTION_KINDS);
          fields.integer("timeLeftMs", { nonNegative: true });
          switch (object3.kind) {
            case "installPlugin":
              fields.pluginRepo("repo");
              if (object3.branch !== void 0) fields.string("branch", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              break;
            case "enablePlugin":
            case "disablePlugin":
            case "removePlugin":
              fields.string("pluginId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              break;
            case "changePluginSource":
              fields.string("pluginId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              fields.objectField("expected");
              fields.pluginRepo("repo");
              if (object3.branch !== void 0) fields.string("branch", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              break;
            case "changeSkinSource":
              fields.string("skinId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              fields.objectField("expected");
              if (object3.url !== void 0) {
                fields.skinUrl("url");
                fields.absent("repo");
                fields.absent("branch");
              } else {
                fields.pluginRepo("repo");
                if (object3.branch !== void 0) fields.string("branch", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              }
              break;
            case "approvePluginUpdate":
              fields.string("pluginId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              fields.string("version", { maxLength: MAX_SOFTWARE_NAME_LENGTH });
              fields.array("addedPermissions", (value) => typeof value === "string" && value.length <= MAX_SOFTWARE_NAME_LENGTH, MAX_PLUGIN_SETTINGS);
              break;
            case "changePluginSettings":
              fields.string("pluginId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              fields.objectField("values");
              fields.objectField("expected");
              break;
            case "installSkin":
              if (object3.url !== void 0) {
                fields.skinUrl("url");
                fields.absent("repo");
                fields.absent("branch");
              } else {
                fields.pluginRepo("repo");
                if (object3.branch !== void 0) fields.string("branch", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              }
              break;
            case "chooseDefaultSkin":
            case "removeSkin":
              fields.string("skinId", { nonEmpty: true, maxLength: MAX_SOFTWARE_NAME_LENGTH });
              break;
            default:
              break;
          }
        });
      case "liveStart":
        return check(object3, "liveStart", () => {
        });
      case "liveStop":
        return check(object3, "liveStop", () => {
        });
      case "liveReceived":
        return check(object3, "liveReceived", (fields) => fields.integer("bytes", { nonNegative: true }));
      case "answer":
        return check(object3, "answer", (fields) => {
          fields.string("id", { nonEmpty: true });
          fields.oneOf("ask", SKIN_ASKS);
          if (object3.ask !== "status" && object3.refused !== void 0) {
            fields.oneOf("refused", SKIN_REFUSALS);
            return fields.absent("result");
          }
          fields.objectField("result");
          if (object3.ask === "shots") {
            fields.optionalObject("result", (page) => {
              page.array("shots", (shot) => isObject2(shot) && typeof shot.id === "string", MAX_SHOTS_PAGE);
              page.optionalString("nextCursor");
            });
          }
          if (object3.ask === "shot") fields.optionalObject("result", (whole) => whole.objectField("shot"));
          if (object3.ask === "reference" || object3.ask === "chooseReference") fields.optionalObject("result", referenceFields);
          if (object3.ask === "status") {
            fields.optionalObject("result", (status) => {
              status.boolean("served");
              if (isObject2(object3.result) && object3.result.served === false) status.oneOf("notServed", NOT_SERVED);
              else status.absent("notServed");
              for (const named of ["machine", "location"]) {
                status.nullableObject(named, (entry) => {
                  entry.string("id", { nonEmpty: true });
                  entry.string("name");
                });
              }
            });
          }
        });
      case "referenceCopy":
        return check(object3, "referenceCopy", (fields) => {
          fields.string("id", { nonEmpty: true });
          fields.recipeSlot("slot");
          fields.nullableObject("copy", (copy) => {
            copy.string("version", { nonEmpty: true, maxLength: MAX_REFERENCE_VERSION_LENGTH });
            copy.optionalBoolean("tooLarge");
            if (isObject2(object3.copy) && object3.copy.tooLarge === true) {
              recipeField(copy);
              copy.absent("reference");
            } else referenceFields(copy);
          });
        });
      case "shotEdit":
        return check(object3, "shotEdit", (fields) => {
          fields.uuid("id");
          fields.recordId("shotId");
          fields.recordTime("version");
          if (object3.rating !== void 0) fields.shotRating("rating");
          if (object3.note !== void 0) fields.shotNote("note");
          fields.some(["rating", "note"]);
        });
      default:
        return invalid("Unknown message type");
    }
  }
  function recipeField(fields) {
    fields.objectField("recipe");
    fields.optionalObject("recipe", (recipe) => recipe.string("id", { nonEmpty: true }));
  }
  function referenceFields(fields) {
    recipeField(fields);
    fields.nullableObject("reference", (reference) => {
      reference.objectField("shot");
      reference.boolean("profileDiffers");
    });
  }
  var FieldChecker = class _FieldChecker {
    constructor(object3, path, problems) {
      __publicField(this, "object", object3);
      __publicField(this, "path", path);
      __publicField(this, "problems", problems);
    }
    string(key2, options = {}) {
      const value = this.object[key2];
      if (typeof value !== "string") this.problem(key2, "must be a string");
      else if (options.nonEmpty && value === "") this.problem(key2, "must not be empty");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key2, `must be at most ${options.maxLength} characters`);
      }
    }
    /** The id of a delivery or a chunk. */
    id() {
      this.string("id", { nonEmpty: true, maxLength: MAX_ID_LENGTH });
    }
    /** A UUID, in either case, as a tablet id is. */
    uuid(key2) {
      if (!isTabletId(this.object[key2])) this.problem(key2, "must be a UUID");
    }
    /** The id of an item of the kind given, as that kind declares its ids (`itemIdRule`). */
    itemId(key2, kind) {
      const rule = itemIdRule(String(kind));
      if (!rule.test(this.object[key2])) this.problem(key2, rule.problem);
    }
    optionalString(key2, options = {}) {
      const value = this.object[key2];
      if (value === void 0 || value === null) return;
      if (typeof value !== "string") this.problem(key2, "must be a string or null");
      else if (options.maxLength !== void 0 && value.length > options.maxLength) {
        this.problem(key2, `must be at most ${options.maxLength} characters`);
      }
    }
    integer(key2, options = {}) {
      const value = this.object[key2];
      if (typeof value !== "number" || !Number.isInteger(value)) this.problem(key2, "must be a whole number");
      else if (options.positive && value <= 0) this.problem(key2, "must be positive");
      else if (options.nonNegative && value < 0) this.problem(key2, "must not be negative");
      else if (options.within !== void 0 && Math.abs(value) > options.within) this.problem(key2, `must be from -${options.within} to ${options.within}`);
    }
    /** One of `values`. */
    oneOf(key2, values) {
      if (!values.includes(this.object[key2])) this.problem(key2, `must be one of ${values.join(", ")}`);
    }
    boolean(key2) {
      if (typeof this.object[key2] !== "boolean") this.problem(key2, "must be true or false");
    }
    /** A Shot's or Steam Record's id (`isRecordId`). */
    recordId(key2) {
      if (!isRecordId(this.object[key2])) this.problem(key2, `must be a record id of at most ${MAX_RECORD_ID_LENGTH} characters`);
    }
    /** A record's time as Decaid writes one in UTC (`isRecordTime`). */
    recordTime(key2) {
      if (!isRecordTime(this.object[key2])) this.problem(key2, "must be a UTC time such as 2026-11-10T09:00:00.123456Z");
    }
    /** A rating a Shot's edit sets (`isShotRating`). */
    shotRating(key2) {
      if (!isShotRating(this.object[key2])) this.problem(key2, `must be a number from 0 to ${MAX_SHOT_RATING}`);
    }
    /** A note a Shot's edit sets (`isShotNote`). */
    shotNote(key2) {
      if (!isShotNote(this.object[key2])) this.problem(key2, "must be text PostgreSQL stores");
    }
    /** A Recipe Slot's number. */
    recipeSlot(key2) {
      if (!isRecipeSlot(this.object[key2])) this.problem(key2, `must be a Recipe Slot, 1 to ${RECIPE_SLOTS}`);
    }
    /** The version of a Reference Shot copy for each of some Recipe Slots, by the slot's number (`ReferencesHeld.held`). */
    versionsBySlot(key2) {
      const value = this.object[key2];
      const held = isObject2(value) ? Object.entries(value) : null;
      const valid = ([slot, version]) => /^[1-9]\d*$/.test(slot) && isRecipeSlot(Number(slot)) && typeof version === "string" && version !== "" && version.length <= MAX_REFERENCE_VERSION_LENGTH;
      if (!held?.every(valid)) this.problem(key2, "must be an object of versions by Recipe Slot");
    }
    optionalBoolean(key2) {
      const value = this.object[key2];
      if (value !== void 0 && typeof value !== "boolean") this.problem(key2, "must be true or false");
    }
    objectField(key2) {
      if (!isObject2(this.object[key2])) this.problem(key2, "must be an object");
    }
    /** A GitHub repository a plugin is installed from (`isPluginRepo`). */
    pluginRepo(key2) {
      if (!isPluginRepo(this.object[key2])) this.problem(key2, "must be a GitHub repository, as owner/name");
    }
    /** A URL a Skin is installed from (`isSkinUrl`). */
    skinUrl(key2) {
      if (!isSkinUrl(this.object[key2])) this.problem(key2, "must be an http or https URL");
    }
    /** Any JSON value but null. */
    present(key2) {
      const value = this.object[key2];
      if (value === void 0 || value === null) this.problem(key2, "must be present and not null");
    }
    absent(key2) {
      if (this.object[key2] !== void 0) this.problem(key2, "must be absent");
    }
    /** At least one of `keys`. */
    some(keys) {
      if (keys.every((key2) => this.object[key2] === void 0)) this.problems.push(`${this.path} must have ${keys.join(" or ")}`);
    }
    /** A UTC instant as `Date.prototype.toISOString` writes it. Read back, it must be written the same, so times that do not exist, which Date rolls over, are refused. */
    instant(key2) {
      if (!isInstant(this.object[key2])) this.problem(key2, "must be a UTC time such as 2026-10-05T14:07:03.341Z");
    }
    /**
     * An array of `length` UTC instants, as `instant` reads one, or nulls. A
     * `length` below zero says there is nothing for it to go beside.
     */
    instants(key2, length) {
      const value = this.object[key2];
      if (length < 0) this.problem(key2, "must be absent unless value is a list");
      else if (!Array.isArray(value) || value.length !== length || !value.every((entry) => entry === null || isInstant(entry))) {
        this.problem(key2, "must be an array as long as value, of UTC times such as 2026-10-05T14:07:03.341Z or nulls");
      }
    }
    array(key2, valid, max) {
      const value = this.object[key2];
      if (!Array.isArray(value) || value.length > max || !value.every(valid)) {
        this.problem(key2, `must be an array of at most ${max} valid entries`);
      }
    }
    optionalObject(key2, checkFields) {
      const value = this.object[key2];
      if (value === void 0 || value === null) return;
      if (!isObject2(value)) {
        this.problem(key2, "must be an object or null");
        return;
      }
      checkFields(new _FieldChecker(value, `${this.path}.${key2}`, this.problems));
    }
    /** An object, checked by `checkFields`, or null, but not absent. */
    nullableObject(key2, checkFields) {
      if (this.object[key2] === void 0) this.problem(key2, "must be an object or null");
      else this.optionalObject(key2, checkFields);
    }
    problem(key2, what) {
      this.problems.push(`${this.path}.${key2} ${what}`);
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
    if (!isObject2(value)) return "A message must be a JSON object";
    if (typeof value.type !== "string") return "A message must have a string type";
    return value;
  }
  function isObject2(value) {
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
      const times = records.map((record3) => {
        const id = typeof record3 === "object" && record3 !== null && !Array.isArray(record3) ? record3.id : void 0;
        if (typeof id !== "string") return null;
        const hash = contentHash(JSON.stringify(record3));
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
  function stringField(object3, key2) {
    const value = object3?.[key2];
    return typeof value === "string" && value !== "" ? value : null;
  }
  async function findMilkProbe() {
    try {
      const response = await fetch(`${API}/sensors`);
      const sensors = response.ok ? await response.json() : null;
      if (!Array.isArray(sensors)) return null;
      const probe = sensors.find((sensor) => isMilkProbe(sensor?.id));
      return probe ? probe.id : null;
    } catch {
      return null;
    }
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
  var localApi;
  function useLocalApi(host) {
    localApi = (path, options) => host.localApi(path, options);
  }
  async function manage(method, path, body) {
    if (!localApi) throw new Error("This Decaid gives the plugin no localApi");
    const answer = await localApi(`/api/v1${path}`, body === void 0 ? { method } : { method, body });
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, text: answer.body };
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
    const read = profileOf(profile);
    return read === null || read.steps.length === 0 ? null : profileStepsKey(read);
  }
  function movedBeanOrProfile(previous, workflow) {
    if (dye2Fingerprint(profileOf(previous.profile)) !== dye2Fingerprint(profileOf(workflow.profile))) return true;
    return LOADED_RECIPE_PARTS.batch.some((field) => !sameValue(workflowValueAt(previous, field) ?? null, workflowValueAt(workflow, field) ?? null));
  }
  function clearRecipe() {
    return workflowPatch({ [DYE2_RECIPE_FIELD]: null });
  }
  function loadable(records) {
    return new Map(
      records.flatMap((record3) => {
        const globalId = dye2GlobalIdOf(record3);
        return globalId !== null && typeof record3.id === "string" ? [[record3.id, { globalId, record: record3 }]] : [];
      })
    );
  }
  function vacatedIds(before, after) {
    const now2 = new Map(after.flatMap((record3) => typeof record3.id === "string" ? [[record3.id, record3]] : []));
    return before.flatMap((record3) => {
      if (typeof record3.id !== "string") return [];
      const was = dye2GlobalIdOf(record3);
      const is = now2.get(record3.id);
      return is === void 0 || was !== null && dye2GlobalIdOf(is) !== was ? [record3.id] : [];
    });
  }
  function loadWrite(workflow, record3, load, omit = /* @__PURE__ */ new Set()) {
    const context = isObject3(workflow.context) ? workflow.context : {};
    const extras = isObject3(context.extras) ? context.extras : {};
    const variables = isObject3(record3.dashboardVariables) ? record3.dashboardVariables : {};
    const contextWrite = {};
    const extrasWrite = {};
    const dose = noneAtZero(numberOf(variables.dose));
    if (!sameNumber(dose, noneAtZero(numberOf(context.targetDoseWeight))) && !omit.has("dose")) contextWrite.targetDoseWeight = dose;
    const ratio = numberOf(variables.ratio);
    const yieldValue = numberOf(variables.drink) ?? (ratio !== null && dose !== null ? Math.round(dose * ratio * 10) / 10 : WORKFLOW_YIELD_OFF);
    if (!sameNumber(yieldValue, numberOf(context.targetYield) ?? WORKFLOW_YIELD_OFF) && !omit.has("yield")) contextWrite.targetYield = yieldValue;
    const grind = grindOf(variables.grind);
    if (!sameGrind(grind, grindOf(context.grinderSetting)) && !omit.has("grind")) contextWrite.grinderSetting = grind;
    const grinder = textOf(variables.grinderId);
    if (grinder === null) {
      if ((textOf(context.grinderId) !== null || textOf(context.grinderModel) !== null) && !omit.has("grinder")) Object.assign(contextWrite, { grinderId: null, grinderModel: null });
    } else if (grinder !== textOf(context.grinderId) && !omit.has("grinder")) {
      contextWrite.grinderId = grinder;
      if (textOf(variables.grinderModel) !== null) contextWrite.grinderModel = variables.grinderModel;
    }
    const rpm = noneAtZero(numberOf(variables.rpm));
    if (!sameNumber(rpm, noneAtZero(numberOf(extras.rpm))) && !omit.has("rpm")) extrasWrite.rpm = rpm;
    const feedRate = textOf(variables.feedRate);
    if (feedRate !== textOf(extras.feedRate) && !omit.has("feedRate")) extrasWrite.feedRate = feedRate;
    const basket = textOf(variables.basketId);
    if (basket === null) {
      if ((textOf(extras.basketId) !== null || textOf(extras.basketName) !== null) && !omit.has("basket")) Object.assign(extrasWrite, { basketId: null, basketName: null });
    } else if (basket !== textOf(extras.basketId) && !omit.has("basket")) {
      extrasWrite.basketId = basket;
      if (textOf(variables.basketName) !== null) extrasWrite.basketName = variables.basketName;
    }
    const batch = textOf(record3.beanBatchId);
    const namesBean = textOf(record3.beanId) !== null || textOf(record3.beanName) !== null;
    if (batch !== null && batch !== textOf(context.beanBatchId) && !omit.has("batch")) {
      contextWrite.beanBatchId = batch;
      if (textOf(record3.beanName) !== null) contextWrite.coffeeName = record3.beanName;
      if (textOf(record3.beanRoaster) !== null) contextWrite.coffeeRoaster = record3.beanRoaster;
    } else if (batch === null && namesBean && textOf(context.beanBatchId) !== null && !omit.has("batch")) {
      contextWrite.beanBatchId = null;
      contextWrite.coffeeName = textOf(record3.beanName);
      contextWrite.coffeeRoaster = textOf(record3.beanRoaster);
    } else if (!namesBean && !omit.has("batch") && WORKFLOW_BEAN.some((field) => context[field] !== null && context[field] !== void 0)) {
      for (const field of WORKFLOW_BEAN) contextWrite[field] = null;
    }
    if (Object.keys(extrasWrite).length > 0) contextWrite.extras = extrasWrite;
    const write = {};
    if (Object.keys(contextWrite).length > 0) write.context = contextWrite;
    const key2 = load.profile === null ? null : profileStepsKey(load.profile);
    if (!omit.has("profile") && key2 !== null && key2 !== profileKey(workflow.profile)) write.profile = load.profile;
    const off = steamHeldOff(numberOf(variables[RECIPE_SETTINGS.steamTemperature.dye2]), numberOf(variables[RECIPE_SETTINGS.steamDuration.dye2]));
    const settings = RECIPE_SETTING_NAMES.flatMap((setting) => {
      const { dye2, workflow: path } = RECIPE_SETTINGS[setting];
      const held = numberOf(variables[dye2]);
      const value = SWITCHES_STEAM.has(setting) && off ? STEAM_OFF_VALUE : setting === "steamDuration" ? steamTimeOf(held) : held;
      if (value === null || sameNumber(value, numberOf(workflowValueAt(workflow, path)))) return [];
      return omit.has(setting) ? [] : [[path, value]];
    });
    Object.assign(write, workflowPatch(Object.fromEntries(settings)));
    return Object.keys(write).length > 0 ? write : null;
  }
  var SWITCHES_STEAM = /* @__PURE__ */ new Set(["steamTemperature", "steamDuration"]);
  function steamOnWith(workflow) {
    const temperature = numberOf(workflowValueAt(workflow, RECIPE_SETTINGS.steamTemperature.workflow));
    if (temperature === null || temperature < STEAM_ON_FROM) return null;
    return { temperature, duration: numberOf(workflowValueAt(workflow, RECIPE_SETTINGS.steamDuration.workflow)) };
  }
  function steamBackOnWrite(workflow, record3, turnedOn) {
    if (steamOff(workflow)) return null;
    const variables = isObject3(record3.dashboardVariables) ? record3.dashboardVariables : {};
    const [temperature, duration] = [numberOf(variables[RECIPE_SETTINGS.steamTemperature.dye2]), numberOf(variables[RECIPE_SETTINGS.steamDuration.dye2])];
    if (steamHeldOff(temperature, duration)) return null;
    const recipes = { temperature, duration: steamTimeOf(duration) };
    const fields = {};
    for (const [part, setting] of [["temperature", "steamTemperature"], ["duration", "steamDuration"]]) {
      const path = RECIPE_SETTINGS[setting].workflow;
      const value = recipes[part];
      const now2 = numberOf(workflowValueAt(workflow, path));
      if (value === null) continue;
      if (sameNumber(now2, turnedOn[part]) && !sameNumber(now2, value)) fields[path] = value;
    }
    return Object.keys(fields).length > 0 ? workflowPatch(fields) : null;
  }
  function steamOffPaired(fields, sent) {
    const [temperaturePath, timePath] = [RECIPE_SETTINGS.steamTemperature.workflow, RECIPE_SETTINGS.steamDuration.workflow];
    const temperature = sent[temperaturePath];
    if (typeof temperature !== "number" || temperature >= STEAM_ON_FROM) return fields;
    if (temperaturePath in fields) return { ...fields, [timePath]: STEAM_OFF_VALUE };
    const kept = { ...fields };
    delete kept[timePath];
    return kept;
  }
  var WORKFLOW_BEAN = ["beanBatchId", "coffeeName", "coffeeRoaster"];
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
    return sameGrindSetting(a, b);
  }
  function isObject3(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/dye2.ts
  var CHANGED_SOCKET = `ws://localhost:8080/ws/v1/plugins/${DYE2_NAMESPACE}/changed`;
  var RECORD = `/plugins/${DYE2_NAMESPACE}/record`;
  async function recordIntoRecipe() {
    const answer = await request("POST", RECORD, {});
    if (answer.status === 404) return "unavailable";
    const value = answer.ok ? parsed(answer.text) : void 0;
    if (!isObject4(value)) throw new Error(`Decaid answered ${answer.status} asking DYE2 to save into its recipe: ${answer.text.slice(0, 200)}`);
    return value.saved === true ? "saved" : "unchanged";
  }
  async function readDye2State() {
    const answer = await request("GET", "/plugins");
    const value = answer.ok ? parsed(answer.text) : void 0;
    if (!Array.isArray(value)) throw new Error(`Decaid answered ${answer.status} listing its plugins`);
    const dye2 = value.find((plugin) => isObject4(plugin) && plugin.id === DYE2_NAMESPACE);
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
  function isObject4(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/loaded-recipes.ts
  var RECIPES = `/store/${DYE2_NAMESPACE}/recipes`;
  var HELD_LOAD_KEY = "heldLoad";
  var LoadedRecipes = class {
    constructor(changes, library, log, transports, pollMs, shot, storage, pushed = () => {
    }, reportRecipes = async () => {
    }, workflowWritten = () => {
    }) {
      __publicField(this, "changes", changes);
      __publicField(this, "library", library);
      __publicField(this, "log", log);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "shot", shot);
      __publicField(this, "storage", storage);
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
      /**
       * Armed for twice the poll interval as DYE2 is first seen not loaded,
       * since it was last loaded, by the host's timers, as SHOT_STORED_WITHIN_MS
       * is, which a correction of the tablet's clock does not move.
       */
      __publicField(this, "awayTimer");
      /** Whether `awayTimer` has fired since DYE2 was last seen loaded. */
      __publicField(this, "notLoadedLong", false);
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
      /** Whether a read of DYE2's recipes is waiting its turn (`readSoon`): one more change needs none of its own. */
      __publicField(this, "readQueued", false);
      /** The Recipe, by its global id, whose load is held until the Shot being pulled ends, or null for none. */
      __publicField(this, "heldLoad", null);
      /**
       * The load held as the plugin last stopped, by its Recipe's global id, or
       * null for none, once read from its storage, until the plugin's first
       * decision takes it, or its read does where that decision came first;
       * undefined until read.
       */
      __publicField(this, "restoredLoad");
      /** How many loads the plugin had decided on as it first decided, or undefined before. */
      __publicField(this, "firstLoads");
      /** Whether the plugin's storage may keep a load held for a Shot. */
      __publicField(this, "loadKept", false);
      /**
       * Steam turned back on with a Recipe loaded, its write of the Recipe's
       * steam temperature and time still to make, which the next save of that
       * Recipe and load makes first (`steamBackOnFirst`); null for none.
       */
      __publicField(this, "steamBackOn", null);
      /**
       * Whether the Workflow had steam off at the plugin's last decision, or in
       * any Workflow Decaid has reported or answered its writes with since: so
       * steam turned off and back on while the plugin's writes were under way,
       * whose changes are decided on together once they are done, is seen as
       * turned back on.
       */
      __publicField(this, "steamWasOff", false);
      __publicField(this, "chain", Promise.resolve());
      __publicField(this, "pollTimer");
      __publicField(this, "stopped", false);
      __publicField(this, "failing", false);
      __publicField(this, "pushes");
      this.pushes = new Dye2Pushes(transports, () => pushed());
    }
    start() {
      this.shot.onEnd(() => this.releaseLoad());
      this.shot.onEnd(() => this.resumeSteamBackOn());
      setTimeout(() => void this.restoreLoad(), 0);
      this.poll();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
      if (this.awayTimer !== void 0) clearTimeout(this.awayTimer);
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
      if (steamOff(workflow)) this.steamWasOff = true;
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
    async ownWrite(write, work) {
      if (this.writing === 0) this.duringWrite = { reported: false, answered: void 0, before: this.latest, written: /* @__PURE__ */ new Set() };
      this.writing++;
      this.changes.hold();
      try {
        return await work((workflow, body) => {
          this.duringWrite.answered = workflow;
          for (const path of fieldPaths(body)) this.duringWrite.written.add(path);
          this.changes.wrote(write);
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
      const { reported, answered: answered3, before, written: written2 } = this.duringWrite;
      if (!reported && answered3 !== void 0) this.latest = answered3;
      const latest = this.latest;
      if (answered3 !== void 0 && steamOff(answered3)) this.steamWasOff = true;
      const after = latest !== void 0 && answered3 !== void 0 && !sameValue(latest, answered3);
      const around = latest !== void 0 && before !== void 0 && changedBesides(before, latest, written2);
      this.decide(written2.has("profile") ? answered3 ?? before : before, reported && after || around);
    }
    async beforePost(before, after) {
      const vacated = new Set(vacatedIds(before, after));
      if (vacated.size === 0) return;
      await this.ownWrite("clear", async (answered3) => {
        const workflow = await workflowNow();
        const named = dye2RecipeIdOf(workflow);
        if (named === null || !vacated.has(named)) return;
        const body = clearRecipe();
        const answer = await request("PUT", "/workflow", body);
        const updated = answer.ok ? parsed2(answer.text) : void 0;
        if (!isObject5(updated)) throw new Error(`Decaid answered ${answer.status} clearing the Workflow's recipe before its record is replaced: ${answer.text.slice(0, 200)}`);
        answered3(updated, body);
        this.workflowWritten(workflow, updated);
      });
    }
    posted(records) {
      this.sawRecipes(records);
    }
    /**
     * Decides on the latest Workflow, once the recipes are read: one naming a
     * Recipe the plugin has not loaded loads it (`load`), but on the
     * plugin's first decision, which takes it as loaded, unless its load was
     * held for a Shot as the plugin last stopped; a change of it
     * (`changed`) naming the Loaded Recipe is saved into it (`saveSoon`), but
     * for one changing the profile from `previous`, as DYE2 fingerprints one,
     * which DYE2 clears the recipe on. One moving the bean or the profile
     * from `previous` (`movedBeanOrProfile`) has DYE2's recipes read first
     * (`readSoon`). One leaving steam on where it was off
     * since the last decision (`steamWasOff`, `steamOnWith`), turned back on,
     * has the save write the Recipe's steam temperature and time first. A
     * read of the recipes (`changed` false) saves nothing.
     */
    decide(previous, changed) {
      const workflow = this.latest;
      if (workflow === void 0 || this.records === null || this.stopped) return;
      const turnedOn = this.steamWasOff ? steamOnWith(workflow) : null;
      this.steamWasOff = steamOff(workflow);
      const recordId = dye2RecipeIdOf(workflow);
      const globalId = (recordId === null ? void 0 : this.records.get(recordId))?.globalId ?? null;
      if (globalId !== this.loaded) {
        const first = this.loaded === void 0;
        const restored = first && globalId !== null && globalId === this.restoredLoad;
        this.loaded = globalId;
        this.loads++;
        if (first) this.firstLoads = this.loads;
        if (globalId !== null && (!first || restored) && this.sharing()) this.load(globalId);
        else if (first && this.restoredLoad !== void 0) void this.keepHeldLoad(null);
        if (first && this.restoredLoad !== void 0) this.restoredLoad = null;
        this.steamBackOn = null;
        return;
      }
      if (!changed || globalId === null || !this.sharing()) return;
      if (previous !== void 0 && movedBeanOrProfile(previous, workflow)) this.readSoon();
      if (previous !== void 0 && dye2Fingerprint(profileOf(previous.profile)) !== dye2Fingerprint(profileOf(workflow.profile))) return;
      if (turnedOn !== null) this.steamBackOn = { globalId, load: this.loads, turnedOn };
      this.saveSoon({ globalId, load: this.loads, fingerprint: dye2Fingerprint(profileOf(workflow.profile)) });
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
     * which DYE2 clears the recipe on, is not saved into it. Where steam was
     * turned back on, the Recipe's steam temperature and time are written
     * first, or the save held with that write for a Shot (`steamBackOnFirst`). A save that
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
        const steamBackOn = this.steamBackOnFor(save);
        if (steamBackOn !== null) this.sawRecipes(await this.readRecipes());
        if (!current()) return;
        const workflow = await workflowNow();
        const recordId = dye2RecipeIdOf(workflow);
        const named = recordId === null ? void 0 : this.records?.get(recordId)?.globalId;
        if (recordId === null || named !== save.globalId || dye2Fingerprint(profileOf(workflow.profile)) !== save.fingerprint || !current()) return;
        if (!await this.steamBackOnFirst(workflow, recordId, save, steamBackOn) || !current()) return;
        if (await recordIntoRecipe() === "saved") await this.reportRecipes();
        this.failing = false;
      }).catch((error) => this.failed(error)).finally(() => this.changes.release());
    }
    /**
     * Reads DYE2's recipes in `library`'s turn, and reports them where they
     * changed (`reportRecipes`), holding the Workflow's changes back until
     * then: a Skin that edits the Loaded Recipe writes its record, which
     * Decaid's store announces none of, and then the Workflow, so the server
     * takes in the record's edit before the Workflow change, and the other
     * Machines are written it then, not at the next poll (#570). In
     * `library`'s turn, a read follows a save of DYE2's under way rather than
     * racing it. The read reaches `decide` as no change, so queues no save.
     * One read waiting its turn covers every change after it.
     */
    readSoon() {
      if (this.readQueued) return;
      this.readQueued = true;
      this.changes.hold();
      void this.library.run(async () => {
        this.readQueued = false;
        if (!this.stopped) await this.reportRecipes();
      }).catch((error) => this.failed(error)).finally(() => this.changes.release());
    }
    /** Loads the Recipe in `library`'s turn (`loadRecipe`), or, while a Shot is being pulled, holds its load until the Shot ends. */
    load(globalId) {
      if (this.shot.running()) {
        this.holdLoad(globalId);
        return;
      }
      void this.library.run(() => this.loadRecipe(globalId)).catch((error) => this.failed(error)).finally(() => {
        if (this.heldLoad === null && !this.stopped) void this.keepHeldLoad(null);
      });
    }
    /** Holds the Recipe's load until the Shot ends, in place of any held before, and keeps it in the plugin's storage. */
    holdLoad(globalId) {
      this.heldLoad = globalId;
      void this.keepHeldLoad(globalId);
    }
    /** Once the Shot ends, makes the load held for it. */
    releaseLoad() {
      const globalId = this.heldLoad;
      if (globalId === null || this.stopped) return;
      this.heldLoad = null;
      this.load(globalId);
    }
    /**
     * Reads the load held for a Shot as the plugin last stopped, which the
     * plugin's first decision makes where the Workflow names its Recipe; one it
     * cannot read is none. Read after that decision, it is made while the
     * Recipe it took as loaded is that one and no other load was decided on
     * since, and otherwise cleared.
     */
    async restoreLoad() {
      if (this.stopped) return;
      let stored = null;
      try {
        stored = await this.storage.read(HELD_LOAD_KEY, "a read of the load held for a Shot");
      } catch (error) {
        this.log(`The load held for a Shot could not be read from Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}`);
      }
      const restored = heldGlobalId(stored);
      this.loadKept || (this.loadKept = restored !== null);
      if (this.stopped) return;
      if (this.firstLoads === void 0) {
        this.restoredLoad = restored;
        return;
      }
      this.restoredLoad = null;
      if (restored !== null && restored === this.loaded && this.loads === this.firstLoads && this.sharing()) this.load(restored);
      else if (this.heldLoad === null) void this.keepHeldLoad(null);
    }
    /** Keeps the load held for a Shot in the plugin's storage, or none, where it keeps one. */
    async keepHeldLoad(globalId) {
      if (globalId === null && !this.loadKept) return;
      this.loadKept = globalId !== null;
      try {
        await this.storage.write(HELD_LOAD_KEY, JSON.stringify(globalId === null ? {} : { globalId }), "the write of the load held for a Shot");
      } catch (error) {
        this.log(`The load held for a Shot could not be kept in Decaid's plugin storage: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    /**
     * Before a save into the Loaded Recipe, where steam was turned back on with
     * that Recipe and load (`steamBackOn`): writes the Recipe's steam
     * temperature and time, as the tablet's record of it holds them, into the
     * Workflow (`steamBackOnWrite`), each where it still holds the one steam
     * came back with, so DYE2's save, which saves every value of the Workflow
     * the record holds otherwise, saves neither. `saveSoon` reads the records
     * afresh before the Workflow, so the Workflow judged is no older than the
     * record, and a load decided on during that read is not written into. While the Machine
     * pulls a Shot, the write, and the save with it, are held until the Shot
     * ends (`resumeSteamBackOn`). Steam turned back on since the save began
     * (`began`) is left to the save queued with it, which reads the records
     * afresh. Resolves with whether the save goes on.
     * Throws if Decaid refuses the write, as with no machine connected: the
     * next change tries again.
     */
    async steamBackOnFirst(workflow, recordId, save, began) {
      const pending = this.steamBackOnFor(save);
      if (pending === null) return true;
      if (pending !== began) return false;
      const record3 = this.records?.get(recordId)?.record;
      const write = record3 === void 0 ? null : steamBackOnWrite(workflow, record3, pending.turnedOn);
      if (write !== null && this.shot.running()) return false;
      if (write !== null) {
        await this.ownWrite("steamOn", async (answered3) => {
          const answer = await request("PUT", "/workflow", write);
          const updated = answer.ok ? parsed2(answer.text) : void 0;
          if (!isObject5(updated)) throw new Error(`Decaid answered ${answer.status} turning steam back on with the Loaded Recipe's steam settings: ${answer.text.slice(0, 200)}`);
          answered3(updated, write);
          this.workflowWritten(workflow, updated);
        });
      }
      if (this.steamBackOn === pending) this.steamBackOn = null;
      return true;
    }
    /** Where steam was turned back on with the Recipe and load the save is for, what it came back with (`steamBackOn`); otherwise null. */
    steamBackOnFor(save) {
      const pending = this.steamBackOn;
      return pending !== null && pending.globalId === save.globalId && pending.load === save.load ? pending : null;
    }
    /** Once a Shot ends: saves where steam turned back on during it is still to be written, which writes it first. */
    resumeSteamBackOn() {
      const pending = this.steamBackOn;
      const workflow = this.latest;
      if (pending === null || workflow === void 0 || this.stopped || pending.globalId !== this.loaded || pending.load !== this.loads) return;
      if (!this.sharing() || this.shot.running()) return;
      this.saveSoon({ globalId: pending.globalId, load: pending.load, fingerprint: dye2Fingerprint(profileOf(workflow.profile)) });
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
        if (this.awayTimer !== void 0) clearTimeout(this.awayTimer);
        this.awayTimer = void 0;
        this.notLoadedLong = false;
        this.pushes.keepOpen();
      } else if (this.awayTimer === void 0 && !this.notLoadedLong && !this.stopped) {
        this.awayTimer = setTimeout(() => {
          this.awayTimer = void 0;
          this.notLoadedLong = true;
        }, 2 * this.pollMs);
      }
      this.changes.dye2Absent(this.unavailable());
      this.sawRecipes(await this.readRecipes());
    }
    /**
     * Whether DYE2 is not there: absent, disabled, or not loaded for longer
     * than twice the poll interval, as the host's timers count it
     * (`awayTimer`). Unlike a Settings Edit's deadline, this needs no check by
     * the tablet's clock for time it spent asleep, as it measures an absence
     * seen across polls, and polls stop while the tablet sleeps too.
     */
    unavailable() {
      if (this.dye2 === "absent" || this.dye2 === "disabled") return true;
      return this.dye2 === "notLoaded" && this.notLoadedLong;
    }
    /**
     * Loads the Recipe the Workflow names, while it still names it: writes
     * into the Workflow what applying a DYE2 recipe leaves out, or a stale
     * copy got wrong (`loadWrite`), as one write (`putWorkflow`), its profile,
     * where it writes one, the record's own. Decaid refuses to change the
     * steam, hot water and flush settings while no machine is connected, so
     * the rest is then written without them. A write Decaid takes is told of
     * (`workflowWritten`).
     */
    async loadRecipe(globalId) {
      if (this.stopped || !this.sharing()) return;
      if (this.shot.running()) {
        if (this.loaded === globalId && this.heldLoad === null) this.holdLoad(globalId);
        return;
      }
      await this.ownWrite("load", async (answered3) => {
        const workflow = await workflowNow();
        const recordId = dye2RecipeIdOf(workflow);
        const recipe = recordId === null ? void 0 : this.records?.get(recordId);
        if (recordId === null || recipe === void 0 || recipe.globalId !== globalId) return;
        const context = await this.loadContext(recipe.record);
        let write = loadWrite(workflow, recipe.record, context);
        if (write === null) return;
        let answer = await putWorkflow(write, answered3);
        if (!answer.ok && MACHINE_SETTING_PARTS.some((part) => part in write) && machineMissing(answer)) {
          write = loadWrite(workflow, recipe.record, context, new Set(RECIPE_SETTING_NAMES));
          answer = write === null ? void 0 : await putWorkflow(write, answered3);
        }
        if (answer && !answer.ok) throw new Error(`Decaid answered ${answer.status} loading the recipe ${recordId}: ${answer.text.slice(0, 200)}`);
        const after = answer ? parsed2(answer.text) : void 0;
        if (isObject5(after)) this.workflowWritten(workflow, after);
      });
    }
    /** The tablet's recipes, read now. Throws if Decaid does not answer with them. */
    async readRecipes() {
      const answer = await request("GET", RECIPES);
      const value = answer.ok ? parsed2(answer.text) : void 0;
      if (value === void 0) throw new Error(`Decaid answered ${answer.status} reading DYE2's recipes`);
      return value;
    }
    /** The record at that path of Decaid's API, or null if it holds none (404). Throws if Decaid answers otherwise. */
    async readRecord(path) {
      const answer = await request("GET", path);
      if (answer.status === 404) return null;
      const record3 = answer.ok ? parsed2(answer.text) : void 0;
      if (record3 === void 0) throw new Error(`Decaid answered ${answer.status} reading ${path}`);
      return record3;
    }
    /**
     * What a load of the recipe writes besides its record: its full Profile at
     * its brew temperature, as the Workflow DYE2 embeds in the record holds it
     * (decentespresso/dye2#26), or else as its snapshot or the tablet's record
     * of that Profile does.
     */
    async loadContext(record3) {
      const full = (profile) => {
        const read = profileOf(profile);
        return read !== null && read.steps.length > 0 ? read : null;
      };
      const embedded = full(isObject5(record3.workflow) ? record3.workflow.profile : null) ?? full(record3.profileSnapshot);
      if (embedded !== null) return { profile: embedded };
      const stored = typeof record3.profileId === "string" && record3.profileId !== "" ? await this.readRecord(`/profiles/${encodeURIComponent(record3.profileId)}`) : null;
      return { profile: isObject5(stored) ? full(stored.profile) : null };
    }
  };
  async function putWorkflow(body, answered3) {
    const answer = await request("PUT", "/workflow", body);
    const updated = answer.ok ? parsed2(answer.text) : void 0;
    if (isObject5(updated)) answered3(updated, body);
    return answer;
  }
  function fieldPaths(body, prefix = "") {
    return Object.entries(body).flatMap(([key2, value]) => {
      const path = prefix === "" ? key2 : `${prefix}.${key2}`;
      return isObject5(value) && path !== "profile" ? fieldPaths(value, path) : [path];
    });
  }
  var PART_FIELDS = Object.values(LOADED_RECIPE_PARTS).flat();
  function changedBesides(before, after, written2) {
    const set = (field) => [...written2].some((path) => field === path || field.startsWith(`${path}.`) || path.startsWith(`${field}.`));
    if (!set("profile") && dye2Fingerprint(profileOf(before.profile)) !== dye2Fingerprint(profileOf(after.profile))) return true;
    return PART_FIELDS.some((field) => field !== "profile" && !set(field) && !sameValue(workflowValueAt(before, field), workflowValueAt(after, field)));
  }
  async function workflowNow() {
    const answer = await request("GET", "/workflow");
    const workflow = answer.ok ? parsed2(answer.text) : void 0;
    if (!isObject5(workflow)) throw new Error(`Decaid answered ${answer.status} reading the Workflow`);
    return workflow;
  }
  function heldGlobalId(stored) {
    const held = typeof stored === "string" ? parsed2(stored) : void 0;
    return isObject5(held) && typeof held.globalId === "string" ? held.globalId : null;
  }
  function machineMissing(answer) {
    return answer.status === 500 && answer.text.includes("DeviceNotConnectedException");
  }
  function parsed2(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject5(value) {
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
      sameItem: (record3, fields) => typeof record3.roaster === "string" && typeof record3.name === "string" && typeof fields.roaster === "string" && typeof fields.name === "string" && beanMatchKey(record3.roaster, record3.name) === beanMatchKey(fields.roaster, fields.name),
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
      listUnder: (parentPath) => `${parentPath}/batches?includeArchived=true`,
      inExtras: BATCH_EXTRAS_KEYS
    },
    grinder: {
      list: "/grinders?includeArchived=true",
      records: "/grinders",
      create: () => "/grinders",
      deferred: ["archived"],
      sameItem: () => false,
      namedByShots: true,
      inExtras: Object.fromEntries(GRINDER_EXTRAS_FIELDS.map((field) => [field, field]))
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
    [LOADED_RECIPE_KIND]: { write: writeLoadedRecipe, changesWorkflow: true },
    [DRAFT_KIND]: { write: writeFollowedDraft, changesWorkflow: true }
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
      write: async (write, _log, posted) => {
        if (write.localId === null) return await create(route, write);
        const updated = await update(route, write, write.localId);
        const answer = answerTo(write, updated.answer, updated.written);
        if (answer.type === "written") archivedChanged(kind, posted, updated.before, answer.record);
        return answer;
      },
      remove: (remove, namedByShot) => deleteRecord(kind, route, remove, namedByShot),
      setAside: (leave, posted) => readThen(route.records, leave, async (_leave, record3, path) => {
        const outcome = await archiveRecord(record3, path);
        if (outcome === "setAside" && record3.archived !== true) archivedChanged(kind, posted, record3, { ...record3, archived: true });
        return outcome;
      })
    };
  }
  function archivedChanged(kind, posted, before, after) {
    if (kind !== "beanBatch" || typeof after.id !== "string") return;
    if (before.archived === true !== (after.archived === true)) posted.batchArchived(after.id);
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
    constructor(library, outbox, loaded, machineMissing2, log, skins, shot, batchArchived = () => {
    }) {
      __publicField(this, "library", library);
      __publicField(this, "outbox", outbox);
      __publicField(this, "loaded", loaded);
      __publicField(this, "machineMissing", machineMissing2);
      __publicField(this, "log", log);
      __publicField(this, "shot", shot);
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
      this.posted = Object.assign((key2) => skins.listPosted(key2), { loaded, workflowWritten: skins.workflowWritten, batchArchived });
      outbox.watch((delivery) => {
        if (delivery.type === "shot" || delivery.type === "shotUpdated") this.noteShot(delivery.shotId, delivery.shot);
      });
    }
    /** Deletes a record of a hard-deleted item once the reads and writes before it are done, and queues its answer. It never rejects. */
    remove(remove) {
      return this.afterShot(
        () => refused(remove, null, PULLING_SHOT),
        async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutDelete(remove, (kind, ids) => this.namedByShot(kind, ids), this.posted)))
      );
    }
    /**
     * Carries out one of the server's changes (`work`) once the reads and
     * writes before it are done, and no Shot is being pulled; while one is,
     * it is answered with `again` once the Shot ends, or after SHOT_WAIT_MS,
     * well within the server's wait for an answer.
     */
    async afterShot(again, work) {
      if (this.shot.running()) {
        if (!await this.shot.ended(SHOT_WAIT_MS)) this.outbox.enqueue(again());
        return;
      }
      await this.library.run(async () => {
        if (this.shot.running()) this.outbox.enqueue(again());
        else await work();
      });
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
      const workflow = isObject6(shot.workflow) ? shot.workflow : {};
      const profile = profileOf(workflow.profile);
      if (profile !== null) names.add(`profile:${stepsKey(profile.steps)}`);
      const context = isObject6(workflow.context) ? workflow.context : {};
      const extras = isObject6(context.extras) ? context.extras : {};
      if (typeof context.beanBatchId === "string") names.add(`beanBatch:${context.beanBatchId}`);
      if (typeof context.grinderId === "string") names.add(`grinder:${context.grinderId}`);
      if (isObject6(extras.workflowSkin) && typeof extras.workflowSkin.selectedProfileId === "string") names.add(`profile:${extras.workflowSkin.selectedProfileId}`);
      const edited2 = isObject6(shot.annotations) && isObject6(shot.annotations.extras) ? shot.annotations.extras : {};
      const basket = edited2.basketId != null || edited2.basketName != null ? edited2.basketId : extras.basketId;
      if (typeof basket === "string") names.add(`basket:${basket}`);
      for (const recorded of [edited2, extras]) {
        const tools = Array.isArray(recorded.equipmentIds) ? recorded.equipmentIds : [recorded.equipmentId];
        for (const id2 of tools) if (typeof id2 === "string") names.add(`tool:${id2}`);
      }
    }
    /** Removes a record from one of DYE2's lists once the reads and writes before it are done, and queues its answer. It never rejects. */
    drop(remove) {
      return this.afterShot(
        () => refused(remove, null, PULLING_SHOT),
        async () => this.outbox.enqueue(this.wrote(remove.kind, await carryOutRemove(remove, this.posted)))
      );
    }
    /** Has the next read of the kind's list reported whatever it holds, if it is one of DYE2's, which the plugin may just have written; returns the answer. */
    wrote(kind, answer) {
      if (isLibraryKind(kind) && dye2Key(kind) !== void 0) this.library.wrote(LIBRARY_ITEM_KINDS[kind].list);
      return answer;
    }
    /** Sets aside a record the Library leaves out once the reads and writes before it are done, and queues its answer. It never rejects. */
    leaveOut(leave) {
      return this.afterShot(
        () => ({ type: "leftOut", id: leave.id, kind: leave.kind, localId: leave.localId, outcome: "refused", status: null, error: PULLING_SHOT }),
        async () => this.outbox.enqueue(this.wrote(leave.kind, await setAside(leave, this.posted)))
      );
    }
    /** Carries out a write once the reads and writes before it are done, and queues its answer. It never rejects. */
    apply(write) {
      const again = () => refused(write, null, PULLING_SHOT);
      if (!writerOf(write.kind)?.changesWorkflow) {
        return this.afterShot(again, async () => this.outbox.enqueue(this.wrote(write.kind, await carryOut(write, this.log, this.posted))));
      }
      const named = write.kind === DRAFT_KIND ? "draft" : write.kind === LOADED_RECIPE_KIND && !(DYE2_RECIPE_FIELD in write.fields) ? "loadedRecipe" : "clear";
      return this.afterShot(
        again,
        () => this.loaded.ownWrite(named, async (answered3) => {
          const answer = await carryOut(write, this.log, Object.assign((key2) => this.posted(key2), this.posted, { answered: answered3 }));
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
    const record3 = current.ok ? parsed3(current.text) : void 0;
    if (!isObject6(record3)) return refused(remove, current.status, current.text);
    const carried = globalIdOf(record3);
    if (carried !== null && carried !== remove.globalId.toLowerCase()) return refused(remove, null, ANOTHER_ITEMS_RECORD);
    if (route.namedByShots) {
      const named = await namedByShot(kind, /* @__PURE__ */ new Set([remove.localId]));
      if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
    }
    for (const child of childKinds(kind)) {
      const under = routeOf(child)?.listUnder;
      if (!under) return refused(remove, null, `This plugin cannot delete the ${child} records under a ${kind}`);
      const listed = await request("GET", under(path));
      const children = listed.ok ? parsed3(listed.text) : void 0;
      if (!Array.isArray(children)) return refused(remove, listed.status, listed.text);
      const ids = new Set(children.filter(isObject6).flatMap((record4) => typeof record4.id === "string" ? [record4.id] : []));
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
    const record3 = current.ok ? parsed3(current.text) : void 0;
    if (!isObject6(record3)) return refused(remove, current.status, current.text);
    const profile = profileOf(record3.profile);
    const named = await namedByShot("profile", new Set(profile === null ? [remove.localId] : [remove.localId, stepsKey(profile.steps)]));
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
  var SHOT_WAIT_MS = 12e4;
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
    const record3 = current.ok ? parsed3(current.text) : void 0;
    if (!isObject6(record3)) return current;
    return setAsideRecord(leave, record3, path);
  }
  async function archiveRecord(record3, path) {
    if (globalIdOf(record3) !== null) return "taken";
    if (record3.archived === true) return "setAside";
    const archived = await request("PUT", path, { archived: true, extras: isObject6(record3.extras) ? record3.extras : {} });
    const updated = archived.ok ? parsed3(archived.text) : void 0;
    return isObject6(updated) && updated.archived === true ? "setAside" : archived;
  }
  async function hideProfile(leave, record3) {
    if (record3.visibility !== "visible") return "setAside";
    const hidden = await setVisibility(leave.localId, "hidden");
    const updated = hidden.ok ? parsed3(hidden.text) : void 0;
    return isObject6(updated) && updated.visibility !== "visible" ? "setAside" : hidden;
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
    let record3 = held.record;
    const writtenFields = [];
    if (!record3) {
      const { parentId, metadata } = write.fields;
      const profile = readProfile(write.fields.profile);
      if (!profile.profile) return refused(write, null, profile.problem);
      const parent = typeof parentId === "string" ? await heldProfile(parentId) : void 0;
      if (parent && "refused" in parent) return refused(write, parent.refused.status, parent.refused.text);
      const body = { profile: profile.profile, ...parent?.record ? { parentId } : {}, ...isObject6(metadata) ? { metadata } : {} };
      const made = await request("POST", "/profiles", body);
      const created = made.ok ? parsed3(made.text) : void 0;
      if (!isObject6(created) || typeof created.id !== "string") return refused(write, made.status, made.text);
      record3 = created;
      writtenFields.push(...Object.keys(body));
    }
    if (record3.id !== write.globalId || typeof visibility !== "string" || record3.visibility === visibility) return written(write, record3, writtenFields);
    const again = await setVisibility(write.globalId, visibility).catch(() => void 0);
    const updated = again?.ok ? parsed3(again.text) : void 0;
    if (!isObject6(updated) || updated.id !== write.globalId) return written(write, record3, writtenFields);
    return written(write, updated, [...writtenFields, "visibility"]);
  }
  async function clearWorkflow(write, _log, posted) {
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed3(current.text) : void 0;
    if (!isObject6(workflow)) return refused(write, current.status, current.text);
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
    const updated = answer.ok ? parsed3(answer.text) : void 0;
    if (!isObject6(updated)) return refused(write, answer.status, answer.text);
    posted.answered?.(updated, body);
    posted.workflowWritten(workflow, updated);
    return written(write, workflowContext(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
  }
  async function writeLoadedRecipe(write, _log, posted) {
    const expected = write.expected?.[DYE2_RECIPE_FIELD];
    const recordId = typeof expected === "string" ? expected : null;
    if (DYE2_RECIPE_FIELD in write.fields) {
      const current = await request("GET", "/workflow");
      const workflow = current.ok ? parsed3(current.text) : void 0;
      if (!isObject6(workflow)) return refused(write, current.status, current.text);
      if (recordId === null || dye2RecipeIdOf(workflow) !== recordId) return written(write, loadedRecipeParts(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
      const body = clearRecipe();
      const answer = await request("PUT", "/workflow", body);
      const updated = answer.ok ? parsed3(answer.text) : void 0;
      if (!isObject6(updated)) return refused(write, answer.status, answer.text);
      posted.answered?.(updated, body);
      posted.workflowWritten(workflow, updated);
      return written(write, loadedRecipeParts(updated), [DYE2_RECIPE_FIELD], (/* @__PURE__ */ new Date()).toISOString());
    }
    if (recordId === null) return refused(write, null, "A write of the Loaded Recipe must name the recipe the Workflow is to name");
    let machineSettings = true;
    for (; ; ) {
      const current = await request("GET", "/workflow");
      const workflow = current.ok ? parsed3(current.text) : void 0;
      if (!isObject6(workflow)) return refused(write, current.status, current.text);
      if (dye2RecipeIdOf(workflow) !== recordId) return refused(write, null, ANOTHER_RECIPE);
      const fields = loadedRecipeFields(write, workflow, machineSettings);
      if (Object.keys(fields).length === 0) return written(write, loadedRecipeParts(workflow), [], (/* @__PURE__ */ new Date()).toISOString());
      let updated;
      const answer = await putWorkflow(loadedRecipePatch(fields, workflow), (workflow2, body) => {
        updated = workflow2;
        posted.answered?.(workflow2, body);
      });
      if (answer.ok && updated !== void 0) {
        posted.workflowWritten(workflow, updated);
        return written(write, loadedRecipeParts(updated), Object.keys(fields), (/* @__PURE__ */ new Date()).toISOString());
      }
      const ofMachine = Object.keys(fields).filter(isMachineSetting);
      if (ofMachine.length === 0 || ofMachine.length === Object.keys(fields).length || !machineMissing(answer)) return refused(write, answer.status, answer.text);
      machineSettings = false;
    }
  }
  async function writeFollowedDraft(write, _log, posted) {
    const profile = readProfile(write.fields.profile);
    if (!profile.profile) return refused(write, null, profile.problem);
    const current = await request("GET", "/workflow");
    const workflow = current.ok ? parsed3(current.text) : void 0;
    if (!isObject6(workflow)) return refused(write, current.status, current.text);
    const body = { profile: profile.profile, ...dye2RecipeIdOf(workflow) === null ? {} : clearRecipe() };
    let updated;
    const answer = await putWorkflow(body, (workflow2, body2) => {
      updated = workflow2;
      posted.answered?.(workflow2, body2);
    });
    if (!answer.ok || updated === void 0) return refused(write, answer.status, answer.text);
    posted.workflowWritten(workflow, updated);
    const record3 = { ...workflowContext(updated), ...isObject6(updated.profile) ? { profile: updated.profile } : {}, draft: profile.profile };
    return written(write, record3, ["profile"], (/* @__PURE__ */ new Date()).toISOString());
  }
  var STEAM_TEMPERATURE_FIELD = RECIPE_SETTINGS.steamTemperature.workflow;
  var STEAM_TIME_FIELD = RECIPE_SETTINGS.steamDuration.workflow;
  var STEAM_OFF_KEPT = /* @__PURE__ */ new Set([STEAM_TEMPERATURE_FIELD, STEAM_TIME_FIELD]);
  function isMachineSetting(field) {
    return MACHINE_SETTING_PARTS.some((part) => field.startsWith(`${part}.`));
  }
  var ANOTHER_RECIPE = "The Workflow names another recipe now, which the plugin reports first";
  function loadedRecipePatch(fields, workflow) {
    const { [BREW_TEMPERATURE_FIELD]: temperature, ...rest } = fields;
    const patch = workflowPatch(rest);
    if (typeof temperature === "number") {
      const profile = profileOf(isObject6(patch.profile) ? patch.profile : workflow.profile);
      const shifted = profile === null ? null : profileAtBrewTemperature(profile, temperature);
      if (shifted !== null) patch.profile = shifted;
    }
    return patch;
  }
  function loadedRecipeFields(write, workflow, machineSettings) {
    return steamOffPaired(loadedRecipeFieldsByPart(write, workflow, machineSettings), write.fields);
  }
  function loadedRecipeFieldsByPart(write, workflow, machineSettings) {
    return Object.fromEntries(
      Object.values(LOADED_RECIPE_PARTS).flatMap((part) => {
        const [first] = part;
        if (!(first in write.fields) || !machineSettings && isMachineSetting(first)) return [];
        if (STEAM_OFF_KEPT.has(first) && steamOff(workflow)) return [];
        const held = workflowValueAt(workflow, first);
        const expected = write.expected?.[first];
        if (expected !== void 0 && !sameValue(held, expected) && !sameValue(held, write.fields[first])) return [];
        return part.filter((field) => field in write.fields).map((field) => [field, write.fields[field]]);
      })
    );
  }
  function loadedRecipeParts(workflow) {
    return {
      context: isObject6(workflow.context) ? workflow.context : {},
      ...Object.fromEntries(MACHINE_SETTING_PARTS.map((part) => [part, isObject6(workflow[part]) ? workflow[part] : {}])),
      ...isObject6(workflow.profile) ? { profile: workflow.profile } : {}
    };
  }
  function workflowContext(workflow) {
    return { context: isObject6(workflow.context) ? workflow.context : {} };
  }
  async function updateProfile(write, id) {
    const held = await heldProfile(id);
    if ("refused" in held) return refused(write, held.refused.status, held.refused.text);
    if (!held.record) return refused(write, 404, "Profile not found");
    let record3 = held.record;
    const read = readProfile(record3.profile);
    const heldText = profileTextOf(record3.profile);
    const fields = settable(write, (field) => field === "visibility" ? record3.visibility : heldText[field]);
    const writtenFields = [];
    const text = PROFILE_TEXT_FIELDS.filter((field) => field in fields);
    if (text.length > 0) {
      if (!read.profile) return refused(write, null, read.problem);
      const profile = { ...read.profile, ...Object.fromEntries(text.map((field) => [field, typeof fields[field] === "string" ? fields[field] : ""])) };
      if (sentProfileId(profile) !== id) return refused(write, null, "The profile as sent would hash to another id, which Decaid would replace this Profile with");
      const answer = await request("PUT", `/profiles/${encodeURIComponent(id)}`, { profile });
      const updated = answer.ok ? parsed3(answer.text) : void 0;
      if (!isObject6(updated) || typeof updated.id !== "string") return refused(write, answer.status, answer.text);
      if (updated.id !== id) return written(write, updated, text);
      record3 = updated;
      writtenFields.push(...text);
    }
    if ("visibility" in fields) {
      if (record3.visibility !== fields.visibility) {
        const answer = await setVisibility(id, fields.visibility).catch((error) => {
          if (writtenFields.length === 0) throw error;
          return void 0;
        });
        const updated = answer?.ok ? parsed3(answer.text) : void 0;
        if (!isObject6(updated) || updated.id !== id) {
          return writtenFields.length === 0 ? refused(write, answer?.status ?? null, answer?.text ?? "") : written(write, record3, writtenFields);
        }
        record3 = updated;
      }
      writtenFields.push("visibility");
    }
    return written(write, record3, writtenFields);
  }
  function settable(write, current) {
    const expected = write.expected;
    return Object.fromEntries(
      Object.entries(write.fields).filter(([field]) => !expected || !(field in expected) || sameValue(current(field), expected[field]))
    );
  }
  function sentProfileId(profile) {
    const sent = readProfile(JSON.parse(JSON.stringify(profile)));
    return sent.profile ? profileId(sent.profile) : null;
  }
  async function heldProfile(id) {
    const answer = await request("GET", `/profiles/${encodeURIComponent(id)}`);
    if (answer.status === 404) return { record: void 0 };
    const record3 = answer.ok ? parsed3(answer.text) : void 0;
    return isObject6(record3) && record3.id === id ? { record: record3 } : { refused: answer };
  }
  function setVisibility(id, visibility) {
    return request("PUT", `/profiles/${encodeURIComponent(id)}/visibility`, { visibility });
  }
  async function create(route, write) {
    const listed = await request("GET", route.list);
    if (!listed.ok) return refused(write, listed.status, listed.text);
    const parsedList = parsed3(listed.text);
    const records = Array.isArray(parsedList) ? parsedList.filter(isObject6) : [];
    const held = records.find((record4) => globalIdOf(record4) === write.globalId.toLowerCase());
    if (held) return written(write, held, []);
    const same = records.find((record4) => globalIdOf(record4) === null && record4.archived !== true && route.sameItem(record4, write.fields));
    if (same && typeof same.id === "string") {
      const answer = answerTo(write, (await update(route, { ...write, fields: {} }, same.id)).answer, []);
      return answer.type === "written" ? { ...answer, linked: true } : answer;
    }
    const path = route.create(write.fields);
    if (path === null) return refused(write, null, `A ${write.kind} to create must name what it belongs to`);
    const { own, extras } = placed(route, write.fields);
    const body = { ...own, extras: { ...extras, [GLOBAL_ID_KEY]: write.globalId } };
    for (const field of route.deferred) delete body[field];
    const made = await request("POST", path, body);
    const record3 = made.ok ? parsed3(made.text) : void 0;
    if (!isObject6(record3) || typeof record3.id !== "string") return refused(write, made.status, made.text);
    const later = Object.fromEntries(route.deferred.flatMap((field) => field in write.fields && write.fields[field] !== (record3[field] ?? null) ? [[field, write.fields[field]]] : []));
    const writtenFields = Object.keys(write.fields);
    if (Object.keys(later).length === 0) return written(write, record3, writtenFields);
    const again = await request("PUT", `${route.records}/${encodeURIComponent(record3.id)}`, later).catch(() => void 0);
    const updated = again?.ok ? parsed3(again.text) : void 0;
    return written(write, isObject6(updated) && typeof updated.id === "string" ? updated : record3, writtenFields);
  }
  async function update(route, write, localId) {
    const path = `${route.records}/${encodeURIComponent(localId)}`;
    const current = await request("GET", path);
    if (!current.ok) return { answer: current, written: [], before: {} };
    const parsedRecord = parsed3(current.text);
    const record3 = isObject6(parsedRecord) ? parsedRecord : {};
    const extras = isObject6(record3.extras) ? record3.extras : {};
    const fields = settable(write, (field) => {
      const key2 = extrasKey(route, field);
      return key2 === void 0 ? record3[field] : extras[key2];
    });
    const placedFields = placed(route, fields);
    return {
      answer: await request("PUT", path, { ...placedFields.own, extras: { ...extras, ...placedFields.extras, [GLOBAL_ID_KEY]: write.globalId } }),
      written: Object.keys(fields),
      before: record3
    };
  }
  function placed(route, fields) {
    const own = {};
    const extras = {};
    for (const [field, value] of Object.entries(fields)) {
      const key2 = extrasKey(route, field);
      if (key2 === void 0) own[field] = value;
      else extras[key2] = value;
    }
    return { own, extras };
  }
  function extrasKey(route, field) {
    const keys = route.inExtras;
    return keys && Object.prototype.hasOwnProperty.call(keys, field) ? keys[field] : void 0;
  }
  function answerTo(write, answer, writtenFields) {
    const record3 = answer.ok ? parsed3(answer.text) : void 0;
    if (isObject6(record3) && typeof record3.id === "string") return written(write, record3, writtenFields);
    return refused(write, answer.status, answer.text);
  }
  function written(write, record3, writtenFields, at) {
    return {
      type: "written",
      id: write.id,
      kind: write.kind,
      globalId: write.globalId,
      record: record3,
      updatedAt: at ?? utcTime(record3.updatedAt),
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
  function parsed3(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject6(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function dye2Writer(key2) {
    const path = `/store/${DYE2_NAMESPACE}/${key2}`;
    const list = (posted) => ({ path, key: key2, posted });
    return {
      list: path,
      write: (write, _log, posted) => key2 === "recipes" ? writeRecipe(list(posted), write) : writeInList(list(posted), write),
      // A hard-deleted item's record is removed as one its Location no longer shows is. A Shot names a basket or tool by its
      // id here, so one a Shot this plugin has yet to send names is kept, as a batch is (`deleteRecord`); a Recipe is named
      // only by a Shot linked to it, which the server judges (hard-deletes.ts).
      remove: async (remove, namedByShot, posted) => {
        if (key2 !== "recipes") {
          const named = await namedByShot(key2 === "baskets" ? "basket" : "tool", /* @__PURE__ */ new Set([remove.localId]));
          if (named !== false) return refused(remove, null, named === "tooMany" ? SHOTS_STILL_TO_READ : SHOT_NOT_SENT);
        }
        const answer = await removeFromList(list(posted), remove);
        return answer.type === "removed" ? { ...answer, type: "deleted" } : answer;
      },
      drop: (remove, posted) => removeFromList(list(posted), remove),
      setAside: (leave, posted) => leaveOutOfList(list(posted), leave)
    };
  }
  async function readList({ path, key: key2 }) {
    const answer = await request("GET", path);
    const value = answer.ok ? parsed3(answer.text) : void 0;
    if (value === void 0) return { refused: answer };
    if (value === null) return { records: [] };
    const records = dye2Records(value);
    return records === null ? { unrecognised: true } : { records: [...records] };
  }
  async function postList({ path, key: key2, posted }, records, before) {
    if (key2 === "recipes") await posted.loaded?.beforePost(before, records);
    const answer = await request("POST", path, records);
    if (answer.ok) {
      posted(key2);
      if (key2 === "recipes") posted.loaded?.posted(records);
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
    let record3;
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
        record3 = { ...records[index], [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = [];
        linked = true;
      } else {
        index = records.length;
        record3 = { ...withValues(write.fields), id: randomUuid(), createdAt: now2, [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = Object.keys(write.fields);
      }
    } else {
      index = records.findIndex((candidate) => candidate.id === write.localId);
      if (index === -1) return refused(write, 404, "Record not found");
      const current = records[index];
      const fields = settable(write, (field) => current[field]);
      record3 = { ...current, ...withValues(fields), [GLOBAL_ID_KEY]: write.globalId };
      for (const [field, value] of Object.entries(fields)) if (value === null) delete record3[field];
      writtenFields = Object.keys(fields);
      if (sameValue(record3, current)) return written(write, current, writtenFields, now2);
    }
    const before = [...records];
    records[index] = record3;
    const posted = await postList(path, records, before);
    if (!posted.ok) return refused(write, posted.status, posted.text);
    const answer = written(write, record3, writtenFields, now2);
    return linked ? { ...answer, linked } : answer;
  }
  async function removeFromList(path, remove) {
    const removed = { type: "removed", id: remove.id, kind: remove.kind, globalId: remove.globalId, localId: remove.localId };
    const list = await readList(path);
    if ("refused" in list) return refused(remove, list.refused.status, list.refused.text);
    if ("unrecognised" in list) return unrecognised(remove);
    const index = list.records.findIndex((record3) => record3.id === remove.localId);
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
    const index = list.records.findIndex((record3) => record3.id === leave.localId);
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
    let record3;
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
        record3 = { ...held, [GLOBAL_ID_KEY]: write.globalId };
        writtenFields = [];
        linked = true;
      } else {
        index = records.length;
        record3 = { ...atPaths({}, withValues(fields)), id: recordId, capturedAt: now2, [GLOBAL_ID_KEY]: write.globalId };
        if (RECIPE_SLOT_FIELD in fields) record3[RECIPE_SLOT_FIELD] = fields[RECIPE_SLOT_FIELD] ?? null;
        writtenFields = Object.keys(fields);
      }
    } else {
      index = records.findIndex((candidate) => candidate.id === write.localId);
      if (index === -1) return refused(write, 404, "Record not found");
      const current = records[index];
      const settled2 = settable(write, (field) => valueAt(current, field));
      const expected = write.expected;
      if (expected && RECIPE_SLOT_FIELD in expected && !sameValue(current[RECIPE_SLOT_FIELD] ?? null, expected[RECIPE_SLOT_FIELD])) delete settled2[RECIPE_SHOWN_FIELD];
      record3 = atPaths({ ...current, [GLOBAL_ID_KEY]: write.globalId }, settled2);
      writtenFields = Object.keys(settled2);
      if (sameJson(record3, current)) return written(write, current, writtenFields, now2);
    }
    const before = [...records];
    records[index] = record3;
    const slot = record3[RECIPE_SLOT_FIELD];
    if (isRecipeSlot(slot)) {
      for (const [at, other] of records.entries()) if (at !== index && other[RECIPE_SLOT_FIELD] === slot) records[at] = { ...other, [RECIPE_SLOT_FIELD]: null };
    }
    const posted = await postList(path, records, before);
    if (!posted.ok) return refused(write, posted.status, posted.text);
    const answer = written(write, record3, writtenFields, now2);
    return linked ? { ...answer, linked } : answer;
  }
  function sameJson(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
    if (!isObject6(a) || !isObject6(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key2) => Object.prototype.hasOwnProperty.call(b, key2) && sameJson(a[key2], b[key2]));
  }
  var DASHBOARD = "dashboardVariables";
  function valueAt(record3, path) {
    if (!path.startsWith(`${DASHBOARD}.`)) return record3[path];
    const variables = record3[DASHBOARD];
    return isObject6(variables) ? variables[path.slice(DASHBOARD.length + 1)] : void 0;
  }
  function atPaths(record3, values) {
    const result = { ...record3 };
    let variables;
    for (const [path, value] of Object.entries(values)) {
      let target = result;
      let field = path;
      if (path.startsWith(`${DASHBOARD}.`)) {
        variables ?? (variables = { ...isObject6(result[DASHBOARD]) ? result[DASHBOARD] : {} });
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

  // src/sensor-calibration.ts
  var SENSOR_CALIBRATION_TARGETS = ["flow", "pressure", "temperature"];
  var KINDS = { flow: "ratio", pressure: "ratio", temperature: "offset" };
  var Q16 = 65536;
  function absoluteSet(target, current, wanted) {
    const kind = KINDS[target];
    if (kind === void 0) return { refused: `The machine has no ${target} sensor to calibrate` };
    if (typeof current !== "number" || !Number.isFinite(current)) return { refused: `Decaid's answer holds no current calibration of the ${target} sensor` };
    if (kind === "ratio" && Math.round(Math.abs(current) * Q16) === 0) {
      return { refused: `The ${target} sensor's calibration is 0, which Decaid can't correct from` };
    }
    return { body: { de1ReportedValue: current, measuredValue: wanted } };
  }

  // src/collections.ts
  var SOURCES = [
    ...LIBRARY_KINDS.map((kind) => ({ name: LIBRARY_ITEM_KINDS[kind].list, path: libraryListPath(kind) })),
    { name: "appSettings", path: "/settings" },
    { name: "presenceSettings", path: "/presence/settings" },
    { name: "machineSettings", path: "/machine/settings" },
    { name: "advancedSettings", path: "/machine/settings/advanced" },
    { name: "machineCalibration", path: "/machine/calibration" },
    { name: "sensorCalibration", read: readSensorCalibration },
    { name: "plugins", path: "/plugins" },
    // After the plugin list, which names the plugins that declare settings.
    { name: "pluginSettings", read: () => Promise.resolve({ kind: "unavailable" }) },
    { name: "decaidUpdate", path: "/update" },
    { name: "skins", read: readSkins },
    // Held by the plugin, as a Skin reports it (`SkinPages`), rather than read from Decaid.
    { name: "skinPage", read: () => Promise.resolve({ kind: "unavailable" }) },
    { name: "pairedDevices", path: "/devices", select: pairedDevices },
    { name: "scaleInfo", path: "/scale/info" },
    { name: "sensors", path: "/sensors" }
  ];
  var RECIPES2 = SOURCES.find((source) => source.name === "dye2Recipes");
  var PROFILES = SOURCES.find((source) => source.name === "profiles");
  var WRITTEN_LISTS = new Set(LIBRARY_LISTS);
  var SETTINGS = new Set(SETTINGS_COLLECTION_NAMES);
  var SOFTWARE = /* @__PURE__ */ new Set(["plugins", "pluginSettings", "decaidUpdate", "skins"]);
  var MACHINE_SETTINGS = /* @__PURE__ */ new Set(["machineSettings", "advancedSettings", "machineCalibration"]);
  var MACHINE_SETTINGS_MS = 6e4;
  var DAILY = /* @__PURE__ */ new Set(["sensorCalibration"]);
  var DAILY_MS = 24 * 60 * 6e4;
  var FROM_MACHINE = /* @__PURE__ */ new Set([...MACHINE_SETTINGS, ...DAILY]);
  var CollectionCapture = class {
    constructor(outbox, library, settings, pollMs, machine, sawRecipes, software, skinPage = () => null) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "library", library);
      __publicField(this, "settings", settings);
      __publicField(this, "pollMs", pollMs);
      __publicField(this, "machine", machine);
      __publicField(this, "sawRecipes", sawRecipes);
      __publicField(this, "software", software);
      __publicField(this, "skinPage", skinPage);
      /** What was last queued for each collection. */
      __publicField(this, "last", /* @__PURE__ */ new Map());
      /** The ids of the tablet's Profiles as last read, or undefined before the first read. */
      __publicField(this, "profileIds");
      /** The plugin list as last read, or undefined before the first read and after one that failed. */
      __publicField(this, "pluginList");
      /** When each record of each of DYE2's lists that is a Library list was first read in its current content. */
      __publicField(this, "firstReads", /* @__PURE__ */ new Map());
      /** For each collection, the latest delivery queued, and the latest queued with a value. */
      __publicField(this, "queued", /* @__PURE__ */ new Map());
      /** The sensor calibration as last read, by target, or undefined where that read was unavailable, or none was made yet. */
      __publicField(this, "sensorCalibration");
      __publicField(this, "wanted");
      /** What Software Actions change, left unread by a full read while one ran: read in full by the next poll. */
      __publicField(this, "softwareOwedFull", /* @__PURE__ */ new Set());
      /** Whether DYE2's recipes alone are to be read, as after DYE2 pushes (`readRecipes`). */
      __publicField(this, "recipesWanted", false);
      /**
       * The reads from the machine (`FROM_MACHINE`) asked for and not yet begun,
       * each with whether it is to be sent whatever it holds, as a full read's:
       * of the machine's own settings on their interval or after the Workflow
       * wrote them (`readMachineSettings`), of the sensor calibration once a
       * day, and of all of them in a full read.
       * They wait here while the machine runs something.
       */
      __publicField(this, "fromMachineWanted", /* @__PURE__ */ new Map());
      __publicField(this, "reading", false);
      __publicField(this, "stopped", false);
      __publicField(this, "pollTimer");
      __publicField(this, "machineSettingsTimer");
      __publicField(this, "dailyTimer");
      /** How often the machine's own settings are read while connected. */
      __publicField(this, "machineSettingsMs");
      library.onWrite((list) => this.last.delete(list));
      this.machineSettingsMs = Math.max(MACHINE_SETTINGS_MS, pollMs);
      machine.onRunningNothing(() => {
        if (!this.stopped && this.outbox.connected && this.fromMachineWanted.size > 0) void this.run();
      });
    }
    start() {
      this.schedulePoll();
      this.scheduleMachineSettings();
      this.scheduleDaily();
    }
    stop() {
      this.stopped = true;
      if (this.pollTimer !== void 0) clearTimeout(this.pollTimer);
      if (this.machineSettingsTimer !== void 0) clearTimeout(this.machineSettingsTimer);
      if (this.dailyTimer !== void 0) clearTimeout(this.dailyTimer);
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
     * only on their interval. While the machine runs something, once it next
     * runs nothing.
     */
    readMachineSettings() {
      if (this.stopped || !this.outbox.connected) return;
      this.wantFromMachine(MACHINE_SETTINGS, false);
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
    /**
     * Reads the sensor calibration once a day has passed since the end of its
     * latest full or daily read, and sends it if it changed, once the machine
     * runs nothing. While disconnected, it waits for the next welcome, which
     * reads everything.
     */
    scheduleDaily() {
      if (this.dailyTimer !== void 0) clearTimeout(this.dailyTimer);
      this.dailyTimer = setTimeout(() => {
        this.dailyTimer = void 0;
        if (this.stopped) return;
        if (!this.outbox.connected) return this.scheduleDaily();
        this.wantFromMachine(DAILY, false);
        void this.run();
      }, DAILY_MS);
    }
    read(kind) {
      if (this.stopped) return;
      if (kind === "full" || this.wanted === void 0) this.wanted = kind;
      if (kind === "full") this.wantFromMachine(FROM_MACHINE, true);
      void this.run();
    }
    async run() {
      if (this.reading) return;
      this.reading = true;
      try {
        while ((this.wanted !== void 0 || this.recipesWanted || this.fromMachineDue()) && !this.stopped) {
          const full = this.wanted === "full";
          const polled = this.wanted !== void 0;
          const recipes = polled || this.recipesWanted;
          this.wanted = void 0;
          this.recipesWanted = false;
          const sentLists = /* @__PURE__ */ new Set();
          for (const source of SOURCES) {
            if (this.stopped) return;
            if (FROM_MACHINE.has(source.name)) {
              if (this.fromMachineWanted.has(source.name)) await this.settings.run(() => this.readFromMachine(source));
              continue;
            }
            if (!(source.name === "dye2Recipes" ? recipes : polled)) continue;
            const parent = isLibraryList(source.name) ? parentList(source.name) : void 0;
            if (SOFTWARE.has(source.name)) {
              if (!this.software.idle) {
                if (full) this.softwareOwedFull.add(source.name);
                continue;
              }
              const owed = this.softwareOwedFull.delete(source.name);
              if (await this.software.run(() => this.capture(source, full || owed))) sentLists.add(source.name);
              continue;
            }
            const sent = await (WRITTEN_LISTS.has(source.name) ? this.library.run(() => this.capture(source, full || parent !== void 0 && sentLists.has(parent))) : SETTINGS.has(source.name) ? this.settings.run(() => this.capture(source, full)) : this.capture(source, full));
            if (sent) sentLists.add(source.name);
          }
        }
      } finally {
        this.reading = false;
      }
    }
    /** Asks for reads from the machine, one of each however many are asked for, sent whatever they hold if `always` was among them. */
    wantFromMachine(names, always) {
      for (const name of names) this.fromMachineWanted.set(name, always || (this.fromMachineWanted.get(name) ?? false));
    }
    /** Whether a read from the machine is asked for that can run now, as the machine runs nothing. */
    fromMachineDue() {
      return this.fromMachineWanted.size > 0 && this.machine.runningNothing();
    }
    /**
     * Reads one of the collections Decaid reads from the machine, within
     * `SettingsAccess.run`, if it is asked for and the machine runs nothing,
     * decided as the read would begin: the pass may reach it long after it
     * began, behind the server's writes or a Settings Edit, so any read of it
     * asked for until then is this one. Otherwise the read keeps waiting, and
     * holds up neither the pass nor the Settings Edits.
     */
    async readFromMachine(source) {
      const always = this.fromMachineWanted.get(source.name);
      if (always === void 0 || this.stopped || !this.machine.runningNothing()) return;
      this.fromMachineWanted.delete(source.name);
      const interval = MACHINE_SETTINGS.has(source.name);
      const daily = DAILY.has(source.name);
      if (interval && this.machineSettingsTimer !== void 0) {
        clearTimeout(this.machineSettingsTimer);
        this.machineSettingsTimer = void 0;
      }
      if (daily && this.dailyTimer !== void 0) {
        clearTimeout(this.dailyTimer);
        this.dailyTimer = void 0;
      }
      await this.capture(source, always);
      if (interval && !this.stopped) this.scheduleMachineSettings();
      if (daily && !this.stopped) this.scheduleDaily();
    }
    /**
     * Queues a report of a settings collection a Settings Edit read, within
     * `SettingsAccess.run`: if it changed since the last one queued, or, when
     * `always`, whatever it holds, as an edit's read-back is, which names the
     * edit (`readBackOf`). The edit's answer follows it, so it is kept where it
     * is: a later report of the collection is queued after it rather than
     * superseding it, which would put the answer ahead of the read-back it
     * reports. A read of the machine's own settings counts for their interval.
     */
    reportSettings(name, reading, always, readBackOf) {
      if (this.stopped) return;
      this.queueReading(name, reading, always, readBackOf === void 0 ? void 0 : { settingsEditId: readBackOf });
      this.queued.delete(name);
      if (MACHINE_SETTINGS.has(name)) this.scheduleMachineSettings();
    }
    /**
     * Reads the plugin list and the plugins' settings, or Decaid's own update
     * state (`decaid`), within Software Actions' `SettingsAccess.run`, as a
     * Software Action does before and after it acts, and queues a report of each: if it
     * changed since the last one queued, or, for an action's read-back,
     * whatever it holds, naming the action (`readBackOf`), whose answer
     * follows it, so it is kept where it is, as a Settings Edit's is.
     * Resolves with the plugin list, or undefined where Decaid did not answer
     * with one.
     */
    async readSoftware(what, readBackOf) {
      const tag = readBackOf === void 0 ? void 0 : { softwareActionId: readBackOf };
      const report = async (name, reading) => {
        if (this.stopped) return;
        this.queueReading(name, reading, tag !== void 0, tag);
        this.queued.delete(name);
      };
      if (what === "decaid") {
        await report("decaidUpdate", await readCollection("/update", null));
        return void 0;
      }
      const plugins = await readCollection("/plugins", null);
      this.pluginList = plugins.kind === "value" ? plugins.value : void 0;
      await report("plugins", plugins);
      await report("pluginSettings", await readPluginSettings(this.pluginList));
      return Array.isArray(this.pluginList) ? this.pluginList : void 0;
    }
    /**
     * Decaid's Skins read now, within Software Actions' `SettingsAccess.run`,
     * as a Software Action on them does before and after it acts, and queued
     * as `readSoftware` queues the plugin list. Resolves with them as
     * reported, `{ skins, default, server }`, or undefined where Decaid did
     * not answer with them.
     */
    async readSoftwareSkins(readBackOf) {
      const reading = await readSkins();
      if (this.stopped) return void 0;
      this.queueReading("skins", reading, readBackOf !== void 0, readBackOf === void 0 ? void 0 : { softwareActionId: readBackOf });
      this.queued.delete("skins");
      return reading.kind === "value" && typeof reading.value === "object" && reading.value !== null ? reading.value : void 0;
    }
    /** Queues a report of the page a Skin just reported, if it is another than the last queued. */
    reportSkinPage() {
      if (this.stopped) return;
      this.queueReading("skinPage", this.skinPageReading(), false);
    }
    /**
     * The page a Skin last reported as a reading: unavailable until one
     * reports in this load, so the server keeps the page an earlier load
     * heard of, as the Skin's page did not change with the plugin's load.
     */
    skinPageReading() {
      const page = this.skinPage();
      return page === null ? { kind: "unavailable" } : { kind: "value", value: page, etag: null };
    }
    /**
     * The sensor calibration with one target read again, within
     * `SettingsAccess.run`, as a Settings Edit of it reads it: that read in
     * place of the target's last, beside the other targets as last read.
     * Where the last read was unavailable, every target is read again when
     * `readAll`, as after the edit's write, and otherwise there is none to
     * report, so the edit's check spends none of its time on reads.
     */
    async sensorCalibrationWith(target, read, readAll) {
      if (this.sensorCalibration === void 0) return readAll ? readSensorCalibration() : void 0;
      return { kind: "value", value: { ...this.sensorCalibration, [target]: read }, etag: null };
    }
    /** Reads a collection, and queues it if it is to be sent. Says whether a value was queued. */
    async capture(source, full) {
      const last = this.last.get(source.name);
      const reading = selected(
        source,
        await (source.name === "pluginSettings" ? readPluginSettings(this.pluginList) : source.name === "skinPage" ? Promise.resolve(this.skinPageReading()) : "read" in source ? source.read() : readCollection(source.path, full ? null : ifNoneMatch(last), isDye2List(source.name)))
      );
      if (this.stopped) return false;
      if (source.name === "plugins" && reading.kind !== "notModified") this.pluginList = reading.kind === "value" ? reading.value : void 0;
      if (source.name === PROFILES.name && reading.kind === "value") this.profileIds = profileIdsOf(reading.value);
      if (source.name === RECIPES2.name && reading.kind === "value") {
        this.sawRecipes(reading.value);
        if (namesUnreadProfile(reading.value, this.profileIds)) {
          await this.capture(PROFILES, false);
          if (this.stopped) return false;
        }
      }
      return this.queueReading(source.name, reading, full);
    }
    /**
     * Queues a collection read if it is to be sent: if it changed since the
     * last one queued, or whatever it holds when `full`. A value of one of the
     * UTC_OFFSET_COLLECTIONS goes with the tablet's UTC offset now, which is
     * compared with it, so a daylight saving change is sent too. A value an
     * edit or a Software Action read back names it (`readBackOf`). Says
     * whether a value was queued.
     */
    queueReading(name, reading, full, readBackOf) {
      if (name === "sensorCalibration" && reading.kind !== "notModified") this.sensorCalibration = reading.kind === "value" ? reading.value : void 0;
      const utcOffsetMinutes = reading.kind === "value" && hasUtcOffset(name) ? utcOffset() : void 0;
      const last = this.last.get(name);
      const compared = utcOffsetMinutes === void 0 || reading.kind !== "value" ? reading : { kind: "value", value: [reading.value, utcOffsetMinutes], etag: null };
      const decision = decide(last, compared, full);
      if (decision.next) this.last.set(name, decision.next);
      if (!decision.send || reading.kind === "notModified") return false;
      const id = this.outbox.nextId();
      const delivery = reading.kind === "value" ? {
        type: "collection",
        id,
        name,
        available: true,
        value: reading.value,
        ...this.placedInTime(name, reading.value),
        ...utcOffsetMinutes === void 0 ? {} : { utcOffsetMinutes },
        ...readBackOf ?? {}
      } : { type: "collection", id, name, available: false };
      const earlier = this.queued.get(name);
      if (earlier) {
        if (delivery.available || earlier.latest !== earlier.value) this.outbox.supersede(earlier.latest);
        if (delivery.available && earlier.value !== void 0 && earlier.value !== earlier.latest) this.outbox.supersede(earlier.value);
      }
      this.queued.set(name, { latest: id, value: delivery.available ? id : earlier?.value });
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
      return { updatedAt: value.map((record3) => utcTime(record3?.updatedAt)) };
    }
  };
  async function readSensorCalibration() {
    const value = {};
    for (const target of SENSOR_CALIBRATION_TARGETS) {
      const reading = await readCollection(`/machine/calibration/${target}`, null);
      if (reading.kind !== "value") return { kind: "unavailable" };
      value[target] = reading.value;
    }
    return { kind: "value", value, etag: null };
  }
  async function readPluginSettings(plugins) {
    if (!Array.isArray(plugins)) return { kind: "unavailable" };
    const value = {};
    for (const plugin of plugins) {
      const entry = typeof plugin === "object" && plugin !== null ? plugin : {};
      const declared = typeof entry.settings === "object" && entry.settings !== null ? Object.keys(entry.settings) : [];
      if (typeof entry.id !== "string" || entry.id === "" || declared.length === 0) continue;
      const reading = await readCollection(`/plugins/${encodeURIComponent(entry.id)}/settings`, null);
      if (reading.kind !== "value" || typeof reading.value !== "object" || Array.isArray(reading.value)) return { kind: "unavailable" };
      value[entry.id] = { declared, values: reading.value };
    }
    return { kind: "value", value, etag: null };
  }
  async function readSkins() {
    const skins = await readCollection("/webui/skins", null);
    if (skins.kind !== "value") return { kind: "unavailable" };
    const defaultSkin = Array.isArray(skins.value) && skins.value.length === 0 ? null : await readCollection("/webui/skins/default", null);
    if (defaultSkin !== null && defaultSkin.kind !== "value") return { kind: "unavailable" };
    const server = await readCollection("/webui/server/status", null);
    if (server.kind !== "value") return { kind: "unavailable" };
    return { kind: "value", value: { skins: skins.value, default: defaultSkin?.value ?? null, server: server.value }, etag: null };
  }
  function utcOffset() {
    return -(/* @__PURE__ */ new Date()).getTimezoneOffset() + 0;
  }
  function selected(source, reading) {
    if (reading.kind !== "value" || !source.select) return reading;
    const value = source.select(reading.value);
    return value === null ? { kind: "unavailable" } : { ...reading, value };
  }
  function profileIdsOf(value) {
    if (!Array.isArray(value)) return void 0;
    return new Set(value.flatMap((entry) => typeof entry === "object" && entry !== null && typeof entry.id === "string" ? [entry.id] : []));
  }
  function namesUnreadProfile(value, known) {
    const records = dye2Records(value) ?? [];
    return records.some((record3) => typeof record3.profileId === "string" && record3.profileId !== "" && (known === void 0 || !known.has(record3.profileId)));
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
    const parsed6 = parse(value);
    const first = parsed6?.first;
    const next = parsed6?.next;
    if (!isCount(first) || !isCount(next) || first > next || next - first > MAX_KEPT) return { first: 0, next: 0 };
    return { first, next, token: typeof parsed6?.token === "string" ? parsed6.token : "" };
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
    const parsed6 = parse(value);
    if (parsed6?.seq !== seq || parsed6.delivery === void 0) return void 0;
    const decoded = decodeMachineEvent(JSON.stringify(parsed6.delivery));
    return decoded.ok ? decoded.message : void 0;
  }
  function parse(value) {
    if (typeof value !== "string") return void 0;
    try {
      const parsed6 = JSON.parse(value);
      return typeof parsed6 === "object" && parsed6 !== null && !Array.isArray(parsed6) ? parsed6 : void 0;
    } catch {
      return void 0;
    }
  }
  function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  // src/live-view.ts
  var LIVE_ACTIVITIES = /* @__PURE__ */ new Set(["espresso", "steam", "hotWater", "flush"]);
  var LIVE_INTERVAL_MS = 1e3;
  var TimeInState = class {
    constructor() {
      __publicField(this, "name");
      __publicField(this, "since");
      __publicField(this, "state");
    }
    /**
     * Takes in a machine snapshot the plugin received at `at`, in UTC. Says
     * when its Machine State's name began, and whether it began with this
     * snapshot; undefined while no snapshot has reported a state.
     */
    observe(snapshot, at) {
      const named = machineStateOf(snapshot);
      let changed = false;
      if (named) {
        this.state = named.state;
        if (named.name !== this.name) {
          this.name = named.name;
          this.since = at;
          changed = true;
        }
      }
      return this.since === void 0 ? void 0 : { since: this.since, changed };
    }
    /** Decaid's state in the latest snapshot that reported one, such as espresso. */
    latestState() {
      return this.state;
    }
  };
  var LiveRate = class {
    constructor(forward) {
      __publicField(this, "forward", forward);
      /** For each source that forwarded a frame within LIVE_INTERVAL_MS, its timer, and the frame it holds. */
      __publicField(this, "gates", /* @__PURE__ */ new Map());
    }
    offer(source, frame, { now: now2 }) {
      const gate = this.gates.get(source);
      if (gate && !now2) {
        gate.held = frame;
        return;
      }
      if (gate) clearTimeout(gate.timer);
      this.send(source, frame);
    }
    /** Drops every frame held, as streaming stops. */
    clear() {
      for (const gate of this.gates.values()) clearTimeout(gate.timer);
      this.gates.clear();
    }
    send(source, frame) {
      this.gates.set(source, {
        timer: setTimeout(() => {
          const held = this.gates.get(source)?.held;
          this.gates.delete(source);
          if (held !== void 0) this.send(source, held);
        }, LIVE_INTERVAL_MS)
      });
      this.forward(frame);
    }
  };
  var LIVE_BUDGET_BYTES = 64 * 1024;
  var LiveBudget = class {
    constructor(send) {
      __publicField(this, "send", send);
      /** The bytes of live frames sent on the connection, less those Decaid refused. */
      __publicField(this, "sent", 0);
      /** The bytes of them the server has said it received. */
      __publicField(this, "receivedBytes", 0);
      /** The frames held, the latest of each source, in the order they came. */
      __publicField(this, "held", /* @__PURE__ */ new Map());
    }
    /** Sends the frame, of `bytes` as sent, or holds it as its source's latest. */
    offer(source, frame, bytes) {
      if (this.held.size === 0 && this.fits(bytes)) return this.forward(frame, bytes);
      this.held.delete(source);
      this.held.set(source, { frame, bytes });
    }
    /** The server's `liveReceived`: the bytes of live frames it has received on the connection, in all. */
    received(bytes) {
      this.receivedBytes = Math.max(this.receivedBytes, bytes);
      this.release();
    }
    /** Drops the frames it holds, as streaming stops. What was sent stays counted until the server receives it. */
    clear() {
      this.held.clear();
    }
    fits(bytes) {
      return this.sent - this.receivedBytes + bytes <= LIVE_BUDGET_BYTES;
    }
    /** Sends what is held, in order, while it fits. */
    release() {
      for (const [source, { frame, bytes }] of this.held) {
        if (!this.fits(bytes)) return;
        this.held.delete(source);
        this.forward(frame, bytes);
      }
    }
    forward(frame, bytes) {
      this.sent += bytes;
      this.send(frame).catch(() => {
        this.sent -= bytes;
        this.release();
      });
    }
  };
  var LIVE_SOCKETS = {
    waterLevels: "ws://localhost:8080/ws/v1/machine/waterLevels",
    scale: "ws://localhost:8080/ws/v1/scale/snapshot",
    shotSettings: "ws://localhost:8080/ws/v1/machine/shotSettings",
    devices: "ws://localhost:8080/ws/v1/devices"
  };
  var SOCKET_SOURCES = Object.keys(LIVE_SOCKETS);
  function sensorSocket(sensorId) {
    return `ws://localhost:8080/ws/v1/sensors/${encodeURIComponent(sensorId)}/snapshot`;
  }
  var LIVE_SOCKET_RETRY_MS = 5e3;
  var LiveSockets = class {
    constructor(transports, findMilkProbe2, received) {
      __publicField(this, "transports", transports);
      __publicField(this, "findMilkProbe", findMilkProbe2);
      __publicField(this, "received", received);
      __publicField(this, "wanted", false);
      /** Bumped by every close, so an open that ends after it is closed at once. */
      __publicField(this, "generation", 0);
      __publicField(this, "handles", /* @__PURE__ */ new Map());
      __publicField(this, "opening", /* @__PURE__ */ new Set());
      __publicField(this, "retry");
      /** The sockets wanted while open: LIVE_SOCKETS', and on a Bengle its milk probe's. */
      __publicField(this, "sockets", SOCKET_SOURCES);
    }
    /** Opens each socket not open or opening, the milk probe's only where the machine is a Bengle, as only a Bengle has one. */
    open({ bengle }) {
      this.wanted = true;
      this.sockets = bengle ? [...SOCKET_SOURCES, "sensor"] : SOCKET_SOURCES;
      for (const socket of this.sockets) this.openSocket(socket);
    }
    /** Closes every socket, and one still opening once it opens. */
    close() {
      this.wanted = false;
      this.generation++;
      if (this.retry !== void 0) clearTimeout(this.retry);
      this.retry = void 0;
      this.opening.clear();
      for (const handle of this.handles.values()) this.transports.close(handle);
      this.handles.clear();
    }
    openSocket(socket) {
      if (!this.wanted || this.handles.has(socket) || this.opening.has(socket)) return;
      const generation = this.generation;
      this.opening.add(socket);
      if (socket !== "sensor") return this.connect(socket, LIVE_SOCKETS[socket], generation);
      void this.findMilkProbe().then((sensorId) => {
        if (generation !== this.generation) return;
        if (sensorId === null) return this.failed(socket);
        this.connect(socket, sensorSocket(sensorId), generation, sensorId);
      });
    }
    connect(socket, url, generation, sensorId) {
      this.transports.open(url).then(
        (handle) => {
          if (generation !== this.generation) return void this.transports.close(handle);
          this.opening.delete(socket);
          this.handles.set(socket, handle);
          this.transports.onEvent(handle, (event) => {
            if (this.handles.get(socket) !== handle) return;
            if (event.type !== "data") {
              this.handles.delete(socket);
              this.transports.close(handle);
              this.retryLater();
            } else if (event.dataType === "text") {
              this.received(socket, event.data, sensorId);
            }
          });
        },
        () => {
          if (generation === this.generation) this.failed(socket);
        }
      );
    }
    /** A socket that couldn't open, or a probe not listed, tried again later. */
    failed(socket) {
      this.opening.delete(socket);
      this.retryLater();
    }
    retryLater() {
      if (this.retry !== void 0) return;
      this.retry = setTimeout(() => {
        this.retry = void 0;
        for (const socket of this.sockets) this.openSocket(socket);
      }, LIVE_SOCKET_RETRY_MS);
    }
  };
  var LiveView = class {
    constructor(log, transports, findMilkProbe2) {
      __publicField(this, "log", log);
      /** Sends on the connection streaming, while one is. */
      __publicField(this, "streaming");
      __publicField(this, "timeInState", new TimeInState());
      __publicField(this, "rate", new LiveRate((frame) => this.send(frame)));
      /** The live budget of the connection, which the next connection starts afresh. */
      __publicField(this, "budget", this.newBudget());
      /** Set once a frame too large to relay was dropped while streaming, so the log says so once a stream. */
      __publicField(this, "droppedLarge", false);
      __publicField(this, "sockets");
      this.sockets = new LiveSockets(transports, findMilkProbe2, (source, text, sensorId) => this.socketFrame(source, text, sensorId));
    }
    /**
     * The server's `liveStart`: streams on the connection given, opening
     * Decaid's sockets, a milk probe's too where the connection's machine is a
     * Bengle, unless already streaming.
     */
    start(send, { bengle }) {
      if (this.streaming) return;
      this.streaming = send;
      this.droppedLarge = false;
      this.sockets.open({ bengle });
    }
    /**
     * The server's `liveStop`: closes Decaid's sockets and drops the frames
     * held. The bytes the server has yet to receive stay counted, as it may
     * start the same connection again.
     */
    stop() {
      this.streaming = void 0;
      this.sockets.close();
      this.rate.clear();
      this.budget.clear();
    }
    /** The end of the connection, streaming or not: the next connection's budget starts afresh. */
    disconnected() {
      this.stop();
      this.budget = this.newBudget();
    }
    /** The server's `liveReceived`: the bytes of live frames it has received on this connection, in all. */
    received(bytes) {
      this.budget.received(bytes);
    }
    /** Decaid's `stateUpdate`: the machine snapshot, several times a second while a machine is connected. */
    stateUpdate(payload) {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
      const receivedAt = (/* @__PURE__ */ new Date()).toISOString();
      const named = this.timeInState.observe(payload, receivedAt);
      if (!this.streaming || !named) return;
      const frame = { type: "liveFrame", source: "machine", receivedAt, stateSince: named.since, frame: payload };
      this.rate.offer("machine", frame, { now: this.inActivity() || named.changed });
    }
    /** A text frame one of Decaid's sockets sent, a sensor's with its id: forwarded as it is, if a JSON object. */
    socketFrame(source, text, sensorId) {
      if (!this.streaming) return;
      const receivedAt = (/* @__PURE__ */ new Date()).toISOString();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
      const frame = { type: "liveFrame", source, ...sensorId !== void 0 ? { sensorId } : {}, receivedAt, frame: payload };
      this.rate.offer(liveSourceOf(frame), frame, { now: this.inActivity() });
    }
    /** Whether the latest machine snapshot reported an activity (LIVE_ACTIVITIES), during which every frame goes. */
    inActivity() {
      return LIVE_ACTIVITIES.has(this.timeInState.latestState() ?? "");
    }
    send(frame) {
      if (!this.streaming) return;
      if (!liveFrameFits(frame)) {
        if (!this.droppedLarge) this.log(`Dropped a ${frame.source} frame too large to relay to the Live View; any more are dropped too.`);
        this.droppedLarge = true;
        return;
      }
      this.budget.offer(liveSourceOf(frame), frame, utf8Length(encode(frame)));
    }
    newBudget() {
      return new LiveBudget((frame) => this.streaming ? this.streaming(frame) : Promise.reject(new Error("Not streaming")));
    }
  };

  // src/machine-activity.ts
  var MachineActivity = class {
    constructor(shot) {
      __publicField(this, "shot", shot);
      __publicField(this, "latest");
      /** Whether it ran nothing as last judged, so only a turn to running nothing is told. */
      __publicField(this, "wasRunningNothing", true);
      __publicField(this, "listeners", /* @__PURE__ */ new Set());
      shot.onEnd(() => this.judge());
    }
    runningNothing() {
      return (this.latest === void 0 || SETTINGS_EDIT_STATES.includes(this.latest)) && !this.shot.running();
    }
    /** Decaid's `stateUpdate`, with the machine's state, after the `ShotGate` is told of it. */
    state(state) {
      this.latest = state;
      this.judge();
    }
    /** Calls `listener` each time the machine turns to running nothing. */
    onRunningNothing(listener) {
      this.listeners.add(listener);
    }
    judge() {
      const now2 = this.runningNothing();
      const turned = now2 && !this.wasRunningNothing;
      this.wasRunningNothing = now2;
      if (turned) for (const listener of this.listeners) listener();
    }
  };

  // src/machine-events.ts
  var MachineEvents = class {
    constructor(outbox, observe = () => {
    }, machineSettingsChanged = () => {
    }, stateReported = () => {
    }) {
      __publicField(this, "outbox", outbox);
      __publicField(this, "observe", observe);
      __publicField(this, "machineSettingsChanged", machineSettingsChanged);
      __publicField(this, "stateReported", stateReported);
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
      /**
       * The first of the plugin's writes into the Workflow that Decaid took
       * while held, whose change `release` sends as the plugin's: Decaid
       * reports a write's change before it answers it, so that change is held
       * already, with any change another writer made meanwhile.
       */
      __publicField(this, "heldWrite");
      /**
       * When Decaid reported the Workflow first naming the recipe it names now
       * (`dye2RecipeIdOf`), where that was while held: `release` sends it as the
       * delivery's `recipeNamedAt`, as a later report meanwhile, such as the
       * plugin's own write's, gives the delivery its `observedAt`.
       */
      __publicField(this, "heldNamedAt");
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
        if (previous === void 0 || dye2RecipeIdOf(previous) !== dye2RecipeIdOf(workflow)) this.heldNamedAt = this.reportedAt;
        this.heldChange = true;
        this.heldReport = true;
      } else this.queueWorkflow(workflow);
      if (previous && machineSettingsDiffer(previous, workflow)) this.machineSettingsChanged();
    }
    /** Holds back the Workflow's changes, as one of the plugin's writes into it begins. */
    hold() {
      this.holds++;
    }
    wrote(write) {
      if (this.holds > 0) this.heldWrite ?? (this.heldWrite = write);
    }
    /**
     * Once no write is under way, sends the latest Workflow, observed when
     * Decaid reported it, or now for a resend alone, if it changed while held:
     * that holds the plugin's own writes, and any change a barista made
     * meanwhile. Where the recipe it names changed while held, it says when
     * Decaid first reported it naming that one (`recipeNamedAt`), and where
     * Decaid took a write of the plugin's meanwhile, that it is the plugin's
     * change (`cause`).
     */
    release() {
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds > 0) return;
      const write = this.heldReport ? this.heldWrite : void 0;
      this.heldWrite = void 0;
      if (this.heldChange && this.workflow) {
        this.heldChange = false;
        const resend = this.heldResend && !this.heldReport;
        const id = this.queueWorkflow(this.workflow, resend ? now() : this.reportedAt, this.heldNamedAt, write);
        if (resend) this.resent = id;
        this.heldResend = false;
        this.heldReport = false;
        this.heldNamedAt = void 0;
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
      if (this.state?.state !== state || this.state.substate !== substate) {
        this.state = { state, substate };
        this.outbox.enqueue({ type: "machineState", id: this.outbox.nextId(), observedAt: now(), state, substate });
      }
      this.stateReported(state);
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
    /** Queues the Workflow as observed now, the plugin's change where one of its writes made it, returning its delivery's id. */
    queueWorkflow(workflow, observedAt = now(), recipeNamedAt, write) {
      const delivery = {
        type: "workflow",
        id: this.outbox.nextId(),
        observedAt,
        workflow,
        ...this.absent ? { dye2Absent: true } : {},
        ...recipeNamedAt !== void 0 ? { recipeNamedAt } : {},
        ...write !== void 0 ? { cause: "plugin", pluginWrite: write } : { cause: "other" }
      };
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

  // src/shot-gate.ts
  var SHOT_STORED_WITHIN_MS = 1e4;
  var MACHINE_GONE_AFTER_MS = 3e3;
  var ShotGate = class {
    constructor() {
      __publicField(this, "pulling", false);
      /** Set from the state leaving espresso until Decaid stores the Shot, or SHOT_STORED_WITHIN_MS have passed. */
      __publicField(this, "storing");
      /** Those waiting for the Shot to end (`ended`). */
      __publicField(this, "waiting", /* @__PURE__ */ new Set());
      /** Told each time a Shot ends (`onEnd`). */
      __publicField(this, "ends", /* @__PURE__ */ new Set());
      __publicField(this, "stopped", false);
      /** When Decaid last reported the machine's state, by the tablet's clock. */
      __publicField(this, "reportedAt", Number.NEGATIVE_INFINITY);
    }
    /** Whether a Shot is being pulled, or is yet to be stored. */
    running() {
      return this.pulling || this.storing !== void 0;
    }
    /** Decaid's `stateUpdate`, with the machine's state. */
    state(state) {
      this.reportedAt = Date.now();
      if (state === SHOT_STATE) {
        this.pulling = true;
        this.clearStoring();
        return;
      }
      if (!this.pulling) return;
      this.pulling = false;
      this.storing = setTimeout(() => this.end(), SHOT_STORED_WITHIN_MS);
    }
    /** Decaid stored a Shot (`shotStored`). */
    shotStored() {
      if (this.storing !== void 0) this.end();
    }
    /** A read found no machine connected, so no Shot is pulled, unless Decaid reported its state just now. */
    machineGone() {
      if (this.running() && Date.now() - this.reportedAt >= MACHINE_GONE_AFTER_MS) this.end();
    }
    /**
     * Resolves once no Shot is being pulled, or after `withinMs`, or as the
     * plugin stops: whether it stopped.
     */
    ended(withinMs) {
      if (!this.running() || this.stopped) return Promise.resolve(this.stopped);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiting.delete(done);
          resolve(this.stopped);
        };
        const timer = setTimeout(done, withinMs);
        this.waiting.add(done);
      });
    }
    /** Calls `listener` each time a Shot ends. */
    onEnd(listener) {
      this.ends.add(listener);
    }
    stop() {
      this.stopped = true;
      this.clearStoring();
      for (const done of [...this.waiting]) done();
    }
    /** The Shot ended: whatever waits for it goes on. */
    end() {
      this.pulling = false;
      this.clearStoring();
      for (const done of [...this.waiting]) done();
      for (const listener of this.ends) listener();
    }
    clearStoring() {
      if (this.storing !== void 0) clearTimeout(this.storing);
      this.storing = void 0;
    }
  };

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
      /** The requested records new on the tablet (`first`), by key, until each is read or its read fails. */
      __publicField(this, "fresh", /* @__PURE__ */ new Set());
      /** The waits for what the outbox held as each began, on this connection. */
      __publicField(this, "waits", /* @__PURE__ */ new Set());
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
      const waits = [...this.waits];
      this.waits.clear();
      for (const wait of waits) wait.done(false);
    }
    /**
     * Calls `done` with true once the server has acknowledged what the outbox
     * holds now: every delivery queued, and every record new on the tablet
     * still to be read, such as a Shot Decaid just stored. So what is sent
     * then follows them, as a request about a Shot follows that Shot's
     * delivery (ADR-0030). The records the server asked for to fill in its
     * history are not waited for, as there may be thousands, nor is a new
     * record once its read has failed, which is tried again after those. Calls it with
     * false if the connection closes first, or at once while none is sending,
     * or while the deliveries earlier loads kept are still to be read back,
     * which are not yet known to wait for. Returns a function that gives the
     * wait up, after which `done` is not called.
     */
    whenDelivered(done) {
      if (!this.sendMessage || this.restoring) {
        done(false);
        return () => {
        };
      }
      const wait = { deliveries: new Set(this.queued.keys()), records: new Set(this.fresh), done };
      this.waits.add(wait);
      this.settleWaits();
      return () => void this.waits.delete(wait);
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
      return [...this.requested.values()].filter((record3) => record3.kind === kind).map((record3) => record3.id);
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
        const keys = new Set(records.map(([key2]) => key2));
        for (const key2 of keys) this.fresh.add(key2);
        const others = [...this.requested].filter(([key2]) => !keys.has(key2));
        this.requested.clear();
        for (const [key2, record3] of [...records, ...others]) this.requested.set(key2, record3);
      } else {
        for (const [key2, record3] of records) this.requested.set(key2, record3);
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
        const [key2, record3] = this.requested.entries().next().value;
        let delivery;
        try {
          delivery = await this.readers[record3.kind](record3.id, this.nextId());
        } catch {
          this.requested.delete(key2);
          this.requested.set(key2, record3);
          this.noLongerFresh(key2, void 0);
          this.log(`Could not read ${RECORD_NAMES[record3.kind]} ${record3.id} from Decaid; retrying it after the other requested records.`);
          this.retry();
          return;
        }
        if (this.stopped) return;
        this.requested.delete(key2);
        if (delivery) {
          this.queued.set(delivery.id, delivery);
          for (const watcher of this.watchers) watcher(delivery);
        }
        this.noLongerFresh(key2, delivery?.id);
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
        this.noLongerQueued(id);
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
      this.noLongerQueued(id);
    }
    /**
     * A record new on the tablet is no longer one about to be read: it was
     * read, as the delivery with this id or as gone from the tablet, or it
     * could not be read, and is tried again after every other record
     * requested. A wait for it is now one for its delivery, or for nothing
     * more of it, so a record that can't be read holds back nothing.
     */
    noLongerFresh(key2, deliveryId) {
      this.fresh.delete(key2);
      for (const wait of this.waits) if (wait.records.delete(key2) && deliveryId !== void 0) wait.deliveries.add(deliveryId);
      this.settleWaits();
    }
    /** A delivery left the queue, acknowledged or dropped: no wait is for it any longer. */
    noLongerQueued(id) {
      for (const wait of this.waits) wait.deliveries.delete(id);
      this.settleWaits();
    }
    /** Ends each wait left with nothing to wait for. */
    settleWaits() {
      for (const wait of [...this.waits]) {
        if (wait.deliveries.size > 0 || wait.records.size > 0) continue;
        this.waits.delete(wait);
        wait.done(true);
      }
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
  var UNCONFIRMED = /* @__PURE__ */ new Set(["request", "chunkReceived", "shotEdited"]);
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
      const id = "id" in message && !UNCONFIRMED.has(message.type) ? message.id : void 0;
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

  // src/settings-edits.ts
  var ROUTES2 = {
    machineSettings: "/machine/settings",
    advancedSettings: "/machine/settings/advanced",
    machineCalibration: "/machine/calibration",
    appSettings: "/settings",
    presenceSettings: "/presence/settings"
  };
  var WITHOUT_MACHINE = /* @__PURE__ */ new Set(["appSettings", "presenceSettings"]);
  var SettingsAccess = class {
    constructor() {
      __publicField(this, "queue", Promise.resolve());
      __publicField(this, "waiting", 0);
    }
    /** Runs `work` once everything asked for before it is done, and resolves or rejects as it does. */
    run(work) {
      this.waiting++;
      const done = this.queue.then(work).finally(() => this.waiting--);
      this.queue = done.catch(() => {
      });
      return done;
    }
    /** Whether nothing asked for is running or waiting its turn. */
    get idle() {
      return this.waiting === 0;
    }
  };
  var SettingsEdits = class {
    constructor(access, outbox, reports, log) {
      __publicField(this, "access", access);
      __publicField(this, "outbox", outbox);
      __publicField(this, "reports", reports);
      __publicField(this, "log", log);
      __publicField(this, "stopped", false);
    }
    /**
     * Carries out an edit once the reads and edits before it are done, and
     * queues its answer. `connected` says whether the connection it arrived
     * on is still open. It never rejects.
     */
    apply(edit, connected) {
      const startBy = edit.timeLeftMs - SETTINGS_EDIT_WRITE_MARGIN_MS;
      const writeBy = Date.now() + startBy;
      let outOfTime = startBy < 0;
      const timer = setTimeout(() => outOfTime = true, Math.max(0, startBy));
      const tooLate = () => outOfTime || !connected() || Date.now() > writeBy;
      return this.access.run(async () => {
        try {
          if (this.stopped) return;
          let answer;
          try {
            answer = await this.carryOut(edit, tooLate);
          } catch (error) {
            answer = refusedByDecaid(edit, null, `Decaid did not answer: ${describe(error)}`);
          }
          if (answer === void 0 || this.stopped) return;
          if (answer.outcome === "refused") this.log(`Did not carry out Settings Edit ${edit.id}: ${describeRefusal(answer)}`);
          this.outbox.enqueue(answer);
        } finally {
          clearTimeout(timer);
        }
      });
    }
    /** Drops the edits still waiting their turn, and starts no write after this, as the plugin unloads. */
    stop() {
      this.stopped = true;
    }
    /** The edit's answer, or undefined where the plugin unloaded before its write. */
    async carryOut(edit, tooLate) {
      if (tooLate()) return expired(edit);
      if (!isEditableSettingsCollection(edit.collection)) return refusedByDecaid(edit, null, `This plugin does not write ${edit.collection}`);
      const refusals = validateSettingsEdit(edit, "admin");
      if (refusals.length > 0) return refusedByDecaid(edit, null, `${NOT_WRITTEN}${refusals.map((refusal2) => settingsRefusalText(edit.collection, refusal2)).join("; ")}`);
      const state = await request("GET", "/machine/state");
      if (state.ok) {
        const machineState = stateOf(state.text);
        if (machineState === null) return refusedByDecaid(edit, state.status, "Decaid's answer names no machine state");
        if (!SETTINGS_EDIT_STATES.includes(machineState)) {
          return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "machineBusy", state: machineState };
        }
      } else if (!(WITHOUT_MACHINE.has(edit.collection) && machineMissing(state))) {
        return refusedByDecaid(edit, state.status, decaidMessage(state));
      }
      if (edit.collection === "sensorCalibration") return this.setSensorCalibration(edit, tooLate);
      if (edit.schedule) return this.editSchedule(edit, edit.schedule, tooLate);
      const route = ROUTES2[edit.collection];
      const before = await readObject(route);
      if (!before.ok) return refusedByDecaid(edit, before.answer.status, decaidMessage(before.answer));
      this.reports.reportSettings(edit.collection, { kind: "value", value: before.value, etag: null }, false);
      if (Object.keys(edit.fields).some((field) => !sameValue(before.value[field], edit.expected[field]))) return changedSince(edit, edited(edit, before.value));
      if (this.stopped) return void 0;
      if (tooLate()) return expired(edit);
      let written2;
      let failure = "";
      try {
        written2 = await writeFields(edit.collection, route, edit.fields);
      } catch (error) {
        failure = describe(error);
      }
      const after = await readObject(route).catch(() => void 0);
      this.reports.reportSettings(edit.collection, after?.ok ? { kind: "value", value: after.value, etag: null } : { kind: "unavailable" }, true, edit.id);
      return answered(edit, written2, failure, after?.ok ? edited(edit, after.value) : void 0);
    }
    /**
     * Sets the one sensor target an edit names (`validateSettingsEdit`) to
     * its value, from one read of the target: the changed-since check compares
     * that read's current value C, its `measuredValue`, with what the edit
     * expected, and the write sends C as `de1ReportedValue` (`absoluteSet`).
     * Each read of the target is reported within the sensor calibration
     * (`SettingsReports.sensorCalibrationWith`): the one before the write only
     * beside the other targets as last read, so no other read delays the
     * write, and the read-back with all three read again where they were
     * unavailable.
     */
    async setSensorCalibration(edit, tooLate) {
      const target = Object.keys(edit.fields)[0];
      const route = `/machine/calibration/${target}`;
      const before = await readObject(route);
      if (!before.ok) return refusedByDecaid(edit, before.answer.status, decaidMessage(before.answer));
      const checked = await this.reports.sensorCalibrationWith(target, before.value, false);
      if (checked) this.reports.reportSettings("sensorCalibration", checked, false);
      const current = before.value.measuredValue;
      if (!sameValue(current, edit.expected[target])) {
        return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "changedSince", values: calibrated(target, before.value) };
      }
      const correction = absoluteSet(target, current, edit.fields[target]);
      if ("refused" in correction) return refusedByDecaid(edit, null, correction.refused);
      if (this.stopped) return void 0;
      if (tooLate()) return expired(edit);
      let written2;
      let failure = "";
      try {
        written2 = await request("PUT", route, correction.body);
      } catch (error) {
        failure = describe(error);
      }
      const after = await readObject(route).catch(() => void 0);
      const readBack = after?.ok ? await this.reports.sensorCalibrationWith(target, after.value, true) : void 0;
      this.reports.reportSettings("sensorCalibration", readBack ?? { kind: "unavailable" }, true, edit.id);
      return answered(edit, written2, failure, after?.ok ? calibrated(target, after.value) : void 0);
    }
    /**
     * Adds, changes or deletes the one wake schedule an edit names, through
     * Decaid's presence routes. A change or a delete goes ahead only while the
     * presence settings, read and reported first, hold the schedule as the
     * edit expected it, whole, and is refused as `changedSince` with the
     * schedule as held, or with none where it is gone; Decaid answering the
     * write 404 says it went since, and refuses it the same way. An add
     * expects nothing. Then the presence settings are read again and reported,
     * and the answer carries the schedule as read back, by the id the edit
     * names or Decaid gave the new one (`scheduleId`).
     */
    async editSchedule(edit, schedule, tooLate) {
      const route = ROUTES2.presenceSettings;
      if (schedule.action !== "add") {
        const before = await readObject(route);
        if (!before.ok) return refusedByDecaid(edit, before.answer.status, decaidMessage(before.answer));
        this.reports.reportSettings("presenceSettings", { kind: "value", value: before.value, etag: null }, false);
        const held2 = scheduleIn(before.value, schedule.id);
        if (!sameValue(held2, edit.expected)) return changedSince(edit, held2 ? scheduleValues(held2) : {});
      }
      if (this.stopped) return void 0;
      if (tooLate()) return expired(edit);
      let written2;
      let failure = "";
      try {
        const path = schedule.action === "add" ? "/presence/schedules" : `/presence/schedules/${encodeURIComponent(schedule.id)}`;
        if (schedule.action === "add") written2 = await request("POST", path, edit.fields);
        else if (schedule.action === "change") written2 = await request("PUT", path, edit.fields);
        else written2 = await request("DELETE", path);
      } catch (error) {
        failure = describe(error);
      }
      const id = schedule.action === "add" ? written2?.ok ? addedId(written2.text) : void 0 : schedule.id;
      const after = await readObject(route).catch(() => void 0);
      const gone = schedule.action !== "add" && written2?.status === 404;
      this.reports.reportSettings("presenceSettings", after?.ok ? { kind: "value", value: after.value, etag: null } : { kind: "unavailable" }, true, gone ? void 0 : edit.id);
      const held = after?.ok && id !== void 0 ? scheduleIn(after.value, id) : void 0;
      const readBack = after?.ok && id !== void 0 ? held ? scheduleValues(held) : {} : void 0;
      if (gone) return changedSince(edit, readBack);
      const answer = answered(edit, written2, failure, readBack);
      return answer.outcome === "written" && id !== void 0 && schedule.action === "add" ? { ...answer, scheduleId: id } : answer;
    }
  };
  function scheduleIn(presence, id) {
    const schedules = Array.isArray(presence.schedules) ? presence.schedules : [];
    return schedules.find((schedule) => isObject7(schedule) && schedule.id === id);
  }
  function scheduleValues(schedule) {
    return { ...schedule, keepAwakeFor: schedule.keepAwakeFor ?? null };
  }
  function addedId(text) {
    const body = parsed4(text);
    return isObject7(body) && typeof body.id === "string" && body.id !== "" ? body.id : void 0;
  }
  function changedSince(edit, values) {
    return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "changedSince", ...values ? { values } : {} };
  }
  function answered(edit, written2, failure, readBack) {
    const values = readBack ? { values: readBack } : {};
    if (written2?.ok) return { type: "settingsEdited", id: edit.id, outcome: "written", ...values };
    return { ...refusedByDecaid(edit, written2?.status ?? null, written2 ? decaidMessage(written2) : `Decaid did not answer: ${failure}`), ...values };
  }
  async function readObject(route) {
    const answer = await request("GET", route);
    const value = answer.ok ? parsed4(answer.text) : void 0;
    if (isObject7(value)) return { ok: true, value };
    return { ok: false, answer: answer.ok ? { ...answer, text: "Decaid's answer is not an object" } : answer };
  }
  async function writeFields(collection, route, fields) {
    if (collection !== "appSettings" || !(UPDATE_CHECKS in fields)) return request("POST", route, fields);
    const { [UPDATE_CHECKS]: checks, ...rest } = fields;
    const managed = await manage("POST", route, { [UPDATE_CHECKS]: checks });
    return !managed.ok || Object.keys(rest).length === 0 ? managed : request("POST", route, rest);
  }
  var UPDATE_CHECKS = "automaticUpdateCheck";
  function calibrated(target, read) {
    return "measuredValue" in read ? { [target]: read.measuredValue } : {};
  }
  function edited(edit, value) {
    return Object.fromEntries(Object.keys(edit.fields).filter((field) => field in value).map((field) => [field, value[field]]));
  }
  function expired(edit) {
    return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "expired" };
  }
  function refusedByDecaid(edit, status, message) {
    return { type: "settingsEdited", id: edit.id, outcome: "refused", reason: "decaid", status, message: message.slice(0, MAX_REFUSAL_LENGTH) };
  }
  function stateOf(text) {
    const snapshot = parsed4(text);
    const state = isObject7(snapshot) && isObject7(snapshot.state) ? snapshot.state.state : void 0;
    return typeof state === "string" && state !== "" ? state : null;
  }
  function decaidMessage(answer) {
    const body = parsed4(answer.text);
    const said = isObject7(body) ? [body.error, body.message].filter((part) => typeof part === "string" && part !== "") : [];
    if (said.length > 0) return said.join(": ");
    return answer.text === "" ? `Decaid answered ${answer.status}` : answer.text;
  }
  function describeRefusal(answer) {
    switch (answer.reason) {
      case "machineBusy":
        return `the machine is ${answer.state}`;
      case "changedSince":
        return "a setting changed on the tablet since the report it was made over";
      case "expired":
        return "it came too late to write in time, or its connection closed";
      case "decaid":
        return `${answer.status === null ? "" : `Decaid answered ${answer.status}: `}${answer.message}`;
      default:
        return String(answer.reason);
    }
  }
  function parsed4(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject7(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/software-actions.ts
  var UPDATE_SOCKET = "ws://localhost:8080/ws/v1/update";
  var UPDATE_CHECK_MS = 45e3;
  var UPDATE_START_MS = 95e3;
  var SERVING_WATCH_MS = 5e3;
  var SERVING_STEP_MS = 500;
  var PENDING_KEY = "softwareAction";
  var PENDING_MS = 10 * 6e4;
  var WATCH_STEP_MS = 3e3;
  var RESUME_WATCH_MS = 3e4;
  var SoftwareActions = class {
    constructor(access, outbox, reports, storage, transports, log, pages) {
      __publicField(this, "access", access);
      __publicField(this, "outbox", outbox);
      __publicField(this, "reports", reports);
      __publicField(this, "storage", storage);
      __publicField(this, "transports", transports);
      __publicField(this, "log", log);
      __publicField(this, "pages", pages);
      __publicField(this, "stopped", false);
    }
    /**
     * Carries out an action once the reads, edits and actions before it are
     * done, and queues its answer. `connected` says whether the connection it
     * arrived on is still open. It never rejects.
     */
    apply(action, connected) {
      const startBy = action.timeLeftMs - SOFTWARE_ACTION_START_MARGIN_MS;
      const startByTime = Date.now() + startBy;
      const endTime = Date.now() + action.timeLeftMs;
      let outOfTime = startBy < 0;
      const timer = setTimeout(() => outOfTime = true, Math.max(0, startBy));
      const tooLate = () => outOfTime || !connected() || Date.now() > startByTime;
      return this.access.run(async () => {
        try {
          if (this.stopped) return;
          let answer;
          try {
            answer = await this.carryOut(action, tooLate, endTime);
          } catch (error) {
            answer = refusedByDecaid2(action.id, null, `Decaid did not answer: ${describe2(error)}`);
          }
          if (answer === void 0 || this.stopped) return;
          if (answer.outcome === "refused") this.log(`Did not carry out Software Action ${action.id}: ${describeRefusal2(answer)}`);
          this.outbox.enqueue(answer);
        } finally {
          clearTimeout(timer);
        }
      });
    }
    /** Drops the actions still waiting their turn, and starts none after this, as the plugin unloads. */
    stop() {
      this.stopped = true;
    }
    /**
     * Answers the action an earlier load kept, if Decaid loaded the plugin
     * again under it, from what is installed now, watched for a while as
     * Decaid finishes the install (`RESUME_WATCH_MS`): within the queue, so no
     * action sent to this load runs first. One it can't tell the outcome of
     * by then is left unanswered, and so not confirmed; one this load unloads
     * under stays kept for the next. It never rejects.
     */
    resume() {
      return this.access.run(async () => {
        try {
          const kept = parsed5(String(await this.storage.read(PENDING_KEY, "the Software Action an earlier load kept") ?? ""));
          if (!isPending(kept) || this.stopped) return;
          if (Date.now() - kept.startedAt > PENDING_MS || Date.now() < kept.startedAt) return void await this.forget();
          const answer = await this.watch(kept, true, Math.min(kept.startedAt + PENDING_MS, Date.now() + RESUME_WATCH_MS));
          if (this.stopped) return;
          await this.forget();
          if (answer !== void 0) this.outbox.enqueue(answer);
        } catch (error) {
          this.log(`Could not answer the Software Action an earlier load kept: ${describe2(error)}`);
        }
      });
    }
    /**
     * What came of a kept action once the plugin list shows it (`settled`),
     * read again every WATCH_STEP_MS until `until`, each read reported as a
     * read-back of the action; undefined where it never shows by then, or the
     * plugin unloads. An update check's results are asked of Decaid again
     * (`joinUpdateCheck`): after a load of the plugin, only once its own build
     * shows changed, which is what loaded it again.
     */
    async watch(kept, reloaded, until) {
      for (; ; ) {
        if (this.stopped) return void 0;
        let plugins = await this.reports.readSoftware("plugins", kept.id);
        let report;
        if (plugins !== void 0 && kept.kind === "checkPluginUpdates" && (!reloaded || ownBuildChanged(kept, plugins))) {
          report = await this.joinUpdateCheck().catch(() => void 0);
          if (report !== void 0 && !this.stopped) plugins = await this.reports.readSoftware("plugins", kept.id) ?? plugins;
        }
        const ownSettings = reloaded && kept.kind === "changePluginSettings" ? await readOwnSettings() : void 0;
        if (this.stopped) return void 0;
        const installed = plugins !== void 0 && kept.kind === "changePluginSource" ? installedSince(kept, plugins) : void 0;
        if (installed !== void 0 && plugins !== void 0) return this.pluginSourceChanged(kept, String(installed.id), plugins);
        const answer = plugins === void 0 ? void 0 : settled(kept, plugins, report, reloaded, ownSettings);
        if (answer !== void 0) return answer;
        if (Date.now() + WATCH_STEP_MS > until) return void 0;
        await new Promise((resolve) => setTimeout(() => resolve(), WATCH_STEP_MS));
      }
    }
    /** The action's answer, or undefined where the plugin unloaded before or under it. */
    async carryOut(action, tooLate, endTime) {
      if (tooLate()) return expired2(action.id);
      const forbidden = forbiddenToItself(action);
      if (forbidden !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "notAllowed", message: forbidden };
      if (action.kind === "checkDecaidUpdate") return this.checkDecaidUpdate(action, tooLate);
      const state = await request("GET", "/machine/state");
      if (state.ok) {
        const machineState = stateOf2(state.text);
        if (machineState === null) return refusedByDecaid2(action.id, state.status, "Decaid's answer names no machine state");
        if (!SETTINGS_EDIT_STATES.includes(machineState)) {
          return { type: "softwareActed", id: action.id, outcome: "refused", reason: "machineBusy", state: machineState };
        }
      } else if (!machineMissing(state)) {
        return refusedByDecaid2(action.id, state.status, decaidMessage2(state));
      }
      if (isSkinAction(action)) return this.carryOutOnSkins(action, tooLate, endTime);
      if (action.kind === "startDecaidUpdate") return this.startDecaidUpdate(action, tooLate, endTime);
      const before = await this.reports.readSoftware("plugins");
      if (before === void 0) return refusedByDecaid2(action.id, null, "Decaid did not answer with its plugins");
      const changed = await changedSince2(action, before);
      if (changed !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: changed };
      if (this.stopped) return void 0;
      if (tooLate()) return expired2(action.id);
      const reloads = mayReloadItself(action);
      const pending = pendingOf(action, before);
      if (reloads) await this.keep(pending);
      let answer;
      let failure = "";
      try {
        answer = await ask(action);
      } catch (error) {
        failure = describe2(error);
        if (reloads && /unloaded|generation changed/i.test(failure)) return void 0;
        if (/timed out/i.test(failure)) {
          const watched = await this.watch(pending, false, endTime);
          if (this.stopped) return void 0;
          if (reloads && watched !== void 0) await this.forget();
          return watched;
        }
      }
      if (this.stopped) return void 0;
      if (reloads) await this.forget();
      const after = await this.reports.readSoftware("plugins", action.id).catch(() => void 0);
      if (answer === void 0) return refusedByDecaid2(action.id, null, `Decaid did not answer: ${failure}`);
      if (!answer.ok) return refusedByDecaid2(action.id, answer.status, decaidMessage2(answer));
      if (action.kind === "changePluginSource") {
        const said = parsed5(answer.text);
        const installed = isObject8(said) && typeof said.id === "string" ? said.id : after === void 0 ? void 0 : installedSince(pending, after)?.id;
        return this.pluginSourceChanged(pending, typeof installed === "string" ? installed : action.pluginId, after ?? before);
      }
      return { type: "softwareActed", id: action.id, outcome: "done", result: resultOf(action, answer, before, after) };
    }
    /**
     * What a change of how a plugin updates came to, once Decaid installed
     * the plugin `installedId` from the new source, over the plugin list as it
     * is now. Done where that is the plugin the action named, with its version
     * before and after and the permissions its new build adds. Where the
     * source held another plugin, Decaid installed that one beside it: the
     * plugin removes it again, unless the Tablet held it before the action or
     * it is this plugin itself, reads the list back, and refuses the action as
     * `differentItem`, the plugin it named being as it was.
     */
    async pluginSourceChanged(kept, installedId, plugins) {
      const listed = (id) => plugins.find((entry) => isObject8(entry) && entry.id === id);
      const wanted = kept.pluginId ?? "";
      if (installedId === wanted) {
        const plugin = listed(wanted);
        const before = new Set(kept.permissions ?? []);
        const added = plugin && Array.isArray(plugin.permissions) ? plugin.permissions.filter((permission) => typeof permission === "string" && !before.has(permission)) : [];
        return {
          type: "softwareActed",
          id: kept.id,
          outcome: "done",
          result: {
            pluginId: wanted,
            ...typeof plugin?.name === "string" && plugin.name !== "" ? { name: plugin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {},
            ...typeof plugin?.version === "string" ? { version: plugin.version } : {},
            ...kept.versions[wanted] === void 0 ? {} : { previousVersion: kept.versions[wanted] },
            ...typeof plugin?.loaded === "boolean" ? { loaded: plugin.loaded } : {},
            ...added.length > 0 ? { addedPermissions: added.slice(0, MAX_PLUGIN_SETTINGS).map((permission) => permission.slice(0, MAX_SOFTWARE_NAME_LENGTH)) } : {}
          }
        };
      }
      const stray = listed(installedId);
      const named = String(stray?.name ?? installedId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
      const heldBefore = kept.versions[installedId] !== void 0 || installedId === "decent-sync.reaplugin";
      let left = `${named} was on the Tablet before, and is now installed from that source`;
      if (!heldBefore) {
        const removed = await manage("DELETE", `/plugins/${encodeURIComponent(installedId)}`).catch((error) => ({ status: 0, ok: false, text: describe2(error) }));
        if (this.stopped) return void 0;
        await this.reports.readSoftware("plugins", kept.id).catch(() => void 0);
        left = removed.ok ? "Decaid installed it beside it, and the plugin removed it again" : `Decaid installed it beside it, and it could not be removed again (${removed.status === 0 ? removed.text : decaidMessage2(removed)}): remove it from its row`;
      }
      const wantedName = String(listed(wanted)?.name ?? wanted).slice(0, MAX_SOFTWARE_NAME_LENGTH);
      return differentItem(kept.id, `That source holds another plugin, ${named}, not ${wantedName}. ${left}. ${wantedName} is unchanged`);
    }
    /**
     * Carries out an action on the Tablet's Skins, the machine idle: reads the
     * Skins, refuses what no longer holds and what the plugin's protections
     * forbid (removing the default Skin or the one served, whatever it is sent), asks Decaid,
     * and reads the Skins back, whether or not Decaid took it.
     */
    async carryOutOnSkins(action, tooLate, endTime) {
      const before = await this.reports.readSoftwareSkins();
      if (this.stopped) return void 0;
      if (before === void 0) return refusedByDecaid2(action.id, null, "Decaid did not answer with its Skins");
      const forbidden = forbiddenOnSkins(action, before);
      if (forbidden !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "notAllowed", message: forbidden };
      const changed = skinsChangedSince(action, before, this.pages?.latest() ?? null);
      if (changed !== null) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: changed };
      if (tooLate()) return expired2(action.id);
      if (action.kind === "reloadSkin") return this.reloadSkin(action, String(servedSkin(before)?.id));
      if (action.kind === "restartSkinView") return this.restartSkinView(action);
      let answer;
      let failure = "";
      try {
        answer = await askOnSkins(action);
      } catch (error) {
        failure = describe2(error);
      }
      if (this.stopped) return void 0;
      if (answer === void 0 && action.kind === "installSkin" && /timed out/i.test(failure)) return this.watchSkinInstall(action, before, endTime);
      if (answer === void 0 && action.kind === "changeSkinSource" && /timed out/i.test(failure)) {
        const watched = await this.watchSkinInstall(action, before, endTime, true);
        return watched === void 0 || this.stopped ? void 0 : this.skinSourceChanged(action, before, watched);
      }
      if (answer === void 0 && action.kind === "checkSkinUpdates" && /timed out/i.test(failure)) {
        if (Date.now() >= endTime) return void 0;
        try {
          answer = await askOnSkins(action);
        } catch (error) {
          failure = describe2(error);
          if (this.stopped || /timed out/i.test(failure)) return void 0;
        }
        if (this.stopped) return void 0;
      }
      const after = await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
      if (answer === void 0) return refusedByDecaid2(action.id, null, `Decaid did not answer: ${failure}`);
      if (!answer.ok) return refusedByDecaid2(action.id, answer.status, decaidMessage2(answer));
      if (action.kind === "changeSkinSource") return this.skinSourceChanged(action, before, after === void 0 ? void 0 : installedSkin(before, after, action.skinId));
      return { type: "softwareActed", id: action.id, outcome: "done", result: skinResultOf(action, answer, before, after) };
    }
    async watchSkinInstall(action, before, until, found) {
      for (; ; ) {
        if (this.stopped) return void 0;
        const after = await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
        const installed = after === void 0 ? void 0 : installedSkin(before, after, action.kind === "changeSkinSource" ? action.skinId : void 0);
        if (installed !== void 0) return found ? installed : { type: "softwareActed", id: action.id, outcome: "done", result: skinNamed(installed) };
        if (Date.now() + WATCH_STEP_MS > until) return void 0;
        await new Promise((resolve) => setTimeout(() => resolve(), WATCH_STEP_MS));
      }
    }
    /**
     * What a change of how a Skin updates came to, once Decaid took the
     * install: `installed` is the Skin the list shows installed since. Done
     * where that is the Skin the action named, with its version before and
     * after. Where the source held another Skin, Decaid installed that one:
     * the plugin removes it again, unless the Tablet held it before, reads the
     * Skins back, and refuses the action as `differentItem`, the Skin it named
     * being as it was. Not confirmed where the list shows no Skin installed.
     */
    async skinSourceChanged(action, before, installed) {
      if (installed === void 0) return { type: "softwareActed", id: action.id, outcome: "notConfirmed", message: "Decaid took the install, but its Skins list shows no Skin installed since" };
      const earlier = skinsIn(before).find((skin) => skin.id === action.skinId);
      if (installed.id === action.skinId) {
        const previous = typeof earlier?.version === "string" && earlier.version !== "" ? { previousVersion: earlier.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {};
        return { type: "softwareActed", id: action.id, outcome: "done", result: { ...skinNamed(installed), ...previous } };
      }
      const installedId = String(installed.id);
      const named = String(installed.name ?? installedId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
      const wanted = String(earlier?.name ?? action.skinId).slice(0, MAX_SOFTWARE_NAME_LENGTH);
      let left = `${named} was on the Tablet before, and is now installed from that source`;
      if (!skinsIn(before).some((skin) => skin.id === installedId)) {
        const removed = await manage("DELETE", `/webui/skins/${encodeURIComponent(installedId)}`).catch((error) => ({ status: 0, ok: false, text: describe2(error) }));
        if (this.stopped) return void 0;
        await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
        left = removed.ok ? "Decaid installed it beside it, and the plugin removed it again" : `Decaid installed it beside it, and it could not be removed again (${removed.status === 0 ? removed.text : decaidMessage2(removed)}): remove it from its row`;
      }
      return differentItem(action.id, `That source holds another Skin, ${named}, not ${wanted}. ${left}. ${wanted} is unchanged`);
    }
    /**
     * Asks the Skin on screen, `skinId`, to load its page again, by a push on
     * `changes`, and waits up to SKIN_RELOAD_MS for its fresh page to report
     * in: done with that page, or not confirmed. Fresh is a page of that Skin
     * that loaded after the one last reported, both timed by the Skin view's
     * clock (`performance.timeOrigin`); or, where none has reported in this
     * load of the plugin, the first of that Skin to report after the push, as
     * Decaid keeps a Skin's socket open across the plugin's loads, so the Skin
     * reports again only once its page loads. Its `loadedAt` is not compared
     * with the plugin's own clock then: the Skin view's runs behind it once the
     * Tablet has slept.
     */
    async reloadSkin(action, skinId) {
      if (!this.pages) return { type: "softwareActed", id: action.id, outcome: "refused", reason: "changedSince", message: "This load of the plugin takes no page reports" };
      const pages = this.pages;
      const shown = pages.latest();
      const after = shown === null ? null : Date.parse(shown.loadedAt);
      let stopWaiting = () => {
      };
      const fresh = new Promise((resolve) => {
        const timer = setTimeout(() => settle(void 0), SKIN_RELOAD_MS);
        const unsubscribe = pages.onReport((page2) => {
          if (page2.skinId === skinId && (after === null || Date.parse(page2.loadedAt) > after)) settle(page2);
        });
        const settle = (page2) => {
          clearTimeout(timer);
          unsubscribe();
          resolve(page2);
        };
        stopWaiting = () => settle(void 0);
      });
      try {
        pages.askReload();
      } catch (error) {
        stopWaiting();
        return refusedByDecaid2(action.id, null, `Decaid did not take the push asking the Skin to reload: ${describe2(error)}`);
      }
      const page = await fresh;
      if (this.stopped) return void 0;
      await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
      if (page === void 0) {
        return {
          type: "softwareActed",
          id: action.id,
          outcome: "notConfirmed",
          message: `The Skin was asked to reload, but no fresh page reported in within ${SKIN_RELOAD_MS / 1e3} s`
        };
      }
      const reported = { skinId: page.skinId, ...page.version === void 0 ? {} : { version: page.version }, loadedAt: page.loadedAt };
      return { type: "softwareActed", id: action.id, outcome: "done", result: { skinId: page.skinId, ...page.version === void 0 ? {} : { version: page.version }, page: reported } };
    }
    /**
     * Stops Decaid's Skin server and starts it again, which has Decaid build
     * its Skin view again on the default Skin, then watches its status until
     * it serves, starting it once more if it does not: done with the Skin
     * served, or refused as `noSkinServed` where the Tablet is left with none.
     */
    async restartSkinView(action) {
      const stopped = await manage("POST", "/webui/server/stop");
      if (this.stopped) return void 0;
      if (!stopped.ok) {
        await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
        return refusedByDecaid2(action.id, stopped.status, decaidMessage2(stopped));
      }
      let said = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = await manage("POST", "/webui/server/start").catch((error) => ({ status: 0, ok: false, text: describe2(error) }));
        if (this.stopped) return void 0;
        if (!started.ok) said = started.status === 0 ? started.text : decaidMessage2(started);
        if (await this.servingSoon()) {
          const after = await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
          const served = after === void 0 ? void 0 : servedSkin(after);
          return { type: "softwareActed", id: action.id, outcome: "done", result: served === void 0 ? {} : skinNamed(served) };
        }
        if (this.stopped) return void 0;
      }
      await this.reports.readSoftwareSkins(action.id).catch(() => void 0);
      return {
        type: "softwareActed",
        id: action.id,
        outcome: "refused",
        reason: "noSkinServed",
        message: `Decaid's Skin server did not start again${said === "" ? "" : `: ${said}`}`.slice(0, MAX_REFUSAL_LENGTH)
      };
    }
    /** Whether Decaid's Skin server says it serves within SERVING_WATCH_MS. */
    async servingSoon() {
      const until = Date.now() + SERVING_WATCH_MS;
      for (; ; ) {
        if (this.stopped) return false;
        const status = await request("GET", "/webui/server/status").catch(() => void 0);
        const read = status?.ok ? parsed5(status.text) : void 0;
        if (isObject8(read) && read.serving === true) return true;
        if (Date.now() + SERVING_STEP_MS > until) return false;
        await new Promise((resolve) => setTimeout(() => resolve(), SERVING_STEP_MS));
      }
    }
    /**
     * Has Decaid start its own update, over its update socket, the machine
     * idle: Decaid checks for it where it holds none, downloads it and opens
     * Android's installer, which someone at the Tablet confirms. Done once
     * Decaid says the installer opened (`installOverSocket`); refused where
     * Android's permission for Decaid to install apps was not granted at the
     * Tablet (`installNotPermitted`), where Decaid is checking, downloading
     * or installing already, found no update or did not open the installer,
     * or where it failed, in its words.
     */
    async startDecaidUpdate(action, tooLate, endTime) {
      await this.reports.readSoftware("decaid");
      if (this.stopped) return void 0;
      if (tooLate()) return expired2(action.id);
      let outcome;
      try {
        outcome = await this.installOverSocket(Math.max(0, Math.min(UPDATE_START_MS, endTime - Date.now())));
      } catch (error) {
        outcome = { refused: "decaid", message: `Decaid did not answer: ${describe2(error)}` };
      }
      if (this.stopped) return void 0;
      await this.reports.readSoftware("decaid", action.id).catch(() => void 0);
      if ("refused" in outcome) {
        return outcome.refused === "installNotPermitted" ? { type: "softwareActed", id: action.id, outcome: "refused", reason: "installNotPermitted", message: outcome.message.slice(0, MAX_REFUSAL_LENGTH) } : refusedByDecaid2(action.id, null, outcome.message);
      }
      if ("notConfirmed" in outcome) return { type: "softwareActed", id: action.id, outcome: "notConfirmed", message: outcome.notConfirmed };
      const state = await request("GET", "/update").catch(() => void 0);
      const decaid = state?.ok ? parsed5(state.text) : void 0;
      return { type: "softwareActed", id: action.id, outcome: "done", result: isObject8(decaid) ? { decaid: updateState(decaid) } : {} };
    }
    /**
     * Sends Decaid's update socket the command to install, once it has sent
     * the state it opens with, and resolves with what came of it, judged from
     * the states it sends: started at its second `installing`, which Decaid
     * sends once Android's installer opens (`_installAttempt` sends a first
     * before it checks the download and launches the installer); Decaid's
     * refusal, as where Android's permission to install apps is not granted
     * (`local_approval_required`); a check that found nothing, an installer
     * that did not open, or a download or install that failed. Not confirmed
     * where none of these shows within `limitMs`: UPDATE_START_MS, or less
     * where the action's time is up sooner.
     */
    async installOverSocket(limitMs) {
      const handle = await this.transports.open(UPDATE_SOCKET);
      try {
        return await new Promise((resolve, reject) => {
          let opened = false;
          let underWay = false;
          let installing = false;
          let over = false;
          let lastSeen = {};
          const notConfirmed = () => {
            const seconds = Math.round(limitMs / 1e3);
            if (lastSeen.phase === "downloading") {
              const progress = typeof lastSeen.progress === "number" && Number.isFinite(lastSeen.progress) ? ` (${Math.round(Math.min(1, Math.max(0, lastSeen.progress)) * 100)}%)` : "";
              return `Decaid was still downloading its update${progress} after ${seconds} s: Android's installer opens at the Tablet once it finishes`;
            }
            if (lastSeen.phase === "checking") return `Decaid was still checking for its update after ${seconds} s`;
            return `Decaid's update did not reach Android's installer within ${seconds} s`;
          };
          const timer = setTimeout(() => settle({ notConfirmed: notConfirmed() }), limitMs);
          const settle = (outcome) => {
            over = true;
            clearTimeout(timer);
            resolve(outcome);
          };
          const fail2 = (error) => {
            over = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          this.transports.onEvent(handle, (event) => {
            if (over) return;
            if (event.type !== "data") return fail2(new Error("its update socket closed"));
            const frame = parsed5(event.data);
            if (!isObject8(frame)) return;
            if (typeof frame.error === "string" && frame.phase === void 0) {
              return settle(frame.reason === "local_approval_required" ? { refused: "installNotPermitted", message: frame.error } : { refused: "decaid", message: frame.error });
            }
            const phase = frame.phase;
            if (opened) lastSeen = frame;
            if (!opened) {
              opened = true;
              if (phase === "checking") return settle({ refused: "decaid", message: "Decaid is checking for its update now: start the update once the check ends" });
              if (phase === "downloading" || phase === "installing") return settle({ refused: "decaid", message: `Decaid is ${String(phase)} its update already` });
              this.transports.send(handle, JSON.stringify({ command: "install" })).catch(fail2);
              return;
            }
            if (phase === "installing") {
              if (installing) return settle({ started: true });
              installing = true;
              return;
            }
            if (phase === "error") return settle({ refused: "decaid", message: typeof frame.error === "string" && frame.error !== "" ? frame.error : "Decaid could not update itself" });
            if (installing && (phase === "available" || phase === "idle")) return settle({ refused: "decaid", message: "Decaid did not open Android's installer" });
            if (phase === "checking" || phase === "downloading") underWay = true;
            else if (phase === "idle" && underWay) settle({ refused: "decaid", message: "Decaid found no update to install" });
          });
        });
      } finally {
        this.transports.close(handle);
      }
    }
    /**
     * Has Decaid check for a newer release of itself, over its update socket,
     * which is the one way it takes the command: done once Decaid's state
     * leaves `checking`, with that state, in any Machine State, as the check
     * touches neither the Machine nor the Skin.
     */
    async checkDecaidUpdate(action, tooLate) {
      await this.reports.readSoftware("decaid");
      if (this.stopped) return void 0;
      if (tooLate()) return expired2(action.id);
      let refusal2;
      try {
        refusal2 = await this.checkOverSocket();
      } catch (error) {
        refusal2 = `Decaid did not answer: ${describe2(error)}`;
      }
      if (this.stopped) return void 0;
      await this.reports.readSoftware("decaid", action.id).catch(() => void 0);
      if (refusal2 !== null) return refusedByDecaid2(action.id, null, refusal2);
      const state = await request("GET", "/update");
      const decaid = state.ok ? parsed5(state.text) : void 0;
      if (!isObject8(decaid)) return refusedByDecaid2(action.id, state.status, decaidMessage2(state));
      if (decaid.phase === "error") return refusedByDecaid2(action.id, null, typeof decaid.error === "string" && decaid.error !== "" ? decaid.error : "Decaid could not check for its update");
      return { type: "softwareActed", id: action.id, outcome: "done", result: { decaid: updateState(decaid) } };
    }
    /**
     * Sends Decaid's update socket the command to check, and resolves once its
     * state has left `checking`: with null, or with why Decaid would not check,
     * as where the state it opens with is downloading or installing its update,
     * when it takes no command to check (`requestCheck`).
     */
    async checkOverSocket() {
      const handle = await this.transports.open(UPDATE_SOCKET);
      try {
        return await new Promise((resolve, reject) => {
          let checking = false;
          let opened = false;
          const timer = setTimeout(() => reject(new Error("its check for an update did not finish in time")), UPDATE_CHECK_MS);
          const settle = (settled2) => {
            clearTimeout(timer);
            settled2();
          };
          this.transports.onEvent(handle, (event) => {
            if (event.type !== "data") return settle(() => reject(new Error("its update socket closed")));
            const frame = parsed5(event.data);
            if (!isObject8(frame)) return;
            if (typeof frame.error === "string" && frame.phase === void 0) return settle(() => resolve(frame.error));
            if (!opened) {
              opened = true;
              if (frame.phase === "downloading" || frame.phase === "installing") return settle(() => resolve(`Decaid is ${String(frame.phase)} its update, so it checks for none now`));
            }
            if (frame.phase === "checking") checking = true;
            else if (checking) settle(() => resolve(null));
          });
          this.transports.send(handle, JSON.stringify({ command: "check" })).catch((error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
        });
      } finally {
        this.transports.close(handle);
      }
    }
    /**
     * The results of the update check that loaded this plugin again, once it
     * ends: Decaid answers a request for a check while one runs with that
     * check's results (`checkForPluginUpdates`), and one made after it ended
     * with a new check's, which finds what the first left. Undefined, and so
     * not confirmed, where the Machine is busy by now, as no new check is
     * started then, or Decaid answers with no results.
     */
    async joinUpdateCheck() {
      const state = await request("GET", "/machine/state");
      if (state.ok) {
        const machineState = stateOf2(state.text);
        if (machineState === null || !SETTINGS_EDIT_STATES.includes(machineState)) return void 0;
      } else if (!machineMissing(state)) {
        return void 0;
      }
      const answer = await manage("POST", "/plugins/update");
      const said = answer.ok ? parsed5(answer.text) : void 0;
      return isObject8(said) && Array.isArray(said.results) ? said.results : void 0;
    }
    async keep(pending) {
      await this.storage.write(PENDING_KEY, JSON.stringify(pending), "a Software Action that may load the plugin again");
    }
    async forget() {
      await this.storage.write(PENDING_KEY, "", "that a Software Action is done").catch((error) => this.log(`Could not clear the Software Action kept: ${describe2(error)}`));
    }
  };
  function pendingOf(action, plugins) {
    return {
      id: action.id,
      kind: action.kind,
      startedAt: Date.now(),
      versions: versionsOf(plugins),
      builds: buildsOf(plugins),
      installed: installedOf(plugins),
      ..."pluginId" in action ? { pluginId: action.pluginId } : {},
      ...action.kind === "installPlugin" || action.kind === "changePluginSource" ? { repo: action.repo, ...action.branch === void 0 ? {} : { branch: action.branch } } : {},
      ...action.kind === "changePluginSource" ? { permissions: permissionsOf(plugins, action.pluginId) } : {},
      ...action.kind === "changePluginSettings" ? { pollSeconds: action.values[OWN_CHANGEABLE_SETTING] } : {}
    };
  }
  function forbiddenToItself(action) {
    if (!("pluginId" in action) || action.pluginId !== "decent-sync.reaplugin") return null;
    if (action.kind === "disablePlugin") return "The Decent Sync plugin does not disable itself: that would cut the Tablet off from the server";
    if (action.kind === "removePlugin") return "The Decent Sync plugin does not remove itself: that would cut the Tablet off from the server";
    if (action.kind === "changePluginSettings" && Object.keys(action.values).some((setting) => setting !== OWN_CHANGEABLE_SETTING)) {
      return "The Decent Sync plugin changes none of its own settings but its poll interval: its server address and Token are set on the Tablet";
    }
    if (action.kind === "changePluginSource" && (action.repo.toLowerCase() !== DECENT_SYNC_REPO || action.branch !== void 0 && !namesCommit(action.branch))) {
      return `The Decent Sync plugin installs itself only from the latest release of ${DECENT_SYNC_REPO} or one of its commits: a build from anywhere else could cut the Tablet off from the server`;
    }
    return null;
  }
  var SKIN_KINDS = ["installSkin", "chooseDefaultSkin", "checkSkinUpdates", "removeSkin", "changeSkinSource", "reloadSkin", "restartSkinView"];
  function isSkinAction(action) {
    return SKIN_KINDS.includes(action.kind);
  }
  function skinsIn(report) {
    return Array.isArray(report.skins) ? report.skins.filter(isObject8) : [];
  }
  function defaultSkinId(report) {
    return isObject8(report.default) && typeof report.default.id === "string" ? report.default.id : null;
  }
  function servedSkin(report) {
    const server = isObject8(report.server) ? report.server : {};
    if (server.serving !== true || typeof server.path !== "string") return void 0;
    return skinsIn(report).find((skin) => skin.path === server.path);
  }
  function forbiddenOnSkins(action, before) {
    if (action.kind === "changeSkinSource") {
      const skin = skinsIn(before).find((entry) => entry.id === action.skinId);
      return skin?.isBundled === true ? "Decaid restores a Skin it comes with from its own repository each time it starts, so how it updates can't be changed" : null;
    }
    if (action.kind !== "removeSkin") return null;
    if (action.skinId === defaultSkinId(before)) return "The plugin does not remove the default Skin: choose another default first";
    if (action.skinId === servedSkin(before)?.id) return "The plugin does not remove the Skin on screen: restart the Skin view onto the default first";
    return null;
  }
  function skinsChangedSince(action, before, page) {
    if (action.kind === "chooseDefaultSkin" || action.kind === "removeSkin") {
      return skinsIn(before).some((skin) => skin.id === action.skinId) ? null : `The Tablet has no Skin ${action.skinId} any more`;
    }
    if (action.kind === "changeSkinSource") {
      const skin = skinsIn(before).find((entry) => entry.id === action.skinId);
      if (!skin) return `The Tablet has no Skin ${action.skinId} any more`;
      if (!sameSourceSeen(skinSourceSeen(skin), action.expected)) return SOURCE_MOVED;
    }
    if (action.kind === "reloadSkin") {
      const served = servedSkin(before);
      if (served === void 0) return "Decaid serves no Skin now: restart the Skin view";
      if (page !== null && page.skinId !== served.id) return `The Skin served now, ${String(served.name ?? served.id).slice(0, MAX_SOFTWARE_NAME_LENGTH)}, has not reported its page, so it can't be asked to reload`;
    }
    return null;
  }
  function askOnSkins(action) {
    switch (action.kind) {
      case "installSkin":
      case "changeSkinSource":
        if (action.url !== void 0) return manage("POST", "/webui/skins/install/url", { url: action.url });
        return action.branch === void 0 ? manage("POST", "/webui/skins/install/github-release", { repo: action.repo }) : manage("POST", "/webui/skins/install/github-branch", { repo: action.repo, branch: action.branch });
      case "chooseDefaultSkin":
        return manage("PUT", "/webui/skins/default", { skinId: action.skinId });
      case "checkSkinUpdates":
        return manage("POST", "/webui/skins/update");
      case "removeSkin":
        return manage("DELETE", `/webui/skins/${encodeURIComponent(action.skinId)}`);
      default:
        return Promise.reject(new Error(`this plugin carries out no ${action.kind} this way`));
    }
  }
  function skinNamed(skin) {
    return {
      ...typeof skin.id === "string" ? { skinId: skin.id } : {},
      ...typeof skin.name === "string" && skin.name !== "" ? { name: skin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {},
      ...typeof skin.version === "string" && skin.version !== "" ? { version: skin.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {}
    };
  }
  function skinIdFor(report, item) {
    const skin = skinsIn(report).find((entry) => {
      if (entry.id === item) return true;
      const metadata = isObject8(entry.reaMetadata) ? entry.reaMetadata : {};
      return typeof metadata.sourceUrl === "string" && metadata.sourceUrl.startsWith(`github_release:${item}@`);
    });
    return typeof skin?.id === "string" ? skin.id : void 0;
  }
  function skinInstalls(report) {
    return new Map(
      skinsIn(report).flatMap((skin) => {
        if (typeof skin.id !== "string") return [];
        const metadata = isObject8(skin.reaMetadata) ? skin.reaMetadata : {};
        return [[skin.id, typeof metadata.installedAt === "string" ? metadata.installedAt : `${String(skin.version)} ${String(metadata.sourceUrl)}`]];
      })
    );
  }
  function installedSkin(before, after, named) {
    const earlier = skinInstalls(before);
    const changed = [...skinInstalls(after)].filter(([skinId, installed]) => earlier.get(skinId) !== installed).map(([skinId]) => skinId);
    const id = named !== void 0 && changed.includes(named) ? named : changed.find((skinId) => !earlier.has(skinId)) ?? changed[0];
    return id === void 0 ? void 0 : skinsIn(after).find((skin) => skin.id === id);
  }
  function skinResultOf(action, answer, before, after) {
    const listed = (report, id) => report === void 0 ? void 0 : skinsIn(report).find((skin) => skin.id === id);
    switch (action.kind) {
      case "installSkin": {
        const installed = after === void 0 ? void 0 : installedSkin(before, after);
        return installed === void 0 ? {} : skinNamed(installed);
      }
      case "chooseDefaultSkin": {
        const skin = listed(after, action.skinId) ?? listed(before, action.skinId);
        return skin === void 0 ? { skinId: action.skinId } : skinNamed(skin);
      }
      case "removeSkin": {
        const skin = listed(before, action.skinId);
        return skin === void 0 ? { skinId: action.skinId } : skinNamed(skin);
      }
      case "checkSkinUpdates": {
        const said = parsed5(answer.text);
        const results = isObject8(said) && Array.isArray(said.results) ? said.results : [];
        const earlier = skinInstalls(before);
        const now2 = after === void 0 ? earlier : skinInstalls(after);
        return {
          results: results.filter(isObject8).flatMap((result) => {
            if (typeof result.item !== "string" || typeof result.status !== "string") return [];
            const skin = listed(after, result.item);
            const id = skinIdFor(after ?? before, result.item);
            const moved = id !== void 0 && earlier.has(id) && now2.has(id) && earlier.get(id) !== now2.get(id);
            const status = moved && result.error === void 0 ? "updated" : result.status;
            const version = typeof skin?.version === "string" && skin.version !== "" ? { version: skin.version.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {};
            return [{ item: result.item.slice(0, MAX_SOFTWARE_NAME_LENGTH), status: status.slice(0, MAX_SOFTWARE_NAME_LENGTH), ...typeof result.error === "string" ? { error: result.error.slice(0, MAX_REFUSAL_LENGTH) } : {}, ...version }];
          })
        };
      }
      default:
        return {};
    }
  }
  function mayReloadItself(action) {
    if (action.kind === "installPlugin" || action.kind === "changePluginSource" || action.kind === "checkPluginUpdates") return true;
    return (action.kind === "approvePluginUpdate" || action.kind === "changePluginSettings") && action.pluginId === "decent-sync.reaplugin";
  }
  async function changedSince2(action, plugins) {
    if (!("pluginId" in action)) return null;
    const plugin = plugins.find((entry) => isObject8(entry) && entry.id === action.pluginId);
    if (!plugin) return `The Tablet has no plugin ${action.pluginId} any more`;
    if (action.kind === "changePluginSource" && !sameSourceSeen(pluginSourceSeen(plugin), action.expected)) return SOURCE_MOVED;
    if (action.kind === "approvePluginUpdate") {
      const waiting = isObject8(plugin.pendingUpdate) ? plugin.pendingUpdate : null;
      if (waiting === null) return "No update of the plugin waits for approval any more";
      const added = Array.isArray(waiting.addedPermissions) ? [...waiting.addedPermissions].sort() : [];
      if (waiting.version !== action.version || !sameValue(added, [...action.addedPermissions].sort())) return "Another update of the plugin waits now than the one shown";
    }
    if (action.kind === "changePluginSettings") {
      const read = await request("GET", `/plugins/${encodeURIComponent(action.pluginId)}/settings`);
      const held = read.ok ? parsed5(read.text) : void 0;
      if (!isObject8(held)) return "Decaid did not answer with the plugin's settings";
      const differs = Object.keys(action.values).filter((setting) => !sameValue(held[setting] ?? null, action.expected[setting] ?? null));
      if (differs.length > 0) return `Changed on the Tablet since the form was shown: ${differs.join(", ")}`;
    }
    return null;
  }
  function ask(action) {
    switch (action.kind) {
      case "installPlugin":
      case "changePluginSource":
        return action.branch === void 0 ? manage("POST", "/plugins/install/github-release", { repo: action.repo }) : manage("POST", "/plugins/install/github-branch", { repo: action.repo, branch: action.branch });
      case "enablePlugin":
        return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/enable`);
      case "disablePlugin":
        return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/disable`);
      case "changePluginSettings":
        return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/settings`, action.values);
      case "checkPluginUpdates":
        return manage("POST", "/plugins/update");
      case "approvePluginUpdate":
        return manage("POST", `/plugins/${encodeURIComponent(action.pluginId)}/update/approve`);
      case "removePlugin":
        return manage("DELETE", `/plugins/${encodeURIComponent(action.pluginId)}`);
      default:
        return Promise.reject(new Error(`this plugin carries out no ${action.kind}`));
    }
  }
  function resultOf(action, answer, before, after) {
    const said = parsed5(answer.text);
    if (action.kind === "checkPluginUpdates") {
      const results = isObject8(said) && Array.isArray(said.results) ? said.results : [];
      const versions = versionsOf(after ?? []);
      return {
        results: results.filter(isObject8).flatMap((result) => {
          if (typeof result.item !== "string" || typeof result.status !== "string") return [];
          return [{ item: result.item, status: result.status, ...typeof result.error === "string" ? { error: result.error.slice(0, MAX_REFUSAL_LENGTH) } : {}, ...versions[result.item] === void 0 ? {} : { version: versions[result.item] } }];
        })
      };
    }
    const pluginId = "pluginId" in action ? action.pluginId : isObject8(said) && typeof said.id === "string" ? said.id : void 0;
    if (pluginId === void 0) return {};
    const named = (plugin2) => typeof plugin2?.name === "string" && plugin2.name !== "" ? { name: plugin2.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {};
    const listed = (list) => list?.find((entry) => isObject8(entry) && entry.id === pluginId);
    if (action.kind === "removePlugin") return { pluginId, ...named(listed(before)) };
    const plugin = listed(after) ?? listed(before);
    if (!plugin) return { pluginId };
    return { pluginId, ...named(plugin), ...typeof plugin.version === "string" ? { version: plugin.version } : {}, ...typeof plugin.loaded === "boolean" ? { loaded: plugin.loaded } : {} };
  }
  function settled(kept, plugins, report, reloaded, ownSettings) {
    const entries = plugins.filter(isObject8);
    const builds = buildsOf(plugins);
    const done = (given) => ({ type: "softwareActed", id: kept.id, outcome: "done", result: given });
    const resultFor = (plugin) => ({
      pluginId: String(plugin.id),
      ...typeof plugin.name === "string" && plugin.name !== "" ? { name: plugin.name.slice(0, MAX_SOFTWARE_NAME_LENGTH) } : {},
      ...typeof plugin.version === "string" ? { version: plugin.version } : {},
      ...typeof plugin.loaded === "boolean" ? { loaded: plugin.loaded } : {}
    });
    switch (kept.kind) {
      case "approvePluginUpdate": {
        const plugin = entries.find((entry) => entry.id === kept.pluginId);
        const rebuilt = plugin !== void 0 && builds[kept.pluginId] !== void 0 && builds[kept.pluginId] !== kept.builds[kept.pluginId];
        return plugin && rebuilt && !isObject8(plugin.pendingUpdate) ? done(resultFor(plugin)) : void 0;
      }
      case "installPlugin": {
        const plugin = installedSince(kept, plugins);
        return plugin ? done(resultFor(plugin)) : void 0;
      }
      case "checkPluginUpdates": {
        if (report === void 0) return void 0;
        const versions = versionsOf(plugins);
        const results = report.filter(isObject8).flatMap((given) => {
          const item = given.item;
          if (typeof item !== "string" || typeof given.status !== "string") return [];
          const rebuilt = kept.builds[item] !== void 0 && builds[item] !== void 0 && kept.builds[item] !== builds[item];
          const status = rebuilt ? "updated" : given.status;
          const error = !rebuilt && typeof given.error === "string" ? { error: given.error.slice(0, MAX_REFUSAL_LENGTH) } : {};
          return [{ item, status, ...error, ...versions[item] === void 0 ? {} : { version: versions[item] } }];
        });
        return done({ results });
      }
      case "changePluginSettings": {
        const own = entries.find((entry) => entry.id === "decent-sync.reaplugin");
        const saved = kept.pollSeconds === void 0 || kept.pollSeconds === null || isObject8(ownSettings) && sameValue(ownSettings[OWN_CHANGEABLE_SETTING], kept.pollSeconds);
        return reloaded && own && kept.pluginId === "decent-sync.reaplugin" && saved ? done(resultFor(own)) : void 0;
      }
      default:
        return void 0;
    }
  }
  function installedSince(kept, plugins) {
    const installed = installedOf(plugins);
    return plugins.filter(isObject8).find((entry) => {
      const source = isObject8(entry.source) ? entry.source : {};
      const sameRepo = typeof source.repo === "string" && typeof kept.repo === "string" && source.repo.toLowerCase() === kept.repo.toLowerCase();
      const sameBranch = kept.branch === void 0 ? source.kind === "github_release" : source.kind === "github_branch" && source.branch === kept.branch;
      const id = String(entry.id);
      return sameRepo && sameBranch && installed[id] !== void 0 && installed[id] !== kept.installed[id];
    });
  }
  function permissionsOf(plugins, pluginId) {
    const plugin = plugins.find((entry) => isObject8(entry) && entry.id === pluginId);
    return Array.isArray(plugin?.permissions) ? plugin.permissions.filter((permission) => typeof permission === "string") : [];
  }
  var SOURCE_MOVED = "The Tablet reports another source or build of it than the page showed: load the page again";
  function differentItem(id, message) {
    return { type: "softwareActed", id, outcome: "refused", reason: "differentItem", message: message.slice(0, MAX_REFUSAL_LENGTH) };
  }
  async function readOwnSettings() {
    const read = await request("GET", `/plugins/${encodeURIComponent("decent-sync.reaplugin")}/settings`).catch(() => void 0);
    return read?.ok ? parsed5(read.text) : void 0;
  }
  function ownBuildChanged(kept, plugins) {
    const now2 = buildsOf(plugins)["decent-sync.reaplugin"];
    return now2 !== void 0 && kept.builds["decent-sync.reaplugin"] !== now2;
  }
  function buildsOf(plugins) {
    return Object.fromEntries(
      plugins.filter(isObject8).flatMap((plugin) => {
        if (typeof plugin.id !== "string" || typeof plugin.version !== "string") return [];
        const source = isObject8(plugin.source) ? plugin.source : {};
        const from = typeof source.commit === "string" ? source.commit : typeof source.releaseTag === "string" ? source.releaseTag : "";
        return [[plugin.id, `${plugin.version} ${from}`]];
      })
    );
  }
  function installedOf(plugins) {
    return Object.fromEntries(
      plugins.filter(isObject8).flatMap((plugin) => {
        const source = isObject8(plugin.source) ? plugin.source : {};
        return typeof plugin.id === "string" && typeof source.installedAt === "string" ? [[plugin.id, source.installedAt]] : [];
      })
    );
  }
  function versionsOf(plugins) {
    return Object.fromEntries(plugins.filter(isObject8).flatMap((plugin) => typeof plugin.id === "string" && typeof plugin.version === "string" ? [[plugin.id, plugin.version]] : []));
  }
  function updateState(state) {
    const { releaseNotes: _notes, ...rest } = state;
    return rest;
  }
  function isPending(value) {
    return isObject8(value) && typeof value.id === "string" && typeof value.kind === "string" && typeof value.startedAt === "number" && isObject8(value.versions) && isObject8(value.builds) && isObject8(value.installed);
  }
  function expired2(id) {
    return { type: "softwareActed", id, outcome: "refused", reason: "expired" };
  }
  function refusedByDecaid2(id, status, message) {
    return { type: "softwareActed", id, outcome: "refused", reason: "decaid", status, message: message.slice(0, MAX_REFUSAL_LENGTH) };
  }
  function stateOf2(text) {
    const snapshot = parsed5(text);
    const state = isObject8(snapshot) && isObject8(snapshot.state) ? snapshot.state.state : void 0;
    return typeof state === "string" && state !== "" ? state : null;
  }
  function decaidMessage2(answer) {
    const body = parsed5(answer.text);
    const said = isObject8(body) ? [body.error, body.message].filter((part) => typeof part === "string" && part !== "") : [];
    if (said.length > 0) return said.join(": ");
    return answer.text === "" ? `Decaid answered ${answer.status}` : answer.text;
  }
  function describeRefusal2(answer) {
    switch (answer.reason) {
      case "machineBusy":
        return `the machine is ${answer.state}`;
      case "changedSince":
        return answer.message ?? "the Tablet's software changed since it was made";
      case "expired":
        return "it came too late to start in time, or its connection closed";
      case "notAllowed":
        return answer.message ?? "the plugin does not do that to itself";
      case "differentItem":
        return answer.message ?? "its source held another plugin or Skin";
      case "decaid":
        return `${answer.status === null || answer.status === void 0 ? "" : `Decaid answered ${answer.status}: `}${answer.message}`;
      default:
        return String(answer.reason);
    }
  }
  function parsed5(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function isObject8(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function describe2(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/shot-edits.ts
  var ShotEdits = class {
    constructor() {
      __publicField(this, "queue", Promise.resolve());
    }
    /** Writes an edit once those before it are written, and gives its answer to `answer`. It never rejects. */
    apply(edit, answer) {
      this.queue = this.queue.then(async () => answer(await writeShotEdit(edit))).catch(() => {
      });
      return this.queue;
    }
  };
  async function writeShotEdit(edit) {
    const annotations = { ...edit.rating !== void 0 && { enjoyment: edit.rating }, ...edit.note !== void 0 && { espressoNotes: edit.note } };
    try {
      const held = await readShot(edit.shotId);
      if (held === null) return { type: "shotEdited", id: edit.id, outcome: "notHeld" };
      if (isLaterRecordTime(held.updatedAt, edit.version)) return { type: "shotEdited", id: edit.id, outcome: "changed" };
      const answer = await request("PUT", `/shots/${encodeURIComponent(edit.shotId)}`, { annotations });
      if (answer.ok) return { type: "shotEdited", id: edit.id, outcome: "written" };
      if (answer.status === 404) return { type: "shotEdited", id: edit.id, outcome: "notHeld" };
      return { type: "shotEdited", id: edit.id, outcome: "refused", status: answer.status, error: answer.text.slice(0, MAX_REFUSAL_LENGTH) };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { type: "shotEdited", id: edit.id, outcome: "refused", status: null, error: why.slice(0, MAX_REFUSAL_LENGTH) };
    }
  }

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

  // src/reference-copies.ts
  var EMPTY = "{}";
  function key(slot) {
    return `reference.${slot}`;
  }
  var ReferenceCopies = class {
    constructor(storage, log, changed) {
      __publicField(this, "storage", storage);
      __publicField(this, "log", log);
      __publicField(this, "changed", changed);
      /** What each slot's key holds, for the slots holding a copy. */
      __publicField(this, "slots", /* @__PURE__ */ new Map());
      /** The reading of what the keys hold, begun by the first use. */
      __publicField(this, "loading");
      /** What each slot is to hold, for the slots whose latest copy from the server is still to be kept. */
      __publicField(this, "waiting", /* @__PURE__ */ new Map());
      /** Whether the copies waiting are being kept. */
      __publicField(this, "busy", false);
      /** Resolves once the copies that have come are kept. */
      __publicField(this, "keeping", Promise.resolve());
      __publicField(this, "stopped", false);
    }
    /** Reads what the keys hold, once. A key that can't be read, or holds no copy, counts as holding none, which the server then sends. */
    load() {
      this.loading ?? (this.loading = (async () => {
        for (let slot = 1; slot <= RECIPE_SLOTS; slot++) {
          try {
            const head = headOf(await this.storage.read(key(slot), `a read of the Reference Shot copy of Recipe Slot ${slot}`));
            if (head) this.slots.set(slot, head);
          } catch (error) {
            if (!this.stopped) this.log(`Could not read the Reference Shot copy of Recipe Slot ${slot}: ${describe3(error)}`);
          }
        }
      })());
      return this.loading;
    }
    /**
     * The server welcomed a connection: it is told what the tablet holds, once
     * that is read and the copies an earlier connection brought are kept,
     * where `current` says the connection is still the one welcomed.
     */
    async welcomed(send, current) {
      await this.settled();
      if (this.stopped || !current()) return;
      const held = {};
      for (const [slot, head] of this.slots) held[String(slot)] = head.version;
      await send({ type: "referencesHeld", held }).catch(() => {
      });
    }
    /**
     * Keeps a copy the server sent in place of what its slot held, and tells
     * Skins of its Recipe. Copies are kept one at a time. One that arrives
     * while an earlier copy for its slot still waits its turn takes that
     * copy's place, so however slow Decaid's storage is, no more wait than
     * there are slots.
     */
    apply({ slot, copy }) {
      if (this.stopped || !isRecipeSlot(slot)) return;
      this.waiting.set(slot, copy);
      if (!this.busy) this.keeping = this.keepWaiting();
    }
    /** Keeps the copies waiting, until none is. It never rejects. */
    async keepWaiting() {
      this.busy = true;
      try {
        await this.load();
        for (; ; ) {
          const next = this.waiting.entries().next();
          if (next.done || this.stopped) return;
          const [slot, copy] = next.value;
          this.waiting.delete(slot);
          await this.keep(slot, copy);
        }
      } catch (error) {
        this.log(`Could not keep the Reference Shot copies: ${describe3(error)}`);
      } finally {
        this.busy = false;
      }
    }
    /** Writes what a slot is to hold to its key, and tells Skins of its Recipe once it is written. */
    async keep(slot, copy) {
      const head = copy && { version: copy.version, recipe: copy.recipe, ...copy.tooLarge === true && { tooLarge: true } };
      try {
        const data = head === null ? EMPTY : head.tooLarge ? JSON.stringify(head) : `${JSON.stringify(head)}
${JSON.stringify(copy?.reference ?? null)}`;
        await this.storage.write(key(slot), data, `the Reference Shot copy of Recipe Slot ${slot}`);
      } catch (error) {
        this.slots.delete(slot);
        if (!this.stopped) this.log(`Could not keep the Reference Shot copy of Recipe Slot ${slot}: ${describe3(error)}`);
        return;
      }
      if (head === null) this.slots.delete(slot);
      else {
        this.slots.set(slot, head);
        this.changed(head.recipe);
      }
    }
    /**
     * The tablet's copy of the Recipe's reference, for a Recipe in a slot whose
     * copy it holds: its Reference Shot, or that it has none. Undefined for
     * any other Recipe, for one whose reference was too large to keep, and
     * where the copy can't be read.
     */
    async read(recipeId) {
      await this.settled();
      for (const [slot, head] of this.slots) {
        if (head.recipe.id !== recipeId) continue;
        if (head.tooLarge) return void 0;
        try {
          const value = await this.storage.read(key(slot), `a read of the Reference Shot copy of Recipe Slot ${slot}`);
          const [first, second] = typeof value === "string" ? value.split("\n") : [];
          if (first === void 0 || second === void 0 || headOf(first)?.version !== head.version) return void 0;
          return { recipe: head.recipe, reference: JSON.parse(second) };
        } catch (error) {
          if (!this.stopped) this.log(`Could not read the Reference Shot copy of Recipe Slot ${slot}: ${describe3(error)}`);
          return void 0;
        }
      }
      return void 0;
    }
    /** The plugin unloads: nothing more is kept or told. A write under way still lands (storage.ts). */
    stop() {
      this.stopped = true;
    }
    /** Resolves once what the keys hold is read and every copy that has come is kept. */
    async settled() {
      await this.load();
      await this.keeping;
    }
  };
  function headOf(value) {
    if (typeof value !== "string") return null;
    try {
      const head = JSON.parse(value.split("\n", 1)[0] ?? "");
      if (typeof head !== "object" || head === null) return null;
      const { version, recipe, tooLarge } = head;
      if (typeof version !== "string" || version === "" || typeof recipe !== "object" || recipe === null || typeof recipe.id !== "string") return null;
      return { version, recipe, ...tooLarge === true && { tooLarge: true } };
    } catch {
      return null;
    }
  }
  function describe3(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/skin-api.ts
  var STATUS_ENDPOINT = "status";
  var SHOTS_ENDPOINT = "shots";
  var SHOT_ENDPOINT = "shot";
  var REFERENCE_ENDPOINT = "reference";
  var CHANGES_ENDPOINT = "changes";
  var MAX_ASKED_LENGTH = 2048;
  var REFUSALS = {
    unreachable: { status: 503, message: "The Decent Sync server can't be reached from this tablet right now." },
    captureOnly: {
      status: 409,
      message: "This Machine is a Capture-only Machine: it is at no Location, or its sharing is off, so it takes no part in the Library."
    },
    hardwareMismatch: {
      status: 409,
      message: "The machine connected to this tablet is not the one this tablet's token was issued for, so the server serves it nothing until an Admin settles which Machine it is."
    },
    noSuchShot: { status: 404, message: "No Shot at this Machine's Location has that id." },
    noSuchRecipe: { status: 404, message: "No DYE2 recipe on this tablet with that id is a Recipe of this Machine's Location." },
    notAtThisLocation: { status: 403, message: "That Recipe belongs to another Location than this Machine's, so its Reference Shot can't be chosen on this tablet." },
    archived: { status: 409, message: "That Recipe is Archived. Its Reference Shot can be chosen once it is restored." },
    recipesUnread: { status: 500, message: "DYE2's recipes can't be read on this tablet right now." },
    // Each says what Decaid answered in a sentence of its own (`editShot`).
    shotUnwritten: { status: 500, message: "Decaid didn't take the edit of this tablet's own Shot." },
    // Each says what is wrong with it in a sentence of its own (`invalid`).
    invalidRequest: { status: 400, message: "The request is not one this endpoint answers." }
  };
  function answerSkin(request2, requests, references) {
    switch (request2.endpoint) {
      case STATUS_ENDPOINT:
        return answerStatus(request2, requests);
      case SHOTS_ENDPOINT:
        return answerShots(request2, requests);
      case SHOT_ENDPOINT:
        return answerShot(request2, requests);
      case REFERENCE_ENDPOINT:
        return answerReference(request2, requests, references);
      default:
        return void 0;
    }
  }
  async function answerStatus(request2, requests) {
    if (request2.method !== "GET") return methodNotAllowed("GET");
    const asked = await ask2(requests, { ask: "status" });
    const unanswered = { connected: requests?.connected ?? false, served: false, machine: null, location: null };
    if ("unanswered" in asked) return refusal(asked.unanswered, unanswered);
    if (asked.answer.ask !== "status") return refusal("unreachable", unanswered);
    const { served, notServed, machine, location } = asked.answer.result;
    const status = { connected: true, served, machine, location };
    return notServed === void 0 ? json(200, status) : refusal(notServed, status);
  }
  async function answerShots(request2, requests) {
    if (request2.method !== "GET") return methodNotAllowed("GET");
    const { limit, cursor } = request2.query;
    if (limit !== void 0 && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= MAX_SHOTS_PAGE)) {
      return invalid2(`Give limit as a whole number from 1 to ${MAX_SHOTS_PAGE}.`);
    }
    if (cursor !== void 0 && !askable(cursor)) return refused2("invalidCursor");
    return answered2(await ask2(requests, { ask: "shots", limit: limit === void 0 ? MAX_SHOTS_PAGE : Number(limit), ...cursor !== void 0 && { cursor } }));
  }
  async function answerShot(request2, requests) {
    if (request2.method === "PUT") return editShot(request2, requests);
    if (request2.method !== "GET") return methodNotAllowed("GET", "PUT");
    const { id } = request2.query;
    if (!askable(id) || id === "") return invalid2(NAME_THE_SHOT);
    return answered2(await ask2(requests, { ask: "shot", shotId: id }));
  }
  var NAME_THE_SHOT = "Give the Shot's id as id.";
  async function editShot(request2, requests) {
    const { id } = request2.query;
    if (!askable(id) || id === "") return invalid2(NAME_THE_SHOT);
    const fields = readEdit(request2.body);
    if (typeof fields === "string") return invalid2(fields);
    const annotations = { ...fields.rating !== void 0 && { enjoyment: fields.rating }, ...fields.note !== void 0 && { espressoNotes: fields.note } };
    let held;
    try {
      held = await request("PUT", `/shots/${encodeURIComponent(id)}`, { annotations });
    } catch (error) {
      return refusal("shotUnwritten", {}, `Decaid didn't answer the edit of this tablet's own Shot: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (held.status === 404) return answered2(await ask2(requests, { ask: "editShot", shotId: id, ...fields }));
    if (!held.ok) return refusal("shotUnwritten", {}, `Decaid refused the edit of this tablet's own Shot (${held.status}).`);
    try {
      return json(200, shotRatingAndNote(JSON.parse(held.text)));
    } catch {
      return refusal("shotUnwritten", {}, "Decaid took the edit of this tablet's own Shot, and answered with no Shot to read it from.");
    }
  }
  function readEdit(body) {
    const NOTHING_TO_SET = "Give the Shot's rating, its note or both in a JSON body.";
    if (typeof body !== "object" || body === null || Array.isArray(body)) return NOTHING_TO_SET;
    const { rating, note, ...others } = body;
    const other = Object.keys(others)[0];
    if (other !== void 0) return `Only a Shot's rating and note can be set: ${JSON.stringify(other.slice(0, 40))} is neither.`;
    if (rating !== void 0 && !isShotRating(rating)) return `Give rating as a number from 0 to ${MAX_SHOT_RATING}, where 0 is unrated.`;
    if (note !== void 0 && !(isShotNote(note) && note.length <= MAX_SKIN_NOTE_LENGTH)) {
      return `Give note as text of at most ${MAX_SKIN_NOTE_LENGTH} characters, where empty is none, without a NUL or an unpaired surrogate.`;
    }
    if (rating === void 0 && note === void 0) return NOTHING_TO_SET;
    return { ...rating !== void 0 && { rating }, ...note !== void 0 && { note } };
  }
  async function answerReference(request2, requests, references) {
    if (request2.method === "PUT") return chooseReference(request2, requests);
    if (request2.method !== "GET") return methodNotAllowed("GET", "PUT");
    const { recipe } = request2.query;
    if (!askable(recipe) || recipe === "") return invalid2(NAME_THE_RECIPE);
    const recipeId = await recipeIdOf(recipe);
    if (recipeId === void 0) return refusal("recipesUnread");
    if (recipeId === null) return refusal("noSuchRecipe");
    const asked = await ask2(requests, { ask: "reference", recipeId });
    if (!("unanswered" in asked)) return "refused" in asked.answer ? refused2(asked.answer.refused) : json(200, { ...asked.answer.result, source: "server" });
    const copy = await references?.read(recipeId);
    return copy ? json(200, { ...copy, source: "tablet" }) : refusal(asked.unanswered);
  }
  async function chooseReference(request2, requests) {
    const { recipe } = request2.query;
    if (!askable(recipe) || recipe === "") return invalid2(NAME_THE_RECIPE);
    const shotId = typeof request2.body === "object" && request2.body !== null ? request2.body.shotId : void 0;
    if (!askable(shotId) || shotId === "") return invalid2("Give the Shot's id as shotId in a JSON body. A tablet can't clear a Reference Shot.");
    const recipeId = await recipeIdOf(recipe);
    if (recipeId === void 0) return refusal("recipesUnread");
    if (recipeId === null) return refusal("noSuchRecipe");
    const asked = await ask2(requests, { ask: "chooseReference", recipeId, shotId });
    if ("unanswered" in asked) return refusal(asked.unanswered);
    if (!("refused" in asked.answer)) return json(200, { ...asked.answer.result, source: "server" });
    return asked.answer.refused === "noSuchShot" ? refusal("noSuchShot", {}, "No Shot this tablet may read whole has that id.") : refused2(asked.answer.refused);
  }
  var NAME_THE_RECIPE = "Give the id of the Recipe's DYE2 record on this tablet as recipe.";
  async function recipeIdOf(recordId) {
    const reading = await readCollection(`/store/${DYE2_NAMESPACE}/recipes`, null, true);
    const records = reading.kind === "value" ? dye2Records(reading.value) : null;
    return records === null ? void 0 : dye2GlobalIdOf(records.find((record3) => record3.id === recordId));
  }
  function askable(value) {
    return typeof value === "string" && value.length <= MAX_ASKED_LENGTH;
  }
  function ask2(requests, question) {
    return requests ? requests.ask(question) : Promise.resolve({ unanswered: "unreachable" });
  }
  function answered2(asked) {
    if ("unanswered" in asked) return refusal(asked.unanswered);
    return "refused" in asked.answer ? refused2(asked.answer.refused) : json(200, asked.answer.result);
  }
  function refused2(code) {
    return code === "invalidCursor" ? invalid2("Give cursor as the nextCursor of the page before, or leave it out for the first page.") : refusal(code);
  }
  function refusal(code, body = {}, message = REFUSALS[code].message) {
    return json(REFUSALS[code].status, { ...body, code, message });
  }
  function invalid2(message) {
    return refusal("invalidRequest", {}, message);
  }
  function methodNotAllowed(...allowed) {
    const error = `Only ${allowed.join(" and ")} ${allowed.length === 1 ? "is" : "are"} answered`;
    return { ...json(405, { error }), headers: { "Content-Type": "application/json", Allow: allowed.join(", ") } };
  }
  function json(status, body) {
    return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }
  function tellReference(host, log, recipe) {
    try {
      host.emit(CHANGES_ENDPOINT, { what: "reference", recipe });
    } catch (error) {
      log(`Could not tell Skins that a Recipe's Reference Shot changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function tellBatch(host, log, batch) {
    try {
      host.emit(CHANGES_ENDPOINT, { what: "batch", batch });
    } catch (error) {
      log(`Could not tell Skins that a Bean Batch was archived or brought back: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function tellConnection(host, log, connected) {
    try {
      host.emit(CHANGES_ENDPOINT, { what: "connection", connected });
    } catch (error) {
      log(`Could not tell Skins that the connection to the server ${connected ? "came" : "went"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // src/skin-requests.ts
  var FOLLOWS_REPORTS = { status: false, shots: true, shot: true, reference: true, chooseReference: true, editShot: false };
  var SKIN_REQUEST_MS = 1e4;
  var SkinRequests = class {
    constructor(outbox) {
      __publicField(this, "outbox", outbox);
      /** The welcomed connection, with the wire revision its server's welcome gave. */
      __publicField(this, "connection");
      /** The requests awaiting an answer, by id, each with what settles it. */
      __publicField(this, "pending", /* @__PURE__ */ new Map());
    }
    /** Whether the plugin holds a connection the server welcomed. */
    get connected() {
      return this.connection !== void 0;
    }
    /** The server welcomed a connection, whose `send` sends a request on it. */
    welcomed(send) {
      this.connection = { send };
    }
    /** The connection closed: its requests have no answer to come. */
    disconnected() {
      this.connection = void 0;
      for (const settle of [...this.pending.values()]) settle({ unanswered: "unreachable" });
    }
    /** The server answered a request; an answer to none awaited, as one that came too late, is dropped. */
    answered(answer) {
      this.pending.get(answer.id)?.({ answer });
    }
    /** Asks the server `question`, and resolves with its answer or why there is none. It never rejects. */
    ask(question) {
      const connection = this.connection;
      if (!connection) return Promise.resolve({ unanswered: "unreachable" });
      const id = this.outbox.nextId();
      return new Promise((resolve) => {
        let giveUp = () => {
        };
        const settle = (asked) => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          giveUp();
          resolve(asked);
        };
        const timer = setTimeout(() => settle({ unanswered: "unreachable" }), SKIN_REQUEST_MS);
        this.pending.set(id, settle);
        const send = () => void connection.send({ type: "request", id, ...question }).catch(() => settle({ unanswered: "unreachable" }));
        if (!FOLLOWS_REPORTS[question.ask]) return send();
        giveUp = this.outbox.whenDelivered((delivered) => {
          if (!delivered) return settle({ unanswered: "unreachable" });
          if (this.pending.has(id)) send();
        });
      });
    }
  };

  // src/skins.ts
  var SKIN_ENDPOINT = "skin";
  var CHANGED_ENDPOINT = "changed";
  var SKIN_ANSWER = { version: 1, surfaces: [], live: { endpoint: CHANGED_ENDPOINT } };
  var WORKFLOW_CHANGED = { what: "workflow" };
  function answerHttp(request2) {
    if (request2.endpoint !== SKIN_ENDPOINT) return json2(404, { error: "Not found" });
    if (request2.method !== "GET") return { ...json2(405, { error: "Only GET is answered" }), headers: { "Content-Type": "application/json", Allow: "GET" } };
    return json2(200, SKIN_ANSWER);
  }
  function json2(status, body) {
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
      listPosted: (key2) => {
        if (key2 === "recipes") push("DYE2's recipes");
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
    async read(key2, what) {
      const answer = await this.run({ type: "read", key: key2 }, what, "storageRead", (payload) => {
        return typeof payload === "object" && payload !== null && payload.key === key2;
      });
      return answer.value ?? null;
    }
    /**
     * Writes `data` at `key`, or a later write's data to the same key, made
     * while this one waited its turn. Rejects, saying why, if Decaid refuses or
     * does not answer in time; it may still have written it. While Decaid
     * leaves writes unanswered, it resolves once the write is sent.
     */
    async write(key2, data, what) {
      const queued = this.queuedWrites.get(key2);
      if (!queued || this.stopped) {
        await this.run({ type: "write", key: key2, data }, what, "storageWrite", (payload) => payload === data);
        return;
      }
      queued.command = { type: "write", key: key2, data };
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

  // src/tablet-notice.ts
  var NOTICE_ID = "sync";
  var UNREACHABLE_NOTICE_MS = 10 * 6e4;
  var SAVED = "Shots still save on this tablet and will upload later.";
  var MANAGER = "Someone who manages Decent Sync";
  var NOTICES = {
    decaidTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decaid is older than the Decent Sync server supports. ${MANAGER} can update Decaid on this tablet.`,
    pluginTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decent Sync plugin is older than the server supports. ${MANAGER} can update the plugin.`,
    tokenRefused: `${SAVED} Decent Sync stopped syncing because the server refused the token in this plugin's settings. ${MANAGER} can enter this machine's current token there.`,
    hardwareDismissed: `${SAVED} Decent Sync stopped syncing because an Admin dismissed the espresso machine connected to this tablet for the token in this plugin's settings. ${MANAGER} can give this machine a token of its own.`,
    anotherTablet: `${SAVED} Decent Sync stopped syncing because another tablet is connected with this machine's token, and it starts again once that tablet disconnects. ${MANAGER} can check which tablet should use the token.`,
    unreachable: `${SAVED} Decent Sync has not reached its server for 10 minutes. Whoever looks after this tablet's network can check that it is online and can reach the server.`
  };
  var NAMES = {
    decaidTooOld: "Decaid is too old",
    pluginTooOld: "the plugin is too old",
    tokenRefused: "the token was refused",
    hardwareDismissed: "this hardware was dismissed",
    anotherTablet: "another tablet holds the Machine",
    unreachable: "the server is out of reach"
  };
  var TabletNotice = class {
    constructor(host, log) {
      __publicField(this, "host", host);
      __publicField(this, "log", log);
      /** The reason up now, null for none, undefined until this load has put one up or withdrawn it. */
      __publicField(this, "shown");
      /** The notices asked for whose result Decaid has not sent yet, by request id. */
      __publicField(this, "pending", /* @__PURE__ */ new Map());
      /** The last notice asked for, and the reason this load had put up before it, if any. */
      __publicField(this, "latest");
    }
    show(reason) {
      if (this.shown === reason) return;
      const replaced = this.shown;
      this.shown = reason;
      this.latest = void 0;
      try {
        const requestId = this.host.notify({ id: NOTICE_ID, message: NOTICES[reason] });
        if (typeof requestId === "string") {
          this.pending.set(requestId, reason);
          this.latest = { requestId, replaced };
        }
      } catch (error) {
        this.log(`Decaid refused the notice on the tablet that ${NAMES[reason]}: ${describe4(error)}`);
      }
    }
    /**
     * Asks Decaid to withdraw the notice, whatever this load thinks shows:
     * Decaid sends no result for a withdrawal, and one whose save fails leaves
     * the notice up, so each call asks again. Withdrawing a notice Decaid
     * doesn't hold changes and saves nothing there (`removeSource` in
     * notification_center.dart). Only while Decaid holds one it can't save
     * the removal of does each call cost a failed save and a line in Decaid's
     * log.
     */
    withdraw() {
      this.shown = null;
      this.dismiss();
    }
    dismiss() {
      try {
        this.host.dismissNotification(NOTICE_ID);
      } catch (error) {
        this.log(`Decaid refused to withdraw the notice on the tablet: ${describe4(error)}`);
      }
    }
    /** Withdraws what an earlier load may have left up, unless this load has already decided what shows. */
    settle() {
      if (this.shown === void 0) this.withdraw();
    }
    /**
     * Decaid's `notificationResult` event: a notice it did not keep is logged.
     * Where it was the last asked for and replaced one this load put up, that
     * one is withdrawn, as its reason no longer holds. What an earlier load
     * left up stays, as it may say just what this load asked for. The refused
     * notice is not asked for again.
     */
    result(payload) {
      if (typeof payload !== "object" || payload === null) return;
      const { requestId, status, reason } = payload;
      if (typeof requestId !== "string") return;
      const asked = this.pending.get(requestId);
      if (asked === void 0) return;
      this.pending.delete(requestId);
      if (status === "accepted") return;
      this.log(
        `Decaid did not keep the notice on the tablet that ${NAMES[asked]} (${typeof reason === "string" ? reason : String(status)}). It is not asked for again until what the notice should say changes.`
      );
      const latest = this.latest;
      this.latest = void 0;
      if (latest?.requestId === requestId && this.shown === asked && latest.replaced) this.dismiss();
    }
  };
  function describe4(error) {
    return error instanceof Error ? error.message : String(error);
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
    [CLOSE_CODES.bad_token, { log: "The server refused the token. Enter the token shown when the machine entry was created, or a newly issued one.", notice: "tokenRefused" }],
    [CLOSE_CODES.plugin_too_old, { log: "The server needs a newer version of this plugin. Update the plugin.", notice: "pluginTooOld" }],
    [CLOSE_CODES.decaid_too_old, { log: "The server needs a newer version of Decaid. Update Decaid on this tablet.", notice: "decaidTooOld" }]
  ]);
  var YIELDING_CLOSES = /* @__PURE__ */ new Map([
    [
      CLOSE_CODES.replaced,
      `Another tablet connected with this Machine's token and took over. Connecting again in ${YIELD_MS / 1e3} s, unless that tablet is still connected then.`
    ],
    [CLOSE_CODES.machine_held, `Another tablet is still connected with this Machine's token. Trying again in ${YIELD_MS / 1e3} s.`]
  ]);
  var SyncConnection = class {
    constructor(host, settings, log, notice, pages) {
      __publicField(this, "host", host);
      __publicField(this, "settings", settings);
      __publicField(this, "log", log);
      __publicField(this, "notice", notice);
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
      /** Carries out the Settings Edits the server asks for, one at a time, between reads of the settings collections. */
      __publicField(this, "settingsEdits");
      /** Carries out the Software Actions the server asks for, one at a time, in the Settings Edits' queue (ADR-0034). */
      __publicField(this, "softwareActions");
      /** Stops reporting each page a Skin reports, as the connection stops. */
      __publicField(this, "stopPageReports");
      /** Writes the edits of Shots made through the server into the Shots the tablet holds, one at a time (ADR-0031). */
      __publicField(this, "shotEdits", new ShotEdits());
      /** Whether the Machine is pulling a Shot, which the plugin's writes into the Workflow, and the server's changes, wait out. */
      __publicField(this, "shot", new ShotGate());
      /** Whether the Machine runs nothing, which the reads of its own settings and sensor calibration wait for. */
      __publicField(this, "activity", new MachineActivity(this.shot));
      /** Streams Decaid's live frames while the server asks, for the Live View (ADR-0024), opening Decaid's sockets meanwhile. */
      __publicField(this, "liveView");
      /** This tablet's id, read from Decaid's plugin storage before the first connection and sent in every `hello`. */
      __publicField(this, "tabletId");
      /** What the plugin asks the server for a Skin, each request on the connection welcomed as it is made (ADR-0030). */
      __publicField(this, "skinRequests");
      /** The copies the tablet keeps of its Location's Recipes' Reference Shots, which the server sends (ticket #510). */
      __publicField(this, "references");
      __publicField(this, "checkingHardware", false);
      __publicField(this, "hardwareCooldown", false);
      this.storage = new PluginStorage(host);
      useLocalApi(host);
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
      const localTransports = {
        send: (handle, data) => this.host.transport.send(handle, { type: "text", data }),
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
      };
      this.loadedRecipes = new LoadedRecipes(
        {
          hold: () => this.machineEvents.hold(),
          release: () => this.machineEvents.release(),
          wrote: (write) => this.machineEvents.wrote(write),
          dye2Absent: (absent) => this.machineEvents.dye2Absent(absent)
        },
        library,
        log,
        localTransports,
        settings.pollSeconds * 1e3,
        this.shot,
        this.storage,
        () => this.collections.readRecipes(),
        () => this.collections.recipesNow(),
        skins.workflowWritten
      );
      this.machineEvents = new MachineEvents(
        this.outbox,
        (workflow) => this.loadedRecipes.observe(workflow),
        () => this.collections.readMachineSettings(),
        (state) => {
          this.shot.state(state);
          this.activity.state(state);
        }
      );
      const settingsAccess = new SettingsAccess();
      const softwareAccess = new SettingsAccess();
      this.collections = new CollectionCapture(
        this.outbox,
        library,
        settingsAccess,
        settings.pollSeconds * 1e3,
        this.activity,
        (value) => this.loadedRecipes.sawRecipes(value),
        softwareAccess,
        () => pages.latest()
      );
      this.stopPageReports = pages.onReport(() => this.collections.reportSkinPage());
      this.settingsEdits = new SettingsEdits(settingsAccess, this.outbox, this.collections, log);
      this.softwareActions = new SoftwareActions(softwareAccess, this.outbox, this.collections, this.storage, localTransports, log, pages);
      this.writes = new LibraryWrites(
        library,
        this.outbox,
        this.loadedRecipes,
        () => {
          if (this.sentHardware !== null) this.machineAway = true;
        },
        log,
        skins,
        this.shot,
        (batch) => tellBatch(host, log, batch)
      );
      this.tabletId = new TabletId(this.storage, log);
      this.liveView = new LiveView(log, localTransports, findMilkProbe);
      this.skinRequests = new SkinRequests(this.outbox);
      this.references = new ReferenceCopies(this.storage, log, (recipe) => tellReference(host, log, recipe));
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
      this.setTimer("softwareAction", 0, () => void this.softwareActions.resume());
    }
    /**
     * A machine state update, sent only while a machine is connected: a change
     * of state is recorded, the snapshot is streamed to the Live View while the
     * server asks, and the machine may have just reported its hardware.
     */
    stateUpdate(payload) {
      if (this.stopped) return;
      this.machineEvents.stateUpdate(payload);
      this.liveView.stateUpdate(payload);
      this.checkHardwareSoon();
    }
    workflowUpdated(payload) {
      if (!this.stopped) this.machineEvents.workflowUpdated(payload);
    }
    shotEvent(type, payload) {
      this.shots.event(type, payload);
      if (type === "shot") this.shot.shotStored();
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
      this.settingsEdits.stop();
      this.softwareActions.stop();
      this.stopPageReports();
      this.shot.stop();
      this.liveView.stop();
      this.tabletId.stop();
      this.references.stop();
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
          if (attempt === this.attempt) this.drop(describe5(error));
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
          wireRevision: WIRE_REVISION,
          token: this.settings.token,
          pluginVersion: "1.14.0",
          decaidVersion: identity.decaidVersion,
          tabletId,
          connectionId: identity.connectionId,
          machine: identity.machine,
          ...this.yielding ? { yielding: true } : {}
        });
      } catch (error) {
        if (attempt === this.attempt) this.drop(`could not connect to ${this.settings.syncUrl}: ${describe5(error)}`);
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
            this.clearTimer("unreachable");
            this.notice.show("hardwareDismissed");
            this.log(
              "The server refused this machine's hardware for this Machine's token. Not connecting until the machine reports other hardware, or another token is entered."
            );
            break;
          }
          const final = event.code === void 0 ? void 0 : FINAL_CLOSES.get(event.code);
          const yielding = event.code === void 0 ? void 0 : YIELDING_CLOSES.get(event.code);
          if (final) {
            this.log(final.log);
            this.notice.show(final.notice);
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
      const { id, index } = decoded.message;
      this.send(handle, { type: "chunkReceived", id, index }).catch((error) => {
        this.sendFailed(handle, `could not confirm a chunk: ${describe5(error)}`);
      });
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
          this.clearTimer("unreachable");
          this.notice.withdraw();
          this.log(`Connected to ${this.settings.syncUrl}`);
          if (!acceptsWireRevision(wireRevisionOf(message))) {
            this.log(
              `The server needs upgrading: it speaks wire revision ${wireRevisionOf(message)}, more than one behind this plugin's ${WIRE_REVISION}.`
            );
          }
          this.silenceMs = message.heartbeatIntervalMs * MISSED_HEARTBEATS;
          this.scheduleHeartbeat(handle, message.heartbeatIntervalMs);
          this.machineEvents.welcome();
          const serverRevision = wireRevisionOf(message);
          this.outbox.welcome(async (delivery) => {
            const sent = delivery.type === "softwareActed" && delivery.reason === "differentItem" && !peerHasWireRevision(serverRevision, SOURCE_CHANGES_WIRE_REVISION) ? { ...delivery, reason: "decaid", status: null, message: delivery.message ?? "Its source held another plugin or Skin" } : delivery;
            try {
              await this.send(handle, sent);
            } catch (error) {
              this.sendFailed(handle, "could not send a delivery");
              throw error;
            }
          });
          this.collections.sendAll();
          this.shots.welcome();
          this.steams.welcome();
          this.skinRequests.welcomed(async (request2) => {
            try {
              await this.send(handle, request2);
            } catch (error) {
              this.sendFailed(handle, "could not send a request");
              throw error;
            }
          });
          tellConnection(this.host, this.log, true);
          void this.references.welcomed(
            async (held) => {
              try {
                await this.send(handle, held);
              } catch (error) {
                this.sendFailed(handle, "could not say which Reference Shot copies the tablet holds");
                throw error;
              }
            },
            () => handle === this.handle
          );
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
        case "settingsEdit":
          void this.settingsEdits.apply(message, () => this.handle === handle && !this.stopped);
          break;
        case "softwareAction":
          void this.softwareActions.apply(message, () => this.handle === handle && !this.stopped);
          break;
        case "shotEdit":
          void this.shotEdits.apply(message, (answer) => {
            this.send(handle, answer).catch((error) => {
              this.sendFailed(handle, `could not answer an edit of a Shot: ${describe5(error)}`);
            });
          });
          break;
        case "liveStart":
          if (this.welcomed) {
            this.liveView.start((frame) => this.send(handle, frame), { bengle: this.sentHardware?.model === "Bengle" });
          }
          break;
        case "liveStop":
          this.liveView.stop();
          break;
        case "liveReceived":
          this.liveView.received(message.bytes);
          break;
        case "answer":
          this.skinRequests.answered(message);
          break;
        case "referenceCopy":
          this.references.apply(message);
          break;
        case "heartbeat":
          this.notice.withdraw();
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
            this.sendFailed(handle, `could not send a heartbeat: ${describe5(error)}`);
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
          this.shot.machineGone();
          if (this.welcomed && this.sentHardware !== null) this.machineAway = true;
          return;
        }
        if (this.dismissedHardware) {
          if (sameHardware(hardware, this.dismissedHardware)) return;
          this.dismissedHardware = null;
          this.notice.withdraw();
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
      this.clearTimer("unreachable");
      this.notice.show("anotherTablet");
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
    /**
     * Abandons the current connection or attempt, if any, and tries again after
     * the backoff delay. The server counts as out of reach from the first drop
     * since a connection was last welcomed.
     */
    drop(reason) {
      this.abandon();
      if (this.stopped) return;
      this.notice.settle();
      if (!this.timers.has("unreachable")) this.setTimer("unreachable", UNREACHABLE_NOTICE_MS, () => this.notice.show("unreachable"));
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
      this.log(`Disconnected: ${reason}. Reconnecting in ${Math.round(delay / 1e3)} s.`);
      this.setTimer("reconnect", delay, () => void this.connect());
    }
    closeHandle() {
      const handle = this.handle;
      const welcomed = this.welcomed;
      this.handle = void 0;
      this.welcomed = false;
      this.liveView.disconnected();
      this.sender?.close();
      this.sender = void 0;
      this.outbox.disconnected();
      this.skinRequests.disconnected();
      if (welcomed) tellConnection(this.host, this.log, false);
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
  function describe5(error) {
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

  // src/skin-page.ts
  var PAGE_ENDPOINT = "page";
  var CHANGES_ENDPOINT2 = "changes";
  var RELOAD = { what: "reload" };
  var MAX_AHEAD_MS = 6e4;
  var LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
  var INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  var SkinPages = class {
    constructor(host, log) {
      __publicField(this, "host", host);
      __publicField(this, "log", log);
      __publicField(this, "page", null);
      __publicField(this, "listeners", /* @__PURE__ */ new Set());
    }
    /** The page last reported in this load, or null. */
    latest() {
      return this.page;
    }
    /** Calls `listener` with each page reported from now on, until the function it returns is called. */
    onReport(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    /**
     * Answers a request to `page`, or undefined for any other endpoint. A PUT
     * of `{ skinId, version, loadedAt }` is kept, stamped with when it was
     * heard, and answered 204; a body of another shape 400, saying what is
     * wrong with it; any other method 405. A page reported from another
     * device than the Tablet, by its `Host`, is answered 204 and not kept.
     */
    answer(request2) {
      if (request2.endpoint !== PAGE_ENDPOINT) return void 0;
      if (request2.method !== "PUT") return { ...json3(405, { error: "Only PUT is answered" }), headers: { "Content-Type": "application/json", Allow: "PUT" } };
      const body = request2.body;
      const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};
      const problems = [
        ...typeof fields.skinId === "string" && fields.skinId !== "" && fields.skinId.length <= MAX_SOFTWARE_NAME_LENGTH ? [] : ["Give skinId, the Skin's id as Decaid's Skin list names it"],
        ...fields.version === void 0 || fields.version === null || typeof fields.version === "string" && fields.version.length <= MAX_SOFTWARE_NAME_LENGTH ? [] : ["Give version as text, or leave it out"],
        ...isLoadTime(fields.loadedAt) ? [] : ["Give loadedAt, when the page loaded, as an ISO 8601 time such as new Date(performance.timeOrigin).toISOString() gives"]
      ];
      if (problems.length > 0) return json3(400, { code: "invalidRequest", message: problems.join(". ") + "." });
      if (!fromTablet(request2.headers)) return { status: 204, headers: {}, body: "" };
      const page = {
        skinId: fields.skinId,
        ...typeof fields.version === "string" && fields.version !== "" ? { version: fields.version } : {},
        loadedAt: new Date(Date.parse(fields.loadedAt)).toISOString(),
        reportedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.page = page;
      for (const listener of [...this.listeners]) {
        try {
          listener(page);
        } catch (error) {
          this.log(`Could not take in a Skin's page report: ${describe6(error)}`);
        }
      }
      return { status: 204, headers: {}, body: "" };
    }
    /** Asks the Skins listening on `changes` to load their page again. Throws if Decaid refuses the push. */
    askReload() {
      this.host.emit(CHANGES_ENDPOINT2, RELOAD);
    }
  };
  function fromTablet(headers) {
    const host = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "host")?.[1];
    return typeof host === "string" && LOCAL_HOST.test(host.trim());
  }
  function isLoadTime(value) {
    if (typeof value !== "string" || !INSTANT.test(value)) return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= Date.now() + MAX_AHEAD_MS;
  }
  function json3(status, body) {
    return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }
  function describe6(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/index.ts
  function createPlugin(host) {
    let connection;
    const log = (message) => host.log(message);
    const notice = new TabletNotice(host, log);
    const pages = new SkinPages(host, log);
    return {
      id: "decent-sync.reaplugin",
      version: "1.14.0",
      onLoad(settings) {
        host.log(`Decent Sync ${"1.14.0"} loaded (protocol ${PROTOCOL_VERSION})`);
        const read = readSettings(settings ?? {});
        if (!read.ok) {
          host.log(`Not connecting: ${read.problems.join("; ")}. Enter them in this plugin's settings.`);
          notice.withdraw();
          return;
        }
        connection = new SyncConnection(host, read.settings, log, notice, pages);
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
        if (event?.name === "notificationResult") notice.result(event.payload);
      },
      // Answered whether or not the plugin connects: a skin asks every loaded plugin, and a Skin asking what the server
      // holds is told the server can't be reached.
      __httpRequestHandler: (request2) => pages.answer(request2) ?? answerSkin(request2, connection?.skinRequests, connection?.references) ?? answerHttp(request2)
    };
  }
  return __toCommonJS(index_exports);
})();
var createPlugin = __decentSync.createPlugin;
