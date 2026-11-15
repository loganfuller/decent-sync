import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readQueryPage } from "../pagination.js";
import { readShotFilters } from "./filters.js";
import { ShotEditsService } from "./shot-edits.service.js";
import { readShotEdit } from "./shot-edits.js";
import { ShotsService } from "./shots.service.js";
import { readBucket, readGroupBy, readNumbers } from "./summary.js";

/**
 * Every Shot captured, which Staff read too, and the edits of a Shot's
 * rating and note (ADR-0031), which Staff make of Shots at the Locations
 * they work at.
 */
@AllowStaff()
@Controller("api/shots")
export class ShotsController {
  constructor(
    private readonly shots: ShotsService,
    private readonly edits: ShotEditsService,
  ) {}

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
  async get(@Param("id") id: string, @CurrentScope() scope: Scope) { return { shot: await this.shots.get(id, scope) }; }

  /**
   * Edits the Shot's rating, its note or both, leaving alone whichever the
   * body doesn't carry, and answers with the Shot as it then reads. The
   * edit is applied at once and kept with who made it, and written to the
   * tablet that holds the Shot, now or when it next connects (ADR-0031).
   */
  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() signedIn: SignedIn) {
    await this.edits.make(id, readShotEdit(body), { accountId: signedIn.account.id, scope: signedIn.scope, connectedAppId: null });
    return { shot: await this.shots.get(id, signedIn.scope) };
  }

  @Get(":id/measurements")
  async measurements(@Param("id") id: string) { return { measurements: await this.shots.measurements(id) }; }
}
