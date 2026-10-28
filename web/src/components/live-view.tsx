import { type ReactNode, useEffect, useState } from "react";
import { machineStateOf } from "@decent-sync/protocol";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { profileStep } from "@/lib/curves";
import { type LiveMachine, liveMachineOf, readLiveEvent, reported, timeInState } from "@/lib/live-view";

/** How long after the browser gives up on the stream, as on a refusal, the card opens it again. */
const REOPEN_MS = 5_000;

/**
 * The Machine's Live View (ADR-0024): what it is doing and measuring now, as
 * its Tablet streams it through the server while this page is open. Nothing
 * of it is stored. `profile` is the profile of the Machine's Workflow, if
 * known, which names a shot's steps.
 */
export function LiveViewCard({ machineId, profile }: { machineId: string; profile?: unknown }) {
  const live = useLiveMachine(machineId);
  return (
    <Card role="region" aria-label="Live View">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <h2>Live View</h2>
          <InfoTip label="About Live View">
            <p>What the Machine is doing and measuring now, as its Tablet sends it while this page is open.</p>
            <p>Nothing here is stored.</p>
          </InfoTip>
        </CardTitle>
        {!live && <CardDescription>Waiting for its Tablet to send what it is doing.</CardDescription>}
      </CardHeader>
      {live && (
        <CardContent>
          <LiveTiles live={live} profile={profile} />
        </CardContent>
      )}
    </Card>
  );
}

/**
 * The Live View's latest machine snapshot, from the Machine's stream, which
 * stays open while the page shows it. The browser opens a stream that ended
 * again by itself; one it gave up on, as when refused, is opened again after
 * REOPEN_MS.
 */
function useLiveMachine(machineId: string): LiveMachine | undefined {
  const [live, setLive] = useState<LiveMachine>();
  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const opened = new EventSource(`/api/machines/${encodeURIComponent(machineId)}/live`);
      source = opened;
      opened.onmessage = (event: MessageEvent) => {
        const relayed = readLiveEvent(event.data);
        const machine = relayed && liveMachineOf(relayed);
        if (machine) setLive(machine);
      };
      opened.onerror = () => {
        if (opened.readyState !== EventSource.CLOSED) return;
        reopen = setTimeout(open, REOPEN_MS);
      };
    };
    open();
    return () => {
      clearTimeout(reopen);
      source?.close();
    };
  }, [machineId]);
  return live;
}

/** Decaid's states while a shot is pulled. */
const SHOT_STATES = new Set(["espresso", "skipStep"]);

function LiveTiles({ live, profile }: { live: LiveMachine; profile?: unknown }) {
  const { snapshot } = live;
  const named = machineStateOf(snapshot);
  const value = (key: string) => reported(snapshot, key);
  const pulling = named !== null && SHOT_STATES.has(named.state);
  // Before its first step a shot's frame is left over from before it, as the Shot page's curves read it.
  const preheat = pulling && named.substate === "preparingForShot";
  const steps = (profile as { steps?: unknown } | null | undefined)?.steps;
  const step = pulling && !preheat ? profileStep(snapshot.profileFrame, Array.isArray(steps) ? steps : []) : null;
  const stepText = preheat ? "Preheat" : step?.name;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Tile label="Machine State" wide>
        <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Machine State
          {named && (
            <InfoTip label="About Machine State">
              <p>
                Decaid reports {named.state}, {named.substate}.
              </p>
              {named.note && <p>{named.note}.</p>}
            </InfoTip>
          )}
        </dt>
        <dd className="flex flex-wrap items-center gap-2 text-lg font-medium">
          {named ? named.name : <NotReported />} {named?.detail && <Badge variant="secondary">{named.detail}</Badge>}
        </dd>
        <TileLine term="Time in state">{timeInState(live) ?? <NotReported />}</TileLine>
      </Tile>
      <Measurement label="Group temperature" value={value("groupTemperature")} target={value("targetGroupTemperature")} unit="°C" />
      <Measurement label="Mix temperature" value={value("mixTemperature")} target={value("targetMixTemperature")} unit="°C" />
      <Measurement label="Steam temperature" value={value("steamTemperature")} unit="°C" />
      {/* A target of zero is a profile step that sets none, as a pressure step's flow target, as the Shot page's curves read it. */}
      <Measurement label="Pressure" value={value("pressure")} target={value("targetPressure")} unit="bar" zeroIsNone />
      <Measurement label="Flow" value={value("flow")} target={value("targetFlow")} unit="ml/s" zeroIsNone />
      <Tile label="Profile step">
        <TileTerm>Profile step</TileTerm>
        <dd className="text-lg font-medium">{stepText ?? <span className="text-muted-foreground">{pulling ? "Not reported" : "Not pulling a shot"}</span>}</dd>
      </Tile>
    </div>
  );
}

/** One tile: a small card holding its terms and values. */
function Tile({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <Card size="sm" role="group" aria-label={label} className={wide ? "col-span-2" : undefined}>
      <CardContent>
        <dl className="grid gap-1">{children}</dl>
      </CardContent>
    </Card>
  );
}

function TileTerm({ children }: { children: ReactNode }) {
  return <dt className="text-xs text-muted-foreground">{children}</dt>;
}

/** A smaller term and value under a tile's own, such as a target. */
function TileLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-1 text-xs text-muted-foreground">
      <dt>{term}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * A measurement against its target, if it has one, each shown as not
 * reported where Decaid sends none. With `zeroIsNone`, a target of zero or
 * less is none.
 */
function Measurement({
  label,
  value,
  target,
  unit,
  zeroIsNone = false,
}: {
  label: string;
  value: number | null;
  target?: number | null;
  unit: string;
  zeroIsNone?: boolean;
}) {
  const targetText = target === null || target === undefined ? null : zeroIsNone && target <= 0 ? "None" : `${target.toFixed(1)} ${unit}`;
  return (
    <Tile label={label}>
      <TileTerm>{label}</TileTerm>
      <dd className="text-lg font-medium tabular-nums">{value === null ? <NotReported /> : `${value.toFixed(1)} ${unit}`}</dd>
      {target !== undefined && <TileLine term="Target">{targetText ?? <NotReported />}</TileLine>}
    </Tile>
  );
}

function NotReported() {
  return <span className="text-muted-foreground">Not reported</span>;
}
