import { Field, Fields } from "@/components/fields";
import { formatTime } from "@/components/machines";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Collection, CollectionSummary, PairedDevice, PairedDevices, WorkflowEvent } from "@/lib/api";

// What a Machine's tablet reports besides its records: its paired devices,
// its settings and its library, each as last reported. Decaid's payloads are
// shown as Decaid names their parts, each only if present: another Decaid
// version may send others or fewer.

/** The settings collections shown, by the name the REST API gives them. */
export const SETTINGS = { appSettings: "App settings", machineSettings: "Machine settings", advancedSettings: "Advanced settings" } as const;

const LIBRARY: [name: string, title: string][] = [
  ["beans", "Beans"],
  ["beanBatches", "Bean Batches"],
  ["grinders", "Grinders"],
  ["profiles", "Profiles"],
  ["dye2Recipes", "DYE2 recipes"],
  ["dye2Equipment", "DYE2 equipment"],
  ["dye2Baskets", "DYE2 baskets"],
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
        <CardDescription>
          {devices.reportedAt
            ? `As its tablet reported them at ${formatTime(devices.reportedAt)}. Devices only discovered nearby are left out. A scale reports its firmware and battery level only while connected, and only if it reports them to Decaid.`
            : "Its tablet has not reported its paired devices yet."}
        </CardDescription>
      </CardHeader>
      {devices.reportedAt && (
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
 * The Machine's latest app, machine and advanced settings, and the steam,
 * hot water and rinse settings of its current Workflow, so calibration
 * differences between Machines can be spotted.
 */
export function SettingsCard({
  settings,
  workflow,
}: {
  settings: Record<keyof typeof SETTINGS, Collection | null>;
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
        <CardDescription>As its tablet reported them, named as Decaid names them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <section aria-label="Steam, hot water and rinse" className="grid content-start gap-2">
          <h3 className="font-medium">Steam, hot water and rinse</h3>
          <p className="text-sm text-muted-foreground">
            {workflow ? `From its Workflow, as its tablet reported it at ${formatTime(workflow.observedAt)}.` : "Its tablet has not reported its Workflow yet."}
          </p>
          {parts.map(([title, value]) => {
            const entries = settingEntries(value);
            return entries.length > 0 ? <SettingsList key={title} label={title} title={title} entries={entries} /> : null;
          })}
        </section>
        {(Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]).map((name) => (
          <section key={name} aria-label={SETTINGS[name]} className="grid content-start gap-2">
            <h3 className="font-medium">{SETTINGS[name]}</h3>
            <p className="text-sm text-muted-foreground">{reportText(settings[name])}</p>
            {settings[name] && <SettingsList label={SETTINGS[name]} entries={settingEntries(settings[name].value)} />}
          </section>
        ))}
      </CardContent>
    </Card>
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
        <CardDescription>As its tablet reported it, archived and hidden entries included. Nothing is sent back to the tablet.</CardDescription>
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

function settingText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  // To two decimal places at most: Decaid sends 2.500000000000001 for 2.5.
  if (typeof value === "number") return String(Number(value.toFixed(2)));
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
    default:
      return "Device";
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
