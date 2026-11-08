import { BadRequestException, Injectable } from "@nestjs/common";
import {
  type HistoryFieldChange,
  SETTINGS_HISTORY_COLLECTIONS,
  type SettingsHistoryCollection,
  isSettingsHistoryCollection,
  settingsHistoryChanges,
} from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";
import { readTime } from "../machines/input.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import type { CollectionView } from "./collections.service.js";

// Reading a Machine's Settings History (#433), which settings-history.ts
// records: its changes, newest first, each a value's fields changed from the
// value before it, as `settingsHistoryChanges` compares and folds them, and
// its collections as last received at or before a time. A history's order is
// the order its rows were written, by id, which a report is compared in
// (COLLECTIONS.md, Settings History).

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
  /** The Settings Edit whose read-back made these changes; null for changes made outside Decent Sync, which are tied to no person. */
  settingsEdit: SettingsHistorySourceView | null;
  fields: SettingsHistoryFieldView[];
}

export interface SettingsHistoryPage {
  changes: SettingsHistoryChangeView[];
  total: number;
  limit: number;
  offset: number;
}

type Page = { limit: number; offset: number };

/** A value of the history, as read to work out its changes. */
interface Row {
  id: bigint;
  name: string;
  value: unknown;
  receivedAt: Date;
  settingsEditId: string | null;
  editedFields: string[] | null;
}

/** A change before it is given as the REST API gives it. */
interface Found {
  row: Row;
  collection: SettingsHistoryCollection;
  settingsEditId: string | null;
  fields: HistoryFieldChange[];
}

/**
 * A Machine's Settings History, as the REST API and the MCP endpoint read
 * it. Every account that reads the Machine reads it; who made a Settings
 * Edit is named as the REST API names it in the edit.
 */
@Injectable()
export class SettingsHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A page of the Machine's changes, newest first, with how many match. Each
   * collection's whole history is read and its changes worked out
   * (`settingsHistoryChanges`), then those received in the range kept, so a
   * brief change is folded wherever a range or page ends. The first value of
   * each collection, its baseline, is no change.
   */
  async changes(machineId: string, filters: SettingsHistoryFilters, page: Page, scope: Scope): Promise<SettingsHistoryPage> {
    await this.requireMachine(machineId);
    // Each once, however often it is named.
    const names = [...new Set(filters.collections ?? SETTINGS_HISTORY_COLLECTIONS)];
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT id, name, value, received_at AS "receivedAt", settings_edit_id AS "settingsEditId", edited_fields AS "editedFields"
      FROM settings_history
      WHERE machine_id = ${machineId}::uuid AND name = ANY(${names}::text[])
      ORDER BY id`;
    const found: Found[] = [];
    for (const collection of names) {
      const values = rows.filter((row) => row.name === collection);
      const changes = settingsHistoryChanges(
        collection,
        values.map((row) => ({ value: row.value, receivedAt: row.receivedAt.getTime(), settingsEditId: row.settingsEditId, editedFields: row.editedFields ?? [] })),
      );
      for (const { index, settingsEditId, fields } of changes) {
        const row = values[index]!;
        if (filters.from && row.receivedAt < filters.from) continue;
        if (filters.to && row.receivedAt >= filters.to) continue;
        const shown = filters.includeBrief ? fields : fields.filter((field) => field.backAt === null);
        if (shown.length > 0) found.push({ row, collection, settingsEditId, fields: shown });
      }
    }
    // Newest first, as written; a read-back's own changes before those made outside it.
    found.sort((a, b) => Number(b.row.id - a.row.id) || (a.settingsEditId === null ? 1 : 0) - (b.settingsEditId === null ? 1 : 0));
    const shown = found.slice(page.offset, page.offset + page.limit);
    const sources = await this.sources(shown, scope);
    return {
      changes: shown.map(({ row, collection, settingsEditId, fields }) => ({
        id: String(row.id),
        receivedAt: row.receivedAt.toISOString(),
        collection,
        settingsEdit: settingsEditId === null ? null : (sources.get(settingsEditId) ?? null),
        fields: fields.map(({ field, change, before, after, backAt }) => ({ field, change, before, after, backAt: backAt === null ? null : new Date(backAt).toISOString() })),
      })),
      total: found.length,
      ...page,
    };
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
  async asOf<Name extends SettingsHistoryCollection>(machineId: string, names: readonly Name[], at: Date): Promise<Record<Name, CollectionView | null>> {
    await this.requireMachine(machineId);
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
        ? { name, available: true, reportedAt: receivedAt!, receivedAt, items: Array.isArray(row.value) ? row.value.length : null, value: row.value, utcOffsetMinutes: row.utcOffsetMinutes }
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

  private async requireMachine(id: string): Promise<void> {
    if ((await this.prisma.machine.count({ where: { id } })) === 0) throw machineNotFound();
  }
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
