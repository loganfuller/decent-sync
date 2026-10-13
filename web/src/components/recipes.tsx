import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { batchName } from "@/components/bean-batches";
import { ItemConflictsCard, ItemHistoryCard, attributePairs } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { grinderName } from "@/components/grinders";
import { ArchiveButton, type Attribute, FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { ConfirmButton, formatTime } from "@/components/machines";
import { profilePath, profileTitle } from "@/components/profiles";
import { OrNone } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ApiError,
  api,
  type BeanBatchSummary,
  type BeanSummary,
  type EquipmentSummary,
  type GrinderSummary,
  type Location,
  type ProfileSummary,
  type Recipe,
} from "@/lib/api";
import { LIBRARY_KINDS } from "@/lib/library-kinds";

// Each Location's Recipes, DYE2's recipes, in its Recipe Slots or none, and
// each Recipe's page. An Admin, or Staff working at its Location, creates
// and edits a Recipe there with every field DYE2 has but steam, flush, the
// barista and the drinker, moves it between slots, takes it out of its slot,
// and Archives and restores it; each change reaches every tablet there.
// Picking a Bean Batch, Profile, Basket or Tool its Location does not offer
// offers it there, as the form says before saving.

/** The highest Recipe Slot DYE2's recipe editor edits; its dashboard and Streamline's strip show every slot. */
export const EDITABLE_SLOTS = 5;

/** A Recipe's name as lists show it. */
export function recipeName(recipe: Pick<Recipe, "name">): string {
  return recipe.name ?? "Unnamed Recipe";
}

/** What may need someone's attention about a Recipe. */
export function RecipeBadges({ recipe }: { recipe: Recipe }) {
  return (
    <div className="flex flex-wrap gap-1">
      {recipe.archived && <Badge variant="secondary">Archived</Badge>}
      {recipe.slot !== null && recipe.slot > EDITABLE_SLOTS && <Badge variant="outline">Not editable in DYE2's recipe editor</Badge>}
      {recipe.batchFinished && <Badge variant="destructive">Batch finished here</Badge>}
    </div>
  );
}

/** Where a Recipe is, such as "Slot 3 at Uptown". */
function placeText(recipe: Recipe): string {
  const here = recipe.location?.name ?? "a Location since removed";
  if (recipe.archived) return `Archived, kept at ${here} in no slot`;
  return recipe.slot === null ? `In no slot at ${here}` : `Slot ${recipe.slot} at ${here}`;
}

function numberText(value: unknown, unit: string): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${value}${unit}` : undefined;
}

/** A Recipe's dose and yield, with DYE2's ratio where it keeps one, such as "18 g → 40 g (1:2.2)". */
function dialText(content: Record<string, unknown>): string | undefined {
  const dose = numberText(content.dose, " g");
  const drink = numberText(content.yield, " g");
  if (dose === undefined && drink === undefined) return undefined;
  const ratio = typeof content.ratio === "number" ? ` (1:${content.ratio})` : "";
  return `${dose ?? "-"} → ${drink ?? "-"}${ratio}`;
}

/** A Recipe's Grinder and its setting, such as "EK43 at 2.5". */
function grindText(recipe: Recipe): string | undefined {
  const setting = typeof recipe.content.grindSetting === "number" ? String(recipe.content.grindSetting) : undefined;
  const grinder = recipe.uses.grinder ? (recipe.uses.grinder.model ?? "Unnamed Grinder") : undefined;
  if (grinder === undefined) return setting === undefined ? undefined : `Setting ${setting}`;
  return setting === undefined ? grinder : `${grinder} at ${setting}`;
}

/** A Recipe's Bean Batch, as lists name a batch. */
function usedBatchText(recipe: Recipe): string | undefined {
  const { beanBatch, bean } = recipe.uses;
  if (beanBatch) return batchName({ bean: { id: bean?.id ?? "", roaster: bean?.roaster ?? null, name: bean?.name ?? null }, roastDate: beanBatch.roastDate });
  return bean ? `${bean.name ?? "Unnamed Bean"}, no batch` : undefined;
}

/** A link to an item's page, named as given. */
function ItemLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

/**
 * Each Location's Recipes on its page: its Recipe Slots, in slot order, which
 * every tablet there holds, and its Recipes in no slot, kept there. An Admin,
 * or Staff working there, creates one there.
 */
export function LocationRecipesCard({ location, recipes, onChanged }: { location: Location; recipes: Recipe[]; onChanged(): Promise<void> | void }) {
  const mayChange = useMayChangeAt()(location.id);
  const slotted = recipes.filter((recipe) => recipe.slot !== null);
  const unslotted = recipes.filter((recipe) => recipe.slot === null);
  return (
    <Card role="region" aria-label="Recipes">
      <CardHeader>
        <CardTitle>
          <h2>Recipes</h2>
        </CardTitle>
        <CardDescription>
          Its Recipe Slots, which every tablet here holds in slot order, and the Recipes kept here in no slot. DYE2's recipe editor edits slots 1
          to {EDITABLE_SLOTS}; its dashboard and Streamline's strip show every slot.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {mayChange && (
          <div>
            <RecipeFormDialog location={location} recipes={recipes} onSaved={onChanged} />
          </div>
        )}
        {slotted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Recipe is in a slot here yet.</p>
        ) : (
          <RecipesTable label="Recipe Slots" recipes={slotted} slots />
        )}
        {unslotted.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">In no slot</h3>
            <RecipesTable label="Recipes in no slot" recipes={unslotted} slots={false} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecipesTable({ label, recipes, slots }: { label: string; recipes: Recipe[]; slots: boolean }) {
  const { pages } = LIBRARY_KINDS.recipe;
  return (
    <div className="rounded-lg border">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {slots && <TableHead>Slot</TableHead>}
            <TableHead>Recipe</TableHead>
            <TableHead>Bean Batch</TableHead>
            <TableHead>Profile</TableHead>
            <TableHead>Dose and yield</TableHead>
            <TableHead>Grinder</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recipes.map((recipe) => (
            <TableRow key={recipe.id}>
              {slots && <TableCell className="font-medium">{recipe.slot}</TableCell>}
              <TableCell className="font-medium">
                <ItemLink to={`${pages}/${recipe.id}`}>{recipeName(recipe)}</ItemLink>
              </TableCell>
              <TableCell className="whitespace-normal">
                <OrNone>{usedBatchText(recipe)}</OrNone>
              </TableCell>
              <TableCell className="whitespace-normal">
                <OrNone>{recipe.uses.profile ? profileTitle(recipe.uses.profile) : undefined}</OrNone>
              </TableCell>
              <TableCell>
                <OrNone>{dialText(recipe.content)}</OrNone>
              </TableCell>
              <TableCell>
                <OrNone>{grindText(recipe)}</OrNone>
              </TableCell>
              <TableCell>
                <RecipeBadges recipe={recipe} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** What the Recipe form picks from: the Library's batches, with their Beans, Profiles, Grinders, Baskets and Tools. */
interface Choices {
  batches: BeanBatchSummary[];
  beans: BeanSummary[];
  profiles: ProfileSummary[];
  grinders: GrinderSummary[];
  baskets: EquipmentSummary[];
  tools: EquipmentSummary[];
}

/** Loads what a Recipe may use, once. */
function useChoices(): { choices: Choices | undefined; error: string | undefined } {
  const [choices, setChoices] = useState<Choices>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    Promise.all([
      api<{ batches: BeanBatchSummary[] }>("GET", "/bean-batches"),
      api<{ beans: BeanSummary[] }>("GET", "/beans"),
      api<{ profiles: ProfileSummary[] }>("GET", "/profiles"),
      api<{ grinders: GrinderSummary[] }>("GET", "/grinders"),
      api<{ baskets: EquipmentSummary[] }>("GET", "/baskets"),
      api<{ tools: EquipmentSummary[] }>("GET", "/tools"),
    ]).then(
      ([{ batches }, { beans }, { profiles }, { grinders }, { baskets }, { tools }]) => current && setChoices({ batches, beans, profiles, grinders, baskets, tools }),
      (caught: unknown) => current && setError(failure(caught, "What a Recipe may use could not be loaded")),
    );
    return () => {
      current = false;
    };
  }, []);
  return { choices, error };
}

/** The names of the items a Recipe may name, by id, for its history. */
function namesOf(choices: Choices | undefined): ReadonlyMap<string, string> {
  if (!choices) return new Map();
  return new Map<string, string>([
    ...choices.batches.flatMap((batch) => [
      [batch.id, batchName(batch)] as [string, string],
      [batch.bean.id, batch.bean.name ?? "Unnamed Bean"] as [string, string],
    ]),
    ...choices.profiles.map((profile) => [profile.id, profileTitle(profile)] as [string, string]),
    ...choices.grinders.map((grinder) => [grinder.id, grinderName(grinder)] as [string, string]),
    ...choices.baskets.map((basket) => [basket.id, basket.name ?? "Unnamed Basket"] as [string, string]),
    ...choices.tools.map((tool) => [tool.id, tool.name ?? "Unnamed Tool"] as [string, string]),
  ]);
}

/** Stands for no item, as a Select's options each need a value. */
const NONE = "none";

/** The Recipe form's values: each field as its input holds it. */
interface FormValues {
  name: string;
  beverage: string;
  beanBatchId: string;
  profileId: string;
  dose: string;
  yield: string;
  grinderId: string;
  grindSetting: string;
  rpm: string;
  brewTemperature: string;
  basketId: string;
  toolIds: string[];
  /** Each picked Tool's attributes for this Recipe, by the Tool's id. */
  toolAttributes: Record<string, Attribute[]>;
  hotWaterMode: string;
  hotWaterVolume: string;
  hotWaterTemperature: string;
  hotWaterDuration: string;
  hotWaterFlow: string;
  showOnDashboard: boolean;
}

/** The fields the form reads as numbers, each with its label. */
const NUMBERS = [
  ["dose", "Dose (g)"],
  ["yield", "Yield (g)"],
  ["grindSetting", "Grind setting"],
  ["rpm", "RPM"],
  ["brewTemperature", "Brew temperature (°C)"],
  ["hotWaterVolume", "Hot water volume (ml)"],
  ["hotWaterTemperature", "Hot water temperature (°C)"],
  ["hotWaterDuration", "Hot water duration (s)"],
  ["hotWaterFlow", "Hot water flow (ml/s)"],
] as const satisfies readonly (readonly [keyof FormValues, string])[];

type NumberField = (typeof NUMBERS)[number][0];

const LABELS: Readonly<Record<NumberField, string>> = Object.fromEntries(NUMBERS) as Record<NumberField, string>;

/** The form's values for a Recipe's content, or a new one's. */
function valuesOf(content: Record<string, unknown>): FormValues {
  const text = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : "");
  const id = (key: string) => (typeof content[key] === "string" ? (content[key] as string) : NONE);
  const number = (key: string) => (typeof content[key] === "number" ? String(content[key]) : "");
  const attributes: Record<string, Attribute[]> = {};
  if (typeof content.toolAttributes === "object" && content.toolAttributes !== null) {
    for (const [tool, pairs] of Object.entries(content.toolAttributes)) attributes[tool] = attributePairs(pairs) ?? [];
  }
  return {
    name: text("name"),
    beverage: text("beverage"),
    beanBatchId: id("beanBatchId"),
    profileId: id("profileId"),
    dose: number("dose"),
    yield: number("yield"),
    grinderId: id("grinderId"),
    grindSetting: number("grindSetting"),
    rpm: number("rpm"),
    brewTemperature: number("brewTemperature"),
    basketId: id("basketId"),
    toolIds: Array.isArray(content.toolIds) ? content.toolIds.filter((tool): tool is string => typeof tool === "string") : [],
    toolAttributes: attributes,
    hotWaterMode: content.hotWaterMode === "temp" ? "temp" : "vol",
    hotWaterVolume: number("hotWaterVolume"),
    hotWaterTemperature: number("hotWaterTemperature"),
    hotWaterDuration: number("hotWaterDuration"),
    hotWaterFlow: number("hotWaterFlow"),
    showOnDashboard: content.showOnDashboard !== false,
  };
}

/** The Tool's own attributes, DYE2's `custom`. */
function toolDefaults(tool: EquipmentSummary | undefined): Attribute[] {
  return attributePairs(tool?.content.custom) ?? [];
}

/**
 * The content the form's values set, each field as the server takes it, null
 * to clear it: a number entered that is not one is refused, so nothing typed
 * is lost unseen. A Tool's attributes are kept only where they differ from
 * the Tool's own, as DYE2's editor keeps those changed for a recipe.
 */
function contentOf(values: FormValues, tools: EquipmentSummary[]): Record<string, unknown> {
  const content: Record<string, unknown> = {
    name: values.name.trim() === "" ? null : values.name.trim(),
    beverage: values.beverage.trim() === "" ? null : values.beverage.trim(),
    beanBatchId: values.beanBatchId === NONE ? null : values.beanBatchId,
    profileId: values.profileId === NONE ? null : values.profileId,
    grinderId: values.grinderId === NONE ? null : values.grinderId,
    basketId: values.basketId === NONE ? null : values.basketId,
    toolIds: values.toolIds,
    toolAttributes: Object.fromEntries(
      values.toolIds.flatMap((tool) => {
        const pairs = (values.toolAttributes[tool] ?? []).map((pair) => ({ key: pair.key, value: pair.value.trim() }));
        const own = toolDefaults(tools.find((candidate) => candidate.id === tool));
        return pairs.length === 0 || JSON.stringify(pairs) === JSON.stringify(own) ? [] : [[tool, pairs]];
      }),
    ),
    hotWaterMode: values.hotWaterMode,
    showOnDashboard: values.showOnDashboard,
  };
  for (const [field, label] of NUMBERS) {
    const text = values[field].trim();
    if (text === "") {
      content[field] = null;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a number of 0 or more`);
    content[field] = value;
  }
  return content;
}

/** The fields an edit changes: those whose value reads otherwise than the Recipe's content now. */
function changedContent(initial: FormValues, values: FormValues, tools: EquipmentSummary[]): Record<string, unknown> {
  const before = contentOf(initial, tools);
  const after = contentOf(values, tools);
  return Object.fromEntries(Object.entries(after).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field])));
}

/** How the form puts a new Recipe in a slot: the lowest free one, none, or one chosen. */
type SlotMode = "next" | "none" | "chosen";

/** The lowest Recipe Slot none of these Recipes is in. */
function lowestFree(recipes: readonly Pick<Recipe, "id" | "slot">[], except?: string): number {
  const taken = new Set(recipes.filter((recipe) => recipe.id !== except).map((recipe) => recipe.slot));
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

/** A slot number entered, or undefined for none that is a whole number from 1. */
function slotEntered(text: string): number | undefined {
  return /^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : undefined;
}

/** What a slot chosen means: the Recipe there leaves it, and above 5 DYE2's editor cannot edit it. */
function SlotNotes({ slot, there, swappedTo }: { slot: number | undefined; there: Recipe | undefined; swappedTo: number | null }) {
  const notes: string[] = [];
  if (there) notes.push(`Slot ${slot} holds ${recipeName(there)}, which ${swappedTo === null ? "is taken out of its slot and kept here" : `moves to slot ${swappedTo}`}.`);
  if (slot !== undefined && slot > EDITABLE_SLOTS) {
    notes.push(`Slot ${slot} is not editable in DYE2's recipe editor, though DYE2's dashboard and Streamline's strip show it.`);
  }
  if (notes.length === 0) return null;
  return (
    <ul aria-label="About this slot" className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/**
 * Creates a Recipe at a Location, in a slot or none, or edits one: every field
 * DYE2 has but steam, flush, the barista and the drinker. It offers the
 * Location's Grinders only; a Bean Batch, Profile, Basket or Tool the
 * Location does not offer is offered there once saved, which it says first.
 */
export function RecipeFormDialog({
  location,
  recipes,
  recipe,
  onSaved,
}: {
  location: Location;
  /** The Location's Recipes, for what a slot chosen holds. */
  recipes: Recipe[];
  /** The Recipe edited; none to create one. */
  recipe?: Recipe;
  onSaved(): Promise<void> | void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const title = recipe ? `Edit ${recipeName(recipe)}` : "New Recipe";
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={recipe ? "outline" : "default"} aria-label={recipe ? "Edit the Recipe" : undefined}>
          {recipe ? "Edit" : "New Recipe"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {recipe ? "Each field changed is an edit made here," : `A Recipe at ${location.name},`} written to every tablet at {location.name}
            {recipe ? " that holds it." : " once it is in a slot."} Steam and flush are the Location's settings, and a Recipe carries no barista or
            drinker.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <RecipeForm
            location={location}
            recipes={recipes}
            recipe={recipe}
            label={title}
            onSaved={async (id) => {
              setOpen(false);
              await onSaved();
              if (!recipe) void navigate(`${LIBRARY_KINDS.recipe.pages}/${id}`);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RecipeForm({
  location,
  recipes,
  recipe,
  label,
  onSaved,
}: {
  location: Location;
  recipes: Recipe[];
  recipe?: Recipe;
  label: string;
  onSaved(id: string): Promise<void>;
}) {
  const { choices, error: choicesError } = useChoices();
  const [initial] = useState(() => valuesOf(recipe?.content ?? { showOnDashboard: true, hotWaterMode: "vol" }));
  const [values, setValues] = useState(initial);
  const [slotMode, setSlotMode] = useState<SlotMode>("next");
  const [slotText, setSlotText] = useState("");
  const [error, setError] = useState<ReactNode>();
  const [saving, setSaving] = useState(false);
  const id = useId();
  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) => setValues((current) => ({ ...current, [field]: value }));
  const here = location.id;

  const slot = slotMode === "next" ? lowestFree(recipes) : slotMode === "chosen" ? slotEntered(slotText) : undefined;
  const there = slot === undefined ? undefined : recipes.find((candidate) => candidate.slot === slot);

  // What this Location offers of each kind, and the rest, which saving offers here; Archived items, and the batches of
  // an Archived Bean, are offered nowhere.
  const archivedBeans = new Set((choices?.beans ?? []).filter((bean) => bean.archived).map((bean) => bean.id));
  const batches = (choices?.batches ?? []).filter((batch) => !batch.archived && !archivedBeans.has(batch.bean.id));
  const batchHere = (batch: BeanBatchSummary) => batch.locations.some((at) => at.location.id === here);
  const profiles = (choices?.profiles ?? []).filter((profile) => !profile.archived);
  const shownHere = (item: { shownAt: { location: { id: string } }[] }) => item.shownAt.some((at) => at.location.id === here);
  const grinders = (choices?.grinders ?? []).filter((grinder) => grinder.location?.id === here && !grinder.archived);
  const baskets = (choices?.baskets ?? []).filter((basket) => !basket.archived);
  const tools = (choices?.tools ?? []).filter((tool) => !tool.archived);
  // Tools the Recipe uses that are offered nowhere now, as one Archived since: kept, or unchecked to drop them, never picked anew.
  const keptTools = (choices ? initial.toolIds : [])
    .filter((toolId) => !tools.some((tool) => tool.id === toolId))
    .map((toolId) => ({ id: toolId, name: choices?.tools.find((tool) => tool.id === toolId)?.name ?? recipe?.uses.tools.find((tool) => tool.id === toolId)?.name ?? null }));

  // What saving offers here that it does not offer now: only what this form changes.
  const offered: string[] = [];
  if (values.beanBatchId !== initial.beanBatchId) {
    const batch = batches.find((candidate) => candidate.id === values.beanBatchId);
    if (batch && !batchHere(batch)) offered.push(`adds the Bean Batch ${batchName(batch)} at ${location.name}`);
  }
  if (values.profileId !== initial.profileId) {
    const profile = profiles.find((candidate) => candidate.id === values.profileId);
    if (profile && !shownHere(profile)) offered.push(`shows the Profile ${profileTitle(profile)} at ${location.name}`);
  }
  if (values.basketId !== initial.basketId) {
    const basket = baskets.find((candidate) => candidate.id === values.basketId);
    if (basket && !shownHere(basket)) offered.push(`shows the Basket ${basket.name ?? "Unnamed Basket"} at ${location.name}`);
  }
  for (const toolId of values.toolIds) {
    const tool = tools.find((candidate) => candidate.id === toolId);
    if (tool && !initial.toolIds.includes(toolId) && !shownHere(tool)) offered.push(`shows the Tool ${tool.name ?? "Unnamed Tool"} at ${location.name}`);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (slotMode === "chosen" && slot === undefined) return setError("Enter the slot as a whole number from 1");
    let content: Record<string, unknown>;
    try {
      content = recipe ? changedContent(initial, values, choices?.tools ?? []) : contentOf(values, choices?.tools ?? []);
    } catch (caught) {
      return setError(failure(caught, "The Recipe could not be read"));
    }
    if (recipe && Object.keys(content).length === 0) return onSaved(recipe.id);
    setSaving(true);
    try {
      if (recipe) {
        await api("PATCH", `/recipes/${recipe.id}`, { content });
        await onSaved(recipe.id);
      } else {
        // A new Recipe holds only what was entered.
        const entered = Object.fromEntries(Object.entries(content).filter(([, value]) => value !== null));
        const created = await api<{ recipe: Recipe }>("POST", "/recipes", { locationId: here, slot: slotMode === "next" ? "next" : (slot ?? null), content: entered });
        await onSaved(created.recipe.id);
      }
    } catch (caught) {
      setError(failure(caught, "The Recipe could not be saved"));
    } finally {
      setSaving(false);
    }
  }

  const numberInput = (field: NumberField) => (
    <div key={field} className="grid gap-2">
      <Label htmlFor={`${id}-${field}`}>{LABELS[field]}</Label>
      <Input
        id={`${id}-${field}`}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={values[field]}
        onChange={(event) => set(field, event.target.value)}
      />
    </div>
  );

  return (
    <form aria-label={label} className="grid gap-5" onSubmit={save}>
      {error && <FormError error={error} />}
      {choicesError && <FormError error={choicesError} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={values.name} onChange={(event) => set("name", event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-beverage`}>Beverage</Label>
          <Input id={`${id}-beverage`} placeholder="Such as Cappuccino" value={values.beverage} onChange={(event) => set("beverage", event.target.value)} />
        </div>

        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${id}-batch`}>Bean Batch</Label>
          <Select value={values.beanBatchId} onValueChange={(value) => set("beanBatchId", value)}>
            <SelectTrigger id={`${id}-batch`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {values.beanBatchId !== NONE && !batches.some((batch) => batch.id === values.beanBatchId) && (
                <SelectItem value={values.beanBatchId}>{recipe ? (usedBatchText(recipe) ?? "Its batch now") : "Its batch now"}</SelectItem>
              )}
              <ChoiceGroup label={`At ${location.name}`} items={batches.filter(batchHere).map((batch) => [batch.id, batchName(batch)])} />
              <ChoiceGroup
                label={`Elsewhere: saving adds it at ${location.name}`}
                items={batches.filter((batch) => !batchHere(batch)).map((batch) => [batch.id, `${batchName(batch)} (adds it here)`])}
              />
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${id}-profile`}>Profile</Label>
          <Select value={values.profileId} onValueChange={(value) => set("profileId", value)}>
            <SelectTrigger id={`${id}-profile`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {values.profileId !== NONE && !profiles.some((profile) => profile.id === values.profileId) && (
                <SelectItem value={values.profileId}>{recipe?.uses.profile ? profileTitle(recipe.uses.profile) : "Its Profile now"}</SelectItem>
              )}
              <ChoiceGroup label={`Shown at ${location.name}`} items={profiles.filter(shownHere).map((profile) => [profile.id, profileTitle(profile)])} />
              <ChoiceGroup
                label={`Not shown here: saving shows it at ${location.name}`}
                items={profiles.filter((profile) => !shownHere(profile)).map((profile) => [profile.id, `${profileTitle(profile)} (shows it here)`])}
              />
            </SelectContent>
          </Select>
        </div>

        {numberInput("dose")}
        {numberInput("yield")}

        <div className="grid gap-2">
          <Label htmlFor={`${id}-grinder`}>Grinder</Label>
          <Select value={values.grinderId} onValueChange={(value) => set("grinderId", value)}>
            <SelectTrigger id={`${id}-grinder`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {values.grinderId !== NONE && !grinders.some((grinder) => grinder.id === values.grinderId) && (
                <SelectItem value={values.grinderId}>{recipe?.uses.grinder ? grinderName(recipe.uses.grinder) : "Its Grinder now"}</SelectItem>
              )}
              {grinders.map((grinder) => (
                <SelectItem key={grinder.id} value={grinder.id}>
                  {grinderName(grinder)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {numberInput("grindSetting")}
        {numberInput("rpm")}
        {numberInput("brewTemperature")}

        <div className="grid gap-2 sm:col-span-2">
          <Label htmlFor={`${id}-basket`}>Basket</Label>
          <Select value={values.basketId} onValueChange={(value) => set("basketId", value)}>
            <SelectTrigger id={`${id}-basket`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {values.basketId !== NONE && !baskets.some((basket) => basket.id === values.basketId) && (
                <SelectItem value={values.basketId}>{recipe?.uses.basket?.name ?? "Its Basket now"}</SelectItem>
              )}
              <ChoiceGroup label={`Shown at ${location.name}`} items={baskets.filter(shownHere).map((basket) => [basket.id, basket.name ?? "Unnamed Basket"])} />
              <ChoiceGroup
                label={`Not shown here: saving shows it at ${location.name}`}
                items={baskets.filter((basket) => !shownHere(basket)).map((basket) => [basket.id, `${basket.name ?? "Unnamed Basket"} (shows it here)`])}
              />
            </SelectContent>
          </Select>
        </div>

        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Tools</legend>
          {tools.length === 0 && keptTools.length === 0 && <p className="text-sm text-muted-foreground">The Library has no Tools yet.</p>}
          {keptTools.map((tool) => {
            const checked = values.toolIds.includes(tool.id);
            return (
              <div key={tool.id} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-tool-${tool.id}`}
                  checked={checked}
                  disabled={!checked}
                  onCheckedChange={(value) =>
                    value !== true && setValues((current) => ({ ...current, toolIds: current.toolIds.filter((candidate) => candidate !== tool.id) }))
                  }
                />
                <Label htmlFor={`${id}-tool-${tool.id}`}>
                  {tool.name ?? "Unnamed Tool"}
                  <span className="font-normal text-muted-foreground"> (Archived: uncheck it to drop it)</span>
                </Label>
              </div>
            );
          })}
          {tools.map((tool) => {
            const checked = values.toolIds.includes(tool.id);
            const toolName = tool.name ?? "Unnamed Tool";
            const pairs = values.toolAttributes[tool.id] ?? toolDefaults(tool);
            return (
              <div key={tool.id} className="grid gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-tool-${tool.id}`}
                    checked={checked}
                    onCheckedChange={(value) =>
                      setValues((current) => ({
                        ...current,
                        toolIds: value === true ? [...current.toolIds, tool.id] : current.toolIds.filter((candidate) => candidate !== tool.id),
                      }))
                    }
                  />
                  <Label htmlFor={`${id}-tool-${tool.id}`}>
                    {toolName}
                    {!shownHere(tool) && <span className="font-normal text-muted-foreground"> (saving shows it here)</span>}
                  </Label>
                </div>
                {checked && pairs.length > 0 && (
                  <div className="grid gap-2 pl-6 sm:grid-cols-2">
                    {pairs.map((pair, index) => (
                      <div key={`${pair.key}-${index}`} className="grid gap-1">
                        <Label htmlFor={`${id}-tool-${tool.id}-${index}`} className="text-xs text-muted-foreground">
                          {toolName}: {pair.key}
                        </Label>
                        <Input
                          id={`${id}-tool-${tool.id}-${index}`}
                          value={pair.value}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              toolAttributes: {
                                ...current.toolAttributes,
                                [tool.id]: pairs.map((candidate, at) => (at === index ? { ...candidate, value: event.target.value } : candidate)),
                              },
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor={`${id}-hot-water-mode`}>Hot water by</Label>
          <Select value={values.hotWaterMode} onValueChange={(value) => set("hotWaterMode", value)}>
            <SelectTrigger id={`${id}-hot-water-mode`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vol">Volume</SelectItem>
              <SelectItem value="temp">Temperature</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {numberInput("hotWaterVolume")}
        {numberInput("hotWaterTemperature")}
        {numberInput("hotWaterDuration")}
        {numberInput("hotWaterFlow")}

        <div className="flex items-center gap-2 self-end py-1.5">
          <Switch id={`${id}-dashboard`} checked={values.showOnDashboard} onCheckedChange={(checked) => set("showOnDashboard", checked)} />
          <Label htmlFor={`${id}-dashboard`}>Shown on the dashboard</Label>
        </div>
      </div>

      {!recipe && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-slot-mode`}>Recipe Slot</Label>
            <Select value={slotMode} onValueChange={(value) => setSlotMode(value as SlotMode)}>
              <SelectTrigger id={`${id}-slot-mode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="next">The next free slot ({lowestFree(recipes)})</SelectItem>
                <SelectItem value="chosen">A slot of my choosing</SelectItem>
                <SelectItem value="none">No slot: kept here only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {slotMode === "chosen" && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-slot`}>Slot</Label>
              <Input id={`${id}-slot`} type="number" inputMode="numeric" min={1} step={1} value={slotText} onChange={(event) => setSlotText(event.target.value)} />
            </div>
          )}
          <div className="sm:col-span-2">
            <SlotNotes slot={slot} there={there} swappedTo={null} />
          </div>
        </div>
      )}

      {offered.length > 0 && (
        <Alert role="status" aria-label="Saving also">
          <AlertDescription>
            <p>Saving also:</p>
            <ul className="list-disc pl-5">
              {offered.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div>
        <Button type="submit" disabled={saving || !choices}>
          {recipe ? "Save" : "Create"}
        </Button>
      </div>
    </form>
  );
}

/** A group of a Select's options under a label; nothing where it has none. */
function ChoiceGroup({ label, items }: { label: string; items: [value: string, text: string][] }) {
  if (items.length === 0) return null;
  return (
    <SelectGroup>
      <SelectLabel>{label}</SelectLabel>
      {items.map(([value, text]) => (
        <SelectItem key={value} value={value}>
          {text}
        </SelectItem>
      ))}
    </SelectGroup>
  );
}

/**
 * Moves a Recipe to a slot at its Location, swapping it with the Recipe
 * there, or to the lowest free slot; the Recipe keeps its id and history.
 */
function MoveRecipeDialog({ recipe, recipes, onMoved }: { recipe: Recipe; recipes: Recipe[]; onMoved(): Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"next" | "chosen">("chosen");
  const [slotText, setSlotText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const id = useId();
  const free = lowestFree(recipes, recipe.id);
  const slot = mode === "next" ? free : slotEntered(slotText);
  const there = slot === undefined ? undefined : recipes.find((candidate) => candidate.slot === slot && candidate.id !== recipe.id);

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (slot === undefined) return setError("Enter the slot as a whole number from 1");
    setSaving(true);
    setError(undefined);
    try {
      await api("PUT", `/recipes/${recipe.id}/slot`, { slot: mode === "next" ? "next" : slot });
      setOpen(false);
      await onMoved();
    } catch (caught) {
      setError(failure(caught, "The Recipe could not be moved"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">{recipe.slot === null ? "Put in a slot" : "Move to a slot"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{recipe.slot === null ? `Put ${recipeName(recipe)} in a slot` : `Move ${recipeName(recipe)} to a slot`}</DialogTitle>
          <DialogDescription>
            Every tablet at {recipe.location?.name ?? "its Location"} holds it in its new slot. It keeps its history.
          </DialogDescription>
        </DialogHeader>
        <form aria-label="Move the Recipe" className="grid gap-4" onSubmit={move}>
          {error && <FormError error={error} />}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-mode`}>Move it to</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as "next" | "chosen")}>
              <SelectTrigger id={`${id}-mode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chosen">A slot of my choosing</SelectItem>
                <SelectItem value="next">The next free slot ({free})</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === "chosen" && (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-slot`}>Slot</Label>
              <Input id={`${id}-slot`} type="number" inputMode="numeric" min={1} step={1} value={slotText} onChange={(event) => setSlotText(event.target.value)} />
            </div>
          )}
          <SlotNotes slot={slot} there={there} swappedTo={recipe.slot} />
          <div>
            <Button type="submit" disabled={saving || slot === recipe.slot}>
              Move
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One Recipe: where it is, its fields, its open Conflicts and its history.
 * An Admin, or Staff working at its Location, edits it, moves it to another
 * slot or takes it out of its slot, and Archives or restores it.
 */
export function RecipeDetails({ id }: { id: string }) {
  const mayChangeAt = useMayChangeAt();
  const { choices } = useChoices();
  const names = useMemo(() => namesOf(choices), [choices]);
  const [loaded, setLoaded] = useState<{ recipe: Recipe; recipes: Recipe[] }>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  // A change here, or using a Conflict's value, changes the Recipe, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const changed = useCallback(() => setChanges((count) => count + 1), []);

  useEffect(() => {
    let current = true;
    (async () => {
      const { recipe } = await api<{ recipe: Recipe }>("GET", `/recipes/${encodeURIComponent(id)}`);
      const { recipes } = recipe.location ? await api<{ recipes: Recipe[] }>("GET", `/locations/${recipe.location.id}/recipes`) : { recipes: [recipe] };
      return { recipe, recipes };
    })().then(
      (read) => current && setLoaded(read),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setError(failure(caught, "The Recipe could not be loaded"));
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);

  if (notFound) {
    return (
      <section className="grid gap-4">
        <Link to="/locations" className="text-sm text-muted-foreground hover:text-foreground">
          ← Locations
        </Link>
        <p role="alert">There is no such Recipe.</p>
      </section>
    );
  }
  if (!loaded) {
    return (
      <section className="grid gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>
    );
  }

  const { recipe, recipes } = loaded;
  const { location, content, uses } = recipe;
  const title = recipeName(recipe);
  const mayChange = location !== null && mayChangeAt(location.id);
  const path = `/recipes/${encodeURIComponent(id)}`;
  const toolAttributes = typeof content.toolAttributes === "object" && content.toolAttributes !== null ? (content.toolAttributes as Record<string, unknown>) : {};

  return (
    <section className="grid gap-6">
      <Link to={location ? `/locations/${location.id}` : "/locations"} className="text-sm text-muted-foreground hover:text-foreground">
        ← {location?.name ?? "Locations"}
      </Link>
      <div className="grid gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {title} <RecipeBadges recipe={recipe} />
        </h1>
        <p className="text-muted-foreground">{placeText(recipe)}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {recipe.slot !== null && recipe.slot > EDITABLE_SLOTS && (
        <Alert>
          <AlertDescription>
            Slot {recipe.slot} is not editable in DYE2's recipe editor, which edits slots 1 to {EDITABLE_SLOTS}, though DYE2's dashboard and Streamline's
            strip show it. Edit it here.
          </AlertDescription>
        </Alert>
      )}
      {recipe.batchFinished && (
        <Alert variant="destructive">
          <AlertDescription>
            Its Bean Batch, {usedBatchText(recipe)}, is no longer at {location?.name ?? "its Location"}: pick the next roast.
          </AlertDescription>
        </Alert>
      )}

      {mayChange ? (
        <div className="flex flex-wrap items-start gap-2">
          <RecipeFormDialog location={location} recipes={recipes} recipe={recipe} onSaved={changed} />
          {!recipe.archived && <MoveRecipeDialog recipe={recipe} recipes={recipes} onMoved={changed} />}
          {recipe.slot !== null && <TakeOutButton recipe={recipe} onDone={changed} />}
          <ArchiveButton
            path={path}
            name={title}
            archived={recipe.archived}
            effect={`taken out of its slot, so removed from every tablet's DYE2 recipes; restored, it is kept at ${location.name} in no slot`}
            onDone={changed}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only Admins, and Staff working at {location?.name ?? "its Location"}, change its Recipes.</p>
      )}

      <ItemConflictsCard kind="recipe" id={id} onResolved={changed} names={names} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Recipe</h2>
          </CardTitle>
          <CardDescription>
            Its dial as saved on tablets or here, with the edits made since, which reach every tablet at its Location. Its steam and flush are the
            Location's settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Fields label="Recipe">
            <Field term="Name">
              <OrNone>{recipe.name ?? undefined}</OrNone>
            </Field>
            <Field term="Beverage">
              <OrNone>{typeof content.beverage === "string" && content.beverage !== "" ? content.beverage : undefined}</OrNone>
            </Field>
            <Field term="Bean Batch">
              {uses.beanBatch ? (
                <ItemLink to={`${LIBRARY_KINDS.beanBatch.pages}/${uses.beanBatch.id}`}>{usedBatchText(recipe)!}</ItemLink>
              ) : (
                <OrNone>{usedBatchText(recipe)}</OrNone>
              )}
            </Field>
            <Field term="Profile">
              {uses.profile ? <ItemLink to={profilePath(uses.profile.id)}>{profileTitle(uses.profile)}</ItemLink> : <OrNone>{undefined}</OrNone>}
            </Field>
            <Field term="Dose">
              <OrNone>{numberText(content.dose, " g")}</OrNone>
            </Field>
            <Field term="Yield">
              <OrNone>{numberText(content.yield, typeof content.ratio === "number" ? ` g (1:${content.ratio})` : " g")}</OrNone>
            </Field>
            <Field term="Grinder">
              {uses.grinder ? (
                <ItemLink to={`${LIBRARY_KINDS.grinder.pages}/${uses.grinder.id}`}>{grinderName(uses.grinder)}</ItemLink>
              ) : (
                <OrNone>{undefined}</OrNone>
              )}
            </Field>
            <Field term="Grind setting">
              <OrNone>{numberText(content.grindSetting, "")}</OrNone>
            </Field>
            <Field term="RPM">
              <OrNone>{numberText(content.rpm, "")}</OrNone>
            </Field>
            <Field term="Brew temperature">
              <OrNone>{numberText(content.brewTemperature, " °C")}</OrNone>
            </Field>
            <Field term="Basket">
              {uses.basket ? (
                <ItemLink to={`${LIBRARY_KINDS.basket.pages}/${uses.basket.id}`}>{uses.basket.name ?? "Unnamed Basket"}</ItemLink>
              ) : (
                <OrNone>{undefined}</OrNone>
              )}
            </Field>
            <Field term="Tools">
              {uses.tools.length === 0 ? (
                <OrNone>{undefined}</OrNone>
              ) : (
                <ul className="grid gap-1">
                  {uses.tools.map((tool) => {
                    const pairs = attributePairs(toolAttributes[tool.id]) ?? [];
                    return (
                      <li key={tool.id}>
                        <ItemLink to={`${LIBRARY_KINDS.tool.pages}/${tool.id}`}>{tool.name ?? "Unnamed Tool"}</ItemLink>
                        {pairs.length > 0 && <span className="text-muted-foreground"> ({pairs.map((pair) => `${pair.key}: ${pair.value}`).join(", ")})</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Field>
            <Field term="Hot water by">{content.hotWaterMode === "temp" ? "Temperature" : "Volume"}</Field>
            <Field term="Hot water volume">
              <OrNone>{numberText(content.hotWaterVolume, " ml")}</OrNone>
            </Field>
            <Field term="Hot water temperature">
              <OrNone>{numberText(content.hotWaterTemperature, " °C")}</OrNone>
            </Field>
            <Field term="Hot water duration">
              <OrNone>{numberText(content.hotWaterDuration, " s")}</OrNone>
            </Field>
            <Field term="Hot water flow">
              <OrNone>{numberText(content.hotWaterFlow, " ml/s")}</OrNone>
            </Field>
            <Field term="Shown on the dashboard">{content.showOnDashboard === false ? "No" : "Yes"}</Field>
            <Field term="Joined">{formatTime(recipe.createdAt)}</Field>
          </Fields>
        </CardContent>
      </Card>

      <ItemHistoryCard key={changes} kind="recipe" id={id} names={names} />
    </section>
  );
}

/** Takes a Recipe out of its slot, kept at its Location, and empties the slot on its tablets. */
function TakeOutButton({ recipe, onDone }: { recipe: Recipe; onDone(): void }) {
  const [error, setError] = useState<string>();
  async function takeOut() {
    setError(undefined);
    try {
      await api("PUT", `/recipes/${recipe.id}/slot`, { slot: null });
      onDone();
    } catch (caught) {
      setError(failure(caught, "The Recipe could not be taken out of its slot"));
    }
  }
  return (
    <div className="grid gap-2">
      {error && <FormError error={error} />}
      <ConfirmButton
        label="Take out of its slot"
        title={`Take ${recipeName(recipe)} out of slot ${recipe.slot}?`}
        description={`Slot ${recipe.slot} is emptied on every tablet at ${recipe.location?.name ?? "its Location"}. The Recipe is kept there in no slot, to put back in one or Archive.`}
        confirmLabel="Take it out"
        onConfirm={() => void takeOut()}
      />
    </div>
  );
}
