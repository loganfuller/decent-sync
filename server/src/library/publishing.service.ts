import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  type Profile,
  type ProfileCheck,
  type ProfileTextField,
  checkProfile,
  isRecordId,
  profileId,
  profileTextOf,
  readProfile,
  textEditOf,
} from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { editContent, lockItems, recordJoined } from "./content-edits.js";
import { type NewerVersion, VIEWER_SEES_NO_DRAFTS, newerVersions, readDraftId, versionContext } from "./drafts.service.js";
import { type EditSource, type Editor, accountSource } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { readContentEdit } from "./item-input.js";
import { BUNDLED_PROFILE_TEXT, LibraryEditsService, PROFILE_TITLE_LOCK, editTime, staffElsewhere } from "./library-edits.service.js";
import { lockLocation, showAt } from "./location-state.js";
import { profileText } from "./profile-intake.js";
import { accountModels, refuseUnrunnableAt } from "./profile-reach.js";
import { PROFILE_JOINING_LOCK } from "./profiles.js";
import { type ProfileVersionView, ProfilesService } from "./profiles.service.js";
import { recipeEditValues } from "./recipe-edits.service.js";
import { lockFollowingForDelete } from "./draft-following.js";

// Publishing a Draft, and returning to an earlier Profile Version (ADR-0032,
// ticket #580). Publishing makes the Draft a Library Profile under the id
// Decaid computes (`profileId`), saved from the Profile it started from
// (Decaid's `parentId`), as a new version of it or a separate Profile, as
// Streamline saves a Duplicate, shows it
// at the Locations chosen and discards the Draft, in one transaction, and
// needs no tablet online: the Library then writes it to those Locations'
// tablets as any Profile, parents first. A new version takes the old one's
// place at each Location chosen: the Recipes chosen move to it, each an edit
// of the Recipe by the person publishing, which keeps its Reference Shot and
// reaches the Machines that have it loaded as any edit does; and the old one
// is hidden there, but where a Recipe not moved still names it. Returning to
// an earlier version is the same change between two Profiles the Library has
// already, and creates nothing. A new version with the steps of the
// Profile it started from has that Profile's id, as Decaid's id leaves out
// the title, author and notes, so publishing it is an edit of those, made as
// the Profile page makes one, and creates nothing either (#667).
//
// Locks: first the Draft's row, which a save or discard of it alone takes;
// then, in the order a tablet's report of new profiles takes them
// (profiles.ts), PROFILE_JOINING_LOCK, so no tablet adds the same Profile
// meanwhile; then each Location's, in order; then PROFILE_TITLE_LOCK, as a
// title edit takes it, so no title is taken meanwhile; then the source
// Profile's row FOR KEY SHARE, which a title edit's update of it never waits on; then the
// Recipes' rows, as a Recipe's edit takes its row after its Location's.
// Publishing a text edit takes, after the Draft's row, the Profile's row and
// then PROFILE_TITLE_LOCK, as an edit of it on the Profile page does, and
// nothing else: a row lock FOR KEY SHARE, as another publish takes the
// Profile's, never waits on it.

/** A Location, as what publishing did names it. */
export interface PlaceRef {
  id: string;
  name: string;
}

/** A Recipe, as what publishing did names it: its name, null where it has none, and its Location. */
export interface RecipeRef {
  id: string;
  name: string | null;
  location: PlaceRef;
}

/** What publishing a Draft, or returning to an earlier version, did. */
export interface PublishedView {
  /** The Profile now shown at the Locations chosen: the one published, or the version returned to. */
  profile: { id: string; title: string | null };
  /** The Profile it took the place of: the one the Draft started from, for a new version, or the later version returned from; null for a separate Profile. */
  replaced: { id: string; title: string | null } | null;
  /** The Locations chosen, which show it. */
  shownAt: PlaceRef[];
  /** The Locations where the Profile it replaced was hidden. */
  hiddenAt: PlaceRef[];
  /** The Locations chosen that still show the Profile it replaced, as a Recipe there not moved names it, with those Recipes. */
  keptAt: { location: PlaceRef; recipes: RecipeRef[] }[];
  /** The Recipes moved to it. */
  moved: RecipeRef[];
  /** The newer versions of the Profile the Draft started from that the Library gained since it began, beside which this one now forks the chain; none for a return. */
  forked: NewerVersion[];
  /**
   * For a Draft with the steps of the Profile it started from, published as
   * a new version of it, which edits that Profile (#667): which of its
   * title, author and notes it changed. The Profile is then the one edited,
   * `replaced` null, and nothing is shown, hidden or moved. Null where
   * publishing made a Profile, and for a return.
   */
  edited: ProfileTextField[] | null;
}

/** Where a Draft is published, or a version returned to (`readPublishAsk`): the Locations to show it at, and the Recipes to move to it. */
export interface PublishAsk {
  locations: string[];
  recipes: string[];
}

/** Why a Draft that makes a Profile names Locations to show it at. */
const NO_LOCATIONS = "locations must list the ids of the Locations to show it at, at least one";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfilesService,
    private readonly edits: LibraryEditsService,
  ) {}

  /**
   * Publishes the Draft as it was at `saves`, its count of saves as the
   * person last read it: 409 where it was saved since, as they would publish
   * what they have not seen. It becomes a Library Profile under Decaid's id,
   * shown at the Locations, which Staff choose among their own only (403),
   * and the Draft is discarded. As a new version, the Profile it started from
   * takes the Recipes chosen, which must name it at one of the Locations, and
   * is hidden at each of them but where a Recipe not moved names it; as a
   * separate Profile it moves no Recipes and hides nothing. Refused, 409,
   * with the reasons, for what its checks stop (`checkProfile`): among them
   * steps a Library Profile has already, naming it, and a title a Profile
   * shown at one of the Locations has, but for the versions of the Profile a
   * new version replaces; and at a Location where a Machine can't run it
   * (`refuseUnrunnableAt`). Says the newer versions of the Profile it
   * started from that the Library gained since it began: it forks the chain
   * beside them. A new version with the steps of the Profile it started
   * from is an edit of that Profile instead (`publishTextEdit`), given no
   * Locations; any other Draft needs one at least (400). 404 for no such
   * Draft or Location; 403 for a Viewer.
   */
  async publish(id: string, ask: PublishAsk & { saves: number }, editor: Editor, scope: Scope): Promise<PublishedView> {
    if (scope.kind === "nothing") throw new ForbiddenException(VIEWER_SEES_NO_DRAFTS);
    const draftId = readDraftId(id);
    refuseElsewhere(ask.locations, scope, "publish a Profile");
    const draft = await this.prisma.draft.findUnique({ where: { id: draftId }, select: { startedFromId: true, publishesAs: true } });
    if (!draft) throw new NotFoundException("No such Draft");
    // The versions a new version replaces, whose titles it may share: read before the transaction, as the chain only grows.
    const chain =
      draft.publishesAs === "VERSION" && draft.startedFromId !== null
        ? replacedVersions(
            draft.startedFromId,
            await this.profiles.versions(draft.startedFromId, scope).catch((caught: unknown) => (caught instanceof NotFoundException ? [] : Promise.reject(caught))),
          )
        : new Set<string>();
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ profile: unknown; startedFromId: string | null; publishesAs: string; saves: number; createdAt: Date }[]>`
        SELECT profile, started_from_id AS "startedFromId", publishes_as::text AS "publishesAs", saves, created_at AS "createdAt"
        FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException("No such Draft");
      if (row.saves !== ask.saves)
        throw new ConflictException(`The Draft was saved since you read it, ${row.saves - ask.saves > 0 ? `${row.saves - ask.saves} more time${row.saves - ask.saves === 1 ? "" : "s"}` : "otherwise"}: read it again before publishing it`);
      const profile = readProfile(row.profile).profile;
      if (!profile) throw new ConflictException(`Draft ${draftId}'s profile can't be read as Decaid reads one`);
      const version = row.publishesAs === "VERSION";
      if (!version && ask.recipes.length > 0) throw new BadRequestException("A separate Profile moves no Recipes: the Profile it started from keeps them");
      if (version && row.startedFromId !== null && profileId(profile) === row.startedFromId) {
        const edited = await this.publishTextEdit(tx, draftId, profile, row.startedFromId, ask, editor);
        if (edited) return edited;
      }
      if (ask.locations.length === 0) throw new BadRequestException([NO_LOCATIONS]);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROFILE_JOINING_LOCK}::bigint)`;
      const places = await lockLocations(tx, ask.locations);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PROFILE_TITLE_LOCK}::bigint)`;

      const id = profileId(profile);
      const [same] = await tx.$queryRaw<{ id: string; title: string | null }[]>`SELECT id, content -> 'profile' ->> 'title' AS title FROM profiles WHERE id = ${id}`;
      const shownThere = await tx.$queryRaw<{ id: string; title: string | null }[]>`
        SELECT DISTINCT p.id, p.content -> 'profile' ->> 'title' AS title
        FROM profiles p JOIN profile_locations here ON here.profile_id = p.id
        WHERE here.location_id = ANY(${ask.locations}::uuid[]) AND here.shown AND NOT p.archived`;
      const checks = checkProfile(profile, {
        models: await accountModels(tx),
        libraryProfiles: same ? [{ id: same.id, title: same.title?.trim() || same.id }] : [],
        titlesInUse: shownThere.flatMap((other) => (other.title === null || chain.has(other.id) ? [] : [other.title])),
      });
      if (checks.blocking.length > 0) throw refusal(checks.blocking);

      // Saved from the Profile it started from, as Streamline saves a Duplicate, while the Library has it: one deleted since leaves nothing to save it from or replace.
      const [startedFrom] =
        row.startedFromId === null
          ? []
          : await tx.$queryRaw<{ id: string; title: string | null; bundled: boolean }[]>`
          SELECT id, content -> 'profile' ->> 'title' AS title, bundled FROM profiles WHERE id = ${row.startedFromId} FOR KEY SHARE`;
      // Only a new version takes its place.
      const source = version ? startedFrom : undefined;
      if (source?.bundled) throw new ConflictException(`"${source.title ?? source.id}" is one of Decaid's bundled Profiles, which a Draft can only publish as a separate Profile from`);
      const forked = source ? await newerVersions(tx, source.id, row.createdAt) : [];

      // A record as Decaid creates one, but for its id, times and visibility, which are each tablet's (`profileContent`).
      const content = { profile, parentId: startedFrom?.id ?? null, isDefault: false, metadata: null };
      const added = await tx.$executeRaw`
        INSERT INTO profiles (id, content, bundled, created_location_id) VALUES (${id}, ${JSON.stringify(content)}::jsonb, false, NULL)
        ON CONFLICT (id) DO NOTHING`;
      if (added === 0) throw new ConflictException(`Its steps are those of a Profile the Library has: ${id}`);
      const at = await editTime(tx);
      const by = accountSource(editor);
      await recordJoined(tx, { kind: "profile", id }, profileText(content), at, by);
      const done = await replaceAt(tx, { from: source?.id ?? null, to: id, places, recipes: ask.recipes }, by, at);
      await lockFollowingForDelete(tx, draftId);
      await tx.$executeRaw`DELETE FROM drafts WHERE id = ${draftId}::uuid`;
      return {
        profile: { id, title: profile.title.trim() || null },
        replaced: source ? { id: source.id, title: source.title?.trim() || null } : null,
        ...done,
        forked,
        edited: null,
      };
    }, INTAKE_TRANSACTION);
  }

  /**
   * Publishes a new version whose steps are those of the Profile it started
   * from, `sourceId`, so its id too (#667): an edit of that Profile's title,
   * author and notes, those the Draft changes, made as the Profile page
   * makes one (`LibraryEditsService.editProfile`), with its rules and what
   * comes of it: written to every tablet that holds it, kept in its history
   * under the editor, and refused, 409, for a title another Profile has and
   * for one of Decaid's bundled Profiles. The Draft is discarded, and
   * nothing else changes: the Profile stays shown where it is and keeps its
   * Recipes, so it is given no Locations or Recipes (400). Refused, 409, as
   * its checks stop it (`checkProfile`), one that changes none of these
   * among them. Undefined where the Library no longer has the Profile, which
   * publishing then adds again. Under the Draft's row lock.
   */
  private async publishTextEdit(
    tx: Prisma.TransactionClient,
    draftId: string,
    profile: Profile,
    sourceId: string,
    ask: PublishAsk,
    editor: Editor,
  ): Promise<PublishedView | undefined> {
    await lockItems(tx, "profile", [sourceId]);
    const [source] = await tx.$queryRaw<{ bundled: boolean }[]>`SELECT bundled FROM profiles WHERE id = ${sourceId}`;
    if (!source) return undefined;
    // Never so through the API, which starts no new version from one, but a bundled Profile's text is Decaid's.
    if (source.bundled) throw new ConflictException(BUNDLED_PROFILE_TEXT);
    // A title another Profile has is judged again by the edit, under PROFILE_TITLE_LOCK; this says so as a check.
    const { versionOf, libraryProfiles } = (await versionContext(tx, profile, sourceId))!;
    const checks = checkProfile(profile, { models: await accountModels(tx), libraryProfiles, versionOf });
    if (checks.blocking.length > 0) throw refusal(checks.blocking);
    if (ask.locations.length > 0 || ask.recipes.length > 0)
      throw new BadRequestException(
        "This Draft changes only the title, author or notes of the Profile it started from, so publishing it edits that Profile, which stays shown where it is with its Recipes: give no locations or recipes",
      );
    const edited = textEditOf(profile, versionOf) ?? [];
    const now = profileTextOf(profile);
    await this.edits.editProfile(sourceId, readContentEdit("profile", { content: Object.fromEntries(edited.map((field) => [field, now[field]])) }), editor, tx);
    await lockFollowingForDelete(tx, draftId);
    await tx.$executeRaw`DELETE FROM drafts WHERE id = ${draftId}::uuid`;
    return { profile: { id: sourceId, title: (edited.includes("title") ? now.title : versionOf.text.title).trim() || null }, replaced: null, shownAt: [], hiddenAt: [], keptAt: [], moved: [], forked: [], edited };
  }

  /**
   * Returns to an earlier version (`to`) of the Profile `from`, one of its
   * Profile Versions: shown at the Locations, which Staff choose among their
   * own only (403), with the Recipes chosen, which must name `from` at one
   * of them, moved to it, and `from` hidden at each but where a Recipe not
   * moved names it, as publishing a new version does; nothing is created.
   * 404 for no such Profile or Location; 409 for a Profile not among
   * `from`'s versions, one Archived, or one a Machine at a Location can't
   * run; 400 for returning to the Profile itself.
   */
  async returnTo(to: string, from: string, ask: PublishAsk, editor: Editor, scope: Scope): Promise<PublishedView> {
    refuseElsewhere(ask.locations, scope, "return to a Profile Version");
    if (to === from) throw new BadRequestException("A Profile can't return to itself: name a version other than from");
    const versions = await this.profiles.versions(from, scope);
    const earlier = versions.find((version) => version.id === to);
    const later = versions.find((version) => version.id === from);
    if (!earlier) {
      if ((await this.prisma.profile.count({ where: { id: to } })) === 0) throw new NotFoundException("No such Profile");
      throw new ConflictException(`That Profile is not a version of "${later?.title ?? from}"`);
    }
    return this.prisma.$transaction(async (tx) => {
      const places = await lockLocations(tx, ask.locations);
      // FOR SHARE, so no Archive of it commits before it is shown, leaving neither version shown; an Archive takes that row alone.
      const [row] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived FROM profiles WHERE id = ${to} FOR SHARE`;
      if (!row) throw new NotFoundException("No such Profile");
      if (row.archived) throw new ConflictException(`"${earlier.title ?? to}" is Archived: restore it before returning to it`);
      const done = await replaceAt(tx, { from, to, places, recipes: ask.recipes }, accountSource(editor), await editTime(tx));
      return { profile: { id: to, title: earlier.title }, replaced: { id: from, title: later?.title ?? null }, ...done, forked: [], edited: null };
    }, INTAKE_TRANSACTION);
  }
}

/**
 * The versions of a chain a new version of `sourceId` replaces, whose titles
 * it may share: the source and those it was saved from, and of the rest, as
 * a fork or a separate Profile saved from one of them, those titled as one
 * of these, compared as Streamline compares titles. A separate Profile
 * retitled is not among them, nor a bundled Profile the chain was saved
 * from: a tablet would show either beside the new version under one title.
 */
function replacedVersions(sourceId: string, versions: readonly ProfileVersionView[]): Set<string> {
  const saved = versions.filter((version) => !version.bundled);
  const byId = new Map(saved.map((version) => [version.id, version]));
  const lineage = new Set<string>();
  for (let at = byId.get(sourceId); at && !lineage.has(at.id); at = at.parentId === null ? undefined : byId.get(at.parentId)) lineage.add(at.id);
  const key = (title: string | null) => (title ?? "").trim().toLowerCase();
  const titles = new Set([...lineage].map((id) => key(byId.get(id)!.title)).filter((title) => title !== ""));
  return new Set(saved.filter((version) => lineage.has(version.id) || titles.has(key(version.title))).map((version) => version.id));
}

/** 403 for Staff choosing a Location they do not work at. */
function refuseElsewhere(locations: readonly string[], scope: Scope, what: string): void {
  if (locations.some((locationId) => !includesLocation(scope, locationId))) throw staffElsewhere(what);
}

/** The Locations, by id, each locked in order of id, so two publishes never wait on each other; 404 unless each exists. */
async function lockLocations(tx: Prisma.TransactionClient, ids: readonly string[]): Promise<PlaceRef[]> {
  const sorted = [...ids].sort();
  for (const id of sorted) await lockLocation(tx, id);
  const found = await tx.location.findMany({ where: { id: { in: sorted } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (found.length !== sorted.length) throw new NotFoundException("No such Location");
  return found;
}

/**
 * The Profile `to` takes the place of `from`, none for a separate Profile, at
 * each Location (`places`): shown there, which a Machine there that can't run
 * it refuses (409); each Recipe chosen, at one of them and naming `from`,
 * moved to it as an edit by `source`; and `from` hidden there unless a Recipe
 * there, not Archived, names it still. Notifies each Location. Under the
 * Locations' locks, taken by the caller.
 */
async function replaceAt(
  tx: Prisma.TransactionClient,
  change: { from: string | null; to: string; places: PlaceRef[]; recipes: readonly string[] },
  source: EditSource,
  at: Date,
): Promise<Omit<PublishedView, "profile" | "replaced" | "forked" | "edited">> {
  const { from, to, places } = change;
  const placeOf = new Map(places.map((place) => [place.id, place]));
  const [{ seenAt }] = await tx.$queryRaw<[{ seenAt: Date }]>`SELECT clock_timestamp() AS "seenAt"`;
  const shown = async (profile: string, locationId: string) =>
    (await tx.$queryRaw<unknown[]>`SELECT 1 FROM profile_locations WHERE profile_id = ${profile} AND location_id = ${locationId}::uuid AND shown`).length > 0;

  for (const place of places) {
    // A Profile reaches only the Machines that can run it (#588).
    await refuseUnrunnableAt(tx, to, place.id);
    if (!(await shown(to, place.id))) await showAt(tx, "profile", to, place.id, source, true, at, seenAt);
  }

  const moved: RecipeRef[] = [];
  const recipeIds = [...new Set(change.recipes.map((id) => id.toLowerCase()))].sort();
  if (recipeIds.length !== change.recipes.length) throw new BadRequestException("Name each Recipe once");
  await lockItems(tx, "recipe", recipeIds);
  const rows =
    recipeIds.length === 0
      ? []
      : await tx.$queryRaw<{ id: string; locationId: string | null; archived: boolean; content: Record<string, unknown> }[]>`
          SELECT id::text AS id, location_id::text AS "locationId", archived, content FROM recipes WHERE id = ANY(${recipeIds}::uuid[]) ORDER BY id`;
  if (rows.length !== recipeIds.length) throw new BadRequestException("No such Recipe");
  for (const recipe of rows) {
    const name = typeof recipe.content.name === "string" ? recipe.content.name : null;
    const place = recipe.locationId === null ? undefined : placeOf.get(recipe.locationId);
    if (!place) throw new BadRequestException(`The Recipe "${name ?? recipe.id}" is at none of the Locations chosen: choose its Location to move it`);
    if (recipe.archived) throw new ConflictException(`The Recipe "${name ?? recipe.id}" is Archived: restore it before moving it`);
    if (from === null || recipe.content.profileId !== from) throw new ConflictException(`The Recipe "${name ?? recipe.id}" doesn't name the Profile being replaced`);
    const set = await recipeEditValues(tx, place.id, { profileId: to }, recipe.content, source, at);
    await editContent(tx, { kind: "recipe", id: recipe.id }, { values: set, at, seenAt: "everything" }, source);
    moved.push({ id: recipe.id, name, location: place });
  }

  const hiddenAt: PlaceRef[] = [];
  const keptAt: PublishedView["keptAt"] = [];
  if (from !== null) {
    for (const place of places) {
      if (!(await shown(from, place.id))) continue;
      const naming = await tx.$queryRaw<{ id: string; name: string | null }[]>`
        SELECT id::text AS id, content ->> 'name' AS name FROM recipes
        WHERE location_id = ${place.id}::uuid AND content ->> 'profileId' = ${from} AND NOT archived
        ORDER BY content ->> 'name', id`;
      if (naming.length > 0) keptAt.push({ location: place, recipes: naming.map((recipe) => ({ ...recipe, location: place })) });
      else {
        await showAt(tx, "profile", from, place.id, source, false, at, seenAt);
        hiddenAt.push(place);
      }
    }
  }
  for (const place of places) await notify(tx, "library_changes", place.id);
  return { shownAt: places, hiddenAt, keptAt, moved };
}

/** 409 for a Draft its checks stop publishing, with each reason. */
function refusal(blocking: readonly ProfileCheck[]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: `The Draft can't be published: ${blocking.map((check) => check.message).join(" ")}`,
    checks: blocking,
  });
}

/**
 * Where a Draft is published, or a version returned to, from a request's
 * body: `{ locations, recipes? }`, the ids of the Locations to show it at, at
 * least one but where `atLeastOne` is false, and of the Recipes to move to it,
 * none where not given. 400 for anything else.
 */
export function readPublishAsk(body: unknown, atLeastOne = true): PublishAsk {
  const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const ids = (value: unknown) => Array.isArray(value) && value.every((each) => typeof each === "string" && UUID.test(each));
  const problems: string[] = [];
  if (!ids(fields.locations) || (atLeastOne && (fields.locations as string[]).length === 0)) problems.push(atLeastOne ? NO_LOCATIONS : "locations must list the ids of the Locations to show it at");
  if (fields.recipes !== undefined && !ids(fields.recipes)) problems.push("recipes must list the ids of the Recipes to move to it");
  if (problems.length > 0) throw new BadRequestException(problems);
  const locations = (fields.locations as string[]).map((id) => id.toLowerCase());
  if (new Set(locations).size !== locations.length) throw new BadRequestException("Name each Location once");
  return { locations, recipes: ((fields.recipes as string[] | undefined) ?? []).map((id) => id.toLowerCase()) };
}

/**
 * A Draft's publishing, from a request's body: where (`readPublishAsk`),
 * none for a Draft that edits the Profile it started from (#667), and
 * `saves`, the count of saves it was read at. 400 for anything else.
 */
export function readDraftPublish(body: unknown): PublishAsk & { saves: number } {
  const saves = (body as { saves?: unknown } | null)?.saves;
  if (typeof saves !== "number" || !Number.isSafeInteger(saves) || saves < 1) throw new BadRequestException("saves must be the Draft's count of saves as you read it, a whole number from 1");
  const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return { ...readPublishAsk({ ...fields, locations: fields.locations ?? [] }, false), saves };
}

/** A return to an earlier version, from a request's body: where (`readPublishAsk`), and `from`, the later version it takes the place of. 400 for anything else. */
export function readReturnAsk(body: unknown): PublishAsk & { from: string } {
  const from = (body as { from?: unknown } | null)?.from;
  if (!isRecordId(from)) throw new BadRequestException("from must be the id of the later version returned from");
  return { ...readPublishAsk(body), from };
}
