import type { RequestShots, RequestSteams } from "@decent-sync/protocol";

/** The request an index was answered with. */
export type IndexRequest = RequestShots | RequestSteams;

/** How much a connection's record of the deliveries it handled may hold. */
export interface HandledDeliveryLimits {
  /** The most deliveries remembered. */
  maxDeliveries: number;
  /** The most code units held: the deliveries' ids and the ids in their indexes' requests. */
  maxLength: number;
}

/**
 * The limits on every connection. A delivery's id is at most MAX_ID_LENGTH
 * code units, and Decaid's Shot and Steam Record ids are UUIDs, so this holds
 * 64 answered index pages of 100 of them.
 */
export const HANDLED_DELIVERY_LIMITS: Readonly<HandledDeliveryLimits> = { maxDeliveries: 64, maxLength: 256 * 1024 };

interface Handled {
  request: IndexRequest | null;
  /** Code units held for it. */
  length: number;
}

/**
 * The deliveries one connection handled most recently, by id, with the
 * request each index was answered with, so that a delivery sent again on the
 * connection is acknowledged without being handled again, and an index's
 * request is sent again with it.
 *
 * It holds no more than its limits allow, forgetting the oldest first. A
 * delivery forgotten, or too large to remember, is handled again if it is sent
 * again, which changes nothing: every delivery's storage is idempotent, and an
 * index is answered from what is stored by then.
 */
export class HandledDeliveries {
  private readonly deliveries = new Map<string, Handled>();
  private length = 0;

  constructor(private readonly limits: Readonly<HandledDeliveryLimits> = HANDLED_DELIVERY_LIMITS) {}

  has(id: string): boolean {
    return this.deliveries.has(id);
  }

  /** The request an index was answered with, null for any other delivery, or undefined if the delivery is not remembered. */
  get(id: string): IndexRequest | null | undefined {
    return this.deliveries.get(id)?.request;
  }

  /** Remembers a delivery once handled, with the request answering it if it is an index. */
  add(id: string, request: IndexRequest | null): void {
    this.forget(id);
    const ids = request ? (request.type === "requestShots" ? request.shotIds : request.steamIds) : [];
    const length = ids.reduce((sum, requested) => sum + requested.length, id.length);
    if (length > this.limits.maxLength) return;
    this.deliveries.set(id, { request, length });
    this.length += length;
    for (const oldest of this.deliveries.keys()) {
      if (this.deliveries.size <= this.limits.maxDeliveries && this.length <= this.limits.maxLength) break;
      this.forget(oldest);
    }
  }

  private forget(id: string): void {
    const handled = this.deliveries.get(id);
    if (!handled) return;
    this.deliveries.delete(id);
    this.length -= handled.length;
  }
}
