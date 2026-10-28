import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { LibraryNav } from "@/components/bean-batches";
import { ItemConflictsCard, ItemHistoryCard, attributePairs } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, PageTitleWithInfo } from "@/components/info-tip";
import { ItemShotsCard } from "@/components/item-shots";
import { ArchiveButton, BASKET_FIELDS, ContentForm, DeleteButton, NewEquipmentDialog, TOOL_FIELDS } from "@/components/library-forms";
import { formatTime, useLocations } from "@/components/machines";
import { ANY, NONE } from "@/components/record-lists";
import { OrNone } from "@/components/records";
import { ShownLocationsCard, shownAtText } from "@/components/shown-locations";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Equipment, type EquipmentSummary } from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

// The Library's Baskets and Tools: DYE2's baskets and its equipment, which
// the management interface calls Tools. Each is one item at every Location,
// shown or hidden at each as a Profile is; the pages list and filter them,
// and each item's page edits it, shows it at Locations, and Archives it.

/** The kinds DYE2 keeps that are Library items. */
export type EquipmentKind = "basket" | "tool";

/** A Basket's or Tool's name as lists show it. */
function equipmentName(kind: EquipmentKind, item: Pick<EquipmentSummary, "name">): string {
  return item.name ?? `Unnamed ${LIBRARY_KINDS[kind].name}`;
}

/** What may need someone's attention about a Basket or Tool. */
function EquipmentBadges({ item }: { item: EquipmentSummary }) {
  return <div className="flex flex-wrap gap-1">{item.archived && <Badge variant="secondary">Archived</Badge>}</div>;
}

/** The sizes DYE2 offers a basket, by its value. */
const SIZES = new Map((BASKET_FIELDS.find((field) => field.field === "size")?.choices ?? []).map(([value, label]) => [value, label]));

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A Basket's size, as DYE2 offers it. */
function sizeText(content: Record<string, unknown>): string | undefined {
  const size = text(content.size);
  return size === undefined ? undefined : (SIZES.get(size) ?? size);
}

/** A Basket's diameter, in millimetres. */
function diameterText(content: Record<string, unknown>): string | undefined {
  return typeof content.diameterMm === "number" && Number.isFinite(content.diameterMm) ? `${content.diameterMm} mm` : undefined;
}

/** A Tool's attributes as one line, such as "Needles: 8, Needle size: 0.3 mm". */
function attributesText(content: Record<string, unknown>): string | undefined {
  const pairs = attributePairs(content.custom) ?? [];
  return pairs.length === 0 ? undefined : pairs.map(({ key, value }) => `${key}: ${value}`).join(", ");
}

/** Whether a Basket or Tool matches the words searched for, in its name or details, ignoring case. */
function matches(kind: EquipmentKind, item: EquipmentSummary, search: string): boolean {
  const words = search.trim().toLowerCase();
  if (words === "") return true;
  const details = kind === "basket" ? [sizeText(item.content), diameterText(item.content), text(item.content.notes)] : [attributesText(item.content)];
  return [item.name, ...details].some((part) => part?.toLowerCase().includes(words));
}

/** The list's filters, kept in the address: words searched for, a Location showing it, or none, and whether it is Archived. */
const FILTERS = { search: "q", location: "shownAt", status: "status" } as const;

/**
 * The Library's Baskets or Tools, filtered by name, by a Location showing
 * them, and by whether they are Archived, the filters kept in the address.
 * Each joins the Library from a tablet, or is created here.
 */
export function EquipmentList({ kind, title, description }: { kind: EquipmentKind; title: string; description: ReactNode }) {
  const { api: apiPath, pages } = LIBRARY_KINDS[kind];
  const plural = kind === "basket" ? "baskets" : "tools";
  const load = useCallback(async () => (await api<Record<string, EquipmentSummary[]>>("GET", apiPath))[plural] ?? [], [apiPath, plural]);
  const { data: items, error } = usePolled(load, DETAILS_POLL_MS);
  const { locations, error: locationsError } = useLocations();
  const [params, setParams] = useSearchParams();
  const id = useId();
  const search = params.get(FILTERS.search) ?? "";
  const shownAt = params.get(FILTERS.location) ?? ANY;
  const status = params.get(FILTERS.status) ?? ANY;
  const filtered = [FILTERS.search, FILTERS.location, FILTERS.status].some((filter) => params.has(filter));

  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "" || value === ANY) next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: name === FILTERS.search });
  }

  const shown = (items ?? []).filter(
    (item) =>
      matches(kind, item, search) &&
      (shownAt === ANY || (shownAt === NONE ? item.shownAt.length === 0 : item.shownAt.some((here) => here.location.id === shownAt))) &&
      (status === ANY || item.archived === (status === "archived")),
  );

  return (
    <section className="grid gap-6">
      <div className="grid gap-1">
        <PageTitleWithInfo title={title}>
          <p>{description}</p>
        </PageTitleWithInfo>
        <LibraryNav />
        <div className="mt-2">
          <NewEquipmentDialog kind={kind} />
        </div>
      </div>

      <div role="search" aria-label={`Filter ${title}`} className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-search`}>Search</Label>
          <Input
            id={`${id}-search`}
            className="w-64"
            type="search"
            placeholder={kind === "basket" ? "Name, size or notes" : "Name or attributes"}
            value={search}
            onChange={(event) => filter(FILTERS.search, event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-shown`}>Shown at</Label>
          <Select value={shownAt} onValueChange={(value) => filter(FILTERS.location, value)}>
            <SelectTrigger id={`${id}-shown`} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any Location</SelectItem>
              <SelectItem value={NONE}>Nowhere</SelectItem>
              {locations?.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-status`}>Status</Label>
          <Select value={status} onValueChange={(value) => filter(FILTERS.status, value)}>
            <SelectTrigger id={`${id}-status`} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any</SelectItem>
              <SelectItem value="current">Not Archived</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {filtered && (
          <Button type="button" variant="outline" onClick={() => setParams(new URLSearchParams())}>
            Clear filters
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {locationsError && (
        <Alert variant="destructive">
          <AlertDescription>{locationsError}</AlertDescription>
        </Alert>
      )}
      {items?.length === 0 && (
        <p className="text-muted-foreground">
          No {title} yet. They join the Library as tablets at a Location save them in DYE2, or as they are created here.
        </p>
      )}
      {items && items.length > 0 && filtered && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {shown.length === 0 ? `No ${title} match these filters.` : `${shown.length} of ${items.length} ${title} shown.`}
        </p>
      )}
      {shown.length > 0 && (
        <div className="rounded-lg border">
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {kind === "basket" ? (
                  <>
                    <TableHead>Size</TableHead>
                    <TableHead>Diameter</TableHead>
                  </>
                ) : (
                  <TableHead>Attributes</TableHead>
                )}
                <TableHead>Shown at</TableHead>
                <TableHead>Created at</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">
                    <Link to={`${pages}/${item.id}`} className="underline-offset-4 hover:underline">
                      {equipmentName(kind, item)}
                    </Link>
                  </TableCell>
                  {kind === "basket" ? (
                    <>
                      <TableCell>
                        <OrNone>{sizeText(item.content)}</OrNone>
                      </TableCell>
                      <TableCell>
                        <OrNone>{diameterText(item.content)}</OrNone>
                      </TableCell>
                    </>
                  ) : (
                    <TableCell>
                      <OrNone>{attributesText(item.content)}</OrNone>
                    </TableCell>
                  )}
                  <TableCell>{shownAtText(item)}</TableCell>
                  <TableCell>
                    <OrNone>{item.createdLocation?.name}</OrNone>
                  </TableCell>
                  <TableCell>
                    <EquipmentBadges item={item} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/**
 * One Basket or Tool: its content, edited here by an Admin or Staff
 * anywhere; the Locations showing it, each changed by an Admin or Staff
 * working there; its open Conflicts; and its history.
 */
export function EquipmentDetails({ kind, id }: { kind: EquipmentKind; id: string }) {
  const { name, api: apiPath, pages } = LIBRARY_KINDS[kind];
  const [item, setItem] = useState<Equipment>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // Using a Conflict's value, or a change here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const [editing, setEditing] = useState(false);
  const changed = () => setChanges((count) => count + 1);
  const path = `${apiPath}/${encodeURIComponent(id)}`;

  useEffect(() => {
    let current = true;
    api<Record<string, Equipment>>("GET", path).then(
      (loaded) => current && setItem(loaded[kind]),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(caught instanceof Error ? caught.message : `The ${name} could not be loaded`);
      },
    );
    return () => {
      current = false;
    };
  }, [kind, name, path, changes]);

  const back = (
    <Link to={pages} className="text-sm text-muted-foreground hover:text-foreground">
      ← {kind === "basket" ? "Baskets" : "Tools"}
    </Link>
  );
  if (notFound) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such {name}.</p>
      </section>
    );
  }
  if (!item) {
    return (
      <section className="grid gap-4">
        {back}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  const title = equipmentName(kind, item);
  return (
    <section className="grid gap-6">
      {back}
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {title} <EquipmentBadges item={item} />
        </h1>
        <p className="text-muted-foreground">
          {item.archived ? "Shown nowhere while Archived" : item.shownAt.length === 0 ? "Shown nowhere" : `Shown at ${shownAtText(item)}`}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <ArchiveButton path={path} name={title} archived={item.archived} effect="removed from every tablet's DYE2 list" onDone={changed} />
        <DeleteButton path={path} name={title} back={pages} deletable={`a ${name} no Shot or Recipe names`} />
      </div>

      <ItemConflictsCard kind={kind} id={id} onResolved={changed} />

      <ShownLocationsCard
        item={item}
        path={path}
        description="Where it is shown. Showing it at a Location writes it to the DYE2 list of each tablet there; hiding it there removes it from those lists, as DYE2 cannot hide one, and changes no other Location."
        archivedNote="It is Archived, so it is shown nowhere and removed from every tablet's DYE2 list. Restoring it writes it again where it is shown below."
        onChanged={changed}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitleWithInfo title={name}>
              <p>As it was created, with the edits made since, on tablets or here, which reach every tablet that holds it.</p>
            </CardTitleWithInfo>
          </CardHeader>
          <CardContent className="grid gap-4">
            {editing ? (
              <ContentForm
                label={`Edit the ${name}`}
                fields={kind === "basket" ? BASKET_FIELDS : TOOL_FIELDS}
                content={item.content}
                path={path}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  changed();
                }}
              />
            ) : (
              <>
                <Fields label={name}>
                  <Field term="Name">
                    <OrNone>{item.name ?? undefined}</OrNone>
                  </Field>
                  {kind === "basket" ? (
                    <>
                      <Field term="Size">
                        <OrNone>{sizeText(item.content)}</OrNone>
                      </Field>
                      <Field term="Diameter">
                        <OrNone>{diameterText(item.content)}</OrNone>
                      </Field>
                      <Field term="Notes">
                        <OrNone>{text(item.content.notes)}</OrNone>
                      </Field>
                    </>
                  ) : (
                    <Field term="Attributes">
                      <Attributes content={item.content} />
                    </Field>
                  )}
                </Fields>
                <div>
                  <Button variant="outline" aria-label={`Edit the ${name}`} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>In the Library</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Fields label="In the Library">
              <Field term="Created at">
                <OrNone>{item.createdLocation?.name}</OrNone>
              </Field>
              <Field term="Joined">{formatTime(item.createdAt)}</Field>
            </Fields>
          </CardContent>
        </Card>
      </div>

      {kind === "basket" && <ItemShotsCard kind="basket" id={id} />}

      <ItemHistoryCard key={changes} kind={kind} id={id} />
    </section>
  );
}

/** A Tool's attributes, each name with its value. */
function Attributes({ content }: { content: Record<string, unknown> }) {
  const pairs = attributePairs(content.custom) ?? [];
  if (pairs.length === 0) return <OrNone>{undefined}</OrNone>;
  return (
    <Table aria-label="Attributes">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pairs.map((pair, index) => (
          <TableRow key={index}>
            <TableCell className="font-medium">{pair.key}</TableCell>
            <TableCell>{pair.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
