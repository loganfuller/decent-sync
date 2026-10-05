import { Injectable, NotFoundException } from "@nestjs/common";
import type { SteamDelivery, SteamIndex } from "@decent-sync/protocol";
import type { Prisma } from "../generated/prisma/client.js";
import { creditReporter } from "../machines/credit.js";
import { creditSteamRecordLocation } from "../machines/location-history.js";
import { PrismaService } from "../prisma.service.js";
import type { Reporter } from "../sync/identity.js";
import { extractSteamRecord } from "./extraction.js";

/**
 * Steam Records, stored once by their Decaid ids. Decaid offers no way to
 * detect an edit to one, so whatever delivers a stored record again, from any
 * tablet, changes nothing. Decaid records no hardware on them, so each is
 * credited to whoever reported it (ADR-0015), with no inferred marker, and to
 * the Location its Machine was at when it was recorded. Metadata and
 * measurements are separate queries, and lists never read measurements.
 */
@Injectable()
export class SteamRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async store(message: SteamDelivery, reporter: Reporter): Promise<void> {
    const { measurements, ...record } = message.steam;
    // Not a record Decaid v0.8.7 or later sends: acknowledged, but ignored.
    if (!Array.isArray(measurements)) return;
    // Spares a backfill's repeats the locks below.
    if (await this.prisma.steamRecord.count({ where: { id: message.steamId } })) return;
    await this.prisma.$transaction(async (tx) => {
      // Credited, with its Machine's row locked, before the record is written, as Shots are.
      const credit = await creditReporter(tx, reporter);
      const stored = await tx.steamRecord.createMany({
        data: {
          id: message.steamId,
          record: record as Prisma.InputJsonObject,
          steamedAt: new Date(message.steamedAt),
          ...extractSteamRecord(message.steam),
          ...credit,
        },
        // Waits for another delivery of it, on any instance, and keeps that one if it commits.
        skipDuplicates: true,
      });
      if (stored.count === 0) return;
      await creditSteamRecordLocation(tx, message.steamId);
      await tx.steamMeasurements.create({ data: { steamRecordId: message.steamId, data: measurements as Prisma.InputJsonValue } });
    });
  }

  /** The indexed Steam Records not stored yet, in the index's order. */
  async requested(index: SteamIndex): Promise<string[]> {
    if (index.steams.length === 0) return [];
    const missing = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT offered.id FROM unnest(${index.steams.map((steam) => steam.id)}::text[]) WITH ORDINALITY AS offered(id, position)
      WHERE NOT EXISTS (SELECT 1 FROM steam_records WHERE steam_records.id = offered.id)
      ORDER BY offered.position`;
    return [...new Set(missing.map((steam) => steam.id))];
  }

  /** Newest first. */
  async list(limit: number, offset: number, machineId?: string) {
    const where: Prisma.SteamRecordWhereInput = { ...visible, ...(machineId ? { machineId } : {}) };
    const [steamRecords, total] = await this.prisma.$transaction([
      this.prisma.steamRecord.findMany({ where, orderBy, take: limit, skip: offset, omit: { record: true }, include: creditView }),
      this.prisma.steamRecord.count({ where }),
    ]);
    return { steamRecords, total, limit, offset };
  }

  async get(id: string) {
    const steamRecord = await this.prisma.steamRecord.findFirst({ where: { id, ...visible }, include: creditView });
    if (!steamRecord) throw steamRecordNotFound();
    return steamRecord;
  }

  async measurements(id: string) {
    // The same visibility applies to all three endpoints.
    if (!(await this.prisma.steamRecord.count({ where: { id, ...visible } }))) throw steamRecordNotFound();
    return (await this.prisma.steamMeasurements.findUnique({ where: { steamRecordId: id } }))?.data ?? null;
  }
}

/** A dismissed Pending Machine's Steam Records are kept, but left out, until a machine entry takes its hardware over. */
const visible: Prisma.SteamRecordWhereInput = { OR: [{ machineId: { not: null } }, { pendingMachine: { dismissedAt: null } }] };
const orderBy: Prisma.SteamRecordOrderByWithRelationInput[] = [{ steamedAt: "desc" }, { id: "asc" }];
const creditView = {
  machine: { select: { id: true, name: true } },
  pendingMachine: { select: { id: true, model: true, serial: true } },
  location: { select: { id: true, name: true, timeZone: true } },
} as const;

function steamRecordNotFound() { return new NotFoundException("Steam Record not found"); }
