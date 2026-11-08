import { ConfirmButton, formatTime } from "@/components/machines";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountConnectedApp, ConnectedApp } from "@/lib/api";

/** What a Connected App may do, as the consent page offered it. */
export function describeAccess(scopes: string[]): string {
  return scopes.includes("change") ? "Read and change" : "Read";
}

/**
 * Connected Apps, each with its name above the host its client id is published at, what it may do, when it was
 * approved and last used, and a Disconnect button. With `accounts`, as an Admin sees every account's, each also names
 * whose it is.
 */
export function ConnectedAppTable({
  label,
  apps,
  accounts = false,
  onDisconnect,
}: {
  label: string;
  apps: ConnectedApp[] | AccountConnectedApp[];
  /** Whether each names its account, as every account's do. */
  accounts?: boolean;
  onDisconnect(app: ConnectedApp): Promise<void>;
}) {
  return (
    <div className="min-w-0 rounded-lg border">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {accounts && <TableHead>Account</TableHead>}
            <TableHead>App</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Approved</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.map((app) => {
            const owner = accounts ? (app as AccountConnectedApp).account : undefined;
            return (
              <TableRow key={app.id}>
                {owner && <TableCell className="font-medium">{owner.name}</TableCell>}
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="font-medium">{app.name}</span>
                    <span className="text-xs text-muted-foreground">{app.host}</span>
                  </span>
                </TableCell>
                <TableCell>{describeAccess(app.scopes)}</TableCell>
                <TableCell>{formatTime(app.approvedAt)}</TableCell>
                <TableCell>{formatTime(app.lastUsedAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <ConfirmButton
                      label="Disconnect"
                      ariaLabel={owner ? `Disconnect ${owner.name}'s ${app.name}` : `Disconnect ${app.name}`}
                      title={`Disconnect ${app.name}?`}
                      description={
                        owner
                          ? `${app.name} at ${app.host} stops acting as ${owner.name} at once. To use it again, they connect it again from the app.`
                          : `${app.name} at ${app.host} stops acting as you at once. To use it again, connect it again from the app.`
                      }
                      confirmLabel="Disconnect"
                      variant="destructive"
                      onConfirm={() => void onDisconnect(app)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
