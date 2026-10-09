import { Controller, Get, Param } from "@nestjs/common";
import { AllowStaff } from "../accounts/guards.js";
import { HistoryService, type VersionView } from "./history.service.js";
import { type BeanSummary, type BeanView, BeansService, readBeanId } from "./beans.service.js";

/** The Library's Beans, and where each is offered. Read-only for now; Staff read them too. */
@AllowStaff()
@Controller("api/beans")
export class BeansController {
  constructor(
    private readonly beans: BeansService,
    private readonly history: HistoryService,
  ) {}

  @Get()
  async list(): Promise<{ beans: BeanSummary[] }> {
    return { beans: await this.beans.list() };
  }

  @Get(":id")
  async get(@Param("id") id: string): Promise<{ bean: BeanView }> {
    return { bean: await this.beans.get(readBeanId(id)) };
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @Get(":id/history")
  async versions(@Param("id") id: string): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "bean", id: readBeanId(id) }) };
  }
}
