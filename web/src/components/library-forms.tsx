import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useIsAdmin, useStaffLocationIds } from "@/auth";
import { batchName, listed, weightText } from "@/components/bean-batches";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ConfirmButton, formatTime, useLocations } from "@/components/machines";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, type BeanBatch, type BeanSummary, type Location } from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";

// Creating and editing the Library's Beans, Bean Batches, Grinders, Baskets
// and Tools, Archiving and restoring them and Profiles, moving a batch to a
// Location and finishing it there, and an Admin's hard delete. Each change is the
// account's edit, made over the item as it stands, and is written to every
// tablet that holds it.

/**
 * How a form reads a field: as text, longer text, a number, a day, yes or
 * no, a list, a list of whole numbers, one of some choices, or a Tool's
 * attributes, name and value pairs.
 */
type FieldKind = "text" | "longText" | "number" | "day" | "flag" | "list" | "wholeList" | "choice" | "attributes";

/** A Tool's attribute as DYE2 keeps it: a name (`key`) and its value. */
export interface Attribute {
  key: string;
  value: string;
}

interface FormField {
  /** Decaid's name for it. */
  field: string;
  label: string;
  kind: FieldKind;
  /** Required: a Bean's roaster and name, a Grinder's model. */
  required?: boolean;
  /** For a choice, each value and its label. */
  choices?: [value: string, label: string][];
  /** For a choice, whether it may be left unset, as a Basket's size. */
  optional?: boolean;
  /** For a number, whether it may be below 0, as a Grinder's range and defaults may. */
  signed?: boolean;
}

/** A Profile's title, author and notes, outside the steps that decide its id (ADR-0032): its title can't be cleared, as Decaid refuses a profile with none. */
export const PROFILE_FIELDS: FormField[] = [
  { field: "title", label: "Title", kind: "text", required: true },
  { field: "author", label: "Author", kind: "text" },
  { field: "notes", label: "Notes", kind: "longText" },
];

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
  { field: "batchCode", label: "Batch Code", kind: "text" },
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

/**
 * A Grinder's fields, in Decaid's order, with the range DYE2 keeps in its
 * `extras` for its setting and for its RPM beside the steps of each, each
 * pair a row of the form, then the default of each, and the feed rate note
 * DYE2 keeps there. A blank range or default is none, and 0 is a value.
 */
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
  { field: "settingMin", label: "Lowest setting", kind: "number", signed: true },
  { field: "settingMax", label: "Highest setting", kind: "number", signed: true },
  { field: "rpmSmallStep", label: "RPM small step", kind: "number" },
  { field: "rpmBigStep", label: "RPM big step", kind: "number" },
  { field: "rpmMin", label: "Lowest RPM", kind: "number", signed: true },
  { field: "rpmMax", label: "Highest RPM", kind: "number", signed: true },
  { field: "settingDefault", label: "Default setting", kind: "number", signed: true },
  { field: "rpmDefault", label: "Default RPM", kind: "number", signed: true },
  { field: "feedRate", label: "Feed rate", kind: "text" },
];

/** A Basket's fields, as DYE2's baskets page has them. */
export const BASKET_FIELDS: FormField[] = [
  { field: "name", label: "Name", kind: "text", required: true },
  {
    field: "size",
    label: "Size",
    kind: "choice",
    optional: true,
    choices: [
      ["single", "Single"],
      ["double", "Double"],
      ["triple", "Triple"],
      ["bottomless", "Bottomless"],
      ["other", "Other"],
    ],
  },
  { field: "diameterMm", label: "Diameter (mm)", kind: "number" },
  { field: "notes", label: "Notes", kind: "longText" },
];

/** A Tool's fields, as DYE2's equipment page has them: its name, and its attributes, which DYE2 keeps as `custom`. */
export const TOOL_FIELDS: FormField[] = [
  { field: "name", label: "Name", kind: "text", required: true },
  { field: "custom", label: "Attributes", kind: "attributes" },
];

/** A form's values: each field as its input holds it. */
type Value = string | boolean | Attribute[];
type Values = Record<string, Value>;

/** Stands for an optional choice left unset, as a Select's options each need a value. */
const NOT_SET = "not-set";

/** A field's value as its input holds it, from an item's content. */
function inputValue(field: FormField, value: unknown): Value {
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
      return typeof value === "string" ? value : field.optional ? "" : (field.choices?.[0]?.[0] ?? "");
    case "attributes":
      return Array.isArray(value)
        ? value.flatMap((pair: unknown) =>
            typeof pair === "object" && pair !== null && typeof (pair as { key?: unknown }).key === "string"
              ? [{ key: (pair as { key: string }).key, value: String((pair as { value?: unknown }).value ?? "") }]
              : [],
          )
        : [];
    default:
      return typeof value === "string" ? value : "";
  }
}

/** An input's value as the server takes it: null clears the field. Attributes without a name are left out, as DYE2 leaves them. */
function contentValue(field: FormField, value: Value): unknown {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.filter((pair) => pair.key.trim() !== "").map((pair) => ({ key: pair.key.trim(), value: pair.value.trim() }));
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
function valuesOf(fields: FormField[], content: Record<string, unknown>): Values {
  return Object.fromEntries(fields.map((field) => [field.field, inputValue(field, content[field.field])]));
}

/** The content a new item is created with: each field given a value. */
function newContent(fields: FormField[], values: Values): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = contentValue(field, values[field.field] ?? "");
    return value === null ? [] : [[field.field, value]];
  }));
}

/**
 * The fields an edit changes, each with its value, null to clear it: those
 * whose value reads otherwise than it did, so 58.0 over 58, a space at either
 * end or an attribute row without a name is no edit. Only a field changed as
 * entered is read, so one the form cannot read is left as it is.
 */
function changedContent(fields: FormField[], initial: Values, values: Values): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      // Compared as entered first, so a Tool's attributes, a new list on every change, are unchanged once put back as they were.
      if (JSON.stringify(values[field.field]) === JSON.stringify(initial[field.field])) return [];
      const value = contentValue(field, values[field.field] ?? "");
      return JSON.stringify(value) === JSON.stringify(readable(field, initial[field.field] ?? "")) ? [] : [[field.field, value]];
    }),
  );
}

/** A field's initial value as the server takes it, or undefined where the form cannot read it, so any value read now differs. */
function readable(field: FormField, value: Value): unknown {
  try {
    return contentValue(field, value);
  } catch {
    return undefined;
  }
}

/** The inputs of a form of an item's fields. */
function ContentInputs({ fields, values, onChange }: { fields: FormField[]; values: Values; onChange(field: string, value: Value): void }) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const inputId = `${id}-${field.field}`;
        const value = values[field.field];
        if (field.kind === "attributes") {
          return <AttributeInputs key={field.field} label={field.label} pairs={Array.isArray(value) ? value : []} onChange={(pairs) => onChange(field.field, pairs)} />;
        }
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
              <Select value={value === "" && field.optional ? NOT_SET : String(value ?? "")} onValueChange={(chosen) => onChange(field.field, chosen === NOT_SET ? "" : chosen)}>
                <SelectTrigger id={inputId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.optional && <SelectItem value={NOT_SET}>Not set</SelectItem>}
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
                min={field.kind === "number" && !field.signed ? 0 : undefined}
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

/**
 * A Tool's attributes as rows of a name and a value, as DYE2's equipment page
 * edits them: a row is added or removed, and one left without a name is not
 * saved.
 */
function AttributeInputs({ label, pairs, onChange }: { label: string; pairs: Attribute[]; onChange(pairs: Attribute[]): void }) {
  const set = (index: number, change: Partial<Attribute>) => onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...change } : pair)));
  return (
    <fieldset className="grid gap-2 sm:col-span-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {pairs.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
      {pairs.map((pair, index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
          <Input aria-label={`Attribute ${index + 1} name`} placeholder="Name, such as Needles" value={pair.key} onChange={(event) => set(index, { key: event.target.value })} />
          <Input aria-label={`Attribute ${index + 1} value`} placeholder="Value, such as 8" value={pair.value} onChange={(event) => set(index, { value: event.target.value })} />
          <Button type="button" variant="outline" size="sm" aria-label={`Remove attribute ${index + 1}`} onClick={() => onChange(pairs.filter((_, at) => at !== index))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          Add an attribute
        </Button>
      </div>
    </fieldset>
  );
}

/** A refusal to show in a form, from what the server answered. */
export function failure(caught: unknown, otherwise: string): string {
  return caught instanceof Error ? caught.message : otherwise;
}

/**
 * A refusal of a Batch Code another batch that is not Archived holds, from
 * what the server answered, with a link to that batch; undefined for any
 * other refusal.
 */
export function codeTaken(caught: unknown, onFollow?: () => void): ReactNode | undefined {
  if (!(caught instanceof ApiError) || caught.status !== 409) return undefined;
  const existing = (caught.data as { existing?: unknown } | undefined)?.existing;
  if (typeof existing !== "object" || existing === null) return undefined;
  const { id, name, batchCode } = existing as { id?: unknown; name?: unknown; batchCode?: unknown };
  if (typeof id !== "string" || typeof batchCode !== "string") return undefined;
  return (
    <>
      Another batch holds the Batch Code {batchCode}:{" "}
      <Link to={`/library/bean-batches/${id}`} className="underline underline-offset-4" onClick={onFollow}>
        {typeof name === "string" ? name : "an unnamed batch"}
      </Link>
      . A code is one batch's until that batch is Archived.
    </>
  );
}

/**
 * A form's refusal, brought into view as it appears: a long form in a dialog
 * is submitted from its foot, with its head, where this is, scrolled away.
 * Once, as it is shown: a form clears its refusal as it is submitted again,
 * so each refusal is shown anew.
 */
export function FormError({ error }: { error: ReactNode }) {
  const shown = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Nothing returned: a browser whose scrollIntoView answers with a promise would hand React that as the effect's cleanup.
    shown.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <Alert ref={shown} variant="destructive">
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
  const [error, setError] = useState<ReactNode>();
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
      setError(codeTaken(caught) ?? failure(caught, "The changes could not be saved"));
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

/** Archives an item, offered nowhere from then on, or restores it, offered again where it was. `effect` says what Archiving does on tablets. */
export function ArchiveButton({
  path,
  name,
  archived,
  effect = "archived on every tablet that holds it",
  onDone,
}: {
  path: string;
  name: string;
  archived: boolean;
  effect?: string;
  onDone(): Promise<void> | void;
}) {
  const [error, setError] = useState<ReactNode>();
  async function change() {
    setError(undefined);
    try {
      await api("PUT", `${path}/archived`, { archived: !archived });
      await onDone();
    } catch (caught) {
      setError(codeTaken(caught) ?? failure(caught, archived ? "It could not be restored" : "It could not be Archived"));
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
          description={`It is offered nowhere from now on, and ${effect}, but kept, so past Shots still name it. It can be restored.`}
          confirmLabel="Archive"
          onConfirm={() => void change()}
        />
      )}
    </div>
  );
}

/**
 * An Admin's hard delete: the item is gone from the Library and every tablet
 * that holds it, refused while a Shot names it, or what `deletable` says.
 */
export function DeleteButton({
  path,
  name,
  what,
  back,
  deletable = "an item no Shot names",
}: {
  path: string;
  name: string;
  what?: string;
  back: string;
  deletable?: string;
}) {
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
        description={`${what === undefined ? "" : `${what} `}It is deleted from every tablet that holds it, now or once it connects, and cannot be restored. Only ${deletable} can be deleted; Archive any other.`}
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
 * Creates a batch of a Bean at the one Location chosen, with its remaining
 * weight there: Staff only at one of their own. A batch is at one Location
 * at a time. Without a Bean given, one is chosen from the Library's, but
 * those Archived.
 */
export function NewBatchDialog({ bean, beans }: { bean?: { id: string; name: string | null }; beans?: BeanSummary[] }) {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [open, setOpen] = useState(false);
  const [beanId, setBeanId] = useState(bean?.id ?? "");
  const [values, setValues] = useState<Values>(() => valuesOf(BATCH_FIELDS, {}));
  const [locationId, setLocationId] = useState("");
  /** The remaining weight typed; until one is, the roasted weight entered above. */
  const [weight, setWeight] = useState<string>();
  const [error, setError] = useState<ReactNode>();
  const [saving, setSaving] = useState(false);
  const id = useId();
  const allowed = (locations ?? []).filter((location) => mayChangeAt(location.id));
  const remaining = weight ?? (typeof values.weight === "string" ? values.weight : "");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (beanId === "") return setError("Choose its Bean");
    if (locationId === "") return setError("Choose the Location it is at");
    setSaving(true);
    setError(undefined);
    try {
      const placed = [{ locationId, ...(remaining.trim() === "" ? {} : { remainingWeight: Number(remaining) }) }];
      const { batch } = await api<{ batch: BeanBatch }>("POST", "/bean-batches", { beanId, content: newContent(BATCH_FIELDS, values), locations: placed });
      setOpen(false);
      void navigate(`/library/bean-batches/${batch.id}`);
    } catch (caught) {
      setError(codeTaken(caught, () => setOpen(false)) ?? failure(caught, "The batch could not be created"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={bean ? "outline" : "default"}>New Batch</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Batch{bean ? ` of ${bean.name ?? "Unnamed Bean"}` : ""}</DialogTitle>
          <DialogDescription>
            A roast of a Bean, written with its Bean to the tablets at the Location it is at. A batch is at one Location at a time: moving it
            to another later takes it away from this one.
          </DialogDescription>
        </DialogHeader>
        <form aria-label="New Batch" className="grid gap-4" onSubmit={create}>
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
          {locationsError && <FormError error={locationsError} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-at`}>At</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger id={`${id}-at`} className="w-full">
                  <SelectValue placeholder="Choose a Location" />
                </SelectTrigger>
                <SelectContent>
                  {allowed.map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-remaining`}>Remaining weight (g)</Label>
              <Input id={`${id}-remaining`} type="number" min={0} step="any" value={remaining} onChange={(event) => setWeight(event.target.value)} />
            </div>
          </div>
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

/** The existing Basket or Tool a new one would be, from a refusal. */
function existingEquipment(caught: unknown): { id: string; name: string | null; archived: boolean } | undefined {
  if (!(caught instanceof ApiError) || caught.status !== 409) return undefined;
  const existing = (caught.data as { existing?: unknown } | undefined)?.existing;
  return typeof existing === "object" && existing !== null && typeof (existing as { id?: unknown }).id === "string"
    ? (existing as { id: string; name: string | null; archived: boolean })
    : undefined;
}

/**
 * Creates a Basket or Tool, shown at the Location chosen only, as one entered
 * on a tablet there is: Staff only at their own. One whose name the Library
 * has is refused, with a link to that one, to show at the Location, or
 * restore if it is Archived.
 */
export function NewEquipmentDialog({ kind }: { kind: "basket" | "tool" }) {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const { name, api: apiPath, pages } = LIBRARY_KINDS[kind];
  const fields = kind === "basket" ? BASKET_FIELDS : TOOL_FIELDS;
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState("");
  const [values, setValues] = useState<Values>(() => valuesOf(fields, {}));
  const [error, setError] = useState<ReactNode>();
  const [saving, setSaving] = useState(false);
  const id = useId();

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locationId === "") return setError("Choose the Location it is shown at");
    setSaving(true);
    setError(undefined);
    try {
      const created = await api<Record<string, { id: string }>>("POST", apiPath, { locationId, content: newContent(fields, values) });
      setOpen(false);
      void navigate(`${pages}/${created[kind]!.id}`);
    } catch (caught) {
      const existing = existingEquipment(caught);
      setError(
        existing ? (
          <>
            The Library has this {name} already{existing.archived ? ", Archived" : ""}:{" "}
            <Link to={`${pages}/${existing.id}`} className="underline underline-offset-4" onClick={() => setOpen(false)}>
              {existing.name ?? `Unnamed ${name}`}
            </Link>
            . {existing.archived ? "Restore it on its page instead." : "Show it at the Location on its page instead."}
          </>
        ) : (
          failure(caught, `The ${name} could not be created`)
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New {name}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New {name}</DialogTitle>
          <DialogDescription>
            {kind === "basket" ? "A model of basket, one at every Location." : "A piece of gear, such as a WDT tool or a puck screen."} It is shown at the
            Location chosen, and written to that Location's tablets only, until it is shown elsewhere.
          </DialogDescription>
        </DialogHeader>
        <form aria-label={`New ${name}`} className="grid gap-4" onSubmit={create}>
          {error && <FormError error={error} />}
          {locationsError && <FormError error={locationsError} />}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-location`}>Shown at</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger id={`${id}-location`} className="w-full">
                <SelectValue placeholder="Choose a Location" />
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
          <ContentInputs fields={fields} values={values} onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))} />
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
 * Where a batch is: the one Location it is at, since when and where it was
 * moved from, with its remaining weight there. Where it was before is in
 * its history. A batch is at one Location at a time, so an Admin, or Staff
 * working at another Location, moves it there, which takes it away from this
 * one; one working where it is finishes it there, or sets its remaining
 * weight. One the previous release left at several Locations, until the
 * server settles it, is shown at each.
 */
export function BatchLocationsCard({ batch, onChanged }: { batch: BeanBatch; onChanged(): Promise<void> | void }) {
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const movable = (locations ?? []).filter((location) => mayChangeAt(location.id) && !batch.locations.some((here) => here.location.id === location.id));
  // The previous release's server, as may answer during a deploy, names none.
  const movedFrom = batch.movedFrom ?? [];

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
      await onChanged();
    } catch (caught) {
      setError(failure(caught, "Where the batch is could not be changed"));
    } finally {
      setBusy(false);
    }
  }

  const move = !batch.archived && movable.length > 0 && <MoveBatchDialog batch={batch} to={movable} onMoved={onChanged} />;
  return (
    <Card>
      <CardHeader>
        <CardTitleWithInfo title="Where it is">
          <p>
            A batch is at one Location at a time, from when it is added there until it is finished there or moved to another. Moving it
            takes it away from the Location it was at, with the remaining weight entered for it.
          </p>
          <p>The tablets at its Location hold it with that weight. Finished there or moved away, it is archived on them.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <FormError error={error} />}
        {locationsError && <FormError error={locationsError} />}
        {batch.locations.length === 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">It is at no Location.</p>
            {move}
          </div>
        )}
        {batch.locations.map((here, index) => {
          const { location } = here;
          const weight = weights[location.id] ?? (here.remainingWeight === null ? "" : String(here.remainingWeight));
          return (
            <div key={location.id} role="group" aria-label={`At ${location.name}`} className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="grid gap-0.5">
                  <Link to={`/locations/${location.id}`} className="text-lg font-semibold underline-offset-4 hover:underline">
                    {location.name}
                  </Link>
                  <span className="text-sm text-muted-foreground">
                    Since {formatTime(here.since)}.{index === 0 && movedFrom.length > 0 && ` Moved from ${listed(movedFrom.map((left) => left.name))}.`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {index === 0 && move}
                  {mayChangeAt(location.id) && (
                    <Button type="button" variant="outline" disabled={busy} aria-label={`Finish it at ${location.name}`} onClick={() => void place(location, { atLocation: false })}>
                      Finish here
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-4">
                <div className="grid gap-0.5">
                  <span className="text-sm text-muted-foreground">Remaining weight</span>
                  <span className="text-2xl font-semibold">{weightText(here.remainingWeight)}</span>
                </div>
                {mayChangeAt(location.id) && (
                  <form
                    className="flex items-center gap-2"
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
                    <Button type="submit" variant="outline" disabled={busy} aria-label={`Set the remaining weight at ${location.name}`}>
                      Set
                    </Button>
                  </form>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * Moves a batch to another Location, one of those the account may move it
 * to (`to`): it is taken away from the Location it is at, whose tablets stop
 * offering it, and its remaining weight goes with it unless another is
 * entered.
 */
function MoveBatchDialog({ batch, to, onMoved }: { batch: BeanBatch; to: Location[]; onMoved(): Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [weight, setWeight] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  const here = batch.locations[0];
  const location = to.find((candidate) => candidate.id === target);
  const from = listed(batch.locations.map((at) => at.location.name));

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!location) return setError("Choose the Location to move it to");
    setSaving(true);
    setError(undefined);
    try {
      await api("PUT", `/bean-batches/${batch.id}/locations/${location.id}`, { atLocation: true, ...(weight.trim() === "" ? {} : { remainingWeight: Number(weight) }) });
      setOpen(false);
      setTarget("");
      setWeight("");
      await onMoved();
    } catch (caught) {
      setError(failure(caught, "The batch could not be moved"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Move to…</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move this batch</DialogTitle>
          <DialogDescription>
            {batchName(batch)}
            {batch.batchCode !== null && ` (${batch.batchCode})`}{" "}
            {here ? `is at ${from}. A batch is at one Location at a time, so moving it takes it away from ${from}.` : "is at no Location. A batch is at one Location at a time."}
          </DialogDescription>
        </DialogHeader>
        <form aria-label="Move this batch" className="grid gap-4" onSubmit={move}>
          {error && <FormError error={error} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`${id}-to`}>Move to</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id={`${id}-to`} className="w-full">
                  <SelectValue placeholder="Choose a Location" />
                </SelectTrigger>
                <SelectContent>
                  {to.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-weight`}>Weight on arrival, in grams</Label>
              <Input
                id={`${id}-weight`}
                type="number"
                min={0}
                step="any"
                placeholder={here && here.remainingWeight !== null ? String(here.remainingWeight) : undefined}
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
            </div>
          </div>
          {here && (
            <ul className="grid list-disc gap-1.5 rounded-md bg-muted py-3 pr-4 pl-8 text-sm">
              <li>
                {here.remainingWeight === null
                  ? "No remaining weight is entered for it, and none is after the move unless you enter one."
                  : `Its remaining weight, ${here.remainingWeight} g, goes with it unless you enter another.`}
              </li>
              <li>Recipes at {from} that name it go on naming it.</li>
              <li>{from}&apos;s tablets stop offering it.</li>
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !location}>
              {location ? `Move to ${location.name}` : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
