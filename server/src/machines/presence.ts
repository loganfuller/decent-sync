import { Injectable } from "@nestjs/common";

/**
 * Which Machines have a plugin connected right now. The sync gateway keeps it;
 * it lives in memory because one server instance holds every connection
 * (ADR-0011), so a restarted server rightly starts with every Machine offline.
 */
@Injectable()
export class Presence {
  private readonly online = new Set<string>();

  isOnline(machineId: string): boolean {
    return this.online.has(machineId);
  }

  setOnline(machineId: string, online: boolean): void {
    if (online) this.online.add(machineId);
    else this.online.delete(machineId);
  }
}
