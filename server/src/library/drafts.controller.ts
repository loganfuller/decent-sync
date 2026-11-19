import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import type { HeldValue } from "@decent-sync/protocol";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { managementEditor } from "./history.js";
import { type DraftSummary, type DraftView, DraftsService, type SaveBetween, readDraftSave, readDraftStart } from "./drafts.service.js";
import { type ProfileSimulation, readSimulationAsk } from "./profile-simulation.service.js";

/**
 * Drafts (ADR-0032, ticket #579): profiles being written or changed here,
 * which the server alone holds and no tablet is written. Admins and Staff
 * read, start, save and discard any of them, as anyone who may change the
 * Library may; a Viewer sees none, 403 (`DraftsService`).
 */
@Controller("api/drafts")
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  /** Every Draft, the one saved last first. */
  @AllowStaff()
  @Get()
  async list(@CurrentSession() session: SignedIn): Promise<{ drafts: DraftSummary[] }> {
    return { drafts: await this.drafts.list(session.scope) };
  }

  /**
   * Starts a Draft (`DraftsService.create`): `{ profileId, as }` from a
   * Library Profile, `as` "version" for Edit or "separate" for Duplicate;
   * `{ shape }` from a starting shape, by its key; or `{ file }` from a
   * profile file's content, Decaid's profile JSON, a bare profile or a whole
   * record, with what was held to the ranges in `held`.
   */
  @AllowStaff()
  @Post()
  async create(@Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ draft: DraftView; held: HeldValue[] }> {
    return this.drafts.create(readDraftStart(body), managementEditor(session.account.id), session.scope);
  }

  @AllowStaff()
  @Get(":id")
  async get(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ draft: DraftView }> {
    return { draft: await this.drafts.get(id, session.scope) };
  }

  /**
   * Saves it: `{ profile?, publishesAs?, saves }`, `saves` the count of saves
   * the change started from. Taken whatever that count, the later save
   * winning; `between` says how many saves came between and the latest of
   * them, null where none did.
   */
  @AllowStaff()
  @Put(":id")
  async save(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ draft: DraftView; between: SaveBetween | null }> {
    return this.drafts.save(id, readDraftSave(body), managementEditor(session.account.id), session.scope);
  }

  /** Discards it. */
  @AllowStaff()
  @Delete(":id")
  @HttpCode(204)
  async discard(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<void> {
    await this.drafts.discard(id, session.scope);
  }

  /** Simulates it, as a Library Profile's simulation route does, taking the same query. */
  @AllowStaff()
  @Get(":id/simulation")
  async simulate(
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @CurrentSession() session: SignedIn,
  ): Promise<{ simulation: { draft: { id: string; title: string } } & Omit<ProfileSimulation, "profile"> }> {
    return { simulation: await this.drafts.simulate(id, readSimulationAsk(query), session.scope) };
  }
}
