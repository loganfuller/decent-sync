import { Injectable } from "@nestjs/common";
import type { ErrorCode } from "@decent-sync/protocol";
import type { Hardware } from "../sync/identity.js";

/** A plugin connected with a Machine's token, as the sync gateway welcomed it. */
export interface LiveConnection {
  /** The real hardware its `hello` reported, if any. */
  hardware: Hardware | null;
  /** Sends the plugin an `error` with this code, then closes with its close code. */
  end(code: ErrorCode, message: string): void;
}

/**
 * Which Machines have a plugin connected right now, and that connection. The
 * sync gateway keeps it; it lives in memory because one server instance holds
 * every connection (ADR-0011), so a restarted server rightly starts with every
 * Machine offline.
 */
@Injectable()
export class Presence {
  private readonly connections = new Map<string, LiveConnection>();

  isOnline(machineId: string): boolean {
    return this.connections.has(machineId);
  }

  /** Makes this the Machine's connection, returning the one it replaces. */
  connect(machineId: string, connection: LiveConnection): LiveConnection | undefined {
    const previous = this.connections.get(machineId);
    this.connections.set(machineId, connection);
    return previous;
  }

  /**
   * Forgets the connection if it is still the Machine's, and says whether it
   * was: a connection replaced by a newer one closes without taking the
   * Machine offline.
   */
  disconnect(machineId: string, connection: LiveConnection): boolean {
    if (this.connections.get(machineId) !== connection) return false;
    this.connections.delete(machineId);
    return true;
  }

  /** Ends the Machine's connection, if it has one and `which` accepts it. */
  end(machineId: string, code: ErrorCode, message: string, which: (connection: LiveConnection) => boolean = () => true): void {
    const connection = this.connections.get(machineId);
    if (connection && which(connection)) connection.end(code, message);
  }
}
