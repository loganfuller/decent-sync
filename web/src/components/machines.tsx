import { type FormEvent, type ReactNode, useId, useState } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Identification, type IssuedToken, type Machine, type PendingMachine } from "@/lib/api";

// Pieces the Machines list and Machine page share.

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/**
 * A time in this browser's time zone. Machines are not yet tied to a
 * Location's time zone, so status times use the viewer's.
 */
export function formatTime(iso: string): string {
  return TIME.format(new Date(iso));
}

/** Hardware as the server's messages name it, such as "DE1Pro serial 10001". */
export function describeHardware(hardware: { model: string; serial: string }): string {
  return `${hardware.model} serial ${hardware.serial}`;
}

/** Whether a serial identifies hardware: not empty, and not the "0" older DE1s report. As the protocol package decides. */
export function isRealSerial(serial: string): boolean {
  const trimmed = serial.trim();
  return trimmed !== "" && trimmed !== "0";
}

/** The hardware a Machine's token is bound to, or null until it is bound. */
export function bindingOf(machine: Machine): { model: string; serial: string } | null {
  return machine.model !== null && machine.serial !== null ? { model: machine.model, serial: machine.serial } : null;
}

/** Whether two pieces of hardware are the same, ignoring surrounding spaces, as the protocol package decides. */
export function sameHardware(a: { model: string; serial: string }, b: { model: string; serial: string }): boolean {
  return a.model.trim() === b.model.trim() && a.serial.trim() === b.serial.trim();
}

/**
 * Whether an Admin can enter the Machine's model and serial: it is an
 * Unidentified Machine, or an unbound one whose machine reported no serial
 * before its tablet last started without its machine. The server decides
 * the same way.
 */
export function needsHardware(machine: Machine): boolean {
  if (machine.identification === "unidentified") return true;
  return machine.model === null && machine.reported !== null && !isRealSerial(machine.reported.serial);
}

/** The model to show for a Machine: its bound hardware's, or what an Unidentified Machine reports. */
export function machineModel(machine: Machine): string | null {
  if (machine.model !== null) return machine.model;
  return needsHardware(machine) ? (machine.reported?.model ?? null) : null;
}

export function StatusBadge({ machine }: { machine: Machine }) {
  return machine.online ? <Badge>Online</Badge> : <Badge variant="outline">Offline</Badge>;
}

const IDENTIFICATION_LABELS: Record<Exclude<Identification, "identified">, string> = {
  unidentified: "Unidentified",
  hardwareNotReported: "Hardware not reported",
  mismatch: "Mismatch",
};

/** Flags a Machine whose identity needs attention; an identified Machine has none. */
export function IdentificationBadge({ identification }: { identification: Identification }) {
  if (identification === "identified") return null;
  return (
    <Badge variant={identification === "hardwareNotReported" ? "secondary" : "destructive"}>
      {IDENTIFICATION_LABELS[identification]}
    </Badge>
  );
}

/** A one-field form for a machine entry's name. */
export function MachineNameForm({
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  onSubmit(name: string): Promise<void>;
  onCancel?(): void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(name);
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={label} className="grid gap-4" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} required />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** A button that asks for confirmation before an action that cannot simply be undone. */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  variant = "outline",
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: "outline" | "destructive";
  disabled?: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} disabled={disabled}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={variant === "destructive" ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Resolving a Pending Machine: creating a machine entry for its hardware,
 * which takes over what is held for it and issues a token, or dismissing it.
 * A dismissed one can still get a machine entry, which restores what it holds.
 */
export function PendingMachineActions({
  pending,
  onCreated,
  onDismissed,
}: {
  pending: PendingMachine;
  onCreated(issued: IssuedToken): void;
  onDismissed(): Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string>();
  const hardware = describeHardware(pending);

  async function create(name: string) {
    const issued = await api<IssuedToken>("POST", `/pending-machines/${pending.id}/machine`, { name });
    setCreating(false);
    onCreated(issued);
  }

  async function dismiss() {
    setDismissing(true);
    setError(undefined);
    try {
      await api("POST", `/pending-machines/${pending.id}/dismiss`);
      await onDismissed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setDismissing(false);
    }
  }

  const reporters = pending.mismatchedMachines.map((machine) => machine.name).join(", ");

  return (
    <div className="grid gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {creating ? (
        <MachineNameForm
          label={`New machine entry for ${hardware}`}
          submitLabel="Create Machine"
          onSubmit={create}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreating(true)}>Create machine entry</Button>
          {!pending.dismissed && (
            <ConfirmButton
              label="Dismiss"
              title={`Dismiss ${hardware}?`}
              description={
                reporters
                  ? `Tablets reporting it with the token of ${reporters} are disconnected and refused from now on. Anything already received is kept, and creating a machine entry for it later brings that back.`
                  : "Anything received for it is kept, and creating a machine entry for it later brings that back."
              }
              confirmLabel="Dismiss"
              variant="destructive"
              disabled={dismissing}
              onConfirm={() => void dismiss()}
            />
          )}
        </div>
      )}
    </div>
  );
}
