import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CollapsibleCard } from "@/components/collapsible-card";
import { formatTime } from "@/components/machines";
import { MadeBy } from "@/components/settings-edit-log";
import { labelOf, shownValue } from "@/components/settings-edits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type SettingsHistoryChange, type SettingsHistoryField, type SettingsHistoryPage, api } from "@/lib/api";
import { isObject, valueText } from "@/lib/settings-text";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";
import { SCHEDULE_KEY_PREFIX, type SettingsHistoryCollection, WAKE_SCHEDULE_FIELDS, isEditableSettingsCollection, sameValue } from "@decent-sync/protocol";

// A Machine's Settings History (#433): each change of what its Tablet
// reported for its settings, plugins, Skins, paired devices, scale and
// sensors, newest first, one row for each field changed, with what made it.

const PAGE_SIZE = 20;

/** Each collection a Settings History keeps, named as the Machine page names it. */
export const HISTORY_SECTIONS: Record<SettingsHistoryCollection, string> = {
  machineSettings: "Machine Settings: General",
  advancedSettings: "Machine Settings: Advanced",
  machineCalibration: "Machine Settings: Flow calibration",
  sensorCalibration: "Machine Settings: Sensor calibration",
  appSettings: "Tablet Settings",
  presenceSettings: "Tablet Settings: Presence",
  plugins: "Plugins",
  skins: "Skins",
  pairedDevices: "Paired devices",
  scaleInfo: "Scale",
  sensors: "Sensors",
};

/** The fields of collections no settings definition covers, by the name the page gives them. */
const OTHER_LABELS: Record<string, string> = {
  "scaleInfo/firmwareVersion": "Firmware",
  "skins/skins": "Installed Skins",
  "skins/default": "Default Skin",
  "skins/server": "Skin served",
};

/**
 * The Machine's Settings History, newest first, a page at a time: when each
 * change was received, its section, each field's value before and after, and
 * the Settings Edit and who made it, or none for a change made outside
 * Decent Sync. Shown closed until opened, as most who read the page do not
 * need it.
 */
export function SettingsHistoryCard({ machineId, answered }: { machineId: string; answered: number }) {
  return (
    <CollapsibleCard
      title="Settings History"
      info={
        <>
          <p>
            Each change of what the Machine's Tablet reported for its settings, plugins, Skins, paired devices, scale and sensors, newest
            first, whatever made it. A change made here or through a Connected App names its Settings Edit's maker; one made on the Tablet,
            by another app or by the Machine itself is tied to no person.
          </p>
          <p>
            A change is received about 30 to 60 seconds after it is made, later while the Machine is busy, and a sensor calibration's within
            a day. A brief change, made on the Tablet and changed back within about 2 minutes, such as the refill kit shown on automatic as
            the Machine reconnects, is shown only on asking.
          </p>
        </>
      }
    >
      <SettingsHistoryLog machineId={machineId} answered={answered} />
    </CollapsibleCard>
  );
}

/**
 * The Settings History, while its card is open. Brief changes, changed back
 * within about 2 minutes, are shown only on asking. Loaded again whenever
 * `answered` changes, as an edit made on the page is answered.
 */
function SettingsHistoryLog({ machineId, answered }: { machineId: string; answered: number }) {
  const [offset, setOffset] = useState(0);
  const [includeBrief, setIncludeBrief] = useState(false);
  const briefId = useId();
  // Each page loaded remembers where it starts and whether it holds brief changes: the last is shown while another loads.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), includeBrief: String(includeBrief) });
    return { offset, page: await api<SettingsHistoryPage>("GET", `/machines/${encodeURIComponent(machineId)}/settings-history?${query}`) };
  }, [machineId, offset, includeBrief]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  const seen = useRef(answered);
  useEffect(() => {
    if (seen.current === answered) return;
    seen.current = answered;
    void reload();
  }, [answered, reload]);

  const first = data ? data.offset + 1 : 0;
  const last = data ? data.offset + data.page.changes.length : 0;
  return (
    <CardContent className="grid gap-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={briefId}
          checked={includeBrief}
          onCheckedChange={(checked) => {
            setIncludeBrief(checked === true);
            setOffset(0);
          }}
        />
        <Label htmlFor={briefId}>Show brief changes</Label>
      </div>
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {data?.page.total === 0 && (
        <p className="text-sm text-muted-foreground">
          {includeBrief ? "No changes have been received yet." : "No changes have been received yet, but for any brief ones."}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not read the Settings History: {error}</AlertDescription>
        </Alert>
      )}
      {data && data.page.changes.length > 0 && (
        <Table aria-label="Settings History">
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Section</TableHead>
              <TableHead>Field</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Made by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.page.changes.flatMap((change) =>
              change.fields.map((field) => (
                <TableRow key={`${change.id}-${change.settingsEdit?.id ?? "outside"}-${field.field}`}>
                  <TableCell>{formatTime(change.receivedAt)}</TableCell>
                  <TableCell className="whitespace-normal">{HISTORY_SECTIONS[change.collection as SettingsHistoryCollection] ?? change.collection}</TableCell>
                  <TableCell className="whitespace-normal">{fieldLabel(change.collection, field)}</TableCell>
                  <TableCell className="min-w-48 whitespace-normal">{changeText(change.collection, field)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <Source change={change} />
                  </TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )}
      {data && data.page.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Changes {first}–{last} of {data.page.total}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
              Newer
            </Button>
            <Button variant="outline" size="sm" disabled={last >= data.page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
              Older
            </Button>
          </div>
        </div>
      )}
    </CardContent>
  );
}

/** What made a change: its Settings Edit's maker, or nobody known, outside Decent Sync. */
function Source({ change }: { change: SettingsHistoryChange }) {
  if (change.settingsEdit === null) return <span className="text-muted-foreground">Outside Decent Sync</span>;
  return (
    <>
      Settings Edit by <MadeBy account={change.settingsEdit.account} connectedApp={change.settingsEdit.connectedApp} />
    </>
  );
}

/**
 * A field's name: a setting's label; a wake schedule by its time; a plugin,
 * Skin, paired device or sensor by the name it reports, or else its id.
 */
function fieldLabel(collection: string, { field, before, after }: SettingsHistoryField): string {
  if (field.startsWith(SCHEDULE_KEY_PREFIX) && collection === "presenceSettings") {
    const time = [after, before].map((value) => (isObject(value) ? value.time : undefined)).find((value) => typeof value === "string");
    return time ? `Wake schedule at ${time}` : "Wake schedule";
  }
  // A value of another shape than Decaid's is one field, keyed "".
  if (field === "") return "Value";
  if (isEditableSettingsCollection(collection)) return labelOf(collection, field);
  const named = [after, before].map(nameOf).find((name) => name !== undefined);
  return named ?? OTHER_LABELS[`${collection}/${field}`] ?? field;
}

/** The name an entry of the plugins, paired devices or sensors reports for itself. */
function nameOf(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const name = value.name ?? (isObject(value.info) ? value.info.name : undefined);
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** The collections a Settings History keeps entry by entry, each by its id. */
const ENTRY_LISTS = new Set(["plugins", "pairedDevices", "sensors"]);

/**
 * A field's change: its value before and after, as the Settings card shows
 * it, only the parts of a wake schedule or an entry that changed; added or
 * removed; and for a brief change, when it changed back.
 */
function changeText(collection: string, field: SettingsHistoryField): string {
  const back = field.backAt === null ? "" : `, back at ${formatTime(field.backAt)}`;
  const scheduled = collection === "presenceSettings" && field.field.startsWith(SCHEDULE_KEY_PREFIX);
  // An entry added or removed is named by its field; a wake schedule's or setting's value is shown.
  const whole = (value: unknown) => (ENTRY_LISTS.has(collection) ? versionOf(value) : valueOf(collection, field.field, value, scheduled));
  if (field.change === "added" || field.change === "removed") {
    const value = whole(field.change === "added" ? field.after : field.before);
    const done = field.change === "added" ? "added" : "removed";
    return `${field.backAt === null ? done.charAt(0).toUpperCase() + done.slice(1) : `Briefly ${done}`}${value ? `: ${value}` : ""}${back}`;
  }
  const parts = isObject(field.before) && isObject(field.after) ? changedParts(field.before, field.after) : undefined;
  const shown = parts
    ? parts.map(({ path, before, after }) => `${scheduled ? labelOf(collection, path, true) : path}: ${valueOf(collection, path, before, scheduled)} to ${valueOf(collection, path, after, scheduled)}`).join("; ")
    : `${valueOf(collection, field.field, field.before)} to ${valueOf(collection, field.field, field.after)}`;
  return field.backAt === null ? shown : `Briefly ${shown}${back}`;
}

/** A plugin's version, as an entry added or removed shows it; empty for any other entry. */
function versionOf(value: unknown): string {
  return isObject(value) && typeof value.version === "string" ? `version ${value.version}` : "";
}

/** A value as the Settings card shows it: a setting, or a wake schedule's field where `scheduled`, by its definition; a whole wake schedule by its fields; anything else as it is. */
function valueOf(collection: string, path: string, value: unknown, scheduled = false): string {
  if (scheduled && isObject(value) && path.startsWith(SCHEDULE_KEY_PREFIX)) {
    return WAKE_SCHEDULE_FIELDS.filter((field) => field.path in value)
      .map((field) => `${labelOf(collection, field.path, true)}: ${shownValue(collection, field.path, value[field.path], null, true)}`)
      .join("; ");
  }
  if (scheduled || isEditableSettingsCollection(collection)) return shownValue(collection, path, value, null, scheduled);
  return valueText(value);
}

/** The parts that differ between two objects, by their paths, an object's parts within it as `part.part`, each with its value before and after. */
function changedParts(before: Record<string, unknown>, after: Record<string, unknown>, prefix = ""): { path: string; before: unknown; after: unknown }[] {
  return [...new Set([...Object.keys(after), ...Object.keys(before)])].flatMap((part) => {
    const [earlier, later] = [before[part] ?? null, after[part] ?? null];
    if (sameValue(earlier, later)) return [];
    if (isObject(earlier) && isObject(later)) return changedParts(earlier, later, `${prefix}${part}.`);
    return [{ path: `${prefix}${part}`, before: earlier, after: later }];
  });
}
