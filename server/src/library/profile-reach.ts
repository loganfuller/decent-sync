import { ConflictException } from "@nestjs/common";
import {
  DRAFT_KIND,
  LOADED_RECIPE_KIND,
  LOADED_RECIPE_PARTS,
  MACHINE_MODELS,
  type MachineModel,
  type Profile,
  type ValueOutOfRange,
  machineModelOf,
  outOfRangeText,
  profileOf,
  unrunnable,
} from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import type { PlannedChange, PlannedWrite } from "./holdings.js";
import { isObject } from "./listed.js";

// Where a Profile may reach (#588, ADR-0032). A DE1 and a Bengle run a
// profile's numbers in different ranges (MODEL_LIMITS in protocol/), and a
// value outside a DE1's wraps to another on the machine, so a Profile
// reaches only the Machines that can run it: a Location where any Machine
// can't refuses to show it, and so to keep a Recipe naming it, which shows
// it there; and the server writes it to no Machine that can't, nor a Recipe
// or Loaded Recipe carrying it, as when such a Machine moved to a Location
// that shows it. A Machine's model is its bound hardware's
// (`machineModelOf`): a DE1 for any other name, and for none, which keeps
// one whose hardware isn't known yet, as one not yet bound, to the narrower
// ranges, and says so.

/** A Machine at a Location, with its model, and whether its hardware is known, which a Machine not yet bound's isn't. */
interface PlacedMachine {
  id: string;
  name: string;
  model: MachineModel;
  known: boolean;
}

/** The models the account has Machines of, in MACHINE_MODELS order: a Draft is held to the widest of their ranges (`checkProfile`); a DE1 alone for none. */
export async function accountModels(db: Prisma.TransactionClient): Promise<MachineModel[]> {
  const rows = await db.$queryRaw<{ model: string | null }[]>`SELECT DISTINCT model FROM machines`;
  const models = new Set(rows.map((row) => machineModelOf(row.model)));
  return models.size === 0 ? ["DE1"] : MACHINE_MODELS.filter((model) => models.has(model));
}

/** The Machines at the Location now, by their latest Location History entry, capture-only ones too, by name. */
async function machinesAt(tx: Prisma.TransactionClient, locationId: string): Promise<PlacedMachine[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; model: string | null }[]>`
    SELECT m.id::text AS id, m.name, m.model FROM machines AS m
    JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS here ON true
    WHERE here.location_id = ${locationId}::uuid
    ORDER BY m.name`;
  return rows.map((row) => ({ id: row.id, name: row.name, model: machineModelOf(row.model), known: row.model !== null }));
}

/**
 * Refuses, 409, a Profile at a Location where any Machine can't run its
 * values, as showing it there, or a Recipe there naming it, would offer it
 * to that Machine: naming the Location, each such Machine and its model,
 * or that its hardware isn't known yet, and the values. A Profile whose
 * profile Decaid would not read is let through, as nothing of it can be
 * judged, and so is one the Library does not have, which the caller
 * refuses itself.
 */
export async function refuseUnrunnableAt(tx: Prisma.TransactionClient, profileId: string, locationId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ profile: unknown }[]>`SELECT content -> 'profile' AS profile FROM profiles WHERE id = ${profileId}`;
  const profile = profileOf(row?.profile);
  if (!profile) return;
  const machines = await machinesAt(tx, locationId);
  const cant = MACHINE_MODELS.flatMap((model) => {
    const values = unrunnable(profile, model);
    const these = machines.filter((machine) => machine.model === model);
    return values.length === 0 || these.length === 0 ? [] : [{ model, machines: these, values }];
  });
  if (cant.length === 0) return;
  const [location] = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM locations WHERE id = ${locationId}::uuid`;
  const why = cant.flatMap(({ model, machines: these, values }) => {
    const text = values.map((value) => outOfRangeText(profile, value)).join("; ");
    const known = these.filter((machine) => machine.known).map((machine) => machine.name);
    const unknown = these.filter((machine) => !machine.known).map((machine) => machine.name);
    return [
      ...(known.length === 0 ? [] : [`${listed(known)} ${known.length > 1 ? `are ${model}s` : `is a ${model}`}, which can't run ${text}`]),
      ...(unknown.length === 0
        ? []
        : [
            unknown.length > 1
              ? `The hardware of ${listed(unknown)} isn't known yet, so they are held to a ${model}'s ranges and can't run ${text}`
              : `${unknown[0]}'s hardware isn't known yet, so it is held to a ${model}'s ranges and can't run ${text}`,
          ]),
    ];
  });
  throw new ConflictException({
    statusCode: 409,
    error: "Conflict",
    message: `"${profile.title}" can't reach ${location?.name ?? "this Location"}: ${why.join(". ")}.`,
    machines: cant.flatMap(({ machines: these }) => these),
  });
}

/** Names joined for a person: "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The changes due to the Machine's tablet, each write carrying a profile
 * the Machine's model can't run marked as not to be written, with why
 * (`PlannedWrite.notWritten`), which its writer records as refused and its
 * sharing status shows: a Profile's record created, or made visible, a
 * Recipe's record carrying its Profile (`profileSnapshot`, and the
 * Workflow DYE2 derives), and a Loaded Recipe's Profile, or the profile of
 * the Draft the Machine follows, written into the Workflow. Each is judged on the Library's Profile as authored, never on
 * the copy a Recipe's Workflow holds moved to its brew temperature
 * (`recipeWorkflow`), as a Recipe's checks are. Read in the caller's
 * snapshot.
 */
export async function markUnrunnable(tx: Prisma.TransactionClient, machineId: string, changes: PlannedChange[]): Promise<PlannedChange[]> {
  const carried = changes.map((change) => carriedProfile(change));
  if (carried.every((profile) => profile === null)) return changes;
  const [machine] = await tx.$queryRaw<{ model: string | null }[]>`SELECT model FROM machines WHERE id = ${machineId}::uuid`;
  const model = machineModelOf(machine?.model);
  const known = typeof machine?.model === "string";
  // A Profile's record made visible carries no content: the Library's is what the tablet holds.
  const ids = carried.flatMap((profile) => (profile !== null && "id" in profile ? [profile.id] : []));
  const contents =
    ids.length === 0
      ? new Map<string, unknown>()
      : new Map((await tx.$queryRaw<{ id: string; profile: unknown }[]>`SELECT id, content -> 'profile' AS profile FROM profiles WHERE id = ANY(${ids}::text[])`).map((row) => [row.id, row.profile]));
  // A Recipe's Workflow holds its Profile moved to its brew temperature: the Profile it names is judged instead.
  const recipeIds = carried.flatMap((profile) => (profile !== null && "recipeId" in profile ? [profile.recipeId] : []));
  const named =
    recipeIds.length === 0
      ? new Map<string, unknown>()
      : new Map(
          (
            await tx.$queryRaw<{ id: string; profile: unknown }[]>`
              SELECT r.id::text AS id, p.content -> 'profile' AS profile FROM recipes AS r
              JOIN profiles AS p ON p.id = r.content ->> 'profileId'
              WHERE r.id = ANY(${recipeIds}::uuid[])`
          ).map((row) => [row.id, row.profile]),
        );
  return changes.map((change, index) => {
    const found = carried[index];
    if (found === null || found === undefined || !("fields" in change)) return change;
    const profile = profileOf("id" in found ? contents.get(found.id) : "recipeId" in found ? (named.get(found.recipeId) ?? found.raw) : found.raw);
    if (!profile) return change;
    const values = unrunnable(profile, model);
    if (values.length === 0) return change;
    return { ...change, notWritten: notWrittenWhy(change, profile, model, known, values) };
  });
}

/**
 * The profile a write carries to the tablet: as written; by the Profile's id
 * where it makes the tablet's record visible; or, for a Recipe's record
 * carrying it only in its Workflow, as the Profile the Recipe names, the
 * Workflow's copy where it names none of the Library's. Null for none.
 */
function carriedProfile(change: PlannedChange): { raw: unknown } | { id: string } | { recipeId: string; raw: unknown } | null {
  if (!("fields" in change) || "remove" in change) return null;
  const { fields } = change;
  if (change.kind === "profile") {
    if (change.localId === null) return { raw: fields.profile };
    return fields.visibility === "visible" ? { id: change.globalId } : null;
  }
  if (change.kind === "recipe") {
    if (fields.profileSnapshot !== undefined && fields.profileSnapshot !== null) return { raw: fields.profileSnapshot };
    return isObject(fields.workflow) && isObject(fields.workflow.profile) ? { recipeId: change.globalId, raw: fields.workflow.profile } : null;
  }
  if (change.kind === LOADED_RECIPE_KIND) {
    const field = LOADED_RECIPE_PARTS.profile[0];
    return fields[field] === undefined || fields[field] === null ? null : { raw: fields[field] };
  }
  // The profile of the Draft the Machine follows (ADR-0032).
  if (change.kind === DRAFT_KIND) return { raw: fields.profile };
  return null;
}

/** Why a write is not made to a Machine of the model, or held to its ranges as its hardware isn't known, for its sharing status. */
function notWrittenWhy(change: PlannedWrite, profile: Profile, model: MachineModel, known: boolean, values: readonly ValueOutOfRange[]): string {
  const what = change.kind === "profile" ? "this Profile" : change.kind === DRAFT_KIND ? "this Draft" : `its Profile, "${profile.title}"`;
  const who = known ? `a ${model} can't run` : `this Machine's hardware isn't known yet, so it is held to a ${model}'s ranges and can't run`;
  return `Not written: ${who} ${what}: ${values.map((value) => outOfRangeText(profile, value)).join("; ")}`;
}
