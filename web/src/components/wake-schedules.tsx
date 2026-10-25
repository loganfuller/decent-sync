import { PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useIsAdmin } from "@/auth";
import { InfoTip } from "@/components/info-tip";
import { FormError, failure } from "@/components/library-forms";
import { TabletTimeWarning, editBlocked } from "@/components/settings-edits";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type Machine, type SettingsEdit, api } from "@/lib/api";
import { WEEKDAYS, daysText, isObject, valueText } from "@/lib/settings-text";
import { inTabletTime, timeOfDayMinutes, timeOfDayText, utcOffsetText } from "@/lib/tablet-time";
import { FIRMWARE_MAX_WAKE_WINDOWS, firmwareWakeWindows } from "@/lib/wake-windows";
import { type WakeScheduleEdit, sameValue, settingsRefusalText, validateSettingsEdit } from "@decent-sync/protocol";

// The wake schedules of a Tablet's presence settings, each added, changed or
// deleted on its own by a Settings Edit (ADR-0023, #220). Each edit is made
// over the schedule as reported: a change or a delete expects it whole, so
// one changed or deleted on the Tablet meanwhile is refused as changed since.

type Schedule = Record<string, unknown>;

/** What the schedule form is open for: a new schedule, or a change of one as reported. */
type Editing = { action: "add" } | { action: "change"; schedule: Schedule };

/**
 * Decaid's wake schedules as reported (`WakeSchedule.toJson`), in its order:
 * each one's time in the Tablet's own time, labelled with its UTC offset, its
 * days, whether it is on, and how long it keeps the Machine awake. Where
 * `mayEdit`, each has Edit and Delete, and an Add button follows, disabled
 * while the Machine's settings can't be edited (`editBlocked`); `onSaved`
 * takes each edit made, which the section then shows.
 */
export function WakeSchedules({
  label,
  heading: Heading,
  machine,
  presence,
  utcOffsetMinutes,
  mayEdit,
  onSaved,
}: {
  label: string;
  heading: "h4" | "h5";
  machine: Machine;
  /** The presence settings as last reported. */
  presence: Record<string, unknown>;
  utcOffsetMinutes: number | null;
  mayEdit: boolean;
  onSaved(edit: SettingsEdit): void;
}) {
  const schedules = Array.isArray(presence.schedules) ? presence.schedules.map((schedule: unknown) => (isObject(schedule) ? schedule : {})) : [];
  const [editing, setEditing] = useState<Editing>();
  const [deleting, setDeleting] = useState<Schedule>();
  const [error, setError] = useState<string | string[]>();
  const [saving, setSaving] = useState(false);
  const blocked = editBlocked(machine) !== null;
  const timeText = (schedule: Schedule) => {
    const time = timeOfDayText(timeOfDayMinutes(schedule.time));
    return time === undefined ? valueText(schedule.time) : inTabletTime(time, utcOffsetMinutes);
  };

  async function remove(schedule: Schedule) {
    setDeleting(undefined);
    setError(undefined);
    setSaving(true);
    try {
      const made = await make(machine, { action: "delete", id: String(schedule.id) }, {}, schedule);
      setEditing(undefined);
      onSaved(made);
    } catch (caught) {
      setError(failure(caught, "The wake schedule could not be deleted"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading className="text-sm font-medium">{label}</Heading>
        {mayEdit && !editing && (
          <Button type="button" variant="outline" size="sm" disabled={blocked || saving} onClick={() => setEditing({ action: "add" })}>
            Add
          </Button>
        )}
      </div>
      {error && <FormError error={Array.isArray(error) ? error.join(". ") : error} />}
      {schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <Table aria-label={label}>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Days</TableHead>
              <TableHead>On</TableHead>
              <TableHead>Keeps awake for</TableHead>
              {mayEdit && (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((schedule, index) => (
              <TableRow key={typeof schedule.id === "string" ? schedule.id : index}>
                <TableCell>{timeText(schedule)}</TableCell>
                <TableCell>{daysText(schedule.daysOfWeek)}</TableCell>
                <TableCell>{valueText(schedule.enabled)}</TableCell>
                <TableCell>{typeof schedule.keepAwakeFor === "number" ? `${valueText(schedule.keepAwakeFor)} min` : valueText(schedule.keepAwakeFor)}</TableCell>
                {mayEdit && (
                  <TableCell>
                    {/* A schedule without an id can't be named in an edit. */}
                    {/* Icons only, as a sensor target's Edit button, so the row fits the section's narrow column. */}
                    {typeof schedule.id === "string" && (
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Edit the wake schedule at ${timeText(schedule)}`}
                          disabled={blocked || saving || editing !== undefined}
                          onClick={() => setEditing({ action: "change", schedule })}
                        >
                          <PencilIcon aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={`Delete the wake schedule at ${timeText(schedule)}`}
                          disabled={blocked || saving || editing !== undefined}
                          onClick={() => setDeleting(schedule)}
                        >
                          <Trash2Icon aria-hidden />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && (
        <WakeScheduleForm
          // A form opened over another schedule starts afresh.
          key={editing.action === "add" ? "add" : String(editing.schedule.id)}
          machine={machine}
          presence={presence}
          schedules={schedules}
          editing={editing}
          utcOffsetMinutes={utcOffsetMinutes}
          onCancel={() => setEditing(undefined)}
          onSaved={(made) => {
            setEditing(undefined);
            onSaved(made);
          }}
        />
      )}
      <AlertDialog open={deleting !== undefined} onOpenChange={(open) => !open && setDeleting(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the wake schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && `The wake schedule at ${timeText(deleting)}, ${daysText(deleting.daysOfWeek)}, is deleted from the Tablet.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && void remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Makes an edit of a wake schedule, answered with its outcome pending. */
async function make(machine: Machine, schedule: WakeScheduleEdit, fields: Record<string, unknown>, expected: Record<string, unknown>): Promise<SettingsEdit> {
  const { settingsEdit } = await api<{ settingsEdit: SettingsEdit }>("POST", `/machines/${encodeURIComponent(machine.id)}/settings-edits`, {
    collection: "presenceSettings",
    schedule,
    fields,
    expected,
  });
  return settingsEdit;
}

/** What the schedule form holds: its time as HH:MM, the days chosen, whether it is on, and its keep-awake time as typed, empty for none. */
interface ScheduleInputs {
  time: string;
  days: number[];
  enabled: boolean;
  keepAwakeFor: string;
}

function inputsOf(schedule: Schedule | undefined): ScheduleInputs {
  if (!schedule) return { time: "", days: [], enabled: true, keepAwakeFor: "" };
  return {
    time: timeOfDayText(timeOfDayMinutes(schedule.time)) ?? "",
    days: Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek.filter((day): day is number => typeof day === "number") : [],
    enabled: schedule.enabled === true,
    keepAwakeFor: typeof schedule.keepAwakeFor === "number" ? String(schedule.keepAwakeFor) : "",
  };
}

/** The schedule's fields as the form's inputs give them (WAKE_SCHEDULE_FIELDS): the days in order, and a keep-awake time of null for none, NaN for one that isn't a number. */
function fieldsOf(inputs: ScheduleInputs): Record<string, unknown> {
  const keepAwake = inputs.keepAwakeFor.trim();
  return {
    // A time input may give whole minutes with their zero seconds, as 23:30:00.
    time: inputs.time.replace(/^(\d\d:\d\d):00(\.0+)?$/, "$1"),
    daysOfWeek: [...inputs.days].sort((a, b) => a - b),
    enabled: inputs.enabled,
    keepAwakeFor: keepAwake === "" ? null : Number(keepAwake),
  };
}

/**
 * The form adding a wake schedule, or changing one: its time in the
 * Tablet's own time, labelled with the Tablet's UTC offset, with the time
 * zone warning; its days, none for every day; whether it is on; and how long
 * it keeps the Machine awake, none or 1 to 720 min. An add sends every
 * field, expecting nothing; a change sends the fields changed, expecting the
 * whole schedule as reported. On a Bengle, it warns where the schedules as
 * they would be make more wake windows than its firmware takes.
 */
function WakeScheduleForm({
  machine,
  presence,
  schedules,
  editing,
  utcOffsetMinutes,
  onCancel,
  onSaved,
}: {
  machine: Machine;
  presence: Record<string, unknown>;
  schedules: Schedule[];
  editing: Editing;
  utcOffsetMinutes: number | null;
  onCancel(): void;
  onSaved(edit: SettingsEdit): void;
}) {
  const id = useId();
  const isAdmin = useIsAdmin();
  const reported = editing.action === "change" ? editing.schedule : undefined;
  const [inputs, setInputs] = useState(() => inputsOf(reported));
  const [error, setError] = useState<string | string[]>();
  const [saving, setSaving] = useState(false);
  const offset = utcOffsetMinutes === null ? "" : ` (${utcOffsetText(utcOffsetMinutes)})`;
  const values = fieldsOf(inputs);
  // The schedules as the edit would leave them, matched by id, as the page may load a newer report while the form is open.
  const after = reported ? schedules.map((schedule) => (schedule.id === reported.id ? { ...schedule, ...values } : schedule)) : [...schedules, values];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const schedule: WakeScheduleEdit = reported ? { action: "change", id: String(reported.id) } : { action: "add" };
    // A change sends only the fields changed; a keep-awake time Decaid leaves out is none.
    const fields = reported ? Object.fromEntries(Object.entries(values).filter(([path, value]) => !sameValue(value, reported[path]))) : values;
    if (Object.keys(fields).length === 0) return onCancel();
    const refusals = validateSettingsEdit({ collection: "presenceSettings", schedule, fields }, isAdmin ? "admin" : "staff");
    if (refusals.length > 0) return setError(refusals.map((refusal) => settingsRefusalText("presenceSettings", refusal)));
    setSaving(true);
    try {
      onSaved(await make(machine, schedule, fields, reported ?? {}));
    } catch (caught) {
      setError(failure(caught, reported ? "The wake schedule could not be changed" : "The wake schedule could not be added"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label={reported ? "Edit the wake schedule" : "Add a wake schedule"} className="grid gap-4" noValidate onSubmit={save}>
      {error && <FormError error={Array.isArray(error) ? error.join(". ") : error} />}
      <TabletTimeWarning machine={machine} utcOffsetMinutes={utcOffsetMinutes} />
      <WakeWindowWarning machine={machine} schedules={after} presenceOn={presence.userPresenceEnabled === true} />
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`${id}-time`}>Time{offset}</FieldLabel>
          <Input id={`${id}-time`} type="time" step={60} required value={inputs.time} onChange={(event) => setInputs((current) => ({ ...current, time: event.target.value }))} />
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Days</FieldLegend>
          <FieldDescription>None chosen is every day.</FieldDescription>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {WEEKDAYS.map((name, index) => {
              const day = index + 1;
              return (
                <Field key={name} orientation="horizontal" className="w-auto">
                  <Checkbox
                    id={`${id}-day-${day}`}
                    checked={inputs.days.includes(day)}
                    onCheckedChange={(checked) =>
                      setInputs((current) => ({ ...current, days: checked === true ? [...current.days.filter((chosen) => chosen !== day), day] : current.days.filter((chosen) => chosen !== day) }))
                    }
                  />
                  <FieldLabel htmlFor={`${id}-day-${day}`}>{name}</FieldLabel>
                </Field>
              );
            })}
          </div>
        </FieldSet>
        <Field orientation="horizontal">
          <Switch id={`${id}-enabled`} checked={inputs.enabled} onCheckedChange={(enabled) => setInputs((current) => ({ ...current, enabled }))} />
          <FieldLabel htmlFor={`${id}-enabled`}>On</FieldLabel>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-keep-awake`}>Keeps awake for (min)</FieldLabel>
          <Input
            id={`${id}-keep-awake`}
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            step={1}
            placeholder="None"
            value={inputs.keepAwakeFor}
            onChange={(event) => setInputs((current) => ({ ...current, keepAwakeFor: event.target.value }))}
          />
          <FieldDescription>1 to 720 min, or empty for none.</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving || editBlocked(machine) !== null}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * On a Bengle while presence is on, a warning where the wake schedules make
 * more wake windows than its firmware takes (`firmwareWakeWindows`), as
 * Decaid then drops the rest. Nothing on another Machine, or with presence
 * off.
 */
export function WakeWindowWarning({ machine, schedules, presenceOn }: { machine: Machine; schedules: unknown; presenceOn: boolean }) {
  const windows = firmwareWakeWindows(schedules);
  if (machine.model !== "Bengle" || !presenceOn || windows <= FIRMWARE_MAX_WAKE_WINDOWS) return null;
  return (
    <Alert>
      <AlertTitle className="flex items-center gap-1.5">
        More wake windows than a Bengle takes
        <InfoTip label="About wake windows">
          On a Bengle, Decaid writes the wake schedules that are on into the Machine as wake windows: one for each day a schedule runs, and
          another where it keeps the Machine awake past midnight. A schedule with no keep-awake time counts as 240 min, so one starting after
          20:00 takes two windows a day.
        </InfoTip>
      </AlertTitle>
      <AlertDescription>
        These wake schedules make {windows} wake windows, and the Machine takes at most {FIRMWARE_MAX_WAKE_WINDOWS}: Decaid leaves out the rest.
      </AlertDescription>
    </Alert>
  );
}
