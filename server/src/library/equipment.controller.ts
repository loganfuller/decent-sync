import { Body, Controller, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { AllowStaff, CurrentScope, CurrentSession } from "../accounts/guards.js";
import type { Scope } from "../accounts/scope.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { readLocationId } from "../locations/input.js";
import type { EquipmentKind } from "./equipment.js";
import { type EquipmentSummary, type EquipmentView, EquipmentService, readEquipmentId } from "./equipment.service.js";
import { type ConflictView, HistoryService, type VersionView } from "./history.service.js";
import { readArchived, readContentEdit, readNewEquipment, readShown } from "./item-input.js";
import { LibraryEditsService } from "./library-edits.service.js";

/**
 * A kind DYE2 keeps, Baskets or Tools, and the Locations showing each
 * (ADR-0005, ADR-0008). Staff read them, edit them, and Archive and restore
 * them, as Admins do, but create them and show and hide them only at their
 * own Locations. They join the Library from tablets, or are created here.
 * Hard deletes come with the Shots that name them.
 */
abstract class EquipmentController {
  constructor(
    private readonly kind: EquipmentKind,
    private readonly equipment: EquipmentService,
    private readonly history: HistoryService,
    private readonly edits: LibraryEditsService,
  ) {}

  protected list(): Promise<EquipmentSummary[]> {
    return this.equipment.list(this.kind);
  }

  protected get(id: string): Promise<EquipmentView> {
    return this.equipment.get(this.kind, readEquipmentId(this.kind, id));
  }

  /** Creates one, shown at the Location: `{ locationId, content }`, its name required. 409, with the `existing` item and whether it is Archived, if one has its name. */
  protected async create(body: unknown, session: SignedIn): Promise<EquipmentView> {
    const { locationId, content } = readNewEquipment(this.kind, body);
    return this.equipment.get(this.kind, await this.edits.createEquipment(this.kind, locationId, content, session.account.id, session.scope));
  }

  /** Edits its content: `{ content }`, each field to change, null to clear it. */
  protected async edit(id: string, body: unknown, session: SignedIn): Promise<EquipmentView> {
    const itemId = readEquipmentId(this.kind, id);
    await this.edits.editEquipment(this.kind, itemId, readContentEdit(this.kind, body), session.account.id);
    return this.equipment.get(this.kind, itemId);
  }

  /** Archives it or restores it: `{ archived }`. */
  protected async archive(id: string, body: unknown, session: SignedIn): Promise<EquipmentView> {
    const itemId = readEquipmentId(this.kind, id);
    await this.edits.archiveEquipment(this.kind, itemId, readArchived(body), session.account.id);
    return this.equipment.get(this.kind, itemId);
  }

  /** Shows it at the Location or hides it there: `{ shown }`. */
  protected async show(id: string, locationId: string, body: unknown, session: SignedIn): Promise<EquipmentView> {
    const itemId = readEquipmentId(this.kind, id);
    await this.edits.showEquipment(this.kind, itemId, readLocationId(locationId).toLowerCase(), readShown(body), session.account.id, session.scope);
    return this.equipment.get(this.kind, itemId);
  }

  /** Its versions, the latest taken in first (ADR-0020). */
  protected versions(id: string, scope: Scope): Promise<VersionView[]> {
    return this.history.versions({ kind: this.kind, id: readEquipmentId(this.kind, id) }, scope);
  }

  /** Its open Conflicts, the latest first (ADR-0020). */
  protected conflicts(id: string, scope: Scope): Promise<ConflictView[]> {
    return this.history.openConflicts(scope, { kind: this.kind, id: readEquipmentId(this.kind, id) });
  }
}

/** The Library's Baskets: DYE2's baskets, one for each model of basket at every Location. */
@Controller("api/baskets")
export class BasketsController extends EquipmentController {
  constructor(equipment: EquipmentService, history: HistoryService, edits: LibraryEditsService) {
    super("basket", equipment, history, edits);
  }

  @AllowStaff()
  @Get()
  async all(): Promise<{ baskets: EquipmentSummary[] }> {
    return { baskets: await this.list() };
  }

  @AllowStaff()
  @Post()
  async add(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ basket: EquipmentView }> {
    return { basket: await this.create(body, session) };
  }

  @AllowStaff()
  @Get(":id")
  async one(@Param("id") id: string): Promise<{ basket: EquipmentView }> {
    return { basket: await this.get(id) };
  }

  @AllowStaff()
  @Patch(":id")
  async change(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ basket: EquipmentView }> {
    return { basket: await this.edit(id, body, session) };
  }

  @AllowStaff()
  @Put(":id/archived")
  async retire(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ basket: EquipmentView }> {
    return { basket: await this.archive(id, body, session) };
  }

  @AllowStaff()
  @Put(":id/locations/:locationId")
  async place(@Param("id") id: string, @Param("locationId") locationId: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ basket: EquipmentView }> {
    return { basket: await this.show(id, locationId, body, session) };
  }

  @AllowStaff()
  @Get(":id/history")
  async versionsOf(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.versions(id, scope) };
  }

  @AllowStaff()
  @Get(":id/conflicts")
  async openConflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.conflicts(id, scope) };
  }
}

/** The Library's Tools: DYE2's equipment, such as a WDT tool or puck screen. */
@Controller("api/tools")
export class ToolsController extends EquipmentController {
  constructor(equipment: EquipmentService, history: HistoryService, edits: LibraryEditsService) {
    super("tool", equipment, history, edits);
  }

  @AllowStaff()
  @Get()
  async all(): Promise<{ tools: EquipmentSummary[] }> {
    return { tools: await this.list() };
  }

  @AllowStaff()
  @Post()
  async add(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ tool: EquipmentView }> {
    return { tool: await this.create(body, session) };
  }

  @AllowStaff()
  @Get(":id")
  async one(@Param("id") id: string): Promise<{ tool: EquipmentView }> {
    return { tool: await this.get(id) };
  }

  @AllowStaff()
  @Patch(":id")
  async change(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ tool: EquipmentView }> {
    return { tool: await this.edit(id, body, session) };
  }

  @AllowStaff()
  @Put(":id/archived")
  async retire(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ tool: EquipmentView }> {
    return { tool: await this.archive(id, body, session) };
  }

  @AllowStaff()
  @Put(":id/locations/:locationId")
  async place(@Param("id") id: string, @Param("locationId") locationId: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ tool: EquipmentView }> {
    return { tool: await this.show(id, locationId, body, session) };
  }

  @AllowStaff()
  @Get(":id/history")
  async versionsOf(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ versions: VersionView[] }> {
    return { versions: await this.versions(id, scope) };
  }

  @AllowStaff()
  @Get(":id/conflicts")
  async openConflicts(@Param("id") id: string, @CurrentScope() scope: Scope): Promise<{ conflicts: ConflictView[] }> {
    return { conflicts: await this.conflicts(id, scope) };
  }
}
