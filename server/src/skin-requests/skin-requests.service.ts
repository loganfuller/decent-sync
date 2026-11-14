import { Injectable } from "@nestjs/common";
import type { SkinAnswer, SkinRequest, SkinStatus } from "@decent-sync/protocol";
import { PrismaService } from "../prisma.service.js";
import type { Identity } from "../sync/identity.js";

// What a plugin asks the server for a Skin on its tablet (ADR-0030,
// milestone 8). A Skin calls an HTTP endpoint of the plugin's, the plugin
// sends a `request` over its connection, and the sync gateway has it
// answered here, in its turn among the connection's frames, so after the
// deliveries that arrived before it are stored. A request is never stored or
// remembered: each is read afresh and answered once.
//
// Only a Machine that takes part in the Library is served: one at a
// Location, with sharing on, connected as itself. That is where the tablet
// writer writes (`tabletDue` in library/tablet-due.ts, and the gateway, which
// gives a mismatched connection no writer). `status` says so, and why not.

/** The connection a request arrived on: its token's Machine, and who its tablet is, as its hello settled it. */
export interface AskingConnection {
  machineId: string;
  identity: Identity;
}

@Injectable()
export class SkinRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Answers a request, as things stand now. */
  async answer(connection: AskingConnection, request: SkinRequest): Promise<SkinAnswer> {
    switch (request.ask) {
      case "status":
        return { type: "answer", id: request.id, ask: "status", result: await this.status(connection) };
    }
  }

  /**
   * Whether the connection's Machine is served, with its Machine and the
   * Location it is at now. A mismatched connection reports hardware that is
   * a Pending Machine's or another Machine's, so it is not its token's
   * Machine's own: it is told so, and named neither.
   */
  private async status({ machineId, identity }: AskingConnection): Promise<SkinStatus> {
    if (identity.kind === "mismatch") return { served: false, notServed: "hardwareMismatch", machine: null, location: null };
    const [machine] = await this.prisma.$queryRaw<{ name: string; sharing: boolean; locationId: string | null; locationName: string | null }[]>`
      SELECT machines.name, machines.sharing, locations.id AS "locationId", locations.name AS "locationName"
      FROM machines
      LEFT JOIN LATERAL (
        SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
      ) AS latest ON true
      LEFT JOIN locations ON locations.id = latest.location_id
      WHERE machines.id = ${machineId}::uuid`;
    // A machine entry is never deleted.
    if (!machine) throw new Error(`Machine ${machineId} of a welcomed connection is gone`);
    const location = machine.locationId === null || machine.locationName === null ? null : { id: machine.locationId, name: machine.locationName };
    const served = machine.sharing && location !== null;
    return { served, ...(served ? {} : { notServed: "captureOnly" as const }), machine: { id: machineId, name: machine.name }, location };
  }
}
