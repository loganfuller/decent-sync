import { type ReactNode, useCallback } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CollapsibleCard } from "@/components/collapsible-card";
import { CardTitleWithInfo } from "@/components/info-tip";
import { formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type EditSource, type ItemHistory as History, type ItemKind, type ItemVersion, type Location, type LostEdit } from "@/lib/api";
import { moveText } from "@/lib/batch-moves";
import { recordedDayWithYear } from "@/lib/batch-name";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/** What an item's kind is called: a Library kind's name (`LIBRARY_KINDS`). */
function kindName(kind: ItemKind): string {
  return LIBRARY_KINDS[kind].name;
}

/** The address of an item's page. */
export function itemPath(kind: ItemKind, id: string): string {
  return `${LIBRARY_KINDS[kind].pages}/${encodeURIComponent(id)}`;
}

/** A link to an item's page, or its name alone where it has none. */
export function ItemLink({ path, className, children }: { path: string | null; className?: string; children: ReactNode }) {
  if (path === null) return <span className={className}>{children}</span>;
  return (
    <Link to={path} className={`${className ?? ""} underline-offset-4 hover:underline`}>
      {children}
    </Link>
  );
}

/** The REST API's address of an item. */
function itemApiPath(kind: ItemKind, id: string): string {
  return `${LIBRARY_KINDS[kind].api}/${encodeURIComponent(id)}`;
}

/**
 * Content fields whose names do not spell out as people read them: a
 * Basket's diameter, a Tool's attributes, which DYE2 keeps as `custom`, a
 * Grinder's range and defaults, as its form labels them, and
 * a Recipe's items, named by their ids, its dial and hot water, and
 * whether it was shown on the strip, which only its versions made by 1.6.0
 * and earlier hold; and a Recipe's Reference Shot, which is not its content.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  batchCode: "Batch Code",
  diameterMm: "Diameter (mm)",
  custom: "Attributes",
  settingMin: "Lowest setting",
  settingMax: "Highest setting",
  settingDefault: "Default setting",
  rpmMin: "Lowest RPM",
  rpmMax: "Highest RPM",
  rpmDefault: "Default RPM",
  beanId: "Bean",
  beanBatchId: "Bean Batch",
  profileId: "Profile",
  grinderId: "Grinder",
  basketId: "Basket",
  toolIds: "Tools",
  toolAttributes: "Tools' attributes",
  dose: "Dose (g)",
  yield: "Yield (g)",
  rpm: "RPM",
  brewTemperature: "Brew temperature (°C)",
  showOnDashboard: "Shown on the dashboard",
  hotWaterMode: "Hot water by",
  steamMode: "Steam by",
  steamTemperature: "Steam temperature (°C)",
  steamDuration: "Steam time (s)",
  steamFlow: "Steam flow (ml/s)",
  steamStopTemperature: "Milk stop (°C)",
  hotWaterTemperature: "Hot water temperature (°C)",
  hotWaterDuration: "Hot water time (s)",
  hotWaterVolume: "Hot water volume (ml)",
  hotWaterFlow: "Hot water flow (ml/s)",
  flushTemperature: "Flush temperature (°C)",
  flushDuration: "Flush time (s)",
  flushFlow: "Flush flow (ml/s)",
  referenceShotId: "Reference Shot",
};

/** A field's name as people read it: a Location's state of the item names the Location, and a field of its content is spelled out, as `roastDate` is "Roast date". */
function fieldLabel(field: string, location: Location | null): string {
  if (location !== null) {
    if (field === "atLocation") return `At ${location.name}`;
    if (field === "remainingWeight") return `Remaining weight at ${location.name}`;
    if (field === "shown") return `Shown at ${location.name}`;
    return `${spelled(field)} at ${location.name}`;
  }
  return Object.prototype.hasOwnProperty.call(FIELD_LABELS, field) ? FIELD_LABELS[field]! : spelled(field);
}

function spelled(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A field's value as text. Null is a field cleared, or one never set. An item
 * named by its id, as a Recipe names its Bean Batch, is named as `names`
 * names it, where it does.
 */
function valueText(field: string, value: unknown, names: ReadonlyMap<string, string> = new Map()): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "None";
  if (typeof value === "string" && names.has(value)) return names.get(value)!;
  if (field === "hotWaterMode") return value === "temp" ? "Temperature" : value === "vol" ? "Volume" : String(value);
  if (field === "steamMode") return value === "time" ? "Time" : value === "flow" ? "Flow" : String(value);
  // A steam temperature of 0 is "Off", which a Recipe holds (ADR-0022).
  if (field === "steamTemperature" && value === 0) return "Off";
  if (field === "toolAttributes" && typeof value === "object" && !Array.isArray(value)) {
    const tools = Object.entries(value as Record<string, unknown>);
    if (tools.length === 0) return "None";
    return tools.map(([tool, pairs]) => `${names.get(tool) ?? tool}: ${valueText("custom", pairs)}`).join("; ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return field === "remainingWeight" ? `${value} g` : String(value);
  // Decaid keeps a day as its local midnight, such as a roast date entered as a day: written as that day, with its year (#732).
  if (typeof value === "string") return /^\d{4}-\d\d-\d\dT00:00:00\.000$/.test(value) ? (recordedDayWithYear(value) ?? value.slice(0, 10)) : value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    return value.map((item) => (typeof item === "string" ? (names.get(item) ?? item) : item)).join(", ");
  }
  const pairs = attributePairs(value);
  if (pairs !== undefined) return pairs.length === 0 ? "None" : pairs.map(({ key, value: text }) => `${key}: ${text}`).join(", ");
  return JSON.stringify(value);
}

/** A Tool's attributes, DYE2's `{ key, value }` pairs, or undefined for a value that is not a list of them. */
export function attributePairs(value: unknown): { key: string; value: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs = value.map((pair: unknown) =>
    typeof pair === "object" && pair !== null && typeof (pair as { key?: unknown }).key === "string"
      ? { key: (pair as { key: string }).key, value: String((pair as { value?: unknown }).value ?? "") }
      : undefined,
  );
  return pairs.every((pair) => pair !== undefined) ? pairs : undefined;
}

/**
 * Where an edit came from: a Machine's tablet, with the barista its Workflow named where the edit carries one, as a
 * Bean Batch a scan brought does, or an account, here or through a Connected App, such as an assistant.
 */
export function SourceText({ source }: { source: EditSource | null }) {
  const { state } = useAuth();
  if (source === null) return <span className="text-muted-foreground">Not known</span>;
  if (source.machine) {
    const machine = (
      <Link to={`/machines/${source.machine.id}`} className="underline-offset-4 hover:underline">
        {source.machine.name}
      </Link>
    );
    return source.barista ? <>{machine}, by {source.barista}</> : machine;
  }
  if (source.account) {
    const who = state.status === "signed-in" && state.account.id === source.account.id ? "You" : (source.account.name ?? "An account");
    // The previous release answers without connectedApp, as it may during a deploy (ADR-0025).
    return source.connectedApp ? <>{who}, through {source.connectedApp.name}</> : <>{who}, here</>;
  }
  return <span className="text-muted-foreground">{source.tabletId ? "A Machine since removed" : "Not known"}</span>;
}

/**
 * The item's change history: each accepted edit, and each Lost Edit, the latest taken in first, with where and when it
 * was made. `names` names the items values name by their ids. With `closed`, as on a Recipe's page (#547), it is a card
 * closed until opened, which reads nothing while closed. `version` is what the item's page counts its changes by: the
 * history is read afresh when it changes, the card staying as open as it was.
 */
export function ItemHistoryCard({ kind, id, names, closed = false, version = 0 }: { kind: ItemKind; id: string; names?: ReadonlyMap<string, string>; closed?: boolean; version?: number }) {
  const info = (
    <>
      <p>
        Each change that was kept, the latest first, with the Machine or account it came from.{" "}
        {`Its first is the ${kindName(kind)} joining the Library${kind === "recipe" ? ", or copied from another" : ""}.`}
      </p>
      <p>
        A Lost Edit is a change that did not apply: it lost to another change of the same field made without seeing it, or it was entered on a
        tablet for something the Library already had, with another value. A tablet joining a Location keeps none: the Location&apos;s values are
        written over its own. It is shown with the change it lost to. To bring its value back, edit the {kindName(kind)}.
      </p>
    </>
  );
  const history = <ItemHistory key={version} kind={kind} id={id} names={names} />;
  if (closed) {
    return (
      <CollapsibleCard title="History" info={info}>
        {history}
      </CollapsibleCard>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitleWithInfo title="History">{info}</CardTitleWithInfo>
      </CardHeader>
      {history}
    </Card>
  );
}

/**
 * What a row changed keeps a width its values can be read in, so in a narrow
 * card, as on a phone, the table scrolls sideways in its own box rather than
 * breaking each value to a letter a line beside a long field name (#726).
 */
const CHANGED = "min-w-64 whitespace-normal";

/** A row of an item's history: an accepted edit, or a Lost Edit, by when the server took it in or it lost. */
type HistoryRow = { at: string; version: ItemVersion; lost?: undefined } | { at: string; lost: LostEdit; version?: undefined };

/** An item's history as its table lists it: its versions and its Lost Edits together, the latest first. */
function historyRows({ versions, lostEdits = [] }: History): HistoryRow[] {
  const rows: HistoryRow[] = [...versions.map((version) => ({ at: version.receivedAt, version })), ...lostEdits.map((lost) => ({ at: lost.lostAt, lost }))];
  // Both are the server's times, in ISO 8601 in UTC, so they sort as text; a sort keeps the order each list came in between equals.
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** A field's value in an item's history: a Recipe's Reference Shot as a link to it. */
function HistoryValue({ field, value, names }: { field: string; value: unknown; names?: ReadonlyMap<string, string> }) {
  if (field === "referenceShotId" && typeof value === "string") {
    return (
      <Link to={`/shots/${encodeURIComponent(value)}`} className="underline-offset-4 hover:underline">
        The Shot
      </Link>
    );
  }
  return <>{valueText(field, value, names)}</>;
}

/**
 * Whether an edit is a batch finished at a Location by a weight of zero
 * entered there, which is one change (ADR-0037). A Batch Move is one change
 * too, written as one line naming both Locations and the amount (`moveText`)
 * in place of the fields it set.
 */
function finishedByZero(version: ItemVersion): boolean {
  return version.location !== null && version.fields.atLocation === false && version.fields.remainingWeight === 0;
}

/** A History card's content, which reads the item's history while it is shown. */
function ItemHistory({ kind, id, names }: { kind: ItemKind; id: string; names?: ReadonlyMap<string, string> }) {
  const load = useCallback(async () => historyRows(await api<History>("GET", `${itemApiPath(kind, id)}/history`)), [kind, id]);
  const { data: rows, error } = usePolled(load, DETAILS_POLL_MS);

  return (
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read its history: {error}</AlertDescription>
          </Alert>
        )}
        {rows && (
          <Table aria-label="History">
            <TableHeader>
              <TableRow>
                <TableHead>Made</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ version, lost }) =>
                lost ? (
                  <TableRow key={lost.id} className="text-muted-foreground">
                    <TableCell>{formatTime(lost.editedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <SourceText source={lost.source} />
                    </TableCell>
                    <TableCell className={CHANGED}>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                        <dt>{fieldLabel(lost.field, lost.location)}</dt>
                        <dd className="min-w-0 wrap-anywhere">
                          <HistoryValue field={lost.field} value={lost.value} names={names} /> <Badge variant="outline">Lost Edit</Badge>
                        </dd>
                      </dl>
                      <p className="mt-1 text-sm">
                        {lost.lostTo ? (
                          <>
                            Lost to <HistoryValue field={lost.field} value={lost.lostTo.value} names={names} />, by <SourceText source={lost.lostTo.source} />,{" "}
                            {formatTime(lost.lostTo.editedAt)}
                          </>
                        ) : (
                          "What it lost to is not recorded"
                        )}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={version.id}>
                    <TableCell>{formatTime(version.editedAt)}</TableCell>
                    <TableCell className="whitespace-normal">
                      <SourceText source={version.source} />
                    </TableCell>
                    <TableCell className={CHANGED}>
                      {version.copiedFrom && (
                        <p className="mb-1 text-sm">
                          Copied from{" "}
                          <ItemLink path={itemPath(kind, version.copiedFrom.id)}>{version.copiedFrom.name ?? `an unnamed ${kindName(kind)}`}</ItemLink>
                          {version.copiedFrom.location ? ` at ${version.copiedFrom.location.name}` : ""}
                        </p>
                      )}
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                        {finishedByZero(version) && (
                          <div className="contents">
                            <dt className="text-muted-foreground">{fieldLabel("atLocation", version.location)}</dt>
                            <dd className="min-w-0 wrap-anywhere">Finished, by a weight of 0 g</dd>
                          </div>
                        )}
                        {version.move && (
                          <div className="contents">
                            <dt className="text-muted-foreground">Batch Move</dt>
                            <dd className="min-w-0 wrap-anywhere">{moveText(version.move)}</dd>
                          </div>
                        )}
                        {(finishedByZero(version) || version.move ? [] : Object.entries(version.fields)).map(([field, value]) => (
                          <div key={field} className="contents">
                            <dt className="text-muted-foreground">{fieldLabel(field, version.location)}</dt>
                            <dd className="min-w-0 wrap-anywhere">
                              <HistoryValue field={field} value={value} names={names} />
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
  );
}
