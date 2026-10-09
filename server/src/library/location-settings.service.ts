import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { SHARED_SETTINGS, STEAM_ON_FROM, type SharedSetting } from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { locationNotFound } from "../locations/input.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { accountSource } from "./history.js";
import { INTAKE_TRANSACTION } from "./intake.js";
import { editSettings, lockSettings } from "./location-settings.js";
import { readLocationValues } from "./settings-intake.js";

// Each Location's steam, hot water and rinse settings per Machine model
// (ADR-0014), read by Staff as by Admins, and changed by Admins, and by Staff
// at their own Locations (ADR-0008's per-Location state). A change here is an
// edit by the account, timed by PostgreSQL's clock (ADR-0016), made over the
// settings as they stand, and written to the Location's Machines of that
// model whose steam is on, or, for hot water and rinse, to all of them.

/** A Location's settings for one model, as the REST API returns them. */
export interface LocationSettingsView {
  /** Their id; null while no Machine of the model there has reported its Workflow, so none are set. */
  id: string | null;
  model: string;
  /** Each setting, by its name in SHARED_SETTINGS, such as `steamSettings.flow`; null while unset. */
  values: Record<SharedSetting, number | null>;
  /** The Location's Machines of the model now, by name. */
  machines: { id: string; name: string }[];
  /** Whether the signed-in account may change them: an Admin, or Staff working at the Location. */
  editable: boolean;
}

/** The settings whose values are whole numbers, as Decaid keeps them; it cuts a fraction off one. */
const WHOLE: ReadonlySet<SharedSetting> = new Set(SHARED_SETTINGS.filter((field) => !field.endsWith(".flow") && field !== "steamSettings.stopAtTemperature"));

@Injectable()
export class LocationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The Location's settings for each model it has settings for or a Machine
   * of now, by model; 404 if there is no such Location.
   */
  async list(locationId: string, scope: Scope): Promise<LocationSettingsView[]> {
    const [location, rows, machines] = await this.prisma.$transaction([
      this.prisma.location.findUnique({ where: { id: locationId }, select: { id: true } }),
      this.prisma.locationSettings.findMany({ where: { locationId }, select: { id: true, model: true, values: true } }),
      this.prisma.$queryRaw<{ id: string; name: string; model: string | null }[]>`
        SELECT machines.id, machines.name,
          CASE WHEN machines.model IS NOT NULL THEN machines.model WHEN machines.identification = 'UNIDENTIFIED' THEN machines.reported_model END AS model
        FROM machines
        WHERE (SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1) = ${locationId}::uuid
        ORDER BY machines.name`,
    ]);
    if (!location) throw locationNotFound();
    const models = [...new Set([...rows.map((row) => row.model), ...machines.flatMap((machine) => (machine.model === null ? [] : [machine.model]))])];
    models.sort((a, b) => a.localeCompare(b));
    const editable = includesLocation(scope, locationId);
    return models.map((model) => {
      const row = rows.find((candidate) => candidate.model === model);
      const values = readLocationValues(row?.values);
      return {
        id: row?.id ?? null,
        model,
        values: Object.fromEntries(SHARED_SETTINGS.map((field) => [field, values[field] ?? null])) as Record<SharedSetting, number | null>,
        machines: machines.filter((machine) => machine.model === model).map(({ id, name }) => ({ id, name })),
        editable,
      };
    });
  }

  /**
   * Changes settings, as the account's edit made over them as they stand
   * (ADR-0020), and tells every instance the Location's tablets are to be
   * written. 404 if there are no such settings, 403 for Staff at another
   * Location.
   */
  async edit(id: string, values: Partial<Record<SharedSetting, number>>, accountId: string, scope: Scope): Promise<LocationSettingsView> {
    const locationId = await this.prisma.$transaction(async (tx) => {
      const settings = await lockSettings(tx, id);
      if (!settings) throw settingsNotFound();
      if (!includesLocation(scope, settings.locationId)) throw new ForbiddenException("Staff change the settings of their own Locations only");
      // Timed by PostgreSQL's clock (ADR-0016), to the millisecond it keeps.
      const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT now()::timestamptz(3) AS at`;
      const edited = await editSettings(tx, id, { values, at, seenAt: "everything" }, accountSource(accountId));
      if (edited.writesDue) await notify(tx, "library_changes", settings.locationId);
      return settings.locationId;
    }, INTAKE_TRANSACTION);
    const views = await this.list(locationId, scope);
    return views.find((view) => view.id === id)!;
  }
}

/**
 * The settings a change sets, from its body, `{ values }`, each by its name
 * in SHARED_SETTINGS: a number of 0 or more, a whole one where Decaid keeps
 * a whole number, and a steam target temperature of 135 °C or more, as
 * turning steam off is not shared (ADR-0014). At least one.
 */
export function readSettingsEdit(body: unknown): Partial<Record<SharedSetting, number>> {
  const values = typeof body === "object" && body !== null ? (body as { values?: unknown }).values : undefined;
  if (typeof values !== "object" || values === null || Array.isArray(values) || Object.keys(values).length === 0) {
    throw new BadRequestException("Send the settings to change as values, each by its name, such as steamSettings.flow");
  }
  const problems: string[] = [];
  const read: Partial<Record<SharedSetting, number>> = {};
  for (const [field, value] of Object.entries(values)) {
    if (!(SHARED_SETTINGS as readonly string[]).includes(field)) problems.push(`${field} is not a shared setting`);
    else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) problems.push(`${field} must be a number of 0 or more`);
    else if (WHOLE.has(field as SharedSetting) && !Number.isInteger(value)) problems.push(`${field} must be a whole number`);
    else if (field === "steamSettings.targetTemperature" && value < STEAM_ON_FROM) {
      problems.push(`steamSettings.targetTemperature must be at least ${STEAM_ON_FROM} °C: turning steam off is each Machine's own`);
    } else read[field as SharedSetting] = value;
  }
  if (problems.length > 0) throw new BadRequestException(problems);
  return read;
}

/** Settings' id from a path; anything that is not a UUID names none. */
export function readSettingsId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw settingsNotFound();
  return id;
}

function settingsNotFound(): NotFoundException {
  return new NotFoundException("No such Location settings");
}
