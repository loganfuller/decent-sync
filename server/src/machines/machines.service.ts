import { ConflictException, Injectable } from "@nestjs/common";
import { type Machine, Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma.service.js";
import { hashSecret, newSecret } from "../secrets.js";
import type { NewMachine } from "./input.js";
import { Presence } from "./presence.js";

/** A Machine as the REST API returns it. */
export interface MachineView {
  id: string;
  name: string;
  /** The hardware the Machine's token is bound to, or null until a connection reports it. */
  model: string | null;
  serial: string | null;
  /** Whether a plugin is connected with the Machine's token right now. */
  online: boolean;
  /** When a plugin connected with its token was last heard from, or null if never. */
  lastSeenAt: string | null;
}

@Injectable()
export class MachinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: Presence,
  ) {}

  view(machine: Machine): MachineView {
    return {
      id: machine.id,
      name: machine.name,
      model: machine.model,
      serial: machine.serial,
      online: this.presence.isOnline(machine.id),
      lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
    };
  }

  /** Every Machine, by name. */
  list(): Promise<Machine[]> {
    return this.prisma.machine.findMany({ orderBy: { name: "asc" } });
  }

  /** Creates a machine entry and its first token. The token is returned only here. */
  async create(fields: NewMachine): Promise<{ machine: Machine; token: string }> {
    const token = newSecret();
    try {
      const machine = await this.prisma.machine.create({
        data: { name: fields.name, tokens: { create: { tokenHash: hashSecret(token) } } },
      });
      return { machine, token };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`A Machine named ${fields.name} already exists`);
      }
      throw error;
    }
  }

  /** The Machine a token belongs to, unless the token is unknown or revoked. */
  async findByToken(token: string): Promise<Machine | null> {
    const found = await this.prisma.machineToken.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { machine: true },
    });
    return found && found.revokedAt === null ? found.machine : null;
  }

  /**
   * Binds the Machine to its hardware, if it is not bound yet. Returns false
   * when it already was, or another Machine has that hardware.
   */
  async bindHardware(machineId: string, hardware: { model: string; serial: string }): Promise<boolean> {
    try {
      const { count } = await this.prisma.machine.updateMany({
        where: { id: machineId, model: null, serial: null },
        data: hardware,
      });
      return count === 1;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  }

  async markSeen(machineId: string, at: Date): Promise<void> {
    await this.prisma.machine.updateMany({ where: { id: machineId }, data: { lastSeenAt: at } });
  }
}
