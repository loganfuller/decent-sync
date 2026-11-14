import { Injectable } from "@nestjs/common";
import { type NotServed, type SkinAnswer, type SkinRequest, type SkinStatus } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { type AskingTablet, locationShot, locationShots } from "../shots/location-shots.js";
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
//
// And only the connection holding its Machine is answered, as only it is
// written to: each answer is read with that checked in the same statement,
// or the same snapshot, so it holds on any instance (ADR-0016).
//
// A served Machine's tablet reads its Location's Shots (ticket #509,
// shots/location-shots.ts): a page of them, and any one of them whole. A
// Machine that is not served is refused each with why `status` says it is
// not, and a served one a Shot its list does not list as no such Shot,
// whether or not the server holds it.

/** The connection a request arrived on: its session, its token's Machine, its tablet, and who that tablet is, as its hello settled it. */
export interface AskingConnection {
  sessionId: string;
  machineId: string;
  tabletId: string;
  identity: Identity;
}

@Injectable()
export class SkinRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Answers a request, as things stand now. Null where the connection no
   * longer holds its Machine, as once another hello has taken it and before
   * this instance is told: the request has no answer, and the connection is
   * to be ended.
   */
  async answer(connection: AskingConnection, request: SkinRequest): Promise<SkinAnswer | null> {
    const answer = { type: "answer", id: request.id } as const;
    switch (request.ask) {
      case "status": {
        const result = await this.status(this.prisma, connection);
        return result && { ...answer, ask: "status", result };
      }
      case "shots": {
        const outcome = await this.served(connection, async (db, asking) => {
          const result = await locationShots(db, asking, request.limit, request.cursor);
          return result ? { result } : { refused: "invalidCursor" as const };
        });
        return outcome && { ...answer, ask: "shots", ...outcome };
      }
      case "shot": {
        const outcome = await this.served(connection, async (db, asking) => {
          const result = await locationShot(db, asking, request.shotId);
          return result ? { result } : { refused: "noSuchShot" as const };
        });
        return outcome && { ...answer, ask: "shot", ...outcome };
      }
    }
  }

  /**
   * What `read` gives of the Location the connection's Machine is served
   * at, for its tablet; or, for a Machine that is not served, why it is
   * refused; or null as `answer` gives it. Whether it is served, and what is
   * read, are of one snapshot, so a Machine moved meanwhile is answered as
   * of before or after, and never with one Location's Shots as another's.
   */
  private served<T>(connection: AskingConnection, read: (db: Prisma.TransactionClient, asking: AskingTablet) => Promise<T>): Promise<T | { refused: NotServed } | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const status = await this.status(tx, connection);
        if (status === null) return null;
        if (status.notServed !== undefined || status.location === null) return { refused: status.notServed ?? "captureOnly" };
        return read(tx, { locationId: status.location.id, tabletId: connection.tabletId });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Whether the connection's Machine is served, with its Machine and the
   * Location it is at now. A mismatched connection reports hardware that is
   * a Pending Machine's or another Machine's, so it is not its token's
   * Machine's own: it is told so, and named neither.
   */
  private async status(db: Prisma.TransactionClient, { sessionId, machineId, identity }: AskingConnection): Promise<SkinStatus | null> {
    const [machine] = await db.$queryRaw<{ name: string; sharing: boolean; locationId: string | null; locationName: string | null }[]>`
      SELECT machines.name, machines.sharing, locations.id AS "locationId", locations.name AS "locationName"
      FROM machines
      LEFT JOIN LATERAL (
        SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1
      ) AS latest ON true
      LEFT JOIN locations ON locations.id = latest.location_id
      WHERE machines.id = ${machineId}::uuid AND machines.connected_session_id = ${sessionId}::uuid`;
    if (!machine) return null;
    if (identity.kind === "mismatch") return { served: false, notServed: "hardwareMismatch", machine: null, location: null };
    const location = machine.locationId === null || machine.locationName === null ? null : { id: machine.locationId, name: machine.locationName };
    const served = machine.sharing && location !== null;
    return { served, ...(served ? {} : { notServed: "captureOnly" as const }), machine: { id: machineId, name: machine.name }, location };
  }
}
