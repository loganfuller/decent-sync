import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useIsAdmin } from "@/auth";
import { InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type Collection, type Machine, type SettingsEdit, api } from "@/lib/api";
import { fieldText, isObject, valueText } from "@/lib/settings-text";
import { differingZoneOffset, timeOfDayMinutes, timeOfDayText, utcOffsetText } from "@/lib/tablet-time";
import {
  type EditableSettingsField,
  SETTINGS_FIELDS,
  type SettingsCollectionName,
  decimalPlaces,
  isEditable,
  isEditableSettingsCollection,
  sameValue,
  settingsField,
  settingsRefusalText,
  validateSettingsEdit,
} from "@decent-sync/protocol";

// Settings Edits (ADR-0023): a section of the Settings card changed here,
// sent to the Machine's Tablet at once, then shown as pending until the
// Machine answers, and with what came of it. Decaid and the Machine keep
// their settings: the section's values always come from the latest report.

/** How often a pending edit is read again, until the Machine answers it. */
const PENDING_POLL_MS = 1_000;

/** How often an edit not confirmed is read again, as an answer may still arrive late, and may never. */
const NOT_CONFIRMED_POLL_MS = 5_000;

/**
 * The fields of a section the signed-in account may change, each reported
 * in its latest report: for an Admin every editable field, for Staff at the
 * Machine's Location those marked for Staff, and none where Settings Edits
 * do not change the section yet.
 */
export function useOfferedFields(name: SettingsCollectionName, collection: Collection | null, machine: Machine): EditableSettingsField[] {
  const isAdmin = useIsAdmin();
  const mayChangeAt = useMayChangeAt();
  const value = collection?.available ? collection.value : undefined;
  if (!isEditableSettingsCollection(name) || !isObject(value) || !mayChangeAt(machine.location?.id ?? null)) return [];
  return SETTINGS_FIELDS[name].filter(isEditable).filter((field) => field.path in value && (isAdmin || field.editableBy === "staff"));
}

/**
 * Why the Machine's settings can't be edited now, or null while they can:
 * it is offline, or its Tablet reports another machine's hardware, which
 * nothing is written to (ADR-0004). The server refuses either with 409.
 */
export function editBlocked(machine: Machine): string | null {
  if (!machine.online) return "Settings can be changed only while the Machine is online, and its Tablet connected.";
  if (machine.identification === "mismatch") return "Its Tablet reports another machine's hardware than this Machine's, so nothing is written to it.";
  return null;
}

/** A field's label, or Decaid's name for one no definition covers. */
export function labelOf(name: string, path: string): string {
  return (isEditableSettingsCollection(name) ? settingsField(name, path)?.label : undefined) ?? path;
}

/** A field's value as the Settings card shows it, a time in the Tablet's own time labelled with its UTC offset where it is given. */
export function shownValue(name: string, path: string, value: unknown, utcOffsetMinutes: number | null = null): string {
  const field = isEditableSettingsCollection(name) ? settingsField(name, path) : undefined;
  return field ? fieldText(field, value, utcOffsetMinutes) : valueText(value);
}

/** Each field's value, as "Label: value", joined. */
function valuesText(name: string, values: Record<string, unknown>, utcOffsetMinutes: number | null = null): string {
  return Object.entries(values)
    .map(([path, value]) => `${labelOf(name, path)}: ${shownValue(name, path, value, utcOffsetMinutes)}`)
    .join("; ");
}

/** What a form holds for each field: a number as typed, a choice by its value as text, a time of day as HH:MM, or on or off. */
type Inputs = Record<string, string | boolean>;

function inputOf(name: SettingsCollectionName, field: EditableSettingsField, value: unknown): string | boolean {
  if (field.kind === "onOff") return value === true;
  if (field.kind === "number" && typeof value === "number") return String(toStep(name, field, value));
  // A reported value that is no time of day opens empty, as a time input shows it.
  if (field.kind === "timeOfDay") return timeOfDayText(value) ?? "";
  return value === undefined || value === null ? "" : String(value);
}

/** Half the step of signed Q16.16, in which the machine keeps each sensor's calibration. */
const Q16_HALF = 0.5 / 65536;

/**
 * A number reported on a field's step, written to as many decimal places as
 * the step has, where it is that step's value as the machine holds it:
 * Decaid reads a scaled register as a whole number times its scale, so a
 * heater flow of 2.3 comes as 2.3000000000000003, and the machine holds a
 * sensor calibration of 1.02 as the nearest Q16.16 value,
 * 1.0199966430664062. A number off the step by more than that is left as it
 * is.
 */
function toStep(name: SettingsCollectionName, field: EditableSettingsField, value: number): number {
  if (field.step === undefined) return value;
  const rounded = Number(value.toFixed(decimalPlaces(field.step)));
  return Math.abs(rounded - value) < (name === "sensorCalibration" ? Q16_HALF : 1e-9) ? rounded : value;
}

/** Whether a choice's input holds one of its choices. */
function offers(field: EditableSettingsField, input: string | boolean): boolean {
  return field.choices?.some((choice) => String(choice.value) === input) ?? false;
}

/**
 * The value an input holds, as the edit sends it: a time of day as minutes
 * after midnight; NaN for a number or time that isn't one, which validation
 * refuses.
 */
function valueOf(field: EditableSettingsField, input: string | boolean): unknown {
  if (field.kind === "onOff") return input === true;
  if (field.kind === "choice") return field.choices?.find((choice) => String(choice.value) === input)?.value ?? input;
  if (field.kind === "timeOfDay") return timeOfDayMinutes(input) ?? Number.NaN;
  return typeof input === "string" && input.trim() !== "" ? Number(input) : Number.NaN;
}

/**
 * A section's inline form: an input for each field the account may change,
 * with its notes, then `children`, the section's other fields, read-only.
 * Saving sends only the fields changed, each with the raw value the report
 * the form opened over held as `expected`, never the value as shown: a
 * report the page loads while the form is open changes neither, so a change
 * made on the Tablet meanwhile refuses the edit as changed since rather than
 * being overwritten. With `confirm`, saving first asks to go ahead with its
 * warning. A time of day is edited in the Tablet's own time, labelled with
 * `utcOffsetMinutes`, the offset reported beside the section, and the form
 * warns where that differs from the Machine's Location's (`TabletTimeWarning`).
 */
export function SettingsForm({
  name,
  machine,
  offered,
  reported,
  utcOffsetMinutes = null,
  label,
  notes,
  confirm,
  onCancel,
  onSaved,
  children,
}: {
  name: SettingsCollectionName;
  machine: Machine;
  offered: EditableSettingsField[];
  /** The section's report as Decaid sent it, read once, as the form opens. */
  reported: Record<string, unknown>;
  /** The Tablet's UTC offset as the report was read, for a section with times in the Tablet's own time; null otherwise. */
  utcOffsetMinutes?: number | null;
  label: string;
  /** What each note on a field says. */
  notes: (field: EditableSettingsField) => string[];
  /** A warning to go ahead past before the edit is made. */
  confirm?: { title: string; description: string };
  onCancel(): void;
  onSaved(edit: SettingsEdit): void;
  children?: ReactNode;
}) {
  const id = useId();
  const isAdmin = useIsAdmin();
  const [baseline] = useState(reported);
  const [inputs, setInputs] = useState<Inputs>(() => Object.fromEntries(offered.map((field) => [field.path, inputOf(name, field, baseline[field.path])])));
  const [error, setError] = useState<string | string[]>();
  const [saving, setSaving] = useState(false);
  // The edit waiting to go ahead past `confirm`'s warning.
  const [confirming, setConfirming] = useState<{ fields: Record<string, unknown>; expected: Record<string, unknown> }>();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const fields: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const field of offered) {
      // An input left as it opened is no change, whatever the value it holds, such as a choice not offered.
      if (inputs[field.path] === inputOf(name, field, baseline[field.path])) continue;
      const value = valueOf(field, inputs[field.path]!);
      const reported = baseline[field.path];
      // A number retyped as reported, such as 2.30 for a heater flow read back as 2.3000000000000003, is no change either.
      if (sameValue(value, field.kind === "number" && typeof reported === "number" ? toStep(name, field, reported) : reported)) continue;
      fields[field.path] = value;
      expected[field.path] = baseline[field.path] ?? null;
    }
    if (Object.keys(fields).length === 0) return onCancel();
    const refusals = validateSettingsEdit({ collection: name, fields }, isAdmin ? "admin" : "staff");
    if (refusals.length > 0) return setError(refusals.map((refusal) => settingsRefusalText(name, refusal)));
    if (confirm) return setConfirming({ fields, expected });
    void make(fields, expected);
  }

  async function make(fields: Record<string, unknown>, expected: Record<string, unknown>) {
    setConfirming(undefined);
    setSaving(true);
    try {
      const { settingsEdit } = await api<{ settingsEdit: SettingsEdit }>("POST", `/machines/${encodeURIComponent(machine.id)}/settings-edits`, { collection: name, fields, expected });
      onSaved(settingsEdit);
    } catch (caught) {
      setError(failure(caught, "The change could not be made"));
    } finally {
      setSaving(false);
    }
  }

  return (
    // Checked against the definitions on saving, for the fields changed only: the browser's own checks would hold a
    // field left as reported, out of its range or off its step, against the others.
    <form aria-label={label} className="grid gap-4" noValidate onSubmit={save}>
      {error && <FormError error={Array.isArray(error) ? error.join(". ") : error} />}
      {offered.some((field) => field.kind === "timeOfDay") && <TabletTimeWarning machine={machine} utcOffsetMinutes={utcOffsetMinutes} />}
      <FieldGroup className="gap-4">
        {offered.map((field) => (
          <SettingInput
            key={field.path}
            id={`${id}-${field.path}`}
            field={field}
            input={inputs[field.path]!}
            utcOffsetMinutes={utcOffsetMinutes}
            notes={notes(field)}
            onChange={(input) => setInputs((current) => ({ ...current, [field.path]: input }))}
          />
        ))}
      </FieldGroup>
      {children}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving || editBlocked(machine) !== null}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {confirm && (
        <AlertDialog open={confirming !== undefined} onOpenChange={(open) => !open && setConfirming(undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirming && `${valuesText(name, confirming.fields, utcOffsetMinutes)}. `}{confirm.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => confirming && void make(confirming.fields, confirming.expected)}>Go ahead</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </form>
  );
}

/**
 * Where the Tablet's UTC offset differs from its Machine's Location's time
 * zone's now, a warning that the times are the Tablet's own: a Tablet set to
 * the wrong time zone wakes or sleeps the Machine at the wrong hour. A
 * Machine with no Location, or a Tablet whose offset is unknown, gets none.
 */
export function TabletTimeWarning({ machine, utcOffsetMinutes }: { machine: Machine; utcOffsetMinutes: number | null }) {
  const location = machine.location;
  const zone = location && utcOffsetMinutes !== null ? differingZoneOffset(utcOffsetMinutes, location.timeZone, Date.now()) : undefined;
  if (!location || utcOffsetMinutes === null || zone === undefined) return null;
  return (
    <Alert>
      <AlertTitle>The Tablet's time zone differs from its Location's</AlertTitle>
      <AlertDescription>
        The Tablet is at {utcOffsetText(utcOffsetMinutes)}, and {location.name} ({location.timeZone}) at {utcOffsetText(zone)} now. The
        times here are the Tablet's own, and it acts on them in its time.
      </AlertDescription>
    </Alert>
  );
}

/** One field's input, by its kind: a number, a choice, a time of day in the Tablet's own time, or on or off. */
function SettingInput({
  id,
  field,
  input,
  utcOffsetMinutes,
  notes,
  onChange,
}: {
  id: string;
  field: EditableSettingsField;
  input: string | boolean;
  utcOffsetMinutes: number | null;
  notes: string[];
  onChange(input: string | boolean): void;
}) {
  // A time of day is labelled with the Tablet's UTC offset, as the Settings card shows it.
  const qualifier = field.kind === "timeOfDay" ? (utcOffsetMinutes === null ? undefined : utcOffsetText(utcOffsetMinutes)) : field.unit;
  const label = qualifier ? `${field.label} (${qualifier})` : field.label;
  const description = notes.length > 0 && <FieldDescription>{notes.join(" ")}</FieldDescription>;
  if (field.kind === "onOff") {
    return (
      <Field orientation="horizontal">
        <Switch id={id} checked={input === true} onCheckedChange={onChange} />
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description}
      </Field>
    );
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {field.kind === "choice" ? (
        // A reported value none of the choices holds, such as a heater voltage of -1, is shown as it is until one is chosen.
        <Select value={offers(field, input) ? String(input) : ""} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={String(input)} />
          </SelectTrigger>
          <SelectContent>
            {field.choices?.map((choice) => (
              <SelectItem key={String(choice.value)} value={String(choice.value)}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.kind === "timeOfDay" ? (
        <Input id={id} type="time" step={60} required value={String(input)} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input
          id={id}
          type="number"
          inputMode={field.kind === "number" ? "decimal" : "numeric"}
          min={field.min}
          max={field.max}
          step={field.kind === "number" ? (field.step ?? "any") : 1}
          required
          value={String(input)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {description}
    </Field>
  );
}

/**
 * The latest edit of a section: pending, read again until the Machine
 * answers it, then what came of it, shown in place. One not confirmed is
 * read again, less often, until an answer arriving late replaces the mark.
 * Once it is answered, whether as it is read again or already as it was
 * made, `onAnswered` reloads the section's values, which come from the
 * latest report, the read-back taken in before the answer.
 */
export function SettingsEditStatus({
  machineId,
  edit: made,
  utcOffsetMinutes = null,
  onAnswered,
}: {
  machineId: string;
  edit: SettingsEdit;
  /** The Tablet's UTC offset its section's times are labelled with, if they are. */
  utcOffsetMinutes?: number | null;
  onAnswered(): Promise<void> | void;
}) {
  const [edit, setEdit] = useState(made);
  const [error, setError] = useState<string>();
  const outcome = edit.outcome;
  // A late answer may still replace a mark of not confirmed, unless the edit was answered, as refused too late.
  const awaiting = outcome === null || (outcome === "notConfirmed" && edit.answeredAt === null);
  // The edit is read until answered, whatever the page reloads meanwhile.
  const answered = useRef(onAnswered);
  answered.current = onAnswered;

  // An edit the Machine answered before the server read it back for its maker comes answered: its reports are loaded at once.
  useEffect(() => {
    if (made.outcome !== null && made.outcome !== "notConfirmed") void answered.current();
  }, [made]);

  useEffect(() => {
    if (!awaiting) return;
    let stopped = false;
    const timer = setInterval(
      async () => {
        try {
          const { settingsEdit } = await api<{ settingsEdit: SettingsEdit }>("GET", `/machines/${encodeURIComponent(machineId)}/settings-edits/${encodeURIComponent(made.id)}`);
          if (stopped) return;
          setError(undefined);
          // Read again while nothing changed; a not confirmed edit answered too late stays so, and is read no more.
          if (settingsEdit.outcome === outcome && settingsEdit.answeredAt === null) return;
          stopped = true;
          clearInterval(timer);
          setEdit(settingsEdit);
          if (settingsEdit.outcome !== null && settingsEdit.outcome !== "notConfirmed") await answered.current();
        } catch (caught) {
          if (!stopped) setError(failure(caught, "The edit could not be read"));
        }
      },
      outcome === null ? PENDING_POLL_MS : NOT_CONFIRMED_POLL_MS,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [awaiting, outcome, machineId, made.id]);

  if (outcome === null) {
    return (
      <Alert role="status">
        <AlertTitle>Pending</AlertTitle>
        <AlertDescription>
          {valuesText(edit.collection, edit.fields, utcOffsetMinutes)}. Sent to the Machine, waiting for its answer.
          {error && ` ${error}.`}
        </AlertDescription>
      </Alert>
    );
  }
  if (outcome === "notConfirmed") {
    return (
      <Alert role="status" variant="destructive">
        <AlertTitle className="flex items-center gap-1.5">
          Not confirmed
          <InfoTip label="About Not confirmed">
            The Machine didn't answer within a minute, or its connection closed first. Its Tablet doesn't start the write after that, but
            one already under way may still finish: an answer arriving later is shown here.
          </InfoTip>
        </AlertTitle>
        <AlertDescription>
          {valuesText(edit.collection, edit.fields, utcOffsetMinutes)}. The section shows the values last reported.
          {error && ` ${error}.`}
        </AlertDescription>
      </Alert>
    );
  }
  const { title, description } = outcomeText(edit, utcOffsetMinutes);
  return (
    <Alert role="status" variant={outcome === "refused" ? "destructive" : "default"}>
      <AlertTitle className="flex items-center gap-1.5">
        {edit.late ? `${title}, answered late` : title}
        {edit.late && <InfoTip label="About answered late">The Machine answered after the edit was marked not confirmed.</InfoTip>}
      </AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

/** What came of an answered edit, as the section shows it, its times labelled with `utcOffsetMinutes` where given. */
export function outcomeText(edit: SettingsEdit, utcOffsetMinutes: number | null = null): { title: string; description: string } {
  const name = edit.collection;
  if (edit.outcome === "applied") return { title: "Applied", description: `${valuesText(name, edit.readBack ?? edit.fields, utcOffsetMinutes)}.` };
  if (edit.outcome === "adjusted") {
    const held = edit.adjusted.filter((field) => "holds" in field);
    const unread = edit.adjusted.filter((field) => !("holds" in field)).map((field) => labelOf(name, field.field));
    const parts = [
      ...(held.length > 0 ? [`The Machine holds another value than was asked for: ${valuesText(name, Object.fromEntries(held.map((field) => [field.field, field.holds])), utcOffsetMinutes)}.`] : []),
      ...(unread.length > 0 ? [`Decaid took the change, but it could not be read back: ${unread.join(", ")}.`] : []),
    ];
    return { title: held.length > 0 ? "Stored otherwise" : "Not read back", description: parts.join(" ") };
  }
  const refusal = edit.refusal;
  switch (refusal?.reason) {
    case "machineBusy":
      return { title: "Not changed", description: `The Machine was busy${refusal.state ? ` (${refusal.state})` : ""}. Edit it again once it is idle.` };
    case "changedSince":
      return {
        title: "Not changed",
        description: `It was changed on the Tablet since the values shown.${refusal.current ? ` It holds ${valuesText(name, refusal.current, utcOffsetMinutes)}.` : ""}`,
      };
    case "expired":
      return { title: "Not changed", description: "The Tablet got the edit too late to make it." };
    case "decaid": {
      const said = refusal.status === null ? (refusal.message ?? "Decaid did not answer") : `Decaid refused it (${refusal.status}): ${refusal.message ?? "no reason given"}`;
      const changed = Object.fromEntries(refusal.changed.map((field) => [field, edit.readBack?.[field]]));
      return { title: "Not changed", description: `${said}.${refusal.changed.length > 0 ? ` Changed before it refused: ${valuesText(name, changed, utcOffsetMinutes)}.` : ""}` };
    }
    default:
      return { title: "Not changed", description: "The Machine refused it." };
  }
}
