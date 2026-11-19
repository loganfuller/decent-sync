import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import type { HeldValue } from "@decent-sync/protocol";
import { AllowStaff, CurrentSession } from "../accounts/guards.js";
import type { SignedIn } from "../accounts/sessions.service.js";
import { managementEditor } from "./history.js";
import { type DraftSummary, type DraftView, DraftsService, type SaveBetween, readDraftSave, readDraftStart } from "./drafts.service.js";
import { DraftFollowingService, type DraftTrying, type TrialView } from "./draft-following.service.js";
import { type ProfileSimulation, readSimulationAsk } from "./profile-simulation.service.js";
import { type PublishedView, PublishingService, readDraftPublish } from "./publishing.service.js";

/**
 * Drafts (ADR-0032, ticket #579): profiles being written or changed here,
 * which the server alone holds and no tablet is written. Admins and Staff
 * read, start, save, publish and discard any of them, as anyone who may change the
 * Library may; a Viewer sees none, 403 (`DraftsService`). A Machine at a
 * Location that tries Drafts follows one (ticket #581), Staff choosing only
 * Machines at their Locations (`DraftFollowingService`).
 */
@Controller("api/drafts")
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly publishing: PublishingService,
    private readonly followings: DraftFollowingService,
  ) {}

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

  /**
   * Publishes it (`PublishingService.publish`): `{ locations, recipes?, saves }`,
   * the Locations to show the Profile at, the Recipes naming the Profile it
   * started from to move to it, for a new version, and its count of saves as
   * read. Answers what it did: the Profile, where it is shown, where the one
   * it replaced was hidden or kept shown, the Recipes moved, and the newer
   * versions it forks beside.
   */
  @AllowStaff()
  @Post(":id/publish")
  @HttpCode(200)
  async publish(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ published: PublishedView }> {
    return { published: await this.publishing.publish(id, readDraftPublish(body), managementEditor(session.account.id), session.scope) };
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

  /** How it is tried (`DraftFollowingService.trying`): whether a Machine follows it and has its steps, the Machines that can, and its Trial Shots. */
  @AllowStaff()
  @Get(":id/trying")
  async trying(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ trying: DraftTrying }> {
    return { trying: await this.followings.trying(id, session.scope) };
  }

  /**
   * Has a Machine follow it (`DraftFollowingService.start`): `{ machineId }`,
   * a Machine at a Location that tries Drafts, whose Loaded Recipe ends as
   * its tablet is written the Draft's profile, now and on each save.
   */
  @AllowStaff()
  @Put(":id/following")
  async follow(@Param("id") id: string, @Body() body: unknown, @CurrentSession() session: SignedIn): Promise<{ trying: DraftTrying }> {
    const machineId = body !== null && typeof body === "object" ? (body as { machineId?: unknown }).machineId : undefined;
    if (typeof machineId !== "string") throw new BadRequestException("machineId must be the id of the Machine to follow the Draft on");
    return { trying: await this.followings.start(id, machineId, session.scope) };
  }

  /** Stops its following: the Machine keeps what its Workflow holds, and is written nothing more. */
  @AllowStaff()
  @Delete(":id/following")
  async unfollow(@Param("id") id: string, @CurrentSession() session: SignedIn): Promise<{ trying: DraftTrying }> {
    return { trying: await this.followings.stop(id, session.scope) };
  }

  /** A profile it was written to a following Machine with, which a Trial Shot ran (`TrialShotView.trialId`). */
  @AllowStaff()
  @Get(":id/trials/:trialId")
  async trial(@Param("id") id: string, @Param("trialId") trialId: string, @CurrentSession() session: SignedIn): Promise<{ trial: TrialView }> {
    return { trial: await this.followings.trial(id, trialId, session.scope) };
  }
}
