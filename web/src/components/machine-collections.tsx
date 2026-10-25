import { useState } from "react";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { formatTime } from "@/components/machines";
import { SettingsEditStatus, SettingsForm, useOfferedFields } from "@/components/settings-edits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Collection, CollectionSummary, Machine, PairedDevice, PairedDevices, SettingsEdit, WorkflowEvent } from "@/lib/api";
import { fieldText, isObject, valueText } from "@/lib/settings-text";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import {
  SETTINGS_FIELDS,
  type SettingsCollectionName,
  type SettingsField,
  type SettingsNote,
  isEditable,
  settingsField,
} from "@decent-sync/protocol";

// What a Machine's tablet reports besides its records: its paired devices,
// its settings and its library, each as last reported. Decaid's payloads are
// shown as Decaid names their parts, each only if present: another Decaid
// version may send others or fewer. The settings are shown by their
// definitions in the protocol package, which name, label and limit each field.

/** The settings collections shown, by the name the REST API gives them, each with its heading in the Settings card. */
export const SETTINGS: Record<SettingsCollectionName, string> = {
  machineSettings: "General",
  advancedSettings: "Advanced",
  machineCalibration: "Flow calibration",
  sensorCalibration: "Sensor calibration",
  appSettings: "Tablet Settings",
};

/** The collections holding a Machine's Machine Settings; its Tablet's Tablet Settings are in `appSettings`. */
const MACHINE_SETTINGS = ["machineSettings", "advancedSettings", "machineCalibration", "sensorCalibration"] as const satisfies readonly SettingsCollectionName[];

/** What each note on a field says. */
const NOTES: Record<SettingsNote, string> = {
  resetsOnReconnect: "Resets when the Machine reconnects.",
  putBackByStreamline: "Streamline puts back a value set in its settings page when that page next opens.",
  restartAfterChange: "Restart the Machine after changing it for the change to take effect.",
};

/** The library collections shown: each kind's list (`LIBRARY_KINDS`), then DYE2's keys that are none of them. */
const LIBRARY: [name: string, title: string][] = [
  ...Object.values(LIBRARY_KINDS).map(({ list }): [string, string] => [list.name, list.title]),
  ...(
    [
      ["dye2Recipes", "DYE2 recipes"],
      ["dye2Equipment", "DYE2 equipment"],
      ["dye2Baskets", "DYE2 baskets"],
    ] as [string, string][]
  ).filter(([name]) => !Object.values(LIBRARY_KINDS).some(({ list }) => list.name === name)),
];

/** The Machine's paired scale, auxiliary scale, sensors and other paired devices. */
export function PairedDevicesCard({ devices }: { devices: PairedDevices }) {
  const rows: [role: string, device: PairedDevice | null][] = [
    ["Scale", devices.scale],
    ...(devices.auxiliaryScale ? [["Auxiliary scale", devices.auxiliaryScale] as [string, PairedDevice]] : []),
    ...devices.sensors.map((sensor) => ["Sensor", sensor] as [string, PairedDevice]),
    ...devices.others.map((other) => [otherRole(other), other] as [string, PairedDevice]),
  ];
  return (
    <Card role="region" aria-label="Paired devices">
      <CardHeader>
        <CardTitleWithInfo title="Paired devices">
          {devices.receivedAt && pairedDevicesAbout(devices).map((line) => <p key={line}>{line}</p>)}
        </CardTitleWithInfo>
        {pairedDevicesState(devices) && <CardDescription>{pairedDevicesState(devices)}</CardDescription>}
      </CardHeader>
      {devices.receivedAt && (
        <CardContent>
          <Table aria-label="Paired devices">
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Firmware</TableHead>
                <TableHead>Battery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([role, device], index) => (
                <TableRow key={device ? `${role}-${device.id}` : `${role}-${index}`}>
                  <TableCell>{role}</TableCell>
                  {device ? (
                    <>
                      <TableCell>{device.vendor ? `${device.model ?? "Not reported"} (${device.vendor})` : (device.model ?? "Not reported")}</TableCell>
                      <TableCell>{device.state ? capitalized(device.state) : "Not reported"}</TableCell>
                      <TableCell>{device.firmware ?? "Not reported"}</TableCell>
                      <TableCell>{device.batteryLevel === null ? "Not reported" : `${device.batteryLevel}%`}</TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={4}>None paired</TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}

/**
 * The Machine's latest Machine Settings (its settings, advanced settings, and
 * flow and sensor calibration) and its Tablet's Tablet Settings, each field
 * as its definition names and shows it (`SETTINGS_FIELDS`), and the steam,
 * hot water and rinse settings of its current Workflow, so differences
 * between Machines can be spotted. A section the signed-in account may
 * change a field of has an Edit button (settings-edits.tsx), and
 * `onReported` loads the reports again once an edit is answered.
 */
export function SettingsCard({
  machine,
  settings,
  workflow,
  onReported,
}: {
  machine: Machine;
  settings: Record<SettingsCollectionName, Collection | null>;
  workflow: WorkflowEvent | null;
  onReported(): Promise<void> | void;
}) {
  const parts: [title: string, value: unknown][] = [
    ["Steam", workflow?.workflow.steamSettings],
    ["Hot water", workflow?.workflow.hotWaterData],
    ["Rinse", workflow?.workflow.rinseData],
  ];
  return (
    <Card role="region" aria-label="Settings">
      <CardHeader>
        <CardTitle>
          <h2>Settings</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <section aria-label="Machine Settings" className="grid gap-4">
          <h3 className="font-medium">Machine Settings</h3>
          <div className="grid gap-6 md:grid-cols-2">
            {MACHINE_SETTINGS.map((name) => (
              <SettingsSection key={name} name={name} collection={settings[name]} heading="h4" machine={machine} onReported={onReported} />
            ))}
          </div>
        </section>
        <div className="grid gap-6 md:grid-cols-2">
          <SettingsSection name="appSettings" collection={settings.appSettings} heading="h3" machine={machine} onReported={onReported} />
          <section aria-label="Steam, hot water and rinse" className="grid content-start gap-2">
            <SectionHeading
              heading="h3"
              title="Steam, hot water and rinse"
              about={workflow && `From its Workflow, as its tablet reported it at ${formatTime(workflow.observedAt)}.`}
            />
            {!workflow && <p className="text-sm text-muted-foreground">Its tablet has not reported its Workflow yet.</p>}
            {parts.map(([title, value]) => {
              const entries = settingEntries(value);
              return entries.length > 0 ? <SettingsList key={title} label={title} title={title} entries={entries} /> : null;
            })}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

/** A section's heading, with what explains it, such as when it was reported, in a tooltip. */
function SectionHeading({ heading: Heading, title, about }: { heading: "h3" | "h4"; title: string; about?: string | false | null }) {
  return (
    <div className="flex items-center gap-1.5">
      <Heading className="font-medium">{title}</Heading>
      {about && (
        <InfoTip label={`About ${title}`}>
          <p>{about}</p>
        </InfoTip>
      )}
    </div>
  );
}

/**
 * One settings collection as last reported: each field its definition
 * covers, in their order, then any other Decaid reports. Where the account
 * may change one of its fields, an Edit button opens its inline form,
 * disabled while the Machine is offline, and the section then shows its
 * latest edit, pending and then what came of it.
 */
function SettingsSection({
  name,
  collection,
  heading: Heading,
  machine,
  onReported,
}: {
  name: SettingsCollectionName;
  collection: Collection | null;
  heading: "h3" | "h4";
  machine: Machine;
  onReported(): Promise<void> | void;
}) {
  const title = SETTINGS[name];
  const offered = useOfferedFields(name, collection, machine);
  const rows = collection ? settingRows(name, collection.value) : [];
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<SettingsEdit>();
  return (
    <section aria-label={title} className="grid content-start gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* When it was reported only on asking, but a report missing or unavailable in plain sight. */}
        <SectionHeading heading={Heading} title={title} about={collection?.available && reportText(collection)} />
        {offered.length > 0 && !editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Edit ${title}`}
            disabled={!machine.online}
            onClick={() => {
              setEdit(undefined);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {offered.length > 0 && !machine.online && !editing && (
        <p className="text-sm text-muted-foreground">Settings can be changed only while the Machine is online, and its Tablet connected.</p>
      )}
      {!collection?.available && <p className="text-sm text-muted-foreground">{reportText(collection)}</p>}
      {edit && <SettingsEditStatus key={edit.id} machineId={machine.id} edit={edit} onAnswered={onReported} />}
      {editing && collection && isObject(collection.value) ? (
        <SettingsForm
          name={name}
          machine={machine}
          offered={offered}
          reported={collection.value}
          label={`Edit ${title}`}
          notes={(field) => (field.notes ?? []).map((note) => NOTES[note])}
          onCancel={() => setEditing(false)}
          onSaved={(made) => {
            setEditing(false);
            setEdit(made);
          }}
        >
          {/* The fields it does not offer keep their place, read-only. */}
          <SettingRows label={`${title}, read-only`} rows={rows.filter((row) => !offered.some((field) => field.path === row.path))} />
        </SettingsForm>
      ) : (
        collection && <SettingRows label={title} rows={rows} />
      )}
    </section>
  );
}

/** Settings fields as a list of terms and values, with what sets a read-only one and a field's notes in a tooltip. */
function SettingRows({ label, rows }: { label: string; rows: SettingRow[] }) {
  return (
    <Fields label={label}>
      {rows.map((row) => {
        const lines = [row.about, ...row.notes].filter((line) => line !== undefined);
        return (
          <Field key={row.term} term={row.term}>
            <span className="inline-flex items-center gap-1.5">
              {row.text}
              {lines.length > 0 && (
                <InfoTip label={`About ${row.term}`}>
                  {lines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </InfoTip>
              )}
            </span>
          </Field>
        );
      })}
    </Fields>
  );
}

/** The library its tablet last reported: how many of each, archived and hidden ones included. */
export function LibraryCard({ collections }: { collections: CollectionSummary[] }) {
  return (
    <Card role="region" aria-label="Library">
      <CardHeader>
        <CardTitleWithInfo title="Library">
          <p>
            As its tablet reported it, archived and hidden entries included. Its beans, bean batches, grinders, profiles, baskets and tools
            are shared with its Location's other tablets while it takes part in the Library; its DYE2 recipes are only recorded.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        <Table aria-label="Library">
          <TableHeader>
            <TableRow>
              <TableHead>Collection</TableHead>
              <TableHead>Entries</TableHead>
              <TableHead>Reported</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {LIBRARY.map(([name, title]) => {
              const reported = collections.find((collection) => collection.name === name);
              return (
                <TableRow key={name}>
                  <TableCell>{title}</TableCell>
                  <TableCell>{reported?.items ?? "None"}</TableCell>
                  {/* Under its "Reported" heading, a current report needs only its time. */}
                  <TableCell>{reported?.available ? formatTime(reported.receivedAt ?? reported.reportedAt) : reportText(reported ?? null)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SettingsList({ label, title, entries }: { label: string; title?: string; entries: [string, string][] }) {
  return (
    <div className="grid gap-1">
      {title && <h4 className="text-sm font-medium">{title}</h4>}
      <Fields label={label}>
        {entries.map(([term, value]) => (
          <Field key={term} term={term}>
            {value}
          </Field>
        ))}
      </Fields>
    </div>
  );
}

/** What explains the paired devices shown, for their tooltip: when they were reported, while current, and what is left out. */
function pairedDevicesAbout(devices: PairedDevices): string[] {
  const notes = [
    "Devices only discovered nearby are left out.",
    "A scale reports its firmware and battery level only while connected, and only if it reports them to Decaid.",
  ];
  return devices.available && devices.receivedAt ? [`As its tablet reported them at ${formatTime(devices.receivedAt)}.`, ...notes] : notes;
}

/** That the paired devices shown are missing or may be stale, said in plain sight; null while they are current. */
function pairedDevicesState(devices: PairedDevices): string | null {
  if (!devices.reportedAt) return "Its tablet has not reported its paired devices yet.";
  if (devices.available && devices.receivedAt) return null;
  const unavailable = `Not available when last read, at ${formatTime(devices.reportedAt)}`;
  return devices.receivedAt ? `${unavailable}; shown as reported at ${formatTime(devices.receivedAt)}, with their state then.` : `${unavailable}.`;
}

/** When a collection was reported, and whether its tablet could read it then. */
function reportText(collection: CollectionSummary | null): string {
  if (!collection) return "Not reported yet";
  if (collection.available) return `Reported at ${formatTime(collection.receivedAt ?? collection.reportedAt)}`;
  // Nothing to read, as while no machine or scale is connected, or a read that failed.
  const unavailable = `Not available when last read, at ${formatTime(collection.reportedAt)}`;
  return collection.receivedAt ? `${unavailable}; shown as reported at ${formatTime(collection.receivedAt)}` : unavailable;
}

/**
 * A settings object's parts, each as Decaid names it with its value written
 * out, alphabetically: the server stores them as jsonb, which does not keep
 * Decaid's order, and one order for every Machine eases comparing them.
 */
function settingEntries(value: unknown): [string, string][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, part]) => [key, settingText(part)]);
}

/** A field of a settings collection as shown: its path, its term, its value written out, what sets it if read-only, and its notes. */
interface SettingRow {
  path: string;
  term: string;
  text: string;
  about?: string;
  notes: string[];
}

/**
 * A settings collection's fields as shown. Each field a definition covers is
 * shown by its label, in the definitions' order, if reported: another Decaid
 * version may send fewer. Any other field Decaid reports is shown under its
 * own name, read-only, alphabetically, as the server stores the collection as
 * jsonb, which does not keep Decaid's order. `sensorCalibration` holds each
 * target's current read, whose `measuredValue` holds its calibration
 * (rest_v1.yml).
 */
function settingRows(name: SettingsCollectionName, value: unknown): SettingRow[] {
  if (!isObject(value)) return [];
  const reported =
    name === "sensorCalibration"
      ? Object.fromEntries(Object.entries(value).map(([target, read]) => [target, isObject(read) && "measuredValue" in read ? read.measuredValue : read]))
      : value;
  const known = SETTINGS_FIELDS[name]
    .filter((field) => field.path in reported)
    .map((field) => ({
      path: field.path,
      term: field.label,
      text: fieldText(field, reported[field.path]),
      about: isEditable(field) ? undefined : field.setBy,
      notes: (field.notes ?? []).map((note) => NOTES[note]),
    }));
  const unknown = Object.keys(reported)
    .filter((path) => !settingsField(name, path))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((path) => ({ path, term: path, text: valueText(reported[path]), about: "Not known to Decent Sync, so shown as Decaid names it, read-only", notes: [] }));
  return [...known, ...unknown];
}

function settingText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  // To three decimal places at most, as the machine keeps its flow calibration (calFlowEst, in thousandths): Decaid
  // sends 2.500000000000001 for 2.5.
  if (typeof value === "number") return String(Number(value.toFixed(3)));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (Array.isArray(value)) return value.length > 0 ? value.map(settingText).join(", ") : "None";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, part]) => `${key}: ${settingText(part)}`)
    .join(", ");
}

/** What another paired device is, by Decaid's kind. */
function otherRole(device: PairedDevice): string {
  switch (device.type) {
    case "machine":
      return "Machine";
    case "scale":
      return "Other scale";
    case "sensor":
      return "Sensor";
    case "grinder":
      return "Grinder";
    default:
      return "Device";
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
