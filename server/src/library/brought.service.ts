import { Injectable } from "@nestjs/common";
import { type LocationView, viewLocation } from "../locations/locations.service.js";
import { machineNotFound } from "../machines/input.js";
import { PrismaService } from "../prisma.service.js";
import { type ConflictItemView, itemView } from "./history.service.js";

/** An item a Machine's tablet brought to the Library as the Machine joined a Location (ADR-0018), as the REST API returns it. */
export interface BroughtItemView {
  /** The item: its kind, its id and what the management interface names it by. */
  item: ConflictItemView;
  /** Whether it was matched to an item the Library had, a Bean by roaster and name or a user's Profile by its id, rather than joining it. */
  matched: boolean;
  /** Whether it is Archived now. */
  archived: boolean;
  /** The Location the Machine joined, or null if it no longer exists. */
  location: LocationView | null;
  /** The tablet that brought it. */
  tabletId: string;
  /** When it was taken in, by PostgreSQL's clock. */
  broughtAt: string;
}

/** What each Machine's tablet brought to the Library as the Machine joined a Location, so an Admin can Archive duplicates (ADR-0018). */
@Injectable()
export class BroughtService {
  constructor(private readonly prisma: PrismaService) {}

  /** What the Machine brought, the latest taken in first; 404 if there is no such Machine. */
  async brought(machineId: string): Promise<BroughtItemView[]> {
    if ((await this.prisma.machine.count({ where: { id: machineId } })) === 0) throw machineNotFound();
    const rows = await this.prisma.broughtItem.findMany({
      where: { machineId },
      include: {
        location: true,
        bean: { select: { content: true, archived: true } },
        batch: { select: { content: true, archived: true, bean: { select: { content: true } } } },
        grinder: { select: { content: true, archived: true } },
        profile: { select: { content: true, archived: true } },
      },
      orderBy: [{ broughtAt: "desc" }, { seq: "desc" }],
    });
    return rows.map((row) => ({
      item: itemView({ ...row, settingsId: null }),
      matched: row.matched,
      archived: (row.bean ?? row.batch ?? row.grinder ?? row.profile)?.archived ?? false,
      location: row.location ? viewLocation(row.location) : null,
      tabletId: row.tabletId,
      broughtAt: row.broughtAt.toISOString(),
    }));
  }
}
