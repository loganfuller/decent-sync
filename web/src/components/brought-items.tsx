import { useCallback } from "react";
import { Link } from "react-router";
import { itemPath } from "@/components/conflicts";
import { formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type BroughtItem, type LibraryKind } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

const KIND_NAMES: Record<LibraryKind, string> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder", profile: "Profile" };

/**
 * What the Machine's tablet brought to the Library as the Machine joined a
 * Location, the latest first: each item it held that joined the Library
 * there, or was matched to one the Library had, with a link to its page,
 * where an Admin or Staff Archives a duplicate. Shown only if there are any.
 */
export function BroughtItemsCard({ machineId }: { machineId: string }) {
  const load = useCallback(() => api<{ brought: BroughtItem[] }>("GET", `/machines/${encodeURIComponent(machineId)}/brought`), [machineId]);
  const { data, error } = usePolled(load, DETAILS_POLL_MS);

  if (!data) {
    return error ? (
      <Alert variant="destructive">
        <AlertDescription>Could not read what it brought to the Library: {error}</AlertDescription>
      </Alert>
    ) : null;
  }
  if (data.brought.length === 0) return null;
  return (
    <Card role="region" aria-label="Brought to the Library">
      <CardHeader>
        <CardTitle>
          <h2>Brought to the Library</h2>
        </CardTitle>
        <CardDescription>
          What its tablet held when it joined a Location: each joined the Library there, or was matched to one the Library had, a
          Bean by roaster and name and a Profile by its id. Archive any that duplicate another from its page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label="Brought to the Library">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.brought.map((brought) => (
              <TableRow key={`${brought.item.kind}:${brought.item.id}`}>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={itemPath(brought.item.kind, brought.item.id)} className="font-medium underline-offset-4 hover:underline">
                      {brought.item.name ?? `Unnamed ${KIND_NAMES[brought.item.kind]}`}
                    </Link>
                    {brought.archived && <Badge variant="secondary">Archived</Badge>}
                  </div>
                </TableCell>
                <TableCell>{KIND_NAMES[brought.item.kind]}</TableCell>
                <TableCell className="whitespace-normal">{brought.matched ? "Matched one the Library had" : "Added to the Library"}</TableCell>
                <TableCell>{brought.location?.name ?? "A Location since removed"}</TableCell>
                <TableCell>{formatTime(brought.broughtAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
