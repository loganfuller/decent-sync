import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readContentEdit, readNewContent } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type BeanSummary, type BeanView, BeansService, readBeanId } from "./beans.service.js";

/**
 * The Library's Beans, and where each is offered. Staff read them, create
 * and edit them, and Archive and restore them, as Admins do; only an Admin
 * hard-deletes one.
 */
@Controller("api/beans")
export class BeansController {
  constructor(
    private readonly beans: BeansService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
    private readonly prisma: PrismaService,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ beans: BeanSummary[] }> {
    return { beans: await this.beans.list() };
  }

  /** Creates a Bean: `{ content }`, its roaster and name required. 409, with the `existing` Bean, if one has them. */
  @AllowStaff()
  @Post()
  async create(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ bean: BeanView }> {
    const id = await this.edits.createBean(readNewContent("bean", body), session.account.id);
    return { bean: await this.beans.get(id) };
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ bean: BeanView }> {
    return { bean: await this.beans.get(readBeanId(id)) };
  }

  /** Edits its content: `{ content }`, each field to change, null to clear it. */
  @AllowStaff()
  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ bean: BeanView }> {
    const beanId = readBeanId(id);
    await this.edits.editBean(beanId, readContentEdit("bean", body), session.account.id);
    return { bean: await this.beans.get(beanId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ bean: BeanView }> {
    const beanId = readBeanId(id);
    await this.edits.archiveBean(beanId, readArchived(body), session.account.id);
    return { bean: await this.beans.get(beanId) };
  }

  /** Deletes it, with its batches, from the Library and every tablet that holds it, unless a Shot names one of its batches. Admins only. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await hardDelete(this.prisma, "bean", readBeanId(id));
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @AllowStaff()
  @Get(":id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "bean", id: readBeanId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "bean", id: readBeanId(id) }) };
  }
}
