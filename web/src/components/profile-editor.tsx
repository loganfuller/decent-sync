import {
  BEVERAGE_TYPES,
  type BeverageType,
  type Profile,
  type ProfileCheck,
  type ProfileChecks,
  type ProfileLimits,
  type ProfileStep,
  type Range,
  type SimulatedRun,
  type StepPump,
  stepLabel,
} from "@decent-sync/protocol";
import { ChevronDown, ChevronUp, CircleCheck, CircleX, Plus, TriangleAlert } from "lucide-react";
import { type ReactNode, type Ref, useId, useRef, useState } from "react";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  type MovesOn,
  addStep,
  brewTemperature,
  clamped,
  deleteStep,
  duplicateStep,
  exitRange,
  limitRange,
  moveStep,
  movesOn,
  preinfusionEnd,
  relativeTo,
  setStep,
  targetRange,
  withBrewTemperature,
  withMovesOn,
  withPreinfusionEnd,
  withPump,
  withRelativeTemperature,
  withTarget,
} from "@/lib/profile-edits";
import { measure, stepAction, stepMovesOn, stepName, stepSimulated } from "@/lib/profile-words";

// A Draft's editor (#579): the inspector beside the graph, for the selected
// step and for the whole profile; the checks, what stops it publishing and
// advice, each naming its step, in a list a status beside Publish opens; and its steps, added, duplicated, deleted
// and reordered. Every change goes to `onChange` with the key of what it
// changed, so changes of one field in quick succession undo as one, or null
// for a change that is a step of its own. Every number is held to the widest
// ranges of the account's models as it is typed.

/** A change to the Draft's profile, and what it changed, or null for a change that undoes alone. */
export type ProfileChange = (next: Profile, key: string | null) => void;

/**
 * The brew temperature's field: as it is typed, every step moves from where
 * it was as the typing began, so a value passed on the way, such as 1 on the
 * way to 100, holds none of them to the range.
 */
function useBrewTemperature(profile: Profile, limits: ProfileLimits, onChange: ProfileChange): { onChange(value: number | null): void; onBlur(): void } {
  const from = useRef<Profile | null>(null);
  return {
    onChange: (value) => {
      const base = (from.current ??= profile);
      onChange(withBrewTemperature(base, value ?? brewTemperature(base) ?? 0, limits.temperature), "brew");
    },
    onBlur: () => {
      from.current = null;
    },
  };
}

/** A number as a field shows it: as authored, to hundredths. */
function shown(value: number | null): string {
  return value === null ? "" : String(Math.round(value * 100) / 100);
}

/** What was typed, as a number: null where it is empty, undefined where it is not a number. */
function typed(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * A field of a number, held to its range as it is typed, saying so where
 * what was typed is outside it; with `off`, empty is none, shown as "Off".
 * It shows what was typed while it has the focus, and the value otherwise,
 * as after an undo. What explains it goes in `info`, behind an icon beside
 * its label; `hint`, under it, is for what says its state.
 */
export function NumberField({
  label,
  value,
  unit,
  range,
  off,
  hint,
  info,
  onChange,
  onBlur,
}: {
  label: string;
  value: number | null;
  unit: string;
  range: Range;
  /** Whether empty is none, as for a limit or a weight. */
  off?: boolean;
  hint?: ReactNode;
  info?: ReactNode;
  onChange(value: number | null): void;
  /** Called as the field is left. */
  onBlur?(): void;
}) {
  const id = useId();
  const [text, setText] = useState(shown(value));
  const [focused, setFocused] = useState(false);
  // A value changed from outside, as by an undo or a handle dragged, shows at once, but not while it is being typed.
  const [seen, setSeen] = useState(value);
  if (!focused && value !== seen) {
    setSeen(value);
    setText(shown(value));
  }
  const read = typed(text);
  const outside = typeof read === "number" && (read < range.min || read > range.max);
  const invalid = read === undefined || (read === null && !off);
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="flex items-center gap-1">
        <Label htmlFor={id}>{label}</Label>
        {info && <InfoTip label={`About ${label.toLowerCase()}`}>{info}</InfoTip>}
      </span>
      <div className="relative">
        <Input
          id={id}
          inputMode="decimal"
          className="pr-12 tabular-nums"
          value={text}
          placeholder={off ? "Off" : undefined}
          aria-invalid={invalid || outside}
          aria-describedby={outside || hint ? `${id}-hint` : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setSeen(value);
            setText(shown(value));
            onBlur?.();
          }}
          onChange={(event) => {
            setText(event.target.value);
            const next = typed(event.target.value);
            if (next === null && off) onChange(null);
            else if (typeof next === "number") onChange(clamped(next, range));
          }}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{unit}</span>
      </div>
      {(outside || hint) && (
        <p id={`${id}-hint`} className={`text-xs ${outside ? "text-destructive" : "text-muted-foreground"}`}>
          {outside ? `Held to ${measure(range.min)} to ${measure(range.max)} ${unit}, what the machine accepts` : hint}
        </p>
      )}
    </div>
  );
}

/** A field of text. */
function TextField({ label, value, onChange, long }: { label: string; value: string; onChange(value: string): void; long?: boolean }) {
  const id = useId();
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {long ? <Textarea id={id} value={value} rows={4} onChange={(event) => onChange(event.target.value)} /> : <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} />}
    </div>
  );
}

/** A choice of a few, as a segmented control with its label. */
function Choice<T extends string>({ label, value, choices, onChange, info }: { label: string; value: T; choices: [T, string][]; onChange(value: T): void; info?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <span className="flex items-center gap-1 text-sm font-medium">
        {label}
        {info && <InfoTip label={`About ${label.toLowerCase()}`}>{info}</InfoTip>}
      </span>
      <Segmented label={label} value={value} onValueChange={(next) => next && onChange(next as T)} className="h-9 w-full">
        {choices.map(([key, text]) => (
          <SegmentedItem key={key} value={key} className="flex-1">
            {text}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

/** A choice from a list, as a select with its label. */
function Picker({ label, value, choices, onChange }: { label: string; value: string; choices: [string, string][]; onChange(value: string): void }) {
  const id = useId();
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const UNIT: Record<StepPump, string> = { pressure: "bar", flow: "ml/s" };
const OTHER: Record<StepPump, StepPump> = { pressure: "flow", flow: "pressure" };

const MOVES_ON: [MovesOn, string][] = [
  ["time", "Its time is up"],
  ["pressure-over", "Pressure goes over"],
  ["pressure-under", "Pressure falls under"],
  ["flow-over", "Flow goes over"],
  ["flow-under", "Flow falls under"],
];

/** The inspector: the selected step's fields, or the whole profile's. */
export function Inspector({
  profile,
  selected,
  tab,
  limits,
  onTab,
  onSelect,
  onChange,
  className = "",
  ref,
}: {
  profile: Profile;
  selected: number;
  tab: "step" | "profile";
  limits: ProfileLimits;
  onTab(tab: "step" | "profile"): void;
  onSelect(step: number): void;
  onChange: ProfileChange;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const step = profile.steps[selected];
  return (
    <Card ref={ref} role="region" aria-label="Inspector" className={`min-w-0 ${className}`}>
      <CardContent className="grid gap-5">
        <Tabs value={step ? tab : "profile"} onValueChange={(value) => onTab(value as "step" | "profile")}>
          <TabsList>
            <TabsTrigger value="step" disabled={!step}>
              {step ? `Step ${selected + 1}` : "No step"}
            </TabsTrigger>
            <TabsTrigger value="profile">Whole Profile</TabsTrigger>
          </TabsList>
          {step && (
            <TabsContent value="step" className="mt-4">
              {/* Its own fields for each step, so what is typed in one never shows in another's. */}
              <StepFields key={selected} profile={profile} index={selected} step={step} limits={limits} onSelect={onSelect} onChange={onChange} />
            </TabsContent>
          )}
          <TabsContent value="profile" className="mt-4">
            <ProfileFields profile={profile} limits={limits} onChange={onChange} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** The selected step's fields: what it is called, what its pump does and how, its temperature, its limit, when it moves on and what else ends it. */
function StepFields({
  profile,
  index,
  step,
  limits,
  onSelect,
  onChange,
}: {
  profile: Profile;
  index: number;
  step: ProfileStep;
  limits: ProfileLimits;
  onSelect(step: number): void;
  onChange: ProfileChange;
}) {
  const at = `steps.${index}`;
  const set = (next: ProfileStep, field: string | null) => onChange(setStep(profile, index, next), field === null ? null : `${at}.${field}`);
  const capped = OTHER[step.pump];
  const brew = brewTemperature(profile) ?? step.temperature;
  const brewField = useBrewTemperature(profile, limits, onChange);
  // The limit's easing range, kept while its limit is emptied to be typed again.
  const easing = useRef(step.limiter?.range ?? 0.6);
  if (step.limiter) easing.current = step.limiter.range;
  return (
    <div className="grid gap-4" aria-label={`${stepLabel(profile, index)}'s fields`} role="group">
      <TextField label="Name" value={step.name} onChange={(name) => set({ ...step, name }, "name")} />
      <Choice
        label="The pump controls"
        value={step.pump}
        choices={[
          ["pressure", "Pressure"],
          ["flow", "Flow"],
        ]}
        onChange={(pump) => set(withPump(step, pump), null)}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Target" unit={UNIT[step.pump]} value={step.pump === "pressure" ? step.pressure : step.flow} range={targetRange(step, limits)} onChange={(value) => set(withTarget(step, value ?? 0), step.pump)} />
        <NumberField label="For at most" unit="s" value={step.seconds} range={limits.seconds} onChange={(value) => set({ ...step, seconds: value ?? 0 }, "seconds")} />
      </div>
      <Choice
        label="Gets there"
        value={step.transition}
        choices={[
          ["fast", "At once"],
          ["smooth", "Over the whole step"],
        ]}
        info={<p>At once jumps to the target as the step begins. Over the whole step ramps to it from the value measured as the step begins, reaching it at the step&apos;s maximum time.</p>}
        onChange={(transition) => set({ ...step, transition }, null)}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label={`Limit ${capped} to`}
          unit={UNIT[capped]}
          off
          value={step.limiter && step.limiter.value > 0 ? step.limiter.value : null}
          range={limitRange(step, limits)}
          onChange={(value) => set({ ...step, limiter: value === null || value === 0 ? null : { value, range: step.limiter?.range ?? easing.current } }, "limiter.value")}
        />
        {step.limiter && step.limiter.value > 0 && (
          <NumberField
            label="Easing over"
            unit={UNIT[capped]}
            value={step.limiter.range}
            range={limits.limiterRange}
            onChange={(value) => set({ ...step, limiter: { value: step.limiter!.value, range: value ?? 0 } }, "limiter.range")}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Picker label="Moves on when" value={movesOn(step)} choices={MOVES_ON} onChange={(choice) => set(withMovesOn(step, choice as MovesOn, limits), "exit.type")} />
        {step.exit && (
          <NumberField
            label="At"
            unit={UNIT[step.exit.type]}
            value={step.exit.value}
            range={exitRange(step.exit.type, limits)}
            hint={step.seconds < 0.05 ? "A step of no length never waits for its exit" : undefined}
            onChange={(value) => set({ ...step, exit: { ...step.exit!, value: value ?? 0 } }, "exit.value")}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {index === 0 ? (
          <NumberField
            label="Temperature"
            unit="°C"
            value={step.temperature}
            range={limits.temperature}
            info={<p>The brew temperature, moving the later steps with it. A Recipe&apos;s brew temperature replaces it.</p>}
            onChange={brewField.onChange}
            onBlur={brewField.onBlur}
          />
        ) : (
          <NumberField
            label="Temperature"
            unit="°C"
            value={relativeTo(profile, index)}
            range={{ min: limits.temperature.min - brew, max: limits.temperature.max - brew }}
            hint={`${measure(step.temperature)} °C at a ${measure(brew)} °C brew`}
            onChange={(value) => onChange(withRelativeTemperature(profile, index, value ?? 0, limits.temperature), `${at}.temperature`)}
          />
        )}
        <Choice
          label="Measured at"
          value={step.sensor}
          choices={[
            ["coffee", "Coffee"],
            ["water", "Water"],
          ]}
          onChange={(sensor) => set({ ...step, sensor }, null)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Or after pumping" unit="ml" off value={step.volume > 0 ? step.volume : null} range={limits.volume} onChange={(value) => set({ ...step, volume: value ?? 0 }, "volume")} />
        <NumberField
          label="Or at a weight of"
          unit="g"
          off
          value={step.weight !== null && step.weight > 0 ? step.weight : null}
          range={limits.weight}
          hint={step.weight !== null && step.weight > 0 ? "Needs a scale" : undefined}
          onChange={(value) => set({ ...step, weight: value === null || value === 0 ? null : value }, "weight")}
        />
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button
          variant="outline"
          onClick={() => {
            onChange(duplicateStep(profile, index), null);
            onSelect(index + 1);
          }}
        >
          Duplicate the step
        </Button>
        <Button
          variant="outline"
          className="text-destructive"
          onClick={() => {
            onChange(deleteStep(profile, index), null);
            onSelect(Math.max(0, Math.min(index, profile.steps.length - 2)));
          }}
        >
          Delete the step
        </Button>
      </div>
    </div>
  );
}

/** The whole profile's fields: its title, author and notes, brew temperature, where it stops, where preinfusion ends, its tank temperature and its drink. */
function ProfileFields({ profile, limits, onChange }: { profile: Profile; limits: ProfileLimits; onChange: ProfileChange }) {
  const brew = brewTemperature(profile);
  const brewField = useBrewTemperature(profile, limits, onChange);
  const end = preinfusionEnd(profile);
  return (
    <div className="grid gap-4" role="group" aria-label="The whole Profile's fields">
      <TextField label="Title" value={profile.title} onChange={(title) => onChange({ ...profile, title }, "title")} />
      <TextField label="Author" value={profile.author} onChange={(author) => onChange({ ...profile, author }, "author")} />
      <TextField label="Notes" long value={profile.notes} onChange={(notes) => onChange({ ...profile, notes }, "notes")} />
      {brew !== null && (
        <NumberField
          label="Brew temperature"
          unit="°C"
          value={brew}
          range={limits.temperature}
          info={<p>The first step&apos;s temperature, moving the others with it. A Recipe&apos;s brew temperature replaces it.</p>}
          onChange={brewField.onChange}
          onBlur={brewField.onBlur}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Stop at weight"
          unit="g"
          off
          value={profile.target_weight !== null && profile.target_weight > 0 ? profile.target_weight : null}
          range={limits.targetWeight}
          info={<p>A Recipe&apos;s yield replaces it.</p>}
          onChange={(value) => onChange({ ...profile, target_weight: value ?? 0 }, "target_weight")}
        />
        <NumberField
          label="Stop at volume"
          unit="ml"
          off
          value={profile.target_volume !== null && profile.target_volume > 0 ? profile.target_volume : null}
          range={limits.targetVolume}
          info={<p>Used with no scale, counted after preinfusion.</p>}
          onChange={(value) => onChange({ ...profile, target_volume: value ?? 0 }, "target_volume")}
        />
      </div>
      <Picker
        label="Preinfusion ends"
        value={end === null ? "none" : String(end)}
        choices={[["none", "No preinfusion"], ...profile.steps.map((step, index): [string, string] => [String(index), `After step ${index + 1}, ${stepName(step, index)}`])]}
        onChange={(value) => onChange(withPreinfusionEnd(profile, value === "none" ? null : Number(value)), null)}
      />
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Tank temperature"
          unit="°C"
          off
          value={profile.tank_temperature > 0 ? profile.tank_temperature : null}
          range={limits.tankTemperature}
          onChange={(value) => onChange({ ...profile, tank_temperature: value ?? 0 }, "tank_temperature")}
        />
        <Picker
          label="Drink"
          value={profile.beverage_type}
          choices={BEVERAGE_TYPES.map((kind): [string, string] => [kind, kind.charAt(0).toUpperCase() + kind.slice(1)])}
          onChange={(value) => onChange({ ...profile, beverage_type: value as BeverageType }, null)}
        />
      </div>
    </div>
  );
}

/** One check, naming its step, which choosing selects. */
function CheckItem({ check, blocking, onSelect }: { check: ProfileCheck; blocking: boolean; onSelect(step: number): void }) {
  const Icon = blocking ? CircleX : TriangleAlert;
  const text = (
    <>
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${blocking ? "text-destructive" : "text-amber-600 dark:text-amber-500"}`} />
      <span>{check.message}</span>
    </>
  );
  return (
    <li data-check={check.code}>
      {check.step === null ? (
        <p className="flex gap-2 py-2">{text}</p>
      ) : (
        <button type="button" className="flex w-full gap-2 rounded-sm py-2 text-left hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => onSelect(check.step!)}>
          {text}
        </button>
      )}
    </li>
  );
}

/** A count of checks in words, such as "1 thing stops publishing" or "2 pieces of advice". */
function checksText(blocking: number, advice: number): string {
  const stops = blocking === 0 ? "Nothing stops publishing" : `${blocking} ${blocking === 1 ? "thing stops" : "things stop"} publishing`;
  return advice === 0 ? stops : `${stops} · ${advice} ${advice === 1 ? "piece" : "pieces"} of advice`;
}

/**
 * The checks, beside Publish (#623): a status saying whether anything stops
 * the Draft from publishing and how much advice there is, which opens their
 * list: what stops it, and what the machine accepts that may not be meant,
 * each naming its step. Choosing one selects its step and closes the list.
 */
export function ChecksStatus({ checks, onSelect }: { checks: ProfileChecks; onSelect(step: number): void }) {
  const [open, setOpen] = useState(false);
  const blocking = checks.blocking.length;
  const advice = checks.advice.length;
  const text = checksText(blocking, advice);
  const Icon = blocking > 0 ? CircleX : advice > 0 ? TriangleAlert : CircleCheck;
  const tone = blocking > 0 ? "text-destructive" : advice > 0 ? "text-amber-600 dark:text-amber-500" : "text-emerald-600";
  const choose = (step: number) => {
    setOpen(false);
    onSelect(step);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Its words wrap rather than run past a phone's width. */}
        <Button variant="outline" aria-label={`Checks: ${text}`} className="h-auto min-h-8 max-w-full shrink py-1 text-left whitespace-normal">
          <Icon aria-hidden className={tone} />
          {text}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Checks"
        tabIndex={-1}
        // A long list scrolls within itself rather than running past the window's end.
        className="max-h-(--radix-popover-content-available-height) w-96 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto"
        // Opens with focus on the first check that selects a step, or on the list, not on the info icon, whose tooltip would open with it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const list = event.currentTarget as HTMLElement;
          (list.querySelector<HTMLElement>("li button") ?? list).focus();
        }}
      >
        <span className="flex items-center gap-1.5 font-medium">
          Checks
          <InfoTip label="About Checks">
            <p>
              What stops this Draft from publishing, and advice: what the machine accepts but may not be meant, such as a weight limit on a Machine with no scale or a target the
              simulated run never reaches. Values are held to the widest ranges of the models the account has Machines of. Choose one to select its step.
            </p>
          </InfoTip>
        </span>
        {blocking > 0 && (
          <section aria-label="Stops it publishing">
            <h3 className="font-medium">Stops it publishing</h3>
            <ul className="grid divide-y">
              {checks.blocking.map((check) => (
                <CheckItem key={`${check.code}-${check.path ?? check.step}`} check={check} blocking onSelect={choose} />
              ))}
            </ul>
          </section>
        )}
        {advice > 0 ? (
          <section aria-label="Advice">
            <h3 className="font-medium">Advice</h3>
            <ul className="grid divide-y">
              {checks.advice.map((check) => (
                <CheckItem key={`${check.code}-${check.path ?? check.step}`} check={check} blocking={false} onSelect={choose} />
              ))}
            </ul>
          </section>
        ) : (
          blocking === 0 && <p className="text-muted-foreground">Nothing stops this from publishing, and there is no advice.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The Draft's steps, in plain words, each chosen to select it, moved up or down, and one added after the selected step. */
export function EditableStepsCard({
  profile,
  run,
  selected,
  onSelect,
  onChange,
}: {
  profile: Profile;
  run: SimulatedRun | undefined;
  selected: number;
  onSelect(step: number): void;
  onChange: ProfileChange;
}) {
  const end = preinfusionEnd(profile);
  return (
    <Card role="region" aria-label="Steps" className="min-w-0">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitleWithInfo title="Steps">
          <p>
            What the Machine follows, in order. Choose a step to edit it in the inspector and on the graph; move it up or down to reorder. Where preinfusion ends stays on the step
            it ends after, wherever that step goes.
          </p>
        </CardTitleWithInfo>
        <Button
          variant="outline"
          onClick={() => {
            const after = profile.steps.length === 0 ? -1 : selected;
            onChange(addStep(profile, after), null);
            onSelect(after + 1);
          }}
        >
          <Plus aria-hidden /> Add a step
        </Button>
      </CardHeader>
      {/* A container, so a row lays its words out by the card's width: one column in the rail beside the graph, four under it. */}
      <CardContent className="@container">
        {profile.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No steps yet.</p>
        ) : (
          <ol className="grid divide-y rounded-md border" aria-label="Steps">
            {profile.steps.map((step, index) => {
              const name = stepName(step, index);
              const current = index === selected;
              return (
                <li key={index} aria-current={current ? "step" : undefined} className={`flex min-w-0 items-center gap-2 px-2 py-1.5 ${current ? "bg-primary/[0.06] shadow-[inset_3px_0_0] shadow-primary" : ""}`}>
                  <button
                    type="button"
                    className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-sm px-1 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none @lg:grid-cols-[1.5rem_8rem_minmax(0,1fr)_minmax(0,14rem)] @lg:items-baseline @lg:gap-3"
                    aria-label={`Select step ${index + 1}, ${name}`}
                    onClick={() => onSelect(index)}
                  >
                    <span className="row-span-3 text-sm text-muted-foreground tabular-nums @lg:row-span-1">{index + 1}</span>
                    <span className="col-start-2 truncate font-semibold @lg:col-start-auto">
                      {name}
                      {end === index && <span className="block text-xs font-normal text-muted-foreground">Preinfusion ends</span>}
                    </span>
                    <span className="col-start-2 text-sm @lg:col-start-auto">{stepAction(profile, index)}</span>
                    <span className="col-start-2 text-sm text-muted-foreground @lg:col-start-auto @lg:text-right">{run ? stepSimulated(profile, run, index) : stepMovesOn(step)}</span>
                  </button>
                  <div className="flex shrink-0 flex-col @lg:flex-row">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${name} up`}
                      disabled={index === 0}
                      onClick={() => {
                        onChange(moveStep(profile, index, index - 1), null);
                        onSelect(index - 1);
                      }}
                    >
                      <ChevronUp aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move ${name} down`}
                      disabled={index === profile.steps.length - 1}
                      onClick={() => {
                        onChange(moveStep(profile, index, index + 1), null);
                        onSelect(index + 1);
                      }}
                    >
                      <ChevronDown aria-hidden />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
