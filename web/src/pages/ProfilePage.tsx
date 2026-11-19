import { type Profile as ProfileDefinition, type ShotFit, type SimulatedRun, profileOf, profileTextOf, simulateOnShot, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { ItemConflictsCard, ItemHistoryCard, SourceText, itemPath } from "@/components/conflicts";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ArchiveButton, ContentForm, DeleteButton, PROFILE_FIELDS } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { ProfileGraph } from "@/components/profile-graph";
import { DoseFields, type GraphShot, GrindControl, ModelChoice, type PuckAsk, RunFigures, loadGraphShot, startingAsk, unsimulatable } from "@/components/profile-simulation";
import { ProfileBadges, ProfileLocationsCard, profilePath, profileTitle } from "@/components/profiles";
import { OrNone } from "@/components/records";
import { Segmented, SegmentedItem } from "@/components/segmented";
import { ShotPicker } from "@/components/shot-picker";
import { shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Profile, type ProfileVersion, type RecipeOnProfile } from "@/lib/api";
import { measure, profileFacts, seconds, stepAction, stepMovesOn, stepName, stepSimulated } from "@/lib/profile-words";
import { earlierVersions, versionNames } from "@/lib/profile-versions";
import { shotsText } from "@/lib/shot-summary";

/**
 * One Profile (#578): how it runs, as a simulation on a puck drawn in lanes
 * with the plan behind it, on the standard puck or a Shot's, with any Shot
 * laid over it; its steps in plain words; its Profile Versions, any two of
 * which can be compared; the Locations showing it, the Recipes on it and the
 * Shots pulled on it and its earlier versions; and its title, author and
 * notes, which can be edited here. Export gives its profile as Decaid's JSON.
 */
export function ProfilePage() {
  const { id = "" } = useParams();
  return <ProfileDetails key={id} id={id} />;
}

/** Reads a Profile, again each time `changes` rises: undefined until read, null for none. */
export function useProfile(id: string, changes = 0): { profile: Profile | null | undefined; error: string | undefined } {
  const [profile, setProfile] = useState<Profile | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api<{ profile: Profile }>("GET", `/profiles/${encodeURIComponent(id)}`).then(
      ({ profile }) => current && setProfile(profile),
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404) setProfile(null);
        else setError(caught instanceof Error ? caught.message : "The Profile could not be loaded");
      },
    );
    return () => {
      current = false;
    };
  }, [id, changes]);
  return { profile, error };
}

/** Its profile, as Decaid reads it, from its record where the server, of the release before, gives none (ADR-0025). */
export function definitionOf(profile: Profile): ProfileDefinition | null {
  return profile.profile === undefined ? profileOf(profile.content.profile) : profile.profile;
}

function ProfileDetails({ id }: { id: string }) {
  const mayChange = useMayChange();
  const [editing, setEditing] = useState(false);
  // Using a Conflict's value, or a change here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const changed = () => setChanges((count) => count + 1);
  const { profile, error } = useProfile(id, changes);
  const [versions, setVersions] = useState<ProfileVersion[]>();
  const [recipes, setRecipes] = useState<RecipeOnProfile[]>();
  const [sideError, setSideError] = useState<string>();
  const path = `/profiles/${encodeURIComponent(id)}`;

  useEffect(() => {
    let current = true;
    // A server of the release before has neither route, as during a deploy (ADR-0025): the page goes without them.
    const failed = (caught: unknown) => current && !(caught instanceof ApiError && caught.status === 404) && setSideError(caught instanceof Error ? caught.message : "Could not be loaded");
    api<{ versions: ProfileVersion[] }>("GET", `${path}/versions`).then(({ versions }) => current && setVersions(versions), failed);
    api<{ recipes: RecipeOnProfile[] }>("GET", `${path}/recipes`).then(({ recipes }) => current && setRecipes(recipes), failed);
    return () => {
      current = false;
    };
  }, [path, changes]);

  const back = (
    <Link to="/library/profiles" className="text-sm text-muted-foreground hover:text-foreground">
      ← Profiles
    </Link>
  );
  if (profile === null) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Profile.</p>
      </section>
    );
  }
  if (!profile) {
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

  const definition = definitionOf(profile);
  // Its title, author and notes, read whatever its steps hold, as the server reads them.
  const profileText = profileTextOf(profile.content.profile);
  const names = versions ? versionNames(versions) : new Map<string, string>();
  const earlier = versions ? earlierVersions(versions, profile.id) : [];
  const versionName = versions && versions.length > 1 && !profile.bundled ? names.get(profile.id) : undefined;
  const byline = [definition?.beverage_type && capitalised(definition.beverage_type), text(profileText.author) && `by ${text(profileText.author)}`].filter(Boolean).join(" · ");

  return (
    <section className="grid min-w-0 gap-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
            {profileTitle(profile)} <ProfileBadges profile={profile} />
            {versionName && <Badge variant="outline">{versionName}</Badge>}
          </h1>
          <p className="text-sm text-muted-foreground">
            {byline}
            {profile.parent && (
              <>
                {byline ? " · " : ""}saved from{" "}
                <Link to={profilePath(profile.parent.id)} className="text-foreground underline underline-offset-4">
                  {profileTitle(profile.parent)}
                </Link>
              </>
            )}
          </p>
          <p className="font-mono text-xs break-all text-muted-foreground">{profile.id}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ExportButton profile={profile} />
          {mayChange && (
            <>
              <ArchiveButton path={path} name={profileTitle(profile)} archived={profile.archived} effect="hidden on every tablet that holds it" onDone={changed} />
              {!profile.bundled && <DeleteButton path={path} name={profileTitle(profile)} back="/library/profiles" />}
            </>
          )}
        </div>
      </div>

      <ItemConflictsCard kind="profile" id={id} onResolved={changed} />

      {sideError && (
        <Alert variant="destructive">
          <AlertDescription>{sideError}</AlertDescription>
        </Alert>
      )}

      <HowItRuns profile={profile} definition={definition} earlier={earlier} recipes={recipes ?? []} />

      <StepsCard definition={definition} profile={profile} />

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        <VersionsCard profile={profile} versions={versions} names={names} />
        <div className="grid min-w-0 gap-6">
          <ProfileLocationsCard profile={profile} onChanged={changed} />
          <RecipesCard recipes={recipes} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitleWithInfo title="Title, author and notes">
            {profile.bundled ? (
              <p>One of Decaid&apos;s bundled Profiles, which keep the title, author and notes Decaid gives them.</p>
            ) : (
              <p>
                Outside the steps that decide the Profile&apos;s id, so a change here keeps it the same Profile, and every tablet that holds it is written the change. Its title can&apos;t
                be cleared.
              </p>
            )}
          </CardTitleWithInfo>
        </CardHeader>
        <CardContent className="grid gap-4">
          {/* Closed if the account may no longer save it, as when an Admin made it a Viewer meanwhile. */}
          {editing && mayChange && !profile.bundled ? (
            <ContentForm
              label="Edit the title, author and notes"
              fields={PROFILE_FIELDS}
              content={profileText}
              path={path}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                changed();
              }}
            />
          ) : (
            <>
              <Fields label="Title, author and notes">
                <Field term="Title">
                  <OrNone>{text(profileText.title)}</OrNone>
                </Field>
                <Field term="Author">
                  <OrNone>{text(profileText.author)}</OrNone>
                </Field>
                <Field term="Notes">
                  <OrNone>{text(profileText.notes)}</OrNone>
                </Field>
              </Fields>
              {mayChange && !profile.bundled && (
                <div>
                  <Button variant="outline" aria-label="Edit the title, author and notes" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ShotsCard profile={profile} versions={versions} earlier={earlier} />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>In the Library</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Fields label="In the Library">
            <Field term="Created at">
              <OrNone>{profile.createdLocation?.name}</OrNone>
            </Field>
            <Field term="Joined">{formatTime(profile.createdAt)}</Field>
            <Field term="Target volume">
              <OrNone>{definition?.target_volume ? `${definition.target_volume} ml` : undefined}</OrNone>
            </Field>
          </Fields>
        </CardContent>
      </Card>

      <ItemHistoryCard key={changes} kind="profile" id={id} />
    </section>
  );
}

/** Gives its profile, as its record holds it, as Decaid's profile JSON, in a file named by its title. */
function ExportButton({ profile }: { profile: Profile }) {
  const exportIt = () => {
    const json = `${JSON.stringify(profile.content.profile ?? null, null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(profileTitle(profile).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "profile").slice(0, 80)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <Button variant="outline" onClick={exportIt}>
      <Download aria-hidden /> Export
    </Button>
  );
}

/** The graph of how it runs, simulated on the standard puck or a Shot's, with its controls and figures. */
function HowItRuns({ profile, definition, earlier, recipes }: { profile: Profile; definition: ProfileDefinition | null; earlier: ProfileVersion[]; recipes: RecipeOnProfile[] }) {
  const [ask, setAsk] = useState<PuckAsk>(() => startingAsk(definition, profile.machineModel));
  const [puck, setPuck] = useState<"standard" | "shot">("standard");
  const [puckShot, setPuckShot] = useState<GraphShot>();
  const [overlay, setOverlay] = useState<GraphShot>();
  const [picking, setPicking] = useState<"puck" | "overlay">();
  const [shotError, setShotError] = useState<string>();
  const change = (next: Partial<PuckAsk>) => setAsk((now) => ({ ...now, ...next }));
  const cannot = unsimulatable(definition);

  const result = useMemo(() => {
    if (cannot || !definition) return undefined;
    if (puck === "shot") {
      if (!puckShot) return undefined;
      return simulateOnShot({ profile: definition, shot: puckShot.simulation, dose: ask.dose, stopAt: ask.stopAt, model: ask.model }) ?? null;
    }
    return { run: simulateProfile({ profile: definition, puck: standardPuck(ask.grind), dose: ask.dose, stopAt: ask.stopAt, model: ask.model }), fit: null };
  }, [cannot, definition, puck, puckShot, ask]);

  const choose = (id: string, as: "puck" | "overlay") => {
    setShotError(undefined);
    loadGraphShot(id).then(
      (loaded) => {
        if (as === "overlay") return setOverlay(loaded);
        setPuckShot(loaded);
        setPuck("shot");
        // As the Shot ran: its dose, the weight it stopped at, and its Machine's model.
        const lastWeight = loaded.simulation.samples.reduce<number | null>((last, sample) => sample.values.weight ?? last, null);
        change({ dose: loaded.simulation.dose ?? ask.dose, stopAt: lastWeight !== null && lastWeight > 0 ? Math.round(lastWeight * 10) / 10 : ask.stopAt, model: loaded.simulation.model });
      },
      (caught: unknown) => setShotError(caught instanceof Error ? caught.message : "The Shot could not be loaded"),
    );
  };

  const compared = puck === "shot" && puckShot ? puckShot : puck === "standard" ? overlay : undefined;
  const comparedLabel = puck === "shot" ? "The Shot, as it ran" : "The Shot laid over it";
  const comparedSamples = compared?.simulation.samples ?? [];
  const run = result?.run;
  const words = run && definition ? graphWords(profileTitle(profile), definition, run, puck === "shot") : "";

  return (
    <Card role="region" aria-label="How it runs">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitleWithInfo title="How it runs, simulated">
          <p>
            A simulation of what a Machine does with this Profile, not a measurement: pressure and flow on a puck, with the plan, what each step asks the Machine for, dashed
            behind them. The standard puck has one control from finer to coarser; a Shot&apos;s puck is worked out from that Shot&apos;s pressure and flow. Temperature is not
            simulated, so its lane draws the plan. Each step is a band named at the top with how long it ran and why it ended.
          </p>
        </CardTitleWithInfo>
        {!cannot && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Simulated on</span>
            <Segmented
              label="Simulated on"
              value={puck}
              onValueChange={(value) => {
                if (value === "standard") setPuck("standard");
                else if (value === "shot") {
                  if (puckShot) setPuck("shot");
                  else setPicking("puck");
                }
              }}
            >
              <SegmentedItem value="standard">A standard puck</SegmentedItem>
              <SegmentedItem value="shot">A Shot&apos;s puck</SegmentedItem>
            </Segmented>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {cannot ? (
          <p className="text-sm text-muted-foreground">{cannot}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <DoseFields ask={ask} onChange={change} />
              {puck === "standard" && recipes.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      Use a Recipe&apos;s
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {recipes.map(({ recipe }) => (
                      <DropdownMenuItem
                        key={recipe.id}
                        onSelect={() => {
                          const dose = number(recipe.content.dose);
                          const yielded = number(recipe.content.yield);
                          change({ ...(dose !== undefined && dose > 0 && { dose }), ...(yielded !== undefined && { stopAt: yielded }) });
                        }}
                      >
                        {`${recipe.name ?? "Unnamed"}${recipe.location ? `, ${recipe.location.name}` : ""}`}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <ModelChoice model={ask.model} onChange={(model) => change({ model })} />
              {puck === "standard" && <GrindControl grind={ask.grind} onChange={(grind) => change({ grind })} />}
            </div>

            {shotError && (
              <Alert variant="destructive">
                <AlertDescription>{shotError}</AlertDescription>
              </Alert>
            )}

            {result === null && <p className="text-sm text-muted-foreground">That Shot recorded no pressure and flow to work its puck out from. Choose another.</p>}

            {run && definition && (
              <div className={`grid min-w-0 gap-4 ${puck === "shot" && puckShot ? "xl:grid-cols-[minmax(0,1fr)_24rem]" : ""}`}>
                <div className="grid min-w-0 gap-4">
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <RunFigures run={run} against={puck === "shot" && puckShot ? { label: "the Shot", samples: puckShot.simulation.samples } : undefined} />
                    {puck === "standard" && (
                      <div className="flex flex-wrap items-center gap-2">
                        {overlay && (
                          <Button variant="ghost" size="sm" onClick={() => setOverlay(undefined)}>
                            Remove the Shot
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => setPicking("overlay")}>
                          {overlay ? "Lay another Shot over it" : "Lay a Shot over it"}
                        </Button>
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {`${measure(run.dose)} g in, ${run.stopAt === null ? "running until its last step ends" : `stopping at ${measure(run.stopAt)} g`}, on a ${run.model}`}
                    {compared && puck === "standard" && `, with the Shot of ${shotTime(compared.shot)} on ${compared.shot.machine?.name ?? "a Pending Machine"} over it`}
                  </p>
                  <ProfileGraph
                    profile={definition}
                    run={run}
                    label={words}
                    compared={compared && comparedSamples.length > 0 ? { label: comparedLabel, samples: comparedSamples, stop: { seconds: lastSecond(comparedSamples), label: "The Shot stopped" } } : null}
                  />
                </div>
                {puck === "shot" && puckShot && <PuckShot shot={puckShot} fit={result?.fit ?? null} onChange={() => setPicking("puck")} />}
              </div>
            )}
          </>
        )}
      </CardContent>
      <ShotPicker
        open={picking !== undefined}
        onOpenChange={(open) => !open && setPicking(undefined)}
        title={picking === "puck" ? "Simulate on a Shot's puck" : "Lay a Shot over the graph"}
        description={
          picking === "puck"
            ? "The simulation runs on the puck worked out from this Shot's pressure and flow, with its dose and the weight it stopped at, as the model of its Machine."
            : "The Shot's pressure, flow and temperature are drawn over the simulation."
        }
        profileIds={[profile.id, ...earlier.map((version) => version.id)]}
        onPick={(shot) => picking && choose(shot.id, picking)}
      />
    </Card>
  );
}

/** The Shot whose puck the simulation runs on, and how close a run of its own steps on that puck comes to it. */
function PuckShot({ shot, fit, onChange }: { shot: GraphShot; fit: ShotFit | null; onChange(): void }) {
  const listed = shot.shot;
  const dose = listed.actualDose ?? listed.targetDose;
  const yielded = listed.actualYield ?? listed.targetYield;
  const rows: [string, string, string][] = fit
    ? [
        ["Duration", seconds(fit.simulated.duration), seconds(fit.shot.duration)],
        ["Peak pressure", `${measure(fit.simulated.peakPressure)} bar`, `${measure(fit.shot.peakPressure)} bar`],
        ["First drip", fit.simulated.timeToFirstDrip === null ? "None" : seconds(fit.simulated.timeToFirstDrip), fit.shot.timeToFirstDrip === null ? "None" : seconds(fit.shot.timeToFirstDrip)],
        ...fit.shot.steps.map((step): [string, string, string] => {
          const simulated = fit.simulated.steps.find((each) => each.index === step.index);
          return [`${step.name} ended`, simulated ? seconds(simulated.end) : "Not reached", seconds(step.end)];
        }),
      ]
    : [];
  return (
    <aside aria-label="The puck" className="grid min-w-0 content-start gap-4">
      <section className="grid gap-2 rounded-lg border p-4">
        <h3 className="font-semibold">The Shot whose puck this is</h3>
        <Link to={`/shots/${encodeURIComponent(listed.id)}`} className="font-medium underline-offset-4 hover:underline">
          {`${listed.profileTitle ?? "A Shot"} on ${listed.machine?.name ?? "a Pending Machine"}`}
        </Link>
        <Fields label="The Shot whose puck this is">
          <Field term="Pulled">{shotTime(listed)}</Field>
          <Field term="Dose and yield">
            <OrNone>{dose !== null && yielded !== null ? `${measure(dose)} g in, ${measure(yielded)} g out` : undefined}</OrNone>
          </Field>
          <Field term="Duration">
            <OrNone>{listed.duration === null ? undefined : seconds(listed.duration)}</OrNone>
          </Field>
          <Field term="Pulled on a">{shot.simulation.model}</Field>
        </Fields>
        <div>
          <Button variant="outline" size="sm" onClick={onChange}>
            Choose another Shot
          </Button>
        </div>
      </section>
      <section className="grid gap-2 rounded-lg border p-4" aria-label="How close the simulation is">
        <CardTitleWithInfo title="How close the simulation is">
          <p>The Shot&apos;s own steps simulated on its puck, stopped as it stopped, against what it did: how far to trust the simulation on this puck.</p>
        </CardTitleWithInfo>
        {fit ? (
          <div className="min-w-0 overflow-x-auto rounded-md border">
            <Table aria-label="The simulation against the Shot">
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>Simulated</TableHead>
                  <TableHead>The Shot</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([term, simulated, real]) => (
                  <TableRow key={term}>
                    <TableHead scope="row" className="font-normal whitespace-normal text-muted-foreground">
                      {term}
                    </TableHead>
                    <TableCell className="tabular-nums">{simulated}</TableCell>
                    <TableCell className="tabular-nums">{real}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not worked out for this Shot: its own profile can&apos;t be read or has more steps than a machine takes, or its scale left no weight to stop a run where it stopped.
          </p>
        )}
      </section>
    </aside>
  );
}

/** Its steps in plain words, each with when it moves on and what the simulation on the standard puck did, and the figures it states once. */
function StepsCard({ profile, definition }: { profile: Profile; definition: ProfileDefinition | null }) {
  const run = useMemo(() => {
    if (unsimulatable(definition) || !definition) return undefined;
    const ask = startingAsk(definition, profile.machineModel);
    return simulateProfile({ profile: definition, puck: standardPuck(ask.grind), dose: ask.dose, stopAt: ask.stopAt, model: ask.model });
  }, [definition, profile.machineModel]);
  const steps = definition?.steps ?? [];
  return (
    <Card role="region" aria-label="Steps">
      <CardHeader>
        <CardTitleWithInfo title="Steps">
          <p>
            What the Machine follows, which decides the Profile&apos;s id: new steps make a new Profile. Later steps&apos; temperatures are given against the first&apos;s, as a
            Recipe&apos;s brew temperature moves them all. Simulated is what the simulation did on the standard puck, with 18 g in.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        <div className="min-w-0 overflow-x-auto rounded-md border">
          <Table aria-label="Steps" className="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Step</TableHead>
                <TableHead>What the Machine does</TableHead>
                <TableHead>Moves on</TableHead>
                <TableHead>Simulated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {steps.map((step, index) => (
                <TableRow key={index}>
                  <TableCell className="text-muted-foreground tabular-nums">{index + 1}</TableCell>
                  <TableHead scope="row" className="font-semibold text-foreground">
                    {stepName(step, index)}
                  </TableHead>
                  <TableCell className="whitespace-normal">{stepAction(definition!, index)}</TableCell>
                  <TableCell className="whitespace-normal">{stepMovesOn(step)}</TableCell>
                  <TableCell className="whitespace-normal">{run ? stepSimulated(definition!, run, index) : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {definition && (
          <dl aria-label="The Profile" className="flex flex-wrap gap-x-10 gap-y-2 tabular-nums">
            {profileFacts(definition).map((fact) => (
              <div key={fact.term}>
                <dt className="text-sm text-muted-foreground">{fact.term}</dt>
                <dd>{fact.text}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

/** Its Profile Versions, the latest saved first, each with who saved it, and a comparison with any of the others. */
function VersionsCard({ profile, versions, names }: { profile: Profile; versions: ProfileVersion[] | undefined; names: Map<string, string> }) {
  return (
    <Card role="region" aria-label="Versions" className="min-w-0">
      <CardHeader>
        <CardTitleWithInfo title="Versions">
          <p>
            A change to a Profile&apos;s steps saves a new Profile saved from the old one: its versions, the latest saved first, down to the Profile the first was saved from. Each
            says who saved it: the Machine whose tablet saved it, or who published it. Where two were saved from one, both branches are listed.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        {versions === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : versions.length <= 1 ? (
          <p className="text-sm text-muted-foreground">Its only version: no Profile in the Library was saved from it, and it was saved from none in the Library.</p>
        ) : (
          <ul className="grid divide-y" aria-label="Versions">
            {versions.map((version) => {
              const here = version.id === profile.id;
              const name = names.get(version.id) ?? version.id;
              const shown = version.shownAt.map((at) => at.location.name);
              return (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 py-3" aria-current={here ? "page" : undefined}>
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-semibold">
                      {here ? (
                        name
                      ) : (
                        <Link to={profilePath(version.id)} className="underline-offset-4 hover:underline">
                          {name}
                        </Link>
                      )}
                      {here && <span className="font-normal text-muted-foreground"> · this one</span>}
                      {version.archived && <span className="font-normal text-muted-foreground"> · Archived</span>}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {version.bundled ? (
                        <>Bundled with Decaid</>
                      ) : (
                        <>
                          {formatTime(version.savedAt)}, <SourceText source={version.savedBy} />
                        </>
                      )}
                      {version.parentId && ` · saved from ${names.get(version.parentId) ?? version.parentId}`}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {`${shown.length === 0 ? "Shown nowhere" : `Shown at ${shown.join(", ")}`} · ${version.shots === 0 ? "no Shots" : shotsText(version.shots)}`}
                    </span>
                  </div>
                  {!here && (
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`${profilePath(profile.id)}/compare/${encodeURIComponent(version.id)}`} aria-label={`Compare with ${name}`}>
                        Compare
                      </Link>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** The Recipes on this version, each with its Location, slot and the Machines that have it loaded. */
function RecipesCard({ recipes }: { recipes: RecipeOnProfile[] | undefined }) {
  return (
    <Card role="region" aria-label="Recipes on this version" className="min-w-0">
      <CardHeader>
        <CardTitleWithInfo title="Recipes on this version">
          <p>The Recipes that name this Profile, not Archived, each with its Location and Recipe Slot, and the Machines that have it loaded now.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent>
        {recipes === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : recipes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Recipe names this version.</p>
        ) : (
          <ul className="grid divide-y">
            {recipes.map(({ recipe, loadedOn }) => (
              <li key={recipe.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
                <Link to={itemPath("recipe", recipe.id)} className="font-medium underline-offset-4 hover:underline">
                  {recipe.name ?? "Unnamed"}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {[recipe.location?.name, recipe.slot !== null ? `slot ${recipe.slot}` : null].filter(Boolean).join(", ")}
                  {loadedOn.length > 0 && ` · loaded on ${loadedOn.map((machine) => machine.name).join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** How many Shots are on this version and on its earlier ones, and a link to this version's in the Shots list. */
function ShotsCard({ profile, versions, earlier }: { profile: Profile; versions: ProfileVersion[] | undefined; earlier: ProfileVersion[] }) {
  const here = versions?.find((version) => version.id === profile.id);
  const before = earlier.reduce((total, version) => total + version.shots, 0);
  // As any Library item's page counts them (ItemShotsCard), and with earlier versions, those on each.
  const counted =
    here &&
    (earlier.length === 0
      ? here.shots === 0
        ? "No Shots yet"
        : shotsText(here.shots)
      : `${here.shots === 0 ? "No Shots" : shotsText(here.shots)} on this version, ${before === 0 ? "none" : shotsText(before)} on earlier ones`);
  return (
    <Card role="region" aria-label="Shots">
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CardTitleWithInfo title="Shots">
            <p>The Shots pulled with this Profile on any Machine, and with the versions it was saved from. The Shots list lists them, newest first, with their summary and trend.</p>
          </CardTitleWithInfo>
          {counted && <p className="text-sm text-muted-foreground tabular-nums">{counted}</p>}
        </div>
        {here && here.shots > 0 && (
          <Link to={`/shots?${new URLSearchParams({ profileId: profile.id })}`} className="text-sm underline underline-offset-4">
            Open in the Shots list
          </Link>
        )}
      </CardHeader>
    </Card>
  );
}

/** The graph in words, for screen readers: each step, how long it ran and why it ended, and the stop. */
export function graphWords(title: string, profile: ProfileDefinition, run: SimulatedRun, onShot: boolean): string {
  const steps = run.steps.map((_, index) => `${stepName(profile.steps[index]!, index)}: ${stepSimulated(profile, run, index)}.`);
  return `Simulated run of ${title} on ${onShot ? "a Shot's puck" : "a standard puck"}. ${steps.join(" ")} It ${run.stop.reason === "weight" ? "stops" : "ends"} at ${seconds(run.stop.seconds)} with ${measure(run.weight)} g in the cup.`;
}

function lastSecond(samples: readonly { seconds: number; shade: string | null }[]): number {
  return samples.filter((sample) => sample.shade === null).at(-1)?.seconds ?? 0;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capitalised(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function text(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
