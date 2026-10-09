import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import { PrismaService } from "../prisma.service.js";
import { hardDelete } from "./hard-deletes.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readContentEdit, readNewBatch, readPlacement } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";
import { type BeanBatchSummary, type BeanBatchView, BeanBatchesService, readBeanBatchId } from "./bean-batches.service.js";

/**
 * The Library's Bean Batches, the Locations each is at and its remaining
 * weight there. Staff read them, create them and edit their details, and
 * Archive and restore them, as Admins do, but add and finish them, and set
 * their remaining weight, only at their own Locations; only an Admin
 * hard-deletes one.
 */
@Controller("api/bean-batches")
export class BeanBatchesController {
  constructor(
    private readonly batches: BeanBatchesService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
    private readonly prisma: PrismaService,
  ) {}

  @AllowStaff()
  @Get()
  async list(): Promise<{ batches: BeanBatchSummary[] }> {
    return { batches: await this.batches.list() };
  }

  /** Creates a batch of a Bean: `{ beanId, content, locations }`, each Location it is added at `{ locationId, remainingWeight? }`. */
  @AllowStaff()
  @Post()
  async create(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ batch: BeanBatchView }> {
    const { beanId, content, locations } = readNewBatch(body);
    const id = await this.edits.createBatch(beanId, content, locations, session.account.id, session.scope);
    return { batch: await this.batches.get(id) };
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string): Promise<{ batch: BeanBatchView }> {
    return { batch: await this.batches.get(readBeanBatchId(id)) };
  }

  /** Edits its details: `{ content }`, each field to change, null to clear it. */
  @AllowStaff()
  @Patch(":id")
  async edit(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ batch: BeanBatchView }> {
    const batchId = readBeanBatchId(id);
    await this.edits.editBatch(batchId, readContentEdit("beanBatch", body), session.account.id);
    return { batch: await this.batches.get(batchId) };
  }

  /** Archives it or restores it: `{ archived }`. */
  @AllowStaff()
  @Put(":id/archived")
  async archive(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ batch: BeanBatchView }> {
    const batchId = readBeanBatchId(id);
    await this.edits.archiveBatch(batchId, readArchived(body), session.account.id);
    return { batch: await this.batches.get(batchId) };
  }

  /** Adds it at the Location or finishes it there, and sets its remaining weight there: `{ atLocation, remainingWeight }`, either or both. */
  @AllowStaff()
  @Put(":id/locations/:locationId")
  async place(
    @Param("id") id: string,
    @Param("locationId") locationId: string,
    @Body() body: unknown,
    @CurrentSession() session: SignedIn,
  ): Promise<{ batch: BeanBatchView }> {
    const batchId = readBeanBatchId(id);
    await this.edits.placeBatch(batchId, readLocationId(locationId).toLowerCase(), readPlacement(body), session.account.id, session.scope);
    return { batch: await this.batches.get(batchId) };
  }

  /** Deletes it from the Library and every tablet that holds it, unless a Shot names it. Admins only. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await hardDelete(this.prisma, "beanBatch", readBeanBatchId(id));
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  @AllowStaff()
  @Get(":id/history")
  async versions(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.history.versions({ kind: "beanBatch", id: readBeanBatchId(id) }, scope) };
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  @AllowStaff()
  @Get(":id/conflicts")
  async conflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.history.openConflicts(scope, { kind: "beanBatch", id: readBeanBatchId(id) }) };
  }
}
