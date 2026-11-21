import {
  MACHINE_MODELS,
  MAX_PROFILE_STEPS,
  type MachineModel,
  type Profile,
  type Sample,
  type ShotCurve,
  type SimulatedRun,
  type SimulationShot,
  STANDARD_DOSE,
  simulationShotOf,
} from "@decent-sync/protocol";
import { useEffect, useState } from "react";
import { InfoTip } from "@/components/info-tip";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { type Shot, api } from "@/lib/api";
import { measure, seconds } from "@/lib/profile-words";

// The controls and figures of a Profile's simulation (#578), shared by its
// page and the comparison of two versions: the standard puck's finer to
// coarser control, the dose, the stop-at weight and the Machine model; the
// run's headline figures; and a Shot read for its puck or to lay over a graph.

/** The most coffee a dose may be, g, as the REST API takes one. */
export const MAX_DOSE = 50;
/** The most a stop-at weight may be, g. */
export const MAX_STOP_AT = 500;

/** What a standard puck's simulation is asked for. */
export interface PuckAsk {
  /** -1, the finest, to 1, the coarsest. */
  grind: number;
  /** g. */
  dose: number;
  /** g, 0 to run until the last step ends. */
  stopAt: number;
  model: MachineModel;
}

/** What a simulation of a profile starts at: 18 g on the standard puck at its middle grind, stopping at the profile's stop-at weight, as the model given. */
export function startingAsk(profile: Profile | null, model: MachineModel | undefined): PuckAsk {
  return { grind: 0, dose: STANDARD_DOSE, stopAt: profile?.target_weight && profile.target_weight > 0 ? profile.target_weight : 0, model: model ?? "DE1" };
}

/** Why a profile can't be simulated, or null where it can. */
export function unsimulatable(profile: Profile | null): string | null {
  if (!profile) return "Its profile can't be read as Decaid reads one, so it can't be simulated.";
  if (profile.steps.length === 0) return "It has no steps to simulate.";
  if (profile.steps.length > MAX_PROFILE_STEPS) return `It has ${profile.steps.length} steps, more than the ${MAX_PROFILE_STEPS} a machine takes, so it can't be simulated.`;
  return null;
}

/** A number typed into a field, or undefined where it is not one within `min` (exclusive where `above`) and `max`. */
function typed(text: string, min: number, max: number, above = false): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && (above ? value > min : value >= min) && value <= max ? value : undefined;
}

/** A field of grams that changes the ask only with a valid number, keeping what was typed while it isn't. */
function GramsField({ label, value, min, max, above, onChange }: { label: string; value: number; min: number; max: number; above?: boolean; onChange(value: number): void }) {
  const [text, setText] = useState(measure(value));
  // A value set from outside, such as a Recipe's, shows in the field.
  useEffect(() => setText((shown) => (typed(shown, min, max, above) === value ? shown : measure(value))), [value, min, max, above]);
  const invalid = typed(text, min, max, above) === undefined;
  const id = `grams-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        className="h-8 w-16 tabular-nums"
        value={text}
        aria-invalid={invalid}
        onChange={(event) => {
          setText(event.target.value);
          const next = typed(event.target.value, min, max, above);
          if (next !== undefined) onChange(next);
        }}
      />
      <span className="text-sm text-muted-foreground">g</span>
    </div>
  );
}

/** The dose and the stop-at weight. */
export function DoseFields({ ask, onChange }: { ask: Pick<PuckAsk, "dose" | "stopAt">; onChange(change: Partial<PuckAsk>): void }) {
  return (
    <>
      <GramsField label="Dose" value={ask.dose} min={0} above max={MAX_DOSE} onChange={(dose) => onChange({ dose })} />
      <GramsField label="Stop at" value={ask.stopAt} min={0} max={MAX_STOP_AT} onChange={(stopAt) => onChange({ stopAt })} />
    </>
  );
}

/** The Machine model the simulation runs as. */
export function ModelChoice({ model, onChange }: { model: MachineModel; onChange(model: MachineModel): void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Machine</span>
      <Segmented label="Machine" value={model} onValueChange={(value) => value && onChange(value as MachineModel)}>
        {MACHINE_MODELS.map((each) => (
          <SegmentedItem key={each} value={each}>
            {each}
          </SegmentedItem>
        ))}
      </Segmented>
      <InfoTip label="About the machine">
        <p>
          Simulated as this model runs it: a DE1&apos;s pump gives about 8 ml/s at most, and a Bengle&apos;s heater keeps up with about 15 ml/s at most. It starts as the model of the
          Machines at the Locations showing the Profile: a Bengle where all of them are, otherwise a DE1. On a Shot&apos;s puck it starts as the model of the Shot&apos;s Machine.
        </p>
      </InfoTip>
    </div>
  );
}

/** The standard puck's one control, from finer to coarser. */
export function GrindControl({ grind, onChange }: { grind: number; onChange(grind: number): void }) {
  return (
    <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:min-w-64 sm:basis-auto">
      <span className="text-sm text-muted-foreground">Puck</span>
      <span className="text-xs">Finer</span>
      <Slider label="Puck, finer to coarser" min={-1} max={1} step={0.05} value={[grind]} onValueChange={([value]) => onChange(value ?? 0)} className="min-w-24 flex-1" />
      <span className="text-xs">Coarser</span>
    </div>
  );
}

/** A run's headline figures: its time, first drip, peak pressure and flow at the stop, each with how far it is from `against`'s where given. */
export function RunFigures({ run, against }: { run: SimulatedRun; against?: { label: string; samples: Sample<ShotCurve>[] } }) {
  const shot = against ? figuresOf(against.samples) : undefined;
  const flowAtStop = run.samples.at(-1)?.values.flow ?? 0;
  const figures: { term: string; value: string; compared?: string }[] = [
    { term: "Time", value: seconds(run.duration), compared: shot && differs(run.duration - shot.duration, "s", "longer", "shorter") },
    { term: "First drip", value: run.timeToFirstDrip === null ? "None" : seconds(run.timeToFirstDrip), compared: shot && run.timeToFirstDrip !== null && shot.firstDrip !== null ? differs(run.timeToFirstDrip - shot.firstDrip, "s", "later", "sooner") : undefined },
    { term: "Peak pressure", value: `${measure(run.peakPressure)} bar`, compared: shot && differs(run.peakPressure - shot.peakPressure, "bar", "higher", "lower") },
    { term: "Flow at the stop", value: `${measure(flowAtStop)} ml/s`, compared: shot && differs(flowAtStop - shot.flowAtStop, "ml/s", "faster", "slower") },
  ];
  return (
    <dl aria-label="Simulated figures" className="flex flex-wrap gap-x-8 gap-y-3 tabular-nums">
      {figures.map((figure) => (
        <div key={figure.term} className="grid gap-0.5">
          <dt className="text-sm text-muted-foreground">{figure.term}</dt>
          <dd className="text-2xl leading-tight font-semibold">{figure.value}</dd>
          {figure.compared && <dd className="text-xs text-muted-foreground">{figure.compared === "The same" ? `The same as ${against!.label}` : `${figure.compared} than ${against!.label}`}</dd>}
        </div>
      ))}
    </dl>
  );
}

function differs(by: number, unit: string, more: string, less: string): string {
  return Math.abs(by) < 0.05 ? "The same" : `${measure(Math.abs(by))} ${unit} ${by > 0 ? more : less}`;
}

/** A Shot's own headline figures, after its Preheat. */
function figuresOf(samples: Sample<ShotCurve>[]): { duration: number; firstDrip: number | null; peakPressure: number; flowAtStop: number } {
  const shot = samples.filter((sample) => sample.shade === null && sample.seconds >= 0);
  const drip = shot.find((sample) => (sample.values.weight ?? 0) >= 1);
  return {
    duration: shot.at(-1)?.seconds ?? 0,
    firstDrip: drip?.seconds ?? null,
    peakPressure: shot.reduce((peak, sample) => Math.max(peak, sample.values.pressure ?? 0), 0),
    flowAtStop: shot.at(-1)?.values.flow ?? 0,
  };
}

/** A Shot read for a Profile's graph: as the Shots list gives it, with what a simulation on its puck reads of it. */
export interface GraphShot {
  shot: Shot;
  simulation: SimulationShot;
}

/** Reads a Shot for a Profile's graph, its curves and what its puck is worked out from. */
export async function loadGraphShot(id: string): Promise<GraphShot> {
  const path = `/shots/${encodeURIComponent(id)}`;
  const [{ shot }, { measurements }] = await Promise.all([api<{ shot: Shot }>("GET", path), api<{ measurements: unknown }>("GET", `${path}/measurements`)]);
  return { shot, simulation: simulationShotOf(shot.record, measurements) };
}
