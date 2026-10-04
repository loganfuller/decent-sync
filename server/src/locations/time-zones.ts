import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";

/**
 * Browsers name a few zones by CLDR's older identifiers, which differ from
 * current IANA names, and PostgreSQL built with tzdata lacking the "backward"
 * links does not know them: Chrome in India reports Asia/Calcutta, which such a
 * server refuses in AT TIME ZONE. These are every identifier that
 * `Intl.supportedValuesOf("timeZone")` lists under a name other than IANA's.
 */
const CLDR_TO_IANA = new Map(
  Object.entries({
    "Africa/Asmera": "Africa/Asmara",
    "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
    "America/Catamarca": "America/Argentina/Catamarca",
    "America/Cordoba": "America/Argentina/Cordoba",
    "America/Godthab": "America/Nuuk",
    "America/Indianapolis": "America/Indiana/Indianapolis",
    "America/Jujuy": "America/Argentina/Jujuy",
    "America/Louisville": "America/Kentucky/Louisville",
    "America/Mendoza": "America/Argentina/Mendoza",
    "Asia/Calcutta": "Asia/Kolkata",
    "Asia/Katmandu": "Asia/Kathmandu",
    "Asia/Rangoon": "Asia/Yangon",
    "Asia/Saigon": "Asia/Ho_Chi_Minh",
    "Atlantic/Faeroe": "Atlantic/Faroe",
    "Europe/Kiev": "Europe/Kyiv",
    "Pacific/Enderbury": "Pacific/Kanton",
    "Pacific/Ponape": "Pacific/Pohnpei",
    "Pacific/Truk": "Pacific/Chuuk",
  }).map(([cldr, iana]) => [cldr.toLowerCase(), iana]),
);

/**
 * The time zones a Location may use: IANA names that both PostgreSQL (for
 * date filters in each Location's local time) and browsers (for showing local
 * times) understand. Offsets such as "+05:00" are not time zones and are
 * refused, since PostgreSQL does not list them.
 */
@Injectable()
export class TimeZones {
  // PostgreSQL's zone names by lower-cased name, read once: its time zone
  // data changes only when the database server is upgraded.
  private known?: Promise<Map<string, string>>;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The zone's name as PostgreSQL spells it, with older CLDR names replaced by
   * their IANA names, or undefined if it is not a usable time zone. Matching
   * ignores case and surrounding spaces.
   */
  async normalise(timeZone: string): Promise<string | undefined> {
    const lower = timeZone.trim().toLowerCase();
    const name = (await this.load()).get(CLDR_TO_IANA.get(lower)?.toLowerCase() ?? lower);
    return name !== undefined && understoodByIntl(name) ? name : undefined;
  }

  /** The zones a browser would offer, under the names `normalise` stores, sorted. */
  async list(): Promise<string[]> {
    const names = await Promise.all(["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => this.normalise(zone)));
    return [...new Set(names.filter((name) => name !== undefined))].sort();
  }

  private load(): Promise<Map<string, string>> {
    this.known ??= this.prisma.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`.then(
      (rows) => new Map(rows.map(({ name }) => [name.toLowerCase(), name])),
      (error: unknown) => {
        this.known = undefined;
        throw error;
      },
    );
    return this.known;
  }
}

function understoodByIntl(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}
