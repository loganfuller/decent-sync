import { type ReactNode, useCallback, useId, useState } from "react";
import { Link } from "react-router";
import { itemPath } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type CaptureOnlyReason, type ItemKind, type Location, type Machine, type SharingStatus, type TabletChange } from "@/lib/api";
import { usePolled } from "@/lib/use-polled";

const REASONS: Record<CaptureOnlyReason, string> = {
  noLocation: "It has no Location.",
  sharingOff: "An Admin turned its sharing off.",
};

const KIND_NAMES: Record<TabletChange["kind"], string> = {
  bean: "Bean",
  beanBatch: "Bean Batch",
  grinder: "Grinder",
  profile: "Profile",
  settings: "Steam, hot water and rinse settings",
  workflow: "Workflow",
};

/** Flags a Capture-only Machine, which takes no part in the Library; a Machine sharing it has none. */
export function CaptureOnlyBadge({ machine }: { machine: Machine }) {
  return machine.captureOnly.length === 0 ? null : <Badge variant="secondary">Capture-only</Badge>;
}

/**
 * Whether the Machine takes part in the Library at its Location, or is a
 * Capture-only Machine, and why: it has no Location, or an Admin turned its
 * sharing off. An Admin turns its sharing off or back on here, once they
 * confirm: turned back on, its tablet joins its Location again, taking on
 * the Location's state over what it changed or added meanwhile. With its
 * sharing status, loaded as often as the Machine's own: how many changes
 * are waiting for its tablet, the last its tablet applied, and those it
 * refused, with Decaid's answer.
 */
export function MachineSharingCard({ machine, isAdmin, onChanged }: { machine: Machine; isAdmin: boolean; onChanged(): Promise<void> }) {
  const switchId = useId();
  const loadStatus = useCallback(
    async () => (await api<{ status: SharingStatus }>("GET", `/machines/${encodeURIComponent(machine.id)}/sharing-status`)).status,
    [machine.id],
  );
  const { data: status, error: statusError, reload: reloadStatus } = usePolled(loadStatus);
  /** Whether the confirmation is open, and the position it asks to switch to, kept as it closes. */
  const [confirming, setConfirming] = useState(false);
  const [asked, setAsked] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const location = machine.location?.name;

  async function switchSharing(sharing: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await api("PUT", `/machines/${machine.id}/sharing`, { sharing });
      await Promise.all([onChanged(), reloadStatus()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Its sharing could not be switched");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card role="region" aria-label="Sharing">
      <CardHeader>
        <CardTitle>
          <h2>Sharing</h2>
        </CardTitle>
        <CardDescription>
          A Machine at a Location shares the Library with the Location's other Machines: its Beans, Bean Batches, Grinders and
          Profiles.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Fields label="Sharing">
          <Field term="Library">
            {machine.captureOnly.length === 0 ? (
              `Shared at ${location}`
            ) : (
              <div className="grid gap-1">
                <span className="font-medium">Capture-only</span>
                {machine.captureOnly.map((reason) => (
                  <span key={reason}>{REASONS[reason]}</span>
                ))}
                <span className="text-muted-foreground">
                  Its Shots and Steam Records are still recorded, but nothing is written to its tablet, and what its tablet adds or changes
                  isn't taken into the Library.
                </span>
              </div>
            )}
          </Field>
          {status && (
            <>
              <Field term="Changes waiting">{waitingText(status, machine.online)}</Field>
              <Field term="Last change applied">
                {status.lastApplied ? (
                  <>
                    <ChangeDescription change={status.lastApplied} location={machine.location} />, {formatTime(status.lastApplied.appliedAt)}
                  </>
                ) : (
                  "None yet"
                )}
              </Field>
            </>
          )}
        </Fields>
        {statusError && !status && (
          <Alert variant="destructive">
            <AlertDescription>Could not read its sharing status: {statusError}</AlertDescription>
          </Alert>
        )}
        {status && status.refused.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Changes its tablet refused</h3>
            <p className="text-sm text-muted-foreground">
              Everything else still applies. Each is tried again once its item changes again, or its tablet reconnects.
            </p>
            <Table aria-label="Changes its tablet refused">
              <TableHeader>
                <TableRow>
                  <TableHead>Refused</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Decaid's answer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {status.refused.map((refusal) => (
                  <TableRow key={`${refusal.change}:${refusal.kind}:${refusal.item?.id ?? refusal.localId}`}>
                    <TableCell>{formatTime(refusal.refusedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <ChangeDescription change={refusal} location={machine.location} />
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal wrap-anywhere">
                      <span className="font-medium">{refusal.status === null ? "No answer" : refusal.status}</span>{" "}
                      <span className="font-mono text-muted-foreground">{refusal.error}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {isAdmin && (
          <div className="flex items-center gap-3">
            <Switch id={switchId} checked={machine.sharing} disabled={busy} onCheckedChange={(checked) => {
                setAsked(checked);
                setConfirming(true);
              }}
            />
            <Label htmlFor={switchId}>Share the Library</Label>
          </div>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{asked ? `Turn sharing back on for ${machine.name}?` : `Turn sharing off for ${machine.name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {asked
                  ? location
                    ? `It joins ${location} again: its tablet is written what ${location} offers and its settings, over what it changed meanwhile, and what it added meanwhile stays out of the Library, archived or hidden on it.`
                    : "It shares once it is at a Location."
                  : location
                    ? "It becomes capture-only: its Shots and Steam Records are still recorded, but nothing more is written to its tablet, and what its tablet adds or changes isn't taken into the Library, then or once sharing is back on."
                    : "It has no Location, so it is capture-only already, and stays so once it is given one."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={asked ? "default" : "destructive"}
                onClick={() => void switchSharing(asked)}
              >
                {asked ? "Turn sharing on" : "Turn sharing off"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/** How many changes are waiting for the Machine's tablet, or why none is. */
function waitingText(status: SharingStatus, online: boolean): string {
  if (status.tabletId === null) return "None: no tablet has connected";
  if (status.waiting === null) return "None: nothing is written to its tablet while it is capture-only";
  if (status.waiting === 0) return "None: its tablet is up to date";
  const count = status.waiting === 1 ? "1 change" : `${status.waiting} changes`;
  return online ? count : `${count}, written once its tablet connects`;
}

/** A change made to the Machine's tablet, naming its item, linked to its page, where the Library still has it. */
function ChangeDescription({ change, location }: { change: TabletChange; location: Location | null }) {
  const kind = KIND_NAMES[change.kind];
  const record = (
    <>
      {kind} record <span className="font-mono">{change.localId}</span>
    </>
  );
  if (change.change === "leaveOut") return <>{record} set aside, as the Library leaves it out</>;
  if (change.kind === "workflow") return <>Its Workflow's grinder and batch cleared</>;
  let item: ReactNode;
  if (change.item) {
    const { item: named } = change;
    item = (
      <Link to={itemPath(named.kind as ItemKind, named.id, location)} className="underline-offset-4 hover:underline">
        {change.kind === "settings" ? kind : named.name === null ? `Unnamed ${kind}` : `${kind} ${named.name}`}
      </Link>
    );
  } else {
    item = change.localId === null ? `A ${kind} since deleted` : record;
  }
  return change.change === "delete" ? <>{item} deleted</> : <>{item} written</>;
}
