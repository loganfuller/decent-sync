import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.js";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { PrismaService } from "../prisma.service.js";
import { type BeanBatchSummary, BeanBatchesService } from "./bean-batches.service.js";
import { offeringLocations } from "./location-state.js";

/** A Bean as the REST API lists it. */
export interface BeanSummary {
  /** Its global id, which its record on each tablet carries. */
  id: string;
  /** Its roaster and name, from its content; null where its content has none. */
  roaster: string | null;
  name: string | null;
  archived: boolean;
  /**
   * The Locations offering it, by name (ADR-0008): each where one of its
   * batches is, and each where it has no batch yet but a tablet created it,
   * linked a bean of its own to it, or un-archived its record. None while it
   * is Archived.
   */
  offeredAt: LocationView[];
  /** When it joined the Library, by PostgreSQL's clock. */
  createdAt: string;
  /** The Location of the tablet that created it, if it still exists. */
  createdLocation: LocationView | null;
  /**
   * The other Beans with the same roaster and name, ignoring case and white
   * space at either end: likely duplicates. Beans are matched only when a
   * tablet first reports them (ADR-0018), so these were never merged.
   */
  likelyDuplicates: { id: string; roaster: string | null; name: string | null }[];
}

/** A Bean with its content, as the REST API returns one. */
export interface BeanView extends BeanSummary {
  /** Decaid's record fields, as the tablet that created it sent them, those this server does not know included. */
  content: Record<string, unknown>;
  /** Its batches, the latest roasted first. */
  batches: BeanBatchSummary[];
}

const withPlaces = { createdLocation: true } as const satisfies Prisma.BeanInclude;

type ListedBean = Prisma.BeanGetPayload<{ include: typeof withPlaces }>;

/** The Library's Beans, which Staff read as Admins do. Beans join it from tablets (`library/beans.ts`). */
@Injectable()
export class BeansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly batches: BeanBatchesService,
  ) {}

  /** Every Bean, by name, then roaster, ignoring case. */
  async list(): Promise<BeanSummary[]> {
    const beans = await this.prisma.bean.findMany({ include: withPlaces });
    const views = await this.views(beans);
    return views.sort((a, b) => compareText(a.name, b.name) || compareText(a.roaster, b.roaster) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<BeanView> {
    const bean = await this.prisma.bean.findUnique({ where: { id }, include: withPlaces });
    if (!bean) throw beanNotFound();
    return { ...(await this.views([bean]))[0]!, content: content(bean), batches: await this.batches.ofBean(bean.id) };
  }

  private async views(beans: ListedBean[]): Promise<BeanSummary[]> {
    const keys = [...new Set(beans.map((bean) => bean.matchKey))];
    const sharingKeys =
      keys.length === 0
        ? []
        : await this.prisma.bean.findMany({ where: { matchKey: { in: keys } }, select: { id: true, matchKey: true, content: true }, orderBy: { createdAt: "asc" } });
    const offering = await offeringLocations(this.prisma, beans.map((bean) => bean.id));
    const locationIds = [...new Set([...offering.values()].flat())];
    const locations = new Map((await this.prisma.location.findMany({ where: { id: { in: locationIds } } })).map((location) => [location.id, viewLocation(location)]));
    return beans.map((bean) => ({
      id: bean.id,
      ...names(bean.content),
      archived: bean.archived,
      offeredAt: (offering.get(bean.id) ?? []).flatMap((id) => locations.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      createdAt: bean.createdAt.toISOString(),
      createdLocation: bean.createdLocation ? viewLocation(bean.createdLocation) : null,
      likelyDuplicates: sharingKeys
        .filter((other) => other.matchKey === bean.matchKey && other.id !== bean.id)
        .map((other) => ({ id: other.id, ...names(other.content) })),
    }));
  }
}

/** A Bean id from a path. */
export function readBeanId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw beanNotFound();
  return id;
}

function beanNotFound(): NotFoundException {
  return new NotFoundException("No such Bean");
}

function content(bean: { content: Prisma.JsonValue }): Record<string, unknown> {
  return typeof bean.content === "object" && bean.content !== null && !Array.isArray(bean.content) ? (bean.content as Record<string, unknown>) : {};
}

function names(value: Prisma.JsonValue): { roaster: string | null; name: string | null } {
  const fields = content({ content: value });
  return { roaster: typeof fields.roaster === "string" ? fields.roaster : null, name: typeof fields.name === "string" ? fields.name : null };
}

/** Text compared ignoring case, with none last. */
function compareText(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}
