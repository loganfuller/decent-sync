import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";

interface KnownZone {
  name: string;
  atEpoch: Temporal.ZonedDateTime;
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
   * For names it lacks, choose the last equivalent alphabetically.
   */
  async normalise(timeZone: string): Promise<string | undefined> {
    const name = timeZone.trim();
    const known = await this.load();
    const given = known.get(name.toLowerCase());
    if (given !== undefined) return given.name;

    const atEpoch = namedZoneAtEpoch(name);
    if (atEpoch === undefined) return undefined;
    for (const zone of known.values()) {
      // At the same instant and calendar, equals compares zone identity,
      // not merely the UTC offset (different zones can share an offset).
      if (atEpoch.equals(zone.atEpoch)) return zone.name;
    }
    return undefined;
  }

  /** The zones a browser would offer, under the names `normalise` stores, sorted. */
  async list(): Promise<string[]> {
    const names = await Promise.all(["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => this.normalise(zone)));
    return [...new Set(names.filter((name) => name !== undefined))].sort();
  }

  private load(): Promise<Map<string, KnownZone>> {
    this.known ??= this.prisma.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
      (rows) => {
        const known = new Map<string, KnownZone>();
        // Reverse alphabetical order is a deterministic tie-breaker when
        // several PostgreSQL names share an identity. It also preserves
        // existing alias resolution without relying on Intl canonicalization.
        const names = rows.map(({ name }) => name).sort().reverse();
        for (const name of names) {
          const atEpoch = namedZoneAtEpoch(name);
          if (atEpoch !== undefined) known.set(name.toLowerCase(), { name, atEpoch });
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

/** Validate in both runtimes without asking Intl to canonicalize the name. */
function namedZoneAtEpoch(timeZone: string): Temporal.ZonedDateTime | undefined {
  // Temporal and newer Intl versions also accept numeric offsets.
  if (/^[+-]/.test(timeZone)) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return new Temporal.ZonedDateTime(0n, timeZone);
  } catch {
    return undefined;
  }
}
