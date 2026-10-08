import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { type BeanBatchSummary, type BeanBatchView, BeanBatchesService, readBeanBatchId } from "./bean-batches.service.js";

/** The Library's Bean Batches, the Locations each is at and its remaining weight there. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/bean-batches")
export class BeanBatchesController {
  constructor(private readonly batches: BeanBatchesService) {}

  @Get()
  async list(): Promise<{ batches: BeanBatchSummary[] }> {
    return { batches: await this.batches.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ batch: BeanBatchView }> {
    return { batch: await this.batches.get(readBeanBatchId(id)) };
  }
}
