import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff, CurrentScope } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { type BeanBatchSummary, type BeanBatchView, BeanBatchesService, readBeanBatchId } from "./bean-batches.service.js";

/** The Library's Bean Batches, the Locations each is at and its remaining weight there. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/bean-batches")
export class BeanBatchesController {
  constructor(
    private readonly batches: BeanBatchesService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  async list(): Promise<{ batches: BeanBatchSummary[] }> {
    return { batches: await this.batches.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ batch: BeanBatchView }> {
    return { batch: await this.batches.get(readBeanBatchId(id)) };
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @Get(":id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "beanBatch", id: readBeanBatchId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "beanBatch", id: readBeanBatchId(id) }) };
  }
}
