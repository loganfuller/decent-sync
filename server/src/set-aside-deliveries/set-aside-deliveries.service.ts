import { Injectable } from "@nestjs/common";
import type { CollectionDelivery, MachineStateDelivery, ShotDelivery, SteamDelivery, WorkflowDelivery } from "@decent-sync/protocol";
import type { SetAsideDelivery } from "../generated/prisma/client.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import type { StorageFailure } from "./repeating-failures.js";

/** The deliveries that store what a tablet captured, which are set aside when that fails in a way that would repeat. */
export type CaptureDelivery = ShotDelivery | SteamDelivery | WorkflowDelivery | MachineStateDelivery | CollectionDelivery;

/** A delivery set aside, as the REST API lists it: never with its message. */
export interface SetAsideDeliveryView {
  id: string;
  /** When it was set aside, by PostgreSQL's clock. */
  receivedAt: string;
  /** The message's type, such as shot or collection. */
  type: string;
  deliveryId: string;
  /** The Decaid id of a Shot's or Steam Record's; null for other deliveries. */
  recordId: string | null;
  /** PostgreSQL's error code, such as 22P05, and its message. */
  sqlState: string;
  error: string;
}

/**
 * Deliveries whose storage failed in a way that would repeat whenever they
 * were sent again (`repeatingFailure`). Each is kept as received, its JSON
 * text, and acknowledged as if stored, so it cannot hold up the deliveries
 * queued behind it on the tablet. Replaying or deleting them comes later.
 *
 * A delivery is recorded once for the Machine whose token delivered it, by
 * its delivery id, decided by PostgreSQL, so a resend reaching any
 * connection or instance adds nothing. A Shot or Steam Record set aside
 * counts as known to that Machine's indexes (`ShotsService.requested`,
 * `SteamRecordsService.requested`), so it is not requested again.
 */
@Injectable()
export class SetAsideDeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  async record(machineId: string, delivery: CaptureDelivery, message: string, failure: StorageFailure): Promise<void> {
    await this.prisma.setAsideDelivery.createMany({
      data: {
        machineId,
        deliveryId: delivery.id,
        type: delivery.type,
        recordId: recordId(delivery),
        sqlState: failure.sqlState,
        error: failure.message,
        message,
      },
      skipDuplicates: true,
    });
  }

  /** The deliveries set aside for the Machine, latest first, without their messages. */
  async list(machineId: string, page: { limit: number; offset: number }) {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const [deliveries, total] = await this.prisma.$transaction([
      this.prisma.setAsideDelivery.findMany({
        where: { machineId },
        omit: { message: true },
        orderBy: { id: "desc" },
        take: page.limit,
        skip: page.offset,
      }),
      this.prisma.setAsideDelivery.count({ where: { machineId } }),
    ]);
    return { deliveries: deliveries.map(view), total, ...page };
  }
}

function recordId(delivery: CaptureDelivery): string | null {
  switch (delivery.type) {
    case "shot":
    case "shotUpdated":
      return delivery.shotId;
    case "steam":
      return delivery.steamId;
    default:
      return null;
  }
}

function view(delivery: Omit<SetAsideDelivery, "message">): SetAsideDeliveryView {
  return {
    id: delivery.id.toString(),
    receivedAt: delivery.receivedAt.toISOString(),
    type: delivery.type,
    deliveryId: delivery.deliveryId,
    recordId: delivery.recordId,
    sqlState: delivery.sqlState,
    error: delivery.error,
  };
}
