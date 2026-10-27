import net from "node:net";
import { adminDatabaseUrl } from "./test-server.js";

// Stands in for the network between a server under test and the PostgreSQL
// server tests use (`adminDatabaseUrl()`), so a test can take the database
// away, as a failover to the replica does, and bring it back (ADR-0025):
//
// - `cut()` resets every connection through it and refuses new ones, as a
//   database restarting does;
// - `silence()` relays nothing more on the connections open and accepts new
//   ones but never answers them, closing nothing, as a primary that vanished
//   does;
// - `resetConnections()` resets the connections open, and changes nothing
//   for new ones. While silenced, it stands in for the server's TCP
//   keepalive giving up on its idle connections, which a proxy in the
//   server's own process can't show, as its socket answers the probes
//   itself;
// - `restore()` relays new connections again. Connections it silenced stay
//   silent, as a vanished primary's do, until their client closes them.

export interface OutageProxy {
  /** The host and port to connect to instead of PostgreSQL's. */
  host: string;
  cut(): void;
  silence(): void;
  resetConnections(): void;
  restore(): void;
  close(): Promise<void>;
}

interface Relay {
  client: net.Socket;
  upstream?: net.Socket;
  silent: boolean;
}

export async function startOutageProxy(): Promise<OutageProxy> {
  const database = new URL(adminDatabaseUrl());
  const target = { host: database.hostname, port: Number(database.port || 5432) };
  let mode: "relaying" | "refusing" | "silent" = "relaying";
  const relays = new Set<Relay>();
  const reset = (relay: Relay) => {
    relay.client.resetAndDestroy();
    relay.upstream?.destroy();
  };

  const server = net.createServer((client) => {
    if (mode === "refusing") return void client.resetAndDestroy();
    const relay: Relay = { client, silent: mode === "silent" };
    relays.add(relay);
    client.on("error", () => client.destroy());
    client.on("close", () => {
      relays.delete(relay);
      relay.upstream?.destroy();
    });
    // Accepted, as by a host that answers nothing more.
    if (relay.silent) return;
    const upstream = net.connect(target);
    relay.upstream = upstream;
    upstream.on("error", () => upstream.destroy());
    // A vanished primary closes nothing.
    upstream.on("close", () => {
      if (!relay.silent) client.destroy();
    });
    client.on("data", (chunk: Buffer) => {
      if (!relay.silent) upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (!relay.silent) client.write(chunk);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    cut: () => {
      mode = "refusing";
      for (const relay of relays) reset(relay);
    },
    silence: () => {
      mode = "silent";
      for (const relay of relays) relay.silent = true;
    },
    resetConnections: () => {
      for (const relay of relays) reset(relay);
    },
    restore: () => {
      mode = "relaying";
    },
    close: async () => {
      for (const relay of relays) reset(relay);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
