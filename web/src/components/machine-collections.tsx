import { Field, Fields } from "@/components/fields";
import { InfoTip } from "@/components/info-tip";
import { formatTime } from "@/components/machines";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Collection, CollectionSummary, PairedDevice, PairedDevices, WorkflowEvent } from "@/lib/api";
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
        <CardTitle>
          <h2>Paired devices</h2>
        </CardTitle>
        <CardDescription>{pairedDevicesText(devices)}</CardDescription>
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
 * between Machines can be spotted.
 */
export function SettingsCard({
  settings,
  workflow,
}: {
  settings: Record<SettingsCollectionName, Collection | null>;
  workflow: WorkflowEvent | null;
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
              <SettingsSection key={name} name={name} collection={settings[name]} heading="h4" />
            ))}
          </div>
        </section>
        <div className="grid gap-6 md:grid-cols-2">
          <SettingsSection name="appSettings" collection={settings.appSettings} heading="h3" />
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

/** One settings collection as last reported: each field its definition covers, in their order, then any other Decaid reports. */
function SettingsSection({ name, collection, heading: Heading }: { name: SettingsCollectionName; collection: Collection | null; heading: "h3" | "h4" }) {
  const title = SETTINGS[name];
  return (
    <section aria-label={title} className="grid content-start gap-2">
      {/* When it was reported only on asking, but a report missing or unavailable in plain sight. */}
      <SectionHeading heading={Heading} title={title} about={collection?.available && reportText(collection)} />
      {!collection?.available && <p className="text-sm text-muted-foreground">{reportText(collection)}</p>}
      {collection && (
        <Fields label={title}>
          {settingRows(name, collection.value).map((row) => {
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
      )}
    </section>
  );
}

/** The library its tablet last reported: how many of each, archived and hidden ones included. */
export function LibraryCard({ collections }: { collections: CollectionSummary[] }) {
  return (
    <Card role="region" aria-label="Library">
      <CardHeader>
        <CardTitle>
          <h2>Library</h2>
        </CardTitle>
        <CardDescription>
          As its tablet reported it, archived and hidden entries included. Its beans, bean batches, grinders, profiles, baskets and tools are
          shared with its Location's other tablets while it takes part in the Library; its DYE2 recipes are only recorded.
        </CardDescription>
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
                  <TableCell>{reportText(reported ?? null)}</TableCell>
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

/** When the paired devices shown were reported, and whether they are still current. */
function pairedDevicesText(devices: PairedDevices): string {
  if (!devices.reportedAt) return "Its tablet has not reported its paired devices yet.";
  const note =
    "Devices only discovered nearby are left out. A scale reports its firmware and battery level only while connected, and only if it reports them to Decaid.";
  if (devices.available && devices.receivedAt) return `As its tablet reported them at ${formatTime(devices.receivedAt)}. ${note}`;
  const unavailable = `Not available when last read, at ${formatTime(devices.reportedAt)}`;
  return devices.receivedAt ? `${unavailable}; shown as reported at ${formatTime(devices.receivedAt)}, with their state then. ${note}` : `${unavailable}.`;
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

/** A field of a settings collection as shown: its term, its value written out, what sets it if read-only, and its notes. */
interface SettingRow {
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
      term: field.label,
      text: fieldText(field, reported[field.path]),
      about: isEditable(field) ? undefined : field.setBy,
      notes: (field.notes ?? []).map((note) => NOTES[note]),
    }));
  const unknown = Object.keys(reported)
    .filter((path) => !settingsField(name, path))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((path) => ({ term: path, text: settingText(reported[path]), about: "Not known to Decent Sync, so shown as Decaid names it, read-only", notes: [] }));
  return [...known, ...unknown];
}

/**
 * A field's value as its definition shows it: a choice by its label, on or
 * off, a time of day as hours and minutes, and a number with its unit. A
 * value that is none of these, such as a choice not offered, is shown as it
 * is. A number is shown to five decimal places at most: the machine keeps
 * each sensor's calibration in signed Q16.16, steps of 1/65536, so any two it
 * can hold still differ when shown, and Decaid sends 2.500000000000001 for a
 * flow multiplier of 2.5.
 */
function fieldText(field: SettingsField, value: unknown): string {
  if (field.kind === "choice" && "choices" in field) {
    const choice = field.choices?.find((offered) => offered.value === value);
    if (choice) return choice.label;
  }
  if (field.kind === "onOff" && typeof value === "boolean") return value ? "On" : "Off";
  if (field.kind === "timeOfDay" && typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 24 * 60) {
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    const number = String(Number(value.toFixed(5)));
    return field.unit ? `${number} ${field.unit}` : number;
  }
  return settingText(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
