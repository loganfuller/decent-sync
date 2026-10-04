import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

/** One database client for the whole server. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
