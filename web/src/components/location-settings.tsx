import { type FormEvent, useId, useState } from "react";
import { Link } from "react-router";
import { ItemConflictsCard, ItemHistoryCard } from "@/components/conflicts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type LocationSettings } from "@/lib/api";

/** Below this steam temperature, in °C, Decaid turns steam off; turning it off is each Machine's own, so it is not shared. */
const STEAM_ON_FROM = 135;

/** Each shared setting, in Decaid's order, with how people read it, its unit, and whether Decaid keeps it as a whole number. */
const SETTINGS: { part: string; fields: [field: string, label: string, unit: string, whole: boolean][] }[] = [
  {
    part: "Steam",
    fields: [
      ["steamSettings.targetTemperature", "Steam temperature", "°C", true],
      ["steamSettings.duration", "Steam time", "s", true],
      ["steamSettings.flow", "Steam flow", "ml/s", false],
      ["steamSettings.stopAtTemperature", "Steam stop temperature", "°C", false],
    ],
  },
  {
    part: "Hot water",
    fields: [
      ["hotWaterData.targetTemperature", "Hot water temperature", "°C", true],
      ["hotWaterData.duration", "Hot water time", "s", true],
      ["hotWaterData.volume", "Hot water volume", "ml", true],
      ["hotWaterData.flow", "Hot water flow", "ml/s", false],
    ],
  },
  {
    part: "Rinse",
    fields: [
      ["rinseData.targetTemperature", "Rinse temperature", "°C", true],
      ["rinseData.duration", "Rinse time", "s", true],
      ["rinseData.flow", "Rinse flow", "ml/s", false],
    ],
  },
];

/** A setting as people read it: Decaid's doubles can carry float noise, such as 2.500000000000001, shown as 2.5. */
export function settingText(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Each shared setting's name as people read it, with its unit, such as "Steam flow (ml/s)". */
export const SETTING_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  SETTINGS.flatMap(({ fields }) => fields.map(([field, label, unit]) => [field, `${label} (${unit})`])),
);

/**
 * A Location's steam, hot water and rinse settings: their values, which an
 * account that may changes, its Machines, each of whose sharing it switches
 * on or off, and their Conflicts and history. `onSaved` follows a change.
 */
export function LocationSettingsCard({ settings, onSaved }: { settings: LocationSettings; onSaved(): Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  // Each change made here is read into the history again.
  const [saves, setSaves] = useState(0);
  const title = "Steam, hot water and rinse";

  return (
    <section aria-label={title} className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{title}</h2>
          </CardTitle>
          <CardDescription>
            Shared by this Location's Machines, whatever their model, but those switched off below, which keep their own. Set them on
            any of their tablets or here. A Machine whose steam is turned off keeps it off, and takes these steam settings once it is
            turned on again.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.id === null ? (
            <p className="text-sm text-muted-foreground">Not set yet: the first Machine here to connect sets them.</p>
          ) : editing ? (
            <SettingsForm
              settings={settings}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                setSaves((count) => count + 1);
                await onSaved();
              }}
            />
          ) : (
            <>
              <SettingsTable settings={settings} />
              {settings.editable && (
                <div>
                  <Button variant="outline" aria-label="Change the steam, hot water and rinse settings" onClick={() => setEditing(true)}>
                    Change
                  </Button>
                </div>
              )}
            </>
          )}
          {settings.machines.length > 0 ? (
            <SharingMachines settings={settings} onChanged={onSaved} />
          ) : (
            <p className="text-sm text-muted-foreground">No Machines here yet.</p>
          )}
        </CardContent>
      </Card>
      {settings.id !== null && (
        <>
          <ItemConflictsCard
            kind="settings"
            id={settings.id}
            onResolved={() => {
              setSaves((count) => count + 1);
              void onSaved();
            }}
          />
          <ItemHistoryCard key={saves} kind="settings" id={settings.id} />
        </>
      )}
    </section>
  );
}

/**
 * The Location's Machines, each with a switch for whether it
 * shares the settings: switched off, its tablet keeps its own and none of
 * its changes are shared; switched on again, it takes these.
 */
function SharingMachines({ settings, onChanged }: { settings: LocationSettings; onChanged(): Promise<void> | void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function setSharing(machineId: string, sharesSettings: boolean) {
    setBusy(machineId);
    setError(undefined);
    try {
      await api("PUT", `/machines/${machineId}/settings-sharing`, { sharesSettings });
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Its sharing could not be switched");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="grid gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Table aria-label="Machines sharing these settings">
        <TableHeader>
          <TableRow>
            <TableHead>Machine</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Shares these settings</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {settings.machines.map((machine) => (
            <TableRow key={machine.id}>
              <TableCell>
                <Link to={`/machines/${machine.id}`} className="underline-offset-4 hover:underline">
                  {machine.name}
                </Link>
              </TableCell>
              <TableCell>{machine.model ?? <span className="text-muted-foreground">Not reported yet</span>}</TableCell>
              <TableCell>
                <Switch
                  aria-label={`${machine.name} shares these settings`}
                  checked={machine.sharesSettings}
                  disabled={!settings.editable || busy !== undefined}
                  onCheckedChange={(checked) => void setSharing(machine.id, checked)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SettingsTable({ settings }: { settings: LocationSettings }) {
  return (
    <Table aria-label="Steam, hot water and rinse settings">
      <TableHeader>
        <TableRow>
          <TableHead>Setting</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {SETTINGS.flatMap(({ fields }) =>
          fields.map(([field, label, unit]) => {
            const value = settings.values[field];
            return (
              <TableRow key={field}>
                <TableCell>{label}</TableCell>
                <TableCell>{value === null || value === undefined ? <span className="text-muted-foreground">Not set</span> : `${settingText(value)} ${unit}`}</TableCell>
              </TableRow>
            );
          }),
        )}
      </TableBody>
    </Table>
  );
}

/** Changes the settings: only those changed are sent, each an edit made here, written to the Location's Machines that share them. */
function SettingsForm({ settings, onCancel, onSaved }: { settings: LocationSettings; onCancel(): void; onSaved(): Promise<void> }) {
  const id = useId();
  const [initial] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(settings.values).map(([field, value]) => [field, value === null ? "" : settingText(value)])),
  );
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changed = Object.fromEntries(
      Object.entries(values).flatMap(([field, text]) => (text !== "" && text !== initial[field] ? [[field, Number(text)]] : [])),
    );
    if (Object.keys(changed).length === 0) return onCancel();
    setSaving(true);
    setError(undefined);
    try {
      await api("PATCH", `/location-settings/${settings.id}`, { values: changed });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The settings could not be changed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Change the steam, hot water and rinse settings" className="grid gap-6" onSubmit={save}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {SETTINGS.map(({ part, fields }) => (
        <fieldset key={part} className="grid gap-3">
          <legend className="mb-2 text-sm font-medium">{part}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map(([field, label, unit, whole]) => (
              <div key={field} className="grid gap-2">
                <Label htmlFor={`${id}-${field}`}>
                  {label} ({unit})
                </Label>
                <Input
                  id={`${id}-${field}`}
                  type="number"
                  inputMode={whole ? "numeric" : "decimal"}
                  min={field === "steamSettings.targetTemperature" ? STEAM_ON_FROM : 0}
                  step={whole ? 1 : "any"}
                  value={values[field] ?? ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))}
                />
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
