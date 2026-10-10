import { useCallback, useState } from "react";
import { Link } from "react-router";
import { LocationCredit, MachineCredit, OrNone, numberText, secondsText } from "@/components/records";
import { ShotBatch, ShotGrinder, ShotProfile, gramsText, shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type ShotPage } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// The Shots a Library item's page lists: those linked to it, through the
// Shots list's filter by it, newest first.

const PAGE_SIZE = 10;

/** The Shots list's filter by each kind of item, and its name. */
const KINDS = {
  bean: { filter: "beanId", name: "Bean" },
  beanBatch: { filter: "beanBatchId", name: "Bean Batch" },
  grinder: { filter: "grinderId", name: "Grinder" },
  profile: { filter: "profileId", name: "Profile" },
} as const;

/**
 * The Shots that used the item, a page at a time, loaded again as often as
 * its history. The Shots list filters by Bean Batch and Grinder, so their
 * pages link to it, filtered.
 */
export function ItemShotsCard({ kind, id }: { kind: keyof typeof KINDS; id: string }) {
  const { filter, name } = KINDS[kind];
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ [filter]: id, limit: String(PAGE_SIZE), offset: String(offset) }).toString();
  const load = useCallback(() => api<ShotPage>("GET", `/shots?${query}`), [query]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);
  const inList = kind === "beanBatch" || kind === "grinder";

  return (
    <Card role="region" aria-label="Shots">
      <CardHeader>
        <CardTitle>
          <h2>Shots</h2>
        </CardTitle>
        <CardDescription>
          The Shots pulled with this {name} on any Machine, newest first, in each Shot's Location's time zone.
          {inList && (
            <>
              {" "}
              <Link to={`/shots?${new URLSearchParams({ [filter]: id }).toString()}`} className="underline underline-offset-4">
                Filter the Shots list by it
              </Link>
              .
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read its Shots: {error}</AlertDescription>
          </Alert>
        )}
        {data?.total === 0 && <p className="text-muted-foreground">No Shots yet.</p>}
        {data && data.total > 0 && data.shots.length === 0 && (
          <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setOffset(0)}>
            Back to the newest Shots
          </Button>
        )}
        {data && data.shots.length > 0 && (
          <>
            <div className="rounded-lg border">
              <Table aria-label={`Shots with this ${name}`}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pulled</TableHead>
                    <TableHead>Machine</TableHead>
                    <TableHead>Location</TableHead>
                    {kind !== "profile" && <TableHead>Profile</TableHead>}
                    {kind !== "beanBatch" && <TableHead>Bean Batch</TableHead>}
                    {kind !== "grinder" && <TableHead>Grinder</TableHead>}
                    <TableHead>Dose</TableHead>
                    <TableHead>Yield</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Enjoyment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.shots.map((shot) => (
                    <TableRow key={shot.id}>
                      <TableCell className="font-medium">
                        <Link to={`/shots/${encodeURIComponent(shot.id)}`} className="underline-offset-4 hover:underline">
                          {shotTime(shot)}
                        </Link>
                      </TableCell>
                      <TableCell className="min-w-28 whitespace-normal">
                        <MachineCredit record={shot} />
                      </TableCell>
                      <TableCell className="min-w-28 whitespace-normal">
                        <LocationCredit record={shot} />
                      </TableCell>
                      {kind !== "profile" && (
                        <TableCell className="min-w-28 whitespace-normal">
                          <ShotProfile shot={shot} />
                        </TableCell>
                      )}
                      {kind !== "beanBatch" && (
                        <TableCell className="min-w-28 whitespace-normal">
                          <ShotBatch shot={shot} />
                        </TableCell>
                      )}
                      {kind !== "grinder" && (
                        <TableCell className="min-w-28 whitespace-normal">
                          <ShotGrinder shot={shot} />
                        </TableCell>
                      )}
                      <TableCell>
                        <OrNone>{gramsText(shot.actualDose, shot.targetDose)}</OrNone>
                      </TableCell>
                      <TableCell>
                        <OrNone>{gramsText(shot.actualYield, shot.targetYield)}</OrNone>
                      </TableCell>
                      <TableCell>
                        <OrNone>{secondsText(shot.duration)}</OrNone>
                      </TableCell>
                      <TableCell>
                        <OrNone>{numberText(shot.enjoyment)}</OrNone>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                Shots {data.offset + 1}–{data.offset + data.shots.length} of {data.total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
                  Newer
                </Button>
                <Button variant="outline" size="sm" disabled={data.offset + PAGE_SIZE >= data.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
                  Older
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
