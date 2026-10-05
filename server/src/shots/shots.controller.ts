import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readMachineId } from "../machines/input.js";
import { readPage } from "../pagination.js";
import { ShotsService } from "./shots.service.js";

/** Every Shot captured, which Staff read too. */
@AllowStaff()
@Controller("api/shots")
export class ShotsController {
  constructor(private readonly shots: ShotsService) {}

  @Get()
  list(@Query("limit") limit?: string, @Query("offset") offset?: string, @Query("machineId") machineId?: string) {
    const page = readPage(limit, offset);
    return this.shots.list(page.limit, page.offset, machineId === undefined ? undefined : readMachineId(machineId));
  }

  @Get(":id")
  async get(@Param("id") id: string) { return { shot: await this.shots.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}
