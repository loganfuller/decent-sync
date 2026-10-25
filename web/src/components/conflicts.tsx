import { type ReactNode, useCallback, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ConfirmButton, formatTime } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Conflict, type EditSource, type ItemKind, type ItemVersion, type Location } from "@/lib/api";
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
 * Basket's diameter, a Tool's attributes, which DYE2 keeps as `custom`, and
 * a Recipe's items, named by their ids, and its dial and hot water.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  diameterMm: "Diameter (mm)",
  custom: "Attributes",
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
  if (field === "toolAttributes" && typeof value === "object" && !Array.isArray(value)) {
    const tools = Object.entries(value as Record<string, unknown>);
    if (tools.length === 0) return "None";
    return tools.map(([tool, pairs]) => `${names.get(tool) ?? tool}: ${valueText("custom", pairs)}`).join("; ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return field === "remainingWeight" ? `${value} g` : String(value);
  // Decaid keeps a day as its local midnight, such as a roast date entered as a day.
  if (typeof value === "string") return /^\d{4}-\d\d-\d\dT00:00:00\.000$/.test(value) ? value.slice(0, 10) : value;
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

/** Where an edit came from: a Machine's tablet, or an account in the management interface. */
function SourceText({ source }: { source: EditSource | null }) {
  const { state } = useAuth();
  if (source === null) return <span className="text-muted-foreground">Not known</span>;
  if (source.machine) {
    return (
      <Link to={`/machines/${source.machine.id}`} className="underline-offset-4 hover:underline">
        {source.machine.name}
      </Link>
    );
  }
  if (source.account) {
    if (state.status === "signed-in" && state.account.id === source.account.id) return <>You, here</>;
    return <>{source.account.name ?? "An account"}, here</>;
  }
  return <span className="text-muted-foreground">{source.tabletId ? "A Machine since removed" : "Not known"}</span>;
}

/** A value with where and when it came from. */
function Attributed({
  field,
  value,
  source,
  editedAt,
  names,
}: {
  field: string;
  value: unknown;
  source: EditSource | null;
  editedAt: string | null;
  names?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="grid gap-0.5">
      <span className="wrap-anywhere">{valueText(field, value, names)}</span>
      <span className="text-xs text-muted-foreground">
        <SourceText source={source} />
        {editedAt && `, ${formatTime(editedAt)}`}
      </span>
    </div>
  );
}

/**
 * Open Conflicts, each with its item, the field, the losing value and the value now, and where and when each came
 * from, and using its value or dismissing it for an account that may. `showItem` adds the item's column, for a list
 * of Conflicts about several items. `names` names the items values name by their ids, where it can.
 */
export function ConflictsTable({
  conflicts,
  showItem,
  onResolved,
  names,
}: {
  conflicts: Conflict[];
  showItem: boolean;
  onResolved(): Promise<void> | void;
  names?: ReadonlyMap<string, string>;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function resolve(conflict: Conflict, action: "use" | "dismiss") {
    setBusy(conflict.id);
    setError(undefined);
    try {
      // Its value replaces only the value now this page showed: one decided since is refused, and shown on reloading.
      await api("POST", `/conflicts/${conflict.id}/${action}`, action === "use" ? { seen: conflict.current.versionId } : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The Conflict could not be resolved");
    } finally {
      setBusy(undefined);
      await onResolved();
    }
  }

  return (
    <div className="grid gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Table aria-label="Conflicts">
        <TableHeader>
          <TableRow>
            {showItem && <TableHead>Item</TableHead>}
            <TableHead>Field</TableHead>
            <TableHead>Losing value</TableHead>
            <TableHead>Value now</TableHead>
            <TableHead>Became a Conflict</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {conflicts.map((conflict) => {
            const field = fieldLabel(conflict.field, conflict.location);
            const itemName = conflict.item.name ?? `Unnamed ${kindName(conflict.item.kind)}`;
            const refusedId = `conflict-${conflict.id}-refused`;
            return (
              <TableRow key={conflict.id}>
                {showItem && (
                  <TableCell className="whitespace-normal">
                    <ItemLink path={itemPath(conflict.item.kind, conflict.item.id)} className="font-medium">
                      {itemName}
                    </ItemLink>
                    <div className="text-xs text-muted-foreground">{kindName(conflict.item.kind)}</div>
                  </TableCell>
                )}
                <TableCell className="whitespace-normal">{field}</TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  <Attributed field={conflict.field} value={conflict.value} source={conflict.source} editedAt={conflict.editedAt} names={names} />
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  <Attributed
                    field={conflict.field}
                    value={conflict.current.value}
                    source={conflict.current.source}
                    editedAt={conflict.current.editedAt}
                    names={names}
                  />
                </TableCell>
                <TableCell>{formatTime(conflict.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <ConfirmButton
                      label="Use this value"
                      ariaLabel={`Use the losing value of ${field}${showItem ? ` of ${itemName}` : ""}`}
                      ariaDescribedBy={conflict.resolvable ? undefined : refusedId}
                      title="Use this value?"
                      description={
                        <>
                          {field} of {itemName} becomes {valueText(conflict.field, conflict.value, names)}, an edit made here, written to every tablet
                          that holds it. {valueText(conflict.field, conflict.current.value, names)}, its value now, stays in its history.
                          {conflict.item.kind === "recipe" &&
                            " A Bean Batch, Profile, Basket or Tool it names that the Recipe's Location does not offer is offered there too."}
                        </>
                      }
                      confirmLabel="Use this value"
                      disabled={!conflict.resolvable || busy !== undefined}
                      onConfirm={() => void resolve(conflict, "use")}
                    />
                    <Button
                      variant="outline"
                      aria-label={`Dismiss the Conflict about ${field}${showItem ? ` of ${itemName}` : ""}`}
                      aria-describedby={conflict.resolvable ? undefined : refusedId}
                      disabled={!conflict.resolvable || busy !== undefined}
                      onClick={() => void resolve(conflict, "dismiss")}
                    >
                      Dismiss
                    </Button>
                  </div>
                  {!conflict.resolvable && (
                    <p id={refusedId} className="mt-1 max-w-56 text-right text-xs text-muted-foreground whitespace-normal">
                      Staff resolve this only at {conflict.location?.name ?? "the Grinder's Location"}.
                    </p>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * A note of the item's open Conflicts, shown only while it has any. `onResolved` follows using a value or dismissing
 * one; `names` names the items values name by their ids.
 */
export function ItemConflictsCard({ kind, id, onResolved, names }: { kind: ItemKind; id: string; onResolved(): void; names?: ReadonlyMap<string, string> }) {
  const load = useCallback(async () => (await api<{ conflicts: Conflict[] }>("GET", `${itemApiPath(kind, id)}/conflicts`)).conflicts, [kind, id]);
  const { data: conflicts, error, reload } = usePolled(load, DETAILS_POLL_MS);

  if (error && !conflicts) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not read its Conflicts: {error}</AlertDescription>
      </Alert>
    );
  }
  if (!conflicts || conflicts.length === 0) return null;
  return (
    <Card role="region" aria-label="Open Conflicts">
      <CardHeader>
        <CardTitleWithInfo title="Open Conflicts">
          <p>Use a losing value to make it current on every tablet that holds it, or dismiss the Conflict to keep the value now.</p>
        </CardTitleWithInfo>
        <CardDescription>
          {conflicts.length === 1 ? "An edit" : `${conflicts.length} edits`} of this {kindName(kind)} lost to another of the same field made
          without seeing it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConflictsTable
          conflicts={conflicts}
          showItem={false}
          names={names}
          onResolved={async () => {
            await reload();
            onResolved();
          }}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The item's change history: each accepted edit, the latest taken in first, with where and when it was made. `names`
 * names the items values name by their ids.
 */
export function ItemHistoryCard({ kind, id, names }: { kind: ItemKind; id: string; names?: ReadonlyMap<string, string> }) {
  const load = useCallback(async () => (await api<{ versions: ItemVersion[] }>("GET", `${itemApiPath(kind, id)}/history`)).versions, [kind, id]);
  const { data: versions, error } = usePolled(load, DETAILS_POLL_MS);

  return (
    <Card>
      <CardHeader>
        <CardTitleWithInfo title="History">
          <p>
            Each change that was kept, the latest first, with the Machine or account it came from.{" "}
            {`Its first is the ${kindName(kind)} joining the Library${kind === "recipe" ? ", or copied from another" : ""}.`}
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>Could not read its history: {error}</AlertDescription>
          </Alert>
        )}
        {versions && (
          <Table aria-label="History">
            <TableHeader>
              <TableRow>
                <TableHead>Made</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.id}>
                  <TableCell>{formatTime(version.editedAt)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <SourceText source={version.source} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {version.copiedFrom && (
                      <p className="mb-1 text-sm">
                        Copied from{" "}
                        <ItemLink path={itemPath(kind, version.copiedFrom.id)}>{version.copiedFrom.name ?? `an unnamed ${kindName(kind)}`}</ItemLink>
                        {version.copiedFrom.location ? ` at ${version.copiedFrom.location.name}` : ""}
                      </p>
                    )}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                      {Object.entries(version.fields).map(([field, value]) => (
                        <div key={field} className="contents">
                          <dt className="text-muted-foreground">{fieldLabel(field, version.location)}</dt>
                          <dd className="min-w-0 wrap-anywhere">{valueText(field, value, names)}</dd>
                        </div>
                      ))}
                    </dl>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
