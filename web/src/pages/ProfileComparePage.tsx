import { type Profile as ProfileDefinition, type SimulatedRun, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ProfileGraph } from "@/components/profile-graph";
import { DoseFields, GrindControl, ModelChoice, type PuckAsk, startingAsk, unsimulatable } from "@/components/profile-simulation";
import { profilePath, profileTitle } from "@/components/profiles";
import { CurveMark } from "@/components/curves";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Profile, type ProfileVersion } from "@/lib/api";
import { measure, profileFacts, seconds, stepAction, stepMovesOn, stepName } from "@/lib/profile-words";
import { versionNames } from "@/lib/profile-versions";
import { definitionOf, graphWords, useProfile } from "@/pages/ProfilePage";

/**
 * Two of a Profile's versions compared (#578): what differs in their steps,
 * in the words the Profile page uses, and each simulated on the same puck,
 * drawn in one graph, the first in blue and the other in orange.
 */
export function ProfileComparePage() {
  const { id = "", other = "" } = useParams();
  return <Comparison key={`${id} ${other}`} id={id} other={other} />;
}

function Comparison({ id, other }: { id: string; other: string }) {
  const navigate = useNavigate();
  const first = useProfile(id);
  const second = useProfile(other);
  const [versions, setVersions] = useState<ProfileVersion[]>();
  useEffect(() => {
    let current = true;
    api<{ versions: ProfileVersion[] }>("GET", `/profiles/${encodeURIComponent(id)}/versions`).then(
      ({ versions }) => current && setVersions(versions),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id]);
  const names = versions ? versionNames(versions) : new Map<string, string>();
  const nameOf = (profile: Profile) => names.get(profile.id) ?? profileTitle(profile);

  const back = (
    <Link to={profilePath(id)} className="text-sm text-muted-foreground hover:text-foreground">
      ← {first.profile ? profileTitle(first.profile) : "The Profile"}
    </Link>
  );
  if (first.profile === null || second.profile === null) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Profile.</p>
      </section>
    );
  }
  if (!first.profile || !second.profile) {
    const error = first.error ?? second.error;
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

  const one = { profile: first.profile, definition: definitionOf(first.profile), name: nameOf(first.profile) };
  const two = { profile: second.profile, definition: definitionOf(second.profile), name: nameOf(second.profile) };
  const choose = (side: "first" | "second") => (value: string) =>
    navigate(side === "first" ? `${profilePath(value)}/compare/${encodeURIComponent(other)}` : `${profilePath(id)}/compare/${encodeURIComponent(value)}`);

  return (
    <section className="grid min-w-0 gap-6">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{profileTitle(one.profile)}</h1>
        <VersionChoice label="Compared" which="current" value={one.profile.id} name={one.name} versions={versions} names={names} onChange={choose("first")} />
        <span className="text-muted-foreground">against</span>
        <VersionChoice label="Compared with" which="previous" value={two.profile.id} name={two.name} versions={versions} names={names} onChange={choose("second")} />
      </div>
      <Compared one={one} two={two} />
    </section>
  );
}

function VersionChoice({
  label,
  which,
  value,
  name,
  versions,
  names,
  onChange,
}: {
  label: string;
  which: "current" | "previous";
  value: string;
  name: string;
  versions: ProfileVersion[] | undefined;
  names: Map<string, string>;
  onChange(value: string): void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="w-auto gap-2">
        <CurveMark of={which} />
        <SelectValue>{name}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(versions ?? []).map((version) => (
          <SelectItem key={version.id} value={version.id}>
            {names.get(version.id) ?? version.id}
          </SelectItem>
        ))}
        {!versions?.some((version) => version.id === value) && <SelectItem value={value}>{name}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

interface Side {
  profile: Profile;
  definition: ProfileDefinition | null;
  name: string;
}

function Compared({ one, two }: { one: Side; two: Side }) {
  const [ask, setAsk] = useState<PuckAsk>(() => startingAsk(one.definition, one.profile.machineModel));
  const change = (next: Partial<PuckAsk>) => setAsk((now) => ({ ...now, ...next }));
  const runOf = (definition: ProfileDefinition | null) =>
    unsimulatable(definition) || !definition ? undefined : simulateProfile({ profile: definition, puck: standardPuck(ask.grind), dose: ask.dose, stopAt: ask.stopAt, model: ask.model });
  const runOne = useMemo(() => runOf(one.definition), [one.definition, ask]); // eslint-disable-line react-hooks/exhaustive-deps
  const runTwo = useMemo(() => runOf(two.definition), [two.definition, ask]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = one.definition && two.definition ? differences(one.definition, two.definition) : [];
  const figures = runOne && runTwo ? figureRows(one.definition!, runOne, runTwo) : [];

  return (
    <>
      <Card role="region" aria-label="What differs">
        <CardHeader>
          <CardTitleWithInfo title="What differs">
            <p>What each version asks of the Machine where the two differ, in their steps and in what each Profile states once, then each simulated on the same puck.</p>
          </CardTitleWithInfo>
        </CardHeader>
        <CardContent>
          <div className="min-w-0 overflow-x-auto rounded-md border">
            <Table aria-label="What differs between the versions" className="min-w-[36rem]">
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>
                    <span className="inline-flex items-center gap-2">
                      <CurveMark of="current" />
                      {one.name}
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center gap-2">
                      <CurveMark of="previous" />
                      {two.name}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-muted-foreground">
                      Their steps ask the same of the Machine.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map(([term, a, b]) => (
                  <TableRow key={term}>
                    <TableHead scope="row" className="font-normal whitespace-normal text-muted-foreground">
                      {term}
                    </TableHead>
                    <TableCell className="whitespace-normal">{a}</TableCell>
                    <TableCell className="whitespace-normal">{b}</TableCell>
                  </TableRow>
                ))}
                {figures.length > 0 && (
                  <TableRow>
                    <TableHead scope="row" colSpan={3} className="font-medium text-foreground">
                      {`Simulated on a standard puck, ${measure(ask.dose)} g in, ${ask.stopAt > 0 ? `stopping at ${measure(ask.stopAt)} g` : "running until the last step ends"}, on a ${ask.model}`}
                    </TableHead>
                  </TableRow>
                )}
                {figures.map(([term, a, b]) => (
                  <TableRow key={`figure ${term}`}>
                    <TableHead scope="row" className="font-normal whitespace-normal text-muted-foreground">
                      {term}
                    </TableHead>
                    <TableCell className="tabular-nums">{a}</TableCell>
                    <TableCell className="tabular-nums">{b}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card role="region" aria-label="How each runs">
        <CardHeader>
          <CardTitleWithInfo title="How each runs, simulated">
            <p>Both versions simulated on the same standard puck, with the same dose, stop-at weight and Machine model: a simulation, not a measurement.</p>
          </CardTitleWithInfo>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <DoseFields ask={ask} onChange={change} />
            <ModelChoice model={ask.model} onChange={(model) => change({ model })} />
            <GrindControl grind={ask.grind} onChange={(grind) => change({ grind })} />
          </div>
          {runOne && one.definition ? (
            <ProfileGraph
              profile={one.definition}
              run={runOne}
              runLabel={`${one.name}, simulated`}
              label={graphWords(one.name, one.definition, runOne, false)}
              compared={runTwo ? { label: `${two.name}, simulated`, samples: withPlannedTemperature(runTwo.samples), stop: { seconds: runTwo.stop.seconds, label: `${two.name} stops` } } : null}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{unsimulatable(one.definition)}</p>
          )}
          {!runTwo && <p className="text-sm text-muted-foreground">{`${two.name}: ${unsimulatable(two.definition)}`}</p>}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * A run's samples with its planned temperature as the temperature drawn, as
 * temperature is not simulated, so a version whose change is its temperature
 * shows it in the temperature lane.
 */
function withPlannedTemperature(samples: SimulatedRun["samples"]): SimulatedRun["samples"] {
  return samples.map((sample) => ({ ...sample, values: { ...sample.values, temperature: sample.targets.temperature } }));
}

/** Where two profiles differ, in the Profile page's words: each step's action and when it moves on, then what each states once. */
export function differences(a: ProfileDefinition, b: ProfileDefinition): [string, string, string][] {
  const rows: [string, string, string][] = [];
  const count = Math.max(a.steps.length, b.steps.length);
  for (let index = 0; index < count; index++) {
    const stepA = a.steps[index];
    const stepB = b.steps[index];
    const name = stepName(stepA ?? stepB!, index);
    if (!stepA || !stepB) {
      rows.push([`Step ${index + 1}`, stepA ? `${name}: ${stepAction(a, index)}` : "None", stepB ? `${name}: ${stepAction(b, index)}` : "None"]);
      continue;
    }
    if (stepName(stepA, index) !== stepName(stepB, index)) rows.push([`Step ${index + 1} is named`, stepName(stepA, index), stepName(stepB, index)]);
    const actionA = stepAction(a, index);
    const actionB = stepAction(b, index);
    if (actionA !== actionB) rows.push([`${name} does`, actionA, actionB]);
    const onA = stepMovesOn(stepA);
    const onB = stepMovesOn(stepB);
    if (onA !== onB) rows.push([`${name} moves on`, onA, onB]);
  }
  const factsB = profileFacts(b);
  profileFacts(a).forEach((fact, index) => {
    if (fact.text !== factsB[index]!.text) rows.push([fact.term, fact.text, factsB[index]!.text]);
  });
  if (a.beverage_type !== b.beverage_type) rows.push(["Kind of drink", a.beverage_type, b.beverage_type]);
  return rows;
}

/** Two runs' figures side by side: time, first drip, peak pressure, and how long each step lasted. */
function figureRows(profile: ProfileDefinition, a: SimulatedRun, b: SimulatedRun): [string, string, string][] {
  const lasted = (run: SimulatedRun, index: number) => {
    const step = run.steps[index];
    if (!step || step.start === null || step.end === null) return "Not reached";
    return step.end === step.start ? "Passed through at once" : seconds(step.end - step.start);
  };
  return [
    ["Time", seconds(a.duration), seconds(b.duration)],
    ["First drip", a.timeToFirstDrip === null ? "None" : seconds(a.timeToFirstDrip), b.timeToFirstDrip === null ? "None" : seconds(b.timeToFirstDrip)],
    ["Peak pressure", `${measure(a.peakPressure)} bar`, `${measure(b.peakPressure)} bar`],
    ...profile.steps.map((step, index): [string, string, string] => [`${stepName(step, index)} lasts`, lasted(a, index), lasted(b, index)]),
  ];
}
