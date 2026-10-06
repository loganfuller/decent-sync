import { Link } from "react-router";
import { ListPagination, type ListState, RECORD_FILTERS, RecordFilters, useRecordList } from "@/components/record-lists";
import { LocationCredit, MachineCredit, OrNone, numberText, recordTime, secondsText } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SteamRecordPage } from "@/lib/api";

/**
 * Every Steam Record, newest first, across every Location, with filters by
 * Location, Machine and date. Times are each Steam Record's Location's, and
 * dates are read in each one's own Location's time zone; Steam Records with
 * no Location use UTC. Staff see all of it.
 */
export function SteamRecordsPage() {
  const list = useRecordList<SteamRecordPage>("/steam-records", RECORD_FILTERS, (page) => page.steamRecords);
  const { data, error } = list;

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Steam Records</h1>
        <p className="text-muted-foreground">
          Every Steam Record from every Location, newest first. Times are shown in each Steam Record's Location's time
          zone, and dates are read in it too; a Steam Record with no Location uses UTC.
        </p>
      </div>

      <RecordFilters
        list={list}
        description="Dates and times are read in each Steam Record's Location's time zone, so 7:00 means 7:00 wherever it was recorded. To includes the whole of its day unless a time is given."
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data?.total === 0 && (
        <p className="text-muted-foreground">{list.filtered ? "No Steam Records match these filters." : "No Steam Records yet."}</p>
      )}
      {data && data.steamRecords.length > 0 && (
        <>
          <div className="rounded-lg border">
            <Table aria-label="Steam Records">
              <TableHeader>
                <TableRow>
                  <TableHead>Steamed</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Peak milk temperature</TableHead>
                  <TableHead>Final milk temperature</TableHead>
                  <TableHead>Barista</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.steamRecords.map((steamRecord) => (
                  <TableRow key={steamRecord.id}>
                    <TableCell className="font-medium">
                      <Link
                        to={`/steam-records/${encodeURIComponent(steamRecord.id)}`}
                        state={{ list: list.search } satisfies ListState}
                        className="underline-offset-4 hover:underline"
                      >
                        {recordTime(steamRecord.steamedAt, steamRecord)}
                      </Link>
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <MachineCredit record={steamRecord} />
                    </TableCell>
                    <TableCell className="min-w-28 whitespace-normal">
                      <LocationCredit record={steamRecord} />
                    </TableCell>
                    <TableCell>
                      <OrNone>{secondsText(steamRecord.duration)}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{numberText(steamRecord.peakMilkTemperature, "°C")}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{numberText(steamRecord.finalMilkTemperature, "°C")}</OrNone>
                    </TableCell>
                    <TableCell>
                      <OrNone>{steamRecord.barista ?? undefined}</OrNone>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ListPagination list={list} noun="Steam Records" />
        </>
      )}
    </section>
  );
}
