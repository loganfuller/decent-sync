import { useCallback, useState } from "react";
import { Link } from "react-router";
import {
  IdentificationBadge,
  type MachineEntry,
  MachineEntryForm,
  PendingMachineActions,
  StatusBadge,
  describeHardware,
  formatTime,
  machineModel,
} from "@/components/machines";
import { TokenNotice } from "@/components/TokenNotice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type IssuedToken, type Machine, type PendingMachine } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

interface Machines {
  machines: Machine[];
  pendingMachines: PendingMachine[];
}

/** Machines and their status, creating machine entries, and resolving Pending Machines. */
export function MachinesPage() {
  const load = useCallback(async (): Promise<Machines> => {
    const [{ machines }, { pendingMachines }] = await Promise.all([
      api<{ machines: Machine[] }>("GET", "/machines"),
      api<{ pendingMachines: PendingMachine[] }>("GET", "/pending-machines"),
    ]);
    return { machines, pendingMachines };
  }, []);
  const { data, error, reload } = usePolled(load);
  // Kept here, not with the form or Pending Machine that issued it, which a reload may remove.
  const [issued, setIssued] = useState<IssuedToken>();

  async function create(entry: MachineEntry) {
    setIssued(await api<IssuedToken>("POST", "/machines", entry));
    await reload();
  }

  function created(token: IssuedToken) {
    setIssued(token);
    void reload();
  }

  const pending = data?.pendingMachines.filter((machine) => !machine.dismissed) ?? [];
  const dismissed = data?.pendingMachines.filter((machine) => machine.dismissed) ?? [];

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">Machines</h1>
        <p className="text-muted-foreground">
          The machines that sync with this server. A machine joins when someone enters its token in the Decent Sync
          plugin on its tablet.
        </p>
      </div>

      {/* Keyed, so a new token never inherits the last one's "Copied". */}
      {issued && <TokenNotice key={issued.token} issued={issued} onDone={() => setIssued(undefined)} />}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {pending.length > 0 && (
        <PendingMachines
          title="Pending Machines"
          description="Hardware a tablet reported that no machine entry covers. Create a machine entry for it, or dismiss it."
          pendingMachines={pending}
          onCreated={created}
          onDismissed={reload}
        />
      )}

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>
            <h2>New Machine</h2>
          </CardTitle>
          <CardDescription>
            Its hardware is recorded from the first connection with its token. It is at its Location from now; correct
            when it arrived on its page to credit earlier Shots there.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MachineEntryForm label="New Machine" submitLabel="Create Machine" onSubmit={create} />
        </CardContent>
      </Card>

      {data?.machines.length === 0 && <p className="text-muted-foreground">No Machines yet.</p>}
      {data && data.machines.length > 0 && <MachineTable machines={data.machines} />}

      {dismissed.length > 0 && (
        <PendingMachines
          title="Dismissed Pending Machines"
          description="Hardware an Admin dismissed. Anything received for it is kept and comes back if it gets a machine entry."
          pendingMachines={dismissed}
          onCreated={created}
          onDismissed={reload}
        />
      )}
    </section>
  );
}

function MachineTable({ machines }: { machines: Machine[] }) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Machines">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Attention</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {machines.map((machine) => (
            <TableRow key={machine.id}>
              <TableCell className="font-medium">
                <Link to={`/machines/${machine.id}`} className="underline-offset-4 hover:underline">
                  {machine.name}
                </Link>
              </TableCell>
              <TableCell>{machineModel(machine) ?? <span className="text-muted-foreground">Not reported</span>}</TableCell>
              <TableCell>{machine.location?.name ?? <span className="text-muted-foreground">No Location</span>}</TableCell>
              <TableCell>
                <StatusBadge machine={machine} />
              </TableCell>
              <TableCell>{machine.lastSeenAt ? formatTime(machine.lastSeenAt) : "Never"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <IdentificationBadge identification={machine.identification} />
                  {machine.lastRefusal && <Badge variant="destructive">Refused</Badge>}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PendingMachines({
  title,
  description,
  pendingMachines,
  onCreated,
  onDismissed,
}: {
  title: string;
  description: string;
  pendingMachines: PendingMachine[];
  onCreated(issued: IssuedToken): void;
  onDismissed(): Promise<void>;
}) {
  return (
    <section className="grid gap-3">
      <div className="grid gap-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {title} <Badge variant="secondary">{pendingMachines.length}</Badge>
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <ul aria-label={title} className="grid max-w-2xl divide-y rounded-lg border">
        {pendingMachines.map((pending) => (
          <li key={pending.id} className="grid gap-3 p-4">
            <div className="grid gap-0.5">
              <span className="font-medium">{describeHardware(pending)}</span>
              {pending.mismatchedMachines.length > 0 && (
                <span className="text-sm">
                  Reported with the token of{" "}
                  {pending.mismatchedMachines.map((machine, index) => (
                    <span key={machine.id}>
                      {index > 0 && ", "}
                      <Link to={`/machines/${machine.id}`} className="underline underline-offset-4">
                        {machine.name}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
              <span className="text-sm text-muted-foreground">
                First seen {formatTime(pending.firstSeenAt)}
                {pending.lastSeenAt && `, last reported ${formatTime(pending.lastSeenAt)}`}
              </span>
            </div>
            <PendingMachineActions pending={pending} onCreated={onCreated} onDismissed={onDismissed} />
          </li>
        ))}
      </ul>
    </section>
  );
}
