import { useCallback, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { ConfirmButton, formatTime } from "@/components/machines";
import { SETTING_LABELS, settingText } from "@/components/location-settings";
import { profilePath } from "@/components/profiles";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Conflict, type EditSource, type ItemKind, type ItemVersion, type Location } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

const KIND_NAMES: Record<ItemKind, string> = { bean: "Bean", beanBatch: "Bean Batch", grinder: "Grinder", profile: "Profile", settings: "Location settings" };

/** The address of an item's page; a Location's settings are on its page. */
export function itemPath(kind: ItemKind, id: string, location: Location | null = null): string {
  switch (kind) {
    case "settings":
      return location ? `/locations/${location.id}` : "/locations";
    case "bean":
      return `/library/beans/${id}`;
    case "beanBatch":
      return `/library/bean-batches/${id}`;
    case "grinder":
      return `/library/grinders/${id}`;
    case "profile":
      return profilePath(id);
  }
}

/** The REST API's address of an item. */
function itemApiPath(kind: ItemKind, id: string): string {
  const kinds: Record<ItemKind, string> = { bean: "beans", beanBatch: "bean-batches", grinder: "grinders", profile: "profiles", settings: "location-settings" };
  return `/${kinds[kind]}/${encodeURIComponent(id)}`;
}

/** A field's name as people read it: a Location's state of the item names the Location, and a field of its content is spelled out, as `roastDate` is "Roast date". */
export function fieldLabel(field: string, location: Location | null): string {
  if (location !== null) {
    if (field === "atLocation") return `At ${location.name}`;
    if (field === "remainingWeight") return `Remaining weight at ${location.name}`;
    if (field === "shown") return `Shown at ${location.name}`;
    if (Object.prototype.hasOwnProperty.call(SETTING_LABELS, field)) return `${SETTING_LABELS[field]} at ${location.name}`;
    return `${spelled(field)} at ${location.name}`;
  }
  return spelled(field);
}

function spelled(field: string): string {
  const words = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A version's fields, settings in Decaid's order (`SETTING_LABELS`), as a database's own key order reads oddly. */
function inOrder(fields: Record<string, unknown>): [string, unknown][] {
  const settings = Object.keys(SETTING_LABELS);
  const rank = (field: string) => (settings.includes(field) ? settings.indexOf(field) : -1);
  return Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b));
}

/** A field's value as text. Null is a field cleared, or one never set. */
export function valueText(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (field === "remainingWeight") return `${value} g`;
    return Object.prototype.hasOwnProperty.call(SETTING_LABELS, field) ? settingText(value) : String(value);
  }
  // Decaid keeps a day as its local midnight, such as a roast date entered as a day.
  if (typeof value === "string") return /^\d{4}-\d\d-\d\dT00:00:00\.000$/.test(value) ? value.slice(0, 10) : value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) return value.join(", ");
  return JSON.stringify(value);
}

/** Where an edit came from: a Machine's tablet, or an account in the management interface. */
export function SourceText({ source }: { source: EditSource | null }) {
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
function Attributed({ field, value, source, editedAt }: { field: string; value: unknown; source: EditSource | null; editedAt: string | null }) {
  return (
    <div className="grid gap-0.5">
      <span className="wrap-anywhere">{valueText(field, value)}</span>
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
 * of Conflicts about several items.
 */
export function ConflictsTable({ conflicts, showItem, onResolved }: { conflicts: Conflict[]; showItem: boolean; onResolved(): Promise<void> | void }) {
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
            const itemName = conflict.item.name ?? `Unnamed ${KIND_NAMES[conflict.item.kind]}`;
            const refusedId = `conflict-${conflict.id}-refused`;
            return (
              <TableRow key={conflict.id}>
                {showItem && (
                  <TableCell className="whitespace-normal">
                    <Link to={itemPath(conflict.item.kind, conflict.item.id, conflict.location)} className="font-medium underline-offset-4 hover:underline">
                      {itemName}
                    </Link>
                    <div className="text-xs text-muted-foreground">{KIND_NAMES[conflict.item.kind]}</div>
                  </TableCell>
                )}
                <TableCell className="whitespace-normal">{field}</TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  <Attributed field={conflict.field} value={conflict.value} source={conflict.source} editedAt={conflict.editedAt} />
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  <Attributed field={conflict.field} value={conflict.current.value} source={conflict.current.source} editedAt={conflict.current.editedAt} />
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
                        conflict.item.kind === "settings" ? (
                          <>
                            {field} becomes {valueText(conflict.field, conflict.value)}, an edit made here, written to every Machine there that
                            shares the settings. {valueText(conflict.field, conflict.current.value)}, its value now, stays in their history.
                          </>
                        ) : (
                          <>
                            {field} of {itemName} becomes {valueText(conflict.field, conflict.value)}, an edit made here, written to every tablet
                            that holds it. {valueText(conflict.field, conflict.current.value)}, its value now, stays in its history.
                          </>
                        )
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

/** A note of the item's open Conflicts, shown only while it has any. `onResolved` follows using a value or dismissing one. */
export function ItemConflictsCard({ kind, id, onResolved }: { kind: ItemKind; id: string; onResolved(): void }) {
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
        <CardTitle>
          <h2>Open Conflicts</h2>
        </CardTitle>
        <CardDescription>
          {conflicts.length === 1 ? "An edit" : `${conflicts.length} edits`} of {kind === "settings" ? "these settings" : `this ${KIND_NAMES[kind]}`}{" "}
          lost to another of the same field made without seeing it. Use a losing value to make it current on every tablet that{" "}
          {kind === "settings" ? "shares them" : "holds it"}, or dismiss the Conflict to keep the value now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ConflictsTable
          conflicts={conflicts}
          showItem={false}
          onResolved={async () => {
            await reload();
            onResolved();
          }}
        />
      </CardContent>
    </Card>
  );
}

/** The item's change history: each accepted edit, the latest taken in first, with where and when it was made. */
export function ItemHistoryCard({ kind, id }: { kind: ItemKind; id: string }) {
  const load = useCallback(async () => (await api<{ versions: ItemVersion[] }>("GET", `${itemApiPath(kind, id)}/history`)).versions, [kind, id]);
  const { data: versions, error } = usePolled(load, DETAILS_POLL_MS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>History</h2>
        </CardTitle>
        <CardDescription>
          Each change that was kept, the latest first, with the Machine or account it came from.{" "}
          {kind === "settings"
            ? "Its first is the first Machine at the Location setting them."
            : `Its first is the ${KIND_NAMES[kind]} joining the Library.`}
        </CardDescription>
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
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                      {inOrder(version.fields).map(([field, value]) => (
                        <div key={field} className="contents">
                          <dt className="text-muted-foreground">{fieldLabel(field, version.location)}</dt>
                          <dd className="min-w-0 wrap-anywhere">{valueText(field, value)}</dd>
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
