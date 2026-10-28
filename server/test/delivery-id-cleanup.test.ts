import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_ID_CLEANUP_BATCH, DELIVERY_ID_CLEANUP_INTERVAL_MS, DeliveryIdCleanup } from "../src/machines/delivery-id-cleanup.js";
import type { PrismaService } from "../src/prisma.service.js";

// The cleanup's timer, through its own interface, with each statement it
// runs answered by the test. What those statements delete, beside deliveries
// and other instances, is tested through Seam 1 in
// delivery-id-retention.test.ts.

const HOUR_MS = DELIVERY_ID_CLEANUP_INTERVAL_MS;
const deletedMessage = (count: number) => `Deleted ${count} delivery ids recorded more than 90 days ago`;

/** A cleanup whose every statement is answered by `answer`, with how many rows it deleted or by failing. */
function cleanupAnswering(answer: () => Promise<number>) {
  const statements = vi.fn(answer);
  const cleanup = new DeliveryIdCleanup({ $executeRaw: statements } as unknown as PrismaService);
  return { cleanup, statements };
}

describe("DeliveryIdCleanup", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  let failed: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logged = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    failed = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deletes as the server starts and then hourly, a statement at a time until one finds less than a batch", async () => {
    const counts = [DELIVERY_ID_CLEANUP_BATCH, DELIVERY_ID_CLEANUP_BATCH, 7];
    const { cleanup, statements } = cleanupAnswering(async () => counts.shift() ?? 0);

    cleanup.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(statements).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenCalledExactlyOnceWith(deletedMessage(2 * DELIVERY_ID_CLEANUP_BATCH + 7));

    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(statements).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements).toHaveBeenCalledTimes(4);
    // A run that deletes nothing says nothing.
    expect(logged).toHaveBeenCalledTimes(1);
    await cleanup.onModuleDestroy();
  });

  it("logs a run that fails, with what it deleted before failing, and tries again an hour later", async () => {
    const answers = [
      () => Promise.resolve(DELIVERY_ID_CLEANUP_BATCH),
      () => Promise.reject(new Error("Connection terminated unexpectedly")),
      () => Promise.resolve(3),
    ];
    const { cleanup, statements } = cleanupAnswering(() => answers.shift()!());

    cleanup.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Connection terminated unexpectedly"));
    expect(logged).toHaveBeenCalledExactlyOnceWith(deletedMessage(DELIVERY_ID_CLEANUP_BATCH));

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(statements).toHaveBeenCalledTimes(3);
    expect(logged).toHaveBeenLastCalledWith(deletedMessage(3));
    await cleanup.onModuleDestroy();
  });

  it("stops its timer on shutdown, before its first run or between runs", async () => {
    const { cleanup: unstarted, statements: neverRun } = cleanupAnswering(async () => 0);
    unstarted.onApplicationBootstrap();
    await unstarted.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);

    const { cleanup, statements } = cleanupAnswering(async () => 0);
    cleanup.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await cleanup.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(neverRun).not.toHaveBeenCalled();
    expect(statements).toHaveBeenCalledTimes(1);
  });

  it("lets a run in progress at shutdown finish its statement before the database disconnects, then starts no other", async () => {
    let finish!: (count: number) => void;
    const { cleanup, statements } = cleanupAnswering(() => new Promise<number>((resolve) => (finish = resolve)));
    cleanup.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(statements).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = cleanup.onModuleDestroy().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    // A whole batch, so more may be left, but the server is shutting down.
    finish(DELIVERY_ID_CLEANUP_BATCH);
    await stopping;

    expect(statements).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
    expect(statements).toHaveBeenCalledTimes(1);
  });
});
