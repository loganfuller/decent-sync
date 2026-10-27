import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { Public } from "./accounts/guards.js";
import { Drain } from "./drain.js";
import { PrismaService } from "./prisma.service.js";

/**
 * How long the routing check waits for the database before calling it
 * unreachable: well within a proxy's timeout for the check, such as
 * fly.io's 5 s, so it answers whatever the database does.
 */
const DATABASE_CHECK_MS = 2_000;

@Controller("api/health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drain: Drain,
  ) {}

  /**
   * Reports whether the server is up and not stopping, which a proxy routes
   * by (ADR-0025). Whether it can reach its database is only in the body,
   * so a database failover keeps no traffic from the server once the
   * database is back.
   */
  @Public()
  @Get()
  async check(): Promise<{ status: "ok"; protocolVersion: number; database: "reachable" | "unreachable" }> {
    // So the proxy sends requests to another instance (`drain.ts`).
    if (this.drain.stopping) throw new ServiceUnavailableException("The server is stopping");
    return { status: "ok", protocolVersion: PROTOCOL_VERSION, database: (await this.databaseReachable()) ? "reachable" : "unreachable" };
  }

  private async databaseReachable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(resolve, DATABASE_CHECK_MS, false)));
    try {
      return await Promise.race([this.prisma.$queryRaw`SELECT 1`.then(() => true), timedOut]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
