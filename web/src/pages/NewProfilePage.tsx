import { type Profile as ProfileDefinition, STARTING_SHAPES, type StartingShape, simulateProfile, standardPuck } from "@decent-sync/protocol";
import { Plus } from "lucide-react";
import { type ChangeEvent, useCallback, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useMayChange } from "@/auth";
import { useStartDraft } from "@/components/drafts";
import { PageTitleWithInfo } from "@/components/info-tip";
import { profileTitle } from "@/components/profiles";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ProfileSummary, api } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled } from "@/lib/use-polled";

/**
 * New Profile (#579): a Draft started from one of the starting shapes, each
 * drawn as it runs on a medium puck and described by what it is for; from a
 * duplicate of any Profile in the Library, Decaid's bundled ones included;
 * or from a profile file, Decaid's profile JSON.
 */
export function NewProfilePage() {
  const mayChange = useMayChange();
  const { start, starting, error } = useStartDraft();
  const back = (
    <Link to="/library/profiles" className="text-sm text-muted-foreground hover:text-foreground">
      ← Profiles
    </Link>
  );
  if (!mayChange) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert">A Viewer starts no Profile.</p>
      </section>
    );
  }
  return (
    <section className="grid min-w-0 gap-6">
      {back}
      <div className="grid gap-1">
        <PageTitleWithInfo title="New Profile">
          <p>Each of these opens as a Draft, kept here and on no tablet until it is published, of plain steps that can be changed freely.</p>
        </PageTitleWithInfo>
        <p className="text-sm text-muted-foreground">Each of these opens as a Draft of plain steps you can change freely.</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section className="grid gap-3" aria-labelledby="shapes">
        <h2 id="shapes" className="font-semibold">
          Start from a shape
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STARTING_SHAPES.map((shape) => (
            <li key={shape.key}>
              <button
                type="button"
                disabled={starting}
                onClick={() => void start({ shape: shape.key })}
                aria-label={`Start from ${shape.title}`}
                className={`grid h-full w-full content-start gap-3 rounded-xl border p-4 text-left shadow-xs transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 ${shape.key === "blank" ? "border-dashed" : ""}`}
              >
                <ShapeDrawing shape={shape} />
                <span className="font-semibold">{shape.title}</span>
                <span className="text-sm text-muted-foreground">{shape.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="grid gap-3" aria-labelledby="from-profile">
        <h2 id="from-profile" className="font-semibold">
          Or start from a Profile
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <DuplicateCard starting={starting} onDuplicate={(profileId) => void start({ profileId, as: "separate" })} />
          <ImportCard starting={starting} onImport={(file) => void start({ file })} />
        </div>
      </section>
    </section>
  );
}

/** A starting shape's pressure as it runs on a medium puck, as a small drawing; a plus for the blank one. */
function ShapeDrawing({ shape }: { shape: StartingShape }) {
  const path = useMemo(() => (shape.key === "blank" ? null : pressurePath(shape.profile)), [shape]);
  return (
    <span aria-hidden className="flex h-20 items-center justify-center rounded-md bg-muted/50">
      {path === null ? (
        <Plus className="size-5 text-muted-foreground" />
      ) : (
        <svg viewBox="0 0 200 60" className="h-full w-full">
          <line x1="10" x2="190" y1="54" y2="54" className="stroke-border" />
          <path d={path} fill="none" className="stroke-foreground" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/** A profile's simulated pressure on the standard puck, as a path in a 200 by 60 box, 0 to 10 bar. */
function pressurePath(profile: ProfileDefinition): string {
  const run = simulateProfile({ profile, puck: standardPuck(0), stopAt: profile.target_weight, model: "DE1" });
  const end = Math.max(1, run.duration);
  return run.samples.map((sample, index) => `${index === 0 ? "M" : "L"}${(10 + (sample.seconds / end) * 180).toFixed(1)},${(54 - (Math.min(10, sample.values.pressure ?? 0) / 10) * 48).toFixed(1)}`).join("");
}

/** Duplicate any Profile in the Library into a Draft, as a separate Profile. */
function DuplicateCard({ starting, onDuplicate }: { starting: boolean; onDuplicate(profileId: string): void }) {
  const id = useId();
  const load = useCallback(async () => (await api<{ profiles: ProfileSummary[] }>("GET", "/profiles")).profiles.filter((profile) => !profile.archived), []);
  const { data: profiles } = usePolled(load, DETAILS_POLL_MS);
  const [chosen, setChosen] = useState<string>();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Duplicate one from the Library</h3>
        </CardTitle>
        <CardDescription>Any Profile, Decaid&apos;s bundled ones included, copied into a Draft that publishes as a Profile of its own.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Label htmlFor={id} className="sr-only">
          The Profile to duplicate
        </Label>
        <Select value={chosen} onValueChange={setChosen} disabled={!profiles || profiles.length === 0}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={profiles && profiles.length === 0 ? "No Profiles yet" : "Choose a Profile"} />
          </SelectTrigger>
          <SelectContent>
            {(profiles ?? []).map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profileTitle(profile)}
                {profile.bundled ? " (bundled)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div>
          <Button variant="outline" disabled={!chosen || starting} onClick={() => chosen && onDuplicate(chosen)}>
            Duplicate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Import a profile file into a Draft: Decaid's profile JSON, a bare profile or a whole record. */
function ImportCard({ starting, onImport }: { starting: boolean; onImport(content: unknown): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const chosen = async (event: ChangeEvent<HTMLInputElement>) => {
    setError(undefined);
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      onImport(JSON.parse(await file.text()));
    } catch {
      setError(`${file.name} is not JSON, so not a profile Decaid reads.`);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Import a file</h3>
        </CardTitle>
        <CardDescription>A profile saved as JSON from Decaid or another Decent Sync. Values the machine doesn&apos;t accept are held to what it does, and you&apos;re told which.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <input ref={input} type="file" accept="application/json,.json" className="sr-only" aria-label="A profile file to import" onChange={(event) => void chosen(event)} />
        <div>
          <Button variant="outline" disabled={starting} onClick={() => input.current?.click()}>
            Choose a file
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
