import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useIsAdmin, useStaffLocationIds } from "@/auth";
import { weightText } from "@/components/bean-batches";
import { Field, Fields } from "@/components/fields";
import { ConfirmButton, formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, type BeanBatch, type BeanSummary, type Location } from "@/lib/api";

// Creating and editing the Library's Beans, Bean Batches and Grinders,
// Archiving and restoring them, adding and finishing batches at Locations,
// and an Admin's hard delete. Each change is the account's edit, made over
// the item as it stands, and is written to every tablet that holds it.

/** How a form reads a field: as text, longer text, a number, a day, yes or no, a list, a list of whole numbers, or one of some choices. */
type FieldKind = "text" | "longText" | "number" | "day" | "flag" | "list" | "wholeList" | "choice";

interface FormField {
  /** Decaid's name for it. */
  field: string;
  label: string;
  kind: FieldKind;
  /** Required: a Bean's roaster and name, a Grinder's model. */
  required?: boolean;
  /** For a choice, each value and its label. */
  choices?: [value: string, label: string][];
}

/** A Bean's fields, in Decaid's order. */
export const BEAN_FIELDS: FormField[] = [
  { field: "roaster", label: "Roaster", kind: "text", required: true },
  { field: "name", label: "Name", kind: "text", required: true },
  { field: "species", label: "Species", kind: "text" },
  { field: "decaf", label: "Decaf", kind: "flag" },
  { field: "decafProcess", label: "Decaf process", kind: "text" },
  { field: "country", label: "Country", kind: "text" },
  { field: "region", label: "Region", kind: "text" },
  { field: "producer", label: "Producer", kind: "text" },
  { field: "variety", label: "Variety (comma separated)", kind: "list" },
  { field: "altitude", label: "Altitude in metres (comma separated)", kind: "wholeList" },
  { field: "processing", label: "Processing", kind: "text" },
  { field: "notes", label: "Notes", kind: "longText" },
];

/** A batch's details, in Decaid's order: not where it is or its remaining weight there, which are each Location's. */
export const BATCH_FIELDS: FormField[] = [
  { field: "roastDate", label: "Roast date", kind: "day" },
  { field: "roastLevel", label: "Roast level", kind: "text" },
  { field: "harvestDate", label: "Harvest", kind: "text" },
  { field: "qualityScore", label: "Quality score", kind: "number" },
  { field: "price", label: "Price", kind: "number" },
  { field: "currency", label: "Currency", kind: "text" },
  { field: "weight", label: "Weight (g)", kind: "number" },
  { field: "buyDate", label: "Bought", kind: "day" },
  { field: "openDate", label: "Opened", kind: "day" },
  { field: "bestBeforeDate", label: "Best before", kind: "day" },
  { field: "frozen", label: "Frozen", kind: "flag" },
  { field: "freezeDate", label: "Frozen on", kind: "day" },
  { field: "unfreezeDate", label: "Thawed on", kind: "day" },
  { field: "notes", label: "Notes", kind: "longText" },
];

/** A Grinder's fields, in Decaid's order. */
export const GRINDER_FIELDS: FormField[] = [
  { field: "model", label: "Model", kind: "text", required: true },
  { field: "burrs", label: "Burrs", kind: "text" },
  { field: "burrSize", label: "Burr size (mm)", kind: "number" },
  { field: "burrType", label: "Burr type", kind: "text" },
  { field: "notes", label: "Notes", kind: "longText" },
  {
    field: "settingType",
    label: "Setting type",
    kind: "choice",
    choices: [
      ["numeric", "Numeric"],
      ["preset", "Preset values"],
    ],
  },
  { field: "settingValues", label: "Preset values (comma separated)", kind: "list" },
  { field: "settingSmallStep", label: "Small step", kind: "number" },
  { field: "settingBigStep", label: "Big step", kind: "number" },
  { field: "rpmSmallStep", label: "RPM small step", kind: "number" },
  { field: "rpmBigStep", label: "RPM big step", kind: "number" },
];

/** A form's values: each field as its input holds it. */
type Values = Record<string, string | boolean>;

/** A field's value as its input holds it, from an item's content. */
function inputValue(field: FormField, value: unknown): string | boolean {
  switch (field.kind) {
    case "flag":
      return value === true;
    case "day":
      return typeof value === "string" && /^\d{4}-\d\d-\d\d/.test(value) ? value.slice(0, 10) : "";
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "list":
    case "wholeList":
      return Array.isArray(value) ? value.join(", ") : "";
    case "choice":
      return typeof value === "string" ? value : (field.choices?.[0]?.[0] ?? "");
    default:
      return typeof value === "string" ? value : "";
  }
}

/** An input's value as the server takes it: null clears the field. */
function contentValue(field: FormField, value: string | boolean): unknown {
  if (typeof value === "boolean") return value;
  const text = value.trim();
  if (text === "") return null;
  switch (field.kind) {
    case "number":
      return Number(text);
    case "list":
      return text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    case "wholeList": {
      const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
      // Refused rather than dropped, so nothing typed is lost unseen.
      if (!items.every((item) => /^\d+$/.test(item))) throw new Error(`${field.label} must be whole numbers, separated by commas`);
      return items.map(Number);
    }
    case "longText":
      return value;
    default:
      return text;
  }
}

/** The values of a form showing an item's content. */
export function valuesOf(fields: FormField[], content: Record<string, unknown>): Values {
  return Object.fromEntries(fields.map((field) => [field.field, inputValue(field, content[field.field])]));
}

/** The content a new item is created with: each field given a value. */
function newContent(fields: FormField[], values: Values): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = contentValue(field, values[field.field] ?? "");
    return value === null ? [] : [[field.field, value]];
  }));
}

/** The fields an edit changes, each with its value, null to clear it. */
function changedContent(fields: FormField[], initial: Values, values: Values): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => (values[field.field] === initial[field.field] ? [] : [[field.field, contentValue(field, values[field.field] ?? "")]])));
}

/** The inputs of a form of an item's fields. */
function ContentInputs({ fields, values, onChange }: { fields: FormField[]; values: Values; onChange(field: string, value: string | boolean): void }) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const inputId = `${id}-${field.field}`;
        const value = values[field.field];
        if (field.kind === "flag") {
          return (
            <div key={field.field} className="flex items-center gap-2 self-end py-1.5">
              <Checkbox id={inputId} checked={value === true} onCheckedChange={(checked) => onChange(field.field, checked === true)} />
              <Label htmlFor={inputId}>{field.label}</Label>
            </div>
          );
        }
        return (
          <div key={field.field} className={field.kind === "longText" ? "grid gap-2 sm:col-span-2" : "grid gap-2"}>
            <Label htmlFor={inputId}>{field.label}</Label>
            {field.kind === "longText" ? (
              <Textarea id={inputId} value={String(value ?? "")} onChange={(event) => onChange(field.field, event.target.value)} />
            ) : field.kind === "choice" ? (
              <Select value={String(value ?? "")} onValueChange={(chosen) => onChange(field.field, chosen)}>
                <SelectTrigger id={inputId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.choices?.map(([choice, label]) => (
                    <SelectItem key={choice} value={choice}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={inputId}
                type={field.kind === "number" ? "number" : field.kind === "day" ? "date" : "text"}
                inputMode={field.kind === "number" ? "decimal" : undefined}
                min={field.kind === "number" ? 0 : undefined}
                step={field.kind === "number" ? "any" : undefined}
                required={field.required}
                value={String(value ?? "")}
                onChange={(event) => onChange(field.field, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A refusal to show in a form, from what the server answered. */
function failure(caught: unknown, otherwise: string): string {
  return caught instanceof Error ? caught.message : otherwise;
}

function FormError({ error }: { error: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/**
 * Edits an item's content: only the fields changed are sent, each an edit
 * made here, which reaches every tablet that holds it.
 */
export function ContentForm({
  label,
  fields,
  content,
  path,
  onCancel,
  onSaved,
}: {
  label: string;
  fields: FormField[];
  content: Record<string, unknown>;
  /** The item's path in the REST API, such as /beans/{id}. */
  path: string;
  onCancel(): void;
  onSaved(): Promise<void> | void;
}) {
  const [initial] = useState(() => valuesOf(fields, content));
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    let changed: Record<string, unknown>;
    try {
      changed = changedContent(fields, initial, values);
    } catch (caught) {
      return setError(failure(caught, "The changes could not be read"));
    }
    if (Object.keys(changed).length === 0) return onCancel();
    setSaving(true);
    try {
      await api("PATCH", path, { content: changed });
      await onSaved();
    } catch (caught) {
      setError(failure(caught, "The changes could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label={label} className="grid gap-4" onSubmit={save}>
      {error && <FormError error={error} />}
      <ContentInputs fields={fields} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
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

/** Whether the signed-in account may change what a Location offers: an Admin anywhere, Staff where they work. */
export function useMayChangeAt(): (locationId: string | null) => boolean {
  const isAdmin = useIsAdmin();
  const staffLocations = useStaffLocationIds();
  return (locationId) => isAdmin || (locationId !== null && staffLocations.has(locationId));
}

/** Archives an item, offered nowhere from then on, or restores it, offered again where it was. */
export function ArchiveButton({ path, name, archived, onDone }: { path: string; name: string; archived: boolean; onDone(): Promise<void> | void }) {
  const [error, setError] = useState<string>();
  async function change() {
    setError(undefined);
    try {
      await api("PUT", `${path}/archived`, { archived: !archived });
      await onDone();
    } catch (caught) {
      setError(failure(caught, archived ? "It could not be restored" : "It could not be Archived"));
    }
  }
  return (
    <div className="grid gap-2">
      {error && <FormError error={error} />}
      {archived ? (
        <Button variant="outline" onClick={() => void change()}>
          Restore
        </Button>
      ) : (
        <ConfirmButton
          label="Archive"
          title={`Archive ${name}?`}
          description="It is offered nowhere from now on, and archived on every tablet that holds it, but kept, so past Shots still name it. It can be restored."
          confirmLabel="Archive"
          onConfirm={() => void change()}
        />
      )}
    </div>
  );
}

/** An Admin's hard delete: the item is gone from the Library and every tablet that holds it, refused while a Shot names it. */
export function DeleteButton({ path, name, what, back }: { path: string; name: string; what?: string; back: string }) {
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  if (!isAdmin) return null;
  async function remove() {
    setError(undefined);
    try {
      await api("DELETE", path);
      void navigate(back);
    } catch (caught) {
      setError(failure(caught, "It could not be deleted"));
    }
  }
  return (
    <div className="grid gap-2">
      {error && <FormError error={error} />}
      <ConfirmButton
        label="Delete"
        variant="destructive"
        title={`Delete ${name}?`}
        description={`${what === undefined ? "" : `${what} `}It is deleted from every tablet that holds it, now or once it connects, and cannot be restored. Only an item no Shot names can be deleted; Archive one that is.`}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** The existing Bean a new one would duplicate, from a refusal. */
function existingBean(caught: unknown): { id: string; roaster: string | null; name: string | null } | undefined {
  if (!(caught instanceof ApiError) || caught.status !== 409) return undefined;
  const existing = (caught.data as { existing?: unknown } | undefined)?.existing;
  return typeof existing === "object" && existing !== null && typeof (existing as { id?: unknown }).id === "string"
    ? (existing as { id: string; roaster: string | null; name: string | null })
    : undefined;
}

/** Creates a Bean, offered nowhere until one of its batches is added somewhere. One of a roaster and name the Library has is refused, with a link to that Bean. */
export function NewBeanDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => valuesOf(BEAN_FIELDS, {}));
  const [error, setError] = useState<ReactNode>();
  const [saving, setSaving] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const { bean } = await api<{ bean: BeanSummary }>("POST", "/beans", { content: newContent(BEAN_FIELDS, values) });
      setOpen(false);
      void navigate(`/library/beans/${bean.id}`);
    } catch (caught) {
      const existing = existingBean(caught);
      setError(
        existing ? (
          <>
            The Library has this Bean already:{" "}
            <Link to={`/library/beans/${existing.id}`} className="underline underline-offset-4" onClick={() => setOpen(false)}>
              {existing.name ?? "Unnamed Bean"}
            </Link>
            {existing.roaster && ` by ${existing.roaster}`}.
          </>
        ) : (
          failure(caught, "The Bean could not be created")
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New Bean</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Bean</DialogTitle>
          <DialogDescription>A coffee, by its roaster and name. It is offered at each Location where one of its batches is added.</DialogDescription>
        </DialogHeader>
        <form aria-label="New Bean" className="grid gap-4" onSubmit={create}>
          {error && <FormError error={error} />}
          <ContentInputs fields={BEAN_FIELDS} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
          <div>
            <Button type="submit" disabled={saving}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Creates a batch of a Bean, at the Locations chosen, each with its
 * remaining weight there: Staff only at their own. Without a Bean given,
 * one is chosen from the Library's, but those Archived.
 */
export function NewBatchDialog({ bean, beans }: { bean?: { id: string; name: string | null }; beans?: BeanSummary[] }) {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [open, setOpen] = useState(false);
  const [beanId, setBeanId] = useState(bean?.id ?? "");
  const [values, setValues] = useState<Values>(() => valuesOf(BATCH_FIELDS, {}));
  const [at, setAt] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const id = useId();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (beanId === "") return setError("Choose its Bean");
    setSaving(true);
    setError(undefined);
    try {
      const placed = Object.entries(at).map(([locationId, weight]) => ({
        locationId,
        ...(weight.trim() === "" ? {} : { remainingWeight: Number(weight) }),
      }));
      const { batch } = await api<{ batch: BeanBatch }>("POST", "/bean-batches", { beanId, content: newContent(BATCH_FIELDS, values), locations: placed });
      setOpen(false);
      void navigate(`/library/bean-batches/${batch.id}`);
    } catch (caught) {
      setError(failure(caught, "The batch could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={bean ? "outline" : "default"}>New batch</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New batch{bean ? ` of ${bean.name ?? "Unnamed Bean"}` : ""}</DialogTitle>
          <DialogDescription>A roast of a Bean, written with its Bean to the tablets at each Location it is added at.</DialogDescription>
        </DialogHeader>
        <form aria-label="New batch" className="grid gap-4" onSubmit={create}>
          {error && <FormError error={error} />}
          {!bean && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-bean`}>Bean</Label>
              <Select value={beanId} onValueChange={setBeanId}>
                <SelectTrigger id={`${id}-bean`} className="w-full">
                  <SelectValue placeholder="Choose its Bean" />
                </SelectTrigger>
                <SelectContent>
                  {(beans ?? [])
                    .filter((candidate) => !candidate.archived)
                    .map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name ?? "Unnamed Bean"}
                        {candidate.roaster ? `, ${candidate.roaster}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <ContentInputs fields={BATCH_FIELDS} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">At</legend>
            {locationsError && <FormError error={locationsError} />}
            {locations?.map((location) => {
              const checked = location.id in at;
              const allowed = mayChangeAt(location.id);
              return (
                <div key={location.id} className="grid grid-cols-[auto_1fr_10rem] items-center gap-3">
                  <Checkbox
                    id={`${id}-at-${location.id}`}
                    checked={checked}
                    disabled={!allowed}
                    onCheckedChange={(value) =>
                      setAt((current) => {
                        const next = { ...current };
                        if (value === true) next[location.id] = typeof values.weight === "string" ? values.weight : "";
                        else delete next[location.id];
                        return next;
                      })
                    }
                  />
                  <Label htmlFor={`${id}-at-${location.id}`}>{location.name}</Label>
                  <Input
                    aria-label={`Remaining weight at ${location.name} (g)`}
                    type="number"
                    min={0}
                    step="any"
                    placeholder="Remaining (g)"
                    disabled={!checked}
                    value={at[location.id] ?? ""}
                    onChange={(event) => setAt((current) => ({ ...current, [location.id]: event.target.value }))}
                  />
                </div>
              );
            })}
          </fieldset>
          <div>
            <Button type="submit" disabled={saving}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Creates a Grinder belonging to a Location: Staff only at their own. */
export function NewGrinderDialog() {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [values, setValues] = useState<Values>(() => valuesOf(GRINDER_FIELDS, {}));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const id = useId();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locationId === "") return setError("Choose the Location it belongs to");
    setSaving(true);
    setError(undefined);
    try {
      const { grinder } = await api<{ grinder: { id: string } }>("POST", "/grinders", { locationId, content: newContent(GRINDER_FIELDS, values) });
      setOpen(false);
      void navigate(`/library/grinders/${grinder.id}`);
    } catch (caught) {
      setError(failure(caught, "The Grinder could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New Grinder</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Grinder</DialogTitle>
          <DialogDescription>A grinder belongs to one Location, and is written to that Location's tablets only.</DialogDescription>
        </DialogHeader>
        <form aria-label="New Grinder" className="grid gap-4" onSubmit={create}>
          {error && <FormError error={error} />}
          {locationsError && <FormError error={locationsError} />}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-location`}>Location</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id={`${id}-location`} className="w-full">
                <SelectValue placeholder="Choose its Location" />
              </SelectTrigger>
              <SelectContent>
                {locations?.filter((location) => mayChangeAt(location.id)).map((location: Location) => (
                  <SelectItem key={location.id} value={location.id}>
                    {location.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ContentInputs fields={GRINDER_FIELDS} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
          <div>
            <Button type="submit" disabled={saving}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a batch is: the Locations it is at, each with its remaining weight
 * there and when it was added there, and those it was finished at. An Admin,
 * or Staff working there, adds it at another Location, finishes it at one,
 * or sets its remaining weight there.
 */
export function BatchLocationsCard({ batch, onChanged }: { batch: BeanBatch; onChanged(): Promise<void> | void }) {
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const addable = (locations ?? []).filter((location) => mayChangeAt(location.id) && !batch.locations.some((here) => here.location.id === location.id));

  async function place(location: Location, body: { atLocation?: boolean; remainingWeight?: number | null }) {
    setBusy(true);
    setError(undefined);
    try {
      await api("PUT", `/bean-batches/${batch.id}/locations/${location.id}`, body);
      setWeights((current) => {
        const next = { ...current };
        delete next[location.id];
        return next;
      });
      setAdding("");
      await onChanged();
    } catch (caught) {
      setError(failure(caught, "Where the batch is could not be changed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Locations</h2>
        </CardTitle>
        <CardDescription>
          Where it is, from when it was added there until it is finished there, and the remaining weight entered last at each.
          Each Location's tablets hold it with that Location's weight; finished there, it is archived on them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <FormError error={error} />}
        {locationsError && <FormError error={locationsError} />}
        {batch.locations.length === 0 ? (
          <p className="text-sm text-muted-foreground">It is at no Location.</p>
        ) : (
          <Table aria-label="Locations">
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead>Remaining weight</TableHead>
                <TableHead>Added</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.locations.map((here) => {
                const { location } = here;
                const weight = weights[location.id] ?? (here.remainingWeight === null ? "" : String(here.remainingWeight));
                return (
                  <TableRow key={location.id}>
                    <TableCell className="font-medium">{location.name}</TableCell>
                    <TableCell>{weightText(here.remainingWeight)}</TableCell>
                    <TableCell>{formatTime(here.since)}</TableCell>
                    <TableCell>
                      {mayChangeAt(location.id) && (
                        <form
                          className="flex items-center justify-end gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void place(location, { remainingWeight: weight.trim() === "" ? null : Number(weight) });
                          }}
                        >
                          <Input
                            aria-label={`Remaining weight at ${location.name} (g)`}
                            className="w-28"
                            type="number"
                            min={0}
                            step="any"
                            value={weight}
                            onChange={(event) => setWeights((current) => ({ ...current, [location.id]: event.target.value }))}
                          />
                          <Button type="submit" variant="outline" size="sm" disabled={busy} aria-label={`Set the remaining weight at ${location.name}`}>
                            Set
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            aria-label={`Finish it at ${location.name}`}
                            onClick={() => void place(location, { atLocation: false })}
                          >
                            Finish here
                          </Button>
                        </form>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {batch.finished.length > 0 && (
          <Fields label="Finished">
            {batch.finished.map((here) => (
              <Field key={here.location.id} term={here.location.name}>
                Finished {formatTime(here.finishedAt)}, with {weightText(here.remainingWeight)}
              </Field>
            ))}
          </Fields>
        )}
        {!batch.archived && addable.length > 0 && (
          <form
            aria-label="Add it at a Location"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const location = addable.find((candidate) => candidate.id === adding);
              if (location) void place(location, { atLocation: true });
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor={`${id}-add`}>Add it at</Label>
              <Select value={adding} onValueChange={setAdding}>
                <SelectTrigger id={`${id}-add`} className="w-56">
                  <SelectValue placeholder="Choose a Location" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" variant="outline" disabled={busy || adding === ""}>
              Add
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
