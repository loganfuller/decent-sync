import { type Profile as ProfileDefinition, type SimulatedRun, checkProfile, fieldLabel, startingShape, widestLimits } from "@decent-sync/protocol";
import { Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useMayChange } from "@/auth";
import { SourceText } from "@/components/item-history";
import { FollowingCard, TrialShotsCard } from "@/components/draft-trying";
import { type DraftArrival, DiscardDraftButton, SavedBy, draftBecomes } from "@/components/drafts";
import { RelativeTime } from "@/components/relative-time";
import { type HandleField } from "@/components/profile-graph";
import { ChecksStatus, EditableStepsCard, Inspector } from "@/components/profile-editor";
import { profilePath } from "@/components/profiles";
import { PublishDialog } from "@/components/publish-profile";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, type Draft, type DraftTrying, type Profile, type ProfileSummary, type ProfileVersion, type SavedDraft, api } from "@/lib/api";
import { type EditHistory, canRedo, canUndo, recordChange, redo, startHistory, undo } from "@/lib/edit-history";
import { setStep, withTarget } from "@/lib/profile-edits";
import { versionNames } from "@/lib/profile-versions";
import { usePolled } from "@/lib/use-polled";
import { useScreen } from "@/lib/use-screen";
import { HowItRuns, definitionOf } from "@/pages/ProfilePage";

/** What the server answers for a Draft it has none of (`DraftsService`). */
const DRAFT_NOT_FOUND = "No such Draft";

/**
 * A window wide enough for the steps and Trial Shots to be a rail left of the graph (#623). From here the
 * graph, between a 272 px rail and the inspector, is wider than it is under them at 1280 px (712 px).
 */
const RAIL_SCREEN = "(min-width: 1500px)";

/** How long after the last change a Draft is saved, ms, so a drag or a word typed saves once. */
const SAVE_AFTER_MS = 500;

/**
 * A Draft (#579): the Profile page with a Draft loaded. Its graph simulates
 * again on every change, drawn with the version it started from faint
 * behind it, and handles on the selected step; the inspector edits that step
 * and the whole profile; the checks, beside Publish, say what stops it
 * publishing; its steps are added, duplicated, deleted and reordered; and
 * every change can be undone and redone through the session. In a wide
 * window the steps and Trial Shots are a rail left of the graph, and under
 * it otherwise (#623). It is saved as it changes, naming the count of saves
 * it started from, and says when another save came between. A Machine at a
 * Location marked for it follows the Draft (#581): a card says whether it
 * has the Draft's steps, and the Draft's Trial Shots are listed, the latest
 * on its steps laid over the graph as it arrives, with the simulation set
 * to match it. A Viewer sees no Draft.
 */
export function DraftPage() {
  const { id = "" } = useParams();
  return <DraftEditor key={id} id={id} />;
}

function DraftEditor({ id }: { id: string }) {
  const mayChange = useMayChange();
  const navigate = useNavigate();
  const rail = useScreen(RAIL_SCREEN);
  const arrival = useLocation().state as DraftArrival | null;
  const path = `/drafts/${encodeURIComponent(id)}`;
  // Undefined until read, null for no such Draft.
  const [draft, setDraft] = useState<Draft | null>();
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<EditHistory<ProfileDefinition>>();
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<"step" | "profile">("step");
  const [run, setRun] = useState<SimulatedRun>();
  const [between, setBetween] = useState<SavedDraft["between"]>(null);
  const [saving, setSaving] = useState<"saved" | "saving" | "failed">("saved");
  const [library, setLibrary] = useState<{ id: string; title: string }[]>([]);
  const [baseline, setBaseline] = useState<{ label: string; profile: ProfileDefinition } | null>(null);
  // What of a file was held to the ranges, in words, named by the steps as the Draft was first read, before any was moved.
  const [held, setHeld] = useState<string[]>([]);
  // Saving: one save at a time, of the latest change, naming the count of saves it started from.
  const saves = useRef(0);
  const pending = useRef<ProfileDefinition | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // How it is tried, asked again as a Machine's status is: the Machine takes a save, and a Trial Shot arrives, by themselves.
  const loadTrying = useCallback(async () => (mayChange ? (await api<{ trying: DraftTrying }>("GET", `${path}/trying`, undefined, { reportRefusal: false })).trying : undefined), [path, mayChange]);
  const { data: polled, reload: reloadTrying } = usePolled(loadTrying);
  // What a change made here answered, until the next poll's answer.
  const [changed, setChanged] = useState<DraftTrying>();
  useEffect(() => setChanged(undefined), [polled]);
  const trying = changed ?? polled;
  // A poll asked before the change may answer after it: asking again drops that answer.
  const followingChanged = useCallback(
    (next: DraftTrying) => {
      setChanged(next);
      void reloadTrying();
    },
    [reloadTrying],
  );
  // The Trial Shot laid over the graph: the latest on the Draft's steps, as it arrives, or the one chosen from the list.
  const latestTrial = trying?.trialShots.find((trial) => trial.steps === "current")?.shot.id;
  const [usedTrial, setUsedTrial] = useState<{ shotId: string; asked: number }>();
  const [laidOver, setLaidOver] = useState<string>();
  useEffect(() => {
    if (latestTrial) setUsedTrial((now) => (now?.shotId === latestTrial ? now : { shotId: latestTrial, asked: 0 }));
  }, [latestTrial]);

  useEffect(() => {
    let current = true;
    api<{ draft: Draft }>("GET", path).then(
      ({ draft }) => {
        if (!current) return;
        setDraft(draft);
        setHistory(startHistory(draft.profile));
        saves.current = draft.saves;
        setHeld((arrival?.held ?? []).map((value) => `${fieldLabel(draft.profile, value)} from ${value.from} to ${value.to}`));
      },
      (caught: unknown) => {
        if (!current) return;
        if (caught instanceof ApiError && caught.status === 404 && caught.message === DRAFT_NOT_FOUND) setDraft(null);
        else setError(caught instanceof Error ? caught.message : "The Draft could not be loaded");
      },
    );
    // The Library's Profiles, to say where the Draft's steps are one's already.
    api<{ profiles: ProfileSummary[] }>("GET", "/profiles").then(
      ({ profiles }) => current && setLibrary(profiles.map((profile) => ({ id: profile.id, title: profile.title ?? profile.id }))),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [path]);

  // What it started from, drawn faint behind it: the Library Profile, named by its version where it has more than one, or the starting shape.
  const startedFromId = draft?.startedFrom?.id;
  const shapeKey = draft?.shape?.key;
  useEffect(() => {
    let current = true;
    if (startedFromId) {
      const from = `/profiles/${encodeURIComponent(startedFromId)}`;
      Promise.all([api<{ profile: Profile }>("GET", from), api<{ versions: ProfileVersion[] }>("GET", `${from}/versions`).catch(() => ({ versions: [] }))]).then(
        ([{ profile }, { versions }]) => {
          const definition = definitionOf(profile);
          if (!current || !definition) return;
          const name = versions.length > 1 && !profile.bundled ? versionNames(versions).get(profile.id) : undefined;
          setBaseline({ label: `${name ?? profile.title ?? "The Profile it started from"}, simulated`, profile: definition });
        },
        () => undefined,
      );
    } else if (shapeKey) {
      const shape = startingShape(shapeKey);
      if (shape) setBaseline({ label: `${shape.title} as it started, simulated`, profile: shape.profile });
    }
    return () => {
      current = false;
    };
  }, [startedFromId, shapeKey]);

  // Set once the page is left, after which a change still unsaved gets one more try and no retries.
  const left = useRef(false);
  // Lost connections and server errors in a row, which are tried again ever more slowly.
  const failures = useRef(0);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (inFlight.current || !pending.current) return;
    const profile = pending.current;
    pending.current = null;
    inFlight.current = true;
    // When to try again, ms: soon for a change made meanwhile, later for a save that may yet succeed, never for one refused.
    let again: number | null = null;
    try {
      const saved = await api<SavedDraft>("PUT", path, { profile, saves: saves.current }, { keepalive: left.current });
      failures.current = 0;
      // The count only grows: a tab-close save's answer may have come back first.
      saves.current = Math.max(saves.current, saved.draft.saves);
      if (!left.current) {
        setDraft(saved.draft);
        if (saved.between) setBetween(saved.between);
        setSaving(pending.current ? "saving" : "saved");
        setError(undefined);
        // Whether the following Machine has this save yet.
        void reloadTrying();
      }
      if (pending.current) again = SAVE_AFTER_MS;
    } catch (caught) {
      const newer = pending.current !== null;
      // Gone, as the server says; a 404 of a server without Drafts, as one of the release before during a deploy, is tried again.
      if (caught instanceof ApiError && caught.status === 404 && caught.message === DRAFT_NOT_FOUND) {
        // Discarded, or published, meanwhile: there is nothing left to save into.
        pending.current = null;
        if (!left.current) setDraft(null);
      } else {
        pending.current ??= profile;
        if (!left.current) {
          setSaving("failed");
          setError(caught instanceof Error ? caught.message : "The Draft could not be saved");
        }
        // A refusal waits for the next change, unless one was made meanwhile.
        if (!(caught instanceof ApiError) || caught.status >= 500 || caught.status === 404) again = Math.min(SAVE_AFTER_MS * 2 ** ++failures.current, 30_000);
        else if (newer) again = SAVE_AFTER_MS;
      }
    } finally {
      inFlight.current = false;
    }
    if (left.current) {
      // The one more try a change made during the last save gets, which is not tried again.
      if (pending.current && again === SAVE_AFTER_MS) void flush();
    } else if (again !== null) timer.current = setTimeout(() => void flush(), again);
  }, [path, reloadTrying]);
  // A change not yet saved is saved as the page is left, and as the tab is closed, by a request that outlives it.
  useEffect(() => {
    left.current = false;
    const onHide = () => {
      if (!pending.current) return;
      const profile = pending.current;
      pending.current = null;
      clearTimeout(timer.current);
      // Sent beside a save in flight, if one is, as the page can't wait for it; the count it answers is kept for a page brought back from the browser's cache.
      void api<SavedDraft>("PUT", path, { profile, saves: saves.current }, { keepalive: true }).then(
        (saved) => {
          saves.current = Math.max(saves.current, saved.draft.saves);
        },
        () => {
          pending.current ??= profile;
        },
      );
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      left.current = true;
      void flush();
    };
  }, [flush, path]);
  const save = (profile: ProfileDefinition) => {
    pending.current = profile;
    setSaving("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  const profile = history?.present;
  const change = (next: ProfileDefinition, key: string | null) => {
    if (!history) return;
    setHistory(recordChange(history, next, key, Date.now()));
    save(next);
  };
  const step = (by: "undo" | "redo") => {
    if (!history) return;
    const next = by === "undo" ? undo(history) : redo(history);
    if (next === history) return;
    setHistory(next);
    save(next.present);
  };
  // Undo and redo from the keyboard, but in a field, whose own undo is its text's.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === "z" || key === "y") {
        event.preventDefault();
        stepRef.current(key === "y" || event.shiftKey ? "redo" : "undo");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const limits = useMemo(() => widestLimits(draft?.models ?? []), [draft?.models]);
  const checks = useMemo(() => (profile && draft ? checkProfile(profile, { models: draft.models, libraryProfiles: library, run }) : undefined), [profile, draft, library, run]);
  const steps = profile?.steps.length ?? 0;
  const chosen = Math.min(selected, Math.max(0, steps - 1));
  const select = useCallback((index: number) => {
    setSelected(index);
    setTab("step");
  }, []);
  const inspector = useRef<HTMLDivElement>(null);
  // A check chosen from the list shows its step: the inspector from its top, however far down it was scrolled, brought
  // into the window where it is out of it, as under the graph in a narrow one, with the focus on the step's tab.
  const selectChecked = useCallback(
    (index: number) => {
      select(index);
      requestAnimationFrame(() => {
        const card = inspector.current;
        if (!card) return;
        card.scrollTo({ top: 0 });
        const tab = card.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
        if (card.getBoundingClientRect().top < 0 || (tab ?? card).getBoundingClientRect().bottom > window.innerHeight) card.scrollIntoView({ block: "start" });
        tab?.focus({ preventScroll: true });
      });
    },
    [select],
  );

  const back = draft?.startedFrom ? (
    <Link to={profilePath(draft.startedFrom.id)} className="text-sm text-muted-foreground hover:text-foreground">
      ← {draft.startedFrom.title ?? "The Profile it started from"}
    </Link>
  ) : (
    <Link to="/library/profiles" className="text-sm text-muted-foreground hover:text-foreground">
      ← Profiles
    </Link>
  );
  if (!mayChange) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">A Viewer sees no Drafts.</p>
      </section>
    );
  }
  if (draft === null) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">There is no such Draft. It may have been published or discarded.</p>
      </section>
    );
  }
  if (!draft || !history || !profile || !checks) {
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

  const onHandle = (field: HandleField, value: number) => {
    const current = profile.steps[chosen];
    if (!current) return;
    const next = field === "target" ? withTarget(current, value) : field === "seconds" ? { ...current, seconds: value } : current.exit ? { ...current, exit: { ...current.exit, value } } : current;
    change(setStep(profile, chosen, next), `steps.${chosen}.${field}`);
  };

  const stepsCard = <EditableStepsCard profile={profile} run={run} selected={chosen} onSelect={select} onChange={change} />;
  const trialsCard = trying && (trying.trialShots.length > 0 || (trying.following !== null && trying.following.state !== "ended")) && (
    <TrialShotsCard
      draftPath={path}
      trialShots={trying.trialShots}
      shown={laidOver}
      machineModel={draft.machineModel}
      onUse={(shotId) => setUsedTrial((now) => ({ shotId, asked: (now?.asked ?? 0) + 1 }))}
    />
  );

  // Spaced closer than other pages, so the steps, the whole graph and the inspector fit a laptop's window (#623).
  return (
    <section className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
              {profile.title.trim() || "Untitled"} <Badge>Draft</Badge>
            </h1>
            <p className="text-sm text-muted-foreground">
              {`Will publish as ${draftBecomes(draft).replace(/^A new/, "a new")} · `}
              {saving === "saving" ? "saving…" : saving === "failed" ? "not saved" : <SavedBy draft={draft} />}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <ChecksStatus checks={checks} onSelect={selectChecked} />
            <Button variant="outline" size="icon" aria-label="Undo" disabled={!canUndo(history)} onClick={() => step("undo")}>
              <Undo2 aria-hidden />
            </Button>
            <Button variant="outline" size="icon" aria-label="Redo" disabled={!canRedo(history)} onClick={() => step("redo")}>
              <Redo2 aria-hidden />
            </Button>
            <PublishDialog
              target={{ kind: "draft", draft, profile, saves: () => saves.current }}
              label="Publish"
              disabled={saving !== "saved" || checks.blocking.length > 0}
              onPublished={(published) => {
                pending.current = null;
                clearTimeout(timer.current);
                void navigate(profilePath(published.profile.id), { state: { published } });
              }}
            />
            <DiscardDraftButton
              draft={draft}
              label="Discard the Draft"
              onDone={() => {
                pending.current = null;
                clearTimeout(timer.current);
                void navigate("/library/profiles");
              }}
            />
          </div>
        </div>

      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {between && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Another save came between: <SourceText source={between.savedBy} /> saved this Draft <RelativeTime at={between.savedAt} />
              {between.saves > 1 ? `, the latest of ${between.saves} saves` : ""} after you opened it, and your change was saved over it.
            </span>
            <Button variant="outline" size="sm" onClick={() => setBetween(null)}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {held.length > 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {`Held to what the machine accepts, from the file: ${held.join("; ")}.`}
            </span>
            <Button variant="outline" size="sm" onClick={() => setHeld([])}>
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {trying && <FollowingCard draftPath={path} title={profile.title} trying={trying} unsaved={saving !== "saved"} onChanged={followingChanged} />}

      <div className={`grid min-w-0 items-start gap-4 ${rail ? "lg:grid-cols-[17rem_minmax(0,1fr)_22rem]" : "lg:grid-cols-[minmax(0,1fr)_22rem]"}`}>
        {rail && (
          <div className="grid min-w-0 gap-4">
            {stepsCard}
            {trialsCard}
          </div>
        )}
        <div className="grid min-w-0 gap-4">
          <HowItRuns
            trial={usedTrial}
            onLaidOver={setLaidOver}
            title={profile.title.trim() || "the Draft"}
            machineModel={draft.machineModel}
            definition={profile}
            shotProfileIds={draft.startedFrom ? [draft.startedFrom.id] : []}
            recipes={[]}
            onRun={setRun}
            baseline={baseline}
            runLabel="This Draft, simulated"
            editing={steps > 0 ? { step: chosen, limits, onSelect: select, onChange: onHandle } : null}
          />
          {!rail && stepsCard}
          {!rail && trialsCard}
        </div>
        {/* Within reach in a window shorter than it: it scrolls within itself rather than running past the window's end. */}
        <div className="min-w-0 lg:sticky lg:top-4">
          <Inspector
            ref={inspector}
            profile={profile}
            selected={chosen}
            tab={tab}
            limits={limits}
            onTab={setTab}
            onSelect={select}
            onChange={change}
            className="lg:max-h-[calc(100svh-2rem)] lg:overflow-y-auto"
          />
        </div>
      </div>
    </section>
  );
}
