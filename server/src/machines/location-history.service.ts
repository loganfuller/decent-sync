import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { type Scope, includesLocation } from "../accounts/scope.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { type Correction, type Move, locationHistoryEntryNotFound, machineNotFound, unknownLocation } from "./input.js";
import { creditLocations, databaseNow } from "./location-history.js";
import { type MachineView, MachinesService, lockMachine } from "./machines.service.js";

/**
 * Moving Machines between Locations, and correcting or removing entries of
 * their Location History. Each change credits the Machine's records again,
 * with its row locked. Staff move Machines only between Locations they work
 * at; correcting and removing entries is for Admins.
 */
@Injectable()
export class LocationHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly machines: MachinesService,
  ) {}

  /**
   * Moves the Machine to another Location, from now or from a time after its
   * latest move. For Staff, both where it is and where it goes must be
   * Locations they work at, judged with its row locked.
   */
  async move(machineId: string, move: Move, scope: Scope): Promise<MachineView> {
    // An earlier time corrects when it moved, which credits its records again: that is for Admins.
    if (scope.kind !== "everything" && move.effectiveFrom) {
      throw new ForbiddenException("Only an Admin can record a move at an earlier time");
    }
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      const latest = await tx.locationAssignment.findFirst({
        where: { machineId },
        orderBy: { effectiveFrom: "desc" },
        include: { location: { select: { name: true } } },
      });
      if (!includesLocation(scope, latest?.locationId ?? null)) {
        throw new ForbiddenException("You can move a Machine only from a Location you work at");
      }
      if (!includesLocation(scope, move.locationId)) throw new ForbiddenException("You can move a Machine only to a Location you work at");
      const location = await tx.location.findUnique({ where: { id: move.locationId }, select: { name: true } });
      if (!location) throw unknownLocation();
      if (latest?.locationId === move.locationId) throw new ConflictException(`It is already at ${location.name}`);
      if (move.effectiveFrom) await refuseFuture(tx, move.effectiveFrom);
      const effectiveFrom = move.effectiveFrom ?? (await databaseNow(tx));
      if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
        throw new ConflictException(`Choose a time after it arrived at ${latest.location.name}`);
      }
      await tx.locationAssignment.create({ data: { machineId, locationId: move.locationId, effectiveFrom } });
      await creditLocations(tx, machineId);
    });
    return this.machines.get(machineId);
  }

  /**
   * Corrects one entry: the Location it names, when the Machine arrived
   * there, or both. Its Location differs from those of the entries before
   * and after it, and its time stays between theirs; moving the first entry's
   * earlier credits records from before it to its Location.
   */
  async correct(machineId: string, entryId: string, correction: Correction): Promise<MachineView> {
    await this.prisma.$transaction(async (tx) => {
      const { before, after } = await lockedEntry(tx, machineId, entryId);
      if (correction.locationId !== undefined) {
        const location = await tx.location.findUnique({ where: { id: correction.locationId }, select: { name: true } });
        if (!location) throw unknownLocation();
        if (before?.locationId === correction.locationId) {
          throw new ConflictException(`It was already at ${location.name} before this; remove this entry instead`);
        }
        if (after?.locationId === correction.locationId) {
          throw new ConflictException(`It moved to ${location.name} after this; choose another Location, or remove that entry`);
        }
      }
      const effectiveFrom = correction.effectiveFrom;
      if (effectiveFrom) {
        await refuseFuture(tx, effectiveFrom);
        if (before && effectiveFrom.getTime() <= before.effectiveFrom.getTime()) {
          throw new ConflictException(`Choose a time after it arrived at ${before.location.name}`);
        }
        if (after && effectiveFrom.getTime() >= after.effectiveFrom.getTime()) {
          throw new ConflictException(`Choose a time before it moved to ${after.location.name}`);
        }
      }
      await tx.locationAssignment.update({ where: { id: entryId }, data: correction });
      await creditLocations(tx, machineId);
    });
    return this.machines.get(machineId);
  }

  /**
   * Removes an entry recorded by mistake: the Machine stayed where the entry
   * before it says, or, for the first entry, its Location is unknown until the
   * next one. When the next entry names the Location it stayed at, the
   * Machine never left, so that entry is removed too.
   */
  async remove(machineId: string, entryId: string): Promise<MachineView> {
    await this.prisma.$transaction(async (tx) => {
      const { before, after } = await lockedEntry(tx, machineId, entryId);
      const neverLeft = before && after && before.locationId === after.locationId;
      await tx.locationAssignment.deleteMany({ where: { id: { in: neverLeft ? [entryId, after.id] : [entryId] } } });
      await creditLocations(tx, machineId);
    });
    return this.machines.get(machineId);
  }
}

/** The entries before and after one of the Machine's, with the Machine's row locked. */
async function lockedEntry(tx: Prisma.TransactionClient, machineId: string, entryId: string) {
  if (!(await lockMachine(tx, machineId))) throw machineNotFound();
  const history = await tx.locationAssignment.findMany({
    where: { machineId },
    orderBy: { effectiveFrom: "asc" },
    include: { location: { select: { name: true } } },
  });
  const index = history.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw locationHistoryEntryNotFound();
  return { before: history[index - 1], after: history[index + 1] };
}

/** A Location History records where a Machine has been, judged by PostgreSQL's clock. */
async function refuseFuture(tx: Prisma.TransactionClient, time: Date): Promise<void> {
  const [{ future }] = await tx.$queryRaw<[{ future: boolean }]>`SELECT ${time}::timestamptz > now() AS future`;
  if (future) throw new BadRequestException(["Choose a time that is not in the future"]);
}
