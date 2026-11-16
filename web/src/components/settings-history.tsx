import { useCallback, useId, useState } from "react";
import { CollapsibleCard } from "@/components/collapsible-card";
import { InfoTip } from "@/components/info-tip";
import { formatTime } from "@/components/machines";
import { OrNone } from "@/components/records";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { MadeBy, labelOf, outcomeText, shownValue } from "@/components/settings-edits";
import { ScrollsSideways } from "@/components/scrolls-sideways";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type SettingsEdit, type SettingsHistoryEntry, type SettingsHistoryEntryPage, type SettingsHistoryField, api } from "@/lib/api";
import { isObject, valueText } from "@/lib/settings-text";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { SCHEDULE_KEY_PREFIX, type SettingsHistoryCollection, WAKE_SCHEDULE_FIELDS, isEditableSettingsCollection, sameValue } from "@decent-sync/protocol";

// A Machine's Settings History (#433, #545): each change of what its Tablet
// reported for its settings, plugins, Skins, paired devices, scale and
// sensors, newest first, one row for each field changed, with what made it,
// and each Settings Edit that changed nothing, with what came of it.

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
 * The Machine's Settings History, newest first, a page at a time (#545): each
 * change its Tablet reported, a row for each field changed, with who made it
 * where a Settings Edit did, and each Settings Edit that changed nothing,
 * being pending, refused, not confirmed or put back by the Machine, each
 * with what came of it. Shown closed until opened, as most who read the page
 * do not need it.
 */
export function SettingsHistoryCard({ machineId, answered }: { machineId: string; answered: number }) {
  return (
    <CollapsibleCard
      title="Settings History"
      info={
        <>
          <p>
            Each change of what the Machine's Tablet reported for its settings, plugins, Skins, paired devices, scale and sensors, newest
            first, whatever made it. A change made here or through a Connected App, such as an assistant, names who made it and what came of
            it; one made on the Tablet, by another app or by the Machine itself is tied to no person.
          </p>
          <p>
            A Settings Edit that changed nothing is listed too, at the time it was made, with what it asked for and what came of it: one still
            pending, refused or not confirmed, or one whose value the Machine put back. Settings Edits lists only what was made through one.
            A change a Settings Edit made is listed when it was received, and says when its edit was made beside who made it.
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

/** What the list holds: every change, or only what was made through a Settings Edit. */
type Which = "all" | "edits";

/**
 * The Settings History, while its card is open. Brief changes, changed back
 * within about 2 minutes, are shown only on asking. Loaded again whenever
 * `answered` changes, as an edit made on the page is answered.
 */
function SettingsHistoryLog({ machineId, answered }: { machineId: string; answered: number }) {
  const [offset, setOffset] = useState(0);
  const [which, setWhich] = useState<Which>("all");
  const [includeBrief, setIncludeBrief] = useState(false);
  const briefId = useId();
  // Each page loaded remembers where it starts and what it was narrowed to.
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), includeBrief: String(includeBrief), editsOnly: String(which === "edits") });
    return { offset, which, includeBrief, page: await api<SettingsHistoryEntryPage>("GET", `/machines/${encodeURIComponent(machineId)}/settings-history/with-edits?${query}`) };
  }, [machineId, offset, includeBrief, which]);
  const polled = usePolled(load, DETAILS_POLL_MS);
  const { error, reload } = polled;
  // The last page read is still shown while another loads, but never under a choice it was not read for: changes made
  // outside Decent Sync don't stand under "Settings Edits" while that list is on its way, or if it can't be read.
  const data = polled.data?.which === which && polled.data.includeBrief === includeBrief ? polled.data : undefined;
  useReloadOn(answered, reload);

  const first = data ? data.offset + 1 : 0;
  const last = data ? data.offset + data.page.entries.length : 0;
  return (
    <CardContent className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          label="Which changes"
          value={which}
          onValueChange={(chosen) => {
            // Pressing the one chosen leaves it chosen.
            if (chosen !== "all" && chosen !== "edits") return;
            setWhich(chosen);
            setOffset(0);
          }}
        >
          <SegmentedItem value="all">All changes</SegmentedItem>
          <SegmentedItem value="edits">Settings Edits</SegmentedItem>
        </Segmented>
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
      </div>
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {data?.page.total === 0 && <p className="text-sm text-muted-foreground">{nothingText(data.which, includeBrief)}</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not read the Settings History: {error}</AlertDescription>
        </Alert>
      )}
      {data && data.page.entries.length > 0 && <ScrollsSideways />}
      {data && data.page.entries.length > 0 && (
        <Table aria-label="Settings History">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Section</TableHead>
              <TableHead>Field</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Made by</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.page.entries.flatMap((entry) =>
              entryRows(entry).map((row) => (
                <TableRow key={`${entry.change?.id ?? "edit"}-${entry.settingsEdit?.id ?? "outside"}-${row.key}`}>
                  <TableCell className="align-top">{formatTime(entry.at)}</TableCell>
                  <TableCell className="align-top whitespace-normal">{HISTORY_SECTIONS[entry.collection as SettingsHistoryCollection] ?? entry.collection}</TableCell>
                  <TableCell className="align-top whitespace-normal">{row.field}</TableCell>
                  <TableCell className="min-w-48 align-top whitespace-normal">{row.change}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    {entry.settingsEdit ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span>
                          <MadeBy account={entry.settingsEdit.account} connectedApp={entry.settingsEdit.connectedApp ?? null} />
                        </span>
                        {/* A change is listed at the time it was received: its edit was made a moment before, or longer where its answer came late. */}
                        {entry.change && (
                          <InfoTip label="About this Settings Edit">
                            <p>Made {formatTime(entry.settingsEdit.madeAt)}.</p>
                          </InfoTip>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Outside Decent Sync</span>
                    )}
                  </TableCell>
                  <TableCell className="min-w-40 align-top whitespace-normal">{entry.settingsEdit ? <Outcome edit={entry.settingsEdit} /> : <OrNone>{undefined}</OrNone>}</TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )}
      {data && data.page.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {first}–{last} of {data.page.total}
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

/** What the list says when it holds nothing. */
function nothingText(which: Which, includeBrief: boolean): string {
  if (which === "edits") return "None of its settings have been changed here.";
  return includeBrief ? "No changes have been received yet." : "No changes have been received yet, but for any brief ones.";
}

/**
 * An entry's rows, each a field and what became of it: a change's fields as
 * its Tablet reported them, before and after, and what its Settings Edit
 * asked for wherever that is something else, so nothing an edit asked is
 * left unsaid: beside a field the Machine stored otherwise, and as a row of
 * its own for a field, or a wake schedule, the edit set that did not change
 * as asked. A Settings Edit that changed nothing is those rows alone: a row
 * for each field it set, or one for the wake schedule it would have added,
 * changed or deleted.
 */
function entryRows({ collection, change, settingsEdit }: SettingsHistoryEntry): { key: string; field: string; change: string }[] {
  const changed = change?.fields ?? [];
  if (!settingsEdit) return changed.map((field) => ({ key: field.field, field: fieldLabel(collection, field), change: changeText(collection, field) }));
  const { fields, expected, schedule } = settingsEdit;
  if (schedule) {
    // A wake schedule's fields in their order, as the server stores an edit's fields as jsonb, which does not keep it:
    // each as asked, a change's from its value in the schedule as reported.
    const shown = (path: string, value: unknown) => shownValue(collection, path, value, null, true);
    const parts = WAKE_SCHEDULE_FIELDS.map((field) => field.path)
      .filter((path) => path in fields)
      .map((path) => `${labelOf(collection, path, true)}: ${schedule.action === "change" ? `${shown(path, expected[path])} to ` : ""}${shown(path, fields[path])}`);
    const time = typeof expected.time === "string" ? expected.time : undefined;
    const asked = schedule.action === "delete" ? "Asked to delete it" : `Asked to ${schedule.action === "add" ? "add it" : "change it"}: ${parts.join("; ")}`;
    return [
      ...changed.map((field) => ({ key: field.field, field: fieldLabel(collection, field), change: changeText(collection, field) })),
      // An applied edit's change is what it asked.
      ...(changed.length > 0 && settingsEdit.outcome === "applied" ? [] : [{ key: "asked", field: time ? `Wake schedule at ${time}` : "Wake schedule", change: asked }]),
    ];
  }
  const asked = (path: string) => shownValue(collection, path, fields[path]);
  return [
    ...changed.map((field) => {
      const otherwise = field.field in fields && asked(field.field) !== shownValue(collection, field.field, field.after);
      return { key: field.field, field: fieldLabel(collection, field), change: `${changeText(collection, field)}${otherwise ? ` (asked for ${asked(field.field)})` : ""}` };
    }),
    ...Object.keys(fields)
      .filter((path) => !changed.some((field) => field.field === path))
      .map((path) => ({ key: `asked ${path}`, field: labelOf(collection, path), change: `Asked for ${asked(path)}, from ${shownValue(collection, path, expected[path])}` })),
  ];
}

/** What came of the edit that made a change, or that changed nothing: pending, not confirmed, or its answer, marked if it came late. */
function Outcome({ edit }: { edit: SettingsEdit }) {
  if (edit.outcome === null) return <>Pending</>;
  if (edit.outcome === "notConfirmed") return <>Not confirmed</>;
  const { title, description } = outcomeText(edit);
  return (
    <div className="grid gap-0.5">
      <span>{edit.late ? `${title}, answered late` : title}</span>
      {/* An applied edit's values are those of its change. */}
      {edit.outcome !== "applied" && <span className="text-xs text-muted-foreground">{description}</span>}
    </div>
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
