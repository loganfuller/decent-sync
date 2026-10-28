import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readQueryPage } from "../pagination.js";
import { readShotFilters } from "./filters.js";
import { ShotsService } from "./shots.service.js";

/** Every Shot captured, which Staff read too. */
@AllowStaff()
@Controller("api/shots")
export class ShotsController {
  constructor(private readonly shots: ShotsService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    const page = readQueryPage(query);
    return this.shots.list(page.limit, page.offset, readShotFilters(query));
  }

  /** Declared before `:id`, which a Decaid Shot id, a UUID, never spells. */
  @Get("filters")
  filters() { return this.shots.filterOptions(); }

  @Get(":id")
  async get(@Param("id") id: string) { return { shot: await this.shots.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}
