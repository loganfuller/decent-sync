import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { machineStateOf } from "@decent-sync/protocol";
import { Curves } from "@/components/curves";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type SteamRecordPage } from "@/lib/api";
import { SHOT_CURVES, profileStep } from "@/lib/curves";
import { LIVE_STEAM_CURVES, type LiveCurve, type LiveCurves, liveSamples, withCurvesFrame, withStreamOpened } from "@/lib/live-curves";
import { type LiveState, machineConnectedOf, readLiveEvent, reported, scaleOf, timeInState, waterLevelOf, withLiveFrame } from "@/lib/live-view";
import { STATUS_POLL_MS } from "@/lib/use-polled";

/** How long after the browser gives up on the stream, as on a refusal, the card opens it again. */
const REOPEN_MS = 5_000;

/**
 * The Machine's Live View (ADR-0024): what it is doing and measuring now, as
 * its Tablet streams it through the server while this page is open, and the
 * curves of its latest shot or steaming. Nothing of it is stored. `profile`
 * is the profile of the Machine's Workflow, if known, which names a shot's
 * steps, and `lastShotId` the id of its last Shot, as the page last loaded
 * it, or null for none.
 */
export function LiveViewCard({ machineId, profile, lastShotId }: { machineId: string; profile?: unknown; lastShotId: string | null }) {
  const { live, curves } = useLiveView(machineId);
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
        <CardContent className="grid gap-6">
          <LiveTiles live={live} profile={profile} />
          {/* Keyed, so each shot or steaming starts with what the page held as it began. */}
          {curves.curve && (
            <LiveCurvesSection key={curves.curve.startedAt} machineId={machineId} curve={curves.curve} profile={profile} lastShotId={lastShotId} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * The latest frame of each source of the Live View, undefined until a frame
 * comes, and its curves, from the Machine's stream, which is open while the
 * page shows it in a visible tab, as the page's polling runs: it is closed
 * while the tab is hidden, and opened again once it is shown, so the plugin
 * stops streaming once nobody sees it. The browser opens a stream that ended
 * again by itself; one it gave up on, as when refused, is opened again after
 * REOPEN_MS.
 */
function useLiveView(machineId: string): { live: LiveState | undefined; curves: LiveCurves } {
  const [live, setLive] = useState<LiveState>();
  const [curves, setCurves] = useState<LiveCurves>({});
  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(reopen);
      source?.close();
      source = undefined;
    };
    const open = () => {
      close();
      if (document.hidden) return;
      const opened = new EventSource(`/api/machines/${encodeURIComponent(machineId)}/live`);
      source = opened;
      // Each time it opens, by itself too, frames may have been missed since the last.
      opened.onopen = () => setCurves(withStreamOpened);
      opened.onmessage = (event: MessageEvent) => {
        const relayed = readLiveEvent(event.data);
        if (!relayed) return;
        setLive((latest) => withLiveFrame(latest, relayed));
        setCurves((latest) => withCurvesFrame(latest, relayed));
      };
      opened.onerror = () => {
        if (opened.readyState !== EventSource.CLOSED) return;
        source = undefined;
        reopen = setTimeout(open, REOPEN_MS);
      };
    };
    // One given up on is opened at once as the tab is shown.
    const visibilityChanged = () => {
      if (document.hidden) close();
      else if (!source) open();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    open();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      close();
    };
  }, [machineId]);
  return { live, curves };
}

/**
 * The curves of the latest shot or steaming, drawn as its frames come, as its
 * stored record's page draws them, and labelled partial where it began before
 * the page's frames did. Once it has ended, the record it was stored as is
 * linked as soon as it has arrived (`useStoredRecord`). Memoized, so only its
 * own frames draw it again, not the scale's.
 */
const LiveCurvesSection = memo(function LiveCurvesSection({
  machineId,
  curve,
  profile,
  lastShotId,
}: {
  machineId: string;
  curve: LiveCurve;
  profile?: unknown;
  lastShotId: string | null;
}) {
  const live = useMemo(() => liveSamples(curve, profile), [curve, profile]);
  const stored = useStoredRecord(machineId, curve, lastShotId);
  const shot = live.activity === "shot";
  const what = shot ? "shot" : "steaming";
  return (
    <section aria-label="Curves" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <h3 className="font-medium">{shot ? "Shot curves" : "Steaming curves"}</h3>
          <InfoTip label="About the curves">
            {shot ? (
              <p>
                Drawn as the shot runs, as its Shot's page draws them: seconds from the start of its profile, with Preheat shaded before 0 s.
                Dashed lines are the targets the Machine reported, and grey vertical lines mark each change of profile step.
              </p>
            ) : (
              <p>
                Drawn as the Machine steams, as its Steam Record's page draws them: seconds from when it started steaming. Dashed lines are
                the targets the Machine reported. Shaded time isn't steaming: Preparing before 0 s, then Paused, Puffing and Purge.
              </p>
            )}
            <p>They stay until the next shot or steaming starts, and aren't stored.</p>
          </InfoTip>
        </div>
        {curve.partial && (
          <span className="flex items-center gap-1.5">
            <Badge variant="outline">Partial</Badge>
            <InfoTip label="About partial curves">
              <p>The {what} began before this page's data started coming, so its start isn't drawn.</p>
            </InfoTip>
          </span>
        )}
        {curve.ended && (
          <span className="text-sm">
            {stored ? (
              <Link to={stored.href} className="underline underline-offset-4">
                Open its {stored.name}
              </Link>
            ) : (
              <span className="text-muted-foreground">Waiting for its {shot ? "Shot" : "Steam Record"}</span>
            )}
          </span>
        )}
      </div>
      {live.activity === "shot" ? (
        <Curves curves={SHOT_CURVES} label="This shot" current={live.samples} />
      ) : (
        <Curves curves={LIVE_STEAM_CURVES} label="This steaming" current={live.samples} />
      )}
    </section>
  );
});

/**
 * The stored record of the curves' shot or steaming, once it has ended and the
 * record has arrived: for a shot, the Machine's last Shot, once its id differs
 * from the one the page held as the shot began, as a Shot's `pulledAt` is
 * rebuilt from its record and may be missing; for steaming, the Machine's
 * newest Steam Record, read as steaming began and every STATUS_POLL_MS once
 * it has ended, while the page is shown, until a newer one appears. Null until
 * then. Its component is keyed by the curves, so starts afresh for each.
 */
function useStoredRecord(machineId: string, curve: LiveCurve, lastShotId: string | null): { name: string; href: string } | null {
  const steaming = curve.activity === "steaming";
  // As the page held it when the shot began: only read as the component mounts.
  const [heldShotId] = useState(lastShotId);
  // The newest Steam Record as steaming began, undefined until read; then a newer one, once one appears.
  const heldSteamRecordId = useRef<string | null | undefined>(undefined);
  const [steamRecordId, setSteamRecordId] = useState<string>();
  const { ended } = curve;
  useEffect(() => {
    if (!steaming || steamRecordId !== undefined || (heldSteamRecordId.current !== undefined && !ended)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!document.hidden) {
        try {
          const path = `/steam-records?machineId=${encodeURIComponent(machineId)}&limit=1`;
          const newest = (await api<SteamRecordPage>("GET", path)).steamRecords[0]?.id ?? null;
          if (stopped) return;
          if (heldSteamRecordId.current === undefined) heldSteamRecordId.current = newest;
          else if (newest !== null && newest !== heldSteamRecordId.current) return setSteamRecordId(newest);
          // Held, while it still steams: read again once it has ended.
          if (!ended) return;
        } catch {
          // Read again next time.
        }
      }
      if (!stopped) timer = setTimeout(() => void read(), STATUS_POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [machineId, steaming, ended, steamRecordId]);
  if (!ended) return null;
  if (steaming) return steamRecordId === undefined ? null : { name: "Steam Record", href: `/steam-records/${encodeURIComponent(steamRecordId)}` };
  return lastShotId !== null && lastShotId !== heldShotId ? { name: "Shot", href: `/shots/${encodeURIComponent(lastShotId)}` } : null;
}

/** Decaid's states while a shot is pulled. */
const SHOT_STATES = new Set(["espresso", "skipStep"]);

function LiveTiles({ live, profile }: { live: LiveState; profile?: unknown }) {
  const snapshot = live.machine?.snapshot ?? {};
  const named = machineStateOf(snapshot);
  const value = (key: string) => reported(snapshot, key);
  const steamTarget = live.shotSettings ? reported(live.shotSettings, "targetSteamTemp") : null;
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
        <TileLine term="Time in state">{(live.machine && timeInState(live.machine)) ?? <NotReported />}</TileLine>
      </Tile>
      <Measurement label="Group temperature" value={value("groupTemperature")} target={value("targetGroupTemperature")} unit="°C" />
      <Measurement label="Mix temperature" value={value("mixTemperature")} target={value("targetMixTemperature")} unit="°C" />
      {/* The steam heater's target is in the machine's shot settings, which Decaid sends on a socket of their own. */}
      <Measurement label="Steam temperature" value={value("steamTemperature")} target={steamTarget} unit="°C" />
      {/* A target of zero is a profile step that sets none, as a pressure step's flow target, as the Shot page's curves read it. */}
      <Measurement label="Pressure" value={value("pressure")} target={value("targetPressure")} unit="bar" zeroIsNone />
      <Measurement label="Flow" value={value("flow")} target={value("targetFlow")} unit="ml/s" zeroIsNone />
      <Tile label="Profile step">
        <TileTerm>Profile step</TileTerm>
        <dd className="text-lg font-medium">{stepText ?? <span className="text-muted-foreground">{pulling ? "Not reported" : "Not pulling a shot"}</span>}</dd>
      </Tile>
      <WaterLevel frame={live.waterLevels} />
      <Scale frame={live.scale} />
      <Tile label="Tablet">
        <TileTerm>Connection to Tablet</TileTerm>
        <dd className="text-lg font-medium">{connectionText(machineConnectedOf(live.devices))}</dd>
      </Tile>
    </div>
  );
}

/** The tank's water level against its refill level, Low at or below it. */
function WaterLevel({ frame }: { frame: Record<string, unknown> | undefined }) {
  const { level, refill, low } = waterLevelOf(frame);
  return (
    <Tile label="Water level">
      <TileTerm>Water level</TileTerm>
      <dd className="flex items-center gap-2 text-lg font-medium tabular-nums">
        {level === null ? <NotReported /> : `${level.toFixed(1)} mm`}
        {low && <Badge variant="destructive">Low</Badge>}
      </dd>
      <div className="flex gap-1 text-xs text-muted-foreground">
        <dt className="flex items-center gap-1">
          Refill level
          <InfoTip label="About the refill level">
            <p>The water level, set on the Machine, at which its tank is due a refill.</p>
            <p>At or below it, the water level is shown as Low.</p>
          </InfoTip>
        </dt>
        <dd className="tabular-nums">{refill === null ? <NotReported /> : `${refill.toFixed(1)} mm`}</dd>
      </div>
    </Tile>
  );
}

/** The scale's weight, weight flow and battery, and whether it is connected. */
function Scale({ frame }: { frame: Record<string, unknown> | undefined }) {
  const { connected, weight, weightFlow, battery } = scaleOf(frame);
  return (
    <Tile label="Scale">
      <TileTerm>Weight</TileTerm>
      <dd className="text-lg font-medium tabular-nums">{weight === null ? <NotReported /> : `${weight.toFixed(1)} g`}</dd>
      <TileLine term="Weight flow">{weightFlow === null ? <NotReported /> : `${weightFlow.toFixed(1)} g/s`}</TileLine>
      <TileLine term="Battery">{battery === null ? <NotReported /> : `${Math.round(battery)} %`}</TileLine>
      <TileLine term="Scale">{connectionText(connected)}</TileLine>
    </Tile>
  );
}

function connectionText(connected: boolean | null): ReactNode {
  if (connected === null) return <NotReported />;
  return connected ? "Connected" : "Not connected";
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
