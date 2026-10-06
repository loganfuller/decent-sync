import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readQueryPage } from "../pagination.js";
import { readRecordFilters } from "../record-filters.js";
import { SteamRecordsService } from "./steam-records.service.js";

/** Every Steam Record captured, which Staff read too. */
@AllowStaff()
@Controller("api/steam-records")
export class SteamRecordsController {
  constructor(private readonly steamRecords: SteamRecordsService) {}

  /** Filtered by Machine or Pending Machine, Location and local time, the filters every record list has. */
  @Get()
  list(@Query() query: Record<string, unknown>) {
    const page = readQueryPage(query);
    const problems: string[] = [];
    const filters = readRecordFilters(query, problems);
    if (problems.length > 0) throw new BadRequestException(problems);
    return this.steamRecords.list(page.limit, page.offset, filters);
  }

  @Get(":id")
  async get(@Param("id") id: string) { return { steamRecord: await this.steamRecords.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.steamRecords.measurements(id) }; }
}
