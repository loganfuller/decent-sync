import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  type HeldValue,
  MAX_PROFILE_STEPS,
  type MachineModel,
  type Profile,
  type ProfileChecks,
  STARTING_SHAPES,
  checkProfile,
  holdToLimits,
  isRecordId,
  outOfRange,
  outOfRangeText,
  profileId,
  readProfile,
  readProfileFile,
  startingShape,
  widestLimits,
} from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { DraftPublishing, type Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import type { Editor } from "./history.js";
import { type SourceView, viewSource } from "./history.service.js";
import { type ProfileSimulation, ProfileSimulationService, type SimulationAsk } from "./profile-simulation.service.js";
import { accountModels } from "./profile-reach.js";
import { ProfilesService } from "./profiles.service.js";

// Drafts (ADR-0032, ticket #579): profiles being written or changed in the
// management interface, which the server alone holds and no tablet is ever
// written. Not Library content: a Draft is shown at no Location, makes no
// Conflict and has no history but who saved it last, and anyone who may
// change the Library may read, change and discard any of them. A Viewer
// sees none. A save names the count it started from: it is taken either way,
// the later save winning, and the answer says whether another came between.
// Publishing one is ticket #580.

/** What publishing a Draft makes: a new Profile Version of the Profile it started from, or a separate Profile. */
export type DraftPublishesAs = "version" | "separate";

/** A Draft as the REST API lists it. */
export interface DraftSummary {
  id: string;
  /** Its profile's title, empty where it has none yet. */
  title: string;
  /** The Library Profile it was started from, by Edit or Duplicate; its title and bundled null where the Library no longer has it. Null for one started from a shape or a file. */
  startedFrom: { id: string; title: string | null; bundled: boolean | null } | null;
  /** The starting shape it was started from, by its key and title; null for one started otherwise. */
  shape: { key: string; title: string } | null;
  publishesAs: DraftPublishesAs;
  /** Who saved it last: the account, its name null but to Admins, and the Connected App it saved it through, if one. */
  savedBy: SourceView;
  /** When it was saved last, by PostgreSQL's clock. */
  savedAt: string;
  /** How many times it has been saved, its creation the first; a save names the count it started from. */
  saves: number;
  /** When it was started, by PostgreSQL's clock. */
  createdAt: string;
}

/** A Draft with its profile, as the REST API returns one. */
export interface DraftView extends DraftSummary {
  /** Its profile as Decaid writes one. */
  profile: Profile;
  /** The id Decaid would give its profile, which publishing it would make a Profile under. */
  profileId: string;
  /** The models the account has Machines of, in MACHINE_MODELS order: it is held to the widest of their ranges, a DE1's for none (#588). */
  models: MachineModel[];
  /**
   * The model it is simulated as unless another is asked for: that of the
   * Profile it started from, where the Library has it (`ProfileView.machineModel`);
   * otherwise a Bengle where every Machine of the account is one, else a DE1.
   */
  machineModel: MachineModel;
  /** Its checks (`checkProfile`), against the widest ranges of those models and the Library's Profiles, but those of a simulated run, which a simulation gives. */
  checks: ProfileChecks;
}

/** A save made between the one asked about and the count it started from: how many, and the latest of them. */
export interface SaveBetween {
  saves: number;
  savedBy: SourceView;
  savedAt: string;
}

/** What a Draft is started from (`readDraftStart`). */
export type DraftStart =
  /** A Library Profile, by Edit, as a new version of it, or Duplicate, as a separate Profile. */
  | { kind: "profile"; profileId: string; publishesAs: DraftPublishesAs }
  /** One of the starting shapes, by its key. */
  | { kind: "shape"; shape: string }
  /** A profile file, Decaid's profile JSON: a bare profile or a whole record. */
  | { kind: "file"; content: unknown };

/** A save of a Draft (`readDraftSave`): its profile, what it will publish as, either left as it is where not given, and the count it started from. */
export interface DraftSave {
  profile?: unknown;
  publishesAs?: DraftPublishesAs;
  saves: number;
}

/** The most steps a Draft holds: far more than the MAX_PROFILE_STEPS a machine takes, which only stops it publishing, so an imported file keeps its steps. */
export const MAX_DRAFT_STEPS = 100;

/** How a Viewer is refused a Draft, which only those who may change the Library see. */
export const VIEWER_SEES_NO_DRAFTS = "A Viewer sees no Drafts";

/** What a duplicate's title has after the Profile's, so a separate Profile doesn't start with the title of the one it came from. */
const COPY = " copy";

const withSaver = {
  savedByAccount: { select: { name: true } },
  savedByConnectedApp: { select: { id: true, name: true, clientHost: true } },
} as const satisfies Prisma.DraftInclude;

type DraftRow = Prisma.DraftGetPayload<{ include: typeof withSaver }>;

@Injectable()
export class DraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly simulation: ProfileSimulationService,
  ) {}

  /** Every Draft, the one saved last first. 403 for a Viewer. */
  async list(scope: Scope): Promise<DraftSummary[]> {
    refuseViewer(scope);
    const rows = await this.prisma.draft.findMany({ include: withSaver, orderBy: [{ savedAt: "desc" }, { id: "asc" }] });
    const started = await this.startedFrom(rows);
    return rows.map((row) => summary(row, started, scope));
  }

  /** The Draft. 404 for none; 403 for a Viewer. */
  async get(id: string, scope: Scope): Promise<DraftView> {
    refuseViewer(scope);
    const row = await this.prisma.draft.findUnique({ where: { id: readDraftId(id) }, include: withSaver });
    if (!row) throw draftNotFound();
    return this.view(row, scope);
  }

  /**
   * Starts a Draft, saved by the editor: from a Library Profile, which is
   * copied as it is for Edit, as a new version of it, and with " copy" after
   * its title for Duplicate, as a separate Profile; from a starting shape,
   * as a separate Profile; or from a profile file, held to the widest ranges
   * of the account's models, which says what it held. Edit of one of Decaid's
   * bundled Profiles is refused, 409, as only Duplicate makes sense of one;
   * a Profile Decaid would not read, 409; a file that is not a profile, 400.
   */
  async create(start: DraftStart, editor: Editor, scope: Scope): Promise<{ draft: DraftView; held: HeldValue[] }> {
    refuseViewer(scope);
    let profile: Profile;
    let held: HeldValue[] = [];
    let startedFromId: string | null = null;
    let shape: string | null = null;
    let publishesAs: DraftPublishesAs = "separate";
    if (start.kind === "profile") {
      const item = await this.profiles.get(start.profileId);
      if (!item.profile) throw new ConflictException(`Profile ${item.id}'s profile can't be read as Decaid reads one, so no Draft can start from it`);
      if (start.publishesAs === "version" && item.bundled)
        throw new ConflictException(`"${item.title ?? item.id}" is one of Decaid's bundled Profiles, which only Duplicate starts a Draft from, as a separate Profile`);
      profile = start.publishesAs === "version" ? item.profile : { ...item.profile, title: `${item.profile.title.trim() || "Profile"}${COPY}` };
      startedFromId = item.id;
      publishesAs = start.publishesAs;
    } else if (start.kind === "shape") {
      const found = startingShape(start.shape);
      if (!found) throw new BadRequestException(`shape must be one of ${STARTING_SHAPES.map((each) => each.key).join(", ")}`);
      profile = found.profile;
      shape = found.key;
    } else {
      const read = readProfileFile(start.content);
      if (!read.profile) throw new BadRequestException(`That file is not a profile Decaid reads: ${read.problem}`);
      ({ profile, held } = holdToLimits(read.profile, widestLimits(await accountModels(this.prisma))));
    }
    refuseTooManySteps(profile);
    const row = await this.prisma.draft.create({
      data: {
        profile: profile as unknown as Prisma.InputJsonValue,
        startedFromId,
        shape,
        publishesAs: publishesAs === "version" ? DraftPublishing.VERSION : DraftPublishing.SEPARATE,
        savedByAccountId: editor.accountId,
        savedByConnectedAppId: editor.connectedAppId,
      },
      include: withSaver,
    });
    return { draft: await this.view(row, scope), held };
  }

  /**
   * Saves the Draft, by the editor: its profile, held to the widest ranges
   * of the account's models and refused, 400, outside them, and what it will
   * publish as, a new version only where it was started from a Profile. The
   * save is taken whatever count it names, the later save winning, and says
   * whether others came between: how many, and the latest of them. 404 for
   * no such Draft; 403 for a Viewer.
   */
  async save(id: string, save: DraftSave, editor: Editor, scope: Scope): Promise<{ draft: DraftView; between: SaveBetween | null }> {
    refuseViewer(scope);
    const draftId = readDraftId(id);
    let profile: Profile | undefined;
    if (save.profile !== undefined) {
      const read = readProfile(save.profile);
      if (!read.profile) throw new BadRequestException(`profile can't be read as Decaid reads one: ${read.problem}`);
      profile = read.profile;
      refuseTooManySteps(profile);
      const outside = outOfRange(profile, widestLimits(await accountModels(this.prisma)));
      if (outside.length > 0) throw new BadRequestException(outside.map((value) => `${outOfRangeText(profile!, value)}, which no Machine of the account runs`));
    }
    const { row, between } = await this.prisma.$transaction(async (tx) => {
      // Locked, so saves through every instance are counted one after another.
      const [before] = await tx.$queryRaw<{ saves: number; started_from_id: string | null }[]>`SELECT saves, started_from_id FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
      if (!before) throw draftNotFound();
      if (save.publishesAs === "version" && before.started_from_id === null) throw new BadRequestException("Only a Draft started from a Profile can publish as a new version of it");
      const earlier = before.saves > save.saves ? await tx.draft.findUnique({ where: { id: draftId }, include: withSaver }) : null;
      await tx.$executeRaw`
        UPDATE drafts SET
          profile = COALESCE(${profile === undefined ? null : JSON.stringify(profile)}::jsonb, profile),
          publishes_as = COALESCE(${save.publishesAs === undefined ? null : save.publishesAs === "version" ? "VERSION" : "SEPARATE"}::draft_publishing, publishes_as),
          saved_by_account_id = ${editor.accountId}::uuid,
          saved_by_connected_app_id = ${editor.connectedAppId}::uuid,
          saved_at = statement_timestamp(),
          saves = saves + 1
        WHERE id = ${draftId}::uuid`;
      const row = await tx.draft.findUniqueOrThrow({ where: { id: draftId }, include: withSaver });
      return { row, between: earlier && { saves: before.saves - save.saves, savedBy: source(earlier, scope), savedAt: earlier.savedAt.toISOString() } };
    });
    return { draft: await this.view(row, scope), between };
  }

  /** Discards the Draft, which leaves nothing behind. 404 for no such Draft; 403 for a Viewer. */
  async discard(id: string, scope: Scope): Promise<void> {
    refuseViewer(scope);
    const { count } = await this.prisma.draft.deleteMany({ where: { id: readDraftId(id) } });
    if (count === 0) throw draftNotFound();
  }

  /**
   * Simulates the Draft as a Library Profile is simulated
   * (`ProfileSimulationService.simulate`), on a Machine of the model asked,
   * else of the model it is simulated as (`DraftView.machineModel`), with its
   * checks. 409 for one of more steps than a machine takes.
   */
  async simulate(id: string, ask: SimulationAsk, scope: Scope): Promise<{ draft: { id: string; title: string } } & Omit<ProfileSimulation, "profile">> {
    const draft = await this.get(id, scope);
    if (draft.profile.steps.length > MAX_PROFILE_STEPS)
      throw new ConflictException(`The Draft has ${draft.profile.steps.length} steps, more than the ${MAX_PROFILE_STEPS} a machine takes, so it can't be simulated`);
    if (draft.profile.steps.length === 0) throw new ConflictException("The Draft has no steps to simulate");
    const simulated = await this.simulation.simulateProfile(draft.profile, ask, draft.machineModel, await this.checkContext(draft.profile, draft.models));
    return { draft: { id: draft.id, title: draft.title }, ...simulated };
  }

  private async view(row: DraftRow, scope: Scope): Promise<DraftView> {
    const profile = readProfile(row.profile).profile;
    // Every profile stored was read so as it was saved, so this is never null but for a row written outside the server.
    if (!profile) throw new ConflictException(`Draft ${row.id}'s profile can't be read as Decaid reads one`);
    const [started, models] = await Promise.all([this.startedFrom([row]), accountModels(this.prisma)]);
    const from = row.startedFromId === null ? null : await this.profiles.get(row.startedFromId).catch((caught: unknown) => (caught instanceof NotFoundException ? null : Promise.reject(caught)));
    return {
      ...summary(row, started, scope),
      profile,
      profileId: profileId(profile),
      models,
      machineModel: from?.machineModel ?? (models.length === 1 && models[0] === "Bengle" ? "Bengle" : "DE1"),
      checks: checkProfile(profile, await this.checkContext(profile, models)),
    };
  }

  /** What a Draft's checks are judged against: the models, and the Library Profile with its steps, if one has them. */
  private async checkContext(profile: Profile, models: MachineModel[]): Promise<{ models: MachineModel[]; libraryProfiles: { id: string; title: string }[] }> {
    const id = profileId(profile);
    const same = profile.steps.length === 0 ? null : await this.prisma.profile.findUnique({ where: { id }, select: { id: true, content: true } });
    const title = same ? readProfile((same.content as { profile?: unknown }).profile).profile?.title : undefined;
    return { models, libraryProfiles: same ? [{ id: same.id, title: title?.trim() || same.id }] : [] };
  }

  /** The Library Profiles the Drafts were started from, by id: each's title and whether it is bundled. */
  private async startedFrom(rows: DraftRow[]): Promise<Map<string, { title: string | null; bundled: boolean }>> {
    const ids = [...new Set(rows.flatMap((row) => (row.startedFromId === null ? [] : [row.startedFromId])))];
    if (ids.length === 0) return new Map();
    const found = await this.prisma.profile.findMany({ where: { id: { in: ids } }, select: { id: true, content: true, bundled: true } });
    return new Map(found.map((each) => [each.id, { title: readProfile((each.content as { profile?: unknown }).profile).profile?.title.trim() || null, bundled: each.bundled }]));
  }
}

function summary(row: DraftRow, started: Map<string, { title: string | null; bundled: boolean }>, scope: Scope): DraftSummary {
  const profile = readProfile(row.profile).profile;
  const from = row.startedFromId === null ? undefined : started.get(row.startedFromId);
  const shape = row.shape === null ? undefined : startingShape(row.shape);
  return {
    id: row.id,
    title: profile?.title ?? "",
    startedFrom: row.startedFromId === null ? null : { id: row.startedFromId, title: from?.title ?? null, bundled: from?.bundled ?? null },
    shape: row.shape === null ? null : { key: row.shape, title: shape?.title ?? row.shape },
    publishesAs: row.publishesAs === DraftPublishing.VERSION ? "version" : "separate",
    savedBy: source(row, scope),
    savedAt: row.savedAt.toISOString(),
    saves: row.saves,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Who saved the Draft last, as a Library item's history names who made an edit. */
function source(row: DraftRow, scope: Scope): SourceView {
  return viewSource({ machine: null, tabletId: null, accountId: row.savedByAccountId, account: row.savedByAccount, connectedApp: row.savedByConnectedApp }, scope);
}

function refuseViewer(scope: Scope): void {
  if (scope.kind === "nothing") throw new ForbiddenException(VIEWER_SEES_NO_DRAFTS);
}

function refuseTooManySteps(profile: Profile): void {
  if (profile.steps.length > MAX_DRAFT_STEPS) throw new BadRequestException(`A Draft holds at most ${MAX_DRAFT_STEPS} steps, and this profile has ${profile.steps.length}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Draft's id from a path: a UUID, else 404. */
export function readDraftId(id: string): string {
  if (!UUID.test(id)) throw draftNotFound();
  return id.toLowerCase();
}

function draftNotFound(): NotFoundException {
  return new NotFoundException("No such Draft");
}

/**
 * What a Draft is started from, from a request's body: `{ profileId, as }`,
 * a Library Profile, `as` "version" for Edit or "separate" for Duplicate;
 * `{ shape }`, a starting shape's key; or `{ file }`, a profile file's
 * content. 400 for anything else, or more than one of them.
 */
export function readDraftStart(body: unknown): DraftStart {
  const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const given = ["profileId", "shape", "file"].filter((name) => fields[name] !== undefined);
  if (given.length !== 1) throw new BadRequestException("Start a Draft from one of profileId, with as, a starting shape's key as shape, or a profile file's content as file");
  if (fields.profileId !== undefined) {
    if (!isRecordId(fields.profileId)) throw new BadRequestException("profileId must be a Profile's id");
    if (fields.as !== "version" && fields.as !== "separate") throw new BadRequestException('as must be "version", to Edit the Profile, or "separate", to Duplicate it');
    return { kind: "profile", profileId: fields.profileId, publishesAs: fields.as };
  }
  if (fields.shape !== undefined) {
    if (typeof fields.shape !== "string") throw new BadRequestException("shape must be a starting shape's key");
    return { kind: "shape", shape: fields.shape };
  }
  return { kind: "file", content: fields.file };
}

/** A Draft's save, from a request's body: `{ profile?, publishesAs?, saves }`, `saves` the count it started from. 400 for anything else. */
export function readDraftSave(body: unknown): DraftSave {
  const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const problems: string[] = [];
  if (typeof fields.saves !== "number" || !Number.isSafeInteger(fields.saves) || fields.saves < 1) problems.push("saves must be the count of saves the change started from, a whole number from 1");
  if (fields.publishesAs !== undefined && fields.publishesAs !== "version" && fields.publishesAs !== "separate") problems.push('publishesAs must be "version" or "separate"');
  if (fields.profile === undefined && fields.publishesAs === undefined) problems.push("Send profile, publishesAs or both to save");
  if (problems.length > 0) throw new BadRequestException(problems);
  return { profile: fields.profile, publishesAs: fields.publishesAs as DraftPublishesAs | undefined, saves: fields.saves as number };
}
