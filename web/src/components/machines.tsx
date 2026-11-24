import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { machineStateText, nameMachineState } from "@decent-sync/protocol";
import { RelativeTime } from "@/components/relative-time";
import { SpecMark } from "@/components/spec-mark";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  api,
  type Identification,
  type IssuedToken,
  type Location,
  type Machine,
  type MachineState,
  type PendingMachine,
} from "@/lib/api";
import { lastShotMarks, offlineKind } from "@/lib/overview";

// Pieces the Machines list, the Machine page and the Overview's status cards share.

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** A time in this browser's time zone, as status times are shown. Location History times use their Location's. */
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

/**
 * A Machine State on one line, as the Live View names it from Decaid's state
 * and substate (`nameMachineState`): "Pulling a shot · Preinfusion", or just
 * "Asleep".
 */
export function describeMachineState({ state, substate }: Pick<MachineState, "state" | "substate">): string {
  return machineStateText(nameMachineState(state, substate));
}

/**
 * Whether a Machine is online, as the Overview's status card, the Machines
 * list and its own page say it (#543, #545). Offline reads louder than
 * online: one that went offline awake is marked, and one that went offline
 * asleep, as a Machine left for the night does, is muted, as is one no
 * tablet has ever connected for (`offlineKind`).
 */
export function StatusBadge({ machine }: { machine: Machine }) {
  if (machine.online) return <Badge>Online</Badge>;
  const kind = offlineKind(machine);
  if (kind === "awake") {
    return (
      <SpecMark label={null} className="rounded-4xl px-2 text-xs">
        Offline
      </SpecMark>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {kind === "asleep" ? "Offline, asleep" : "Offline"}
    </Badge>
  );
}

/** When an offline Machine was last seen, as how long ago, by `timeZone`'s clock, or that no tablet has ever connected for it. */
export function LastSeen({ machine, timeZone }: { machine: Machine; timeZone?: string }) {
  if (machine.lastSeenAt === null) return <>Never connected</>;
  return (
    <>
      Last seen <RelativeTime at={machine.lastSeenAt} timeZone={timeZone} />
    </>
  );
}

/**
 * A Machine's last Shot: how long ago, by `timeZone`'s clock, then its
 * Recipe and duration, linked to the Shot, and what of it is out of spec,
 * marked (#543). `lead` is what goes before the time, as "Last Shot" where
 * no heading says so.
 */
export function LastShot({ machine, timeZone, lead }: { machine: Machine; timeZone?: string; lead?: string }) {
  const last = machine.lastShot;
  if (!last) return <span className="text-muted-foreground">No Shots yet</span>;
  // The previous release's answer during a deploy gives neither its Recipe nor its duration (ADR-0025): the link is the Shot alone.
  const named = last.recipe === undefined ? ["Open"] : [last.recipe?.name ?? (last.recipe ? "Unnamed Recipe" : "No Recipe"), ...(last.duration != null ? [`${last.duration.toFixed(1)} s`] : [])];
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className="text-muted-foreground">
        {lead && `${lead} `}
        {last.pulledAt ? <RelativeTime at={last.pulledAt} timeZone={timeZone} /> : "at a time not known"}
      </span>
      <Link to={`/shots/${encodeURIComponent(last.id)}`} className="tabular-nums underline-offset-4 hover:underline">
        {named.join(" · ")}
      </Link>
      {last.spec?.unfinished && <span className="text-muted-foreground">Unfinished</span>}
      {last.spec?.cleaningOrCalibration && <span className="text-muted-foreground">Cleaning or calibration</span>}
      {lastShotMarks(last.spec).map((mark) => (
        <SpecMark key={mark} className="tabular-nums">
          {mark}
        </SpecMark>
      ))}
    </span>
  );
}

/** A Recipe Slot's number, in the small square that stands before a Recipe's name. */
export function SlotBadge({ slot }: { slot: number }) {
  return (
    <Badge variant="outline" aria-label={`Slot ${slot}`} className="rounded-md px-1.5 text-muted-foreground tabular-nums">
      {slot}
    </Badge>
  );
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

/** The server's Locations, by name, for choosers; undefined until they arrive. */
export function useLocations(): { locations: Location[] | undefined; error: string | undefined } {
  const [locations, setLocations] = useState<Location[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api<{ locations: Location[] }>("GET", "/locations").then(
      ({ locations }) => current && setLocations(locations),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The Locations could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, []);
  return { locations, error };
}

/** A new machine entry: its name, and the Location it is at from now, if any. */
export interface MachineEntry {
  name: string;
  locationId: string | null;
}

// Every option of a Select needs a value, so "No Location" has one no Location id can be.
const NO_LOCATION = "none";

/** A form for a new machine entry's name and Location. */
export function MachineEntryForm({
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  onSubmit(entry: MachineEntry): Promise<void>;
  onCancel?(): void;
}) {
  const id = useId();
  const { locations, error: locationsError } = useLocations();
  const [name, setName] = useState("");
  const [location, setLocation] = useState(NO_LOCATION);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ name, locationId: location === NO_LOCATION ? null : location });
      setName("");
      setLocation(NO_LOCATION);
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
      <div className="grid gap-2">
        <Label htmlFor={`${id}-location`}>Location</Label>
        <Select value={location} onValueChange={setLocation}>
          <SelectTrigger id={`${id}-location`} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_LOCATION}>No Location</SelectItem>
            {locations?.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {locationsError && <p className="text-sm text-destructive">{locationsError}</p>}
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
  ariaLabel,
  ariaDescribedBy,
  title,
  description,
  confirmLabel,
  variant = "outline",
  size,
  disabled,
  onConfirm,
}: {
  label: string;
  /** A fuller name for the button, such as one naming the row it acts on. */
  ariaLabel?: string;
  /** The id of what describes the button, such as why it is disabled. */
  ariaDescribedBy?: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: "outline" | "destructive";
  /** The button's size; the dialog is the same at any. */
  size?: "sm";
  disabled?: boolean;
  onConfirm(): void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={disabled} aria-label={ariaLabel} aria-describedby={ariaDescribedBy}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <ConfirmContent title={title} description={description} confirmLabel={confirmLabel} variant={variant} onConfirm={onConfirm} />
    </AlertDialog>
  );
}

/** What a confirmation asks, and what it is called once confirmed. */
interface Confirmation {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  variant?: "outline" | "destructive";
  onConfirm(): void;
}

function ConfirmContent({ title, description, confirmLabel, variant = "outline", onConfirm, onCloseAutoFocus }: Confirmation & { onCloseAutoFocus?(event: Event): void }) {
  return (
    <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
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
  );
}

/**
 * A confirmation with no button of its own, opened by what holds `open`, as a menu's item does: `ConfirmButton`'s
 * dialog. With no trigger, the keyboard's focus has nowhere to go back to as it closes, so `onCloseAutoFocus` puts it
 * somewhere.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  ...confirmation
}: Confirmation & { open: boolean; onOpenChange(open: boolean): void; onCloseAutoFocus(event: Event): void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <ConfirmContent {...confirmation} onCloseAutoFocus={onCloseAutoFocus} />
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

  async function create(entry: MachineEntry) {
    const issued = await api<IssuedToken>("POST", `/pending-machines/${pending.id}/machine`, entry);
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
        <MachineEntryForm
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
