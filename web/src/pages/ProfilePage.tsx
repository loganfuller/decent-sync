import {
  type MachineModel,
  type Profile as ProfileDefinition,
  type SimulatedRun,
  grindOf,
  lastRecordedWeight,
  profileOf,
  profileTextOf,
  shotPuck,
  simulateProfile,
  standardPuck,
} from "@decent-sync/protocol";
import { Copy, Download, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { ItemConflictsCard, ItemHistoryCard, SourceText, itemPath } from "@/components/conflicts";
import { ItemShotsCard } from "@/components/item-shots";
import { useStartDraft } from "@/components/drafts";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { ArchiveButton, ContentForm, DeleteButton, PROFILE_FIELDS } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { type GraphEditing, ProfileGraph } from "@/components/profile-graph";
import { DoseFields, type GraphShot, GrindControl, ModelChoice, type PuckAsk, RunFigures, loadGraphShot, startingAsk, unsimulatable } from "@/components/profile-simulation";
import { ProfileBadges, ProfileLocationsCard, profilePath, profileTitle } from "@/components/profiles";
import { PublishDialog } from "@/components/publish-profile";
import { OrNone } from "@/components/records";
import { ShotPicker } from "@/components/shot-picker";
import { shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, api, type Profile, type ProfileVersion, type Published, type RecipeOnProfile } from "@/lib/api";
import { measure, profileFacts, seconds, stepAction, stepMovesOn, stepName, stepSimulated } from "@/lib/profile-words";
import { earlierVersions, versionNames } from "@/lib/profile-versions";
import { shotsText } from "@/lib/shot-summary";

/**
 * One Profile (#578): how it runs, as a simulation on a puck drawn in lanes
 * with the plan behind it, on the standard puck, with any Shot laid over it
 * setting the simulation to match it; its steps in plain words; its Profile Versions, any two of
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

/** Each Profile's profile read from its record, so a read gives the same one each time, as the server's does. */
const readDefinitions = new WeakMap<Profile, ProfileDefinition | null>();

/**
 * Its profile, as Decaid reads it, from its record where the server, of the
 * release before, gives none (ADR-0025): the same object for the same
 * Profile, so a page simulating it on each new one doesn't re-render forever.
 */
export function definitionOf(profile: Profile): ProfileDefinition | null {
  if (profile.profile !== undefined) return profile.profile;
  if (!readDefinitions.has(profile)) readDefinitions.set(profile, profileOf(profile.content.profile));
  return readDefinitions.get(profile)!;
}

function ProfileDetails({ id }: { id: string }) {
  const mayChange = useMayChange();
  // What publishing a Draft, or returning to this version, did, where the page was opened from one.
  const published = (useLocation().state as { published?: Published } | null)?.published;
  const [editing, setEditing] = useState(false);
  // Using a Conflict's value, or a change here, changes the item, so it is loaded again, with its history.
  const [changes, setChanges] = useState(0);
  const changed = () => setChanges((count) => count + 1);
  const { profile, error } = useProfile(id, changes);
  // Undefined until read, null where the server, of the release before, has no such route.
  const [versions, setVersions] = useState<ProfileVersion[] | null>();
  const [recipes, setRecipes] = useState<RecipeOnProfile[] | null>();
  const [sideError, setSideError] = useState<string>();
  // The run the graph draws, which the steps table says what each step did in.
  const [run, setRun] = useState<SimulatedRun>();
  const path = `/profiles/${encodeURIComponent(id)}`;

  useEffect(() => {
    let current = true;
    // A server of the release before has neither route, as during a deploy (ADR-0025): the page goes without them.
    const failed = (absent: () => void) => (caught: unknown) => {
      if (!current) return;
      if (caught instanceof ApiError && caught.status === 404) absent();
      else setSideError(caught instanceof Error ? caught.message : "Could not be loaded");
    };
    api<{ versions: ProfileVersion[] }>("GET", `${path}/versions`).then(({ versions }) => current && setVersions(versions), failed(() => setVersions(null)));
    api<{ recipes: RecipeOnProfile[] }>("GET", `${path}/recipes`).then(({ recipes }) => current && setRecipes(recipes), failed(() => setRecipes(null)));
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
          {mayChange && definition && <StartDraftButtons profile={profile} />}
          <ExportButton profile={profile} />
          {mayChange && (
            <>
              <ArchiveButton path={path} name={profileTitle(profile)} archived={profile.archived} effect="hidden on every tablet that holds it" onDone={changed} />
              {!profile.bundled && <DeleteButton path={path} name={profileTitle(profile)} back="/library/profiles" />}
            </>
          )}
        </div>
      </div>

      {published?.profile.id === profile.id && <PublishedNotice published={published} />}

      {profile.refusedOn && profile.refusedOn.length > 0 && (
        <Alert variant="destructive" role="region" aria-label="Refused on tablets">
          <AlertDescription className="grid gap-1">
            <p className="font-semibold">Refused on {profile.refusedOn.length === 1 ? "a tablet" : `${profile.refusedOn.length} tablets`}</p>
            <ul className="grid gap-1">
              {profile.refusedOn.map((refused) => (
                <li key={refused.machine.id}>
                  <Link to={`/machines/${encodeURIComponent(refused.machine.id)}`} className="underline underline-offset-4">
                    {refused.machine.name}
                  </Link>
                  , {formatTime(refused.refusedAt)}: {refused.error}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <ItemConflictsCard kind="profile" id={id} onResolved={changed} />

      {sideError && (
        <Alert variant="destructive">
          <AlertDescription>{sideError}</AlertDescription>
        </Alert>
      )}

      <HowItRuns
        title={profileTitle(profile)}
        machineModel={profile.machineModel}
        definition={definition}
        shotProfileIds={[profile.id, ...earlier.map((version) => version.id)]}
        recipes={recipes ?? []}
        onRun={setRun}
      />

      <StepsCard definition={definition} run={run} />

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        {versions !== null && <VersionsCard profile={profile} versions={versions} names={names} earlier={new Set(earlier.map((version) => version.id))} mayChange={mayChange} />}
        <div className="grid min-w-0 gap-6">
          <ProfileLocationsCard profile={profile} onChanged={changed} />
          {recipes !== null && <RecipesCard recipes={recipes} />}
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

      {/* Without the versions, as from a server of the release before, the count any Library item's page gives. */}
      {versions === null ? <ItemShotsCard kind="profile" id={profile.id} /> : <ShotsCard profile={profile} versions={versions} earlier={earlier} />}

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

/**
 * Starts a Draft of it (#579): Edit, to change it, publishing as a new
 * version of it, which one of Decaid's bundled Profiles doesn't offer, and
 * Duplicate, a copy of it to publish as a Profile of its own.
 */
function StartDraftButtons({ profile }: { profile: Profile }) {
  const { start, starting, error } = useStartDraft();
  return (
    <>
      {!profile.bundled && (
        <Button disabled={starting} onClick={() => void start({ profileId: profile.id, as: "version" })}>
          <Pencil aria-hidden /> Edit
        </Button>
      )}
      <Button variant="outline" disabled={starting} onClick={() => void start({ profileId: profile.id, as: "separate" })}>
        <Copy aria-hidden /> Duplicate
      </Button>
      {error && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
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

/**
 * The graph of how a profile runs, simulated on the standard puck, with its
 * controls and figures and any Shot laid over it, which sets the controls to
 * match it: a Library Profile's, or a Draft's (#579), drawn with the version
 * it started from faint behind it, its figures said against that version's,
 * and handles on its selected step.
 */
export function HowItRuns({
  title,
  machineModel,
  definition,
  shotProfileIds,
  recipes,
  onRun,
  baseline,
  editing,
  runLabel,
  trial,
  onLaidOver,
}: {
  /** The profile's title, as the graph's words name it. */
  title: string;
  /** The model it is simulated as until another is chosen. */
  machineModel: MachineModel | undefined;
  definition: ProfileDefinition | null;
  /** The Profiles whose Shots the Shot picker offers first. */
  shotProfileIds: string[];
  recipes: RecipeOnProfile[];
  onRun(run: SimulatedRun | undefined): void;
  /** A profile simulated on the same puck and drawn faint behind it, such as the version a Draft started from, by what the legend calls it. */
  baseline?: { label: string; profile: ProfileDefinition } | null;
  editing?: GraphEditing | null;
  /** What the legend calls the run. */
  runLabel?: string;
  /** A Trial Shot (#581) laid over the run, as it is given and whenever it changes or is asked for again: the Draft's latest on its steps as it arrives, or the one chosen. */
  trial?: { shotId: string; asked: number } | null;
  /** Told of the Shot laid over the run, by its id, and of none. */
  onLaidOver?(shotId: string | undefined): void;
}) {
  const [ask, setAsk] = useState<PuckAsk>(() => startingAsk(definition, machineModel));
  // Whether the simulation stops where the person, or a Shot laid over it, chose, rather than at the profile's stop-at weight.
  const [stopChosen, setStopChosen] = useState(false);
  // A Draft's stop-at weight changed moves where the simulation stops.
  const stopAtWeight = definition?.target_weight ?? null;
  const firstStopAt = useRef(stopAtWeight);
  useEffect(() => {
    if (stopAtWeight === firstStopAt.current) return;
    firstStopAt.current = stopAtWeight;
    setStopChosen(false);
    setAsk((now) => ({ ...now, stopAt: stopAtWeight !== null && stopAtWeight > 0 ? stopAtWeight : 0 }));
  }, [stopAtWeight]);
  const [overlay, setOverlay] = useState<GraphShot>();
  const [picking, setPicking] = useState(false);
  const [shotError, setShotError] = useState<string>();
  const change = (next: Partial<PuckAsk>) => {
    if (next.stopAt !== undefined) setStopChosen(true);
    setAsk((now) => ({ ...now, ...next }));
  };
  const cannot = unsimulatable(definition);

  const run = useMemo(
    () => (cannot || !definition ? undefined : simulateProfile({ profile: definition, puck: standardPuck(ask.grind), dose: ask.dose, stopAt: ask.stopAt, model: ask.model })),
    [cannot, definition, ask],
  );
  useEffect(() => onRun(run), [run, onRun]);
  // The baseline on the same puck, where it can be simulated, stopping at its own stop-at weight unless the person or a Shot chose where both stop.
  const baselineProfile = baseline?.profile;
  const baselineRun = useMemo(() => {
    if (!baselineProfile || unsimulatable(baselineProfile)) return undefined;
    const stopAt = stopChosen ? ask.stopAt : startingAsk(baselineProfile, ask.model).stopAt;
    return simulateProfile({ profile: baselineProfile, puck: standardPuck(ask.grind), dose: ask.dose, stopAt, model: ask.model });
  }, [baselineProfile, ask, stopChosen]);

  // Each Shot asked for, so one that answers after a later choice is dropped.
  const latest = useRef(0);
  const layOver = (id: string) => {
    setShotError(undefined);
    const asked = ++latest.current;
    loadGraphShot(id).then(
      (loaded) => {
        if (asked !== latest.current) return;
        setOverlay(loaded);
        const matched = askOf(loaded);
        if (matched.stopAt !== undefined) setStopChosen(true);
        setAsk((now) => ({ ...now, ...matched }));
      },
      (caught: unknown) => asked === latest.current && setShotError(caught instanceof Error ? caught.message : "The Shot could not be loaded"),
    );
  };

  // A Trial Shot is laid over the run as it arrives, and again when it is chosen.
  const layOverRef = useRef(layOver);
  layOverRef.current = layOver;
  const trialShotId = trial?.shotId;
  const trialAsked = trial?.asked;
  useEffect(() => {
    if (trialShotId) layOverRef.current(trialShotId);
  }, [trialShotId, trialAsked]);
  const laidOver = overlay?.shot.id;
  useEffect(() => onLaidOver?.(laidOver), [laidOver, onLaidOver]);

  const comparedLabel = trialShotId != null && laidOver === trialShotId ? "The Trial Shot, as it ran" : "The Shot laid over it";
  const comparedSamples = overlay?.simulation.samples ?? [];
  const words = run && definition ? graphWords(title, definition, run) : "";
  const against = baseline && baselineRun ? { label: baseline.label.replace(/, simulated$/, ""), samples: baselineRun.samples } : undefined;

  return (
    <Card role="region" aria-label="How it runs">
      <CardHeader>
        <CardTitleWithInfo title="How it runs, simulated">
          <p>
            A simulation of what a Machine does with this Profile, not a measurement: pressure and flow on a standard puck, with the plan, what each step asks the Machine for,
            dashed behind them. The puck has one control from finer to coarser. A Shot laid over it sets the dose, the stop-at weight, the Machine and the puck to match the Shot,
            and each can be changed after. Temperature is not simulated, so its lane draws the plan. Each step is a band named at the top with how long it ran and why it ended.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      {/* A container, so the graph and its figures go by the card's own width: it is narrower beside a Draft's inspector, and in a dialog, than the window. */}
      <CardContent className="@container grid min-w-0 gap-4">
        {cannot ? (
          <p className="text-sm text-muted-foreground">{cannot}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
              <DoseFields ask={ask} onChange={change} />
              {recipes.length > 0 && (
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
              <GrindControl grind={ask.grind} onChange={(grind) => change({ grind })} />
            </div>

            {shotError && (
              <Alert variant="destructive">
                <AlertDescription>{shotError}</AlertDescription>
              </Alert>
            )}

            {run && definition && (
              <div className="grid min-w-0 gap-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <RunFigures run={run} against={against} />
                  <div className="flex flex-wrap items-center gap-2">
                    {overlay && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          // A Shot still loading is dropped too, so it neither returns nor sets the controls.
                          latest.current++;
                          setOverlay(undefined);
                        }}
                      >
                        Remove the Shot
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
                      {overlay ? "Lay another Shot over it" : "Lay a Shot over it"}
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  {`${measure(run.dose)} g in, ${run.stopAt === null ? "running until its last step ends" : `stopping at ${measure(run.stopAt)} g`}, on a ${run.model}`}
                  {overlay && `, with the Shot of ${shotTime(overlay.shot)} on ${overlay.shot.machine?.name ?? "a Pending Machine"} over it`}
                </p>
                <ProfileGraph
                  profile={definition}
                  run={run}
                  runLabel={runLabel}
                  label={words}
                  compared={overlay && comparedSamples.length > 0 ? { label: comparedLabel, samples: comparedSamples, stop: { seconds: lastSecond(comparedSamples), label: "The Shot stopped" } } : null}
                  baseline={baseline && baselineRun ? { label: baseline.label, run: baselineRun } : null}
                  editing={editing}
                />
              </div>
            )}
          </>
        )}
      </CardContent>
      <ShotPicker
        open={picking}
        onOpenChange={setPicking}
        title="Lay a Shot over the graph"
        description="The Shot's pressure, flow and temperature are drawn over the simulation, which takes the Shot's dose, the weight it stopped at, its Machine's model and the puck nearest its own."
        profileIds={shotProfileIds}
        onPick={(shot) => layOver(shot.id)}
      />
    </Card>
  );
}

/**
 * What a Shot laid over the run sets the simulation to (#622): its dose, as
 * weighed or else as set; the weight it stopped at; its Machine's model; and
 * the grind at which the standard puck has its puck's open resistance. Each
 * it can't give, as it recorded no dose, no weight or no model, or no puck
 * can be worked out from it, is left out, and stays as it was.
 */
function askOf({ simulation }: GraphShot): Partial<PuckAsk> {
  const stopped = lastRecordedWeight(simulation.samples)?.weight;
  const puck = shotPuck(simulation);
  return {
    ...(simulation.dose !== null && { dose: simulation.dose }),
    ...(stopped !== undefined && stopped > 0 && { stopAt: Math.round(stopped * 10) / 10 }),
    ...(simulation.model !== null && { model: simulation.model }),
    ...(puck && { grind: grindOf(puck) }),
  };
}

/** Its steps in plain words, each with when it moves on and what the simulation the graph draws did with it, and the figures it states once. */
function StepsCard({ definition, run }: { definition: ProfileDefinition | null; run: SimulatedRun | undefined }) {
  const steps = definition?.steps ?? [];
  return (
    <Card role="region" aria-label="Steps">
      <CardHeader>
        <CardTitleWithInfo title="Steps">
          <p>
            What the Machine follows, which decides the Profile&apos;s id: new steps make a new Profile. Later steps&apos; temperatures are given against the first&apos;s, as a
            Recipe&apos;s brew temperature moves them all. Simulated is what the simulation drawn above did with each step.
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

/** What publishing, or returning to a version, did: where it is shown, where the one it replaced was hidden or kept shown, the Recipes moved, and any fork. */
function PublishedNotice({ published }: { published: Published }) {
  const names = (places: { name: string }[]) => places.map((place) => place.name).join(", ");
  const replaced = published.replaced ? profileTitle(published.replaced) : null;
  return (
    <Alert role="status">
      <AlertDescription className="grid gap-1">
        <p>Shown at {names(published.shownAt)}. Tablets there get it as they get any Profile.</p>
        {replaced && published.hiddenAt.length > 0 && <p>{`${replaced} is hidden at ${names(published.hiddenAt)}.`}</p>}
        {replaced &&
          published.keptAt.map((kept) => (
            <p key={kept.location.id}>{`${replaced} stays shown at ${kept.location.name}, as ${kept.recipes.map((recipe) => recipe.name ?? "a Recipe").join(", ")} still ${kept.recipes.length === 1 ? "names" : "name"} it.`}</p>
          ))}
        {published.moved.length > 0 && <p>{`Moved to it: ${published.moved.map((recipe) => `${recipe.name ?? "a Recipe"} at ${recipe.location.name}`).join(", ")}.`}</p>}
        {published.forked.length > 0 && <p>{`It forks the chain beside ${published.forked.map((version) => profileTitle(version)).join(", ")}, saved since its Draft began.`}</p>}
      </AlertDescription>
    </Alert>
  );
}

/** Its Profile Versions, the latest saved first, each with who saved it, and a comparison with any of the others. */
function VersionsCard({
  profile,
  versions,
  names,
  earlier,
  mayChange,
}: {
  profile: Profile;
  versions: ProfileVersion[] | undefined;
  names: Map<string, string>;
  /** The versions it was saved from, down the chain, which it can return to. */
  earlier: Set<string>;
  mayChange: boolean;
}) {
  const navigate = useNavigate();
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
          <p className="text-sm text-muted-foreground">
            {profile.bundled
              ? "One of Decaid's own Profiles, so no version anyone saved: a Profile saved from it starts versions of its own, which name it as where the first was saved from."
              : "Its only version: no Profile in the Library was saved from it, and it was saved from none in the Library."}
          </p>
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
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`${profilePath(profile.id)}/compare/${encodeURIComponent(version.id)}`} aria-label={`Compare with ${name}`}>
                          Compare
                        </Link>
                      </Button>
                      {mayChange && earlier.has(version.id) && !version.archived && !profile.bundled && (
                        <PublishDialog
                          target={{ kind: "return", to: { id: version.id, name }, from: profile }}
                          label="Return to it"
                          ariaLabel={`Return to ${name}`}
                          onPublished={(published) => void navigate(profilePath(published.profile.id), { state: { published } })}
                        />
                      )}
                    </div>
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
export function graphWords(title: string, profile: ProfileDefinition, run: SimulatedRun): string {
  const steps = run.steps.map((_, index) => `${stepName(profile.steps[index]!, index)}: ${stepSimulated(profile, run, index)}.`);
  return `Simulated run of ${title} on a standard puck. ${steps.join(" ")} It ${run.stop.reason === "weight" ? "stops" : "ends"} at ${seconds(run.stop.seconds)} with ${measure(run.weight)} g in the cup.`;
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
