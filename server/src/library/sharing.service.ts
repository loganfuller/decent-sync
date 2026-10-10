import { Injectable } from "@nestjs/common";
import { machineNotFound } from "../machines/input.js";
import { lockMachine } from "../machines/machines.service.js";
import { notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { type SharingStatusView, sharingStatus } from "./sharing-status.js";

// The capture-only switch: whether a Machine takes part in the Library at its
// Location. Turned off, by an Admin, it is a Capture-only Machine, as one at
// no Location is: its records are captured as before, but its tablet is
// written nothing and its Library changes are not taken in. Turned back on,
// it joins its Location (ADR-0008), as when it is moved there: each of its
// tablet's reports records when sharing was last turned on (`tablet_reports`,
// joining.ts), so the first since is part of joining.

@Injectable()
export class SharingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The Machine's sharing status (sharing-status.ts); 404 if there is no such Machine. */
  status(machineId: string): Promise<SharingStatusView> {
    return sharingStatus(this.prisma, machineId);
  }

  /**
   * Turns the Machine's sharing on or off, under its row lock, which taking
   * in its tablet's reports and recording its answers hold too, so each is
   * decided wholly before or after the switch, on any instance. Turned back
   * on, it is timed by PostgreSQL's clock. Tells every instance its tablet's
   * writer is to look again: turned off, it writes nothing more; turned on,
   * it asks for the tablet's reports afresh. 404 if there is no such Machine.
   */
  async setSharing(machineId: string, sharing: boolean): Promise<{ sharing: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockMachine(tx, machineId))) throw machineNotFound();
      const changed = await tx.$executeRaw`
        UPDATE machines SET sharing = ${sharing}, sharing_since = CASE WHEN ${sharing} THEN now() ELSE sharing_since END
        WHERE id = ${machineId}::uuid AND sharing <> ${sharing}`;
      if (changed > 0) await notify(tx, "machine_locations", machineId);
    });
    return { sharing };
  }
}
