import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readContentEdit, readGrinderLocation, readNewContent } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type GrinderSummary, type GrinderView, GrindersService, readGrinderId } from "./grinders.service.js";

/**
 * The Library's Grinders, and the Location each belongs to. Staff read them,
 * and Archive and restore them, as Admins do, but create and edit them only
 * at their own Locations; only an Admin hard-deletes one.
 */
@Controller("api/grinders")
export class GrindersController {
  constructor(
    private readonly grinders: GrindersService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
    private readonly prisma: PrismaService,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ grinders: GrinderSummary[] }> {
    return { grinders: await this.grinders.list() };
  }

  /** Creates a Grinder at a Location: `{ locationId, content }`, its model required. */
  @AllowStaff()
  @Post()
  async create(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ grinder: GrinderView }> {
    const locationId = readGrinderLocation(body);
    const id = await this.edits.createGrinder(locationId, readNewContent("grinder", body), session.account.id, session.scope);
    return { grinder: await this.grinders.get(id) };
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ grinder: GrinderView }> {
    return { grinder: await this.grinders.get(readGrinderId(id)) };
  }

  /** Edits its content: `{ content }`, each field to change, null to clear it. */
  @AllowStaff()
  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ grinder: GrinderView }> {
    const grinderId = readGrinderId(id);
    await this.edits.editGrinder(grinderId, readContentEdit("grinder", body), session.account.id, session.scope);
    return { grinder: await this.grinders.get(grinderId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ grinder: GrinderView }> {
    const grinderId = readGrinderId(id);
    await this.edits.archiveGrinder(grinderId, readArchived(body), session.account.id);
    return { grinder: await this.grinders.get(grinderId) };
  }

  /** Deletes it from the Library and every tablet that holds it, unless a Shot names it. Admins only. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await hardDelete(this.prisma, "grinder", readGrinderId(id));
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @AllowStaff()
  @Get(":id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "grinder", id: readGrinderId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "grinder", id: readGrinderId(id) }) };
  }
}
