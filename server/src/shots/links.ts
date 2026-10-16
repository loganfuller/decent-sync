import { DYE2_SELECTION_FIELD, type LibraryKind } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { KINDS } from "../library/kinds.js";

// Shots linked to the Library (tickets #92 and #147). A Shot names its Bean
// Batch, Grinder and Basket by their ids on the tablet that reported it,
// which resolve to the Library's items through that tablet's map (ADR-0006). A Shot stored before
// Shots kept their tablet takes the tablet whose index lists it, as only a
// tablet holding the Shot lists it (`claimListed`), and is linked then: so
// once each tablet's plugin loads again, but for Shots no tablet holds any
// more. Each link is stored on the Shot once its tablet's map holds the
// id, as the Shot is stored or as the map gains the id later, so a Shot
// reported before its batch joined the Library is linked once it does. A
// link stays when the tablet's record leaves its map, as when a barista
// deletes it there: the Shot still used that batch.
//
// A Profile's id is Decaid's, the same on every tablet: a hash of what the
// machine executes (`ProfileHash.calculateProfileHash` in
// decaid:lib/src/models/data/profile_hash.dart), which a Shot's Workflow
// records as its profile, but not the id itself. So a Shot's Profile is read,
// with nothing stored, from that profile (`shotProfileSql`). What a skin
// overrides in the profile it loads is the barista's input to the Shot, not
// another profile: the yield, which streamline-js writes as its target
// weight, the temperature, which it writes into every step, and a limiter of
// value 0, which it sends as none. So a Shot's candidates are the Library
// Profiles holding the rest of what Decaid hashes (`stepsKeySql`), compared
// as JSON so a whole double Decaid writes as `92.0` equals 92, and of those
// it is the one whose title it recorded, then the one it holds most of as it
// is. The profile id a skin records in the Workflow is not used: the
// WorkFlow skin (Sabotage1/WorkFlow-Skin) records the Profile picked in it,
// which stays as it was when another skin loads another profile, as Decaid
// merges a Workflow's changes into it.
//
// A Shot's Recipe is the one its Workflow's DYE2 selection named
// (`context.extras.dye.selection`, ADR-0022), by the slot of the recipe it
// named, through its tablet's map of its recipes' slots, stored as its
// other ids' links are (`recipe_id`), where its Machine had that Recipe
// loaded as it was pulled, by its Loaded Recipes (`loaded_recipes`): a
// Capture-only Machine's Workflow names a recipe DYE2 has selected that is
// not its Loaded Recipe. A Shot whose selection named nothing
// (`selection_named` false), as one pulled while the plugin selects the slot
// again after its own write of a batch or grinder, which DYE2 clears its
// selection on, is stored naming the Recipe its Machine had loaded latest by
// its end, and linked to it where it still had it loaded as the Shot ended. Which Recipe its Machine had loaded is read, not stored
// (`shotRecipeSql`), so it follows the Loaded Recipes as their deliveries
// arrive, those of a tablet that was offline included, and the Shot's credit
// as it changes. A Shot's Tools are linked as its Basket is, each in its place among the ids
// DYE2 recorded (`library_tool_ids`), only so a Tool a Shot used is never
// hard-deleted once its record has left the tablet, as when it was Archived
// or hidden there: its page shows the names DYE2 stored.
//
// Every change to a tablet's map holds the tablet's row lock, and links the
// Shots it can then (`linkShots`); storing a Shot's metadata holds that row
// for share as it resolves its ids (`resolveLinks`). So either the map's
// change commits first, and the Shot's resolution finds it, or the Shot is
// stored first, and the map's change links it. Linking several Shots at once
// (`linkShots`, `claimListed`) locks their rows in no set order, as crediting
// a Machine's Shots to Locations and handing them over do: two of those
// touching the same Shots may deadlock, and PostgreSQL ends one. A delivery
// ended so is sent again on reconnect, and a request so fails, so either is
// tried again, rather than ordering every such update.

/** A kind's columns on a Shot, for a kind a Shot names by its id on its tablet (`shotLink` in library/kinds.ts): that id, and its link. */
function shotLinkOf(kind: LibraryKind): { local: string; link: string } {
  const columns = KINDS[kind].shotLink;
  if (!columns) throw new Error(`A Shot names no ${KINDS[kind].name}`);
  return columns;
}

/** The path of the id DYE2's selection names in a Shot's record, a recipe's its slot. */
const DYE2_SELECTION_ID = `{workflow,${DYE2_SELECTION_FIELD.split(".").join(",")},id}`;

/** A Shot's ids on its tablet, as its metadata names them, and its links. */
interface ShotLinks {
  beanBatchId: string | null;
  grinderId: string | null;
  basketId: string | null;
  toolIds: string[];
  libraryBatchId: string | null;
  libraryGrinderId: string | null;
  libraryBasketId: string | null;
  libraryToolIds: string[];
}

/**
 * The links of the Shot whose metadata the tablet reported, naming the ids
 * given, through the tablet's map, holding its row for share until the
 * transaction ends. An id the map does not hold keeps the link the Shot has
 * while it names the same id, as its record may have left the map since;
 * otherwise it is unlinked, until the map gains it (`linkShots`). The Shot's
 * links are read under the tablet's row, as a map change may have linked it
 * while this waited for that or for its credit's locks.
 */
export async function resolveLinks(
  tx: Prisma.TransactionClient,
  tabletId: string,
  shotId: string,
  ids: { beanBatchId: string | null; grinderId: string | null; basketId: string | null; toolIds: readonly string[]; recipeSlot: string | null },
): Promise<{ libraryBatchId: string | null; libraryGrinderId: string | null; libraryBasketId: string | null; libraryToolIds: string[]; recipeId: string | null }> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR SHARE`;
  const [resolved] = await tx.$queryRaw<{ batch: string | null; grinder: string | null; basket: string | null; recipe: string | null }[]>`
    SELECT
      (SELECT batch_id::text FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.beanBatchId}) AS batch,
      (SELECT grinder_id::text FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.grinderId}) AS grinder,
      (SELECT basket_id::text FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.basketId}) AS basket,
      (SELECT recipe_id::text FROM tablet_recipes WHERE tablet_id = ${tabletId}::uuid AND local_id = ${ids.recipeSlot}) AS recipe`;
  const tools = await tx.$queryRaw<{ localId: string; toolId: string }[]>`
    SELECT local_id AS "localId", tool_id::text AS "toolId" FROM tablet_tools WHERE tablet_id = ${tabletId}::uuid AND local_id = ANY(${[...ids.toolIds]}::text[])`;
  const [stored] = await tx.$queryRaw<(ShotLinks & { recipeSlot: string | null; recipeId: string | null })[]>`
    SELECT bean_batch_id AS "beanBatchId", grinder_id AS "grinderId", basket_id AS "basketId", tool_ids AS "toolIds",
      library_batch_id::text AS "libraryBatchId", library_grinder_id::text AS "libraryGrinderId", library_basket_id::text AS "libraryBasketId",
      library_tool_ids AS "libraryToolIds", record #>> ${DYE2_SELECTION_ID} AS "recipeSlot", recipe_id::text AS "recipeId"
    FROM shots WHERE id = ${shotId}`;
  const kept = (id: string | null, before: string | null | undefined, link: string | null | undefined) =>
    id !== null && id === before ? (link ?? null) : null;
  return {
    libraryBatchId: resolved?.batch ?? kept(ids.beanBatchId, stored?.beanBatchId, stored?.libraryBatchId),
    libraryGrinderId: resolved?.grinder ?? kept(ids.grinderId, stored?.grinderId, stored?.libraryGrinderId),
    libraryBasketId: resolved?.basket ?? kept(ids.basketId, stored?.basketId, stored?.libraryBasketId),
    // A slot holds another Recipe once its own moves: the one the Shot was stored naming is kept while it names that slot.
    recipeId: (ids.recipeSlot !== null && ids.recipeSlot === stored?.recipeSlot ? stored.recipeId : null) ?? resolved?.recipe ?? null,
    libraryToolIds: ids.toolIds.map((localId) => {
      const before = stored ? stored.toolIds.indexOf(localId) : -1;
      return tools.find((tool) => tool.localId === localId)?.toolId ?? (before === -1 ? NO_TOOL : (stored!.libraryToolIds[before] ?? NO_TOOL));
    }),
  };
}

/**
 * A Tool a Shot names by an id its tablet's map does not hold, in its links
 * (`library_tool_ids`), which follow the ids DYE2 recorded (`tool_ids`)
 * place for place.
 */
const NO_TOOL = "";

/**
 * Links each Shot the tablet reported naming the Tool's record by its id
 * there, but not linked to a Tool by it yet, to the Tool: as `linkShots`
 * does for a kind a Shot names one of, in its place among the Shot's Tools.
 */
export async function linkShotTools(tx: Prisma.TransactionClient, tabletId: string, toolId: string, localId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE shots AS s SET library_tool_ids = ARRAY(
      SELECT CASE WHEN listed.local = ${localId} AND coalesce(listed.link, '') = '' THEN ${toolId.toLowerCase()} ELSE coalesce(listed.link, '') END
      FROM unnest(s.tool_ids, s.library_tool_ids) WITH ORDINALITY AS listed(local, link, position) ORDER BY listed.position
    )
    WHERE s.tablet_id = ${tabletId}::uuid AND s.tool_ids @> ARRAY[${localId}]::text[]
      AND EXISTS (SELECT 1 FROM unnest(s.tool_ids, s.library_tool_ids) AS listed(local, link) WHERE listed.local = ${localId} AND coalesce(listed.link, '') = '')`;
}

/**
 * Links each Shot not linked yet that the tablet reported naming its record
 * by its id there to the item: called as the tablet's map comes to hold the
 * record under that id, with the tablet's row lock held, which storing a
 * Shot's metadata waits for.
 */
export async function linkShots(tx: Prisma.TransactionClient, kind: LibraryKind, tabletId: string, itemId: string, localId: string): Promise<void> {
  const { local, link } = shotLinkOf(kind);
  await tx.$executeRaw`
    UPDATE shots AS s SET ${Prisma.raw(link)} = ${itemId}::uuid
    WHERE s.${Prisma.raw(local)} = ${localId} AND s.${Prisma.raw(link)} IS NULL AND s.tablet_id = ${tabletId}::uuid`;
}

/**
 * Gives the Shots the tablet's index lists that have no tablet, as stored
 * before Shots kept the tablet reporting them, that tablet, and links them
 * through its map: a tablet listing a Shot holds it, so its ids are that
 * tablet's. Holds the tablet's row for share, as storing a Shot's metadata
 * does, so a map gaining an id meanwhile links them either way.
 */
export async function claimListed(tx: Prisma.TransactionClient, tabletId: string, shotIds: readonly string[]): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM tablets WHERE id = ${tabletId}::uuid FOR SHARE`;
  await tx.$executeRaw`
    UPDATE shots AS s SET tablet_id = ${tabletId}::uuid,
      library_batch_id = (SELECT batch_id FROM tablet_bean_batches WHERE tablet_id = ${tabletId}::uuid AND local_id = s.bean_batch_id),
      library_grinder_id = (SELECT grinder_id FROM tablet_grinders WHERE tablet_id = ${tabletId}::uuid AND local_id = s.grinder_id),
      library_basket_id = (SELECT basket_id FROM tablet_baskets WHERE tablet_id = ${tabletId}::uuid AND local_id = s.basket_id),
      library_tool_ids = ARRAY(
        SELECT coalesce((SELECT tool_id::text FROM tablet_tools WHERE tablet_id = ${tabletId}::uuid AND local_id = listed.local), '')
        FROM unnest(s.tool_ids) WITH ORDINALITY AS listed(local, position) ORDER BY listed.position
      )
    WHERE s.id = ANY(${shotIds}::text[]) AND s.tablet_id IS NULL`;
}

/** Whether a Shot is linked to any of the items, under the locks of the tablets whose maps hold them. */
export function shotLinkedSql(kind: LibraryKind, ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM shots WHERE ${Prisma.raw(shotLinkOf(kind).link)} = ANY(${[...ids]}::uuid[]))`;
}

/**
 * The id of the Recipe the Shot of `shots` aliased `alias` is linked to, or
 * null: the Recipe it names (`recipe_id`), where its Machine had that Recipe
 * loaded at some time while the Shot was pulled, from its start to its last
 * sample, by the tablet's clock, as both are; or, for a Shot whose selection
 * named nothing (`selection_named`), which names the Recipe its Machine had
 * loaded latest by its end as it was stored (`nameLoadedRecipe`), where that
 * was still loaded at the Shot's end: its Loaded Recipes run on unbroken
 * through the plugin's selecting the slot again after its own write, but one
 * a barista unloaded, as DYE2 clears its selection, is unloaded before. A
 * Shot started as DYE2 wrote its selection, before the plugin reported the
 * Workflow holding it, is still pulled with it. A Shot whose time is
 * unknown, or that no Machine has, is linked to none. A Machine's Loaded
 * Recipes follow one another, each loaded no earlier than the one before was
 * unloaded (loaded-recipes.ts), so of its entries for the Recipe loaded by
 * the Shot's end, the latest is the one unloaded last: the Shot is pulled
 * with it if that one was unloaded after the Shot started, or after it ended
 * for a Shot naming nothing, or not yet. That one entry is found through the
 * index on the Machine, the Recipe and when it was loaded, whatever the
 * history's length.
 */
export function shotRecipeSql(alias: string): Prisma.Sql {
  const shot = Prisma.raw(alias);
  const end = Prisma.sql`${shot}.pulled_at + make_interval(secs => coalesce(${shot}.duration, 0))`;
  return Prisma.sql`(CASE WHEN ${shot}.recipe_id IS NOT NULL THEN (
    SELECT CASE WHEN latest.unloaded_at IS NULL OR latest.unloaded_at > (CASE WHEN ${shot}.selection_named THEN ${shot}.pulled_at ELSE ${end} END)
      THEN latest.recipe_id END
    FROM (
      SELECT loaded.recipe_id, loaded.unloaded_at FROM loaded_recipes AS loaded
      WHERE loaded.machine_id = ${shot}.machine_id AND loaded.recipe_id = ${shot}.recipe_id AND loaded.loaded_at <= ${end}
      ORDER BY loaded.loaded_at DESC, loaded.id DESC LIMIT 1) AS latest) END)`;
}

/**
 * Has a Shot whose selection named nothing, once stored with its Machine and
 * time, name the Recipe its Machine had loaded latest by its end, as the
 * server knows its Loaded Recipes then, which `shotRecipeSql` links it to
 * where that was still loaded at its end. Found through the index on the
 * Machine and when each was loaded.
 */
export async function nameLoadedRecipe(tx: Prisma.TransactionClient, shotId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE shots AS s SET recipe_id = (
      SELECT loaded.recipe_id FROM loaded_recipes AS loaded
      WHERE loaded.machine_id = s.machine_id AND loaded.loaded_at <= s.pulled_at + make_interval(secs => coalesce(s.duration, 0))
      ORDER BY loaded.loaded_at DESC, loaded.id DESC LIMIT 1)
    WHERE s.id = ${shotId} AND NOT s.selection_named AND s.machine_id IS NOT NULL AND s.pulled_at IS NOT NULL`;
}

/** Whether a Shot is linked to any of the Recipes (`shotRecipeSql`), of those naming one of them, through the index on the Recipe they name. */
export function shotLinkedToRecipesSql(ids: readonly string[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM shots AS linked WHERE linked.recipe_id = ANY(${[...ids]}::uuid[]) AND ${shotRecipeSql("linked")} IS NOT NULL)`;
}

/**
 * A profile's steps as they identify it, through the indexes on them
 * (`profile_steps_key`, in the migration): without each step's temperature,
 * and with a limiter of value 0, which is no limiter, as none, as a skin
 * overrides or sends them in the profile it loads into the Workflow.
 */
export function stepsKeySql(steps: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`profile_steps_key(${steps})`;
}

/** What Decaid hashes for a Profile's id but its steps and target weight, which a skin may override. */
const HASHED = ["version", "beverage_type", "tank_temperature", "target_volume", "target_volume_count_start"] as const;

/** A Shot's Workflow's profile, of `shots` aliased `alias`. */
function workflowProfileSql(alias: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}.record -> 'workflow' -> 'profile')`;
}

/**
 * The id of the Library Profile the Shot of `shots` aliased `alias` was
 * pulled with, or null: of those holding its Workflow's profile's steps as
 * they identify it (`stepsKeySql`) and the rest of what Decaid hashes but
 * the target weight, the one whose title the Shot recorded, as a skin loads
 * a Profile under its own; then the one whose step temperatures and target
 * weight, both or either, the Shot holds, as overrides of neither; then the
 * one whose steps it holds as they are, limiters of value 0 and all, as a
 * copy saved of a profile a skin loaded keeps them as the skin sent them.
 * Two alike in all of that leave the Shot linked to neither. The Profiles'
 * steps are found through their index.
 */
export function shotProfileSql(alias: string): Prisma.Sql {
  return profileOfSql(workflowProfileSql(alias));
}

/**
 * The id of the Library Profile a profile, as a Workflow holds one, is, or
 * null, chosen as a Shot's is (`shotProfileSql`): as a DYE2 recipe names the
 * profile it read from the Workflow by that profile alone (recipes.ts).
 */
export function profileOfSql(profile: Prisma.Sql): Prisma.Sql {
  const same = HASHED.map((field) => Prisma.sql`p.content -> 'profile' -> ${field} IS NOT DISTINCT FROM ${profile} -> ${field}`);
  const temperatures = (of: Prisma.Sql) => Prisma.sql`jsonb_path_query_array(${of} -> 'steps', '$[*].temperature')`;
  return Prisma.sql`(
    SELECT CASE WHEN best.tied = 1 THEN best.id END FROM (
      SELECT ranked.id, count(*) OVER (PARTITION BY ranked."sameTitle", ranked."sameTemperatures", ranked."sameWeight", ranked."sameSteps") AS tied,
        ranked."sameTitle", ranked."sameTemperatures", ranked."sameWeight", ranked."sameSteps"
      FROM (
        SELECT p.id,
          coalesce(p.content -> 'profile' -> 'title' = ${profile} -> 'title', false) AS "sameTitle",
          coalesce(${temperatures(Prisma.sql`p.content -> 'profile'`)} = ${temperatures(profile)}, false) AS "sameTemperatures",
          coalesce(p.content -> 'profile' -> 'target_weight' = ${profile} -> 'target_weight', false) AS "sameWeight",
          coalesce(p.content -> 'profile' -> 'steps' = ${profile} -> 'steps', false) AS "sameSteps"
        FROM profiles AS p
        WHERE ${stepsKeySql(Prisma.sql`p.content -> 'profile' -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${profile} -> 'steps'`)}
          AND ${Prisma.join(same, " AND ")}
      ) AS ranked
      ORDER BY ranked."sameTitle" DESC, ranked."sameTemperatures" AND ranked."sameWeight" DESC, ranked."sameTemperatures" DESC,
        ranked."sameWeight" DESC, ranked."sameSteps" DESC, ranked.id
      LIMIT 1
    ) AS best
  )`;
}

/**
 * Whether the Shot of `shots` aliased `alias` was pulled with the Library
 * Profile (`shotProfileSql`), decided only for the Shots holding that
 * Profile's steps as they identify it and the rest of what Decaid hashes but
 * the target weight, found through the index on the Shots' steps.
 */
export function shotPulledWithSql(alias: string, profileId: string): Prisma.Sql {
  const shot = workflowProfileSql(alias);
  const target = Prisma.sql`(SELECT content -> 'profile' FROM profiles WHERE id = ${profileId})`;
  const same = HASHED.map((field) => Prisma.sql`${shot} -> ${field} IS NOT DISTINCT FROM ${target} -> ${field}`);
  return Prisma.sql`${stepsKeySql(Prisma.sql`${Prisma.raw(alias)}.record -> 'workflow' -> 'profile' -> 'steps'`)} = ${stepsKeySql(Prisma.sql`${target} -> 'steps'`)}
    AND ${Prisma.join(same, " AND ")} AND ${shotProfileSql(alias)} = ${profileId}`;
}
