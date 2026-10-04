import { Injectable, NotFoundException } from "@nestjs/common";
import type { ShotDelivery, ShotIndex } from "@decent-sync/protocol";
import { Prisma } from "../generated/prisma/client.js";
import { lockHardware } from "../machines/machines.service.js";
import { PrismaService } from "../prisma.service.js";
import type { Identity } from "../sync/identity.js";
import { extractShot, object, shotHardware, shotVersion } from "./extraction.js";

export interface ShotReporter {
  machineId: string;
  identity: Identity;
}

/** Metadata and curves are deliberately separate queries, including on detail reads. */
@Injectable()
export class ShotsService {
  constructor(private readonly prisma: PrismaService) {}

  async store(message: ShotDelivery, reporter: ShotReporter): Promise<void> {
    const { measurements, ...incoming } = message.shot;
    const version = shotVersion(incoming);
    await this.prisma.$transaction(async (tx) => {
      // Serializes even the first insertion across instances. No row is held
      // until credit is resolved: hardware adoption can finish while we wait
      // for its hardware lock. Adoption never takes this advisory lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4000003::int, hashtext(${message.shotId}::text))`;
      const [comparison] = await tx.$queryRaw<{ newer: boolean }[]>`
        SELECT ${version}::timestamptz > version_at AS newer FROM shots WHERE id = ${message.shotId}`;
      const stored = await tx.shot.findUnique({ where: { id: message.shotId } });
      const full = message.type === "shot";
      if (stored && !comparison!.newer && (!full || stored.hasFullRecord)) return;

      let record = incoming;
      if (stored) {
        const previous = object(stored.record);
        if (full && !stored.hasFullRecord && !comparison!.newer) {
          record = stored.metadataComplete ? previous : merge(incoming, previous);
        } else if (!full && !message.snapshot) {
          record = merge(previous, incoming);
        }
      }
      // Edits carry no curves. The first full record fills them, even when a
      // newer edit was stored first; later edits never load or rewrite them.
      const fillCurves = full && (!stored?.hasFullRecord || comparison?.newer);
      // Only curve fields come from the measurements projection.
      const metadata = extractShot(record);
      const curves = fillCurves && measurements !== undefined ? extractShot({ measurements }) : stored;
      const hasFullRecord = full || stored?.hasFullRecord === true;
      const credit = full && !stored?.hasFullRecord ? await this.credit(tx, incoming, reporter) : {};
      const data = {
        ...metadata,
        duration: curves?.duration ?? null,
        peakPressure: curves?.peakPressure ?? null,
        peakFlow: curves?.peakFlow ?? null,
        hasFullRecord,
        metadataComplete: full || message.snapshot === true || stored?.metadataComplete === true,
        record: record as Prisma.InputJsonObject,
        ...credit,
      };
      if (stored) await tx.shot.update({ where: { id: message.shotId }, data });
      else await tx.shot.create({ data: { id: message.shotId, versionAt: new Date(0), ...data } });
      // Prisma's Date loses Decaid's microseconds. Let PostgreSQL parse and
      // retain them, so two edits within one millisecond compare correctly.
      if (!stored || comparison!.newer) {
        await tx.$executeRaw`UPDATE shots SET version_at = ${version}::timestamptz WHERE id = ${message.shotId}`;
      }
      if (fillCurves && measurements !== undefined) {
        const value = measurements === null ? Prisma.JsonNull : measurements as Prisma.InputJsonValue;
        await tx.shotMeasurements.upsert({
          where: { shotId: message.shotId },
          create: { shotId: message.shotId, data: value },
          update: { data: value },
        });
      }
    });
  }

  /** Missing full records are requested even if their edits have already arrived. */
  async requested(index: ShotIndex): Promise<string[]> {
    if (index.shots.length === 0) return [];
    const entries = index.shots.map((shot) => Prisma.sql`(${shot.id}::text, ${shot.updatedAt ? shotVersion({ updatedAt: shot.updatedAt }) : null}::timestamptz)`);
    const missing = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT offered.id FROM (VALUES ${Prisma.join(entries)}) AS offered(id, version_at)
      LEFT JOIN shots ON shots.id = offered.id
      WHERE shots.id IS NULL OR NOT shots.has_full_record OR offered.version_at > shots.version_at`);
    return [...new Set(missing.map((shot) => shot.id))];
  }

  async list(limit: number, offset: number, machineId?: string) {
    const where: Prisma.ShotWhereInput = { ...visible, ...(machineId ? { machineId } : {}) };
    const [shots, total] = await this.prisma.$transaction([
      this.prisma.shot.findMany({ where, orderBy, take: limit, skip: offset, omit: { record: true, versionAt: true, hasFullRecord: true, metadataComplete: true }, include: creditView }),
      this.prisma.shot.count({ where }),
    ]);
    return { shots, total, limit, offset };
  }

  async get(id: string) {
    const shot = await this.prisma.shot.findFirst({ where: { id, ...visible }, omit: { versionAt: true, hasFullRecord: true, metadataComplete: true }, include: creditView });
    if (!shot) throw shotNotFound();
    return shot;
  }

  async measurements(id: string) {
    // The same visibility applies to all three endpoints.
    if (!(await this.prisma.shot.count({ where: { id, ...visible } }))) throw shotNotFound();
    return (await this.prisma.shotMeasurements.findUnique({ where: { shotId: id } }))?.data ?? null;
  }

  private async credit(tx: Prisma.TransactionClient, record: unknown, reporter: ShotReporter) {
    const recordedHardware = shotHardware(record);
    const hardware = recordedHardware ?? (reporter.identity.kind === "mismatch" ? reporter.identity.hardware : null);
    const machineInferred = recordedHardware === null;
    if (!hardware) return { machineId: reporter.machineId, pendingMachineId: null, machineInferred };
    await lockHardware(tx, hardware);
    // Machine rows before the Pending Machine, matching hello and dismissal.
    const [owner] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM machines WHERE model = ${hardware.model} AND serial = ${hardware.serial} FOR UPDATE`;
    if (owner) return { machineId: owner.id, pendingMachineId: null, machineInferred };
    const pending = await tx.pendingMachine.upsert({ where: { model_serial: hardware }, create: hardware, update: {} });
    return { machineId: null, pendingMachineId: pending.id, machineInferred };
  }
}

const visible: Prisma.ShotWhereInput = {
  hasFullRecord: true,
  OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }],
};
const orderBy: Prisma.ShotOrderByWithRelationInput[] = [{ pulledAt: { sort: "desc", nulls: "last" } }, { id: "asc" }];
const creditView = { machine: { select: { id: true, name: true } }, pendingMachine: { select: { id: true, model: true, serial: true } } } as const;

function shotNotFound() { return new NotFoundException("Shot not found"); }

/** Merge metadata recursively while keeping explicit nulls and unknown fields. */
function merge(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(update)) {
    const previous = result[key];
    Object.defineProperty(result, key, { value: isObject(previous) && isObject(value) ? merge(previous, value) : value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
