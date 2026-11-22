import { grindSettingOf } from "@decent-sync/protocol";
import { ChevronDownIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useIsAdmin, useMayChange, useStaffLocationIds } from "@/auth";
import { batchName } from "@/components/bean-batches";
import { ItemConflictsCard, ItemHistoryCard, attributePairs } from "@/components/conflicts";
import { grinderName } from "@/components/grinders";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ItemShotsCard } from "@/components/item-shots";
import { PeriodChoice, PeriodTabs, useOverviewPeriod } from "@/components/overview";
import { RecipeByMachineCard, RecipeTrendCard } from "@/components/recipe-numbers";
import { ReferenceShotCard } from "@/components/reference-shots";
import { type Attribute, FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { ConfirmDialog, formatTime, useLocations } from "@/components/machines";
import { profilePath, profileTitle } from "@/components/profiles";
import { OrNone, secondsText } from "@/components/records";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
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
import { ratedShotsPath } from "@/lib/shot-list";

// Each Location's Recipes, DYE2's recipes, in its Recipe Slots or none, each
// not Archived on every tablet there, as its page and the Library's Recipes
// tab list them, and each Recipe's page. An Admin, or
// Staff working at its Location, creates and edits a Recipe there with every
// field DYE2 has but the barista and the drinker, and its steam and hot water
// modes, which are only what DYE2's stepper shows, moves it between slots,
// takes it out of its slot, and Archives and restores it; each change
// reaches every tablet there. A Recipe is on Streamline's strip exactly while
// it is in a slot the strip has a button for, 1 to 5 of the nine, so it has
// no switch of its own for that. Its grind
// setting is a number or text, as DYE2 keeps one. Each steam, hot water and flush setting it does
// not hold is each Machine's own, and a steam temperature of 0 is "Off" (ADR-0022). Picking a Bean Batch, Profile, Basket or
// Tool its Location does not offer offers it there, as the form says before
// saving. A Recipe is copied to a Location as a new Recipe there, offering
// there what it uses.

/** How many Recipe Slots a Location has (`RECIPE_SLOTS` in protocol/src/index.ts), of which Streamline's DYE strip shows 1 to 5. */
const RECIPE_SLOTS = 9;

/** Each Recipe Slot offered, 1 to RECIPE_SLOTS. */
const SLOTS = Array.from({ length: RECIPE_SLOTS }, (_, index) => index + 1);

/** A Recipe's name as lists show it. */
function recipeName(recipe: Pick<Recipe, "name">): string {
  return recipe.name ?? "Unnamed Recipe";
}

/** What may need someone's attention about a Recipe. */
function RecipeBadges({ recipe }: { recipe: Recipe }) {
  return (
    <div className="flex flex-wrap gap-1">
      {recipe.archived && <Badge variant="secondary">Archived</Badge>}
      {recipe.batchFinished && <Badge variant="destructive">Batch finished here</Badge>}
    </div>
  );
}

/**
 * Where a Recipe is, under its name: "at Uptown" for one in a Recipe Slot,
 * which the badge beside its name gives, or that it is in none there, or
 * Archived, its Location linked to its page.
 */
function Place({ recipe }: { recipe: Recipe }) {
  const here = recipe.location ? (
    <Link to={`/locations/${recipe.location.id}`} className="underline-offset-4 hover:underline">
      {recipe.location.name}
    </Link>
  ) : (
    "a Location since removed"
  );
  if (recipe.archived) return <>Archived, kept at {here} in no slot</>;
  return recipe.slot === null ? <>In no slot at {here}</> : <>at {here}</>;
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

/** A Recipe's grind setting as kept: a number, or text as typed, such as "1.1.0"; undefined for none. */
function grindSettingText(content: Record<string, unknown>): string | undefined {
  const setting = grindSettingOf(content.grindSetting);
  return setting === null ? undefined : String(setting);
}

/** A Recipe's feed rate, text as typed, such as "MF" or "1200", as DYE2 v0.1.34 keeps one; undefined for none. */
function feedRateText(content: Record<string, unknown>): string | undefined {
  const feedRate = content.feedRate;
  if (typeof feedRate === "number") return Number.isFinite(feedRate) ? String(feedRate) : undefined;
  return typeof feedRate === "string" && feedRate.trim() !== "" ? feedRate : undefined;
}

/** A Recipe's Grinder and its setting, such as "EK43 at 2.5". */
function grindText(recipe: Recipe): string | undefined {
  const setting = grindSettingText(recipe.content);
  const grinder = recipe.uses.grinder ? (recipe.uses.grinder.model ?? "Unnamed Grinder") : undefined;
  if (grinder === undefined) return setting === undefined ? undefined : `Setting ${setting}`;
  return setting === undefined ? grinder : `${grinder} at ${setting}`;
}

/** A Recipe's Bean Batch, as lists name a batch. */
export function usedBatchText(recipe: Recipe): string | undefined {
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
 * Each Location's Recipes on its page: its Recipe Slots, shared by every
 * Machine there, and its Recipes in no slot, kept there. Each not Archived is
 * on every tablet there, one in no slot found in DYE2's Select Recipe page.
 * Its info text says which slots Streamline's strip shows, as the server
 * does not work out which Skin a Location's tablets run (#502). An Admin, or
 * Staff working there, creates one there.
 */
export function LocationRecipesCard({ location, recipes, onChanged }: { location: Location; recipes: Recipe[]; onChanged(): Promise<void> | void }) {
  const mayChange = useMayChangeAt()(location.id);
  const slotted = recipes.filter((recipe) => recipe.slot !== null);
  const unslotted = recipes.filter((recipe) => recipe.slot === null);
  return (
    <Card role="region" aria-label="Recipes">
      <CardHeader>
        <CardTitleWithInfo title="Recipes">
          <p>
            Its Recipe Slots, 1 to {RECIPE_SLOTS}, shared by every Machine here, and the Recipes kept here in no slot. Every Recipe here not
            Archived is on each tablet here.
          </p>
          <p>
            Streamline's DYE strip shows slots 1 to 5 only. A Recipe in 6 to 9 is a button on a Skin that shows nine, and is listed by DYE2.
          </p>
          <p>A Recipe in 1 to 5 is on the strip exactly while it is in its slot: taking it off any Machine's strip takes it out of its slot here.</p>
        </CardTitleWithInfo>
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
            <p className="text-sm text-muted-foreground">Found on each tablet here in DYE2's Select Recipe page.</p>
            <RecipesTable label="Recipes in no slot" recipes={unslotted} slots={false} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A Recipe's Reference Shot as a list of Recipes says it (#547): its
 * duration, linked to the Shot, or "No reference", linked to the Recipe's
 * rated Shots in the Shots list, to choose one from. The previous release's
 * list, as during a deploy, gives none (ADR-0025): a dash.
 */
function ReferenceCell({ recipe }: { recipe: Recipe }) {
  const shot = recipe.referenceShot;
  if (shot === undefined) return <OrNone>{undefined}</OrNone>;
  if (shot === null) {
    return (
      <Link to={ratedShotsPath(recipe.id)} className="text-muted-foreground underline decoration-dotted underline-offset-4">
        No reference
      </Link>
    );
  }
  return (
    <Link to={`/shots/${encodeURIComponent(shot.id)}`} className="tabular-nums underline underline-offset-4">
      {secondsText(shot.duration) ?? "Open"}
    </Link>
  );
}

/**
 * A table of Recipes, as a Location's Recipes card and the Library's
 * Recipes tab list them: each with its Recipe Slot, where `slots`, its name
 * linked to its page, its Bean Batch, Profile, dose and yield, Grinder and
 * setting, its Reference Shot's duration, and what needs attention.
 */
export function RecipesTable({ label, recipes, slots }: { label: string; recipes: Recipe[]; slots: boolean }) {
  const { pages } = LIBRARY_KINDS.recipe;
  return (
    <div className="min-w-0 rounded-lg border">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            {slots && <TableHead>Slot</TableHead>}
            <TableHead>Recipe</TableHead>
            <TableHead>Bean Batch</TableHead>
            <TableHead>Profile</TableHead>
            <TableHead>Dose and yield</TableHead>
            <TableHead>Grinder</TableHead>
            <TableHead>Reference Shot</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recipes.map((recipe) => (
            <TableRow key={recipe.id}>
              {slots && (
                <TableCell className="font-medium">
                  <OrNone>{recipe.slot === null ? undefined : String(recipe.slot)}</OrNone>
                </TableCell>
              )}
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
                <ReferenceCell recipe={recipe} />
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
    ...choices.beans.map((bean) => [bean.id, bean.name ?? "Unnamed Bean"] as [string, string]),
    ...choices.batches.map((batch) => [batch.id, batchName(batch)] as [string, string]),
    ...choices.profiles.map((profile) => [profile.id, profileTitle(profile)] as [string, string]),
    ...choices.grinders.map((grinder) => [grinder.id, grinderName(grinder)] as [string, string]),
    ...choices.baskets.map((basket) => [basket.id, basket.name ?? "Unnamed Basket"] as [string, string]),
    ...choices.tools.map((tool) => [tool.id, tool.name ?? "Unnamed Tool"] as [string, string]),
  ]);
}

/** Stands for no item, as a Select's options each need a value. */
const NONE = "none";

/** Stands for a Recipe's Bean with no batch, as a Bean picked on a tablet with none at its Location leaves it: kept unless another is picked. */
const BEAN_ONLY = "bean-only";

/** A steam, hot water or flush setting a Recipe may hold, by its content field. */
type SettingField =
  | "steamTemperature"
  | "steamDuration"
  | "steamFlow"
  | "steamStopTemperature"
  | "hotWaterTemperature"
  | "hotWaterDuration"
  | "hotWaterVolume"
  | "hotWaterFlow"
  | "flushTemperature"
  | "flushDuration"
  | "flushFlow";

/**
 * A setting as the Recipe's page and form show it: its name, its unit, and
 * the range the server takes (`RECIPE_FIELDS` in server/src/library/kinds.ts),
 * from `min` to `max`, a whole number where `whole`, and 0 for off where
 * `off`, which the form's input only hints at: the server refuses a value
 * outside it, saying why.
 */
interface Setting {
  readonly field: SettingField;
  readonly term: string;
  readonly unit: string;
  readonly min: number;
  readonly max?: number;
  readonly whole?: boolean;
  readonly off?: boolean;
}

/** The steam, hot water and flush settings, in DYE2's editor's groups. */
const SETTING_GROUPS: readonly { readonly name: string; readonly settings: readonly Setting[] }[] = [
  {
    name: "Steam",
    settings: [
      { field: "steamTemperature", term: "Steam temperature", unit: "°C", min: 135, max: 170, whole: true, off: true },
      { field: "steamDuration", term: "Steam time", unit: "s", min: 1, max: 255, whole: true },
      { field: "steamFlow", term: "Steam flow", unit: "ml/s", min: 0 },
      { field: "steamStopTemperature", term: "Milk stop", unit: "°C", min: 30, max: 80, off: true },
    ],
  },
  {
    name: "Hot water",
    settings: [
      { field: "hotWaterTemperature", term: "Hot water temperature", unit: "°C", min: 0, whole: true },
      { field: "hotWaterDuration", term: "Hot water time", unit: "s", min: 5, max: 120, whole: true },
      { field: "hotWaterVolume", term: "Hot water volume", unit: "ml", min: 0, whole: true },
      { field: "hotWaterFlow", term: "Hot water flow", unit: "ml/s", min: 0.5, max: 8 },
    ],
  },
  {
    name: "Flush",
    settings: [
      { field: "flushTemperature", term: "Flush temperature", unit: "°C", min: 5, max: 95, whole: true },
      { field: "flushDuration", term: "Flush time", unit: "s", min: 0, whole: true },
      { field: "flushFlow", term: "Flush flow", unit: "ml/s", min: 1, max: 8 },
    ],
  },
];

const SETTINGS: readonly Setting[] = SETTING_GROUPS.flatMap((group) => group.settings);

/** A setting's label in the form, such as "Steam time (s)". */
function settingLabel(setting: Setting): string {
  return `${setting.term} (${setting.unit})`;
}

/** A setting a Recipe holds, such as "30 s" or a steam temperature's or milk stop's "Off", or none where each Machine keeps its own. */
function settingText(setting: Setting, value: unknown): string | undefined {
  if (setting.off && value === 0) return "Off";
  return numberText(value, ` ${setting.unit}`);
}

/** The Recipe form's values: each field as its input holds it, each setting as text, empty for none held. */
interface FormValues extends Record<SettingField, string> {
  name: string;
  beverage: string;
  beanBatchId: string;
  profileId: string;
  dose: string;
  yield: string;
  grinderId: string;
  grindSetting: string;
  rpm: string;
  feedRate: string;
  brewTemperature: string;
  basketId: string;
  toolIds: string[];
  /** Each picked Tool's attributes for this Recipe, by the Tool's id. */
  toolAttributes: Record<string, Attribute[]>;
}

/** The fields the form reads as numbers, each with its label. */
const NUMBERS = [
  ["dose", "Dose (g)"],
  ["yield", "Yield (g)"],
  ["rpm", "RPM"],
  ["brewTemperature", "Brew temperature (°C)"],
] as const satisfies readonly (readonly [keyof FormValues, string])[];

type NumberField = (typeof NUMBERS)[number][0];

/** The numbers a Recipe holds none of at 0, as its grind setting: an empty field says none. Its yield may be 0, which is stop-at-weight off. */
const ABOVE_ZERO: ReadonlySet<NumberField> = new Set(["dose", "rpm"]);

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
    beanBatchId: typeof content.beanBatchId !== "string" && typeof content.beanId === "string" ? BEAN_ONLY : id("beanBatchId"),
    profileId: id("profileId"),
    dose: number("dose"),
    yield: number("yield"),
    grinderId: id("grinderId"),
    grindSetting: grindSettingText(content) ?? "",
    rpm: number("rpm"),
    feedRate: feedRateText(content) ?? "",
    brewTemperature: number("brewTemperature"),
    basketId: id("basketId"),
    toolIds: Array.isArray(content.toolIds) ? content.toolIds.filter((tool): tool is string => typeof tool === "string") : [],
    toolAttributes: attributes,
    ...(Object.fromEntries(SETTINGS.map((setting) => [setting.field, number(setting.field)])) as Record<SettingField, string>),
  };
}

/** The Tool's own attributes, DYE2's `custom`. */
function toolDefaults(tool: EquipmentSummary | undefined): Attribute[] {
  return attributePairs(tool?.content.custom) ?? [];
}

/**
 * The content the form's values set, each field as the server takes it, null
 * to clear it, as an empty setting is: a number entered that is not one is
 * refused, so nothing typed is lost unseen, and a setting outside its range
 * is the server's to refuse. A dose or RPM of 0 is refused too, as a Recipe
 * holds none of one at 0; a grind setting of 0 is a dial position, as DYE2
 * from v0.1.42 applies one. The grind setting is a number where it reads as
 * one, and otherwise the text as typed, as DYE2 keeps one, and the feed rate
 * the text, trimmed as DYE2's editor trims it. A Tool's attributes are kept
 * only where they differ from the Tool's own, as DYE2's editor keeps those
 * changed for a recipe.
 */
function contentOf(values: FormValues, tools: EquipmentSummary[]): Record<string, unknown> {
  const content: Record<string, unknown> = {
    name: values.name.trim() === "" ? null : values.name.trim(),
    beverage: values.beverage.trim() === "" ? null : values.beverage.trim(),
    // A Bean with no batch is kept as it is; None clears it, with its batch.
    ...(values.beanBatchId === BEAN_ONLY ? {} : { beanBatchId: values.beanBatchId === NONE ? null : values.beanBatchId }),
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
    grindSetting: grindSettingOf(values.grindSetting),
    feedRate: values.feedRate.trim() === "" ? null : values.feedRate.trim(),
  };
  for (const [field, label] of NUMBERS) {
    const text = values[field].trim();
    if (text === "") {
      content[field] = null;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a number of 0 or more`);
    if (value === 0 && ABOVE_ZERO.has(field)) throw new Error(`${label} must be above 0: leave it empty for none`);
    content[field] = value;
  }
  for (const setting of SETTINGS) {
    const text = values[setting.field].trim();
    const value = Number(text);
    if (text !== "" && !Number.isFinite(value)) throw new Error(`${settingLabel(setting)} must be a number`);
    content[setting.field] = text === "" ? null : value;
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

/** The lowest Recipe Slot none of these Recipes is in, or undefined where every one holds a Recipe. */
function lowestFree(recipes: readonly Pick<Recipe, "slot">[]): number | undefined {
  const taken = new Set(recipes.map((recipe) => recipe.slot));
  return SLOTS.find((slot) => !taken.has(slot));
}

/** The slot a slot Select chose, or undefined for none chosen yet. */
function slotChosen(value: string): number | undefined {
  return SLOTS.find((slot) => String(slot) === value);
}

/** The choice of the next free slot, naming it, or saying that every slot holds a Recipe; just the choice while the Recipes are loading. */
function nextFreeText(recipes: readonly Pick<Recipe, "slot">[] | undefined): string {
  if (recipes === undefined) return "The next free slot";
  return `The next free slot (${lowestFree(recipes) ?? "none: every slot holds a Recipe"})`;
}

/** A Select of the Recipe Slots, 1 to RECIPE_SLOTS, labelled Slot. */
function SlotSelect({ id, value, onChange }: { id: string; value: string; onChange(value: string): void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Slot</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a slot" />
        </SelectTrigger>
        <SelectContent>
          {SLOTS.map((slot) => (
            <SelectItem key={slot} value={String(slot)}>
              {slot}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * What a slot chosen means: the Recipe there leaves it, kept at its Location
 * (`keptAt`, here by default); and, for the next free slot where every slot
 * holds a Recipe (`full`), that the Recipe is kept there in no slot.
 */
function SlotNotes({
  slot,
  there,
  swappedTo,
  keptAt = "here",
  full = false,
}: {
  slot: number | undefined;
  there: Recipe | undefined;
  swappedTo: number | null;
  keptAt?: string;
  full?: boolean;
}) {
  const notes: string[] = [];
  if (there) notes.push(`Slot ${slot} holds ${recipeName(there)}, which ${swappedTo === null ? `is taken out of its slot and kept ${keptAt}` : `moves to slot ${swappedTo}`}.`);
  if (full) notes.push(`Every slot ${keptAt} holds a Recipe, so it is kept ${keptAt} in no slot.`);
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
 * DYE2 has but the barista, the drinker and the steam and hot water modes,
 * each steam, hot water and flush setting left empty for the Machine's own,
 * which clears one the Recipe held. It offers the
 * Location's Grinders only; a Bean Batch, Profile, Basket or Tool the
 * Location does not offer is offered there once saved, which it says first.
 */
function RecipeFormDialog({
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
            {recipe ? " that holds it." : "."} A Recipe carries no barista or drinker.
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

/**
 * New Recipe on the Library's Recipes tab: the Location chosen first, of
 * those the account may change, or the only one, then the form a Location's
 * page creates one with.
 */
export function NewRecipeDialog({ places }: { places: { location: Location; recipes: Recipe[] }[] | undefined }) {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const [open, setOpen] = useState(false);
  const choosable = (places ?? []).filter(({ location }) => mayChangeAt(location.id));
  const [locationId, setLocationId] = useState("");
  // The only Location is chosen as if picked, so another one a later poll brings keeps the form and what it holds.
  if (open && locationId === "" && choosable.length === 1) setLocationId(choosable[0]!.location.id);
  const chosen = choosable.find(({ location }) => location.id === locationId);
  const id = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setLocationId("");
      }}
    >
      <DialogTrigger asChild>
        <Button>New Recipe</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New Recipe</DialogTitle>
          <DialogDescription>
            {chosen ? `A Recipe at ${chosen.location.name}, written to every tablet at ${chosen.location.name}.` : "A Recipe belongs to one Location, and is written to every tablet there."} A
            Recipe carries no barista or drinker.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-location`}>Location</Label>
          <Select value={chosen?.location.id ?? ""} onValueChange={setLocationId}>
            <SelectTrigger id={`${id}-location`} className="w-full">
              <SelectValue placeholder="Choose its Location" />
            </SelectTrigger>
            <SelectContent>
              {choosable.map(({ location }) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {open && chosen && (
          <RecipeForm
            key={chosen.location.id}
            location={chosen.location}
            recipes={chosen.recipes}
            label="New Recipe"
            onSaved={async (recipeId) => {
              setOpen(false);
              setLocationId("");
              void navigate(`${LIBRARY_KINDS.recipe.pages}/${recipeId}`);
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
  const [initial] = useState(() => valuesOf(recipe?.content ?? {}));
  const [values, setValues] = useState(initial);
  const [slotMode, setSlotMode] = useState<SlotMode>("next");
  const [slotText, setSlotText] = useState("");
  const [error, setError] = useState<ReactNode>();
  // A refusal is shown above the form, out of view of its Save button, so it is scrolled into view.
  const errorShown = useRef<HTMLDivElement>(null);
  useEffect(() => {
    errorShown.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) => setValues((current) => ({ ...current, [field]: value }));
  const here = location.id;

  const slot = slotMode === "next" ? lowestFree(recipes) : slotMode === "chosen" ? slotChosen(slotText) : undefined;
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
    if (slotMode === "chosen" && slot === undefined) return setError("Choose the slot");
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

  const settingInput = (setting: Setting) => (
    <div key={setting.field} className="grid gap-2">
      <Label htmlFor={`${id}-${setting.field}`}>{settingLabel(setting)}</Label>
      <Input
        id={`${id}-${setting.field}`}
        type="number"
        inputMode={setting.whole ? "numeric" : "decimal"}
        min={setting.off ? 0 : setting.min}
        max={setting.max}
        step={setting.whole ? 1 : "any"}
        placeholder="Machine's own"
        value={values[setting.field]}
        onChange={(event) => set(setting.field, event.target.value)}
      />
    </div>
  );

  // The server checks each setting's range and its refusal is shown, so the browser's own checks are left out.
  return (
    <form aria-label={label} className="grid gap-5" noValidate onSubmit={save}>
      {error && (
        <div ref={errorShown}>
          <FormError error={error} />
        </div>
      )}
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
        <div className="grid gap-2">
          <Label htmlFor={`${id}-grindSetting`}>Grind setting</Label>
          <Input
            id={`${id}-grindSetting`}
            placeholder="Such as 2.5 or 1.1.0"
            value={values.grindSetting}
            onChange={(event) => set("grindSetting", event.target.value)}
          />
        </div>
        {numberInput("rpm")}
        <div className="grid gap-2">
          <Label htmlFor={`${id}-feedRate`}>Feed rate</Label>
          <Input id={`${id}-feedRate`} placeholder="Such as MF or 1200" value={values.feedRate} onChange={(event) => set("feedRate", event.target.value)} />
        </div>
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
      </div>

      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          A Machine loading the Recipe takes each steam, hot water and flush setting it holds. Leave one empty for each Machine to keep its own.
          A steam temperature turns the Machine's steam on as the Recipe loads, and one of 0 is Off, which turns it off there and on every
          Machine that has the Recipe loaded.
        </p>
        {SETTING_GROUPS.map((group) => (
          <fieldset key={group.name} className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">{group.name}</legend>
            {group.settings.map(settingInput)}
          </fieldset>
        ))}
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
                <SelectItem value="next">{nextFreeText(recipes)}</SelectItem>
                <SelectItem value="chosen">A slot of my choosing</SelectItem>
                <SelectItem value="none">No slot: kept here only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {slotMode === "chosen" && <SlotSelect id={`${id}-slot`} value={slotText} onChange={setSlotText} />}
          <div className="sm:col-span-2">
            <SlotNotes slot={slot} there={there} swappedTo={null} full={slotMode === "next" && slot === undefined} />
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
 * there, or to the lowest free slot, offered only where one is free; the
 * Recipe keeps its id and history. It is shown open, by the action that
 * asks for it, and `onClose` is called as it closes, `onCloseAutoFocus`
 * then putting the keyboard's focus back, as it has no trigger of its own.
 */
function MoveRecipeDialog({
  recipe,
  recipes,
  onMoved,
  onClose,
  onCloseAutoFocus,
}: {
  recipe: Recipe;
  recipes: Recipe[];
  onMoved(): Promise<void> | void;
  onClose(): void;
  onCloseAutoFocus(event: Event): void;
}) {
  const [picked, setPicked] = useState<"next" | "chosen">("chosen");
  const [slotText, setSlotText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const id = useId();
  const free = lowestFree(recipes);
  // The next free slot is offered only while one is free.
  const mode = free === undefined ? "chosen" : picked;
  const slot = mode === "next" ? free : slotChosen(slotText);
  const there = slot === undefined ? undefined : recipes.find((candidate) => candidate.slot === slot && candidate.id !== recipe.id);

  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (slot === undefined) return setError("Choose the slot");
    setSaving(true);
    setError(undefined);
    try {
      await api("PUT", `/recipes/${recipe.id}/slot`, { slot: mode === "next" ? "next" : slot });
      onClose();
      await onMoved();
    } catch (caught) {
      setError(failure(caught, "The Recipe could not be moved"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
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
            <Select value={mode} onValueChange={(value) => setPicked(value as "next" | "chosen")}>
              <SelectTrigger id={`${id}-mode`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chosen">A slot of my choosing</SelectItem>
                {free !== undefined && <SelectItem value="next">The next free slot ({free})</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {mode === "chosen" && <SlotSelect id={`${id}-slot`} value={slotText} onChange={setSlotText} />}
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

/** Stands for keeping the Recipe's own Bean Batch in its copy. */
const KEEP = "keep";

/**
 * Copies a Recipe to a Location the account changes Recipes at, as a new
 * Recipe there whose history names this one (ticket #144): in a slot chosen,
 * the Recipe there taken out of it, the next free one, or none, with one of
 * that Location's Grinders, its grind setting kept as a starting point, and
 * its Bean Batch, or another at that Location, or none. It says first what
 * copying adds, offers or shows there. A copy goes to another Location than
 * the Recipe's own. It is shown open, by the action that asks for it, each
 * time afresh from the Recipe as it is then, and `onClose` is called as it
 * closes.
 */
function CopyRecipeDialog({ recipe, choices, onClose, onCloseAutoFocus }: { recipe: Recipe; choices: Choices | undefined; onClose(): void; onCloseAutoFocus(event: Event): void }) {
  const navigate = useNavigate();
  const mayChangeAt = useMayChangeAt();
  const { locations, error: locationsError } = useLocations();
  const [locationId, setLocationId] = useState("");
  const [targetRecipes, setTargetRecipes] = useState<Recipe[]>();
  const [slotMode, setSlotMode] = useState<SlotMode>("next");
  const [slotText, setSlotText] = useState("");
  const [grinderId, setGrinderId] = useState(NONE);
  const keptBatch = () => (recipe.uses.beanBatch || recipe.uses.bean ? KEEP : NONE);
  const [batchId, setBatchId] = useState(keptBatch);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const id = useId();
  const target = locations?.find((location) => location.id === locationId);

  // The Location's Recipes, for what a slot chosen holds there and its next free one.
  useEffect(() => {
    setTargetRecipes(undefined);
    if (locationId === "") return;
    let current = true;
    api<{ recipes: Recipe[] }>("GET", `/locations/${locationId}/recipes`).then(
      ({ recipes }) => current && setTargetRecipes(recipes),
      (caught: unknown) => current && setError(failure(caught, "That Location's Recipes could not be loaded")),
    );
    return () => {
      current = false;
    };
  }, [locationId]);

  const grinders = (choices?.grinders ?? []).filter((grinder) => grinder.location?.id === locationId && !grinder.archived);
  const archivedBeans = new Set((choices?.beans ?? []).filter((bean) => bean.archived).map((bean) => bean.id));
  const atTarget = (batch: BeanBatchSummary) => batch.locations.some((at) => at.location.id === locationId);
  const batches = (choices?.batches ?? []).filter((batch) => !batch.archived && !archivedBeans.has(batch.bean.id) && atTarget(batch) && batch.id !== recipe.uses.beanBatch?.id);
  const free = targetRecipes ? lowestFree(targetRecipes) : undefined;
  const slot = slotMode === "next" ? free : slotMode === "chosen" ? slotChosen(slotText) : undefined;
  const there = slot === undefined ? undefined : targetRecipes?.find((candidate) => candidate.slot === slot);

  // A Recipe naming a Bean with no batch takes that Bean's batch most recently added at the Location, or none, keeping
  // the Bean: the latest added there, then the latest created, then by id, as the server picks it (`batchOfBean`).
  const sinceAtTarget = (batch: BeanBatchSummary) => Date.parse(batch.locations.find((at) => at.location.id === locationId)?.since ?? "") || 0;
  // A batch a hard delete took is left out of the copy, which then names its Bean alone.
  const batchGone = recipe.uses.beanBatch !== null && choices !== undefined && !choices.batches.some((batch) => batch.id === recipe.uses.beanBatch!.id);
  const beanOnly = recipe.uses.beanBatch === null || batchGone ? recipe.uses.bean : null;
  const beanBatchThere = beanOnly
    ? (choices?.batches ?? [])
        .filter((batch) => batch.bean.id === beanOnly.id && !batch.archived && atTarget(batch))
        .sort((a, b) => sinceAtTarget(b) - sinceAtTarget(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
    : undefined;
  const keptText =
    beanOnly && target
      ? beanBatchThere
        ? `${batchName(beanBatchThere)} (this Recipe's Bean's latest batch at ${target.name})`
        : `${beanOnly.name ?? "Unnamed Bean"}, no batch (this Recipe's Bean, with none at ${target.name})`
      : `${usedBatchText(recipe) ?? "Its batch"} (this Recipe's)`;

  // What copying adds or shows at the Location that it does not offer now, so the copy can be loaded there.
  const offered: string[] = [];
  if (target && choices) {
    const shownThere = (item: { shownAt: { location: { id: string } }[] } | undefined) => item?.shownAt.some((at) => at.location.id === locationId) ?? true;
    const ownBatch = choices.batches.find((batch) => batch.id === recipe.uses.beanBatch?.id);
    if (batchId === KEEP && ownBatch && !atTarget(ownBatch)) offered.push(`adds the Bean Batch ${batchName(ownBatch)} at ${target.name}`);
    const bean = choices.beans.find((candidate) => candidate.id === beanOnly?.id);
    if (batchId === KEEP && bean && !beanBatchThere && !bean.offeredAt.some((at) => at.id === locationId)) {
      offered.push(`offers the Bean ${bean.name ?? "Unnamed Bean"} at ${target.name}`);
    }
    const profile = choices.profiles.find((candidate) => candidate.id === recipe.uses.profile?.id);
    if (profile && !shownThere(profile)) offered.push(`shows the Profile ${profileTitle(profile)} at ${target.name}`);
    const basket = choices.baskets.find((candidate) => candidate.id === recipe.uses.basket?.id);
    if (basket && !shownThere(basket)) offered.push(`shows the Basket ${basket.name ?? "Unnamed Basket"} at ${target.name}`);
    for (const used of recipe.uses.tools) {
      const tool = choices.tools.find((candidate) => candidate.id === used.id);
      if (tool && !shownThere(tool)) offered.push(`shows the Tool ${tool.name ?? "Unnamed Tool"} at ${target.name}`);
    }
    // What a hard delete left it naming is left out of the copy.
    const gone = (kind: string, used: { id: string } | null, listed: readonly { id: string }[]) =>
      used && !listed.some((item) => item.id === used.id) ? [`leaves out its ${kind}, which the Library no longer has`] : [];
    offered.push(
      ...(batchId === KEEP ? gone("Bean Batch", recipe.uses.beanBatch, choices.batches) : []),
      ...(batchId === KEEP ? gone("Bean", recipe.uses.bean, choices.beans) : []),
      ...gone("Profile", recipe.uses.profile, choices.profiles),
      ...gone("Basket", recipe.uses.basket, choices.baskets),
      ...recipe.uses.tools.flatMap((tool) => gone("Tool", tool, choices.tools)),
    );
  }

  function chooseLocation(next: string) {
    setLocationId(next);
    setError(undefined);
    // The Grinder of the Recipe's model there, if that Location has one.
    const model = recipe.uses.grinder?.model?.trim().toLowerCase();
    const same = (choices?.grinders ?? []).find(
      (grinder) => grinder.location?.id === next && !grinder.archived && model !== undefined && grinder.model?.trim().toLowerCase() === model,
    );
    setGrinderId(same?.id ?? NONE);
    if (batchId !== KEEP) setBatchId(NONE);
  }

  async function copy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    if (locationId === "") return setError("Choose the Location to copy it to");
    if (slotMode === "chosen" && slot === undefined) return setError("Choose the slot");
    setSaving(true);
    try {
      const { recipe: copied } = await api<{ recipe: Recipe }>("POST", `/recipes/${recipe.id}/copies`, {
        locationId,
        slot: slotMode === "next" ? "next" : slotMode === "chosen" ? slot : null,
        grinderId: grinderId === NONE ? null : grinderId,
        ...(batchId === KEEP ? {} : { beanBatchId: batchId === NONE ? null : batchId }),
      });
      onClose();
      void navigate(`${LIBRARY_KINDS.recipe.pages}/${copied.id}`);
    } catch (caught) {
      setError(failure(caught, "The Recipe could not be copied"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Copy {recipeName(recipe)} to a Location</DialogTitle>
          <DialogDescription>
            A new Recipe there, as a starting point: its history starts with the copy, and this Recipe is not changed. It keeps its dial, grind
            setting, and the steam, hot water and flush settings it holds.
          </DialogDescription>
        </DialogHeader>
        <form aria-label="Copy the Recipe" className="grid gap-4" onSubmit={copy}>
          {error && <FormError error={error} />}
          {locationsError && <FormError error={locationsError} />}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-location`}>Copy to</Label>
            <Select value={locationId} onValueChange={chooseLocation}>
              <SelectTrigger id={`${id}-location`} className="w-full">
                <SelectValue placeholder="Choose a Location" />
              </SelectTrigger>
              <SelectContent>
                {locations
                  ?.filter((location) => mayChangeAt(location.id) && location.id !== recipe.location?.id)
                  .map((location) => (
                    <SelectItem key={location.id} value={location.id}>
                      {location.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {target && (
            <>
              <div className="grid gap-2">
                <Label htmlFor={`${id}-slot-mode`}>Recipe Slot</Label>
                <Select value={slotMode} onValueChange={(value) => setSlotMode(value as SlotMode)}>
                  <SelectTrigger id={`${id}-slot-mode`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="next">{nextFreeText(targetRecipes)}</SelectItem>
                    <SelectItem value="chosen">A slot of my choosing</SelectItem>
                    <SelectItem value="none">No slot: kept there only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {slotMode === "chosen" && <SlotSelect id={`${id}-slot`} value={slotText} onChange={setSlotText} />}
              <SlotNotes
                slot={slot}
                there={there}
                swappedTo={null}
                keptAt={`at ${target.name}`}
                full={slotMode === "next" && targetRecipes !== undefined && slot === undefined}
              />

              <div className="grid gap-2">
                <Label htmlFor={`${id}-grinder`}>Grinder</Label>
                <Select value={grinderId} onValueChange={setGrinderId}>
                  <SelectTrigger id={`${id}-grinder`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {grinders.map((grinder) => (
                      <SelectItem key={grinder.id} value={grinder.id}>
                        {grinderName(grinder)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  One of {target.name}'s Grinders.
                  {grindSettingText(recipe.content) !== undefined && ` Its grind setting, ${grindSettingText(recipe.content)}, is kept as a starting point.`}
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor={`${id}-batch`}>Bean Batch</Label>
                <Select value={batchId} onValueChange={setBatchId}>
                  <SelectTrigger id={`${id}-batch`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {batchId === KEEP || recipe.uses.beanBatch || recipe.uses.bean ? (
                      <SelectItem value={KEEP}>{keptText}</SelectItem>
                    ) : null}
                    <SelectItem value={NONE}>None</SelectItem>
                    <ChoiceGroup label={`At ${target.name}`} items={batches.map((batch) => [batch.id, batchName(batch)])} />
                  </SelectContent>
                </Select>
              </div>

              {offered.length > 0 && (
                <Alert role="status" aria-label="Copying also">
                  <AlertDescription>
                    <p>Copying also:</p>
                    <ul className="list-disc pl-5">
                      {offered.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          <div>
            <Button type="submit" disabled={saving || !choices || !target || targetRecipes === undefined}>
              Copy
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One Recipe, in the order a reader asks (#547): its name, Recipe Slot and
 * Location, with its actions; its open Conflicts; how it is pulling, over
 * a period its address keeps, which is its Reference Shot beside its
 * numbers by Machine, then its 30-day trend; the fields it has set; how
 * many Shots it has in the period, which the Shots list opens; and its
 * history, closed until opened. An Admin, or Staff working at its
 * Location, edits it, moves it to another slot or takes it out of its
 * slot, clears its Reference Shot, and Archives or restores it; an Admin,
 * or Staff, copies it to a Location they change Recipes at.
 */
export function RecipeDetails({ id }: { id: string }) {
  const mayChangeAt = useMayChangeAt();
  const mayChangeAnything = useMayChange();
  const isAdmin = useIsAdmin();
  const staffLocations = useStaffLocationIds();
  const { choices } = useChoices();
  const names = useMemo(() => namesOf(choices), [choices]);
  const [period, setPeriod] = useOverviewPeriod();
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
        <Link to="/library/recipes" className="text-sm text-muted-foreground hover:text-foreground">
          ← Recipes
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
  const { location } = recipe;
  const title = recipeName(recipe);
  const mayChange = location !== null && mayChangeAt(location.id);
  // A copy goes to another Location the account changes Recipes at: an Admin's any, Staff's their own.
  const mayCopy = isAdmin || [...staffLocations].some((staffLocation) => staffLocation !== location?.id);

  return (
    // One column no wider than the page, so a wide table scrolls rather than widening it.
    <section className="grid grid-cols-1 gap-6">
      <Link to={location ? `/locations/${location.id}` : "/locations"} className="text-sm text-muted-foreground hover:text-foreground">
        ← {location?.name ?? "Locations"}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold wrap-anywhere">
              {title} <RecipeBadges recipe={recipe} />
            </h1>
            {recipe.slot !== null && (
              <Badge variant="outline" role="img" aria-label={`Slot ${recipe.slot}`} className="rounded-md px-1.5 text-muted-foreground tabular-nums">
                {recipe.slot}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            <Place recipe={recipe} />
          </p>
        </div>
        <RecipeActions recipe={recipe} recipes={recipes} choices={choices} mayChange={mayChange} mayCopy={mayCopy} onChanged={changed} />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {recipe.batchFinished && (
        <Alert variant="destructive">
          <AlertDescription>
            Its Bean Batch, {usedBatchText(recipe)}, is no longer at {location?.name ?? "its Location"}: pick the next roast.
          </AlertDescription>
        </Alert>
      )}
      {!mayChange && mayChangeAnything && (
        <p className="text-sm text-muted-foreground">Only Admins, and Staff working at {location?.name ?? "its Location"}, change its Recipes.</p>
      )}

      <ItemConflictsCard kind="recipe" id={id} onResolved={changed} names={names} />

      <PeriodTabs period={period} onPeriod={setPeriod} className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <h2 className="text-lg font-semibold">How it is pulling</h2>
          <PeriodChoice />
        </div>
        {/* Side by side from 1024 px, the numbers twice as wide; stacked below it. */}
        <TabsContent value={period} className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <ReferenceShotCard recipe={recipe} mayChange={mayChange} onChanged={changed} />
          <RecipeByMachineCard recipe={recipe} period={period} />
        </TabsContent>
      </PeriodTabs>

      <RecipeTrendCard recipe={recipe} />

      <RecipeFieldsCard recipe={recipe} />

      <ItemShotsCard kind="recipe" id={id} within={{ period, timeZone: location?.timeZone }} />

      <ItemHistoryCard kind="recipe" id={id} names={names} closed version={changes} />
    </section>
  );
}

/** What a Recipe's actions menu may open: each a dialog of its own. */
type RecipeAction = "move" | "takeOut" | "copy" | "archive" | "delete";

/**
 * A Recipe's actions, beside its name (#547): Edit, always in view, and the
 * rest in a menu, for those who may use each: moving it to a slot, which a
 * wide screen keeps in view too, taking it out of its slot, copying it to a
 * Location, Archiving or restoring it, and, for an Admin, deleting it, which
 * only a Recipe no Shot was pulled with allows. Nothing for an account that
 * may use none.
 */
function RecipeActions({
  recipe,
  recipes,
  choices,
  mayChange,
  mayCopy,
  onChanged,
}: {
  recipe: Recipe;
  recipes: Recipe[];
  choices: Choices | undefined;
  mayChange: boolean;
  mayCopy: boolean;
  onChanged(): void;
}) {
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [action, setAction] = useState<RecipeAction>();
  const [error, setError] = useState<string>();
  const { location } = recipe;
  const title = recipeName(recipe);
  const path = `/recipes/${encodeURIComponent(recipe.id)}`;
  const here = location?.name ?? "its Location";
  const close = () => setAction(undefined);
  // A dialog opened from here has no trigger of its own for the keyboard's focus to go back to as it closes: it goes
  // back to the button that opened it, or, for one opened from the menu, whose items are gone by then, to More.
  const more = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = (next: RecipeAction, from?: HTMLElement) => {
    setError(undefined);
    opener.current = from ?? more.current;
    setAction(next);
  };
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    (opener.current?.isConnected ? opener.current : more.current)?.focus();
  };
  const confirming = (which: RecipeAction) => ({ open: action === which, onOpenChange: (next: boolean) => !next && close(), onCloseAutoFocus });

  /** Makes a change that has no form of its own, and says why where it is refused. */
  async function change(request: () => Promise<unknown>, refused: string, done: () => void = onChanged) {
    setError(undefined);
    try {
      await request();
      done();
    } catch (caught) {
      setError(failure(caught, refused));
    }
  }
  const takeOut = () => change(() => api("PUT", `${path}/slot`, { slot: null }), "The Recipe could not be taken out of its slot");
  const archive = (archived: boolean) => change(() => api("PUT", `${path}/archived`, { archived }), archived ? "It could not be Archived" : "It could not be restored");
  const remove = () =>
    change(
      () => api("DELETE", path),
      "It could not be deleted",
      () => void navigate(location ? `/locations/${location.id}` : "/locations"),
    );

  if (!mayChange && !mayCopy && !isAdmin) return null;
  const moveLabel = recipe.slot === null ? "Put in a slot" : "Move to a slot";
  const mayMove = mayChange && !recipe.archived;
  return (
    <div className="grid justify-items-start gap-2 sm:justify-items-end">
      <div className="flex flex-wrap items-center gap-2">
        {mayChange && location && <RecipeFormDialog location={location} recipes={recipes} recipe={recipe} onSaved={onChanged} />}
        {mayMove && (
          <Button variant="outline" className="max-sm:hidden" onClick={(event) => open("move", event.currentTarget)}>
            {moveLabel}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={more} variant="outline">
              More
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {/* In view beside Edit on a wide screen. */}
            {mayMove && (
              <DropdownMenuItem className="sm:hidden" onSelect={() => open("move")}>
                {moveLabel}
              </DropdownMenuItem>
            )}
            {mayChange && recipe.slot !== null && <DropdownMenuItem onSelect={() => open("takeOut")}>Take out of its slot</DropdownMenuItem>}
            {mayCopy && <DropdownMenuItem onSelect={() => open("copy")}>Copy to a Location</DropdownMenuItem>}
            {mayChange && (recipe.archived ? <DropdownMenuItem onSelect={() => void archive(false)}>Restore</DropdownMenuItem> : <DropdownMenuItem onSelect={() => open("archive")}>Archive</DropdownMenuItem>)}
            {isAdmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => open("delete")}>
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && <FormError error={error} />}

      {/* Each mounted while it is open, so it starts from the Recipe as it is then. */}
      {action === "move" && <MoveRecipeDialog recipe={recipe} recipes={recipes} onMoved={onChanged} onClose={close} onCloseAutoFocus={onCloseAutoFocus} />}
      {action === "copy" && <CopyRecipeDialog recipe={recipe} choices={choices} onClose={close} onCloseAutoFocus={onCloseAutoFocus} />}
      <ConfirmDialog
        {...confirming("takeOut")}
        title={`Take ${title} out of slot ${recipe.slot}?`}
        description={`Slot ${recipe.slot} is emptied on every tablet at ${here}. The Recipe is kept there in no slot, still found in DYE2's Select Recipe page, to put back in one or Archive.`}
        confirmLabel="Take it out"
        onConfirm={() => void takeOut()}
      />
      <ConfirmDialog
        {...confirming("archive")}
        title={`Archive ${title}?`}
        description={`It is offered nowhere from now on, and removed from every tablet's DYE2 recipes and taken out of its slot; restored, it is written to them again, kept at ${here} in no slot, but kept, so past Shots still name it. It can be restored.`}
        confirmLabel="Archive"
        onConfirm={() => void archive(true)}
      />
      <ConfirmDialog
        {...confirming("delete")}
        variant="destructive"
        title={`Delete ${title}?`}
        description="It is deleted from every tablet that holds it, now or once it connects, and cannot be restored. Only a Recipe no Shot was pulled with can be deleted; Archive any other."
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** A field of a Recipe as its card shows it: what it is called, its value where the Recipe has set it, and what stands for it where it has not. */
interface ShownField {
  term: string;
  value: ReactNode | undefined;
  unset?: string;
}

/**
 * The fields a Recipe has set (#547), each once: what it names of the
 * Library, linked, its dial, and the steam, hot water and flush settings it
 * holds. Those it has not set are left out until asked for, by one control
 * that says how many there are: each then shows a dash, or, for a setting,
 * that each Machine keeps its own. Editing offers every field.
 */
function RecipeFieldsCard({ recipe }: { recipe: Recipe }) {
  const [all, setAll] = useState(false);
  const { content, uses } = recipe;
  const toolAttributes = typeof content.toolAttributes === "object" && content.toolAttributes !== null ? (content.toolAttributes as Record<string, unknown>) : {};
  const fields: ShownField[] = [
    { term: "Beverage", value: typeof content.beverage === "string" && content.beverage !== "" ? content.beverage : undefined },
    {
      term: "Bean Batch",
      value: uses.beanBatch ? <ItemLink to={`${LIBRARY_KINDS.beanBatch.pages}/${uses.beanBatch.id}`}>{usedBatchText(recipe)!}</ItemLink> : usedBatchText(recipe),
    },
    { term: "Profile", value: uses.profile ? <ItemLink to={profilePath(uses.profile.id)}>{profileTitle(uses.profile)}</ItemLink> : undefined },
    { term: "Dose", value: numberText(content.dose, " g") },
    { term: "Yield", value: numberText(content.yield, typeof content.ratio === "number" ? ` g (1:${content.ratio})` : " g") },
    { term: "Grinder", value: uses.grinder ? <ItemLink to={`${LIBRARY_KINDS.grinder.pages}/${uses.grinder.id}`}>{grinderName(uses.grinder)}</ItemLink> : undefined },
    { term: "Grind setting", value: grindSettingText(content) },
    { term: "RPM", value: numberText(content.rpm, "") },
    { term: "Feed rate", value: feedRateText(content) },
    { term: "Brew temperature", value: numberText(content.brewTemperature, " °C") },
    { term: "Basket", value: uses.basket ? <ItemLink to={`${LIBRARY_KINDS.basket.pages}/${uses.basket.id}`}>{uses.basket.name ?? "Unnamed Basket"}</ItemLink> : undefined },
    {
      term: "Tools",
      value:
        uses.tools.length === 0 ? undefined : (
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
        ),
    },
    ...SETTINGS.map((setting) => ({ term: setting.term, value: settingText(setting, content[setting.field]), unset: "Machine's own" })),
  ];
  const unset = fields.filter((field) => field.value === undefined).length;
  const shown = all ? fields : fields.filter((field) => field.value !== undefined);

  return (
    <Card role="region" aria-label="Recipe">
      <CardHeader>
        <CardTitleWithInfo title="Recipe">
          <p>
            Its dial as saved on tablets or here, with the edits made since, which reach every tablet at its Location. It is the whole Shot: a
            Machine that loads it is left with none of what it holds none of here, such as a Grinder or Basket.
          </p>
          <p>
            Only the fields it has set are shown, until the rest are asked for. A Machine loading it takes each steam, hot water and flush
            setting it holds, and keeps its own of each it does not. A steam temperature turns the Machine's steam on as it loads, and one
            of Off turns it off, there and on every Machine that has the Recipe loaded.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl aria-label="Recipe" className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm tabular-nums lg:grid-cols-3">
          {shown.map(({ term, value, unset: none }) => (
            <div key={term} className="min-w-0">
              <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
              <dd className="wrap-anywhere">{value ?? <span className="text-muted-foreground">{none ?? "-"}</span>}</dd>
            </div>
          ))}
          <div className="min-w-0">
            <dt className="text-[0.8125rem] text-muted-foreground">Joined</dt>
            <dd>{formatTime(recipe.createdAt)}</dd>
          </div>
        </dl>
        {unset > 0 && (
          <div>
            {/* Its words say which way it is set. */}
            <Button variant="outline" size="sm" onClick={() => setAll(!all)}>
              {all ? "Hide the fields not set" : `Show the ${unset} ${unset === 1 ? "field" : "fields"} not set`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
