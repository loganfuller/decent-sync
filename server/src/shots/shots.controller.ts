import { Controller, Get, Param, Query } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { readQueryPage } from "../pagination.js";
import { readShotFilters } from "./filters.js";
import { ShotsService } from "./shots.service.js";
import { readBucket, readGroupBy, readNumbers } from "./summary.js";

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

  /**
   * The Shot Summary of the Shots the list lists for the same filters, by
   * the groupings `groupBy` names, with the `numbers` it names, a page of
   * its groups at a time, each, with `bucket`, as its buckets by `day` or
   * `week`. Before `:id` too.
   */
  @Get("summary")
  summary(@Query() query: Record<string, unknown>) {
    return this.shots.summary(readShotFilters(query), readGroupBy(query), readQueryPage(query), readNumbers(query), readBucket(query));
  }

  @Get(":id")
  async get(@Param("id") id: string) { return { shot: await this.shots.get(id) }; }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}
