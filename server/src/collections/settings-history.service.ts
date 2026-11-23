import { BadRequestException, Injectable } from "@nestjs/common";
import {
  type HistoryFieldChange,
  SETTINGS_HISTORY_COLLECTIONS,
  type SettingsHistoryCollection,
  isSettingsHistoryCollection,
  settingsHistoryChanges,
} from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { readTime } from "../machines/input.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import { type SettingsEditView, SettingsEditsService } from "../settings-edits/settings-edits.service.js";
import { type SoftwareActionView, SoftwareActionsService } from "../software-actions/software-actions.service.js";
import { shownPluginSettings, shownSetting } from "./plugin-settings.js";
import type { CollectionView } from "./collections.service.js";

// Reading a Machine's Settings History (#433), which settings-history.ts
// records: its changes, newest first, each a value's fields changed from the
// value before it, as `settingsHistoryChanges` compares and folds them, and
// its collections as last received at or before a time. A history's order is
// the order its rows were written, by id, which a report is compared in
// (COLLECTIONS.md, Settings History). Its changes are also read merged with
// the Machine's Settings Edits that changed nothing (#545), as its page
// lists them.

/** What a list of a Machine's Settings History's changes is narrowed to. */
export interface SettingsHistoryFilters {
  /** The collections whose changes to list; every one a Settings History keeps if none. */
  collections?: readonly SettingsHistoryCollection[];
  /** Received at or after this moment. */
  from?: Date;
  /** Received before this moment. */
  to?: Date;
  /** Whether to list brief changes, those changed back within about 2 minutes, which are left out otherwise. */
  includeBrief: boolean;
}

/** One field's change, as the REST API gives it. */
export interface SettingsHistoryFieldView {
  /**
   * The field as a Settings History compares it: a field's name, as Decaid
   * names it; a wake schedule's `schedules/<id>`; a sensor calibration's
   * target; a plugin's, paired device's or sensor's id; or "" for a value
   * that is no object or list of entries with ids.
   */
  field: string;
  change: "added" | "changed" | "removed";
  /** As compared: a wake schedule's fields, a sensor calibration's `measuredValue`, a paired device without how it is connected. Null where absent. */
  before: unknown;
  after: unknown;
  /** For a brief change, made outside Decent Sync and changed back within about 2 minutes, when it was changed back; null for any other. */
  backAt: string | null;
}

/** The Settings Edit that made a change, and who made it, as the REST API names them in a Settings Edit. */
export interface SettingsHistorySourceView {
  id: string;
  /** Named to Admins only; null once the account is gone. */
  account: { id: string; name: string | null } | null;
  /** The Connected App it was made through; null for the management interface. */
  connectedApp: { id: string; name: string; host: string } | null;
}

/** A change of one collection, as the REST API lists it. */
export interface SettingsHistoryChangeView {
  /**
   * The id of the value whose change it is. A read-back of a Settings Edit
   * that holds changes made outside it too gives two changes of that id,
   * one for each.
   */
  id: string;
  /** When the server received the value, by PostgreSQL's clock. */
  receivedAt: string;
  collection: SettingsHistoryCollection;
  /** The Settings Edit whose read-back made these changes; null for changes made outside Decent Sync, which are tied to no person, and for a Software Action's. */
  settingsEdit: SettingsHistorySourceView | null;
  /** The Software Action whose read-back made these changes (ADR-0034), with what it did; null for any other change. */
  softwareAction: (SettingsHistorySourceView & { kind: string }) | null;
  fields: SettingsHistoryFieldView[];
}

export interface SettingsHistoryPage {
  changes: SettingsHistoryChangeView[];
  total: number;
  limit: number;
  offset: number;
}

/** What a list of a Machine's Settings History with its Settings Edits is narrowed to. */
export interface SettingsHistoryWithEditsFilters extends SettingsHistoryFilters {
  /** Whether to list only what was made through a Settings Edit: the changes one made, and the edits that changed nothing. */
  editsOnly: boolean;
}

/**
 * An entry of a Machine's Settings History with its Settings Edits: a change,
 * with the Settings Edit that made it, if one did, or a Settings Edit that
 * changed nothing.
 */
export interface SettingsHistoryEntryView {
  /** When the server received the change, or, for a Settings Edit that changed nothing, when it was made; by PostgreSQL's clock. */
  at: string;
  collection: string;
  /** The change, by the id of the value whose change it is; null for a Settings Edit that changed nothing. */
  change: { id: string; fields: SettingsHistoryFieldView[] } | null;
  /**
   * The Settings Edit that made the change, or that changed nothing, as the
   * REST API gives a Settings Edit, with what came of it; null for a change
   * made outside Decent Sync.
   */
  settingsEdit: SettingsEditView | null;
  /** The Software Action that made the change (ADR-0034), as the REST API gives one; null for any other change. */
  softwareAction: SoftwareActionView | null;
}

export interface SettingsHistoryWithEditsPage {
  entries: SettingsHistoryEntryView[];
  total: number;
  limit: number;
  offset: number;
}

type Page = { limit: number; offset: number };

/** The client a read is made through: the service's own, or a transaction's. */
type Db = PrismaService | Prisma.TransactionClient;

/** A value of the history, as read to work out its changes. */
interface Row {
  id: bigint;
  name: string;
  value: unknown;
  receivedAt: Date;
  settingsEditId: string | null;
  softwareActionId: string | null;
  editedFields: string[] | null;
}

/** A change before it is given as the REST API gives it. */
interface Found {
  row: Row;
  collection: SettingsHistoryCollection;
  settingsEditId: string | null;
  softwareActionId: string | null;
  fields: HistoryFieldChange[];
}

/**
 * A Machine's Settings History, as the REST API and the MCP endpoint read
 * it. Every account that reads the Machine reads it; who made a Settings
 * Edit is named as the REST API names it in the edit.
 */
@Injectable()
export class SettingsHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly edits: SettingsEditsService,
    private readonly actions: SoftwareActionsService,
  ) {}

  /**
   * A page of the Machine's changes, newest first, with how many match. Each
   * collection's whole history is read and its changes worked out
   * (`settingsHistoryChanges`), then those received in the range kept, so a
   * brief change is folded wherever a range or page ends. The first value of
   * each collection, its baseline, is no change.
   */
  async changes(machineId: string, filters: SettingsHistoryFilters, page: Page, scope: Scope): Promise<SettingsHistoryPage> {
    await this.requireMachine(this.prisma, machineId);
    const { found } = await this.found(this.prisma, machineId, filters);
    const shown = found.slice(page.offset, page.offset + page.limit);
    const sources = await this.sources(shown, scope);
    const actions = await this.actions.viewsOf(this.prisma, [...new Set(shown.flatMap((change) => change.softwareActionId ?? []))], scope);
    return {
      changes: shown.map(({ row, collection, settingsEditId, softwareActionId, fields }) => {
        const action = softwareActionId === null ? undefined : actions.get(softwareActionId);
        return {
          id: String(row.id),
          receivedAt: row.receivedAt.toISOString(),
          collection,
          settingsEdit: settingsEditId === null ? null : (sources.get(settingsEditId) ?? null),
          softwareAction: action ? { id: action.id, kind: action.kind, account: action.account, connectedApp: action.connectedApp } : null,
          fields: fields.map((field) => fieldView(collection, field, scope)),
        };
      }),
      total: found.length,
      ...page,
    };
  }

  /**
   * A page of the Machine's Settings History with its Settings Edits (#545),
   * newest first, with how many entries match: its changes, as `changes`
   * lists them, each with the Settings Edit that made it whole, so with what
   * came of it; and each Settings Edit that changed nothing, placed by when
   * it was made: one still pending, refused or not confirmed, or one whose
   * read-back held nothing new of what it set, as when the Machine put a
   * value back. A Settings Edit that made a change is listed only as that
   * change. `editsOnly` leaves out the changes made outside Decent Sync.
   * The collections and the times narrow both; brief changes are none of a
   * Settings Edit's.
   *
   * The history and the edits are read from one snapshot, so an edit whose
   * read-back arrives meanwhile is listed once, as a change or as an edit
   * that has changed nothing yet.
   */
  async withEdits(machineId: string, filters: SettingsHistoryWithEditsFilters, page: Page, scope: Scope): Promise<SettingsHistoryWithEditsPage> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.requireMachine(tx, machineId);
        const { found, madeBy } = await this.found(tx, machineId, filters);
        const changes = filters.editsOnly ? found.filter((change) => change.settingsEditId !== null) : found;
        const unchanged = (await this.edits.made(tx, machineId, filters)).filter((edit) => !madeBy.has(edit.id));
        // Each list is newest first, and stays in its own order: a change goes before an edit made no later than it was received.
        const merged: ({ change: Found } | { edit: (typeof unchanged)[number] })[] = [];
        let next = 0;
        for (const change of changes) {
          while (next < unchanged.length && unchanged[next]!.madeAt > change.row.receivedAt) merged.push({ edit: unchanged[next++]! });
          merged.push({ change });
        }
        for (; next < unchanged.length; next++) merged.push({ edit: unchanged[next]! });
        const shown = merged.slice(page.offset, page.offset + page.limit);
        const ids = shown.flatMap((entry) => ("edit" in entry ? [entry.edit.id] : entry.change.settingsEditId === null ? [] : [entry.change.settingsEditId]));
        const views = await this.edits.viewsOf(tx, [...new Set(ids)], scope);
        const actions = await this.actions.viewsOf(tx, [...new Set(shown.flatMap((entry) => ("change" in entry ? (entry.change.softwareActionId ?? []) : [])))], scope);
        return {
          entries: shown.map((entry): SettingsHistoryEntryView => {
            if ("edit" in entry) return { at: entry.edit.madeAt.toISOString(), collection: entry.edit.collection, change: null, settingsEdit: views.get(entry.edit.id) ?? null, softwareAction: null };
            const { row, collection, settingsEditId, softwareActionId, fields } = entry.change;
            return {
              at: row.receivedAt.toISOString(),
              collection,
              change: { id: String(row.id), fields: fields.map((field) => fieldView(collection, field, scope)) },
              settingsEdit: settingsEditId === null ? null : (views.get(settingsEditId) ?? null),
              softwareAction: softwareActionId === null ? null : (actions.get(softwareActionId) ?? null),
            };
          }),
          total: merged.length,
          ...page,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * The Machine's changes that match the filters, newest first, as written,
   * a read-back's own changes before those made outside it; and `madeBy`,
   * the Settings Edits that made any change of the collections read,
   * whenever it was received.
   */
  private async found(db: Db, machineId: string, filters: SettingsHistoryFilters): Promise<{ found: Found[]; madeBy: Set<string> }> {
    // Each once, however often it is named.
    const names = [...new Set(filters.collections ?? SETTINGS_HISTORY_COLLECTIONS)];
    const rows = await db.$queryRaw<Row[]>`
      SELECT id, name, value, received_at AS "receivedAt", settings_edit_id AS "settingsEditId", software_action_id AS "softwareActionId", edited_fields AS "editedFields"
      FROM settings_history
      WHERE machine_id = ${machineId}::uuid AND name = ANY(${names}::text[])
      ORDER BY id`;
    const found: Found[] = [];
    const madeBy = new Set<string>();
    for (const collection of names) {
      const values = rows.filter((row) => row.name === collection);
      const changes = settingsHistoryChanges(
        collection,
        values.map((row) => ({ value: row.value, receivedAt: row.receivedAt.getTime(), settingsEditId: row.settingsEditId, softwareActionId: row.softwareActionId, editedFields: row.editedFields ?? [] })),
      );
      for (const { index, settingsEditId, softwareActionId, fields } of changes) {
        if (settingsEditId !== null) madeBy.add(settingsEditId);
        const row = values[index]!;
        if (filters.from && row.receivedAt < filters.from) continue;
        if (filters.to && row.receivedAt >= filters.to) continue;
        const shown = filters.includeBrief ? fields : fields.filter((field) => field.backAt === null);
        if (shown.length > 0) found.push({ row, collection, settingsEditId, softwareActionId, fields: shown });
      }
    }
    const outside = (change: Found) => (change.settingsEditId === null && change.softwareActionId === null ? 1 : 0);
    found.sort((a, b) => Number(b.row.id - a.row.id) || outside(a) - outside(b));
    return { found, madeBy };
  }

  /**
   * Each of the Machine's collections named, as last received at or before
   * `at`, by its Settings History: of the values received by then, the last
   * written, given as the REST API gives the latest value, `available` and
   * its report time that value's, as the history keeps only reports with a
   * value; null for one with none received by then, or none kept from then:
   * a history begins with the value stored as it was first kept, at the time
   * that value was last reported.
   */
  async asOf<Name extends SettingsHistoryCollection>(machineId: string, names: readonly Name[], at: Date, scope: Scope): Promise<Record<Name, CollectionView | null>> {
    await this.requireMachine(this.prisma, machineId);
    const rows = await this.prisma.$queryRaw<{ name: Name; value: CollectionView["value"]; receivedAt: Date; utcOffsetMinutes: number | null }[]>`
      SELECT DISTINCT ON (name) name, value, received_at AS "receivedAt", utc_offset_minutes AS "utcOffsetMinutes"
      FROM settings_history
      WHERE machine_id = ${machineId}::uuid AND name = ANY(${[...names]}::text[]) AND received_at <= ${at}::timestamptz
      ORDER BY name, id DESC`;
    const views = {} as Record<Name, CollectionView | null>;
    for (const name of names) {
      const row = rows.find((candidate) => candidate.name === name);
      const receivedAt = row?.receivedAt.toISOString() ?? null;
      views[name] = row
        ? {
            name,
            available: true,
            reportedAt: receivedAt!,
            receivedAt,
            items: Array.isArray(row.value) ? row.value.length : null,
            value: name === "pluginSettings" ? (shownPluginSettings(row.value, scope) as CollectionView["value"]) : row.value,
            utcOffsetMinutes: row.utcOffsetMinutes,
          }
        : null;
    }
    return views;
  }

  /** The Settings Edits that made the changes, each with who made it, named to Admins only, as a Settings Edit names them. */
  private async sources(changes: Found[], scope: Scope): Promise<Map<string, SettingsHistorySourceView>> {
    const ids = [...new Set(changes.flatMap((change) => (change.settingsEditId === null ? [] : [change.settingsEditId])))];
    if (ids.length === 0) return new Map();
    const edits = await this.prisma.settingsEdit.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true, account: { select: { name: true } }, connectedApp: { select: { id: true, name: true, clientHost: true } } },
    });
    return new Map(
      edits.map((edit) => [
        edit.id,
        {
          id: edit.id,
          // Other accounts' names are personal information that Staff do not see.
          account: edit.accountId === null ? null : { id: edit.accountId, name: scope.kind === "everything" ? (edit.account?.name ?? null) : null },
          connectedApp: edit.connectedApp && { id: edit.connectedApp.id, name: edit.connectedApp.name, host: edit.connectedApp.clientHost },
        },
      ]),
    );
  }

  private async requireMachine(db: Db, id: string): Promise<void> {
    if ((await db.machine.count({ where: { id } })) === 0) throw machineNotFound();
  }
}

/** A field's change as the REST API gives it: a plugin's setting with its values hidden from anyone but an Admin. */
function fieldView(collection: SettingsHistoryCollection, { field, change, before, after, backAt }: HistoryFieldChange, scope: Scope): SettingsHistoryFieldView {
  const shown = (value: unknown) => (collection === "pluginSettings" ? shownSetting(value, scope) : value);
  return { field, change, before: shown(before), after: shown(after), backAt: backAt === null ? null : new Date(backAt).toISOString() };
}

/**
 * A list of a Machine's Settings History's changes, from its query:
 * `collection`, given once or more, each a collection a Settings History
 * keeps; `from` and `to`, each a moment with its offset; and `includeBrief`,
 * true or false.
 */
export function readSettingsHistoryFilters(query: Record<string, unknown>): SettingsHistoryFilters {
  const problems: string[] = [];
  const filters: SettingsHistoryFilters = { includeBrief: false };
  const given = query.collection === undefined ? [] : [query.collection].flat();
  if (given.length > 0) {
    const collections = given.filter((name): name is SettingsHistoryCollection => typeof name === "string" && isSettingsHistoryCollection(name));
    if (collections.length < given.length) problems.push(`Choose each collection from ${SETTINGS_HISTORY_COLLECTIONS.join(", ")}`);
    filters.collections = [...new Set(collections)];
  }
  for (const bound of ["from", "to"] as const) {
    const value = query[bound];
    if (value === undefined) continue;
    const time = readMoment(value, problems);
    if (time) filters[bound] = time;
  }
  if (filters.from && filters.to && filters.to <= filters.from) problems.push("Choose an end after the start");
  if (query.includeBrief !== undefined) {
    if (query.includeBrief === "true" || query.includeBrief === "false") filters.includeBrief = query.includeBrief === "true";
    else problems.push("Enter includeBrief as true or false");
  }
  if (problems.length > 0) throw new BadRequestException(problems);
  return filters;
}

/**
 * A list of a Machine's Settings History with its Settings Edits, from its
 * query: what `readSettingsHistoryFilters` reads, and `editsOnly`, true or
 * false.
 */
export function readSettingsHistoryWithEditsFilters(query: Record<string, unknown>): SettingsHistoryWithEditsFilters {
  const filters = readSettingsHistoryFilters(query);
  if (query.editsOnly !== undefined && query.editsOnly !== "true" && query.editsOnly !== "false") throw new BadRequestException(["Enter editsOnly as true or false"]);
  return { ...filters, editsOnly: query.editsOnly === "true" };
}

/** A collection's time as of which to read it, from a query, a moment with its offset; undefined if none is given. */
export function readAsOf(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  const problems: string[] = [];
  const time = readMoment(value, problems);
  if (!time) throw new BadRequestException(problems);
  return time;
}

/** A moment with its offset, in the years 1 to 9999 in UTC, which PostgreSQL reads. */
function readMoment(value: unknown, problems: string[]): Date | undefined {
  const time = readTime(value, problems);
  if (time && (time.getUTCFullYear() < 1 || time.getUTCFullYear() > 9999)) {
    problems.push("Times must be in the years 1 to 9999, in UTC");
    return undefined;
  }
  return time;
}
