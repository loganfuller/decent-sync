import { Injectable } from "@nestjs/common";
import type { ErrorCode } from "@decent-sync/protocol";
import type { Hardware } from "../sync/identity.js";

/** A plugin connection this server instance welcomed. */
export interface LiveConnection {
  /** Written to its Machine's row while it holds the Machine. */
  sessionId: string;
  machineId: string;
  /** The SHA-256 hash of its token, to check the token is still current. */
  tokenHash: Uint8Array<ArrayBuffer>;
  /** For a mismatch, the hardware reported, to check it has not been dismissed for this token. */
  mismatch: Hardware | null;
  /** The record of its tablet against whoever it resolved to, which its heartbeats keep seen. */
  machineTabletId: bigint;
  /** Sends the plugin an `error` with this code, then closes with its close code. */
  end(code: ErrorCode, message: string): void;
}

/**
 * The connections this server instance holds. Other instances hold others:
 * whether a Machine is online, and which connection holds it, is stored on
 * its row, and changes that may end a connection reach every instance as
 * notifications (AccessChanges).
 */
@Injectable()
export class LiveConnections {
  private readonly byMachine = new Map<string, Set<LiveConnection>>();

  add(connection: LiveConnection): void {
    const connections = this.byMachine.get(connection.machineId) ?? new Set();
    connections.add(connection);
    this.byMachine.set(connection.machineId, connections);
  }

  delete(connection: LiveConnection): void {
    const connections = this.byMachine.get(connection.machineId);
    connections?.delete(connection);
    if (connections?.size === 0) this.byMachine.delete(connection.machineId);
  }

  /** This instance's connections for one Machine, or for every Machine. */
  of(machineId: string | null): LiveConnection[] {
    if (machineId !== null) return [...(this.byMachine.get(machineId) ?? [])];
    return [...this.byMachine.values()].flatMap((connections) => [...connections]);
  }
}
