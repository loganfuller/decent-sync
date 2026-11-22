import { useEffect, useState } from "react";
import { beanText, gramsText, shotTime } from "@/components/shots";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type ListedShot, type Machine, type ShotPage, api } from "@/lib/api";
import { seconds } from "@/lib/profile-words";

// Choosing a Shot on a Profile's page (#578) to lay over its graph, which
// sets the simulation to match it (#622). Those pulled on the Profile and its
// earlier versions come first, then any Shot, the newest first, on any
// Machine or one.

/** How many Shots each list shows at a time. */
const PAGE = 10;

const ANY = "any";

export function ShotPicker({
  open,
  onOpenChange,
  title,
  description,
  profileIds,
  onPick,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  /** The Profile and its earlier versions, whose Shots are offered first. */
  profileIds: readonly string[];
  onPick(shot: ListedShot): void;
}) {
  const [onProfile, setOnProfile] = useState<ListedShot[]>();
  const [others, setOthers] = useState<ShotPage>();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machine, setMachine] = useState(ANY);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string>();
  const key = profileIds.join(",");

  useEffect(() => {
    if (!open) return;
    let current = true;
    setOnProfile(undefined);
    Promise.all(key.split(",").map((profileId) => api<ShotPage>("GET", `/shots?${new URLSearchParams({ profileId, limit: String(PAGE) })}`))).then(
      (pages) => {
        if (!current) return;
        const seen = new Set<string>();
        const shots = pages
          .flatMap((page) => page.shots)
          .filter((shot) => !seen.has(shot.id) && seen.add(shot.id))
          .sort((a, b) => (b.pulledAt ?? "").localeCompare(a.pulledAt ?? ""))
          .slice(0, PAGE);
        setOnProfile(shots);
      },
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The Shots could not be loaded"),
    );
    api<{ machines: Machine[] }>("GET", "/machines").then(
      ({ machines }) => current && setMachines(machines),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, key]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(machine !== ANY && { machineId: machine }) });
    api<ShotPage>("GET", `/shots?${query}`).then(
      (page) => current && setOthers(page),
      (caught: unknown) => current && setError(caught instanceof Error ? caught.message : "The Shots could not be loaded"),
    );
    return () => {
      current = false;
    };
  }, [open, machine, offset]);

  const pick = (shot: ListedShot) => {
    onPick(shot);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <section aria-label="On this Profile" className="grid gap-2">
          <h3 className="text-sm font-medium">On this Profile and its earlier versions</h3>
          {onProfile === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : onProfile.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Shots yet.</p>
          ) : (
            <ShotChoices shots={onProfile} onPick={pick} />
          )}
        </section>
        <section aria-label="Any Shot" className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Any Shot</h3>
            <Select
              value={machine}
              onValueChange={(value) => {
                setMachine(value);
                setOffset(0);
              }}
            >
              <SelectTrigger aria-label="Machine" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any Machine</SelectItem>
                {machines.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {others === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : others.shots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Shots.</p>
          ) : (
            <>
              <ShotChoices shots={others.shots} onPick={pick} />
              <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                <span className="tabular-nums">{`${offset + 1} to ${offset + others.shots.length} of ${others.total}`}</span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                    Newer
                  </Button>
                  <Button variant="outline" size="sm" disabled={offset + PAGE >= others.total} onClick={() => setOffset(offset + PAGE)}>
                    Older
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function ShotChoices({ shots, onPick }: { shots: ListedShot[]; onPick(shot: ListedShot): void }) {
  return (
    <ul className="grid divide-y rounded-lg border">
      {shots.map((shot) => {
        const details = [shot.profileTitle, beanText(shot), [gramsText(shot.actualDose, shot.targetDose), gramsText(shot.actualYield, shot.targetYield)].filter(Boolean).join(" in, ") + (shot.actualYield !== null || shot.targetYield !== null ? " out" : ""), shot.duration === null ? null : seconds(shot.duration)]
          .filter((part) => part)
          .join(" · ");
        return (
          <li key={shot.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="text-sm font-medium">{`${shotTime(shot)} · ${shot.machine?.name ?? "A Pending Machine"}`}</span>
              <span className="truncate text-xs text-muted-foreground">{details}</span>
            </div>
            <Button variant="outline" size="sm" aria-label={`Choose the Shot of ${shotTime(shot)} on ${shot.machine?.name ?? "a Pending Machine"}`} onClick={() => onPick(shot)}>
              Choose
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
