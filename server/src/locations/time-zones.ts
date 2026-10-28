import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";

interface KnownZone {
  name: string;
  atEpoch: Temporal.ZonedDateTime;
  /** Intl lists the name, as it lists one name for each zone. */
  offered: boolean;
}

/**
 * The named time zones a Location may use: understood by PostgreSQL for date
 * filters and by Intl and Temporal for displaying and comparing local times.
 */
@Injectable()
export class TimeZones {
  // PostgreSQL's zone data changes only when the database server is upgraded.
  private known?: Promise<Map<string, KnownZone>>;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Preserve PostgreSQL's spelling, ignoring case and surrounding spaces.
   * For a name it lacks, choose a name it has for the same zone: the one Intl
   * lists, such as America/Denver for US/Mountain rather than
   * America/Shiprock, and otherwise the first alphabetically, such as
   * Pacific/Chuuk rather than Pacific/Yap for the Pacific/Truk Intl lists.
   */
  async normalise(timeZone: string): Promise<string | undefined> {
    const name = timeZone.trim();
    const known = await this.load();
    const given = known.get(name.toLowerCase());
    if (given !== undefined) return given.name;

    const atEpoch = namedZoneAtEpoch(name);
    if (atEpoch === undefined) return undefined;
    // At the same instant and calendar, equals compares zone identity,
    // not merely the UTC offset (different zones can share an offset).
    const same = [...known.values()].filter((zone) => atEpoch.equals(zone.atEpoch));
    return (same.find((zone) => zone.offered) ?? same[0])?.name;
  }

  /** The zones a browser would offer, under the names `normalise` stores, sorted. */
  async list(): Promise<string[]> {
    const names = await Promise.all(offeredZones().map((zone) => this.normalise(zone)));
    return [...new Set(names.filter((name) => name !== undefined))].sort();
  }

  private load(): Promise<Map<string, KnownZone>> {
    this.known ??= this.prisma.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
      (rows) => {
        const offered = new Set(offeredZones().map((zone) => zone.toLowerCase()));
        // In alphabetical order, for `normalise` to choose between names of one zone.
        const known = new Map<string, KnownZone>();
        for (const name of rows.map((row) => row.name).sort()) {
          const atEpoch = namedZoneAtEpoch(name);
          if (atEpoch !== undefined) known.set(name.toLowerCase(), { name, atEpoch, offered: offered.has(name.toLowerCase()) });
        }
        return known;
      },
      (error: unknown) => {
        this.known = undefined;
        throw error;
      },
    );
    return this.known;
  }
}

/** Intl's zones, one name for each, and UTC, which it may leave out. */
function offeredZones(): string[] {
  return ["UTC", ...Intl.supportedValuesOf("timeZone")];
}

/** Validate in both runtimes without asking Intl to canonicalize the name. */
function namedZoneAtEpoch(timeZone: string): Temporal.ZonedDateTime | undefined {
  // Temporal and newer Intl versions also accept numeric offsets.
  if (/^[+-]/.test(timeZone)) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return new Temporal.ZonedDateTime(0n, timeZone);
  } catch (error) {
    // Both refuse an unknown zone with a RangeError. Anything else, such as a
    // Node without Temporal, would otherwise refuse every zone without a word.
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}
