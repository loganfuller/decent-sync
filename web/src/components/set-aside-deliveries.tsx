import { useCallback, useState } from "react";
import { formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type SetAsideDeliveryPage } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

const PAGE_SIZE = 20;

/** What each type of delivery carried. */
const DELIVERY_TYPES: Record<string, string> = {
  shot: "Shot",
  shotUpdated: "Shot edit",
  steam: "Steam Record",
  workflow: "Workflow",
  machineState: "Machine state",
  collection: "Library, settings or paired devices",
};

/**
 * The deliveries from the Machine's tablet that the server could not store,
 * and set aside, latest first, a page at a time: when, what and why, never
 * what they carried. Shown only if there are any.
 */
export function SetAsideDeliveriesCard({ machineId }: { machineId: string }) {
  const [offset, setOffset] = useState(0);
  // Each page loaded remembers where it starts: the last one is still shown while another loads.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    return { offset, page: await api<SetAsideDeliveryPage>("GET", `/machines/${encodeURIComponent(machineId)}/set-aside-deliveries?${query}`) };
  }, [machineId, offset]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);

  if (!data) {
    return error ? (
      <Alert variant="destructive">
        <AlertDescription>Could not read the deliveries set aside: {error}</AlertDescription>
      </Alert>
    ) : null;
  }
  const { page } = data;
  if (page.total === 0) return null;
  const first = data.offset + 1;
  const last = data.offset + page.deliveries.length;
  return (
    <Card role="region" aria-label="Deliveries set aside" className="border-destructive">
      <CardHeader>
        <CardTitle>
          <h2>Deliveries set aside</h2>
        </CardTitle>
        <CardDescription>
          {page.total === 1 ? "1 delivery" : `${page.total} deliveries`} from its tablet could not be stored, and would fail the
          same way if sent again. Each was set aside as sent, so what the tablet sent after it was still stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Table aria-label="Deliveries set aside">
          <TableHeader>
            <TableRow>
              <TableHead>Set aside</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.deliveries.map((delivery) => (
              <TableRow key={delivery.id}>
                <TableCell>{formatTime(delivery.receivedAt)}</TableCell>
                <TableCell className="whitespace-normal">{DELIVERY_TYPES[delivery.type] ?? delivery.type}</TableCell>
                <TableCell className="font-mono">{delivery.recordId ?? "None"}</TableCell>
                <TableCell className="min-w-48 whitespace-normal">
                  {delivery.error} <span className="font-mono text-muted-foreground">({delivery.sqlState})</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {page.total > PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Deliveries {first}–{last} of {page.total}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
                Newer
              </Button>
              <Button variant="outline" size="sm" disabled={last >= page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
                Older
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
