import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { SHARED_SETTINGS, STEAM_ON_FROM, type SharedSetting } from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { locationNotFound } from "../locations/input.js";
import { machineNotFound } from "../machines/input.js";
import { lockMachine } from "../machines/machines.service.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { accountSource } from "./history.js";
import { INTAKE_TRANSACTION, currentLocation } from "./intake.js";
import { editSettings, lockSettings } from "./location-settings.js";
import { readLocationValues } from "./settings-intake.js";

// Each Location's steam, hot water and rinse settings, shared by its
// Machines whatever their model (ADR-0014), read by Staff as by Admins, and
// changed by Admins, and by Staff at their own Locations (ADR-0008's
// per-Location state). A change here is an edit by the account, timed by
// PostgreSQL's clock (ADR-0016), made over the settings as they stand, and
// written to the Location's Machines that share them, their steam settings
// only to those whose steam is on. Each Machine's sharing of them is turned
// on or off the same way.

/** A Machine at a Location, as its settings list it. */
export interface SharingMachineView {
  id: string;
  name: string;
  /** Its hardware's model, or for an Unidentified Machine the model it reports; null while neither is known. */
  model: string | null;
  /** Whether its tablet shares the Location's settings. */
  sharesSettings: boolean;
}

/** A Location's settings, as the REST API returns them. */
export interface LocationSettingsView {
  /** Their id; null while no Machine there sharing them has reported its Workflow, so none is set. */
  id: string | null;
  /** Each setting, by its name in SHARED_SETTINGS, such as `steamSettings.flow`; null while unset. */
  values: Record<SharedSetting, number | null>;
  /** The Location's Machines now, by name, sharing them or not. */
  machines: SharingMachineView[];
  /** Whether the signed-in account may change them, and switch its Machines' sharing: an Admin, or Staff working at the Location. */
  editable: boolean;
}

/** The settings whose values are whole numbers, as Decaid keeps them; it cuts a fraction off one. */
const WHOLE: ReadonlySet<SharedSetting> = new Set(SHARED_SETTINGS.filter((field) => !field.endsWith(".flow") && field !== "steamSettings.stopAtTemperature"));

@Injectable()
export class LocationSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The Location's settings, and its Machines now; 404 if there is no such Location. */
  async view(locationId: string, scope: Scope): Promise<LocationSettingsView> {
    const [location, row, machines] = await this.prisma.$transaction([
      this.prisma.location.findUnique({ where: { id: locationId }, select: { id: true } }),
      this.prisma.locationSettings.findUnique({ where: { locationId }, select: { id: true, values: true } }),
      this.prisma.$queryRaw<SharingMachineView[]>`
        SELECT machines.id, machines.name, machines.shares_settings AS "sharesSettings",
          CASE WHEN machines.model IS NOT NULL THEN machines.model WHEN machines.identification = 'UNIDENTIFIED' THEN machines.reported_model END AS model
        FROM machines
        WHERE (SELECT location_id FROM location_assignments WHERE machine_id = machines.id ORDER BY effective_from DESC LIMIT 1) = ${locationId}::uuid
        ORDER BY machines.name`,
    ]);
    if (!location) throw locationNotFound();
    const values = readLocationValues(row?.values);
    return {
      // A Machine with sharing turned off makes the row, with nothing set, to keep its tablet's settings against.
      id: row && Object.keys(values).length > 0 ? row.id : null,
      values: Object.fromEntries(SHARED_SETTINGS.map((field) => [field, values[field] ?? null])) as Record<SharedSetting, number | null>,
      machines,
      editable: includesLocation(scope, locationId),
    };
  }

  /**
   * Switches whether a Machine's tablet shares its Location's settings, under
   * the Machine's row lock, which taking in its Workflow holds: turned off,
   * nothing of them is taken from it or written to it; turned back on, it
   * is written the Location's, and its own changes count from then on. Tells
   * every instance its Location's tablets are to be written. 404 if there is
   * no such Machine, 403 for Staff unless it is at one of their Locations.
   */
  async setSharing(machineId: string, sharesSettings: boolean, scope: Scope): Promise<{ sharesSettings: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      const locationId = await currentLocation(tx, machineId);
      if (!includesLocation(scope, locationId)) throw new ForbiddenException("Staff turn settings sharing on or off only for Machines at their own Locations");
      // Turned on, it is timed, so a change its tablet made while sharing was off and delivers later stays its own.
      await tx.$executeRaw`
        UPDATE machines SET shares_settings = ${sharesSettings},
          shares_settings_since = CASE WHEN ${sharesSettings} AND NOT shares_settings THEN now() ELSE shares_settings_since END
        WHERE id = ${machineId}::uuid`;
      if (locationId !== null) await notify(tx, "library_changes", locationId);
    });
    return { sharesSettings };
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
    return this.view(locationId, scope);
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
