import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PROTOCOL_VERSION } from "@decent-sync/protocol";
import { Public } from "./accounts/guards.js";
import { PrismaService } from "./prisma.service.js";

@Controller("api/health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Reports whether the server is up and can reach its database. */
  @Public()
  @Get()
  async check(): Promise<{ status: "ok"; protocolVersion: number }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("The database is unreachable");
    }
    return { status: "ok", protocolVersion: PROTOCOL_VERSION };
  }
}
