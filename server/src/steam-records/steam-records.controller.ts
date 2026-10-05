import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { SteamRecordsService } from "./steam-records.service.js";

/** Every Steam Record captured, which Staff read too. */
@AllowStaff()
@Controller("api/steam-records")
export class SteamRecordsController {
  constructor(private readonly steamRecords: SteamRecordsService) {}

  @Get()
  list(@Query("limit") limit?: string, @Query("offset") offset?: string, @Query("machineId") machineId?: string) {
    const page = readPage(limit, offset);
    return this.steamRecords.list(page.limit, page.offset, machineId === undefined ? undefined : readMachineId(machineId));
  }

  @Get(":id")
  async get(@Param("id") id: string) { return { steamRecord: await this.steamRecords.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.steamRecords.measurements(id) }; }
}
