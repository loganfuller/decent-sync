import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { readMachineId } from "../machines/input.js";
import { ShotsService } from "./shots.service.js";

@Controller("api/shots")
export class ShotsController {
  constructor(private readonly shots: ShotsService) {}

  @Get()
  list(@Query("limit") limit?: string, @Query("offset") offset?: string, @Query("machineId") machineId?: string) {
    return this.shots.list(integer(limit, 20, 1, 100), integer(offset, 0, 0, 1 << 30), machineId === undefined ? undefined : readMachineId(machineId));
  }

  @Get(":id")
  async get(@Param("id") id: string) { return { shot: await this.shots.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`Pagination must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}
