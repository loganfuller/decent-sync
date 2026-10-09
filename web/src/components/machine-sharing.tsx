import { useId, useState } from "react";
import { Field, Fields } from "@/components/fields";
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
import { api, type CaptureOnlyReason, type Machine } from "@/lib/api";

const REASONS: Record<CaptureOnlyReason, string> = {
  noLocation: "It has no Location.",
  sharingOff: "An Admin turned its sharing off.",
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
 * the Location's state.
 */
export function MachineSharingCard({ machine, isAdmin, onChanged }: { machine: Machine; isAdmin: boolean; onChanged(): Promise<void> }) {
  const switchId = useId();
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
      await onChanged();
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
          A Machine at a Location shares its Library: Beans, Bean Batches, Grinders, Profiles and steam, hot water and rinse settings.
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
        </Fields>
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
                    ? `It joins ${location} again: its tablet is written what ${location} offers and its settings, and what its tablet added meanwhile joins the Library there.`
                    : "It shares once it is at a Location."
                  : "It becomes capture-only: its Shots and Steam Records are still recorded, but nothing more is written to its tablet, and what its tablet adds or changes isn't taken into the Library."}
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
