import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readPage } from "../pagination.js";
import { readShotFilters } from "./filters.js";
import { ShotsService } from "./shots.service.js";

/** Every Shot captured, which Staff read too. */
@AllowStaff()
@Controller("api/shots")
export class ShotsController {
  constructor(private readonly shots: ShotsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    const { limit, offset, ...filters } = query;
    const page = readPage(single(limit), single(offset));
    return this.shots.list(page.limit, page.offset, readShotFilters(filters));
  }

  /** Declared before `:id`, which a Decaid Shot id, a UUID, never spells. */
  @Get("filters")
  filters() { return this.shots.filterOptions(); }

  @Get(":id")
  async get(@Param("id") id: string) { return { shot: await this.shots.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}

/** A repeated query parameter is no whole number, which `readPage` refuses. */
function single(value: unknown): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return String(value);
}
