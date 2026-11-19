import type { MachineModel } from "@decent-sync/protocol";
import { Check, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { CardTitleWithInfo } from "@/components/info-tip";
import { formatTime } from "@/components/machines";
import { gramsText, shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type DraftFollowing, type DraftTrial, type DraftTrying, type FollowableMachine, type TrialShot, api } from "@/lib/api";
import { seconds } from "@/lib/profile-words";
import { HowItRuns } from "@/pages/ProfilePage";

// Trying a Draft on a Machine (#581, ADR-0032): the card that has a Machine
// at a Location marked for it follow the Draft and says whether it has the
// Draft's steps, and the list of the Draft's Trial Shots, an earlier one
// opening against the steps it ran.

/** Why a Machine offered can't be chosen, in words; undefined for one that can. */
function cannotFollow(machine: FollowableMachine): string | undefined {
  if (machine.follows) return `following “${machine.follows.title || "Untitled"}”`;
  if (machine.needsPluginUpdate) return "needs its plugin updated";
  return machine.canFollow ? undefined : "its tablet has not connected yet";
}

const ENDED: Record<NonNullable<DraftFollowing["ended"]>["why"], string> = {
  workflow: "",
  stopped: " It was turned off here.",
  location: " Drafts are no longer tried where it is.",
};

/**
 * Following the Draft on a Machine: a switch, the Machine, and whether it
 * has the Draft's steps and since when, or is still waiting for them. Turning
 * it on first says that the Machine's Loaded Recipe ends. Once following has
 * ended, it says what the Machine has instead, with one control to follow
 * again. Nothing where no Location tries Drafts and the Draft was never
 * followed.
 */
export function FollowingCard({ draftPath, title, trying, unsaved, onChanged }: { draftPath: string; title: string; trying: DraftTrying; unsaved: boolean; onChanged(trying: DraftTrying): void }) {
  const id = useId();
  const { following, machines } = trying;
  const active = following !== null && following.state !== "ended";
  const [chosen, setChosen] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The Machine followed, or last followed, until another is chosen; else the first that can follow.
  const machineId = active ? following.machine.id : (chosen ?? following?.machine.id ?? machines.find((machine) => !cannotFollow(machine))?.id);
  const machine = machines.find((each) => each.id === machineId);
  const name = machine?.name ?? following?.machine.name ?? "a Machine";

  if (machines.length === 0 && !following) return null;

  async function send(method: "PUT" | "DELETE") {
    setBusy(true);
    setError(undefined);
    try {
      const { trying: next } = await api<{ trying: DraftTrying }>(method, `${draftPath}/following`, method === "PUT" ? { machineId } : undefined);
      onChanged(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Following could not be changed");
    } finally {
      setBusy(false);
    }
  }

  let status: ReactNode = null;
  if (following?.state === "current") {
    status = (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Check aria-hidden className="size-4 text-green-700 dark:text-green-500" />
        {unsaved ? "Saving…" : `The Machine has these steps${following.since ? `, since ${formatTime(following.since)}` : ""}`}
      </span>
    );
  } else if (following?.state === "waiting") {
    status = <span className="text-sm text-muted-foreground">{`Waiting for ${following.machine.name}${following.waitingFor ? `: ${following.waitingFor}` : ", which takes them once it is on and not pulling a Shot"}`}</span>;
  } else if (following?.ended) {
    status = (
      <span className="inline-flex items-start gap-1.5 text-sm">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-500" />
        <span>
          <span className="font-semibold">{`Following stopped at ${formatTime(following.ended.at)}.`}</span>
          {ENDED[following.ended.why]}
          {following.has ? ` ${following.machine.name} now has ${following.has}.` : ""}
        </span>
      </span>
    );
  }
  const cannot = machine ? cannotFollow(machine) : "no Machine can follow a Draft now";

  return (
    <Card role="region" aria-label="On a Machine" className={following?.state === "ended" ? "bg-muted/40" : undefined}>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              id={`${id}-follow`}
              checked={active}
              disabled={busy || (!active && cannot !== undefined)}
              onCheckedChange={(on) => (on ? setAsking(true) : void send("DELETE"))}
            />
            <Label htmlFor={`${id}-follow`}>Follow on</Label>
            <Select value={machineId ?? ""} onValueChange={setChosen} disabled={active || busy}>
              <SelectTrigger aria-label="Machine" className="min-w-40">
                <SelectValue placeholder="No Machine" />
              </SelectTrigger>
              <SelectContent>
                {machines.map((each) => {
                  const why = cannotFollow(each);
                  return (
                    <SelectItem key={each.id} value={each.id} disabled={why !== undefined}>
                      {why ? `${each.name}, ${why}` : each.name}
                    </SelectItem>
                  );
                })}
                {following && !machines.some((each) => each.id === following.machine.id) && <SelectItem value={following.machine.id}>{following.machine.name}</SelectItem>}
              </SelectContent>
            </Select>
            {status}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {following?.state === "ended" ? (
              <>
                {!cannot && <span>Following again replaces what it has loaded</span>}
                <Button size="sm" disabled={busy || cannot !== undefined} onClick={() => void send("PUT")}>
                  Follow again
                </Button>
              </>
            ) : active ? (
              <span>{`${following.machine.location?.name ?? "No Location"} · on its tablet as “${following.titleOnTablet}”`}</span>
            ) : (
              <span>{cannot ? `${name}: ${cannot}` : (machine?.location.name ?? "")}</span>
            )}
          </div>
        </div>
      </CardContent>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Follow this Draft on ${name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${name}'s Loaded Recipe ends, and the Draft's steps become what it does next, now and each time the Draft is saved, held while it pulls a Shot. Its dose, yield, Bean Batch, Grinder and Basket stay as they are. On its tablet the Draft is named “${title.trim() || "Untitled"} (Draft)”, and it joins no tablet's Profiles.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send("PUT")}>Follow</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * The Draft's Trial Shots, the latest first: each says whether it ran the
 * Draft's steps as they are now or earlier ones. One on the current steps
 * moves the simulation to its puck; an earlier one opens against the steps
 * it ran. The one whose puck the graph is on is marked.
 */
export function TrialShotsCard({
  draftPath,
  trialShots,
  shown,
  machineModel,
  onUse,
}: {
  draftPath: string;
  trialShots: TrialShot[];
  /** The Shot whose puck the Draft's graph is on, if one of these. */
  shown: string | undefined;
  machineModel: MachineModel | undefined;
  onUse(shotId: string): void;
}) {
  const [opened, setOpened] = useState<TrialShot>();
  const machineNames = [...new Set(trialShots.map((trial) => trial.shot.machine?.name).filter((name): name is string => !!name))];
  return (
    <Card role="region" aria-label="Trial Shots">
      <CardHeader>
        <CardTitleWithInfo title={`Trial Shots · ${trialShots.length}${machineNames.length === 1 ? ` on ${machineNames[0]}` : ""}`}>
          <p>
            The Shots pulled with this Draft&apos;s steps on a Machine following it, whatever brew temperature or yield was set on the tablet. The latest on the steps as they are
            now is laid over the graph by itself, and the simulation moves to its puck. Once the Draft is published, the Shots on the published steps are the new Profile&apos;s.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-2">
        {trialShots.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. A Shot pulled on the following Machine with these steps appears here as soon as the server has it.</p>
        ) : (
          <ul className="grid divide-y rounded-lg border">
            {trialShots.map((trial) => {
              const { shot } = trial;
              const onGraph = shot.id === shown;
              return (
                <li key={shot.id}>
                  <button
                    type="button"
                    aria-current={onGraph ? "true" : undefined}
                    className={`grid w-full gap-0.5 p-3 text-left text-sm hover:bg-muted/60 ${onGraph ? "bg-primary/5 shadow-[inset_3px_0_0] shadow-primary" : ""}`}
                    onClick={() => (trial.steps === "current" ? onUse(shot.id) : setOpened(trial))}
                  >
                    <span className="font-semibold">{shotTime(shot)}</span>
                    <span className="tabular-nums">
                      {[shot.duration === null ? undefined : seconds(shot.duration), inAndOut(trial)].filter(Boolean).join(" · ")}
                    </span>
                    <span className="text-muted-foreground">{trial.steps === "current" ? "On these steps" : "On earlier steps"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {trialShots.some((trial) => trial.steps === "earlier") && <p className="text-sm text-muted-foreground">An earlier trial opens against the steps it ran.</p>}
      </CardContent>
      {opened && <EarlierTrial draftPath={draftPath} trial={opened} machineModel={machineModel} onClose={() => setOpened(undefined)} />}
    </Card>
  );
}

function inAndOut({ shot }: TrialShot): string | undefined {
  const dose = gramsText(shot.actualDose, shot.targetDose);
  const out = gramsText(shot.actualYield, shot.targetYield);
  return [dose && `${dose} in`, out && `${out} out`].filter(Boolean).join(", ") || undefined;
}

const NO_RUN = () => undefined;

/** An earlier Trial Shot against the steps it ran: those steps simulated on its puck, with the Shot over them. */
function EarlierTrial({ draftPath, trial, machineModel, onClose }: { draftPath: string; trial: TrialShot; machineModel: MachineModel | undefined; onClose(): void }) {
  const [ran, setRan] = useState<DraftTrial>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    api<{ trial: DraftTrial }>("GET", `${draftPath}/trials/${encodeURIComponent(trial.trialId)}`).then(
      ({ trial }) => current && setRan(trial),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The steps it ran could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, [draftPath, trial.trialId]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{`Trial Shot of ${shotTime(trial.shot)}, on earlier steps`}</DialogTitle>
          <DialogDescription>
            The steps the Draft had when this Shot was pulled, simulated on the Shot&apos;s puck, with the Shot as it ran.{" "}
            <Link to={`/shots/${encodeURIComponent(trial.shot.id)}`} className="underline underline-offset-4">
              Open the Shot
            </Link>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {ran && (
          <HowItRuns
            title={ran.profile.title.trim() || "the Draft"}
            machineModel={machineModel}
            definition={ran.profile}
            shotProfileIds={[]}
            recipes={[]}
            onRun={NO_RUN}
            runLabel="The steps it ran, simulated"
            trial={{ shotId: trial.shot.id, asked: 0 }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
