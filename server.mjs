#!/usr/bin/env node
// Decent Sync server (prototype).
//
// Accepts WebSocket connections from the decent-sync.reaplugin running on each
// machine, prints everything it receives, and keeps a central copy on disk:
//
//   data/machines/<machineId>/machine.json        latest hello
//   data/machines/<machineId>/events.jsonl        every message, append-only
//   data/machines/<machineId>/state/<name>.json   latest beans, grinders, ...
//   data/machines/<machineId>/shots/<shotId>.json every shot, with measurements
//
// Usage: node server.mjs [--full] [--verbose]
//   --full     also pretty-print each payload
//   --verbose  also show heartbeats and duplicate deliveries
// Env: PORT (8787), HOST (0.0.0.0), SYNC_TOKEN (unset = no auth), DATA_DIR (./data)

import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const SYNC_TOKEN = process.env.SYNC_TOKEN || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const FULL = process.argv.includes("--full");
const VERBOSE = process.argv.includes("--verbose");
const HELLO_TIMEOUT_MS = 10_000;
const DEDUPE_WINDOW = 10_000;

// ------------------------------------------------------------------ output

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2), bold = c(1), red = c(31), green = c(32), yellow = c(33), blue = c(34), magenta = c(35), cyan = c(36);

function ts() {
  return dim(new Date().toLocaleTimeString([], { hour12: false }));
}

function out(machine, tag, color, text) {
  const who = machine ? cyan(machine.name || machine.machineId) : dim("?");
  console.log(`${ts()} ${who} ${color(tag.padEnd(13))} ${text}`);
}

function detail(lines) {
  for (const line of lines) console.log(`           ${dim("│")} ${line}`);
}

function dump(obj) {
  if (FULL) console.log(dim(JSON.stringify(obj, null, 2)));
}

// --------------------------------------------------------------- storage

function machineDir(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(DATA_DIR, "machines", safe);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  return dir;
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function storedShotIds(dir) {
  return new Set(
    fs.readdirSync(path.join(dir, "shots"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5)),
  );
}

// ------------------------------------------------------------- summaries

function fmtNum(n, unit = "") {
  return typeof n === "number" ? `${Math.round(n * 10) / 10}${unit}` : "–";
}

function shotSummary(shot) {
  const ctx = shot.workflow?.context ?? {};
  const ann = shot.annotations ?? {};
  const m = shot.measurements ?? [];
  const t0 = Date.parse(m[0]?.machine?.timestamp);
  const t1 = Date.parse(m.at(-1)?.machine?.timestamp);
  const secs = Number.isFinite(t0) && Number.isFinite(t1) ? (t1 - t0) / 1000 : null;
  const dose = ann.actualDoseWeight ?? ctx.targetDoseWeight;
  const yld = ann.actualYield ?? m.at(-1)?.scale?.weight;
  return {
    headline:
      `${bold(shot.workflow?.profile?.title ?? "?")}  ` +
      `${fmtNum(dose, "g")} → ${fmtNum(yld, "g")} in ${fmtNum(secs, "s")}` +
      (shot.stopReason ? dim(`  (${shot.stopReason})`) : ""),
    lines: [
      `bean:    ${[ctx.coffeeRoaster, ctx.coffeeName].filter(Boolean).join(" — ") || "–"}` +
        (ctx.beanBatchId ? dim(`  batch ${ctx.beanBatchId}`) : ""),
      `grinder: ${ctx.grinderModel ?? "–"} @ ${ctx.grinderSetting ?? "–"}`,
      `when:    ${shot.timestamp}   samples: ${m.length}   id: ${shot.id}`,
      ...(ann.enjoyment != null ? [`enjoyment: ${ann.enjoyment}`] : []),
      ...(ann.espressoNotes ? [`notes: ${ann.espressoNotes}`] : []),
    ],
  };
}

const collectionFormatters = {
  beans: (b) =>
    `${b.roaster ?? "?"} — ${b.name ?? "?"}` +
    dim([b.country, b.processing, b.archived && "archived"].filter(Boolean).map((s) => `  ${s}`).join("")),
  beanBatches: (b, ctx) => {
    const bean = ctx.beans?.find((x) => x.id === b.beanId);
    const label = bean ? `${bean.roaster} — ${bean.name}` : b.beanId;
    return `${label}  roasted ${b.roastDate?.slice(0, 10) ?? "?"}` +
      dim([b.frozen && "frozen", b.archived && "archived"].filter(Boolean).map((s) => `  ${s}`).join(""));
  },
  grinders: (g) =>
    `${g.model}` + dim([g.burrs, g.burrSize && `${g.burrSize}mm`, g.burrType, g.archived && "archived"].filter(Boolean).map((s) => `  ${s}`).join("")),
  profiles: (p) => `${p.profile?.title ?? p.id}` + dim(`  ${p.profile?.author ?? ""}  ${p.visibility ?? ""}`),
};

function diffKeys(prev, next) {
  if (!prev || typeof prev !== "object") return null;
  const keys = new Set([...Object.keys(prev), ...Object.keys(next ?? {})]);
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next?.[k]));
}

// --------------------------------------------------------------- session

class Session {
  constructor(ws, remote) {
    this.ws = ws;
    this.remote = remote;
    this.machine = null;
    this.dir = null;
    this.seen = new Set();
    this.parts = new Map(); // collection -> {parts, items[]}
  }

  send(msg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  ack(env) {
    if (env.id) this.send({ type: "ack", id: env.id });
  }

  handle(env) {
    if (!this.machine) {
      if (env.type !== "hello") return this.reject("expected hello first");
      return this.hello(env);
    }
    if (env.type === "heartbeat") {
      if (VERBOSE) out(this.machine, "heartbeat", dim, dim(`outbox ${env.data?.outbox} backfill ${env.data?.backfill}`));
      return;
    }
    if (env.id && this.seen.has(env.id)) {
      if (VERBOSE) out(this.machine, "duplicate", dim, dim(`${env.type} ${env.id}`));
      return this.ack(env);
    }

    fs.appendFileSync(path.join(this.dir, "events.jsonl"), JSON.stringify({ receivedAt: new Date().toISOString(), ...env }) + "\n");

    const handler = this[`on_${env.type}`];
    if (handler) handler.call(this, env.data ?? {}, env);
    else out(this.machine, env.type, yellow, dim("(unrecognised message type)"));
    dump(env);

    this.remember(env.id);
    this.ack(env);
  }

  remember(id) {
    if (!id) return;
    this.seen.add(id);
    if (this.seen.size > DEDUPE_WINDOW) this.seen.delete(this.seen.values().next().value);
  }

  reject(reason, code = 4400) {
    out(this.machine, "rejected", red, `${this.remote}: ${reason}`);
    this.send({ type: "error", message: reason });
    this.ws.close(code, reason);
  }

  hello(env) {
    const d = env.data ?? {};
    if (SYNC_TOKEN && d.token !== SYNC_TOKEN) return this.reject("bad token", 4401);
    if (!d.machineId) return this.reject("hello without machineId");
    const { token, ...info } = d;
    this.machine = info;
    this.dir = machineDir(info.machineId);
    // Seed de-duplication from the session we may be replacing.
    for (const s of sessions) if (s !== this && s.machine?.machineId === info.machineId) {
      for (const id of s.seen) this.seen.add(id);
      s.ws.close(4409, "replaced by new connection");
    }
    writeJson(path.join(this.dir, "machine.json"), { ...info, lastSeen: new Date().toISOString(), remote: this.remote });
    out(this.machine, "connected", green,
      `${bold(info.model ?? "?")} #${info.serialNumber ?? "?"}  fw ${info.firmware ?? "?"}  ` +
      `Decaid ${info.decaidVersion ?? "?"}  plugin ${info.pluginVersion}  ${dim(`${this.remote} id=${info.machineId}`)}`);
    this.send({ type: "welcome", serverTime: new Date().toISOString() });
  }

  on_collection(d) {
    const name = d.collection;
    let value = d.value;
    if (d.parts > 1) {
      const acc = d.part === 1 || !this.parts.has(name) ? { items: [] } : this.parts.get(name);
      acc.items.push(...value);
      this.parts.set(name, acc);
      if (d.part < d.parts) {
        out(this.machine, name, blue, dim(`part ${d.part}/${d.parts} (${value.length} items)`));
        return;
      }
      this.parts.delete(name);
      value = acc.items;
    }

    const file = path.join(this.dir, "state", `${name}.json`);
    const prev = readJson(file);
    writeJson(file, value);

    if (Array.isArray(value)) {
      const prevById = new Map((Array.isArray(prev) ? prev : []).map((x) => [x.id, x]));
      const added = value.filter((x) => !prevById.has(x.id));
      const changed = value.filter((x) => prevById.has(x.id) && JSON.stringify(prevById.get(x.id)) !== JSON.stringify(x));
      const removed = [...prevById.keys()].filter((id) => !value.some((x) => x.id === id));
      out(this.machine, name, blue,
        `${value.length} items` + (prev ? dim(`  +${added.length} ~${changed.length} -${removed.length}`) : dim("  (first sync)")));
      const fmt = collectionFormatters[name];
      if (!fmt) return;
      const ctx = { beans: readJson(path.join(this.dir, "state", "beans.json")) };
      const show = prev ? [...added.map((x) => [green("+"), x]), ...changed.map((x) => [yellow("~"), x])] : value.map((x) => [" ", x]);
      const shown = name === "profiles" && !prev ? show.slice(0, 12) : show;
      detail(shown.map(([mark, x]) => `${mark} ${fmt(x, ctx)}`));
      if (shown.length < show.length) detail([dim(`… and ${show.length - shown.length} more`)]);
      if (prev && removed.length) detail(removed.map((id) => `${red("-")} ${id}`));
    } else {
      const keys = diffKeys(prev, value);
      out(this.machine, name, blue, keys ? `${keys.length} changed` : dim("(first sync)"));
      const show = keys ?? Object.keys(value ?? {});
      detail(show.map((k) => `${k}: ${JSON.stringify(value?.[k])}` + (keys ? dim(`  (was ${JSON.stringify(prev?.[k])})`) : "")));
    }
  }

  on_shotIndex(d) {
    const have = storedShotIds(this.dir);
    const missing = (d.ids ?? []).filter((id) => !have.has(id));
    out(this.machine, "shot index", magenta, `${d.ids?.length ?? 0} shots on machine, ${missing.length} not yet stored`);
    if (missing.length) this.send({ type: "requestShots", ids: missing });
  }

  on_shot(d) {
    const shot = d.shot;
    writeJson(path.join(this.dir, "shots", `${shot.id}.json`), shot);
    const s = shotSummary(shot);
    out(this.machine, d.reason === "backfill" ? "shot (backfill)" : "shot ☕", magenta, s.headline);
    detail(s.lines);
  }

  on_shotUpdated(d) {
    const file = path.join(this.dir, "shots", `${d.id}.json`);
    const stored = readJson(file);
    if (stored && d.shot) writeJson(file, { ...stored, ...d.shot, measurements: stored.measurements });
    out(this.machine, "shot edited", magenta, `${d.id}`);
    detail(Object.entries(d.patch ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`));
  }

  on_workflow(d) {
    writeJson(path.join(this.dir, "state", "workflow.json"), d);
    const ctx = d.context ?? {};
    out(this.machine, "workflow", cyan,
      `${bold(d.profile?.title ?? "?")}  ${fmtNum(ctx.targetDoseWeight, "g")} → ${fmtNum(ctx.targetYield, "g")}  ` +
      dim(`${[ctx.coffeeRoaster, ctx.coffeeName].filter(Boolean).join(" — ")}  ${ctx.grinderModel ?? ""} @ ${ctx.grinderSetting ?? ""}`));
  }

  on_machineState(d) {
    out(this.machine, "state", yellow,
      `${dim(d.from ?? "∅")} → ${bold(d.to)}  ${dim(`group ${fmtNum(d.groupTemperature, "°C")} steam ${fmtNum(d.steamTemperature, "°C")}`)}`);
  }
}

// ------------------------------------------------------------------ server

const sessions = new Set();
const wss = new WebSocketServer({ host: HOST, port: PORT, path: "/sync", maxPayload: 16 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`.replace(/^::ffff:/, "");
  const session = new Session(ws, remote);
  sessions.add(session);
  const helloTimer = setTimeout(() => session.machine || session.reject("no hello"), HELLO_TIMEOUT_MS);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let env;
    try {
      env = JSON.parse(raw.toString());
    } catch {
      return out(session.machine, "bad frame", red, dim(raw.toString().slice(0, 120)));
    }
    try {
      session.handle(env);
    } catch (e) {
      out(session.machine, "error", red, `${env.type}: ${e.stack || e}`);
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(helloTimer);
    sessions.delete(session);
    if (session.machine) out(session.machine, "disconnected", red, dim(`${code} ${reason || ""}`));
  });
  ws.on("error", (e) => out(session.machine, "socket error", red, e.message));
});

wss.on("error", (e) => {
  console.error(red(e.code === "EADDRINUSE" ? `port ${PORT} is already in use (another server running?)` : e.message));
  process.exit(1);
});

wss.on("listening", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log(bold("Decent Sync server") + dim(` — storing data in ${DATA_DIR}`));
  for (const ip of ips.length ? ips : ["localhost"]) console.log(`  listening on ${green(`ws://${ip}:${PORT}/sync`)}`);
  console.log(dim(`  auth: ${SYNC_TOKEN ? "SYNC_TOKEN required" : "none (set SYNC_TOKEN to require one)"}`));
});

process.on("SIGINT", () => {
  console.log(dim("\nshutting down"));
  for (const s of sessions) s.ws.close(1001, "server shutting down");
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
