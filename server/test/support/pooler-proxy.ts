import net from "node:net";
import { adminDatabaseUrl } from "./test-server.js";

// Stands in for a connection pooler such as PgBouncer in session mode, between
// a server under test and the PostgreSQL server named by DATABASE_URL: each
// connection gets a PostgreSQL session of its own. As PgBouncer does by
// default, it refuses startup parameters it does not track. It records the
// parameters each connection sent, and asks each new session for its
// idle_in_transaction_session_timeout before handing it to the client.

/**
 * What PgBouncer 1.26 accepts at startup unless told to ignore others
 * (`ignore_startup_parameters`): the user and database, and the settings it
 * tracks by default, including those it tracks only from a later PostgreSQL
 * version (`scram_iterations`, `search_path`).
 */
const TRACKED_PARAMETERS = new Set([
  "user",
  "database",
  "application_name",
  "client_encoding",
  "datestyle",
  "default_transaction_read_only",
  "intervalstyle",
  "scram_iterations",
  "search_path",
  "session_authorization",
  "standard_conforming_strings",
  "timezone",
]);

const PROTOCOL_3 = 196608;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;

export interface PoolerSession {
  /** What the client sent at startup, by name. */
  parameters: Record<string, string>;
  /** As `SHOW` reports it, once PostgreSQL accepted the session. */
  idleInTransactionTimeout?: string;
}

export interface PoolerProxy {
  /** The host and port to connect to instead of PostgreSQL's. */
  host: string;
  /** Every session a client asked for, refused or not, in order. */
  sessions: PoolerSession[];
  /** The startup parameters it refused. */
  refused: Set<string>;
  /**
   * Resets every client's connection through it, as a network failure does:
   * each client's end gets a TCP reset. Clients may connect again.
   */
  resetConnections(): void;
  close(): Promise<void>;
}

export async function startPoolerProxy(): Promise<PoolerProxy> {
  const database = new URL(adminDatabaseUrl());
  const target = { host: database.hostname, port: Number(database.port || 5432) };
  const sessions: PoolerSession[] = [];
  const refused = new Set<string>();
  const sockets = new Set<net.Socket>();
  const clients = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  /**
   * Opens a PostgreSQL connection for the client, sends it what the client
   * has sent so far, and relays from then on. For a new session, it first
   * holds back PostgreSQL's first ReadyForQuery, which ends the startup,
   * until the session has answered `SHOW`; the client sends nothing until
   * then.
   */
  const relay = (client: net.Socket, sent: Buffer, session?: PoolerSession) => {
    const upstream = net.connect(target);
    track(upstream);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.write(sent);
    client.on("data", (chunk: Buffer) => upstream.write(chunk));

    let relaying = !session;
    let received = Buffer.alloc(0);
    let ready: Buffer | undefined;
    upstream.on("data", (chunk: Buffer) => {
      if (relaying) return void client.write(chunk);
      received = Buffer.concat([received, chunk]);
      while (received.length >= 5 && received.length >= 1 + received.readInt32BE(1)) {
        const type = String.fromCharCode(received[0]!);
        const message = received.subarray(0, 1 + received.readInt32BE(1));
        received = received.subarray(message.length);
        if (!ready) {
          if (type !== "Z") {
            client.write(message);
            continue;
          }
          ready = message;
          upstream.write(query("SHOW idle_in_transaction_session_timeout"));
        } else if (type === "D") {
          session!.idleInTransactionTimeout = dataRowValue(message);
        } else if (type === "Z") {
          relaying = true;
          client.write(Buffer.concat([ready, received]));
          return;
        }
      }
    });
  };

  const server = net.createServer((client) => {
    track(client);
    clients.add(client);
    client.on("close", () => clients.delete(client));
    let received = Buffer.alloc(0);
    const onStartup = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      while (received.length >= 8 && received.length >= received.readInt32BE(0)) {
        const message = received.subarray(0, received.readInt32BE(0));
        const code = message.readInt32BE(4);
        received = received.subarray(message.length);
        // Neither TLS nor GSS encryption, as a pooler set up without them answers.
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          client.write("N");
          continue;
        }
        client.off("data", onStartup);
        // A cancel request, for a session PostgreSQL already has, goes through as it is.
        if (code !== PROTOCOL_3) return relay(client, Buffer.concat([message, received]));

        const session: PoolerSession = { parameters: startupParameters(message) };
        sessions.push(session);
        const unsupported = Object.keys(session.parameters).find((name) => !TRACKED_PARAMETERS.has(name.toLowerCase()));
        if (unsupported) {
          refused.add(unsupported);
          client.end(errorResponse("08P01", `unsupported startup parameter: ${unsupported}`));
          return;
        }
        return relay(client, Buffer.concat([message, received]), session);
      }
    };
    client.on("data", onStartup);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    sessions,
    refused,
    resetConnections: () => {
      for (const client of clients) client.resetAndDestroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function startupParameters(message: Buffer): Record<string, string> {
  const fields = message.subarray(8).toString("utf8").split("\0");
  const parameters: Record<string, string> = {};
  for (let i = 0; fields[i]; i += 2) parameters[fields[i]!] = fields[i + 1] ?? "";
  return parameters;
}

function query(sql: string): Buffer {
  return frame("Q", `${sql}\0`);
}

function errorResponse(code: string, text: string): Buffer {
  return frame("E", `SFATAL\0VFATAL\0C${code}\0M${text}\0\0`);
}

function frame(type: string, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const header = Buffer.alloc(5);
  header.write(type, 0);
  header.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** The first column of a DataRow message. */
function dataRowValue(message: Buffer): string | undefined {
  const length = message.readInt32BE(7);
  return length < 0 ? undefined : message.subarray(11, 11 + length).toString("utf8");
}
