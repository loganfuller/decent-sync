import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { Public } from "./accounts/guards.js";
import { Drain } from "./drain.js";
import { PrismaService } from "./prisma.service.js";

@Controller("api/health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drain: Drain,
  ) {}

  /** Reports whether the server is up, not stopping, and can reach its database. */
  @Public()
  @Get()
  async check(): Promise<{ status: "ok"; protocolVersion: number }> {
    // So the proxy sends requests to another instance (`drain.ts`).
    if (this.drain.stopping) throw new ServiceUnavailableException("The server is stopping");
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("The database is unreachable");
    }
    return { status: "ok", protocolVersion: PROTOCOL_VERSION };
  }
}
