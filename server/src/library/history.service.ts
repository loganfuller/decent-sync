import { Injectable, NotFoundException } from "@nestjs/common";
import type { LibraryKind } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import type { ItemRef } from "./history.js";
import { isObject } from "./listed.js";

/**
 * Where a version or a Conflict came from: a Machine's tablet, or an account
 * in the management interface. An account is named by its id only: other
 * accounts' names are personal information that Staff do not see.
 */
export interface SourceView {
  /** The Machine whose tablet made it, if one did and it still exists. */
  machine: { id: string; name: string } | null;
  /** That tablet's id. */
  tabletId: string | null;
  account: { id: string } | null;
}

/** One accepted edit of a Library item, as the REST API returns it. */
export interface VersionView {
  id: string;
  /**
   * The fields it set, each with its value: of the item's content, by
   * Decaid's names, or of its state at `location` (`atLocation`,
   * `remainingWeight`, `shown`). The first version is the item joining the
   * Library.
   */
  fields: Record<string, unknown>;
  /** The Location whose state of the item it changed; null for its content. */
  location: LocationView | null;
  source: SourceView;
  /** When it was made: a tablet's by its record's `updatedAt` in UTC; a delete on a tablet when the server learned of it. */
  editedAt: string;
  /** When the server took it in, by PostgreSQL's clock. */
  receivedAt: string;
}

/** A Library item a Conflict is about. */
export interface ConflictItemView {
  kind: LibraryKind;
  /** Its global id, or a Profile's id. */
  id: string;
  /** What the management interface names it by: a Bean's roaster and name, a batch's Bean and roast date, a Grinder's model, a Profile's title; null where its content has none. */
  name: string | null;
}

/** An open Conflict, as the REST API returns it. */
export interface ConflictView {
  id: string;
  item: ConflictItemView;
  field: string;
  /** The losing value; null where the edit cleared the field. */
  value: unknown;
  /** The Location whose state of the item the field is; null for the item's content. */
  location: LocationView | null;
  source: SourceView;
  /** When the losing edit was made. */
  editedAt: string;
  /** When it became a Conflict, by PostgreSQL's clock. */
  createdAt: string;
}

const withSource = { machine: { select: { id: true, name: true } }, location: true } as const;

/** The column each kind of item is named by in a version or Conflict. */
const ITEM_WHERE: Readonly<Record<LibraryKind, (id: string) => Prisma.ItemVersionWhereInput>> = {
  bean: (id) => ({ beanId: id }),
  beanBatch: (id) => ({ batchId: id }),
  grinder: (id) => ({ grinderId: id }),
  profile: (id) => ({ profileId: id }),
};

const KIND_NAMES: Readonly<Record<LibraryKind, string>> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder", profile: "Profile" };

/** Each Library item's history and the open Conflicts (ADR-0020), which Staff read as Admins do. */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The item's versions, the latest taken in first; 404 if the Library does not have it. */
  async versions(item: ItemRef): Promise<VersionView[]> {
    const [versions, exists] = await Promise.all([
      this.prisma.itemVersion.findMany({ where: ITEM_WHERE[item.kind](item.id), include: withSource, orderBy: [{ receivedAt: "desc" }, { id: "desc" }] }),
      this.exists(item),
    ]);
    if (!exists) throw new NotFoundException(`No such ${KIND_NAMES[item.kind]}`);
    return versions.map((version) => ({
      id: version.id,
      fields: isObject(version.fields) ? version.fields : {},
      location: version.location ? viewLocation(version.location) : null,
      source: viewSource(version),
      editedAt: version.editedAt.toISOString(),
      receivedAt: version.receivedAt.toISOString(),
    }));
  }

  /** The open Conflicts, the latest first. */
  async openConflicts(): Promise<ConflictView[]> {
    const conflicts = await this.prisma.conflict.findMany({
      where: { state: "OPEN" },
      include: {
        ...withSource,
        bean: { select: { content: true } },
        batch: { select: { content: true, bean: { select: { content: true } } } },
        grinder: { select: { content: true } },
        profile: { select: { content: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return conflicts.map((conflict) => ({
      id: conflict.id,
      item: conflictItem(conflict),
      field: conflict.field,
      value: conflict.value,
      location: conflict.location ? viewLocation(conflict.location) : null,
      source: viewSource(conflict),
      editedAt: conflict.editedAt.toISOString(),
      createdAt: conflict.createdAt.toISOString(),
    }));
  }

  private async exists(item: ItemRef): Promise<boolean> {
    const where = { where: { id: item.id } };
    switch (item.kind) {
      case "bean":
        return (await this.prisma.bean.count(where)) > 0;
      case "beanBatch":
        return (await this.prisma.beanBatch.count(where)) > 0;
      case "grinder":
        return (await this.prisma.grinder.count(where)) > 0;
      case "profile":
        return (await this.prisma.profile.count(where)) > 0;
    }
  }
}

function viewSource(row: { machine: { id: string; name: string } | null; tabletId: string | null; accountId: string | null }): SourceView {
  return { machine: row.machine, tabletId: row.tabletId, account: row.accountId === null ? null : { id: row.accountId } };
}

type ItemContent = { content: Prisma.JsonValue } | null;

function conflictItem(conflict: {
  beanId: string | null;
  batchId: string | null;
  grinderId: string | null;
  profileId: string | null;
  bean: ItemContent;
  batch: { content: Prisma.JsonValue; bean: { content: Prisma.JsonValue } } | null;
  grinder: ItemContent;
  profile: ItemContent;
}): ConflictItemView {
  if (conflict.beanId !== null) {
    const bean = fields(conflict.bean?.content);
    return { kind: "bean", id: conflict.beanId, name: joined([text(bean.roaster), text(bean.name)]) };
  }
  if (conflict.batchId !== null) {
    const batch = fields(conflict.batch?.content);
    return { kind: "beanBatch", id: conflict.batchId, name: joined([text(fields(conflict.batch?.bean.content).name), text(batch.roastDate)]) };
  }
  if (conflict.grinderId !== null) return { kind: "grinder", id: conflict.grinderId, name: text(fields(conflict.grinder?.content).model) };
  const profile = fields(fields(conflict.profile?.content).profile);
  return { kind: "profile", id: conflict.profileId!, name: text(profile.title) };
}

function fields(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function joined(parts: (string | null)[]): string | null {
  const present = parts.filter((part) => part !== null);
  return present.length === 0 ? null : present.join(" ");
}
